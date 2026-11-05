"use client"

import { Transaction, TransactionDataBuilder } from "@mysten/sui/transactions"
import { SuiGrpcClient } from "@mysten/sui/grpc"
import type { SuiClientTypes } from "@mysten/sui/client"
import { normalizeSuiAddress } from "@mysten/sui/utils"
import { clearLegacyDevKeys } from "./dev-keystore"
import { getZkLoginSigner } from "./zklogin"
import { supportsSuiWallet, type RegisteredWallet, type WalletAccount } from "./wallet-discovery"
import { acknowledgePendingTransaction, createPendingTransaction, discardUnsubmittedTransaction, getPendingTransaction, getTransactionReceipt, transactionAccountKey, transactionIntentKey, TransactionReceiptError, updatePendingTransaction, type PendingTransactionReceipt, type TransactionAccount, type TransactionIntent } from "./pending-transactions"

import { PROPOSAL_PACKAGE_ID } from "./proposal-chain"
import { t } from "./i18n/t"

// Call target: the newest published package object. A compatible upgrade mints a
// new package id and leaves the old one resolving only its original functions, so
// this must track the latest publication (v7 at the time of writing).
export const TESTNET_PACKAGE_ID = PROPOSAL_PACKAGE_ID

interface ActiveAccount { type: string; address: string; provider?: string }

function activeAccount(): ActiveAccount {
  let account: ActiveAccount | null = null
  try { account = JSON.parse(localStorage.getItem("sui_active_account") ?? "null") } catch {}
  if (!account?.address || !/^0x[0-9a-fA-F]{64}$/.test(account.address)) throw new Error(t("misc.signer.connectFirst"))
  return { ...account, address: normalizeSuiAddress(account.address) }
}

export function getTransactionAccount(): ActiveAccount {
  return activeAccount()
}
export function assertTransactionAccount(expected: TransactionAccount) {
  if (transactionAccountKey(activeAccount()) !== transactionAccountKey(expected)) throw new Error(t("misc.signer.accountSwitched"))
}
function assertStillActive(expected: ActiveAccount) { assertTransactionAccount(expected) }

export function bindTransactionSender(tx: Transaction, address: string) {
  const sender = tx.getData().sender
  if (sender && normalizeSuiAddress(sender) !== normalizeSuiAddress(address)) throw new Error(t("misc.signer.senderMismatch"))
  tx.setSender(address)
}

export function successfulTransaction(result: SuiClientTypes.TransactionResult<{ effects: true; transaction: true }>, expectedAddress: string) {
  if (result.$kind === "FailedTransaction") throw new Error(t("misc.signer.execFailed", { reason: result.FailedTransaction.status.error?.message ?? t("misc.signer.unknownError") }))
  const transaction = result.Transaction
  if (!transaction.status.success || !transaction.effects?.status.success) throw new Error(t("misc.signer.execUnconfirmed"))
  if (!transaction.transaction?.sender || normalizeSuiAddress(transaction.transaction.sender) !== normalizeSuiAddress(expectedAddress)) throw new Error(t("misc.signer.onchainSenderMismatch"))
  if (!transaction.digest) throw new Error(t("misc.signer.noDigest"))
  return {
    digest: transaction.digest,
    createdObjects: transaction.effects.changedObjects.filter((object) => object.idOperation === "Created").map((object) => object.objectId),
  }
}

/**
 * Finds the registered wallet that can sign for the active account.
 *
 * Typed against `RegisteredWallet` rather than `any`: this is the one place that
 * decides which wallet is asked to sign, so a wallet missing the account or the
 * feature must fail a check here, not at the first method call. The SDK's own
 * `getWallets().get()` returns objects that structurally satisfy this type;
 * `RegisteredWallet` names only the fields read below.
 */
export function findMatchingWallet(wallets: readonly RegisteredWallet[], expected: ActiveAccount): { wallet: RegisteredWallet; account: WalletAccount } | undefined {
  for (const wallet of wallets) {
    if (!supportsSuiWallet(wallet)) continue
    if (expected.provider && wallet.name !== expected.provider) continue
    const account = wallet.accounts?.find((candidate) => {
      try {
        return candidate.address && normalizeSuiAddress(candidate.address) === expected.address && candidate.chains?.includes("sui:testnet")
      } catch { return false }
    })
    if (account && (wallet.features?.["sui:signTransaction"] || wallet.features?.["sui:signAndExecuteTransaction"] || wallet.features?.["sui:signAndExecuteTransactionBlock"])) return { wallet, account }
  }
}

