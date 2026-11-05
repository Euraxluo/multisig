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
import { QrAddressScanner } from "@/components/qr-address-scanner"
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

import { getActiveAccount } from "@/lib/onchain-store"
import { getFollowing, getIdentityByAddress, identityConfigured } from "@/lib/identity-client"
import { canonicalPaymentAssets } from "@/lib/payment-assets"
import { useI18n } from "@/components/i18n-provider"

interface CreateBillDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

interface Contact { id: string; name: string; address: string; type: "wallet" | "email" }
const defaultContacts: Contact[] = []
const historicalParticipants: Contact[] = []

interface Payee {
  id: string
  name?: string
  address: string
  amount: string
  type?: "wallet" | "email"
}

export function CreateBillDialog({ open, onOpenChange }: CreateBillDialogProps) {
  const { t } = useI18n()
  const [payees, setPayees] = useState<Payee[]>([{ id: "1", address: "", amount: "" }])
  const [splitType, setSplitType] = useState("equal")
  const [step, setStep] = useState(1)
  const [currentInput, setCurrentInput] = useState("")
  const [showQrScanner, setShowQrScanner] = useState(false)
  const [searchTerm, setSearchTerm] = useState("")
  const [recentContacts, setRecentContacts] = useState(defaultContacts)

  const [contactsError, setContactsError] = useState("")
  useEffect(() => {
    let generation = 0
    const load = async () => {
      const run = ++generation
      setRecentContacts([]); setContactsError("")
      const address = getActiveAccount()?.address
      if (!open || !address || !identityConfigured()) return
      try {
        const profile = await getIdentityByAddress(address)
        const list = profile ? await getFollowing(profile) : []
        if (run === generation && getActiveAccount()?.address === address) setRecentContacts(list.map(person => ({ id: person.id, name: person.displayName || `${person.label}.id`, address: person.address, type: "wallet" as const })))
      } catch (error) { if (run === generation) setContactsError(error instanceof Error ? error.message : t("voting.errContactsRead")) }
    }
    void load()
    window.addEventListener("sui-account-switched", load); window.addEventListener("storage", load)
    return () => { generation++; window.removeEventListener("sui-account-switched", load); window.removeEventListener("storage", load) }
  }, [open])

  const [title, setTitle] = useState("")
  const [description, setDescription] = useState("")
  const [totalAmount, setTotalAmount] = useState("")
  const [selectedToken, setSelectedToken] = useState("SUI")
  const [acceptedTokens, setAcceptedTokens] = useState<string[]>(["SUI"])
  const [deadline, setDeadline] = useState(() => new Date(Date.now() + 86_400_000 * 7).toISOString().slice(0, 10))

  const tokens = canonicalPaymentAssets()

  const toggleAcceptedToken = (symbol: string, checked: boolean) => {
    setAcceptedTokens(current => checked ? [...new Set([...current, symbol])] : current.filter(value => value !== symbol))
  }

  const handleFinalSubmit = () => {
    try {
      const stored = JSON.parse(localStorage.getItem("sui_bills") || "[]")
      const parsedAmt = parseFloat(totalAmount)
      const activePayees = payees.filter((p) => p.address)
      const myAddress = getActiveAccount()?.address
      if (!myAddress || !title.trim() || !Number.isFinite(parsedAmt) || parsedAmt <= 0 || activePayees.length === 0) { setContactsError(t("voting.errBillRequired")) ; return }
      if (!deadline) { setContactsError(t("voting.errBillDeadline")) ; return }
      if (selectedToken !== "SUI") { setContactsError(t("voting.errBillSuiOnly")) ; return }
      const newBill = {
        id: `bill_${Date.now()}`,
        title: title.trim(),
        description: description.trim() || t("voting.billDefaultDescription"),
        amount: parsedAmt,
        token: selectedToken,
        coinType: "0x2::sui::SUI",
        acceptedTokens,
        acceptedTokensNote: t("voting.billTokensNote"),
        participants: activePayees.length,
        paid: 0,
        deadline,
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
    } catch { setContactsError(t("voting.errBillSave")); return }
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
        setTitle("")
        setDescription("")
        setTotalAmount("")
        setSelectedToken("SUI")
        setAcceptedTokens(["SUI"])
        setDeadline(new Date(Date.now() + 86_400_000 * 7).toISOString().slice(0, 10))
        setContactsError("")
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

  const handleQrScan = (validAddress: string) => {
    const emptyPayee = payees.find((p) => !p.address)
    if (emptyPayee) updatePayee(emptyPayee.id, { address: validAddress, type: "wallet" })
    else setPayees([...payees, { id: Date.now().toString(), address: validAddress, amount: "", type: "wallet" }])
    setContactsError("")
    setShowQrScanner(false)
  }

  const getInputType = (value: string) => {
    if (!value) return null
    if (value.includes("@")) return "email"
    if (value.startsWith("0x")) return "wallet"
    return "unknown"
  }

  const nextStep = () => {
    if (step === 1) {
      if (!title.trim() || !Number.isFinite(Number(totalAmount)) || Number(totalAmount) <= 0) {
        setContactsError(t("voting.errStep1Fields"))
        return
      }
      if (!deadline) {
        setContactsError(t("voting.errStep1Deadline"))
        return
      }
    }
    if (step === 2 && payees.filter((payee) => payee.address).length === 0) {
      setContactsError(t("voting.errStep2Payees"))
      return
    }
    setContactsError("")
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
          <DialogDescription>{t("voting.billDialogDesc")}</DialogDescription>
          {contactsError && <p role="alert" className="text-xs text-destructive">{contactsError}</p>}
        </DialogHeader>

        <div className="relative overflow-hidden">
          <div className="flex justify-between px-4 pt-4">
            {[1, 2, 3].map((i) => (
              <button
                key={i}
                type="button"
                disabled={i >= step}
                onClick={() => setStep(i)}
                aria-current={i === step ? "step" : undefined}
                aria-label={t("voting.stepAria", { index: i, label: ["Details", "Participants", "Review"][i - 1] })}
                className="flex flex-col items-center rounded-md disabled:cursor-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
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
              </button>
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
                          {tokens.map((asset) => (
                            <SelectItem key={asset.symbol} value={asset.symbol} disabled={asset.source === "unavailable"}>
                              {asset.source === "unavailable" ? t("voting.tokenUnavailable", { symbol: asset.symbol }) : asset.symbol}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  <div className="space-y-1">
                    <Label className="text-xs font-medium">Accepted Tokens</Label>
                    <div className="flex flex-wrap gap-2 mt-1">
                      {tokens.map((asset) => (
                        <div key={asset.symbol} className="flex items-center">
                          <input
                            type="checkbox"
                            id={`token-${asset.symbol}`}
                            className="mr-1.5"
                            checked={acceptedTokens.includes(asset.symbol)}
                            disabled={asset.source === "unavailable"}
                            onChange={(event) => toggleAcceptedToken(asset.symbol, event.target.checked)}
                          />
                          <Label htmlFor={`token-${asset.symbol}`} className="text-xs">
                            {asset.symbol}
                          </Label>
                        </div>
                      ))}
                    </div>
                    <p className="text-[11px] text-muted-foreground">{t("voting.acceptedTokensNote")}</p>
                  </div>

                  <div className="space-y-1">
                    <Label htmlFor="deadline" className="text-xs font-medium">
                      Deadline
                    </Label>
                    <div className="relative">
                      <Input id="deadline" type="date" className="pl-9" value={deadline} onChange={(event) => setDeadline(event.target.value)} />
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
                            <div className="px-1 pb-1">
                              <Input
                                value={searchTerm}
                                onChange={(event) => setSearchTerm(event.target.value)}
                                placeholder={t("voting.searchContacts")}
                                aria-label={t("voting.searchContacts")}
                                className="h-7 text-xs"
                              />
                            </div>
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

                    <QrAddressScanner open={showQrScanner} onOpenChange={setShowQrScanner} onAddress={handleQrScan} />

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
                      <span className="text-xs font-medium">{title.trim() || t("voting.notFilled")}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-xs text-muted-foreground">Amount</span>
                      <span className="text-xs font-medium">{totalAmount || "0"} {selectedToken}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-xs text-muted-foreground">Split Type</span>
                      <span className="text-xs font-medium">{splitType === "equal" ? "Equal" : "Custom"}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-xs text-muted-foreground">Deadline</span>
                      <span className="text-xs font-medium">{deadline ? new Date(`${deadline}T00:00:00`).toLocaleDateString() : t("voting.notChosen")}</span>
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
                        .map((payee) => (
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
                              {splitType === "equal"
                                ? `${(Number(totalAmount || 0) / Math.max(1, payees.filter((p) => p.address).length)).toFixed(2)} ${selectedToken}`
                                : `${payee.amount || "0"} ${selectedToken}`}
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
