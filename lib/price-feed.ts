// Live reference prices for wallet assets.
//
// There is no on-chain price oracle in this app, so a price is only ever shown
// when a real feed returned it, together with its source and fetch time. When
// the feed is unreachable nothing is displayed — the UI never falls back to a
// hardcoded price. Testnet tokens are not redeemable for the mainnet asset the
// feed quotes, so callers must label the value as a reference estimate.
import type { WalletAsset } from "./wallet-data"
import { SUI_COIN_TYPE, USDC_TESTNET_COIN_TYPE, USDT_COIN_TYPE } from "./payment-assets"

export const PRICE_FEED_URL = process.env.NEXT_PUBLIC_PRICE_FEED_URL || "https://api.coingecko.com/api/v3/simple/price"

/** The feed is opt-in: a deployment enables it with NEXT_PUBLIC_PRICE_FEED=on. */
export function priceFeedEnabled(): boolean {
  return process.env.NEXT_PUBLIC_PRICE_FEED === "on"
}

export interface TokenPrice {
  usd: number
  change24h: number | null
}

export interface PriceSnapshot {
  source: string
  fetchedAt: number
  prices: Record<string, TokenPrice>
}

/** CoinGecko ids for the coin types this app knows how to price. */
const COINGECKO_IDS: Record<string, string> = {
  [SUI_COIN_TYPE]: "sui",
  [USDC_TESTNET_COIN_TYPE]: "usd-coin",
  ...(USDT_COIN_TYPE ? { [USDT_COIN_TYPE]: "tether" } : {}),
}

export function priceIdsForAssets(assets: Array<Pick<WalletAsset, "coinType">>): string[] {
  return [...new Set(assets.map(asset => COINGECKO_IDS[asset.coinType]).filter((id): id is string => Boolean(id)))]
}

/** Total USD value for the assets whose price is known; `null` when none is. */
export function totalUsdValue(assets: WalletAsset[], prices: Record<string, TokenPrice>): number | null {
  let total = 0
  let priced = 0
  for (const asset of assets) {
    const price = prices[asset.coinType]
    if (!price || asset.decimals === null) continue
    total += Number(asset.rawBalance) / 10 ** asset.decimals * price.usd
    priced += 1
  }
  return priced ? total : null
}

let cached: { snapshot: PriceSnapshot; expiresAt: number } | null = null

/**
 * Fetch reference prices. Returns null when disabled, unreachable, or when the
 * response does not contain a finite positive price for any requested coin.
 */
export async function fetchTokenPrices(assets: Array<Pick<WalletAsset, "coinType">>, signal?: AbortSignal): Promise<PriceSnapshot | null> {
  if (!priceFeedEnabled()) return null
  const ids = priceIdsForAssets(assets)
  if (!ids.length) return null
  if (cached && cached.expiresAt > Date.now()) {
    // The snapshot holds every price this build knows, so it serves any subset.
    return cached.snapshot
  }

  const url = new URL(PRICE_FEED_URL)
  url.searchParams.set("ids", ids.join(","))
  url.searchParams.set("vs_currencies", "usd")
  url.searchParams.set("include_24hr_change", "true")

  let payload: unknown
  try {
    const response = await fetch(url, { cache: "no-store", signal: signal ?? AbortSignal.timeout(8_000) })
    if (!response.ok) return null
    payload = await response.json()
  } catch {
    return null
  }
  if (!payload || typeof payload !== "object") return null

  const prices: Record<string, TokenPrice> = {}
  let any = false
  for (const [coinType, id] of Object.entries(COINGECKO_IDS)) {
    if (!ids.includes(id)) continue
    const entry = (payload as Record<string, unknown>)[id]
    if (!entry || typeof entry !== "object") continue
    const usd = (entry as Record<string, unknown>).usd
    const change = (entry as Record<string, unknown>).usd_24h_change
    if (typeof usd !== "number" || !Number.isFinite(usd) || usd <= 0) continue
    prices[coinType] = {
      usd,
      change24h: typeof change === "number" && Number.isFinite(change) ? change : null,
    }
    any = true
  }
  if (!any) return null

  const snapshot: PriceSnapshot = { source: new URL(PRICE_FEED_URL).host, fetchedAt: Date.now(), prices }
  cached = { snapshot, expiresAt: Date.now() + 60_000 }
  return snapshot
}

/** Format a USD value the way the asset row displays it. */
export function formatUsd(value: number): string {
  return value.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 })
}

/** `null` when the feed did not provide a 24h change. */
export function formatChange(change: number | null): string | null {
  if (change === null || !Number.isFinite(change)) return null
  return `${change >= 0 ? "+" : ""}${change.toFixed(2)}%`
}
