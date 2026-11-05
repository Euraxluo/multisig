import assert from "node:assert/strict"
import { afterEach, mock, test } from "node:test"
import { bcs } from "@mysten/sui/bcs"
import type { SuiClientTypes } from "@mysten/sui/client"
import { generateMessageKey, publicKeyBytes, sealMessage, toBase64 } from "./message-crypto"

const address = (digit: string) => `0x${digit.repeat(64)}`
const packageId = address("a")
process.env.NEXT_PUBLIC_IDENTITY_PACKAGE_ID = packageId
process.env.NEXT_PUBLIC_IDENTITY_NAMES_ID = address("b")
const { identityRpc } = require("./identity-client") as typeof import("./identity-client")
const { getPrivateMessages, readPrivateMessageHistory } = require("./private-messages") as typeof import("./private-messages")
const me: import("./identity-client").IdentityProfile = { id: address("1"), address: address("2"), label: "alice", displayName: "", avatarUrl: "", encryptionKey: [], followingTable: address("3"), followingCount: 0 }
const peer = { ...me, id: address("4"), address: address("5"), label: "bob" }
const MessageSent = bcs.struct("MessageSent", { sender: bcs.Address, recipient: bcs.Address, ciphertext: bcs.vector(bcs.u8()), nonce: bcs.vector(bcs.u8()), ephemeral_public_key: bcs.vector(bcs.u8()), recipient_key: bcs.vector(bcs.u8()) })
const eventType = `${packageId}::identity::MessageSent`
const page = (events: SuiClientTypes.EventEntry[], hasNextPage = false, endCursor: string | null = null) => ({ events, hasNextPage, startCursor: endCursor, endCursor })
async function encryptedEvent(sender = peer, recipient = me, digest = "digest", index = 0) {
  const [senderPair, recipientPair] = await Promise.all([generateMessageKey(), generateMessageKey()])
  const senderKey = await publicKeyBytes(senderPair.publicKey), recipientKey = await publicKeyBytes(recipientPair.publicKey)
  const sealed = await sealMessage("链上私信", senderKey, recipientKey, { senderId: sender.id, recipientId: recipient.id })
  const fields = { sender: sender.id, recipient: recipient.id, ciphertext: Array.from(sealed.ciphertext), nonce: Array.from(sealed.nonce), ephemeral_public_key: Array.from(sealed.ephemeralKey), recipient_key: Array.from(recipientKey) }
  const event: SuiClientTypes.EventEntry = { packageId, module: "identity", sender: sender.address, eventType, bcs: MessageSent.serialize(fields).toBytes(), json: null, checkpoint: "42", transactionDigest: digest, eventIndex: index }
  return { event, fields, senderPair, recipientPair, senderKey, recipientKey }
}
function transactions(timestampMs: number | null = 1_700_000_000_000) {
  return mock.method(identityRpc, "getTransaction", async () => ({ $kind: "Transaction", Transaction: { status: { success: true, error: null }, timestampMs } }))
}
// Only the browser key-storage boundary is simulated. ECDH/HKDF/AES-GCM run for real.
const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, "indexedDB")
function installDeviceKeys(records: Map<string, CryptoKeyPair>) {
  const database = {
    close() {},
    transaction() {
      return { objectStore() { return { get(id: string) {
        const request: { result?: { id: string; pair: CryptoKeyPair }; onsuccess?: () => void } = {}
        queueMicrotask(() => { const pair = records.get(id); request.result = pair ? { id, pair } : undefined; request.onsuccess?.() })
        return request
      } } } }
    },
  }
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: { open() {
    const request: { result: typeof database; onsuccess?: () => void } = { result: database }
    queueMicrotask(() => request.onsuccess?.())
    return request
  } } as unknown as IDBFactory })
}
afterEach(() => {
  mock.restoreAll()
  if (originalIndexedDB) Object.defineProperty(globalThis, "indexedDB", originalIndexedDB)
  else Reflect.deleteProperty(globalThis, "indexedDB")
})

