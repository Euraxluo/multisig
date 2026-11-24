/**
 * 前端 FrostSessionStore 适配器。
 *
 * 类型、内存实现与记录状态迁移全部来自 `multisig/bridge`；本文件只保留
 * IndexedDB 持久化。所有迁移调用 SDK 导出的纯函数，保证浏览器实现与
 * 内存/node 实现共享同一套 nonce 单次消费不变量。
 */
import {
  consumeNonceRecord,
  mergeSessionRecord,
  prepareNonceRecord,
  publishRound1Record,
  withRound2Share,
  type FrostNonceRecord,
  type FrostSessionRecord,
  type FrostSessionStore,
} from "multisig/bridge"

export type {
  BurnedFrostNonce,
  FrostNonceConsumption,
  FrostNonceMaterial,
  FrostNonceRecord,
  FrostSessionRecord,
  FrostSessionStore,
} from "multisig/bridge"
export { createMemoryFrostSessionStore } from "multisig/bridge"

const clone = <T>(value: T): T => structuredClone(value)

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
      const record = prepareNonceRecord(value as FrostNonceRecord | undefined, candidate)
      return { result: clone(record.round1), ...(value ? {} : { write: record }) }
    }),
    publishRound1: (id, round1) => transaction("nonces", "readwrite", id, value => ({
      result: clone(round1),
      write: publishRound1Record(value as FrostNonceRecord | undefined, round1),
    })),
    consume: (id, round1, transcriptHash) => transaction("nonces", "readwrite", id, value => {
      const { record, result } = consumeNonceRecord(value as FrostNonceRecord | undefined, round1, transcriptHash)
      return { result, write: record }
    }),
    saveRound2: (id, round2) => transaction("nonces", "readwrite", id, value => ({
      result: undefined,
      write: withRound2Share(value as FrostNonceRecord | undefined, round2),
    })),
    remember: record => transaction("sessions", "readwrite", record.request.requestId, value => ({
      result: undefined,
      write: mergeSessionRecord(value as FrostSessionRecord | undefined, record),
    })),
    restore: requestId => transaction("sessions", "readonly", requestId, value => ({ result: (value ?? null) as FrostSessionRecord | null })),
    list: () => transaction("sessions", "readonly", null, value => ({ result: (value as FrostSessionRecord[]).sort((a, b) => b.updatedAtMs - a.updatedAtMs) })),
  }
}

export const defaultFrostSessionStore = createIndexedDbFrostSessionStore()
export const listFrostSessions = (options: { store?: FrostSessionStore } = {}) => (options.store ?? defaultFrostSessionStore).list()
export const restoreFrostSession = (requestId: string, options: { store?: FrostSessionStore } = {}) => (options.store ?? defaultFrostSessionStore).restore(requestId)
export const rememberFrostSession = (record: FrostSessionRecord, options: { store?: FrostSessionStore } = {}) => (options.store ?? defaultFrostSessionStore).remember(record)
