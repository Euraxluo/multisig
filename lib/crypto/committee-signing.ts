"use client"

// Threshold signing for organization transitions.
//
// The deployed contract verifies a single 64-byte Ed25519 signature from the
// FROST group key (`sui::ed25519::ed25519_verify`). This module turns the shares
// this tab holds for one organization epoch into that signature with the same
// scheme the DKG ceremony uses:
//
//   R = Σ R_i,  c = SHA512(R ‖ Y ‖ message) mod L,
//   z_i = r_i + c · λ_i(0) · s_i,  z = Σ z_i,  signature = R ‖ z
//
// Two honest limits are reported rather than hidden:
//   - The shares exist only in this tab (see committee-session.ts). After a
//     reload the committee cannot sign anything; there is no placeholder fallback.
//   - Signing requires at least `threshold` shares, which in the bundled demo
//     ceremony means the ceremony ran in this tab. A real committee needs each
//     member to produce their own share and relay them out of band.
import { t } from "@/lib/i18n/t"
import { ed25519 } from "@noble/curves/ed25519.js"
import { sha512 } from "@noble/hashes/sha2.js"
import { bytesToScalar, lagrangeCoefficient, mod, randomScalar, scalarToBytes32 } from "./math"
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

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

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
  if (!sameBytes(session.groupPk, live.groupPk)) {
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

  const nonces = selected.map(() => {
    const scalar = randomScalar()
    return { scalar, point: ed25519.Point.BASE.multiply(scalar) }
  })
  const aggregateR = nonces.reduce((sum, nonce) => sum.add(nonce.point), ed25519.Point.ZERO)
  const rBytes = aggregateR.toBytes()
  const hashInput = new Uint8Array(64 + message.length)
  hashInput.set(rBytes, 0)
  hashInput.set(session.groupPk, 32)
  hashInput.set(message, 64)
  const challenge = bytesToScalar(sha512(hashInput))

  const z = selected.reduce((sum, share, position) => {
    const lambda = lagrangeCoefficient(indices[position], indices, 0n)
    return mod(sum + nonces[position].scalar + challenge * lambda * share)
  }, 0n)
  const signature = new Uint8Array(64)
  signature.set(rBytes, 0)
  signature.set(scalarToBytes32(z), 32)

  if (!ed25519.verify(signature, message, session.groupPk)) {
    throw new ThresholdSigningError(t("dkg.aggregateVerifyFailed"))
  }
  return { signature, signerIndices: indices, groupPk: session.groupPk }
}
