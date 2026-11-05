import "fake-indexeddb/auto"
import assert from "node:assert/strict"
import { test } from "node:test"
import { ed25519, ed25519_FROST } from "@noble/curves/ed25519.js"
import { publicKeyPackageId } from "./dkg-key-package"
import { sha256 } from "@noble/hashes/sha2.js"
import { createFrostRequest, createFrostTranscript, prepareFrostCommitment, produceFrostShare, aggregateFrostSession, verifyFrostRequest, FrostSessionError, type BoundDeviceKey, type ProtocolAuth } from "./frost-session"
import { createMemoryFrostSessionStore, type FrostSessionStore } from "./frost-session-store"

const addresses = ["0x" + "11".repeat(32), "0x" + "22".repeat(32), "0x" + "33".repeat(32)]
const orgId = "0x" + "aa".repeat(32)
const auth: ProtocolAuth = {
  async sign(bytes) { return { signature: Buffer.from(sha256(bytes)).toString("hex") } },
  async verify(bytes, signature, address) { assert.equal(signature, Buffer.from(sha256(bytes)).toString("hex")); assert.ok([orgId, ...addresses].includes(address)) },
}
function fixture(threshold = 2, count = 3) {
  const ids = addresses.slice(0, count).map((_, i) => ed25519_FROST.Identifier.fromNumber(i + 1))
  if (threshold === 1) {
    const commitments = [ed25519.Point.BASE.multiply(5n).toBytes()]
    const metadata = { network: "sui:testnet" as const, sessionId: "0x" + "bb".repeat(32), participantAddresses: [addresses[0]], dealerAddresses: [addresses[0]], threshold: 1n, sessionEpoch: 7n, commitments }
    const keyPackageId = publicKeyPackageId(metadata)
    const key = { ...metadata, holder: addresses[0], index: 1n, share: 5n, groupPk: commitments[0], keyPackageId, orgId, epoch: 7n, creationDigest: "00".repeat(32) }
    return { keys: [key] as BoundDeviceKey[], packageId: keyPackageId }
  }
  const dealer = ed25519_FROST.trustedDealer({ min: threshold, max: count }, ids)
  const commitments = dealer.public.commitments
  const metadata = { network: "sui:testnet" as const, sessionId: "0x" + "bb".repeat(32), participantAddresses: addresses.slice(0, count), dealerAddresses: addresses.slice(0, threshold), threshold: BigInt(threshold), sessionEpoch: 7n, commitments }
  const packageId = publicKeyPackageId(metadata)
  const keys = ids.map((id, i) => ({ ...metadata, holder: addresses[i], index: BigInt(i + 1), share: ed25519_FROST.utils.Fn.fromBytes(dealer.secretShares[id].signingShare), groupPk: commitments[0], keyPackageId: packageId, orgId, epoch: 7n, creationDigest: "00".repeat(32) })) as BoundDeviceKey[]
  return { keys, packageId }
}
const action = { kind: "proposal" as const, packageId: "0x" + "cc".repeat(32), orgId, epoch: "7", nonce: "9", chainIdHex: "00".repeat(32), actionType: 2, payloadHex: "01020304" }
async function sign(threshold = 2, count = 3, signerIndices = [1n, 2n], storeByIndex?: Map<number, FrostSessionStore>) {
  const { keys } = fixture(threshold, count)
  const localStores = storeByIndex ?? new Map<number, FrostSessionStore>()
  const store = (index: number) => { if (!localStores.has(index)) localStores.set(index, createMemoryFrostSessionStore()); return localStores.get(index)! }
  const request = await createFrostRequest({ action, key: keys[0], signerIndices, coordinator: addresses[0], expiresAtMs: Date.now() + 60_000 }, auth)
  const rounds = await Promise.all(signerIndices.map(async i => prepareFrostCommitment(request, keys[Number(i - 1n)], { store: store(Number(i)), auth })))
  const transcript = await createFrostTranscript(request, rounds, auth, store(Number(signerIndices[0])))
  for (let i = 0; i < signerIndices.length; i++) await store(Number(signerIndices[i])).remember({ request, round1: rounds, transcript, round2: [], updatedAtMs: Date.now() })
  const shares = await Promise.all(signerIndices.map(async i => produceFrostShare(request, transcript, keys[Number(i - 1n)], { store: store(Number(i)), auth })))
  return { result: await aggregateFrostSession(request, transcript, shares, auth.verify), request, transcript, rounds, shares, keys, store }
}

