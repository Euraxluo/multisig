import assert from "node:assert/strict"
import { test } from "node:test"
import { encodeGroupFilePreview, groupFileMessageText, sharedGroupFiles } from "./group-files"
import type { ChatMessage } from "./group-chat"

const BLOB_ID = "M4hsZGQ1oCktdzegB6HnI6Mi28S2nqOPHxK-W7_4BUk"
const message = (overrides: Partial<ChatMessage> = {}): ChatMessage => ({ id: "tx:0", digest: "tx", sequence: "1", sender: "0x1", agent: "0x1", text: encodeGroupFilePreview({ name: "报告.pdf", size: 8192, contentType: "application/pdf" }), walrusBlobId: BLOB_ID, timestampMs: 1_790_000_000_000, ...overrides })

test("a fresh device reconstructs shared attachments entirely from channel event facts", () => {
  const [file] = sharedGroupFiles("group", "channel", [message()])
  assert.equal(file.name, "报告.pdf")
  assert.equal(file.size, 8192)
  assert.equal(file.uploader, "0x1")
  assert.equal(file.channelId, "channel")
  assert.equal(file.transactionDigest, "tx")
  assert.equal(file.source, "chain")
  assert.equal(file.uploadedAt, new Date(1_790_000_000_000).toISOString())
  assert.equal(groupFileMessageText(message().text), "共享文件：报告.pdf")
})

test("duplicate references and legacy attachments retain provenance without invented metadata", () => {
  const files = sharedGroupFiles("group", "channel", [message({ text: "legacy preview" }), message({ id: "tx2:0", digest: "tx2" }), message({ walrusBlobId: "" })])
  assert.equal(files.length, 1)
  assert.equal(files[0].size, null)
  assert.equal(files[0].transactionDigest, "tx")
  assert.match(files[0].name, /^附件/)
})

test("malformed or forged metadata cannot crash file history or redirect the download URL", () => {
  const raw = "sui-group-file:" + JSON.stringify({ version: 1, name: "x", size: -1, contentType: "text/plain", url: "https://attacker.example" })
  const [file] = sharedGroupFiles("group", "channel", [message({ text: raw, walrusBlobId: "../../invalid" })])
  assert.equal(file.size, null)
  assert.equal(file.url, "")
  assert.equal(file.recordIssues!.length, 2)
  assert.equal(groupFileMessageText(raw), raw)
  assert.throws(() => encodeGroupFilePreview({ name: "", size: 1, contentType: "text/plain" }), /无效/)
  assert.throws(() => encodeGroupFilePreview({ name: "a".repeat(513), size: 1, contentType: "text/plain" }), /无效/)
  assert.throws(() => sharedGroupFiles("group", "channel", [message({ timestampMs: Number.MAX_SAFE_INTEGER })]), /时间无效/)
})
