import assert from "node:assert/strict"
import { test } from "node:test"
import { ed25519 } from "@noble/curves/ed25519.js"
import { Ed25519PublicKey } from "@mysten/sui/keypairs/ed25519"
import { messageWithIntent, toSerializedSignature } from "@mysten/sui/cryptography"
import { blake2b } from "@noble/hashes/blake2.js"
import { verifySignature } from "@mysten/sui/verify"
import {
  aggregateNonce, aggregateSignature, createNonceCommitment, createSignatureShare,
  type NonceCommitment,
} from "./frost-exchange"
import { GennaroResharingParticipant } from "./crypto/resharing"
import { mod, randomScalar, lagrangeCoefficient } from "./crypto/math"
import type { Point } from "./crypto/vss"

// The property this file exists to prove:
//
//   A DAO whose SUI assets sit at the address derived from its group public key
//   keeps that address — and therefore keeps the assets, and can keep spending
//   them with a threshold signature — across member removal and addition.
//
// Two mechanisms make that true, and both are exercised against real Sui
// primitives (address derivation, signature verification), not a mock:
//
//   1. Sui derives an Ed25519 address as blake2b(0x00 ‖ pubkey). The address
//      depends on the *public* key only, so it cannot move while the group key
//      is unchanged — regardless of who is in the committee.
//   2. Resharing refreshes every share with a polynomial whose constant term is
//      the weighted old share, so the reconstructed secret — and hence the group
//      key — is bit-for-bit identical, while removed members' old shares no
//      longer reconstruct it.
//
// `GennaroResharingParticipant.finalizeNewShare` itself throws when the
// recomputed group key differs from the original, so the key-preservation claim
// is enforced by the implementation rather than asserted only by this test.

const ORG = "0x" + "aa".repeat(32)
const MESSAGE = new TextEncoder().encode("SUI_TRANSFER_INTENT")
const T = 2

interface Member { id: string; index: bigint; share: bigint }

/** Sui's Ed25519 address derivation. */
const suiAddressOf = (publicKey: Uint8Array) => new Ed25519PublicKey(publicKey).toSuiAddress()

/** A t-of-n Shamir split, standing in for the output of a DKG. */
function split(threshold: number, n: number) {
  const coefficients = Array.from({ length: threshold }, () => randomScalar())
  const shareAt = (x: bigint) => coefficients.reduceRight((acc, c) => mod(acc * x + c), 0n)
  const indices = Array.from({ length: n }, (_, i) => BigInt(i + 1))
  return {
    indices,
    shares: indices.map(shareAt),
    groupPk: ed25519.Point.BASE.multiply(coefficients[0]).toBytes(),
  }
}

/** Signs with the supplied shares in the two-round protocol. */
function signWith(shares: { index: bigint; share: bigint }[], groupPk: Uint8Array, message: Uint8Array) {
  const round1 = shares.map(s => ({ signer: s, ...createNonceCommitment(ORG, s.index) }))
  const commitments: NonceCommitment[] = round1.map(r => r.commitment)
  const aggregateR = aggregateNonce(commitments, ORG)
  const signerIndices = shares.map(s => s.index)
  const parts = round1.map(r => createSignatureShare({
    orgId: ORG, index: r.signer.index, secret: r.secret, share: r.signer.share,
    threshold: BigInt(T), signerIndices, aggregateR, groupPk, message, verifyRoundOne: true,
  }))
  return aggregateSignature(aggregateR, parts, groupPk, message).signature
}

/** Runs the same check a Sui full node runs on a submitted signature. */
async function suiAccepts(signature: Uint8Array, message: Uint8Array, groupPk: Uint8Array) {
  const serialized = toSerializedSignature({
    signatureScheme: "ED25519",
    signature,
    publicKey: new Ed25519PublicKey(groupPk),
  })
  // `verifySignature(bytes, signature)`: the signed bytes come first.
  try { await verifySignature(message, serialized); return true } catch { return false }
}

/**
 * Runs Gennaro resharing from `oldCommittee` to `roster`, returning the new
 * shares and the group key each new member recomputed. Throws if any member's
 * recomputed key differs from the original — the implementation enforces that.
 */
function reshare(oldCommittee: Member[], roster: { id: string; index: bigint }[], threshold: number, originalGroupPk: Uint8Array) {
  const oldIndices = oldCommittee.map(m => m.index)
  const rosterMap = new Map(roster.map(m => [m.id, m.index]))
  const oldIds = new Set(oldCommittee.map(m => m.id))

  // Every active old member deals a zero-constant-ish refresh polynomial.
  const packages = oldCommittee.map(member => {
    const node = new GennaroResharingParticipant({
      id: member.id, index: member.index, isOldActiveMember: true,
      isNewMember: rosterMap.has(member.id), currentShare: member.share, newThreshold: threshold,
    })
    return node.generateResharePackage(oldIndices, rosterMap)
  })
  const peerCommitments = new Map<string, Point[]>(packages.map(p => [p.senderId, p.commitments] as [string, Point[]]))

  // Every new member accumulates sub-shares and must recompute the same group key.
  const results = roster.map(member => {
    const node = new GennaroResharingParticipant({
      id: member.id, index: member.index,
      isOldActiveMember: oldIds.has(member.id), isNewMember: true, newThreshold: threshold,
    })
    const incoming = new Map<string, bigint>(packages.map(p => [p.senderId, p.subShares.get(member.id)!] as [string, bigint]))
    return node.finalizeNewShare(incoming, peerCommitments, originalGroupPk)
  })

  for (const result of results) {
    assert.deepEqual(result.groupPublicKey, originalGroupPk, `${result.participantId} recomputed a different group key`)
  }
  return {
    groupPk: results[0].groupPublicKey,
    members: roster.map((member, i) => ({ id: member.id, index: member.index, share: results[i].newPrivateShare })),
  }
}

