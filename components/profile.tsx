"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { motion } from "framer-motion"
import { QRCodeSVG } from "qrcode.react"
import Link from "next/link"
import { ArrowDownLeft, Check, ChevronDown, ChevronRight, Copy, ExternalLink, HardDrive, History, Loader2, QrCode, RefreshCw, ShieldCheck, Users, Wallet } from "lucide-react"
import { useI18n } from "@/components/i18n-provider"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { IdentityPanel } from "@/components/identity-panel"
import { safeAvatar } from "@/components/identity-avatar"
import { ShareQrDialog } from "@/components/share-qr-dialog"
import { GroupDetailsDialog } from "@/components/group-details-dialog"
import { getActiveAccount, getUserGroups } from "@/lib/onchain-store"
import { useTheme } from "next-themes"
import { mergeDiscoveredGroups } from "@/lib/group-discovery"
import { useGroupDiscovery } from "@/lib/use-group-discovery"
import { reverseResolveSuiNSName } from "@/lib/suins"
import type { IdentityProfile } from "@/lib/identity-client"
import { readWalletActivity, readWalletAssets, type WalletActivity, type WalletAsset } from "@/lib/wallet-data"
import { fetchTokenPrices, formatChange, formatUsd, totalUsdValue, type PriceSnapshot } from "@/lib/price-feed"

type Account = NonNullable<ReturnType<typeof getActiveAccount>>
const shortAddress = (address: string) => `${address.slice(0, 8)}…${address.slice(-6)}`
const tokenColors = ["bg-indigo-500", "bg-fuchsia-500", "bg-emerald-500", "bg-sky-500"]

