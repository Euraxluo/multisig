"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { normalizeSuiAddress } from "@mysten/sui/utils"
import { AlertTriangle, Loader2, PlusCircle, RefreshCw, Send, ShieldCheck } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { parseDecimalValue, toCoinUnits } from "@/lib/coin-amount"
import { formatMist } from "@/lib/group-chat"
import {
  clearSavedRegistryId, findCreatedRegistry, initializeRegistry, listOwnStakeReceipts, payApp,
  POLICY_MODULE, policyDeployment, policyPackageId, policyReader, readSavedRegistryAdminCapId,
  readSavedRegistryId, registerPaymentApp, registryClient, registryIdFromEnv,
  saveRegistryAdminCapId, saveRegistryId, toggleAppStatus, verifyChatChannel,
  type PolicyDeployment, type RegistrySnapshot, type StakeReceiptEntry,
} from "@/lib/walrus-app-policy"
import { getTransactionAccount, isWalletRejection, signAndExecuteWithWallet } from "@/lib/sui-wallet-signer"
import { t as libT } from "@/lib/i18n/t"
import { useI18n } from "@/components/i18n-provider"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

const shortId = (value: string) => value.length > 20 ? `${value.slice(0, 10)}…${value.slice(-6)}` : value
const sui = (mist: string) => `${formatMist(mist)} SUI`

/** SUI has 9 decimals; a user-entered amount must resolve to exact MIST or fail. */
const parseSuiMist = (value: string, label: string): bigint => {
  const parsed = parseDecimalValue(value)
  if (!parsed || parsed.units <= 0n) throw new Error(libT("walrus.amountPositive", { label }))
  return toCoinUnits(parsed, 9)
}

/**
 * View and wallet-signed transaction entries for a `walrus_app_policy`
 * payment registry.
 *
 * Reads decode chain state only. Every write (initialize / register / toggle /
 * pay) is a Transaction built offline by `lib/walrus-app-policy.ts` and
 * signed by the connected wallet — this panel never sends anything itself, and
 * the ABI gate must resolve all five entries before the buttons render enabled.
 * After an initialize, the created registry and AdminCap are resolved from
 * the confirmed transaction (cap ownership verified against the signer) before
 * anything is saved locally.
 */
