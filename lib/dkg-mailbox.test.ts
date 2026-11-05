import assert from "node:assert/strict"
import { test } from "node:test"
import { bcs } from "@mysten/sui/bcs"
import { ObjectError } from "@mysten/sui/client"
import {
  createEncryptionKeyReader, isSealableKey, MAX_SHARE_BYTES, openShare, sealShare,
  type EncryptionKeyClient, type ShareContext,
} from "./dkg-mailbox"

// These pin the seal/open contract that makes `deposit_mailbox_share` safe to
// use: the payload is readable by every RPC caller, so a share must never leave
// this module in the clear, and a sealed share must not be movable to another
// session, sender, recipient, or epoch.

const SESSION = "0x" + "a1".repeat(32)
const SENDER = "0x" + "b2".repeat(32)
const RECIPIENT = "0x" + "c3".repeat(32)
const OTHER = "0x" + "d4".repeat(32)

const context = (overrides: Partial<ShareContext> = {}): ShareContext => ({
  sessionId: SESSION, sender: SENDER, recipient: RECIPIENT, epoch: 1, ...overrides,
})

async function keyPair(): Promise<{ privateKey: CryptoKey; publicKey: Uint8Array }> {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"])
  return { privateKey: pair.privateKey, publicKey: new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)) }
}

test("a sealed share opens for the intended recipient and returns the same bytes", async () => {
  const recipient = await keyPair()
  const share = crypto.getRandomValues(new Uint8Array(32))
  const sealed = await sealShare(share, recipient.publicKey, context())
  assert.deepEqual(await openShare(sealed.bytes, recipient.privateKey, context()), share)
})

test("the sealed payload does not contain the plaintext share", async () => {
  const recipient = await keyPair()
  // A share whose bytes are easy to search for: if sealing failed, this needle
  // would appear verbatim in the on-chain payload.
  const share = new Uint8Array(32).fill(0x5a)
  const sealed = await sealShare(share, recipient.publicKey, context())
  const haystack = Buffer.from(sealed.bytes).toString("hex")
  assert.equal(haystack.includes("5a".repeat(32)), false)
})

test("a third party cannot open a share sealed to someone else", async () => {
  const recipient = await keyPair()
  const stranger = await keyPair()
  const sealed = await sealShare(new Uint8Array(32).fill(7), recipient.publicKey, context())
  await assert.rejects(() => openShare(sealed.bytes, stranger.privateKey, context()))
})

test("a share moved to another session, sender, recipient, or epoch is rejected", async () => {
  const recipient = await keyPair()
  const sealed = await sealShare(new Uint8Array(32).fill(9), recipient.publicKey, context())
  for (const moved of [
    context({ sessionId: OTHER }),
    context({ sender: OTHER }),
    context({ recipient: OTHER }),
    context({ epoch: 2 }),
  ]) {
    await assert.rejects(() => openShare(sealed.bytes, recipient.privateKey, moved), `must reject ${JSON.stringify(moved)}`)
  }
})

test("each seal produces a fresh ephemeral key and nonce", async () => {
  const recipient = await keyPair()
  const share = new Uint8Array(32).fill(3)
  const first = await sealShare(share, recipient.publicKey, context())
  const second = await sealShare(share, recipient.publicKey, context())
  assert.notDeepEqual(first.bytes, second.bytes)
  assert.notDeepEqual(first.ephemeralPublicKey, second.ephemeralPublicKey)
})

test("a truncated or foreign payload fails to parse instead of decrypting", async () => {
  const recipient = await keyPair()
  const sealed = await sealShare(new Uint8Array(32).fill(1), recipient.publicKey, context())
  await assert.rejects(() => openShare(sealed.bytes.subarray(0, 40), recipient.privateKey, context()), /长度不足/)
  await assert.rejects(() => openShare(new Uint8Array(200).fill(0), recipient.privateKey, context()), /不是本协议的份额信封/)
})

test("only a 65-byte uncompressed P-256 point is accepted as a recipient key", async () => {
  const recipient = await keyPair()
  assert.equal(isSealableKey(recipient.publicKey), true)
  assert.equal(isSealableKey(new Uint8Array(33)), false)
  assert.equal(isSealableKey(new Uint8Array(65)), false, "all-zero 65 bytes is not a point")
  await assert.rejects(() => sealShare(new Uint8Array(4), new Uint8Array(33), context()), /未压缩 P-256/)
})

test("share length is bounded before any crypto work", async () => {
  const recipient = await keyPair()
  await assert.rejects(() => sealShare(new Uint8Array(0), recipient.publicKey, context()), /份额长度无效/)
  await assert.rejects(() => sealShare(new Uint8Array(MAX_SHARE_BYTES + 1), recipient.publicKey, context()), /份额长度无效/)
})

// --- on-chain key reads -----------------------------------------------------

const PACKAGE = "0x" + "e5".repeat(32)

/** The SDK exposes only the stored value in `value.bcs`, not the field struct. */
function registeredKey(value: Uint8Array) {
  return {
    $kind: "DynamicField" as const,
    type: `0x2::dynamic_field::Field<${PACKAGE}::dkg_committee::EncryptionKeySlot,vector<u8>>`,
    name: { type: `${PACKAGE}::dkg_committee::EncryptionKeySlot`, bcs: new Uint8Array() },
    valueType: "vector<u8>",
    fieldId: "0x" + "f6".repeat(32),
    version: "1", digest: "d", previousTransaction: null,
    value: { type: "vector<u8>", bcs: bcs.vector(bcs.u8()).serialize(Array.from(value)).toBytes() },
  }
}

