import assert from "node:assert/strict"
import { test } from "node:test"
import {
  decimalProduct,
  decimalSum,
  formatAmount,
  formatCoinUnits,
  parseDecimalValue,
  toCoinUnits,
} from "./coin-amount"

test("plain decimals parse exactly without binary floating point", () => {
  assert.deepEqual(parseDecimalValue("1.25"), { units: 125n, scale: 2 })
  assert.deepEqual(parseDecimalValue("0"), { units: 0n, scale: 0 })
  assert.deepEqual(parseDecimalValue("18446744073.709551615"), { units: 18446744073709551615n, scale: 9 })
  for (const value of ["", "1e3", "-1", "+1", ".5", "1.", "1,5", "NaN"]) assert.equal(parseDecimalValue(value), null)
})

test("products and sums keep their exact scale", () => {
  assert.deepEqual(decimalProduct({ units: 3n, scale: 0 }, { units: 15n, scale: 1 }), { units: 45n, scale: 1 })
  assert.deepEqual(decimalSum([{ units: 45n, scale: 1 }, { units: 1n, scale: 2 }]), { units: 451n, scale: 2 })
  assert.deepEqual(decimalSum([{ units: 1n, scale: 3 }, { units: 2n, scale: 1 }]), { units: 201n, scale: 3 })
})

test("trailing zeros beyond the coin precision are accepted", () => {
  assert.equal(toCoinUnits({ units: 1000n, scale: 10 }, 9), 100n)
  assert.equal(toCoinUnits({ units: 12n, scale: 1 }, 9), 1200000000n)
})

test("a non-zero remainder beyond the coin precision aborts", () => {
  assert.throws(() => toCoinUnits({ units: 1n, scale: 10 }, 9), /精度/)
})

test("coin units format without exponent notation", () => {
  assert.equal(formatCoinUnits(1_000_000_000n, 9), "1")
  assert.equal(formatCoinUnits(1n, 9), "0.000000001")
  assert.equal(formatCoinUnits(0n, 9), "0")
  assert.equal(formatCoinUnits(125n, 2), "1.25")
})

test("display keeps two fractional digits and respects smaller decimals", () => {
  assert.equal(formatAmount({ units: 125n, scale: 1 }, 9), "12.50")
  assert.equal(formatAmount({ units: 0n, scale: 0 }, 9), "0.00")
  assert.equal(formatAmount({ units: 3n, scale: 9 }, 9), "0.000000003")
  assert.equal(formatAmount({ units: 1n, scale: 0 }, 0), "1.00")
  assert.throws(() => formatAmount({ units: 1n, scale: 10 }, 9), /精度/)
})