export function WalrusPolicyRegistry() {
  const { t } = useI18n()
  const [input, setInput] = useState("")
  const [snapshot, setSnapshot] = useState<RegistrySnapshot | null>(null)
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)
  const [deployment, setDeployment] = useState<PolicyDeployment | null>(null)
  const [deploymentError, setDeploymentError] = useState("")
  const [deploymentLoading, setDeploymentLoading] = useState(true)
  const [notice, setNotice] = useState("")
  const [adminCap, setAdminCap] = useState("")
  const [regBlob, setRegBlob] = useState("")
  const [regChannel, setRegChannel] = useState("")
  const [channelVerified, setChannelVerified] = useState("")
  const [channelCheckLoading, setChannelCheckLoading] = useState(false)
  const [channelCheckError, setChannelCheckError] = useState("")
  const [regStake, setRegStake] = useState("")
  const [regRecipient, setRegRecipient] = useState("")
  const [regMax, setRegMax] = useState("")
  const [regBudget, setRegBudget] = useState("")
  const [payBlob, setPayBlob] = useState("")
  const [payChannel, setPayChannel] = useState("")
  const [payReceipt, setPayReceipt] = useState("")
  const [payAmount, setPayAmount] = useState("")
  const [receipts, setReceipts] = useState<StakeReceiptEntry[] | null>(null)
  const [receiptsLoading, setReceiptsLoading] = useState(false)
  const [busy, setBusy] = useState<"initialize" | "register" | "pay" | "toggle" | null>(null)
  const [txError, setTxError] = useState("")
  const [txNotice, setTxNotice] = useState("")
  const run = useRef(0)

  // The ABI gate must resolve all five entries before anything is displayed as
  // usable; a network failure is shown as an error, never as "not deployed".
  useEffect(() => {
    let cancelled = false
    void policyDeployment()
      .then(value => { if (!cancelled) setDeployment(value) })
      .catch(cause => { if (!cancelled) setDeploymentError(cause instanceof Error ? cause.message : t("walrus.deploymentCheckFailed")) })
      .finally(() => { if (!cancelled) setDeploymentLoading(false) })
    return () => { cancelled = true }
  }, [])

  // The saved admin-cap pointer only prefills the form; the chain re-checks
  // ownership on every admin call, so a stale id can never authorize anything.
  useEffect(() => { setAdminCap(readSavedRegistryAdminCapId()) }, [])

  const load = useCallback(async (value: string) => {
    const id = value.trim()
    if (!id) { setError(t("walrus.registryIdRequired")); return }
    const current = ++run.current
    setLoading(true); setError(""); setNotice("")
    try {
      const result = await policyReader.readRegistry(id)
      if (current !== run.current) return
      setSnapshot(result); setInput(result.registryId)
    } catch (cause) {
      if (current !== run.current) return
      setSnapshot(null)
      setError(cause instanceof Error ? cause.message : t("walrus.registryReadFailed"))
    } finally { if (current === run.current) setLoading(false) }
  }, [t])

  useEffect(() => {
    const saved = readSavedRegistryId() || registryIdFromEnv()
    if (!saved) return
    setInput(saved)
    void load(saved)
    const invalidate = () => { run.current++ }
    return () => { invalidate() }
  }, [load])

  const remember = () => {
    try { saveRegistryId(input.trim()); setNotice(t("walrus.savedRegistryId")) }
    catch (cause) { setError(cause instanceof Error ? cause.message : t("walrus.invalidRegistryId")) }
  }
  const forget = () => {
    clearSavedRegistryId(); setNotice(t("walrus.removedRegistryId"))
  }

  // --- Wallet-signed transaction entries ---

  const begin = (op: "initialize" | "register" | "pay" | "toggle") => {
    setBusy(op); setTxError(""); setTxNotice("")
  }
  const fail = (cause: unknown, fallback: string) => {
    setTxError(isWalletRejection(cause) ? t("walrus.walletRejected") : cause instanceof Error ? cause.message : fallback)
  }
  const finish = (text: string) => {
    setTxNotice(text)
    const id = input.trim()
    if (id) void load(id)
  }

  const initialize = async () => {
    begin("initialize")
    try {
      const account = getTransactionAccount()
      const result = await signAndExecuteWithWallet(initializeRegistry(account.address), {
        action: "walrus-initialize-registry", scope: policyPackageId(), expectedAccount: account, metadata: { module: POLICY_MODULE },
      })
      const found = await findCreatedRegistry(registryClient, result.createdObjects, { expectedOwner: account.address })
      saveRegistryId(found.registryId)
      saveRegistryAdminCapId(found.adminCapId)
      setAdminCap(found.adminCapId)
      setInput(found.registryId)
      setTxNotice(t("walrus.initializeNotice", { registryId: found.registryId, adminCapId: found.adminCapId }))
      void load(found.registryId)
    } catch (cause) { fail(cause, t("walrus.initializeFailed")) } finally { setBusy(null) }
  }

  const register = async () => {
    begin("register")
    try {
      const account = getTransactionAccount()
      const tx = registerPaymentApp({
        registryId: input.trim(), adminCapId: adminCap, blobId: regBlob, channelId: regChannel,
        minMemberStakeMist: parseSuiMist(regStake, t("walrus.labelMinStake")),
        recipient: regRecipient,
        maxPaymentMist: parseSuiMist(regMax, t("walrus.labelMaxPayment")),
        epochBudgetMist: parseSuiMist(regBudget, t("walrus.labelEpochBudget")),
      })
      const result = await signAndExecuteWithWallet(tx, {
        action: "walrus-register-payment-app", scope: `${policyPackageId()}:${input.trim()}`, expectedAccount: account, metadata: { blobId: regBlob.trim() },
      })
      finish(t("walrus.registerNotice", { blobId: regBlob.trim(), digest: result.digest }))
    } catch (cause) { fail(cause, t("walrus.registerFailed")) } finally { setBusy(null) }
  }

  const pay = async () => {
    begin("pay")
    try {
      const account = getTransactionAccount()
      const tx = payApp({
        registryId: input.trim(), blobId: payBlob, channelId: payChannel, receiptId: payReceipt,
        amountMist: parseSuiMist(payAmount, t("walrus.labelPayAmount")),
      })
      const result = await signAndExecuteWithWallet(tx, {
        action: "walrus-pay-app", scope: `${policyPackageId()}:${input.trim()}`, expectedAccount: account, metadata: { blobId: payBlob.trim() },
      })
      finish(t("walrus.payNotice", { digest: result.digest }))
    } catch (cause) { fail(cause, t("walrus.payFailed")) } finally { setBusy(null) }
  }

  const toggle = async (blobId: string, next: boolean) => {
    begin("toggle")
    try {
      const account = getTransactionAccount()
      const result = await signAndExecuteWithWallet(toggleAppStatus({ registryId: input.trim(), adminCapId: adminCap, blobId, isActive: next }), {
        action: "walrus-toggle-payment-app", scope: `${policyPackageId()}:${input.trim()}`, expectedAccount: account, metadata: { blobId, isActive: String(next) },
      })
      finish(t("walrus.toggleNotice", { blobId, digest: result.digest }))
    } catch (cause) { fail(cause, t("walrus.toggleFailed")) } finally { setBusy(null) }
  }

  // Offer the account's real MemberStakeReceipt objects instead of hand-typed
  // ids; the chain re-validates everything on pay, this only removes typos.
  const loadReceipts = async () => {
    setReceiptsLoading(true); setTxError("")
    try {
      const account = getTransactionAccount()
      setReceipts(await listOwnStakeReceipts(registryClient, account.address))
    } catch (cause) { fail(cause, t("walrus.receiptsReadFailed")) } finally { setReceiptsLoading(false) }
  }

  const pickReceipt = (receiptId: string) => {
    const receipt = receipts?.find(entry => entry.receiptId === receiptId)
    if (!receipt) return
    setPayReceipt(receipt.receiptId)
    setPayChannel(receipt.channelId)
  }

  // Registering against a wrong channel burns gas at execution; verify the
  // object exists and is a shared ChatChannel of this package before the
  // register button unlocks. The contract re-validates at register time.
  const checkChannel = async () => {
    setChannelCheckLoading(true); setChannelCheckError(""); setChannelVerified("")
    try {
      const verified = await verifyChatChannel(registryClient, regChannel)
      setChannelVerified(verified.channelId)
    } catch (cause) {
      setChannelCheckError(cause instanceof Error ? cause.message : t("walrus.channelCheckFailed"))
    } finally { setChannelCheckLoading(false) }
  }

  const registryReady = input.trim().length > 0
  const writable = deployment?.moduleResolved === true && busy === null

  return <Card className="border-none shadow-sm">
    <CardHeader className="flex-row items-center justify-between space-y-0 p-4 pb-1">
      <h2 className="flex items-center gap-2 text-sm font-semibold"><ShieldCheck className="h-4 w-4 text-primary" />{t("walrus.policyTitle")}</h2>
      <Button size="icon" variant="ghost" className="h-7 w-7" aria-label={t("walrus.reloadAria")} disabled={!input.trim() || loading} onClick={() => void load(input)}>
        <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
      </Button>
    </CardHeader>
    <CardContent className="space-y-3 p-4 pt-1">
      <p className="text-[11px] text-muted-foreground">
        {t("walrus.policyDescription")}
      </p>

      {deploymentError && <p role="alert" className="break-all rounded-lg bg-destructive/10 p-2 text-[11px] text-destructive">{t("walrus.deploymentErrorPrefix")}{deploymentError}</p>}
      {deploymentLoading && <p role="status" className="flex items-center gap-2 text-[11px] text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" />{t("walrus.deploymentChecking")}</p>}
      {deployment && <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant={deployment.moduleResolved ? "outline" : "destructive"} className="text-[10px]">{deployment.moduleResolved ? t("walrus.abiAvailable") : t("walrus.abiUnavailable")}</Badge>
        <p className="text-[10px] text-muted-foreground">{deployment.reason}</p>
      </div>}

      <div className="flex gap-2">
        <Input
          value={input}
          onChange={event => setInput(event.target.value)}
          placeholder={t("walrus.registryIdPlaceholder")}
          aria-label={t("walrus.registryIdAria")}
          className="h-9 font-mono text-xs"
          onKeyDown={event => { if (event.key === "Enter") void load(input) }}
        />
        <Button size="sm" className="h-9 shrink-0" aria-label={t("walrus.readAria")} disabled={loading || !input.trim()} onClick={() => void load(input)}>
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : t("walrus.read")}
        </Button>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px]" disabled={!input.trim()} onClick={remember}>{t("walrus.rememberId")}</Button>
        <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px]" onClick={forget}>{t("walrus.clearLocalRecord")}</Button>
      </div>
      {notice && <p role="status" className="text-[11px] text-muted-foreground">{notice}</p>}

      {/* Wallet-signed transaction entries. The ABI gate must pass before any
          button is usable; without a connected account the first click stops at
          getTransactionAccount() instead of building a half-signed intent. */}
      <div className="space-y-2.5 rounded-lg border p-2.5">
        <p className="text-[11px] font-semibold">{t("walrus.txSectionTitle")}</p>
        {!registryReady && <div className="space-y-1.5">
          <p className="text-[11px] text-muted-foreground">{t("walrus.initializeHint")}</p>
          <Button size="sm" className="h-8" aria-label={t("walrus.initializeAria")} disabled={busy !== null || !deployment?.moduleResolved} onClick={() => void initialize()}>
            {busy === "initialize" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PlusCircle className="h-3.5 w-3.5" />}{t("walrus.initialize")}
          </Button>
        </div>}
        {registryReady && deployment?.moduleResolved && <div className="space-y-2">
            <div className="space-y-1">
              <Label htmlFor="walrus-policy-admin-cap" className="text-[10px] text-muted-foreground">{t("walrus.adminCapLabel")}</Label>
              <Input id="walrus-policy-admin-cap" value={adminCap} onChange={event => setAdminCap(event.target.value)} placeholder={t("walrus.adminCapPlaceholder")} aria-label={t("walrus.adminCapAria")} className="h-8 font-mono text-[11px]" />
            </div>
            <div className="space-y-1.5 rounded-lg bg-muted/30 p-2">
              <p className="text-[10px] font-semibold text-muted-foreground">{t("walrus.registerSectionTitle")}</p>
              <div className="flex gap-1.5">
                <Input value={regChannel} onChange={event => setRegChannel(event.target.value)} placeholder={t("walrus.channelPlaceholder")} aria-label={t("walrus.regChannelAria")} className="h-8 flex-1 font-mono text-[11px]" />
                <Button size="sm" variant="outline" className="h-8 shrink-0" aria-label={t("walrus.verifyChannelAria")} disabled={channelCheckLoading || !regChannel.trim()} onClick={() => void checkChannel()}>
                  {channelCheckLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : t("walrus.verifyChannel")}
                </Button>
              </div>
              {channelVerified && regChannel.trim() && normalizeSuiAddress(channelVerified) === normalizeSuiAddress(regChannel.trim())
                && <p role="status" className="text-[11px] text-emerald-700 dark:text-emerald-300">{t("walrus.channelVerified", { channelId: shortId(channelVerified) })}</p>}
              {channelCheckError && <p role="alert" className="break-all rounded-lg bg-destructive/10 p-2 text-[11px] text-destructive">{channelCheckError}</p>}
              <div className="grid grid-cols-2 gap-1.5">
                <Input value={regBlob} onChange={event => setRegBlob(event.target.value)} placeholder="Walrus blob ID" aria-label={t("walrus.regBlobAria")} className="h-8 font-mono text-[11px]" />
                <Input value={regStake} onChange={event => setRegStake(event.target.value)} placeholder={t("walrus.minStakePlaceholder")} aria-label={t("walrus.minStakeAria")} className="h-8 text-[11px]" inputMode="decimal" />
                <Input value={regRecipient} onChange={event => setRegRecipient(event.target.value)} placeholder={t("walrus.recipientPlaceholder")} aria-label={t("walrus.recipientAria")} className="h-8 font-mono text-[11px]" />
                <Input value={regMax} onChange={event => setRegMax(event.target.value)} placeholder={t("walrus.maxPaymentPlaceholder")} aria-label={t("walrus.maxPaymentAria")} className="h-8 text-[11px]" inputMode="decimal" />
                <Input value={regBudget} onChange={event => setRegBudget(event.target.value)} placeholder={t("walrus.epochBudgetPlaceholder")} aria-label={t("walrus.epochBudgetAria")} className="h-8 text-[11px]" inputMode="decimal" />
              </div>
              <Button size="sm" className="h-8" aria-label={t("walrus.registerAria")} disabled={!writable || !adminCap.trim() || !regBlob.trim() || !regChannel.trim() || !regStake.trim() || !regRecipient.trim() || !regMax.trim() || !regBudget.trim() || !(regChannel.trim() && channelVerified && normalizeSuiAddress(channelVerified) === normalizeSuiAddress(regChannel.trim()))} onClick={() => void register()}>
                {busy === "register" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PlusCircle className="h-3.5 w-3.5" />}{t("walrus.register")}
              </Button>
            </div>
            <div className="space-y-1.5 rounded-lg bg-muted/30 p-2">
              <p className="text-[10px] font-semibold text-muted-foreground">{t("walrus.paySectionTitle")}</p>
              {snapshot && snapshot.policies.length > 0 && <Select onValueChange={setPayBlob}>
                <SelectTrigger aria-label={t("walrus.selectAppAria")} className="h-8 text-[11px]">
                  <SelectValue placeholder={t("walrus.selectAppPlaceholder")} />
                </SelectTrigger>
                <SelectContent>
                  {snapshot.policies.map(policy => <SelectItem key={policy.blobId} value={policy.blobId} disabled={!policy.isActive} className="text-[11px]">
                    {policy.blobId}{policy.isActive ? "" : t("walrus.pausedSuffix")}
                  </SelectItem>)}
                </SelectContent>
              </Select>}
              <div className="flex gap-1.5">
                <Button size="sm" variant="outline" className="h-8 shrink-0" aria-label={t("walrus.loadReceiptsAria")} disabled={receiptsLoading || busy !== null} onClick={() => void loadReceipts()}>
                  {receiptsLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : t("walrus.loadReceipts")}
                </Button>
                {receipts && receipts.length > 0 && <Select onValueChange={pickReceipt}>
                  <SelectTrigger aria-label={t("walrus.selectReceiptAria")} className="h-8 flex-1 text-[11px]">
                    <SelectValue placeholder={t("walrus.selectReceiptPlaceholder")} />
                  </SelectTrigger>
                  <SelectContent>
                    {receipts.map(receipt => {
                      // With a policy selected, receipts from another channel are
                      // disabled in the list — they can never authorize this payment.
                      const policy = snapshot?.policies.find(entry => entry.blobId === payBlob.trim())
                      const mismatch = Boolean(policy && normalizeSuiAddress(policy.channelId) !== normalizeSuiAddress(receipt.channelId))
                      return <SelectItem key={receipt.receiptId} value={receipt.receiptId} disabled={mismatch} className="text-[11px]">
                        {t("walrus.receiptOption", { channelId: shortId(receipt.channelId), amount: formatMist(receipt.stakedAmountMist) })}{mismatch ? t("walrus.receiptChannelMismatch") : ""}
                      </SelectItem>
                    })}
                  </SelectContent>
                </Select>}
              </div>
              {receipts && receipts.length === 0 && <p className="text-[11px] text-muted-foreground">{t("walrus.noReceipts")}</p>}
              {payReceipt && (() => {
                const receipt = receipts?.find(entry => entry.receiptId === payReceipt)
                const policy = snapshot?.policies.find(entry => entry.blobId === payBlob.trim())
                if (!receipt) return null
                if (policy && normalizeSuiAddress(policy.channelId) !== normalizeSuiAddress(receipt.channelId)) {
                  return <p role="alert" className="rounded-lg bg-destructive/10 p-2 text-[11px] text-destructive">{t("walrus.receiptChannelConflict", { receiptChannel: shortId(receipt.channelId), policyChannel: shortId(policy.channelId) })}</p>
                }
                if (policy && BigInt(receipt.stakedAmountMist) < BigInt(policy.minMemberStakeMist)) {
                  return <p role="alert" className="rounded-lg bg-destructive/10 p-2 text-[11px] text-destructive">{t("walrus.receiptStakeTooLow", { staked: formatMist(receipt.stakedAmountMist), required: formatMist(policy.minMemberStakeMist) })}</p>
                }
                return null
              })()}
              {(() => {
                // The per-payment cap is deterministic chain state; the epoch
                // budget needs the live epoch, so only the cap gets a hint.
                const policy = snapshot?.policies.find(entry => entry.blobId === payBlob.trim())
                if (!policy || !payAmount.trim()) return null
                try {
                  const mist = parseSuiMist(payAmount, t("walrus.labelPayAmount"))
                  if (mist > BigInt(policy.maxPaymentMist)) return <p role="alert" className="rounded-lg bg-destructive/10 p-2 text-[11px] text-destructive">{t("walrus.amountOverCap", { amount: formatMist(mist.toString()), cap: formatMist(policy.maxPaymentMist) })}</p>
                } catch { /* invalid input is caught by the builder at submit */ }
                return null
              })()}
              <div className="grid grid-cols-2 gap-1.5">
                {!(snapshot && snapshot.policies.length > 0) && <Input value={payBlob} onChange={event => setPayBlob(event.target.value)} placeholder="Walrus blob ID" aria-label={t("walrus.payBlobAria")} className="h-8 font-mono text-[11px]" />}
                <Input value={payChannel} onChange={event => setPayChannel(event.target.value)} placeholder={t("walrus.payChannelPlaceholder")} aria-label={t("walrus.payChannelAria")} className="h-8 font-mono text-[11px]" />
                <Input value={payReceipt} onChange={event => setPayReceipt(event.target.value)} placeholder={t("walrus.payReceiptPlaceholder")} aria-label={t("walrus.payReceiptAria")} className="h-8 font-mono text-[11px]" />
                <Input value={payAmount} onChange={event => setPayAmount(event.target.value)} placeholder={t("walrus.payAmountPlaceholder")} aria-label={t("walrus.payAmountAria")} className="h-8 text-[11px]" inputMode="decimal" />
              </div>
              <Button size="sm" className="h-8" aria-label={t("walrus.payAria")} disabled={!writable || !payBlob.trim() || !payChannel.trim() || !payReceipt.trim() || !payAmount.trim()} onClick={() => void pay()}>
                {busy === "pay" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}{t("walrus.pay")}
              </Button>
            </div>
          </div>}
        {txError && <p role="alert" className="break-all rounded-lg bg-destructive/10 p-2 text-[11px] text-destructive">{txError}</p>}
        {txNotice && <p role="status" className="break-all rounded-lg bg-emerald-500/10 p-2 text-[11px] text-emerald-700 dark:text-emerald-300">{txNotice}</p>}
      </div>

      {loading && <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" />{t("walrus.readingRegistry")}</p>}
      {error && <p role="alert" className="break-all rounded-lg bg-destructive/10 p-2 text-[11px] text-destructive">{error}</p>}

      {!snapshot && !loading && !error && deployment?.moduleResolved && <p className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
        {t("walrus.noSnapshotHint")}
      </p>}

      {snapshot && <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="outline" className="text-[10px]">{t("walrus.snapshotLoaded")}</Badge>
          <Badge variant="outline" className="text-[10px]">{t("walrus.policyCount", { loaded: snapshot.policies.length, total: snapshot.totalApps })}</Badge>
          {snapshot.truncated && <Badge variant="outline" className="border-amber-500/30 text-[10px] text-amber-600 dark:text-amber-300">{t("walrus.truncated")}</Badge>}
        </div>
        <p className="break-all font-mono text-[10px] text-muted-foreground">{t("walrus.registryLabel", { registryId: snapshot.registryId })}</p>
        {snapshot.failures.length > 0 && <div role="alert" className="space-y-1 rounded-lg bg-amber-500/10 p-2 text-[11px] text-amber-700 dark:text-amber-300">
          <p className="flex items-center gap-1"><AlertTriangle className="h-3.5 w-3.5" />{t("walrus.failuresIntro", { count: snapshot.failures.length })}</p>
          {snapshot.failures.map(failure => <p key={failure.blobId} className="break-all font-mono text-[10px]">{failure.blobId}: {failure.reason}</p>)}
        </div>}
        {snapshot.policies.length === 0
          ? <p className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">{t("walrus.noPolicies")}</p>
          : snapshot.policies.map(policy => <div key={policy.blobId} className="space-y-1.5 rounded-xl border bg-muted/20 p-2.5">
            <div className="flex flex-wrap items-center justify-between gap-1.5">
              <span className="break-all font-mono text-[11px] font-medium">{policy.blobId}</span>
              <div className="flex shrink-0 items-center gap-1">
                <Badge variant={policy.isActive ? "outline" : "destructive"} className="text-[10px]">{policy.isActive ? t("walrus.payable") : t("walrus.paused")}</Badge>
                {deployment?.moduleResolved && adminCap.trim() && <Button
                  size="sm" variant="outline" className="h-6 px-1.5 text-[10px]"
                  aria-label={policy.isActive ? t("walrus.pauseAppAria", { blobId: policy.blobId }) : t("walrus.resumeAppAria", { blobId: policy.blobId })}
                  disabled={busy !== null}
                  onClick={() => void toggle(policy.blobId, !policy.isActive)}
                >
                  {busy === "toggle" ? <Loader2 className="h-3 w-3 animate-spin" /> : policy.isActive ? t("walrus.pause") : t("walrus.resume")}
                </Button>}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
              <p className="text-muted-foreground">{t("walrus.fieldChannel")}<span className="ml-1 font-mono text-foreground">{shortId(policy.channelId)}</span></p>
              <p className="text-muted-foreground">{t("walrus.fieldMinStake")}<span className="ml-1 font-mono text-foreground">{sui(policy.minMemberStakeMist)}</span></p>
              <p className="text-muted-foreground">{t("walrus.fieldRecipient")}<span className="ml-1 font-mono text-foreground">{shortId(policy.recipient)}</span></p>
              <p className="text-muted-foreground">{t("walrus.fieldMaxPayment")}<span className="ml-1 font-mono text-foreground">{sui(policy.maxPaymentMist)}</span></p>
              <p className="text-muted-foreground">{t("walrus.fieldEpochBudget")}<span className="ml-1 font-mono text-foreground">{sui(policy.epochBudgetMist)}</span></p>
              <p className="text-muted-foreground">{t("walrus.fieldSpentInEpoch")}<span className="ml-1 font-mono text-foreground">{sui(policy.spentInEpochMist)}</span></p>
            </div>
          </div>)}
        <p className="text-[10px] text-muted-foreground">
          {t("walrus.snapshotFootnote")}
        </p>
      </div>}
    </CardContent>
  </Card>
}
