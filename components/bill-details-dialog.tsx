"use client"

import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Progress } from "@/components/ui/progress"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Calendar, User, Share2 } from "lucide-react"
import { getActiveAccount } from "@/lib/onchain-store"
import type { BillView, StoredBill } from "@/lib/bill-record"
import { parseDecimalValue } from "@/lib/coin-amount"
import { buildPaymentLink, canonicalPaymentAssets } from "@/lib/payment-assets"
import { QRCodeSVG } from "qrcode.react"
import { PaymentDialog } from "@/components/payment-dialog"
import { useState, useEffect } from "react"
import { motion, AnimatePresence } from "framer-motion"
import { useI18n } from "@/components/i18n-provider"

interface BillDetailsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  billId: string
}

export function BillDetailsDialog({ open, onOpenChange, billId }: BillDetailsDialogProps) {
  const { t } = useI18n()
  const [isPaymentOpen, setIsPaymentOpen] = useState(false)
  const [activeTab, setActiveTab] = useState("participants")

  const [bill, setBill] = useState<BillView | null>(null)
  useEffect(() => {
    setIsPaymentOpen(false)
    const load = () => {
      try {
        const saved: unknown = JSON.parse(localStorage.getItem("sui_bills") || "[]")
        const found = Array.isArray(saved)
          ? (saved as StoredBill[]).find(b => b?.id === billId && b.id.startsWith("bill_"))
          : undefined
        // A bill written before `payees` existed still has a participant count;
        // it simply has no per-participant rows to show.
        setBill(found ? {
          ...found,
          participants: found.payees ?? [],
          creatorName: found.creator,
          acceptedTokens: Array.isArray(found.acceptedTokens) && found.acceptedTokens.length
            ? found.acceptedTokens
            : found.token ? [found.token] : [],
        } as BillView : null)
      } catch { setBill(null) }
    }
    load()
    window.addEventListener("sui-bills-updated", load)
    return () => window.removeEventListener("sui-bills-updated", load)
  }, [billId, open])
  const activeAddress = getActiveAccount()?.address
  const isCreator = !!activeAddress && bill?.creator === activeAddress
  const userParticipant = bill?.participants.find((p) => p.address.toLowerCase() === activeAddress?.toLowerCase())
  // Bills are SUI-only on chain, so the QR carries base units for the SUI coin.
  const billAmount = userParticipant?.amount || bill?.amount
  const billTotal = typeof billAmount === "string" ? parseDecimalValue(billAmount) : null
  let billPaymentLink = ""
  if (bill?.creator && billTotal) {
    try {
      billPaymentLink = buildPaymentLink({ address: bill.creator, total: billTotal, asset: canonicalPaymentAssets()[0], nonce: `bill-${bill.id}-${activeAddress?.slice(-8) || "anon"}`, label: bill.title })
    } catch { billPaymentLink = "" }
  }
  if (!bill) return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent><DialogHeader><DialogTitle>{t("voting.billDetailsTitle")}</DialogTitle></DialogHeader><p className="text-sm text-muted-foreground">{t("voting.billNotFound")}</p></DialogContent></Dialog>

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px] p-0 gap-0 overflow-hidden">
        <div className={`relative h-24 bg-gradient-to-r ${bill.color} p-4 flex flex-col justify-end`}>
          {/* Scrim: white text over the light gradient endpoints of the bill
              palette reaches only ~1.7:1. See group-details-dialog. */}
          <div className="absolute inset-0 bg-black/45" aria-hidden />
          <DialogHeader className="relative text-white">
            <DialogTitle className="flex items-center justify-between">
              <span className="text-xl">{bill.title}</span>
              <Badge
                variant={bill.status === "completed" ? "outline" : "default"}
                className="bg-white/20 text-white border-white/40"
              >
                {bill.status === "completed" ? "Completed" : "Pending"}{t("voting.billLocalBadge")}
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
                  {(bill.creatorName ?? "?")[0]}
                </AvatarFallback>
              </Avatar>
              <div>
                <p className="text-sm font-medium">{bill.creatorName ?? t("voting.unknownCreator")}</p>
                <p className="text-xs text-muted-foreground">Creator</p>
              </div>
            </div>
            <div className="text-right">
              <p className="font-medium">
                {bill.amount} {bill.token}
              </p>
              <div className="flex items-center text-xs text-muted-foreground">
                <Calendar className="h-3 w-3 mr-1" />
                {bill.deadline ? new Date(bill.deadline).toLocaleDateString() : t("voting.notSet")}
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
            {/* The bill and its `paid` flags live in this browser. Only the
                per-payee digests below are chain evidence, so the label says
                what is local and how to verify a payment that claims one. */}
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              {t("voting.localProgressNote")}
            </p>
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
                              {(participant.name || participant.address)[0]}
                            </AvatarFallback>
                          </Avatar>
                          <div>
                            <p className="font-medium text-sm">{participant.name || participant.address}</p>
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
                            {participant.paid ? (participant.txDigest ? t("voting.paidVerifiable") : t("voting.paidLocal")) : "Pending"}
                          </Badge>
                          {participant.paid && participant.txDigest && <a href={`https://suiscan.xyz/testnet/tx/${participant.txDigest}`} target="_blank" rel="noreferrer" className="mt-0.5 block font-mono text-[10px] text-primary underline-offset-2 hover:underline">{t("voting.txDigestLink")}</a>}
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
                          {billPaymentLink ? <QRCodeSVG value={billPaymentLink} size={128} /> : <p className="py-6 text-center text-xs text-muted-foreground">{t("voting.qrUnavailable")}</p>}
                          <p className="text-xs text-muted-foreground mt-2">{t("voting.qrNote")}</p>
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

      {userParticipant && bill && (
        <PaymentDialog
          open={isPaymentOpen}
          onOpenChange={setIsPaymentOpen}
          bill={{
            id: bill.id,
            title: bill.title,
            creator: bill.creator,
            token: bill.token,
            coinType: bill.coinType,
            amount: Number(userParticipant.amount || bill.amount),
          }}
          amount={userParticipant.amount}
        />
      )}
    </Dialog>
  )
}