export function isWalletRejection(cause: unknown): boolean {
  if (!cause) return false
  if (typeof cause === "object") {
    const error = cause as Record<string, unknown>
    if (error.code === 4001 || error.code === "USER_REJECTED") return true
    if (error.cause && isWalletRejection(error.cause)) return true
    if (typeof error.message === "string" && /rejected by user|user rejected|rejected the request|user denied|cancelled by user/i.test(error.message)) return true
  }
  return false
}

const include = { effects: true, transaction: true } as const
// One shared client instead of a fresh gRPC connection per execution; tests
// inject their own via `dependencies.client`.
const sharedTransactionClient = new SuiGrpcClient({ network: "testnet", baseUrl: "https://fullnode.testnet.sui.io:443" })
const transactionClient = () => sharedTransactionClient
export interface WalletTransactionResult { digest: string; createdObjects: string[]; receipt: PendingTransactionReceipt }
export interface WalletTransactionOptions { action: string; scope: string; expectedAccount?: TransactionAccount; metadata?: Record<string, string> }
/** Allows an offline client without replacing wallet discovery or signature verification. */
export interface WalletTransactionDependencies { client?: SuiGrpcClient }
const signing = new Set<string>()

/**
 * Serializes one signing intent across every tab. Web Locks is the primary
 * guard; the in-tab Set remains the fallback for non-secure contexts and test
 * environments without `navigator.locks`. A second caller — same tab or another
 * tab — fails fast instead of prompting the wallet twice.
 */
async function withSigningLock<T>(lock: string, task: () => Promise<T>): Promise<T> {
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks
  if (!locks) {
    if (signing.has(lock)) throw new Error(t("misc.signer.signingLocked"))
    signing.add(lock)
    try { return await task() } finally { signing.delete(lock) }
  }
  return locks.request(`sui-signing:${lock}`, { ifAvailable: true }, async held => {
    if (!held) throw new Error(t("misc.signer.signingLocked"))
    return task()
  })
}

function recordResult(result: SuiClientTypes.TransactionResult<typeof include>, receipt: PendingTransactionReceipt): WalletTransactionResult {
  const transaction = result.$kind === "FailedTransaction" ? result.FailedTransaction : result.Transaction
  try {
    if (!transaction.digest || (receipt.digest && transaction.digest !== receipt.digest)) throw new Error(t("misc.signer.receiptMismatch"))
    if (!transaction.transaction?.sender || normalizeSuiAddress(transaction.transaction.sender) !== normalizeSuiAddress(receipt.account.address)) throw new Error(t("misc.signer.receiptSenderMismatch"))
  } catch (cause) { throw new TransactionReceiptError(cause instanceof Error ? cause.message : t("misc.signer.receiptUnverifiable"), receipt, { cause }) }
  if (result.$kind === "FailedTransaction" || transaction.status.success === false || transaction.effects?.status.success === false) {
    const error = t("misc.signer.execConfirmedFailed", { reason: transaction.status.error?.message ?? transaction.effects?.status.error?.message ?? t("misc.signer.unknownError") })
    const failed = updatePendingTransaction(receipt, { digest: transaction.digest, status: "failed", error })
    throw new TransactionReceiptError(error, failed)
  }
  let verified: ReturnType<typeof successfulTransaction>
  try { verified = successfulTransaction(result, receipt.account.address) }
  catch (cause) { throw new TransactionReceiptError(cause instanceof Error ? cause.message : t("misc.signer.resultUnverifiable"), receipt, { cause }) }
  const confirmed = updatePendingTransaction(receipt, { ...verified, status: "success", error: undefined })
  return { ...verified, receipt: confirmed }
}
function uncertain(receipt: PendingTransactionReceipt, cause: unknown): TransactionReceiptError {
  const updated = updatePendingTransaction(receipt, { error: cause instanceof Error ? cause.message : t("misc.signer.networkNoResult") })
  return new TransactionReceiptError(t(updated.digest ? "misc.signer.uncertainWithDigest" : "misc.signer.uncertainNoDigest", { digest: updated.digest ?? "", storageNote: updated.persistent ? "" : t("misc.signer.storageWarning") }), updated, { cause })
}

