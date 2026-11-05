import assert from "node:assert/strict"
import { test } from "node:test"
import { normalizeSuiAddress } from "@mysten/sui/utils"
import { MAX_OUTBOX_MESSAGES, clearChatOutbox, enqueueChatMessage, peekChatOutbox, restoreChatOutbox, takeChatOutbox } from "./chat-outbox"
import { AgentVaultClient } from "./vault-client"

const channelId = normalizeSuiAddress("0xc1")

test("outbox keeps lines in order, caps the burst and hands them to the flush once", () => {
  clearChatOutbox(channelId)
  assert.equal(enqueueChatMessage(channelId, "  hi  ").queued, 1)
  assert.equal(enqueueChatMessage(channelId, "second").queued, 2)
  assert.deepEqual(peekChatOutbox(channelId), ["hi", "second"])
  const taken = takeChatOutbox(channelId)
  assert.deepEqual(taken, ["hi", "second"])
  assert.deepEqual(peekChatOutbox(channelId), [])
  assert.deepEqual(takeChatOutbox(channelId), [])
})

test("outbox rejects empty and oversized lines instead of silently dropping them", () => {
  clearChatOutbox(channelId)
  assert.throws(() => enqueueChatMessage(channelId, "   "))
  assert.throws(() => enqueueChatMessage(channelId, "x".repeat(4_097)), /4096/)
  assert.deepEqual(peekChatOutbox(channelId), [])
})

test("outbox stops at the cap and reports it so the caller can flush early", () => {
  clearChatOutbox(channelId)
  for (let index = 0; index < MAX_OUTBOX_MESSAGES; index++) enqueueChatMessage(channelId, `line ${index}`)
  const overflow = enqueueChatMessage(channelId, "one too many")
  assert.equal(overflow.full, true)
  assert.equal(overflow.queued, MAX_OUTBOX_MESSAGES)
  assert.equal(peekChatOutbox(channelId).length, MAX_OUTBOX_MESSAGES)
  clearChatOutbox(channelId)
})

test("a failed flush restores its lines ahead of anything typed meanwhile", () => {
  clearChatOutbox(channelId)
  enqueueChatMessage(channelId, "a")
  const taken = takeChatOutbox(channelId)
  enqueueChatMessage(channelId, "typed during wallet prompt")
  restoreChatOutbox(channelId, taken)
  assert.deepEqual(peekChatOutbox(channelId), ["a", "typed during wallet prompt"])
  clearChatOutbox(channelId)
})

test("the merged PTB carries exactly one post_message per line and no Walrus id", async () => {
  const client = new AgentVaultClient({ packageId: normalizeSuiAddress("0xabc") })
  const tx = client.buildPostChatMessagesPTB(channelId, ["first", "第二条", "third"])
  const data = await tx.getData()
  assert.equal(data.commands.length, 3)
  let firstWalrusArgument: unknown
  for (const command of data.commands) {
    assert.equal(command.$kind === "MoveCall", true)
    if (command.$kind !== "MoveCall") continue
    assert.equal(command.MoveCall.package, normalizeSuiAddress("0xabc"))
    assert.equal(command.MoveCall.module, "onchain_chat")
    assert.equal(command.MoveCall.function, "post_message")
    // channel + clock + walrus blob id + text
    assert.equal(command.MoveCall.arguments.length, 4)
    assert.equal((command.MoveCall.arguments[0] as { type?: string }).type, "object")
    assert.equal((command.MoveCall.arguments[1] as { type?: string }).type, "object")
    // The empty Walrus id is shared by the whole burst, not re-added per line.
    if (firstWalrusArgument === undefined) firstWalrusArgument = command.MoveCall.arguments[2]
    assert.deepEqual(command.MoveCall.arguments[2], firstWalrusArgument)
  }
  // Two object inputs plus one empty Walrus id plus one text per line.
  assert.equal(data.inputs.filter(input => input.$kind === "Pure").length, 1 + 3)
  assert.equal(data.inputs.length, 3 + 3)
})

test("the batch PTB is one call carrying both vectors in order", async () => {
  const client = new AgentVaultClient({ packageId: normalizeSuiAddress("0xabc") })
  const tx = client.buildPostChatMessageBatchPTB(channelId, ["a", "b"])
  const data = await tx.getData()
  assert.equal(data.commands.length, 1)
  const command = data.commands[0]
  assert.equal(command.$kind, "MoveCall")
  if (command.$kind !== "MoveCall") return
  assert.equal(command.MoveCall.module, "onchain_chat")
  assert.equal(command.MoveCall.function, "post_message_batch")
  // channel + clock + previews + walrus ids
  assert.equal(command.MoveCall.arguments.length, 4)
  assert.equal((command.MoveCall.arguments[0] as { type?: string }).type, "object")
  assert.equal((command.MoveCall.arguments[1] as { type?: string }).type, "object")
  // Pure inputs: previews then blob ids, each a BCS `vector<vector<u8>>`.
  // Pinned bytes for ["a","b"] → 02 01 61 01 62 (len 2, len 1 "a", len 1 "b")
  // and for two empty ids → 02 00 00.
  assert.equal(data.inputs.length, 4)
  const pure = data.inputs.filter(input => input.$kind === "Pure")
  assert.equal(pure.length, 2)
  const bytesOf = (index: number) => (pure[index] as { Pure: { bytes: string } }).Pure.bytes
  assert.equal(bytesOf(0), "AgFhAWI=")
  assert.equal(bytesOf(1), "AgAA")
})

test("the batch PTB rejects the same malformed bursts as the fallback", () => {
  const client = new AgentVaultClient({ packageId: normalizeSuiAddress("0xabc") })
  assert.throws(() => client.buildPostChatMessageBatchPTB(channelId, []), /没有可发送/)
  assert.throws(() => client.buildPostChatMessageBatchPTB(channelId, ["ok", "  "]), /不能为空/)
  assert.throws(() => client.buildPostChatMessageBatchPTB(channelId, Array.from({ length: 33 }, (_, index) => `m${index}`)), /32/)
})

test("the merged PTB rejects empty batches and non-message arguments", () => {
  const client = new AgentVaultClient({ packageId: normalizeSuiAddress("0xabc") })
  assert.throws(() => client.buildPostChatMessagesPTB(channelId, []), /没有可发送/)
  assert.throws(() => client.buildPostChatMessagesPTB(channelId, ["ok", "  "]), /不能为空/)
  assert.throws(() => client.buildPostChatMessagesPTB(channelId, Array.from({ length: 33 }, (_, index) => `m${index}`)), /32/)
})
