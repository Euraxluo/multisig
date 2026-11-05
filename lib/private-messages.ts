"use client"

import { bcs } from "@mysten/sui/bcs"
import type { SuiClientTypes } from "@mysten/sui/client"
import { normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils"
import { getIdentity, identityConfigured, identityModule, identityRpc, setEncryptionKey, submitPrivateMessage, type IdentityProfile } from "./identity-client"
import { generateMessageKey, publicKeyBytes, sealMessage, openMessage, readEnvelope, toBase64 } from "./message-crypto"
import { t } from "./i18n/t"

export interface PrivateMessage { id: string; senderId: string; recipientId: string; text: string | null; timestampMs: number; unavailableReason?: string }
export interface PrivateConversation { peer: IdentityProfile; lastMessage: PrivateMessage | null; messageCount: number }
export interface PrivateConversationList { conversations: PrivateConversation[]; scannedEvents: number; truncated: boolean; failures: Array<{ senderId: string; reason: string }> }
export interface PrivateMessageHistory { messages: PrivateMessage[]; truncated: boolean; scannedEvents: number }
export interface PrivateMessageHistoryOptions { maxPages?: number; pageSize?: number }
const MessageSent = bcs.struct("MessageSent", {
  sender: bcs.Address, recipient: bcs.Address, ciphertext: bcs.vector(bcs.u8()), nonce: bcs.vector(bcs.u8()),
  ephemeral_public_key: bcs.vector(bcs.u8()), recipient_key: bcs.vector(bcs.u8()),
})
const requestSignal = () => AbortSignal.timeout(20_000)
interface StoredKey { id: string; pair: CryptoKeyPair }
// IndexedDB structured-clones non-extractable CryptoKeys; never export the private key.
function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("sui-identity-private-messages", 1)
    request.onupgradeneeded = () => request.result.createObjectStore("keys", { keyPath: "id" })
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(new Error(t("misc.dmLib.openFailed")))
    request.onblocked = () => reject(new Error(t("misc.dmLib.blocked")))
  })
}

async function readKey(id: string): Promise<StoredKey | undefined> {
  const db = await database()
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("keys", "readonly")
      const request = tx.objectStore("keys").get(id)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(new Error(t("misc.dmLib.readFailed")))
    })
  } finally { db.close() }
}

async function saveKey(record: StoredKey): Promise<void> {
  const db = await database()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("keys", "readwrite")
      tx.objectStore("keys").put(record)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(new Error(t("misc.dmLib.saveFailed")))
      tx.onabort = () => reject(new Error(t("misc.dmLib.saveRetry")))
    })
  } finally { db.close() }
}

function keyId(profile: IdentityProfile, key: Uint8Array): string {
  return `${identityModule}:${profile.id}:${toBase64(key)}`
}

export async function hasMessagingKey(profile: IdentityProfile): Promise<boolean> {
  if (!profile.encryptionKey.length) return false
  return !!(await readKey(keyId(profile, new Uint8Array(profile.encryptionKey))))
}

export async function enablePrivateMessages(profile: IdentityProfile): Promise<void> {
  if (await hasMessagingKey(profile)) return
  // Reuse an unpublished pending key after rejection/retry; retain old published keys for history.
  const pendingId = `${identityModule}:${profile.id}:pending`
  const pending = await readKey(pendingId)
  const pair = pending?.pair ?? await generateMessageKey()
  if (!pending) await saveKey({ id: pendingId, pair })
  const key = await publicKeyBytes(pair.publicKey)
  await saveKey({ id: keyId(profile, key), pair })
  await setEncryptionKey(profile, key)
}

export async function sendPrivateMessage(sender: IdentityProfile, recipient: IdentityProfile, text: string): Promise<void> {
  const [liveSender, liveRecipient] = await Promise.all([getIdentity(sender.id), getIdentity(recipient.id)])
  if (!(await hasMessagingKey(liveSender))) throw new Error(t("misc.dmLib.enableFirst"))
  if (!liveRecipient.encryptionKey.length) throw new Error(t("misc.dmLib.peerNotEnabled"))
  if (liveSender.id === liveRecipient.id) throw new Error(t("misc.dmLib.pickOther"))
  const encrypted = await sealMessage(text, new Uint8Array(liveSender.encryptionKey), new Uint8Array(liveRecipient.encryptionKey), { senderId: liveSender.id, recipientId: liveRecipient.id })
  await submitPrivateMessage(liveSender, liveRecipient, encrypted.ciphertext, encrypted.nonce, encrypted.ephemeralKey)
}

