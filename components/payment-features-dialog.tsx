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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Calendar,
  Clock,
  Repeat,
  Send,
  Plus,
  X,
  ArrowRight,
  Receipt,
  DollarSign,
  Users,
  Wallet,
  Zap,
  Code,
} from "lucide-react"
import { motion, AnimatePresence } from "framer-motion"

interface PaymentFeaturesDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  groupId?: string
}

export function PaymentFeaturesDialog({ open, onOpenChange, groupId }: PaymentFeaturesDialogProps) {
  const [activeTab, setActiveTab] = useState("recurring")
  const [recipients, setRecipients] = useState<Array<{ id: string; address: string; amount: string }>>([
    { id: "1", address: "", amount: "" },
  ])
  const [invoiceItems, setInvoiceItems] = useState<Array<{ id: string; description: string; amount: string }>>([
    { id: "1", description: "", amount: "" },
  ])

  // Mock data for the current group
  const currentGroup = {
    id: groupId || "group-1",
    name: "Team Treasury",
    balance: 1250,
    token: "APT",
  }

  const tokens = ["APT", "USDC", "USDT"]

  const addRecipient = () => {
    setRecipients([...recipients, { id: Date.now().toString(), address: "", amount: "" }])
  }

  const removeRecipient = (id: string) => {
    if (recipients.length > 1) {
      setRecipients(recipients.filter((r) => r.id !== id))
    }
  }

  const updateRecipient = (id: string, field: string, value: string) => {
    setRecipients(recipients.map((r) => (r.id === id ? { ...r, [field]: value } : r)))
  }

  const addInvoiceItem = () => {
    setInvoiceItems([...invoiceItems, { id: Date.now().toString(), description: "", amount: "" }])
  }

  const removeInvoiceItem = (id: string) => {
    if (invoiceItems.length > 1) {
      setInvoiceItems(invoiceItems.filter((item) => item.id !== id))
    }
  }

  const updateInvoiceItem = (id: string, field: string, value: string) => {
    setInvoiceItems(invoiceItems.map((item) => (item.id === id ? { ...item, [field]: value } : item)))
  }

  const getTotalInvoiceAmount = () => {
    return invoiceItems.reduce((sum, item) => sum + (Number.parseFloat(item.amount) || 0), 0).toFixed(2)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px] p-0 gap-0 overflow-hidden">
        <DialogHeader className="p-4 pb-0">
          <DialogTitle>Payment Features</DialogTitle>
          <DialogDescription>Set up advanced payment options for your group</DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="recurring" value={activeTab} onValueChange={setActiveTab} className="w-full">
          <div className="px-4 pt-4">
            <TabsList className="grid w-full grid-cols-5 p-1 bg-muted/50 rounded-xl">
              <TabsTrigger
                value="recurring"
                className="rounded-lg text-xs data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
              >
                <Repeat className="h-3 w-3 mr-1" />
                Recurring
              </TabsTrigger>
              <TabsTrigger
                value="batch"
                className="rounded-lg text-xs data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
              >
                <Users className="h-3 w-3 mr-1" />
                Batch
              </TabsTrigger>
              <TabsTrigger
                value="stream"
                className="rounded-lg text-xs data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
              >
                <Clock className="h-3 w-3 mr-1" />
                Stream
              </TabsTrigger>
              <TabsTrigger
                value="invoice"
                className="rounded-lg text-xs data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
              >
                <Receipt className="h-3 w-3 mr-1" />
                Invoice
              </TabsTrigger>
              <TabsTrigger
                value="quick"
                className="rounded-lg text-xs data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
              >
                <Zap className="h-3 w-3 mr-1" />
                Quick
              </TabsTrigger>
            </TabsList>
          </div>

          <AnimatePresence mode="wait">
            {/* Recurring Payment Tab */}
            {activeTab === "recurring" && (
              <TabsContent value="recurring" className="mt-0">
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  transition={{ duration: 0.2 }}
                  className="p-4 space-y-4"
                >
                  <div className="p-3 rounded-lg bg-muted/50">
                    <p className="text-xs text-muted-foreground">Current Group</p>
                    <p className="font-medium">{currentGroup.name}</p>

                    <div className="flex items-center justify-between mt-2">
                      <div>
                        <p className="text-xs text-muted-foreground">Available Balance</p>
                        <p className="font-medium">
                          {currentGroup.balance} {currentGroup.token}
                        </p>
                      </div>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="payment-title">Payment Title</Label>
                    <Input id="payment-title" placeholder="Monthly Salary, Subscription, etc." />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="recipient">Recipient Address</Label>
                    <Input id="recipient" placeholder="0x..." />
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-2">
                      <Label htmlFor="amount">Amount</Label>
                      <Input id="amount" type="number" placeholder="0.00" />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="token">Token</Label>
                      <Select defaultValue="USDC">
                        <SelectTrigger id="token">
                          <SelectValue placeholder="Select" />
                        </SelectTrigger>
                        <SelectContent>
                          {tokens.map((token) => (
                            <SelectItem key={token} value={token}>
                              {token}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="interval">Payment Interval</Label>
                    <Select defaultValue="monthly">
                      <SelectTrigger id="interval">
                        <SelectValue placeholder="Select interval" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="daily">Daily</SelectItem>
                        <SelectItem value="weekly">Weekly</SelectItem>
                        <SelectItem value="biweekly">Bi-weekly</SelectItem>
                        <SelectItem value="monthly">Monthly</SelectItem>
                        <SelectItem value="quarterly">Quarterly</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-2">
                      <Label htmlFor="start-date">Start Date</Label>
                      <div className="relative">
                        <Input id="start-date" type="date" className="pl-9" />
                        <Calendar className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                      </div>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="end-date">End Date (Optional)</Label>
                      <div className="relative">
                        <Input id="end-date" type="date" className="pl-9" />
                        <Calendar className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                      </div>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="description">Description (Optional)</Label>
                    <Textarea
                      id="description"
                      placeholder="Add details about this recurring payment"
                      className="resize-none h-20"
                    />
                  </div>

                  <div className="flex items-center justify-between p-2 rounded-lg border">
                    <div className="flex items-center">
                      <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center mr-2">
                        <Wallet className="h-4 w-4 text-primary" />
                      </div>
                      <div>
                        <p className="text-sm font-medium">Save as Template</p>
                        <p className="text-xs text-muted-foreground">Save this configuration as a reusable template</p>
                      </div>
                    </div>
                    <Switch />
                  </div>
                </motion.div>
              </TabsContent>
            )}

            {/* Batch Payment Tab */}
            {activeTab === "batch" && (
              <TabsContent value="batch" className="mt-0">
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  transition={{ duration: 0.2 }}
                  className="p-4 space-y-4"
                >
                  <div className="p-3 rounded-lg bg-muted/50">
                    <p className="text-xs text-muted-foreground">Current Group</p>
                    <p className="font-medium">{currentGroup.name}</p>

                    <div className="flex items-center justify-between mt-2">
                      <div>
                        <p className="text-xs text-muted-foreground">Available Balance</p>
                        <p className="font-medium">
                          {currentGroup.balance} {currentGroup.token}
                        </p>
                      </div>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="batch-title">Batch Payment Title</Label>
                    <Input id="batch-title" placeholder="Team Payments, Vendor Payments, etc." />
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label className="text-sm font-medium">Recipients</Label>
                      <Button type="button" variant="outline" size="sm" onClick={addRecipient} className="h-7 text-xs">
                        <Plus className="h-3 w-3 mr-1" /> Add Recipient
                      </Button>
                    </div>

                    <ScrollArea className="h-[200px] pr-4">
                      <div className="space-y-2">
                        {recipients.map((recipient, index) => (
                          <div key={recipient.id} className="flex items-center gap-2">
                            <div className="relative flex-1">
                              <Input
                                placeholder="Wallet address or Email"
                                value={recipient.address}
                                onChange={(e) => updateRecipient(recipient.id, "address", e.target.value)}
                              />
                            </div>

                            <Input
                              type="number"
                              placeholder="Amount"
                              value={recipient.amount}
                              onChange={(e) => updateRecipient(recipient.id, "amount", e.target.value)}
                              className="w-24 text-xs"
                            />

                            {recipients.length > 1 && (
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                onClick={() => removeRecipient(recipient.id)}
                                className="h-7 w-7"
                              >
                                <X className="h-3 w-3" />
                              </Button>
                            )}
                          </div>
                        ))}
                      </div>
                    </ScrollArea>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="batch-token">Token</Label>
                    <Select defaultValue="USDC">
                      <SelectTrigger id="batch-token">
                        <SelectValue placeholder="Select" />
                      </SelectTrigger>
                      <SelectContent>
                        {tokens.map((token) => (
                          <SelectItem key={token} value={token}>
                            {token}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="batch-date">Execution Date</Label>
                    <div className="relative">
                      <Input id="batch-date" type="date" className="pl-9" />
                      <Calendar className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="batch-description">Description (Optional)</Label>
                    <Textarea
                      id="batch-description"
                      placeholder="Add details about this batch payment"
                      className="resize-none h-20"
                    />
                  </div>

                  <div className="flex items-center justify-between p-2 rounded-lg border">
                    <div className="flex items-center">
                      <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center mr-2">
                        <Repeat className="h-4 w-4 text-primary" />
                      </div>
                      <div>
                        <p className="text-sm font-medium">Make Recurring</p>
                        <p className="text-xs text-muted-foreground">
                          Schedule this batch payment to repeat periodically
                        </p>
                      </div>
                    </div>
                    <Switch />
                  </div>
                </motion.div>
              </TabsContent>
            )}

            {/* Stream Payment Tab */}
            {activeTab === "stream" && (
              <TabsContent value="stream" className="mt-0">
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  transition={{ duration: 0.2 }}
                  className="p-4 space-y-4"
                >
                  <div className="p-3 rounded-lg bg-muted/50">
                    <p className="text-xs text-muted-foreground">Current Group</p>
                    <p className="font-medium">{currentGroup.name}</p>

                    <div className="flex items-center justify-between mt-2">
                      <div>
                        <p className="text-xs text-muted-foreground">Available Balance</p>
                        <p className="font-medium">
                          {currentGroup.balance} {currentGroup.token}
                        </p>
                      </div>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="stream-title">Stream Payment Title</Label>
                    <Input id="stream-title" placeholder="Developer Grant, Vesting, etc." />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="stream-recipient">Recipient Address</Label>
                    <Input id="stream-recipient" placeholder="0x..." />
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-2">
                      <Label htmlFor="stream-amount">Total Amount</Label>
                      <Input id="stream-amount" type="number" placeholder="0.00" />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="stream-token">Token</Label>
                      <Select defaultValue="USDC">
                        <SelectTrigger id="stream-token">
                          <SelectValue placeholder="Select" />
                        </SelectTrigger>
                        <SelectContent>
                          {tokens.map((token) => (
                            <SelectItem key={token} value={token}>
                              {token}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="stream-duration">Stream Duration</Label>
                    <Select defaultValue="30days">
                      <SelectTrigger id="stream-duration">
                        <SelectValue placeholder="Select duration" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="7days">7 days</SelectItem>
                        <SelectItem value="14days">14 days</SelectItem>
                        <SelectItem value="30days">30 days</SelectItem>
                        <SelectItem value="60days">60 days</SelectItem>
                        <SelectItem value="90days">90 days</SelectItem>
                        <SelectItem value="180days">180 days</SelectItem>
                        <SelectItem value="365days">365 days</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-2">
                      <Label htmlFor="stream-start">Start Date</Label>
                      <div className="relative">
                        <Input id="stream-start" type="date" className="pl-9" />
                        <Calendar className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                      </div>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="stream-end">End Date</Label>
                      <div className="relative">
                        <Input id="stream-end" type="date" className="pl-9" disabled />
                        <Calendar className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                      </div>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="stream-cliff">Cliff Period (Optional)</Label>
                    <Select defaultValue="none">
                      <SelectTrigger id="stream-cliff">
                        <SelectValue placeholder="Select cliff period" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">No Cliff</SelectItem>
                        <SelectItem value="7days">7 days</SelectItem>
                        <SelectItem value="14days">14 days</SelectItem>
                        <SelectItem value="30days">30 days</SelectItem>
                        <SelectItem value="90days">90 days</SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                      A cliff period means no tokens will be released until after this period
                    </p>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="stream-description">Description (Optional)</Label>
                    <Textarea
                      id="stream-description"
                      placeholder="Add details about this stream payment"
                      className="resize-none h-20"
                    />
                  </div>

                  <div className="p-3 rounded-lg bg-accent/30">
                    <div className="flex items-center">
                      <Clock className="h-4 w-4 mr-2 text-primary" />
                      <p className="text-xs font-medium">
                        Tokens will be continuously streamed at a rate of 0.0115 USDC per second
                      </p>
                    </div>
                  </div>
                </motion.div>
              </TabsContent>
            )}

            {/* Invoice Tab */}
            {activeTab === "invoice" && (
              <TabsContent value="invoice" className="mt-0">
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  transition={{ duration: 0.2 }}
                  className="p-4 space-y-4"
                >
                  <div className="space-y-2">
                    <Label htmlFor="invoice-title">Invoice Title</Label>
                    <Input id="invoice-title" placeholder="Consulting Services, Project Work, etc." />
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-2">
                      <Label htmlFor="invoice-number">Invoice Number</Label>
                      <Input id="invoice-number" placeholder="INV-001" />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="invoice-date">Invoice Date</Label>
                      <div className="relative">
                        <Input id="invoice-date" type="date" className="pl-9" />
                        <Calendar className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                      </div>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="invoice-recipient">Bill To</Label>
                    <Input id="invoice-recipient" placeholder="Client name or address" />
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label className="text-sm font-medium">Invoice Items</Label>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={addInvoiceItem}
                        className="h-7 text-xs"
                      >
                        <Plus className="h-3 w-3 mr-1" /> Add Item
                      </Button>
                    </div>

                    <ScrollArea className="max-h-[200px] pr-4">
                      <div className="space-y-2">
                        {invoiceItems.map((item) => (
                          <div key={item.id} className="flex items-center gap-2">
                            <div className="relative flex-1">
                              <Input
                                placeholder="Item description"
                                value={item.description}
                                onChange={(e) => updateInvoiceItem(item.id, "description", e.target.value)}
                              />
                            </div>

                            <Input
                              type="number"
                              placeholder="Amount"
                              value={item.amount}
                              onChange={(e) => updateInvoiceItem(item.id, "amount", e.target.value)}
                              className="w-24 text-xs"
                            />

                            {invoiceItems.length > 1 && (
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                onClick={() => removeInvoiceItem(item.id)}
                                className="h-7 w-7"
                              >
                                <X className="h-3 w-3" />
                              </Button>
                            )}
                          </div>
                        ))}
                      </div>
                    </ScrollArea>
                  </div>

                  <div className="p-3 rounded-lg bg-muted/50">
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-medium">Total Amount</p>
                      <p className="text-sm font-bold">{getTotalInvoiceAmount()} USDC</p>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="invoice-token">Payment Token</Label>
                    <Select defaultValue="USDC">
                      <SelectTrigger id="invoice-token">
                        <SelectValue placeholder="Select" />
                      </SelectTrigger>
                      <SelectContent>
                        {tokens.map((token) => (
                          <SelectItem key={token} value={token}>
                            {token}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="invoice-due">Due Date</Label>
                    <div className="relative">
                      <Input id="invoice-due" type="date" className="pl-9" />
                      <Calendar className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="invoice-notes">Notes (Optional)</Label>
                    <Textarea
                      id="invoice-notes"
                      placeholder="Add notes or payment instructions"
                      className="resize-none h-20"
                    />
                  </div>

                  <div className="flex items-center justify-between p-2 rounded-lg border">
                    <div className="flex items-center">
                      <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center mr-2">
                        <Send className="h-4 w-4 text-primary" />
                      </div>
                      <div>
                        <p className="text-sm font-medium">Send Invoice</p>
                        <p className="text-xs text-muted-foreground">Send this invoice to the recipient via email</p>
                      </div>
                    </div>
                    <Switch />
                  </div>
                </motion.div>
              </TabsContent>
            )}

            {/* Quick Transactions Tab */}
            {activeTab === "quick" && (
              <TabsContent value="quick" className="mt-0">
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  transition={{ duration: 0.2 }}
                  className="p-4 space-y-4"
                >
                  <div className="grid grid-cols-2 gap-3">
                    <Card className="hover:bg-muted/50 transition-colors cursor-pointer">
                      <CardHeader className="p-3 pb-0">
                        <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center">
                          <Send className="h-4 w-4 text-primary" />
                        </div>
                        <CardTitle className="text-sm mt-2">Quick Transfer</CardTitle>
                        <CardDescription className="text-xs">Send tokens to a recipient</CardDescription>
                      </CardHeader>
                      <CardContent className="p-3 pt-2">
                        <p className="text-xs text-muted-foreground">
                          Simple one-time transfer with minimal configuration
                        </p>
                      </CardContent>
                      <CardFooter className="p-3 pt-0">
                        <Button variant="ghost" size="sm" className="w-full h-7 text-xs">
                          <ArrowRight className="h-3 w-3 mr-1" /> Start
                        </Button>
                      </CardFooter>
                    </Card>

                    <Card className="hover:bg-muted/50 transition-colors cursor-pointer">
                      <CardHeader className="p-3 pb-0">
                        <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center">
                          <Repeat className="h-4 w-4 text-primary" />
                        </div>
                        <CardTitle className="text-sm mt-2">Recurring Payment</CardTitle>
                        <CardDescription className="text-xs">Set up a periodic payment</CardDescription>
                      </CardHeader>
                      <CardContent className="p-3 pt-2">
                        <p className="text-xs text-muted-foreground">
                          Schedule payments to repeat at regular intervals
                        </p>
                      </CardContent>
                      <CardFooter className="p-3 pt-0">
                        <Button variant="ghost" size="sm" className="w-full h-7 text-xs">
                          <ArrowRight className="h-3 w-3 mr-1" /> Start
                        </Button>
                      </CardFooter>
                    </Card>

                    <Card className="hover:bg-muted/50 transition-colors cursor-pointer">
                      <CardHeader className="p-3 pb-0">
                        <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center">
                          <Users className="h-4 w-4 text-primary" />
                        </div>
                        <CardTitle className="text-sm mt-2">Batch Payment</CardTitle>
                        <CardDescription className="text-xs">Pay multiple recipients at once</CardDescription>
                      </CardHeader>
                      <CardContent className="p-3 pt-2">
                        <p className="text-xs text-muted-foreground">
                          Send payments to multiple addresses in one transaction
                        </p>
                      </CardContent>
                      <CardFooter className="p-3 pt-0">
                        <Button variant="ghost" size="sm" className="w-full h-7 text-xs">
                          <ArrowRight className="h-3 w-3 mr-1" /> Start
                        </Button>
                      </CardFooter>
                    </Card>

                    <Card className="hover:bg-muted/50 transition-colors cursor-pointer">
                      <CardHeader className="p-3 pb-0">
                        <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center">
                          <Clock className="h-4 w-4 text-primary" />
                        </div>
                        <CardTitle className="text-sm mt-2">Stream Payment</CardTitle>
                        <CardDescription className="text-xs">Continuous token streaming</CardDescription>
                      </CardHeader>
                      <CardContent className="p-3 pt-2">
                        <p className="text-xs text-muted-foreground">
                          Stream tokens continuously over a period of time
                        </p>
                      </CardContent>
                      <CardFooter className="p-3 pt-0">
                        <Button variant="ghost" size="sm" className="w-full h-7 text-xs">
                          <ArrowRight className="h-3 w-3 mr-1" /> Start
                        </Button>
                      </CardFooter>
                    </Card>

                    <Card className="hover:bg-muted/50 transition-colors cursor-pointer">
                      <CardHeader className="p-3 pb-0">
                        <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center">
                          <Receipt className="h-4 w-4 text-primary" />
                        </div>
                        <CardTitle className="text-sm mt-2">Create Invoice</CardTitle>
                        <CardDescription className="text-xs">Generate payment request</CardDescription>
                      </CardHeader>
                      <CardContent className="p-3 pt-2">
                        <p className="text-xs text-muted-foreground">Create and send professional invoices</p>
                      </CardContent>
                      <CardFooter className="p-3 pt-0">
                        <Button variant="ghost" size="sm" className="w-full h-7 text-xs">
                          <ArrowRight className="h-3 w-3 mr-1" /> Start
                        </Button>
                      </CardFooter>
                    </Card>

                    <Card className="hover:bg-muted/50 transition-colors cursor-pointer">
                      <CardHeader className="p-3 pb-0">
                        <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center">
                          <DollarSign className="h-4 w-4 text-primary" />
                        </div>
                        <CardTitle className="text-sm mt-2">Request Payment</CardTitle>
                        <CardDescription className="text-xs">Request funds from group</CardDescription>
                      </CardHeader>
                      <CardContent className="p-3 pt-2">
                        <p className="text-xs text-muted-foreground">Request funds from your multi-sig group</p>
                      </CardContent>
                      <CardFooter className="p-3 pt-0">
                        <Button variant="ghost" size="sm" className="w-full h-7 text-xs">
                          <ArrowRight className="h-3 w-3 mr-1" /> Start
                        </Button>
                      </CardFooter>
                    </Card>
                  </div>

                  <div className="space-y-2">
                    <Label className="text-sm font-medium">Saved Templates</Label>
                    <ScrollArea className="h-[200px]">
                      <div className="space-y-2">
                        <Card className="p-2 hover:bg-muted/50 transition-colors cursor-pointer">
                          <div className="flex items-center justify-between">
                            <div className="flex items-center">
                              <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center mr-2">
                                <Send className="h-4 w-4 text-primary" />
                              </div>
                              <div>
                                <p className="text-sm font-medium">Monthly Salary Payment</p>
                                <p className="text-xs text-muted-foreground">500 USDC • Recurring</p>
                              </div>
                            </div>
                            <Button variant="ghost" size="sm" className="h-7">
                              Use
                            </Button>
                          </div>
                        </Card>

                        <Card className="p-2 hover:bg-muted/50 transition-colors cursor-pointer">
                          <div className="flex items-center justify-between">
                            <div className="flex items-center">
                              <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center mr-2">
                                <Code className="h-4 w-4 text-primary" />
                              </div>
                              <div>
                                <p className="text-sm font-medium">Staking Rewards</p>
                                <p className="text-xs text-muted-foreground">Contract Call • claimRewards</p>
                              </div>
                            </div>
                            <Button variant="ghost" size="sm" className="h-7">
                              Use
                            </Button>
                          </div>
                        </Card>

                        <Card className="p-2 hover:bg-muted/50 transition-colors cursor-pointer">
                          <div className="flex items-center justify-between">
                            <div className="flex items-center">
                              <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center mr-2">
                                <Clock className="h-4 w-4 text-primary" />
                              </div>
                              <div>
                                <p className="text-sm font-medium">Developer Grant</p>
                                <p className="text-xs text-muted-foreground">5000 USDT • Stream Payment</p>
                              </div>
                            </div>
                            <Button variant="ghost" size="sm" className="h-7">
                              Use
                            </Button>
                          </div>
                        </Card>
                      </div>
                    </ScrollArea>
                  </div>
                </motion.div>
              </TabsContent>
            )}
          </AnimatePresence>
        </Tabs>

        <DialogFooter className="p-4">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button className="bg-gradient-to-r from-primary to-purple-500 hover:from-primary/90 hover:to-purple-500/90">
            Create Payment
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
