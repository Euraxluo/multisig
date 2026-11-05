import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { resolve } from "node:path"
import { afterEach, beforeEach, test } from "node:test"
import type { Wallet } from "@mysten/wallet-standard"
import type { SuiClientTypes } from "@mysten/sui/client"
import type { SuiGrpcClient } from "@mysten/sui/grpc"
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { Transaction, TransactionDataBuilder } from "@mysten/sui/transactions"
import { normalizeSuiAddress } from "@mysten/sui/utils"
import {
  acknowledgePendingTransaction, getPendingTransaction, getTransactionReceipt,
  TransactionReceiptError, type PendingTransactionReceipt, type TransactionAccount, type TransactionIntent,
} from "./pending-transactions"
import { resumePendingTransaction, signAndExecuteWithWallet, type WalletTransactionOptions } from "./sui-wallet-signer"
import { acknowledgeAgentTransaction, submitAgentTransaction } from "./agent-vault-transactions"

// Generated in memory for offline cryptographic checks; no browser or development keys are read.
const keypair = Ed25519Keypair.generate()
const address = keypair.toSuiAddress()
const otherAddress = normalizeSuiAddress("0x222")
const selected = { address, type: "wallet", provider: "Offline Wallet" }
const createdId = normalizeSuiAddress("0x123")
const storage = new Map<string, string>()
const originalGlobals = new Map(["window", "localStorage", "fetch"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
const unregister: Array<() => void> = []
let sequence = 0

beforeEach(() => {
  storage.clear()
  Object.defineProperty(globalThis, "window", { configurable: true, value: new EventTarget() })
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value) },
    removeItem: (key: string) => { storage.delete(key) },
    key: (index: number) => [...storage.keys()][index] ?? null,
    get length() { return storage.size },
  } })
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: () => assert.fail("Offline signer tests must never use the network") })
  activate(selected)
})
afterEach(() => {
  unregister.splice(0).forEach(remove => remove())
  for (const [key, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else Reflect.deleteProperty(globalThis, key)
  }
})

function activate(account: TransactionAccount) { localStorage.setItem("sui_active_account", JSON.stringify(account)) }
function operation(): WalletTransactionOptions {
  return { action: "create-payment", scope: `signer-regression-${++sequence}`, expectedAccount: selected, metadata: { name: "Offline payment" } }
}
function intent(options: WalletTransactionOptions, account: TransactionAccount = selected): TransactionIntent {
  return { account, action: options.action, scope: options.scope }
}
function persisted(receipt: PendingTransactionReceipt): PendingTransactionReceipt {
  const raw = storage.get(receipt.key)
  assert.ok(raw, "The receipt must be written to browser storage")
  return JSON.parse(raw)
}
async function receiptError(promise: Promise<unknown>): Promise<TransactionReceiptError> {
  try { await promise } catch (error) {
    assert.ok(error instanceof TransactionReceiptError, `Expected TransactionReceiptError, received ${String(error)}`)
    return error
  }
  assert.fail("Expected an unresolved or failed transaction receipt")
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function offlineTransaction() {
  const tx = new Transaction()
  tx.setGasPrice(1)
  tx.setGasBudget(10_000)
  tx.setGasPayment([{ objectId: normalizeSuiAddress("0x999"), version: "1", digest: "11111111111111111111111111111111" }])
  const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(1)])
  tx.transferObjects([coin], tx.pure.address(otherAddress))
  return tx
}

