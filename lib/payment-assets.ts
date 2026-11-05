// Canonical payment assets and Sui payment-request links.
//
// Links follow the Sui Payment Kit URI (`sui:pay?receiver=…&amount=…&coinType=…`),
// where the amount is expressed in the coin's base units. Legacy links written
// by earlier builds (`sui:<address>?amount=<display>&coin=<SYMBOL>`) are still
// parsed so saved drafts never stop resolving; they are reported as legacy and
// their precision is only trusted when the symbol maps to a canonical asset.
import { normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils"
import { decimalProduct, decimalSum, formatDecimal, parseDecimalValue, toCoinUnits, type DecimalValue } from "./coin-amount"
import { t } from "./i18n/t"

export interface PaymentAsset {
  symbol: string
  coinType: string
  decimals: number
  /** Where the coin identity came from. `unavailable` means no type is configured. */
  source: "canonical" | "configured" | "unavailable"
}

export const SUI_COIN_TYPE = normalizeStructTag("0x2::sui::SUI")
export const USDC_TESTNET_COIN_TYPE = normalizeStructTag("0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC")

// Tether does not publish a canonical Sui testnet USDT type, so it is only
// offered when an operator configures the exact type they intend to accept.
export const USDT_COIN_TYPE = (process.env.NEXT_PUBLIC_USDT_COIN_TYPE || "").trim()

export function canonicalPaymentAssets(): PaymentAsset[] {
  return [
    { symbol: "SUI", coinType: SUI_COIN_TYPE, decimals: 9, source: "canonical" },
    { symbol: "USDC", coinType: USDC_TESTNET_COIN_TYPE, decimals: 6, source: "canonical" },
    {
      symbol: "USDT",
      coinType: USDT_COIN_TYPE ? normalizeStructTag(USDT_COIN_TYPE) : "",
      decimals: USDT_COIN_TYPE ? 6 : 0,
      source: USDT_COIN_TYPE ? "configured" : "unavailable",
    },
  ]
}

export function paymentAssetBySymbol(symbol: string): PaymentAsset | undefined {
  return canonicalPaymentAssets().find(asset => asset.symbol === symbol.toUpperCase())
}

export function paymentAssetByCoinType(coinType: string): PaymentAsset | undefined {
  return canonicalPaymentAssets().find(asset => asset.coinType && asset.symbol && coinType && asset.coinType === normalizeStructTag(coinType))
}

export function paymentAssetLabel(asset: PaymentAsset): string {
  return asset.source === "unavailable" ? t("payments.assetUnconfigured", { symbol: asset.symbol }) : asset.symbol
}

export interface PaymentLinkInput {
  address: string
  total: DecimalValue
  asset: PaymentAsset
  nonce: string
  label?: string
  message?: string
}

/**
 * Build a Payment Kit URI with base-unit amounts. Throws instead of writing a
 * link whose precision the coin cannot represent.
 */
export function buildPaymentLink(input: PaymentLinkInput): string {
  if (!input.asset.coinType) throw new Error(t("payments.errAssetNotConfigured", { symbol: input.asset.symbol }))
  if (!normalizeSuiAddress(input.address)) throw new Error(t("payments.errInvalidRecipientAddress"))
  const units = toCoinUnits(input.total, input.asset.decimals)
  if (units <= 0n) throw new Error(t("payments.errAmountMustBePositive"))
  const nonce = input.nonce.trim()
  if (!nonce || nonce.length > 36 || !/^[A-Za-z0-9._~-]+$/.test(nonce)) throw new Error(t("payments.errInvalidNonce"))
  const params = new URLSearchParams()
  params.set("receiver", normalizeSuiAddress(input.address))
  params.set("amount", units.toString())
  params.set("coinType", input.asset.coinType)
  params.set("nonce", nonce)
  if (input.label?.trim()) params.set("label", input.label.trim())
  if (input.message?.trim()) params.set("message", input.message.trim())
  return `sui:pay?${params.toString()}`
}

export interface ParsedPaymentLink {
  address: string
  coinType: string | null
  symbol: string | null
  amountUnits: bigint | null
  amountDisplay: string | null
  nonce: string | null
  label: string | null
  message: string | null
  legacy: boolean
  /** `exact` when base units and coin type are known; `legacy-symbol` when only a symbol amount was stored. */
  precision: "exact" | "legacy-symbol" | "unknown"
}

/** Parse both current Payment Kit links and legacy `sui:<address>` drafts. */
export function parsePaymentLink(raw: string): ParsedPaymentLink | null {
  const value = raw.trim()
  const standard = /^sui:pay\?(.*)$/i.exec(value)
  if (standard) {
    const params = new URLSearchParams(standard[1])
    const receiver = params.get("receiver") || ""
    if (!receiver) return null
    const coinType = params.get("coinType")
    const units = params.get("amount")
    return {
      address: receiver,
      coinType: coinType ? normalizeStructTag(coinType) : null,
      symbol: coinType ? paymentAssetByCoinType(coinType)?.symbol ?? null : null,
      amountUnits: units && /^\d+$/.test(units) ? BigInt(units) : null,
      amountDisplay: null,
      nonce: params.get("nonce"),
      label: params.get("label"),
      message: params.get("message"),
      legacy: false,
      precision: coinType && units && /^\d+$/.test(units) ? "exact" : "unknown",
    }
  }

  const legacy = /^sui:([^?]+)(?:\?(.*))?$/i.exec(value)
  if (!legacy) return null
  const params = new URLSearchParams(legacy[2] || "")
  const symbol = params.get("coin")
  const amount = params.get("amount")
  return {
    address: decodeURIComponent(legacy[1]),
    coinType: null,
    symbol,
    amountUnits: null,
    amountDisplay: amount,
    nonce: null,
    label: null,
    message: params.get("desc"),
    legacy: true,
    precision: symbol && paymentAssetBySymbol(symbol)?.coinType ? "legacy-symbol" : "unknown",
  }
}

/** Sum line items exactly: quantity × unit price, added at the highest scale. */
export function invoiceLineTotal(quantity: string, price: string): DecimalValue | null {
  const q = parseDecimalValue(quantity)
  const p = parseDecimalValue(price)
  return q && p ? decimalProduct(q, p) : null
}

export function invoiceTotal(items: Array<{ quantity: string; price: string }>): DecimalValue {
  const lines = items.map(item => invoiceLineTotal(item.quantity, item.price) ?? { units: 0n, scale: 0 })
  return decimalSum(lines)
}

/** Display without rounding; pads to at least two fractional digits. */
export function formatInvoiceTotal(total: DecimalValue): string {
  return formatDecimal(total, 2)
}
