import "fake-indexeddb/auto"
import assert from "node:assert/strict"
import { test } from "node:test"
import { createDeviceVault } from "./device-vault"

const CONTEXT = "frost-nonce:keypkg:ctxhash:1"

test("seals and opens secret material roundtrip with context binding", async () => {
  const vault = createDeviceVault({ databaseName: `device-vault-test-${crypto.randomUUID()}` })
  const secret = crypto.getRandomValues(new Uint8Array(64))

  const box = await vault.seal(secret, CONTEXT)
  assert.equal(box.version, 1)
  assert.equal(box.iv.length, 24)
  assert.ok(box.data.length >= 128 && box.data.length % 2 === 0)
  // Ciphertext must not contain the plaintext bytes anywhere.
  const plaintextHex = Array.from(secret, b => b.toString(16).padStart(2, "0")).join("")
  assert.equal(box.data.includes(plaintextHex.slice(0, 16)), false)

  assert.deepEqual(await vault.open(box, CONTEXT), secret)
})

test("a sealed box is refused under a different context (AAD binding)", async () => {
  const vault = createDeviceVault({ databaseName: `device-vault-test-${crypto.randomUUID()}` })
  const box = await vault.seal(new Uint8Array(32).fill(7), CONTEXT)
  await assert.rejects(() => vault.open(box, "frost-nonce:keypkg:other:1"), /设备密钥库解密失败/)
  await assert.rejects(() => vault.open(box, ""), /非空上下文/)
})

test("tampered ciphertext or IV is rejected by the GCM tag", async () => {
  const vault = createDeviceVault({ databaseName: `device-vault-test-${crypto.randomUUID()}` })
  const box = await vault.seal(new Uint8Array(32).fill(9), CONTEXT)
  const flip = (value: string) => value.slice(0, -2) + (value.slice(-2) === "00" ? "01" : "00")
  await assert.rejects(() => vault.open({ ...box, data: flip(box.data) }, CONTEXT), /设备密钥库解密失败/)
  await assert.rejects(() => vault.open({ ...box, iv: flip(box.iv) }, CONTEXT), /设备密钥库解密失败/)
  await assert.rejects(() => vault.open({ ...box, version: 2 } as never, CONTEXT), /密封数据格式无效/)
})

test("two vault instances over one database converge on the same non-extractable key", async () => {
  const databaseName = `device-vault-test-${crypto.randomUUID()}`
  const first = createDeviceVault({ databaseName })
  const second = createDeviceVault({ databaseName })

  const [a, b] = await Promise.all([
    first.seal(new Uint8Array(64).fill(1), CONTEXT),
    second.seal(new Uint8Array(64).fill(2), CONTEXT),
  ])
  // Each instance can open the other's box, proving both resolved to one key
  // even when both raced the initial creation.
  assert.deepEqual(await second.open(a, CONTEXT), new Uint8Array(64).fill(1))
  assert.deepEqual(await first.open(b, CONTEXT), new Uint8Array(64).fill(2))

  // The persisted key is a real non-extractable CryptoKey.
  const key = await new Promise<CryptoKey>((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1)
    request.onsuccess = () => {
      const tx = request.result.transaction("keys", "readonly")
      const get = tx.objectStore("keys").get("device-aes-gcm-256")
      get.onsuccess = () => resolve(get.result as CryptoKey)
      get.onerror = () => reject(get.error)
    }
    request.onerror = () => reject(request.error)
  })
  assert.equal(key.extractable, false)
  await assert.rejects(() => crypto.subtle.exportKey("raw", key), /may not be exported|not extractable/i)
})

test("empty plaintext and oversized contexts are rejected before any storage write", async () => {
  const vault = createDeviceVault({ databaseName: `device-vault-test-${crypto.randomUUID()}` })
  await assert.rejects(() => vault.seal(new Uint8Array(0), CONTEXT), /待密封数据不能为空/)
  await assert.rejects(() => vault.seal(new Uint8Array(32), "x".repeat(600)), /上下文过长/)
})
