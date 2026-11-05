// Exact decimal arithmetic for user-entered amounts. Values are kept as
// bigint units plus a decimal scale; nothing is routed through Number, so a
// large amount or a high-precision coin is never silently rounded.

import { t } from "./i18n/t"

export interface DecimalValue {
  units: bigint
  scale: number
}

const PLAIN_DECIMAL = /^\d+(\.\d+)?$/

/** Parse a plain decimal string. Exponents, signs and separators are rejected. */
export function parseDecimalValue(value: string): DecimalValue | null {
  const trimmed = value.trim()
  if (!PLAIN_DECIMAL.test(trimmed)) return null
  const [whole, fraction = ""] = trimmed.split(".")
  return { units: BigInt(whole + fraction), scale: fraction.length }
}

export function decimalProduct(left: DecimalValue, right: DecimalValue): DecimalValue {
  return { units: left.units * right.units, scale: left.scale + right.scale }
}

export function decimalSum(values: DecimalValue[]): DecimalValue {
  const scale = values.reduce((max, value) => Math.max(max, value.scale), 0)
  const units = values.reduce((sum, value) => sum + value.units * 10n ** BigInt(scale - value.scale), 0n)
  return { units, scale }
}

export function formatCoinUnits(units: bigint, decimals: number): string {
  if (units < 0n || !Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new Error(t("payments.errInvalidAmountOrDecimals"))
  if (decimals === 0) return units.toString()
  const digits = units.toString().padStart(decimals + 1, "0")
  const fraction = digits.slice(-decimals).replace(/0+$/, "")
  return `${digits.slice(0, -decimals)}${fraction ? `.${fraction}` : ""}`
}

/**
 * Convert an exact decimal value to on-chain units. Throws when the value has
 * more precision than the coin supports and the excess is not zero, instead of
 * dropping dust the user did not agree to lose.
 */
export function toCoinUnits(value: DecimalValue, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new Error(t("payments.errInvalidDecimals"))
  if (value.scale <= decimals) return value.units * 10n ** BigInt(decimals - value.scale)
  const divisor = 10n ** BigInt(value.scale - decimals)
  if (value.units % divisor !== 0n) throw new Error(t("payments.errAmountExceedsDecimals", { decimals }))
  return value.units / divisor
}

/** Human display with at least two fractional digits, never more than the coin allows. */
export function formatAmount(value: DecimalValue, decimals: number): string {
  const units = toCoinUnits(value, decimals)
  const whole = decimals === 0 ? units : units / 10n ** BigInt(decimals)
  const fraction = decimals === 0 ? "" : (units % 10n ** BigInt(decimals)).toString().padStart(decimals, "0")
  const trimmed = fraction.replace(/0+$/, "").padEnd(2, "0")
  return `${whole}.${trimmed}`
}

/**
 * Display an exact value when the asset's precision is not known. Keeps every
 * entered digit and pads to two fractional places; it never rounds.
 */
export function formatDecimal(value: DecimalValue, minFractionDigits = 2): string {
  const digits = value.units.toString().padStart(value.scale + 1, "0")
  const whole = digits.slice(0, digits.length - value.scale)
  const fraction = digits.slice(digits.length - value.scale).replace(/0+$/, "").padEnd(minFractionDigits, "0")
  return `${whole}.${fraction}`
}
