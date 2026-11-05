import assert from "node:assert/strict"
import test from "node:test"
import { generateMessageKey, publicKeyBytes, sealMessage, openMessage, MAX_MESSAGE_BYTES } from "./message-crypto"

const context = { senderId: "0xsender", recipientId: "0xrecipient" }

test("sender and recipient decrypt an envelope, a third party cannot", async () => {
  const [sender, recipient, outsider] = await Promise.all([generateMessageKey(), generateMessageKey(), generateMessageKey()])
  assert.equal(sender.privateKey.extractable, false)
  const sealed = await sealMessage("你好，Sui 👋", await publicKeyBytes(sender.publicKey), await publicKeyBytes(recipient.publicKey), context)
  assert.equal(await openMessage(sealed, sender.privateKey, context, "from"), "你好，Sui 👋")
  assert.equal(await openMessage(sealed, recipient.privateKey, context, "to"), "你好，Sui 👋")
  await assert.rejects(openMessage(sealed, outsider.privateKey, context, "to"))
  await assert.rejects(openMessage(sealed, recipient.privateKey, { ...context, senderId: "0xforged" }, "to"))
  const changedNonce = sealed.nonce.slice()
  changedNonce[0] ^= 1
  await assert.rejects(openMessage({ ...sealed, nonce: changedNonce }, recipient.privateKey, context, "to"))
})

test("UTF8 byte bounds keep dual ciphertext envelopes within onchain limits", async () => {
  const [sender, recipient] = await Promise.all([generateMessageKey(), generateMessageKey()])
  const senderKey = await publicKeyBytes(sender.publicKey)
  const recipientKey = await publicKeyBytes(recipient.publicKey)
  const sealed = await sealMessage("x".repeat(MAX_MESSAGE_BYTES), senderKey, recipientKey, context)
  assert.ok(sealed.ciphertext.length <= 4112)
  assert.equal((await openMessage(sealed, recipient.privateKey, context, "to")).length, MAX_MESSAGE_BYTES)
  await assert.rejects(sealMessage(" ", senderKey, recipientKey, context))
  await assert.rejects(sealMessage("你".repeat(334), senderKey, recipientKey, context))
})

test("fresh ephemeral keys and nonces produce distinct ciphertext", async () => {
  const [sender, recipient] = await Promise.all([generateMessageKey(), generateMessageKey()])
  const args = [await publicKeyBytes(sender.publicKey), await publicKeyBytes(recipient.publicKey)] as const
  const a = await sealMessage("same", ...args, context)
  const b = await sealMessage("same", ...args, context)
  assert.notDeepEqual(a.ephemeralKey, b.ephemeralKey)
  assert.notDeepEqual(a.nonce, b.nonce)
  assert.notDeepEqual(a.ciphertext, b.ciphertext)
})
