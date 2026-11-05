"use client"

import { useState } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Progress } from "@/components/ui/progress"
import { Copy, Pause, Play, ShieldAlert, Key, Check, ExternalLink } from "lucide-react"
import { formatSuiUnits } from "@/lib/agent-vault-chain"
import { remainingBudget } from "@/lib/use-agent-vault"
import { useI18n } from "@/components/i18n-provider"
import type { AgentCapView } from "@/types/agent"

interface AgentDetailsDialogProps {
  cap: AgentCapView | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onTogglePause?: (cap: AgentCapView) => void
  onOpenAdjust?: (cap: AgentCapView) => void
  onOpenExport?: (cap: AgentCapView) => void
  busy?: boolean
  notice?: string
}

const statusText: Record<AgentCapView["status"], string> = {
  ACTIVE: "agents.statusActive", QUOTA_REACHED: "agents.statusQuotaReached", PAUSED: "agents.statusPaused", REVOKED: "agents.statusRevoked", STALE: "agents.statusStale", UNVERIFIED: "agents.statusUnverified",
}
const statusClass: Record<AgentCapView["status"], string> = {
  ACTIVE: "bg-emerald-500/10 text-emerald-500 border-emerald-500/20",
  QUOTA_REACHED: "bg-amber-500/10 text-amber-500 border-amber-500/20",
  PAUSED: "bg-muted text-muted-foreground",
  REVOKED: "bg-red-500/10 text-red-500 border-red-500/20",
  STALE: "bg-red-500/10 text-red-500 border-red-500/20",
  UNVERIFIED: "bg-muted text-muted-foreground",
}

