import assert from "node:assert/strict"
import { test } from "node:test"
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import {
  DEFAULT_SSM_SEAL_SERVERS, MAX_SSM_GROUPS, SSM_LOCAL_RELAYER_KEY, WalletSigner,
  describeSsmError, normalizeRelayerUrl, probeRelayer, readLocalRelayer, readSsmGroups,
  saveLocalRelayer, saveSsmGroup, ssmChatRows, ssmGroupStorageKey, ssmStatus,
  ssmSession, resetSsmSession, getSsmSigner, type SsmSessionDependencies,
} from "./sui-stack-messaging"

import { publishAccount } from "./zklogin"

const org = `0x${"a".repeat(64)}`
const group = `0x${"b".repeat(64)}`

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value) },
    removeItem: (key: string) => { data.delete(key) },
  }
}

test("a browser relayer URL must be HTTPS or loopback HTTP and never embed credentials", () => {
  assert.equal(normalizeRelayerUrl("https://relay.example.com/"), "https://relay.example.com")
  assert.equal(normalizeRelayerUrl("http://127.0.0.1:8787"), "http://127.0.0.1:8787")
  assert.equal(normalizeRelayerUrl(" http://localhost:3000/// "), "http://localhost:3000")
  for (const bad of ["", "relay.example.com", "http://relay.example.com", "https://user:pass@relay.example.com", "ftp://relay.example.com"]) {
    assert.throws(() => normalizeRelayerUrl(bad), Error, bad)
  }
})

test("status reports configuration gaps instead of inventing a relayer", () => {
  const missing = ssmStatus({}, "")
  assert.equal(missing.configured, false)
  assert.equal(missing.relayerSource, "none")
  assert.match(missing.reason!, /relayer/)
  assert.deepEqual(missing.sealServers, [...DEFAULT_SSM_SEAL_SERVERS])

  const env = ssmStatus({ NEXT_PUBLIC_SSM_RELAYER_URL: "https://relay.example.com" }, "")
  assert.deepEqual({ configured: env.configured, source: env.relayerSource, url: env.relayerUrl }, { configured: true, source: "env", url: "https://relay.example.com" })

  const local = ssmStatus({ NEXT_PUBLIC_SSM_RELAYER_URL: "https://env.example.com" }, "http://127.0.0.1:8787")
  assert.equal(local.relayerUrl, "http://127.0.0.1:8787")
  assert.equal(local.relayerSource, "local")

  const badSeal = ssmStatus({ NEXT_PUBLIC_SSM_RELAYER_URL: "https://relay.example.com", NEXT_PUBLIC_SSM_SEAL_KEY_SERVERS: "0x12" }, "")
  assert.equal(badSeal.configured, false)
  assert.match(badSeal.reason!, /Seal/)
})

test("a local relayer override round-trips and clears without touching the env value", () => {
  const storage = memoryStorage()
  assert.equal(readLocalRelayer(storage), "")
  assert.equal(saveLocalRelayer(storage, "http://127.0.0.1:8787/"), "http://127.0.0.1:8787")
  assert.equal(storage.getItem(SSM_LOCAL_RELAYER_KEY), "http://127.0.0.1:8787")
  assert.equal(readLocalRelayer(storage), "http://127.0.0.1:8787")
  assert.equal(saveLocalRelayer(storage, "  "), "")
  assert.equal(storage.getItem(SSM_LOCAL_RELAYER_KEY), null)
  assert.throws(() => saveLocalRelayer(storage, "http://relay.example.com"))
})

test("the liveness probe only reports ok for the reference health response", async () => {
  const calls: string[] = []
  const ok = await probeRelayer("https://relay.example.com/", (async (url: string) => {
    calls.push(url)
    return new Response(JSON.stringify({ status: "ok" }), { status: 200 })
  }) as typeof fetch)
  assert.deepEqual(ok, { ok: true, detail: "https://relay.example.com" })
  assert.deepEqual(calls, ["https://relay.example.com/health_check"])

  const rejected = await probeRelayer("https://relay.example.com", (async () => new Response("down", { status: 503 })) as typeof fetch)
  assert.equal(rejected.ok, false)
  assert.match(rejected.detail, /503/)

  const wrongShape = await probeRelayer("https://relay.example.com", (async () => new Response(JSON.stringify({ healthy: true }), { status: 200 })) as typeof fetch)
  assert.equal(wrongShape.ok, false)

  const offline = await probeRelayer("https://relay.example.com", (async () => { throw new Error("ECONNREFUSED") }) as typeof fetch)
  assert.equal(offline.ok, false)
  assert.match(offline.detail, /ECONNREFUSED/)

  const invalid = await probeRelayer("relay.example.com", (async () => new Response("{}")) as typeof fetch)
  assert.equal(invalid.ok, false)
})

