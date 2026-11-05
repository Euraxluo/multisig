"use client"

import { useEffect, useRef, useState } from "react"
import { QRCodeSVG } from "qrcode.react"
import { Coins, Copy, Download, ExternalLink, Plus, RefreshCw } from "lucide-react"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { groupVaults, type GroupVaultList, type GroupVaultRow } from "@/lib/group-vaults"
import { formatCoinBalance, readWalletAssets } from "@/lib/wallet-data"
import { directPaymentUnits } from "@/lib/direct-payments"
import { assertTransactionAccount, getTransactionAccount, signAndExecuteWithWallet, type WalletTransactionResult } from "@/lib/sui-wallet-signer"
import { acknowledgePendingTransaction, TransactionReceiptError } from "@/lib/pending-transactions"
import { usePendingCreation } from "@/lib/use-pending-creation"
import { useI18n } from "@/components/i18n-provider"

type Translate = (key: string, params?: Record<string, string | number | bigint>) => string

const amountLabel = (row: GroupVaultRow, t: Translate) => row.coinType.endsWith("::sui::SUI")
  ? `${formatCoinBalance(row.balance, 9)} SUI` : t("groups.minimalUnitsCoinType", { balance: row.balance, coinType: row.coinType })

interface GroupTreasuryProps {
  groupId: string
  orgId: string
  readOnly?: boolean
  data: GroupVaultList | null
  error: string
  loading: boolean
  reload: () => Promise<void>
}