export function AgentDetailsDialog({ cap, open, onOpenChange, onTogglePause, onOpenAdjust, onOpenExport, busy, notice }: AgentDetailsDialogProps) {
  const { t } = useI18n()
  const [activeTab, setActiveTab] = useState("overview")
  const [copied, setCopied] = useState("")

  if (!cap) return null

  const spent = cap.effectiveSpentUnits > cap.dailyBudgetUnits ? cap.dailyBudgetUnits : cap.effectiveSpentUnits
  const quotaPercent = cap.dailyBudgetUnits > 0n ? Number((spent * 100n) / cap.dailyBudgetUnits) : 0
  const remaining = remainingBudget(cap)
  const totalSpent = cap.spends.reduce((sum, row) => sum + row.amountUnits, 0n)
  const name = cap.label?.name || `${cap.capId.slice(0, 10)}…`

  const copy = (label: string, text: string) => {
    void navigator.clipboard.writeText(text)
    setCopied(label)
    setTimeout(() => setCopied(""), 2000)
  }
  const copyButton = (label: string, text: string) => (
    <button onClick={() => copy(label, text)} className="p-1 hover:text-primary" aria-label={t("agents.details.copyLabel", { label })}>
      {copied === label ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px] max-h-[90dvh] overflow-y-auto">
        <DialogHeader className="pt-1">
          <div className="flex items-center justify-between gap-2">
            <div>
              <DialogTitle className="text-base font-bold">{name}</DialogTitle>
              <p className="text-xs text-muted-foreground">{cap.label?.purpose || t("agents.details.noPurpose")}</p>
            </div>
            <Badge variant="outline" className={statusClass[cap.status]}>{t(statusText[cap.status])}</Badge>
          </div>
        </DialogHeader>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="mt-3">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="overview">{t("agents.details.tabOverview")}</TabsTrigger>
            <TabsTrigger value="spends">{t("agents.details.tabSpends")}</TabsTrigger>
            <TabsTrigger value="security">{t("agents.details.tabSecurity")}</TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="space-y-3 pt-3">
            <div className="space-y-2 rounded-xl border border-border/60 bg-card/60 p-3.5">
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">{t("agents.details.epochProgress")}</span>
                <span className="font-bold text-foreground">{formatSuiUnits(spent)} / {formatSuiUnits(cap.dailyBudgetUnits)} SUI ({quotaPercent}%)</span>
              </div>
              <Progress value={quotaPercent} className="h-2" />
              <div className="flex justify-between pt-1 text-[11px] text-muted-foreground">
                <span>{t("agents.details.remaining", { amount: formatSuiUnits(remaining) })}</span>
                <span>{t("agents.details.lastSpentEpoch", { epoch: cap.lastSpentEpoch.toString() })}</span>
              </div>
              <p className="text-[11px] leading-relaxed text-muted-foreground">{cap.reason}</p>
            </div>

            <div className="grid grid-cols-2 gap-2 text-[11px]">
              <div className="rounded-lg border border-border/40 bg-muted/30 p-2.5">
                <span className="block text-muted-foreground">{t("agents.details.vaultBalance")}</span>
                <span className="font-mono font-semibold">{formatSuiUnits(cap.vaultBalanceUnits)} SUI</span>
              </div>
              <div className="rounded-lg border border-border/40 bg-muted/30 p-2.5">
                <span className="block text-muted-foreground">{t("agents.details.vaultStatus")}</span>
                <span className="font-semibold">{cap.vaultPaused ? t("agents.vaultPausedGlobal") : t("agents.vaultRunning")} · v{cap.vaultVersion.toString()}</span>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-2 pt-1">
              <Button variant="outline" size="sm" className="gap-1.5 text-xs" disabled={busy || (cap.status !== "ACTIVE" && cap.status !== "PAUSED" && cap.status !== "QUOTA_REACHED")}
                onClick={() => onTogglePause?.(cap)}>
                {cap.isActive ? <Pause className="h-3.5 w-3.5 text-amber-500" /> : <Play className="h-3.5 w-3.5 text-emerald-500" />}
                {cap.isActive ? t("agents.details.pauseCard") : t("agents.details.resumeCard")}
              </Button>
              <Button variant="outline" size="sm" className="text-xs" disabled={busy || cap.status === "STALE"}
                onClick={() => { onOpenChange(false); onOpenAdjust?.(cap) }}>{t("agents.details.adjustBudget")}</Button>
              <Button variant="outline" size="sm" className="gap-1 text-xs" onClick={() => { onOpenChange(false); onOpenExport?.(cap) }}>
                <Key className="h-3.5 w-3.5 text-primary" />{t("agents.details.exportEnv")}
              </Button>
            </div>
            {notice && <p role="status" className="break-all text-xs text-muted-foreground">{notice}</p>}
            {!cap.isActive && cap.status === "PAUSED" && (
              <p className="text-[11px] text-muted-foreground">{t("agents.details.pauseNote")}</p>
            )}
          </TabsContent>

          <TabsContent value="spends" className="space-y-2 pt-3">
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">{t("agents.details.recentSpends", { count: cap.spends.length })}{cap.spendsTruncated ? t("agents.details.scanLimitSuffix") : ""}</span>
              <span className="font-mono">{cap.spendsTruncated ? t("agents.details.listedTotal") : t("agents.details.total")} {formatSuiUnits(totalSpent)} SUI</span>
            </div>
            {cap.spendsError && <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-xs text-destructive">{t("agents.details.spendsReadFailed", { error: cap.spendsError })}<br />{t("agents.details.spendsReadFailedNote")}</p>}
            {!cap.spendsError && cap.spends.length === 0 && !cap.spendsTruncated && <p className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">{t("agents.details.noSpendEventsScan")}</p>}
            {!cap.spendsError && cap.spends.length === 0 && cap.spendsTruncated && <p className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">{t("agents.details.truncatedBeforeReaching")}</p>}
            {cap.spendsTruncated && <p role="status" className="text-[11px] text-amber-600">{t("agents.details.truncatedNote")}</p>}
            <div className="space-y-1.5">
              {cap.spends.map(row => (
                <div key={row.digest} className="flex items-center justify-between gap-2 rounded-lg border border-border/40 bg-card/40 p-2 text-[11px]">
                  <div className="min-w-0">
                    <p className="font-mono font-semibold">-{formatSuiUnits(row.amountUnits)} SUI</p>
                    <p className="truncate font-mono text-[10px] text-muted-foreground">→ {row.recipient}</p>
                    <p className="font-mono text-[10px] text-muted-foreground">{t("agents.guard.spendRowMeta", { epoch: row.epoch.toString(), time: row.timestampMs ? new Date(row.timestampMs).toLocaleString() : t("agents.guard.timeUnconfirmed") })}</p>
                  </div>
                  <a href={`https://suiscan.xyz/testnet/tx/${row.digest}`} target="_blank" rel="noreferrer" className="flex shrink-0 items-center text-primary">
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </div>
              ))}
            </div>
          </TabsContent>

          <TabsContent value="security" className="space-y-2 pt-3 text-xs">
            <div className="space-y-1 rounded-lg border border-border/40 bg-muted/40 p-3">
              <span className="block text-[11px] text-muted-foreground">{t("agents.details.capObject")}</span>
              <div className="flex items-center justify-between gap-2 font-mono font-medium">{cap.capId}{copyButton("cap", cap.capId)}</div>
            </div>
            <div className="space-y-1 rounded-lg border border-border/40 bg-muted/40 p-3">
              <span className="block text-[11px] text-muted-foreground">{t("agents.details.agentAddress")}</span>
              <div className="flex items-center justify-between gap-2 font-mono font-medium">{cap.agentAddress}{copyButton("agent", cap.agentAddress)}</div>
            </div>
            <div className="space-y-1 rounded-lg border border-border/40 bg-muted/40 p-3">
              <span className="block text-[11px] text-muted-foreground">{t("agents.details.objectOwner")}</span>
              <div className="flex items-center justify-between gap-2 font-mono font-medium">{cap.capOwner ?? t("agents.details.nonAddressOwner")}{cap.capOwner && copyButton("owner", cap.capOwner)}</div>
            </div>
            <div className="space-y-1 rounded-lg border border-border/40 bg-muted/40 p-3">
              <span className="block text-[11px] text-muted-foreground">{t("agents.details.vaultLabel")}</span>
              <div className="flex items-center justify-between gap-2 font-mono font-medium">{cap.vaultId}{copyButton("vault", cap.vaultId)}</div>
            </div>
            <div className="space-y-1 rounded-lg border border-border/40 bg-muted/40 p-3">
              <span className="block text-[11px] text-muted-foreground">{t("agents.details.serviceLabel")}</span>
              <p className="break-all font-mono text-[11px]">{cap.serviceHash.length ? new TextDecoder().decode(cap.serviceHash) : t("agents.details.serviceUnset")}</p>
            </div>
            <div className="space-y-1 rounded-lg border border-primary/20 bg-primary/5 p-3 text-[11px] leading-relaxed text-muted-foreground">
              <p className="flex items-center gap-1.5 text-xs font-semibold text-foreground"><ShieldAlert className="h-3.5 w-3.5 text-primary" />{t("agents.details.hardLimits")}</p>
              <p>{t("agents.details.hardLimitsPrefix")}<span className="font-mono">spend_x402_budget</span>{t("agents.details.hardLimitsSuffix")}</p>
            </div>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
