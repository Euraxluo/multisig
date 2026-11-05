import "fake-indexeddb/auto"
import assert from "node:assert/strict"
import { generateKeyPairSync, sign } from "node:crypto"
import { describe, it } from "node:test"
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { generateNonce, parseZkLoginSignature, toZkLoginPublicIdentifier } from "@mysten/sui/zklogin"
import { fromBase64 } from "@mysten/sui/utils"
import { Transaction } from "@mysten/sui/transactions"
import { getZkLoginSigner, completeManualZkLogin } from "./zklogin"
import { defaultDeviceVault } from "./crypto/device-vault"
import { configuration, consumeFlow, FLOW_SECONDS, limitedJson, openFlow, protect, sealFlow, validateClaims, verifyGoogleJwt, type Flow, type GoogleClaims } from "../app/api/zklogin/server"
import { bindTransactionSender, findMatchingWallet, successfulTransaction } from "./sui-wallet-signer"
import type { WalletAccount } from "./wallet-discovery"

const flow: Flow = {
  state: "a".repeat(64), nonce: "n".repeat(27), publicKey: "test-key", randomness: "1", maxEpoch: 10,
  createdAt: Date.now() - 5_000, expiresAt: Date.now() + 595_000,
}
const claims: GoogleClaims = {
  iss: "https://accounts.google.com", aud: "test.apps.googleusercontent.com", sub: "google-subject-123",
  nonce: flow.nonce, exp: Math.floor(Date.now() / 1000) + 300, iat: Math.floor(Date.now() / 1000),
}