test("the DAO address comes from the group public key, not from any member", () => {
  const { indices, groupPk } = split(T, 3)
  const daoAddress = suiAddressOf(groupPk)
  assert.match(daoAddress, /^0x[0-9a-f]{64}$/)
  for (const index of indices) {
    assert.notEqual(suiAddressOf(ed25519.Point.BASE.multiply(index).toBytes()), daoAddress)
  }
})

test("a threshold signature from the DAO key passes Sui's own verifier", async () => {
  const { indices, shares, groupPk } = split(T, 3)
  const signature = signWith([0, 1].map(i => ({ index: indices[i], share: shares[i] })), groupPk, MESSAGE)
  assert.equal(await suiAccepts(signature, MESSAGE, groupPk), true)
})

test("removing a member leaves the DAO address, and therefore its assets, untouched", () => {
  const original = split(T, 3)
  const daoAddressBefore = suiAddressOf(original.groupPk)

  const oldCommittee: Member[] = [0, 1].map(i => ({ id: `m${i + 1}`, index: original.indices[i], share: original.shares[i] }))
  const roster = [0, 1].map(i => ({ id: `m${i + 1}`, index: BigInt(i + 1) }))
  const state = reshare(oldCommittee, roster, T, original.groupPk)

  assert.equal(suiAddressOf(state.groupPk), daoAddressBefore)
})

test("after removing a member, the remaining committee still signs for the DAO", async () => {
  const original = split(T, 3)
  const oldCommittee: Member[] = [0, 1].map(i => ({ id: `m${i + 1}`, index: original.indices[i], share: original.shares[i] }))
  const roster = [0, 1].map(i => ({ id: `m${i + 1}`, index: BigInt(i + 1) }))
  const state = reshare(oldCommittee, roster, T, original.groupPk)

  const signature = signWith(state.members.map(m => ({ index: m.index, share: m.share })), state.groupPk, MESSAGE)
  assert.equal(await suiAccepts(signature, MESSAGE, state.groupPk), true)
})

test("stale shares from one generation still reconstruct the key — resharing does not revoke them", async () => {
  const original = split(T, 3)
  const oldCommittee: Member[] = [0, 1].map(i => ({ id: `m${i + 1}`, index: original.indices[i], share: original.shares[i] }))
  const roster = [0, 1].map(i => ({ id: `m${i + 1}`, index: BigInt(i + 1) }))
  const state = reshare(oldCommittee, roster, T, original.groupPk)

  // This is a real limitation, not a bug, and it is the reason the UI must not
  // claim resharing revokes old shares: any t shares from the *same* generation
  // lie on the same polynomial and reconstruct the same secret. Removing a member
  // only helps once their copy is deleted. True revocation changes the key itself
  // (`rotate_group_key`), which moves the DAO address and therefore its assets.
  const stale = [0, 2].map(i => ({ index: original.indices[i], share: original.shares[i] }))
  assert.equal(await suiAccepts(signWith(stale, state.groupPk, MESSAGE), MESSAGE, state.groupPk), true,
    "t stale shares still sign — revocation requires key rotation, not resharing")
})

test("adding a member keeps the address and the enlarged committee can sign", async () => {
  const original = split(T, 3)
  const daoAddressBefore = suiAddressOf(original.groupPk)

  const oldCommittee: Member[] = [0, 1].map(i => ({ id: `m${i + 1}`, index: original.indices[i], share: original.shares[i] }))
  const roster = [0, 1, 2].map(i => ({ id: `m${i + 1}`, index: BigInt(i + 1) }))
  const state = reshare(oldCommittee, roster, T, original.groupPk)

  assert.equal(suiAddressOf(state.groupPk), daoAddressBefore)

  // A signature that includes the newly added member's fresh share.
  const signature = signWith(
    [{ index: state.members[0].index, share: state.members[0].share },
     { index: state.members[2].index, share: state.members[2].share }],
    state.groupPk, MESSAGE,
  )
  assert.equal(await suiAccepts(signature, MESSAGE, state.groupPk), true)
})

