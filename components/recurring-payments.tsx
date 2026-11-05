"use client"

import { useState, useEffect, useCallback, useRef } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { CalendarClock, Waves, MoreHorizontal, Pause, Play, X, RefreshCw } from "lucide-react"
import { motion } from "framer-motion"
import { getActiveAccount, getUserGroups } from "@/lib/onchain-store"
import { buildPaymentAction, claimableUnits, paymentUnits, scheduledPaymentsReader, ZERO_SCOPE, type PaymentSnapshot, type PaymentAction } from "@/lib/scheduled-payments-chain"
import { formatCoinBalance } from "@/lib/wallet-data"
import { proposalClient } from "@/lib/proposal-chain"
import { assertTransactionAccount, getTransactionAccount, signAndExecuteWithWallet } from "@/lib/sui-wallet-signer"
import { transactionAccountKey } from "@/lib/pending-transactions"
import { createSubmissionGuard } from "@/lib/wallet-creation-state"
import { isValidSuiObjectId, normalizeSuiAddress } from "@mysten/sui/utils"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { useI18n } from "@/components/i18n-provider"

interface RecurringPaymentsProps { groupId?: string }
interface DisplayPayment extends PaymentSnapshot { symbol: string; decimals: number | null }
interface LegacyPlan { id: string; name: string; groupId?: string; ownerAddress?: string }

function dateLabel(ms: bigint) {
  if (ms > BigInt(8_640_000_000_000_000) || ms < 0n) return `${ms} ms`
  return new Date(Number(ms)).toLocaleString()
}

