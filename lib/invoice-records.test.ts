import assert from "node:assert/strict"
import { afterEach, beforeEach, test } from "node:test"
import {
  INVOICES_UPDATED_EVENT,
  computeInvoiceTotal,
  invoiceItemTotal,
  isStoredInvoice,
  legacyInvoiceLink,
  readInvoices,
  removeInvoice,
  saveInvoice,
  type StoredInvoice,
} from "./invoice-records"

const storage = new Map<string, string>()
beforeEach(() => {
  storage.clear()
  Object.defineProperty(globalThis, "window", { configurable: true, value: new EventTarget() })
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  } })
})
afterEach(() => {
  Reflect.deleteProperty(globalThis, "window")
  Reflect.deleteProperty(globalThis, "localStorage")
})

const invoice: StoredInvoice = {
  invoiceNumber: "INV-000001",
  recipient: "Acme Ltd",
  recipientEmail: "billing@example.com",
  token: "SUI",
  items: [{ id: "1", description: "Design work", quantity: "2", price: "1.5" }],
  total: "3.00",
  paymentAddress: "0x" + "1".repeat(64),
  source: "local",
}

test("an empty store lists no invoices", () => {
  assert.deepEqual(readInvoices(), [])
})

test("malformed storage is reported as empty without throwing or being rewritten", () => {
  storage.set("sui_invoices", "{not json")
  assert.deepEqual(readInvoices(), [])
  assert.equal(storage.get("sui_invoices"), "{not json")
})

test("unknown entries are retained in storage and excluded from the list", () => {
  storage.set("sui_invoices", JSON.stringify([invoice, { invoiceNumber: 42 }, null, "legacy"]))
  assert.deepEqual(readInvoices().map(entry => entry.invoiceNumber), ["INV-000001"])
  assert.equal(JSON.parse(storage.get("sui_invoices")!).length, 4)
})

test("saving prepends the new invoice and keeps older unknown entries", () => {
  storage.set("sui_invoices", JSON.stringify([{ legacy: true }]))
  const saved = saveInvoice(invoice)
  assert.deepEqual(saved.map(entry => entry.invoiceNumber), ["INV-000001"])
  const raw = JSON.parse(storage.get("sui_invoices")!)
  assert.equal(raw.length, 2)
  assert.deepEqual(raw[1], { legacy: true })
})

test("re-saving an existing invoice number replaces that draft instead of duplicating it", () => {
  storage.set("sui_invoices", JSON.stringify([invoice, { ...invoice, invoiceNumber: "INV-000002" }]))
  const saved = saveInvoice({ ...invoice, total: "9.00", notes: "edited" })
  assert.deepEqual(saved.map(entry => entry.invoiceNumber), ["INV-000001", "INV-000002"])
  assert.equal(saved[0].total, "9.00")
  assert.equal(saved[0].notes, "edited")
  assert.equal(JSON.parse(storage.get("sui_invoices")!).length, 2)
})

test("saving dispatches the update event so open lists refresh", () => {
  let fired = 0
  ;(window as unknown as EventTarget).addEventListener(INVOICES_UPDATED_EVENT, () => { fired += 1 })
  saveInvoice(invoice)
  assert.equal(fired, 1)
})

test("removing an invoice keeps every other record untouched", () => {
  storage.set("sui_invoices", JSON.stringify([
    invoice,
    { ...invoice, invoiceNumber: "INV-000002" },
    { legacy: "keep me" },
  ]))
  const remaining = removeInvoice("INV-000001")
  assert.deepEqual(remaining.map(entry => entry.invoiceNumber), ["INV-000002"])
  const raw = JSON.parse(storage.get("sui_invoices")!)
  assert.equal(raw.length, 2)
  assert.deepEqual(raw[1], { legacy: "keep me" })
})

test("an invoice without items or identity fields is rejected", () => {
  assert.equal(isStoredInvoice({ ...invoice, items: [] }), false)
  assert.equal(isStoredInvoice({ ...invoice, invoiceNumber: "  " }), false)
  assert.equal(isStoredInvoice({ ...invoice, token: "" }), false)
  assert.equal(isStoredInvoice({ ...invoice, items: [{ description: "x" }] }), false)
  assert.equal(isStoredInvoice(invoice), true)
})

test("items missing an id receive a stable positional id", () => {
  storage.set("sui_invoices", JSON.stringify([
    { ...invoice, items: [{ description: "Work", quantity: "1", price: "2" }] },
  ]))
  assert.equal(readInvoices()[0].items[0].id, "stored-0")
})

test("totals use decimal arithmetic with invalid fields counting as zero", () => {
  assert.equal(computeInvoiceTotal([{ id: "1", description: "a", quantity: "2", price: "1.25" }]), "2.50")
  assert.equal(computeInvoiceTotal([{ id: "1", description: "a", quantity: "", price: "" }]), "0.00")
})

test("line totals keep exact decimal precision instead of binary rounding", () => {
  assert.deepEqual(invoiceItemTotal({ quantity: "0.1", price: "0.2" }), { units: 2n, scale: 2 })
  assert.equal(computeInvoiceTotal([
    { id: "1", description: "a", quantity: "1", price: "0.1" },
    { id: "2", description: "b", quantity: "1", price: "0.2" },
  ]), "0.30")
})

test("legacy links expose the payee, display amount and symbol", () => {
  const parsed = legacyInvoiceLink(`sui:0x${"1".repeat(64)}?amount=12.50&coin=SUI&desc=Invoice-1`)
  assert.equal(parsed?.address, `0x${"1".repeat(64)}`)
  assert.equal(parsed?.amount, "12.50")
  assert.equal(parsed?.symbol, "SUI")
  assert.equal(legacyInvoiceLink(undefined), null)
  assert.equal(legacyInvoiceLink("sui:pay?receiver=0x1&amount=1"), null)
})
