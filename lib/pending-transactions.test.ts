import assert from "node:assert/strict"
import { afterEach, test } from "node:test"
import { acknowledgePendingTransaction, createPendingTransaction, getPendingTransaction, listTransactionReceipts, TransactionReceiptError, updatePendingTransaction } from "./pending-transactions"

const address = `0x${"1".repeat(64)}`
const intent = { account: { address, type: "wallet", provider: "Test Wallet" }, action: "personal-transfer", scope: `${address}:0x2::sui::SUI:10` }
const storage = new Map<string, string>()
const originalWindow = globalThis.window
const originalLocalStorage = globalThis.localStorage
function installStorage() {
  Object.defineProperty(globalThis, "window", { configurable: true, value: {} })
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value) }, removeItem: (key: string) => { storage.delete(key) }, key: (index: number) => [...storage.keys()][index] ?? null, get length() { return storage.size } } })
}
afterEach(() => {
  storage.clear()
  if (originalWindow === undefined) Reflect.deleteProperty(globalThis, "window"); else Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow })
  if (originalLocalStorage === undefined) Reflect.deleteProperty(globalThis, "localStorage"); else Object.defineProperty(globalThis, "localStorage", { configurable: true, value: originalLocalStorage })
})

test("receipt locks survive reload and metadata remains public", () => {
  installStorage()
  const receipt = createPendingTransaction({ ...intent, metadata: { blobId: "b1", name: "file.txt", size: "4", contentType: "text/plain", groupId: "g1", channelId: "c1" } }, "digest-1")
  assert.equal(getPendingTransaction(intent)?.digest, "digest-1")
  assert.deepEqual(getPendingTransaction(intent)?.metadata, { blobId: "b1", name: "file.txt", size: "4", contentType: "text/plain", groupId: "g1", channelId: "c1" })
  assert.equal(listTransactionReceipts().length, 1)
  assert.throws(() => createPendingTransaction(intent), (error: unknown) => error instanceof TransactionReceiptError && error.digest === "digest-1")
  const success = updatePendingTransaction(receipt, { status: "success", createdObjects: ["0x2"] })
  assert.equal(getPendingTransaction(intent)?.status, "success")
  acknowledgePendingTransaction(success)
  assert.equal(getPendingTransaction(intent), undefined)
})

test("storage failure keeps in-memory lock and unknown storage is preserved", () => {
  installStorage()
  const receipt = createPendingTransaction(intent, "digest-2")
  const raw = [...storage.entries()][0]
  storage.set(raw[0], "future-format-record")
  assert.equal(getPendingTransaction(intent)?.digest, "digest-2")
  assert.equal(storage.get(raw[0]), "future-format-record")
  assert.throws(() => createPendingTransaction(intent), /此操作已有待恢复交易/)
  assert.equal(receipt.persistent, false)
})
