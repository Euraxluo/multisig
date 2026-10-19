"use client"

import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Check,
  X,
  ExternalLink,
  Clock,
  ArrowRight,
  FileText,
  Code,
  Send,
  Calendar,
  Zap,
  ListChecks,
  ChevronDown,
  ChevronUp,
} from "lucide-react"
import { useState } from "react"
import { motion, AnimatePresence } from "framer-motion"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"

interface TransactionDetailsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  transactionId: string
  groupId: string
}

export function TransactionDetailsDialog({
  open,
  onOpenChange,
  transactionId,
  groupId,
}: TransactionDetailsDialogProps) {
  const [activeTab, setActiveTab] = useState("details")
  const [isApproving, setIsApproving] = useState(false)
  const [isRejecting, setIsRejecting] = useState(false)
  const [expandedBatchIndex, setExpandedBatchIndex] = useState<number | null>(null)

  // Mock data - in a real app, you would fetch this based on transactionId and groupId
  const transaction = {
    id: transactionId,
    title: "Token Transfer",
    description: "Transfer tokens to external wallet for project expenses",
    amount: 100,
    token: "SUI",
    recipient: "0x0000...0000",
    recipientName: "External Project",
    status: "pending",
    approvals: 3,
    requiredApprovals: 5,
    createdAt: "2025-03-15T12:00:00Z",
    expiresAt: "2025-04-15T12:00:00Z",
    type: "transfer",
    creator: "Alex",
    creatorAddress: "0x1a2b...3c4d",
    approvers: [
      { name: "Alex", address: "0x1a2b...3c4d", approved: true, weight: 2 },
      { name: "Sam", address: "0x5e6f...7g8h", approved: true, weight: 2 },
      { name: "Jamie", address: "jamie@gmail.com", approved: false, weight: 1 },
      { name: "Taylor", address: "0x2k3l...4m5n", approved: false, weight: 3 },
      { name: "You", address: "0x6o7p...8q9r", approved: false, weight: 2 },
    ],
    approvalWeight: 4,
    rejectionWeight: 0,
    network: "Sui",
    nonce: 12,
    data: "0x1a2b3c4d...",
    isBatch: false,
    isScheduled: false,
    isConditional: false,
    scheduledDate: null,
    conditionType: null,
    conditionDetails: null,
    batchTransactions: [
      {
        id: "batch-1",
        type: "transfer",
        recipient: "0xdef0...5678",
        recipientName: "Team Member 1",
        amount: 50,
        token: "SUI",
      },
      {
        id: "batch-2",
        type: "transfer",
        recipient: "0xghi1...9012",
        recipientName: "Team Member 2",
        amount: 50,
        token: "SUI",
      },
    ],
  }

  const group = {
    id: groupId,
    name: "Team Treasury",
    threshold: 5,
    totalWeight: 10,
    color: "from-primary to-purple-500",
  }

  const handleApprove = () => {
    setIsApproving(true)
    // Simulate approval process
    setTimeout(() => {
      setIsApproving(false)
      onOpenChange(false)
    }, 1500)
  }

  const handleReject = () => {
    setIsRejecting(true)
    // Simulate rejection process
    setTimeout(() => {
      setIsRejecting(false)
      onOpenChange(false)
    }, 1500)
  }

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleString()
  }

  const userApprover = transaction.approvers.find((a) => a.name === "You")
  const canApprove = userApprover && !userApprover.approved && transaction.status === "pending"

  const toggleBatchExpand = (index: number) => {
    setExpandedBatchIndex(expandedBatchIndex === index ? null : index)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px] p-0 gap-0 overflow-hidden">
        <div className={`h-24 bg-gradient-to-r ${group.color} p-4 flex flex-col justify-end`}>
          <DialogHeader className="text-white">
            <DialogTitle className="flex items-center justify-between">
              <span className="text-xl">{transaction.title}</span>
              <Badge
                variant={
                  transaction.status === "executed"
                    ? "outline"
                    : transaction.status === "rejected"
                      ? "destructive"
                      : "default"
                }
                className={
                  transaction.status === "executed"
                    ? "bg-white/20 text-white border-white/40"
                    : transaction.status === "rejected"
                      ? "bg-destructive/20 text-white border-destructive/40"
                      : "bg-white/20 text-white border-white/40"
                }
              >
                {transaction.status === "executed"
                  ? "Executed"
                  : transaction.status === "rejected"
                    ? "Rejected"
                    : "Pending"}
              </Badge>
            </DialogTitle>
            <p className="text-white/80 text-sm mt-1">{transaction.description}</p>
          </DialogHeader>
        </div>

        <div className="p-4 space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center">
              <Avatar className="h-10 w-10 mr-3 border-2 border-background">
                <AvatarFallback className="bg-gradient-to-br from-gray-500 to-gray-600 text-white">
                  {transaction.creator[0]}
                </AvatarFallback>
              </Avatar>
              <div>
                <p className="text-sm font-medium">{transaction.creator}</p>
                <p className="text-xs text-muted-foreground">Creator</p>
              </div>
            </div>
            <div className="text-right">
              <p className="font-medium">
                {transaction.isBatch ? "Batch Transaction" : `${transaction.amount} ${transaction.token}`}
              </p>
              <div className="flex items-center text-xs text-muted-foreground justify-end">
                <Clock className="h-3 w-3 mr-1" />
                {formatDate(transaction.createdAt)}
              </div>
            </div>
          </div>

          <div className="p-3 rounded-lg bg-muted/50">
            <div className="flex items-center justify-between">
              <div className="flex items-center">
                {transaction.isBatch ? (
                  <ListChecks className="h-4 w-4 mr-2 text-primary" />
                ) : transaction.type === "transfer" ? (
                  <Send className="h-4 w-4 mr-2 text-primary" />
                ) : (
                  <Code className="h-4 w-4 mr-2 text-primary" />
                )}
                <span className="text-sm font-medium">
                  {transaction.isBatch
                    ? "Batch Transaction"
                    : transaction.type === "transfer"
                      ? "Token Transfer"
                      : "Contract Interaction"}
                </span>
              </div>
              <Badge variant="outline" className="text-xs">
                Nonce: {transaction.nonce}
              </Badge>
            </div>

            {!transaction.isBatch && (
              <div className="mt-2 flex items-center">
                <div className="flex-1">
                  <p className="text-xs text-muted-foreground">From</p>
                  <p className="text-xs font-medium">{group.name}</p>
                </div>
                <ArrowRight className="h-4 w-4 mx-2 text-muted-foreground" />
                <div className="flex-1">
                  <p className="text-xs text-muted-foreground">To</p>
                  <p className="text-xs font-medium">{transaction.recipientName || transaction.recipient}</p>
                </div>
              </div>
            )}

            {(transaction.isScheduled || transaction.isConditional) && (
              <div className="mt-2 pt-2 border-t border-border/30">
                <div className="flex items-center">
                  {transaction.isScheduled ? (
                    <Calendar className="h-4 w-4 mr-2 text-primary" />
                  ) : (
                    <Zap className="h-4 w-4 mr-2 text-primary" />
                  )}
                  <div>
                    <p className="text-xs font-medium">
                      {transaction.isScheduled ? "Scheduled Transaction" : "Conditional Transaction"}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {transaction.isScheduled
                        ? `Will execute on ${formatDate(transaction.scheduledDate || "")}`
                        : transaction.conditionType === "price"
                          ? `Will execute when price condition is met`
                          : `Will execute when conditions are met`}
                    </p>
                  </div>
                </div>
              </div>
            )}
          </div>

          <Tabs defaultValue="details" value={activeTab} onValueChange={setActiveTab} className="w-full">
            <TabsList className="grid w-full grid-cols-2 p-1 bg-muted/50 rounded-xl">
              <TabsTrigger
                value="details"
                className="rounded-lg data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
              >
                <FileText className="h-4 w-4 mr-1.5" />
                Details
              </TabsTrigger>
              <TabsTrigger
                value="approvals"
                className="rounded-lg data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
              >
                <Check className="h-4 w-4 mr-1.5" />
                Approvals
              </TabsTrigger>
            </TabsList>

            <AnimatePresence mode="wait">
              {activeTab === "details" && (
                <TabsContent value="details" className="mt-3 space-y-2">
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    transition={{ duration: 0.2 }}
                  >
                    {!transaction.isBatch ? (
                      <div className="space-y-3">
                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <p className="text-xs text-muted-foreground">Amount</p>
                            <p className="text-sm font-medium">
                              {transaction.amount} {transaction.token}
                            </p>
                          </div>
                          <div>
                            <p className="text-xs text-muted-foreground">Network</p>
                            <p className="text-sm font-medium">{transaction.network}</p>
                          </div>
                        </div>

                        <div>
                          <p className="text-xs text-muted-foreground">Recipient</p>
                          <div className="flex items-center">
                            <p className="text-sm font-medium mr-1">{transaction.recipient}</p>
                            <Button variant="ghost" size="icon" className="h-6 w-6">
                              <ExternalLink className="h-3 w-3" />
                            </Button>
                          </div>
                        </div>

                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <p className="text-xs text-muted-foreground">Created</p>
                            <p className="text-sm font-medium">{formatDate(transaction.createdAt)}</p>
                          </div>
                          <div>
                            <p className="text-xs text-muted-foreground">Expires</p>
                            <p className="text-sm font-medium">{formatDate(transaction.expiresAt)}</p>
                          </div>
                        </div>

                        {transaction.type === "contract" && (
                          <div>
                            <p className="text-xs text-muted-foreground">Transaction Data</p>
                            <div className="mt-1 p-2 bg-muted rounded-md">
                              <p className="text-xs font-mono break-all">{transaction.data}</p>
                            </div>
                          </div>
                        )}

                        {transaction.isConditional && transaction.conditionType === "price" && (
                          <div className="p-3 rounded-lg bg-accent/30">
                            <p className="text-xs font-medium flex items-center">
                              <Zap className="h-4 w-4 mr-1.5 text-primary" />
                              Price Condition
                            </p>
                            <p className="text-xs mt-1">
                              This transaction will automatically execute when the price condition is met.
                            </p>
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="space-y-3">
                        <p className="text-xs font-medium flex items-center">
                          <ListChecks className="h-4 w-4 mr-1.5 text-primary" />
                          Batch Transaction ({transaction.batchTransactions.length} transactions)
                        </p>

                        <div className="space-y-2">
                          {transaction.batchTransactions.map((batchTx, index) => (
                            <Collapsible key={batchTx.id}>
                              <div className="border rounded-lg overflow-hidden">
                                <CollapsibleTrigger className="w-full">
                                  <div className="flex items-center justify-between p-2 bg-muted/50">
                                    <div className="flex items-center">
                                      <Badge variant="outline" className="mr-2">
                                        #{index + 1}
                                      </Badge>
                                      <span className="text-sm font-medium">
                                        {batchTx.type === "transfer"
                                          ? "Transfer"
                                          : batchTx.type === "contract"
                                            ? "Contract Call"
                                            : "Custom Transaction"}
                                      </span>
                                      {batchTx.amount && batchTx.token && (
                                        <Badge variant="secondary" className="ml-2">
                                          {batchTx.amount} {batchTx.token}
                                        </Badge>
                                      )}
                                    </div>
                                    <div>
                                      {expandedBatchIndex === index ? (
                                        <ChevronUp className="h-4 w-4" />
                                      ) : (
                                        <ChevronDown className="h-4 w-4" />
                                      )}
                                    </div>
                                  </div>
                                </CollapsibleTrigger>
                                <CollapsibleContent>
                                  <div className="p-3 space-y-2">
                                    {batchTx.type === "transfer" && (
                                      <>
                                        <div>
                                          <p className="text-xs text-muted-foreground">Recipient</p>
                                          <div className="flex items-center">
                                            <p className="text-sm font-medium mr-1">
                                              {batchTx.recipientName || batchTx.recipient}
                                            </p>
                                            <Button variant="ghost" size="icon" className="h-6 w-6">
                                              <ExternalLink className="h-3 w-3" />
                                            </Button>
                                          </div>
                                        </div>
                                        <div>
                                          <p className="text-xs text-muted-foreground">Amount</p>
                                          <p className="text-sm font-medium">
                                            {batchTx.amount} {batchTx.token}
                                          </p>
                                        </div>
                                      </>
                                    )}
                                  </div>
                                </CollapsibleContent>
                              </div>
                            </Collapsible>
                          ))}
                        </div>

                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <p className="text-xs text-muted-foreground">Created</p>
                            <p className="text-sm font-medium">{formatDate(transaction.createdAt)}</p>
                          </div>
                          <div>
                            <p className="text-xs text-muted-foreground">Expires</p>
                            <p className="text-sm font-medium">{formatDate(transaction.expiresAt)}</p>
                          </div>
                        </div>

                        {transaction.isScheduled && (
                          <div className="p-3 rounded-lg bg-accent/30">
                            <p className="text-xs font-medium flex items-center">
                              <Calendar className="h-4 w-4 mr-1.5 text-primary" />
                              Scheduled Batch
                            </p>
                            <p className="text-xs mt-1">
                              This batch will automatically execute on {formatDate(transaction.scheduledDate || "")}.
                            </p>
                          </div>
                        )}
                      </div>
                    )}
                  </motion.div>
                </TabsContent>
              )}

              {activeTab === "approvals" && (
                <TabsContent value="approvals" className="mt-3 space-y-2">
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    transition={{ duration: 0.2 }}
                  >
                    <div className="mb-3">
                      <div className="flex justify-between items-center mb-1">
                        <p className="text-xs text-muted-foreground">
                          Approval Progress: {transaction.approvalWeight}/{transaction.requiredApprovals}
                        </p>
                        <p className="text-xs font-medium">
                          {Math.round((transaction.approvalWeight / transaction.requiredApprovals) * 100)}%
                        </p>
                      </div>
                      <div className="w-full h-2 bg-muted rounded-full overflow-hidden">
                        <div
                          className="h-full bg-gradient-to-r from-primary to-purple-500"
                          style={{
                            width: `${Math.min(
                              100,
                              (transaction.approvalWeight / transaction.requiredApprovals) * 100,
                            )}%`,
                          }}
                        ></div>
                      </div>
                    </div>

                    <div className="space-y-2">
                      {transaction.approvers.map((approver, index) => (
                        <div
                          key={index}
                          className="flex items-center justify-between p-2 rounded-lg hover:bg-muted/50 transition-colors"
                        >
                          <div className="flex items-center">
                            <Avatar className="h-8 w-8 mr-3">
                              <AvatarFallback
                                className={`text-white ${
                                  approver.name === "You"
                                    ? "bg-gradient-to-br from-primary to-purple-500"
                                    : "bg-gradient-to-br from-gray-500 to-gray-600"
                                }`}
                              >
                                {approver.name[0]}
                              </AvatarFallback>
                            </Avatar>
                            <div>
                              <p className="font-medium text-sm">{approver.name}</p>
                              <p className="text-xs text-muted-foreground">
                                {approver.address.includes("@")
                                  ? approver.address
                                  : `${approver.address.slice(0, 6)}...${approver.address.slice(-4)}`}
                              </p>
                            </div>
                          </div>
                          <div className="flex items-center">
                            <Badge variant="outline" className="mr-2 text-xs">
                              Weight: {approver.weight}
                            </Badge>
                            {approver.approved ? (
                              <div className="h-6 w-6 rounded-full bg-green-100 flex items-center justify-center">
                                <Check className="h-3 w-3 text-green-600" />
                              </div>
                            ) : (
                              <div className="h-6 w-6 rounded-full bg-muted flex items-center justify-center">
                                <Clock className="h-3 w-3 text-muted-foreground" />
                              </div>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </motion.div>
                </TabsContent>
              )}
            </AnimatePresence>
          </Tabs>

          <DialogFooter className="pt-2">
            {canApprove ? (
              <div className="flex w-full justify-between">
                <Button
                  variant="outline"
                  onClick={handleReject}
                  disabled={isApproving || isRejecting}
                  className="flex-1 mr-2"
                >
                  {isRejecting ? (
                    <>
                      <span className="animate-spin mr-1">⏳</span> Rejecting...
                    </>
                  ) : (
                    <>
                      <X className="h-4 w-4 mr-1" /> Reject
                    </>
                  )}
                </Button>
                <Button
                  onClick={handleApprove}
                  disabled={isApproving || isRejecting}
                  className="flex-1 bg-gradient-to-r from-primary to-purple-500 hover:from-primary/90 hover:to-purple-500/90"
                >
                  {isApproving ? (
                    <>
                      <span className="animate-spin mr-1">⏳</span> Approving...
                    </>
                  ) : (
                    <>
                      <Check className="h-4 w-4 mr-1" /> Approve
                    </>
                  )}
                </Button>
              </div>
            ) : (
              <Button variant="outline" onClick={() => onOpenChange(false)} className="w-full">
                Close
              </Button>
            )}
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  )
}
