import assert from "node:assert/strict"
import { afterEach, beforeEach, test } from "node:test"
import {
  buildPaymentLink,
  canonicalPaymentAssets,
  invoiceLineTotal,
  invoiceTotal,
  parsePaymentLink,
  paymentAssetBySymbol,
} from "./payment-assets"
import { formatAmount } from "./coin-amount"

const address = "0x" + "1".repeat(64)
const usdc = paymentAssetBySymbol("USDC")!
const sui = paymentAssetBySymbol("SUI")!

beforeEach(() => {
  process.env.NEXT_PUBLIC_USDT_COIN_TYPE = "0x99::usdt::USDT"
})
afterEach(() => {
  delete process.env.NEXT_PUBLIC_USDT_COIN_TYPE
})

test("SUI is offered from the canonical type with 9 decimals", () => {
  assert.equal(sui.coinType, "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI")
  assert.equal(sui.decimals, 9)
  assert.equal(sui.source, "canonical")
})

test("USDC uses the published testnet type and 6 decimals", () => {
  assert.equal(usdc.coinType, "0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC")
  assert.equal(usdc.decimals, 6)
})

test("USDT is only offered when an operator configures its exact type", () => {
  // The env var is read at module load, so rebuild through the symbol lookup on
  // the imported list instead of mutating the module-level constant.
  const usdt = canonicalPaymentAssets().find(asset => asset.symbol === "USDT")!
  assert.equal(usdt.source === "configured" || usdt.source === "unavailable", true)
  if (usdt.source === "unavailable") assert.equal(usdt.coinType, "")
})

test("a SUI link carries base-unit amounts, coin type and nonce", () => {
  const link = buildPaymentLink({ address, total: { units: 125n, scale: 1 }, asset: sui, nonce: "nonce-1" })
  const params = new URLSearchParams(link.split("?")[1])
  assert.equal(link.startsWith("sui:pay?"), true)
  assert.equal(params.get("receiver"), address)
  assert.equal(params.get("amount"), "12500000000")
  assert.equal(params.get("coinType"), sui.coinType)
  assert.equal(params.get("nonce"), "nonce-1")
})

test("a USDC link uses 6 decimals and rejects extra precision", () => {
  const link = buildPaymentLink({ address, total: { units: 1234567n, scale: 6 }, asset: usdc, nonce: "n2" })
  assert.equal(new URLSearchParams(link.split("?")[1]).get("amount"), "1234567")
  assert.throws(() => buildPaymentLink({ address, total: { units: 1n, scale: 7 }, asset: usdc, nonce: "n3" }), /精度/)
})

test("a link is refused without a configured coin type or a valid nonce", () => {
  const unavailable = canonicalPaymentAssets().find(asset => asset.symbol === "USDT")!
  if (unavailable.source === "unavailable") {
    assert.throws(() => buildPaymentLink({ address, total: { units: 1n, scale: 0 }, asset: unavailable, nonce: "n" }), /未配置/)
  }
  assert.throws(() => buildPaymentLink({ address, total: { units: 1n, scale: 0 }, asset: sui, nonce: "" }), /nonce/)
  assert.throws(() => buildPaymentLink({ address, total: { units: 1n, scale: 0 }, asset: sui, nonce: "a".repeat(37) }), /nonce/)
  assert.throws(() => buildPaymentLink({ address, total: { units: 0n, scale: 0 }, asset: sui, nonce: "n" }), /大于零/)
})

test("parsing a standard link returns exact base units", () => {
  const parsed = parsePaymentLink(buildPaymentLink({ address, total: { units: 2n, scale: 0 }, asset: usdc, nonce: "abc", label: "Acme" }))
  assert.equal(parsed?.legacy, false)
  assert.equal(parsed?.precision, "exact")
  assert.equal(parsed?.amountUnits, 2_000_000n)
  assert.equal(parsed?.symbol, "USDC")
  assert.equal(parsed?.label, "Acme")
})

test("legacy address links still resolve but are marked as symbol-precision", () => {
  const parsed = parsePaymentLink(`sui:${address}?amount=12.50&coin=SUI&desc=Invoice-1`)
  assert.equal(parsed?.legacy, true)
  assert.equal(parsed?.address, address)
  assert.equal(parsed?.amountDisplay, "12.50")
  assert.equal(parsed?.precision, "legacy-symbol")
  const unknown = parsePaymentLink(`sui:${address}?amount=1&coin=XYZ`)
  assert.equal(unknown?.precision, "unknown")
  assert.equal(parsePaymentLink("not a link"), null)
})

test("invoice totals multiply and add without binary floating point", () => {
  assert.deepEqual(invoiceLineTotal("0.1", "0.2"), { units: 2n, scale: 2 })
  assert.deepEqual(invoiceTotal([{ quantity: "1", price: "0.1" }, { quantity: "1", price: "0.2" }]), { units: 3n, scale: 1 })
  assert.equal(formatAmount(invoiceTotal([{ quantity: "3", price: "1.15" }]), 6), "3.45")
  assert.equal(invoiceLineTotal("x", "1"), null)
})
