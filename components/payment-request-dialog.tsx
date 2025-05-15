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
import { CalendarIcon, Copy, QrCode, Send, Share2, CreditCard } from "lucide-react"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"

interface PaymentRequestDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  groupId?: string
}

export function PaymentRequestDialog({ open, onOpenChange, groupId }: PaymentRequestDialogProps) {
  const [requestType, setRequestType] = useState("single")
  const [recipient, setRecipient] = useState("")
  const [amount, setAmount] = useState("")
  const [token, setToken] = useState("USDC")
  const [dueDate, setDueDate] = useState<Date | undefined>(addDays(new Date(), 7))
  const [description, setDescription] = useState("")
  const [sendNotification, setSendNotification] = useState(true)
  const [isProcessing, setIsProcessing] = useState(false)
  const [isGenerated, setIsGenerated] = useState(false)
  const [requestLink, setRequestLink] = useState("https://pay.example.com/request/abc123")
  const [paymentMethod, setPaymentMethod] = useState("wallet")

  const tokens = ["APT", "USDC", "USDT"]

  const handleSubmit = () => {
    setIsProcessing(true)

    // Simulate API call
    setTimeout(() => {
      setIsProcessing(false)
      setIsGenerated(true)
      setRequestLink(`https://pay.example.com/request/${Math.random().toString(36).substring(2, 10)}`)
      // In a real app, you would create the payment request here
    }, 1500)
  }

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text)
    // Show toast notification
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!isProcessing) {
          onOpenChange(value)
          if (!value) {
            setIsGenerated(false)
          }
        }
      }}
    >
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>{isGenerated ? "Payment Request Created" : "Request Payment"}</DialogTitle>
          <DialogDescription>
            {isGenerated
              ? "Share this payment request with the recipient"
              : "Create a payment request that can be shared with others"}
          </DialogDescription>
        </DialogHeader>

        {isProcessing ? (
          <div className="py-8 flex flex-col items-center justify-center">
            <div className="h-12 w-12 rounded-full border-4 border-primary border-t-transparent animate-spin mb-4"></div>
            <p className="font-medium">Creating payment request...</p>
          </div>
        ) : isGenerated ? (
          <div className="space-y-4 py-4">
            <div className="p-4 border rounded-lg bg-muted/30 flex flex-col items-center">
              <div className="w-48 h-48 bg-white p-2 rounded-lg mb-4">
                <div className="w-full h-full bg-muted flex items-center justify-center">
                  <QrCode className="h-24 w-24 text-primary" />
                </div>
              </div>

              <div className="text-center">
                <p className="font-medium">
                  Request for {amount} {token}
                </p>
                <p className="text-sm text-muted-foreground">
                  Due by {dueDate ? format(dueDate, "PPP") : "Not specified"}
                </p>
              </div>
            </div>

            <div className="space-y-2">
              <Label>Payment Link</Label>
              <div className="flex">
                <Input value={requestLink} readOnly className="rounded-r-none" />
                <Button variant="secondary" className="rounded-l-none" onClick={() => copyToClipboard(requestLink)}>
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">Share this link with the recipient to request payment</p>
            </div>

            <div className="flex justify-center space-x-2 pt-2">
              <Button variant="outline" className="flex items-center">
                <Send className="h-4 w-4 mr-2" />
                Email
              </Button>
              <Button variant="outline" className="flex items-center">
                <Share2 className="h-4 w-4 mr-2" />
                Share
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4 py-4">
            <Tabs defaultValue="single" onValueChange={setRequestType}>
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="single">Single Request</TabsTrigger>
                <TabsTrigger value="multiple">Multiple Recipients</TabsTrigger>
              </TabsList>

              <TabsContent value="single" className="space-y-4 pt-4">
                <div className="space-y-2">
                  <Label htmlFor="recipient">Recipient Address or Email</Label>
                  <Input
                    id="recipient"
                    placeholder="0x... or email@example.com"
                    value={recipient}
                    onChange={(e) => setRecipient(e.target.value)}
                  />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="amount">Amount</Label>
                    <Input
                      id="amount"
                      type="number"
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
                        {tokens.map((t) => (
                          <SelectItem key={t} value={t}>
                            {t}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </TabsContent>

              <TabsContent value="multiple" className="pt-4">
                <div className="p-4 border rounded-lg bg-muted/30 flex flex-col items-center">
                  <p className="text-sm text-muted-foreground">
                    Multiple recipient functionality will be available soon
                  </p>
                </div>
              </TabsContent>
            </Tabs>

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
                    disabled={(date) => date < new Date()}
                  />
                </PopoverContent>
              </Popover>
            </div>

            <div className="space-y-2">
              <Label htmlFor="description">Description (Optional)</Label>
              <Textarea
                id="description"
                placeholder="What is this payment for?"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="resize-none h-20"
              />
            </div>

            <div className="space-y-2">
              <Label>Payment Method</Label>
              <RadioGroup value={paymentMethod} onValueChange={setPaymentMethod} className="flex space-x-4">
                <div className="flex items-center space-x-2">
                  <RadioGroupItem value="wallet" id="payment-wallet" />
                  <Label htmlFor="payment-wallet" className="cursor-pointer flex items-center">
                    <CreditCard className="h-4 w-4 mr-2" />
                    Crypto Wallet
                  </Label>
                </div>
                <div className="flex items-center space-x-2">
                  <RadioGroupItem value="card" id="payment-card" disabled />
                  <Label htmlFor="payment-card" className="cursor-pointer flex items-center text-muted-foreground">
                    <CreditCard className="h-4 w-4 mr-2" />
                    Credit Card (Coming Soon)
                  </Label>
                </div>
              </RadioGroup>
            </div>

            <div className="flex items-center space-x-2">
              <Switch id="send-notification" checked={sendNotification} onCheckedChange={setSendNotification} />
              <Label htmlFor="send-notification" className="cursor-pointer">
                Send notification to recipient
              </Label>
            </div>
          </div>
        )}

        <DialogFooter>
          {!isProcessing && (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {isGenerated ? "Close" : "Cancel"}
              </Button>
              {!isGenerated && (
                <Button
                  onClick={handleSubmit}
                  disabled={!amount || (requestType === "single" && !recipient)}
                  className="bg-gradient-to-r from-primary to-purple-500 hover:from-primary/90 hover:to-purple-500/90"
                >
                  Create Request
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
