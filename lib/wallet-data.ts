import { normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils"
import { proposalClient, PROPOSAL_TYPE_ORIGIN, PROPOSAL_PACKAGE_ID } from "./proposal-chain"
import { t } from "./i18n/t"

const SUI_TYPE = normalizeStructTag("0x2::sui::SUI")
const signal = () => AbortSignal.timeout(20_000)

export interface WalletAsset {
  coinType: string
  symbol: string
  name: string
  balance: string
  rawBalance: bigint
  decimals: number | null
  metadataError?: string
}

export function formatCoinBalance(raw: bigint, decimals: number): string {
  if (raw < 0n || !Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new Error(t("misc.walletData.invalidAmount"))
  if (decimals === 0) return raw.toString()
  const digits = raw.toString().padStart(decimals + 1, "0")
  const fraction = digits.slice(-decimals).replace(/0+$/, "")
  return `${digits.slice(0, -decimals)}${fraction ? `.${fraction}` : ""}`
}

export async function readWalletAssets(address: string): Promise<WalletAsset[]> {
  const owner = normalizeSuiAddress(address)
  const balances = new Map<string, bigint>()
  const cursors = new Set<string>()
  let cursor: string | null = null
  let pages = 0
  let rows = 0
  do {
    if (++pages > 40) throw new Error(t("misc.walletData.pageLimit"))
    const page = await proposalClient.listBalances({ owner, cursor, limit: 50, signal: signal() })
    rows += page.balances.length
    if (rows > 1000) throw new Error(t("misc.walletData.typeLimit"))
    for (const row of page.balances) {
      const type = normalizeStructTag(row.coinType)
      const amount = BigInt(row.balance)
      if (amount < 0n) throw new Error(t("misc.walletData.invalidBalance"))
      balances.set(type, amount)
    }
    if (balances.size > 1000) throw new Error(t("misc.walletData.typeLimit"))
    if (page.hasNextPage && (!page.cursor || cursors.has(page.cursor))) throw new Error(t("misc.walletData.pageStuck"))
    cursor = page.hasNextPage ? page.cursor : null
    if (cursor) cursors.add(cursor)
  } while (cursor)
  if (!balances.has(SUI_TYPE)) balances.set(SUI_TYPE, 0n)

  const assets: WalletAsset[] = []
  const entries = [...balances]
  for (let offset = 0; offset < entries.length; offset += 8) {
    assets.push(...await Promise.all(entries.slice(offset, offset + 8).map(async ([coinType, rawBalance]): Promise<WalletAsset> => {
      if (coinType === SUI_TYPE) return { coinType, symbol: "SUI", name: "Sui Native Coin", balance: formatCoinBalance(rawBalance, 9), rawBalance, decimals: 9 }
      try {
        const { coinMetadata } = await proposalClient.getCoinMetadata({ coinType, signal: signal() })
        if (!coinMetadata) throw new Error(t("misc.walletData.noMetadata"))
        return { coinType, rawBalance, symbol: coinMetadata.symbol, name: coinMetadata.name, decimals: coinMetadata.decimals, balance: formatCoinBalance(rawBalance, coinMetadata.decimals) }
      } catch (error) {
        return { coinType, rawBalance, symbol: coinType.split("::").at(-1) || "Coin", name: t("misc.walletData.metadataMissing"), balance: rawBalance.toString(), decimals: null, metadataError: error instanceof Error ? error.message : t("misc.walletData.metadataFailed") }
      }
    })))
  }
  return assets.sort((a, b) => a.coinType === SUI_TYPE ? -1 : b.coinType === SUI_TYPE ? 1 : a.coinType.localeCompare(b.coinType))
}

export interface WalletActivity {
  digest: string
  timestampMs: number | null
  success: boolean
  category: "approval" | "creation" | "transaction"
  title: string
  error?: string
}

export function activityFromEvents(transaction: {
  digest: string
  timestampMs: number | null
  status: { success: boolean; error?: { message?: string } | null }
  events: Array<{ eventType: string }>
}): WalletActivity {
  const names = transaction.events.filter(event => {
    const [origin, module] = event.eventType.split("::")
    return [PROPOSAL_TYPE_ORIGIN, PROPOSAL_PACKAGE_ID].includes(normalizeSuiAddress(origin)) && module === "asynchronous_proposal"
  }).map(event => event.eventType.split("::").at(-1))
  const rejected = names.includes("AsyncVoteRejectedEvent")
  const approval = rejected || names.includes("AsyncVoteSubmittedEvent")
  const creation = names.includes("ProposalCreatedEvent")
  const executed = names.includes("ProposalExecutedEvent")
  return {
    digest: transaction.digest, timestampMs: transaction.timestampMs, success: transaction.status.success,
    category: approval ? "approval" : creation ? "creation" : "transaction",
    title: rejected ? t("misc.walletData.txDiscard") : approval ? t("misc.walletData.txApprove") : creation ? t("misc.walletData.txCreate") : executed ? t("misc.walletData.txExecute") : t("misc.walletData.txGeneric"),
    error: transaction.status.error?.message,
  }
}

export async function readWalletActivity(address: string, before?: string | null) {
  const page = await proposalClient.listTransactions({
    filter: { sender: normalizeSuiAddress(address) }, order: "descending", before,
    limit: 20, include: { events: true }, signal: signal(),
  })
  return {
    activities: page.transactions.map(result => activityFromEvents(result.$kind === "Transaction" ? result.Transaction : result.FailedTransaction)),
    hasNextPage: page.hasNextPage, cursor: page.endCursor,
  }
}
