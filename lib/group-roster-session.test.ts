import "fake-indexeddb/auto"
import assert from "node:assert/strict"
import { test } from "node:test"
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { verifyPersonalMessageSignature } from "@mysten/sui/verify"
import { ed25519, ed25519_FROST } from "@noble/curves/ed25519.js"
import { publicKeyPackageId } from "./dkg-key-package"
import { createMemoryFrostSessionStore, type FrostSessionRecord } from "./frost-session-store"
import { aggregateFrostSession, createFrostRequest, createFrostTranscript, prepareFrostCommitment, produceFrostShare, type BoundDeviceKey } from "./frost-session"
import { createRosterFrostAction } from "./group-roster-transactions"
import { planRosterChange, type LiveOrganization } from "./group-roster"
import { listRosterSessions, mergeFrostRounds, restoreRosterSession } from "./group-roster-session"

async function fixture() {
  const wallets = [Ed25519Keypair.generate(), Ed25519Keypair.generate()]
  const participants = wallets.map(wallet => wallet.toSuiAddress())
  const identifiers = [1, 2].map(index => ed25519_FROST.Identifier.fromNumber(index))
  const dealer = ed25519_FROST.trustedDealer({ min: 2, max: 2 }, identifiers)
  const metadata = { network: "sui:testnet" as const, sessionId: "0x" + "bb".repeat(32), participantAddresses: participants, dealerAddresses: participants, threshold: 2n, sessionEpoch: 7n, commitments: dealer.public.commitments }
  const keys: BoundDeviceKey[] = participants.map((holder, index) => ({ ...metadata, holder, index: BigInt(index + 1), share: ed25519_FROST.utils.Fn.fromBytes(dealer.secretShares[identifiers[index]].signingShare), groupPk: metadata.commitments[0], keyPackageId: publicKeyPackageId(metadata), orgId: "0x" + "aa".repeat(32), epoch: 7n, creationDigest: "00".repeat(32) }))
  const verify = async (bytes: Uint8Array, signature: string, address: string) => { await verifyPersonalMessageSignature(bytes, signature, { address }) }
  const auth = wallets.map(wallet => ({ sign: async (bytes: Uint8Array) => ({ signature: (await wallet.signPersonalMessage(bytes)).signature }), verify }))
  const live: LiveOrganization = { orgId: keys[0].orgId, epoch: 7n, lastNonce: 9n, groupPk: keys[0].groupPk, chainId: new TextEncoder().encode("sui-testnet:"), thresholdWeight: 2n, members: participants.map(address => ({ address, weight: 1n })) }
  const plan = planRosterChange(live, { members: live.members.map(member => ({ ...member, weight: 2n })), thresholdWeight: 3n })
  const request = await createFrostRequest({ action: createRosterFrostAction(live, plan), key: keys[0], signerIndices: [1n, 2n], coordinator: participants[0], expiresAtMs: Date.now() + 60_000 }, auth[0])
  const stores = keys.map(() => createMemoryFrostSessionStore())
  const round1 = await Promise.all(keys.map((key, i) => prepareFrostCommitment(request, key, { store: stores[i], auth: auth[i] })))
  const transcript = await createFrostTranscript(request, round1, auth[0], stores[0])
  const round2 = await Promise.all(keys.map((key, i) => produceFrostShare(request, transcript, key, { store: stores[i], auth: auth[i] })))
  const record: FrostSessionRecord = { request, round1, transcript, round2, updatedAtMs: Date.now() }
  await stores[0].remember(record)
  return { wallets, participants, live, keys, auth, verify, request, round1, transcript, round2, record, store: stores[0] }
}

