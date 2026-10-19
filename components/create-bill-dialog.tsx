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
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { X, Plus, Calendar, DollarSign, Users, Search, QrCode, Check, AtSign, Wallet, History } from "lucide-react"
import { motion, AnimatePresence } from "framer-motion"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

import { getCachedDevAccounts } from "@/lib/dev-keystore"
import { getActiveAccount } from "@/lib/onchain-store"

interface CreateBillDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

const defaultContacts = [
  { id: "1", name: "Agent-Alice (理事长)", address: "0xaf0806fadf61ceeb76c21b40af4393e244a5d8ca91ba208d4f58537421eff2e4", type: "wallet" as const },
  { id: "2", name: "Agent-Bob (审计员)", address: "0x83fb785f1da119aea4e0faa19d1466b33899e14ea730af6425ec7d5557cb5a36", type: "wallet" as const },
  { id: "3", name: "Agent-Carol (执行官)", address: "0x5e6f8a9b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f", type: "wallet" as const },
  { id: "4", name: "Sui Community Pool", address: "0x0000000000000000000000000000000000000000000000000000000000000002", type: "wallet" as const },
]

const frequentGroups = [
  { id: "g1", name: "Core Contributors", members: ["1", "2"] },
  { id: "g2", name: "MultiSig Threshold Signers", members: ["1", "2", "3"] },
]

interface Payee {
  id: string
  name?: string
  address: string
  amount: string
  type?: "wallet" | "email"
}

