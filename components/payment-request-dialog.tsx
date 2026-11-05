"use client"

import { useState, useEffect } from "react"
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
import { format, addDays } from "date-fns"
import { cn } from "@/lib/utils"
import { CalendarIcon, Copy, Plus, Send, Share2, CreditCard, Trash } from "lucide-react"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { QRCodeSVG } from "qrcode.react"
import { getActiveAccount } from "@/lib/onchain-store"
import { parseDecimalValue } from "@/lib/coin-amount"
import { buildPaymentLink, canonicalPaymentAssets, paymentAssetBySymbol } from "@/lib/payment-assets"
import { useI18n } from "@/components/i18n-provider"

interface PaymentRequestDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  groupId?: string
}

interface MultiRecipient {
  id: string
  address: string
  amount: string
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError"
}

function isValidSuiAddress(value: string) {
  return /^0x[0-9a-fA-F]{1,64}$/.test(value.trim())
}

export function PaymentRequestDialog({ open, onOpenChange }: PaymentRequestDialogProps) {
  const { t } = useI18n()
  const [requestType, setRequestType] = useState("single")
  const [recipient, setRecipient] = useState("")
  const [amount, setAmount] = useState("10")
  const [token, setToken] = useState("SUI")
  const [dueDate, setDueDate] = useState<Date | undefined>(addDays(new Date(), 7))
  const [description, setDescription] = useState(t("payments.reqDefaultDescription"))
  const [sendNotification, setSendNotification] = useState(false)
  const [isGenerated, setIsGenerated] = useState(false)
  const [requestLink, setRequestLink] = useState("")
  const [generatedRequest, setGeneratedRequest] = useState<{ amount: string; symbol: string; payer: string; due: string } | null>(null)
  const [paymentMethod, setPaymentMethod] = useState("wallet")
  const [error, setError] = useState("")
  const [actionStatus, setActionStatus] = useState("")
  // Multi-recipient requests produce one split table (CSV) of independent
  // Payment Kit links. Nothing is delivered by this app; the payer still has to
  // approve each transfer in their wallet.
  const [multiRecipients, setMultiRecipients] = useState<MultiRecipient[]>([{ id: "1", address: "", amount: "" }])
  const [multiLinks, setMultiLinks] = useState("")
  const [nonce] = useState(() => crypto.randomUUID())

  useEffect(() => {
    const reset = () => {
      setIsGenerated(false)
      setRequestLink("")
      setMultiLinks("")
      setGeneratedRequest(null)
      setError("")
      setActionStatus("")
    }
    reset()
    window.addEventListener("sui-account-switched", reset)
    return () => window.removeEventListener("sui-account-switched", reset)
  }, [open])

  // USDT is only listed once an operator configures its exact coin type; the
  // picker never offers a symbol whose on-chain asset is unknown.
  const assets = canonicalPaymentAssets().filter(asset => asset.source !== "unavailable")
  const asset = paymentAssetBySymbol(token)
  const emailRecipient = recipient.includes("@") ? recipient.trim() : ""

  const handleSubmit = () => {
    const account = getActiveAccount()
    if (!account?.address) {
      setError(t("payments.reqErrConnectWallet"))
      return
    }
    if (paymentMethod !== "wallet") {
      setError(t("payments.reqErrCardUnsupported"))
      return
    }
    if (!asset) {
      setError(t("payments.reqErrPickToken"))
      return
    }
    const total = parseDecimalValue(amount)
    if (!total || total.units === 0n) {
      setError(t("payments.reqErrInvalidAmount"))
      return
    }

    if (requestType === "multiple") {
      const rows = multiRecipients.filter(row => row.address.trim())
      if (!rows.length) {
        setError(t("payments.reqErrNeedRecipients"))
        return
      }
      try {
        const lines = rows.map((row, index) => {
          if (!isValidSuiAddress(row.address)) throw new Error(t("payments.reqErrRowAddress", { row: index + 1 }))
          const rowAmount = parseDecimalValue(row.amount)
          if (!rowAmount || rowAmount.units === 0n) throw new Error(t("payments.reqErrRowAmount", { row: index + 1 }))
          return `${row.address.trim()},${row.amount.trim()},${token},${buildPaymentLink({ address: row.address.trim(), total: rowAmount, asset, nonce: `${nonce}-${index}`, label: description || undefined })}`
        })
        setError("")
        setActionStatus("")
        setMultiLinks(["address,amount,symbol,payment_link", ...lines].join("\n"))
        setGeneratedRequest({ amount: String(rows.length), symbol: t("payments.reqRecipientUnit"), payer: rows.map(row => row.address.trim()).join(", "), due: dueDate ? format(dueDate, "PPP") : "Not specified" })
        setIsGenerated(true)
      } catch (buildError) {
        setError(buildError instanceof Error ? buildError.message : t("payments.reqErrCannotGenerate"))
      }
      return
    }

    if (!recipient.trim()) {
      setError(t("payments.reqErrNeedPayer"))
      return
    }
    try {
      const realUri = buildPaymentLink({ address: account.address, total, asset, nonce, label: description || "Wallet Transfer" })
      setError("")
      setActionStatus("")
      setGeneratedRequest({ amount: amount.trim(), symbol: asset.symbol, payer: account.address, due: dueDate ? format(dueDate, "PPP") : "Not specified" })
      setIsGenerated(true)
      setRequestLink(realUri)
    } catch (buildError) {
      setError(buildError instanceof Error ? buildError.message : t("payments.reqErrCannotGenerate"))
    }
  }

  const copyToClipboard = async () => {
    const text = requestType === "multiple" ? multiLinks : requestLink
    try {
      await navigator.clipboard.writeText(text)
      setActionStatus(requestType === "multiple" ? t("payments.reqCsvCopied") : t("payments.reqLinkCopied"))
      setError("")
    } catch {
      setError(t("payments.reqErrClipboard"))
    }
  }

  const shareRequest = async () => {
    if (!navigator.share) {
      setError(t("payments.reqErrShareUnsupported"))
      return
    }
    if (requestType === "multiple") {
      setError(t("payments.reqErrShareCsv"))
      return
    }
    try {
      await navigator.share({
        title: `Payment request · ${amount} ${token}`,
        text: t("payments.reqShareText", { account: accountLabel(), amount, token }) + description,
        url: requestLink,
      })
      setActionStatus(t("payments.reqShareHandedOff"))
      setError("")
    } catch (shareError) {
      if (isAbortError(shareError)) return
      setError(t("payments.reqErrShareFailed"))
    }
  }

  const openEmailDraft = () => {
    if (requestType === "multiple") {
      setError(t("payments.reqErrEmailCsv"))
      return
    }
    if (!emailRecipient) {
      setError(t("payments.reqErrNotEmail"))
      return
    }
    const subject = `Payment request · ${amount} ${token}`
    const body = [
      `Payment request: ${amount} ${token}`,
      `Pay to: ${getActiveAccount()?.address || "current wallet"}`,
      `Due: ${dueDate ? format(dueDate, "yyyy-MM-dd") : "not specified"}`,
      `Link: ${requestLink}`,
      description,
      "",
      "This opens a local email draft. No email was sent by this app.",
    ].join("\n")
    window.location.href = `mailto:${encodeURIComponent(emailRecipient)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
    setActionStatus(t("payments.reqEmailDraftOpened"))
    setError("")
  }

  const accountLabel = () => getActiveAccount()?.address || t("payments.reqCurrentWallet")

  const addRecipient = () => setMultiRecipients(rows => [...rows, { id: crypto.randomUUID(), address: "", amount: "" }])
  const updateRecipient = (id: string, patch: Partial<MultiRecipient>) => setMultiRecipients(rows => rows.map(row => row.id === id ? { ...row, ...patch } : row))
  const removeRecipient = (id: string) => setMultiRecipients(rows => rows.length > 1 ? rows.filter(row => row.id !== id) : rows)

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        onOpenChange(value)
        if (!value) {
          setIsGenerated(false)
          setRequestLink("")
          setMultiLinks("")
          setGeneratedRequest(null)
          setError("")
          setActionStatus("")
        }
      }}
    >
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>{isGenerated ? (requestType === "multiple" ? "Split Request Ready" : "Payment Request Created") : "Request Payment"}</DialogTitle>
          <DialogDescription>
            {isGenerated
              ? requestType === "multiple"
                ? t("payments.reqDescMultiDone")
                : t("payments.reqDescSingleDone")
              : t("payments.reqDescCreate")}
          </DialogDescription>
        </DialogHeader>

        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {actionStatus && <p role="status" className="text-sm text-muted-foreground">{actionStatus}</p>}

        {isGenerated ? (
          <div className="space-y-4 py-4">
            {requestType === "multiple" ? (
              <>
                <div className="p-3 border rounded-lg bg-muted/30 space-y-1">
                  <p className="text-sm font-medium">{t("payments.reqRecipientCount", { count: multiRecipients.filter(row => row.address.trim()).length, token })}</p>
                  <p className="text-xs text-muted-foreground">Due by {generatedRequest?.due}</p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="multi-links">{t("payments.reqCsvLabel")}</Label>
                  <Textarea id="multi-links" value={multiLinks} readOnly className="h-40 font-mono text-[11px]" />
                  <p className="text-xs text-muted-foreground">{t("payments.reqCsvNote")}</p>
                </div>
              </>
            ) : (
              <>
                <div className="p-4 border rounded-lg bg-muted/30 flex flex-col items-center">
                  <div className="w-48 h-48 bg-white p-2 rounded-lg mb-4">
                    <QRCodeSVG value={requestLink} size={176} />
                  </div>
                  <div className="text-center">
                    <p className="font-medium">Request for {generatedRequest?.amount} {generatedRequest?.symbol}</p>
                    <p className="text-sm text-muted-foreground">Due by {generatedRequest?.due}</p>
                    <p className="mt-1 text-xs text-muted-foreground break-all">Pay to {generatedRequest?.payer}</p>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label>Payment Link</Label>
                  <div className="flex">
                    <Input value={requestLink} readOnly className="rounded-r-none" aria-label="Payment request link" />
                    <Button variant="secondary" className="rounded-l-none" onClick={copyToClipboard}>
                      <Copy className="h-4 w-4" />
                      <span className="sr-only">Copy payment link</span>
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">{t("payments.reqPrecisionNote", { token })}</p>
                </div>
              </>
            )}

            <div className="flex flex-wrap justify-center gap-2 pt-2">
              <Button variant="outline" onClick={openEmailDraft} className="flex items-center" disabled={requestType === "multiple"}>
                <Send className="h-4 w-4 mr-2" />
                Email draft
              </Button>
              <Button variant="outline" onClick={shareRequest} className="flex items-center">
                <Share2 className="h-4 w-4 mr-2" />
                Share
              </Button>
              <Button variant="outline" onClick={copyToClipboard} className="flex items-center">
                <Copy className="h-4 w-4 mr-2" />
                {requestType === "multiple" ? t("payments.reqCopyCsv") : t("payments.reqCopyLink")}
              </Button>
              <Button variant="outline" onClick={() => { setIsGenerated(false); setActionStatus("") }}>
                Edit request
              </Button>
            </div>
            {sendNotification && <p className="text-xs text-muted-foreground text-center">{t("payments.reqNotifyNote")}</p>}
          </div>
        ) : (
          <div className="space-y-4 py-4">
            <Tabs value={requestType} onValueChange={setRequestType}>
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="single">Single Request</TabsTrigger>
                <TabsTrigger value="multiple">Multiple Recipients</TabsTrigger>
              </TabsList>

              <TabsContent value="single" className="space-y-4 pt-4">
                <div className="space-y-2">
                  <Label htmlFor="recipient">Requested payer address or email</Label>
                  <Input
                    id="recipient"
                    placeholder="0x... or email@example.com"
                    value={recipient}
                    onChange={(event) => setRecipient(event.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">This identifies who you plan to share with. The connected wallet remains the payment destination.</p>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="amount">Amount</Label>
                    <Input id="amount" type="number" min="0" step="any" placeholder="0.00" value={amount} onChange={(event) => setAmount(event.target.value)} />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="token">Token</Label>
                    <Select value={token} onValueChange={setToken}>
                      <SelectTrigger id="token"><SelectValue placeholder="Select token" /></SelectTrigger>
                      <SelectContent>{assets.map((value) => <SelectItem key={value.symbol} value={value.symbol}>{value.symbol}</SelectItem>)}</SelectContent>
                    </Select>
                  </div>
                </div>
              </TabsContent>

              <TabsContent value="multiple" className="space-y-3 pt-4">
                <p className="text-xs text-muted-foreground">{t("payments.reqMultiIntro")}</p>
                <div className="grid grid-cols-[1fr,90px,28px] gap-2 text-[11px] text-muted-foreground"><span>{t("payments.reqColAddress")}</span><span>{t("payments.reqColAmount", { token })}</span><span /></div>
                <div className="space-y-2 max-h-[180px] overflow-y-auto pr-1">
                  {multiRecipients.map((row, index) => <div key={row.id} className="grid grid-cols-[1fr,90px,28px] gap-2 items-center">
                    <Input aria-label={t("payments.reqRowAddressLabel", { row: index + 1 })} placeholder="0x..." value={row.address} onChange={(event) => updateRecipient(row.id, { address: event.target.value })} className="font-mono text-xs" />
                    <Input aria-label={t("payments.reqRowAmountLabel", { row: index + 1 })} type="number" min="0" step="any" placeholder="0.00" value={row.amount} onChange={(event) => updateRecipient(row.id, { amount: event.target.value })} className="text-xs" />
                    <Button type="button" variant="ghost" size="icon" className="h-8 w-8" aria-label={t("payments.reqRowRemoveLabel", { row: index + 1 })} disabled={multiRecipients.length === 1} onClick={() => removeRecipient(row.id)}><Trash className="h-3.5 w-3.5" /></Button>
                  </div>)}
                </div>
                <div className="flex items-center justify-between">
                  <Button type="button" variant="outline" size="sm" className="h-7 text-xs" onClick={addRecipient}><Plus className="mr-1 h-3 w-3" />{t("payments.reqAddRecipient")}</Button>
                  <Select value={token} onValueChange={setToken}><SelectTrigger className="h-7 w-28 text-xs"><SelectValue /></SelectTrigger><SelectContent>{assets.map((value) => <SelectItem key={value.symbol} value={value.symbol}>{value.symbol}</SelectItem>)}</SelectContent></Select>
                </div>
              </TabsContent>
            </Tabs>

            <div className="space-y-2">
              <Label>Due Date</Label>
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" className={cn("w-full justify-start text-left font-normal", !dueDate && "text-muted-foreground")}>
                    <CalendarIcon className="mr-2 h-4 w-4" />
                    {dueDate ? format(dueDate, "PPP") : "Select date"}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0"><Calendar mode="single" selected={dueDate} onSelect={setDueDate} disabled={(date) => date < new Date()} /></PopoverContent>
              </Popover>
            </div>

            <div className="space-y-2">
              <Label htmlFor="description">Description (Optional)</Label>
              <Textarea id="description" placeholder="What is this payment for?" value={description} onChange={(event) => setDescription(event.target.value)} className="resize-none h-20" />
            </div>

            <div className="space-y-2">
              <Label>Payment Method</Label>
              <RadioGroup value={paymentMethod} onValueChange={setPaymentMethod} className="flex space-x-4">
                <div className="flex items-center space-x-2"><RadioGroupItem value="wallet" id="payment-wallet" /><Label htmlFor="payment-wallet" className="cursor-pointer flex items-center"><CreditCard className="h-4 w-4 mr-2" />Crypto Wallet</Label></div>
                <div className="flex items-center space-x-2"><RadioGroupItem value="card" id="payment-card" disabled /><Label htmlFor="payment-card" className="cursor-pointer flex items-center text-muted-foreground"><CreditCard className="h-4 w-4 mr-2" />Credit Card (Coming Soon)</Label></div>
              </RadioGroup>
              <p className="text-[11px] text-muted-foreground">{t("payments.reqCardDisabledNote")}</p>
            </div>

            <div className="flex items-center space-x-2">
              <Switch id="send-notification" checked={sendNotification} onCheckedChange={setSendNotification} />
              <Label htmlFor="send-notification" className="cursor-pointer">Remember that I plan to notify the requested payer</Label>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{isGenerated ? "Close" : "Cancel"}</Button>
          {!isGenerated && <Button onClick={handleSubmit} disabled={requestType === "single" ? (!amount || !recipient.trim()) : false} className="bg-gradient-to-r from-primary to-purple-500 hover:from-primary/90 hover:to-purple-500/90">Create Request</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
