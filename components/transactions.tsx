"use client"

import { useState, useEffect, useRef } from "react"
import { normalizeSuiAddress } from "@mysten/sui/utils"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { motion, AnimatePresence } from "framer-motion"
import { Clock, Check, X, ArrowRight, Code, Send, Calendar, Zap, ListChecks, Play } from "lucide-react"
import { TransactionDetailsDialog } from "@/components/transaction-details-dialog"
import {
  getProposals,
  approveProposal,
  rejectProposalWithReceipt,
  executeProposal,
  getActiveAccount,
  type ProposalItem,
} from "@/lib/onchain-store"
import { useI18n } from "@/components/i18n-provider"

export default function Transactions() {
  const { t } = useI18n()
  const [selectedTx, setSelectedTx] = useState<{ id: string; groupId: string } | null>(null)
  const [activeTab, setActiveTab] = useState("pending")
  const [proposals, setProposals] = useState<ProposalItem[]>([])
  const [actionLoadingId, setActionLoadingId] = useState<string | null>(null)
  const [actionError, setActionError] = useState("")
  const [actionDigest, setActionDigest] = useState("")
  const [address, setAddress] = useState("")
  const actionPending = useRef(false)

  useEffect(() => {
    const load = () => {
      setProposals(getProposals())
      const account = getActiveAccount()
      setAddress(account ? normalizeSuiAddress(account.address) : "")
    }
    load()
    window.addEventListener("sui-proposals-updated", load)
    window.addEventListener("storage", load)
    window.addEventListener("sui-account-switched", load)
    const id = window.setInterval(load, 3000)
    return () => {
      window.removeEventListener("sui-proposals-updated", load)
      window.removeEventListener("storage", load)
      window.removeEventListener("sui-account-switched", load)
      window.clearInterval(id)
    }
  }, [])

  const handleVote = async (id: string, reject: boolean, e: React.MouseEvent) => {
    e.stopPropagation()
    if (actionPending.current) return
    actionPending.current = true
    setActionLoadingId(id)
    setActionError(""); setActionDigest("")
    try {
      const result = reject ? await rejectProposalWithReceipt(id) : await approveProposal(id)
      setActionDigest(result.digest || "")
    } catch (error) {
      setActionError(error instanceof Error ? error.message : t("tx.voteFailed"))
    } finally { actionPending.current = false; setActionLoadingId(null) }
  }

  const handleExecute = async (id: string, e?: React.MouseEvent) => {
    e?.stopPropagation()
    if (actionPending.current) return
    actionPending.current = true
    setActionLoadingId(id)
    setActionError(""); setActionDigest("")
    try {
      const res = await executeProposal(id)
      setActionDigest(res.digest || "")
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t("tx.executeFailed"))
    } finally {
      actionPending.current = false
      setActionLoadingId(null)
    }
  }

  const pendingTransactions = proposals.filter(
    (p) => p.status === "pending" || p.status === "approved"
  )

  const completedTransactions = proposals.filter(
    (p) => p.status === "executed" || p.status === "rejected"
  )

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

  const getTransactionIcon = (tx: ProposalItem) => {
    if (tx.isBatch) return <ListChecks className="h-3 w-3 mr-1" />
    if (tx.type === "transfer") return <Send className="h-3 w-3 mr-1" />
    if (tx.type === "contract") return <Code className="h-3 w-3 mr-1" />
    return <Send className="h-3 w-3 mr-1" />
  }

  const getTransactionTypeText = (tx: ProposalItem) => {
    if (tx.isBatch) return t("tx.typeBatch")
    if (tx.type === "transfer") return t("tx.typeTransfer")
    if (tx.type === "contract") return t("tx.typeContract")
    return t("tx.typeDefault")
  }

  const getSpecialBadge = (tx: ProposalItem) => {
    if (tx.isScheduled) {
      return (
        <Badge variant="outline" className="text-xs flex items-center">
          <Calendar className="h-3 w-3 mr-1" /> {t("tx.badgeScheduled")}
        </Badge>
      )
    }
    if (tx.isConditional) {
      return (
        <Badge variant="outline" className="text-xs flex items-center">
          <Zap className="h-3 w-3 mr-1" /> {t("tx.badgeConditional")}
        </Badge>
      )
    }
    if (tx.isBatch) {
      return (
        <Badge variant="outline" className="text-xs flex items-center">
          <ListChecks className="h-3 w-3 mr-1" /> {t("tx.badgeBatchCount", { count: tx.batchCount ?? 0 })}
        </Badge>
      )
    }
    return null
  }

  return (
    <div className="space-y-4">
      {actionError && <p role="alert" className="text-xs text-destructive">{actionError}</p>}
      {actionDigest && <a role="status" className="block break-all text-xs text-primary" href={`https://suiscan.xyz/testnet/tx/${actionDigest}`} target="_blank" rel="noreferrer">{t("tx.confirmed")} {actionDigest}</a>}
      <Tabs defaultValue="pending" value={activeTab} onValueChange={setActiveTab} className="w-full">
        <TabsList className="grid w-full grid-cols-2 p-1 bg-muted/50 rounded-xl">
          <TabsTrigger
            value="pending"
            className="rounded-lg data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
          >
            <Clock className="h-4 w-4 mr-1.5" />
            {t("tx.tabPending")}
          </TabsTrigger>
          <TabsTrigger
            value="completed"
            className="rounded-lg data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
          >
            <Check className="h-4 w-4 mr-1.5" />
            {t("tx.tabCompleted")}
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
                        className="overflow-hidden rounded-2xl border border-border/60 bg-surface-card hover:border-primary/40 hover:shadow-md active:scale-[0.99] transition-all duration-200 shadow-sm cursor-pointer"
                        role="button"
                        tabIndex={0}
                        onClick={() => setSelectedTx({ id: tx.id, groupId: tx.groupId })}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault()
                            setSelectedTx({ id: tx.id, groupId: tx.groupId })
                          }
                        }}
                      >
                        <CardHeader className="p-4 pb-0">
                          <div className="flex items-start justify-between">
                            <div>
                              <h3 className="font-semibold text-sm text-label-primary">{tx.title}</h3>
                              {tx.sourceStatus === "unverified" && <Badge variant="outline" className="my-1 text-[10px] rounded-full">{t("tx.badgeLegacyUnverified")}</Badge>}
                              <p className="text-xs text-muted-foreground">{tx.groupName}</p>
                            </div>
                            <div className="flex space-x-2">
                              {getSpecialBadge(tx)}
                              <Badge
                                variant={tx.status === "approved" ? "secondary" : "default"}
                                className={`text-xs rounded-full ${tx.status === "approved" ? "bg-emerald-500/10 text-emerald-600 border-emerald-500/20" : ""}`}
                              >
                                {tx.status === "approved" ? t("tx.readyToExecute") : t("tx.awaitingApproval")}
                              </Badge>
                            </div>
                          </div>
                        </CardHeader>
                        <CardContent className="p-4 pt-2">
                          <div className="flex items-center justify-between mb-1.5">
                            <div className="flex items-center text-xs text-muted-foreground">
                              {getTransactionIcon(tx)}
                              {getTransactionTypeText(tx)}
                            </div>
                            {!tx.isBatch && (
                              <div className="font-medium text-sm">
                                {tx.amountLabel || `${tx.amount} ${tx.token}`}
                              </div>
                            )}
                          </div>

                          <div className="flex items-center justify-between mt-2">
                            <div className="text-xs text-muted-foreground">
                              {tx.chainSyncedAt ? t("tx.approvedCount", { approved: tx.approvals, total: tx.requiredApprovals }) : tx.onChainId ? t("tx.readingApprovals") : t("tx.localUnverified")}
                            </div>
                            <div className="flex gap-3">
                              {tx.chainSyncedAt && tx.status === "approved" ? (
                                <Button
                                  size="sm"
                                  disabled={actionLoadingId === tx.id}
                                  onClick={(e) => handleExecute(tx.id, e)}
                                  className="h-11 px-4 text-sm bg-emerald-600 hover:bg-emerald-500 text-white font-medium"
                                >
                                  <Play className="h-4 w-4 mr-1" />
                                  {actionLoadingId === tx.id ? t("tx.executing") : t("tx.executeOnChain")}
                                </Button>
                              ) : (
                                <>
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    disabled={!!actionLoadingId || !address || !!tx.voteWeights?.[address] || tx.deadlineMs < Date.now()}
                                    onClick={(event) => void handleVote(tx.id, true, event)}
                                    className="h-11 px-4 text-sm border-red-200 text-red-500 hover:bg-red-50"
                                  >
                                    <X className="h-4 w-4 mr-1" /> {t("tx.reject")}
                                  </Button>
                                  <Button
                                    size="sm"
                                    disabled={!!actionLoadingId || !address || !!tx.voteWeights?.[address] || tx.deadlineMs < Date.now()}
                                    onClick={(event) => void handleVote(tx.id, false, event)}
                                    className="h-11 px-4 text-sm bg-primary text-primary-foreground"
                                  >
                                    <Check className="h-4 w-4 mr-1" /> {actionLoadingId === tx.id ? t("tx.signing") : t("tx.approve")}
                                  </Button>
                                </>
                              )}
                            </div>
                          </div>
                          {tx.syncError && <p role="alert" className="mt-2 text-xs text-destructive">{tx.syncError}</p>}
                          {tx.rejectionSupported === false && <p className="mt-2 text-[11px] text-muted-foreground">{t("tx.rejectionUnsupported")}</p>}
                        </CardContent>
                      </Card>
                    </motion.div>
                  ))
                ) : (
                  <div className="text-center py-8">
                    <p className="text-muted-foreground">{t("tx.noPending")}</p>
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
                      className="overflow-hidden rounded-2xl border border-border/60 bg-surface-card hover:border-primary/40 hover:shadow-md active:scale-[0.99] transition-all duration-200 shadow-sm cursor-pointer"
                      role="button"
                      tabIndex={0}
                      onClick={() => setSelectedTx({ id: tx.id, groupId: tx.groupId })}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault()
                          setSelectedTx({ id: tx.id, groupId: tx.groupId })
                        }
                      }}
                    >
                      <CardHeader className="p-4 pb-0">
                        <div className="flex items-start justify-between">
                          <div>
                            <h3 className="font-semibold text-sm text-label-primary">{tx.title}</h3>
                            <p className="text-xs text-muted-foreground">{tx.groupName}</p>
                          </div>
                          <div className="flex space-x-2">
                            {getSpecialBadge(tx)}
                            {/* `status` is persisted local state. Only a chain-synced
                                row may claim the settlement outcome; otherwise the
                                row says the outcome is unverified. */}
                            {tx.chainSyncedAt ? (
                              <Badge variant={tx.status === "executed" ? "outline" : "destructive"} className="text-xs rounded-full">
                                {tx.status === "executed" ? t("tx.executed") : t("tx.rejected")}
                              </Badge>
                            ) : (
                              <Badge variant="outline" className="text-xs rounded-full text-amber-700 dark:text-amber-300">{t("tx.localOutcomeUnverified")}</Badge>
                            )}
                          </div>
                        </div>
                      </CardHeader>
                      <CardContent className="p-4 pt-2">
                        <div className="flex items-center justify-between mb-1.5">
                          <div className="flex items-center text-xs text-muted-foreground">
                            {getTransactionIcon(tx)}
                            {getTransactionTypeText(tx)}
                          </div>
                          {!tx.isBatch && (
                            <div className="font-medium text-sm">
                              {tx.chainSyncedAt ? (tx.amountLabel || `${tx.amount} ${tx.token}`) : <span className="text-xs text-muted-foreground">{t("tx.amountUnverified")}</span>}
                            </div>
                          )}
                        </div>

                        <div className="flex items-center justify-between mt-2">
                          <div className="text-xs text-muted-foreground">
                            {!tx.chainSyncedAt
                              ? t("tx.localUnverifiedFull")
                              : tx.status === "executed"
                                ? t("tx.executedAt", { date: tx.executedAt ? new Date(tx.executedAt).toLocaleDateString() : "—" })
                                : t("tx.rejectedAt", { date: tx.rejectedAt ? new Date(tx.rejectedAt).toLocaleDateString() : "—" })}
                          </div>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-9 px-3 text-sm text-primary flex items-center gap-1"
                          >
                            {t("tx.details")} <ArrowRight className="h-4 w-4" />
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