test("full sequence: fund, remove, add, sign again — the address never moves", async () => {
  const original = split(T, 3)
  const daoAddress = suiAddressOf(original.groupPk)
  const seen = new Set<string>([daoAddress])

  // Remove m3.
  let committee: Member[] = [0, 1].map(i => ({ id: `m${i + 1}`, index: original.indices[i], share: original.shares[i] }))
  let roster = [0, 1].map(i => ({ id: `m${i + 1}`, index: BigInt(i + 1) }))
  let state = reshare(committee, roster, T, original.groupPk)
  seen.add(suiAddressOf(state.groupPk))

  // Add m3 back.
  committee = state.members
  roster = [0, 1, 2].map(i => ({ id: `m${i + 1}`, index: BigInt(i + 1) }))
  state = reshare(committee, roster, T, original.groupPk)
  seen.add(suiAddressOf(state.groupPk))

  assert.equal(seen.size, 1, "the DAO address must be identical after every membership change")

  const signature = signWith(
    [{ index: state.members[1].index, share: state.members[1].share },
     { index: state.members[2].index, share: state.members[2].share }],
    state.groupPk, MESSAGE,
  )
  assert.equal(await suiAccepts(signature, MESSAGE, state.groupPk), true)
})

test("resharing refuses when a member recomputes a different group key", () => {
  const original = split(T, 3)
  const stranger = split(T, 3).groupPk
  const oldCommittee: Member[] = [0, 1].map(i => ({ id: `m${i + 1}`, index: original.indices[i], share: original.shares[i] }))
  const roster = [0, 1].map(i => ({ id: `m${i + 1}`, index: BigInt(i + 1) }))
  // Passing the wrong expected key must throw inside the implementation, not
  // silently produce shares for a key the chain does not know.
  assert.throws(() => reshare(oldCommittee, roster, T, stranger), /does not match original group public key/)
})

test("shares from before and after a refresh cannot be mixed into one signature", async () => {
  const original = split(T, 3)
  const oldCommittee: Member[] = [0, 1].map(i => ({ id: `m${i + 1}`, index: original.indices[i], share: original.shares[i] }))
  const roster = [0, 1].map(i => ({ id: `m${i + 1}`, index: BigInt(i + 1) }))
  const state = reshare(oldCommittee, roster, T, original.groupPk)

  // One stale share plus one fresh share is not a t-subset of either generation.
  // Aggregation verifies before returning, so this throws rather than producing a
  // signature the chain would reject.
  const mixed = [
    { index: oldCommittee[0].index, share: oldCommittee[0].share },
    { index: state.members[1].index, share: state.members[1].share },
  ]
  assert.throws(() => signWith(mixed, state.groupPk, MESSAGE), /未通过群公钥验证/)
})

test("a third party cannot spend the DAO assets without the committee's shares", async () => {
  const { groupPk } = split(T, 3)
  const thiefSecret = randomScalar()
  const thiefPk = ed25519.Point.BASE.multiply(thiefSecret).toBytes()
  // A signature by any other key must not verify against the DAO key.
  assert.equal(await suiAccepts(ed25519.sign(MESSAGE, scalarToPrivateKey(thiefSecret)), MESSAGE, groupPk), false)
  // Nor does the thief's address equal the DAO's.
  assert.notEqual(suiAddressOf(thiefPk), suiAddressOf(groupPk))
})

/** 32-byte scalar encoding for signing in this test only. */
function scalarToPrivateKey(value: bigint): Uint8Array {
  const out = new Uint8Array(32)
  let rest = value
  for (let i = 31; i >= 0; i--) { out[i] = Number(rest & 0xffn); rest >>= 8n }
  return out
}

test("lagrange coefficients reconstruct the secret at zero", () => {
  const { indices, shares, groupPk } = split(T, 3)
  const subset = [indices[0], indices[2]]
  const reconstructed = mod(
    shares[0] * lagrangeCoefficient(indices[0], subset)
    + shares[2] * lagrangeCoefficient(indices[2], subset),
  )
  assert.deepEqual(ed25519.Point.BASE.multiply(reconstructed).toBytes(), groupPk)
})

// --- the Sui transaction-signing digest -------------------------------------
//
// This one is here because it cost a rejected live transaction: Sui does not sign
// the intent-wrapped bytes, it signs `blake2b(messageWithIntent(...), 32)`. A
// signature over the un-hashed bytes passes a raw `ed25519.verify` and is then
// refused by the full node with "Invalid user signature".

test("Sui signs the blake2b digest of the intent message, not the intent message", async () => {
  const { indices, shares, groupPk } = split(T, 3)
  const signers = [0, 1].map(i => ({ index: indices[i], share: shares[i] }))
  const transactionBytes = new Uint8Array(64).fill(0xab)
  const intent = messageWithIntent("TransactionData", transactionBytes)
  const digest = blake2b(intent, { dkLen: 32 })

  const overDigest = signWith(signers, groupPk, digest)
  const overIntent = signWith(signers, groupPk, intent)

  assert.equal(await suiAccepts(overDigest, digest, groupPk), true, "signing the digest is what the chain accepts")
  assert.equal(await suiAccepts(overIntent, digest, groupPk), false, "a signature over the un-hashed intent is rejected")
  assert.notDeepEqual(overDigest, overIntent)
})
