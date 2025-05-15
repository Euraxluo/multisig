"use client"

import { useState } from "react"
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
import { CalendarIcon, FileText, Plus, Trash, Download, Share2, Copy } from "lucide-react"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"

interface InvoiceGeneratorDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  groupId?: string
}

interface InvoiceItem {
  id: string
  description: string
  quantity: string
  price: string
}

export function InvoiceGeneratorDialog({ open, onOpenChange, groupId }: InvoiceGeneratorDialogProps) {
  const [recipient, setRecipient] = useState("")
  const [recipientEmail, setRecipientEmail] = useState("")
  const [invoiceNumber, setInvoiceNumber] = useState(`INV-${Date.now().toString().slice(-6)}`)
  const [issueDate, setIssueDate] = useState<Date | undefined>(new Date())
  const [dueDate, setDueDate] = useState<Date | undefined>(addDays(new Date(), 30))
  const [token, setToken] = useState("USDC")
  const [items, setItems] = useState<InvoiceItem[]>([{ id: "1", description: "", quantity: "1", price: "" }])
  const [notes, setNotes] = useState("")
  const [sendEmail, setSendEmail] = useState(false)
  const [isProcessing, setIsProcessing] = useState(false)
  const [isPreview, setIsPreview] = useState(false)

  const tokens = ["APT", "USDC", "USDT"]

  const handleSubmit = () => {
    if (isPreview) {
      setIsPreview(false)
      return
    }

    setIsProcessing(true)

    // Simulate API call
    setTimeout(() => {
      setIsProcessing(false)
      setIsPreview(true)
      // In a real app, you would save the invoice here
    }, 1500)
  }

  const addItem = () => {
    setItems([
      ...items,
      {
        id: Date.now().toString(),
        description: "",
        quantity: "1",
        price: "",
      },
    ])
  }

  const updateItem = (id: string, field: keyof InvoiceItem, value: string) => {
    setItems(items.map((item) => (item.id === id ? { ...item, [field]: value } : item)))
  }

  const removeItem = (id: string) => {
    if (items.length > 1) {
      setItems(items.filter((item) => item.id !== id))
    }
  }

  const calculateSubtotal = () => {
    return items
      .reduce((sum, item) => {
        const quantity = Number.parseFloat(item.quantity) || 0
        const price = Number.parseFloat(item.price) || 0
        return sum + quantity * price
      }, 0)
      .toFixed(2)
  }

  const calculateTotal = () => {
    return calculateSubtotal()
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!isProcessing) {
          onOpenChange(value)
          if (!value) {
            setIsPreview(false)
          }
        }
      }}
    >
      <DialogContent className={cn("sm:max-w-[600px]", isPreview && "sm:max-w-[700px]")}>
        <DialogHeader>
          <DialogTitle>{isPreview ? "Invoice Preview" : "Generate Invoice"}</DialogTitle>
          <DialogDescription>
            {isPreview ? "Review your invoice before sending" : "Create a professional invoice for payment"}
          </DialogDescription>
        </DialogHeader>

        {isProcessing ? (
          <div className="py-8 flex flex-col items-center justify-center">
            <div className="h-12 w-12 rounded-full border-4 border-primary border-t-transparent animate-spin mb-4"></div>
            <p className="font-medium">Generating invoice...</p>
          </div>
        ) : isPreview ? (
          <div className="space-y-4 py-4">
            <div className="border rounded-lg p-6 bg-white">
              <div className="flex justify-between items-start">
                <div>
                  <h2 className="text-2xl font-bold text-primary">INVOICE</h2>
                  <p className="text-sm text-muted-foreground mt-1">#{invoiceNumber}</p>
                </div>
                <div className="text-right">
                  <p className="font-medium">Your Company Name</p>
                  <p className="text-sm text-muted-foreground">your.email@example.com</p>
                  <p className="text-sm text-muted-foreground">0x1234...5678</p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-8 mt-8">
                <div>
                  <p className="text-sm text-muted-foreground">Bill To:</p>
                  <p className="font-medium">{recipient || "Client Name"}</p>
                  <p className="text-sm">{recipientEmail || "client@example.com"}</p>
                  <p className="text-sm">{recipient || "0xabcd...efgh"}</p>
                </div>
                <div className="text-right">
                  <div className="flex justify-end items-center gap-4">
                    <div>
                      <p className="text-sm text-muted-foreground">Issue Date:</p>
                      <p className="text-sm">{issueDate ? format(issueDate, "PPP") : "Not specified"}</p>
                    </div>
                    <div>
                      <p className="text-sm text-muted-foreground">Due Date:</p>
                      <p className="text-sm">{dueDate ? format(dueDate, "PPP") : "Not specified"}</p>
                    </div>
                  </div>
                </div>
              </div>

              <div className="mt-8">
                <table className="w-full">
                  <thead>
                    <tr className="border-b">
                      <th className="text-left py-2">Description</th>
                      <th className="text-right py-2">Quantity</th>
                      <th className="text-right py-2">Price</th>
                      <th className="text-right py-2">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item) => (
                      <tr key={item.id} className="border-b">
                        <td className="py-2">{item.description || "Item description"}</td>
                        <td className="text-right py-2">{item.quantity}</td>
                        <td className="text-right py-2">
                          {item.price} {token}
                        </td>
                        <td className="text-right py-2">
                          {((Number.parseFloat(item.quantity) || 0) * (Number.parseFloat(item.price) || 0)).toFixed(2)}{" "}
                          {token}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="mt-4 flex justify-end">
                <div className="w-1/3">
                  <div className="flex justify-between py-1">
                    <span className="font-medium">Total:</span>
                    <span className="font-bold">
                      {calculateTotal()} {token}
                    </span>
                  </div>
                </div>
              </div>

              {notes && (
                <div className="mt-8 border-t pt-4">
                  <p className="text-sm font-medium">Notes:</p>
                  <p className="text-sm text-muted-foreground">{notes}</p>
                </div>
              )}

              <div className="mt-8 border-t pt-4 text-center">
                <p className="text-sm text-muted-foreground">Payment can be made to wallet address: 0x1234...5678</p>
              </div>
            </div>

            <div className="flex justify-center space-x-2">
              <Button variant="outline" className="flex items-center">
                <Download className="h-4 w-4 mr-2" />
                Download PDF
              </Button>
              <Button variant="outline" className="flex items-center">
                <Copy className="h-4 w-4 mr-2" />
                Copy Link
              </Button>
              <Button variant="outline" className="flex items-center">
                <Share2 className="h-4 w-4 mr-2" />
                Share
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4 py-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="invoice-number">Invoice Number</Label>
                <Input id="invoice-number" value={invoiceNumber} onChange={(e) => setInvoiceNumber(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="token">Currency</Label>
                <Select value={token} onValueChange={setToken}>
                  <SelectTrigger id="token">
                    <SelectValue placeholder="Select currency" />
                  </SelectTrigger>
                  <SelectContent>
                    {tokens.map((t) => (
                      <SelectItem key={t} value={t}>
                        {t}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Issue Date</Label>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      variant={"outline"}
                      className={cn(
                        "w-full justify-start text-left font-normal",
                        !issueDate && "text-muted-foreground",
                      )}
                    >
                      <CalendarIcon className="mr-2 h-4 w-4" />
                      {issueDate ? format(issueDate, "PPP") : "Select date"}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0">
                    <Calendar mode="single" selected={issueDate} onSelect={setIssueDate} initialFocus />
                  </PopoverContent>
                </Popover>
              </div>

              <div className="space-y-2">
                <Label>Due Date</Label>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      variant={"outline"}
                      className={cn("w-full justify-start text-left font-normal", !dueDate && "text-muted-foreground")}
                    >
                      <CalendarIcon className="mr-2 h-4 w-4" />
                      {dueDate ? format(dueDate, "PPP") : "Select date"}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0">
                    <Calendar
                      mode="single"
                      selected={dueDate}
                      onSelect={setDueDate}
                      initialFocus
                      disabled={(date) => {
                        if (!issueDate) return false
                        return date < issueDate
                      }}
                    />
                  </PopoverContent>
                </Popover>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="recipient">Bill To (Address)</Label>
              <Input
                id="recipient"
                placeholder="0x... or Client Name"
                value={recipient}
                onChange={(e) => setRecipient(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="recipient-email">Client Email (Optional)</Label>
              <Input
                id="recipient-email"
                type="email"
                placeholder="client@example.com"
                value={recipientEmail}
                onChange={(e) => setRecipientEmail(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Invoice Items</Label>
                <Button type="button" variant="outline" size="sm" onClick={addItem} className="h-8 text-xs">
                  <Plus className="h-3 w-3 mr-1" /> Add Item
                </Button>
              </div>

              <div className="space-y-2 max-h-[200px] overflow-y-auto pr-1">
                {items.map((item, index) => (
                  <div key={item.id} className="grid grid-cols-[1fr,80px,80px,30px] gap-2 items-center">
                    <Input
                      placeholder="Item description"
                      value={item.description}
                      onChange={(e) => updateItem(item.id, "description", e.target.value)}
                      className="text-sm"
                    />
                    <Input
                      type="number"
                      placeholder="Qty"
                      value={item.quantity}
                      onChange={(e) => updateItem(item.id, "quantity", e.target.value)}
                      className="text-sm"
                    />
                    <Input
                      type="number"
                      placeholder="Price"
                      value={item.price}
                      onChange={(e) => updateItem(item.id, "price", e.target.value)}
                      className="text-sm"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => removeItem(item.id)}
                      disabled={items.length === 1}
                      className="h-8 w-8"
                    >
                      <Trash className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>

              <div className="flex justify-end pt-2">
                <div className="w-[190px] space-y-1">
                  <div className="flex justify-between text-sm">
                    <span>Subtotal:</span>
                    <span>
                      {calculateSubtotal()} {token}
                    </span>
                  </div>
                  <div className="flex justify-between font-medium">
                    <span>Total:</span>
                    <span>
                      {calculateTotal()} {token}
                    </span>
                  </div>
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="notes">Notes (Optional)</Label>
              <Textarea
                id="notes"
                placeholder="Add any additional notes or payment instructions"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                className="resize-none h-20"
              />
            </div>

            <div className="flex items-center space-x-2">
              <Switch id="send-email" checked={sendEmail} onCheckedChange={setSendEmail} />
              <Label htmlFor="send-email" className="cursor-pointer">
                Send invoice to client via email
              </Label>
            </div>
          </div>
        )}

        <DialogFooter>
          {!isProcessing && (
            <>
              <Button
                variant="outline"
                onClick={() => {
                  if (isPreview) {
                    setIsPreview(false)
                  } else {
                    onOpenChange(false)
                  }
                }}
              >
                {isPreview ? "Edit Invoice" : "Cancel"}
              </Button>
              <Button
                onClick={handleSubmit}
                disabled={!recipient || items.some((item) => !item.description || !item.price)}
                className="bg-gradient-to-r from-primary to-purple-500 hover:from-primary/90 hover:to-purple-500/90"
              >
                <FileText className="h-4 w-4 mr-2" />
                {isPreview ? "Send Invoice" : "Preview Invoice"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