test("independent device stores produce RFC 9591 signature verified against DKG group key", async () => {
  const stores = new Map([1, 2].map(i => [i, createMemoryFrostSessionStore()]))
  const { result, keys } = await sign(2, 3, [1n, 3n], stores)
  assert.equal(result.signature.length, 64)
  assert.equal(ed25519_FROST.verify(result.signature, result.digest, keys[0].groupPk), true)
})

test("single-signer scalar path emits a normal Ed25519 signature, never a scalar seed", async () => {
  const { result, keys } = await sign(1, 1, [1n])
  assert.equal(result.signature.length, 64)
  assert.equal(ed25519_FROST.verify(result.signature, result.digest, keys[0].groupPk), true)
})

test("nonce is durably consumed before share and cannot sign another transcript", async () => {
  const { request, transcript, keys, store, rounds } = await sign(2, 3, [1n, 2n])
  const altered = { ...transcript, transcriptHash: "ff".repeat(32) }
  await assert.rejects(() => produceFrostShare(request, altered, keys[0], { store: store(1), auth }), FrostSessionError)
  assert.equal(rounds.length, 2)
})

test("below-threshold signer request and duplicate commitments are rejected", async () => {
  const { keys } = fixture(2, 3)
  await assert.rejects(() => createFrostRequest({ action, key: keys[0], signerIndices: [1n], coordinator: addresses[0], expiresAtMs: Date.now() + 60_000 }, auth), FrostSessionError)
  await assert.rejects(() => sign(2, 3, [1n, 1n]), FrostSessionError)
})

test("expired requests remain invalid for signing but can be authenticated for an existing receipt recovery", async t => {
  const { request } = await sign()
  t.mock.method(Date, "now", () => request.expiresAtMs)
  await assert.rejects(() => verifyFrostRequest(request, auth.verify), /expired/)
  await verifyFrostRequest(request, auth.verify, { allowExpired: true })
})

test("expired receipt aggregation never relaxes commitment, transcript, share or normal aggregate expiry", async t => {
  const { aggregateFrostSessionForReceiptRecovery } = await import("./frost-session")
  const { request, transcript, shares, keys, store, result } = await sign()
  t.mock.method(Date, "now", () => request.expiresAtMs)
  await assert.rejects(() => prepareFrostCommitment(request, keys[0], { store: store(1), auth }), /expired/)
  await assert.rejects(() => createFrostTranscript(request, transcript.round1, auth, store(1)), /expired/)
  await assert.rejects(() => produceFrostShare(request, transcript, keys[0], { store: store(1), auth }), /expired/)
  await assert.rejects(() => aggregateFrostSession(request, transcript, shares, auth.verify), /expired/)
  const recovered = await aggregateFrostSessionForReceiptRecovery(request, transcript, shares, auth.verify)
  assert.deepEqual(recovered, result)
})

test("changed request contexts and round-two transcript hashes are rejected", async () => {
  const { request, transcript, shares, keys, store } = await sign(2, 3, [1n, 2n])
  const { aggregateFrostSession } = await import("./frost-session")
  await assert.rejects(() => aggregateFrostSession({ ...request, contextHash: "00".repeat(32) }, transcript, shares, auth.verify), FrostSessionError)
  await assert.rejects(() => aggregateFrostSession(request, transcript, [{ ...shares[0], transcriptHash: "00".repeat(32) }, shares[1]], auth.verify), FrostSessionError)
  const alteredAction = { ...request.action, orgId: "0x" + "dd".repeat(32) }
  const alteredRequest = { ...request, action: alteredAction, contextHash: "00".repeat(32) }
  await assert.rejects(() => prepareFrostCommitment(alteredRequest, keys[0], { store: store(1), auth }), /context hash mismatch/)
  await assert.rejects(() => produceFrostShare({ ...request, action: { ...request.action, epoch: "2" } }, transcript, keys[0], { store: store(1), auth }), /context hash mismatch/)
})
