import assert from "node:assert/strict"
import { afterEach, mock, test } from "node:test"
import { normalizeStructTag } from "@mysten/sui/utils"
import { proposalClient, PROPOSAL_TYPE_ORIGIN } from "./proposal-chain"
import { activityFromEvents, formatCoinBalance, readWalletActivity, readWalletAssets } from "./wallet-data"

const address = `0x${"1".repeat(64)}`
const coinType = normalizeStructTag("0x99::usdc::USDC")
afterEach(() => mock.restoreAll())

test("coin quantities preserve units and precision above Number.MAX_SAFE_INTEGER", () => {
  assert.equal(formatCoinBalance(9007199254740993123456789n, 9), "9007199254740993.123456789")
  assert.equal(formatCoinBalance(1n, 9), "0.000000001")
  assert.equal(formatCoinBalance(1200000n, 6), "1.2")
  assert.equal(formatCoinBalance(42n, 0), "42")
  assert.throws(() => formatCoinBalance(1n, 256), /精度无效/)
  assert.throws(() => formatCoinBalance(-1n, 9), /金额或精度无效/)
})

test("wallet assets page real holdings and apply each coin's published decimals", async () => {
  const cursors: Array<string | null | undefined> = []
  mock.method(proposalClient, "listBalances", async ({ cursor }: { cursor?: string | null }) => {
    cursors.push(cursor)
    return cursor ? { balances: [{ coinType, balance: "1234567" }], hasNextPage: false, cursor: null }
      : { balances: [{ coinType: "0x2::sui::SUI", balance: "9007199254740993123" }], hasNextPage: true, cursor: "page-2" }
  })
  mock.method(proposalClient, "getCoinMetadata", async () => ({ coinMetadata: { decimals: 6, symbol: "USDC", name: "On-chain token name" } }))
  const assets = await readWalletAssets(address)
  assert.deepEqual(cursors, [null, "page-2"])
  assert.equal(assets.length, 2)
  assert.equal(assets[0].symbol, "SUI")
  assert.equal(assets[0].balance, "9007199254.740993123")
  assert.equal(assets[1].balance, "1.234567")
  assert.equal(assets[1].name, "On-chain token name")
})

test("missing coin metadata retains exact raw units and exposes the read error", async () => {
  mock.method(proposalClient, "listBalances", async () => ({ balances: [{ coinType, balance: "1234567" }], hasNextPage: false, cursor: null }))
  mock.method(proposalClient, "getCoinMetadata", async () => { throw new Error("metadata transport unavailable") })
  const assets = await readWalletAssets(address)
  const token = assets.find(asset => asset.coinType === coinType)!
  assert.equal(token.decimals, null)
  assert.equal(token.balance, "1234567")
  assert.equal(token.metadataError, "metadata transport unavailable")
})

test("balance transport errors and cyclic pagination do not become empty wallets", async () => {
  mock.method(proposalClient, "listBalances", async () => { throw new Error("balance offline") })
  await assert.rejects(readWalletAssets(address), /balance offline/)
  mock.restoreAll()
  mock.method(proposalClient, "listBalances", async () => ({ balances: [], hasNextPage: true, cursor: "cycle" }))
  await assert.rejects(readWalletAssets(address), /分页未前进/)
})

test("personal approvals classify only matching protocol events and retain failures", () => {
  const base = { digest: "confirmed-digest", timestampMs: 10, status: { success: true, error: null } }
  const approval = activityFromEvents({ ...base, events: [{ eventType: `${PROPOSAL_TYPE_ORIGIN}::asynchronous_proposal::AsyncVoteSubmittedEvent` }] })
  assert.equal(approval.category, "approval")
  assert.equal(approval.title, "审批资金提案")
  const foreign = activityFromEvents({ ...base, events: [{ eventType: "0x999::asynchronous_proposal::ProposalCreatedEvent" }] })
  assert.equal(foreign.category, "transaction")
  const failed = activityFromEvents({ ...base, status: { success: false, error: { message: "MoveAbort" } }, events: [] })
  assert.equal(failed.success, false)
  assert.equal(failed.error, "MoveAbort")
})

test("activity queries are scoped to the current sender and preserve pagination", async () => {
  mock.method(proposalClient, "listTransactions", async (options: any) => {
    assert.deepEqual(options.filter, { sender: address })
    assert.equal(options.before, "older")
    assert.equal(options.order, "descending")
    return { transactions: [{ $kind: "Transaction", Transaction: { digest: "tx", timestampMs: 20, status: { success: true, error: null }, events: [] } }], hasNextPage: true, endCursor: "next" }
  })
  const page = await readWalletActivity(address, "older")
  assert.equal(page.activities[0].digest, "tx")
  assert.equal(page.cursor, "next")
  assert.equal(page.hasNextPage, true)
})
