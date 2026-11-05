"use client"

// Issue a channel-scoped posting delegation (`SubagentMessagingCap`). This is
// the other half of group AI: a delegated runtime can post into the on-chain
// channel without the member signing every message, bounded by expiry and a
// per-minute rate limit. It cannot move funds or vote.
import { useEffect, useRef, useState } from "react"
import { MessageSquare } from "lucide-react"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { isValidSuiAddress, normalizeSuiAddress } from "@mysten/sui/utils"
import { issueMessagingDelegation } from "@/lib/group-messaging-transactions"
import { useI18n } from "@/components/i18n-provider"

interface MessagingCapDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  orgId: string
  channelId: string
  /** True when the connected account is a member of the channel. */
  isMember: boolean
  accountAddress: string | null
  onIssued: (digest: string) => void
}

export function MessagingCapDialog({ open, onOpenChange, orgId, channelId, isMember, accountAddress, onIssued }: MessagingCapDialogProps) {
  const { t } = useI18n()
  const [agent, setAgent] = useState("")
  const [hours, setHours] = useState("24")
  const [rate, setRate] = useState("20")
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [busy, setBusy] = useState(false)
  const generation = useRef(0)

  useEffect(() => {
    if (!open) return
    setAgent(""); setHours("24"); setRate("20"); setError(""); setNotice(""); setBusy(false)
    generation.current++
  }, [open, channelId])

  const submit = async () => {
    if (busy) return
    setError(""); setNotice("")
    if (!accountAddress) { setError(t("misc.mcap.connectFirst")); return }
    if (!isMember) { setError(t("misc.mcap.memberOnly")); return }
    const target = agent.trim()
    if (!isValidSuiAddress(target)) { setError(t("misc.mcap.addressInvalid")); return }
    const hoursNumber = Number(hours)
    if (!Number.isFinite(hoursNumber) || hoursNumber <= 0 || hoursNumber > 24 * 30) { setError(t("misc.mcap.hoursInvalid")); return }
    const rateNumber = Number(rate)
    if (!Number.isSafeInteger(rateNumber) || rateNumber <= 0) { setError(t("misc.mcap.rateInvalid")); return }
    const run = ++generation.current
    setBusy(true)
    try {
      const result = await issueMessagingDelegation({
        channelId, agentAddress: normalizeSuiAddress(target),
        expiresAtMs: BigInt(Math.floor(Date.now() + hoursNumber * 3_600_000)), rateLimitPerMinute: BigInt(rateNumber), orgId,
      })
      if (run !== generation.current) return
      setNotice(t("misc.mcap.issued", { digest: result.digest }))
      onIssued(result.digest)
    } catch (cause) {
      if (run === generation.current) setError(cause instanceof Error ? cause.message : t("misc.mcap.issueFailed"))
    } finally {
      if (run === generation.current) setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={next => { if (!busy) onOpenChange(next) }}>
      <DialogContent className="w-[92vw] max-w-[420px] rounded-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <MessageSquare className="h-4 w-4 text-cyan-500" />
            {t("misc.mcap.title")}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {t("misc.mcap.description")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2 text-xs">
          <p className="break-all rounded-lg border border-border/40 bg-muted/30 p-2 font-mono text-[11px] text-muted-foreground">
            {t("misc.mcap.channelPrefix", { channelId })}{accountAddress ? `${isMember ? t("misc.mcap.isMember") : t("misc.mcap.notMember")} · ${accountAddress}` : t("misc.mcap.noWallet")}
          </p>
          <div className="space-y-1.5">
            <Label htmlFor="messaging-agent" className="text-xs">{t("misc.mcap.agentLabel")}</Label>
            <Input id="messaging-agent" value={agent} onChange={event => setAgent(event.target.value)} disabled={busy} className="font-mono text-xs" placeholder="0x…" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5">
              <Label htmlFor="messaging-hours" className="text-xs">{t("misc.mcap.hoursLabel")}</Label>
              <Input id="messaging-hours" inputMode="numeric" value={hours} onChange={event => setHours(event.target.value)} disabled={busy} className="font-mono text-xs" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="messaging-rate" className="text-xs">{t("misc.mcap.rateLabel")}</Label>
              <Input id="messaging-rate" inputMode="numeric" value={rate} onChange={event => setRate(event.target.value)} disabled={busy} className="font-mono text-xs" />
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground">{t("misc.mcap.note")}</p>
          {error && <p role="alert" className="break-all text-xs text-destructive">{error}</p>}
          {notice && <p role="status" className="break-all text-xs text-emerald-600">{notice}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={busy} className="text-xs">{t("common.close")}</Button>
          <Button size="sm" onClick={() => void submit()} disabled={busy || !isMember} className="gap-1 bg-cyan-600 text-xs text-white hover:bg-cyan-700">
            <MessageSquare className="h-3.5 w-3.5" />{busy ? t("misc.mcap.waitingWallet") : t("misc.mcap.sign")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
