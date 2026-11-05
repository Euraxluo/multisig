"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { motion } from "framer-motion"
import {
  TrendingUp, Clock, Plus, ShieldCheck, Zap, ShieldAlert, ArrowRight, Flame, RefreshCw, Coins, Landmark, EyeOff, ExternalLink,
} from "lucide-react"
import { AgentDetailsDialog } from "@/components/agent-details-dialog"
import { CreateAgentDialog } from "@/components/create-agent-dialog"
import { AdjustBudgetDialog } from "@/components/adjust-budget-dialog"
import { ExportConfigDialog } from "@/components/export-config-dialog"
import { EmergencyLiquidationDialog } from "@/components/emergency-liquidation-dialog"
import { AgentVaultActionDialog, createAgentVault, type VaultAction } from "@/components/agent-vault-actions-dialog"
import { SpendDialog } from "@/components/agent-spend-dialog"
import { formatSuiUnits, parseLegacyAgentRecords, createAgentVaultWriters } from "@/lib/agent-vault-chain"
import { submitAgentTransaction } from "@/lib/agent-vault-transactions"
import { remainingBudget, useAgentVault } from "@/lib/use-agent-vault"
import { useI18n } from "@/components/i18n-provider"
import type { AgentCapView, AgentVaultView } from "@/types/agent"

const STATUS_LABEL: Record<AgentCapView["status"], string> = {
  ACTIVE: "agents.statusActive", QUOTA_REACHED: "agents.statusQuotaReached", PAUSED: "agents.statusPaused", REVOKED: "agents.statusRevoked", STALE: "agents.statusStale", UNVERIFIED: "agents.statusUnverified",
}
const STATUS_CLASS: Record<AgentCapView["status"], string> = {
  ACTIVE: "bg-emerald-500/10 text-emerald-500 border-emerald-500/20",
  QUOTA_REACHED: "bg-amber-500/10 text-amber-500 border-amber-500/20",
  PAUSED: "bg-muted text-muted-foreground",
  REVOKED: "bg-red-500/10 text-red-500 border-red-500/20",
  STALE: "bg-red-500/10 text-red-500 border-red-500/20",
  UNVERIFIED: "bg-muted text-muted-foreground",
}

interface LegacyHistory { cards: number; logs: number; names: string[] }