export function RecurringPayments({ groupId }: RecurringPaymentsProps) {
  const { t } = useI18n()
  const [payments, setPayments] = useState<DisplayPayment[]>([])
  const [legacy, setLegacy] = useState<LegacyPlan[]>([])
  const [cancelPaymentId, setCancelPaymentId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [connected, setConnected] = useState(false)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [lookup, setLookup] = useState("")
  const [topup, setTopup] = useState<Record<string, string>>({})
  const [now, setNow] = useState(Date.now())
  const [accountKey, setAccountKey] = useState("")
  const reloadVersion = useRef(0)
  const actionGuard = useRef(createSubmissionGuard())

  useEffect(() => {
    const syncAccount = () => {
      const account = getActiveAccount()
      setAccountKey(account ? transactionAccountKey(account) : "")
    }
    syncAccount()
    const timer = setInterval(() => { setNow(Date.now()); syncAccount() }, 3_000)
    return () => clearInterval(timer)
  }, [])

  const scope = useCallback(() => {
    if (!groupId) return ZERO_SCOPE
    const group = getUserGroups().find(group => group.id === groupId)
    if (!group?.orgObjectId) throw new Error(t("payments.recErrNoOrg"))
    return normalizeSuiAddress(group.orgObjectId)
  }, [groupId])

  const decorate = async (payment: PaymentSnapshot): Promise<DisplayPayment> => {
    if (payment.coinType === normalizeSuiAddress("0x2") + "::sui::SUI") return { ...payment, symbol: "SUI", decimals: 9 }
    try {
      const { coinMetadata } = await proposalClient.getCoinMetadata({ coinType: payment.coinType, signal: AbortSignal.timeout(15_000) })
      return { ...payment, symbol: coinMetadata?.symbol || payment.coinType, decimals: coinMetadata?.decimals ?? null }
    } catch { return { ...payment, symbol: payment.coinType, decimals: null } }
  }

  const reload = useCallback(async () => {
    const version = ++reloadVersion.current
    let expected = ""
    const current = () => {
      if (version !== reloadVersion.current) return false
      try {
        const active = getActiveAccount()
        return (active ? transactionAccountKey(active) : "") === expected
      } catch { return false }
    }
    setLoading(true)
    setError(null)
    setPayments([])
    setNotice(null)
    try {
      const active = getActiveAccount()
      expected = active ? transactionAccountKey(active) : ""
      setConnected(!!active)
      if (!active) {
        setPayments([])
        setNotice(t("payments.recNoticeConnect"))
        return
      }
      const account = getTransactionAccount()
      try {
        const parsed: unknown = JSON.parse(localStorage.getItem("sui_recurring_payments") || "[]")
        setLegacy(Array.isArray(parsed) ? parsed.filter((value): value is LegacyPlan => value && typeof value === "object" && typeof value.name === "string" && typeof value.id === "string" && (groupId ? value.groupId === groupId : !value.groupId) && (!value.ownerAddress || normalizeSuiAddress(value.ownerAddress) === normalizeSuiAddress(account.address))) : [])
      } catch { setLegacy([]) }
      const result = await scheduledPaymentsReader.listPayments(account.address, scope())
      const display = await Promise.all(result.payments.map(decorate))
      if (!current()) return
      setPayments(display)
      setNotice(result.truncated ? t("payments.recNoticeTruncated") : null)
      if (result.errors.length) setError(result.errors.join("；"))
    } catch (cause) { if (current()) setError(cause instanceof Error ? cause.message : t("payments.recErrReadFailed")) }
    finally { if (version === reloadVersion.current) setLoading(false) }
  }, [groupId, scope])

  useEffect(() => {
    setCancelPaymentId(null)
    setLegacy([])
    void reload()
    const refresh = () => { void reload() }
    window.addEventListener("sui-recurring-updated", refresh)
    window.addEventListener("storage", refresh)
    window.addEventListener("sui-account-switched", refresh)
    window.addEventListener("sui-account-changed", refresh)
    const invalidate = () => { reloadVersion.current++ }
    return () => { invalidate(); window.removeEventListener("sui-recurring-updated", refresh); window.removeEventListener("storage", refresh); window.removeEventListener("sui-account-switched", refresh); window.removeEventListener("sui-account-changed", refresh) }
  }, [reload, accountKey])

  const runAction = async (payment: DisplayPayment, action: PaymentAction) => {
    if (!actionGuard.current.enter()) return
    setBusy(payment.id)
    setError(null)
    setNotice(null)
    try {
      const account = getTransactionAccount()
      assertTransactionAccount(account)
      await scheduledPaymentsReader.requireDeployment()
      const current = await scheduledPaymentsReader.readPayment(payment.id)
      if (current.scope !== scope()) throw new Error(t("payments.recErrWrongScope"))
      const fresh = { ...current, capId: payment.capId }
      let amount: bigint | undefined
      if (action === "fund") {
        if (payment.decimals === null) throw new Error(t("payments.recErrDecimalsUnavailable"))
        amount = paymentUnits(topup[payment.id] || "", payment.decimals)
      }
      const tx = buildPaymentAction(fresh, action, amount)
      tx.setSender(account.address)
      assertTransactionAccount(account)
      const result = await signAndExecuteWithWallet(tx)
      setNotice(t("payments.recNoticeConfirmed", { digest: result.digest }))
      await reload()
    } catch (cause) { setError(cause instanceof Error ? cause.message : t("payments.recErrActionFailed")) }
    finally { actionGuard.current.leave(); setBusy(null); setCancelPaymentId(null) }
  }

  const findPayment = async () => {
    setError(null)
    try {
      if (!isValidSuiObjectId(lookup)) throw new Error(t("payments.recErrNeedObjectId"))
      const payment = await scheduledPaymentsReader.readPayment(lookup)
      if (payment.scope !== scope()) throw new Error(t("payments.recErrObjectWrongScope"))
      const row = await decorate(payment)
      setPayments(current => current.some(value => value.id === row.id) ? current : [row, ...current])
    } catch (cause) { setError(cause instanceof Error ? cause.message : t("payments.recErrObjectReadFailed")) }
  }

  const selected = payments.find(payment => payment.id === cancelPaymentId)
  const amountLabel = (payment: DisplayPayment, units: bigint) => payment.decimals === null ? t("payments.recSmallestUnits", { units: units.toString() }) : `${formatCoinBalance(units, payment.decimals)} ${payment.symbol}`

  return <>
    <div className="mb-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-lg font-semibold">{t("payments.recTitle")}</h3>
        <Button size="sm" variant="ghost" disabled={loading || !!busy} onClick={() => void reload()}><RefreshCw className={`h-4 w-4 mr-1 ${loading ? "animate-spin" : ""}`} />{t("payments.recRefresh")}</Button>
      </div>
      <p className="mb-3 text-xs text-muted-foreground">{t("payments.recIntroNote")}</p>
      {connected && <div className="flex gap-2 mb-3"><Input aria-label={t("payments.recLookupLabel")} placeholder={t("payments.recLookupPlaceholder")} value={lookup} onChange={event => setLookup(event.target.value)} /><Button variant="outline" onClick={() => void findPayment()}>{t("payments.recLookupButton")}</Button></div>}
      {error && <p role="alert" className="mb-3 text-xs text-destructive break-all">{error}</p>}
      {notice && <p role="status" className="mb-3 text-xs text-muted-foreground break-all">{notice}</p>}
      {payments.length === 0 ? <Card className="border-dashed"><CardContent className="p-6 text-sm text-muted-foreground">{loading ? t("payments.recLoading") : t("payments.recEmpty")}</CardContent></Card> : <motion.div className="grid gap-2" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
        {payments.map(payment => {
          const recurring = payment.schedule.$kind === "Recurring" ? payment.schedule.Recurring : null
          const stream = payment.schedule.$kind === "Stream" ? payment.schedule.Stream : null
          const status = payment.status.$kind
          const claimable = claimableUnits(payment, BigInt(now))
          const approval = recurring?.requires_approval === true
          const canClaim = claimable > 0n && (!approval || !!payment.capId)
          const paused = BigInt(payment.paused_ms)
          return <motion.div key={payment.id} initial={{ y: 10 }} animate={{ y: 0 }}><Card className="overflow-hidden border-none shadow-sm">
            <div className={`h-1 ${recurring ? "bg-amber-500" : "bg-primary"}`} />
            <CardContent className="p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start min-w-0">
                  <div className="h-8 w-8 shrink-0 rounded-full bg-primary/10 flex items-center justify-center mr-3">{recurring ? <CalendarClock className="h-4 w-4 text-orange-500" /> : <Waves className="h-4 w-4 text-purple-500" />}</div>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2"><h4 className="text-sm font-medium truncate">{new TextDecoder().decode(Uint8Array.from(payment.name))}</h4><Badge variant="outline">{t("payments.recBadgeEscrowed")}</Badge><Badge variant={status === "Active" ? "default" : "outline"}>{status === "Active" ? t("payments.recStatusActive") : status === "Paused" ? t("payments.recStatusPaused") : t("payments.recStatusTerminated")}</Badge>{payment.capId && <Badge variant="outline">{t("payments.recBadgeCap")}</Badge>}</div>
                    <p className="text-xs text-muted-foreground font-mono break-all">{recurring ? t("payments.recPerInstallment") : t("payments.recTotalAmount")}{amountLabel(payment, BigInt(recurring?.amount || payment.funded))} → {payment.recipient}</p>
                  </div>
                </div>
                {payment.capId && status !== "Terminated" && <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" disabled={!!busy} className="h-8 w-8 shrink-0" aria-label={t("payments.recManageLabel")}><MoreHorizontal className="h-4 w-4" /></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuLabel>{t("payments.recManageMenuLabel")}</DropdownMenuLabel><DropdownMenuSeparator /><DropdownMenuItem onClick={() => void runAction(payment, status === "Paused" ? "resume" : "pause")}>{status === "Paused" ? <><Play className="h-4 w-4 mr-2" />{t("payments.recResume")}</> : <><Pause className="h-4 w-4 mr-2" />{t("payments.recPause")}</>}</DropdownMenuItem><DropdownMenuItem className="text-destructive" onClick={() => setCancelPaymentId(payment.id)}><X className="h-4 w-4 mr-2" />{t("payments.recTerminate")}</DropdownMenuItem></DropdownMenuContent></DropdownMenu>}
              </div>
              <div className="mt-2 pt-2 border-t space-y-1 text-xs text-muted-foreground">
                <p>{t("payments.recFundedPrefix")} {amountLabel(payment, BigInt(payment.funded))} · {t("payments.recPaidPrefix")} {amountLabel(payment, BigInt(payment.paid))} · {t("payments.recEscrowPrefix")} {amountLabel(payment, BigInt(payment.balance))} · {t("payments.recRefundedPrefix")} {amountLabel(payment, BigInt(payment.refunded))}</p>
                <p>{t("payments.recStartPrefix")}{dateLabel(BigInt(payment.start_ms) + paused)}{stream ? t("payments.recEndPrefix", { date: dateLabel(BigInt(payment.start_ms) + BigInt(stream.duration_ms) + paused) }) : ""}{status === "Paused" ? t("payments.recFrozenNote") : ""}</p>
                {recurring && <><p>{t("payments.recIntervalDays", { days: Number(BigInt(recurring.interval_ms) / 86_400_000n) })} · {t("payments.recExecutedCount", { count: payment.installments_paid })} · {recurring.max_count !== "0" ? t("payments.recMaxCount", { count: recurring.max_count }) : t("payments.recNoMaxCount")} · {recurring.end_ms !== "0" ? t("payments.recEndBy", { date: dateLabel(BigInt(recurring.end_ms) + paused) }) : t("payments.recNoEndDate")}</p><p>{approval ? t("payments.recApprovalMode") : t("payments.recOpenMode")}</p></>}
                {stream && <p>{t("payments.recStreamCurve", { early: 100 - stream.curve, late: stream.curve })}</p>}
                <p>{t("payments.recClaimableNow")}{approval ? t("payments.recClaimableApprove") : t("payments.recClaimableClaim")}{t("payments.recClaimableEstimate")}{amountLabel(payment, claimable)}</p>
                <p className="font-mono break-all">{t("payments.recObjectIdPrefix")} {payment.id}</p><p className="font-mono break-all">{t("payments.recCoinTypePrefix")} {payment.coinType}</p>
              </div>
              {status !== "Terminated" && <div className="mt-3 flex flex-wrap gap-2"><Button size="sm" disabled={!canClaim || !!busy} onClick={() => void runAction(payment, approval ? "execute_installment" : "claim")}>{busy === payment.id ? t("payments.recBusy") : approval ? t("payments.recApproveOne") : recurring ? t("payments.recTriggerInstallment") : t("payments.recClaimVested")}</Button>
                {recurring && payment.capId && <><Input className="w-32 h-8" aria-label={t("payments.recTopupLabel")} placeholder={t("payments.recTopupLabel")} value={topup[payment.id] || ""} onChange={event => setTopup(current => ({ ...current, [payment.id]: event.target.value }))} /><Button size="sm" variant="outline" disabled={!!busy || !topup[payment.id]} onClick={() => void runAction(payment, "fund")}>{t("payments.recFundButton")}</Button></>}
              </div>}
            </CardContent>
          </Card></motion.div>
        })}
      </motion.div>}
      {legacy.length > 0 && <div className="mt-4 text-xs text-muted-foreground"><p>{t("payments.recLegacyNote")}</p>{legacy.map(plan => <p key={plan.id}>{plan.name}</p>)}</div>}
    </div>
    <AlertDialog open={!!cancelPaymentId} onOpenChange={open => { if (!open) setCancelPaymentId(null) }}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{t("payments.recTerminateTitle")}</AlertDialogTitle><AlertDialogDescription>{t("payments.recTerminateDescription")}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>{t("payments.recKeepButton")}</AlertDialogCancel><AlertDialogAction disabled={!!busy} className="bg-destructive text-destructive-foreground" onClick={() => selected && void runAction(selected, "terminate")}>{t("payments.recTerminateConfirm")}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </>
}