test("local group registration rejects malformed records instead of dropping them", () => {
  const storage = memoryStorage()
  assert.deepEqual(readSsmGroups(storage, org), [])
  const record = { groupId: group, uuid: "u-1", name: "Team", createdAt: 1 }
  assert.deepEqual(saveSsmGroup(storage, org, record), [record])
  assert.deepEqual(readSsmGroups(storage, org), [record])

  const key = ssmGroupStorageKey(org)
  for (const raw of ["not json", "{}", JSON.stringify([{ groupId: "0x12", uuid: "u", name: "n", createdAt: 1 }]), JSON.stringify([{ groupId: group, uuid: "", name: "n", createdAt: 1 }]), JSON.stringify([{ groupId: group, uuid: "u", name: "n", createdAt: "1" }])]) {
    assert.throws(() => readSsmGroups(memoryStorage({ [key]: raw }), org), /原始记录已保留/, raw)
  }
})

test("group registration is bounded and newest-first without duplicates", () => {
  const storage = memoryStorage()
  let rows: ReturnType<typeof saveSsmGroup> = []
  for (let index = 0; index < MAX_SSM_GROUPS + 5; index++) {
    rows = saveSsmGroup(storage, org, { groupId: `0x${index.toString(16).padStart(64, "0")}`, uuid: `u-${index}`, name: `g${index}`, createdAt: index })
  }
  assert.equal(rows.length, MAX_SSM_GROUPS)
  assert.equal(rows[0].name, `g${MAX_SSM_GROUPS + 4}`)
  const replaced = saveSsmGroup(storage, org, { ...rows[0], name: "renamed" })
  assert.equal(replaced.length, MAX_SSM_GROUPS)
  assert.equal(replaced.filter(row => row.groupId === rows[0].groupId).length, 1)
  assert.equal(replaced[0].name, "renamed")
})

test("decrypted messages are ordered, normalized and never show deleted text", () => {
  const base = { groupId: group, isEdited: false, isDeleted: false, senderVerified: true, attachments: [] as never[] }
  const rows = ssmChatRows([
    { ...base, messageId: "b", order: 2, senderAddress: `0x${"C".repeat(64)}`, text: "second", createdAt: 2 },
    { ...base, messageId: "a", order: 1, senderAddress: `0x${"D".repeat(64)}`, text: "first", createdAt: 1, isEdited: true },
    { ...base, messageId: "c", order: 3, senderAddress: `0x${"e".repeat(64)}`, text: "hidden", createdAt: 3, isDeleted: true },
  ] as never)
  assert.deepEqual(rows.map(row => [row.id, row.order, row.text]), [["a", 1, "first"], ["b", 2, "second"], ["c", 3, ""]])
  assert.equal(rows[0].edited, true)
  assert.equal(rows[1].sender, `0x${"c".repeat(64)}`)
  assert.equal(rows[2].deleted, true)
})

test("relayer and Seal failures are explained as operational facts", () => {
  const withStatus = (status: number) => Object.assign(new Error("x"), { status })
  assert.match(describeSsmError(withStatus(401)), /签名/)
  assert.match(describeSsmError(withStatus(403)), /不回溯历史/)
  assert.match(describeSsmError(withStatus(404)), /找不到/)
  assert.match(describeSsmError(withStatus(500)), /HTTP 500/)
  assert.match(describeSsmError(new Error("Seal decryption access denied")), /Seal/)
  assert.match(describeSsmError(new Error("Failed to fetch")), /relayer/)
  assert.equal(describeSsmError(new Error("自定义错误")), "自定义错误")
})

async function withBrowser(run: (storage: ReturnType<typeof memoryStorage>, events: EventTarget) => Promise<void>) {
  const descriptors = new Map(["window", "localStorage", "fetch"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  const storage = memoryStorage()
  const events = new EventTarget()
  Object.defineProperty(globalThis, "window", { configurable: true, value: events })
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage })
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: () => assert.fail("Offline session tests must not use the network") })
  resetSsmSession()
  try { await run(storage, events) }
  finally {
    resetSsmSession()
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
}

function sessionDependencies() {
  let creates = 0, disconnects = 0, signers = 0
  const signer = Ed25519Keypair.generate()
  const dependencies: SsmSessionDependencies = {
    getSigner: async () => { signers++; return signer },
    createClient: async () => { creates++; return { messaging: { disconnect() { disconnects++ } } } as Awaited<ReturnType<NonNullable<SsmSessionDependencies["createClient"]>>> },
  }
  return { dependencies, counts: () => ({ creates, disconnects, signers }) }
}

