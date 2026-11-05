"use client"

// Issue a group-scoped AI co-sign delegation.
//
// The only group-scoped AI authority in the deployed protocol is
// `SubagentCoSignCap`: it lets a delegated runtime approve proposals on behalf
// of one member, inside per-transaction and cumulative amount limits. This
// dialog never claims the delegation is an AgentVault card or that it can spend
// from the group treasury directly.
import { useEffect, useRef, useState } from "react"
import { Bot } from "lucide-react"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { isValidSuiAddress, normalizeSuiAddress } from "@mysten/sui/utils"
import { suiMist, formatMist } from "@/lib/group-chat"
import { issueGroupAgentDelegation } from "@/lib/group-agent-transactions"
import { useI18n } from "@/components/i18n-provider"

interface GroupAgentDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  orgId: string
  /** Connected account, when it is the member whose weight the cap would carry. */
  member: { address: string; weight: bigint } | null
  accountAddress: string | null
  onIssued: (digest: string) => void
}

export function GroupAgentDialog({ open, onOpenChange, orgId, member, accountAddress, onIssued }: GroupAgentDialogProps) {
  const { t } = useI18n()
  const [agent, setAgent] = useState("")
  const [perTx, setPerTx] = useState("1")
  const [limit, setLimit] = useState("10")
  const [hours, setHours] = useState("24")
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [busy, setBusy] = useState(false)
  const generation = useRef(0)

  useEffect(() => {
    if (!open) return
    setAgent(""); setPerTx("1"); setLimit("10"); setHours("24"); setError(""); setNotice(""); setBusy(false)
    generation.current++
  }, [open, orgId])

  const submit = async () => {
    if (busy) return
    setError(""); setNotice("")
    if (!member) { setError(t("agents.deleg.notMember")); return }
    const target = agent.trim()
    if (!isValidSuiAddress(target)) { setError(t("agents.deleg.agentAddressRequired")); return }
    if (normalizeSuiAddress(target) === normalizeSuiAddress(member.address)) { setError(t("agents.deleg.sameAddress")); return }
    let perTxUnits: bigint, limitUnits: bigint
    try {
      perTxUnits = suiMist(perTx)
      limitUnits = suiMist(limit)
    } catch (cause) { setError(cause instanceof Error ? cause.message : t("agents.invalidAmount")); return }
    if (limitUnits < perTxUnits) { setError(t("agents.deleg.limitBelowPerTx")); return }
    const hoursNumber = Number(hours)
    if (!Number.isFinite(hoursNumber) || hoursNumber <= 0 || hoursNumber > 24 * 365) { setError(t("agents.deleg.validityRange")); return }
    const expiresAtMs = BigInt(Math.floor(Date.now() + hoursNumber * 3_600_000))
    const run = ++generation.current
    setBusy(true)
    try {
      const result = await issueGroupAgentDelegation({
        agentAddress: normalizeSuiAddress(target), voterWeight: member.weight,
        maxBudgetPerTx: perTxUnits, dailyBudgetLimit: limitUnits, expiresAtMs, orgId,
      })
      if (run !== generation.current) return
      setNotice(t("agents.deleg.confirmed", { weight: member.weight, perTx: formatMist(perTxUnits.toString()), limit: formatMist(limitUnits.toString()), digest: result.digest }))
      onIssued(result.digest)
    } catch (cause) {
      if (run === generation.current) setError(cause instanceof Error ? cause.message : t("agents.deleg.txFailed"))
    } finally {
      if (run === generation.current) setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={next => { if (!busy) onOpenChange(next) }}>
      <DialogContent className="w-[92vw] max-w-[420px] rounded-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Bot className="h-4 w-4 text-purple-500" />
            {t("agents.deleg.title")}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {t("agents.deleg.desc")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2 text-xs">
          {accountAddress ? (
            <p className="break-all rounded-lg border border-border/40 bg-muted/30 p-2 font-mono text-[11px] text-muted-foreground">
              {member ? t("agents.deleg.issuerLine", { weight: member.weight, address: accountAddress }) : t("agents.deleg.notMemberLine", { address: accountAddress })}
            </p>
          ) : <p role="alert" className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-2 text-[11px]">{t("agents.deleg.connectFirst")}</p>}

          <div className="space-y-1.5">
            <Label htmlFor="group-agent-address" className="text-xs">{t("agents.deleg.addressLabel")}</Label>
            <Input id="group-agent-address" value={agent} onChange={event => setAgent(event.target.value)} disabled={busy} className="font-mono text-xs" placeholder={t("agents.deleg.addressPlaceholder")} />
            {accountAddress && (
              <button type="button" className="text-[11px] text-primary hover:underline" onClick={() => setAgent(accountAddress)} disabled={busy}>
                {t("agents.deleg.useOwnAddress")}
              </button>
            )}
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5">
              <Label htmlFor="group-agent-per-tx" className="text-xs">{t("agents.deleg.perTxLabel")}</Label>
              <Input id="group-agent-per-tx" inputMode="decimal" value={perTx} onChange={event => setPerTx(event.target.value)} disabled={busy} className="font-mono text-xs" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="group-agent-limit" className="text-xs">{t("agents.deleg.limitLabel")}</Label>
              <Input id="group-agent-limit" inputMode="decimal" value={limit} onChange={event => setLimit(event.target.value)} disabled={busy} className="font-mono text-xs" />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="group-agent-hours" className="text-xs">{t("agents.deleg.hoursLabel")}</Label>
            <Input id="group-agent-hours" inputMode="numeric" value={hours} onChange={event => setHours(event.target.value)} disabled={busy} className="font-mono text-xs" />
          </div>

          <p className="text-[11px] text-muted-foreground">
            {t("agents.deleg.hint")}
          </p>
          {error && <p role="alert" className="break-all text-xs text-destructive">{error}</p>}
          {notice && <p role="status" className="break-all text-xs text-emerald-600">{notice}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={busy} className="text-xs">{t("agents.close")}</Button>
          <Button size="sm" onClick={() => void submit()} disabled={busy || !member} className="gap-1 bg-purple-600 text-xs text-white hover:bg-purple-700">
            <Bot className="h-3.5 w-3.5" />{busy ? t("agents.awaitWalletSigning") : t("agents.deleg.submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
