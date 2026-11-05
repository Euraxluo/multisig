import assert from "node:assert/strict"
import { test } from "node:test"
import { ed25519 } from "@noble/curves/ed25519.js"
import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToScalar, mod } from "./math"
import { signWithCommittee, ThresholdSigningError } from "./committee-signing"
import type { CommitteeSession } from "../committee-session"

const utf8 = (value: string) => new TextEncoder().encode(value)

/** Deal a `threshold`-of-`count` polynomial and return the shares plus group key. */
function deal(threshold: number, count: number, salt = "committee") {
  const coefficients = Array.from({ length: threshold }, (_, index) =>
    bytesToScalar(sha256(utf8(`${salt}-coefficient-${index}`))))
  const evaluate = (x: bigint) => coefficients.reduce((sum, coefficient, power) =>
    mod(sum + coefficient * x ** BigInt(power)), 0n)
  const shares = Array.from({ length: count }, (_, position) => evaluate(BigInt(position + 1)))
  const groupPk = ed25519.Point.BASE.multiply(coefficients[0]).toBytes()
  return { shares, indices: shares.map((_, position) => BigInt(position + 1)), groupPk }
}

function session(overrides: Partial<CommitteeSession> = {}): CommitteeSession {
  const { shares, indices, groupPk } = deal(2, 3)
  return { orgId: "0x" + "20".repeat(32), groupPk, epoch: 1n, threshold: 2n, indices, shares, ...overrides }
}

test("committee shares produce a signature the contract's Ed25519 verifier accepts", () => {
  const current = session()
  const message = sha256(utf8("SUI_ORG_ROSTER_V1:payload"))
  const { signature, signerIndices } = signWithCommittee(current, message, { groupPk: current.groupPk, epoch: 1n })
  assert.equal(signature.length, 64)
  assert.equal(signerIndices.length, 2)
  assert.ok(ed25519.verify(signature, message, current.groupPk))
})

test("signatures use fresh nonces and differ across calls", () => {
  const current = session()
  const message = sha256(utf8("same-message"))
  const first = signWithCommittee(current, message, { groupPk: current.groupPk, epoch: 1n })
  const second = signWithCommittee(current, message, { groupPk: current.groupPk, epoch: 1n })
  assert.notDeepEqual(first.signature, second.signature)
  assert.ok(ed25519.verify(second.signature, message, current.groupPk))
})

test("refuses to sign when the live group key differs from the held shares", () => {
  const current = session()
  const other = deal(2, 3, "another-committee").groupPk
  assert.throws(
    () => signWithCommittee(current, sha256(utf8("x")), { groupPk: other, epoch: 1n }),
    (error: unknown) => error instanceof ThresholdSigningError && /群公钥/.test((error as Error).message),
  )
})

test("refuses to sign after the organization advanced its epoch", () => {
  const current = session()
  assert.throws(
    () => signWithCommittee(current, sha256(utf8("x")), { groupPk: current.groupPk, epoch: 2n }),
    (error: unknown) => error instanceof ThresholdSigningError && /Epoch/.test((error as Error).message),
  )
})

test("refuses to sign when fewer shares exist than the threshold", () => {
  const { shares, indices, groupPk } = deal(3, 3, "three-of-three")
  const partial = session({ shares: shares.slice(0, 2), indices: indices.slice(0, 2), groupPk, threshold: 2n })
  // The chain says 3 shares are required; the tab only holds 2.
  assert.throws(
    () => signWithCommittee({ ...partial, threshold: 3n }, sha256(utf8("x")), { groupPk, epoch: 1n }),
    (error: unknown) => error instanceof ThresholdSigningError && /门限/.test((error as Error).message),
  )
})

test("any threshold-sized subset reconstructs the same key and verifies", () => {
  const { shares, indices, groupPk } = deal(2, 3, "subset-committee")
  // Use the last two shares only, which is a different subset from the default.
  const subset = session({ shares: shares.slice(1), indices: indices.slice(1), groupPk, threshold: 2n })
  const message = sha256(utf8("subset"))
  const { signature, signerIndices } = signWithCommittee(subset, message, { groupPk, epoch: 1n })
  assert.deepEqual(signerIndices, [2n, 3n])
  // The contract sees only the group key; a different subset must still pass.
  assert.ok(ed25519.verify(signature, message, groupPk))
  const manual = ed25519.verify(signature, message, groupPk)
  assert.equal(manual, true)
  // A signature from the subset must not verify against another roster's key.
  assert.equal(ed25519.verify(signature, message, deal(2, 3, "another-committee").groupPk), false)
})
