"use client"

import { useEffect, useRef, useState } from "react"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { AlertCircle, Copy, ExternalLink, Fingerprint, Loader2, LogOut, RefreshCw, Wallet } from "lucide-react"
import { isValidSuiAddress } from "@mysten/sui/utils"
import { clearLegacyDevKeys } from "@/lib/dev-keystore"
import { beginGoogleZkLogin, clearZkLoginSession, completeManualZkLogin, getZkLoginConfig, publishAccount } from "@/lib/zklogin"
import { connectWalletProvider, discoverWalletProviders, walletProviderId, type WalletProvider } from "@/lib/wallet-discovery"
import { listStoredPasskeys, loginWithPasskey, passkeyErrorMessage, passkeySupported, recoverPasskeyAccount, registerPasskey, removeStoredPasskey, type PasskeyAccount } from "@/lib/passkey"
import { useI18n } from "@/components/i18n-provider"
import { t as tGlobal } from "@/lib/i18n/t"

export interface UserAccount {
  type: "zklogin" | "passkey" | "wallet" | "keystore"
  provider?: string
  identifier: string
  address: string
  epochTtl?: number
  authMethodLabel: string
}
interface ConnectWalletDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onLoginSuccess?: (account: UserAccount) => void
  currentAccount?: UserAccount | null
  currentUser?: UserAccount | null
  onLogout?: () => void
}

const INSTALL_WALLETS = [
  { id: "slush", name: "Slush", url: "https://slush.app/" },
  { id: "suiet", name: "Suiet Wallet", url: "https://suiet.app/" },
  { id: "okx", name: "OKX Wallet", url: "https://www.okx.com/web3" },
  { id: "nightly", name: "Nightly", url: "https://nightly.app/" },
  { id: "martian", name: "Martian Wallet", url: "https://martianwallet.xyz/" },
]
const errorText = (error: unknown) => error instanceof Error ? error.message : tGlobal("misc.cw.connectFailed")

export function isCleanSuiAddress(address: unknown, explicitSuiChain = false): boolean {
  return typeof address === "string" && (explicitSuiChain || address.length === 66) && isValidSuiAddress(address)
}

