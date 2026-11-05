import assert from "node:assert/strict"
import { afterEach, mock, test } from "node:test"
import { proposalClient } from "./proposal-chain"
import { assignTokenWeights, calculateWeight, getTokenBalance } from "./token-weight"

const owner = `0x${"1".repeat(64)}`
const coinType = `0x${"2".repeat(64)}::usd::USD`
afterEach(() => mock.restoreAll())

test("weight transforms preserve zero and floor fractions without inventing eligibility", () => {
  for (const method of ["linear", "sqrt", "quadratic"]) assert.equal(calculateWeight(0, method), 0)
  assert.equal(calculateWeight(2.5, "quadratic"), 6)
  assert.equal(calculateWeight(15, "sqrt"), 3)
  for (const value of [NaN, Infinity, -1, Number.MAX_VALUE]) assert.throws(() => calculateWeight(value, "linear"))
  assert.throws(() => calculateWeight(1, "unknown"))
})

test("token units use real metadata with exact bigint division before conversion", async () => {
  mock.method(proposalClient, "listBalances", async ({ cursor }: { cursor?: string | null }) => cursor
    ? { balances: [{ coinType, balance: "1234567" }], hasNextPage: false, cursor: null }
    : { balances: [], hasNextPage: true, cursor: "next" })
  mock.method(proposalClient, "getCoinMetadata", async () => ({ coinMetadata: { decimals: 6 } }))
  assert.equal(await getTokenBalance(owner, coinType), 1)
})

test("RPC outage, unknown metadata, malformed amounts and stuck cursors do not become weight one", async () => {
  mock.method(proposalClient, "listBalances", async () => { throw new Error("offline") })
  await assert.rejects(getTokenBalance(owner), /offline/)
  mock.restoreAll()
  mock.method(proposalClient, "listBalances", async () => ({ balances: [], hasNextPage: false, cursor: null }))
  mock.method(proposalClient, "getCoinMetadata", async () => ({ coinMetadata: null }))
  await assert.rejects(getTokenBalance(owner, coinType), /元数据不可用/)
  mock.restoreAll()
  mock.method(proposalClient, "listBalances", async () => ({ balances: [{ coinType, balance: "-1" }], hasNextPage: false, cursor: null }))
  await assert.rejects(getTokenBalance(owner, coinType), /余额无效/)
  mock.restoreAll()
  mock.method(proposalClient, "listBalances", async () => ({ balances: [], hasNextPage: true, cursor: "cycle" }))
  await assert.rejects(getTokenBalance(owner), /分页未前进/)
})

test("zero holdings clear a stale voter weight and historical snapshots cannot silently use current balances", async () => {
  mock.method(proposalClient, "listBalances", async () => ({ balances: [], hasNextPage: false, cursor: null }))
  const voters = [{ address: owner, weight: 50, name: "saved voter" }]
  assert.equal((await assignTokenWeights(voters, "0x2::sui::SUI"))[0].weight, 0)
  assert.equal(voters[0].weight, 50)
  await assert.rejects(assignTokenWeights(voters, "0x2::sui::SUI", "linear", "100"), /快照/)
})
