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
  Play,
  ShieldCheck,
} from "lucide-react"
import { useState, useEffect } from "react"
import { motion, AnimatePresence } from "framer-motion"
import {
  getProposals,
  approveProposal,
  rejectProposal,
  executeProposal,
  getActiveAccount,
  type ProposalItem,
} from "@/lib/onchain-store"
import { getCachedDevAccounts } from "@/lib/dev-keystore"

interface TransactionDetailsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  transactionId: string
  groupId?: string
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
  const [isExecuting, setIsExecuting] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [proposal, setProposal] = useState<ProposalItem | null>(null)

  useEffect(() => {
    if (!open) {
      setErrorMessage(null)
      return
    }
    const loadProposal = () => {
      const all = getProposals()
      const found = all.find((p) => p.id === transactionId || p.onChainId === transactionId)
      if (found) {
        setProposal(found)
      } else if (all.length > 0) {
        setProposal(all[0])
      }
    }
    loadProposal()
    window.addEventListener("sui-proposals-updated", loadProposal)
    return () => window.removeEventListener("sui-proposals-updated", loadProposal)
  }, [open, transactionId])

  if (!proposal) {
    return null
  }

  const activeAccount = getActiveAccount()
  const userAddr = activeAccount?.address || ""
  const hasVoted = userAddr ? proposal.voters.includes(userAddr) : false
  const canApprove = proposal.status === "pending" && !hasVoted
  const canExecute = proposal.status === "approved" || (proposal.status === "pending" && proposal.approvals >= proposal.requiredApprovals)

  const handleApprove = async () => {
    setErrorMessage(null)
    setIsApproving(true)
    try {
      await approveProposal(proposal.id)
    } catch (e: any) {
      setErrorMessage(e.message || "Approve failed")
    } finally {
      setIsApproving(false)
    }
  }

  const handleReject = async () => {
    setErrorMessage(null)
    setIsRejecting(true)
    try {
      await rejectProposal(proposal.id)
      onOpenChange(false)
    } catch (e: any) {
      setErrorMessage(e.message || "Reject failed")
    } finally {
      setIsRejecting(false)
    }
  }

  const handleExecute = async () => {
    setErrorMessage(null)
    setIsExecuting(true)
    try {
      const res = await executeProposal(proposal.id)
      if (res.digest) {
        setProposal((prev) => (prev ? { ...prev, status: "executed", executionDigest: res.digest } : null))
      }
    } catch (e: any) {
      setErrorMessage(e.message || "Execute failed")
    } finally {
      setIsExecuting(false)
    }
  }

  const formatDate = (dateString?: string) => {
    if (!dateString) return "N/A"
    return new Date(dateString).toLocaleString()
  }

  // 计算投票者名册展示
  const knownAccounts = getCachedDevAccounts()
  const memberVotes = knownAccounts.map((acc) => {
    const isVoter = proposal.voters.includes(acc.address)
    return {
      name: acc.name,
      address: acc.address,
      approved: isVoter,
      weight: 1,
    }
  })

  // 确保列表包含真实已有投票者
  const extraVoters = proposal.voters
    .filter((v) => !knownAccounts.some((a) => a.address === v))
    .map((v) => ({
      name: v === userAddr ? "当前账户 (You)" : `${v.slice(0, 6)}...${v.slice(-4)}`,
      address: v,
      approved: true,
      weight: 1,
    }))

  const allVoterList = [...extraVoters, ...memberVotes.filter((mv) => !proposal.voters.includes(mv.address))]

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px] p-0 gap-0 overflow-hidden bg-background">
        <div className={`h-24 bg-gradient-to-r ${proposal.color || "from-primary to-purple-500"} p-4 flex flex-col justify-end text-white`}>
          <DialogHeader className="text-white">
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
                    ? "bg-emerald-500/30 text-emerald-100 border-emerald-400/40"
                    : proposal.status === "rejected"
                      ? "bg-destructive/40 text-destructive-foreground border-destructive/50"
                      : "bg-white/20 text-white border-white/40"
                }
              >
                {proposal.status === "executed"
                  ? "已执行"
                  : proposal.status === "approved"
                    ? "已批准 (待划转)"
                    : proposal.status === "rejected"
                      ? "已否决"
                      : "审批中"}
              </Badge>
            </DialogTitle>
            <p className="text-white/80 text-xs mt-1 truncate">{proposal.description}</p>
          </DialogHeader>
        </div>

        <div className="p-4 space-y-4">
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
                {proposal.amount} {proposal.token}
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
                  {proposal.type === "transfer" ? "金库原生转账" : "合约交互调用"}
                </span>
              </div>
              {proposal.onChainId && (
                <Badge variant="outline" className="text-[10px] font-mono">
                  链上共享对象: {proposal.onChainId.slice(0, 6)}...
                </Badge>
              )}
            </div>

            <div className="mt-2 flex items-center text-xs">
              <div className="flex-1">
                <p className="text-muted-foreground">出款金库</p>
                <p className="font-medium truncate">{proposal.groupName}</p>
              </div>
              <ArrowRight className="h-4 w-4 mx-2 text-muted-foreground" />
              <div className="flex-1">
                <p className="text-muted-foreground">收款地址</p>
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
                详细参数
              </TabsTrigger>
              <TabsTrigger
                value="approvals"
                className="rounded-lg data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm text-xs"
              >
                <Check className="h-3.5 w-3.5 mr-1.5" />
                审批名册 ({proposal.approvals}/{proposal.requiredApprovals})
              </TabsTrigger>
            </TabsList>

            <AnimatePresence mode="wait">
              {activeTab === "details" && (
                <TabsContent value="details" className="mt-3 space-y-3">
                  <div className="space-y-2.5 text-xs">
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <p className="text-muted-foreground">提案金额</p>
                        <p className="font-semibold text-foreground text-sm">
                          {proposal.amount} {proposal.token}
                        </p>
                      </div>
                      <div>
                        <p className="text-muted-foreground">链上网络</p>
                        <p className="font-semibold text-foreground text-sm">Sui Testnet (v3)</p>
                      </div>
                    </div>

                    <div>
                      <p className="text-muted-foreground">收款地址 (Recipient)</p>
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
                        <p className="text-muted-foreground">提案创建凭证 (Tx Digest)</p>
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

                    {proposal.executionDigest && (
                      <div className="p-2.5 bg-emerald-500/10 border border-emerald-500/20 rounded-lg">
                        <p className="text-emerald-600 dark:text-emerald-400 font-semibold flex items-center gap-1">
                          <ShieldCheck className="h-3.5 w-3.5" /> 金库划款执行凭证 (Execution Tx)
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

                    <div className="grid grid-cols-2 gap-2 pt-1 border-t border-border/40">
                      <div>
                        <p className="text-muted-foreground">创建时间</p>
                        <p className="font-medium text-foreground">{formatDate(proposal.createdAt)}</p>
                      </div>
                      <div>
                        <p className="text-muted-foreground">失效截至</p>
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
                        审批进度: {proposal.approvals}/{proposal.requiredApprovals} 门限权重
                      </p>
                      <p className="text-xs font-semibold text-primary">
                        {Math.min(100, Math.round((proposal.approvals / proposal.requiredApprovals) * 100))}%
                      </p>
                    </div>
                    <div className="w-full h-2 bg-muted rounded-full overflow-hidden">
                      <div
                        className="h-full bg-gradient-to-r from-primary to-purple-500 transition-all duration-300"
                        style={{
                          width: `${Math.min(100, (proposal.approvals / proposal.requiredApprovals) * 100)}%`,
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
                            权重 1
                          </Badge>
                          {member.approved ? (
                            <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400 font-medium text-[11px]">
                              <Check className="h-3.5 w-3.5" /> 已签署
                            </span>
                          ) : (
                            <span className="flex items-center gap-1 text-muted-foreground text-[11px]">
                              <Clock className="h-3.5 w-3.5" /> 待签
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

          {errorMessage && (
            <div className="p-2 text-xs text-red-500 bg-red-500/10 border border-red-500/20 rounded-md">
              {errorMessage}
            </div>
          )}

          <DialogFooter className="pt-2">
            {canExecute ? (
              <Button
                onClick={handleExecute}
                disabled={isExecuting}
                className="w-full bg-gradient-to-r from-emerald-500 to-teal-600 hover:opacity-90 text-white font-medium"
              >
                {isExecuting ? "正在执行链上国库转账 PTB..." : (
                  <>
                    <Play className="h-4 w-4 mr-1.5" /> 门限已达成 · 执行国库转账
                  </>
                )}
              </Button>
            ) : canApprove ? (
              <div className="flex w-full gap-2">
                <Button
                  variant="outline"
                  onClick={handleReject}
                  disabled={isApproving || isRejecting}
                  className="flex-1"
                >
                  <X className="h-4 w-4 mr-1" /> 否决
                </Button>
                <Button
                  onClick={handleApprove}
                  disabled={isApproving || isRejecting}
                  className="flex-1 bg-gradient-to-r from-primary to-purple-500 hover:opacity-90 text-white"
                >
                  {isApproving ? "正在钱包签名投票..." : (
                    <>
                      <Check className="h-4 w-4 mr-1" /> 同意并签名投票
                    </>
                  )}
                </Button>
              </div>
            ) : (
              <Button variant="outline" onClick={() => onOpenChange(false)} className="w-full">
                关闭
              </Button>
            )}
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  )
}
