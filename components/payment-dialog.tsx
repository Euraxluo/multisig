"use client"

import { useState, useEffect, useRef } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { ArrowRight, Loader2, CheckCircle2, ExternalLink, Wallet } from "lucide-react"
import { getActiveAccount } from "@/lib/onchain-store"
import type { StoredBill } from "@/lib/bill-record"
import { resumePendingTransaction, signAndExecuteWithWallet, type WalletTransactionResult } from "@/lib/sui-wallet-signer"
import { acknowledgePendingTransaction, listTransactionReceipts, transactionAccountKey, TransactionReceiptError, type PendingTransactionReceipt } from "@/lib/pending-transactions"
import { readWalletAssets, type WalletAsset } from "@/lib/wallet-data"
import { paymentUnits } from "@/lib/scheduled-payments-chain"
import { buildDirectCoinPayment, buildDirectBatchPayment, directPaymentUnits } from "@/lib/direct-payments"
import { normalizeStructTag } from "@mysten/sui/utils"
import { describeRecipientRoute, resolveRecipient } from "@/lib/identity-client"
import { useI18n } from "@/components/i18n-provider"

const SUI_TYPE = normalizeStructTag("0x2::sui::SUI")

interface PaymentDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  bill?: StoredBill
  amount?: number | string
  recipientAddress?: string
  title?: string
  /** Coin type from a template or record; resolved against the wallet's own assets. */
  initialCoinType?: string
  batchItems?: { recipient: string; amount: string; token?: string }[]
}

