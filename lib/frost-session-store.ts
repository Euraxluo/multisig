import type { SealedSecretBox } from "./crypto/device-vault"
import type { FrostRequest, FrostRound1, FrostRound2, FrostTranscript } from "./frost-session"

/**
 * Nonce material as persisted. New records store only the device-vault sealed
 * box; the legacy plaintext shape is still accepted on read so a record written
 * before sealing shipped can still be consumed exactly once.
 */
export type FrostNonceMaterial =
  | { hiding: Uint8Array; binding: Uint8Array }
  | { sealed: SealedSecretBox }

/** Public recovery data. Secret nonces live in a separate object store. */
export interface FrostSessionRecord {
  request: FrostRequest
  round1: FrostRound1[]
  transcript?: FrostTranscript
  round2: FrostRound2[]
  updatedAtMs: number
}

export interface FrostNonceRecord {
  id: string
  round1: FrostRound1
  nonces?: FrostNonceMaterial
  consumed: boolean
  transcriptHash?: string
  round2?: FrostRound2
}

export interface BurnedFrostNonce { nonces: FrostNonceMaterial }

export type FrostNonceConsumption =
  | { kind: "fresh"; nonces: FrostNonceMaterial }
  | { kind: "cached"; round2: FrostRound2 }

/** All mutations resolve only after commit. No caller callback runs inside an IDB transaction. */
export interface FrostSessionStore {
  prepare(record: FrostNonceRecord): Promise<FrostRound1>
  publishRound1(id: string, round1: FrostRound1): Promise<FrostRound1>
  consume(id: string, round1: FrostRound1, transcriptHash: string): Promise<FrostNonceConsumption>
  saveRound2(id: string, round2: FrostRound2): Promise<void>
  remember(record: FrostSessionRecord): Promise<void>
  restore(requestId: string): Promise<FrostSessionRecord | null>
  list(): Promise<FrostSessionRecord[]>
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`
  return JSON.stringify(value)
}
const clone = <T>(value: T): T => structuredClone(value)
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b)
const unsigned = <T extends { signature: string }>(value: T) => ({ ...value, signature: "" })

function prepareRecord(existing: FrostNonceRecord | undefined, candidate: FrostNonceRecord): FrostNonceRecord {
  if (existing) {
    if (existing.round1.requestId !== candidate.round1.requestId || existing.round1.contextHash !== candidate.round1.contextHash || existing.round1.address !== candidate.round1.address || existing.round1.index !== candidate.round1.index) throw new Error("FROST nonce context conflict")
    return existing
  }
  if (candidate.consumed || !candidate.nonces || candidate.round2 || candidate.transcriptHash) throw new Error("Invalid prepared FROST nonce")
  return clone(candidate)
}

function consumeRecord(existing: FrostNonceRecord | undefined, round1: FrostRound1, transcriptHash: string): { record: FrostNonceRecord; result: FrostNonceConsumption } {
  if (!existing || !same(existing.round1, round1)) throw new Error("Missing or conflicting local FROST commitment")
  if (existing.consumed) {
    if (existing.transcriptHash !== transcriptHash) throw new Error("FROST nonce already consumed for another transcript")
    if (!existing.round2) throw new Error("FROST nonce permanently consumed; start a new request")
    return { record: existing, result: { kind: "cached", round2: clone(existing.round2) } }
  }
  if (!existing.nonces) throw new Error("Missing FROST secret nonce")
  const nonces = clone(existing.nonces)
  const record: FrostNonceRecord = { id: existing.id, round1: clone(existing.round1), consumed: true, transcriptHash }
  return { record, result: { kind: "fresh", nonces } }
}

function withRound2(existing: FrostNonceRecord | undefined, round2: FrostRound2): FrostNonceRecord {
  if (!existing?.consumed || existing.transcriptHash !== round2.transcriptHash || existing.round1.requestId !== round2.requestId || existing.round1.contextHash !== round2.contextHash || existing.round1.address !== round2.address || existing.round1.index !== round2.index) throw new Error("FROST share does not match consumed nonce")
  if (existing.round2 && (!same(unsigned(existing.round2), unsigned(round2)) || (existing.round2.signature && existing.round2.signature !== round2.signature))) throw new Error("Conflicting FROST signature share")
  return { ...existing, round2: clone(round2) }
}

function mergeRecord(existing: FrostSessionRecord | undefined, incoming: FrostSessionRecord): FrostSessionRecord {
  if (existing && !same(existing.request, incoming.request)) throw new Error("Conflicting FROST request recovery record")
  if (existing?.transcript && incoming.transcript && !same(existing.transcript, incoming.transcript)) throw new Error("Conflicting FROST transcript recovery record")
  function merge<T extends { index: string; signature: string }>(a: T[], b: T[]): T[] {
    const records = new Map(a.map(value => [value.index, value]))
    for (const value of b) {
      const prior = records.get(value.index)
      if (prior && !same(prior, value)) {
        if (!same(unsigned(prior), unsigned(value)) || (prior.signature && value.signature && prior.signature !== value.signature)) throw new Error("Conflicting FROST round recovery record")
      }
      records.set(value.index, prior?.signature ? prior : value)
    }
    return [...records.values()].sort((x, y) => Number(BigInt(x.index) - BigInt(y.index)))
  }
  return clone({ request: incoming.request, round1: merge(existing?.round1 ?? [], incoming.round1), round2: merge(existing?.round2 ?? [], incoming.round2), ...(incoming.transcript ?? existing?.transcript ? { transcript: incoming.transcript ?? existing?.transcript } : {}), updatedAtMs: Math.max(existing?.updatedAtMs ?? 0, incoming.updatedAtMs) })
}

/** Test injection; production defaults to IndexedDB. Mutations are synchronous before resolution. */
export function createMemoryFrostSessionStore(): FrostSessionStore {
  const nonces = new Map<string, FrostNonceRecord>()
  const sessions = new Map<string, FrostSessionRecord>()
  return {
    async prepare(candidate) {
      const record = prepareRecord(nonces.get(candidate.id), candidate)
      nonces.set(candidate.id, record)
      return clone(record.round1)
    },
    async publishRound1(id, round1) {
      const existing = nonces.get(id)
      if (!existing || !same(existing.round1, round1) && (!same(unsigned(existing.round1), unsigned(round1)) || (existing.round1.signature && existing.round1.signature !== round1.signature))) throw new Error("FROST commitment does not match prepared nonce")
      existing.round1 = clone(round1)
      nonces.set(id, existing)
      return clone(round1)
    },
    async consume(id, round1, transcriptHash) {
      const { record, result } = consumeRecord(nonces.get(id), round1, transcriptHash)
      nonces.set(id, record)
      return result
    },
    async saveRound2(id, round2) { nonces.set(id, withRound2(nonces.get(id), round2)) },
    async remember(record) { sessions.set(record.request.requestId, mergeRecord(sessions.get(record.request.requestId), record)) },
    async restore(requestId) { return clone(sessions.get(requestId) ?? null) },
    async list() { return clone([...sessions.values()].sort((a, b) => b.updatedAtMs - a.updatedAtMs)) },
  }
}

export function createIndexedDbFrostSessionStore(options: { databaseName?: string; indexedDB?: IDBFactory } = {}): FrostSessionStore {
  let database: Promise<IDBDatabase> | undefined
  function open(): Promise<IDBDatabase> {
    if (!database) database = new Promise((resolve, reject) => {
      const factory = options.indexedDB ?? globalThis.indexedDB
      if (!factory) { reject(new Error("IndexedDB unavailable for FROST nonce safety")); return }
      const request = factory.open(options.databaseName ?? "multisig-frost-sessions-v1", 1)
      request.onupgradeneeded = () => {
        request.result.createObjectStore("nonces", { keyPath: "id" })
        request.result.createObjectStore("sessions", { keyPath: "request.requestId" })
      }
      request.onerror = () => { database = undefined; reject(request.error ?? new Error("Cannot open FROST store")) }
      request.onblocked = () => { database = undefined; reject(new Error("FROST store upgrade blocked")) }
      request.onsuccess = () => { request.result.onversionchange = () => { request.result.close(); database = undefined }; resolve(request.result) }
    })
    return database
  }
  async function transaction<T>(name: "nonces" | "sessions", mode: IDBTransactionMode, key: string | null, update: (value: unknown) => { result: T; write?: unknown }): Promise<T> {
    const db = await open()
    return new Promise((resolve, reject) => {
      // Strict durability plus oncomplete ensures no signing happens before the burn is committed.
      const tx = db.transaction(name, mode, mode === "readwrite" ? { durability: "strict" } : undefined)
      const store = tx.objectStore(name)
      const get = key === null ? store.getAll() : store.get(key)
      let result: T
      let failure: unknown
      get.onsuccess = () => {
        try {
          const next = update(get.result)
          result = next.result
          if (next.write !== undefined) store.put(next.write)
        } catch (error) { failure = error; tx.abort() }
      }
      tx.oncomplete = () => resolve(result)
      tx.onabort = () => reject(failure ?? tx.error ?? new Error("FROST storage transaction aborted"))
      tx.onerror = () => { /* onabort supplies the terminal error. */ }
    })
  }
  return {
    prepare: candidate => transaction("nonces", "readwrite", candidate.id, value => {
      const record = prepareRecord(value as FrostNonceRecord | undefined, candidate)
      return { result: clone(record.round1), ...(value ? {} : { write: record }) }
    }),
    publishRound1: (id, round1) => transaction("nonces", "readwrite", id, value => {
      const existing = value as FrostNonceRecord | undefined
      if (!existing || !same(existing.round1, round1) && (!same(unsigned(existing.round1), unsigned(round1)) || (existing.round1.signature && existing.round1.signature !== round1.signature))) throw new Error("FROST commitment does not match prepared nonce")
      const updated = { ...existing, round1: clone(round1) }
      return { result: clone(round1), write: updated }
    }),
    consume: (id, round1, transcriptHash) => transaction("nonces", "readwrite", id, value => {
      const { record, result } = consumeRecord(value as FrostNonceRecord | undefined, round1, transcriptHash)
      return { result, write: record }
    }),
    saveRound2: (id, round2) => transaction("nonces", "readwrite", id, value => ({ result: undefined, write: withRound2(value as FrostNonceRecord | undefined, round2) })),
    remember: record => transaction("sessions", "readwrite", record.request.requestId, value => ({ result: undefined, write: mergeRecord(value as FrostSessionRecord | undefined, record) })),
    restore: requestId => transaction("sessions", "readonly", requestId, value => ({ result: (value ?? null) as FrostSessionRecord | null })),
    list: () => transaction("sessions", "readonly", null, value => ({ result: (value as FrostSessionRecord[]).sort((a, b) => b.updatedAtMs - a.updatedAtMs) })),
  }
}

export const defaultFrostSessionStore = createIndexedDbFrostSessionStore()
export const listFrostSessions = (options: { store?: FrostSessionStore } = {}) => (options.store ?? defaultFrostSessionStore).list()
export const restoreFrostSession = (requestId: string, options: { store?: FrostSessionStore } = {}) => (options.store ?? defaultFrostSessionStore).restore(requestId)
export const rememberFrostSession = (record: FrostSessionRecord, options: { store?: FrostSessionStore } = {}) => (options.store ?? defaultFrostSessionStore).remember(record)
