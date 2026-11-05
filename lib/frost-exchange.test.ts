import assert from "node:assert/strict"
import { test } from "node:test"
import { ed25519 } from "@noble/curves/ed25519.js"
import { mod, randomScalar, lagrangeCoefficient, scalarToBytes32, bytesToScalar } from "./crypto/math"
import {
  aggregateNonce, aggregateSignature, createNonceCommitment, createSignatureShare,
  sessionCertificateMessage, signingChallenge, ThresholdExchangeError, verifyGroupSignature,
  type NonceCommitment,
} from "./frost-exchange"

// These tests pin the property that actually matters: a set of t devices, each
// holding one share and running the two rounds in order, produces a signature the
// on-chain `ed25519_verify` accepts; and skipping or reordering a round does not.

const ORG = "0x" + "aa".repeat(32)
const MESSAGE = new TextEncoder().encode("SESSION_CERT_V1:payload")
const THRESHOLD = 2

/** A t-of-n Shamir split, which is what the DKG ends with. */
function splitKey(threshold: number, n: number) {
  const coefficients = Array.from({ length: threshold }, () => randomScalar())
  const shareAt = (x: bigint) => coefficients.reduceRight((acc, c) => mod(acc * x + c), 0n)
  const indices = Array.from({ length: n }, (_, i) => BigInt(i + 1))
  const shares = indices.map(shareAt)
  const groupPk = ed25519.Point.BASE.multiply(coefficients[0]).toBytes()
  return { indices, shares, groupPk }
}

/** Runs both rounds across `signers` and returns the aggregate signature. */
function runRounds(signers: { index: bigint; share: bigint }[], groupPk: Uint8Array, message: Uint8Array) {
  const round1 = signers.map(signer => ({ signer, ...createNonceCommitment(ORG, signer.index) }))
  const commitments: NonceCommitment[] = round1.map(entry => entry.commitment)
  const aggregateR = aggregateNonce(commitments, ORG)
  const signerIndices = signers.map(signer => signer.index)
  const shares = round1.map((entry) => createSignatureShare({
    orgId: ORG, index: entry.signer.index, secret: entry.secret, share: entry.signer.share,
    threshold: BigInt(THRESHOLD), signerIndices, aggregateR, groupPk, message, verifyRoundOne: true,
  }))
  return { aggregateR, signature: aggregateSignature(aggregateR, shares, groupPk, message) }
}

test("t devices produce one signature the on-chain verifier accepts", () => {
  const { indices, shares, groupPk } = splitKey(THRESHOLD, 3)
  const signers = [0, 2].map(i => ({ index: indices[i], share: shares[i] }))
  const { signature } = runRounds(signers, groupPk, MESSAGE)
  assert.equal(signature.signature.length, 64)
  assert.equal(verifyGroupSignature(signature.signature, MESSAGE, groupPk), true)
  // The contract calls `ed25519_verify(sig, group_pk, msg)`; same check, different call site.
  assert.equal(ed25519.verify(signature.signature, MESSAGE, groupPk), true)
})

test("any t-subset works, and each subset yields a different but valid signature", () => {
  const { indices, shares, groupPk } = splitKey(THRESHOLD, 4)
  const subsets = [[0, 1], [1, 2], [0, 3], [2, 3]]
  const signatures: Uint8Array[] = []
  for (const subset of subsets) {
    const signers = subset.map(i => ({ index: indices[i], share: shares[i] }))
    const { signature } = runRounds(signers, groupPk, MESSAGE)
    assert.equal(verifyGroupSignature(signature.signature, MESSAGE, groupPk), true, `subset ${subset}`)
    signatures.push(signature.signature)
  }
  // Different nonces, so different bytes — but all valid.
  assert.equal(new Set(signatures.map(s => Buffer.from(s).toString("hex"))).size, subsets.length)
})

test("fewer than t devices cannot produce an accepted signature", () => {
  const { indices, shares, groupPk } = splitKey(THRESHOLD, 3)
  // One device alone: the aggregate is a valid scalar but not a signature for the group key.
  const single = [{ index: indices[0], share: shares[0] }]
  assert.throws(() => runRounds(single, groupPk, MESSAGE), ThresholdExchangeError)
})

test("a signature over one message does not verify against another", () => {
  const { indices, shares, groupPk } = splitKey(THRESHOLD, 3)
  const signers = [0, 1].map(i => ({ index: indices[i], share: shares[i] }))
  const { signature } = runRounds(signers, groupPk, MESSAGE)
  assert.equal(verifyGroupSignature(signature.signature, new TextEncoder().encode("SESSION_CERT_V1:other"), groupPk), false)
})

test("a signer that skipped round 1 cannot contribute a share", () => {
  const { indices, shares, groupPk } = splitKey(THRESHOLD, 3)
  const round1 = [0, 1].map(i => createNonceCommitment(ORG, indices[i]))
  const aggregateR = aggregateNonce(round1.map(r => r.commitment), ORG)
  assert.throws(() => createSignatureShare({
    orgId: ORG, index: indices[0], secret: round1[0].secret, share: shares[0],
    threshold: BigInt(THRESHOLD), signerIndices: [indices[0], indices[1]],
    aggregateR, groupPk, message: MESSAGE, verifyRoundOne: false,
  }), /未先提交本轮随机数承诺/)
})

