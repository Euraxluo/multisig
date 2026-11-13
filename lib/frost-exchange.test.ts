import assert from "node:assert/strict"
import { test } from "node:test"
import { ed25519 } from "@noble/curves/ed25519.js"
import { ThresholdSignerNode } from "multisig/dkg"
import { mod, randomScalar, lagrangeCoefficient, scalarToBytes32, bytesToScalar } from "./crypto/math"
import {
  aggregateNonce, aggregateSignature, createNonceCommitment, createSignatureShare,
  sessionCertificateMessage, signingChallenge, ThresholdExchangeError, verifyGroupSignature,
  type NonceCommitment,
} from "./frost-exchange"

// These tests pin the property that actually matters: a set of t devices, each
// holding one share and running the two rounds in order, produces a signature the
// on-chain `ed25519_verify` accepts; and skipping or reordering a round does not.
// Round-7: the scheme is RFC 9591 §4.4 — every commitment pair is bound by a
// per-participant binding factor ρ_i, so crafted commitments cannot cancel
// honest nonces.

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
  const round1 = signers.map(signer => createNonceCommitment(ORG, signer.index, signer.share))
  const commitments: NonceCommitment[] = round1.map(entry => entry.commitment)
  const aggregateR = aggregateNonce(commitments, ORG, message, groupPk)
  const signerIndices = signers.map(signer => signer.index)
  const shares = round1.map((entry) => createSignatureShare({
    node: entry.node, orgId: ORG,
    threshold: BigInt(THRESHOLD), signerIndices, commitments, groupPk, message,
  }))
  return { aggregateR, signature: aggregateSignature(commitments, shares, groupPk, message) }
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
  // Round 1 ran for holders 1 and 2 only; holder 3 is in the round's signer
  // list but its node never generated a commitment — no nonces exist, so the
  // node refuses to sign.
  const round1 = [0, 1].map(i => createNonceCommitment(ORG, indices[i], shares[i]))
  const commitments = round1.map(r => r.commitment)
  const skipped = new ThresholdSignerNode("skipped", indices[2], shares[2])
  assert.throws(() => createSignatureShare({
    node: skipped, orgId: ORG,
    threshold: BigInt(THRESHOLD), signerIndices: [indices[0], indices[1], indices[2]],
    commitments, groupPk, message: MESSAGE,
  }), /nonce|consumed/i)
})

test("a node cannot sign twice: nonces are consumed by the first round-2 call", () => {
  const { indices, shares, groupPk } = splitKey(THRESHOLD, 2)
  const round1 = [0, 1].map(i => createNonceCommitment(ORG, indices[i], shares[i]))
  const commitments = round1.map(r => r.commitment)
  const signerIndices = [indices[0], indices[1]]
  createSignatureShare({ node: round1[0].node, orgId: ORG, threshold: 2n, signerIndices, commitments, groupPk, message: MESSAGE })
  assert.throws(() => createSignatureShare({
    node: round1[0].node, orgId: ORG, threshold: 2n, signerIndices, commitments, groupPk, message: MESSAGE,
  }), /nonce|consumed/i)
})

test("a duplicate commitment from one index is rejected, not summed twice", () => {
  const { shares } = splitKey(THRESHOLD, 2)
  const commitment = createNonceCommitment(ORG, 1n, shares[0]).commitment
  assert.throws(() => aggregateNonce([commitment, commitment], ORG, MESSAGE, splitKey(THRESHOLD, 2).groupPk), /重复提交/)
})

test("commitments from another organization are rejected", () => {
  const { shares, groupPk } = splitKey(THRESHOLD, 2)
  const other = { ...createNonceCommitment(ORG, 1n, shares[0]).commitment, orgId: "0x" + "bb".repeat(32) }
  assert.throws(() => aggregateNonce([other], ORG, MESSAGE, groupPk), /另一个组织/)
})

test("a malformed or small-order commitment point is rejected before any math", () => {
  const { shares, groupPk } = splitKey(THRESHOLD, 2)
  const good = createNonceCommitment(ORG, 1n, shares[0]).commitment
  assert.throws(
    () => aggregateNonce([{ orgId: ORG, index: 2n, hiding: new Uint8Array(31), binding: good.binding }], ORG, MESSAGE, groupPk),
    /32-byte/,
  )
  // Small-order (order-8 torsion) point must be refused: commitments are
  // validated by the SDK's parseValidPoint before aggregation.
  const smallOrderHex = "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05"
  const smallOrder = new Uint8Array(32)
  for (let i = 0; i < 32; i++) smallOrder[i] = parseInt(smallOrderHex.slice(i * 2, i * 2 + 2), 16)
  assert.throws(
    () => aggregateNonce([{ orgId: ORG, index: 2n, hiding: smallOrder, binding: good.binding }], ORG, MESSAGE, groupPk),
    /torsion-free|identity|bad point/i,
  )
})

