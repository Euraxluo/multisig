"use client"

import { isValidSuiAddress, normalizeSuiAddress } from "@mysten/sui/utils"
import { getUserGroups } from "@/lib/onchain-store"
import { buildCreatePayment, PAYMENTS_PACKAGE_ID, paymentUnits, scheduledPaymentsReader, ZERO_SCOPE } from "@/lib/scheduled-payments-chain"
import { assertTransactionAccount, getTransactionAccount, signAndExecuteWithWallet, type WalletTransactionResult } from "@/lib/sui-wallet-signer"
import { acknowledgePendingTransaction, TransactionReceiptError } from "@/lib/pending-transactions"
import { assertAssetOwner, createSubmissionGuard } from "@/lib/wallet-creation-state"
import { usePaymentAssets } from "@/lib/use-payment-assets"
import { usePendingCreation } from "@/lib/use-pending-creation"
import { useState, useRef } from "react"
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Calendar } from "@/components/ui/calendar"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { format, addDays, differenceInCalendarDays } from "date-fns"
import { cn } from "@/lib/utils"
import { CalendarIcon, Waves, ArrowRight } from "lucide-react"
import { Slider } from "@/components/ui/slider"
import { Textarea } from "@/components/ui/textarea"
import { useI18n } from "@/components/i18n-provider"

interface StreamPaymentDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  groupId?: string
}

