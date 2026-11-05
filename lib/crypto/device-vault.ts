"use client"

import { t } from "@/lib/i18n/t"
import { bytesToHex, hexToBytes } from "./bytes"

/**
 * Device-bound sealing for secret material at rest, mirroring how the Sui web
 * wallet keeps signing keys: a non-extractable AES-256-GCM CryptoKey is stored
 * in IndexedDB and only ciphertext is ever persisted next to it. The key can be
 * used by same-origin code while the page is live, but it cannot be exported,
 * so a copied profile or an exfiltrated record store yields ciphertext only.
 *
 * This boundary deliberately does NOT claim protection against an attacker who
 * already runs arbitrary same-origin script in a live page; that requires the
 * passphrase envelope in `encrypted-keystore.ts` or a hardware passkey (SIP-9).
 */
export interface SealedSecretBox {
  version: 1
  /** 12-byte AES-GCM IV, hex. */
  iv: string
  /** AES-GCM ciphertext incl. the 16-byte tag, hex. */
  data: string
}

export interface DeviceVault {
  seal(plaintext: Uint8Array, context: string): Promise<SealedSecretBox>
  open(box: SealedSecretBox, context: string): Promise<Uint8Array>
}

export interface DeviceVaultOptions {
  databaseName?: string
  indexedDB?: IDBFactory
}

const DEFAULT_DATABASE = "sui-device-vault-v1"
const STORE = "keys"
const KEY_ID = "device-aes-gcm-256"
const AAD_PREFIX = "sui-device-vault-v1:"
const MAX_CONTEXT_BYTES = 512

function subtleCrypto(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) throw new Error(t("dkg.noWebCrypto"))
  return subtle
}

function contextBytes(context: string): Uint8Array {
  if (typeof context !== "string" || context.length === 0) throw new Error(t("dkg.contextRequired"))
  const aad = new TextEncoder().encode(AAD_PREFIX + context)
  if (aad.length > MAX_CONTEXT_BYTES) throw new Error(t("dkg.contextTooLong"))
  return aad
}

function isSealedBox(value: unknown): value is SealedSecretBox {
  if (!value || typeof value !== "object") return false
  const box = value as Record<string, unknown>
  return box.version === 1 && typeof box.iv === "string" && typeof box.data === "string"
}

/** A CryptoKey that arrived without the guarantees this module was built around is refused, not adopted. */
function assertUsableKey(key: CryptoKey): void {
  if (key.extractable) throw new Error(t("dkg.keyExtractable"))
  if (!key.usages.includes("encrypt") || !key.usages.includes("decrypt")) throw new Error(t("dkg.keyMissingUsage"))
}

function getRecord(db: IDBDatabase, mode: IDBTransactionMode): Promise<CryptoKey | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode)
    const request = tx.objectStore(STORE).get(KEY_ID)
    request.onsuccess = () => resolve(request.result as CryptoKey | undefined)
    request.onerror = () => reject(request.error ?? new Error(t("dkg.readFailed")))
    tx.onabort = () => reject(tx.error ?? new Error(t("dkg.txAborted")))
  })
}

/**
 * Put `candidate` only when no key exists yet and return whichever key won.
 * Two tabs racing the first creation converge on the same key because both
 * re-read inside the same transaction that writes.
 */
function swapIfAbsent(db: IDBDatabase, candidate: CryptoKey): Promise<CryptoKey> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite")
    const store = tx.objectStore(STORE)
    const get = store.get(KEY_ID)
    let winner: CryptoKey | undefined
    get.onsuccess = () => {
      winner = (get.result as CryptoKey | undefined) ?? candidate
      if (!get.result) store.put(winner, KEY_ID)
    }
    tx.oncomplete = () => { if (winner) resolve(winner); else reject(new Error(t("dkg.initIncomplete"))) }
    tx.onabort = () => reject(tx.error ?? new Error(t("dkg.initAborted")))
    tx.onerror = () => { /* onabort supplies the terminal error. */ }
  })
}

export function createDeviceVault(options: DeviceVaultOptions = {}): DeviceVault {
  const factory = options.indexedDB ?? globalThis.indexedDB
  let database: Promise<IDBDatabase> | undefined
  let cached: CryptoKey | undefined

  function openDatabase(): Promise<IDBDatabase> {
    if (!database) {
      if (!factory) { database = undefined; return Promise.reject(new Error(t("dkg.noIndexedDb"))) }
      database = new Promise((resolve, reject) => {
        const request = factory.open(options.databaseName ?? DEFAULT_DATABASE, 1)
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE)
        }
        request.onerror = () => { database = undefined; reject(request.error ?? new Error(t("dkg.openFailed"))) }
        request.onblocked = () => { database = undefined; reject(new Error(t("dkg.openBlocked"))) }
        request.onsuccess = () => {
          request.result.onversionchange = () => { request.result.close(); database = undefined; cached = undefined }
          resolve(request.result)
        }
      })
    }
    return database
  }

  async function loadKey(): Promise<CryptoKey> {
    if (cached) return cached
    const db = await openDatabase()
    const existing = await getRecord(db, "readonly")
    if (existing) { assertUsableKey(existing); cached = existing; return existing }
    const generated = await subtleCrypto().generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"])
    const winner = await swapIfAbsent(db, generated)
    assertUsableKey(winner)
    cached = winner
    return winner
  }

  return {
    async seal(plaintext, context) {
      if (!(plaintext instanceof Uint8Array) || plaintext.length === 0) throw new Error(t("dkg.sealEmpty"))
      const aad = contextBytes(context)
      const key = await loadKey()
      const iv = crypto.getRandomValues(new Uint8Array(12))
      const ciphertext = new Uint8Array(await subtleCrypto().encrypt({ name: "AES-GCM", iv, additionalData: aad }, key, plaintext))
      return { version: 1, iv: bytesToHex(iv), data: bytesToHex(ciphertext) }
    },
    async open(box, context) {
      if (!isSealedBox(box)) throw new Error(t("dkg.invalidSealedFormat"))
      if (box.iv.length !== 24 || box.data.length < 32 || box.data.length % 2 !== 0) throw new Error(t("dkg.invalidSealedParams"))
      const aad = contextBytes(context)
      const key = await loadKey()
      try {
        return new Uint8Array(await subtleCrypto().decrypt(
          { name: "AES-GCM", iv: hexToBytes(box.iv), additionalData: aad },
          key,
          hexToBytes(box.data),
        ))
      } catch (cause) {
        throw new Error(t("dkg.decryptFailed"), { cause })
      }
    },
  }
}

export const defaultDeviceVault = createDeviceVault()
