"use client"

// Two-round threshold signing between devices, wired onto the SDK's FROST1
// implementation (`multisig/dkg`, RFC 9591 §4.4 per-participant binding factors).
//
//   round 1  each signer publishes a hiding+binding commitment pair D_i, E_i
//   round 2  each signer publishes z_i = (hide_i + ρ_i·bind_i) + c·λ_i·s_i, where
//            ρ_i = SHA512("SUI_FROST_BINDING_V1:" ‖ sorted(idx‖D‖E) ‖ message ‖ Y ‖ idx_i) mod L
//            c   = SHA512(R̄ ‖ Y ‖ message) mod L,  R̄ = Σ(D_i + ρ_i·E_i)
//            anyone sums z = Σz_i and emits R̄ ‖ z
//
// The previous single-nonce scheme (R = Σ r_i·G with no commitment binding) is
// deleted: its last signer could craft commitments that cancel the honest
// nonces. Every ρ_i is recomputed by the aggregator inside
// `ThresholdSignerNode.aggregateSignature`, which also self-verifies the final
// signature under `ed25519.verify` before returning, so a caller either gets
// something the contract will accept or an error.
//
// The two-round shape is not decoration: publishing nonce material after seeing
// the other commitments would let the last signer solve for the group secret.
// Round 2 runs on the same `ThresholdSignerNode` that produced the round-1
// commitment, and the node refuses to sign twice with consumed nonces — that
// is what forces the ordering.
import { t } from "@/lib/i18n/t"
import { ed25519 } from "@noble/curves/ed25519.js"
import { sha512 } from "@noble/hashes/sha2.js"
import {
  ThresholdSignerNode,
  computeAggregateNonce,
  validateCommitments as validateFrost1Commitments,
} from "multisig/dkg"
import type { NonceCommitment as Frost1Commitment, SignatureShare as Frost1Share } from "multisig/dkg"
import { bytesToScalar, scalarToBytes32 } from "./crypto/math"

export interface NonceCommitment {
  orgId: string
  /** Holder index of the signer. */
  index: bigint
  /** D_i = hide_i·G, 32-byte compressed point. */
  hiding: Uint8Array
  /** E_i = bind_i·G, 32-byte compressed point. */
  binding: Uint8Array
}

export interface SignatureShare {
  orgId: string
  index: bigint
  /** z_i, 32-byte little-endian scalar. */
  scalar: Uint8Array
}

export class ThresholdExchangeError extends Error {}

/** The message the contract verifies: `SESSION_CERT_V1:` ‖ bcs(session_id) ‖ group_pk. */
export function sessionCertificateMessage(sessionIdBytes: Uint8Array, groupPk: Uint8Array): Uint8Array {
  const prefix = new TextEncoder().encode("SESSION_CERT_V1:")
  const message = new Uint8Array(prefix.length + sessionIdBytes.length + groupPk.length)
  message.set(prefix, 0)
  message.set(sessionIdBytes, prefix.length)
  message.set(groupPk, prefix.length + sessionIdBytes.length)
  return message
}

/** Maps wire commitments onto SDK FROST1 commitments (identity = index). */
function frost1Commitments(commitments: NonceCommitment[]): Frost1Commitment[] {
  return commitments.map(commitment => ({
    participantId: commitment.index.toString(),
    participantIndex: commitment.index,
    hiding: commitment.hiding,
    binding: commitment.binding,
  }))
}

/** Maps wire shares onto SDK FROST1 shares (identity = index). */
function frost1Shares(shares: SignatureShare[]): Frost1Share[] {
  return shares.map(share => ({
    participantId: share.index.toString(),
    participantIndex: share.index,
    shareZ: bytesToScalar(share.scalar),
  }))
}

/**
 * Round 1, local side. Creates this holder's FROST1 signer node (bound to its
 * DKG share), generates the hiding/binding nonce pair inside the node, and
 * returns the commitment to publish. The node stays with the caller — round 2
 * runs on it; the secret nonces never leave it and are consumed on use.
 */
export function createNonceCommitment(
  orgId: string,
  index: bigint,
  share: bigint,
): { commitment: NonceCommitment; node: ThresholdSignerNode } {
  const node = new ThresholdSignerNode(`${orgId}:${index}`, index, share)
  const generated = node.generateNonceCommitment()
  return {
    commitment: { orgId, index, hiding: generated.hiding, binding: generated.binding },
    node,
  }
}

/**
 * R̄ = Σ(D_i + ρ_i·E_i) over the published commitments, with every ρ_i
 * recomputed per index (RFC 9591 §4.4). Validates organization binding and
 * rejects duplicate indices and malformed/non-prime-order commitment points.
 */
