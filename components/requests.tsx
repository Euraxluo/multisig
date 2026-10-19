"use client"

import { useState } from "react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { BillDetailsDialog } from "@/components/bill-details-dialog"
import { motion, AnimatePresence } from "framer-motion"
import { ArrowUpRight, ArrowDownLeft, Calendar } from "lucide-react"

export default function Requests() {
  const [selectedBill, setSelectedBill] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState("received")

  const sentRequests = [
    {
      id: "sent-1",
      title: "Concert Tickets",
      amount: 75,
      token: "USDT",
      participants: 2,
      paid: 0,
      deadline: "2025-04-10",
      progress: 0,
      status: "pending",
      color: "from-purple-500 to-pink-400",
    },
    {
      id: "sent-2",
      title: "Group Gift",
      amount: 60,
      token: "USDC",
      participants: 5,
      paid: 3,
      deadline: "2025-03-30",
      progress: 60,
      status: "pending",
      color: "from-blue-500 to-cyan-400",
    },
  ]

  const receivedRequests = [
    {
      id: "received-1",
      title: "Dinner at Satoshi's",
      amount: 30,
      token: "USDC",
      creator: "0x1a2b...3c4d",
      creatorName: "Alex",
      deadline: "2025-04-01",
      status: "pending",
      color: "from-blue-500 to-cyan-400",
    },
    {
      id: "received-2",
      title: "Movie Night",
      amount: 15,
      token: "SUI",
      creator: "0x9i8u...7y6t",
      creatorName: "Jamie",
      deadline: "2025-03-28",
      status: "pending",
      color: "from-green-500 to-emerald-400",
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

  return (
    <div className="space-y-4">
      <Tabs defaultValue="received" value={activeTab} onValueChange={setActiveTab} className="w-full">
        <TabsList className="grid w-full grid-cols-2 p-1 bg-muted/50 rounded-xl">
          <TabsTrigger
            value="received"
            className="rounded-lg data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
          >
            <ArrowDownLeft className="h-4 w-4 mr-1.5" />
            Received
          </TabsTrigger>
          <TabsTrigger
            value="sent"
            className="rounded-lg data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
          >
            <ArrowUpRight className="h-4 w-4 mr-1.5" />
            Sent
          </TabsTrigger>
        </TabsList>

        <AnimatePresence mode="wait">
          {activeTab === "received" && (
            <TabsContent value="received" className="mt-3 space-y-3">
              <motion.div variants={container} initial="hidden" animate="show" exit={{ opacity: 0 }}>
                {receivedRequests.map((request) => (
                  <motion.div key={request.id} variants={item}>
                    <Card
                      className="overflow-hidden hover:shadow-md transition-all duration-300 border-none shadow-sm"
                      onClick={() => setSelectedBill(request.id)}
                    >
                      <div className={`h-1 bg-gradient-to-r ${request.color}`}></div>
                      <CardHeader className="p-3 pb-0">
                        <div className="flex items-start justify-between">
                          <div>
                            <h3 className="font-medium text-sm">{request.title}</h3>
                            <p className="text-xs text-muted-foreground">From {request.creatorName}</p>
                          </div>
                          <div className="flex items-center text-xs text-muted-foreground">
                            <Calendar className="h-3 w-3 mr-1" />
                            {new Date(request.deadline).toLocaleDateString()}
                          </div>
                        </div>
                      </CardHeader>
                      <CardContent className="p-3 pt-2">
                        <div className="flex items-center justify-between">
                          <div className="font-medium text-sm">
                            You owe: {request.amount} {request.token}
                          </div>
                          <Button
                            size="sm"
                            className="h-7 text-xs bg-gradient-to-r from-primary to-purple-500 hover:from-primary/90 hover:to-purple-500/90"
                          >
                            Pay
                          </Button>
                        </div>
                      </CardContent>
                    </Card>
                  </motion.div>
                ))}
              </motion.div>
            </TabsContent>
          )}

          {activeTab === "sent" && (
            <TabsContent value="sent" className="mt-3 space-y-3">
              <motion.div variants={container} initial="hidden" animate="show" exit={{ opacity: 0 }}>
                {sentRequests.map((request) => (
                  <motion.div key={request.id} variants={item}>
                    <Card
                      className="overflow-hidden hover:shadow-md transition-all duration-300 border-none shadow-sm"
                      onClick={() => setSelectedBill(request.id)}
                    >
                      <div className={`h-1 bg-gradient-to-r ${request.color}`}></div>
                      <CardHeader className="p-3 pb-0">
                        <div className="flex items-start justify-between">
                          <div>
                            <h3 className="font-medium text-sm">{request.title}</h3>
                            <p className="text-xs text-muted-foreground">
                              {request.paid} of {request.participants} paid
                            </p>
                          </div>
                          <Badge variant={request.status === "completed" ? "outline" : "default"} className="text-xs">
                            {request.status === "completed" ? "Completed" : "Pending"}
                          </Badge>
                        </div>
                      </CardHeader>
                      <CardContent className="p-3 pt-2">
                        <div className="flex items-center justify-between mb-1.5">
                          <div className="flex items-center text-xs text-muted-foreground">
                            <Calendar className="h-3 w-3 mr-1" />
                            {new Date(request.deadline).toLocaleDateString()}
                          </div>
                          <div className="font-medium text-sm">
                            {request.amount} {request.token}
                          </div>
                        </div>
                        <Progress
                          value={request.progress}
                          className="h-1.5 rounded-full"
                          indicatorClassName={`bg-gradient-to-r ${request.color}`}
                        />
                      </CardContent>
                    </Card>
                  </motion.div>
                ))}
              </motion.div>
            </TabsContent>
          )}
        </AnimatePresence>
      </Tabs>

      <BillDetailsDialog open={!!selectedBill} onOpenChange={() => setSelectedBill(null)} billId={selectedBill || ""} />
    </div>
  )
}
