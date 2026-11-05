import assert from "node:assert/strict"
import { test } from "node:test"
import { normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils"
import { calculateBatchTotal, validateBatchTemplate, buildPTBFromTemplate } from "./transaction-templates"
import type { TransactionTemplate } from "./local-records"
import type { WalletAsset } from "./wallet-data"

const suiType = normalizeStructTag("0x2::sui::SUI")
const mockAsset: WalletAsset = {
  coinType: suiType,
  name: "Sui",
  symbol: "SUI",
  decimals: 9,
  rawBalance: 100_000_000_000n, // 100 SUI
  balance: "100",
}

const alice = normalizeSuiAddress("0xa")
const bob = normalizeSuiAddress("0xb")
const charlie = normalizeSuiAddress("0xc")

test("calculateBatchTotal sums valid amounts and ignores malformed inputs", () => {
  assert.equal(calculateBatchTotal([]), "0")
  assert.equal(calculateBatchTotal([
    { amount: "1.5" },
    { amount: "2.5" },
    { amount: "0" },
    { amount: "-1" },
  ]), "4")
})

test("validateBatchTemplate verifies recipient addresses, positive amounts, and balances", () => {
  const validTemplate: TransactionTemplate = {
    id: "batch-1",
    name: "Payroll",
    type: "batch",
    description: "Monthly salary",
    createdAt: "2026-10-29T00:00:00Z",
    batchItems: [
      { recipient: bob, amount: "10", token: "SUI" },
      { recipient: charlie, amount: "20", token: "SUI" },
    ],
  }

  const res = validateBatchTemplate(validTemplate, mockAsset)
  assert.equal(res.valid, true)
  assert.equal(res.recipientCount, 2)
  assert.equal(res.totalUnits, 30_000_000_000n) // 30 SUI

  // Invalid address aborts
  const badAddrTemplate: TransactionTemplate = {
    ...validTemplate,
    batchItems: [{ recipient: "invalid", amount: "10", token: "SUI" }],
  }
  assert.equal(validateBatchTemplate(badAddrTemplate, mockAsset).valid, false)

  // Zero address aborts
  const zeroAddrTemplate: TransactionTemplate = {
    ...validTemplate,
    batchItems: [{ recipient: normalizeSuiAddress("0x0"), amount: "10", token: "SUI" }],
  }
  assert.equal(validateBatchTemplate(zeroAddrTemplate, mockAsset).valid, false)

  // Insufficient balance aborts
  const brokeAsset = { ...mockAsset, rawBalance: 1_000_000_000n } // 1 SUI
  const brokeRes = validateBatchTemplate(validTemplate, brokeAsset)
  assert.equal(brokeRes.valid, false)
  assert.match(brokeRes.error || "", /余额不足/)
})

test("buildPTBFromTemplate generates valid PTBs for single transfer and batch templates", () => {
  const singleTemplate: TransactionTemplate = {
    id: "single-1",
    name: "Bonus",
    type: "transfer",
    description: "Single transfer",
    createdAt: "2026-10-29T00:00:00Z",
    recipient: bob,
    amount: "5",
    token: "SUI",
  }
  const singleTx = buildPTBFromTemplate(alice, singleTemplate, mockAsset)
  assert.equal(singleTx.getData().sender, alice)
  assert.equal(singleTx.getData().commands.length, 2)

  const batchTemplate: TransactionTemplate = {
    id: "batch-1",
    name: "Team Payroll",
    type: "batch",
    description: "Team salary",
    createdAt: "2026-10-29T00:00:00Z",
    batchItems: [
      { recipient: bob, amount: "2", token: "SUI" },
      { recipient: charlie, amount: "3", token: "SUI" },
    ],
  }
  const batchTx = buildPTBFromTemplate(alice, batchTemplate, mockAsset)
  assert.equal(batchTx.getData().sender, alice)
  assert.equal(batchTx.getData().commands.length, 4) // 2 recipients -> 2 Intent + 2 Transfer
})
