import { normalizeSuiAddress } from "@mysten/sui/utils"
import { t } from "./i18n/t"

export interface TransactionAccount { address: string; type?: string; provider?: string }
export interface TransactionIntent { account: TransactionAccount; action: string; scope: string; network?: "testnet"; metadata?: Record<string, string> }
export type ReceiptStatus = "pending" | "success" | "failed"
export interface PendingTransactionReceipt {
  version: 1
  id: string
  key: string
  account: TransactionAccount
  network: "testnet"
  action: string
  scope: string
  digest?: string
  status: ReceiptStatus
  createdObjects: string[]
  acknowledged: boolean
  persistent: boolean
  createdAt: number
  updatedAt: number
  error?: string
  metadata?: Record<string, string>
}

const PREFIX = "sui_pending_transaction_v1:"
const memory = new Map<string, PendingTransactionReceipt>()

export function transactionAccountKey(account: TransactionAccount | null | undefined): string {
  return account ? JSON.stringify([normalizeSuiAddress(account.address), account.type || "", account.provider || ""]) : ""
}
export function transactionIntentKey(intent: TransactionIntent): string {
  return PREFIX + encodeURIComponent(JSON.stringify([transactionAccountKey(intent.account), intent.network || "testnet", intent.action, intent.scope]))
}
export class TransactionReceiptError extends Error {
  readonly digest: string | undefined
  readonly status: ReceiptStatus
  constructor(message: string, readonly receipt: PendingTransactionReceipt, options?: ErrorOptions) {
    super(message, options)
    this.name = "TransactionReceiptError"
    this.digest = receipt.digest
    this.status = receipt.status
  }
}

function parseReceipt(raw: string, key: string): PendingTransactionReceipt {
  // The stored receipt is untrusted JSON from an earlier build: it is parsed as
  // `unknown` and every field is checked below before the value is accepted.
  let value: unknown
  try { value = JSON.parse(raw) } catch { throw new Error(t("vault.receiptUnparseable")) }
  if (!value || typeof value !== "object") throw new Error(t("vault.receiptInvalidFormat"))
  const receipt = value as Record<string, unknown>
  const account = receipt.account
  const accountRecord = account && typeof account === "object" && !Array.isArray(account) ? account as Record<string, unknown> : null
  const metadata = receipt.metadata
  if (receipt.version !== 1 || typeof receipt.id !== "string" || receipt.key !== key ||
    !accountRecord || typeof accountRecord.address !== "string" ||
    (accountRecord.type !== undefined && typeof accountRecord.type !== "string") ||
    (accountRecord.provider !== undefined && typeof accountRecord.provider !== "string") || receipt.network !== "testnet" ||
    typeof receipt.action !== "string" || typeof receipt.scope !== "string" ||
    typeof receipt.status !== "string" || !["pending", "success", "failed"].includes(receipt.status) ||
    !Array.isArray(receipt.createdObjects) || receipt.createdObjects.some((id: unknown) => typeof id !== "string") ||
    typeof receipt.acknowledged !== "boolean" ||
    typeof receipt.createdAt !== "number" || typeof receipt.updatedAt !== "number" ||
    (receipt.digest !== undefined && typeof receipt.digest !== "string") ||
    (receipt.error !== undefined && typeof receipt.error !== "string") ||
    (metadata !== undefined && (!metadata || typeof metadata !== "object" || Array.isArray(metadata) ||
      Object.values(metadata as Record<string, unknown>).some((entry: unknown) => typeof entry !== "string")))) {
    throw new Error(t("vault.receiptUnknownFormat"))
  }
  // `persistent` is a local cache flag, not an identity field: a receipt written
  // before this build has no such key, and rejecting it would strand a real
  // unconfirmed transaction. It is normalised from presence, not validated.
  const checked = { ...receipt, persistent: typeof receipt.persistent === "boolean" ? receipt.persistent : true } as unknown as PendingTransactionReceipt
  try { if (transactionIntentKey(checked) !== key) throw new Error() } catch { throw new Error(t("vault.receiptInvalidIdentity")) }
  return checked
}

