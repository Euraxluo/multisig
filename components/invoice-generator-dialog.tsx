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
import { normalizeSuiAddress } from "@mysten/sui/utils"
import { CalendarIcon, FileText, Plus, Trash, Download, Share2, Copy, Send, Check } from "lucide-react"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import { getActiveAccount } from "@/lib/onchain-store"
import {
  computeInvoiceTotal,
  invoiceItemTotal,
  invoiceTotal,
  invoiceTotalUnits,
  legacyInvoiceLink,
  saveInvoice,
  type InvoiceItem,
  type StoredInvoice,
} from "@/lib/invoice-records"
import { formatDecimal } from "@/lib/coin-amount"
import { t as ti18n } from "@/lib/i18n/t"
import { useI18n } from "@/components/i18n-provider"
import {
  buildPaymentLink,
  canonicalPaymentAssets,
  paymentAssetBySymbol,
  type PaymentAsset,
} from "@/lib/payment-assets"

interface InvoiceGeneratorDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  groupId?: string
  // A saved draft reopened from the invoice list. It starts in preview so the
  // shared link, export and email actions stay available without editing.
  initialInvoice?: StoredInvoice
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError"
}

function newNonce() {
  return crypto.randomUUID()
}

export function InvoiceGeneratorDialog({ open, onOpenChange, groupId, initialInvoice }: InvoiceGeneratorDialogProps) {
  const { t } = useI18n()
  const [recipient, setRecipient] = useState(initialInvoice?.recipient ?? "")
  const [recipientEmail, setRecipientEmail] = useState(initialInvoice?.recipientEmail ?? "")
  const [invoiceNumber, setInvoiceNumber] = useState(initialInvoice?.invoiceNumber ?? `INV-${Date.now().toString().slice(-6)}`)
  const [issueDate, setIssueDate] = useState<Date | undefined>(initialInvoice?.issueDate ? new Date(initialInvoice.issueDate) : new Date())
  const [dueDate, setDueDate] = useState<Date | undefined>(initialInvoice?.dueDate ? new Date(initialInvoice.dueDate) : addDays(new Date(), 30))
  const [token, setToken] = useState(initialInvoice?.token ?? "SUI")
  const [items, setItems] = useState<InvoiceItem[]>(initialInvoice?.items?.length ? initialInvoice.items : [{ id: "1", description: "", quantity: "1", price: "" }])
  const [notes, setNotes] = useState(initialInvoice?.notes ?? "")
  // A reopened draft keeps the payee it was issued with; a new draft pays the
  // currently connected account. These must not be conflated.
  const [savedPaymentAddress, setSavedPaymentAddress] = useState(initialInvoice?.paymentAddress ?? "")
  const [nonce, setNonce] = useState(initialInvoice?.nonce ?? newNonce())
  const [sendEmail, setSendEmail] = useState(false)
  const [isProcessing, setIsProcessing] = useState(false)
  const [isPreview, setIsPreview] = useState(Boolean(initialInvoice))
  const [error, setError] = useState("")
  const [actionStatus, setActionStatus] = useState("")

  // Re-hydrate when a different saved draft is opened in the same mounted dialog.
  useEffect(() => {
    if (!initialInvoice) return
    setRecipient(initialInvoice.recipient)
    setRecipientEmail(initialInvoice.recipientEmail ?? "")
    setInvoiceNumber(initialInvoice.invoiceNumber)
    setIssueDate(initialInvoice.issueDate ? new Date(initialInvoice.issueDate) : undefined)
    setDueDate(initialInvoice.dueDate ? new Date(initialInvoice.dueDate) : undefined)
    setToken(initialInvoice.token)
    setItems(initialInvoice.items)
    setNotes(initialInvoice.notes ?? "")
    setSavedPaymentAddress(initialInvoice.paymentAddress)
    setNonce(initialInvoice.nonce ?? newNonce())
    setIsPreview(true)
    setError("")
    setActionStatus("")
  }, [initialInvoice])

  // Opening without a saved draft always starts a fresh invoice, so a reopened
  // draft's payee, number and nonce never leak into a new one.
  useEffect(() => {
    if (!open || initialInvoice) return
    setRecipient("")
    setRecipientEmail("")
    setInvoiceNumber(`INV-${Date.now().toString().slice(-6)}`)
    setIssueDate(new Date())
    setDueDate(addDays(new Date(), 30))
    setToken("SUI")
    setItems([{ id: "1", description: "", quantity: "1", price: "" }])
    setNotes("")
    setSavedPaymentAddress("")
    setNonce(newNonce())
    setSendEmail(false)
    setIsPreview(false)
    setError("")
    setActionStatus("")
  }, [open, initialInvoice])

  useEffect(() => {
    const reset = () => {
      setIsPreview(false)
      setError("")
      setActionStatus("")
    }
    window.addEventListener("sui-account-switched", reset)
    return () => window.removeEventListener("sui-account-switched", reset)
  }, [])

  const assets = canonicalPaymentAssets()
  const asset: PaymentAsset | undefined = paymentAssetBySymbol(token)
  const activeAddress = getActiveAccount()?.address || ""
  const paymentAddress = savedPaymentAddress || activeAddress

  const total = invoiceTotal(items)
  const totalDisplay = computeInvoiceTotal(items)

  // A link is only claimable when the asset has a real on-chain type and the
  // total fits that coin's precision. Otherwise the draft keeps its legacy link
  // (if it had one) and the UI says the link is stale rather than presenting it.
  const legacy = legacyInvoiceLink(initialInvoice?.paymentUri)
  let paymentUri = ""
  let linkError = ""
  if (paymentAddress && asset) {
    try {
      paymentUri = buildPaymentLink({ address: paymentAddress, total, asset, nonce, label: `Invoice ${invoiceNumber}`, message: notes })
    } catch (buildError) {
      linkError = buildError instanceof Error ? buildError.message : t("payments.reqErrCannotGenerate")
    }
  }
  // A legacy link only speaks for the draft it was written with: same payee,
  // same symbol, and the amount must still equal the draft's current total.
  const legacyUri = !paymentUri && initialInvoice?.paymentUri && legacy
    && normalizeSuiAddress(legacy.address) === normalizeSuiAddress(paymentAddress)
    && legacy.symbol?.toUpperCase() === token.toUpperCase()
    && legacy.amount === totalDisplay
    ? initialInvoice.paymentUri
    : ""
  const displayUri = paymentUri || legacyUri

  const invoiceText = () => [
    "Sui Web3 invoice",
    `Invoice number: ${invoiceNumber}`,
    `Amount: ${totalDisplay} ${token}${asset?.source === "unavailable" ? ` (${t("payments.invUnconfiguredSuffix")})` : ""}`,
    `Bill to: ${recipient}`,
    recipientEmail ? `Email: ${recipientEmail}` : "",
    `Pay to: ${paymentAddress}`,
    `Issue date: ${format(issueDate || new Date(), "yyyy-MM-dd")}`,
    `Due date: ${dueDate ? format(dueDate, "yyyy-MM-dd") : "Not specified"}`,
    "",
    ...items.map((item) => `${item.description}: ${item.quantity} × ${item.price} ${token}`),
    notes ? `\nNotes: ${notes}` : "",
    `\nPayment link (${paymentUri ? "Payment Kit" : "legacy draft link"}): ${displayUri || "not available"}`,
  ].filter(Boolean).join("\n")

  const handleSubmit = () => {
    if (isPreview) {
      // The switch only promises an email draft when it is on. With it off the
      // preview closes without opening a mail client.
      if (sendEmail) openEmailDraft()
      else onOpenChange(false)
      return
    }

    if (!asset) {
      setError(t("payments.invErrPickToken"))
      return
    }
    if (!paymentAddress) {
      setError(t("payments.invErrNeedAddress"))
      return
    }
    if (!recipient.trim() || !invoiceNumber.trim()) {
      setError(t("payments.invErrNeedNumberRecipient"))
      return
    }
    if (items.some((item) => !item.description.trim())) {
      setError(t("payments.invErrNeedItemNames"))
      return
    }
    if (items.some((item) => invoiceItemTotal(item).units === 0n)) {
      setError(t("payments.invErrItemValues"))
      return
    }
    if (asset.source === "unavailable") {
      setError(t("payments.invErrTokenUnconfigured", { symbol: asset.symbol }))
      return
    }
    let totalUnits: bigint
    try {
      totalUnits = invoiceTotalUnitsOrThrow(items, asset.decimals)
    } catch (precisionError) {
      setError(precisionError instanceof Error ? precisionError.message : t("payments.invErrPrecision"))
      return
    }

    setIsProcessing(true)
    try {
      let uri = ""
      try {
        uri = buildPaymentLink({ address: paymentAddress, total, asset, nonce, label: `Invoice ${invoiceNumber}`, message: notes })
      } catch (buildError) {
        setError(buildError instanceof Error ? buildError.message : t("payments.invErrLinkBuildFailed"))
        return
      }
      saveInvoice({
        invoiceNumber: invoiceNumber.trim(),
        recipient: recipient.trim(),
        recipientEmail: recipientEmail.trim(),
        issueDate: issueDate?.toISOString(),
        dueDate: dueDate?.toISOString(),
        token: asset.symbol,
        coinType: asset.coinType,
        totalUnits: totalUnits.toString(),
        nonce,
        items,
        notes,
        total: totalDisplay,
        paymentAddress,
        paymentUri: uri,
        groupId: groupId || initialInvoice?.groupId,
        source: "local",
      })
      setError("")
      setActionStatus(initialInvoice ? t("payments.invDraftUpdated") : t("payments.invDraftSaved"))
      setIsPreview(true)
    } catch {
      setError(t("payments.invErrSaveFailed"))
    } finally {
      setIsProcessing(false)
    }
  }

  const copyPaymentLink = async () => {
    if (!displayUri) {
      setError(linkError || t("payments.invErrNoPaymentAddress"))
      return
    }
    try {
      await navigator.clipboard.writeText(displayUri)
      setActionStatus(paymentUri ? t("payments.invLinkCopied") : t("payments.invLegacyLinkCopied"))
      setError("")
    } catch {
      setError(t("payments.invErrClipboard"))
    }
  }

  const exportInvoice = () => {
    const blob = new Blob([invoiceText()], { type: "text/plain;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = `${invoiceNumber}.txt`
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    URL.revokeObjectURL(url)
    setActionStatus(t("payments.invExported"))
    setError("")
  }

  const shareInvoice = async () => {
    if (!navigator.share) {
      setError(t("payments.invErrShareUnsupported"))
      return
    }
    try {
      await navigator.share({ title: `Invoice ${invoiceNumber}`, text: invoiceText(), url: displayUri || undefined })
      setActionStatus(t("payments.invShareHandedOff"))
      setError("")
    } catch (shareError) {
      if (isAbortError(shareError)) return
      setError(t("payments.invErrShareFailed"))
    }
  }

  const openEmailDraft = () => {
    if (!recipientEmail.trim()) {
      setError(t("payments.invErrNeedEmail"))
      return
    }
    const subject = `Invoice ${invoiceNumber} · ${totalDisplay} ${token}`
    const body = `${invoiceText()}\n\nThis is a local email draft. No email was sent by this app.`
    window.location.href = `mailto:${encodeURIComponent(recipientEmail.trim())}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
    setActionStatus(t("payments.reqEmailDraftOpened"))
    setError("")
  }

  const addItem = () => {
    setItems([...items, { id: crypto.randomUUID(), description: "", quantity: "1", price: "" }])
  }

  const updateItem = (id: string, field: keyof InvoiceItem, value: string) => {
    setItems(items.map((item) => (item.id === id ? { ...item, [field]: value } : item)))
  }

  const removeItem = (id: string) => {
    if (items.length > 1) setItems(items.filter((item) => item.id !== id))
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!isProcessing) {
          onOpenChange(value)
          if (!value) {
            setIsPreview(false)
            setError("")
            setActionStatus("")
          }
        }
      }}
    >
      <DialogContent className={cn("sm:max-w-[600px]", isPreview && "sm:max-w-[700px]")}>
        <DialogHeader>
          <DialogTitle>{isPreview ? "Invoice Preview" : initialInvoice ? "Edit Saved Invoice Draft" : "Generate Invoice"}</DialogTitle>
          <DialogDescription>
            {isPreview ? t("payments.invDescPreview") : t("payments.invDescCreate")}
          </DialogDescription>
        </DialogHeader>

        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {actionStatus && <p role="status" className="text-sm text-muted-foreground">{actionStatus}</p>}
        {isProcessing ? (
          <div className="py-8 flex flex-col items-center justify-center">
            <div className="h-12 w-12 rounded-full border-4 border-primary border-t-transparent animate-spin mb-4"></div>
            <p className="font-medium">Saving local invoice...</p>
          </div>
        ) : isPreview ? (
          <div className="space-y-4 py-4">
            <div className="border rounded-lg p-6 bg-white text-black">
              <div className="flex justify-between items-start gap-4">
                <div>
                  <h2 className="text-2xl font-bold text-primary">INVOICE</h2>
                  <p className="text-sm text-muted-foreground mt-1">#{invoiceNumber}</p>
                </div>
                <div className="text-right max-w-[55%]">
                  <p className="font-medium">{t("payments.invPayTo")}</p>
                  <p className="text-sm text-muted-foreground break-all">{paymentAddress}</p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-8 mt-8">
                <div>
                  <p className="text-sm text-muted-foreground">Bill To:</p>
                  <p className="font-medium break-words">{recipient || t("payments.invNotFilled")}</p>
                  {recipientEmail && <p className="text-sm break-all">{recipientEmail}</p>}
                </div>
                <div className="text-right">
                  <div className="flex justify-end items-center gap-4">
                    <div><p className="text-sm text-muted-foreground">Issue Date:</p><p className="text-sm">{issueDate ? format(issueDate, "PPP") : "Not specified"}</p></div>
                    <div><p className="text-sm text-muted-foreground">Due Date:</p><p className="text-sm">{dueDate ? format(dueDate, "PPP") : "Not specified"}</p></div>
                  </div>
                </div>
              </div>

              <div className="mt-8 overflow-x-auto">
                <table className="w-full min-w-[460px]">
                  <thead><tr className="border-b"><th className="text-left py-2">Description</th><th className="text-right py-2">Quantity</th><th className="text-right py-2">Price</th><th className="text-right py-2">Amount</th></tr></thead>
                  <tbody>{items.map((item) => <tr key={item.id} className="border-b"><td className="py-2">{item.description}</td><td className="text-right py-2">{item.quantity}</td><td className="text-right py-2">{item.price} {token}</td><td className="text-right py-2">{formatDecimal(invoiceItemTotal(item), 2)} {token}</td></tr>)}</tbody>
                </table>
              </div>

              <div className="mt-4 flex justify-end"><div className="w-1/3"><div className="flex justify-between py-1"><span className="font-medium">Total:</span><span className="font-bold">{totalDisplay} {token}</span></div></div></div>
              {notes && <div className="mt-8 border-t pt-4"><p className="text-sm font-medium">Notes:</p><p className="text-sm text-muted-foreground whitespace-pre-wrap">{notes}</p></div>}
              <div className="mt-8 border-t pt-4 text-center">
                <p className="text-xs text-muted-foreground font-mono break-all">{t("payments.invPaymentAddress")} {paymentAddress}</p>
                {paymentUri ? <p className="mt-1 text-[11px] text-muted-foreground">{t("payments.invPaymentKitNote")}</p> : linkError ? <p className="mt-1 text-[11px] text-destructive">{linkError}</p> : null}
                {!paymentUri && legacyUri && <p className="mt-1 text-[11px] text-amber-600">{t("payments.invLegacyLinkNote")}</p>}
              </div>
            </div>

            <div className="flex flex-wrap justify-center gap-2">
              <Button variant="outline" className="flex items-center text-xs" onClick={copyPaymentLink}><Copy className="h-4 w-4 mr-2" />{t("payments.invCopyLink")}</Button>
              <Button variant="outline" className="flex items-center text-xs" onClick={exportInvoice}><Download className="h-4 w-4 mr-2" />{t("payments.invExportText")}</Button>
              <Button variant="outline" className="flex items-center text-xs" onClick={shareInvoice}><Share2 className="h-4 w-4 mr-2" />Share</Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4 py-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2"><Label htmlFor="invoice-number">Invoice Number</Label><Input id="invoice-number" value={invoiceNumber} onChange={(event) => setInvoiceNumber(event.target.value)} /></div>
              <div className="space-y-2">
                <Label htmlFor="token">Currency</Label>
                <Select value={token} onValueChange={setToken}>
                  <SelectTrigger id="token"><SelectValue placeholder="Select currency" /></SelectTrigger>
                  <SelectContent>{assets.map((value) => <SelectItem key={value.symbol} value={value.symbol} disabled={value.source === "unavailable"}>{value.source === "unavailable" ? t("payments.invTokenUnconfigured", { symbol: value.symbol }) : t("payments.invTokenDecimals", { symbol: value.symbol, decimals: value.decimals })}</SelectItem>)}</SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2"><Label>Issue Date</Label><Popover><PopoverTrigger asChild><Button variant="outline" className={cn("w-full justify-start text-left font-normal", !issueDate && "text-muted-foreground")}><CalendarIcon className="mr-2 h-4 w-4" />{issueDate ? format(issueDate, "PPP") : "Select date"}</Button></PopoverTrigger><PopoverContent className="w-auto p-0"><Calendar mode="single" selected={issueDate} onSelect={setIssueDate} /></PopoverContent></Popover></div>
              <div className="space-y-2"><Label>Due Date</Label><Popover><PopoverTrigger asChild><Button variant="outline" className={cn("w-full justify-start text-left font-normal", !dueDate && "text-muted-foreground")}><CalendarIcon className="mr-2 h-4 w-4" />{dueDate ? format(dueDate, "PPP") : "Select date"}</Button></PopoverTrigger><PopoverContent className="w-auto p-0"><Calendar mode="single" selected={dueDate} onSelect={setDueDate} disabled={(date) => issueDate ? date < issueDate : false} /></PopoverContent></Popover></div>
            </div>

            <div className="space-y-2"><Label htmlFor="recipient">Bill To (Address or Name)</Label><Input id="recipient" placeholder="0x... or Client Name" value={recipient} onChange={(event) => setRecipient(event.target.value)} /></div>
            <div className="space-y-2"><Label htmlFor="recipient-email">Client Email (Optional)</Label><Input id="recipient-email" type="email" placeholder="client@example.com" value={recipientEmail} onChange={(event) => setRecipientEmail(event.target.value)} /></div>

            <div className="space-y-2">
              <div className="flex items-center justify-between"><Label>Invoice Items</Label><Button type="button" variant="outline" size="sm" onClick={addItem} className="h-8 text-xs"><Plus className="h-3 w-3 mr-1" /> Add Item</Button></div>
              <div className="space-y-2 max-h-[200px] overflow-y-auto pr-1">{items.map((item) => <div key={item.id} className="grid grid-cols-[1fr,80px,80px,30px] gap-2 items-center"><Input placeholder="Item description" value={item.description} onChange={(event) => updateItem(item.id, "description", event.target.value)} className="text-sm" /><Input type="number" min="0" step="any" placeholder="Qty" value={item.quantity} onChange={(event) => updateItem(item.id, "quantity", event.target.value)} className="text-sm" /><Input type="number" min="0" step="any" placeholder="Price" value={item.price} onChange={(event) => updateItem(item.id, "price", event.target.value)} className="text-sm" /><Button type="button" variant="ghost" size="icon" onClick={() => removeItem(item.id)} disabled={items.length === 1} className="h-8 w-8"><Trash className="h-4 w-4" /></Button></div>)}</div>
              <div className="flex justify-end pt-2"><div className="w-[190px] space-y-1"><div className="flex justify-between text-sm"><span>Subtotal:</span><span>{totalDisplay} {token}</span></div><div className="flex justify-between font-medium"><span>Total:</span><span>{totalDisplay} {token}</span></div></div></div>
              {asset && asset.source !== "unavailable" && invoiceTotalUnits(items, asset.decimals) === null && <p className="text-right text-xs text-destructive">{t("payments.invPrecisionExceeded", { symbol: asset.symbol, decimals: asset.decimals })}</p>}
            </div>

            <div className="space-y-2"><Label htmlFor="notes">Notes (Optional)</Label><Textarea id="notes" placeholder="Add any additional notes or payment instructions" value={notes} onChange={(event) => setNotes(event.target.value)} className="resize-none h-20" /></div>
            <div className="flex items-center space-x-2"><Switch id="send-email" checked={sendEmail} onCheckedChange={setSendEmail} /><Label htmlFor="send-email" className="cursor-pointer">Open an email draft after preview</Label></div>
          </div>
        )}

        <DialogFooter>
          {!isProcessing && <>
            <Button variant="outline" onClick={() => isPreview ? setIsPreview(false) : onOpenChange(false)}>{isPreview ? "Edit Invoice" : "Cancel"}</Button>
            <Button onClick={handleSubmit} disabled={!paymentAddress || !recipient.trim() || !invoiceNumber.trim() || items.some((item) => !item.description.trim() || !item.price || invoiceItemTotal(item).units === 0n) || asset?.source === "unavailable"} className="bg-gradient-to-r from-primary to-purple-500 hover:from-primary/90 hover:to-purple-500/90">
              {isPreview
                ? sendEmail
                  ? <><Send className="h-4 w-4 mr-2" />Open Email Draft</>
                  : <><Check className="h-4 w-4 mr-2" />{t("payments.invDone")}</>
                : <><FileText className="h-4 w-4 mr-2" />Preview Invoice</>}
            </Button>
          </>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function invoiceTotalUnitsOrThrow(items: InvoiceItem[], decimals: number): bigint {
  const units = invoiceTotalUnits(items, decimals)
  if (units === null) throw new Error(ti18n("payments.errAmountExceedsDecimals", { decimals }))
  return units
}