export function aggregateNonce(
  commitments: NonceCommitment[],
  orgId: string,
  message: Uint8Array,
  groupPk: Uint8Array,
): Uint8Array {
  if (commitments.length === 0) throw new ThresholdExchangeError(t("dkg.noCommitments"))
  const seen = new Set<string>()
  for (const commitment of commitments) {
    if (commitment.orgId.toLowerCase() !== orgId.toLowerCase()) throw new ThresholdExchangeError(t("dkg.foreignCommitment"))
    const key = commitment.index.toString()
    if (seen.has(key)) throw new ThresholdExchangeError(t("dkg.duplicateCommitment", { participant: key }))
    seen.add(key)
  }
  const frost1 = frost1Commitments(commitments)
  validateFrost1Commitments(frost1)
  return computeAggregateNonce(frost1, message, groupPk).toBytes()
}

/** c = SHA512(R̄ ‖ Y ‖ message) mod L, the same challenge the contract's verifier implies. */
export function signingChallenge(aggregateR: Uint8Array, groupPk: Uint8Array, message: Uint8Array): bigint {
  if (aggregateR.length !== 32) throw new ThresholdExchangeError(t("dkg.aggregateRBytes"))
  if (groupPk.length !== 32) throw new ThresholdExchangeError(t("dkg.groupKeyBytes32"))
  const input = new Uint8Array(64 + message.length)
  input.set(aggregateR, 0)
  input.set(groupPk, 32)
  input.set(message, 64)
  return bytesToScalar(sha512(input))
}

/**
 * Round 2, local side. Produces this device's signature share on the node that
 * published the round-1 commitment. A node without unconsumed nonces — i.e. a
 * signer that skipped round 1 or already signed — throws inside the node, so a
 * share cannot exist without a prior commitment of its own.
 */
export function createSignatureShare(input: {
  node: ThresholdSignerNode
  orgId: string
  threshold: bigint
  /** Holder indices of every signer in this round, including this one. */
  signerIndices: bigint[]
  /** Every published round-1 commitment, including this signer's own. */
  commitments: NonceCommitment[]
  groupPk: Uint8Array
  message: Uint8Array
}): SignatureShare {
  if (input.signerIndices.length < Number(input.threshold)) {
    throw new ThresholdExchangeError(t("dkg.signersBelowThreshold", { count: input.signerIndices.length, threshold: String(input.threshold) }))
  }
  if (!input.signerIndices.some(index => index === input.node.index)) {
    throw new ThresholdExchangeError(t("dkg.signerNotInRound"))
  }
  const share = input.node.computeSignatureShare(input.message, input.groupPk, frost1Commitments(input.commitments))
  return { orgId: input.orgId, index: input.node.index, scalar: scalarToBytes32(share.shareZ) }
}

export interface AggregateResult {
  signature: Uint8Array
  groupPk: Uint8Array
}

/**
 * Combines the shares into the final 64-byte `R̄ ‖ z` signature. The SDK
 * aggregator recomputes every per-participant binding factor, rebuilds R̄ from
 * the commitments (not from a caller-supplied aggregate), and verifies the
 * result against the group key before returning. A share set that does not
 * reconstruct the key fails here, before any transaction is built.
 */
export function aggregateSignature(
  commitments: NonceCommitment[],
  shares: SignatureShare[],
  groupPk: Uint8Array,
  message: Uint8Array,
): AggregateResult {
  if (shares.length === 0) throw new ThresholdExchangeError(t("dkg.noShares"))
  const seen = new Set<string>()
  for (const share of shares) {
    const key = share.index.toString()
    if (seen.has(key)) throw new ThresholdExchangeError(t("dkg.duplicateShare", { participant: key }))
    seen.add(key)
  }
  let signature: Uint8Array
  try {
    signature = ThresholdSignerNode.aggregateSignature(message, groupPk, frost1Commitments(commitments), frost1Shares(shares))
  } catch (error) {
    throw new ThresholdExchangeError(`${t("dkg.exchangeAggregateVerifyFailed")}: ${(error as Error).message}`)
  }
  return { signature, groupPk }
}

/** True when `signature` is a valid Ed25519 signature of `message` under `groupPk`. */
export function verifyGroupSignature(signature: Uint8Array, message: Uint8Array, groupPk: Uint8Array): boolean {
  if (signature.length !== 64 || groupPk.length !== 32) return false
  try { return ed25519.verify(signature, message, groupPk) } catch { return false }
}
