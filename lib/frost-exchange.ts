"use client"

// Two-round threshold signing between devices.
//
// The committee's shares now live on separate devices (`lib/committee-share-store.ts`).
// Producing one 64-byte Ed25519 signature from t shares therefore needs two rounds
// of messages, and this module is the wire format plus the per-round logic:
//
//   round 1  each signer publishes a nonce commitment  R_i = r_i·G
//   round 2  each signer publishes z_i = r_i + c·λ_i·s_i, where
//            c = SHA512(ΣR_i ‖ Y ‖ message) mod L
//            anyone sums z = Σz_i and emits R ‖ z
//
// The two-round shape is not decoration: publishing r_i after seeing the other
// commitments would let the last signer solve for the group secret. The protocol
// refuses to produce a round-2 share unless it already has its own round-1
// commitment recorded, which is what forces the ordering.
//
// Signatures are checked against the group public key before they are returned, so
// a caller either gets something the contract will accept or an error.
import { t } from "@/lib/i18n/t"
import { ed25519 } from "@noble/curves/ed25519.js"
import { sha512 } from "@noble/hashes/sha2.js"
import { bytesToScalar, lagrangeCoefficient, mod, randomScalar, scalarToBytes32 } from "./crypto/math"

export interface NonceCommitment {
  orgId: string
  /** Holder index of the signer. */
  index: bigint
  /** R_i = r_i·G, 32-byte compressed point. */
  point: Uint8Array
}

export interface SignatureShare {
  orgId: string
  index: bigint
  /** z_i = r_i + c·λ_i·s_i, 32-byte little-endian scalar. */
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

function sameOrg(a: string, b: string): boolean { return a.toLowerCase() === b.toLowerCase() }

/**
 * Round 1, local side. Returns the nonce commitment to publish and keeps the
 * secret scalar in the returned closure — never in storage.
 */
export function createNonceCommitment(orgId: string, index: bigint): { commitment: NonceCommitment; secret: bigint } {
  const secret = randomScalar()
  return {
    commitment: { orgId, index, point: ed25519.Point.BASE.multiply(secret).toBytes() },
    secret,
  }
}

/** Sums the published commitments into the aggregate R. */
export function aggregateNonce(commitments: NonceCommitment[], orgId: string): Uint8Array {
  if (commitments.length === 0) throw new ThresholdExchangeError(t("dkg.noCommitments"))
  const seen = new Set<string>()
  let total = ed25519.Point.ZERO
  for (const commitment of commitments) {
    if (!sameOrg(commitment.orgId, orgId)) throw new ThresholdExchangeError(t("dkg.foreignCommitment"))
    if (commitment.point.length !== 32) throw new ThresholdExchangeError(t("dkg.commitmentPointBytes"))
    const key = commitment.index.toString()
    if (seen.has(key)) throw new ThresholdExchangeError(t("dkg.duplicateCommitment", { participant: key }))
    seen.add(key)
    total = total.add(ed25519.Point.fromBytes(commitment.point))
  }
  return total.toBytes()
}

/** c = SHA512(R ‖ Y ‖ message) mod L, the same challenge the contract's verifier implies. */
export function signingChallenge(aggregateR: Uint8Array, groupPk: Uint8Array, message: Uint8Array): bigint {
  if (aggregateR.length !== 32) throw new ThresholdExchangeError(t("dkg.aggregateRBytes"))
  if (groupPk.length !== 32) throw new ThresholdExchangeError(t("dkg.groupKeyBytes32"))
  const input = new Uint8Array(64 + message.length)
  input.set(aggregateR, 0)
  input.set(groupPk, 32)
  input.set(message, 64)
  return mod(bytesToScalar(sha512(input)))
}

/**
 * Round 2, local side. Produces this device's signature share.
 *
 * `verifyRoundOne` must be true only when this signer already published its own
 * commitment for this aggregate; the caller enforces that by passing the value it
 * stored in round 1. Without it a signer that skipped round 1 could choose z freely.
 */
export function createSignatureShare(input: {
  orgId: string
  index: bigint
  secret: bigint
  share: bigint
  threshold: bigint
  /** Holder indices of every signer in this round, including this one. */
  signerIndices: bigint[]
  aggregateR: Uint8Array
  groupPk: Uint8Array
  message: Uint8Array
  verifyRoundOne: boolean
}): SignatureShare {
  if (!input.verifyRoundOne) throw new ThresholdExchangeError(t("dkg.roundOneMissing"))
  if (input.signerIndices.length < Number(input.threshold)) {
    throw new ThresholdExchangeError(t("dkg.signersBelowThreshold", { count: input.signerIndices.length, threshold: String(input.threshold) }))
  }
  if (!input.signerIndices.some(index => index === input.index)) {
    throw new ThresholdExchangeError(t("dkg.signerNotInRound"))
  }
  const challenge = signingChallenge(input.aggregateR, input.groupPk, input.message)
  const lambda = lagrangeCoefficient(input.index, input.signerIndices)
  const scalar = mod(input.secret + challenge * lambda * input.share)
  return { orgId: input.orgId, index: input.index, scalar: scalarToBytes32(scalar) }
}

export interface AggregateResult {
  signature: Uint8Array
  groupPk: Uint8Array
}

/**
 * Combines the shares into the final 64-byte `R ‖ z` signature and verifies it
 * against the group key. A share set that does not reconstruct the key fails here,
 * before any transaction is built.
 */
export function aggregateSignature(
  aggregateR: Uint8Array,
  shares: SignatureShare[],
  groupPk: Uint8Array,
  message: Uint8Array,
): AggregateResult {
  if (shares.length === 0) throw new ThresholdExchangeError(t("dkg.noShares"))
  const seen = new Set<string>()
  let z = 0n
  for (const share of shares) {
    const key = share.index.toString()
    if (seen.has(key)) throw new ThresholdExchangeError(t("dkg.duplicateShare", { participant: key }))
    seen.add(key)
    z = mod(z + bytesToScalar(share.scalar))
  }
  const signature = new Uint8Array(64)
  signature.set(aggregateR, 0)
  signature.set(scalarToBytes32(z), 32)
  if (!ed25519.verify(signature, message, groupPk)) {
    throw new ThresholdExchangeError(t("dkg.exchangeAggregateVerifyFailed"))
  }
  return { signature, groupPk }
}

/** True when `signature` is a valid Ed25519 signature of `message` under `groupPk`. */
export function verifyGroupSignature(signature: Uint8Array, message: Uint8Array, groupPk: Uint8Array): boolean {
  if (signature.length !== 64 || groupPk.length !== 32) return false
  try { return ed25519.verify(signature, message, groupPk) } catch { return false }
}