function reader(overrides: Partial<EncryptionKeyClient> = {}) {
  return {
    getMoveFunction: async () => ({}),
    getDynamicField: async () => { throw new Error("not configured") },
    ...overrides,
  } as unknown as EncryptionKeyClient
}

test("a package without register_encryption_key reports no support instead of throwing", async () => {
  const client = reader({
    getMoveFunction: (async () => { throw new Error("Function not found: register_encryption_key") }) as unknown as EncryptionKeyClient["getMoveFunction"],
  })
  assert.equal(await createEncryptionKeyReader(client, PACKAGE).supportsEncryptionKeys(), false)
})

test("a network failure while probing support is not read as an old package", async () => {
  const client = reader({
    getMoveFunction: (async () => { throw new Error("connect ECONNREFUSED") }) as unknown as EncryptionKeyClient["getMoveFunction"],
  })
  await assert.rejects(() => createEncryptionKeyReader(client, PACKAGE).supportsEncryptionKeys(), /ECONNREFUSED/)
})

test("an unregistered participant reads as null, not as an empty key", async () => {
  const client = reader({
    getDynamicField: (async () => { throw new ObjectError("notFound", "missing", { objectId: SESSION, reason: "notFound" }) }) as unknown as EncryptionKeyClient["getDynamicField"],
  })
  assert.equal(await createEncryptionKeyReader(client, PACKAGE).readKey(SESSION, RECIPIENT), null)
})

test("a non-notFound dynamic-field failure surfaces instead of reading as unregistered", async () => {
  const client = reader({
    getDynamicField: (async () => { throw new ObjectError("malformed", "bad field", { objectId: SESSION, reason: "unknown" }) }) as unknown as EncryptionKeyClient["getDynamicField"],
  })
  await assert.rejects(() => createEncryptionKeyReader(client, PACKAGE).readKey(SESSION, RECIPIENT))
})

test("a registered key is returned when the field belongs to the requested participant", async () => {
  const raw = crypto.getRandomValues(new Uint8Array(65)); raw[0] = 0x04
  const client = reader({
    getDynamicField: (async () => ({ dynamicField: registeredKey(raw) })) as unknown as EncryptionKeyClient["getDynamicField"],
  })
  assert.deepEqual(await createEncryptionKeyReader(client, PACKAGE).readKey(SESSION, RECIPIENT), raw)
})

test("a registered key of the wrong length is an error, not a sealable key", async () => {
  const client = reader({
    getDynamicField: (async () => ({ dynamicField: registeredKey(new Uint8Array(33)) })) as unknown as EncryptionKeyClient["getDynamicField"],
  })
  await assert.rejects(() => createEncryptionKeyReader(client, PACKAGE).readKey(SESSION, RECIPIENT), /长度无效/)
})

test("the queried name carries the participant, so a slot cannot be confused with another", async () => {
  let seen: Uint8Array | null = null
  const raw = new Uint8Array(65); raw[0] = 0x04
  const client = reader({
    getDynamicField: (async ({ name }: { name: { bcs: Uint8Array } }) => {
      seen = name.bcs
      return { dynamicField: registeredKey(raw) }
    }) as unknown as EncryptionKeyClient["getDynamicField"],
  })
  await createEncryptionKeyReader(client, PACKAGE).readKey(SESSION, RECIPIENT)
  assert.ok(seen, "the name must be sent")
  assert.deepEqual(new Uint8Array(seen!).subarray(0, 32), Uint8Array.from(Buffer.from(RECIPIENT.replace(/^0x/, ""), "hex")))
})

test("the dynamic-field type comes from the defining package, not the call target", async () => {
  // A compatible upgrade mints a new package id; the dynamic-field NAME type
  // keeps the id of the package that first defined the struct. Deriving the
  // lookup from the call target returns notFound after an upgrade, which the
  // reader would report as "nobody registered a key" and silently skip delivery.
  const CALL_TARGET = "0x" + "11".repeat(32)
  const DEFINING = "0x" + "22".repeat(32)
  let seenType = ""
  const client = {
    getMoveFunction: async () => { throw new Error("not used here") },
    getDynamicField: (async ({ name }: { name: { type: string } }) => {
      seenType = name.type
      return { dynamicField: registeredKey(Object.assign(new Uint8Array(65), { 0: 0x04 })) }
    }) as unknown as EncryptionKeyClient["getDynamicField"],
  }
  await createEncryptionKeyReader(client, CALL_TARGET, DEFINING).readKey(SESSION, RECIPIENT)
  assert.equal(seenType, `${DEFINING}::dkg_committee::EncryptionKeySlot`)
  assert.doesNotMatch(seenType, /1111111111/)

  // Omitting the origin keeps today's deployment working, where they coincide.
  await createEncryptionKeyReader(client, CALL_TARGET).readKey(SESSION, RECIPIENT)
  assert.equal(seenType, `${CALL_TARGET}::dkg_committee::EncryptionKeySlot`)
})
