import assert from "node:assert/strict"
import { afterEach, mock, test } from "node:test"
import { addGroupWalrusFile, downloadFromWalrus, getGroupWalrusFiles, uploadToWalrus, type GroupFileInfo } from "./walrus-client"

const BLOB_ID = "M4hsZGQ1oCktdzegB6HnI6Mi28S2nqOPHxK-W7_4BUk"
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } })
const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage")
afterEach(() => {
  mock.restoreAll()
  Reflect.deleteProperty(globalThis, "window")
  if (storageDescriptor) Object.defineProperty(globalThis, "localStorage", storageDescriptor)
  else Reflect.deleteProperty(globalThis, "localStorage")
})

function storageFixture() {
  const records = new Map<string, string>()
  Object.defineProperty(globalThis, "window", { configurable: true, value: new EventTarget() })
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => records.get(key) ?? null,
    setItem: (key: string, value: string) => { records.set(key, value) },
  } })
  return records
}
const file: GroupFileInfo = { id: "upload-1", groupId: "group", name: "文件.txt", size: 6, blobId: BLOB_ID, uploader: "0x1", uploadedAt: "2026-10-21T00:00:00Z", contentType: "text/plain", url: "", source: "local" }

test("publisher HTTP, transport and malformed responses never fabricate a stored blob", async () => {
  for (const response of [new Response("offline", { status: 503 }), json({ newlyCreated: {} }), json({}), json({ alreadyCertified: { blobId: "invalid-id" } })]) {
    mock.method(globalThis, "fetch", async () => response)
    await assert.rejects(uploadToWalrus("private test payload"), /Walrus/)
    mock.restoreAll()
  }
  mock.method(globalThis, "fetch", async () => { throw new Error("publisher offline") })
  await assert.rejects(uploadToWalrus("test payload"), /publisher offline/)
})

test("upload accepts publisher blob identifiers and preserves the original bytes", async () => {
  const calls: RequestInit[] = []
  mock.method(globalThis, "fetch", async (_url: RequestInfo | URL, init?: RequestInit) => { calls.push(init!); return json({ newlyCreated: { blobObject: { blobId: BLOB_ID } } }) })
  const result = await uploadToWalrus("文件", { epochs: 2, contentType: "text/plain" })
  assert.equal(result.blobId, BLOB_ID)
  assert.equal(result.isLocalFallback, false)
  assert.equal(result.size, 6)
  assert.equal(new TextDecoder().decode(calls[0].body as ArrayBuffer), "文件")
  mock.restoreAll()
  mock.method(globalThis, "fetch", async () => json({ alreadyCertified: { blobId: BLOB_ID } }))
  assert.equal((await uploadToWalrus("文件")).blobId, BLOB_ID)
  await assert.rejects(uploadToWalrus("文件", { epochs: 0 }), /周期/)
})

test("download failures reject and real bytes report aggregator provenance", async () => {
  mock.method(globalThis, "fetch", async () => new Response("missing", { status: 404 }))
  await assert.rejects(downloadFromWalrus(BLOB_ID), /无法从 Walrus.*404/)
  await assert.rejects(downloadFromWalrus("../bad-id"), /格式无效/)
  mock.restoreAll()
  mock.method(globalThis, "fetch", async () => new Response("actual data", { headers: { "Content-Type": "text/plain" } }))
  const result = await downloadFromWalrus(BLOB_ID)
  assert.equal(await result.data.text(), "actual data")
  assert.equal(result.source, "aggregator")
})

test("cached bytes are distinct from a remote availability check", async () => {
  const records = storageFixture()
  records.set(`walrus_blob_${BLOB_ID}`, JSON.stringify({ data: btoa("cached data"), contentType: "text/plain", filename: "original.txt" }))
  mock.method(globalThis, "fetch", async () => { throw new Error("must not be queried") })
  const result = await downloadFromWalrus(BLOB_ID)
  assert.equal(result.source, "cache")
  assert.equal(result.filename, "original.txt")
  assert.equal(await result.data.text(), "cached data")
})

test("uninitialized group files contain no generated demonstration rows", () => {
  storageFixture()
  assert.deepEqual(getGroupWalrusFiles("new-group"), [])
})

test("legacy unknown file rows remain visible and raw history survives append", () => {
  const records = storageFixture()
  const legacy = [null, 42, { id: "legacy", blobId: "walrus_blob_fake", futureField: { preserved: true } }]
  const original = JSON.stringify(legacy)
  records.set("walrus_files_group", original)
  const rows = getGroupWalrusFiles("group")
  assert.equal(rows.length, 3)
  assert.equal(rows[0].size, null)
  assert.equal(rows[2].source, "local")
  assert.match(rows[2].recordIssues!.join(), /Blob ID/)
  assert.equal(records.get("walrus_files_group"), original)
  addGroupWalrusFile("group", file)
  assert.deepEqual(JSON.parse(records.get("walrus_files_group")!).slice(1), legacy)
})

test("index failures preserve original storage and expose the successful upload blob ID", () => {
  const records = storageFixture()
  records.set("walrus_files_group", "malformed JSON")
  assert.throws(() => addGroupWalrusFile("group", file), new RegExp(BLOB_ID))
  assert.equal(records.get("walrus_files_group"), "malformed JSON")
  records.set("walrus_files_group", "[]")
  mock.method(localStorage, "setItem", () => { throw new Error("quota exceeded") })
  assert.throws(() => addGroupWalrusFile("group", file), /quota exceeded.*Blob ID/)
  assert.equal(records.get("walrus_files_group"), "[]")
})
