import assert from "node:assert/strict"
import { afterEach, beforeEach, test } from "node:test"
import { p256 } from "@noble/curves/nist.js"
import { sha256 } from "@noble/hashes/sha2.js"
import { verifyPersonalMessageSignature } from "@mysten/sui/verify"
import { PasskeyPublicKey } from "@mysten/sui/keypairs/passkey"
import { fromBase64, toBase64 } from "@mysten/sui/utils"
import {
  LEGACY_PASSKEY_KEY, PASSKEY_STORE_KEY, findStoredPasskey, getPasskeySigner, listStoredPasskeys,
  loginWithPasskey, passkeyErrorMessage, passkeySupported, recoverPasskeyAccount, registerPasskey,
  removeStoredPasskey, type StoredPasskey,
} from "./passkey"

// The browser provider is the only untrusted seam. These fixtures implement the
// WebAuthn responses the SDK expects with a real P-256 key, so registration,
// recovery and signature verification run the production code paths offline.

interface CredentialFixture {
  credentialId: Uint8Array
  secret: Uint8Array
  publicKey: Uint8Array
}

function makeCredential(): CredentialFixture {
  const secret = p256.utils.randomSecretKey()
  return {
    credentialId: crypto.getRandomValues(new Uint8Array(16)),
    secret,
    publicKey: p256.getPublicKey(secret, true),
  }
}

/** DER SubjectPublicKeyInfo for a P-256 key, the shape `getPublicKey()` returns. */
function spki(publicKey: Uint8Array): Uint8Array {
  const header = Uint8Array.from([48, 89, 48, 19, 6, 7, 42, 134, 72, 206, 61, 2, 1, 6, 8, 42, 134, 72, 206, 61, 3, 1, 7, 3, 66, 0])
  const uncompressed = p256.Point.fromBytes(publicKey).toBytes(false)
  return new Uint8Array([...header, ...uncompressed])
}

function registration(fixture: CredentialFixture) {
  return {
    rawId: fixture.credentialId,
    response: { getPublicKey: () => spki(fixture.publicKey).buffer },
  }
}

function assertion(fixture: CredentialFixture, challenge: Uint8Array) {
  const origin = "https://example.test"
  const clientDataJSON = new TextEncoder().encode(JSON.stringify({
    type: "webauthn.get", challenge: toBase64(challenge).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""), origin, crossOrigin: false,
  }))
  const authenticatorData = new Uint8Array(37)
  authenticatorData.set(sha256(new TextEncoder().encode(origin)), 0)
  // rpIdHash || flags || signCount; verified-user flag set.
  authenticatorData[32] = 0x05
  const message = new Uint8Array([...authenticatorData, ...sha256(clientDataJSON)])
  const signature = p256.sign(message, fixture.secret, { format: "der" })
  return {
    rawId: fixture.credentialId,
    response: { authenticatorData: authenticatorData.buffer, clientDataJSON: clientDataJSON.buffer, signature: signature.buffer },
  }
}

class FixtureProvider {
  creates = 0
  gets = 0
  fixture: CredentialFixture
  constructor(fixture: CredentialFixture) { this.fixture = fixture }
  async create() { this.creates += 1; return registration(this.fixture) as unknown as PublicKeyCredential }
  async get(challenge: Uint8Array) {
    this.gets += 1
    // Narrow to the credential the caller asked for, like a real authenticator.
    return assertion(this.fixture, challenge) as unknown as PublicKeyCredential
  }
}

const storage = new Map<string, string>()
const originalGlobals = new Map(["window", "localStorage", "navigator"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))

