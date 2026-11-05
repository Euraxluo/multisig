"use client"

import React, { useEffect, useRef, useState } from "react"
import { AlertOctagon } from "lucide-react"
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
import { isValidSuiAddress } from "@mysten/sui/utils"
import { createAgentVaultWriters, formatSuiUnits } from "@/lib/agent-vault-chain"
import { submitAgentTransaction } from "@/lib/agent-vault-transactions"
import type { AgentVaultView } from "@/types/agent"
import { useI18n } from "@/components/i18n-provider"

interface EmergencyLiquidationDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  vault: AgentVaultView | null
  defaultRecipient: string | null
  onDone: () => void
}

export function EmergencyLiquidationDialog({ open, onOpenChange, vault, defaultRecipient, onDone }: EmergencyLiquidationDialogProps) {
  const { t } = useI18n()
  const [confirmText, setConfirmText] = useState("")
  const [recipient, setRecipient] = useState("")
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [busy, setBusy] = useState(false)
  const generation = useRef(0)
  const masterCapId = vault?.masterCapIds[0]

  useEffect(() => {
    if (!open) return
    setConfirmText(""); setError(""); setNotice(""); setBusy(false)
    setRecipient(current => current || defaultRecipient || "")
    generation.current++
  }, [open, defaultRecipient])

  const confirmed = confirmText.trim().toUpperCase() === "PURGE"

  const execute = async () => {
    if (!vault || !masterCapId || busy || !confirmed) return
    setError(""); setNotice("")
    const target = recipient.trim()
    if (!isValidSuiAddress(target)) { setError(t("payments.liqErrInvalidRecipient")); return }
    const run = ++generation.current
    setBusy(true)
    try {
      const tx = createAgentVaultWriters().purge(masterCapId, vault.vaultId, target)
      const result = await submitAgentTransaction(tx, {
        action: "agent-vault-purge", scope: vault.vaultId,
        metadata: { vaultId: vault.vaultId, masterCapId, sweepRecipient: target, balanceUnits: vault.balanceUnits.toString() },
      })
      if (run !== generation.current) return
      setNotice(t("payments.liqNoticeConfirmed", { version: (vault.vaultVersion + 1n).toString(), digest: result.digest }))
      onDone()
    } catch (cause) {
      if (run === generation.current) setError(cause instanceof Error ? cause.message : t("payments.liqErrFailed"))
    } finally {
      if (run === generation.current) setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={next => { if (!busy) onOpenChange(next) }}>
      <DialogContent className="sm:max-w-[480px] border-red-500/40">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-red-500">
            <AlertOctagon className="h-5 w-5 text-red-500" />
            {t("payments.liqTitle")}
          </DialogTitle>
          <DialogDescription className="text-xs text-red-400/90">
            {t("payments.liqDescription")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2 text-xs">
          <div className="space-y-1.5 rounded-lg border border-red-500/30 bg-red-950/40 p-3 leading-relaxed text-red-200">
            <p className="font-semibold text-white">{t("payments.liqWillExecute")}</p>
            <p>{t("payments.liqStep1")}</p>
            <p>{t("payments.liqStep2")}</p>
            <p>3. {t("payments.liqStep3Prefix")} <span className="font-mono font-bold text-white">{vault ? `${formatSuiUnits(vault.balanceUnits)} SUI` : t("payments.liqUnverified")}</span> {t("payments.liqStep3Suffix")}</p>
            <p className="text-red-300/80">{t("payments.liqAftermath")}</p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="purge-recipient" className="text-xs text-muted-foreground">{t("payments.liqRecipientLabel")}</Label>
            <Input id="purge-recipient" value={recipient} onChange={event => setRecipient(event.target.value)} disabled={busy}
              placeholder="0x…" className="h-8 border-red-500/30 font-mono text-xs" />
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">{t("payments.liqConfirmPrefix")} <span className="font-bold text-red-400">PURGE</span> {t("payments.liqConfirmSuffix")}</Label>
            <Input value={confirmText} onChange={event => setConfirmText(event.target.value)} placeholder="PURGE" disabled={busy}
              className="h-8 border-red-500/30 font-mono text-xs focus-visible:ring-red-500" />
          </div>

          {!masterCapId && <p role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 p-2 text-[11px]">{t("payments.liqNoMasterCap")}</p>}
          {error && <p role="alert" className="break-all text-xs text-destructive">{error}</p>}
          {notice && <p role="status" className="break-all text-xs text-emerald-600">{notice}</p>}
        </div>

        <DialogFooter className="pt-2">
          <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={busy} className="text-xs">{t("common.cancel")}</Button>
          <Button type="button" variant="destructive" size="sm" disabled={!confirmed || busy || !masterCapId} onClick={() => void execute()}
            className="bg-red-600 text-xs font-semibold hover:bg-red-700">
            {busy ? t("payments.liqWaitingSign") : t("payments.liqExecute")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
