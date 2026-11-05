// Invoice drafts are browser-local records. They are not sent, paid or verified
// on chain, and clearing browser storage removes them.
//
// Totals are stored twice: `total` is the exact human display (never rounded to
// binary floating point) and `totalUnits` is the base-unit amount for the draft's
// `coinType`, when the asset type is known. Older drafts only carry `total`,
// `token` and a legacy link; they stay readable and are never rewritten.
import { isRecord } from "./local-records"
import { decimalSum, formatDecimal, parseDecimalValue, toCoinUnits, type DecimalValue } from "./coin-amount"

export interface InvoiceItem {
  id: string
  description: string
  quantity: string
  price: string
}

export interface StoredInvoice {
  invoiceNumber: string
  recipient: string
  recipientEmail?: string
  issueDate?: string
  dueDate?: string
  token: string
  /** Full coin type for drafts saved after the Payment Kit link migration. */
  coinType?: string
  /** Exact base units for `coinType`; absent on legacy drafts. */
  totalUnits?: string
  /** Stable payment nonce so a retried link cannot charge twice. */
  nonce?: string
  items: InvoiceItem[]
  notes?: string
  total: string
  paymentAddress: string
  paymentUri?: string
  groupId?: string
  source: "local"
}

export const INVOICE_STORAGE_KEY = "sui_invoices"
export const INVOICES_UPDATED_EVENT = "sui-invoices-updated"

function readItems(value: unknown): InvoiceItem[] | null {
  if (!Array.isArray(value) || value.length === 0) return null
  const items: InvoiceItem[] = []
  for (const [index, entry] of value.entries()) {
    if (!isRecord(entry)) return null
    const { id, description, quantity, price } = entry
    if (typeof description !== "string" || typeof quantity !== "string" || typeof price !== "string") return null
    items.push({
      id: typeof id === "string" && id ? id : `stored-${index}`,
      description,
      quantity,
      price,
    })
  }
  return items
}

export function isStoredInvoice(value: unknown): value is StoredInvoice {
  if (!isRecord(value)) return false
  const items = readItems(value.items)
  if (!items) return false
  return typeof value.invoiceNumber === "string" && value.invoiceNumber.trim() !== ""
    && typeof value.recipient === "string"
    && typeof value.token === "string" && value.token.trim() !== ""
    && typeof value.total === "string"
    && typeof value.paymentAddress === "string"
}

function readRaw(): unknown {
  if (typeof localStorage === "undefined") return null
  try {
    return JSON.parse(localStorage.getItem(INVOICE_STORAGE_KEY) || "[]")
  } catch { return null }
}

// Entries that do not match the current shape are excluded from the list but
// left untouched in storage, so an older or partially edited record is never
// silently discarded.
export function readInvoices(): StoredInvoice[] {
  const raw = readRaw()
  if (!Array.isArray(raw)) return []
  return raw.filter(isStoredInvoice).map(invoice => ({ ...invoice, items: readItems(invoice.items)! }))
}

/** Exact product of quantity × price, or zero when either field is not a plain decimal. */
export function invoiceItemTotal(item: Pick<InvoiceItem, "quantity" | "price">): DecimalValue {
  const quantity = parseDecimalValue(item.quantity)
  const price = parseDecimalValue(item.price)
  if (!quantity || !price) return { units: 0n, scale: 0 }
  return { units: quantity.units * price.units, scale: quantity.scale + price.scale }
}

export function invoiceTotal(items: InvoiceItem[]): DecimalValue {
  return decimalSum(items.map(invoiceItemTotal))
}

/** Exact display total; equivalent to the previous two-decimal string for valid input. */
export function computeInvoiceTotal(items: InvoiceItem[]): string {
  return formatDecimal(invoiceTotal(items), 2)
}

/** Base units for a coin type, or null when the total has excess precision. */
export function invoiceTotalUnits(items: InvoiceItem[], decimals: number): bigint | null {
  try {
    return toCoinUnits(invoiceTotal(items), decimals)
  } catch {
    return null
  }
}

export interface LegacyInvoiceLink {
  address: string
  amount: string | null
  symbol: string | null
}

/**
 * Read the payee and display amount out of a legacy `sui:<address>?amount=…`
 * draft link. Legacy links never stored base units, so callers must not claim
 * exact on-chain precision from them.
 */
export function legacyInvoiceLink(uri: string | undefined): LegacyInvoiceLink | null {
  if (!uri) return null
  if (/^sui:pay\?/i.test(uri.trim())) return null
  const match = /^sui:([^?]+)(?:\?(.*))?$/i.exec(uri.trim())
  if (!match) return null
  const params = new URLSearchParams(match[2] || "")
  return { address: decodeURIComponent(match[1]), amount: params.get("amount"), symbol: params.get("coin") }
}

// Invoice numbers identify a draft: re-saving the same number replaces that
// record instead of appending a duplicate. Other entries are kept verbatim.
export function saveInvoice(invoice: StoredInvoice): StoredInvoice[] {
  const raw = readRaw()
  const existing = Array.isArray(raw) ? raw : []
  const others = existing.filter(entry => !(isRecord(entry) && entry.invoiceNumber === invoice.invoiceNumber))
  localStorage.setItem(INVOICE_STORAGE_KEY, JSON.stringify([invoice, ...others]))
  notifyInvoicesUpdated()
  return readInvoices()
}

export function removeInvoice(invoiceNumber: string): StoredInvoice[] {
  const raw = readRaw()
  const existing = Array.isArray(raw) ? raw : []
  const remaining = existing.filter(entry => !(isRecord(entry) && entry.invoiceNumber === invoiceNumber))
  localStorage.setItem(INVOICE_STORAGE_KEY, JSON.stringify(remaining))
  notifyInvoicesUpdated()
  return readInvoices()
}

function notifyInvoicesUpdated() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(INVOICES_UPDATED_EVENT))
}