type ChainResult = SuiClientTypes.TransactionResult<{ effects: true; transaction: true }>
type WaitInput = { digest: string; include?: { effects?: boolean; transaction?: boolean }; timeout?: number }
type ExecuteInput = { transaction: Uint8Array; signatures: string[]; include?: { effects?: boolean; transaction?: boolean } }
function result(digest: string, sender = address): ChainResult {
  // Only fields consumed by the signer are populated; malformed responses are tested separately.
  return { $kind: "Transaction", Transaction: {
    digest, status: { success: true, error: null }, transaction: { sender },
    effects: { status: { success: true, error: null }, changedObjects: [
      { objectId: createdId, idOperation: "Created" },
      { objectId: normalizeSuiAddress("0x999"), idOperation: "None" },
    ] },
  } } as ChainResult
}
function failedResult(digest: string, sender = address): ChainResult {
  const value = result(digest, sender).Transaction!
  value.status = { success: false, error: { message: "MoveAbort(offline fixture)" } as SuiClientTypes.ExecutionError }
  value.effects.status = value.status
  return { $kind: "FailedTransaction", FailedTransaction: value }
}
function rpc() { const waits: WaitInput[] = []
  const executes: ExecuteInput[] = []
  const handlers = {
    wait: async (_input: WaitInput): Promise<ChainResult> => { throw new Error("Confirmation query timed out") },
    execute: async (_input: ExecuteInput): Promise<ChainResult> => { throw new Error("Execute transport disconnected") },
  }
  // A narrow fake is cast only at the SDK boundary. Fully populated PTBs build without RPC resolution.
  const client = {
    waitForTransaction: async (input: WaitInput) => { waits.push(input); return handlers.wait(input) },
    executeTransaction: async (input: ExecuteInput) => { executes.push(input); return handlers.execute(input) },
    getCurrentSystemState: async () => assert.fail("Wallet tests must not resolve a zkLogin or keystore signer"),
  } as unknown as SuiGrpcClient
  return { client, handlers, waits, executes }
}

type WalletInput = { transaction?: Transaction; transactionBlock?: Transaction; account: { address: string }; chain: string; options?: object }
type WalletOutput = { digest?: string; bytes?: string; signature?: string; effects?: string }
async function wallet(mode: "modern" | "legacy" | "sign", handler: (input: WalletInput) => Promise<WalletOutput>, provider = selected.provider, walletAddress = address) {
  const calls: WalletInput[] = []
  const account = { address: walletAddress, publicKey: keypair.getPublicKey().toRawBytes(), chains: ["sui:testnet"], features: [] }
  const invoke = async (input: WalletInput) => {
    calls.push(input)
    assert.equal(input.account, account, "Pass the selected provider's exact account object")
    assert.equal(input.chain, "sui:testnet")
    assert.equal((input.transaction ?? input.transactionBlock)?.getData().sender, walletAddress)
    return handler(input)
  }
  const feature = mode === "sign" ? { "sui:signTransaction": { version: "2.0.0", signTransaction: invoke } }
    : mode === "modern" ? { "sui:signAndExecuteTransaction": { version: "2.0.0", signAndExecuteTransaction: invoke } }
      : { "sui:signAndExecuteTransactionBlock": { version: "1.0.0", signAndExecuteTransactionBlock: invoke } }
  const registered = { version: "1.0.0", name: provider, icon: "data:image/png;base64,", chains: ["sui:testnet"], accounts: [account], features: {
    "standard:connect": { version: "1.0.0", connect: async () => assert.fail("Signing must not reconnect a wallet") }, ...feature,
  } } as unknown as Wallet
  const { getWallets } = await import("@mysten/wallet-standard")
  unregister.push(getWallets().register(registered))
  return calls
}

test("retired keystore identities cannot build, sign, submit, or create a fresh receipt even with a stale browser key", async () => {
  const retired = { ...selected, type: "keystore", provider: "Dev Keystore" }
  activate(retired)
  storage.set("sui_active_dev_privkey", "synthetic-retired-key")
  storage.set("sui_dev_accounts", "synthetic-retired-list")
  const remote = rpc()
  const tx = offlineTransaction()
  tx.build = async () => assert.fail("Retired key must not build transactions")
  const options = { ...operation(), expectedAccount: retired }
  await assert.rejects(signAndExecuteWithWallet(tx, options, remote), /Keystore 签名已停用/)
  assert.equal(storage.has("sui_active_dev_privkey"), false)
  assert.equal(storage.has("sui_dev_accounts"), false)
  assert.deepEqual(remote.executes, [])
  assert.deepEqual(remote.waits, [])
  assert.equal(getPendingTransaction(intent(options, retired)), undefined)
})

