"use client"

import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Check, X, Loader2, ExternalLink, Clock, ArrowRight, FileText, Code, Send, Play, ShieldCheck } from "lucide-react"
import { useState, useEffect, useRef } from "react"
import { AnimatePresence } from "framer-motion"
import {
  getProposals,
  approveProposal,
  rejectProposalWithReceipt,
  executeProposal,
  getActiveAccount,
  getUserGroups,
  refreshProposal,
  type ProposalItem,
} from "@/lib/onchain-store"
import { normalizeSuiAddress } from "@mysten/sui/utils"
import { usePendingCreation } from "@/lib/use-pending-creation"
import { TransactionReceiptError } from "@/lib/pending-transactions"
import { errorMessage as describeError } from "@/lib/error-message"
import { useI18n } from "@/components/i18n-provider"

interface TransactionDetailsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  transactionId: string
  groupId?: string
}

export function TransactionDetailsDialog({ open, onOpenChange, transactionId, groupId }: TransactionDetailsDialogProps) {
  const { t } = useI18n()
  const [activeTab, setActiveTab] = useState("details")
  const [isApproving, setIsApproving] = useState(false)
  const [isRejecting, setIsRejecting] = useState(false)
  const [confirmReject, setConfirmReject] = useState(false)
  const [isExecuting, setIsExecuting] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [proposal, setProposal] = useState<ProposalItem | null>(null)
  const [userAddr, setUserAddr] = useState("")
  const [actionDigest, setActionDigest] = useState("")
  const actionPending = useRef(false)
  const actionGeneration = useRef(0)
  const executionPending = usePendingCreation(open, "group-treasury-proposal-execute", proposal?.onChainId || "")

  useEffect(() => {
    const run = ++actionGeneration.current
    setActiveTab("details"); setErrorMessage(null); setActionDigest("")
    if (!open) return
    let cancelled = false
    const loadProposal = () => {
      const account = getActiveAccount()
      setUserAddr(account ? normalizeSuiAddress(account.address) : "")
      const all = getProposals()
      const found = all.find((p) => p.id === transactionId || p.onChainId === transactionId)
      setProposal(found || null)
    }
    loadProposal()
    void refreshProposal(transactionId).catch(error => {
      if (!cancelled && run === actionGeneration.current) setErrorMessage(error instanceof Error ? error.message : t("vault.chainReadFailed"))
    })
    const accountChanged = () => { actionGeneration.current++; setActionDigest(""); setErrorMessage(null); loadProposal() }
    const invalidate = () => { actionGeneration.current++ }
    window.addEventListener("sui-proposals-updated", loadProposal)
    window.addEventListener("sui-account-switched", accountChanged)
    return () => {
      cancelled = true
      invalidate()
      window.removeEventListener("sui-proposals-updated", loadProposal)
      window.removeEventListener("sui-account-switched", accountChanged)
    }
  }, [open, transactionId])

  if (!proposal) {
    return null
  }

  const hasVoted = !!proposal.voteWeights?.[userAddr]
  const canApprove = proposal.status === "pending" && !!proposal.onChainId && !hasVoted
  const canExecute = !!proposal.chainSyncedAt && proposal.status === "approved" && !!proposal.onChainId && !!proposal.vaultId && (!!proposal.treasuryId && !!proposal.treasuryBindingId || !!proposal.masterCapId)

  const handleApprove = async () => {
    if (actionPending.current) return
    const run = actionGeneration.current
    actionPending.current = true
    setErrorMessage(null)
    setIsApproving(true)
    try {
      const result = await approveProposal(proposal.id)
      if (run === actionGeneration.current) setActionDigest(result.digest || "")
    } catch (e) {
      if (run === actionGeneration.current) setErrorMessage(describeError(e, "Approve failed"))
    } finally {
      actionPending.current = false
      setIsApproving(false)
    }
  }

  const handleReject = async () => {
    if (actionPending.current) return
    const run = actionGeneration.current
    actionPending.current = true
    setErrorMessage(null)
    setIsRejecting(true)
    try {
      const result = await rejectProposalWithReceipt(proposal.id)
      if (run === actionGeneration.current) setActionDigest(result.digest || "")
    } catch (e) {
      if (run === actionGeneration.current) setErrorMessage(describeError(e, "Reject failed"))
    } finally {
      actionPending.current = false
      setIsRejecting(false)
    }
  }

  const handleExecute = async () => {
    if (actionPending.current) return
    const run = actionGeneration.current
    actionPending.current = true
    setErrorMessage(null)
    setIsExecuting(true)
    try {
      const res = await executeProposal(proposal.id)
      if (run === actionGeneration.current) { setActionDigest(res.digest || ""); executionPending.setPending(undefined) }
    } catch (e) {
      if (run === actionGeneration.current) {
        if (e instanceof TransactionReceiptError) executionPending.setPending(e.status === "failed" ? undefined : e.receipt)
        setErrorMessage(describeError(e, "Execute failed"))
      }
    } finally {
      actionPending.current = false
      setIsExecuting(false)
    }
  }

  const formatDate = (dateString?: string) => {
    if (!dateString) return "N/A"
    return new Date(dateString).toLocaleString()
  }

  // 计算投票者名册展示
  const knownAccounts = Object.entries(proposal.memberWeights || {}).map(([address, weight]) => { const member = getUserGroups().find(g => g.id === groupId)?.members?.find((member) => member.address.toLowerCase() === address.toLowerCase())
    return { name: member?.name || address, address, weight }
  })
  const memberVotes = knownAccounts.map(acc => ({
    ...acc, approved: proposal.voters.includes(acc.address), rejected: proposal.rejectingVoters?.includes(acc.address) || false,
  }))
  const extraVoters = Object.entries(proposal.voteWeights || {}).filter(([address]) => !knownAccounts.some(member => member.address === address)).map(([address, weight]) => ({
    name: address === userAddr ? t("vault.currentAccountYou") : `${address.slice(0, 6)}...${address.slice(-4)}`,
    address, weight, approved: proposal.voters.includes(address), rejected: proposal.rejectingVoters?.includes(address) || false,
  }))

  const allVoterList = [...extraVoters, ...memberVotes]

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px] p-0 gap-0 overflow-hidden bg-background">
        <div className={`relative h-24 bg-gradient-to-r ${proposal.color || "from-primary to-purple-500"} p-4 flex flex-col justify-end text-white`}>
          {/* Scrim: white text over the light gradient endpoints of the proposal
              palette reaches only ~1.7:1. See group-details-dialog. */}
          <div className="absolute inset-0 bg-black/45" aria-hidden />
          <DialogHeader className="relative text-white">
            <DialogTitle className="flex items-center justify-between">
              <span className="text-xl font-bold truncate max-w-[320px]">{proposal.title}</span>
              <Badge
                variant={
                  proposal.status === "executed"
                    ? "outline"
                    : proposal.status === "rejected"
                      ? "destructive"
                      : "default"
                }
                className={
                  proposal.status === "executed"
                    ? "bg-emerald-700 text-white border-emerald-600"
                    : proposal.status === "rejected"
                      ? "bg-destructive text-destructive-foreground border-destructive"
                      : "bg-white/20 text-white border-white/40"
                }
              >
                {proposal.status === "executed"
                  ? proposal.chainSyncedAt ? t("vault.statusExecuted") : t("vault.statusExecutedLocal")
                  : proposal.status === "approved"
                    ? t("vault.statusApproved")
                    : proposal.status === "rejected"
                      ? proposal.chainSyncedAt ? t("vault.statusRejected") : t("vault.statusRejectedLocal")
                      : t("vault.statusPendingApproval")}
              </Badge>
            </DialogTitle>
            <p className="text-white/80 text-xs mt-1 truncate">{proposal.description}</p>
          </DialogHeader>
        </div>

        <div className="p-4 space-y-4">
          {proposal.sourceStatus === "unverified" && <Badge variant="outline">{t("vault.badgeHistoryUnverified")}</Badge>}
          <p className="text-xs text-muted-foreground">{t("vault.approvalFlowHint")}{proposal.rejectionSupported === false && t("vault.rejectionUnsupportedHint")}</p>
          {proposal.syncError && <p role="alert" className="text-xs text-destructive">{proposal.syncError}</p>}
          {actionDigest && <a role="status" className="block break-all text-xs text-primary" href={`https://suiscan.xyz/testnet/tx/${actionDigest}`} target="_blank" rel="noreferrer">{t("vault.txConfirmed", { digest: actionDigest })}</a>}
          <div className="flex items-center justify-between">
            <div className="flex items-center">
              <Avatar className="h-10 w-10 mr-3 border-2 border-background">
                <AvatarFallback className="bg-gradient-to-br from-primary/80 to-purple-600 text-white font-bold">
                  {proposal.title[0]?.toUpperCase() || "P"}
                </AvatarFallback>
              </Avatar>
              <div>
                <p className="text-sm font-medium">{proposal.groupName}</p>
                <p className="text-xs text-muted-foreground font-mono">Org: {proposal.orgId.slice(0, 10)}...</p>
              </div>
            </div>
            <div className="text-right">
              <p className="font-bold text-base text-primary">
                {proposal.amountLabel || `${proposal.amount} ${proposal.token}`}
              </p>
              <div className="flex items-center text-xs text-muted-foreground justify-end">
                <Clock className="h-3 w-3 mr-1" />
                {formatDate(proposal.createdAt)}
              </div>
            </div>
          </div>

          <div className="p-3 rounded-lg bg-muted/50 space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center">
                {proposal.type === "transfer" ? (
                  <Send className="h-4 w-4 mr-2 text-primary" />
                ) : (
                  <Code className="h-4 w-4 mr-2 text-primary" />
                )}
                <span className="text-sm font-medium">
                  {proposal.type === "transfer" ? t("vault.vaultNativeTransfer") : t("vault.contractInteraction")}
                </span>
              </div>
              {proposal.onChainId && (
                <Badge variant="outline" className="text-[10px] font-mono">
                  {t("vault.onchainSharedObject", { id: proposal.onChainId.slice(0, 6) })}...
                </Badge>
              )}
            </div>

            <div className="mt-2 flex items-center text-xs">
              <div className="flex-1">
                <p className="text-muted-foreground">{t("vault.sendingVault")}</p>
                <p className="font-medium truncate">{proposal.groupName}</p>
              </div>
              <ArrowRight className="h-4 w-4 mx-2 text-muted-foreground" />
              <div className="flex-1">
                <p className="text-muted-foreground">{t("vault.recipientAddress")}</p>
                <p className="font-medium font-mono truncate">{proposal.recipient}</p>
              </div>
            </div>
          </div>

          <Tabs defaultValue="details" value={activeTab} onValueChange={setActiveTab} className="w-full">
            <TabsList className="grid w-full grid-cols-2 p-1 bg-muted/50 rounded-xl">
              <TabsTrigger
                value="details"
                className="rounded-lg data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm text-xs"
              >
                <FileText className="h-3.5 w-3.5 mr-1.5" />
                {t("vault.tabDetails")}
              </TabsTrigger>
              <TabsTrigger
                value="approvals"
                className="rounded-lg data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm text-xs"
              >
                <Check className="h-3.5 w-3.5 mr-1.5" />
                {t("vault.tabApprovals", { approved: proposal.approvals, required: proposal.requiredApprovals })}
              </TabsTrigger>
            </TabsList>

            <AnimatePresence mode="wait">
              {activeTab === "details" && (
                <TabsContent value="details" className="mt-3 space-y-3">
                  <div className="space-y-2.5 text-xs">
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <p className="text-muted-foreground">{t("vault.proposalAmount")}</p>
                        <p className="font-semibold text-foreground text-sm">
                          {proposal.amountLabel || `${proposal.amount} ${proposal.token}`}
                        </p>
                      </div>
                      <div>
                        <p className="text-muted-foreground">{t("vault.network")}</p>
                        <p className="font-semibold text-foreground text-sm">Sui Testnet (v3)</p>
                      </div>
                    </div>

                    <div>
                      <p className="text-muted-foreground">{t("vault.recipientAddressRecipient")}</p>
                      <div className="flex items-center gap-1 font-mono break-all mt-0.5">
                        <span>{proposal.recipient}</span>
                        <a
                          href={`https://suiscan.xyz/testnet/account/${proposal.recipient}`}
                          target="_blank"
                          rel="noreferrer"
                          className="text-primary hover:opacity-80"
                        >
                          <ExternalLink className="h-3.5 w-3.5" />
                        </a>
                      </div>
                    </div>

                    {proposal.txDigest && (
                      <div>
                        <p className="text-muted-foreground">{t("vault.creationDigest")}</p>
                        <div className="flex items-center gap-1 font-mono break-all mt-0.5">
                          <span className="text-primary">{proposal.txDigest}</span>
                          <a
                            href={`https://suiscan.xyz/testnet/tx/${proposal.txDigest}`}
                            target="_blank"
                            rel="noreferrer"
                            className="text-primary hover:opacity-80"
                          >
                            <ExternalLink className="h-3.5 w-3.5" />
                          </a>
                        </div>
                      </div>
                    )}

                    {/* A digest is only an execution credential if it is shaped like a
                        real Sui digest AND the row was confirmed against the chain.
                        Older builds stored placeholder strings such as
                        `0xexec_<timestamp>` alongside `status: "executed"`, so the
                        shape check and the provenance check are both required. */}
                    {proposal.executionDigest && /^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(proposal.executionDigest) && proposal.chainSyncedAt && (
                      <div className="p-2.5 bg-emerald-500/10 border border-emerald-500/20 rounded-lg">
                        <p className="text-emerald-600 dark:text-emerald-400 font-semibold flex items-center gap-1">
                          <ShieldCheck className="h-3.5 w-3.5" /> {t("vault.executionCredential")}
                        </p>
                        <div className="flex items-center gap-1 font-mono break-all mt-1">
                          <span className="text-xs text-foreground">{proposal.executionDigest}</span>
                          <a
                            href={`https://suiscan.xyz/testnet/tx/${proposal.executionDigest}`}
                            target="_blank"
                            rel="noreferrer"
                            className="text-primary hover:opacity-80"
                          >
                            <ExternalLink className="h-3.5 w-3.5" />
                          </a>
                        </div>
                      </div>
                    )}
                    {proposal.executionDigest && !(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(proposal.executionDigest) && proposal.chainSyncedAt) && (
                      <div className="p-2.5 bg-amber-500/10 border border-amber-500/30 rounded-lg">
                        <p className="text-amber-700 dark:text-amber-300 font-semibold flex items-center gap-1">
                          <ShieldCheck className="h-3.5 w-3.5" /> {t("vault.localExecutionDigest")}
                        </p>
                        <p className="mt-1 break-all font-mono text-xs text-muted-foreground">{proposal.executionDigest}</p>
                        <p className="mt-1 text-[11px] text-muted-foreground">{t("vault.localExecutionNote")}</p>
                      </div>
                    )}

                    <div className="grid grid-cols-2 gap-2 pt-1 border-t border-border/40">
                      <div>
                        <p className="text-muted-foreground">{t("vault.createdAt")}</p>
                        <p className="font-medium text-foreground">{formatDate(proposal.createdAt)}</p>
                      </div>
                      <div>
                        <p className="text-muted-foreground">{t("vault.expiresAt")}</p>
                        <p className="font-medium text-foreground">{formatDate(proposal.expiresAt)}</p>
                      </div>
                    </div>
                  </div>
                </TabsContent>
              )}

              {activeTab === "approvals" && (
                <TabsContent value="approvals" className="mt-3 space-y-2">
                  <div className="mb-3">
                    <div className="flex justify-between items-center mb-1">
                      <p className="text-xs text-muted-foreground">
                        {proposal.chainSyncedAt ? t("vault.approvalProgress", { approved: proposal.approvals, required: proposal.requiredApprovals }) : t("vault.approvalProgressUnverified")}
                      </p>
                      <p className="text-xs font-semibold text-primary">
                        {proposal.chainSyncedAt && proposal.requiredApprovals > 0
                          ? `${Math.min(100, Math.round((proposal.approvals / proposal.requiredApprovals) * 100))}%`
                          : "—"}
                      </p>
                    </div>
                    <div className="w-full h-2 bg-muted rounded-full overflow-hidden">
                      <div
                        className="h-full bg-gradient-to-r from-primary to-purple-500 transition-all duration-300"
                        style={{
                          width: `${proposal.chainSyncedAt && proposal.requiredApprovals > 0 ? Math.min(100, (proposal.approvals / proposal.requiredApprovals) * 100) : 0}%`,
                        }}
                      ></div>
                    </div>
                  </div>

                  <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
                    {allVoterList.map((member, idx) => (
                      <div
                        key={idx}
                        className="flex items-center justify-between p-2 rounded-lg bg-muted/30 border border-border/30 text-xs"
                      >
                        <div className="flex items-center gap-2">
                          <Avatar className="h-6 w-6">
                            <AvatarFallback className="text-[10px] bg-primary/20 text-primary">
                              {member.name[0]}
                            </AvatarFallback>
                          </Avatar>
                          <div>
                            <p className="font-medium">{member.name}</p>
                            <p className="text-[11px] text-muted-foreground font-mono">
                              {member.address.slice(0, 6)}...{member.address.slice(-4)}
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <Badge variant="outline" className="text-[10px]">
                            {t("vault.weightBadge", { weight: member.weight })}
                          </Badge>
                          {member.approved ? (
                            <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400 font-medium text-[11px]">
                              <Check className="h-3.5 w-3.5" /> {t("vault.signed")}
                            </span>
                          ) : member.rejected ? (
                            <span className="text-destructive">{t("vault.rejected")}</span>
                          ) : (
                            <span className="flex items-center gap-1 text-muted-foreground text-[11px]">
                              <Clock className="h-3.5 w-3.5" /> {t("vault.awaitingSignature")}
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </TabsContent>
              )}
            </AnimatePresence>
          </Tabs>

          {proposal.treasuryId ? <p className="break-all text-xs text-muted-foreground">{t("vault.treasuryBindingPrefix")}<span className="font-mono">{proposal.treasuryId}</span></p> : <p className="text-xs text-muted-foreground">{t("vault.legacyProposalNoBinding")}</p>}
          {executionPending.pending && <div role="status" className="space-y-2 rounded-lg border p-3 text-xs"><p className="break-all">{t("vault.executionPendingPrefix")}{executionPending.pending.digest || t("vault.noDigestFromWallet")}</p><Button size="sm" variant="outline" disabled={isExecuting} onClick={handleExecute}>{t("vault.lookupExecutionTx")}</Button></div>}
          {errorMessage && (
            <div role="alert" className="p-2 text-xs text-red-500 bg-red-500/10 border border-red-500/20 rounded-md">
              {errorMessage}
            </div>
          )}

          <DialogFooter className="pt-2">
            {canExecute ? (
              <Button
                onClick={handleExecute}
                disabled={isExecuting || !!executionPending.pending}
                className="w-full bg-gradient-to-r from-emerald-500 to-teal-600 hover:opacity-90 text-white font-medium"
              >
                {isExecuting ? t("vault.executingPtb") : (
                  <>
                    <Play className="h-4 w-4 mr-1.5" /> {t("vault.thresholdMetExecute")}
                  </>
                )}
              </Button>
            ) : canApprove ? (
              <div className="flex flex-col w-full gap-2.5">
                <Button
                  onClick={handleApprove}
                  disabled={isApproving || isRejecting || !userAddr}
                  className="w-full h-11 bg-primary hover:bg-primary/90 text-primary-foreground font-semibold shadow-sm text-sm"
                >
                  {isApproving ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin mr-2" />
                      {t("vault.signingVote")}
                    </>
                  ) : (
                    <>
                      <Check className="h-4 w-4 mr-1.5" /> {t("vault.approveAndSign")}
                    </>
                  )}
                </Button>
                {confirmReject ? (
                  <div className="flex items-center gap-2 p-2.5 rounded-xl bg-destructive/10 border border-destructive/20 animate-in fade-in duration-150">
                    <span className="text-xs text-destructive font-medium flex-1">确认拒绝签署此提案？</span>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={handleReject}
                      disabled={isApproving || isRejecting || !userAddr}
                      className="h-8 px-3 text-xs font-semibold"
                    >
                      {isRejecting ? t("vault.signingVote") : "确认拒绝"}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setConfirmReject(false)}
                      className="h-8 px-2.5 text-xs text-muted-foreground hover:text-foreground"
                    >
                      取消
                    </Button>
                  </div>
                ) : (
                  <Button
                    variant="ghost"
                    onClick={() => setConfirmReject(true)}
                    disabled={isApproving || isRejecting || !userAddr}
                    className="w-full h-9 text-xs text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                  >
                    <X className="h-3.5 w-3.5 mr-1" /> {t("vault.rejectButton")}
                  </Button>
                )}
              </div>
            ) : (
              <Button variant="outline" onClick={() => onOpenChange(false)} className="w-full">
                {t("vault.closeButton")}
              </Button>
            )}
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  )
}
