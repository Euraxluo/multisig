import assert from "node:assert/strict"
import { test } from "node:test"
import { ed25519 } from "@noble/curves/ed25519.js"
import {
  assembleDeviceKey,
  parsePublicKeyPackage,
  publicKeyPackageId,
  serializePublicKeyPackage,
  toPublicKeyPackage,
  validateDeviceKeyPackage,
  validatePublicKeyPackage,
  type DeviceKeyPackage,
} from "./dkg-key-package"

const P1 = `0x${"11".repeat(32)}`
const P2 = `0x${"22".repeat(32)}`
const P3 = `0x${"33".repeat(32)}`
const SESSION = `0x${"aa".repeat(32)}`
const HOLDER = P2

function dealer(address: string, coefficients: bigint[], index = 2n) {
  const commitments = coefficients.map(coefficient => ed25519.Point.BASE.multiply(coefficient).toBytes())
  let share = 0n
  let power = 1n
  for (const coefficient of coefficients) {
    share += coefficient * power
    power *= index
  }
  return { address, commitments, share }
}

function assembled(): DeviceKeyPackage {
  return assembleDeviceKey({
    sessionId: SESSION,
    holder: HOLDER,
    participantAddresses: [P1, P2, P3],
    threshold: 2n,
    sessionEpoch: 9n,
    // The input order is intentionally different; the qualified dealer set is
    // canonicalized to the frozen original roster order before hashing.
    dealers: [dealer(P3, [11n, 13n]), dealer(P1, [5n, 7n])],
  })
}

test("aggregates exactly the frozen dealer set and preserves original holder index", () => {
  const key = assembled()
  assert.equal(key.index, 2n)
  assert.deepEqual(key.dealerAddresses, [P1, P3])
  assert.equal(key.share, 56n)
  assert.deepEqual(key.groupPk, ed25519.Point.BASE.multiply(16n).toBytes())
  assert.equal(key.keyPackageId, publicKeyPackageId(key))
  validateDeviceKeyPackage(key)
})

test("all holders derive the same metadata-only public package id", () => {
  const key = assembled()
  const other = assembleDeviceKey({
    sessionId: SESSION,
    holder: P1,
    participantAddresses: [P1, P2, P3],
    threshold: 2n,
    sessionEpoch: 9n,
    dealers: [dealer(P1, [5n, 7n], 1n), dealer(P3, [11n, 13n], 1n)],
  })
  assert.equal(other.keyPackageId, key.keyPackageId)
  assert.notEqual(other.share, key.share)
  assert.notEqual(other.index, key.index)
})

test("public package serialization is canonical and excludes holder and share", () => {
  const key = assembled()
  const publicPackage = toPublicKeyPackage(key)
  const wire = serializePublicKeyPackage(publicPackage)
  assert.equal(wire.includes("holder"), false)
  assert.equal(wire.includes("share"), false)
  const parsed = parsePublicKeyPackage(wire)
  assert.deepEqual(parsed, publicPackage)
  validatePublicKeyPackage(parsed)
})

test("a dealer share mismatch is refused before aggregation", () => {
  assert.throws(() => assembleDeviceKey({
    sessionId: SESSION,
    holder: HOLDER,
    participantAddresses: [P1, P2, P3],
    threshold: 2n,
    sessionEpoch: 9n,
    dealers: [dealer(P1, [5n, 7n]), { ...dealer(P3, [11n, 13n]), share: 57n }],
  }), /dealer 分片未通过承诺校验/)
})

test("qualified dealer set must have at least threshold members", () => {
  assert.throws(() => assembleDeviceKey({
    sessionId: SESSION,
    holder: HOLDER,
    participantAddresses: [P1, P2, P3],
    threshold: 2n,
    sessionEpoch: 9n,
    dealers: [dealer(P1, [5n, 7n])],
  }), /冻结 dealer 集合 Q 低于门限/)
})

test("one-of-one uses the dedicated share equals public key check", () => {
  const key = assembleDeviceKey({
    sessionId: SESSION,
    holder: P1,
    participantAddresses: [P1],
    threshold: 1n,
    sessionEpoch: 1n,
    dealers: [dealer(P1, [19n], 1n)],
  })
  assert.notEqual(key.share, 0n)
  assert.equal(key.share, 19n)
  validateDeviceKeyPackage(key)
  const badDealer = dealer(P1, [19n], 1n)
  badDealer.share = 20n
  assert.throws(() => assembleDeviceKey({
    sessionId: SESSION,
    holder: P1,
    participantAddresses: [P1],
    threshold: 1n,
    sessionEpoch: 1n,
    dealers: [badDealer],
  }), /dealer 分片未通过承诺校验/)
})
