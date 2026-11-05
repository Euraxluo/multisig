"use client"

import { useEffect, useRef, useState } from "react"
import { Zap } from "lucide-react"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { isValidSuiAddress } from "@mysten/sui/utils"
import { agentSuiUnits, createAgentVaultWriters, formatSuiUnits } from "@/lib/agent-vault-chain"
import { submitAgentTransaction } from "@/lib/agent-vault-transactions"
import { remainingBudget } from "@/lib/use-agent-vault"
import { useI18n } from "@/components/i18n-provider"
import type { AgentCapView } from "@/types/agent"

interface SpendDialogProps {
  cap: AgentCapView | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onDone: () => void
}

/**
 * Real `spend_x402_budget` call. The AgentCap object is owned by its address
 * owner, so this only works when that owner is the connected account; the
 * dialog states that instead of pretending another key can sign.
 */
export function SpendDialog({ cap, open, onOpenChange, onDone }: SpendDialogProps) {
  const { t } = useI18n()
  const [amount, setAmount] = useState("")
  const [recipient, setRecipient] = useState("")
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [busy, setBusy] = useState(false)
  const generation = useRef(0)

  useEffect(() => {
    if (!open) return
    setAmount(""); setRecipient(""); setError(""); setNotice(""); setBusy(false)
    generation.current++
  }, [open, cap?.capId])

  if (!cap) return null
  const remaining = remainingBudget(cap)
  const blocked = cap.status !== "ACTIVE"

  const execute = async () => {
    if (busy || blocked) return
    setError(""); setNotice("")
    let units: bigint
    try { units = agentSuiUnits(amount) } catch (cause) { setError(cause instanceof Error ? cause.message : t("agents.invalidAmount")); return }
    if (units <= 0n) { setError(t("agents.amountMustBePositive")); return }
    if (units > remaining) { setError(t("agents.spend.exceedsRemaining", { remaining: formatSuiUnits(remaining) })); return }
    if (!isValidSuiAddress(recipient.trim())) { setError(t("agents.spend.recipientRequired")); return }
    const run = ++generation.current
    setBusy(true)
    try {
      const tx = createAgentVaultWriters().spend(cap.capId, cap.vaultId, units, recipient.trim())
      const result = await submitAgentTransaction(tx, {
        action: "agent-x402-spend", scope: `${cap.capId}:${recipient.trim()}:${units}`,
        metadata: { capId: cap.capId, vaultId: cap.vaultId, units: units.toString(), recipient: recipient.trim(), remainingUnits: remaining.toString() },
      })
      if (run !== generation.current) return
      setNotice(t("agents.spend.confirmed", { amount: formatSuiUnits(units), recipient: recipient.trim(), digest: result.digest }))
      onDone()
    } catch (cause) {
      if (run === generation.current) setError(cause instanceof Error ? cause.message : t("agents.spend.txFailed"))
    } finally {
      if (run === generation.current) setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={next => { if (!busy) onOpenChange(next) }}>
      <DialogContent className="w-[92vw] max-w-[420px] rounded-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Zap className="h-4 w-4 text-amber-500" />
            <span>{t("agents.spend.title")}</span>
          </DialogTitle>
          <DialogDescription className="text-xs">
            {t("agents.spend.desc")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2 text-xs">
          <p className="break-all rounded-lg border border-border/40 bg-muted/30 p-2 font-mono text-[11px] text-muted-foreground">
            {t("agents.spend.summaryLine", { name: cap.label?.name || cap.capId.slice(0, 12), remaining: formatSuiUnits(remaining), budget: formatSuiUnits(cap.dailyBudgetUnits), epoch: cap.lastSpentEpoch.toString() })}
          </p>
          {blocked && <p role="alert" className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-2 text-[11px]">{t("agents.spend.blockedStatus", { status: cap.status, reason: cap.reason })}</p>}
          <div className="space-y-1.5">
            <Label htmlFor="spend-recipient" className="text-xs">{t("agents.spend.recipientLabel")}</Label>
            <Input id="spend-recipient" value={recipient} onChange={event => setRecipient(event.target.value)} disabled={busy} className="font-mono text-xs" placeholder="0x…" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="spend-amount" className="text-xs">{t("agents.actions.amountLabel")}</Label>
            <Input id="spend-amount" inputMode="decimal" value={amount} onChange={event => setAmount(event.target.value)} disabled={busy} className="font-mono text-xs" />
          </div>
          <p className="text-[11px] text-muted-foreground">
            {t("agents.spend.hint")}
          </p>
          {error && <p role="alert" className="break-all text-xs text-destructive">{error}</p>}
          {notice && <p role="status" className="break-all text-xs text-emerald-600">{notice}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={busy} className="text-xs">{t("agents.close")}</Button>
          <Button size="sm" onClick={() => void execute()} disabled={busy || blocked} className="gap-1 bg-amber-500 text-xs text-white hover:bg-amber-600">
            <Zap className="h-3.5 w-3.5" />{busy ? t("agents.awaitWalletSigning") : t("agents.spend.submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