export default function Profile({ onShowGroups }: { onShowGroups?: () => void }) {
  const { t, locale, setLocale } = useI18n()
  const [account, setAccount] = useState<Account | null>(null)
  const [identity, setIdentity] = useState<IdentityProfile | null>(null)
  const [groups, setGroups] = useState<Array<{ id: string; name: string }>>([])
  const [selectedGroup, setSelectedGroup] = useState("")
  const [assets, setAssets] = useState<WalletAsset[]>([])
  const [activities, setActivities] = useState<WalletActivity[]>([])
  const [dataAddress, setDataAddress] = useState("")
  const [assetsLoading, setAssetsLoading] = useState(false)
  const [activityLoading, setActivityLoading] = useState(false)
  const [assetError, setAssetError] = useState("")
  const [prices, setPrices] = useState<PriceSnapshot | null>(null)
  const [activityError, setActivityError] = useState("")
  const [cursor, setCursor] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [notice, setNotice] = useState("")
  const [shareOpen, setShareOpen] = useState(false)
  const [suinsName, setSuinsName] = useState("")
  /** Set when the reverse lookup failed, so the fallback label is not read as "no name". */
  const [suinsError, setSuinsError] = useState("")
  const [shareLink, setShareLink] = useState("")
  const [revision, setRevision] = useState(0)
  // next-themes resolves on the client; `mounted` keeps the control out of the
  // server render so markup stays deterministic.
  const { theme, resolvedTheme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  const discovery = useGroupDiscovery()
  // The same discovery source backs the dashboard list, so the menu counts and
  // the dashboard counts cannot disagree.
  const allGroups = useMemo(() => mergeDiscoveredGroups(groups, discovery.data), [groups, discovery.data])
  const activityRun = useRef(0)
  const loadingMore = useRef(false)

  useEffect(() => {
    const sync = () => {
      const next = getActiveAccount()
      setAccount(current => current?.address === next?.address && current?.identifier === next?.identifier ? current : next)
      setGroups(getUserGroups())
    }
    sync()
    window.addEventListener("storage", sync)
    window.addEventListener("sui-account-switched", sync)
    window.addEventListener("sui-groups-updated", sync)
    return () => {
      window.removeEventListener("storage", sync)
      window.removeEventListener("sui-account-switched", sync)
      window.removeEventListener("sui-groups-updated", sync)
    }
  }, [])

  const address = account?.address || ""
  const visibleAssets = dataAddress === address ? assets : []
  const visibleActivities = dataAddress === address ? activities : []
  const profile = identity?.address.toLowerCase() === address.toLowerCase() ? identity : null
  const name = profile?.displayName || (profile ? `${profile.label}.id` : suinsName || account?.identifier || t("profile.personalAccount"))

  // The wallet's own default .sui name, verified to still resolve back to it.
  // Presentation only: a minted protocol identity takes precedence.
  useEffect(() => {
    setSuinsName("")
    setSuinsError("")
    if (!address || profile) return
    let cancelled = false
    void reverseResolveSuiNSName(address)
      .then(value => { if (!cancelled) setSuinsName(value ?? "") })
      .catch(error => { if (!cancelled) setSuinsError(error instanceof Error ? error.message : t("profile.suinsLookupFailed")) })
    return () => { cancelled = true }
  }, [address, profile])

  useEffect(() => {
    setShareOpen(false); setNotice(""); setIdentity(null)
    if (!address) { setShareLink(""); return }
    const url = new URL("/", window.location.origin)
    url.searchParams.set("person", address)
    setShareLink(url.toString())
  }, [address])

  useEffect(() => {
    let cancelled = false
    const run = ++activityRun.current
    loadingMore.current = false
    setAssets([]); setActivities([]); setDataAddress(address)
    setAssetError(""); setActivityError(""); setCursor(null); setHasMore(false); setPrices(null)
    setAssetsLoading(!!address); setActivityLoading(!!address)
    if (!address) return
    void readWalletAssets(address).then(async value => {
      if (cancelled) return
      setAssets(value)
      const snapshot = await fetchTokenPrices(value)
      if (!cancelled) setPrices(snapshot)
    })
      .catch(error => { if (!cancelled) setAssetError(error instanceof Error ? error.message : t("profile.assetsReadFailed")) })
      .finally(() => { if (!cancelled) setAssetsLoading(false) })
    void readWalletActivity(address).then(value => {
      if (!cancelled && run === activityRun.current) { setActivities(value.activities); setCursor(value.cursor); setHasMore(value.hasNextPage) }
    }).catch(error => { if (!cancelled) setActivityError(error instanceof Error ? error.message : t("profile.activityReadFailed")) })
      .finally(() => { if (!cancelled && run === activityRun.current) setActivityLoading(false) })
    const invalidate = () => { activityRun.current++ }
    return () => { cancelled = true; invalidate() }
  }, [address, revision])

  async function loadMore() {
    if (!address || !cursor || loadingMore.current) return
    loadingMore.current = true
    const run = activityRun.current
    setActivityLoading(true); setActivityError("")
    try {
      const page = await readWalletActivity(address, cursor)
      if (run !== activityRun.current) return
      if (page.hasNextPage && (!page.cursor || page.cursor === cursor)) throw new Error(t("profile.activityPageStuck"))
      setActivities(current => [...new Map([...current, ...page.activities].map(item => [item.digest, item])).values()])
      setCursor(page.cursor); setHasMore(page.hasNextPage)
    } catch (error) { if (run === activityRun.current) setActivityError(error instanceof Error ? error.message : t("profile.activityReadFailed")) }
    finally { if (run === activityRun.current) { loadingMore.current = false; setActivityLoading(false) } }
  }

  async function copyAddress() {
    if (!address) return
    try { await navigator.clipboard.writeText(address); setNotice(t("profile.addressCopied")) }
    catch { setNotice(t("profile.copyFailed")) }
  }

  return <div className="space-y-4">
    <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
      <Card className="overflow-hidden border-none shadow-sm">
        <div className="relative h-24 bg-gradient-to-r from-primary to-purple-500"><div className="absolute -right-6 -top-12 h-40 w-40 rounded-full border-[24px] border-white/10" /></div>
        <CardContent className="relative p-4 pt-0">
          <div className="flex items-start justify-between gap-3">
            <Avatar className="-mt-8 h-16 w-16 border-4 border-background shadow-md">
              {profile && safeAvatar(profile.avatarUrl) && <AvatarImage src={profile.avatarUrl} referrerPolicy="no-referrer" className="object-cover" alt={t("profile.avatarAlt")} />}
              <AvatarFallback className="bg-gradient-to-br from-primary to-purple-500 text-xl font-semibold text-white">{address ? name.slice(0, 1).toUpperCase() : <Wallet className="h-6 w-6" />}</AvatarFallback>
            </Avatar>
            <Badge variant="outline" className="mt-3 border-primary/25 text-primary">{t("profile.personalAccount")}</Badge>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild><Button variant="ghost" className="mt-2 h-auto max-w-full justify-start gap-1 p-0 hover:bg-transparent"><span className="truncate text-lg font-bold">{address ? name : t("profile.connectWalletPrompt")}</span><ChevronDown className="h-4 w-4 shrink-0" /></Button></DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-64">
              <DropdownMenuLabel>{t("profile.menuAccountsGroups")}</DropdownMenuLabel>
              <DropdownMenuItem onClick={() => document.getElementById("btn-nav-wallet")?.click()}><Wallet className="mr-2 h-4 w-4" />{t("profile.connectOrSwitch")}</DropdownMenuItem>
              {/* Theme selection lives in the account menu; the choice persists in this browser.
                  Selected state compares `theme` (the stored choice), not `resolvedTheme` —
                  "system" never appears as a resolved value. */}
              <DropdownMenuLabel className="pt-1 text-[11px] font-normal text-muted-foreground">{t("profile.themeLabel")}</DropdownMenuLabel>
              {mounted && (
                <div className="flex gap-1 px-1.5 pb-1" role="group" aria-label={t("profile.themeLabel")}>
                  {([["system", t("profile.themeSystem")], ["light", t("profile.themeLight")], ["dark", t("profile.themeDark")]] as const).map(([value, label]) => (
                    <Button key={value} size="sm" variant={theme === value ? "secondary" : "outline"} className="h-7 flex-1 px-1 text-xs" aria-pressed={theme === value} onClick={() => setTheme(value)}>
                      {value === "system" ? (resolvedTheme === "dark" ? t("profile.themeSystemDark") : t("profile.themeSystemLight")) : label}
                    </Button>
                  ))}
                </div>
              )}
              <DropdownMenuLabel className="pt-1 text-[11px] font-normal text-muted-foreground">{t("profile.languageLabel")}</DropdownMenuLabel>
              {mounted && (
                <div className="flex gap-1 px-1.5 pb-1" role="group" aria-label={t("profile.languageLabel")}>
                  <Button size="sm" variant={locale === "en" ? "secondary" : "outline"} className="h-7 flex-1 px-1 text-xs" aria-pressed={locale === "en"} onClick={() => setLocale("en")}>English</Button>
                  <Button size="sm" variant={locale === "zh" ? "secondary" : "outline"} className="h-7 flex-1 px-1 text-xs" aria-pressed={locale === "zh"} onClick={() => setLocale("zh")}>中文</Button>
                </div>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={onShowGroups}><Users className="mr-2 h-4 w-4" />{t("profile.myGroupsCount", { count: allGroups.length })}</DropdownMenuItem>
              {allGroups.map(group => <DropdownMenuItem key={group.id} onClick={() => setSelectedGroup(group.id)}><span className="truncate">{group.name}</span>{group.origin === "chain" && <Badge variant="outline" className="ml-2 text-[10px]">{t("profile.chainBadge")}</Badge>}</DropdownMenuItem>)}
            </DropdownMenuContent>
          </DropdownMenu>
          <div className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
            <span className="min-w-0 truncate font-mono">{address ? shortAddress(address) : t("profile.loginHint")}</span>
            {address && <><Button size="icon" variant="ghost" className="h-7 w-7" aria-label={t("profile.copyAddressAria")} onClick={() => void copyAddress()}><Copy className="h-3.5 w-3.5" /></Button><Button size="icon" variant="ghost" className="h-7 w-7" aria-label={t("profile.viewOnExplorerAria")} asChild><a href={`https://suiscan.xyz/testnet/account/${address}`} target="_blank" rel="noreferrer"><ExternalLink className="h-3.5 w-3.5" /></a></Button></>}
          </div>
          {suinsError && <p role="status" className="mt-1 text-[11px] text-amber-600">{t("profile.suinsErrorNote", { error: suinsError })}</p>}
          <div className="mt-3 flex gap-2">
            <Button size="sm" variant="outline" className="flex-1 rounded-lg" disabled={!address} onClick={() => document.getElementById("profile-receive")?.scrollIntoView({ behavior: "smooth", block: "center" })}><ArrowDownLeft className="mr-1.5 h-4 w-4" />{t("profile.receive")}</Button>
            <Button size="sm" variant="outline" className="flex-1 rounded-lg" disabled={!address} onClick={() => setShareOpen(true)}><QrCode className="mr-1.5 h-4 w-4" />{t("profile.businessCard")}</Button>
            <Button size="sm" variant="outline" className="rounded-lg" onClick={onShowGroups}><Users className="mr-1.5 h-4 w-4" />{t("profile.groupsBtn")}</Button>
          </div>
          {notice && <p role="status" className="mt-2 text-xs text-primary">{notice}</p>}
        </CardContent>
      </Card>
    </motion.div>

    <Card id="profile-receive" className="scroll-mt-20 overflow-hidden border-none shadow-sm">
      <CardHeader className="p-4 pb-2"><h2 className="text-sm font-semibold">{t("profile.qrTitle")}</h2></CardHeader>
      <CardContent className="p-4 pt-1">
        <Tabs defaultValue="receive">
          <TabsList className="grid w-full grid-cols-2 rounded-xl bg-muted/50"><TabsTrigger value="receive" className="rounded-lg text-xs">{t("profile.tabReceiveAddress")}</TabsTrigger><TabsTrigger value="identity" className="rounded-lg text-xs">{t("profile.tabBusinessCard")}</TabsTrigger></TabsList>
          {[{ key: "receive", value: address, label: t("profile.qrReceiveLabel"), caption: t("profile.qrReceiveCaption") }, { key: "identity", value: shareLink, label: t("profile.qrIdentityLabel"), caption: t("profile.qrIdentityCaption") }].map(qr => <TabsContent key={qr.key} value={qr.key} className="mt-4 text-center">
            {qr.value ? <><div className="mx-auto w-fit rounded-xl bg-white p-3 shadow-sm ring-1 ring-black/5"><QRCodeSVG value={qr.value} size={144} level="M" marginSize={2} title={qr.label} /></div><p className="mt-3 break-all font-mono text-xs text-muted-foreground">{address}</p><p className="mt-1 text-xs text-muted-foreground">{qr.caption}</p></> : <div className="flex flex-col items-center gap-2 py-6 text-muted-foreground"><QrCode className="h-10 w-10 opacity-40" /><p className="text-sm">{t("profile.qrConnectFirst")}</p></div>}
            {qr.key === "receive" ? <Button size="sm" variant="ghost" className="mt-2 text-primary" disabled={!address} onClick={() => void copyAddress()}><Copy className="mr-1 h-3.5 w-3.5" />{t("profile.copyReceiveAddress")}</Button> : <Button size="sm" variant="ghost" className="mt-2 text-primary" disabled={!address} onClick={() => setShareOpen(true)}>{t("profile.shareQr")}</Button>}
          </TabsContent>)}
        </Tabs>
      </CardContent>
    </Card>

    <Card className="border-none shadow-sm">
      <CardHeader className="flex-row items-center justify-between space-y-0 p-4 pb-1"><h2 className="text-sm font-semibold">{t("profile.assetsTitle")}</h2><Button size="icon" variant="ghost" className="h-7 w-7" aria-label={t("profile.refreshAssetsAria")} disabled={!address || assetsLoading || activityLoading} onClick={() => setRevision(value => value + 1)}><RefreshCw className={`h-3.5 w-3.5 ${assetsLoading ? "animate-spin" : ""}`} /></Button></CardHeader>
      <CardContent className="p-3 pt-1">
        {assetError && <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">{assetError}</p>}
        {!assetsLoading && visibleAssets.length > 0 && (() => {
          const total = prices ? totalUsdValue(visibleAssets, prices.prices) : null
          return <p className="px-2.5 pb-1 text-xs text-muted-foreground">{total !== null ? t("profile.assetsUsdTotal", { total: formatUsd(total), source: prices?.source ?? "", time: new Date(prices!.fetchedAt).toLocaleTimeString(locale === "zh" ? "zh-CN" : "en-US") }) : t("profile.assetsNoPrice")}</p>
        })()}
        {assetsLoading ? <p role="status" className="flex items-center gap-2 p-3 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{t("profile.assetsLoading")}</p> : visibleAssets.map((asset, index) => {
          const price = prices?.prices[asset.coinType]
          const fiat = price && asset.decimals !== null ? Number(asset.rawBalance) / 10 ** asset.decimals * price.usd : null
          const change = formatChange(price?.change24h ?? null)
          return <motion.div key={asset.coinType} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(index, 8) * 0.03 }} className="flex items-center gap-3 rounded-xl p-2.5 transition-colors hover:bg-muted/50">
          <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white ${tokenColors[index % tokenColors.length]}`}>{asset.symbol.slice(0, 4)}</div>
          <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{asset.name || asset.symbol}</p><a href={`https://suiscan.xyz/testnet/coin/${asset.coinType}`} target="_blank" rel="noreferrer" className="block truncate text-xs text-muted-foreground" title={asset.coinType}>{asset.symbol} · {asset.coinType.slice(0, 6)}…{asset.coinType.split("::").at(-1)}</a></div>
          <div className="min-w-0 max-w-[48%] text-right"><p className="break-all font-mono text-sm font-medium tabular-nums">{asset.balance}</p>{fiat !== null && <p className="text-xs text-muted-foreground">{formatUsd(fiat)}{change && <span className={`ml-1 ${price!.change24h! >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-destructive"}`}>{change} 24h</span>}</p>}{fiat === null && <p className="text-xs text-muted-foreground" title={asset.metadataError}>{asset.decimals === null ? t("profile.rawUnitsPendingMeta") : asset.symbol}</p>}</div>
        </motion.div>})}
        {!assetsLoading && !address && <p className="p-3 text-sm text-muted-foreground">{t("profile.assetsConnectFirst")}</p>}
      </CardContent>
    </Card>

    {/* 高级与说明拆到独立页面，保持个人页聚焦 */}
    <Card className="border-none shadow-sm">
      <CardHeader className="p-4 pb-2"><h2 className="text-sm font-semibold">{t("profile.moreTitle")}</h2></CardHeader>
      <CardContent className="p-2 pt-0">
        <Link href="/trust" className="flex items-center gap-3 rounded-xl p-3 transition-colors hover:bg-muted/50">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary"><ShieldCheck className="h-4 w-4" /></div>
          <div className="min-w-0 flex-1"><p className="text-sm font-medium">{t("profile.trustEntry")}</p><p className="text-xs text-muted-foreground">{t("profile.trustEntrySub")}</p></div>
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
        </Link>
        <Link href="/walrus" className="flex items-center gap-3 rounded-xl p-3 transition-colors hover:bg-muted/50">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-amber-500/10 text-amber-600"><HardDrive className="h-4 w-4" /></div>
          <div className="min-w-0 flex-1"><p className="text-sm font-medium">{t("profile.walrusEntry")}</p><p className="text-xs text-muted-foreground">{t("profile.walrusEntrySub")}</p></div>
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
        </Link>
      </CardContent>
    </Card>


    <Card className="border-none shadow-sm">
      <CardHeader className="p-4 pb-2"><h2 className="flex items-center gap-2 text-sm font-semibold"><History className="h-4 w-4 text-primary" />{t("profile.activityTitle")}</h2></CardHeader>
      <CardContent className="p-4 pt-1">
        <Tabs defaultValue="all">
          <TabsList className="grid w-full grid-cols-3 rounded-xl bg-muted/50">{[{ key: "all", label: t("profile.activityAll") }, { key: "approval", label: t("profile.activityApproval") }, { key: "creation", label: t("profile.activityCreation") }].map(tab => <TabsTrigger key={tab.key} value={tab.key} className="rounded-lg text-xs">{tab.label}</TabsTrigger>)}</TabsList>
          {["all", "approval", "creation"].map(tab => <TabsContent key={tab} value={tab} className="mt-3 space-y-1">
            {visibleActivities.filter(item => tab === "all" || item.category === tab).map(item => <a key={item.digest} href={`https://suiscan.xyz/testnet/tx/${item.digest}`} target="_blank" rel="noreferrer" className="flex items-start gap-3 rounded-xl py-3 transition-colors hover:bg-muted/40">
              <div className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${item.success ? "bg-primary/10 text-primary" : "bg-destructive/10 text-destructive"}`}>{item.category === "approval" ? <Check className="h-4 w-4" /> : <History className="h-4 w-4" />}</div>
              <div className="min-w-0 flex-1"><p className="text-sm font-medium">{item.title}<span className={`ml-2 text-xs ${item.success ? "text-muted-foreground" : "text-destructive"}`}>{item.success ? t("profile.activityConfirmed") : t("profile.activityFailed")}</span></p><p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">{item.digest}</p><p className="mt-1 text-xs text-muted-foreground">{item.timestampMs ? new Date(item.timestampMs).toLocaleString(locale === "zh" ? "zh-CN" : "en-US") : t("profile.waitingBlockTime")}</p></div><ExternalLink className="mt-1 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            </a>)}
            {!activityLoading && !activityError && !visibleActivities.some(item => tab === "all" || item.category === tab) && <p className="py-6 text-center text-sm text-muted-foreground">{address ? hasMore ? t("profile.activityNoneInLoaded") : t("profile.activityNone") : t("profile.activityConnectFirst")}</p>}
          </TabsContent>)}
        </Tabs>
        {activityError && <p role="alert" className="mt-3 text-sm text-destructive">{activityError}</p>}
        {activityLoading && <p role="status" className="flex items-center justify-center gap-2 py-3 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" />{t("profile.activityLoading")}</p>}
        {hasMore && <Button size="sm" variant="ghost" className="mt-2 w-full text-primary" disabled={activityLoading} onClick={() => void loadMore()}>{t("profile.loadMoreActivity")}</Button>}
      </CardContent>
    </Card>


    <IdentityPanel onProfileLoaded={setIdentity} />
    <ShareQrDialog open={shareOpen && !!address} onOpenChange={setShareOpen} title={t("profile.shareQrTitle")} kind="person" identifier={address} description={t("profile.shareQrDescription")} />
    {selectedGroup && <GroupDetailsDialog open onOpenChange={open => { if (!open) setSelectedGroup("") }} groupId={selectedGroup} />}
  </div>
}
