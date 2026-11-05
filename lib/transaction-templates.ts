import { Transaction } from "@mysten/sui/transactions"
import { isValidSuiAddress, normalizeSuiAddress } from "@mysten/sui/utils"
import { type TransactionTemplate } from "./local-records"
import { buildDirectCoinPayment, buildDirectBatchPayment, directPaymentUnits, type BatchRecipientTransfer } from "./direct-payments"
import { t } from "./i18n/t"
import type { WalletAsset } from "./wallet-data"

export interface BatchItem {
  recipient: string
  amount: string
  token?: string
}

export interface TemplateValidationResult {
  valid: boolean
  error?: string
  totalUnits?: bigint
  recipientCount?: number
}

/** Compute total amount across all batch items as a string decimal. */
export function calculateBatchTotal(items?: { amount: string }[]): string {
  if (!items || items.length === 0) return "0"
  let total = 0
  for (const item of items) {
    const val = Number(item.amount)
    if (Number.isFinite(val) && val > 0) total += val
  }
  return total.toString()
}

/** Check if template has valid batch configuration. */
export function validateBatchTemplate(template: TransactionTemplate, asset?: WalletAsset): TemplateValidationResult {
  if (template.type !== "batch") {
    return { valid: false, error: t("vault.notBatchType") }
  }
  const items = template.batchItems
  if (!Array.isArray(items) || items.length === 0) {
    return { valid: false, error: t("vault.batchNeedsItems") }
  }

  let totalUnits = 0n
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (!item.recipient || !isValidSuiAddress(item.recipient.trim()) || BigInt(item.recipient.trim()) === 0n) {
      return { valid: false, error: t("vault.batchInvalidRecipient", { index: i + 1, recipient: item.recipient }) }
    }
    const amountNum = Number(item.amount)
    if (!Number.isFinite(amountNum) || amountNum <= 0) {
      return { valid: false, error: t("vault.batchInvalidAmount", { index: i + 1, amount: item.amount }) }
    }
    if (asset) {
      try {
        const u = directPaymentUnits(item.amount, asset)
        totalUnits += u
      } catch (err) {
        return { valid: false, error: t("vault.batchAmountPrecision", { index: i + 1, error: err instanceof Error ? err.message : String(err) }) }
      }
    }
  }

  if (asset && totalUnits > asset.rawBalance) {
    return { valid: false, error: t("vault.batchInsufficientBalance"), totalUnits, recipientCount: items.length }
  }

  return { valid: true, totalUnits, recipientCount: items.length }
}

/** Build executable PTB from a validated template (transfer or batch). */
export function buildPTBFromTemplate(
  sender: string,
  template: TransactionTemplate,
  asset: WalletAsset
): Transaction {
  if (!isValidSuiAddress(sender) || BigInt(sender) === 0n) {
    throw new Error(t("vault.invalidSender"))
  }

  if (template.type === "transfer") {
    if (!template.recipient || !template.amount) {
      throw new Error(t("vault.transferMissingFields"))
    }
    const units = directPaymentUnits(template.amount, asset)
    return buildDirectCoinPayment(sender, template.recipient.trim(), asset.coinType, units)
  }

  if (template.type === "batch") {
    const validation = validateBatchTemplate(template, asset)
    if (!validation.valid) {
      throw new Error(validation.error || t("vault.batchValidationFailed"))
    }
    const items = template.batchItems!
    const transfers: BatchRecipientTransfer[] = items.map(item => ({
      recipient: normalizeSuiAddress(item.recipient.trim()),
      units: directPaymentUnits(item.amount, asset),
    }))
    return buildDirectBatchPayment(sender, asset.coinType, transfers)
  }

  throw new Error(t("vault.unsupportedTemplateType", { type: template.type }))
}