export async function listPrivateConversations(me: IdentityProfile, options: { maxPages?: number; pageSize?: number; resolveProfile?: (id: string) => Promise<IdentityProfile> } = {}): Promise<PrivateConversationList> {
  if (!identityConfigured()) throw new Error(t("misc.dmLib.identityNotConfiguredInbox"))
  const maxPages = options.maxPages ?? 10
  const pageSize = options.pageSize ?? 50
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 20 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50) throw new Error(t("misc.dmLib.inboxRangeInvalid"))

  const eventType = `${identityModule}::MessageSent`
  const events: SuiClientTypes.EventEntry[] = []
  const cursors = new Set<string>()
  let before: string | null = null
  let truncated = false
  for (let pageIndex = 0; pageIndex < maxPages; pageIndex++) {
    const page = await identityRpc.listEvents({ filter: { eventType }, before, limit: pageSize, order: "descending", signal: requestSignal() })
    for (const event of page.events) if (normalizeStructTag(event.eventType) === normalizeStructTag(eventType)) events.push(event)
    if (!page.hasNextPage) break
    if (!page.endCursor || cursors.has(page.endCursor) || page.endCursor === before) throw new Error(t("misc.dmLib.inboxPageStuck"))
    if (pageIndex === maxPages - 1) {
      truncated = true
      break
    }
    cursors.add(page.endCursor)
    before = page.endCursor
  }

  const profileCache = new Map<string, IdentityProfile>()
  const resolveProfile = options.resolveProfile ?? getIdentity
  const timestampCache = new Map<string, number>()
  const conversations = new Map<string, PrivateConversation>()
  const failures: Array<{ senderId: string; reason: string }> = []
  const seen = new Set<string>()
  for (const event of events) {
    const raw = MessageSent.parse(event.bcs)
    if (raw.recipient !== me.id) continue
    const id = `${event.transactionDigest}:${event.eventIndex}`
    if (seen.has(id)) continue
    seen.add(id)

    let peer = profileCache.get(raw.sender)
    if (!peer) {
      try {
        peer = await resolveProfile(raw.sender)
        if (peer.id !== raw.sender || normalizeSuiAddress(event.sender) !== normalizeSuiAddress(peer.address)) throw new Error(t("misc.dmLib.senderMismatch"))
        profileCache.set(raw.sender, peer)
      } catch (error) {
        // Classification by message text (zh SDK text + the en twin): rethrow
        // the sender-mismatch family, everything else degrades to a failure row.
        const message = error instanceof Error ? error.message : ""
        if (message.includes("发送方与身份所有者") || message.includes("identity owner")) throw error
        failures.push({ senderId: raw.sender, reason: error instanceof Error ? error.message : t("misc.dmLib.senderUnreadable") })
        continue
      }
    } else if (normalizeSuiAddress(event.sender) !== normalizeSuiAddress(peer.address)) {
      throw new Error(t("misc.dmLib.senderMismatch"))
    }

    if (!timestampCache.has(event.transactionDigest)) {
      const transaction = await identityRpc.getTransaction({ digest: event.transactionDigest, signal: requestSignal() })
      if (transaction.$kind === "FailedTransaction" || !transaction.Transaction.status.success) throw new Error(t("misc.dmLib.txInvalid"))
      const timestamp = transaction.Transaction.timestampMs
      if (timestamp === null || !Number.isSafeInteger(timestamp) || timestamp < 0) throw new Error(t("misc.dmLib.txTimeMissing"))
      timestampCache.set(event.transactionDigest, timestamp)
    }

    const message: PrivateMessage = { id, senderId: raw.sender, recipientId: raw.recipient, text: null, timestampMs: timestampCache.get(event.transactionDigest)! }
    try {
      const ciphertext = new Uint8Array(raw.ciphertext)
      const envelope = readEnvelope(ciphertext)
      if (envelope.recipientKey !== toBase64(new Uint8Array(raw.recipient_key))) throw new Error(t("misc.dmLib.recipientKeyMismatch"))
      const key = await readKey(`${identityModule}:${me.id}:${envelope.recipientKey}`)
      if (!key) throw new Error(t("misc.dmLib.noKey"))
      message.text = await openMessage({ ciphertext, nonce: new Uint8Array(raw.nonce), ephemeralKey: new Uint8Array(raw.ephemeral_public_key) }, key.pair.privateKey, { senderId: message.senderId, recipientId: message.recipientId }, "to")
    } catch (error) {
      message.unavailableReason = error instanceof Error ? error.message : t("misc.dmLib.undecryptable")
    }

    const current = conversations.get(peer.id)
    if (!current || current.lastMessage === null || message.timestampMs > current.lastMessage.timestampMs || (message.timestampMs === current.lastMessage.timestampMs && message.id > current.lastMessage.id)) {
      conversations.set(peer.id, { peer, lastMessage: message, messageCount: (current?.messageCount ?? 0) + 1 })
    } else {
      conversations.set(peer.id, { ...current, messageCount: current.messageCount + 1 })
    }
  }

  return { conversations: [...conversations.values()].sort((a, b) => {
    const aTime = a.lastMessage?.timestampMs ?? -1
    const bTime = b.lastMessage?.timestampMs ?? -1
    return bTime - aTime || a.peer.id.localeCompare(b.peer.id)
  }), scannedEvents: events.length, truncated, failures }
}

