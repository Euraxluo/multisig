"use client"

import { useState, useEffect } from "react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { getActiveAccount } from "@/lib/onchain-store"
import type { StoredBill } from "@/lib/bill-record"
import { BillDetailsDialog } from "@/components/bill-details-dialog"
import { motion, AnimatePresence } from "framer-motion"
import { ArrowUpRight, ArrowDownLeft, Calendar } from "lucide-react"
import { useI18n } from "@/components/i18n-provider"

export default function Requests() {
  const { t } = useI18n()
  const [selectedBill, setSelectedBill] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState("received")

  const [bills, setBills] = useState<(StoredBill & { creator: string })[]>([])
  const [accountAddress, setAccountAddress] = useState("")
  useEffect(() => {
    const load = () => {
      setAccountAddress(getActiveAccount()?.address || "")
      try {
        const saved: unknown = JSON.parse(localStorage.getItem("sui_bills") || "[]")
        // Only bills with a real creator address can be attributed to someone.
        setBills(Array.isArray(saved)
          ? (saved as StoredBill[]).filter((b): b is StoredBill & { creator: string } =>
              !!b?.id?.startsWith("bill_") && typeof b.creator === "string" && b.creator.length > 0)
          : [])
      } catch { setBills([]) }
    }
    load()
    window.addEventListener("sui-bills-updated", load); window.addEventListener("storage", load); window.addEventListener("sui-account-switched", load)
    return () => { window.removeEventListener("sui-bills-updated", load); window.removeEventListener("storage", load); window.removeEventListener("sui-account-switched", load) }
  }, [])
  const sentRequests = bills.filter(b => accountAddress && b.creator.toLowerCase() === accountAddress.toLowerCase())
  const receivedRequests = bills
    .filter((b) => accountAddress
      && b.creator.toLowerCase() !== accountAddress.toLowerCase()
      && b.payees?.some((p) => p.address.toLowerCase() === accountAddress.toLowerCase()))
    .map((b) => ({
      ...b,
      amount: b.payees?.find((p) => p.address.toLowerCase() === accountAddress.toLowerCase())?.amount,
      creatorName: b.creator,
    }))

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
      <p className="text-xs text-muted-foreground">{t("dash.requestsIntro")}</p>
      <Tabs defaultValue="received" value={activeTab} onValueChange={setActiveTab} className="w-full">
        <TabsList className="grid w-full grid-cols-2 p-1 bg-muted/50 rounded-xl">
          <TabsTrigger
            value="received"
            className="rounded-lg data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
          >
            <ArrowDownLeft className="h-4 w-4 mr-1.5" />
            {t("dash.requestsReceived")}
          </TabsTrigger>
          <TabsTrigger
            value="sent"
            className="rounded-lg data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
          >
            <ArrowUpRight className="h-4 w-4 mr-1.5" />
            {t("dash.requestsSent")}
          </TabsTrigger>
        </TabsList>

        <AnimatePresence mode="wait">
          {activeTab === "received" && (
            <TabsContent value="received" className="mt-3 space-y-3">
              <motion.div variants={container} initial="hidden" animate="show" exit={{ opacity: 0 }}>
                {receivedRequests.length === 0 && <p className="py-6 text-sm text-muted-foreground">{t("dash.noReceivedBills")}</p>}
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
                            <p className="text-xs text-muted-foreground">{t("dash.billFrom", { name: request.creatorName })}</p>
                          </div>
                          <div className="flex items-center text-xs text-muted-foreground">
                            <Calendar className="h-3 w-3 mr-1" />
                            {request.deadline ? new Date(request.deadline).toLocaleDateString() : t("dash.noDeadline")}
                          </div>
                        </div>
                      </CardHeader>
                      <CardContent className="p-3 pt-2">
                        <div className="flex items-center justify-between">
                          <div className="font-medium text-sm">
                            {t("dash.youOwe", { amount: request.amount ?? "", token: request.token ?? "" })}
                          </div>
                          <Button
                            size="sm"
                            onClick={(event) => {
                              event.stopPropagation()
                              setSelectedBill(request.id)
                            }}
                            className="h-7 text-xs bg-gradient-to-r from-primary to-purple-500 hover:from-primary/90 hover:to-purple-500/90"
                          >
                            {t("dash.pay")}
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
                {sentRequests.length === 0 && <p className="py-6 text-sm text-muted-foreground">{t("dash.noSentBills")}</p>}
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
                              {t("dash.paidCount", { paid: request.paid ?? 0, total: request.participants ?? 0 })}
                            </p>
                          </div>
                          <Badge variant={request.status === "completed" ? "outline" : "default"} className="text-xs">
                            {t("dash.statusLocal", { status: request.status === "completed" ? t("dash.statusCompleted") : t("dash.statusActive") })}
                          </Badge>
                        </div>
                      </CardHeader>
                      <CardContent className="p-3 pt-2">
                        <div className="flex items-center justify-between mb-1.5">
                          <div className="flex items-center text-xs text-muted-foreground">
                            <Calendar className="h-3 w-3 mr-1" />
                            {request.deadline ? new Date(request.deadline).toLocaleDateString() : t("dash.noDeadline")}
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
                        <p className="mt-1.5 text-[11px] text-muted-foreground">{t("dash.progressLocalNote")}</p>
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