for (const mode of ["modern", "legacy"] as const) {
  test(`${mode} wallet digest survives confirmation timeout; retry is blocked and resume only queries the original digest`, async () => {
    const options = operation()
    const remote = rpc()
    const digest = `${mode}-original-digest`
    const calls = await wallet(mode, async input => {
      const receipt = getPendingTransaction(intent(options))!
      assert.equal(persisted(receipt).status, "pending", "Persist a lock before invoking a wallet that can broadcast")
      assert.equal(receipt.digest, undefined)
      if (mode === "legacy") assert.deepEqual(input.options, { showEffects: true })
      return { digest }
    })
    remote.handlers.wait = async input => {
      assert.equal(input.digest, digest)
      assert.equal(persisted(getPendingTransaction(intent(options))!).digest, digest, "Persist the returned digest before querying")
      throw new Error("Confirmation query timed out")
    }
    const first = await receiptError(signAndExecuteWithWallet(offlineTransaction(), options, remote))
    assert.equal(first.digest, digest)
    assert.equal(first.status, "pending")
    assert.equal(first.receipt.persistent, true)
    assert.equal(persisted(first.receipt).digest, digest)
    assert.match(first.receipt.error!, /timed out/)
    assert.deepEqual(remote.waits, [{ digest, include: { effects: true, transaction: true }, timeout: 30_000 }])

    const duplicate = await receiptError(signAndExecuteWithWallet(offlineTransaction(), options, remote))
    assert.equal(duplicate.receipt.id, first.receipt.id)
    assert.equal(calls.length, 1)
    assert.equal(remote.waits.length, 1)
    await receiptError(resumePendingTransaction(first.receipt.id, remote))
    assert.equal(getPendingTransaction(intent(options))?.digest, digest)

    remote.handlers.wait = async () => result(digest)
    const recovered = await resumePendingTransaction(first.receipt.id, remote)
    assert.equal(recovered.receipt.id, first.receipt.id)
    assert.equal(recovered.receipt.status, "success")
    assert.equal(recovered.receipt.error, undefined)
    assert.deepEqual(recovered.createdObjects, [createdId])
    assert.deepEqual(remote.waits.map(input => input.digest), [digest, digest, digest])
    assert.equal(calls.length, 1, "Recovery must never sign or execute in the wallet again")
    assert.equal(remote.executes.length, 0)
    assert.equal(persisted(recovered.receipt).acknowledged, false)
    await receiptError(signAndExecuteWithWallet(offlineTransaction(), options, remote))
    assert.equal(calls.length, 1, "Success remains locked until recovered objects have been acknowledged")
    acknowledgePendingTransaction(recovered.receipt)
    assert.equal(getPendingTransaction(intent(options)), undefined)
    assert.equal(persisted(recovered.receipt).acknowledged, true)
  })
}

test("agent creation flows keep the confirmed receipt pending until created objects resolve, then acknowledge", async () => {
  let digest = "agent-deferred-digest"
  await wallet("modern", async () => ({ digest }))
  const remote = rpc()
  remote.handlers.wait = async () => result(digest)

  const deferred = { action: "agent-cap-spawn", scope: `agent-defer-${++sequence}`, deferAcknowledgement: true }
  const confirmed = await submitAgentTransaction(offlineTransaction(), deferred, remote)
  assert.equal(confirmed.digest, digest)
  assert.deepEqual(confirmed.createdObjects, [createdId])
  // Confirmed on chain, but the pending lock survives until the caller has
  // resolved and verified the created objects (deferAcknowledgement).
  assert.equal(getPendingTransaction({ account: selected, ...deferred })?.digest, digest)
  // A failure while resolving objects must not invite a duplicate spawn: the
  // same intent stays blocked exactly like an unconfirmed transaction.
  await assert.rejects(submitAgentTransaction(offlineTransaction(), deferred, remote), /待恢复/)
  acknowledgeAgentTransaction(confirmed)
  assert.equal(getPendingTransaction({ account: selected, ...deferred }), undefined)

  // The default path acknowledges the receipt before the call returns.
  digest = "agent-immediate-digest"
  const immediate = { action: "agent-vault-initialize", scope: `agent-defer-${++sequence}` }
  await submitAgentTransaction(offlineTransaction(), immediate, remote)
  assert.equal(getPendingTransaction({ account: selected, ...immediate }), undefined)
})