beforeEach(() => {
  storage.clear()
  Object.defineProperty(globalThis, "window", { configurable: true, value: { isSecureContext: true, PublicKeyCredential: function () {} } })
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value) },
    removeItem: (key: string) => { storage.delete(key) },
  } })
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { credentials: {} } })
})
afterEach(() => {
  for (const [key, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else Reflect.deleteProperty(globalThis, key)
  }
})

test("registration derives a SIP-9 address and persists only public material", async () => {
  const fixture = makeCredential()
  const provider = new FixtureProvider(fixture)
  const { account, record } = await registerPasskey(provider as never)
  const expected = new PasskeyPublicKey(fixture.publicKey).toSuiAddress()

  assert.equal(account.type, "passkey")
  assert.equal(account.address, expected)
  assert.equal(record.suiAddress, expected)
  assert.deepEqual(listStoredPasskeys().map(item => item.suiAddress), [expected])
  const stored = storage.get(PASSKEY_STORE_KEY) ?? ""
  assert.equal(stored.includes(toBase64(fixture.secret)), false)
  for (const key of ["secret", "privateKey", "secretKey"]) assert.equal(stored.includes(key), false)
  assert.equal(provider.creates, 1)

  const signer = await getPasskeySigner(expected, provider as never)
  assert.equal(signer.toSuiAddress(), expected)
  assert.deepEqual(signer.getCredentialId(), fixture.credentialId)
})

test("login proves possession and rejects a passkey whose address does not match", async () => {
  const fixture = makeCredential()
  const provider = new FixtureProvider(fixture)
  const { record } = await registerPasskey(provider as never)
  const account = await loginWithPasskey(record.suiAddress, provider as never)
  assert.equal(account.address, record.suiAddress)
  assert.equal(provider.gets, 1)

  const other = makeCredential()
  await assert.rejects(loginWithPasskey(record.suiAddress, new FixtureProvider(other) as never), /未通过|不匹配|验证/)
})

test("a tampered stored public key is refused before signing", async () => {
  const fixture = makeCredential()
  const provider = new FixtureProvider(fixture)
  const { record } = await registerPasskey(provider as never)
  const tampered: StoredPasskey = { ...record, publicKeyBase64: toBase64(makeCredential().publicKey) }
  storage.set(PASSKEY_STORE_KEY, JSON.stringify([tampered]))
  await assert.rejects(getPasskeySigner(record.suiAddress, provider as never), /不匹配/)
})

test("the legacy single-record store is upgraded from a real assertion", async () => {
  const fixture = makeCredential()
  const address = new PasskeyPublicKey(fixture.publicKey).toSuiAddress()
  storage.set(LEGACY_PASSKEY_KEY, JSON.stringify({
    credentialIdBase64: toBase64(fixture.credentialId),
    suiAddress: address,
    identifier: "MacBook TouchID",
    createdAt: 1,
  }))
  assert.equal(listStoredPasskeys().length, 1)
  assert.equal(listStoredPasskeys()[0].publicKeyBase64, null)

  const provider = new FixtureProvider(fixture)
  const signer = await getPasskeySigner(address, provider as never)
  assert.equal(signer.toSuiAddress(), address)
  const upgraded = findStoredPasskey(address)
  assert.ok(upgraded?.publicKeyBase64)
  assert.equal(storage.has(LEGACY_PASSKEY_KEY), false)
  assert.deepEqual(JSON.parse(storage.get(PASSKEY_STORE_KEY)!)[0].publicKeyBase64, upgraded?.publicKeyBase64)
})

test("the legacy record is rejected when the device holds a different key", async () => {
  const registered = makeCredential()
  const address = new PasskeyPublicKey(registered.publicKey).toSuiAddress()
  storage.set(LEGACY_PASSKEY_KEY, JSON.stringify({ credentialIdBase64: toBase64(registered.credentialId), suiAddress: address, identifier: "old", createdAt: 1 }))
  await assert.rejects(getPasskeySigner(address, new FixtureProvider(makeCredential()) as never), /不匹配/)
})

test("recovery identifies one credential from two assertions and stores it", async () => {
  const fixture = makeCredential()
  const provider = new FixtureProvider(fixture)
  const record = await recoverPasskeyAccount(provider as never)
  assert.equal(record.suiAddress, new PasskeyPublicKey(fixture.publicKey).toSuiAddress())
  assert.equal(record.publicKeyBase64, toBase64(fixture.publicKey))
  assert.deepEqual(record.credentialIdBase64, toBase64(fixture.credentialId))
  assert.equal(listStoredPasskeys().length, 1)
})

test("records can be removed without touching other accounts", async () => {
  const first = await registerPasskey(new FixtureProvider(makeCredential()) as never)
  const second = await registerPasskey(new FixtureProvider(makeCredential()) as never)
  removeStoredPasskey(first.record.suiAddress)
  assert.deepEqual(listStoredPasskeys().map(item => item.suiAddress), [second.record.suiAddress])
  assert.equal(storage.has(LEGACY_PASSKEY_KEY), false)
})

test("malformed records are ignored rather than trusted", async () => {
  storage.set(PASSKEY_STORE_KEY, JSON.stringify([
    null, "x", {}, { suiAddress: "0x12", credentialIdBase64: "AAAA" },
    { suiAddress: new PasskeyPublicKey(makeCredential().publicKey).toSuiAddress(), credentialIdBase64: "", publicKeyBase64: null },
  ]))
  assert.deepEqual(listStoredPasskeys(), [])
  storage.set(PASSKEY_STORE_KEY, "not json")
  assert.deepEqual(listStoredPasskeys(), [])
})

test("support detection and error text never claim a capability the browser lacks", () => {
  assert.equal(passkeySupported(), true)
  Object.defineProperty(globalThis, "window", { configurable: true, value: { isSecureContext: false, PublicKeyCredential: function () {} } })
  assert.equal(passkeySupported(), false)
  assert.match(passkeyErrorMessage(Object.assign(new Error("x"), { name: "NotAllowedError" })), /取消/)
  assert.match(passkeyErrorMessage(new Error("自定义错误")), /自定义错误/)
})

test("a fixture signature verifies for the account address under the Passkey scheme", async () => {
  // Guards the expectation that the fixtures produce the exact BCS shape the network accepts.
  const fixture = makeCredential()
  const provider = new FixtureProvider(fixture)
  const { record } = await registerPasskey(provider as never)
  const signer = await getPasskeySigner(record.suiAddress, provider as never)
  const message = new TextEncoder().encode("offline check")
  const signed = await signer.signPersonalMessage(message)
  assert.equal(fromBase64(signed.signature)[0], 6)
  await verifyPersonalMessageSignature(message, signed.signature, { address: record.suiAddress })
  await assert.rejects(verifyPersonalMessageSignature(message, signed.signature, { address: new PasskeyPublicKey(makeCredential().publicKey).toSuiAddress() }))
})
