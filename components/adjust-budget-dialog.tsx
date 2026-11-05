"use client"

import React, { useEffect, useRef, useState } from "react"
import { Settings2 } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { agentSuiUnits, createAgentVaultWriters, formatSuiUnits } from "@/lib/agent-vault-chain"
import { submitAgentTransaction } from "@/lib/agent-vault-transactions"
import { useI18n } from "@/components/i18n-provider"
import type { AgentCapView, AgentVaultView } from "@/types/agent"

interface AdjustBudgetDialogProps {
  cap: AgentCapView | null
  vault: AgentVaultView | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved: () => void
}

export function AdjustBudgetDialog({ cap, vault, open, onOpenChange, onSaved }: AdjustBudgetDialogProps) {
  const { t } = useI18n()
  const [budget, setBudget] = useState("")
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [saving, setSaving] = useState(false)
  const generation = useRef(0)

  useEffect(() => {
    if (cap) { setBudget(formatSuiUnits(cap.dailyBudgetUnits)); setError(""); setNotice(""); setSaving(false) }
  }, [cap])

  if (!cap) return null

  const operator = vault?.operatorCaps.find(row => row.vaultVersion === vault.vaultVersion)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!cap || saving) return
    setError(""); setNotice("")
    let units: bigint
    try { units = agentSuiUnits(budget) } catch (cause) { setError(cause instanceof Error ? cause.message : t("agents.invalidBudget")); return }
    if (units < 0n) { setError(t("agents.adjust.negative")); return }
    if (units === cap.dailyBudgetUnits) { setError(t("agents.adjust.unchanged")); return }
    if (!vault || !operator) { setError(t("agents.adjust.noOperator")); return }
    const run = ++generation.current
    setSaving(true)
    try {
      const tx = createAgentVaultWriters().setBudget(operator.capId, vault.vaultId, cap.agentAddress, units)
      const result = await submitAgentTransaction(tx, {
        action: "agent-cap-budget", scope: `${cap.capId}:${units}`,
        metadata: { capId: cap.capId, vaultId: vault.vaultId, operatorCapId: operator.capId, previousBudgetUnits: cap.dailyBudgetUnits.toString(), budgetUnits: units.toString() },
      })
      if (run !== generation.current) return
      setNotice(t("agents.adjust.confirmed", { amount: formatSuiUnits(units), digest: result.digest }))
      onSaved()
    } catch (cause) {
      if (run === generation.current) setError(cause instanceof Error ? cause.message : t("agents.adjust.txFailed"))
    } finally {
      if (run === generation.current) setSaving(false)
    }
  }

  const name = cap.label?.name || `${cap.capId.slice(0, 10)}…`

  return (
    <Dialog open={open} onOpenChange={next => { if (!saving) onOpenChange(next) }}>
      <DialogContent className="w-[92vw] max-w-[400px] rounded-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Settings2 className="h-5 w-5 text-primary" />
            <span>{t("agents.adjust.title")}</span>
          </DialogTitle>
          <DialogDescription className="text-xs">
            {t("agents.adjust.descPrefix")}<span className="font-semibold text-foreground">{name}</span>{t("agents.adjust.descSuffix")}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label className="text-xs">{t("agents.adjust.budgetLabel")}</Label>
            <Input inputMode="decimal" value={budget} onChange={event => setBudget(event.target.value)} disabled={saving} className="h-8 font-mono text-xs" />
            <p className="text-[11px] text-muted-foreground">{t("agents.adjust.currentBudget", { budget: formatSuiUnits(cap.dailyBudgetUnits), spent: formatSuiUnits(cap.spentInEpochUnits) })}</p>
          </div>

          <div className="rounded-lg border border-border/50 bg-muted/30 p-2.5 text-[11px] text-muted-foreground">
            {t("agents.adjust.lowerWarning")}
          </div>

          {error && <p role="alert" className="break-all text-xs text-destructive">{error}</p>}
          {notice && <p role="status" className="break-all text-xs text-emerald-600">{notice}</p>}
          <DialogFooter className="pt-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={saving} className="text-xs">{t("agents.close")}</Button>
            <Button type="submit" size="sm" disabled={saving || !operator} className="bg-primary text-xs text-primary-foreground">
              {saving ? t("agents.awaitWalletSigning") : operator ? t("agents.adjust.submit") : t("agents.adjust.missingOperator")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
