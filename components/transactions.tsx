"use client"

import { useState } from "react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { motion, AnimatePresence } from "framer-motion"
import { Clock, Check, X, ArrowRight, Code, Send, Calendar, Zap, ListChecks } from "lucide-react"
import { TransactionDetailsDialog } from "@/components/transaction-details-dialog"

export default function Transactions() {
  const [selectedTx, setSelectedTx] = useState<{ id: string; groupId: string } | null>(null)
  const [activeTab, setActiveTab] = useState("pending")

  const pendingTransactions = [
    {
      id: "tx1",
      title: "Token Transfer",
      description: "Transfer tokens to external wallet",
      amount: 100,
      token: "APT",
      groupId: "group-1",
      groupName: "Team Treasury",
      status: "pending",
      approvals: 3,
      requiredApprovals: 5,
      createdAt: "2025-03-15T12:00:00Z",
      expiresAt: "2025-04-15T12:00:00Z",
      type: "transfer",
      color: "from-primary to-purple-500",
      isScheduled: false,
      isConditional: false,
      isBatch: false,
    },
    {
      id: "tx2",
      title: "Stake Tokens",
      description: "Stake tokens in DeFi protocol",
      amount: 500,
      token: "USDC",
      groupId: "group-2",
      groupName: "DAO Fund",
      status: "pending",
      approvals: 4,
      requiredApprovals: 7,
      createdAt: "2025-03-14T12:00:00Z",
      expiresAt: "2025-04-14T12:00:00Z",
      type: "contract",
      color: "from-blue-500 to-cyan-400",
      isScheduled: true,
      scheduledDate: "2025-03-20T12:00:00Z",
      isConditional: false,
      isBatch: false,
    },
    {
      id: "tx3",
      title: "Batch Payment",
      description: "Monthly team payments",
      groupId: "group-1",
      groupName: "Team Treasury",
      status: "pending",
      approvals: 2,
      requiredApprovals: 5,
      createdAt: "2025-03-13T12:00:00Z",
      expiresAt: "2025-04-13T12:00:00Z",
      type: "batch",
      color: "from-primary to-purple-500",
      isScheduled: false,
      isConditional: false,
      isBatch: true,
      batchCount: 3,
    },
    {
      id: "tx4",
      title: "Conditional Swap",
      description: "Swap tokens when price reaches target",
      amount: 200,
      token: "APT",
      groupId: "group-2",
      groupName: "DAO Fund",
      status: "pending",
      approvals: 5,
      requiredApprovals: 7,
      createdAt: "2025-03-12T12:00:00Z",
      expiresAt: "2025-04-12T12:00:00Z",
      type: "contract",
      color: "from-blue-500 to-cyan-400",
      isScheduled: false,
      isConditional: true,
      conditionType: "price",
      conditionDetails: "APT above $15",
      isBatch: false,
    },
  ]

  const completedTransactions = [
    {
      id: "tx5",
      title: "Contract Interaction",
      description: "Stake tokens in DeFi protocol",
      amount: 500,
      token: "APT",
      groupId: "group-1",
      groupName: "Team Treasury",
      status: "executed",
      approvals: 6,
      requiredApprovals: 5,
      createdAt: "2025-03-10T12:00:00Z",
      executedAt: "2025-03-12T15:30:00Z",
      type: "contract",
      color: "from-primary to-purple-500",
      isScheduled: false,
      isConditional: false,
      isBatch: false,
    },
    {
      id: "tx6",
      title: "Token Swap",
      description: "Swap APT for USDC",
      amount: 200,
      token: "APT",
      groupId: "group-1",
      groupName: "Team Treasury",
      status: "rejected",
      approvals: 2,
      requiredApprovals: 5,
      createdAt: "2025-03-05T12:00:00Z",
      rejectedAt: "2025-03-07T09:15:00Z",
      type: "contract",
      color: "from-primary to-purple-500",
      isScheduled: false,
      isConditional: false,
      isBatch: false,
    },
    {
      id: "tx7",
      title: "Fund Project",
      description: "Send funds to project wallet",
      amount: 1000,
      token: "USDC",
      groupId: "group-2",
      groupName: "DAO Fund",
      status: "executed",
      approvals: 5,
      requiredApprovals: 4,
      createdAt: "2025-03-01T12:00:00Z",
      executedAt: "2025-03-03T10:15:00Z",
      type: "transfer",
      color: "from-blue-500 to-cyan-400",
      isScheduled: false,
      isConditional: false,
      isBatch: false,
    },
    {
      id: "tx8",
      title: "Batch Distribution",
      description: "Distribute tokens to team members",
      groupId: "group-1",
      groupName: "Team Treasury",
      status: "executed",
      approvals: 6,
      requiredApprovals: 5,
      createdAt: "2025-02-28T12:00:00Z",
      executedAt: "2025-03-01T14:20:00Z",
      type: "batch",
      color: "from-primary to-purple-500",
      isScheduled: false,
      isConditional: false,
      isBatch: true,
      batchCount: 5,
    },
  ]

  const container = {
    hidden: { opacity: 0 },
    show: {
      opacity: 1,
      transition: {
        staggerChildren: 0.1,
      },
    },
  }

  const item = {
    hidden: { opacity: 0, y: 20 },
    show: { opacity: 1, y: 0 },
  }

  const getTransactionIcon = (tx: any) => {
    if (tx.isBatch) return <ListChecks className="h-3 w-3 mr-1" />
    if (tx.type === "transfer") return <Send className="h-3 w-3 mr-1" />
    if (tx.type === "contract") return <Code className="h-3 w-3 mr-1" />
    return <Send className="h-3 w-3 mr-1" />
  }

  const getTransactionTypeText = (tx: any) => {
    if (tx.isBatch) return "Batch Transaction"
    if (tx.type === "transfer") return "Transfer"
    if (tx.type === "contract") return "Contract Call"
    return "Transaction"
  }

  const getSpecialBadge = (tx: any) => {
    if (tx.isScheduled) {
      return (
        <Badge variant="outline" className="text-xs flex items-center">
          <Calendar className="h-3 w-3 mr-1" /> Scheduled
        </Badge>
      )
    }
    if (tx.isConditional) {
      return (
        <Badge variant="outline" className="text-xs flex items-center">
          <Zap className="h-3 w-3 mr-1" /> Conditional
        </Badge>
      )
    }
    if (tx.isBatch) {
      return (
        <Badge variant="outline" className="text-xs flex items-center">
          <ListChecks className="h-3 w-3 mr-1" /> {tx.batchCount} Txs
        </Badge>
      )
    }
    return null
  }

  return (
    <div className="space-y-4">
      <Tabs defaultValue="pending" value={activeTab} onValueChange={setActiveTab} className="w-full">
        <TabsList className="grid w-full grid-cols-2 p-1 bg-muted/50 rounded-xl">
          <TabsTrigger
            value="pending"
            className="rounded-lg data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
          >
            <Clock className="h-4 w-4 mr-1.5" />
            Pending
          </TabsTrigger>
          <TabsTrigger
            value="completed"
            className="rounded-lg data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
          >
            <Check className="h-4 w-4 mr-1.5" />
            Completed
          </TabsTrigger>
        </TabsList>

        <AnimatePresence mode="wait">
          {activeTab === "pending" && (
            <TabsContent value="pending" className="mt-3 space-y-3">
              <motion.div variants={container} initial="hidden" animate="show" exit={{ opacity: 0 }}>
                {pendingTransactions.length > 0 ? (
                  pendingTransactions.map((tx) => (
                    <motion.div key={tx.id} variants={item}>
                      <Card
                        className="overflow-hidden hover:shadow-md transition-all duration-300 border-none shadow-sm"
                        onClick={() => setSelectedTx({ id: tx.id, groupId: tx.groupId })}
                      >
                        <div className={`h-1 bg-gradient-to-r ${tx.color}`}></div>
                        <CardHeader className="p-3 pb-0">
                          <div className="flex items-start justify-between">
                            <div>
                              <h3 className="font-medium text-sm">{tx.title}</h3>
                              <p className="text-xs text-muted-foreground">{tx.groupName}</p>
                            </div>
                            <div className="flex space-x-2">
                              {getSpecialBadge(tx)}
                              <Badge variant="default" className="text-xs">
                                Pending
                              </Badge>
                            </div>
                          </div>
                        </CardHeader>
                        <CardContent className="p-3 pt-2">
                          <div className="flex items-center justify-between mb-1.5">
                            <div className="flex items-center text-xs text-muted-foreground">
                              {getTransactionIcon(tx)}
                              {getTransactionTypeText(tx)}
                            </div>
                            {!tx.isBatch && (
                              <div className="font-medium text-sm">
                                {tx.amount} {tx.token}
                              </div>
                            )}
                          </div>

                          <div className="flex items-center justify-between mt-2">
                            <div className="text-xs text-muted-foreground">
                              Approvals: {tx.approvals}/{tx.requiredApprovals}
                            </div>
                            <div className="flex space-x-2">
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 text-xs border-red-200 text-red-500 hover:bg-red-50"
                              >
                                <X className="h-3 w-3 mr-1" /> Reject
                              </Button>
                              <Button
                                size="sm"
                                className="h-7 text-xs bg-gradient-to-r from-primary to-purple-500 hover:from-primary/90 hover:to-purple-500/90"
                              >
                                <Check className="h-3 w-3 mr-1" /> Approve
                              </Button>
                            </div>
                          </div>
                        </CardContent>
                      </Card>
                    </motion.div>
                  ))
                ) : (
                  <div className="text-center py-8">
                    <p className="text-muted-foreground">No pending transactions</p>
                  </div>
                )}
              </motion.div>
            </TabsContent>
          )}

          {activeTab === "completed" && (
            <TabsContent value="completed" className="mt-3 space-y-3">
              <motion.div variants={container} initial="hidden" animate="show" exit={{ opacity: 0 }}>
                {completedTransactions.map((tx) => (
                  <motion.div key={tx.id} variants={item}>
                    <Card
                      className="overflow-hidden hover:shadow-md transition-all duration-300 border-none shadow-sm"
                      onClick={() => setSelectedTx({ id: tx.id, groupId: tx.groupId })}
                    >
                      <div className={`h-1 bg-gradient-to-r ${tx.color}`}></div>
                      <CardHeader className="p-3 pb-0">
                        <div className="flex items-start justify-between">
                          <div>
                            <h3 className="font-medium text-sm">{tx.title}</h3>
                            <p className="text-xs text-muted-foreground">{tx.groupName}</p>
                          </div>
                          <div className="flex space-x-2">
                            {getSpecialBadge(tx)}
                            <Badge variant={tx.status === "executed" ? "outline" : "destructive"} className="text-xs">
                              {tx.status === "executed" ? "Executed" : "Rejected"}
                            </Badge>
                          </div>
                        </div>
                      </CardHeader>
                      <CardContent className="p-3 pt-2">
                        <div className="flex items-center justify-between mb-1.5">
                          <div className="flex items-center text-xs text-muted-foreground">
                            {getTransactionIcon(tx)}
                            {getTransactionTypeText(tx)}
                          </div>
                          {!tx.isBatch && (
                            <div className="font-medium text-sm">
                              {tx.amount} {tx.token}
                            </div>
                          )}
                        </div>

                        <div className="flex items-center justify-between mt-2">
                          <div className="text-xs text-muted-foreground">
                            {tx.status === "executed"
                              ? `Executed: ${new Date(tx.executedAt).toLocaleDateString()}`
                              : `Rejected: ${new Date(tx.rejectedAt).toLocaleDateString()}`}
                          </div>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 text-xs text-primary flex items-center gap-1"
                          >
                            Details <ArrowRight className="h-3 w-3" />
                          </Button>
                        </div>
                      </CardContent>
                    </Card>
                  </motion.div>
                ))}
              </motion.div>
            </TabsContent>
          )}
        </AnimatePresence>
      </Tabs>

      {selectedTx && (
        <TransactionDetailsDialog
          open={!!selectedTx}
          onOpenChange={() => setSelectedTx(null)}
          transactionId={selectedTx.id}
          groupId={selectedTx.groupId}
        />
      )}
    </div>
  )
}