test("a fresh process reloads the persisted receipt, blocks resubmission, and recovers with no registered wallet", async () => {
  const options = operation()
  const remote = rpc()
  await wallet("modern", async () => ({ digest: "reload-original-digest" }))
  const first = await receiptError(signAndExecuteWithWallet(offlineTransaction(), options, remote))
  // A new Node process has neither the receipt module's memory cache nor the wallet registry.
  const script = String.raw`
    const assert = require("node:assert/strict")
    const fs = require("node:fs")
    const input = JSON.parse(fs.readFileSync(0, "utf8"))
    const storage = new Map(input.storage)
    globalThis.localStorage = {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      key: index => [...storage.keys()][index] ?? null,
      get length() { return storage.size },
    }
    globalThis.fetch = () => assert.fail("Reload recovery must stay offline")
    const { getWallets } = require("@mysten/wallet-standard")
    const { Transaction } = require("@mysten/sui/transactions")
    const receipts = require("./lib/pending-transactions.ts")
    const signer = require("./lib/sui-wallet-signer.ts")
    let waits = 0, executes = 0
    const client = {
      waitForTransaction: async request => {
        waits++
        assert.equal(request.digest, input.receipt.digest)
        return input.result
      },
      executeTransaction: async () => { executes++; assert.fail("Recovery must not execute") },
    }
    ;(async () => {
      assert.equal(getWallets().get().length, 0)
      const restored = receipts.getPendingTransaction(input.intent)
      assert.equal(restored.id, input.receipt.id)
      assert.equal(restored.digest, input.receipt.digest)
      await assert.rejects(signer.signAndExecuteWithWallet(new Transaction(), input.options, { client }),
        error => error instanceof receipts.TransactionReceiptError && error.digest === input.receipt.digest)
      const recovered = await signer.resumePendingTransaction(restored.id, { client })
      assert.equal(waits, 1)
      assert.equal(executes, 0)
      assert.equal(receipts.getPendingTransaction(input.intent).status, "success")
      process.stdout.write(JSON.stringify({ recovered, stored: JSON.parse(storage.get(restored.key)) }))
    })().catch(error => { console.error(error); process.exitCode = 1 })
  `
  const output = execFileSync(process.execPath, ["--require", "tsx/cjs", "--eval", script], {
    cwd: resolve(__dirname, ".."), encoding: "utf8", timeout: 20_000,
    input: JSON.stringify({ storage: [...storage], receipt: first.receipt, intent: intent(options), options, result: result(first.digest!) }),
  })
  const reloaded = JSON.parse(output)
  assert.equal(reloaded.recovered.digest, first.digest)
  assert.equal(reloaded.recovered.receipt.id, first.receipt.id)
  assert.deepEqual(reloaded.recovered.createdObjects, [createdId])
  assert.equal(reloaded.stored.status, "success")
  assert.equal(reloaded.stored.acknowledged, false)
})

test("signed transaction bytes are hashed and persisted before an ambiguous execute transport error", async () => {
  const options = operation()
  const remote = rpc()
  let signedBytes!: Uint8Array
  let signature!: string
  const calls = await wallet("sign", async ({ transaction }) => {
    signedBytes = await transaction!.build()
    const signed = await keypair.signTransaction(signedBytes)
    signature = signed.signature
    return signed
  })
  remote.handlers.execute = async input => {
    assert.deepEqual(input.transaction, signedBytes)
    assert.deepEqual(input.signatures, [signature])
    assert.deepEqual(input.include, { effects: true, transaction: true })
    const stored = persisted(getPendingTransaction(intent(options))!)
    assert.equal(stored.digest, TransactionDataBuilder.getDigestFromBytes(input.transaction))
    assert.equal(stored.status, "pending")
    const raw = JSON.stringify(stored)
    for (const key of ["signature", "bytes", "privateKey", "secretKey"]) assert.equal(Object.hasOwn(stored, key), false)
    assert.equal(raw.includes(signature), false)
    assert.equal(raw.includes(Buffer.from(signedBytes).toString("base64")), false)
    throw new Error("Server accepted bytes but transport disconnected")
  }
  const first = await receiptError(signAndExecuteWithWallet(offlineTransaction(), options, remote))
  assert.equal(first.digest, TransactionDataBuilder.getDigestFromBytes(signedBytes))
  assert.equal(first.status, "pending")
  assert.equal(first.receipt.error, "Server accepted bytes but transport disconnected")
  assert.equal(persisted(first.receipt).digest, first.digest)
  assert.equal(remote.executes.length, 1)
  assert.equal(remote.waits.length, 0)
  await receiptError(signAndExecuteWithWallet(offlineTransaction(), options, remote))
  assert.equal(calls.length, 1)
  assert.equal(remote.executes.length, 1)
  remote.handlers.wait = async () => result(first.digest!)
  await resumePendingTransaction(first.receipt, remote)
  assert.deepEqual(remote.waits.map(input => input.digest), [first.digest])
  assert.equal(calls.length, 1)
  assert.equal(remote.executes.length, 1)
})

