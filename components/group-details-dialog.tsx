"use client"

import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { QrCode, Users, Share2, Copy, ExternalLink, Plus } from "lucide-react"
import { useState } from "react"
import { motion, AnimatePresence } from "framer-motion"
import { CreateTransactionDialog } from "@/components/create-transaction-dialog"
import { TransactionDetailsDialog } from "@/components/transaction-details-dialog"

interface GroupDetailsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  groupId: string
}

export function GroupDetailsDialog({ open, onOpenChange, groupId }: GroupDetailsDialogProps) {
  const [activeTab, setActiveTab] = useState("members")
  const [isCreateTxOpen, setIsCreateTxOpen] = useState(false)
  const [selectedTx, setSelectedTx] = useState<string | null>(null)

  // Mock data - in a real app, you would fetch this based on groupId
  const group = {
    id: groupId,
    name: "Team Treasury",
    description: "Treasury for our team's expenses and investments",
    address: "0x1a2b3c4d5e6f7g8h9i0j",
    network: "Aptos",
    balance: 1250,
    token: "APT",
    creator: "0x1a2b...3c4d",
    creatorName: "Alex",
    members: [
      { address: "0x5e6f...7g8h", name: "Sam", weight: 2 },
      { address: "jamie@gmail.com", name: "Jamie", weight: 1 },
      { address: "0x2k3l...4m5n", name: "Taylor", weight: 3 },
      { address: "0x6o7p...8q9r", name: "You", weight: 2 },
    ],
    threshold: 5,
    totalWeight: 8,
    transactions: [
      {
        id: "tx1",
        title: "Token Transfer",
        description: "Transfer tokens to external wallet",
        amount: 100,
        token: "APT",
        recipient: "0xabcd...1234",
        status: "pending",
        approvals: 3,
        requiredApprovals: 5,
        createdAt: "2025-03-15T12:00:00Z",
        expiresAt: "2025-04-15T12:00:00Z",
        type: "transfer",
      },
      {
        id: "tx2",
        title: "Contract Interaction",
        description: "Stake tokens in DeFi protocol",
        amount: 500,
        token: "APT",
        recipient: "0xdefi...5678",
        status: "executed",
        approvals: 6,
        requiredApprovals: 5,
        createdAt: "2025-03-10T12:00:00Z",
        executedAt: "2025-03-12T15:30:00Z",
        type: "contract",
      },
      {
        id: "tx3",
        title: "Token Swap",
        description: "Swap APT for USDC",
        amount: 200,
        token: "APT",
        recipient: "0xswap...9012",
        status: "rejected",
        approvals: 2,
        requiredApprovals: 5,
        createdAt: "2025-03-05T12:00:00Z",
        rejectedAt: "2025-03-07T09:15:00Z",
        type: "contract",
      },
    ],
    color: "from-primary to-purple-500",
  }

  const shortAddress = `${group.address.slice(0, 6)}...${group.address.slice(-4)}`

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px] p-0 gap-0 overflow-hidden">
        <div className={`h-24 bg-gradient-to-r ${group.color} p-4 flex flex-col justify-end`}>
          <DialogHeader className="text-white">
            <DialogTitle className="flex items-center justify-between">
              <span className="text-xl">{group.name}</span>
              <Badge variant="outline" className="bg-white/20 text-white border-white/40">
                {group.network}
              </Badge>
            </DialogTitle>
            <p className="text-white/80 text-sm mt-1">{group.description}</p>
          </DialogHeader>
        </div>

        <div className="p-4 space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center">
              <Avatar className="h-10 w-10 mr-3 border-2 border-background">
                <AvatarFallback className="bg-gradient-to-br from-primary to-purple-500 text-white">
                  {group.name[0]}
                </AvatarFallback>
              </Avatar>
              <div>
                <div className="flex items-center">
                  <p className="text-sm font-medium mr-1">{shortAddress}</p>
                  <Button variant="ghost" size="icon" className="h-6 w-6">
                    <Copy className="h-3 w-3" />
                  </Button>
                  <Button variant="ghost" size="icon" className="h-6 w-6">
                    <ExternalLink className="h-3 w-3" />
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">Multi-Signature Wallet</p>
              </div>
            </div>
            <div className="text-right">
              <p className="font-medium">
                {group.balance} {group.token}
              </p>
              <div className="flex items-center text-xs text-muted-foreground justify-end">
                <span>
                  Threshold: {group.threshold}/{group.totalWeight}
                </span>
              </div>
            </div>
          </div>

          <Tabs defaultValue="members" value={activeTab} onValueChange={setActiveTab} className="w-full">
            <TabsList className="grid w-full grid-cols-3 p-1 bg-muted/50 rounded-xl">
              <TabsTrigger
                value="members"
                className="rounded-lg data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
              >
                <Users className="h-4 w-4 mr-1.5" />
                Members
              </TabsTrigger>
              <TabsTrigger
                value="transactions"
                className="rounded-lg data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
              >
                <Share2 className="h-4 w-4 mr-1.5" />
                Transactions
              </TabsTrigger>
              <TabsTrigger
                value="receive"
                className="rounded-lg data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
              >
                <QrCode className="h-4 w-4 mr-1.5" />
                Receive
              </TabsTrigger>
            </TabsList>

            <AnimatePresence mode="wait">
              {activeTab === "members" && (
                <TabsContent value="members" className="mt-3 space-y-2">
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    transition={{ duration: 0.2 }}
                  >
                    {group.members.map((member, index) => (
                      <div
                        key={index}
                        className="flex items-center justify-between p-2 rounded-lg hover:bg-muted/50 transition-colors"
                      >
                        <div className="flex items-center">
                          <Avatar className="h-8 w-8 mr-3">
                            <AvatarFallback
                              className={`text-white ${
                                member.name === "You"
                                  ? "bg-gradient-to-br from-primary to-purple-500"
                                  : "bg-gradient-to-br from-gray-500 to-gray-600"
                              }`}
                            >
                              {member.name[0]}
                            </AvatarFallback>
                          </Avatar>
                          <div>
                            <p className="font-medium text-sm">{member.name}</p>
                            {member.address.includes("@") ? (
                              <p className="text-xs text-muted-foreground flex items-center">
                                <span className="text-xs bg-blue-100 text-blue-600 px-1 rounded mr-1">@</span>
                                {member.address}
                              </p>
                            ) : (
                              <p className="text-xs text-muted-foreground flex items-center">
                                <span className="text-xs bg-purple-100 text-purple-600 px-1 rounded mr-1">Ξ</span>
                                {member.address.slice(0, 6)}...{member.address.slice(-4)}
                              </p>
                            )}
                          </div>
                        </div>
                        <div className="text-right">
                          <Badge variant="outline" className="text-xs">
                            Weight: {member.weight}
                          </Badge>
                        </div>
                      </div>
                    ))}

                    <div className="mt-4 p-3 rounded-lg bg-accent/30">
                      <p className="text-xs">
                        This group requires at least {group.threshold} weight units (
                        {Math.round((group.threshold / group.totalWeight) * 100)}% of total) to approve transactions.
                      </p>
                    </div>
                  </motion.div>
                </TabsContent>
              )}

              {activeTab === "transactions" && (
                <TabsContent value="transactions" className="mt-3 space-y-3">
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    transition={{ duration: 0.2 }}
                  >
                    <div className="flex justify-end mb-2">
                      <Button
                        size="sm"
                        onClick={() => setIsCreateTxOpen(true)}
                        className="bg-gradient-to-r from-primary to-purple-500 hover:from-primary/90 hover:to-purple-500/90"
                      >
                        <Plus className="h-4 w-4 mr-1" /> New Transaction
                      </Button>
                    </div>

                    {group.transactions.map((tx) => (
                      <div
                        key={tx.id}
                        className="p-3 rounded-lg border hover:bg-muted/50 transition-colors cursor-pointer"
                        onClick={() => setSelectedTx(tx.id)}
                      >
                        <div className="flex justify-between items-start">
                          <div>
                            <h3 className="font-medium text-sm">{tx.title}</h3>
                            <p className="text-xs text-muted-foreground">{tx.description}</p>
                          </div>
                          <Badge
                            variant={
                              tx.status === "executed"
                                ? "outline"
                                : tx.status === "rejected"
                                  ? "destructive"
                                  : "default"
                            }
                            className="text-xs"
                          >
                            {tx.status === "executed" ? "Executed" : tx.status === "rejected" ? "Rejected" : "Pending"}
                          </Badge>
                        </div>

                        <div className="flex justify-between mt-2">
                          <div className="text-xs text-muted-foreground">
                            {tx.type === "transfer" ? "Transfer" : "Contract Call"}
                          </div>
                          <div className="text-xs font-medium">
                            {tx.amount} {tx.token}
                          </div>
                        </div>

                        {tx.status === "pending" && (
                          <div className="mt-2 flex items-center justify-between">
                            <div className="text-xs text-muted-foreground">
                              Approvals: {tx.approvals}/{tx.requiredApprovals}
                            </div>
                            <Button size="sm" variant="outline" className="h-7 text-xs">
                              Review
                            </Button>
                          </div>
                        )}
                      </div>
                    ))}
                  </motion.div>
                </TabsContent>
              )}

              {activeTab === "receive" && (
                <TabsContent value="receive" className="mt-3 space-y-3">
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    transition={{ duration: 0.2 }}
                  >
                    <div className="flex flex-col items-center">
                      <div className="bg-white p-4 rounded-lg mb-3 relative group">
                        <div className="absolute inset-0 bg-gradient-to-r from-primary/20 to-purple-500/20 opacity-0 group-hover:opacity-100 transition-opacity rounded-lg"></div>
                        <QrCode className="h-40 w-40 text-primary" />
                        <div className="absolute inset-0 flex items-center justify-center">
                          <div className="h-10 w-10 rounded-full bg-white p-1">
                            <div className="h-full w-full rounded-full bg-gradient-to-r from-primary to-purple-500"></div>
                          </div>
                        </div>
                      </div>
                      <p className="text-sm font-medium">{group.name}</p>
                      <p className="text-xs text-muted-foreground mb-2">{shortAddress}</p>
                      <div className="flex space-x-2">
                        <Button variant="outline" size="sm" className="text-xs">
                          <Copy className="h-3 w-3 mr-1" /> Copy Address
                        </Button>
                        <Button variant="outline" size="sm" className="text-xs">
                          <Share2 className="h-3 w-3 mr-1" /> Share
                        </Button>
                      </div>
                    </div>

                    <div className="mt-4 p-3 rounded-lg bg-accent/30">
                      <p className="text-xs">
                        Send only {group.network} assets to this address. Sending other assets may result in permanent
                        loss.
                      </p>
                    </div>
                  </motion.div>
                </TabsContent>
              )}
            </AnimatePresence>
          </Tabs>

          <div className="flex justify-between pt-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          </div>
        </div>
      </DialogContent>

      <CreateTransactionDialog open={isCreateTxOpen} onOpenChange={setIsCreateTxOpen} groupId={groupId} />

      {selectedTx && (
        <TransactionDetailsDialog
          open={!!selectedTx}
          onOpenChange={() => setSelectedTx(null)}
          transactionId={selectedTx}
          groupId={groupId}
        />
      )}
    </Dialog>
  )
}
