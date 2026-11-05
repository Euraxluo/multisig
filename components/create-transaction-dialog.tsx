"use client"

import { useState, useEffect, useRef } from "react"
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
import { motion, AnimatePresence } from "framer-motion"
import { Calendar, FileText, Code, Send, Clock, Zap, ListChecks, Plus, X, ChevronDown, ChevronUp } from "lucide-react"
import { Switch } from "@/components/ui/switch"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import { format } from "date-fns"
import { Calendar as CalendarComponent } from "@/components/ui/calendar"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { createTransferProposalOnChain, getUserGroups } from "@/lib/onchain-store"
import { groupVaults, type GroupVaultRow } from "@/lib/group-vaults"
import { createSubmissionGuard } from "@/lib/wallet-creation-state"
import { usePendingCreation } from "@/lib/use-pending-creation"
import { TransactionReceiptError } from "@/lib/pending-transactions"
import { getPaymentTemplates, savePaymentTemplates } from "@/lib/local-records"
import { paymentUnits } from "@/lib/scheduled-payments-chain"
import { errorMessage as describeError } from "@/lib/error-message"
import { useI18n } from "@/components/i18n-provider"
import { MIST_PER_SUI } from "@mysten/sui/utils"

const formatSuiBalance = (mist: bigint) => {
  const fraction = (mist % MIST_PER_SUI).toString().padStart(9, "0").replace(/0+$/, "")
  return `${mist / MIST_PER_SUI}${fraction ? `.${fraction}` : ""} SUI`
}

interface CreateTransactionDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  groupId: string
  initialTemplate?: TransactionTemplate
}

interface TransactionTemplate {
  id: string
  name: string
  type: string
  recipient?: string
  amount?: string
  token?: string
  contract?: string
  function?: string
  args?: string
  payload?: string
}

interface BatchTransaction {
  id: string
  type: string
  recipient?: string
  amount?: string
  token?: string
  contract?: string
  function?: string
  args?: string
  payload?: string
}