test("only a matching onchain failure releases the intent; query errors and mismatched or incomplete responses keep it locked", async () => {
  const options = operation()
  const remote = rpc()
  const digest = "confirmed-failure-digest"
  const calls = await wallet("modern", async () => ({ digest }))
  const first = await receiptError(signAndExecuteWithWallet(offlineTransaction(), options, remote))
  const incomplete = result(digest)
  Reflect.deleteProperty(incomplete.Transaction!, "effects")
  for (const response of [failedResult("unrelated-digest"), failedResult(digest, otherAddress), incomplete]) {
    remote.handlers.wait = async () => response
    const error = await receiptError(resumePendingTransaction(first.receipt, remote))
    assert.equal(error.status, "pending")
    assert.equal(getPendingTransaction(intent(options))?.digest, digest)
    await receiptError(signAndExecuteWithWallet(offlineTransaction(), options, remote))
    assert.equal(calls.length, 1)
  }
  remote.handlers.wait = async () => failedResult(digest)
  const failure = await receiptError(resumePendingTransaction(first.receipt, remote))
  assert.equal(failure.status, "failed")
  assert.match(failure.message, /MoveAbort/)
  assert.equal(persisted(failure.receipt).status, "failed")
  assert.equal(getPendingTransaction(intent(options)), undefined)
  remote.handlers.wait = async () => { throw new Error("New transaction confirmation timed out") }
  const retry = await receiptError(signAndExecuteWithWallet(offlineTransaction(), options, remote))
  assert.notEqual(retry.receipt.id, first.receipt.id)
  assert.equal(calls.length, 2)
  assert.equal(remote.executes.length, 0)
})

test("wallet execution rejection before submission unlocks; transport ambiguity without a digest cannot be resumed or resubmitted", async () => {
  const options = operation()
  const remote = rpc()
  let reject = true
  const calls = await wallet("modern", async () => {
    if (reject) throw Object.assign(new Error("User rejected"), { code: 4001 })
    throw new Error("Wallet transport disconnected after possible broadcast")
  })
  await assert.rejects(signAndExecuteWithWallet(offlineTransaction(), options, remote), /用户已拒绝钱包签名/)
  assert.equal(getPendingTransaction(intent(options)), undefined)
  reject = false
  const ambiguous = await receiptError(signAndExecuteWithWallet(offlineTransaction(), options, remote))
  assert.equal(ambiguous.digest, undefined)
  assert.equal(persisted(ambiguous.receipt).status, "pending")
  await receiptError(resumePendingTransaction(ambiguous.receipt, remote))
  await receiptError(signAndExecuteWithWallet(offlineTransaction(), options, remote))
  assert.equal(calls.length, 2)
  assert.equal(remote.waits.length, 0)
  assert.equal(remote.executes.length, 0)
})

test("wallet rejection by code, message or nested cause safely discards unsubmitted transaction", async () => {
  for (const err of [
    Object.assign(new Error("Rejected"), { code: 4001 }),
    Object.assign(new Error("Rejected"), { code: "USER_REJECTED" }),
    new Error("User rejected the request"),
    new Error("Transaction rejected by user"),
    { cause: { code: 4001 } },
  ]) {
    const options = operation()
    const remote = rpc()
    await wallet("modern", async () => { throw err })
    await assert.rejects(signAndExecuteWithWallet(offlineTransaction(), options, remote), /用户已拒绝钱包签名/)
    assert.equal(getPendingTransaction(intent(options)), undefined)
  }
})