/** Query the original digest only. This function never signs or submits a transaction. */
export async function resumePendingTransaction(receiptOrId: PendingTransactionReceipt | string, dependencies: WalletTransactionDependencies = {}): Promise<WalletTransactionResult> {
  const receipt = getTransactionReceipt(receiptOrId)
  if (!receipt.digest) throw new TransactionReceiptError(t("misc.signer.noDigestYet"), receipt)
  try {
    return recordResult(await (dependencies.client ?? transactionClient()).waitForTransaction({ digest: receipt.digest, include, timeout: 30_000 }), receipt)
  } catch (cause) { if (cause instanceof TransactionReceiptError) throw cause; throw uncertain(receipt, cause) }
}

async function executeSigned(client: SuiGrpcClient, bytes: Uint8Array, signature: string, intent: TransactionIntent): Promise<WalletTransactionResult> {
  // Installed SDK hashes complete TransactionData bytes; the exact submitted bytes are retained by digest before network I/O.
  const digest = TransactionDataBuilder.getDigestFromBytes(bytes)
  const receipt = createPendingTransaction(intent, digest)
  try {
    // A submission that never returns must not leave the page waiting forever.
    // Aborting here is *ambiguous* — the transaction may have landed — so it
    // routes to `uncertain()`, which keeps the digest and refuses to re-sign,
    // rather than to a "failed" verdict that would invite a duplicate send.
    return recordResult(await client.executeTransaction({ transaction: bytes, signatures: [signature], include, signal: AbortSignal.timeout(60_000) }), receipt)
  }
  catch (cause) { if (cause instanceof TransactionReceiptError) throw cause; throw uncertain(receipt, cause) }
}

