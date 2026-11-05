import assert from "node:assert/strict"
import { test } from "node:test"
import { ed25519 } from "@noble/curves/ed25519.js"
import {
  encryptWithPassword,
  decryptWithPassword,
  decryptJsonWithPassword,
  encodeSuiKeystoreKey,
  decodeSuiKeystoreKey,
  deriveEncryptionKey,
  exportEncryptedDeviceKey,
  importEncryptedDeviceKey,
  exportSuiCliKeystore,
  importSuiCliKeystore,
} from "./encrypted-keystore"
import { assembleDeviceKey } from "../dkg-key-package"

test("encrypts and decrypts raw 32-byte secret shares roundtrip", async () => {
  const secret = crypto.getRandomValues(new Uint8Array(32))
  const password = "my-secure-dao-passphrase-2026!"

  const envelope = await encryptWithPassword(secret, password, { iterations: 50_000 })
  assert.equal(envelope.version, 1)
  assert.equal(envelope.cipher, "aes-256-gcm")
  assert.equal(envelope.kdf, "pbkdf2")
  assert.equal(envelope.kdfParams.iterations, 50_000)
  assert.equal(envelope.kdfParams.salt.length, 32) // 16 bytes hex
  assert.equal(envelope.iv.length, 24) // 12 bytes hex
  assert.ok(envelope.ciphertext.length > 64)

  const decrypted = await decryptWithPassword(envelope, password)
  assert.deepEqual(decrypted, secret)
})

test("encrypts and decrypts JSON session objects roundtrip", async () => {
  const payload = {
    sessionId: "0x1234567890abcdef",
    holder: "0xalice",
    shareHex: "deadbeef00112233445566778899aabbccddeeff",
    nonces: { hiding: "01020304", binding: "05060708" },
  }
  const password = "complex-vault-password-#1"

  const envelope = await encryptWithPassword(JSON.stringify(payload), password, { iterations: 50_000 })
  const restored = await decryptJsonWithPassword<typeof payload>(envelope, password)
  assert.deepEqual(restored, payload)
})

test("rejects decryption with an incorrect password", async () => {
  const secret = new TextEncoder().encode("sensitive-secret-share-data")
  const envelope = await encryptWithPassword(secret, "correct-password", { iterations: 50_000 })

  await assert.rejects(
    decryptWithPassword(envelope, "wrong-password"),
    /密码错误或密钥数据已损坏/
  )
})

test("rejects decryption if ciphertext or IV has been tampered with", async () => {
  const secret = new TextEncoder().encode("integrity-protected-payload")
  const password = "password-123"
  const envelope = await encryptWithPassword(secret, password, { iterations: 50_000 })

  // Tamper with ciphertext
  const tamperedCiphertext = {
    ...envelope,
    ciphertext: envelope.ciphertext.slice(0, -2) + (envelope.ciphertext.slice(-2) === "00" ? "01" : "00"),
  }
  await assert.rejects(
    decryptWithPassword(tamperedCiphertext, password),
    /密码错误或密钥数据已损坏/
  )

  // Tamper with IV
  const tamperedIv = {
    ...envelope,
    iv: envelope.iv.slice(0, -2) + (envelope.iv.slice(-2) === "00" ? "01" : "00"),
  }
  await assert.rejects(
    decryptWithPassword(tamperedIv, password),
    /密码错误或密钥数据已损坏/
  )
})

test("rejects decryption if AAD is mismatched", async () => {
  const secret = new TextEncoder().encode("aad-protected-payload")
  const password = "password-aad"
  const aad1 = new TextEncoder().encode("scope-org-1")
  const aad2 = new TextEncoder().encode("scope-org-2")

  const envelope = await encryptWithPassword(secret, password, { iterations: 50_000, aad: aad1 })

  // Correct AAD succeeds
  const recovered = await decryptWithPassword(envelope, password, { aad: aad1 })
  assert.deepEqual(recovered, secret)

  // Wrong AAD fails
  await assert.rejects(
    decryptWithPassword(envelope, password, { aad: aad2 }),
    /密码错误或密钥数据已损坏/
  )
})