function readKey(key: string): PendingTransactionReceipt | undefined {
  let raw: string | null = null
  try { raw = localStorage.getItem(key) } catch { return memory.get(key) }
  const cached = memory.get(key)
  let stored: PendingTransactionReceipt | undefined
  try { stored = raw === null ? undefined : parseReceipt(raw, key) }
  catch (error) {
    if (cached) { cached.persistent = false; return cached }
    throw error
  }
  const receipt = cached && (!stored || cached.updatedAt > stored.updatedAt) ? cached : stored
  if (receipt) memory.set(key, receipt)
  return receipt
}
function writeReceipt(receipt: PendingTransactionReceipt): PendingTransactionReceipt {
  const next = { ...receipt, persistent: true, updatedAt: Math.max(Date.now(), receipt.updatedAt + 1) }
  // Put known digests in memory before any storage operation can fail.
  memory.set(next.key, next)
  try {
    // Never replace unknown/corrupt browser records with a convenient empty state.
    const raw = localStorage.getItem(next.key)
    if (raw !== null) parseReceipt(raw, next.key)
    localStorage.setItem(next.key, JSON.stringify(next))
  } catch { next.persistent = false }
  return next
}

export function getPendingTransaction(intent: TransactionIntent): PendingTransactionReceipt | undefined {
  const receipt = readKey(transactionIntentKey(intent))
  return receipt && (receipt.status === "pending" || (receipt.status === "success" && !receipt.acknowledged)) ? receipt : undefined
}
export function createPendingTransaction(intent: TransactionIntent, digest?: string): PendingTransactionReceipt {
  const existing = getPendingTransaction(intent)
  if (existing) throw new TransactionReceiptError(t("vault.receiptExistsPending"), existing)
  const now = Date.now()
  return writeReceipt({ version: 1, id: crypto.randomUUID(), key: transactionIntentKey(intent), account: { ...intent.account, address: normalizeSuiAddress(intent.account.address) },
    action: intent.action, scope: intent.scope, metadata: intent.metadata, network: intent.network || "testnet", digest, status: "pending", createdObjects: [], acknowledged: false, persistent: false, createdAt: now, updatedAt: now })
}
export function listTransactionReceipts(): PendingTransactionReceipt[] {
  const keys = new Set(memory.keys())
  try { for (let i = 0; i < localStorage.length; i++) { const key = localStorage.key(i); if (key?.startsWith(PREFIX)) keys.add(key) } } catch { /* Memory remains available if browser storage is blocked. */ }
  return [...keys].flatMap(key => { try { const receipt = readKey(key); return receipt ? [receipt] : [] } catch { return [] } })
}
export function getTransactionReceipt(receiptOrId: PendingTransactionReceipt | string): PendingTransactionReceipt {
  const receipt = typeof receiptOrId === "string" ? listTransactionReceipts().find(row => row.id === receiptOrId) : readKey(receiptOrId.key)
  if (!receipt || (typeof receiptOrId !== "string" && receipt.id !== receiptOrId.id)) throw new Error(t("vault.receiptNotFound"))
  return receipt
}
export function updatePendingTransaction(receipt: PendingTransactionReceipt, patch: Partial<Pick<PendingTransactionReceipt, "digest" | "status" | "createdObjects" | "error" | "acknowledged">>): PendingTransactionReceipt {
  const current = getTransactionReceipt(receipt)
  if (current.digest && patch.digest && current.digest !== patch.digest) throw new TransactionReceiptError(t("vault.receiptDigestMismatch"), current)
  return writeReceipt({ ...current, ...patch })
}
/** Release only after the caller has recovered the confirmed objects/attachment. */
export function acknowledgePendingTransaction(receiptOrId: PendingTransactionReceipt | string): void {
  const receipt = getTransactionReceipt(receiptOrId)
  if (receipt.status !== "success") throw new TransactionReceiptError(t("vault.receiptNotConfirmed"), receipt)
  updatePendingTransaction(receipt, { acknowledged: true })
}
/** Only for a proven wallet rejection before submission, never an RPC/transport error. */
export function discardUnsubmittedTransaction(receipt: PendingTransactionReceipt): void {
  const current = getTransactionReceipt(receipt)
  if (current.digest || current.status !== "pending") throw new TransactionReceiptError(t("vault.receiptKnownDigestMustConfirm"), current)
  memory.delete(current.key)
  try { localStorage.removeItem(current.key) } catch { /* Nothing was submitted. */ }
}