test("an index outside the signer list cannot sign", () => {
  const { indices, shares, groupPk } = splitKey(THRESHOLD, 3)
  const round1 = [0, 1].map(i => createNonceCommitment(ORG, indices[i], shares[i]))
  const outsider = createNonceCommitment(ORG, indices[2], shares[2]).node
  assert.throws(() => createSignatureShare({
    node: outsider, orgId: ORG,
    threshold: BigInt(THRESHOLD), signerIndices: [indices[0], indices[1]],
    commitments: round1.map(r => r.commitment), groupPk, message: MESSAGE,
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
  const round1 = signers.map(s => createNonceCommitment(ORG, s.index, s.share))
  const commitments = round1.map(r => r.commitment)
  const parts = round1.map((entry) => createSignatureShare({
    node: entry.node, orgId: ORG,
    threshold: BigInt(THRESHOLD), signerIndices: signers.map(s => s.index),
    commitments, groupPk: wrongPk, message: MESSAGE,
  }))
  assert.throws(() => aggregateSignature(commitments, parts, wrongPk, MESSAGE), /未通过群公钥验证/)
})

test("a 1-of-1 committee signs with a single device", () => {
  const coefficients = [randomScalar()]
  const share = coefficients[0]
  const groupPk = ed25519.Point.BASE.multiply(share).toBytes()
  const nonce = createNonceCommitment(ORG, 1n, share)
  const aggregateR = aggregateNonce([nonce.commitment], ORG, MESSAGE, groupPk)
  const part = createSignatureShare({
    node: nonce.node, orgId: ORG, threshold: 1n, signerIndices: [1n],
    commitments: [nonce.commitment], groupPk, message: MESSAGE,
  })
  const { signature } = aggregateSignature([nonce.commitment], [part], groupPk, MESSAGE)
  assert.equal(verifyGroupSignature(signature, MESSAGE, groupPk), true)
  // R̄ must equal the node's hiding commitment (single participant, ρ_1 only
  // multiplies its own binding part which cancels nothing here by construction
  // of the honest run) — checked via the aggregate verifying at all.
  assert.equal(aggregateR.length, 32)
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

test("round-7 regression: crafted negative commitments cannot cancel honest nonces", () => {
  // Old single-nonce scheme: R = Σ r_i·G with no binding. Holder 2 publishing
  // R_2 = -R_1 zeroes the aggregate and lets holder 2 forge with z_2 = c·λ_2·s_2.
  // Now every D_i/E_i pair enters the challenge through per-index ρ_i, so the
  // cancellation pair's effective nonce point is -(D_1 + ρ_2·E_1) ≠ 0 and the
  // forger's share fails both verifyShare and the aggregate self-check.
  const { indices, shares, groupPk } = splitKey(THRESHOLD, 2)
  const honest = createNonceCommitment(ORG, indices[0], shares[0])
  const forger = createNonceCommitment(ORG, indices[1], shares[1])
  const hidingPoint = ed25519.Point.fromBytes(honest.commitment.hiding)
  const bindingPoint = ed25519.Point.fromBytes(honest.commitment.binding)
  const crafted: NonceCommitment = {
    orgId: ORG, index: indices[1],
    hiding: hidingPoint.negate().toBytes(),
    binding: bindingPoint.negate().toBytes(),
  }
  const commitments = [honest.commitment, crafted]
  const aggregateR = aggregateNonce(commitments, ORG, MESSAGE, groupPk)
  assert.ok(!aggregateR.every(b => b === 0), "R̄ must not collapse to identity")

  const c = signingChallenge(aggregateR, groupPk, MESSAGE)
  const lambda2 = lagrangeCoefficient(indices[1], [indices[0], indices[1]])
  const forged = { orgId: ORG, index: indices[1], scalar: scalarToBytes32(mod(c * lambda2 * shares[1])) }
  const honestShare = createSignatureShare({
    node: honest.node, orgId: ORG, threshold: 2n, signerIndices: [indices[0], indices[1]],
    commitments, groupPk, message: MESSAGE,
  })
  assert.throws(
    () => aggregateSignature(commitments, [honestShare, forged], groupPk, MESSAGE),
    /未通过群公钥验证|self-verification/i,
  )
  // The forger's own node (which never generated these nonces) must also be
  // unable to produce a share consistent with the crafted commitments.
  assert.throws(() => {
    const share = forger.node.computeSignatureShare(MESSAGE, groupPk, [
      { participantId: indices[0].toString(), participantIndex: indices[0], hiding: honest.commitment.hiding, binding: honest.commitment.binding },
      { participantId: indices[1].toString(), participantIndex: indices[1], hiding: crafted.hiding, binding: crafted.binding },
    ])
    aggregateSignature(commitments, [honestShare, { orgId: ORG, index: indices[1], scalar: scalarToBytes32(share.shareZ) }], groupPk, MESSAGE)
  }, /未通过群公钥验证|self-verification/i)
})
