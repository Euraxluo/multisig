import { isValidSuiAddress, normalizeSuiAddress } from "@mysten/sui/utils"
import type {
  StandardConnectFeature,
  SuiSignAndExecuteTransactionBlockFeature,
  SuiSignAndExecuteTransactionFeature,
  SuiSignPersonalMessageFeature,
  SuiSignTransactionFeature,
  WalletAccount,
} from "@mysten/wallet-standard"
import { t } from "./i18n/t"

export const WALLET_CHAIN = "sui:testnet" as const

/**
 * The wallet features this app calls, typed against the SDK's own declarations.
 *
 * A `RegisteredWallet` is what `getWallets().get()` returns: the Wallet Standard
 * says features are `Record<string, unknown>`, because any wallet may add any
 * feature. Only these keys are ever read here, so naming them turns a typo or a
 * wrong method name into a compile error instead of an `undefined is not a
 * function` at connect time. Keys a wallet does not implement stay optional,
 * and the index signature keeps a wallet's other features loadable.
 */
export type SuiWalletFeatures =
  Partial<StandardConnectFeature> &
  Partial<SuiSignTransactionFeature> &
  Partial<SuiSignAndExecuteTransactionFeature> &
  Partial<SuiSignAndExecuteTransactionBlockFeature> &
  Partial<SuiSignPersonalMessageFeature> &
  Record<string, unknown>

export interface RegisteredWallet {
  name: string
  icon?: string
  chains: readonly string[]
  features: SuiWalletFeatures
  accounts: readonly WalletAccount[]
}
/** The account type the Wallet Standard declares; re-exported so callers share one name. */
export type { WalletAccount }
export interface WalletProvider { id: string; name: string; icon?: string; wallets: RegisteredWallet[] }

export function walletProviderId(name: string): string {
  const normalized = name.trim().toLowerCase().replace(/\s+/g, " ")
  if (/^okx(?: wallet)?$/.test(normalized)) return "okx"
  if (/^(?:slush|sui wallet)$/.test(normalized)) return "slush"
  if (/^suiet(?: wallet)?$/.test(normalized)) return "suiet"
  if (/^nightly(?: wallet)?$/.test(normalized)) return "nightly"
  if (/^martian(?: wallet)?$/.test(normalized)) return "martian"
  return normalized
}

/**
 * The signing feature each entry refers to, and the method it must expose.
 *
 * Declared as data rather than three inline string lookups so the pairing
 * ("sui:signTransaction" carries `signTransaction`) is stated once and checked
 * by the compiler.
 */
const SIGN_FEATURES = {
  "sui:signTransaction": "signTransaction",
  "sui:signAndExecuteTransaction": "signAndExecuteTransaction",
  "sui:signAndExecuteTransactionBlock": "signAndExecuteTransactionBlock",
} as const

/** True when `feature` is an object exposing a callable `method`. */
function hasMethod(feature: unknown, method: string): boolean {
  return !!feature && typeof feature === "object" && typeof (feature as Record<string, unknown>)[method] === "function"
}

/** Narrows an unknown feature entry to the standard connect feature it must be. */
function isConnectFeature(feature: unknown): feature is StandardConnectFeature["standard:connect"] {
  return hasMethod(feature, "connect")
}

export function supportsSuiWallet(wallet: RegisteredWallet): boolean {
  return !!wallet.name?.trim() && wallet.chains?.includes(WALLET_CHAIN)
    && isConnectFeature(wallet.features?.["standard:connect"])
    && Object.entries(SIGN_FEATURES).some(([name, method]) => hasMethod(wallet.features?.[name], method))
}

export function testnetAccount(accounts: readonly WalletAccount[]): WalletAccount | undefined {
  return accounts.find(account => account.chains?.includes(WALLET_CHAIN) && isValidSuiAddress(account.address))
}

export function discoverWalletProviders(wallets: readonly RegisteredWallet[]): WalletProvider[] {
  const providers = new Map<string, WalletProvider>()
  for (const wallet of wallets) {
    if (!supportsSuiWallet(wallet)) continue
    const id = walletProviderId(wallet.name)
    const existing = providers.get(id)
    if (existing) {
      if (!existing.wallets.includes(wallet)) existing.wallets.push(wallet)
    } else providers.set(id, { id, name: wallet.name.trim(), icon: wallet.icon, wallets: [wallet] })
  }
  for (const provider of providers.values()) {
    provider.wallets.sort((a, b) => Number(!!testnetAccount(b.accounts)) - Number(!!testnetAccount(a.accounts))
      || Number(!!b.features["sui:signTransaction"]) - Number(!!a.features["sui:signTransaction"]))
    provider.name = provider.wallets[0].name.trim()
    provider.icon = provider.wallets[0].icon
  }
  return [...providers.values()]
}

export async function connectWalletProvider(provider: WalletProvider): Promise<{ wallet: RegisteredWallet; account: WalletAccount }> {
  for (const wallet of provider.wallets) {
    // `supportsSuiWallet` already proved this feature is callable before the
    // provider was built, so a wallet reaching here without it is a bug in this
    // module, not a user situation to recover from.
    const connect = wallet.features["standard:connect"]
    if (!isConnectFeature(connect)) throw new Error(t("misc.discovery.noConnect"))
    // A rejected connection is final; never reopen another provider prompt after rejection.
    const result = await connect.connect()
    const account = testnetAccount(result?.accounts ?? wallet.accounts)
    if (account) return { wallet, account: { ...account, address: normalizeSuiAddress(account.address) } }
  }
  throw new Error(t("misc.discovery.enableTestnet", { name: provider.name }))
}