export async function readPrivateMessageHistory(me: IdentityProfile, peer: IdentityProfile, options: PrivateMessageHistoryOptions = {}): Promise<PrivateMessageHistory> {
  if (!identityConfigured()) throw new Error(t("misc.dmLib.identityNotConfiguredHistory"))
  const maxPages = options.maxPages ?? 10
  const pageSize = options.pageSize ?? 50
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 20 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50) throw new Error(t("misc.dmLib.historyRangeInvalid"))
  // Query authenticated sender streams; the contract keeps each Name address-bound.
  const senderAddresses = [me.address, peer.address].filter((value, index, all) => all.findIndex(other => normalizeSuiAddress(other) === normalizeSuiAddress(value)) === index)
  const streams = await Promise.all(senderAddresses.map(async (sender) => {
    const events: SuiClientTypes.EventEntry[] = []
    const cursors = new Set<string>()
    let before: string | null = null
    let truncated = false
    for (let pageIndex = 0; pageIndex < maxPages; pageIndex++) {
      const page = await identityRpc.listEvents({ filter: { sender }, before, limit: pageSize, order: "descending", signal: requestSignal() })
      events.push(...page.events)
      if (!page.hasNextPage) break
      if (!page.endCursor || cursors.has(page.endCursor) || page.endCursor === before) throw new Error(t("misc.dmLib.historyPageStuck"))
      if (pageIndex === maxPages - 1) { truncated = true; break }
      cursors.add(page.endCursor)
      before = page.endCursor
    }
    return { events, truncated }
  }))
  const result: PrivateMessage[] = []
  const seen = new Map<string, SuiClientTypes.EventEntry>()
  const timestamps = new Map<string, number>()
  for (const event of streams.flatMap(stream => stream.events)) {
    if (normalizeStructTag(event.eventType) !== normalizeStructTag(`${identityModule}::MessageSent`)) continue
    const raw = MessageSent.parse(event.bcs)
    if (!((normalizeSuiAddress(raw.sender) === normalizeSuiAddress(me.id) && normalizeSuiAddress(raw.recipient) === normalizeSuiAddress(peer.id)) || (normalizeSuiAddress(raw.sender) === normalizeSuiAddress(peer.id) && normalizeSuiAddress(raw.recipient) === normalizeSuiAddress(me.id)))) continue
    const isOutgoing = raw.sender === me.id
    if (normalizeSuiAddress(event.sender) !== normalizeSuiAddress(isOutgoing ? me.address : peer.address)) throw new Error(t("misc.dmLib.senderMismatch"))
    const id = `${event.transactionDigest}:${event.eventIndex}`
    const previous = seen.get(id)
    if (previous) {
      if (previous.bcs.length !== event.bcs.length || previous.bcs.some((value, index) => value !== event.bcs[index]) || normalizeSuiAddress(previous.sender) !== normalizeSuiAddress(event.sender)) throw new Error(t("misc.dmLib.conflict"))
      continue
    }
    seen.set(id, event)
    if (!timestamps.has(event.transactionDigest)) {
      const transaction = await identityRpc.getTransaction({ digest: event.transactionDigest, signal: requestSignal() })
      if (transaction.$kind === "FailedTransaction" || !transaction.Transaction.status.success) throw new Error(t("misc.dmLib.txInvalid"))
      const timestamp = transaction.Transaction.timestampMs
      if (timestamp === null || !Number.isSafeInteger(timestamp) || timestamp < 0) throw new Error(t("misc.dmLib.txTimeMissing"))
      timestamps.set(event.transactionDigest, timestamp)
    }
    const message: PrivateMessage = { id, senderId: raw.sender, recipientId: raw.recipient, text: null, timestampMs: timestamps.get(event.transactionDigest)! }
    try {
      const ciphertext = new Uint8Array(raw.ciphertext)
      const envelope = readEnvelope(ciphertext)
      const publicKey = isOutgoing ? envelope.senderKey : envelope.recipientKey
      if (!isOutgoing && publicKey !== toBase64(new Uint8Array(raw.recipient_key))) throw new Error(t("misc.dmLib.recipientKeyMismatch"))
      const key = await readKey(`${identityModule}:${me.id}:${publicKey}`)
      if (!key) throw new Error(t("misc.dmLib.noKey"))
      message.text = await openMessage({ ciphertext, nonce: new Uint8Array(raw.nonce), ephemeralKey: new Uint8Array(raw.ephemeral_public_key) }, key.pair.privateKey, { senderId: message.senderId, recipientId: message.recipientId }, isOutgoing ? "from" : "to")
    } catch (error) {
      message.unavailableReason = error instanceof Error ? error.message : t("misc.dmLib.undecryptable")
    }
    result.push(message)
  }
  return { messages: result.sort((a, b) => a.timestampMs - b.timestampMs || a.id.localeCompare(b.id)), truncated: streams.some(stream => stream.truncated), scannedEvents: streams.reduce((total, stream) => total + stream.events.length, 0) }
}

/** Existing consumers keep the array API; protocol transports can inspect scan completeness. */
export async function getPrivateMessages(me: IdentityProfile, peer: IdentityProfile): Promise<PrivateMessage[]> {
  return (await readPrivateMessageHistory(me, peer)).messages
}
