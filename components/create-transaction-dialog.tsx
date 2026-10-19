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
import { motion, AnimatePresence } from "framer-motion"
import { Calendar, FileText, Code, Send, Clock, Zap, ListChecks, Plus, X, ChevronDown, ChevronUp } from "lucide-react"
import { Switch } from "@/components/ui/switch"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import { format } from "date-fns"
import { Calendar as CalendarComponent } from "@/components/ui/calendar"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { createTransferProposalOnChain } from "@/lib/onchain-store"

interface CreateTransactionDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  groupId?: string
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

export function CreateTransactionDialog({ open, onOpenChange, groupId }: CreateTransactionDialogProps) {
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

  // Real or fallback group
  const [currentGroup, setCurrentGroup] = useState({
    id: groupId || "group-1",
    name: "Team Treasury (Sui MultiSig)",
    balance: 1250,
    token: "SUI",
    orgObjectId: "0xaf0806fadf61ceeb76c21b40af4393e244a5d8ca91ba208d4f58537421eff2e4",
  })

  useEffect(() => {
    try {
      const groups = JSON.parse(localStorage.getItem("user_groups") || "[]")
      if (groups.length > 0) {
        const found = groupId ? groups.find((g: any) => g.id === groupId) : groups[0]
        if (found) {
          setCurrentGroup({
            id: found.id,
            name: found.name,
            balance: 1250,
            token: "SUI",
            orgObjectId: found.orgObjectId || "0xaf0806fadf61ceeb76c21b40af4393e244a5d8ca91ba208d4f58537421eff2e4",
          })
        }
      }
    } catch {}
  }, [groupId])

  // Mock templates
  const templates: TransactionTemplate[] = [
    {
      id: "template-1",
      name: "Monthly Salary Payment",
      type: "transfer",
      recipient: "0x0000...0000",
      amount: "500",
      token: "USDC",
    },
    {
      id: "template-2",
      name: "Staking Rewards",
      type: "contract",
      contract: "0x0000...0000",
      function: "claimRewards",
      args: '{"amount": "100"}',
    },
    {
      id: "template-3",
      name: "Token Swap",
      type: "contract",
      contract: "0x0000...0000",
      function: "swap",
      args: '{"tokenIn": "SUI", "tokenOut": "USDC", "amountIn": "10"}',
    },
  ]

  // Reset state when dialog opens/closes
  useEffect(() => {
    if (!open) {
      setTimeout(() => {
        setStep(1)
        setTransactionType("transfer")
        setAdvancedMode(false)
        setScheduleType("immediate")
        setExecuteDate(undefined)
        setConditionType("none")
        setPriceCondition("above")
        setPriceThreshold("100")
        setPriceToken("SUI")
        setSaveAsTemplate(false)
        setTemplateName("")
        setSelectedTemplate(null)
        setBatchMode(false)
        setBatchTransactions([])
        setExpandedBatchIndex(null)
      }, 300)
    }
  }, [open])

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
      setErrorMessage("请输入提案标题 (Title is required)")
      return
    }

    const numAmount = parseFloat(amount) || 0
    if (transactionType === "transfer") {
      if (!recipient.trim() || !recipient.startsWith("0x")) {
        setErrorMessage("请输入合法的 Sui 接收者地址 (需以 0x 开头)")
        return
      }
      if (numAmount <= 0) {
        setErrorMessage("转账金额必须大于 0")
        return
      }
    }

    setIsSubmitting(true)
    try {
      await createTransferProposalOnChain({
        title: title.trim(),
        recipient: recipient.trim() || "0xaf0806fadf61ceeb76c21b40af4393e244a5d8ca91ba208d4f58537421eff2e4",
        amount: numAmount > 0 ? numAmount : 1,
        token: selectedToken,
        description: description.trim() || `${transactionType} proposal`,
        groupId: currentGroup.id,
        groupName: currentGroup.name,
        orgId: currentGroup.orgObjectId,
        deadlineMs: executeDate ? executeDate.getTime() : undefined,
      })
      onOpenChange(false)
    } catch (e: any) {
      console.error("[CreateTx] failed:", e)
      setErrorMessage(e.message || "创建提案失败")
    } finally {
      setIsSubmitting(false)
    }
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
          <DialogTitle>Create Transaction</DialogTitle>
          <DialogDescription>Create a new transaction for approval by group members.</DialogDescription>
        </DialogHeader>

        <div className="relative overflow-hidden">
          <div className="flex justify-between px-4 pt-4">
            {[1, 2].map((i) => (
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
                <div className="text-xs mt-1 text-muted-foreground">{i === 1 ? "Transaction Type" : "Details"}</div>
              </div>
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
                    <Label className="text-xs font-medium">Transaction Type</Label>
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
                            <SelectValue placeholder="Select" />
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
                        placeholder="Payment for services, Token transfer, etc."
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
                      placeholder="Add details about this transaction"
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
                        <Label className="text-xs font-medium">Execution Schedule</Label>
                        <Select value={scheduleType} onValueChange={setScheduleType}>
                          <SelectTrigger className="w-full">
                            <SelectValue placeholder="Select schedule type" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="immediate">Immediate (After Approval)</SelectItem>
                            <SelectItem value="scheduled">Scheduled Date</SelectItem>
                            <SelectItem value="conditional">Conditional Execution</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>

                      {scheduleType === "scheduled" && (
                        <div className="space-y-1">
                          <Label className="text-xs font-medium">Execute On</Label>
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
                            <Label className="text-xs font-medium">Condition Type</Label>
                            <Select value={conditionType} onValueChange={setConditionType}>
                              <SelectTrigger className="w-full">
                                <SelectValue placeholder="Select condition type" />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="price">Price Condition</SelectItem>
                                <SelectItem value="balance">Balance Condition</SelectItem>
                                <SelectItem value="time">Time-Based Condition</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>

                          {conditionType === "price" && (
                            <div className="space-y-3">
                              <div className="flex items-center space-x-2">
                                <div className="flex-1">
                                  <Label className="text-xs font-medium">Token</Label>
                                  <Select value={priceToken} onValueChange={setPriceToken}>
                                    <SelectTrigger>
                                      <SelectValue placeholder="Select token" />
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
                                  <Label className="text-xs font-medium">Condition</Label>
                                  <Select value={priceCondition} onValueChange={setPriceCondition}>
                                    <SelectTrigger>
                                      <SelectValue placeholder="Select condition" />
                                    </SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value="above">Price Above</SelectItem>
                                      <SelectItem value="below">Price Below</SelectItem>
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
                              <div className="p-2 bg-accent/30 rounded-md">
                                <p className="text-xs">
                                  Transaction will execute when {priceToken} price is {priceCondition} ${priceThreshold}{" "}
                                  USD
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
                            Template Name
                          </Label>
                          <Input
                            id="template-name"
                            placeholder="Monthly Payment, Staking, etc."
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
                          placeholder="0x..."
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
                        <Input id="function" placeholder="transfer, mint, etc." />
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
                          placeholder="Paste your custom transaction payload here..."
                          className="resize-none h-32 font-mono text-xs"
                        />
                      </div>

                      <div className="p-3 rounded-lg bg-accent/30">
                        <p className="text-xs">
                          Custom transactions allow you to execute any valid transaction on the blockchain. Make sure
                          you understand what you're doing.
                        </p>
                      </div>
                    </>
                  )}

                  <div className="space-y-1">
                    <Label htmlFor="deadline" className="text-xs font-medium">
                      Expiration (Optional)
                    </Label>
                    <div className="relative">
                      <Input id="deadline" type="date" className="pl-9" />
                      <Calendar className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      If not approved by this date, the transaction will expire
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
                            ? `Scheduled to execute on ${executeDate ? format(executeDate, "PPP") : "selected date"}`
                            : conditionType === "price"
                              ? `Will execute when ${priceToken} price is ${priceCondition} $${priceThreshold}`
                              : "Will execute when conditions are met"}
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
                        <p className="text-sm text-muted-foreground">No transactions added yet</p>
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
                                  <Label className="text-xs font-medium">Transaction Type</Label>
                                  <Select
                                    value={transaction.type}
                                    onValueChange={(value) => updateBatchTransaction(index, { type: value })}
                                  >
                                    <SelectTrigger>
                                      <SelectValue placeholder="Select type" />
                                    </SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value="transfer">Transfer</SelectItem>
                                      <SelectItem value="contract">Contract Call</SelectItem>
                                      <SelectItem value="custom">Custom Transaction</SelectItem>
                                    </SelectContent>
                                  </Select>
                                </div>

                                {transaction.type === "transfer" && (
                                  <>
                                    <div className="space-y-1">
                                      <Label className="text-xs font-medium">Recipient</Label>
                                      <Input
                                        placeholder="0x..."
                                        value={transaction.recipient || ""}
                                        onChange={(e) => updateBatchTransaction(index, { recipient: e.target.value })}
                                      />
                                    </div>
                                    <div className="grid grid-cols-2 gap-2">
                                      <div className="space-y-1">
                                        <Label className="text-xs font-medium">Amount</Label>
                                        <Input
                                          type="number"
                                          placeholder="0.00"
                                          value={transaction.amount || ""}
                                          onChange={(e) => updateBatchTransaction(index, { amount: e.target.value })}
                                        />
                                      </div>
                                      <div className="space-y-1">
                                        <Label className="text-xs font-medium">Token</Label>
                                        <Select
                                          value={transaction.token || "SUI"}
                                          onValueChange={(value) => updateBatchTransaction(index, { token: value })}
                                        >
                                          <SelectTrigger>
                                            <SelectValue placeholder="Select token" />
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
                                      <Label className="text-xs font-medium">Contract Address</Label>
                                      <Input
                                        placeholder="0x..."
                                        value={transaction.contract || ""}
                                        onChange={(e) => updateBatchTransaction(index, { contract: e.target.value })}
                                      />
                                    </div>
                                    <div className="space-y-1">
                                      <Label className="text-xs font-medium">Function</Label>
                                      <Input
                                        placeholder="transfer, mint, etc."
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
                                    <Label className="text-xs font-medium">Transaction Payload</Label>
                                    <Textarea
                                      placeholder="Paste your custom transaction payload here..."
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
                    <Label htmlFor="deadline" className="text-xs font-medium">
                      Batch Expiration (Optional)
                    </Label>
                    <div className="relative">
                      <Input id="deadline" type="date" className="pl-9" />
                      <Calendar className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      If not approved by this date, all transactions in the batch will expire
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
                            ? `Batch scheduled to execute on ${executeDate ? format(executeDate, "PPP") : "selected date"}`
                            : conditionType === "price"
                              ? `Batch will execute when ${priceToken} price is ${priceCondition} $${priceThreshold}`
                              : "Batch will execute when conditions are met"}
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
                disabled={isSubmitting}
                onClick={handleSubmitTransaction}
                size="sm"
                className="bg-gradient-to-r from-primary to-purple-500 hover:from-primary/90 hover:to-purple-500/90"
              >
                {isSubmitting ? "Submitting (PTB)..." : batchMode ? "Create Batch" : "Create Transaction"}
              </Button>
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