test("web locks serialize one intent across contexts while other intents proceed", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator")
  const held = new Set<string>()
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { locks: { request: (name: string, options: { ifAvailable?: boolean }, callback: (lock: unknown) => Promise<unknown>) => {
    if (held.has(name)) {
      // ifAvailable + already held: the callback receives null and must fail fast.
      if (options.ifAvailable) return Promise.resolve(callback(null))
      throw new Error("unexpected blocking mode")
    }
    held.add(name)
    return Promise.resolve(callback({ name })).finally(() => held.delete(name))
  } } } })
  try {
    const options = operation()
    const remote = rpc()
    const gate = deferred<void>()
    let walletCalls = 0
    // Sign-only path: the pending receipt is written only after the wallet
    // returns, so the second caller below races in the exact window the Web
    // Lock exists to close.
    await wallet("sign", async ({ transaction }) => {
      walletCalls++
      await gate.promise
      const bytes = await transaction!.build()
      return keypair.signTransaction(bytes)
    })
    remote.handlers.execute = async () => { throw new Error("Execute transport disconnected") }
    const first = signAndExecuteWithWallet(offlineTransaction(), options, remote).catch(error => error)
    // Let the first caller reach the wallet before the second tries the same intent.
    await new Promise(resolve => setImmediate(resolve))
    await assert.rejects(signAndExecuteWithWallet(offlineTransaction(), options, remote), /请勿重复点击/)
    gate.resolve()
    const outcome = await first
    assert.ok(outcome instanceof TransactionReceiptError, "first caller ends in its own ambiguous-transport state")
    assert.equal(walletCalls, 1, "the wallet is prompted exactly once")
    // A different intent is a different lock and is not blocked.
    const otherOptions = operation()
    await wallet("modern", async () => ({ digest: "other-intent-digest" }))
    const otherRemote = rpc()
    await signAndExecuteWithWallet(offlineTransaction(), otherOptions, otherRemote).catch(error => error instanceof TransactionReceiptError ? undefined : Promise.reject(error))
    assert.equal(held.size, 0, "all named locks must be released")
  } finally {
    if (original) Object.defineProperty(globalThis, "navigator", original)
    else Reflect.deleteProperty(globalThis, "navigator")
  }
})

test("submission binds address, provider, sender and expected identity before invoking any wallet", async () => {
  const options = operation()
  const remote = rpc()
  const wrongProvider = await wallet("modern", async () => assert.fail("Wrong provider must never sign"), "Other Wallet")
  const wrongAccount = await wallet("modern", async () => assert.fail("Wrong account must never sign"), selected.provider, otherAddress)
  await assert.rejects(signAndExecuteWithWallet(offlineTransaction(), options, remote), /找不到当前 Sui testnet 账户/)
  const chosen = await wallet("modern", async () => ({ digest: "bound-identity-digest" }))
  await assert.rejects(signAndExecuteWithWallet(offlineTransaction(), { ...options, expectedAccount: { ...selected, provider: "Other Wallet" } }, remote), /账户或钱包提供方已切换/)
  await assert.rejects(signAndExecuteWithWallet(offlineTransaction(), { ...options, expectedAccount: { ...selected, address: otherAddress } }, remote), /账户或钱包提供方已切换/)
  const wrongSender = offlineTransaction()
  wrongSender.setSender(otherAddress)
  await assert.rejects(signAndExecuteWithWallet(wrongSender, options, remote), /交易发送方与当前登录账户不匹配/)
  assert.equal(getPendingTransaction(intent(options)), undefined)
  const receipt = await receiptError(signAndExecuteWithWallet(offlineTransaction(), options, remote))
  assert.deepEqual(receipt.receipt.account, selected)
  assert.equal(chosen.length, 1)
  assert.equal(wrongProvider.length, 0)
  assert.equal(wrongAccount.length, 0)
})

for (const switchTo of [{ ...selected, address: otherAddress }, { ...selected, provider: "Other Wallet" }]) {
  test(`identity switch while a wallet signs prevents execute (${switchTo.address === address ? "provider" : "account"})`, async () => {
    const options = operation()
    const remote = rpc()
    const calls = await wallet("sign", async ({ transaction }) => {
      const bytes = await transaction!.build()
      const signed = await keypair.signTransaction(bytes)
      activate(switchTo)
      return signed
    })
    await assert.rejects(signAndExecuteWithWallet(offlineTransaction(), options, remote), /账户或钱包提供方已切换/)
    assert.equal(calls.length, 1)
    assert.equal(remote.executes.length, 0)
    assert.equal(remote.waits.length, 0)
    assert.equal(getPendingTransaction(intent(options)), undefined)
  })
}

