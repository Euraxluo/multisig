import assert from "node:assert/strict"
import { test } from "node:test"
import { ed25519 } from "@noble/curves/ed25519.js"
import { bcs } from "@mysten/sui/bcs"
import { randomScalar } from "./crypto/math"

// Regression pin for a CRITICAL contract defect found by an independent audit
// and reproduced here against the real message layout.
//
// `dkg_committee::finalize_session_v2` verifies the submitted "FROST proof"
// against `group_public_key` — the very key the caller supplies:
//
//     ed25519::ed25519_verify(&frost_signature, &group_public_key, &msg)
//
// That is circular. It proves "the caller knows the private key for the key the
// caller chose", not "the confirmed committee dealt this key". `finalize_session`
// (v1, still present in the deployed package) performs no verification at all.
//
// These tests cannot fix the contract. They exist so the client-side
// cross-check has a pinned counterpart, and so anyone reading the test suite
// sees the attack reproduced rather than described.
//
// Fixed in package v6 (0xbe71f98b…): both legacy entry points now abort with
// E_LEGACY_FINALIZE_DISABLED (3013), and `finalize_session_v3` requires
// `threshold` confirmed members to attest the key they each recomputed from the
// on-chain commitments. The forgery below is still valid as a demonstration of
// *why* v2 was unsafe; it no longer succeeds against the deployed package.

/** Exactly the message `finalize_session_v2` builds. */
function sessionCertificateMessage(sessionIdHex: string, groupPk: Uint8Array): Uint8Array {
  const prefix = new TextEncoder().encode("SESSION_CERT_V1:")
  const idBytes = bcs.Address.serialize(sessionIdHex).toBytes()
  const message = new Uint8Array(prefix.length + idBytes.length + groupPk.length)
  message.set(prefix, 0)
  message.set(idBytes, prefix.length)
  message.set(groupPk, prefix.length + idBytes.length)
  return message
}

const SESSION = "0x4da8b14f82361050ce8571af77e5ce2f82a2b1f841040f84af34514de33b7b56"

test("the contract's finalize check accepts a key the caller generated", () => {
  const attackerSecret = ed25519.utils.randomSecretKey()
  const attackerPublic = ed25519.getPublicKey(attackerSecret)

  const message = sessionCertificateMessage(SESSION, attackerPublic)
  const forged = ed25519.sign(message, attackerSecret)

  // This is the contract's own `ed25519_verify(sig, group_public_key, msg)`.
  assert.equal(ed25519.verify(forged, message, attackerPublic), true,
    "the deployed check passes for an attacker-chosen key — the proof is circular")
})

test("the forged certificate does not verify under any honest key", () => {
  const attackerSecret = ed25519.utils.randomSecretKey()
  const attackerPublic = ed25519.getPublicKey(attackerSecret)
  const honestPublic = ed25519.getPublicKey(ed25519.utils.randomSecretKey())

  const message = sessionCertificateMessage(SESSION, attackerPublic)
  const forged = ed25519.sign(message, attackerSecret)

  // The signature is bound to the message, which embeds the attacker's key, so
  // it is worthless against another key. This is why only a cross-check against
  // the commitment sum can detect the substitution.
  assert.equal(ed25519.verify(forged, message, honestPublic), false)
  // And a message built for the honest key differs, so the attacker's signature
  // does not cover it.
  const honestMessage = sessionCertificateMessage(SESSION, honestPublic)
  assert.notDeepEqual(message, honestMessage)
  assert.equal(ed25519.verify(forged, honestMessage, attackerPublic), false)
})

test("the recomputed commitment sum is the evidence the contract omits", () => {
  // A 3-dealer deal: the group key is the sum of the dealers' C_0 terms. The
  // client recomputes exactly this and compares it to `final_public_key`.
  const dealers = [0, 1, 2].map(() => {
    const secret = randomScalar()
    return ed25519.Point.BASE.multiply(secret).toBytes()
  })
  let sum = ed25519.Point.fromBytes(dealers[0])
  for (const c0 of dealers.slice(1)) sum = sum.add(ed25519.Point.fromBytes(c0))
  const honestGroupPk = sum.toBytes()

  const attackerPk = ed25519.getPublicKey(ed25519.utils.randomSecretKey())
  // The two keys differ, which is exactly what the client-side comparison in
  // `handleFinalize` detects before presenting a finalized session as sound.
  assert.notDeepEqual(attackerPk, honestGroupPk)
})