test("restoring complete public progress revalidates and aggregates without another signature", async () => {
  const f = await fixture()
  const restored = await restoreRosterSession({ requestId: f.request.requestId, live: f.live, holder: f.participants[0], verify: f.verify, store: f.store })
  const result = await aggregateFrostSession(restored.request, restored.transcript!, restored.round2, f.verify)
  assert.equal(ed25519.verify(result.signature, result.digest, f.live.groupPk), true)
  assert.equal((await f.store.restore(f.request.requestId))?.round2.length, 2)
  assert.deepEqual(await produceFrostShare(f.request, f.transcript, f.keys[0], { auth: f.auth[0], store: f.store }), f.round2[0])
  const serialized = JSON.stringify(restored)
  assert.equal(serialized.includes('"nonces"'), false)
  assert.equal(serialized.includes('"share"'), false)
})

test("recovery discovers only this organization and its coordinator or fixed signer", async () => {
  const f = await fixture()
  assert.equal((await listRosterSessions(f.live.orgId, f.participants[0], f.store)).length, 1)
  assert.equal((await listRosterSessions("0x" + "dd".repeat(32), f.participants[0], f.store)).length, 0)
  assert.equal((await listRosterSessions(f.live.orgId, Ed25519Keypair.generate().toSuiAddress(), f.store)).length, 0)
})

test("discovery ignores malformed persisted records before the UI renders their progress", async () => {
  const f = await fixture()
  const records = [
    { ...f.record, round1: undefined },
    { ...f.record, round2: null },
    { ...f.record, updatedAtMs: "invalid" },
    { ...f.record, request: { ...f.request, requestId: "invalid" } },
    f.record,
  ]
  const store = { ...f.store, list: async () => records as FrostSessionRecord[] }
  assert.deepEqual(await listRosterSessions(f.live.orgId, f.participants[0], store), [f.record])
})

test("recovery rejects a different account, stale nonce, epoch and group key", async () => {
  const f = await fixture()
  const restore = (live = f.live, holder = f.participants[0]) => restoreRosterSession({ requestId: f.request.requestId, live, holder, verify: f.verify, store: f.store })
  await assert.rejects(restore(f.live, Ed25519Keypair.generate().toSuiAddress()), /当前账户/)
  await assert.rejects(restore({ ...f.live, lastNonce: 10n }), /不一致/)
  await assert.rejects(restore({ ...f.live, epoch: 8n }), /不一致/)
  await assert.rejects(restore({ ...f.live, groupPk: ed25519.Point.BASE.toBytes() }), /群公钥/)
})

test("recovery rejects persisted tampering and Round 2 without its authenticated transcript", async () => {
  const f = await fixture()
  const restore = async (record: FrostSessionRecord) => {
    const store = createMemoryFrostSessionStore()
    await store.remember(record)
    return restoreRosterSession({ requestId: f.request.requestId, live: f.live, holder: f.participants[0], verify: f.verify, store })
  }
  await assert.rejects(restore({ ...f.record, request: { ...f.request, signature: "invalid" } }))
  await assert.rejects(restore({ ...f.record, round1: [{ ...f.round1[0], signature: "invalid" }, f.round1[1]] }))
  await assert.rejects(restore({ ...f.record, transcript: undefined }), /缺少已验证的 transcript/)
  await assert.rejects(restore({ ...f.record, round2: [{ ...f.round2[0], scalar: "00".repeat(32) }] }), /share verification failed/)
})

test("recovery rejects expired requests before returning any usable progress", async t => {
  const f = await fixture()
  // Let a correctly signed request expire without changing its authenticated bytes.
  t.mock.method(Date, "now", () => f.request.expiresAtMs)
  await assert.rejects(restoreRosterSession({ requestId: f.request.requestId, live: f.live, holder: f.participants[0], verify: f.verify, store: f.store }), /expired/)
})

test("manual full-array retries are idempotent while changed commitments or shares fail", async () => {
  const f = await fixture()
  assert.deepEqual(mergeFrostRounds([f.round1[0]], f.round1), f.round1)
  assert.deepEqual(mergeFrostRounds(f.round2, f.round2), f.round2)
  assert.throws(() => mergeFrostRounds(f.round1, [{ ...f.round1[0], binding: f.round1[1].binding }]), /冲突/)
  assert.throws(() => mergeFrostRounds(f.round2, [{ ...f.round2[0], transcriptHash: "ff".repeat(32) }]), /冲突/)
})