export default function AgentGuard() {
  const { t } = useI18n()
  const vault = useAgentVault()
  const [selectedCap, setSelectedCap] = useState<AgentCapView | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [adjustCap, setAdjustCap] = useState<AgentCapView | null>(null)
  const [exportCap, setExportCap] = useState<AgentCapView | null>(null)
  const [spendCap, setSpendCap] = useState<AgentCapView | null>(null)
  const [purgeVault, setPurgeVault] = useState<AgentVaultView | null>(null)
  const [vaultAction, setVaultAction] = useState<VaultAction | null>(null)
  const [actionVault, setActionVault] = useState<AgentVaultView | null>(null)
  const [busy, setBusy] = useState("")
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [legacy, setLegacy] = useState<LegacyHistory>({ cards: 0, logs: 0, names: [] })
  const [showLegacy, setShowLegacy] = useState(false)
  const generation = useRef(0)

  useEffect(() => {
    try {
      const parsed = (key: string) => { const raw = localStorage.getItem(key); try { const value = JSON.parse(raw || "[]"); return Array.isArray(value) ? value : [] } catch { return [] } }
      const records = parseLegacyAgentRecords(parsed("sui_agent_cards"), parsed("sui_agent_logs"))
      setLegacy({ cards: records.cards.length, logs: records.logs, names: records.cards.map(record => record.name).slice(0, 6) })
    } catch { setLegacy({ cards: 0, logs: 0, names: [] }) }
  }, [])

  // Keep the open dialog bound to a fresh chain read after every reload.
  const allCaps = useMemo(() => vault.vaults.flatMap(row => row.caps), [vault.vaults])
  useEffect(() => {
    if (selectedCap) setSelectedCap(allCaps.find(cap => cap.capId === selectedCap.capId) ?? null)
    if (adjustCap) setAdjustCap(allCaps.find(cap => cap.capId === adjustCap.capId) ?? null)
    if (exportCap) setExportCap(allCaps.find(cap => cap.capId === exportCap.capId) ?? null)
    if (spendCap) setSpendCap(allCaps.find(cap => cap.capId === spendCap.capId) ?? null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allCaps])

  const totalBalance = vault.vaults.reduce((sum, row) => sum + row.balanceUnits, 0n)
  const epochSpent = allCaps.reduce((sum, cap) => sum + cap.effectiveSpentUnits, 0n)
  // A sum over zero verified vaults is not a balance of zero; show the absence instead.
  const balanceLabel = vault.vaults.length ? `${formatSuiUnits(totalBalance)}` : "—"
  const spentLabel = allCaps.length ? formatSuiUnits(epochSpent) : "—"
  const pausedCaps = allCaps.filter(cap => cap.status === "PAUSED" || cap.status === "STALE").length
  const spendRows = allCaps.flatMap(cap => cap.spends.map(row => ({ ...row, cap })))
    .sort((a, b) => (b.timestampMs ?? 0) - (a.timestampMs ?? 0)).slice(0, 6)

  const run = async (label: string, task: () => Promise<void>) => {
    const current = ++generation.current
    setBusy(label); setError(""); setNotice("")
    try { await task() }
    catch (cause) { if (current === generation.current) setError(cause instanceof Error ? cause.message : t("agents.operationFailed")) }
    finally { if (current === generation.current) setBusy("") }
  }

  const handleCreateVault = () => run("vault", async () => {
    const created = await createAgentVault()
    setNotice(t("agents.guard.vaultCreated", { vaultId: created.vaultId, masterCapId: created.masterCapId, digest: created.digest }))
    await vault.reload()
  })

  const handleInitializeVault = (action: VaultAction, target: AgentVaultView) => { setActionVault(target); setVaultAction(action) }

  const container = { hidden: { opacity: 0 }, show: { opacity: 1, transition: { staggerChildren: 0.08 } } }
  const item = { hidden: { opacity: 0, y: 15 }, show: { opacity: 1, y: 0 } }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-xl font-bold tracking-tight">{t("agents.guard.title")}</h2>
            <Badge variant="outline" className="border-primary/20 bg-primary/10 text-xs text-primary">
              {t("common.testnetBadge")}
            </Badge>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t("agents.guard.subtitle")}
          </p>
        </div>
        <div className="flex shrink-0 gap-1">
          <Button size="sm" variant="ghost" className="h-8 px-2 text-xs" disabled={vault.loading || !!busy} onClick={() => void vault.reload()}>
            <RefreshCw className={`h-3.5 w-3.5 ${vault.loading ? "animate-spin" : ""}`} />
          </Button>
          <Button size="sm" className="gap-1 bg-primary text-xs text-primary-foreground hover:bg-primary/90"
            onClick={() => setCreateOpen(true)}>
            <Plus className="h-3.5 w-3.5" /> {t("agents.guard.issueCard")}
          </Button>
        </div>
      </div>

      {!vault.account && !vault.loading && (
        <p role="status" className="rounded-lg border p-3 text-xs text-muted-foreground">{t("agents.guard.connectFirst")}</p>
      )}
      {vault.loading && <p role="status" className="rounded-lg border p-3 text-xs text-muted-foreground">{t("agents.guard.verifying")}</p>}
      {vault.error && <p role="alert" className="break-all rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">{vault.error}</p>}
      {!!vault.errors.length && <div role="alert" className="space-y-1 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-700 dark:text-amber-400">{vault.errors.map((row, index) => <p key={`${row}:${index}`} className="break-all">{row}</p>)}</div>}
      {error && <p role="alert" className="break-all rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">{error}</p>}
      {notice && <p role="status" className="break-all rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 text-xs text-emerald-700 dark:text-emerald-400">{notice}</p>}

      <div className="grid grid-cols-3 gap-2">
        <Card className="cursor-pointer border border-border/50 bg-card/60 transition-all hover:shadow-md" onClick={() => setCreateOpen(true)}>
          <CardContent className="flex flex-col items-center justify-center p-2.5 text-center">
            <div className="mb-1.5 flex h-8 w-8 items-center justify-center rounded-full bg-primary text-white shadow-xs"><Plus className="h-4 w-4" /></div>
            <span className="text-xs font-bold">{t("agents.guard.newCard")}</span>
            <span className="text-xs text-muted-foreground">{t("agents.guard.newCardHint")}</span>
          </CardContent>
        </Card>
        <Card className={`border border-border/50 bg-card/60 transition-all ${allCaps.length ? "cursor-pointer hover:shadow-md" : "opacity-60"}`}
          onClick={() => (allCaps.length ? setSpendCap(allCaps.find(cap => cap.status === "ACTIVE") ?? allCaps[0]) : setNotice(t("agents.guard.noCapsYet")))}>
          <CardContent className="flex flex-col items-center justify-center p-2.5 text-center">
            <div className="mb-1.5 flex h-8 w-8 items-center justify-center rounded-full bg-amber-500 text-white shadow-xs"><Zap className="h-4 w-4" /></div>
            <span className="text-xs font-bold">{t("agents.guard.spendTitle")}</span>
            <span className="text-xs text-muted-foreground">{t("agents.guard.spendHint")}</span>
          </CardContent>
        </Card>
        <Card className="cursor-pointer border border-border/50 bg-card/60 transition-all hover:shadow-md" onClick={() => void vault.reload()}>
          <CardContent className="flex flex-col items-center justify-center p-2.5 text-center">
            <div className="mb-1.5 flex h-8 w-8 items-center justify-center rounded-full bg-red-500 text-white shadow-xs"><ShieldAlert className="h-4 w-4" /></div>
            <span className="text-xs font-bold">{t("agents.guard.guardTitle")}</span>
            <span className="text-[10px] text-muted-foreground">{pausedCaps ? t("agents.guard.limitedCount", { count: pausedCaps }) : t("agents.guard.recheck")}</span>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-3 gap-2.5">
        <Card className="border-none bg-primary/5 shadow-sm">
          <CardContent className="flex flex-col items-center justify-center p-3 text-center">
            <TrendingUp className="mb-1 h-5 w-5 text-primary" />
            <p className="text-base font-bold text-foreground">{vault.account ? balanceLabel : "—"}</p>
            <p className="text-xs text-muted-foreground">{t("agents.guard.totalAssets")}</p>
          </CardContent>
        </Card>
        <Card className="border-none bg-amber-500/5 shadow-sm">
          <CardContent className="flex flex-col items-center justify-center p-3 text-center">
            <Clock className="mb-1 h-5 w-5 text-amber-500" />
            <p className="text-base font-bold text-foreground">{vault.account ? spentLabel : "—"}</p>
            <p className="text-xs text-muted-foreground">{t("agents.guard.epochSpent")}</p>
          </CardContent>
        </Card>
        <Card className="border-none bg-emerald-500/5 shadow-sm">
          <CardContent className="flex flex-col items-center justify-center p-3 text-center">
            <ShieldCheck className="mb-1 h-5 w-5 text-emerald-500" />
            <p className="text-base font-bold text-foreground">{vault.epoch ? `#${vault.epoch.epoch.toString()}` : "—"}</p>
            <p className="text-xs text-muted-foreground">{t("agents.guard.currentEpoch")}</p>
          </CardContent>
        </Card>
      </div>
      {vault.epoch && (
        <p className="text-xs text-muted-foreground">{t("agents.guard.epochWindow", { start: new Date(vault.epoch.startedAtMs).toLocaleString(), hours: Math.round(vault.epoch.durationMs / 3_600_000) })}</p>
      )}
      {vault.epochError && <p className="break-all text-xs text-amber-600">{t("agents.guard.epochWindowError", { error: vault.epochError })}</p>}
      {vault.vaults.some(v => v.caps.some(c => !c.epochKnown && c.status === "QUOTA_REACHED")) && <p role="alert" className="text-xs text-amber-600">{t("agents.guard.quotaEpochCaveat")}</p>}

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-foreground">{t("agents.guard.vaultsAndCaps", { count: allCaps.length })}</h3>
          <span className="text-xs text-muted-foreground">{t("agents.guard.verifiedVaults", { count: vault.vaults.length })}</span>
        </div>

        {vault.account && !vault.loading && vault.vaults.length === 0 && !vault.error && (
          <div className="space-y-2 rounded-xl border border-dashed p-4 text-xs text-muted-foreground">
            <p>{t("agents.guard.emptyAccount")}</p>
            {legacy.cards > 0 && <p className="text-amber-600">{t("agents.guard.legacyDetected", { count: legacy.cards })}</p>}
            <Button size="sm" disabled={!!busy} onClick={() => void handleCreateVault()} className="gap-1 text-xs">
              <Landmark className="h-3.5 w-3.5" />{busy === "vault" ? t("agents.awaitWalletSigning") : t("agents.guard.createVault")}
            </Button>
          </div>
        )}

        <motion.div className="grid gap-3" variants={container} initial="hidden" animate="show">
          {vault.vaults.map(row => (
            <motion.div key={row.vaultId} variants={item}>
              <Card className="overflow-hidden border-none bg-card shadow-sm">
                <CardHeader className="p-3 pb-1">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <h4 className="text-sm font-semibold">{formatSuiUnits(row.balanceUnits)} SUI</h4>
                      <p className="break-all font-mono text-[11px] text-muted-foreground">{t("agents.guard.vaultLine", { vaultId: row.vaultId, version: row.vaultVersion.toString(), count: row.totalSubagents.toString() })}</p>
                    </div>
                    <div className="flex flex-wrap items-center gap-1">
                      {row.paused && <Badge variant="outline" className="border-red-500/20 bg-red-500/10 text-[10px] text-red-500">{t("agents.vaultPausedGlobal")}</Badge>}
                      {row.masterCapIds.length ? <Badge variant="outline" className="border-emerald-500/20 bg-emerald-500/10 text-[10px] text-emerald-600">Master</Badge> : null}
                      {row.operatorCaps.some(cap => cap.vaultVersion === row.vaultVersion) && <Badge variant="outline" className="text-[10px]">Operator</Badge>}
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="p-3 pt-2">
                  <div className="mb-2 flex flex-wrap gap-1.5">
                    <Button size="sm" variant="outline" className="h-7 gap-1 text-[11px]" disabled={!!busy} onClick={() => handleInitializeVault("deposit", row)}><Coins className="h-3 w-3" />{t("agents.guard.deposit")}</Button>
                    <Button size="sm" variant="outline" className="h-7 gap-1 text-[11px]" disabled={!!busy || !row.masterCapIds.length} onClick={() => handleInitializeVault("withdraw", row)}>{t("agents.guard.withdraw")}</Button>
                    <Button size="sm" variant="outline" className="h-7 gap-1 text-[11px]" disabled={!!busy || !row.masterCapIds.length} onClick={() => handleInitializeVault("operator", row)}>{t("agents.guard.issueOperator")}</Button>
                    {row.paused && <Button size="sm" variant="outline" className="h-7 gap-1 text-[11px]" disabled={!!busy || !row.masterCapIds.length} onClick={() => handleInitializeVault("unpause", row)}>{t("agents.guard.unpause")}</Button>}
                    <Button size="sm" variant="outline" className="h-7 gap-1 border-red-500/30 text-[11px] text-red-500 hover:bg-red-500/10" disabled={!!busy || !row.masterCapIds.length}
                      onClick={() => setPurgeVault(row)}><Flame className="h-3 w-3" />{t("agents.guard.emergencyPurge")}</Button>
                    <a href={`https://suiscan.xyz/testnet/object/${row.vaultId}`} target="_blank" rel="noreferrer" className="ml-auto inline-flex items-center text-[11px] text-primary">{t("agents.guard.onchain")}<ExternalLink className="ml-1 h-3 w-3" /></a>
                  </div>
                  {row.operatorCaps.length > 0 && (
                    <p className="break-all font-mono text-[11px] text-muted-foreground">{t("agents.guard.operatorCapsLine", { caps: row.operatorCaps.map(cap => `${cap.capId.slice(0, 12)}…@v${cap.vaultVersion}`).join(" · ") })}</p>
                  )}
                  {row.masterCapIds.length === 0 && !row.operatorCaps.length && <p className="text-xs text-muted-foreground">{t("agents.guard.noCaps")}</p>}

                  <div className="mt-3 space-y-2">
                    {row.caps.length === 0 && <p className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">{t("agents.guard.noCardsInVault")}</p>}
                    {row.caps.map(cap => {
                      const percent = cap.dailyBudgetUnits > 0n ? Number((cap.effectiveSpentUnits * 100n) / cap.dailyBudgetUnits) : 0
                      return (
                        <button key={cap.capId} type="button" onClick={() => setSelectedCap(cap)}
                          className="w-full space-y-2 rounded-xl border border-border/60 bg-background/60 p-3 text-left transition-colors hover:border-primary/40">
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <p className="truncate text-xs font-semibold">{cap.label?.name || `${cap.capId.slice(0, 10)}…`}</p>
                              <p className="truncate text-[10px] text-muted-foreground">{cap.label?.purpose || t("agents.guard.untaggedPurpose")}</p>
                            </div>
                            <Badge variant="outline" className={`shrink-0 text-[10px] ${STATUS_CLASS[cap.status]}`}>{t(STATUS_LABEL[cap.status])}</Badge>
                          </div>
                          <div className="space-y-1">
                            <div className="flex justify-between text-[10px] text-muted-foreground">
                              <span>{t("agents.guard.epochUsage", { spent: formatSuiUnits(cap.effectiveSpentUnits), budget: formatSuiUnits(cap.dailyBudgetUnits) })}</span>
                              <span>{t("agents.guard.remaining", { amount: formatSuiUnits(remainingBudget(cap)) })}</span>
                            </div>
                            <Progress value={Math.min(100, percent)} className="h-1.5" />
                          </div>
                          <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                            <span className="truncate font-mono">Agent {cap.agentAddress.slice(0, 14)}…</span>
                            <span className="inline-flex items-center gap-1 text-primary">{t("agents.guard.details")} <ArrowRight className="h-3 w-3" /></span>
                          </div>
                        </button>
                      )
                    })}
                  </div>
                </CardContent>
              </Card>
            </motion.div>
          ))}
        </motion.div>

        {vault.unverified.length > 0 && (
          <div className="space-y-1 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-xs">
            <p className="font-semibold text-amber-700 dark:text-amber-400">{t("agents.guard.unverifiedTitle", { count: vault.unverified.length })}</p>
            <p className="text-xs text-muted-foreground">{t("agents.guard.unverifiedDesc")}</p>
            {vault.unverified.map(row => <p key={row.capId} className="break-all font-mono text-[11px] text-muted-foreground">{t("agents.guard.unverifiedRow", { capId: row.capId, reason: row.reason })}</p>)}
          </div>
        )}
      </div>

      <div className="space-y-2 pt-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">{t("agents.guard.spendHistoryTitle")}</h3>
          <span className="text-xs text-muted-foreground">{t("agents.guard.spendHistoryHint")}</span>
        </div>
        {spendRows.length === 0 && <p className="rounded-xl border border-dashed p-4 text-xs text-muted-foreground">{t("agents.guard.noSpendEvents")}</p>}
        {spendRows.map(row => (
          <div key={`${row.cap.capId}:${row.digest}`} className="flex items-center justify-between rounded-xl border border-border/40 bg-card/40 p-2.5 text-xs">
            <div className="flex min-w-0 items-center gap-2.5">
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-emerald-500/15 text-emerald-500"><Zap className="h-3.5 w-3.5" /></div>
              <div className="min-w-0">
                <p className="truncate text-xs font-semibold">{row.cap.label?.name || row.cap.capId.slice(0, 10)}</p>
                <p className="truncate font-mono text-[11px] text-muted-foreground">→ {row.recipient}</p>
                <p className="text-[10px] text-muted-foreground">{t("agents.guard.spendRowMeta", { epoch: row.epoch.toString(), time: row.timestampMs ? new Date(row.timestampMs).toLocaleString() : t("agents.guard.timeUnconfirmed") })}</p>
              </div>
            </div>
            <div className="shrink-0 text-right">
              <p className="font-mono font-bold">-{formatSuiUnits(row.amountUnits)} SUI</p>
              <a href={`https://suiscan.xyz/testnet/tx/${row.digest}`} target="_blank" rel="noreferrer" className="text-[10px] text-primary">{t("agents.guard.viewTx")}</a>
            </div>
          </div>
        ))}
      </div>

      {legacy.cards > 0 && (
        <div className="space-y-2 rounded-xl border border-border/60 bg-muted/20 p-3">
          <button type="button" className="flex w-full items-center justify-between text-left" onClick={() => setShowLegacy(value => !value)}>
            <span className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground"><EyeOff className="h-3.5 w-3.5" />{t("agents.guard.legacyToggle")}</span>
            <span className="text-xs text-muted-foreground">{t("agents.guard.legacySummary", { cards: legacy.cards, logs: legacy.logs })}</span>
          </button>
          <p className="text-xs text-muted-foreground">{t("agents.guard.legacyDesc")}</p>
          {showLegacy && <div className="space-y-1">{legacy.names.map((name, index) => <p key={`${name}:${index}`} className="font-mono text-[11px] text-muted-foreground">{name}</p>)}</div>}
        </div>
      )}

      <AgentDetailsDialog cap={selectedCap} open={!!selectedCap} onOpenChange={next => !next && setSelectedCap(null)}
        onTogglePause={cap => { setSelectedCap(null); setAdjustCap(null); void run("pause", async () => {
          const vaultRow = vault.vaults.find(row => row.vaultId === cap.vaultId)
          const operator = vaultRow?.operatorCaps.find(row => row.vaultVersion === vaultRow.vaultVersion)
          if (!operator) throw new Error(t("agents.guard.noMatchingOperator"))
          const tx = createAgentVaultWriters().setPaused(operator.capId, cap.vaultId, cap.agentAddress, cap.isActive)
          const result = await submitAgentTransaction(tx, { action: "agent-cap-pause", scope: `${cap.capId}:${cap.isActive}`, metadata: { capId: cap.capId, vaultId: cap.vaultId, operatorCapId: operator.capId, paused: String(cap.isActive) } })
          setNotice(cap.isActive ? t("agents.guard.capPausedNotice", { digest: result.digest }) : t("agents.guard.capResumedNotice", { digest: result.digest }))
          await vault.reload()
        }) }}
        onOpenAdjust={cap => setAdjustCap(cap)}
        onOpenExport={cap => setExportCap(cap)}
        busy={!!busy} />

      <CreateAgentDialog open={createOpen} onOpenChange={setCreateOpen} vaults={vault.vaults} account={vault.account}
        onCreated={() => { void vault.reload() }} />

      <AdjustBudgetDialog cap={adjustCap} vault={adjustCap ? vault.vaults.find(row => row.vaultId === adjustCap.vaultId) ?? null : null}
        open={!!adjustCap} onOpenChange={next => !next && setAdjustCap(null)} onSaved={() => { void vault.reload() }} />

      <ExportConfigDialog cap={exportCap} vault={exportCap ? vault.vaults.find(row => row.vaultId === exportCap.vaultId) ?? null : null}
        open={!!exportCap} onOpenChange={next => !next && setExportCap(null)} />

      <SpendDialog cap={spendCap} open={!!spendCap} onOpenChange={next => !next && setSpendCap(null)} onDone={() => { void vault.reload() }} />

      <EmergencyLiquidationDialog open={!!purgeVault} onOpenChange={next => !next && setPurgeVault(null)} vault={purgeVault}
        defaultRecipient={vault.account} onDone={() => { void vault.reload() }} />

      <AgentVaultActionDialog action={vaultAction} vault={actionVault} account={vault.account} open={!!vaultAction}
        onOpenChange={next => { if (!next) { setVaultAction(null); setActionVault(null) } }} onDone={() => { void vault.reload() }} />
    </div>
  )
}