export function CreateBillDialog({ open, onOpenChange }: CreateBillDialogProps) {
  const [payees, setPayees] = useState<Payee[]>([{ id: "1", address: "", amount: "" }])
  const [splitType, setSplitType] = useState("equal")
  const [step, setStep] = useState(1)
  const [currentInput, setCurrentInput] = useState("")
  const [showQrScanner, setShowQrScanner] = useState(false)
  const [searchTerm, setSearchTerm] = useState("")
  const [recentContacts, setRecentContacts] = useState(defaultContacts)

  useEffect(() => {
    const devAccs = getCachedDevAccounts()
    if (devAccs.length > 0) {
      setRecentContacts(
        devAccs.map((a, i) => ({
          id: String(i + 1),
          name: a.name,
          address: a.address,
          type: "wallet" as const,
        }))
      )
    }
  }, [open])

  const [title, setTitle] = useState("团队协作餐叙 AA")
  const [description, setDescription] = useState("测试网团队例会分账")
  const [totalAmount, setTotalAmount] = useState("10")
  const [selectedToken, setSelectedToken] = useState("SUI")

  const tokens = ["SUI", "USDC", "USDT"]

  const handleFinalSubmit = () => {
    try {
      const stored = JSON.parse(localStorage.getItem("sui_bills") || "[]")
      const parsedAmt = parseFloat(totalAmount) || 10
      const activePayees = payees.filter((p) => p.address)
      const myAddress = getActiveAccount()?.address || "0xaf0806fadf61ceeb76c21b40af4393e244a5d8ca91ba208d4f58537421eff2e4"
      const newBill = {
        id: `bill_${Date.now()}`,
        title: title || "团队账单分摊",
        description: description || "账单结算",
        amount: parsedAmt,
        token: selectedToken,
        participants: activePayees.length > 0 ? activePayees.length : 2,
        paid: 0,
        deadline: new Date(Date.now() + 86400000 * 7).toISOString().slice(0, 10),
        progress: 0,
        status: "pending",
        color: "from-blue-500 to-cyan-400",
        payees: activePayees.map((p) => ({
          ...p,
          amount: splitType === "equal" ? (parsedAmt / Math.max(1, activePayees.length)).toFixed(2) : p.amount,
          paid: false,
        })),
        creator: myAddress,
      }
      localStorage.setItem("sui_bills", JSON.stringify([newBill, ...stored]))
      window.dispatchEvent(new CustomEvent("sui-bills-updated", { detail: newBill }))
    } catch {}
    onOpenChange(false)
  }

  // Reset state when dialog opens/closes
  useEffect(() => {
    if (!open) {
      setTimeout(() => {
        setPayees([{ id: "1", address: "", amount: "" }])
        setSplitType("equal")
        setStep(1)
        setCurrentInput("")
        setShowQrScanner(false)
      }, 300)
    }
  }, [open])

  const addPayee = () => {
    setPayees([...payees, { id: Date.now().toString(), address: "", amount: "" }])
  }

  const removePayee = (id: string) => {
    if (payees.length > 1) {
      setPayees(payees.filter((p) => p.id !== id))
    }
  }

  const updatePayee = (id: string, updates: Partial<Payee>) => {
    setPayees(payees.map((p) => (p.id === id ? { ...p, ...updates } : p)))
  }

  const addContact = (contact: (typeof recentContacts)[0]) => {
    setPayees((currentPayees) => {
      // Find an empty payee slot or add a new one
      const emptyPayee = currentPayees.find((p) => !p.address)

      if (emptyPayee) {
        return currentPayees.map((p) =>
          p.id === emptyPayee.id
            ? {
                ...p,
                address: contact.address,
                name: contact.name,
                type: contact.type,
              }
            : p,
        )
      } else {
        return [
          ...currentPayees,
          {
            id: Date.now().toString(),
            address: contact.address,
            amount: "",
            name: contact.name,
            type: contact.type,
          },
        ]
      }
    })
  }

  const addGroup = (groupId: string) => {
    const group = frequentGroups.find((g) => g.id === groupId)
    if (!group) return

    // Get contacts from the group
    const groupContacts = group.members
      .map((memberId) => recentContacts.find((c) => c.id === memberId))
      .filter(Boolean) as typeof recentContacts

    // Add all contacts from the group
    const newPayees = [...payees]

    // Remove empty payees
    const filteredPayees = newPayees.filter((p) => p.address)

    // Add group members
    const updatedPayees = [
      ...filteredPayees,
      ...groupContacts.map((contact) => ({
        id: `gp_${Date.now()}_${contact.id}`,
        address: contact.address,
        amount: "",
        name: contact.name,
        type: contact.type as "wallet" | "email",
      })),
    ]

    setPayees(updatedPayees)
  }

  const handleQrScan = (result: string) => {
    // 真实的 Sui 扫码结果或有效测试网地址
    const validAddress = result?.startsWith("0x") ? result : "0xaf0806fadf61ceeb76c21b40af4393e244a5d8ca91ba208d4f58537421eff2e4"

    // Find an empty payee slot or add a new one
    const emptyPayee = payees.find((p) => !p.address)

    if (emptyPayee) {
      updatePayee(emptyPayee.id, { address: validAddress, type: "wallet" })
    } else {
      setPayees([
        ...payees,
        {
          id: Date.now().toString(),
          address: validAddress,
          amount: "",
          type: "wallet" as const,
        },
      ])
    }

    setShowQrScanner(false)
  }

  const getInputType = (value: string) => {
    if (!value) return null
    if (value.includes("@")) return "email"
    if (value.startsWith("0x")) return "wallet"
    return "unknown"
  }

  const nextStep = () => {
    setStep(step + 1)
  }

  const prevStep = () => {
    setStep(step - 1)
  }

  // Filter contacts based on search term
  const filteredContacts = searchTerm
    ? recentContacts.filter(
        (contact) =>
          contact.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
          contact.address.toLowerCase().includes(searchTerm.toLowerCase()),
      )
    : recentContacts

  const filteredHistorical = searchTerm
    ? historicalParticipants.filter(
        (contact) =>
          contact.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
          contact.address.toLowerCase().includes(searchTerm.toLowerCase()),
      )
    : historicalParticipants

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[425px] p-0 gap-0 overflow-hidden">
        <DialogHeader className="p-4 pb-0">
          <DialogTitle>Create Bill Request</DialogTitle>
          <DialogDescription>Create a new bill request to split expenses with others.</DialogDescription>
        </DialogHeader>

        <div className="relative overflow-hidden">
          <div className="flex justify-between px-4 pt-4">
            {[1, 2, 3].map((i) => (
              <div key={i} className="flex flex-col items-center" onClick={() => i < step && setStep(i)}>
                <div
                  className={`h-8 w-8 rounded-full flex items-center justify-center text-sm ${
                    i < step
                      ? "bg-primary text-primary-foreground"
                      : i === step
                        ? "bg-primary/20 text-primary border-2 border-primary"
                        : "bg-muted text-muted-foreground"
                  }`}
                >
                  {i}
                </div>
                <div className="text-xs mt-1 text-muted-foreground">
                  {i === 1 ? "Details" : i === 2 ? "Participants" : "Review"}
                </div>
              </div>
            ))}
            <div className="absolute top-[28px] left-[68px] w-[120px] h-[2px] bg-muted">
              <div className={`h-full bg-primary transition-all ${step > 1 ? "w-full" : "w-0"}`}></div>
            </div>
            <div className="absolute top-[28px] right-[68px] w-[120px] h-[2px] bg-muted">
              <div className={`h-full bg-primary transition-all ${step > 2 ? "w-full" : "w-0"}`}></div>
            </div>
          </div>

          <AnimatePresence mode="wait">
            {step === 1 && (
              <motion.div
                key="step1"
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 20 }}
                transition={{ duration: 0.3 }}
                className="px-4 py-4"
              >
                <div className="space-y-3">
                  <div className="space-y-1">
                    <Label htmlFor="title" className="text-xs font-medium">
                      Bill Title
                    </Label>
                    <div className="relative">
                      <Input
                        id="title"
                        value={title}
                        onChange={(e) => setTitle(e.target.value)}
                        placeholder="Dinner, Trip, etc."
                        className="pl-9"
                      />
                      <DollarSign className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                    </div>
                  </div>

                  <div className="space-y-1">
                    <Label htmlFor="description" className="text-xs font-medium">
                      Description (Optional)
                    </Label>
                    <Textarea
                      id="description"
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      placeholder="Add details about this bill"
                      className="resize-none h-20"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <Label htmlFor="total" className="text-xs font-medium">
                        Total Amount
                      </Label>
                      <Input
                        id="total"
                        type="number"
                        value={totalAmount}
                        onChange={(e) => setTotalAmount(e.target.value)}
                        placeholder="0.00"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="token" className="text-xs font-medium">
                        Token
                      </Label>
                      <Select value={selectedToken} onValueChange={setSelectedToken}>
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

                  <div className="space-y-1">
                    <Label className="text-xs font-medium">Accepted Tokens</Label>
                    <div className="flex flex-wrap gap-2 mt-1">
                      {tokens.map((token) => (
                        <div key={token} className="flex items-center">
                          <input
                            type="checkbox"
                            id={`token-${token}`}
                            className="mr-1.5"
                            defaultChecked={token === "USDC"}
                          />
                          <Label htmlFor={`token-${token}`} className="text-xs">
                            {token}
                          </Label>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="space-y-1">
                    <Label htmlFor="deadline" className="text-xs font-medium">
                      Deadline
                    </Label>
                    <div className="relative">
                      <Input id="deadline" type="date" className="pl-9" />
                      <Calendar className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                    </div>
                  </div>
                </div>
              </motion.div>
            )}

            {step === 2 && (
              <motion.div
                key="step2"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                transition={{ duration: 0.3 }}
                className="px-4 py-4"
              >
                <div className="space-y-3">
                  <div className="space-y-1">
                    <Label className="text-xs font-medium">Split Type</Label>
                    <Tabs value={splitType} onValueChange={setSplitType} className="w-full">
                      <TabsList className="grid w-full grid-cols-2 p-1 bg-muted/50 rounded-xl h-9">
                        <TabsTrigger
                          value="equal"
                          className="rounded-lg text-xs data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
                        >
                          Equal Split
                        </TabsTrigger>
                        <TabsTrigger
                          value="custom"
                          className="rounded-lg text-xs data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
                        >
                          Custom Split
                        </TabsTrigger>
                      </TabsList>
                    </Tabs>
                  </div>

                  <div className="space-y-1">
                    <div className="flex items-center justify-between">
                      <Label className="text-xs font-medium flex items-center">
                        <Users className="h-4 w-4 mr-1.5" />
                        Participants
                      </Label>
                      <div className="flex space-x-1">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="h-7 text-xs"
                              title="Search Contacts"
                            >
                              <Search className="h-3 w-3" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent className="w-64 p-1">
                            <DropdownMenuLabel className="text-xs px-2 py-1.5 font-medium text-muted-foreground">
                              Recent Contacts
                            </DropdownMenuLabel>
                            <DropdownMenuSeparator className="my-1" />
                            <div className="max-h-[200px] overflow-y-auto">
                              <DropdownMenuGroup>
                                {filteredContacts.map((contact) => (
                                  <DropdownMenuItem
                                    key={contact.id}
                                    onSelect={() => addContact(contact)}
                                    className="flex items-center gap-2 px-2 py-1 text-xs cursor-pointer hover:bg-accent"
                                  >
                                    <Avatar className="h-5 w-5">
                                      <AvatarFallback
                                        className={`text-[10px] ${
                                          contact.type === "email"
                                            ? "bg-blue-100 text-blue-600"
                                            : "bg-purple-100 text-purple-600"
                                        }`}
                                      >
                                        {contact.type === "email" ? "@" : "Ξ"}
                                      </AvatarFallback>
                                    </Avatar>
                                    <div className="flex flex-col gap-0.5">
                                      <span className="font-medium">{contact.name}</span>
                                      <span className="text-[10px] text-muted-foreground truncate max-w-[160px]">
                                        {contact.address}
                                      </span>
                                    </div>
                                  </DropdownMenuItem>
                                ))}
                              </DropdownMenuGroup>

                              {filteredHistorical.length > 0 && (
                                <>
                                  <DropdownMenuSeparator className="my-1" />
                                  <DropdownMenuLabel className="text-xs px-2 py-1.5 font-medium text-muted-foreground">
                                    From Previous Transactions
                                  </DropdownMenuLabel>
                                  <DropdownMenuGroup>
                                    {filteredHistorical.map((contact) => (
                                      <DropdownMenuItem
                                        key={contact.id}
                                        onSelect={() => addContact(contact)}
                                        className="flex items-center gap-2 px-2 py-1 text-xs cursor-pointer hover:bg-accent"
                                      >
                                        <Avatar className="h-5 w-5">
                                          <AvatarFallback
                                            className={`text-[10px] ${
                                              contact.type === "email"
                                                ? "bg-blue-100 text-blue-600"
                                                : "bg-purple-100 text-purple-600"
                                            }`}
                                          >
                                            {contact.type === "email" ? "@" : "Ξ"}
                                          </AvatarFallback>
                                        </Avatar>
                                        <div className="flex flex-col gap-0.5">
                                          <span className="font-medium">{contact.name}</span>
                                          <span className="text-[10px] text-muted-foreground truncate max-w-[160px]">
                                            {contact.address}
                                          </span>
                                        </div>
                                      </DropdownMenuItem>
                                    ))}
                                  </DropdownMenuGroup>
                                </>
                              )}
                            </div>
                          </DropdownMenuContent>
                        </DropdownMenu>

                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => setShowQrScanner(true)}
                          className="h-7 text-xs"
                          title="Scan QR Code"
                        >
                          <QrCode className="h-3 w-3" />
                        </Button>

                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={addPayee}
                          className="h-7 text-xs"
                          title="Add Manually"
                        >
                          <Plus className="h-3 w-3" />
                        </Button>
                      </div>
                    </div>

                    {/* QR Scanner Modal (simplified for demo) */}
                    {showQrScanner && (
                      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
                        <div className="bg-background rounded-lg p-4 max-w-sm w-full">
                          <h3 className="font-medium mb-2">Scan QR Code</h3>
                          <div className="border-2 border-dashed border-muted-foreground rounded-lg h-48 flex items-center justify-center mb-4">
                            <div className="text-center">
                              <QrCode className="h-12 w-12 mx-auto mb-2 text-muted-foreground" />
                              <p className="text-sm text-muted-foreground">Position QR code in this area</p>
                            </div>
                          </div>
                          <div className="flex justify-between">
                            <Button variant="outline" onClick={() => setShowQrScanner(false)}>
                              Cancel
                            </Button>
                            <Button onClick={() => handleQrScan("")}>Simulate Scan</Button>
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Participant Tags */}
                    <div className="flex flex-wrap gap-2 mb-3">
                      {payees
                        .filter((p) => p.address)
                        .map((payee) => (
                          <div
                            key={payee.id}
                            className="flex items-center bg-muted rounded-full pl-1 pr-2 py-1 text-xs group"
                          >
                            <Avatar className="h-5 w-5 mr-1">
                              <AvatarFallback
                                className={`text-[10px] ${
                                  payee.type === "email" || payee.address.includes("@")
                                    ? "bg-blue-100 text-blue-600"
                                    : "bg-purple-100 text-purple-600"
                                }`}
                              >
                                {payee.name?.[0] || (payee.type === "email" || payee.address.includes("@") ? "@" : "Ξ")}
                              </AvatarFallback>
                            </Avatar>
                            <span className="truncate max-w-[100px]">{payee.name || payee.address}</span>
                            <button
                              className="ml-1 rounded-full hover:bg-background p-0.5 opacity-70 group-hover:opacity-100"
                              onClick={() => removePayee(payee.id)}
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </div>
                        ))}
                    </div>

                    {/* Input Area */}
                    <div className="space-y-2 max-h-[200px] overflow-y-auto pr-1">
                      {payees.filter((p) => !p.address).length === 0 && (
                        <div className="relative">
                          <Input
                            placeholder="Add wallet address or email"
                            value={currentInput}
                            onChange={(e) => setCurrentInput(e.target.value)}
                            className="pl-9"
                            onKeyDown={(e) => {
                              if (e.key === "Enter" && currentInput) {
                                setPayees([
                                  ...payees,
                                  {
                                    id: Date.now().toString(),
                                    address: currentInput,
                                    amount: "",
                                    type: currentInput.includes("@") ? ("email" as const) : ("wallet" as const),
                                  },
                                ])
                                setCurrentInput("")
                              }
                            }}
                          />
                          <div className="absolute left-3 top-2.5">
                            {getInputType(currentInput) === "email" ? (
                              <AtSign className="h-4 w-4 text-blue-500" />
                            ) : (
                              <Wallet className="h-4 w-4 text-purple-500" />
                            )}
                          </div>
                          {currentInput && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="absolute right-2 top-1.5 h-6 w-6 p-0"
                              onClick={() => {
                                setPayees([
                                  ...payees,
                                  {
                                    id: Date.now().toString(),
                                    address: currentInput,
                                    amount: "",
                                    type: currentInput.includes("@") ? ("email" as const) : ("wallet" as const),
                                  },
                                ])
                                setCurrentInput("")
                              }}
                            >
                              <Check className="h-4 w-4" />
                            </Button>
                          )}
                        </div>
                      )}

                      {payees
                        .filter((p) => !p.address)
                        .map((payee) => (
                          <div key={payee.id} className="flex items-center gap-2">
                            <div className="relative flex-1">
                              <Input
                                placeholder="Wallet address or Email"
                                value={payee.address}
                                onChange={(e) => updatePayee(payee.id, { address: e.target.value })}
                                className="pl-9"
                              />
                              <div className="absolute left-3 top-2.5">
                                {getInputType(payee.address) === "email" ? (
                                  <AtSign className="h-4 w-4 text-blue-500" />
                                ) : (
                                  <Wallet className="h-4 w-4 text-purple-500" />
                                )}
                              </div>
                            </div>

                            {splitType === "custom" && (
                              <Input
                                type="number"
                                placeholder="Amount"
                                value={payee.amount}
                                onChange={(e) => updatePayee(payee.id, { amount: e.target.value })}
                                className="w-20 text-xs"
                              />
                            )}

                            {payees.length > 1 && (
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                onClick={() => removePayee(payee.id)}
                                className="h-7 w-7"
                              >
                                <X className="h-3 w-3" />
                              </Button>
                            )}
                          </div>
                        ))}
                    </div>

                    {/* Quick Actions */}
                    <div className="flex flex-wrap gap-2 mt-3">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs flex items-center"
                        onClick={() => {
                          // Add all recent contacts
                          const newPayees = recentContacts.map((contact, idx) => ({
                            id: `rc_${Date.now()}_${idx}`,
                            address: contact.address,
                            amount: "",
                            name: contact.name,
                            type: contact.type as "wallet" | "email",
                          }))
                          setPayees(newPayees)
                        }}
                      >
                        <History className="h-3 w-3 mr-1" />
                        Recent Split
                      </Button>
                    </div>
                  </div>
                </div>
              </motion.div>
            )}

            {step === 3 && (
              <motion.div
                key="step3"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                transition={{ duration: 0.3 }}
                className="px-4 py-4"
              >
                <div className="space-y-3">
                  <div className="rounded-lg border p-3 space-y-2">
                    <div className="flex justify-between">
                      <span className="text-xs text-muted-foreground">Title</span>
                      <span className="text-xs font-medium">Dinner at Satoshi's</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-xs text-muted-foreground">Amount</span>
                      <span className="text-xs font-medium">120 USDC</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-xs text-muted-foreground">Split Type</span>
                      <span className="text-xs font-medium">{splitType === "equal" ? "Equal" : "Custom"}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-xs text-muted-foreground">Deadline</span>
                      <span className="text-xs font-medium">April 1, 2025</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-xs text-muted-foreground">Participants</span>
                      <span className="text-xs font-medium">{payees.filter((p) => p.address).length} people</span>
                    </div>
                  </div>

                  <div className="space-y-1">
                    <Label className="text-xs font-medium">Participants</Label>
                    <div className="rounded-lg border p-3 max-h-[150px] overflow-y-auto">
                      {payees
                        .filter((p) => p.address)
                        .map((payee, index) => (
                          <div key={payee.id} className="flex justify-between py-1 border-b last:border-0">
                            <div className="flex items-center text-xs truncate max-w-[180px]">
                              <Avatar className="h-5 w-5 mr-1.5">
                                <AvatarFallback
                                  className={`text-[10px] ${
                                    payee.type === "email" || payee.address.includes("@")
                                      ? "bg-blue-100 text-blue-600"
                                      : "bg-purple-100 text-purple-600"
                                  }`}
                                >
                                  {payee.name?.[0] ||
                                    (payee.type === "email" || payee.address.includes("@") ? "@" : "Ξ")}
                                </AvatarFallback>
                              </Avatar>
                              <span className="truncate">{payee.name || payee.address}</span>
                            </div>
                            <span className="text-xs font-medium">
                              {splitType === "equal" ? "30 USDC" : `${payee.amount || "0"} USDC`}
                            </span>
                          </div>
                        ))}
                    </div>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <DialogFooter className="p-4 pt-2">
          {step > 1 ? (
            <div className="flex w-full justify-between">
              <Button type="button" variant="outline" onClick={prevStep} size="sm">
                Back
              </Button>
              {step < 3 ? (
                <Button type="button" onClick={nextStep} size="sm">
                  Next
                </Button>
              ) : (
                <Button
                  type="button"
                  onClick={handleFinalSubmit}
                  size="sm"
                  className="bg-gradient-to-r from-primary to-purple-500 hover:from-primary/90 hover:to-purple-500/90"
                >
                  Create Request
                </Button>
              )}
            </div>
          ) : (
            <Button type="button" onClick={nextStep} className="w-full">
              Next
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
