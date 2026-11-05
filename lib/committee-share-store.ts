"use client"

// Per-device custody for the legacy share record and the asynchronous DKG key package.
// Secret scalars never touch IndexedDB in plaintext anymore: every record stores a
// device-vault sealed box (non-extractable AES-256-GCM, AAD bound to the record id)
// plus a SHA-256 tag so synchronous conflict checks can compare secret equality
// without opening the box. The tag leaks nothing usable — a holder's verifying
// share is already public transcript data derivable from the dealer commitments.
// Records written before sealing shipped still carry plaintext `share`; they open
// directly and are upgraded to sealed on their next mutation. Sealing and opening
// happen outside the IndexedDB transactions, so every mutation below keeps its
// original synchronous compare-and-put semantics. No transaction or private share
// is sent to a log, and the old `shares` object store remains intact.
import { t } from "@/lib/i18n/t"
import { sha256 } from "@noble/hashes/sha2.js"
import { toHex } from "@mysten/sui/utils"
import { bytesToScalar, scalarToBytes32 } from "./crypto/math"
import { defaultDeviceVault, type SealedSecretBox } from "./crypto/device-vault"
import {
  DEVICE_KEY_NETWORK,
  validateDealerContribution,
  validateDeviceKeyPackage,
  type BoundDeviceKey,
  type DealerContribution,
  type DeviceKeyPackage,
} from "./dkg-key-package"

export { DEVICE_KEY_NETWORK, assembleDeviceKey, parsePublicKeyPackage, publicKeyPackageId, serializePublicKeyPackage, toNobleFrostPublic, toPublicKeyPackage, validateDealerContribution, validateDeviceKeyPackage, validatePublicKeyPackage } from "./dkg-key-package"
export type { BoundDeviceKey, DealerContribution, DeviceKeyPackage, PublicKeyPackage } from "./dkg-key-package"

const DATABASE = "sui-committee-shares"
const LEGACY_STORE = "shares"
const PENDING_STORE = "pending-device-keys"
const DEVICE_STORE = "device-keys"
const DEALER_STORE = "dealer-contributions"
const DATABASE_VERSION = 2

/** One member's old organization share, retained for compatibility. */
export interface StoredShare {
  orgId: string
  groupPk: Uint8Array
  index: bigint
  epoch: bigint
  share: bigint
  threshold: bigint
  participants: number
}

/** Sealed secret at rest: the device-vault box plus the equality tag. */
interface SealedShareField { sealed: SealedSecretBox; tag: string }
/** Any stored secret: sealed (current) or plaintext (pre-sealing records, read-compatible). */
type StoredSecret = SealedShareField | { share: Uint8Array }

type LegacyRecord = {
  id: string
  orgId: string
  groupPk: Uint8Array
  index: string
  epoch: string
  threshold: string
  participants: number
} & StoredSecret

type DeviceRecord = {
  id: string
  network: typeof DEVICE_KEY_NETWORK
  sessionId: string
  holder: string
  participantAddresses: string[]
  dealerAddresses: string[]
  index: string
  threshold: string
  sessionEpoch: string
  commitments: Uint8Array[]
  groupPk: Uint8Array
  keyPackageId: string
} & StoredSecret

type BoundRecord = DeviceRecord & { orgId: string; epoch: string; creationDigest: string }
type DealerRecord = { id: string; network: typeof DEVICE_KEY_NETWORK; sessionId: string; holder: string; index: string; commitments: Uint8Array[] } & StoredSecret

const lower = (value: string): string => value.toLowerCase()
const oldKey = (orgId: string): string => lower(orgId)
const scopedKey = (scope: "session" | "org", scopeId: string, holder: string): string => JSON.stringify([DEVICE_KEY_NETWORK, scope, lower(scopeId), lower(holder)])
const dealerKey = (sessionId: string, holder: string): string => scopedKey("session", sessionId, holder)
const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((byte, index) => byte === b[index])
const copyBytes = (bytes: Uint8Array): Uint8Array => Uint8Array.from(bytes)
const copyCommitments = (commitments: Uint8Array[]): Uint8Array[] => commitments.map(copyBytes)

const hex = (bytes: Uint8Array): string => toHex(bytes)
const TAG_PREFIX = "sui-device-share-tag-v1:"