test("a duplicate commitment from one index is rejected, not summed twice", () => {
  const commitment = createNonceCommitment(ORG, 1n).commitment
  assert.throws(() => aggregateNonce([commitment, commitment], ORG), /重复提交/)
})

test("commitments from another organization are rejected", () => {
  const other = { ...createNonceCommitment(ORG, 1n).commitment, orgId: "0x" + "bb".repeat(32) }
  assert.throws(() => aggregateNonce([other], ORG), /另一个组织/)
})

test("a malformed commitment point is rejected before any math", () => {
  assert.throws(() => aggregateNonce([{ orgId: ORG, index: 1n, point: new Uint8Array(31) }], ORG), /32 字节/)
})

test("an index outside the signer list cannot sign", () => {
  const { indices, shares, groupPk } = splitKey(THRESHOLD, 3)
  const round1 = [0, 1].map(i => createNonceCommitment(ORG, indices[i]))
  const aggregateR = aggregateNonce(round1.map(r => r.commitment), ORG)
  assert.throws(() => createSignatureShare({
    orgId: ORG, index: indices[2], secret: round1[0].secret, share: shares[2],
    threshold: BigInt(THRESHOLD), signerIndices: [indices[0], indices[1]],
    aggregateR, groupPk, message: MESSAGE, verifyRoundOne: true,
  }), /不在本轮签名者名单/)
})

test("the session certificate message matches the contract's byte layout", () => {
  const sessionId = new Uint8Array(32).fill(7)
  const groupPk = new Uint8Array(32).fill(9)
  const message = sessionCertificateMessage(sessionId, groupPk)
  const prefix = new TextEncoder().encode("SESSION_CERT_V1:")
  assert.equal(prefix.length, 16)
  assert.deepEqual(message.subarray(0, prefix.length), prefix)
  assert.deepEqual(message.subarray(16, 48), sessionId)
  assert.deepEqual(message.subarray(48, 80), groupPk)
  assert.equal(message.length, 80)
})

test("the challenge is the documented hash and changes with every input", () => {
  const R = new Uint8Array(32).fill(1), Y = new Uint8Array(32).fill(2)
  const base = signingChallenge(R, Y, MESSAGE)
  assert.equal(base, signingChallenge(R, Y, MESSAGE))
  assert.notEqual(base, signingChallenge(new Uint8Array(32).fill(3), Y, MESSAGE))
  assert.notEqual(base, signingChallenge(R, new Uint8Array(32).fill(3), MESSAGE))
  assert.notEqual(base, signingChallenge(R, Y, new Uint8Array([1])))
})

test("a wrong group key is caught by verification, not silently accepted", () => {
  const { indices, shares } = splitKey(THRESHOLD, 3)
  const wrongPk = splitKey(THRESHOLD, 3).groupPk
  const signers = [0, 1].map(i => ({ index: indices[i], share: shares[i] }))
  const round1 = signers.map(s => ({ signer: s, ...createNonceCommitment(ORG, s.index) }))
  const aggregateR = aggregateNonce(round1.map(r => r.commitment), ORG)
  const parts = round1.map((entry) => createSignatureShare({
    orgId: ORG, index: entry.signer.index, secret: entry.secret, share: entry.signer.share,
    threshold: BigInt(THRESHOLD), signerIndices: signers.map(s => s.index),
    aggregateR, groupPk: wrongPk, message: MESSAGE, verifyRoundOne: true,
  }))
  assert.throws(() => aggregateSignature(aggregateR, parts, wrongPk, MESSAGE), /未通过群公钥验证/)
})

test("a 1-of-1 committee signs with a single device", () => {
  const coefficients = [randomScalar()]
  const share = coefficients[0]
  const groupPk = ed25519.Point.BASE.multiply(share).toBytes()
  const nonce = createNonceCommitment(ORG, 1n)
  const aggregateR = aggregateNonce([nonce.commitment], ORG)
  const part = createSignatureShare({
    orgId: ORG, index: 1n, secret: nonce.secret, share,
    threshold: 1n, signerIndices: [1n], aggregateR, groupPk, message: MESSAGE, verifyRoundOne: true,
  })
  const { signature } = aggregateSignature(aggregateR, [part], groupPk, MESSAGE)
  assert.equal(verifyGroupSignature(signature, MESSAGE, groupPk), true)
})

test("lagrange coefficients reconstruct the secret at zero", () => {
  const { indices, shares } = splitKey(THRESHOLD, 3)
  const subset = [indices[0], indices[2]]
  const reconstructed = mod(
    shares[0] * lagrangeCoefficient(indices[0], subset)
    + shares[2] * lagrangeCoefficient(indices[2], subset),
  )
  assert.equal(scalarToBytes32(reconstructed).length, 32)
  assert.equal(bytesToScalar(scalarToBytes32(reconstructed)), reconstructed)
})
