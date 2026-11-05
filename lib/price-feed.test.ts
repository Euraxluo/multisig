import assert from "node:assert/strict"
import { afterEach, beforeEach, test } from "node:test"
import { fetchTokenPrices, formatChange, formatUsd, priceIdsForAssets, totalUsdValue } from "./price-feed"
import type { WalletAsset } from "./wallet-data"
import { SUI_COIN_TYPE, USDC_TESTNET_COIN_TYPE } from "./payment-assets"

const assets: WalletAsset[] = [
  { coinType: SUI_COIN_TYPE, symbol: "SUI", name: "Sui", balance: "2", rawBalance: 2_000_000_000n, decimals: 9 },
  { coinType: USDC_TESTNET_COIN_TYPE, symbol: "USDC", name: "USD Coin", balance: "3.5", rawBalance: 3_500_000n, decimals: 6 },
  { coinType: "0x42::unknown::COIN", symbol: "COIN", name: "Unknown", balance: "9", rawBalance: 9n, decimals: null },
]

const originalFetch = globalThis.fetch
beforeEach(() => {
  delete process.env.NEXT_PUBLIC_PRICE_FEED
})
afterEach(() => {
  globalThis.fetch = originalFetch
  delete process.env.NEXT_PUBLIC_PRICE_FEED
})

test("only known coin types are priced", () => {
  assert.deepEqual(priceIdsForAssets(assets), ["sui", "usd-coin"])
})

test("total USD uses exact decimals and skips unpriced or unknown-precision assets", () => {
  const total = totalUsdValue(assets, {
    [SUI_COIN_TYPE]: { usd: 3, change24h: 1.2 },
    [USDC_TESTNET_COIN_TYPE]: { usd: 1, change24h: 0 },
  })
  assert.equal(total, 2 * 3 + 3.5)
  assert.equal(totalUsdValue(assets, {}), null)
})

test("a missing change or an unpriced asset never becomes a fabricated number", () => {
  assert.equal(formatChange(null), null)
  assert.equal(formatChange(Number.NaN), null)
  assert.equal(formatChange(-1.234), "-1.23%")
  assert.equal(formatChange(0), "+0.00%")
  assert.equal(formatUsd(12.5), "$12.50")
})

test("the feed returns null instead of inventing prices when unreachable", async () => {
  process.env.NEXT_PUBLIC_PRICE_FEED = "on"
  globalThis.fetch = (async () => { throw new Error("offline") }) as typeof fetch
  assert.equal(await fetchTokenPrices(assets), null)
})

test("a malformed or empty feed response is rejected", async () => {
  process.env.NEXT_PUBLIC_PRICE_FEED = "on"
  globalThis.fetch = (async () => new Response("{}", { status: 200 })) as typeof fetch
  assert.equal(await fetchTokenPrices(assets), null)
  globalThis.fetch = (async () => new Response(JSON.stringify({ sui: { usd: 0 } }), { status: 200 })) as typeof fetch
  assert.equal(await fetchTokenPrices(assets), null)
})

test("a real response supplies price and change with its source", async () => {
  process.env.NEXT_PUBLIC_PRICE_FEED = "on"
  globalThis.fetch = (async () => new Response(JSON.stringify({
    sui: { usd: 2.5, usd_24h_change: 4.5 },
    "usd-coin": { usd: 1, usd_24h_change: null },
  }), { status: 200 })) as typeof fetch
  const snapshot = await fetchTokenPrices(assets)
  assert.equal(snapshot?.prices[SUI_COIN_TYPE].usd, 2.5)
  assert.equal(snapshot?.prices[USDC_TESTNET_COIN_TYPE].change24h, null)
  assert.equal(typeof snapshot?.source, "string")
  assert.equal(typeof snapshot?.fetchedAt, "number")
})

test("the feed is opt-in and stays off without explicit configuration", async () => {
  globalThis.fetch = (async () => { throw new Error("must not be called") }) as typeof fetch
  assert.equal(await fetchTokenPrices(assets), null)
  process.env.NEXT_PUBLIC_PRICE_FEED = "off"
  assert.equal(await fetchTokenPrices(assets), null)
})