export function ConnectWalletDialog({ open, onOpenChange, onLoginSuccess, currentAccount, currentUser, onLogout }: ConnectWalletDialogProps) {
  const { t } = useI18n()
  const [tab, setTab] = useState("wallet")
  const [providers, setProviders] = useState<WalletProvider[]>([])
  const [account, setAccount] = useState<UserAccount | null>(currentAccount ?? currentUser ?? null)
  const [pending, setPending] = useState("")
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [google, setGoogle] = useState<{ enabled: boolean; error?: string } | null>(null)
  const [passkeys, setPasskeys] = useState<ReturnType<typeof listStoredPasskeys>>([])
  const [passkeyReady, setPasskeyReady] = useState(false)
  const [manualJwt, setManualJwt] = useState("")
  const generation = useRef(0)
  const connecting = useRef(false)

  useEffect(() => {
    setManualJwt("")
  }, [tab])

  useEffect(() => {
    const sync = () => {
      clearLegacyDevKeys()
      try {
        const stored = JSON.parse(localStorage.getItem("sui_active_account") ?? "null")
        setAccount(stored && isCleanSuiAddress(stored.address) ? stored : null)
      } catch { setAccount(null) }
    }
    sync()
    window.addEventListener("sui-account-switched", sync)
    window.addEventListener("storage", sync)
    return () => { window.removeEventListener("sui-account-switched", sync); window.removeEventListener("storage", sync) }
  }, [])

  useEffect(() => {
    if (currentAccount !== undefined) setAccount(currentAccount)
    else if (currentUser !== undefined) setAccount(currentUser)
  }, [currentAccount, currentUser])

  useEffect(() => {
    const run = ++generation.current
    setError(""); setNotice(""); setPending("")
    if (!open) {
      setManualJwt("")
      return
    }
    let disposed = false
    let unsubscribers: Array<() => void> = []
    import("@mysten/wallet-standard").then(({ getWallets }) => {
      if (disposed) return
      const registry = getWallets()
      const refresh = () => { if (!disposed) setProviders(discoverWalletProviders(registry.get())) }
      unsubscribers = [registry.on("register", refresh), registry.on("unregister", refresh)]
      refresh()
    }).catch(() => { if (!disposed) setError(tGlobal("misc.cw.detectFailed")) })
    getZkLoginConfig().then(config => { if (!disposed && run === generation.current) setGoogle(config) })
    setPasskeyReady(passkeySupported())
    setPasskeys(listStoredPasskeys())
    const invalidate = () => { generation.current++ }
    return () => { disposed = true; invalidate(); unsubscribers.forEach(unsubscribe => unsubscribe()) }
  }, [open])

  const refreshWallets = async () => {
    try {
      const { getWallets } = await import("@mysten/wallet-standard")
      setProviders(discoverWalletProviders(getWallets().get()))
    } catch { setError(tGlobal("misc.cw.detectFailed")) }
  }

  async function connect(provider: WalletProvider) {
    if (connecting.current) return
    connecting.current = true
    const run = generation.current
    setPending(provider.id); setError(""); setNotice("")
    try {
      const { wallet, account: connected } = await connectWalletProvider(provider)
      if (run !== generation.current) return
      const next: UserAccount = { type: "wallet", provider: wallet.name, identifier: wallet.name, address: connected.address, authMethodLabel: `${wallet.name} · Sui testnet` }
      clearZkLoginSession()
      publishAccount({ ...next })
      setAccount(next)
      onLoginSuccess?.(next)
      onOpenChange(false)
    } catch (error) { if (run === generation.current) setError(errorText(error)) }
    finally { connecting.current = false; if (run === generation.current) setPending("") }
  }

  async function googleLogin() {
    if (connecting.current) return
    connecting.current = true
    setPending("google"); setError("")
    try { await beginGoogleZkLogin() }
    catch (error) { setError(errorText(error)); setPending("") }
    finally { connecting.current = false }
  }

  async function manualZkLogin() {
    if (connecting.current) return
    connecting.current = true
    setPending("zklogin-manual"); setError(""); setNotice("")
    try {
      const signedIn = await completeManualZkLogin(manualJwt)
      setManualJwt("")
      setAccount(signedIn)
      onLoginSuccess?.(signedIn)
      onOpenChange(false)
    } catch (error) { setError(errorText(error)) }
    finally { connecting.current = false; setPending("") }
  }

  // Choosing another identity drops any pending or held zkLogin session, which
  // would otherwise be stale. zkLogin completion calls publishAccount itself.
  function finishPasskeyLogin(next: PasskeyAccount) {
    clearZkLoginSession()
    publishAccount({ ...next })
    setAccount(next)
    onLoginSuccess?.(next)
    onOpenChange(false)
  }

  async function createPasskey() {
    if (connecting.current) return
    connecting.current = true
    setPending("passkey"); setError(""); setNotice("")
    try {
      if (!passkeySupported()) throw new Error(tGlobal("misc.cw.passkeyUnsupported"))
      const { account: next } = await registerPasskey()
      // Prove the fresh credential signs for the derived address before connecting.
      finishPasskeyLogin(await loginWithPasskey(next.address))
    } catch (error) { setError(passkeyErrorMessage(error)) }
    finally { connecting.current = false; setPending(""); setPasskeys(listStoredPasskeys()) }
  }

  async function loginPasskey(address: string) {
    if (connecting.current) return
    connecting.current = true
    setPending("passkey"); setError(""); setNotice("")
    try { finishPasskeyLogin(await loginWithPasskey(address)) }
    catch (error) { setError(passkeyErrorMessage(error)) }
    finally { connecting.current = false; setPending(""); setPasskeys(listStoredPasskeys()) }
  }

  async function recoverPasskey() {
    if (connecting.current) return
    connecting.current = true
    setPending("passkey"); setError(""); setNotice("")
    try {
      const record = await recoverPasskeyAccount()
      finishPasskeyLogin(await loginWithPasskey(record.suiAddress))
    } catch (error) { setError(passkeyErrorMessage(error)) }
    finally { connecting.current = false; setPending(""); setPasskeys(listStoredPasskeys()) }
  }

  function forgetPasskey(address: string) {
    removeStoredPasskey(address)
    setPasskeys(listStoredPasskeys())
    setNotice(t("misc.cw.passkeyRemoved"))
  }

  function logout() {
    clearZkLoginSession()
    publishAccount(null)
    setAccount(null)
    onLogout?.()
  }

  const installSuggestions = INSTALL_WALLETS.filter(item => !providers.some(provider => provider.id === walletProviderId(item.name)))

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-h-[90dvh] w-[calc(100%-2rem)] max-w-[420px] overflow-y-auto rounded-2xl p-5">
      <DialogHeader>
        <DialogTitle>{account ? t("misc.cw.titleAccount") : t("misc.cw.titleLogin")}</DialogTitle>
        <DialogDescription>{t("misc.cw.subtitle")}</DialogDescription>
      </DialogHeader>
      {error && <p role="alert" className="flex items-start gap-2 rounded-lg bg-destructive/10 p-3 text-xs text-destructive"><AlertCircle className="h-4 w-4 shrink-0" />{error}</p>}
      {notice && <p role="status" className="text-xs text-muted-foreground">{notice}</p>}
      {pending && <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{pending === "google" ? t("misc.cw.pendingGoogle") : pending === "zklogin-manual" ? t("misc.cw.pendingManual") : pending === "passkey" ? t("misc.cw.pendingPasskey") : t("misc.cw.pendingWallet")}</p>}
      {account ? <div className="space-y-3 rounded-xl border p-3">
        <p className="text-sm font-medium">{account.identifier}</p>
        <p className="break-all font-mono text-xs text-muted-foreground">{account.address}</p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={async () => { try { await navigator.clipboard.writeText(account.address); setNotice(t("misc.cw.copied")) } catch { setError(t("misc.cw.copyFailed")) } }}><Copy className="mr-1 h-3 w-3" />{t("misc.cw.copyAddress")}</Button>
          <Button size="sm" variant="outline" asChild><a href={`https://suiscan.xyz/testnet/account/${account.address}`} target="_blank" rel="noreferrer"><ExternalLink className="mr-1 h-3 w-3" />{t("misc.cw.viewAccount")}</a></Button>
          <Button size="sm" variant="ghost" onClick={logout}><LogOut className="mr-1 h-3 w-3" />{t("misc.cw.logout")}</Button>
        </div>
        <p className="text-xs text-muted-foreground">{account.type === "passkey" ? t("misc.cw.hintPasskey") : account.type === "zklogin" ? t("misc.cw.hintZklogin") : account.type === "keystore" ? t("misc.cw.hintKeystore") : t("misc.cw.hintWallet")}</p>
      </div> : <Tabs value={tab} onValueChange={value => { setTab(value); setError(""); setNotice("") }}>
        <TabsList className="grid h-auto w-full grid-cols-3">
          <TabsTrigger id="tab-wallet" value="wallet" className="text-xs">{t("misc.cw.tabWallet")}</TabsTrigger>
          <TabsTrigger id="tab-passkey" value="passkey" className="text-xs">{t("misc.cw.tabPasskey")}</TabsTrigger>
          <TabsTrigger id="tab-zklogin" value="zklogin" className="text-xs">Google</TabsTrigger>
        </TabsList>
        <TabsContent value="wallet" className="mt-4 space-y-4">
          <section className="space-y-2" aria-label={t("misc.cw.detectedAria")}>
            <div className="flex items-center justify-between"><p className="text-xs font-medium text-muted-foreground">{t("misc.cw.walletsTitle")}</p><Button size="icon" variant="ghost" aria-label={t("misc.cw.redetectAria")} disabled={!!pending} className="h-7 w-7" onClick={() => void refreshWallets()}><RefreshCw className="h-3.5 w-3.5" /></Button></div>
            {providers.length ? providers.map(provider => <Button data-wallet-provider={provider.id} key={provider.id} variant="outline" disabled={!!pending} onClick={() => void connect(provider)} className="flex h-12 w-full justify-between rounded-xl px-3">
              {/* A wallet's icon is a data: URL or a URL to its own extension
                  asset; `next/image` cannot optimise either and would require a
                  build-time host list that no wallet registration provides. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <span className="flex min-w-0 items-center gap-2.5">{provider.icon ? <img src={provider.icon} alt="" className="h-5 w-5 object-contain" /> : <Wallet className="h-5 w-5 text-primary" />}<span className="truncate text-sm">{provider.name}</span></span><span className="text-xs text-primary">{t("misc.cw.connect")}</span>
            </Button>) : <p className="rounded-xl bg-muted/40 p-3 text-xs leading-relaxed text-muted-foreground">{t("misc.cw.noWallets")}</p>}
          </section>
          {installSuggestions.length > 0 && <section className="space-y-2" aria-label={t("misc.cw.installableAria")}><p className="text-xs font-medium text-muted-foreground">{t("misc.cw.installableTitle")}</p>{installSuggestions.map(item => <a key={item.id} href={item.url} target="_blank" rel="noreferrer" className="flex items-center justify-between rounded-xl border px-3 py-3 text-sm"><span>{item.name}</span><span className="flex items-center gap-1 text-xs text-primary">{t("misc.cw.visitSite")}<ExternalLink className="h-3 w-3" /></span></a>)}</section>}
        </TabsContent>
        <TabsContent value="passkey" className="mt-4 space-y-3">
          <Button id="btn-login-passkey" variant="outline" disabled={!!pending || !passkeyReady} onClick={() => void createPasskey()} className="w-full"><Fingerprint className="mr-2 h-4 w-4" />{passkeys.length ? t("misc.cw.createPasskeyNew") : t("misc.cw.createPasskeyFirst")}</Button>
          {!passkeyReady && <p className="rounded-lg bg-muted/40 p-3 text-xs leading-relaxed text-muted-foreground">{t("misc.cw.passkeyNotReady")}</p>}
          {passkeys.length > 0 && <section className="space-y-2" aria-label={t("misc.cw.localPasskeysAria")}>
            <p className="text-xs font-medium text-muted-foreground">{t("misc.cw.localPasskeysTitle")}</p>
            {passkeys.map(record => <div key={record.suiAddress} className="rounded-xl border p-3">
              <div className="flex items-center justify-between gap-2">
                <button data-passkey-address={record.suiAddress} disabled={!!pending} onClick={() => void loginPasskey(record.suiAddress)} className="min-w-0 flex-1 text-left">
                  <span className="block truncate text-sm">{record.identifier}</span>
                  <span className="block break-all font-mono text-[10px] text-muted-foreground">{record.suiAddress}</span>
                </button>
                <Button size="sm" variant="ghost" disabled={!!pending} onClick={() => forgetPasskey(record.suiAddress)} aria-label={t("misc.cw.removeAria")}>{t("misc.cw.remove")}</Button>
              </div>
            </div>)}
          </section>}
          <Button id="btn-recover-passkey" variant="outline" disabled={!!pending || !passkeyReady} onClick={() => void recoverPasskey()} className="w-full">{t("misc.cw.recoverPasskey")}</Button>
          <p className="text-xs leading-relaxed text-muted-foreground">{t("misc.cw.passkeyPrivacy")}</p>
        </TabsContent>
        <TabsContent value="zklogin" className="mt-4 space-y-3">
          <Button id="btn-login-google" variant="outline" disabled={!!pending || google?.enabled !== true} onClick={() => void googleLogin()} className="w-full">{t("misc.cw.googleContinue")}</Button>
          {google?.enabled !== true && <p className="break-words rounded-lg bg-muted/40 p-3 text-xs leading-relaxed text-muted-foreground">{google?.error || t("misc.cw.googleChecking")}</p>}
          {google?.enabled === true && <div className="space-y-2 rounded-lg border p-3">
            <p className="text-xs font-medium">{t("misc.cw.manualTitle")}</p>
            <p className="text-[11px] leading-relaxed text-muted-foreground">{t("misc.cw.manualHint")}</p>
            <textarea id="input-zklogin-jwt" value={manualJwt} onChange={event => setManualJwt(event.target.value)} rows={3} spellCheck={false} placeholder="eyJhbGciOiJSUzI1NiIs…" className="w-full rounded-md border border-input bg-background p-2 font-mono text-[10px]" />
            <Button id="btn-zklogin-manual" variant="outline" disabled={!!pending || !manualJwt.trim()} onClick={() => void manualZkLogin()} className="w-full">{t("misc.cw.manualLogin")}</Button>
          </div>}
        </TabsContent>
      </Tabs>}
    </DialogContent>
  </Dialog>
}