test("exposes scan completeness while keeping the legacy array API", async () => {
  const { event } = await encryptedEvent(peer, me, "history")
  let calls = 0
  mock.method(identityRpc, "listEvents", async ({ filter, before }: SuiClientTypes.ListEventsOptions) => {
    calls++
    if (filter?.sender === me.address) return page([])
    return before ? page([], false, "done") : page([event], true, "frontier")
  })
  transactions()
  installDeviceKeys(new Map())
  const history = await readPrivateMessageHistory(me, peer, { maxPages: 1 })
  assert.deepEqual(history, { messages: [{ id: "history:0", senderId: peer.id, recipientId: me.id, text: null, timestampMs: 1_700_000_000_000, unavailableReason: "此设备没有该消息的私钥，无法解密。" }], truncated: true, scannedEvents: 1 })
  assert.equal((await getPrivateMessages(me, peer)).length, 1)
  assert.equal(calls, 5)
})

test("paginates gRPC events including empty scan pages, deduplicates, and uses transaction time", async () => {
  const { event } = await encryptedEvent()
  const cursors: Array<string | null | undefined> = []
  mock.method(identityRpc, "listEvents", async ({ filter, before, order }: SuiClientTypes.ListEventsOptions) => {
    assert.equal(order, "descending")
    if (filter?.sender === me.address) return page([])
    assert.equal(filter?.sender, peer.address)
    cursors.push(before)
    return before ? page([event, event]) : page([], true, "scan-frontier")
  })
  const time = transactions()
  installDeviceKeys(new Map())
  const messages = await getPrivateMessages(me, peer)
  assert.deepEqual(cursors, [null, "scan-frontier"])
  assert.equal(messages.length, 1)
  assert.equal(messages[0].id, "digest:0")
  assert.equal(messages[0].timestampMs, 1_700_000_000_000)
  assert.equal(messages[0].senderId, peer.id)
  assert.match(messages[0].unavailableReason!, /没有该消息的私钥/)
  assert.equal(time.mock.callCount(), 1)
})

test("decrypts incoming and outgoing BCS envelopes with existing non-extractable device keys", async () => {
  const incoming = await encryptedEvent(peer, me, "incoming")
  const outgoing = await encryptedEvent(me, peer, "outgoing")
  mock.method(identityRpc, "listEvents", async ({ filter }: SuiClientTypes.ListEventsOptions) => page([filter?.sender === me.address ? outgoing.event : incoming.event]))
  transactions()
  const keys = new Map([
    [`${packageId}::identity:${me.id}:${toBase64(incoming.recipientKey)}`, incoming.recipientPair],
    [`${packageId}::identity:${me.id}:${toBase64(outgoing.senderKey)}`, outgoing.senderPair],
  ])
  installDeviceKeys(keys)
  assert.equal(incoming.recipientPair.privateKey.extractable, false)
  const messages = await getPrivateMessages(me, peer)
  assert.equal(messages.length, 2)
  assert.ok(messages.every(message => message.text === "链上私信" && !message.unavailableReason))
})

test("keeps incoming recipient-key epoch binding when parsing BCS events", async () => {
  const { event, fields } = await encryptedEvent()
  fields.recipient_key[1] ^= 1
  event.bcs = MessageSent.serialize(fields).toBytes()
  mock.method(identityRpc, "listEvents", async ({ filter }: SuiClientTypes.ListEventsOptions) => page(filter?.sender === peer.address ? [event] : []))
  transactions()
  const [message] = await getPrivateMessages(me, peer)
  assert.equal(message.text, null)
  assert.match(message.unavailableReason!, /接收密钥与链上记录不匹配/)
})

test("filters exact contract type and both identities before reading timestamps", async () => {
  const { event, fields } = await encryptedEvent()
  const unrelated = { ...event, bcs: MessageSent.serialize({ ...fields, recipient: address("f") }).toBytes() }
  mock.method(identityRpc, "listEvents", async () => page([{ ...event, eventType: `${address("b")}::identity::MessageSent` }, unrelated]))
  const time = transactions()
  assert.deepEqual(await getPrivateMessages(me, peer), [])
  assert.equal(time.mock.callCount(), 0)
})

