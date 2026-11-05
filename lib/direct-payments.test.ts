import assert from "node:assert/strict"
import { test } from "node:test"
import { bcs } from "@mysten/sui/bcs"
import { normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils"
import { buildDirectCoinPayment, buildDirectBatchPayment, directPaymentUnits } from "./direct-payments"
import type { WalletAsset } from "./wallet-data"

const usdc = normalizeStructTag("0x123::usdc::USDC")
const asset = (overrides: Partial<WalletAsset> = {}): WalletAsset => ({ coinType: usdc, name: "USD Coin", symbol: "USDC", decimals: 6, rawBalance: (1n << 64n) - 1n, balance: "", ...overrides })
test("personal payments preserve the full u64 and each coin's decimal precision", () => {
  assert.equal(directPaymentUnits("18446744073709.551615", asset()), (1n << 64n) - 1n)
  assert.equal(directPaymentUnits("0.000001", asset()), 1n)
  assert.equal(directPaymentUnits("0.000000001", asset({ decimals: 9 })), 1n)
  for (const amount of ["0", "1e-6", "0.0000001", "-1"]) assert.throws(() => directPaymentUnits(amount, asset()))
  assert.throws(() => directPaymentUnits("1", asset({ decimals: null })), /精度/)
  assert.throws(() => directPaymentUnits("1", asset({ rawBalance: 999_999n })), /余额不足/)
})
test("multi-coin PTB binds sender, exact type and units, then transfers to the resolved recipient", () => {
  const tx = buildDirectCoinPayment(normalizeSuiAddress("0xa"), normalizeSuiAddress("0xb"), usdc, 9_007_199_254_740_993n)
  const data = tx.getData()
  assert.equal(data.sender, normalizeSuiAddress("0xa"))
  assert.equal(data.commands.length, 2)
  assert.equal(data.commands[0].$kind, "$Intent")
  const intent = data.commands[0].$Intent!
  assert.equal(intent.name, "CoinWithBalance")
  assert.equal(intent.data.type, usdc)
  assert.equal(String(intent.data.balance), "9007199254740993")
  assert.equal(data.commands[1].$kind, "TransferObjects")
  assert.equal(bcs.Address.parse(Buffer.from(data.inputs[0].Pure!.bytes, "base64")), normalizeSuiAddress("0xb"))
  assert.throws(() => buildDirectCoinPayment("bad", normalizeSuiAddress("0xb"), usdc, 1n))
  assert.throws(() => buildDirectCoinPayment(normalizeSuiAddress("0xa"), normalizeSuiAddress("0x0"), usdc, 1n))
})

test("batch PTB binds sender and fans out multi-recipient transfers in a single transaction", () => {
  const alice = normalizeSuiAddress("0xa")
  const bob = normalizeSuiAddress("0xb")
  const charlie = normalizeSuiAddress("0xc")
  const transfers = [
    { recipient: bob, units: 1_000_000n },
    { recipient: charlie, units: 2_000_000n },
  ]
  const tx = buildDirectBatchPayment(alice, usdc, transfers)
  const data = tx.getData()
  assert.equal(data.sender, alice)
  // Each recipient gets a CoinWithBalance Intent + TransferObjects command
  assert.equal(data.commands.length, 4)
  assert.equal(data.commands[0].$kind, "$Intent")
  assert.equal(data.commands[0].$Intent?.name, "CoinWithBalance")
  assert.equal(data.commands[1].$kind, "TransferObjects")
  assert.equal(data.commands[2].$kind, "$Intent")
  assert.equal(data.commands[3].$kind, "TransferObjects")

  // Rejections for invalid sender, empty list, or invalid recipient
  assert.throws(() => buildDirectBatchPayment("bad", usdc, transfers), /发送人地址无效/)
  assert.throws(() => buildDirectBatchPayment(alice, usdc, []), /批量转账至少需要一个收款人/)
  assert.throws(() => buildDirectBatchPayment(alice, usdc, [{ recipient: normalizeSuiAddress("0x0"), units: 1n }]), /收款人地址或金额无效/)
  assert.throws(() => buildDirectBatchPayment(alice, usdc, [{ recipient: bob, units: 0n }]), /收款人地址或金额无效/)
})