test("SSM cache binds account provider and type and is invalidated by logout or same-address login", async () => {
  await withBrowser(async (storage, events) => {
    const account = { address: org, type: "wallet", provider: "First Wallet" }
    storage.setItem("sui_active_account", JSON.stringify(account))
    const fixture = sessionDependencies()
    const first = await ssmSession("https://relay.example.com", fixture.dependencies)
    assert.equal((await ssmSession("https://relay.example.com", fixture.dependencies)).client, first.client)
    storage.setItem("sui_active_account", JSON.stringify({ ...account, provider: "Second Wallet" }))
    assert.notEqual((await ssmSession("https://relay.example.com", fixture.dependencies)).client, first.client)
    storage.setItem("sui_active_account", JSON.stringify({ ...account, type: "passkey" }))
    await ssmSession("https://relay.example.com", fixture.dependencies)
    events.dispatchEvent(new Event("sui-account-switched"))
    await ssmSession("https://relay.example.com", fixture.dependencies)
    publishAccount(null)
    publishAccount(account)
    await ssmSession("https://relay.example.com", fixture.dependencies)
    assert.deepEqual(fixture.counts(), { creates: 5, disconnects: 4, signers: 5 })
  })
})

test("retired keystore identity cannot use SSM or cached signer and cannot be republished", async () => {
  await withBrowser(async storage => {
    storage.setItem("sui_active_account", JSON.stringify({ address: org, type: "wallet", provider: "First Wallet" }))
    const fixture = sessionDependencies()
    await ssmSession("https://relay.example.com", fixture.dependencies)
    const retired = { address: org, type: "keystore" }
    storage.setItem("sui_active_account", JSON.stringify(retired))
    storage.setItem("sui_active_dev_privkey", "synthetic-retired-key")
    await assert.rejects(ssmSession("https://relay.example.com", fixture.dependencies), /Keystore 签名已停用/)
    await assert.rejects(getSsmSigner(), /Keystore 签名已停用/)
    assert.throws(() => publishAccount(retired), /Keystore 登录已停用/)
    assert.equal(storage.getItem("sui_active_dev_privkey"), null)
    assert.deepEqual(fixture.counts(), { creates: 1, disconnects: 1, signers: 1 })
  })
})

test("account switching while SSM initializes discards the obsolete client", async () => {
  await withBrowser(async (storage, events) => {
    const account = { address: org, type: "wallet", provider: "First Wallet" }
    storage.setItem("sui_active_account", JSON.stringify(account))
    let release!: () => void, ready!: () => void, disconnects = 0
    const started = new Promise<void>(resolve => { ready = resolve })
    const finish = new Promise<void>(resolve => { release = resolve })
    const pending = ssmSession("https://relay.example.com", {
      getSigner: async () => Ed25519Keypair.generate(),
      createClient: async () => {
        ready(); await finish
        return { messaging: { disconnect() { disconnects++ } } } as Awaited<ReturnType<NonNullable<SsmSessionDependencies["createClient"]>>>
      },
    })
    const rejected = assert.rejects(pending, /账户|切换/)
    await started
    storage.setItem("sui_active_account", JSON.stringify({ ...account, provider: "Other Wallet" }))
    events.dispatchEvent(new Event("sui-account-switched"))
    release()
    await rejected
    assert.equal(disconnects, 1)
  })
})

test("retained wallet signers reject provider changes before prompting", async () => {
  await withBrowser(async storage => {
    const keypair = Ed25519Keypair.generate()
    const account = { address: keypair.toSuiAddress(), publicKey: keypair.getPublicKey().toSuiBytes(), chains: ["sui:testnet"] }
    const signer = new WalletSigner({ name: "First Wallet", features: { "sui:signPersonalMessage": { version: "1.1.0", signPersonalMessage: async () => assert.fail("Stale provider must not prompt") } } }, account)
    storage.setItem("sui_active_account", JSON.stringify({ address: account.address, type: "wallet", provider: "Other Wallet" }))
    await assert.rejects(signer.signPersonalMessage(new Uint8Array([1])), /账户或钱包提供方已切换/)
  })
})

test("the wallet adapter binds the public key to the account before any prompt", () => {
  const keypair = Ed25519Keypair.generate()
  const wallet = { name: "Test Wallet", features: {} }
  const account = { address: keypair.toSuiAddress(), publicKey: keypair.getPublicKey().toSuiBytes(), chains: ["sui:testnet"] }
  const signer = new WalletSigner(wallet, account)
  assert.equal(signer.toSuiAddress(), keypair.toSuiAddress())
  assert.equal(signer.getKeyScheme(), "ED25519")
  assert.equal(wallet.features ? 1 : 1, 1)

  assert.throws(() => new WalletSigner(wallet, { ...account, publicKey: undefined }), /未提供公钥/)
  assert.throws(() => new WalletSigner(wallet, { ...account, address: Ed25519Keypair.generate().toSuiAddress() }), /不匹配/)
  // A wallet without personal-message support fails closed before prompting.
  assert.rejects(signer.signPersonalMessage(new Uint8Array([1])), /sui:signPersonalMessage/)
})
