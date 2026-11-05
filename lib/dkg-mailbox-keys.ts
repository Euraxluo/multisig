"use client"

// Per-device custody of the mailbox key pair used to open sealed DKG shares.
//
// The key is a non-extractable `CryptoKey` stored in IndexedDB. Structured clone
// keeps it non-extractable — the private half never becomes a string this page
// or any log could leak. A different browser, a different profile, or cleared
// site data therefore cannot open shares sealed to this one; that is reported as
// "no key on this device" rather than silently regenerating a key that could
// never decrypt the existing shares.
//
// This mirrors `lib/private-messages.ts`, which uses the same custody model for
// direct messages.
import { t } from "@/lib/i18n/t"
import { generateMessageKey, publicKeyBytes } from "./message-crypto"

const DATABASE = "sui-dkg-mailbox"
const STORE = "keys"

export interface MailboxKeyPair {
  /** The 65-byte uncompressed P-256 point registered on chain. */
  publicKey: Uint8Array
  privateKey: CryptoKey
}

/** A generated pair that is not yet in IndexedDB; `pair` is what gets stored. */
export interface PendingMailboxKey extends MailboxKeyPair { pair: CryptoKeyPair }

interface StoredKey { id: string; pair: CryptoKeyPair }

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "id" })
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(new Error(t("dkg.mailboxOpenStoreFailed")))
    request.onblocked = () => reject(new Error(t("dkg.mailboxStoreBlocked")))
  })
}

async function read(id: string): Promise<StoredKey | undefined> {
  const db = await database()
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly")
      const request = tx.objectStore(STORE).get(id)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(new Error(t("dkg.readKeysFailed")))
    })
  } finally { db.close() }
}

async function write(record: StoredKey): Promise<void> {
  const db = await database()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite")
      tx.objectStore(STORE).put(record)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(new Error(t("dkg.saveKeyFailed")))
      tx.onabort = () => reject(new Error(t("dkg.saveKeyFailed")))
    })
  } finally { db.close() }
}

/** One key per session and participant: a session's shares are sealed to it. */
const keyId = (sessionId: string, participant: string) =>
  `${sessionId.toLowerCase()}:${participant.toLowerCase()}`

/** The stored pair, or null when this device never created one for the session. */
export async function readMailboxKey(sessionId: string, participant: string): Promise<MailboxKeyPair | null> {
  const record = await read(keyId(sessionId, participant))
  if (!record) return null
  return { publicKey: await publicKeyBytes(record.pair.publicKey), privateKey: record.pair.privateKey }
}

/**
 * Generate a key pair for this session **without persisting it**.
 *
 * Persistence is deliberately a separate step (`persistMailboxKey`). Writing
 * the key before the registration transaction is known to have succeeded was a
 * real footgun: two tabs could both generate, the loser's transaction would
 * abort with `E_ENCRYPTION_KEY_CONFLICT`, and the device would be left holding a
 * key the chain does not know — unable to open any share, forever, because
 * registration is once-only.
 *
 * `expectedPublicKey` is what is already registered on chain. If it is present
 * and differs from the generated key, this device could never open shares sealed
 * to the registered one, so the mismatch is surfaced instead of proceeding.
 */
export async function createMailboxKey(
  sessionId: string,
  participant: string,
  expectedPublicKey: Uint8Array | null,
): Promise<PendingMailboxKey> {
  const pair = await generateMessageKey()
  const publicKey = await publicKeyBytes(pair.publicKey)
  if (expectedPublicKey) {
    const same = expectedPublicKey.length === publicKey.length
      && expectedPublicKey.every((byte, index) => byte === publicKey[index])
    if (!same) throw new Error(t("dkg.onchainKeyNotOurs"))
  }
  return { publicKey, privateKey: pair.privateKey, pair }
}

/**
 * Store a generated key after its public half is on chain.
 *
 * Call this only once `register_encryption_key` succeeded: an unregistered key
 * in local storage can never be used, and could shadow a key another tab
 * registered first.
 */
export async function persistMailboxKey(sessionId: string, participant: string, pending: PendingMailboxKey): Promise<void> {
  const stored = await read(keyId(sessionId, participant))
  if (stored) {
    const existing = await publicKeyBytes(stored.pair.publicKey)
    const same = existing.length === pending.publicKey.length
      && existing.every((byte, index) => byte === pending.publicKey[index])
    // Never clobber a different device key: that would orphan every share
    // already sealed to the stored one.
    if (!same) throw new Error(t("dkg.refuseOverwrite"))
    return
  }
  await write({ id: keyId(sessionId, participant), pair: pending.pair })
}

/**
 * Load the device key, creating it only when the chain has no registered key.
 * Returns the key plus whether it was just created, so the caller can decide to
 * submit `register_encryption_key`.
 */
export async function ensureMailboxKey(
  sessionId: string,
  participant: string,
  registeredOnChain: Uint8Array | null,
): Promise<{ key: MailboxKeyPair; created: boolean }> {
  const existing = await readMailboxKey(sessionId, participant)
  if (existing) {
    if (registeredOnChain) {
      const same = registeredOnChain.length === existing.publicKey.length
        && registeredOnChain.every((byte, index) => byte === existing.publicKey[index])
      if (!same) throw new Error(t("dkg.localOnchainMismatch"))
    }
    return { key: existing, created: false }
  }
  // Not persisted here: the caller persists only after registration lands.
  const pending = await createMailboxKey(sessionId, participant, registeredOnChain)
  return { key: pending, created: true }
}
