"use client"

import { useState, useEffect, useMemo } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { GroupDetailsDialog } from "@/components/group-details-dialog"
import { motion } from "framer-motion"
import { ArrowRight, Loader2, TrendingUp, Users, Plus, Clock, RefreshCw } from "lucide-react"
import { CreateGroupDialog } from "@/components/create-group-dialog"
import { getActiveAccount, getUserGroups, getProposals, type LocalGroupRecord, type ProposalItem } from "@/lib/onchain-store"
import { readWalletAssets, type WalletAsset } from "@/lib/wallet-data"
import { fetchTokenPrices, formatUsd, totalUsdValue, type PriceSnapshot } from "@/lib/price-feed"
import { discoveredGroupRecord, mergeDiscoveredGroups } from "@/lib/group-discovery"
import { useGroupDiscovery } from "@/lib/use-group-discovery"
import { useI18n } from "@/components/i18n-provider"

export default function Dashboard() {
  const { t, locale } = useI18n()
  const router = useRouter()
  const [selectedGroup, setSelectedGroup] = useState<{ id: string; name: string } | null>(null)
  const [isCreateGroupOpen, setIsCreateGroupOpen] = useState(false)
  const [userGroups, setUserGroups] = useState<LocalGroupRecord[]>([])
  const [proposals, setProposals] = useState<ProposalItem[]>([])
  const [adoptError, setAdoptError] = useState("")
  const [adopted, setAdopted] = useState("")
  const discovery = useGroupDiscovery()

  // Adopting a discovered organization writes only chain facts plus an empty
  // note. It never copies a vault or capability, so nothing is silently granted.
  const adoptGroup = (orgId: string) => {
    setAdoptError(""); setAdopted("")
    const org = discovery.data?.organizations.find(row => row.orgId.toLowerCase() === orgId.toLowerCase())
    if (!org) { setAdoptError(t("dash.discoveryStale")); return }
    if (getUserGroups().some(group => typeof group.orgObjectId === "string" && group.orgObjectId.toLowerCase() === orgId.toLowerCase())) {
      setAdopted(t("dash.alreadySaved")); return
    }
    try {
      const saved = JSON.parse(localStorage.getItem("user_groups") || "[]")
      const next = Array.isArray(saved) ? [...saved, discoveredGroupRecord(org)] : [discoveredGroupRecord(org)]
      localStorage.setItem("user_groups", JSON.stringify(next))
      window.dispatchEvent(new CustomEvent("sui-groups-updated", { detail: next }))
      window.dispatchEvent(new Event("storage"))
      setUserGroups(getUserGroups())
      setAdopted(t("dash.adoptSaved"))
    } catch (cause) {
      setAdoptError(cause instanceof Error ? cause.message : t("dash.saveGroupFailed"))
    }
  }
  // Real RPC balances for the connected account. No USD valuation is computed
  // here: the app has no price feed, and a hardcoded price would be invented.
  const [assets, setAssets] = useState<WalletAsset[]>([])
  const [assetsAddress, setAssetsAddress] = useState("")
  const [assetsLoading, setAssetsLoading] = useState(false)
  const [assetsError, setAssetsError] = useState("")
  const [prices, setPrices] = useState<PriceSnapshot | null>(null)
  useEffect(() => {
    const load = () => { setUserGroups(getUserGroups()); setProposals(getProposals()) }
    load()
    window.addEventListener("storage", load)
    window.addEventListener("sui-groups-updated", load)
    window.addEventListener("sui-proposals-updated", load)
    return () => {
      window.removeEventListener("storage", load)
      window.removeEventListener("sui-groups-updated", load)
      window.removeEventListener("sui-proposals-updated", load)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    const loadAssets = () => {
      const address = getActiveAccount()?.address || ""
      setAssets([]); setAssetsAddress(address); setAssetsError(""); setAssetsLoading(!!address); setPrices(null)
      if (!address) return
      void readWalletAssets(address)
        .then(async rows => {
          if (cancelled || getActiveAccount()?.address !== address) return
          setAssets(rows)
          const snapshot = await fetchTokenPrices(rows)
          if (!cancelled && getActiveAccount()?.address === address) setPrices(snapshot)
        })
        .catch(error => { if (!cancelled) setAssetsError(error instanceof Error ? error.message : t("dash.assetsLoadFailed")) })
        .finally(() => { if (!cancelled) setAssetsLoading(false) })
    }
    loadAssets()
    window.addEventListener("sui-account-switched", loadAssets)
    window.addEventListener("storage", loadAssets)
    return () => {
      cancelled = true
      window.removeEventListener("sui-account-switched", loadAssets)
      window.removeEventListener("storage", loadAssets)
    }
  }, [])

  // 群组列表 = 本机备注 + 链上发现；本机记录永不因发现结果被隐藏。

  // Chain discovery is the membership source; local records stay as a notes overlay.
  const groupRows = useMemo(() => mergeDiscoveredGroups(userGroups, discovery.data), [userGroups, discovery.data])
  const chainOnly = groupRows.filter(row => row.origin === "chain").length
  const membershipUnknown = groupRows.filter(row => row.origin === "local" && row.orgObjectId && row.membership === "unknown").length
  const discoveryFailed = !!discovery.error

  const container = {
    hidden: { opacity: 0 },
    show: {
      opacity: 1,
      transition: {
        staggerChildren: 0.1,
      },
    },
  }

  const item = {
    hidden: { opacity: 0, y: 20 },
    show: { opacity: 1, y: 0 },
  }

  const groupIds = new Set(groupRows.map(group => group.id))
  const orgIds = new Set(groupRows.map(group => group.orgObjectId).filter(Boolean).map(id => id.toLowerCase()))
  const verified = proposals.filter(proposal => (groupIds.has(proposal.groupId) || orgIds.has(String(proposal.orgId || "").toLowerCase())) && proposal.chainSyncedAt && !proposal.syncError)
  const pending = verified.filter(proposal => proposal.status === "pending" && proposal.deadlineMs >= Date.now()).length
  const usdTotal = prices ? totalUsdValue(assets, prices.prices) : null

  return (
    <div className="space-y-4">
      <Card className="rounded-2xl border border-border/60 bg-surface-card shadow-sm overflow-hidden">
        <CardContent className="p-5">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span className="font-medium text-label-secondary">{t("dash.assetsTitle")}</span>
            <div className="h-7 w-7 rounded-full bg-primary/10 flex items-center justify-center text-primary">
              <TrendingUp className="h-3.5 w-3.5" />
            </div>
          </div>
          {assetsLoading ? (
            <p className="mt-2 flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{t("dash.assetsLoading")}</p>
          ) : !assetsAddress ? (
            <p className="mt-2 text-sm text-muted-foreground">{t("dash.assetsConnectFirst")}</p>
          ) : (
            <>
              <p className="mt-2 truncate font-mono text-3xl font-bold tracking-tight text-label-primary">
                {assets[0]?.balance ?? (assetsError ? t("dash.readFailed") : "—")}{" "}
                <span className="text-base font-semibold text-label-secondary">
                  {assets[0]?.symbol ?? (assetsError ? "" : "SUI")}
                </span>
              </p>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {assets.length > 1 ? t("dash.assetsMulti", { count: assets.length, rest: assets.length - 1 }) : t("dash.assetsRpcNote")}
              </p>
              {usdTotal !== null ? (
                <p className="mt-2 text-sm font-medium">≈ {formatUsd(usdTotal)} <span className="text-[11px] font-normal text-muted-foreground">{t("dash.referenceEstimate")} · {prices?.source} · {new Date(prices!.fetchedAt).toLocaleTimeString(locale === "zh" ? "zh-CN" : "en-US")}</span></p>
              ) : null}
            </>
          )}
          {assetsError && <p role="alert" className="mt-2 text-xs text-destructive">{assetsError}</p>}
          <p className="mt-2 text-[11px] text-muted-foreground">
            {usdTotal !== null ? t("dash.assetsUsdNote") : t("dash.assetsNoPriceNote")}
          </p>
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 gap-3">
        <Card className="rounded-2xl border border-border/60 bg-surface-card shadow-sm">
          <CardContent className="p-4">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span className="font-medium text-label-secondary">{t("dash.myGroups")}</span>
              <div className="h-7 w-7 rounded-full bg-primary/10 flex items-center justify-center text-primary">
                <Users className="h-3.5 w-3.5" />
              </div>
            </div>
            <p className="mt-2 text-2xl font-bold tracking-tight text-label-primary">{groupRows.length}</p>
            <p className="mt-1 text-[11px] text-muted-foreground">{t("dash.statVerified", { count: groupRows.filter(group => group.sourceStatus === "chain-confirmed").length })}{chainOnly ? t("dash.statChainSuffix", { count: chainOnly }) : ""}</p>
          </CardContent>
        </Card>
        <Card className="rounded-2xl border border-border/60 bg-surface-card shadow-sm">
          <CardContent className="p-4">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span className="font-medium text-label-secondary">{t("dash.pendingApprovals")}</span>
              <div className="h-7 w-7 rounded-full bg-amber-500/10 flex items-center justify-center text-amber-600 dark:text-amber-400">
                <Clock className="h-3.5 w-3.5" />
              </div>
            </div>
            <p className="mt-2 text-2xl font-bold tracking-tight text-label-primary">{pending}</p>
            <p className="mt-1 text-[11px] text-muted-foreground">{t("dash.syncedProposals", { count: verified.length })}</p>
          </CardContent>
        </Card>
      </div>
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-xl font-bold">{t("dash.myGroups")}</h2>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            aria-label={t("dash.refreshOrgs")}
            disabled={discovery.loading || !discovery.address}
            onClick={discovery.refresh}
          >
            {discovery.loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          </Button>
          <Button
            variant="default"
            size="sm"
            className="bg-primary hover:bg-primary/90 text-primary-foreground shadow-sm"
            onClick={() => setIsCreateGroupOpen(true)}
          >
            <Plus className="h-4 w-4 mr-1" /> {t("dash.newGroup")}
          </Button>
        </div>
      </div>

      {/* Membership discovery is chain state; the local collection is only a
          notes overlay, so an empty local list never means "no groups". */}
      {discovery.address && (
        <p className="text-[11px] text-muted-foreground">
          {discovery.data
            ? discovery.data.truncated
              ? t("dash.discoveryTruncated", { scanned: discovery.data.scannedEvents, found: chainOnly })
              : t("dash.discoveryChecked", { checked: discovery.data.checked.length, found: chainOnly })
            : discovery.loading ? t("dash.discoveryChecking") : discoveryFailed ? "" : t("dash.discoveryNotRun")}
        </p>
      )}
      {discoveryFailed && <p role="alert" className="rounded-lg bg-destructive/10 p-2 text-xs text-destructive">{t("dash.discoveryFailedNote", { error: discovery.error ?? "" })}</p>}
      {!discoveryFailed && membershipUnknown > 0 && <p className="rounded-lg bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-300">{t("dash.membershipUnknownNote", { count: membershipUnknown })}</p>}
      {discovery.data && discovery.data.failures.length > 0 && <p className="rounded-lg bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-300">{t("dash.discoveryFailuresNote", { count: discovery.data.failures.length })}</p>}
      {adoptError && <p role="alert" className="rounded-lg bg-destructive/10 p-2 text-xs text-destructive">{adoptError}</p>}
      {adopted && <p role="status" className="rounded-lg bg-emerald-500/10 p-2 text-xs text-emerald-700 dark:text-emerald-300">{adopted}</p>}

      {!groupRows.length && <div className="rounded-xl border border-dashed bg-muted/20 py-10 text-center"><p className="text-sm font-medium">{discoveryFailed ? t("dash.emptyTitleFailed") : discovery.address ? t("dash.emptyTitleNone") : t("dash.emptyTitleNoAccount")}</p><p className="mt-1 text-xs text-muted-foreground">{discoveryFailed ? t("dash.emptyBodyFailed") : discovery.address ? t("dash.emptyBodyNone") : t("dash.emptyBodyNoAccount")}</p></div>}

      <motion.div className="grid gap-3" variants={container} initial="hidden" animate="show">
        {groupRows.map((group) => (
          <motion.div key={group.id} variants={item}>
            <Card
              className="overflow-hidden rounded-2xl border border-border/60 bg-surface-card shadow-sm hover:shadow-md hover:border-primary/40 transition-all duration-200 cursor-pointer active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              role="button"
              tabIndex={0}
              aria-label={group.name}
              onClick={() => router.push(`/groups/${group.id}`)}
              onKeyDown={(event) => {
                if (event.target === event.currentTarget && ["Enter", " "].includes(event.key)) {
                  event.preventDefault()
                  router.push(`/groups/${group.id}`)
                }
              }}
            >
              <CardHeader className="p-4 pb-0">
                <div className="flex items-start justify-between">
                  <div className="min-w-0">
                    <h3 className="font-semibold text-sm truncate text-label-primary">{group.name}</h3>
                    {group.origin === "chain" && <Badge variant="outline" className="my-1 text-[10px] bg-primary/5 text-primary border-primary/20">{t("dash.badgeChainFound")}</Badge>}
                    {group.origin === "local" && group.sourceStatus === "unverified" && <Badge variant="outline" className="my-1 text-[10px]">{t("dash.badgeLegacyUnverified")}</Badge>}
                    {group.origin === "local" && group.membership === "not-member" && <Badge variant="outline" className="my-1 border-amber-500/30 text-[10px] text-amber-600 dark:text-amber-300">{t("dash.badgeNotInRoster")}</Badge>}
                    <p className="text-xs text-muted-foreground">{group.network} Network</p>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="p-4 pt-2">
                <div className="flex items-center justify-between mb-1.5">
                  <div className="text-xs text-muted-foreground flex items-center">
                    <Users className="h-3.5 w-3.5 mr-1 text-primary/70" />
                    {t("dash.memberCount", { count: group.memberCount ?? group.members.length })}
                  </div>
                  <div className="font-medium text-sm text-label-primary">
                    {t("dash.threshold", { value: group.threshold ?? "—" })}
                  </div>
                </div>
                {group.myWeight !== null && <p className="mb-1 text-[11px] text-muted-foreground">{t("dash.myWeight", { value: group.myWeight })}</p>}
                <div className="mt-3 flex items-center justify-between">
                  <div className="flex -space-x-2">
                    {group.members.slice(0, 3).map((member, i) => (
                      <Avatar key={member.address || i} className="border-2 border-background h-6 w-6" title={member.name || member.address}>
                        <AvatarFallback className="text-xs bg-muted text-foreground font-medium border border-border">
                          {member.name?.slice(0, 1) || member.address?.replace(/^0x/, "").slice(0, 2).toUpperCase() || <Users className="h-3 w-3" />}
                        </AvatarFallback>
                      </Avatar>
                    ))}
                    {group.members.length === 0 && group.memberCount !== null && group.memberCount > 0 && (
                      <span className="text-[11px] text-muted-foreground">{t("dash.rosterInDetails")}</span>
                    )}
                    {group.members.length > 3 && (
                      <Avatar className="border-2 border-background h-6 w-6">
                        <AvatarFallback className="text-xs bg-muted">+{group.members.length - 3}</AvatarFallback>
                      </Avatar>
                    )}
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-xs text-primary flex items-center gap-1 rounded-lg active:scale-95 transition-all"
                    aria-haspopup="dialog"
                    onClick={event => { event.stopPropagation(); setSelectedGroup({ id: group.id, name: group.name }) }}
                  >
                    {t("dash.viewDetails")} <ArrowRight className="h-3.5 w-3.5" />
                  </Button>
                </div>
                {group.origin === "chain" && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-2.5 h-7 w-full text-xs rounded-lg active:scale-[0.98]"
                    onClick={event => { event.stopPropagation(); adoptGroup(group.orgObjectId) }}
                  >
                    {t("dash.adoptGroup")}
                  </Button>
                )}
              </CardContent>
            </Card>
          </motion.div>
        ))}
      </motion.div>

      <GroupDetailsDialog
        open={!!selectedGroup}
        onOpenChange={() => setSelectedGroup(null)}
        groupId={selectedGroup?.id || ""}
      />

      <CreateGroupDialog open={isCreateGroupOpen} onOpenChange={setIsCreateGroupOpen} />
    </div>
  )
}