test("recovery remains bound to the original receipt after the active account and provider change", async () => {
  const options = operation()
  const remote = rpc()
  const calls = await wallet("modern", async () => ({ digest: "original-account-digest" }))
  const first = await receiptError(signAndExecuteWithWallet(offlineTransaction(), options, remote))
  activate({ ...selected, address: otherAddress, provider: "Other Wallet" })
  remote.handlers.wait = async () => result(first.digest!, otherAddress)
  const wrongSender = await receiptError(resumePendingTransaction(first.receipt, remote))
  assert.equal(wrongSender.status, "pending")
  remote.handlers.wait = async () => result(first.digest!)
  const recovered = await resumePendingTransaction(first.receipt, remote)
  assert.deepEqual(recovered.receipt.account, selected)
  assert.equal(recovered.receipt.id, first.receipt.id)
  assert.equal(calls.length, 1)
  assert.equal(remote.executes.length, 0)
  assert.deepEqual(remote.waits.map(input => input.digest), [first.digest, first.digest, first.digest])
})

for (const tamper of ["bytes", "signature"] as const) {
  test(`wallet ${tamper} cannot authorize a different transaction or account`, async () => {
    const options = operation()
    const remote = rpc()
    await wallet("sign", async ({ transaction }) => {
      if (tamper === "bytes") transaction!.setGasBudget(20_000)
      const bytes = await transaction!.build()
      return (tamper === "signature" ? Ed25519Keypair.generate() : keypair).signTransaction(bytes)
    })
    await assert.rejects(signAndExecuteWithWallet(offlineTransaction(), options, remote), tamper === "bytes" ? /钱包更改了待签交易/ : /signature|address/i)
    assert.equal(getPendingTransaction(intent(options)), undefined)
    assert.equal(remote.executes.length, 0)
    assert.equal(remote.waits.length, 0)
  })
}

test("concurrent signing of one intent is blocked even if public metadata changes", async () => {
  const options = operation()
  const remote = rpc()
  const entered = deferred<void>()
  const release = deferred<void>()
  const calls = await wallet("sign", async ({ transaction }) => {
    entered.resolve()
    await release.promise
    return keypair.signTransaction(await transaction!.build())
  })
  const first = signAndExecuteWithWallet(offlineTransaction(), options, remote)
  await entered.promise
  // Resolve both signing prompts even if the lock regresses, so a failing test cannot hang.
  const second = signAndExecuteWithWallet(offlineTransaction(), { ...options, metadata: { name: "Renamed while signing" } }, remote)
  release.resolve()
  const outcomes = await Promise.allSettled([first, second])
  assert.equal(outcomes[0].status, "rejected")
  assert.equal(outcomes[1].status, "rejected")
  if (outcomes[1].status === "rejected") assert.match(outcomes[1].reason.message, /正在等待签名/)
  assert.equal(calls.length, 1)
  assert.equal(remote.executes.length, 1)
  assert.equal(getTransactionReceipt(getPendingTransaction(intent(options))!).status, "pending")
})

// The passkey path rebuilds the SIP-9 signer from browser storage and must
// verify the assertion locally before any bytes reach the network.
function passkeyFixture() {
  const { p256 } = require("@noble/curves/nist.js") as typeof import("@noble/curves/nist.js")
  const { sha256 } = require("@noble/hashes/sha2.js") as typeof import("@noble/hashes/sha2.js")
  const { toBase64 } = require("@mysten/sui/utils") as typeof import("@mysten/sui/utils")
  const secret = p256.utils.randomSecretKey()
  const publicKey = p256.getPublicKey(secret, true)
  const credentialId = crypto.getRandomValues(new Uint8Array(16))
  const origin = "https://example.test"
  return {
    secret, publicKey, credentialId,
    assertion(challenge: Uint8Array) {
      const clientDataJSON = new TextEncoder().encode(JSON.stringify({
        type: "webauthn.get", challenge: toBase64(challenge).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""), origin, crossOrigin: false,
      }))
      const authenticatorData = new Uint8Array(37)
      authenticatorData.set(sha256(new TextEncoder().encode(origin)), 0)
      authenticatorData[32] = 0x05
      const signature = p256.sign(new Uint8Array([...authenticatorData, ...sha256(clientDataJSON)]), secret, { format: "der" })
      return { rawId: credentialId, response: { authenticatorData: authenticatorData.buffer, clientDataJSON: clientDataJSON.buffer, signature: signature.buffer } } as unknown as PublicKeyCredential
    },
  }
}

