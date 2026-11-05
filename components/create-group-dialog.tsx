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
import { X, Plus, Users, Search, QrCode, Check, AtSign, Wallet } from "lucide-react"
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
import { Slider } from "@/components/ui/slider"

import { getActiveAccount } from "@/lib/onchain-store"
import { getFollowing, getIdentityByAddress, identityConfigured } from "@/lib/identity-client"
import { useI18n } from "@/components/i18n-provider"

interface CreateGroupDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

interface Contact { id: string; name: string; address: string; type: "wallet" | "email" }
const defaultRecentContacts: Contact[] = []
const historicalParticipants: Contact[] = []

interface Member {
  id: string
  name?: string
  address: string
  weight: number
  type?: "wallet" | "email"
}

export function CreateGroupDialog({ open, onOpenChange }: CreateGroupDialogProps) {
  const { t } = useI18n()
  const [recentContacts, setRecentContacts] = useState(defaultRecentContacts)
  const [members, setMembers] = useState<Member[]>([{ id: "1", address: "", weight: 1 }])
  const [step, setStep] = useState(1)
  const [currentInput, setCurrentInput] = useState("")
  const [showQrScanner, setShowQrScanner] = useState(false)
  const [searchTerm, setSearchTerm] = useState("")
  const [threshold, setThreshold] = useState(2)
  const [totalWeight, setTotalWeight] = useState(1)
  const [groupTitle, setGroupTitle] = useState("")

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
      } catch (error) { if (run === generation) setContactsError(error instanceof Error ? error.message : t("groups.readContactsFailed")) }
    }
    void load()
    window.addEventListener("sui-account-switched", load); window.addEventListener("storage", load)
    return () => { generation++; window.removeEventListener("sui-account-switched", load); window.removeEventListener("storage", load) }
  }, [open])

  // Reset state when dialog opens/closes
  useEffect(() => {
    if (!open) {
      setTimeout(() => {
        setMembers([{ id: "1", address: "", weight: 1 }])
        setStep(1)
        setCurrentInput("")
        setShowQrScanner(false)
        setThreshold(2)
        setTotalWeight(1)
      }, 300)
    }
  }, [open])

  useEffect(() => {
    // Calculate total weight
    const total = members.reduce((sum, member) => sum + member.weight, 0)
    setTotalWeight(total)
  }, [members])

  const addMember = () => {
    setMembers([...members, { id: Date.now().toString(), address: "", weight: 1 }])
  }

  const removeMember = (id: string) => {
    if (members.length > 1) {
      setMembers(members.filter((p) => p.id !== id))
    }
  }

  const updateMember = (id: string, updates: Partial<Member>) => {
    setMembers(members.map((p) => (p.id === id ? { ...p, ...updates } : p)))
  }

  const addContact = (contact: (typeof recentContacts)[0]) => {
    setMembers((currentMembers) => {
      // Find an empty member slot or add a new one
      const emptyMember = currentMembers.find((p) => !p.address)

      if (emptyMember) {
        return currentMembers.map((p) =>
          p.id === emptyMember.id
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
          ...currentMembers,
          {
            id: Date.now().toString(),
            address: contact.address,
            weight: 1,
            name: contact.name,
            type: contact.type,
          },
        ]
      }
    })
  }

  const handleQrScan = (validAddress: string) => {
    const emptyMember = members.find((p) => !p.address)
    if (emptyMember) updateMember(emptyMember.id, { address: validAddress, type: "wallet" })
    else setMembers([...members, { id: Date.now().toString(), address: validAddress, weight: 1, type: "wallet" }])
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
    setStep(step + 1)
  }

  const prevStep = () => {
    setStep(step - 1)
  }

  const handleCreateGroup = () => {
    // v0 shell 的 Create Group 按钮原本是 type="submit" 但没有 <form> 包裹，点击无效。
    // 这里保留 UI，不改外壳结构，直接把"建群"映射为本地新建群组（不上链，上链由 Convert to DAO 负责）。
    if (!members.every((m) => m.address)) {
      return
    }
    try {
      const newGroups = JSON.parse(localStorage.getItem("user_groups") || "[]")
      newGroups.push({
        id: `grp_${Date.now()}`,
        name: groupTitle.trim() || t("groups.unnamedGroup"),
        description: "",
        network: "Sui",
        members: members.map((m) => ({ ...m, weight: m.weight || 1 })),
        threshold,
        totalWeight,
        createdAt: new Date().toISOString(),
      })
      localStorage.setItem("user_groups", JSON.stringify(newGroups))
      window.dispatchEvent(new CustomEvent("sui-groups-updated", { detail: newGroups }))
      window.dispatchEvent(new Event("storage"))
      onOpenChange(false)
    } catch (e) {
      console.warn("Failed to save group to localStorage", e)
    }
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
          <DialogTitle>Create Multi-Signature Group</DialogTitle>
          <DialogDescription>{t("groups.createLocalDraftDesc")}</DialogDescription>
          {contactsError && <p role="alert" className="text-xs text-destructive">{contactsError}</p>}
        </DialogHeader>

        <div className="relative overflow-hidden">
          <div className="flex justify-between px-4 pt-4">
            {[1, 2, 3].map((i) => (
              <button
                key={i}
                type="button"
                disabled={i >= step}
                onClick={() => i < step && setStep(i)}
                aria-current={i === step ? "step" : undefined}
                aria-label={t("groups.stepLabel", { step: i, name: ["Details", "Members", "Review"][i - 1] ?? "" })}
                className="flex flex-col items-center rounded-md disabled:cursor-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                <div
                  className={`h-8 w-8 rounded-full flex items-center justify-center text-sm ${
                    i < step
                      ? "bg-primary text-primary-foreground"
                      : i === step
                        ? "bg-primary/20 text-primary border-2 border-primary"
                        : "bg-muted text-muted-foreground"}`}
                >
                  {i}
                </div>
                <div className="text-xs mt-1 text-muted-foreground">
                  {i === 1 ? "Details" : i === 2 ? "Members" : "Review"}
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
                      Group Name
                    </Label>
                    <Input id="title" value={groupTitle} onChange={(e) => setGroupTitle(e.target.value)} placeholder="Team Treasury, DAO Fund, etc." />
                  </div>

                  <div className="space-y-1">
                    <Label htmlFor="description" className="text-xs font-medium">
                      Description (Optional)
                    </Label>
                    <Textarea
                      id="description"
                      placeholder="Add details about this group"
                      className="resize-none h-20"
                    />
                  </div>

                  <div className="space-y-1">
                    <Label htmlFor="network" className="text-xs font-medium">
                      Network
                    </Label>
                    <select
                      id="network"
                      className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <option value="sui">Sui</option>
                      <option value="ethereum">Ethereum</option>
                      <option value="solana">Solana</option>
                      <option value="polygon">Polygon</option>
                    </select>
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
                    <div className="flex items-center justify-between">
                      <Label className="text-xs font-medium flex items-center">
                        <Users className="h-4 w-4 mr-1.5" />
                        Group Members
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
                                placeholder={t("groups.searchContacts")}
                                aria-label={t("groups.searchContacts")}
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
                          onClick={addMember}
                          className="h-7 text-xs"
                          title="Add Manually"
                        >
                          <Plus className="h-3 w-3" />
                        </Button>
                      </div>
                    </div>

                    <QrAddressScanner open={showQrScanner} onOpenChange={setShowQrScanner} onAddress={handleQrScan} />

                    {/* Member Tags */}
                    <div className="flex flex-wrap gap-2 mb-3">
                      {members
                        .filter((p) => p.address)
                        .map((member) => (
                          <div
                            key={member.id}
                            className="flex items-center bg-muted rounded-full pl-1 pr-2 py-1 text-xs group"
                          >
                            <Avatar className="h-5 w-5 mr-1">
                              <AvatarFallback
                                className={`text-[10px] ${
                                  member.type === "email" || member.address.includes("@")
                                    ? "bg-blue-100 text-blue-600"
                                    : "bg-purple-100 text-purple-600"
                                }`}
                              >
                                {member.name?.[0] ||
                                  (member.type === "email" || member.address.includes("@") ? "@" : "Ξ")}
                              </AvatarFallback>
                            </Avatar>
                            <span className="truncate max-w-[100px]">{member.name || member.address}</span>
                            <button
                              className="ml-1 rounded-full hover:bg-background p-0.5 opacity-70 group-hover:opacity-100"
                              onClick={() => removeMember(member.id)}
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </div>
                        ))}
                    </div>

                    {/* Input Area */}
                    <div className="space-y-2 max-h-[200px] overflow-y-auto pr-1">
                      {members.filter((p) => !p.address).length === 0 && (
                        <div className="relative">
                          <Input
                            placeholder="Add wallet address or email"
                            value={currentInput}
                            onChange={(e) => setCurrentInput(e.target.value)}
                            className="pl-9"
                            onKeyDown={(e) => {
                              if (e.key === "Enter" && currentInput) {
                                setMembers([
                                  ...members,
                                  {
                                    id: Date.now().toString(),
                                    address: currentInput,
                                    weight: 1,
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
                                setMembers([
                                  ...members,
                                  {
                                    id: Date.now().toString(),
                                    address: currentInput,
                                    weight: 1,
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

                      {members
                        .filter((p) => !p.address)
                        .map((member) => (
                          <div key={member.id} className="flex items-center gap-2">
                            <div className="relative flex-1">
                              <Input
                                placeholder="Wallet address or Email"
                                value={member.address}
                                onChange={(e) => updateMember(member.id, { address: e.target.value })}
                                className="pl-9"
                              />
                              <div className="absolute left-3 top-2.5">
                                {getInputType(member.address) === "email" ? (
                                  <AtSign className="h-4 w-4 text-blue-500" />
                                ) : (
                                  <Wallet className="h-4 w-4 text-purple-500" />
                                )}
                              </div>
                            </div>

                            {members.length > 1 && (
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                onClick={() => removeMember(member.id)}
                                className="h-7 w-7"
                              >
                                <X className="h-3 w-3" />
                              </Button>
                            )}
                          </div>
                        ))}
                    </div>

                    {/* Member Weights */}
                    <div className="mt-6 space-y-3">
                      <Label className="text-xs font-medium">Member Weights</Label>
                      {members
                        .filter((p) => p.address)
                        .map((member) => (
                          <div key={member.id} className="flex items-center gap-3">
                            <div className="flex items-center flex-1">
                              <Avatar className="h-6 w-6 mr-2">
                                <AvatarFallback
                                  className={`text-[10px] ${
                                    member.type === "email" || member.address.includes("@")
                                      ? "bg-blue-100 text-blue-600"
                                      : "bg-purple-100 text-purple-600"
                                  }`}
                                >
                                  {member.name?.[0] ||
                                    (member.type === "email" || member.address.includes("@") ? "@" : "Ξ")}
                                </AvatarFallback>
                              </Avatar>
                              <span className="text-xs truncate max-w-[120px]">
                                {member.name || member.address.slice(0, 8) + "..."}
                              </span>
                            </div>
                            <div className="flex items-center gap-2 flex-1">
                              <Slider
                                defaultValue={[1]}
                                value={[member.weight]}
                                min={1}
                                max={10}
                                step={1}
                                onValueChange={(value) => updateMember(member.id, { weight: value[0] })}
                                className="flex-1"
                              />
                              <span className="text-xs font-medium w-6 text-center">{member.weight}</span>
                            </div>
                          </div>
                        ))}
                    </div>

                    {/* Threshold Setting */}
                    <div className="mt-6 space-y-2">
                      <div className="flex items-center justify-between">
                        <Label className="text-xs font-medium">Approval Threshold</Label>
                        <span className="text-xs font-medium">
                          {threshold} of {totalWeight} ({Math.round((threshold / totalWeight) * 100)}%)
                        </span>
                      </div>
                      <Slider
                        defaultValue={[2]}
                        value={[threshold]}
                        min={1}
                        max={totalWeight}
                        step={1}
                        onValueChange={(value) => setThreshold(value[0])}
                      />
                      <p className="text-xs text-muted-foreground mt-1">
                        Transactions require at least {threshold} weight units to be approved
                      </p>
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
                      <span className="text-xs text-muted-foreground">Group Name</span>
                      <span className="text-xs font-medium">{groupTitle || t("groups.unnamedGroup")}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-xs text-muted-foreground">Network</span>
                      <span className="text-xs font-medium">Sui</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-xs text-muted-foreground">Members</span>
                      <span className="text-xs font-medium">{members.filter((p) => p.address).length} people</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-xs text-muted-foreground">Total Weight</span>
                      <span className="text-xs font-medium">{totalWeight} units</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-xs text-muted-foreground">Threshold</span>
                      <span className="text-xs font-medium">
                        {threshold} ({Math.round((threshold / totalWeight) * 100)}%)
                      </span>
                    </div>
                  </div>

                  <div className="space-y-1">
                    <Label className="text-xs font-medium">Members</Label>
                    <div className="rounded-lg border p-3 max-h-[150px] overflow-y-auto">
                      {members
                        .filter((p) => p.address)
                        .map((member) => (
                          <div key={member.id} className="flex justify-between py-1 border-b last:border-0">
                            <div className="flex items-center text-xs truncate max-w-[180px]">
                              <Avatar className="h-5 w-5 mr-1.5">
                                <AvatarFallback
                                  className={`text-[10px] ${
                                    member.type === "email" || member.address.includes("@")
                                      ? "bg-blue-100 text-blue-600"
                                      : "bg-purple-100 text-purple-600"
                                  }`}
                                >
                                  {member.name?.[0] ||
                                    (member.type === "email" || member.address.includes("@") ? "@" : "Ξ")}
                                </AvatarFallback>
                              </Avatar>
                              <span className="truncate">{member.name || member.address}</span>
                            </div>
                            <span className="text-xs font-medium">Weight: {member.weight}</span>
                          </div>
                        ))}
                    </div>
                  </div>

                  <div className="rounded-lg border p-3 bg-accent/30">
                    <p className="text-xs">
                      This will create a new multi-signature wallet on the Sui blockchain. All members will receive an
                      invitation link to join this group.
                    </p>
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
                  onClick={handleCreateGroup}
                  size="sm"
                  className="bg-gradient-to-r from-primary to-purple-500 hover:from-primary/90 hover:to-purple-500/90"
                >
                  Create Group
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