export function StreamPaymentDialog({ open, onOpenChange, groupId }: StreamPaymentDialogProps) {
  const { t } = useI18n()
  const [recipient, setRecipient] = useState("")
  const [totalAmount, setTotalAmount] = useState("")
  const [token, setToken] = useState(normalizeSuiAddress("0x2") + "::sui::SUI")
  const [startDate, setStartDate] = useState<Date | undefined>(addDays(new Date(), 1))
  const [endDate, setEndDate] = useState<Date | undefined>(addDays(new Date(), 30))
  const [description, setDescription] = useState("")
  const [isProcessing, setIsProcessing] = useState(false)
  const [flowRate, setFlowRate] = useState(50) // Percentage vested during the second half.
  const [saveError, setSaveError] = useState<string | null>(null)
  const { assets, assetOwnerKey, deploymentError } = usePaymentAssets(open)
  const scope = groupId ? getUserGroups().find(group => group.id === groupId)?.orgObjectId : ZERO_SCOPE
  const receiptScope = `${scope ? normalizeSuiAddress(scope) : groupId}:${PAYMENTS_PACKAGE_ID}`
  const recovery = usePendingCreation(open, "create-stream", receiptScope)
  const submitting = useRef(createSubmissionGuard())
  const selectedAsset = assets.find(asset => asset.coinType === token)
  const canSave = Boolean(selectedAsset && selectedAsset.decimals !== null && !deploymentError && isValidSuiAddress(recipient.trim()) && Number.isFinite(Number(totalAmount)) && Number(totalAmount) > 0 && startDate && endDate && differenceInCalendarDays(endDate, startDate) > 0)


  const finishCreation = async (result: WalletTransactionResult) => {
    recovery.setPending(result.receipt)
    let found = false
    for (const id of result.createdObjects) {
      try {
        const payment = await scheduledPaymentsReader.readPayment(id)
        if (payment.scope === normalizeSuiAddress(scope || ZERO_SCOPE) && payment.schedule.$kind === "Stream") { found = true; break }
      } catch { /* PaymentCap and other created objects are not streams. */ }
    }
    if (!found) throw new TransactionReceiptError(t("payments.streamErrNotRead"), result.receipt)
    acknowledgePendingTransaction(result.receipt)
    recovery.setPending(undefined)
    window.dispatchEvent(new CustomEvent("sui-recurring-updated", { detail: { digest: result.digest } }))
    onOpenChange(false)
  }
  const handleResume = async () => {
    if (!submitting.current.enter()) return
    setIsProcessing(true); setSaveError(null)
    try { await finishCreation(await recovery.resume(getTransactionAccount())) }
    catch (error) {
      if (error instanceof TransactionReceiptError) recovery.setPending(error.status === "failed" ? undefined : error.receipt)
      setSaveError(error instanceof Error ? error.message : t("payments.schedErrResumeUnconfirmed"))
    } finally { submitting.current.leave(); setIsProcessing(false) }
  }
  const handleSubmit = async () => {
    if (!canSave || recovery.blocked || !startDate || !endDate || selectedAsset?.decimals == null || !submitting.current.enter()) return
    setSaveError(null)
    setIsProcessing(true)
    try {
      const account = getTransactionAccount()
      assertAssetOwner(assetOwnerKey, account)
      if (!scope) throw new Error(t("payments.schedErrNoOrg"))
      await scheduledPaymentsReader.requireDeployment()
      assertTransactionAccount(account)
      assertAssetOwner(assetOwnerKey, getTransactionAccount())
      if (startDate.getTime() <= Date.now()) throw new Error(t("payments.schedErrStartInFuture"))
      const funding = paymentUnits(totalAmount, selectedAsset.decimals)
      if (funding > selectedAsset.rawBalance) throw new Error(t("payments.streamErrInsufficient"))
      const tx = buildCreatePayment({ recipient: normalizeSuiAddress(recipient.trim()), scope, name: description.trim() || "Stream payment", coinType: token, funding, startMs: BigInt(startDate.getTime()), endMs: BigInt(endDate.getTime()), curve: flowRate })
      tx.setSender(account.address)
      const result = await signAndExecuteWithWallet(tx, { action: "create-stream", scope: receiptScope, expectedAccount: account, metadata: { name: description.trim() || "Stream payment", coinType: token, funding: funding.toString(), recipient: normalizeSuiAddress(recipient.trim()) } })
      await finishCreation(result)
    } catch (error) {
      if (error instanceof TransactionReceiptError) recovery.setPending(error.status === "failed" ? undefined : error.receipt)
      setSaveError(error instanceof Error ? error.message : t("payments.streamErrCreateFailed"))
    } finally {
      submitting.current.leave()
      setIsProcessing(false)
    }
  }

  const getDurationInDays = () => {
    if (!startDate || !endDate) return 0
    return Math.max(0, differenceInCalendarDays(endDate, startDate))
  }

  const getFlowRatePerDay = () => {
    if (!totalAmount || !startDate || !endDate) return "0"
    const days = Math.max(1, getDurationInDays())
    return (Number.parseFloat(totalAmount) / days).toFixed(4)
  }

  const getFlowCurveDescription = () => {
    return t("payments.streamCurveDesc", { early: 100 - flowRate, late: flowRate })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px] max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Create Funded Stream Payment</DialogTitle>
          <DialogDescription>{t("payments.streamDescription")}{groupId ? ` ${t("payments.schedDescriptionGroup")}` : ""}</DialogDescription>
        </DialogHeader>

        {isProcessing ? (
          <div className="py-8 flex flex-col items-center justify-center">
            <div className="h-12 w-12 rounded-full border-4 border-primary border-t-transparent animate-spin mb-4"></div>
            <p className="font-medium">Awaiting wallet and chain confirmation...</p>
          </div>
        ) : (
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="recipient">Recipient Address</Label>
              <Input
                id="recipient"
                placeholder="0x..."
                value={recipient}
                onChange={(e) => setRecipient(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">Recipient is immutable once funded. Cancellation settles vested funds before refunding the remainder.</p>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="amount">Total Amount</Label>
                <Input
                  id="amount"
                  type="number"
                  min="0"
                  step="any"
                  placeholder="0.00"
                  value={totalAmount}
                  onChange={(e) => setTotalAmount(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="token">Token</Label>
                <Select value={token} onValueChange={setToken}>
                  <SelectTrigger id="token">
                    <SelectValue placeholder="Select token" />
                  </SelectTrigger>
                  <SelectContent>
                    {assets.map((asset) => (
                      <SelectItem key={asset.coinType} value={asset.coinType}>
                        {asset.symbol} · {asset.balance} · {asset.coinType.slice(0, 8)}…{asset.coinType.split("::").at(-1)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Planned Start Date</Label>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      variant={"outline"}
                      className={cn(
                        "w-full justify-start text-left font-normal",
                        !startDate && "text-muted-foreground",
                      )}
                    >
                      <CalendarIcon className="mr-2 h-4 w-4" />
                      {startDate ? format(startDate, "PPP") : "Select date"}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0">
                    <Calendar
                      mode="single"
                      selected={startDate}
                      onSelect={(date) => {
                        setStartDate(date)
                        if (date && endDate && date > endDate) {
                          setEndDate(addDays(date, 30))
                        }
                      }}
                    />
                  </PopoverContent>
                </Popover>
              </div>

              <div className="space-y-2">
                <Label>Planned End Date</Label>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      variant={"outline"}
                      className={cn("w-full justify-start text-left font-normal", !endDate && "text-muted-foreground")}
                    >
                      <CalendarIcon className="mr-2 h-4 w-4" />
                      {endDate ? format(endDate, "PPP") : "Select date"}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0">
                    <Calendar
                      mode="single"
                      selected={endDate}
                      onSelect={setEndDate}
                      disabled={(date) => {
                        if (!startDate) return false
                        return date < startDate
                      }}
                    />
                  </PopoverContent>
                </Popover>
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Flow Curve</Label>
                <span className="text-xs text-muted-foreground">{getFlowCurveDescription()}</span>
              </div>
              <Slider
                value={[flowRate]}
                min={0}
                max={100}
                step={1}
                onValueChange={(value) => setFlowRate(value[0])}
                className="py-4"
              />
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>Front-loaded</span>
                <span>Linear</span>
                <span>Back-loaded</span>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="description">Description (Optional)</Label>
              <Textarea
                id="description"
                placeholder="Add details about this stream payment"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="resize-none h-20"
              />
            </div>

            <div className="bg-muted/50 p-3 rounded-lg space-y-2">
              <h4 className="text-sm font-medium flex items-center">
                <Waves className="h-4 w-4 mr-2" />
                Funded Stream Summary
              </h4>
              <div className="text-sm space-y-1">
                <p>Planned amount: {totalAmount ? `${totalAmount} ${selectedAsset?.symbol || ""}` : "Not specified"}</p>
                <p>Planned duration: {getDurationInDays()} days</p>
                <p>
                  Estimated daily average: {getFlowRatePerDay()} {selectedAsset?.symbol}/day
                </p>
                <p className="text-xs text-muted-foreground">{t("payments.streamFundingNote")}</p>
                <div className="flex items-center mt-2">
                  <div className="text-xs text-muted-foreground">
                    {startDate ? format(startDate, "MMM d") : "Start"}
                  </div>
                  <div className="flex-1 mx-2 h-2 bg-muted rounded-full overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-primary to-purple-500"
                      style={{
                        clipPath:
                          flowRate < 50
                            ? `polygon(0 0, ${100 - flowRate}% 100%, 100% 100%, 100% 0)`
                            : `polygon(0 0, 0 100%, ${flowRate}% 0)`,
                      }}
                    ></div>
                  </div>
                  <div className="text-xs text-muted-foreground">{endDate ? format(endDate, "MMM d") : "End"}</div>
                </div>
              </div>
            </div>
          </div>
        )}

        {recovery.pending && <div role="status" className="text-xs space-y-2 break-all"><p>{t("payments.schedPendingPrefix")}{recovery.pending.digest || t("payments.schedPendingNoDigest")}{t("payments.schedPendingSuffix")}</p>{!recovery.pending.persistent && <p>{t("payments.schedStorageWarning")}</p>}<Button variant="outline" disabled={isProcessing || !recovery.pending.digest} onClick={() => void handleResume()}>{t("payments.schedResumeButton")}</Button></div>}
        {recovery.receiptError && <p role="alert" className="text-sm text-destructive">{recovery.receiptError}</p>}
        {deploymentError && <p role="alert" className="text-sm text-destructive">{deploymentError}</p>}
        {saveError && <p role="alert" className="text-sm text-destructive">{saveError}</p>}
        <DialogFooter>
          {!isProcessing && (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                onClick={handleSubmit}
                disabled={!canSave || recovery.blocked}
                className="bg-gradient-to-r from-primary to-purple-500 hover:from-primary/90 hover:to-purple-500/90"
              >
                <ArrowRight className="h-4 w-4 mr-2" />
                Fund and Create Stream
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
