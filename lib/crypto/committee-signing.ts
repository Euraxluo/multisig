"use client"

// Threshold signing for organization transitions.
//
// The deployed contract verifies a single 64-byte Ed25519 signature from the
// FROST group key (`sui::ed25519::ed25519_verify`). This module delegates all
// group-signature math to the SDK's FROST1 implementation
// (`multisig/dkg/threshold_signer`, RFC 9591 §4.4 per-participant binding
// factors ρ_i): each held share becomes a `ThresholdSignerNode`, nodes publish
// hiding+binding commitments in round 1, produce shares in round 2, and the
// aggregator recomputes every ρ_i for R̄ = Σ(D_i + ρ_i·E_i).
//
// There is deliberately no local single-nonce Schnorr path anymore: the old
// R = Σr_i scheme had no commitment binding, so a last signer could craft
// commitments that cancel honest nonces. The SDK path self-verifies the
// aggregate under `ed25519.verify` before returning, so a call either yields
// something the contract accepts or throws.
//
// Two honest limits are reported rather than hidden:
//   - The shares exist only in this tab (see committee-session.ts). After a
//     reload the committee cannot sign anything; there is no placeholder fallback.
//   - Signing requires at least `threshold` shares, which in the bundled demo
//     ceremony means the ceremony ran in this tab. A real committee needs each
//     member to produce their own share and relay them out of band.
import { t } from "@/lib/i18n/t"
import { ThresholdSignerNode } from "multisig/dkg"
import type { CommitteeSession } from "../committee-session"

export interface ThresholdSignature {
  signature: Uint8Array
  /** Holder indices that participated. */
  signerIndices: bigint[]
  /** Group public key this signature verifies against. */
  groupPk: Uint8Array
}

/** Why a committee cannot sign right now, or the verified signature. */
export class ThresholdSigningError extends Error {}

/**
 * Sign `message` (already domain-separated and hashed by the caller) with the
 * shares held for `session`. Refuses when the session is for another key or epoch
 * than the live chain state, when there are too few shares, or when the produced
 * signature does not verify — so every call returns something the contract will
 * accept or throws before a transaction is built.
 */
export function signWithCommittee(
  session: CommitteeSession,
  message: Uint8Array,
  live: { groupPk: Uint8Array; epoch: bigint },
): ThresholdSignature {
  const keyMatches = session.groupPk.length === live.groupPk.length
    && session.groupPk.every((value, index) => value === live.groupPk[index])
  if (!keyMatches) {
    throw new ThresholdSigningError(t("dkg.signingGroupKeyMismatch"))
  }
  if (session.epoch !== live.epoch) {
    throw new ThresholdSigningError(t("dkg.signingEpochMismatch", { sessionEpoch: String(session.epoch), liveEpoch: String(live.epoch) }))
  }
  if (BigInt(session.shares.length) < session.threshold) {
    throw new ThresholdSigningError(t("dkg.signingInsufficientShares", { count: session.shares.length, threshold: String(session.threshold) }))
  }

  // Use the first `threshold` shares; any t-subset reconstructs the same key.
  const selected = session.shares.slice(0, Number(session.threshold))
  const indices = session.indices.slice(0, Number(session.threshold))
  if (new Set(indices.map(index => index.toString())).size !== indices.length) {
    throw new ThresholdSigningError(t("dkg.duplicateIndices"))
  }

  // FROST1: fresh signer nodes per call (nonce reuse is prohibited), each node
  // holds one share plus its own hiding/binding nonces. Nonces never leave the
  // node; only commitments and signature shares cross this boundary.
  const nodes = selected.map((share, position) =>
    new ThresholdSignerNode(`holder-${indices[position]}`, indices[position], share))
  const commitments = nodes.map(node => node.generateNonceCommitment())
  const shares = nodes.map(node => node.computeSignatureShare(message, session.groupPk, commitments))

  let signature: Uint8Array
  try {
    signature = ThresholdSignerNode.aggregateSignature(message, session.groupPk, commitments, shares)
  } catch (error) {
    throw new ThresholdSigningError(`${t("dkg.aggregateVerifyFailed")}: ${(error as Error).message}`)
  }
  return { signature, signerIndices: indices, groupPk: session.groupPk }
}