test("validates KDF input bounds (empty password, short salt, low iterations)", async () => {
  const validSalt = new Uint8Array(16)
  await assert.rejects(
    deriveEncryptionKey("", validSalt),
    /密码不能为空/
  )
  await assert.rejects(
    deriveEncryptionKey("pass", new Uint8Array(8)),
    /Salt 长度不足/
  )
  await assert.rejects(
    deriveEncryptionKey("pass", validSalt, 1000),
    /KDF 迭代次数过低/
  )
})

test("Sui keystore format: encodes and decodes canonical suiprivkey1 strings", () => {
  const secretKey = crypto.getRandomValues(new Uint8Array(32))

  const bech32 = encodeSuiKeystoreKey(secretKey, "ED25519")
  assert.ok(bech32.startsWith("suiprivkey1"))

  const decoded = decodeSuiKeystoreKey(bech32)
  assert.equal(decoded.schema, "ED25519")
  assert.deepEqual(decoded.secretKey, secretKey)
})

test("end-to-end: encrypts a Sui CLI keystore string into an encrypted envelope", async () => {
  const secretKey = crypto.getRandomValues(new Uint8Array(32))
  const suiPrivKey = encodeSuiKeystoreKey(secretKey, "ED25519")
  const password = "sui-cli-master-password"

  // Encrypt the suiprivkey string
  const envelope = await encryptWithPassword(suiPrivKey, password, { iterations: 50_000 })

  // Decrypt and import back to Sui keypair bytes
  const decryptedBytes = await decryptWithPassword(envelope, password)
  const decryptedStr = new TextDecoder("utf-8").decode(decryptedBytes)
  assert.equal(decryptedStr, suiPrivKey)

  const parsed = decodeSuiKeystoreKey(decryptedStr)
  assert.deepEqual(parsed.secretKey, secretKey)
})

test("Sui CLI Keystore JSON array export and import roundtrip", () => {
  const k1 = crypto.getRandomValues(new Uint8Array(32))
  const k2 = crypto.getRandomValues(new Uint8Array(32))

  const jsonStr = exportSuiCliKeystore([
    { secretKey: k1, scheme: "ED25519" },
    { secretKey: k2, scheme: "Secp256k1" },
  ])

  assert.ok(jsonStr.startsWith("[\n"))
  const imported = importSuiCliKeystore(jsonStr)
  assert.equal(imported.length, 2)
  assert.equal(imported[0].schema, "ED25519")
  assert.deepEqual(imported[0].secretKey, k1)
  assert.equal(imported[1].schema, "Secp256k1")
  assert.deepEqual(imported[1].secretKey, k2)
})

test("DKG DeviceKeyPackage sealing: encrypts and imports with session and holder AAD binding", async () => {
  const A = `0x${"41".repeat(32)}`
  const SESSION = `0x${"ab".repeat(32)}`
  const commitments = [ed25519.Point.BASE.multiply(23n).toBytes()]

  const key = assembleDeviceKey({
    sessionId: SESSION,
    holder: A,
    participantAddresses: [A],
    threshold: 1n,
    sessionEpoch: 4n,
    dealers: [{ address: A, commitments, share: 23n }],
  })

  const password = "dkg-master-password"
  const envelope = await exportEncryptedDeviceKey(key, password, { iterations: 50_000 })
  assert.equal(envelope.version, 1)

  // Successful import with matching password, session ID, and holder
  const restored = await importEncryptedDeviceKey(envelope, password, SESSION, A)
  assert.equal(restored.sessionId, SESSION)
  assert.equal(restored.holder, A)
  assert.equal(restored.share, 23n)
  assert.deepEqual(restored.groupPk, key.groupPk)

  // Rejected if password is wrong
  await assert.rejects(
    importEncryptedDeviceKey(envelope, "wrong-pass", SESSION, A),
    /密码错误或密钥数据已损坏/
  )

  // Rejected if session ID or holder does not match the bound AAD
  const OTHER_SESSION = `0x${"cc".repeat(32)}`
  await assert.rejects(
    importEncryptedDeviceKey(envelope, password, OTHER_SESSION, A),
    /密码错误或密钥数据已损坏/
  )
})