export function GroupTreasury({ groupId, orgId, readOnly = false, data, error, loading, reload }: GroupTreasuryProps) {
  const { t } = useI18n()
  const [selected, setSelected] = useState("")
  const [notice, setNotice] = useState("")
  const [actionError, setActionError] = useState("")
  const [busy, setBusy] = useState(false)
  const guard = useRef(false)
  const generation = useRef(0)
  const context = useRef({ orgId, readOnly })
  if (context.current.orgId !== orgId || context.current.readOnly !== readOnly) {
    context.current = { orgId, readOnly }; generation.current++
  }
  const pending = usePendingCreation(!readOnly && !!orgId, "group-treasury-create", orgId)
  useEffect(() => {
    setSelected(""); setNotice(""); setActionError("")
    const invalidate = () => { generation.current++; setNotice(""); setActionError("") }
    window.addEventListener("sui-account-switched", invalidate)
    window.addEventListener("sui-account-changed", invalidate)
    window.addEventListener("storage", invalidate)
    return () => { invalidate(); window.removeEventListener("sui-account-switched", invalidate); window.removeEventListener("sui-account-changed", invalidate); window.removeEventListener("storage", invalidate) }
  }, [orgId])

  const create = async (resume = false) => {
    if (guard.current || readOnly) return
    guard.current = true; setBusy(true); setActionError(""); setNotice("")
    const run = generation.current
    let confirmed: WalletTransactionResult | undefined
    try {
      if (!orgId) throw new Error(t("groups.needOrgFirst"))
      const account = getTransactionAccount()
      const current = () => {
        assertTransactionAccount(account)
        if (run !== generation.current || context.current.orgId !== orgId || context.current.readOnly) throw new Error(t("groups.groupOrAccountSwitchedCreate"))
      }
      if (resume) confirmed = await pending.resume(account)
      else {
        if (pending.blocked) throw new Error(pending.receiptError || t("groups.queryOriginalCreateFirst"))
        const tx = await groupVaults.buildCreateTreasury(account.address, orgId)
        current()
        confirmed = await signAndExecuteWithWallet(tx, { action: "group-treasury-create", scope: orgId, expectedAccount: account, metadata: { groupId, orgId } })
      }
      current()
      const row = await groupVaults.findCreatedTreasury(confirmed.createdObjects, orgId)
      current()
      acknowledgePendingTransaction(confirmed.receipt)
      pending.setPending(undefined)
      setNotice(t("groups.treasuryConfirmed", { id: row.id, digest: confirmed.digest }))
      setSelected(row.treasuryId || "")
      window.dispatchEvent(new CustomEvent("sui-vaults-updated"))
    } catch (cause) {
      if (run === generation.current) {
        if (confirmed) pending.setPending(confirmed.receipt)
        else if (cause instanceof TransactionReceiptError) pending.setPending(cause.status === "failed" ? undefined : cause.receipt)
        setActionError(cause instanceof Error ? cause.message : t("groups.createTreasuryFailed"))
      }
    } finally { guard.current = false; setBusy(false) }
  }

  return <div className="space-y-3" aria-label={t("groups.treasuryTitle")}>
    <div className="flex items-center justify-between gap-2">
      <div className="flex items-center gap-2 text-sm font-semibold"><Coins className="h-4 w-4 text-primary" />{t("groups.treasuryTitle")}</div>
      <Button size="sm" variant="ghost" disabled={loading || busy} onClick={() => void reload()}><RefreshCw className={`mr-1 h-3 w-3 ${loading ? "animate-spin" : ""}`} />{t("groups.refresh")}</Button>
    </div>
    <p className="text-xs text-muted-foreground">{t("groups.treasuryHint")}</p>
    {loading && <p role="status" className="text-xs text-muted-foreground">{t("groups.verifyingOrg")}</p>}
    {error && <p role="alert" className="break-all text-xs text-destructive">{error}</p>}
    {data?.discoveryError && <p role="alert" className="break-all text-xs text-destructive">{data.discoveryError}</p>}
    {data?.treasuryDeploymentError && <p role="alert" className="break-all text-xs text-destructive">{data.treasuryDeploymentError}</p>}
    {!!data?.errors.length && <div role="alert" className="space-y-1 text-xs text-destructive">{data.errors.map((issue, index) => <p className="break-all" key={`${issue.id}:${index}`}>{issue.id}{t("groups.cnColon")}{issue.error}</p>)}</div>}
    {data?.truncated && <p className="text-xs text-muted-foreground">{t("groups.truncatedHint")}</p>}
    {data && data.vaults.length === 0 && <p className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">{t("groups.noTreasuries")}</p>}
    {data?.vaults.map(row => <div key={row.id} className="space-y-2 rounded-xl border bg-muted/20 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-sm font-semibold">{amountLabel(row, t)}</span><Badge variant="outline" className="text-[10px]">{row.treasuryId ? t("groups.badgeProposalCustody") : t("groups.badgeGroupKey")}</Badge></div>
      <p className="break-all font-mono text-[10px] text-muted-foreground">Vault {row.id}</p>
      {row.treasuryId ? <>
        <p className="break-all font-mono text-[10px] text-muted-foreground">{t("groups.custodyObjectLabel")} {row.treasuryId}</p>
        <Button size="sm" variant="outline" onClick={() => setSelected(row.treasuryId!)}><Coins className="mr-1 h-3 w-3" />{readOnly ? t("groups.viewVaultAndDeposit") : t("groups.fundOrShare")}</Button>
      </> : <p className="text-xs text-muted-foreground">{row.authority.reason}{t("groups.cnPeriod")}{t("groups.legacyVaultNote")}</p>}
      {row.paused && <p className="text-xs text-muted-foreground">{t("groups.vaultPaused")}</p>}
      <a href={`https://suiscan.xyz/testnet/object/${row.id}`} target="_blank" rel="noreferrer" className="inline-flex items-center text-xs text-primary">{t("groups.viewOnchainVault")}<ExternalLink className="ml-1 h-3 w-3" /></a>
    </div>)}
    {!readOnly && <div className="space-y-2">
      {pending.pending && <div role="status" className="space-y-2 rounded-lg border p-3 text-xs"><p className="break-all">{t("groups.createPendingLabel")} {pending.pending.digest || t("groups.noDigestYet")}</p><Button size="sm" variant="outline" disabled={busy} onClick={() => void create(true)}>{t("groups.queryOriginalCreate")}</Button></div>}
      {(actionError || pending.receiptError) && <p role="alert" className="break-all text-xs text-destructive">{actionError || pending.receiptError}</p>}
      {notice && <p role="status" className="break-all text-xs text-muted-foreground">{notice}</p>}
      <Button size="sm" variant="outline" disabled={busy || !!pending.pending} onClick={() => void create()}><Plus className="mr-1 h-3 w-3" />{t("groups.createTreasuryAction")}</Button>
      <p className="text-[11px] text-muted-foreground">{t("groups.createTreasuryHint")}</p>
    </div>}
    {selected && <TreasuryDepositDialog open orgId={orgId} treasuryId={selected} onOpenChange={next => { if (!next) setSelected("") }} allowFunding={!readOnly} />}
  </div>
}

export function TreasuryDepositDialog({ open, onOpenChange, orgId, treasuryId, allowFunding = true }: { open: boolean; onOpenChange: (open: boolean) => void; orgId: string; treasuryId: string; allowFunding?: boolean }) {
  const { t } = useI18n()
  const [row, setRow] = useState<GroupVaultRow | null>(null)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [link, setLink] = useState("")
  const [amount, setAmount] = useState("")
  const [preparing, setPreparing] = useState(false)
  const [busy, setBusy] = useState(false)
  const guard = useRef(false)
  const generation = useRef(0)
  const svg = useRef<HTMLDivElement>(null)
  const pending = usePendingCreation(open, "group-treasury-deposit", treasuryId)
  const context = useRef({ open, orgId, treasuryId })
  if (context.current.open !== open || context.current.orgId !== orgId || context.current.treasuryId !== treasuryId) {
    generation.current++; context.current = { open, orgId, treasuryId }
  }
  useEffect(() => {
    const run = ++generation.current
    setRow(null); setError(""); setNotice(""); setPreparing(false); setAmount(""); setLink("")
    if (!open) return
    const url = new URL("/", window.location.origin)
    url.searchParams.set("treasury", treasuryId); url.searchParams.set("org", orgId)
    setLink(url.toString())
    groupVaults.readTreasury(treasuryId, orgId).then(value => { if (run === generation.current) setRow(value) }).catch(cause => { if (run === generation.current) setError(cause instanceof Error ? cause.message : t("groups.readVaultsFailed")) })
    const invalidate = () => { generation.current++; setPreparing(false); setNotice("") }
    window.addEventListener("sui-account-switched", invalidate); window.addEventListener("sui-account-changed", invalidate); window.addEventListener("storage", invalidate)
    return () => { invalidate(); window.removeEventListener("sui-account-switched", invalidate); window.removeEventListener("sui-account-changed", invalidate); window.removeEventListener("storage", invalidate) }
  }, [open, orgId, treasuryId])

  const fund = async (resume = false) => {
    if (guard.current || !allowFunding) return
    guard.current = true; setBusy(true); setError(""); setNotice("")
    const run = generation.current
    let confirmed: WalletTransactionResult | undefined
    try {
      const account = getTransactionAccount()
      const current = () => {
        assertTransactionAccount(account)
        if (run !== generation.current || !context.current.open) throw new Error(t("groups.accountOrVaultSwitched"))
      }
      if (resume) confirmed = await pending.resume(account)
      else {
        if (pending.blocked) throw new Error(pending.receiptError || t("groups.queryOriginalDepositFirst"))
        const fresh = await groupVaults.readTreasury(treasuryId, orgId)
        const assets = await readWalletAssets(account.address)
        current()
        const asset = assets.find(value => value.coinType === fresh.coinType)
        if (!asset) throw new Error(t("groups.walletMissingCoin"))
        const units = directPaymentUnits(amount, asset)
        const tx = await groupVaults.buildDepositVault(account.address, fresh.id, fresh.coinType, units)
        current()
        confirmed = await signAndExecuteWithWallet(tx, { action: "group-treasury-deposit", scope: treasuryId, expectedAccount: account, metadata: { orgId, treasuryId, vaultId: fresh.id, coinType: fresh.coinType, units: units.toString(), amount: amount.trim() } })
      }
      current()
      const updated = await groupVaults.readTreasury(treasuryId, orgId)
      current()
      setRow(updated)
      acknowledgePendingTransaction(confirmed.receipt); pending.setPending(undefined)
      setNotice(t("groups.depositConfirmed", { digest: confirmed.digest }))
      setAmount(""); setPreparing(false)
      window.dispatchEvent(new CustomEvent("sui-vaults-updated"))
    } catch (cause) {
      if (run === generation.current) {
        if (confirmed) pending.setPending(confirmed.receipt)
        else if (cause instanceof TransactionReceiptError) pending.setPending(cause.status === "failed" ? undefined : cause.receipt)
        setError(cause instanceof Error ? cause.message : t("groups.depositFailed"))
      }
    } finally { guard.current = false; setBusy(false) }
  }
  const copy = async () => {
    try { await navigator.clipboard.writeText(link); setNotice(t("groups.depositLinkCopied")) }
    catch { setError(t("groups.copyFailed")) }
  }
  const download = () => {
    const element = svg.current?.querySelector("svg")
    if (!element) return
    const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(element)], { type: "image/svg+xml;charset=utf-8" }))
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = `treasury-${treasuryId.slice(0, 10)}.svg`; anchor.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="w-[calc(100%-2rem)] max-w-sm max-h-[90dvh] overflow-y-auto rounded-2xl">
    <DialogHeader><DialogTitle>{t("groups.depositDialogTitle")}</DialogTitle><DialogDescription>{t("groups.depositDialogDesc")}</DialogDescription></DialogHeader>
    {row && <div className="space-y-3">
      <p className="text-lg font-semibold">{amountLabel(row, t)}</p>
      <p className="break-all font-mono text-[10px] text-muted-foreground">{t("groups.orgLabel")} {orgId}<br />Vault {row.id}<br />{t("groups.custodyLabel")} {treasuryId}</p>
      <Badge variant="outline">{t("groups.verifiedCustodyBadge")}</Badge>
      <div ref={svg} className="mx-auto w-fit rounded-xl bg-white p-3"><QRCodeSVG value={link} size={192} marginSize={4} title={t("groups.qrTitle")} /></div>
      <input aria-label={t("groups.depositLinkAria")} className="w-full rounded-md border bg-background p-2 text-xs" readOnly value={link} onFocus={event => event.target.select()} />
      <div className="flex gap-2"><Button size="sm" variant="outline" onClick={() => void copy()}><Copy className="mr-1 h-3 w-3" />{t("groups.copyLink")}</Button><Button size="sm" variant="outline" onClick={download}><Download className="mr-1 h-3 w-3" />{t("groups.saveQr")}</Button></div>
      <p className="text-xs text-muted-foreground">{t("groups.depositNotice")}</p>
      {allowFunding && !preparing && <Button size="sm" onClick={() => { setPreparing(true); setError("") }}>{t("groups.prepareDeposit")}</Button>}
    </div>}
    {allowFunding && preparing && <div className="space-y-2"><Input aria-label={t("groups.depositAmountAria")} inputMode="decimal" placeholder={t("groups.amountPlaceholder")} value={amount} onChange={event => setAmount(event.target.value)} disabled={busy || !!pending.pending} /><Button size="sm" disabled={busy || !!pending.pending} onClick={() => void fund()}>{t("groups.confirmAndSign")}</Button></div>}
    {allowFunding && pending.pending && <div role="status" className="space-y-2 text-xs"><p className="break-all">{t("groups.depositPendingLabel")} {pending.pending.digest || t("groups.noDigestYetDeposit")}</p><Button size="sm" variant="outline" disabled={busy} onClick={() => void fund(true)}>{t("groups.queryOriginalDeposit")}</Button></div>}
    {(error || pending.receiptError && preparing) && <p role="alert" className="break-all text-xs text-destructive">{error || pending.receiptError}</p>}
    {notice && <p role="status" className="break-all text-xs text-muted-foreground">{notice}</p>}
  </DialogContent></Dialog>
}