async function sealShare(shareBytes: Uint8Array, context: string): Promise<SealedShareField> {
  return { sealed: await defaultDeviceVault.seal(shareBytes, context), tag: hex(sha256(new TextEncoder().encode(TAG_PREFIX + hex(shareBytes)))) }
}

async function openShare(secret: StoredSecret, context: string): Promise<Uint8Array> {
  if ("share" in secret) return copyBytes(secret.share)
  return defaultDeviceVault.open(secret.sealed, context)
}

/** Secret equality without opening: tags when both sealed, bytes when both legacy. Mixed shapes cannot be compared synchronously and compare unequal (fail closed). */
function secretEqual(a: StoredSecret, b: StoredSecret): boolean {
  if ("tag" in a && "tag" in b) return a.tag === b.tag
  if ("share" in a && "share" in b) return sameBytes(a.share, b.share)
  return false
}

function canonical(value: unknown): string {
  if (value instanceof Uint8Array) return `u8:${hex(value)}`
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`
  return JSON.stringify(value)
}

function database(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") return Promise.reject(new Error(t("dkg.noIdb")))
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, DATABASE_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(LEGACY_STORE)) db.createObjectStore(LEGACY_STORE, { keyPath: "id" })
      if (!db.objectStoreNames.contains(PENDING_STORE)) db.createObjectStore(PENDING_STORE, { keyPath: "id" })
      if (!db.objectStoreNames.contains(DEVICE_STORE)) db.createObjectStore(DEVICE_STORE, { keyPath: "id" })
      if (!db.objectStoreNames.contains(DEALER_STORE)) db.createObjectStore(DEALER_STORE, { keyPath: "id" })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(new Error(t("dkg.shareStoreOpenFailed")))
    request.onblocked = () => reject(new Error(t("dkg.shareStoreBlocked")))
  })
}

function readRecord<T>(db: IDBDatabase, store: string, id: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly")
    const request = tx.objectStore(store).get(id)
    request.onsuccess = () => resolve(request.result as T | undefined)
    request.onerror = () => reject(new Error(t("dkg.readRecordFailed")))
    tx.onabort = () => reject(tx.error ?? new Error(t("dkg.readAborted")))
  })
}

/** Rewrite a pre-sealing plaintext record into its sealed form, only if it is still byte-identical to what was read. */
async function upgradeToSealed<T extends { id: string } & StoredSecret>(db: IDBDatabase, store: string, record: T): Promise<T> {
  if (!("share" in record)) return record
  const { share, ...fields } = record as T & { share: Uint8Array }
  const next = { ...fields, ...(await sealShare(copyBytes(share), record.id)) } as unknown as T
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(store, "readwrite")
    const objectStore = tx.objectStore(store)
    const read = objectStore.get(record.id)
    let failed = false
    const fail = (error: Error) => { if (!failed) { failed = true; reject(error) } }
    read.onsuccess = () => {
      const current = read.result
      if (canonical(current) !== canonical(record)) { fail(new Error(t("dkg.sealUpgradeConflict"))); try { tx.abort() } catch {} ; return }
      objectStore.put(next)
    }
    read.onerror = () => fail(new Error(t("dkg.readRecordFailed")))
    tx.oncomplete = () => { if (!failed) resolve() }
    tx.onerror = () => fail(new Error(t("dkg.sealUpgradeFailed")))
    tx.onabort = () => fail(new Error(t("dkg.sealUpgradeFailed")))
  })
  return next
}

/** Read a record and make sure it is sealed; upgrades legacy plaintext outside any caller transaction. */
async function loadSealed<T extends { id: string } & StoredSecret>(store: string, id: string): Promise<T | undefined> {
  const db = await database()
  try {
    const record = await readRecord<T>(db, store, id)
    if (!record || "sealed" in record) return record
    return await upgradeToSealed(db, store, record)
  } finally { db.close() }
}

async function readLegacyRecord(orgId: string): Promise<LegacyRecord | undefined> {
  const db = await database()
  try { return await readRecord<LegacyRecord>(db, LEGACY_STORE, oldKey(orgId)) } finally { db.close() }
}

async function asDeviceKey(record: DeviceRecord): Promise<DeviceKeyPackage> {
  return {
    network: record.network,
    sessionId: record.sessionId,
    holder: record.holder,
    participantAddresses: [...record.participantAddresses],
    dealerAddresses: [...record.dealerAddresses],
    index: BigInt(record.index),
    threshold: BigInt(record.threshold),
    sessionEpoch: BigInt(record.sessionEpoch),
    commitments: copyCommitments(record.commitments),
    groupPk: copyBytes(record.groupPk),
    share: bytesToScalar(await openShare(record, record.id)),
    keyPackageId: record.keyPackageId,
  }
}

async function asBoundKey(record: BoundRecord): Promise<BoundDeviceKey> {
  return { ...await asDeviceKey(record), orgId: record.orgId, epoch: BigInt(record.epoch), creationDigest: record.creationDigest }
}

async function deviceRecord(key: DeviceKeyPackage, id: string): Promise<DeviceRecord> {
  return {
    id,
    network: key.network,
    sessionId: key.sessionId,
    holder: key.holder,
    participantAddresses: [...key.participantAddresses],
    dealerAddresses: [...key.dealerAddresses],
    index: key.index.toString(),
    threshold: key.threshold.toString(),
    sessionEpoch: key.sessionEpoch.toString(),
    commitments: copyCommitments(key.commitments),
    groupPk: copyBytes(key.groupPk),
    keyPackageId: key.keyPackageId,
    ...(await sealShare(scalarToBytes32(key.share), id)),
  }
}

function validateDigest(digest: string | undefined): string | undefined {
  if (digest !== undefined && (typeof digest !== "string" || digest.length === 0)) throw new Error(t("dkg.creationDigestEmpty"))
  return digest
}

function boundEqual(a: BoundRecord, b: BoundRecord): boolean {
  return a.id === b.id && a.network === b.network && a.sessionId === b.sessionId && a.holder === b.holder &&
    a.orgId === b.orgId && a.epoch === b.epoch && a.creationDigest === b.creationDigest &&
    a.index === b.index && a.threshold === b.threshold && a.sessionEpoch === b.sessionEpoch &&
    a.keyPackageId === b.keyPackageId && sameBytes(a.groupPk, b.groupPk) && secretEqual(a, b) &&
    JSON.stringify(a.participantAddresses) === JSON.stringify(b.participantAddresses) &&
    JSON.stringify(a.dealerAddresses) === JSON.stringify(b.dealerAddresses) &&
    a.commitments.length === b.commitments.length && a.commitments.every((bytes, i) => sameBytes(bytes, b.commitments[i]))
}

function keyEqual(a: DeviceRecord, b: DeviceRecord): boolean {
  return a.id === b.id && a.network === b.network && a.sessionId === b.sessionId && a.holder === b.holder &&
    a.index === b.index && a.threshold === b.threshold && a.sessionEpoch === b.sessionEpoch && a.keyPackageId === b.keyPackageId &&
    sameBytes(a.groupPk, b.groupPk) && secretEqual(a, b) &&
    JSON.stringify(a.participantAddresses) === JSON.stringify(b.participantAddresses) &&
    JSON.stringify(a.dealerAddresses) === JSON.stringify(b.dealerAddresses) &&
    a.commitments.length === b.commitments.length && a.commitments.every((bytes, i) => sameBytes(bytes, b.commitments[i]))
}

/** Save an unbound DKG result. A conflicting record is never overwritten. */
export async function savePendingDeviceKey(key: DeviceKeyPackage): Promise<void> {
  validateDeviceKeyPackage(key)
  const id = scopedKey("session", key.sessionId, key.holder)
  await loadSealed<DeviceRecord>(PENDING_STORE, id)
  const next = await deviceRecord(key, id)
  const db = await database()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(PENDING_STORE, "readwrite")
      const store = tx.objectStore(PENDING_STORE)
      const read = store.get(id)
      let failed = false
      const fail = (error: Error) => { if (!failed) { failed = true; reject(error) } }
      read.onsuccess = () => {
        const existing = read.result as DeviceRecord | undefined
        if (existing && !keyEqual(existing, next)) { fail(new Error(t("dkg.sessionKeyConflict"))); try { tx.abort() } catch {} ; return }
        if (!existing) store.put(next)
      }
      read.onerror = () => fail(new Error(t("dkg.readPendingFailed")))
      tx.oncomplete = () => { if (!failed) resolve() }
      tx.onerror = () => fail(new Error(t("dkg.bindSaveFailed")))
      tx.onabort = () => fail(new Error(t("dkg.bindSaveFailed")))
    })
  } finally { db.close() }
}

export async function readPendingDeviceKey(sessionId: string, holder: string): Promise<DeviceKeyPackage | null> {
  const id = scopedKey("session", sessionId, holder)
  const record = await loadSealed<DeviceRecord>(PENDING_STORE, id)
  return record ? await asDeviceKey(record) : null
}

/** Bind a pending result to an organization and remove the one-shot pending entry atomically. */
export async function bindDeviceKey(input: { sessionId: string; holder: string; orgId: string; epoch: bigint; creationDigest: string; groupPk: Uint8Array }): Promise<BoundDeviceKey> {
  validateDigest(input.creationDigest)
  if (!(input.groupPk instanceof Uint8Array) || input.groupPk.length !== 32) throw new Error(t("dkg.groupKeyBytes32"))
  if (typeof input.epoch !== "bigint" || input.epoch < 0n) throw new Error(t("dkg.epochInvalid"))
  const pendingId = scopedKey("session", input.sessionId, input.holder)
  const boundId = scopedKey("org", input.orgId, input.holder)
  const pending = await loadSealed<DeviceRecord>(PENDING_STORE, pendingId)
  const db = await database()
  try {
    // A retry after a successful bind has no pending row left. It is still
    // idempotent when the bound record exactly matches the requested live
    // epoch, digest and group key; this path performs no mutation, so a plain
    // read carries the same guarantee the transaction used to.
    if (!pending) {
      const existing = await loadSealed<BoundRecord>(DEVICE_STORE, boundId)
      if (existing && BigInt(existing.epoch) === input.epoch && existing.creationDigest === input.creationDigest && sameBytes(existing.groupPk, input.groupPk)) return asBoundKey(existing)
      throw new Error(t("dkg.noPendingKey"))
    }
    if (!sameBytes(pending.groupPk, input.groupPk)) throw new Error(t("dkg.bindKeyMismatch"))
    if (!("sealed" in pending)) throw new Error(t("dkg.sealUpgradeMissing"))
    // The bound record lives under a different id, so the share is re-sealed for
    // the bound context; the plaintext exists only in this function's memory.
    const shareBytes = await openShare(pending, pendingId)
    const { sealed: _pendingBox, tag: _pendingTag, ...publicFields } = pending
    const next: BoundRecord = { ...publicFields, id: boundId, orgId: input.orgId, epoch: input.epoch.toString(), creationDigest: input.creationDigest, ...(await sealShare(shareBytes, boundId)) }
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([PENDING_STORE, DEVICE_STORE], "readwrite")
      const pendingStore = tx.objectStore(PENDING_STORE)
      const deviceStore = tx.objectStore(DEVICE_STORE)
      let failed = false
      const fail = (error: Error) => { if (!failed) { failed = true; reject(error) } }
      const pendingRequest = pendingStore.get(pendingId)
      pendingRequest.onsuccess = () => {
        const current = pendingRequest.result as DeviceRecord | undefined
        if (!current || !keyEqual(current, pending)) { fail(new Error(t("dkg.pendingChangedDuringBind"))); try { tx.abort() } catch {} ; return }
        const existingRequest = deviceStore.get(boundId)
        existingRequest.onsuccess = () => {
          const existing = existingRequest.result as BoundRecord | undefined
          if (existing && !boundEqual(existing, next)) { fail(new Error(t("dkg.boundKeyConflict"))); try { tx.abort() } catch {} ; return }
          if (!existing) deviceStore.put(next)
          pendingStore.delete(pendingId)
        }
        existingRequest.onerror = () => fail(new Error(t("dkg.readBoundFailed")))
      }
      pendingRequest.onerror = () => fail(new Error(t("dkg.readPendingFailed")))
      tx.oncomplete = () => { if (!failed) resolve() }
      tx.onerror = () => fail(new Error(t("dkg.bindPersistFailed")))
      tx.onabort = () => fail(new Error(t("dkg.bindPersistFailed")))
    })
    return {
      network: next.network, sessionId: next.sessionId, holder: next.holder,
      participantAddresses: [...next.participantAddresses], dealerAddresses: [...next.dealerAddresses],
      index: BigInt(next.index), threshold: BigInt(next.threshold), sessionEpoch: BigInt(next.sessionEpoch),
      commitments: copyCommitments(next.commitments), groupPk: copyBytes(next.groupPk),
      share: bytesToScalar(shareBytes), keyPackageId: next.keyPackageId,
      orgId: next.orgId, epoch: BigInt(next.epoch), creationDigest: next.creationDigest,
    }
  } finally { db.close() }
}

export async function readDeviceKey(orgId: string, holder: string): Promise<BoundDeviceKey | null> {
  const id = scopedKey("org", orgId, holder)
  const record = await loadSealed<BoundRecord>(DEVICE_STORE, id)
  return record ? await asBoundKey(record) : null
}

export async function advanceDeviceKeyEpoch(orgId: string, holder: string, input: { fromEpoch: bigint; toEpoch: bigint; groupPk: Uint8Array; creationDigest?: string }): Promise<void> {
  if (typeof input.fromEpoch !== "bigint" || typeof input.toEpoch !== "bigint" || input.fromEpoch < 0n || input.toEpoch <= input.fromEpoch) throw new Error(t("dkg.epochNotIncreasing"))
  if (!(input.groupPk instanceof Uint8Array) || input.groupPk.length !== 32) throw new Error(t("dkg.groupKeyBytes32"))
  const digest = validateDigest(input.creationDigest)
  const id = scopedKey("org", orgId, holder)
  await loadSealed<BoundRecord>(DEVICE_STORE, id)
  const db = await database()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(DEVICE_STORE, "readwrite")
      const store = tx.objectStore(DEVICE_STORE)
      const read = store.get(id)
      let failed = false
      const fail = (error: Error) => { if (!failed) { failed = true; reject(error) } }
      read.onsuccess = () => {
        const existing = read.result as BoundRecord | undefined
        if (!existing) { fail(new Error(t("dkg.noBoundKey"))); try { tx.abort() } catch {} ; return }
        const requestedDigest = digest ?? existing.creationDigest
        if (BigInt(existing.epoch) === input.toEpoch && sameBytes(existing.groupPk, input.groupPk) && existing.creationDigest === requestedDigest) return
        if (BigInt(existing.epoch) !== input.fromEpoch) { fail(new Error(t("dkg.epochNotExpected", { current: String(existing.epoch), expected: String(input.fromEpoch) }))); try { tx.abort() } catch {} ; return }
        // Same record id, so the sealed box and tag carry over verbatim.
        const next: BoundRecord = { ...existing, epoch: input.toEpoch.toString(), groupPk: copyBytes(input.groupPk), creationDigest: requestedDigest }
        store.put(next)
      }
      read.onerror = () => fail(new Error(t("dkg.readBoundFailed")))
      tx.oncomplete = () => { if (!failed) resolve() }
      tx.onerror = () => fail(new Error(t("dkg.epochUpdateFailed")))
      tx.onabort = () => fail(new Error(t("dkg.epochUpdateFailed")))
    })
  } finally { db.close() }
}

export async function saveDealerContribution(input: DealerContribution): Promise<void> {
  // Validate the share against every coefficient before writing it.
  validateDealerContribution(input)
  const id = dealerKey(input.sessionId, input.holder)
  await loadSealed<DealerRecord>(DEALER_STORE, id)
  const next: DealerRecord = { id, network: DEVICE_KEY_NETWORK, sessionId: input.sessionId, holder: input.holder, index: input.index.toString(), commitments: copyCommitments(input.commitments), ...(await sealShare(scalarToBytes32(input.share), id)) }
  const db = await database()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(DEALER_STORE, "readwrite")
      const store = tx.objectStore(DEALER_STORE)
      const read = store.get(id)
      let failed = false
      const fail = (error: Error) => { if (!failed) { failed = true; reject(error) } }
      read.onsuccess = () => {
        const existing = read.result as DealerRecord | undefined
        const equal = existing && existing.index === next.index && secretEqual(existing, next) && existing.commitments.length === next.commitments.length && existing.commitments.every((bytes, i) => sameBytes(bytes, next.commitments[i]))
        if (existing && !equal) { fail(new Error(t("dkg.contributionConflict"))); try { tx.abort() } catch {} ; return }
        if (!existing) store.put(next)
      }
      read.onerror = () => fail(new Error(t("dkg.readContributionFailed")))
      tx.oncomplete = () => { if (!failed) resolve() }
      tx.onerror = () => fail(new Error(t("dkg.contributionSaveFailed")))
      tx.onabort = () => fail(new Error(t("dkg.contributionSaveFailed")))
    })
  } finally { db.close() }
}

// (package validation is statically imported above; keeping this module browser-safe)

export async function readDealerContribution(sessionId: string, holder: string): Promise<DealerContribution | null> {
  const id = dealerKey(sessionId, holder)
  const record = await loadSealed<DealerRecord>(DEALER_STORE, id)
  if (!record) return null
  return { sessionId: record.sessionId, holder: record.holder, index: BigInt(record.index), commitments: copyCommitments(record.commitments), share: bytesToScalar(await openShare(record, record.id)) }
}

/** The old share API remains unchanged. */
export async function readStoredShare(orgId: string): Promise<StoredShare | null> {
  const record = await readLegacyRecord(orgId)
  if (!record) return null
  return { orgId: record.orgId, groupPk: copyBytes(record.groupPk), index: BigInt(record.index), epoch: BigInt(record.epoch), share: bytesToScalar(await openShare(record, record.id)), threshold: BigInt(record.threshold), participants: record.participants }
}

export async function writeStoredShare(share: StoredShare): Promise<void> {
  if (share.share <= 0n) throw new Error(t("dkg.shareScalarInvalid"))
  if (share.index <= 0n) throw new Error(t("dkg.shareIndexInvalid"))
  const id = oldKey(share.orgId)
  await loadSealed<LegacyRecord>(LEGACY_STORE, id)
  const sealed = await sealShare(scalarToBytes32(share.share), id)
  const db = await database()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(LEGACY_STORE, "readwrite")
      const store = tx.objectStore(LEGACY_STORE)
      const read = store.get(id)
      let failed = false
      const fail = (error: Error) => { if (!failed) { failed = true; reject(error) } }
      read.onsuccess = () => {
        const existing = read.result as LegacyRecord | undefined
        if (existing) {
          const same = sameBytes(Uint8Array.from(existing.groupPk), share.groupPk)
          if (!same) { fail(new Error(t("dkg.shareGroupConflict"))); try { tx.abort() } catch {} ; return }
        }
        if (!existing) store.put({ id, orgId: share.orgId, groupPk: copyBytes(share.groupPk), index: share.index.toString(), epoch: share.epoch.toString(), threshold: share.threshold.toString(), participants: share.participants, ...sealed } satisfies LegacyRecord)
      }
      read.onerror = () => fail(new Error(t("dkg.readShareFailed")))
      tx.oncomplete = () => { if (!failed) resolve() }
      tx.onerror = () => fail(new Error(t("dkg.shareSaveFailed")))
      tx.onabort = () => fail(new Error(t("dkg.shareSaveFailed")))
    })
  } finally { db.close() }
}

export async function clearStoredShare(orgId: string): Promise<void> {
  const db = await database()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(LEGACY_STORE, "readwrite")
      tx.objectStore(LEGACY_STORE).delete(oldKey(orgId))
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(new Error(t("dkg.shareDeleteFailed")))
      tx.onabort = () => reject(new Error(t("dkg.shareDeleteFailed")))
    })
  } finally { db.close() }
}

export function shareMismatch(share: StoredShare, live: { orgId: string; groupPk: Uint8Array; epoch: bigint }): string | null {
  if (lower(share.orgId) !== lower(live.orgId)) return t("dkg.shareOrgMismatch")
  if (!sameBytes(share.groupPk, live.groupPk)) return t("dkg.shareGroupMismatch")
  if (share.epoch !== live.epoch) return t("dkg.shareEpochMismatch", { shareEpoch: String(share.epoch), liveEpoch: String(live.epoch) })
  return null
}