test("passkey signing rebuilds the stored key, verifies locally, and submits exactly those bytes", async () => {
  const fixture = passkeyFixture()
  const { PasskeyPublicKey } = await import("@mysten/sui/keypairs/passkey")
  const { PASSKEY_STORE_KEY } = await import("./passkey")
  const passkeyAddress = new PasskeyPublicKey(fixture.publicKey).toSuiAddress()
  const passkeyAccount = { address: passkeyAddress, type: "passkey", provider: "本机 Passkey" }
  activate(passkeyAccount)
  localStorage.setItem(PASSKEY_STORE_KEY, JSON.stringify([{
    credentialIdBase64: Buffer.from(fixture.credentialId).toString("base64"),
    publicKeyBase64: Buffer.from(fixture.publicKey).toString("base64"),
    suiAddress: passkeyAddress, identifier: "fixture", createdAt: 1,
  }]))

  Object.defineProperty(globalThis, "navigator", { configurable: true, value: {
    credentials: { get: async ({ publicKey }: { publicKey: { challenge: Uint8Array } }) => fixture.assertion(new Uint8Array(publicKey.challenge)) },
  } })
  const remote = rpc()
  let executed: ExecuteInput | undefined
  let passkeyDigest = ""
  remote.handlers.execute = async input => {
    executed = input
    passkeyDigest = TransactionDataBuilder.getDigestFromBytes(input.transaction)
    return result(passkeyDigest, passkeyAddress)
  }
  const options: WalletTransactionOptions = { action: "passkey-transfer", scope: "passkey-regression", expectedAccount: passkeyAccount }
  const outcome = await signAndExecuteWithWallet(offlineTransaction(), options, remote)
  assert.equal(outcome.digest, passkeyDigest)
  assert.ok(executed)
  assert.equal(executed.signatures.length, 1)
  assert.equal(executed.signatures[0][0], "B") // Passkey scheme flag 6 -> base64 starts with 'B'.
  const { verifyTransactionSignature } = await import("@mysten/sui/verify")
  await verifyTransactionSignature(executed.transaction, executed.signatures[0], { address: passkeyAddress })
  assert.equal(executed.transaction.length > 0, true)
})

test("a passkey signature from a different key is rejected before execute", async () => {
  const stored = passkeyFixture()
  const other = passkeyFixture()
  const { PasskeyPublicKey } = await import("@mysten/sui/keypairs/passkey")
  const { PASSKEY_STORE_KEY } = await import("./passkey")
  const passkeyAddress = new PasskeyPublicKey(stored.publicKey).toSuiAddress()
  const passkeyAccount = { address: passkeyAddress, type: "passkey" }
  activate(passkeyAccount)
  localStorage.setItem(PASSKEY_STORE_KEY, JSON.stringify([{
    credentialIdBase64: Buffer.from(stored.credentialId).toString("base64"),
    publicKeyBase64: Buffer.from(stored.publicKey).toString("base64"),
    suiAddress: passkeyAddress, identifier: "fixture", createdAt: 1,
  }]))
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: {
    credentials: { get: async ({ publicKey }: { publicKey: { challenge: Uint8Array } }) => other.assertion(new Uint8Array(publicKey.challenge)) },
  } })
  const remote = rpc()
  const options: WalletTransactionOptions = { action: "passkey-tamper", scope: "passkey-tamper", expectedAccount: passkeyAccount }
  await assert.rejects(signAndExecuteWithWallet(offlineTransaction(), options, remote), /Passkey 交易签名未通过本机验证/)
  assert.equal(remote.executes.length, 0)
})
