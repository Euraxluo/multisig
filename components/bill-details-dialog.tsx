"use client"

import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Progress } from "@/components/ui/progress"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { QrCode, Calendar, User, Share2 } from "lucide-react"
import { PaymentDialog } from "@/components/payment-dialog"
import { useState } from "react"
import { motion, AnimatePresence } from "framer-motion"

interface BillDetailsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  billId: string
}

export function BillDetailsDialog({ open, onOpenChange, billId }: BillDetailsDialogProps) {
  const [isPaymentOpen, setIsPaymentOpen] = useState(false)
  const [activeTab, setActiveTab] = useState("participants")

  // Mock data - in a real app, you would fetch this based on billId
  const bill = {
    id: billId,
    title: "Dinner at Satoshi's",
    description: "Group dinner at the new crypto-themed restaurant",
    amount: 120,
    token: "USDC",
    creator: "0x1a2b...3c4d",
    creatorName: "Alex",
    participants: [
      { address: "0x5e6f...7g8h", name: "Sam", amount: 30, paid: true },
      { address: "jamie@gmail.com", name: "Jamie", amount: 30, paid: true },
      { address: "0x2k3l...4m5n", name: "Taylor", amount: 30, paid: false },
      { address: "0x6o7p...8q9r", name: "You", amount: 30, paid: false },
    ],
    deadline: "2025-04-01",
    progress: 50,
    status: "pending",
    acceptedTokens: ["USDC", "USDT", "SUI"],
    color: "from-blue-500 to-cyan-400",
  }

  const isCreator = bill.participants.find((p) => p.name === "You") === undefined
  const userParticipant = bill.participants.find((p) => p.name === "You")

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px] p-0 gap-0 overflow-hidden">
        <div className={`h-24 bg-gradient-to-r ${bill.color} p-4 flex flex-col justify-end`}>
          <DialogHeader className="text-white">
            <DialogTitle className="flex items-center justify-between">
              <span className="text-xl">{bill.title}</span>
              <Badge
                variant={bill.status === "completed" ? "outline" : "default"}
                className="bg-white/20 text-white border-white/40"
              >
                {bill.status === "completed" ? "Completed" : "Pending"}
              </Badge>
            </DialogTitle>
            <p className="text-white/80 text-sm mt-1">{bill.description}</p>
          </DialogHeader>
        </div>

        <div className="p-4 space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center">
              <Avatar className="h-10 w-10 mr-3 border-2 border-background">
                <AvatarFallback className="bg-gradient-to-br from-primary to-purple-500 text-white">
                  {bill.creatorName[0]}
                </AvatarFallback>
              </Avatar>
              <div>
                <p className="text-sm font-medium">{bill.creatorName}</p>
                <p className="text-xs text-muted-foreground">Creator</p>
              </div>
            </div>
            <div className="text-right">
              <p className="font-medium">
                {bill.amount} {bill.token}
              </p>
              <div className="flex items-center text-xs text-muted-foreground">
                <Calendar className="h-3 w-3 mr-1" />
                {new Date(bill.deadline).toLocaleDateString()}
              </div>
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <p className="text-xs text-muted-foreground">
                {bill.participants.filter((p) => p.paid).length} of {bill.participants.length} paid
              </p>
              <p className="text-xs font-medium">{bill.progress}% Complete</p>
            </div>
            <Progress
              value={bill.progress}
              className="h-1.5 rounded-full"
              indicatorClassName={`bg-gradient-to-r ${bill.color}`}
            />
          </div>

          <Tabs defaultValue="participants" value={activeTab} onValueChange={setActiveTab} className="w-full">
            <TabsList className="grid w-full grid-cols-2 p-1 bg-muted/50 rounded-xl">
              <TabsTrigger
                value="participants"
                className="rounded-lg data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
              >
                <User className="h-4 w-4 mr-1.5" />
                Participants
              </TabsTrigger>
              <TabsTrigger
                value="details"
                className="rounded-lg data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
              >
                <Share2 className="h-4 w-4 mr-1.5" />
                Payment Details
              </TabsTrigger>
            </TabsList>

            <AnimatePresence mode="wait">
              {activeTab === "participants" && (
                <TabsContent value="participants" className="mt-3 space-y-2">
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    transition={{ duration: 0.2 }}
                  >
                    {bill.participants.map((participant, index) => (
                      <div
                        key={index}
                        className="flex items-center justify-between p-2 rounded-lg hover:bg-muted/50 transition-colors"
                      >
                        <div className="flex items-center">
                          <Avatar className="h-8 w-8 mr-3">
                            <AvatarFallback
                              className={`text-white ${
                                participant.paid
                                  ? "bg-gradient-to-br from-green-400 to-emerald-400"
                                  : "bg-gradient-to-br from-amber-400 to-orange-400"
                              }`}
                            >
                              {participant.name[0]}
                            </AvatarFallback>
                          </Avatar>
                          <div>
                            <p className="font-medium text-sm">{participant.name}</p>
                            {participant.address.includes("@") ? (
                              <p className="text-xs text-muted-foreground flex items-center">
                                <span className="text-xs bg-blue-100 text-blue-600 px-1 rounded mr-1">@</span>
                                {participant.address}
                              </p>
                            ) : (
                              <p className="text-xs text-muted-foreground flex items-center">
                                <span className="text-xs bg-purple-100 text-purple-600 px-1 rounded mr-1">Ξ</span>
                                {participant.address.slice(0, 6)}...{participant.address.slice(-4)}
                              </p>
                            )}
                          </div>
                        </div>
                        <div className="text-right">
                          <p className="font-medium text-sm">
                            {participant.amount} {bill.token}
                          </p>
                          <Badge variant={participant.paid ? "outline" : "secondary"} className="text-xs">
                            {participant.paid ? "Paid" : "Pending"}
                          </Badge>
                        </div>
                      </div>
                    ))}
                  </motion.div>
                </TabsContent>
              )}

              {activeTab === "details" && (
                <TabsContent value="details" className="mt-3 space-y-3">
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    transition={{ duration: 0.2 }}
                  >
                    <div>
                      <p className="text-sm font-medium">Accepted Tokens</p>
                      <div className="flex flex-wrap gap-2 mt-1">
                        {bill.acceptedTokens.map((token) => (
                          <Badge key={token} variant="outline" className="bg-muted/50">
                            {token}
                          </Badge>
                        ))}
                      </div>
                    </div>

                    <div className="mt-4">
                      <p className="text-sm font-medium">Payment QR Code</p>
                      <div className="flex justify-center mt-2 border rounded-md p-4 bg-white">
                        <div className="flex flex-col items-center">
                          <div className="relative">
                            <QrCode className="h-32 w-32" />
                            <div className="absolute inset-0 flex items-center justify-center">
                              <div className="h-8 w-8 rounded-full bg-white p-1">
                                <div className="h-full w-full rounded-full bg-gradient-to-r from-primary to-purple-500"></div>
                              </div>
                            </div>
                          </div>
                          <p className="text-xs text-muted-foreground mt-2">Scan to pay with any Sui wallet</p>
                        </div>
                      </div>
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

            {!isCreator && userParticipant && !userParticipant.paid && (
              <Button
                onClick={() => setIsPaymentOpen(true)}
                className="bg-gradient-to-r from-primary to-purple-500 hover:from-primary/90 hover:to-purple-500/90"
              >
                Pay Now
              </Button>
            )}
          </div>
        </div>
      </DialogContent>

      {userParticipant && (
        <PaymentDialog
          open={isPaymentOpen}
          onOpenChange={setIsPaymentOpen}
          bill={bill}
          amount={userParticipant.amount}
        />
      )}
    </Dialog>
  )
}