describe("Google zkLogin server session", () => {
  it("requires server configuration, HTTPS providers and exact same-origin POSTs", () => {
    const env = {
      ZKLOGIN_ORIGIN: "https://app.example", ZKLOGIN_GOOGLE_CLIENT_ID: "test.apps.googleusercontent.com",
      ZKLOGIN_SESSION_SECRET: "test-secret-which-is-over-32-bytes-long", ZKLOGIN_SALT_URL: "https://salt.example/api", ZKLOGIN_PROVER_URL: "https://proof.example/api",
    }
    const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]))
    try {
      Object.assign(process.env, env)
      assert.equal(configuration().clientId, env.ZKLOGIN_GOOGLE_CLIENT_ID)
      assert.doesNotThrow(() => protect(new Request("https://app.example/api/zklogin/start", { method: "POST", headers: { origin: "https://app.example", "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" }, body: "{}" })))
      assert.throws(() => protect(new Request("https://app.example/api/zklogin/start", { method: "POST", headers: { origin: "https://evil.example", "Content-Type": "application/json" }, body: "{}" })), /来源/)
      process.env.ZKLOGIN_SALT_URL = "http://salt.example/api"
      assert.throws(() => configuration(), /HTTPS/)
      delete process.env.ZKLOGIN_SALT_URL
      assert.throws(() => configuration(), /未配置/)
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })

  it("bounds request bodies even when no Content-Length was supplied", async () => {
    assert.deepEqual(await limitedJson(new Request("https://app.example", { method: "POST", body: "{}" }), 20), {})
    await assert.rejects(limitedJson(new Request("https://app.example", { method: "POST", body: JSON.stringify({ token: "a".repeat(200) }) }), 20), /大小限制/)
  })

  it("authenticates an HMAC-protected HttpOnly-flow payload and rejects tampering", () => {
    const cookie = sealFlow(flow, "test-secret-which-is-over-32-bytes-long")
    assert.equal(openFlow(cookie, "test-secret-which-is-over-32-bytes-long").state, flow.state)
    assert.throws(() => openFlow(`${cookie}x`, "test-secret-which-is-over-32-bytes-long"))
    assert.throws(() => openFlow(cookie, "other-test-secret-which-is-over-32-bytes-long"))
  })

  it("rejects expired OAuth flow payloads and replayed state", () => {
    const expired = { ...flow, createdAt: Date.now() - FLOW_SECONDS * 1000 - 5, expiresAt: Date.now() - 5 }
    assert.throws(() => openFlow(sealFlow(expired, "test-secret-which-is-over-32-bytes-long"), "test-secret-which-is-over-32-bytes-long"), /超时/)
    consumeFlow(flow, flow.state)
    assert.throws(() => consumeFlow(flow, flow.state), /已使用/)
    assert.throws(() => consumeFlow({ ...flow, state: "b".repeat(64) }, flow.state), /state/)
  })

  it("requires trusted issuer, exact audience, nonce, and fresh expiry", () => {
    assert.doesNotThrow(() => validateClaims(claims, flow, claims.aud))
    assert.throws(() => validateClaims({ ...claims, iss: "https://evil.example" }, flow, claims.aud), /issuer/)
    assert.throws(() => validateClaims({ ...claims, aud: "other-client" }, flow, claims.aud), /audience/)
    assert.throws(() => validateClaims({ ...claims, nonce: "wrong" }, flow, claims.aud), /nonce/)
    assert.throws(() => validateClaims({ ...claims, exp: 1 }, flow, claims.aud), /过期/)
    assert.throws(() => validateClaims({ ...claims, iat: Math.floor(Date.now() / 1000) + 600 }, flow, claims.aud), /签发时间/)
  })

  it("verifies the RSA signature before accepting a Google JWT", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
    const jwk = publicKey.export({ format: "jwk" })
    const oldFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response(JSON.stringify({ keys: [{ ...jwk, kid: "test-kid", alg: "RS256", use: "sig" }] }), { headers: { "Content-Type": "application/json", "Cache-Control": "max-age=300" } })) as typeof fetch
    try {
      const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")
      const input = `${encode({ alg: "RS256", kid: "test-kid", typ: "JWT" })}.${encode(claims)}`
      const jwt = `${input}.${sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url")}`
      assert.equal((await verifyGoogleJwt(jwt, flow, claims.aud)).sub, claims.sub)
      const segments = jwt.split(".")
      const forged = `${segments[0]}.${encode({ ...claims, sub: "attacker" })}.${segments[2]}`
      await assert.rejects(verifyGoogleJwt(forged, flow, claims.aud), /签名/)
      await assert.rejects(verifyGoogleJwt(`${segments[0]}.${segments[1]}.AAAA`, flow, claims.aud), /签名/)
    } finally { globalThis.fetch = oldFetch }
  })

  it("wraps a real ephemeral signature, rejects another identity, and expires by epoch", async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage")
    const memory = new Map<string, string>()
    Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => memory.set(key, value), removeItem: (key: string) => memory.delete(key) } })
    try {
      const keypair = Ed25519Keypair.generate()
      const address = toZkLoginPublicIdentifier(123n, claims.iss, { legacyAddress: false }).toSuiAddress()
      // Structural proof fixture tests SDK signature assembly only; no simulated chain success.
      const inputs = {
        proofPoints: { a: ["1", "2", "1"], b: [["1", "2"], ["3", "4"], ["1", "0"]], c: ["1", "2", "1"] },
        issBase64Details: { value: Buffer.from(`"iss":"${claims.iss}",`).toString("base64url"), indexMod4: 0 },
        headerBase64: "e30", addressSeed: "123",
      }
      memory.set("sui_zklogin_session_v1", JSON.stringify({
        secretKey: keypair.getSecretKey(), publicKey: keypair.getPublicKey().toBase64(), randomness: "1",
        nonce: generateNonce(keypair.getPublicKey(), 10, "1"), maxEpoch: 10, inputs,
        account: { type: "zklogin", address },
      }))
      const signer = await getZkLoginSigner(address, 10)
      assert.equal(signer.toSuiAddress(), address)
      const signed = await signer.signTransaction(new Uint8Array([1, 2, 3]))
      assert.equal(fromBase64(signed.signature)[0], 5)
      const parsed = parseZkLoginSignature(fromBase64(signed.signature).slice(1))
      assert.equal(parsed.maxEpoch, "10")
      assert.equal(parsed.inputs.addressSeed, "123")
      await assert.rejects(() => getZkLoginSigner(`0x${"f".repeat(64)}`, 10), /不匹配/)
      await assert.rejects(() => getZkLoginSigner(address, 11), /过期/)
      assert.equal(memory.has("sui_zklogin_session_v1"), false)
      await assert.rejects(() => getZkLoginSigner(address, 10), /没有/)
    } finally {
      if (original) Object.defineProperty(globalThis, "sessionStorage", original)
      else Reflect.deleteProperty(globalThis, "sessionStorage")
    }
  })

  it("stores the ephemeral key sealed in sessionStorage and refuses a box bound to another login", async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage")
    const memory = new Map<string, string>()
    Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => memory.set(key, value), removeItem: (key: string) => memory.delete(key) } })
    try {
      const keypair = Ed25519Keypair.generate()
      const address = toZkLoginPublicIdentifier(123n, claims.iss, { legacyAddress: false }).toSuiAddress()
      const publicKey = keypair.getPublicKey().toBase64()
      const inputs = {
        proofPoints: { a: ["1", "2", "1"], b: [["1", "2"], ["3", "4"], ["1", "0"]], c: ["1", "2", "1"] },
        issBase64Details: { value: Buffer.from(`"iss":"${claims.iss}",`).toString("base64url"), indexMod4: 0 },
        headerBase64: "e30", addressSeed: "123",
      }
      const sealed = await defaultDeviceVault.seal(new TextEncoder().encode(keypair.getSecretKey()), `zklogin-ephemeral-v1:${publicKey}`)
      memory.set("sui_zklogin_session_v1", JSON.stringify({
        secretKey: sealed, publicKey, randomness: "1",
        nonce: generateNonce(keypair.getPublicKey(), 10, "1"), maxEpoch: 10, inputs,
        account: { type: "zklogin", address },
      }))
      // At rest the record holds only the sealed box, never the suiprivkey string.
      assert.equal(memory.get("sui_zklogin_session_v1")!.includes("suiprivkey"), false)
      const signer = await getZkLoginSigner(address, 10)
      assert.equal(signer.toSuiAddress(), address)
      const signed = await signer.signTransaction(new Uint8Array([1, 2, 3]))
      assert.equal(fromBase64(signed.signature)[0], 5)

      // The AAD context binds the box to this login's public key: replaying it
      // under another key's record must fail closed instead of signing.
      const other = Ed25519Keypair.generate()
      memory.set("sui_zklogin_session_v1", JSON.stringify({
        secretKey: sealed, publicKey: other.getPublicKey().toBase64(), randomness: "1",
        nonce: generateNonce(other.getPublicKey(), 10, "1"), maxEpoch: 10, inputs,
        account: { type: "zklogin", address },
      }))
      await assert.rejects(() => getZkLoginSigner(address, 10), /解密失败|不匹配/)
    } finally {
      if (original) Object.defineProperty(globalThis, "sessionStorage", original)
      else Reflect.deleteProperty(globalThis, "sessionStorage")
    }
  })

  it("rejects transaction sender mismatches and execution failures", () => {
    const address = `0x${"a".repeat(64)}`
    const transaction = new Transaction()
    bindTransactionSender(transaction, address)
    assert.equal(transaction.getData().sender, address)
    assert.throws(() => bindTransactionSender(transaction, `0x${"b".repeat(64)}`), /不匹配/)
    assert.throws(() => successfulTransaction({ $kind: "FailedTransaction", FailedTransaction: { status: { success: false, error: { message: "MoveAbort" } } } } as any, address), /MoveAbort/)
    const result = { $kind: "Transaction", Transaction: { digest: "test-digest", status: { success: true }, transaction: { sender: address }, effects: { status: { success: true }, changedObjects: [{ idOperation: "Created", objectId: "0x123" }] } } }
    assert.deepEqual(successfulTransaction(result as any, address), { digest: "test-digest", createdObjects: ["0x123"] })
    assert.throws(() => successfulTransaction(result as any, `0x${"b".repeat(64)}`), /不匹配/)
  })

  it("a pasted ID Token only completes the flow this tab started, and never invents a session", async () => {
    const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage")
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
    const originalFetch = globalThis.fetch
    const memory = new Map<string, string>()
    Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => memory.set(key, value), removeItem: (key: string) => memory.delete(key) } })
    Object.defineProperty(globalThis, "window", { configurable: true, value: new EventTarget() })
    const keypair = Ed25519Keypair.generate()
    const pending = {
      secretKey: keypair.getSecretKey(), publicKey: keypair.getPublicKey().toBase64(), randomness: "1",
      state: "c".repeat(64), nonce: generateNonce(keypair.getPublicKey(), 10, "1"), maxEpoch: 10, expiresAt: Date.now() + 300_000,
    }
    try {
      // No pending flow in this tab: a token alone must not create an account.
      await assert.rejects(completeManualZkLogin("a.b.c"), /重新开始|重新登录/)
      assert.equal(memory.has("sui_zklogin_session_v1"), false)

      memory.set("sui_zklogin_pending_v1", JSON.stringify(pending))
      await assert.rejects(completeManualZkLogin("not-a-jwt"), /格式无效/)
      // The one-use flow is cleared on every failure, so a retry needs a fresh start.
      assert.equal(memory.has("sui_zklogin_pending_v1"), false)

      memory.set("sui_zklogin_pending_v1", JSON.stringify(pending))
      let posted: { jwt?: string; state?: string } = {}
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        posted = JSON.parse(String(init?.body))
        return new Response(JSON.stringify({ error: "Google JWT nonce 不匹配。请重新登录。" }), { status: 400, headers: { "Content-Type": "application/json" } })
      }) as typeof fetch
      await assert.rejects(completeManualZkLogin("a.b.c"), /nonce 不匹配/)
      assert.deepEqual(posted, { jwt: "a.b.c", state: pending.state })
      assert.equal(memory.has("sui_zklogin_session_v1"), false)
    } finally {
      globalThis.fetch = originalFetch
      if (originalStorage) Object.defineProperty(globalThis, "sessionStorage", originalStorage)
      else Reflect.deleteProperty(globalThis, "sessionStorage")
      if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow)
      else Reflect.deleteProperty(globalThis, "window")
    }
  })

  it("matches only the selected Sui account and provider", () => {
    const selected = { type: "wallet", address: `0x${"b".repeat(64)}`, provider: "Sui Wallet" }
    // Wallet Standard accounts require `publicKey` and `features`; the matcher
    // reads only address/chains, but the fixture still has to be a real account.
    const accountFields = { publicKey: new Uint8Array(32), features: [] as WalletAccount["features"] }
    const chain = "sui:testnet" as const
    const wrong: WalletAccount = { address: `0x${"a".repeat(64)}`, chains: [chain], ...accountFields }
    const correct: WalletAccount = { address: selected.address, chains: [chain], ...accountFields }
    const features = { "standard:connect": { version: "1.0.0" as const, connect: async () => ({ accounts: [correct] }) }, "sui:signTransaction": { version: "2.0.0" as const, signTransaction: async () => ({ bytes: "", signature: "" }) } }
    const wallets = [
      { name: "Another Wallet", chains: ["sui:testnet"], accounts: [correct], features },
      { name: "Sui Wallet", chains: ["sui:testnet"], accounts: [wrong, correct], features },
      { name: "Sui Wallet", chains: ["sui:testnet"], accounts: [correct], features: { "sui:signTransactionBlock": {} } },
    ]
    assert.equal(findMatchingWallet(wallets, selected)?.account, correct)
    assert.equal(findMatchingWallet([{ name: "Sui Wallet", chains: ["sui:testnet"], accounts: [wrong], features: {} }], selected), undefined)
  })
})
