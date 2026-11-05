"use client"

import { isValidSuiAddress, normalizeSuiAddress } from "@mysten/sui/utils"
import { getUserGroups } from "@/lib/onchain-store"
import { buildCreatePayment, FREQUENCY_MS, PAYMENTS_PACKAGE_ID, paymentUnits, recurringCount, scheduledPaymentsReader, ZERO_SCOPE } from "@/lib/scheduled-payments-chain"
import { formatCoinBalance } from "@/lib/wallet-data"
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
import { format, startOfDay, addDays, endOfDay } from "date-fns"
import { cn } from "@/lib/utils"
import { CalendarIcon, Clock, Repeat, CalendarPlus2Icon as CalendarIcon2, Check } from "lucide-react"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { useI18n } from "@/components/i18n-provider"

interface PaymentSchedulerDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  groupId?: string
}

export function PaymentSchedulerDialog({ open, onOpenChange, groupId }: PaymentSchedulerDialogProps) {
  const { t } = useI18n()
  const [recipient, setRecipient] = useState("")
  const [amount, setAmount] = useState("")
  const [token, setToken] = useState(normalizeSuiAddress("0x2") + "::sui::SUI")
  const [frequency, setFrequency] = useState("monthly")
  const [startDate, setStartDate] = useState<Date | undefined>(addDays(new Date(), 1))
  const [endDate, setEndDate] = useState<Date | undefined>(undefined)
  const [endAfterOccurrences, setEndAfterOccurrences] = useState("10")
  const [endType, setEndType] = useState("occurrences") // occurrences, date, never
  const [description, setDescription] = useState("")
  const [requiresApproval, setRequiresApproval] = useState(true)
  const [isProcessing, setIsProcessing] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [prepaidCount, setPrepaidCount] = useState("10")
  const { assets, assetOwnerKey, deploymentError } = usePaymentAssets(open)
  const scope = groupId ? getUserGroups().find(group => group.id === groupId)?.orgObjectId : ZERO_SCOPE
  const receiptScope = `${scope ? normalizeSuiAddress(scope) : groupId}:${PAYMENTS_PACKAGE_ID}`
  const recovery = usePendingCreation(open, "create-recurring", receiptScope)
  const submitting = useRef(createSubmissionGuard())
  const selectedAsset = assets.find(asset => asset.coinType === token)
  const canSave = Boolean(
    selectedAsset?.decimals !== null && selectedAsset && !deploymentError &&
    isValidSuiAddress(recipient.trim()) && Number.isFinite(Number(amount)) && Number(amount) > 0 && startDate &&
    (endType !== "date" || (endDate && startOfDay(endDate) >= startOfDay(startDate))) &&
    (endType !== "occurrences" || (Number.isInteger(Number(endAfterOccurrences)) && Number(endAfterOccurrences) > 0)) &&
    (endType !== "never" || /^\d+$/.test(prepaidCount) && BigInt(prepaidCount) > 0n)
  )


  const frequencies = [
    { value: "daily", label: "Daily" },
    { value: "weekly", label: "Weekly" },
    { value: "biweekly", label: "Bi-weekly" },
    { value: "monthly", label: "Monthly" },
    { value: "quarterly", label: "Quarterly" },
    { value: "yearly", label: "Yearly" },
  ]

  const finishCreation = async (result: WalletTransactionResult) => {
    recovery.setPending(result.receipt)
    let found = false
    for (const id of result.createdObjects) {
      try {
        const payment = await scheduledPaymentsReader.readPayment(id)
        if (payment.scope === normalizeSuiAddress(scope || ZERO_SCOPE) && payment.schedule.$kind === "Recurring") { found = true; break }
      } catch { /* A transaction also creates a PaymentCap; only Payment objects are recovered here. */ }
    }
    if (!found) throw new TransactionReceiptError(t("payments.schedErrPaymentNotRead"), result.receipt)
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
    if (!canSave || recovery.blocked || !startDate || selectedAsset?.decimals == null || !submitting.current.enter()) return
    setSaveError(null)
    setIsProcessing(true)
    try {
      const account = getTransactionAccount()
      assertAssetOwner(assetOwnerKey, account)
      if (!scope) throw new Error(t("payments.schedErrNoOrg"))
      await scheduledPaymentsReader.requireDeployment()
      assertTransactionAccount(account)
      assertAssetOwner(assetOwnerKey, getTransactionAccount())
      const startMs = BigInt(startDate.getTime())
      if (startMs <= BigInt(Date.now())) throw new Error(t("payments.schedErrStartInFuture"))
      const intervalMs = FREQUENCY_MS[frequency]
      const endMs = endType === "date" && endDate ? BigInt(endOfDay(endDate).getTime()) : 0n
      const count = recurringCount(startMs, intervalMs, endType, endAfterOccurrences, endMs)
      const installments = count || BigInt(prepaidCount)
      const units = paymentUnits(amount, selectedAsset.decimals)
      const funding = units * installments
      if (funding > selectedAsset.rawBalance) throw new Error(t("payments.schedErrInsufficientFunding"))
      const tx = buildCreatePayment({ recipient: normalizeSuiAddress(recipient.trim()), scope, name: description.trim() || "Recurring payment", coinType: token, funding, startMs, amount: units, intervalMs, maxCount: endType === "occurrences" ? count : 0n, endMs, requiresApproval })
      tx.setSender(account.address)
      const result = await signAndExecuteWithWallet(tx, { action: "create-recurring", scope: receiptScope, expectedAccount: account, metadata: { name: description.trim() || "Recurring payment", coinType: token, funding: funding.toString(), recipient: normalizeSuiAddress(recipient.trim()) } })
      await finishCreation(result)
    } catch (error) {
      if (error instanceof TransactionReceiptError) recovery.setPending(error.status === "failed" ? undefined : error.receipt)
      setSaveError(error instanceof Error ? error.message : t("payments.schedErrCreateFailed"))
    } finally {
      submitting.current.leave()
      setIsProcessing(false)
    }
  }

  const fundingPreview = (() => {
    try {
      if (!startDate || selectedAsset?.decimals == null) return t("payments.schedPreviewUnset")
      const end = endType === "date" && endDate ? BigInt(endOfDay(endDate).getTime()) : undefined
      const count = recurringCount(BigInt(startDate.getTime()), FREQUENCY_MS[frequency], endType, endAfterOccurrences, end)
      const amountUnits = paymentUnits(amount, selectedAsset.decimals)
      return `${formatCoinBalance(amountUnits * (count || BigInt(prepaidCount)), selectedAsset.decimals)} ${selectedAsset.symbol}`
    } catch { return t("payments.schedPreviewInvalid") }
  })()

  const getFrequencyText = () => {
    switch (frequency) {
      case "daily":
        return "day"
      case "weekly":
        return "week"
      case "biweekly":
        return "2 weeks"
      case "monthly":
        return "month"
      case "quarterly":
        return "3 months"
      case "yearly":
        return "year"
      default:
        return "month"
    }
  }

  const getEndDateText = () => {
    if (endType === "never") return "No planned end date"
    if (endType === "occurrences") return `After ${endAfterOccurrences} planned payments`
    if (endType === "date" && endDate) return `Until ${format(endDate, "PPP")}`
    return "Not specified"
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px] max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Create Funded Recurring Payment</DialogTitle>
          <DialogDescription>{t("payments.schedDescription")}{groupId ? ` ${t("payments.schedDescriptionGroup")}` : ""}</DialogDescription>
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
              <p className="text-xs text-muted-foreground">Enter a complete Sui address. The recipient cannot be changed after funding.</p>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="amount">Amount</Label>
                <Input
                  id="amount"
                  type="number"
                  min="0"
                  step="any"
                  placeholder="0.00"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
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

            <div className="space-y-2">
              <Label>Planned Payment Frequency</Label>
              <RadioGroup value={frequency} onValueChange={setFrequency} className="grid grid-cols-3 gap-2">
                {frequencies.map((f) => (
                  <div key={f.value} className="flex items-center space-x-2">
                    <RadioGroupItem value={f.value} id={`frequency-${f.value}`} />
                    <Label htmlFor={`frequency-${f.value}`} className="text-sm cursor-pointer">
                      {f.label}
                    </Label>
                  </div>
                ))}
              </RadioGroup>
              <p className="text-xs text-muted-foreground">{t("payments.schedFrequencyNote")}</p>
            </div>

            <div className="space-y-2">
              <Label>Planned Start Date</Label>
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant={"outline"}
                    className={cn("w-full justify-start text-left font-normal", !startDate && "text-muted-foreground")}
                  >
                    <CalendarIcon className="mr-2 h-4 w-4" />
                    {startDate ? format(startDate, "PPP") : "Select date"}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0">
                  <Calendar mode="single" selected={startDate} onSelect={setStartDate} />
                </PopoverContent>
              </Popover>
            </div>

            <div className="space-y-2">
              <Label>Planned End Condition</Label>
              <RadioGroup value={endType} onValueChange={setEndType} className="space-y-2">
                <div className="flex items-center space-x-2">
                  <RadioGroupItem value="occurrences" id="end-occurrences" />
                  <Label htmlFor="end-occurrences" className="text-sm cursor-pointer flex items-center">
                    <Repeat className="h-4 w-4 mr-2" />
                    After
                    <Input
                      type="number"
                      min="1"
                      step="1"
                      aria-label="Number of planned payments"
                      value={endAfterOccurrences}
                      onChange={(e) => setEndAfterOccurrences(e.target.value)}
                      className="w-16 mx-2 h-7 text-sm"
                      disabled={endType !== "occurrences"}
                    />
                    payments
                  </Label>
                </div>

                <div className="flex items-center space-x-2">
                  <RadioGroupItem value="date" id="end-date" />
                  <Label htmlFor="end-date" className="text-sm cursor-pointer flex items-center">
                    <CalendarIcon2 className="h-4 w-4 mr-2" />
                    On specific date
                    <Popover>
                      <PopoverTrigger asChild>
                        <Button
                          variant={"outline"}
                          className={cn("ml-2 h-7 text-sm", !endDate && "text-muted-foreground")}
                          disabled={endType !== "date"}
                        >
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
                            return startOfDay(date) < startOfDay(startDate)
                          }}
                        />
                      </PopoverContent>
                    </Popover>
                  </Label>
                </div>

                <div className="flex items-center space-x-2">
                  <RadioGroupItem value="never" id="end-never" />
                  <Label htmlFor="end-never" className="text-sm cursor-pointer flex items-center">
                    <Clock className="h-4 w-4 mr-2" />
                    No planned end date
                  </Label>
                </div>
              </RadioGroup>
            </div>

            {endType === "never" && <div className="space-y-2">
              <Label htmlFor="prepaid-count">Prepaid installments</Label>
              <Input id="prepaid-count" type="number" min="1" step="1" value={prepaidCount} onChange={event => setPrepaidCount(event.target.value)} />
              <p className="text-xs text-muted-foreground">{t("payments.schedPrepaidNote")}</p>
            </div>}
            <div className="space-y-2">
              <Label htmlFor="description">Description (Optional)</Label>
              <Textarea
                id="description"
                placeholder="Add details about this recurring payment"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="resize-none h-20"
              />
            </div>

            <div className="flex items-center space-x-2">
              <Switch id="requires-approval" checked={requiresApproval} onCheckedChange={setRequiresApproval} />
              <Label htmlFor="requires-approval" className="cursor-pointer">
                Require PaymentCap approval and execution for every installment
              </Label>
            </div>

            <div className="bg-muted/50 p-3 rounded-lg space-y-2">
              <h4 className="text-sm font-medium">Funded Schedule Summary</h4>
              <div className="text-sm space-y-1">
                <p>
                  Planned amount: {amount ? `${amount} ${selectedAsset?.symbol || ""}` : "Not specified"} to {recipient || "recipient"} every{" "}
                  {getFrequencyText()}.
                </p>
                <p>{t("payments.schedFundingTotal", { preview: fundingPreview })}</p>
                <p>Planned start: {startDate ? format(startDate, "PPP") : "Not specified"}</p>
                <p>{getEndDateText()}</p>
                <p>
                  {requiresApproval ? t("payments.schedApprovalNote") : t("payments.schedOpenNote")}
                </p>
                <p className="text-xs text-muted-foreground">{t("payments.schedFundingNote")}</p>
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
                <Check className="h-4 w-4 mr-2" />
                Fund and Create Schedule
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