test("rejects event senders that do not own the claimed protocol identity", async () => {
  const { event } = await encryptedEvent()
  mock.method(identityRpc, "listEvents", async () => page([{ ...event, sender: me.address }]))
  await assert.rejects(getPrivateMessages(me, peer), /发送方与身份所有者/)
})

test("does not turn event-query or transaction-time failures into an empty history", async () => {
  mock.method(identityRpc, "listEvents", async () => { throw new Error("event service unavailable") })
  await assert.rejects(getPrivateMessages(me, peer), /event service unavailable/)
  mock.restoreAll()
  const { event } = await encryptedEvent()
  mock.method(identityRpc, "listEvents", async ({ filter }: SuiClientTypes.ListEventsOptions) => page(filter?.sender === peer.address ? [event] : []))
  mock.method(identityRpc, "getTransaction", async () => { throw new Error("transaction service unavailable") })
  await assert.rejects(getPrivateMessages(me, peer), /transaction service unavailable/)
  mock.restoreAll()
  mock.method(identityRpc, "listEvents", async ({ filter }: SuiClientTypes.ListEventsOptions) => page(filter?.sender === peer.address ? [event] : []))
  transactions(null)
  await assert.rejects(getPrivateMessages(me, peer), /有效的链上时间/)
})

test("discovers inbound conversations without requiring a follow edge and keeps undecryptable previews", async () => {
  const incoming = await encryptedEvent(peer, me, "inbox")
  mock.method(identityRpc, "listEvents", async ({ filter }: SuiClientTypes.ListEventsOptions) => {
    assert.equal(filter?.eventType, eventType)
    return page([incoming.event, incoming.event])
  })
  transactions()
  installDeviceKeys(new Map())
  const result = await require("./private-messages").listPrivateConversations(me, { resolveProfile: async (id: string) => {
    assert.equal(id, peer.id)
    return peer
  } }) as import("./private-messages").PrivateConversationList
  assert.equal(result.conversations.length, 1)
  assert.equal(result.conversations[0].peer.id, peer.id)
  assert.equal(result.conversations[0].messageCount, 1)
  const last = result.conversations[0].lastMessage
  assert.ok(last && last.unavailableReason, "the last message should carry an unavailability reason")
  assert.match(last.unavailableReason, /没有该消息的私钥/)
  assert.equal(result.truncated, false)
  assert.equal(result.scannedEvents, 2)
})

test("deduplicates inbox events, marks scan truncation, and rejects a stuck cursor", async () => {
  const incoming = await encryptedEvent(peer, me, "cursor")
  let calls = 0
  mock.method(identityRpc, "listEvents", async () => {
    calls++
    return calls === 1 ? page([incoming.event], true, "frontier") : page([incoming.event], true, "frontier-2")
  })
  transactions()
  installDeviceKeys(new Map())
  const result = await require("./private-messages").listPrivateConversations(me, { maxPages: 2, resolveProfile: async () => peer }) as import("./private-messages").PrivateConversationList
  assert.equal(result.conversations[0].messageCount, 1)
  assert.equal(result.truncated, true)
  mock.restoreAll()
  mock.method(identityRpc, "listEvents", async () => page([], true, "same-frontier"))
  await assert.rejects(require("./private-messages").listPrivateConversations(me, { resolveProfile: async () => peer }), /分页未前进/)
})

test("rejects an inbox event whose transaction sender does not own the claimed identity", async () => {
  const incoming = await encryptedEvent(peer, me, "ownership")
  mock.method(identityRpc, "listEvents", async () => page([{ ...incoming.event, sender: address("9") }]))
  await assert.rejects(require("./private-messages").listPrivateConversations(me, { resolveProfile: async () => peer }), /发送方与身份所有者/)
})