export function CreateTransactionDialog({ open, onOpenChange, groupId, initialTemplate }: CreateTransactionDialogProps) {
  const { t } = useI18n()
  const [step, setStep] = useState(1)
  const [transactionType, setTransactionType] = useState("transfer")
  const [advancedMode, setAdvancedMode] = useState(false)
  const [scheduleType, setScheduleType] = useState("immediate")
  const [executeDate, setExecuteDate] = useState<Date | undefined>(undefined)
  const [conditionType, setConditionType] = useState("none")
  const [priceCondition, setPriceCondition] = useState("above")
  const [priceThreshold, setPriceThreshold] = useState("100")
  const [priceToken, setPriceToken] = useState("SUI")
  const [saveAsTemplate, setSaveAsTemplate] = useState(false)
  const [templateName, setTemplateName] = useState("")
  const [selectedTemplate, setSelectedTemplate] = useState<string | null>(null)
  const [batchMode, setBatchMode] = useState(false)
  const [batchTransactions, setBatchTransactions] = useState<BatchTransaction[]>([])
  const [expandedBatchIndex, setExpandedBatchIndex] = useState<number | null>(null)

  // Form input states
  const [title, setTitle] = useState("")
  const [description, setDescription] = useState("")
  const [recipient, setRecipient] = useState("")
  const [amount, setAmount] = useState("")
  const [selectedToken, setSelectedToken] = useState("SUI")
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const [currentGroup, setCurrentGroup] = useState({ id: "", name: t("vault.noOrgSelected"), balance: "—", token: "SUI", orgObjectId: "", vaultId: "", masterCapId: "" })
  const [treasuries, setTreasuries] = useState<GroupVaultRow[]>([])
  const [selectedTreasuryId, setSelectedTreasuryId] = useState("")
  const [legacySource, setLegacySource] = useState("")
  const submissionGuard = useRef(createSubmissionGuard())
  const groupGeneration = useRef(0)
  const treasuryScope = selectedTreasuryId || currentGroup.vaultId || "unselected"
  const proposalCreateAction = selectedTreasuryId ? "group-treasury-proposal-create" : legacySource ? "personal-cap-proposal-create" : "group-treasury-proposal-create"
  const recovery = usePendingCreation(open, proposalCreateAction, treasuryScope)
  useEffect(() => {
    let cancelled = false
    const generation = ++groupGeneration.current
    const load = async () => {
      const found = getUserGroups().find(group => group.id === groupId)
      const next = { id: found?.id || "", name: found?.name || t("vault.noOrgSelected"), balance: "—", token: "SUI", orgObjectId: found?.orgObjectId || "", vaultId: found?.vaultId || "", masterCapId: found?.masterCapId || "" }
      setCurrentGroup(next)
      setTreasuries([])
      setSelectedTreasuryId("")
      setLegacySource("")
      setTemplates(getPaymentTemplates())
      if (!found?.orgObjectId) return
      try {
        const result = await groupVaults.listVaults(found.orgObjectId)
        if (cancelled || generation !== groupGeneration.current) return
        const choices = result.vaults.filter(vault => vault.authority.verified && vault.authority.status === "organization-treasury" && vault.coinType === "0x2::sui::SUI" && vault.treasuryId)
        setTreasuries(choices)
        const first = choices[0]
        if (first) {
          setCurrentGroup(value => ({ ...value, balance: t("vault.pickTreasury"), token: "SUI" }))
        }
      } catch (error) {
        if (!cancelled && generation === groupGeneration.current) setErrorMessage(error instanceof Error ? error.message : t("vault.treasuryReadFailed"))
      }
    }
    void load()
    const onGroupsUpdated = () => void load()
    const onTemplatesUpdated = () => void load()
    const onStorage = () => void load()
    window.addEventListener("sui-groups-updated", onGroupsUpdated)
    window.addEventListener("sui-templates-updated", onTemplatesUpdated)
    window.addEventListener("storage", onStorage)
    const invalidate = () => { groupGeneration.current++ }
    return () => { cancelled = true; invalidate(); window.removeEventListener("sui-groups-updated", onGroupsUpdated); window.removeEventListener("sui-templates-updated", onTemplatesUpdated); window.removeEventListener("storage", onStorage) }
  }, [groupId, open])
  const [templates, setTemplates] = useState<TransactionTemplate[]>([])

  useEffect(() => {
    if (!open) return
    setStep(1)
    setTransactionType(initialTemplate?.type || "transfer")
    setTitle(initialTemplate?.name || "")
    setRecipient(initialTemplate?.recipient || "")
    setAmount(initialTemplate?.amount || "")
    setSelectedToken(initialTemplate?.token || "SUI")
    setDescription("")
    setErrorMessage(null)
    setAdvancedMode(false)
    setScheduleType("immediate")
    setExecuteDate(undefined)
    setConditionType("none")
    setPriceCondition("above")
    setPriceThreshold("100")
    setPriceToken("SUI")
    setSaveAsTemplate(false)
    setTemplateName("")
    setSelectedTemplate(initialTemplate?.id || null)
    setBatchMode(false)
    setBatchTransactions([])
    setExpandedBatchIndex(null)
    setSelectedTreasuryId("")
    setLegacySource("")
  }, [open, groupId, initialTemplate])

  const nextStep = () => {
    setStep(step + 1)
  }

  const prevStep = () => {
    setStep(step - 1)
  }

  const tokens = ["SUI", "USDC", "USDT"]

  const loadTemplate = (templateId: string) => {
    const template = templates.find((t) => t.id === templateId)
    if (template) {
      setTransactionType(template.type)
      setSelectedTemplate(templateId)
      setTitle(template.name)

      // Load template data based on type
      if (template.type === "transfer" && template.recipient && template.amount && template.token) {
        setRecipient(template.recipient)
        setAmount(template.amount)
        setSelectedToken(template.token)
      }
    }
  }

  const handleSubmitTransaction = async () => {
    setErrorMessage(null)
    if (!title.trim()) {
      setErrorMessage(t("vault.titleRequired"))
      return
    }

    // The contract can only execute one fixed coin transfer per proposal
    // (organization_treasury::create_transfer / asynchronous_proposal). Off-chain
    // descriptions of contract calls, batches, schedules and price conditions
    // must not be presented as proposals that would actually execute.
    if (transactionType !== "transfer") {
      setErrorMessage(t("vault.proposalSuiOnly"))
      return
    }
    if (batchMode) {
      setErrorMessage(t("vault.batchProposalUnsupported"))
      return
    }
    if (scheduleType !== "immediate") {
      setErrorMessage(t("vault.scheduledProposalUnsupported"))
      return
    }
    if (conditionType !== "none") {
      setErrorMessage(t("vault.conditionProposalUnsupported"))
      return
    }
    if (saveAsTemplate && !templateName.trim()) {
      setErrorMessage(t("vault.templateNameRequired"))
      return
    }
    const selectedGroup = getUserGroups().find(group => group.id === groupId)
    if (!groupId || !currentGroup.orgObjectId || selectedGroup?.orgObjectId !== currentGroup.orgObjectId) {
      setErrorMessage(t("vault.reenterFromGroup"))
      return
    }
    if (selectedToken !== "SUI") { setErrorMessage(t("vault.treasurySuiOnly")); return }
    if (transactionType === "transfer") {
      if (!recipient.trim()) {
        setErrorMessage(t("vault.recipientRequired"));
        return
      }
      if (!/^\d+(\.\d+)?$/.test(amount.trim())) {
        setErrorMessage(t("vault.amountDecimalHint"));
        return
      }
      try { paymentUnits(amount.trim(), 9) } catch (amountError) {
        setErrorMessage(amountError instanceof Error ? amountError.message : t("vault.amountInvalid"))
        return
      }
    }
    if (!selectedTreasuryId && !legacySource) {
      setErrorMessage(t("vault.selectTreasuryFirst"))
      return
    }
    if (recovery.blocked) { setErrorMessage(recovery.receiptError || t("vault.pendingProposalRecover")); return }
    if (!submissionGuard.current.enter()) return
    const runGeneration = groupGeneration.current
    setIsSubmitting(true)
    try {
      await createTransferProposalOnChain({
        title: title.trim(),
        recipient: recipient.trim(),
        amount,
        token: selectedToken,
        description: description.trim() || `${transactionType} proposal`,
        groupId: currentGroup.id,
        groupName: currentGroup.name,
        orgId: currentGroup.orgObjectId,
        treasuryId: selectedTreasuryId || undefined,
        legacyVaultId: legacySource ? currentGroup.vaultId : undefined,
        legacyMasterCapId: legacySource ? currentGroup.masterCapId : undefined,
        deadlineMs: executeDate ? executeDate.getTime() : undefined,
        assertContext: () => {
          if (runGeneration !== groupGeneration.current || getUserGroups().find(group => group.id === groupId)?.orgObjectId !== currentGroup.orgObjectId) throw new Error(t("vault.groupSwitchedDuringSubmit"))
        },
      })
      if (saveAsTemplate) {
        // Persist only after the proposal is confirmed on chain, so a failed
        // submission cannot leave a "template" implying a real transaction.
        const now = new Date().toISOString()
        const template = {
          id: `template-${Date.now()}`,
          name: templateName.trim(),
          type: "transfer",
          description: description.trim() || `${recipient.trim()} · ${amount.trim()} SUI`,
          createdAt: now,
          recipient: recipient.trim(),
          amount: amount.trim(),
          token: "SUI",
          sourceStatus: "local" as const,
        }
        savePaymentTemplates([...getPaymentTemplates(), template])
      }
      onOpenChange(false)
    } catch (e) {
      if (e instanceof TransactionReceiptError) recovery.setPending(e.status === "failed" ? undefined : e.receipt)
      setErrorMessage(describeError(e, t("vault.createProposalFailed")))
    } finally {
      submissionGuard.current.leave()
      setIsSubmitting(false)
    }
  }
  const handleResumeTransaction = async () => {
    if (!recovery.pending || !submissionGuard.current.enter()) return
    setIsSubmitting(true); setErrorMessage(null)
    try {
      const { resumeTransferProposalCreation } = await import("@/lib/onchain-store")
      await resumeTransferProposalCreation(recovery.pending)
      recovery.setPending(undefined)
      onOpenChange(false)
    } catch (error) {
      if (error instanceof TransactionReceiptError) recovery.setPending(error.status === "failed" ? undefined : error.receipt)
      setErrorMessage(error instanceof Error ? error.message : t("vault.originalTxUnconfirmed"))
    } finally { submissionGuard.current.leave(); setIsSubmitting(false) }
  }

  const addBatchTransaction = () => {
    const newTransaction: BatchTransaction = {
      id: `batch-${Date.now()}`,
      type: "transfer",
    }
    setBatchTransactions([...batchTransactions, newTransaction])
    setExpandedBatchIndex(batchTransactions.length)
  }

  const removeBatchTransaction = (index: number) => {
    const updatedBatch = [...batchTransactions]
    updatedBatch.splice(index, 1)
    setBatchTransactions(updatedBatch)
    setExpandedBatchIndex(null)
  }

  const updateBatchTransaction = (index: number, updates: Partial<BatchTransaction>) => {
    const updatedBatch = [...batchTransactions]
    updatedBatch[index] = { ...updatedBatch[index], ...updates }
    setBatchTransactions(updatedBatch)
  }

  const toggleBatchExpand = (index: number) => {
    setExpandedBatchIndex(expandedBatchIndex === index ? null : index)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px] p-0 gap-0 overflow-hidden">
        <DialogHeader className="p-4 pb-0">
          <DialogTitle>{t("vault.newGroupProposal")}</DialogTitle>
          <DialogDescription>{t("vault.newGroupProposalDesc")}</DialogDescription>
          {selectedTemplate && (
            <p className="text-xs text-muted-foreground">
              {t("vault.appliedTemplate", { name: templates.find((template) => template.id === selectedTemplate)?.name ?? selectedTemplate })}
            </p>
          )}
        </DialogHeader>

        <div className="relative overflow-hidden">
          <div className="flex justify-between px-4 pt-4">
            {[1, 2].map((i) => (
              <button
                key={i}
                type="button"
                disabled={i >= step}
                onClick={() => setStep(i)}
                aria-current={i === step ? "step" : undefined}
                aria-label={t("vault.stepAria", { i, label: i === 1 ? "Transaction Type" : "Details" })}
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
                <div className="text-xs mt-1 text-muted-foreground">{i === 1 ? "Transaction Type" : "Details"}</div>
              </button>
            ))}
            <div className="absolute top-[28px] left-[120px] w-[120px] h-[2px] bg-muted">
              <div className={`h-full bg-primary transition-all ${step > 1 ? "w-full" : "w-0"}`}></div>
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
                    <Label className="text-xs font-medium">{t("vault.formTxType")}</Label>
                    <Tabs value={transactionType} onValueChange={setTransactionType} className="w-full">
                      <TabsList className="grid w-full grid-cols-3 p-1 bg-muted/50 rounded-xl h-9">
                        <TabsTrigger
                          value="transfer"
                          className="rounded-lg text-xs data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
                        >
                          <Send className="h-3 w-3 mr-1" />
                          Transfer
                        </TabsTrigger>
                        <TabsTrigger
                          value="contract"
                          className="rounded-lg text-xs data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
                        >
                          <Code className="h-3 w-3 mr-1" />
                          Contract
                        </TabsTrigger>
                        <TabsTrigger
                          value="custom"
                          className="rounded-lg text-xs data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
                        >
                          <FileText className="h-3 w-3 mr-1" />
                          Custom
                        </TabsTrigger>
                      </TabsList>
                    </Tabs>
                  </div>

                  <div className="p-3 rounded-lg bg-muted/50">
                    <p className="text-xs text-muted-foreground">{t("vault.proposalGroup")}</p>
                    <p className="font-medium">{currentGroup.name}</p>
                    <p className="mt-1 break-all font-mono text-xs text-muted-foreground">{currentGroup.orgObjectId || t("vault.orgNotLinked")}</p>

                    <div className="flex items-center justify-between mt-2">
                      <div>
                        <p className="text-xs text-muted-foreground">{t("vault.formAvailableBalance")}</p>
                        <p className="font-medium">
                          {currentGroup.balance} {currentGroup.token}
                        </p>
                      </div>
                    </div>
                    <div className="mt-3 space-y-1">
                      <Label className="text-xs font-medium">{t("vault.fundingSource")}</Label>
                      <Select value={selectedTreasuryId || legacySource} onValueChange={(value) => {
                        if (value === "legacy") { setSelectedTreasuryId(""); setLegacySource("legacy") }
                        else { setLegacySource(""); setSelectedTreasuryId(value) }
                        const row = treasuries.find(treasury => treasury.treasuryId === value)
                        if (row) setCurrentGroup(group => ({ ...group, balance: formatSuiBalance(row.balance), vaultId: row.id, masterCapId: row.masterCapId || "" }))
                      }}>
                        <SelectTrigger className="w-full"><SelectValue placeholder={t("vault.selectTreasuryPlaceholder")} /></SelectTrigger>
                        <SelectContent>
                          {treasuries.map(treasury => <SelectItem key={treasury.treasuryId} value={treasury.treasuryId!}>
                            {t("vault.orgTreasuryOption", { balance: formatSuiBalance(treasury.balance) })}
                          </SelectItem>)}
                          {currentGroup.vaultId && currentGroup.masterCapId && <SelectItem value="legacy">{t("vault.legacyVaultOption")}</SelectItem>}
                        </SelectContent>
                      </Select>
                      <p className="text-[11px] text-muted-foreground">{t("vault.treasurySourceHint")}</p>
                    </div>
                  </div>

                  <div className="space-y-1">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="title" className="text-xs font-medium">
                        Transaction Title
                      </Label>
                      <div className="flex items-center space-x-2">
                        <Label htmlFor="template" className="text-xs font-medium">
                          Use Template
                        </Label>
                        <Select onValueChange={(value) => loadTemplate(value)}>
                          <SelectTrigger id="template" className="h-7 w-[130px] text-xs">
                            <SelectValue placeholder={t("vault.phSelect")} />
                          </SelectTrigger>
                          <SelectContent>
                            {templates.map((template) => (
                              <SelectItem key={template.id} value={template.id} className="text-xs">
                                {template.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                    <div className="relative">
                      <Input
                        id="title"
                        value={title}
                        onChange={(e) => setTitle(e.target.value)}
                        placeholder={t("vault.phTitle")}
                        className="pl-9"
                      />
                      <FileText className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
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
                      placeholder={t("vault.phDescription")}
                      className="resize-none h-20"
                    />
                  </div>

                  <div className="flex items-center justify-between pt-2">
                    <div className="flex items-center space-x-2">
                      <Switch id="advanced-mode" checked={advancedMode} onCheckedChange={setAdvancedMode} />
                      <Label htmlFor="advanced-mode" className="text-xs font-medium cursor-pointer">
                        Advanced Mode
                      </Label>
                    </div>
                    <div className="flex items-center space-x-2">
                      <Switch id="batch-mode" checked={batchMode} onCheckedChange={setBatchMode} />
                      <Label htmlFor="batch-mode" className="text-xs font-medium cursor-pointer">
                        Batch Mode
                      </Label>
                    </div>
                  </div>

                  {advancedMode && (
                    <div className="space-y-3 pt-2 border-t">
                      <div className="space-y-1">
                        <Label className="text-xs font-medium">{t("vault.formExecutionSchedule")}</Label>
                        <Select value={scheduleType} onValueChange={setScheduleType}>
                          <SelectTrigger className="w-full">
                            <SelectValue placeholder={t("vault.phSelectSchedule")} />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="immediate">Immediate (After Approval)</SelectItem>
                            <SelectItem value="scheduled">{t("vault.formScheduledDate")}</SelectItem>
                            <SelectItem value="conditional">{t("vault.formConditionalExecution")}</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>

                      {scheduleType === "scheduled" && (
                        <div className="space-y-1">
                          <Label className="text-xs font-medium">{t("vault.formExecuteOn")}</Label>
                          <Popover>
                            <PopoverTrigger asChild>
                              <Button
                                variant={"outline"}
                                className={cn(
                                  "w-full justify-start text-left font-normal",
                                  !executeDate && "text-muted-foreground",
                                )}
                              >
                                <Calendar className="mr-2 h-4 w-4" />
                                {executeDate ? format(executeDate, "PPP") : "Select date"}
                              </Button>
                            </PopoverTrigger>
                            <PopoverContent className="w-auto p-0">
                              <CalendarComponent
                                mode="single"
                                selected={executeDate}
                                onSelect={setExecuteDate}
                              />
                            </PopoverContent>
                          </Popover>
                        </div>
                      )}

                      {scheduleType === "conditional" && (
                        <div className="space-y-3">
                          <div className="space-y-1">
                            <Label className="text-xs font-medium">{t("vault.formConditionType")}</Label>
                            <Select value={conditionType} onValueChange={setConditionType}>
                              <SelectTrigger className="w-full">
                                <SelectValue placeholder={t("vault.phSelectConditionType")} />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="price">{t("vault.formPriceCondition")}</SelectItem>
                                <SelectItem value="balance">{t("vault.formBalanceCondition")}</SelectItem>
                                <SelectItem value="time">{t("vault.formTimeCondition")}</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>

                          {conditionType === "price" && (
                            <div className="space-y-3">
                              <div className="flex items-center space-x-2">
                                <div className="flex-1">
                                  <Label className="text-xs font-medium">{t("vault.formToken")}</Label>
                                  <Select value={priceToken} onValueChange={setPriceToken}>
                                    <SelectTrigger>
                                      <SelectValue placeholder={t("vault.phSelectToken")} />
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
                                <div className="flex-1">
                                  <Label className="text-xs font-medium">{t("vault.formCondition")}</Label>
                                  <Select value={priceCondition} onValueChange={setPriceCondition}>
                                    <SelectTrigger>
                                      <SelectValue placeholder={t("vault.phSelectCondition")} />
                                    </SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value="above">{t("vault.formPriceAbove")}</SelectItem>
                                      <SelectItem value="below">{t("vault.formPriceBelow")}</SelectItem>
                                    </SelectContent>
                                  </Select>
                                </div>
                              </div>
                              <div className="space-y-1">
                                <Label className="text-xs font-medium">Price Threshold (USD)</Label>
                                <div className="flex items-center space-x-2">
                                  <Input
                                    type="number"
                                    value={priceThreshold}
                                    onChange={(e) => setPriceThreshold(e.target.value)}
                                  />
                                  <span className="text-xs font-medium">USD</span>
                                </div>
                              </div>
                              <div className="p-2 rounded-md border border-amber-500/40 bg-amber-500/10">
                                <p className="text-xs text-amber-700 dark:text-amber-300">
                                  {t("vault.priceConditionWarning", { token: priceToken, condition: priceCondition, threshold: priceThreshold })}
                                </p>
                              </div>
                            </div>
                          )}
                        </div>
                      )}

                      <div className="flex items-center space-x-2 pt-2">
                        <Switch id="save-template" checked={saveAsTemplate} onCheckedChange={setSaveAsTemplate} />
                        <Label htmlFor="save-template" className="text-xs font-medium cursor-pointer">
                          Save as Template
                        </Label>
                      </div>

                      {saveAsTemplate && (
                        <div className="space-y-1">
                          <Label htmlFor="template-name" className="text-xs font-medium">
                            {t("vault.formTemplateName")}
                          </Label>
                          <Input
                            id="template-name"
                            placeholder={t("vault.phTemplateName")}
                            value={templateName}
                            onChange={(e) => setTemplateName(e.target.value)}
                          />
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </motion.div>
            )}

            {step === 2 && !batchMode && (
              <motion.div
                key="step2"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                transition={{ duration: 0.3 }}
                className="px-4 py-4"
              >
                <div className="space-y-3">
                  {transactionType === "transfer" && (
                    <>
                      <div className="space-y-1">
                        <Label htmlFor="recipient" className="text-xs font-medium">
                          Recipient Address
                        </Label>
                        <Input
                          id="recipient"
                          value={recipient}
                          onChange={(e) => setRecipient(e.target.value)}
                          placeholder="0x… / alice.sui / alice.id"
                        />
                      </div>

                      <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1">
                          <Label htmlFor="amount" className="text-xs font-medium">
                            Amount
                          </Label>
                          <Input
                            id="amount"
                            type="number"
                            value={amount}
                            onChange={(e) => setAmount(e.target.value)}
                            placeholder="0.00"
                          />
                        </div>
                        <div className="space-y-1">
                          <Label htmlFor="token" className="text-xs font-medium">
                            Token
                          </Label>
                          <Select value={selectedToken} onValueChange={setSelectedToken}>
                            <SelectTrigger id="token">
                              <SelectValue placeholder={t("vault.phSelect")} />
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
                    </>
                  )}

                  {transactionType === "contract" && (
                    <>
                      <div className="space-y-1">
                        <Label htmlFor="contract" className="text-xs font-medium">
                          Contract Address
                        </Label>
                        <Input id="contract" placeholder="0x..." />
                      </div>

                      <div className="space-y-1">
                        <Label htmlFor="function" className="text-xs font-medium">
                          Function Name
                        </Label>
                        <Input id="function" placeholder={t("vault.phTags")} />
                      </div>

                      <div className="space-y-1">
                        <Label htmlFor="args" className="text-xs font-medium">
                          Arguments (JSON)
                        </Label>
                        <Textarea
                          id="args"
                          placeholder='[{"name": "amount", "value": "100"}, {"name": "recipient", "value": "0x..."}]'
                          className="resize-none h-20 font-mono text-xs"
                        />
                      </div>
                    </>
                  )}

                  {transactionType === "custom" && (
                    <>
                      <div className="space-y-1">
                        <Label htmlFor="payload" className="text-xs font-medium">
                          Transaction Payload
                        </Label>
                        <Textarea
                          id="payload"
                          placeholder={t("vault.phPayload")}
                          className="resize-none h-32 font-mono text-xs"
                        />
                      </div>

                      <div className="p-3 rounded-lg bg-accent/30">
                        <p className="text-xs">
                          Custom transactions allow you to execute any valid transaction on the blockchain. Make sure
                          you understand what you&apos;re doing.
                        </p>
                      </div>
                    </>
                  )}

                  <div className="space-y-1">
                    <Label htmlFor="deadline" className="text-xs font-medium">
                      {t("vault.deadlineLabel")}
                    </Label>
                    <div className="relative">
                      {/* This input used to render with no value/onChange, so typing a
                          date silently did nothing while implying it set the expiry.
                          It now writes the same `executeDate` the submission uses. */}
                      <Input
                        id="deadline"
                        type="date"
                        className="pl-9"
                        value={executeDate ? format(executeDate, "yyyy-MM-dd") : ""}
                        onChange={(event) => setExecuteDate(event.target.value ? new Date(event.target.value) : undefined)}
                      />
                      <Calendar className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {t("vault.deadlineHint")}
                    </p>
                  </div>

                  {advancedMode && scheduleType !== "immediate" && (
                    <div className="p-3 rounded-lg bg-accent/30 mt-2">
                      <div className="flex items-center">
                        {scheduleType === "scheduled" ? (
                          <Clock className="h-4 w-4 mr-2 text-primary" />
                        ) : (
                          <Zap className="h-4 w-4 mr-2 text-primary" />
                        )}
                        <p className="text-xs font-medium">
                          {scheduleType === "scheduled"
                            ? t("vault.scheduledWarning", { date: executeDate ? format(executeDate, "PPP") : t("vault.noDatePicked") })
                            : conditionType === "price"
                              ? t("vault.priceConditionNoOracle", { token: priceToken, condition: priceCondition, threshold: priceThreshold })
                              : t("vault.conditionTriggerNoSupport")}
                        </p>
                      </div>
                    </div>
                  )}
                </div>
              </motion.div>
            )}

            {step === 2 && batchMode && (
              <motion.div
                key="step2-batch"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                transition={{ duration: 0.3 }}
                className="px-4 py-4"
              >
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs font-medium flex items-center">
                      <ListChecks className="h-4 w-4 mr-1.5" />
                      Batch Transactions
                    </Label>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={addBatchTransaction}
                      className="h-7 text-xs"
                    >
                      <Plus className="h-3 w-3 mr-1" /> Add Transaction
                    </Button>
                  </div>

                  <ScrollArea className="h-[300px] pr-4">
                    {batchTransactions.length === 0 ? (
                      <div className="flex flex-col items-center justify-center h-32 border border-dashed rounded-lg">
                        <ListChecks className="h-8 w-8 text-muted-foreground mb-2" />
                        <p className="text-sm text-muted-foreground">{t("vault.formNoTxAdded")}</p>
                        <Button type="button" variant="link" size="sm" onClick={addBatchTransaction} className="mt-2">
                          Add your first transaction
                        </Button>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {batchTransactions.map((transaction, index) => (
                          <div key={transaction.id} className="border rounded-lg overflow-hidden">
                            <div
                              className="flex items-center justify-between p-2 bg-muted/50 cursor-pointer"
                              onClick={() => toggleBatchExpand(index)}
                            >
                              <div className="flex items-center">
                                <Badge variant="outline" className="mr-2">
                                  #{index + 1}
                                </Badge>
                                <span className="text-sm font-medium">
                                  {transaction.type === "transfer"
                                    ? "Transfer"
                                    : transaction.type === "contract"
                                      ? "Contract Call"
                                      : "Custom Transaction"}
                                </span>
                                {transaction.amount && transaction.token && (
                                  <Badge variant="secondary" className="ml-2">
                                    {transaction.amount} {transaction.token}
                                  </Badge>
                                )}
                              </div>
                              <div className="flex items-center">
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon"
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    removeBatchTransaction(index)
                                  }}
                                  className="h-6 w-6 mr-1"
                                >
                                  <X className="h-3 w-3" />
                                </Button>
                                {expandedBatchIndex === index ? (
                                  <ChevronUp className="h-4 w-4" />
                                ) : (
                                  <ChevronDown className="h-4 w-4" />
                                )}
                              </div>
                            </div>
                            {expandedBatchIndex === index && (
                              <div className="p-3 space-y-3">
                                <div className="space-y-1">
                                  <Label className="text-xs font-medium">{t("vault.formTxType")}</Label>
                                  <Select
                                    value={transaction.type}
                                    onValueChange={(value) => updateBatchTransaction(index, { type: value })}
                                  >
                                    <SelectTrigger>
                                      <SelectValue placeholder={t("vault.phSelectType")} />
                                    </SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value="transfer">{t("vault.formTransfer")}</SelectItem>
                                      <SelectItem value="contract">{t("vault.formContractCall")}</SelectItem>
                                      <SelectItem value="custom">{t("vault.formCustomTx")}</SelectItem>
                                    </SelectContent>
                                  </Select>
                                </div>

                                {transaction.type === "transfer" && (
                                  <>
                                    <div className="space-y-1">
                                      <Label className="text-xs font-medium">{t("vault.formRecipient")}</Label>
                                      <Input
                                        placeholder="0x..."
                                        value={transaction.recipient || ""}
                                        onChange={(e) => updateBatchTransaction(index, { recipient: e.target.value })}
                                      />
                                    </div>
                                    <div className="grid grid-cols-2 gap-2">
                                      <div className="space-y-1">
                                        <Label className="text-xs font-medium">{t("vault.formAmount")}</Label>
                                        <Input
                                          type="number"
                                          placeholder="0.00"
                                          value={transaction.amount || ""}
                                          onChange={(e) => updateBatchTransaction(index, { amount: e.target.value })}
                                        />
                                      </div>
                                      <div className="space-y-1">
                                        <Label className="text-xs font-medium">{t("vault.formToken")}</Label>
                                        <Select
                                          value={transaction.token || "SUI"}
                                          onValueChange={(value) => updateBatchTransaction(index, { token: value })}
                                        >
                                          <SelectTrigger>
                                            <SelectValue placeholder={t("vault.phSelectToken")} />
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
                                  </>
                                )}

                                {transaction.type === "contract" && (
                                  <>
                                    <div className="space-y-1">
                                      <Label className="text-xs font-medium">{t("vault.formContractAddress")}</Label>
                                      <Input
                                        placeholder="0x..."
                                        value={transaction.contract || ""}
                                        onChange={(e) => updateBatchTransaction(index, { contract: e.target.value })}
                                      />
                                    </div>
                                    <div className="space-y-1">
                                      <Label className="text-xs font-medium">{t("vault.formFunction")}</Label>
                                      <Input
                                        placeholder={t("vault.phTags")}
                                        value={transaction.function || ""}
                                        onChange={(e) => updateBatchTransaction(index, { function: e.target.value })}
                                      />
                                    </div>
                                    <div className="space-y-1">
                                      <Label className="text-xs font-medium">Arguments (JSON)</Label>
                                      <Textarea
                                        placeholder='[{"name": "amount", "value": "100"}]'
                                        className="resize-none h-16 font-mono text-xs"
                                        value={transaction.args || ""}
                                        onChange={(e) => updateBatchTransaction(index, { args: e.target.value })}
                                      />
                                    </div>
                                  </>
                                )}

                                {transaction.type === "custom" && (
                                  <div className="space-y-1">
                                    <Label className="text-xs font-medium">{t("vault.formPayload")}</Label>
                                    <Textarea
                                      placeholder={t("vault.phPayload")}
                                      className="resize-none h-20 font-mono text-xs"
                                      value={transaction.payload || ""}
                                      onChange={(e) => updateBatchTransaction(index, { payload: e.target.value })}
                                    />
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </ScrollArea>

                  <div className="space-y-1 pt-2">
                    <Label htmlFor="batch-deadline" className="text-xs font-medium">
                      {t("vault.batchDeadlineLabel")}
                    </Label>
                    <div className="relative">
                      <Input
                        id="batch-deadline"
                        type="date"
                        className="pl-9"
                        value={executeDate ? format(executeDate, "yyyy-MM-dd") : ""}
                        onChange={(event) => setExecuteDate(event.target.value ? new Date(event.target.value) : undefined)}
                      />
                      <Calendar className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {t("vault.batchDeadlineHint")}
                    </p>
                  </div>

                  {advancedMode && scheduleType !== "immediate" && (
                    <div className="p-3 rounded-lg bg-accent/30 mt-2">
                      <div className="flex items-center">
                        {scheduleType === "scheduled" ? (
                          <Clock className="h-4 w-4 mr-2 text-primary" />
                        ) : (
                          <Zap className="h-4 w-4 mr-2 text-primary" />
                        )}
                        <p className="text-xs font-medium">
                          {scheduleType === "scheduled"
                            ? t("vault.batchScheduledWarning", { date: executeDate ? format(executeDate, "PPP") : t("vault.noDatePicked") })
                            : conditionType === "price"
                              ? t("vault.batchPriceConditionNoOracle", { token: priceToken, condition: priceCondition, threshold: priceThreshold })
                              : t("vault.batchConditionTriggerNoSupport")}
                        </p>
                      </div>
                    </div>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {errorMessage && (
          <div className="px-4 py-1.5 text-xs text-red-500 bg-red-500/10 border-t border-red-500/20">
            {errorMessage}
          </div>
        )}

        <DialogFooter className="p-4 pt-2">
          {step > 1 ? (
            <div className="flex w-full justify-between">
              <Button type="button" variant="outline" onClick={prevStep} size="sm">
                Back
              </Button>
              <Button
                type="button"
                disabled={isSubmitting || recovery.blocked || (!selectedTreasuryId && !legacySource) || !currentGroup.orgObjectId}
                onClick={recovery.pending ? handleResumeTransaction : handleSubmitTransaction}
                size="sm"
                className="bg-gradient-to-r from-primary to-purple-500 hover:from-primary/90 hover:to-purple-500/90"
              >
                {isSubmitting ? t("vault.signingSubmitting") : recovery.pending ? t("vault.recoverOriginalTx") : t("vault.createGroupProposal")}
              </Button>
            </div>
          ) : (
            <Button type="button" onClick={nextStep} disabled={!currentGroup.orgObjectId} className="w-full">
              Next
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