/** Sign only with the selected identity. Receipt recovery never selects or invokes a signer. */
export async function signAndExecuteWithWallet(tx: Transaction, options?: WalletTransactionOptions, dependencies: WalletTransactionDependencies = {}): Promise<WalletTransactionResult> {
  const selected = activeAccount()
  clearLegacyDevKeys()
  if (selected.type === "keystore") throw new Error(t("misc.signer.keystoreDisabled"))
  if (options?.expectedAccount) assertTransactionAccount(options.expectedAccount)
  const intent: TransactionIntent = { account: selected, action: options?.action || "transaction", scope: options?.scope || JSON.stringify(tx.getData().commands), network: "testnet", metadata: options?.metadata }
  const existing = getPendingTransaction(intent)
  if (existing) throw new TransactionReceiptError(t("misc.signer.recoveryPending"), existing)
  const lock = transactionIntentKey(intent)
  return withSigningLock(lock, async () => {
  bindTransactionSender(tx, selected.address)
  const client = dependencies.client ?? transactionClient()
  const complete = (result: WalletTransactionResult) => {
    if (!options) acknowledgePendingTransaction(result.receipt)
    return result
  }

  // zkLogin must be resolved before stale local development keys or extension wallets.
  if (selected.type === "zklogin") {
    const { systemState } = await client.getCurrentSystemState({ signal: AbortSignal.timeout(15_000) })
    const signer = await getZkLoginSigner(selected.address, Number(systemState.epoch))
    if (signer.toSuiAddress() !== selected.address) throw new Error(t("misc.signer.zkMismatch"))
    const bytes = await tx.build({ client })
    assertStillActive(selected)
    const { signature } = await signer.signTransaction(bytes)
    assertStillActive(selected)
    return complete(await executeSigned(client, bytes, signature, intent))
  }

  // SIP-9 passkey: the browser holds the credential; the keypair is rebuilt from
  // the stored public key and the assertion is verified before submission.
  if (selected.type === "passkey") {
    const { getPasskeySigner } = await import("./passkey")
    const signer = await getPasskeySigner(selected.address)
    if (signer.toSuiAddress() !== selected.address) throw new Error(t("misc.signer.passkeyMismatch"))
    const bytes = await tx.build({ client })
    assertStillActive(selected)
    const { signature } = await signer.signTransaction(bytes)
    const { verifyTransactionSignature } = await import("@mysten/sui/verify")
    try { await verifyTransactionSignature(bytes, signature, { address: selected.address, client }) }
    catch (error) {
      // Fails closed, which is right, but it must not rewrite an unexpected
      // programming error as a definite signature verdict. The cause is kept
      // so a failure that is not about the signature can still be diagnosed.
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(t("misc.signer.passkeyVerifyFailed", { reason }), { cause: error })
    }
    assertStillActive(selected)
    return complete(await executeSigned(client, bytes, signature, intent))
  }

  if (selected.type !== "wallet") throw new Error(t("misc.signer.noSigningMethod"))
  const { getWallets } = await import("@mysten/wallet-standard")
  const matched = findMatchingWallet(getWallets().get(), selected)
  if (!matched) throw new Error(t("misc.signer.walletAccountMissing"))
  const { wallet, account } = matched
  assertStillActive(selected)
  const signFeature = wallet.features["sui:signTransaction"]
  // Sign bytes locally, then submit ourselves; check the wallet preserved sender and transaction.
  // `signFeature` alone is not enough: the SDK types its method as optional, so a
  // feature entry without a callable `signTransaction` must fall through to the
  // wallet-executed path instead of throwing at the call.
  if (typeof signFeature?.signTransaction === "function") {
    const signTransaction = signFeature.signTransaction.bind(signFeature)
    const bytes = await tx.build({ client })
    const signable = Transaction.from(bytes)
    assertStillActive(selected)
    let signed: { bytes: string; signature: string }
    try {
      signed = await signTransaction({ transaction: signable, account, chain: "sui:testnet" })
    } catch (cause) {
      if (isWalletRejection(cause)) throw new Error(t("misc.signer.rejected"), { cause })
      throw cause
    }
    const { fromBase64 } = await import("@mysten/sui/utils")
    const returnedBytes = fromBase64(signed.bytes)
    if (returnedBytes.length !== bytes.length || returnedBytes.some((value: number, index: number) => value !== bytes[index])) throw new Error(t("misc.signer.txAltered"))
    const { verifyTransactionSignature } = await import("@mysten/sui/verify")
    await verifyTransactionSignature(bytes, signed.signature, { address: selected.address, client })
    assertStillActive(selected)
    return complete(await executeSigned(client, bytes, signed.signature, intent))
  }

  const modern = wallet.features["sui:signAndExecuteTransaction"]
  const legacy = wallet.features["sui:signAndExecuteTransactionBlock"]
  // Each feature entry is optional *and* its method is optional in the SDK's
  // type, so both must be narrowed before use. Without these checks a wallet
  // that advertises an empty feature object reached a method call that crashed
  // after a pending-transaction lock had already been written.
  const executeModern = modern?.signAndExecuteTransaction ? modern.signAndExecuteTransaction.bind(modern) : undefined
  const executeLegacy = legacy?.signAndExecuteTransactionBlock ? legacy.signAndExecuteTransactionBlock.bind(legacy) : undefined
  if (!executeModern && !executeLegacy) throw new Error(t("misc.signer.noSignCapability"))
  // Wallet-executed transactions cannot provide exact signed bytes in advance.
  // Persist a lock before invoking them, then persist their digest before any RPC confirmation read.
  let receipt = createPendingTransaction(intent)
  let result: { digest?: string }
  try {
    result = executeModern
      ? await executeModern({ transaction: tx, account, chain: "sui:testnet" })
      : await executeLegacy!({ transactionBlock: tx, account, chain: "sui:testnet", options: { showEffects: true } })
  } catch (cause) {
    if (isWalletRejection(cause)) {
      discardUnsubmittedTransaction(receipt)
      throw new Error(t("misc.signer.rejected"), { cause })
    }
    throw uncertain(receipt, cause)
  }
  if (!result?.digest) throw uncertain(receipt, new Error(t("misc.signer.noDigestReturned")))
  receipt = updatePendingTransaction(receipt, { digest: result.digest })
  return complete(await resumePendingTransaction(receipt, { client }))
  })
}