export function PaymentDialog({ open, onOpenChange, bill, amount: initialAmount, recipientAddress, title, initialCoinType, batchItems }: PaymentDialogProps) {
  const { t } = useI18n()
  const displayTitle = title || bill?.title || t("payments.defaultTitle")
  const defaultRecipient = recipientAddress || bill?.creator || ""
  const defaultAmount = (initialAmount ?? bill?.amount ?? "").toString()

  const [paymentToken, setPaymentToken] = useState(initialCoinType || bill?.coinType || (bill?.token === "SUI" || !bill?.token ? SUI_TYPE : ""))
  const [recipient, setRecipient] = useState(defaultRecipient)
  const [paymentAmount, setPaymentAmount] = useState(defaultAmount)
  const [isProcessing, setIsProcessing] = useState(false)
  const [processingStatus, setProcessingStatus] = useState<string>("")
  const [txDigest, setTxDigest] = useState<string | null>(null)
  const [confirmedPayment, setConfirmedPayment] = useState<{ amount: string; symbol: string; recipient: string } | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [assets, setAssets] = useState<WalletAsset[]>([])
  const [assetOwner, setAssetOwner] = useState("")
  const [pendingPayment, setPendingPayment] = useState<PendingTransactionReceipt | null>(null)
  const [activeAccount, setActiveAccount] = useState(getActiveAccount)
  // A `.id` recipient is the identity object, not the owner's wallet. Show that
  // before the wallet prompt so the payer knows the funds land in an inbox that
  // the identity owner has to withdraw from.
  const [recipientHint, setRecipientHint] = useState<{ kind: "address" | "suins" | "protocol"; address: string } | null>(null)
  const isBatch = Boolean(batchItems && batchItems.length > 0)
  const selectedAsset = assets.find(asset => asset.coinType === paymentToken)
  const tokenLabel = selectedAsset?.symbol || bill?.token || t("payments.tokenFallback")
  const walletBalance = selectedAsset?.balance ?? "—"
  const generation = useRef(0)
  const submitting = useRef(false)

  useEffect(() => {
    const sync = () => {
      const next = getActiveAccount()
      setActiveAccount(next)
      if (transactionAccountKey(next) !== transactionAccountKey(activeAccount)) {
        generation.current++
        onOpenChange(false)
      }
    }
    window.addEventListener("storage", sync)
    window.addEventListener("sui-account-switched", sync)
    return () => {
      window.removeEventListener("storage", sync)
      window.removeEventListener("sui-account-switched", sync)
    }
  }, [activeAccount, onOpenChange])

  useEffect(() => {
    let cancelled = false
    setAssets([]); setAssetOwner("")
    if (open && activeAccount?.address) {
      const owner = transactionAccountKey(activeAccount)
      readWalletAssets(activeAccount.address)
        .then(rows => {
          if (!cancelled && transactionAccountKey(getActiveAccount()) === owner) { setAssets(rows); setAssetOwner(owner) }
        })
        .catch(error => { if (!cancelled) setErrorMessage(error instanceof Error ? error.message : t("payments.errAssetReadFailed")) })
    }
    return () => { cancelled = true }
  }, [open, activeAccount])

  useEffect(() => {
    generation.current++
    setTxDigest(null)
    setErrorMessage(null)
    if (open) {
      setPaymentAmount(defaultAmount)
      setRecipient(defaultRecipient)
      setPaymentToken(initialCoinType || bill?.coinType || (bill?.token === "SUI" || !bill?.token ? SUI_TYPE : ""))
      const account = getActiveAccount()
      const pending = account ? listTransactionReceipts().find(receipt => receipt.action === "personal-transfer" && receipt.status !== "failed" && !receipt.acknowledged && transactionAccountKey(receipt.account) === transactionAccountKey(account)) : undefined
      setPendingPayment(pending || null)
      if (pending?.metadata) {
        setRecipient(pending.metadata.recipient || defaultRecipient)
        setPaymentAmount(pending.metadata.amount || defaultAmount)
        setPaymentToken(pending.metadata.coinType || SUI_TYPE)
      }
    }
    const invalidate = () => { generation.current++ }
    return () => { invalidate() }
  }, [open, defaultAmount, defaultRecipient, bill?.token, bill?.coinType, initialCoinType, activeAccount?.address, activeAccount?.type, activeAccount?.provider])

  // Preview the routing before the wallet prompt: resolving as you type shows
  // whether a name means "wallet address" or "identity inbox". Failures stay
  // silent here; the submit path reports them.
  useEffect(() => {
    const value = recipient.trim()
    if (!open || !value) { setRecipientHint(null); return }
    let cancelled = false
    const timer = setTimeout(() => {
      resolveRecipient(value)
        .then(resolved => { if (!cancelled) setRecipientHint({ kind: resolved.kind, address: resolved.address }) })
        .catch(() => { if (!cancelled) setRecipientHint(null) })
    }, 450)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [open, recipient])

  const completePayment = (result: WalletTransactionResult) => {
    const details = result.receipt.metadata || {}
    setTxDigest(result.digest)
    setConfirmedPayment({ amount: details.amount || t("payments.unknown"), symbol: details.symbol || details.coinType || t("payments.tokenFallback"), recipient: details.recipient || t("payments.unknown") })
    setProcessingStatus(t("payments.confirmedOnChain"))
    if (details.billId && details.recipient && details.units && details.coinType) {
      try {
        const stored: unknown = JSON.parse(localStorage.getItem("sui_bills") || "[]")
        if (!Array.isArray(stored)) throw new Error(t("payments.errBillRecordInvalid"))
        const updated = (stored as StoredBill[]).map((record) => {
          if (record?.id !== details.billId || typeof record.creator !== "string" || record.creator.toLowerCase() !== details.recipient.toLowerCase() || !Array.isArray(record.payees)) return record
          const recordType = record.coinType || (record.token === "SUI" ? SUI_TYPE : "")
          if (recordType !== details.coinType) return record
          const payees = record.payees.map((payee) => {
            if (typeof payee?.address !== "string" || payee.address.toLowerCase() !== result.receipt.account.address.toLowerCase()) return payee
            try { if (paymentUnits(String(payee.amount), Number(details.decimals)) !== BigInt(details.units)) return payee } catch { return payee }
            return { ...payee, paid: true, txDigest: result.digest }
          })
          const paid = payees.filter((payee) => payee?.paid).length
          return { ...record, payees, paid, progress: payees.length ? Math.round(paid / payees.length * 100) : 0, status: paid === payees.length ? "completed" : "pending" }
        })
        localStorage.setItem("sui_bills", JSON.stringify(updated))
        window.dispatchEvent(new CustomEvent("sui-bills-updated"))
      } catch { setErrorMessage(t("payments.errBillSaveFailed")) }
      window.dispatchEvent(new CustomEvent("sui-bill-paid", { detail: { billId: details.billId, amount: details.amount, txDigest: result.digest } }))
    }
    acknowledgePendingTransaction(result.receipt)
    setPendingPayment(null)
  }

  const handleResumePayment = async () => {
    if (!pendingPayment || submitting.current) return
    submitting.current = true; setIsProcessing(true); setErrorMessage(null)
    try { completePayment(await resumePendingTransaction(pendingPayment)) }
    catch (error) {
      if (error instanceof TransactionReceiptError) setPendingPayment(error.status === "failed" ? null : error.receipt)
      setErrorMessage(error instanceof Error ? error.message : t("payments.errConfirmQueryFailed"))
    } finally { submitting.current = false; setIsProcessing(false) }
  }

  const handleExecutePayment = async () => {
    if (submitting.current || pendingPayment) return
    const run = generation.current
    if (!selectedAsset || !activeAccount || assetOwner !== transactionAccountKey(activeAccount) || assetOwner !== transactionAccountKey(getActiveAccount())) {
      setErrorMessage(t("payments.errConnectAndReadBalance"))
      return
    }

    const isBatch = Boolean(batchItems && batchItems.length > 0)

    if (isBatch && batchItems) {
      submitting.current = true
      setErrorMessage(null)
      setIsProcessing(true)
      setProcessingStatus(t("payments.statusBuildingBatch"))
      try {
        if (!activeAccount?.address) throw new Error(t("payments.errConnectWallet"))
        const owner = transactionAccountKey(activeAccount)
        setProcessingStatus(t("payments.statusVerifyingBalance"))
        const freshAssets = await readWalletAssets(activeAccount.address)
        if (run !== generation.current || transactionAccountKey(getActiveAccount()) !== owner) throw new Error(t("payments.errAccountSwitched"))
        const freshAsset = freshAssets.find(asset => asset.coinType === paymentToken)
        if (!freshAsset) throw new Error(t("payments.errTokenNotFound"))

        setProcessingStatus(t("payments.statusResolvingBatch"))
        const resolvedTransfers = []
        let totalBatchUnits = 0n
        for (const item of batchItems) {
          const resolved = await resolveRecipient(item.recipient)
          const units = directPaymentUnits(item.amount, freshAsset)
          totalBatchUnits += units
          resolvedTransfers.push({ recipient: resolved.address, units })
        }
        if (totalBatchUnits > freshAsset.rawBalance) {
          throw new Error(t("payments.errInsufficientForBatch"))
        }
        const tx = buildDirectBatchPayment(activeAccount.address, paymentToken, resolvedTransfers)
        setProcessingStatus(t("payments.statusSignBatch", { count: resolvedTransfers.length }))
        const result = await signAndExecuteWithWallet(tx, {
          action: "personal-transfer",
          scope: `batch:${paymentToken}:${totalBatchUnits}`,
          expectedAccount: activeAccount,
          metadata: {
            recipient: t("payments.batchRecipientCount", { count: resolvedTransfers.length }),
            coinType: paymentToken,
            units: totalBatchUnits.toString(),
            decimals: String(freshAsset.decimals),
            amount: paymentAmount.trim(),
            symbol: tokenLabel,
          },
        })
        if (run !== generation.current) return
        completePayment(result)
      } catch (err: unknown) {
        if (run === generation.current) {
          if (err instanceof TransactionReceiptError) setPendingPayment(err.status === "failed" ? null : err.receipt)
          setErrorMessage(err instanceof Error ? err.message : t("payments.errBatchSignFailed"))
        }
      } finally {
        submitting.current = false
        setIsProcessing(false)
      }
      return
    }

    let units: bigint
    try { units = directPaymentUnits(paymentAmount, selectedAsset) }
    catch (error) { setErrorMessage(error instanceof Error ? error.message : t("payments.errInvalidAmountFallback")); return }
    if (!recipient.trim()) {
      setErrorMessage(t("payments.errEnterRecipient"))
      return
    }

    submitting.current = true
    setErrorMessage(null)
    setIsProcessing(true)
    setProcessingStatus(t("payments.statusBuildingTransfer"))

    try {
      if (!activeAccount?.address) throw new Error(t("payments.errConnectWallet"))
      const owner = transactionAccountKey(activeAccount)
      setProcessingStatus(t("payments.statusResolvingRecipient"))
      const resolved = await resolveRecipient(recipient)
      if (run !== generation.current || transactionAccountKey(getActiveAccount()) !== owner) throw new Error(t("payments.errAccountSwitched"))
      setRecipientHint({ kind: resolved.kind, address: resolved.address })
      setProcessingStatus(t("payments.statusVerifyingCurrentBalance"))
      const freshAssets = await readWalletAssets(activeAccount.address)
      if (run !== generation.current || transactionAccountKey(getActiveAccount()) !== owner) throw new Error(t("payments.errAccountSwitched"))
      const freshAsset = freshAssets.find(asset => asset.coinType === paymentToken)
      if (!freshAsset || freshAsset.decimals !== selectedAsset.decimals || directPaymentUnits(paymentAmount, freshAsset) !== units) throw new Error(t("payments.errAssetChanged"))
      const tx = buildDirectCoinPayment(activeAccount.address, resolved.address, paymentToken, units)
      setProcessingStatus(t("payments.statusSignPayment"))
      const result = await signAndExecuteWithWallet(tx, {
        action: "personal-transfer", scope: `${resolved.address}:${paymentToken}:${units}`,
        expectedAccount: activeAccount,
        metadata: { recipient: resolved.address, coinType: paymentToken, units: units.toString(), decimals: String(freshAsset.decimals), amount: paymentAmount.trim(), symbol: tokenLabel, ...(bill?.id ? { billId: bill.id } : {}) },
      })
      if (run !== generation.current) return
      completePayment(result)
    } catch (err: unknown) {
      if (run === generation.current) {
        if (err instanceof TransactionReceiptError) setPendingPayment(err.status === "failed" ? null : err.receipt)
        setErrorMessage(err instanceof Error ? err.message : t("payments.errSignFailed"))
      }
    } finally {
      submitting.current = false
      setIsProcessing(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={next => { if (!isProcessing) onOpenChange(next) }}>
      <DialogContent className="w-[92vw] max-w-[420px] max-h-[90dvh] overflow-y-auto rounded-2xl p-0 bg-background border border-border shadow-2xl">
        <div className="bg-gradient-to-r from-primary to-purple-600 p-4 text-white">
          <DialogHeader className="text-left">
            <DialogTitle className="text-base font-bold flex items-center gap-2">
              <Wallet className="w-4 h-4" />
              <span>{displayTitle}</span>
            </DialogTitle>
            <DialogDescription className="text-white text-xs">
              {t("payments.dialogDescription")}
            </DialogDescription>
          </DialogHeader>
        </div>

        <div className="p-4 space-y-4 text-xs">
          {!txDigest ? (
            <>
              {/* 收款人与金额卡片 */}
              <div className="space-y-3">
                {pendingPayment && <div role="status" className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 space-y-2">
                  <p>{t("payments.pendingPaymentPrefix")}<span className="break-all font-mono">{pendingPayment.digest || t("payments.pendingNoDigest")}</span></p>
                  <Button size="sm" variant="outline" disabled={isProcessing} onClick={handleResumePayment}>{t("payments.resumePayment")}</Button>
                </div>}
                <div className="space-y-1.5">
                  <Label htmlFor="payment-token" className="text-xs font-semibold">{t("payments.payToken")}</Label>
                  <select id="payment-token" value={paymentToken} onChange={event => setPaymentToken(event.target.value)} disabled={isProcessing || !!pendingPayment || !!bill} className="w-full h-9 rounded-md border border-input bg-background px-2 text-xs">
                    {!assets.some(asset => asset.coinType === paymentToken) && <option value={paymentToken}>{bill?.token || t("payments.readingWalletTokens")}</option>}
                    {assets.map(asset => <option key={asset.coinType} value={asset.coinType} disabled={asset.decimals === null}>{asset.symbol} · {asset.coinType.slice(0, 10)}…::{asset.coinType.split("::").at(-1)} · {asset.decimals === null ? t("payments.decimalsUnknown") : asset.balance}</option>)}
                  </select>
                </div>
                {isBatch && batchItems ? (
                  <div className="space-y-2">
                    <div className="flex justify-between items-center">
                      <Label className="text-xs font-semibold">{t("payments.batchDetails", { count: batchItems.length })}</Label>
                      <span className="text-[11px] text-muted-foreground">
                        {t("payments.walletBalance")} <strong className="text-foreground">{walletBalance} {tokenLabel}</strong>
                      </span>
                    </div>
                    <div className="max-h-40 overflow-y-auto space-y-1.5 p-2 rounded-lg border border-border/50 bg-muted/20">
                      {batchItems.map((item, idx) => (
                        <div key={idx} className="flex justify-between items-center text-[11px] p-1.5 rounded bg-background border border-border/30">
                          <span className="font-mono text-muted-foreground truncate max-w-[200px]">{item.recipient}</span>
                          <span className="font-semibold text-foreground">{item.amount} {item.token || tokenLabel}</span>
                        </div>
                      ))}
                    </div>
                    <div className="flex justify-between items-center pt-1 border-t text-xs">
                      <span className="font-medium text-muted-foreground">{t("payments.batchTotalDebit")}</span>
                      <strong className="text-sm font-bold text-primary">{paymentAmount} {tokenLabel}</strong>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="space-y-1.5">
                      <Label htmlFor="payment-recipient" className="text-xs font-semibold">{t("payments.recipientLabel")}</Label>
                      <Input
                        id="payment-recipient"
                        value={recipient}
                        onChange={(e) => { setRecipient(e.target.value); setRecipientHint(null) }}
                        placeholder="0x… / alice.sui / alice.id"
                        className="font-mono text-xs"
                        disabled={isProcessing || !!pendingPayment}
                      />
                      {recipientHint && (() => {
                        const route = describeRecipientRoute(recipientHint)
                        if (!route) return null
                        return <p className={`rounded-md border p-2 text-[11px] ${route.tone === "caution" ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300" : "border-border/50 bg-muted/40 text-muted-foreground"}`}>
                          {route.message}
                          <span className="mt-1 block break-all font-mono">{recipientHint.address}</span>
                        </p>
                      })()}
                    </div>

                    <div className="space-y-1.5">
                      <div className="flex justify-between items-center">
                        <Label htmlFor="payment-amount" className="text-xs font-semibold">{t("payments.amountLabel")}</Label>
                        <span className="text-[11px] text-muted-foreground">
                          {t("payments.walletBalance")} <strong className="text-foreground">{walletBalance} {tokenLabel}</strong>
                        </span>
                      </div>
                      <div className="relative">
                        <Input
                          id="payment-amount"
                          type="number"
                          step="0.000000001"
                          value={paymentAmount}
                          onChange={(e) => setPaymentAmount(e.target.value)}
                          className="text-sm pr-16"
                          disabled={isProcessing || !!pendingPayment}
                        />
                        <span className="absolute right-3 top-2.5 text-xs font-bold text-muted-foreground">
                          {tokenLabel}
                        </span>
                      </div>
                    </div>
                  </>
                )}

                {/* 状态与费用估算 */}
                <div className="p-2.5 rounded-lg bg-muted/40 border border-border/50 text-[11px] space-y-1 text-muted-foreground">
                  <div className="flex justify-between">
                    <span>{t("payments.networkLabel")}</span>
                    <span className="font-medium text-foreground">Sui Testnet</span>
                  </div>
                  <div className="flex justify-between">
                    <span>{t("payments.gasLabel")}</span>
                    <span className="font-medium text-foreground">{t("payments.gasByWallet")}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>{t("payments.signingLabel")}</span>
                    <span className="font-medium text-emerald-600 dark:text-emerald-400">{t("payments.signingCurrentAccount")}</span>
                  </div>
                </div>

                {errorMessage && (
                  <div className="p-2.5 rounded-md bg-destructive/10 border border-destructive/20 text-destructive text-xs">
                    {errorMessage}
                  </div>
                )}
              </div>

              {isProcessing ? (
                <div className="py-3 flex flex-col items-center justify-center space-y-2">
                  <Loader2 className="w-6 h-6 animate-spin text-primary" />
                  <p className="text-xs font-medium text-center text-muted-foreground">{processingStatus}</p>
                </div>
              ) : (
                <div className="flex justify-end gap-2 pt-2">
                  <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
                    {t("common.cancel")}
                  </Button>
                  <Button
                    size="sm"
                    onClick={handleExecutePayment}
                    disabled={!!pendingPayment || !selectedAsset || selectedAsset.decimals === null}
                    className="bg-gradient-to-r from-primary to-purple-600 text-white hover:from-primary/90 hover:to-purple-600/90 gap-1.5"
                  >
                    <span>{t("payments.confirmPayment")}</span>
                    <ArrowRight className="w-3.5 h-3.5" />
                  </Button>
                </div>
              )}
            </>
          ) : (
            /* 支付成功视图 */
            <div className="py-4 space-y-4 text-center">
              <div className="w-12 h-12 rounded-full bg-emerald-100 dark:bg-emerald-950/40 text-emerald-600 flex items-center justify-center mx-auto">
                <CheckCircle2 className="w-6 h-6" />
              </div>
              <div>
                <h4 className="text-sm font-bold text-foreground">{t("payments.successTitle")}</h4>
                <p className="text-xs text-muted-foreground mt-1">
                  {t("payments.successSentPrefix")} {confirmedPayment?.amount} {confirmedPayment?.symbol}
                </p>
              </div>

              <div className="p-2.5 rounded-md bg-muted font-mono text-[11px] break-all select-all text-left border border-border">
                <div className="text-[10px] text-muted-foreground mb-0.5">{t("payments.digestLabel")}</div>
                {txDigest}
              </div>

              <div className="flex justify-center gap-2 pt-2">
                <a
                  href={`https://suiscan.xyz/testnet/tx/${txDigest}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center justify-center h-8 px-3 text-xs font-medium rounded-md border border-input bg-background hover:bg-accent hover:text-accent-foreground gap-1"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  <span>{t("payments.viewOnSuiscan")}</span>
                </a>
                <Button
                  size="sm"
                  onClick={() => onOpenChange(false)}
                  className="h-8 bg-gradient-to-r from-primary to-purple-600 text-white"
                >
                  {t("payments.doneAndClose")}
                </Button>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
