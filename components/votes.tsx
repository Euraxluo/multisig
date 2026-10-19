"use client"

import { useState, useEffect } from "react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { motion, AnimatePresence } from "framer-motion"
import {
  Clock,
  Vote,
  CheckCircle2,
  BarChart2,
  UserCheck,
  Eye,
  EyeOff,
  BarChart,
  CalendarClock,
  Plus,
  Play,
  Lock,
} from "lucide-react"
import { VoteDetailsDialog } from "@/components/vote-details-dialog"
import { CreateVoteDialog } from "@/components/create-vote-dialog"
import { getProposals, getActiveAccount, type ProposalItem } from "@/lib/onchain-store"

export default function Votes() {
  const [selectedVote, setSelectedVote] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState("active")
  const [createVoteOpen, setCreateVoteOpen] = useState(false)
  const [proposals, setProposals] = useState<ProposalItem[]>([])
  const [customVotes, setCustomVotes] = useState<any[]>([])

  useEffect(() => {
    const load = () => {
      setProposals(getProposals())
      try {
        const stored = JSON.parse(localStorage.getItem("sui_governance_votes") || "[]")
        setCustomVotes(stored)
      } catch {}
    }
    load()
    window.addEventListener("sui-proposals-updated", load)
    window.addEventListener("sui-votes-updated", load)
    window.addEventListener("storage", load)
    return () => {
      window.removeEventListener("sui-proposals-updated", load)
      window.removeEventListener("sui-votes-updated", load)
      window.removeEventListener("storage", load)
    }
  }, [])

  const currentAddress = getActiveAccount()?.address || ""

  // 将链上真实提案转换为治理投票视图
  const proposalVotes = proposals.map((p) => {
    const hasVoted = currentAddress ? p.voters.includes(currentAddress) : false
    const isCompleted = p.status === "executed" || p.status === "rejected"
    return {
      id: p.id,
      onChainId: p.onChainId,
      title: p.title,
      description: p.description || `${p.amount} ${p.token} 治理划转`,
      creator: p.voters[0] ? `${p.voters[0].slice(0, 6)}...` : "DAO 成员",
      createdAt: p.createdAt,
      expiresAt: p.expiresAt,
      endedAt: p.executedAt || p.expiresAt,
      voteType: "single",
      totalVotes: p.approvals,
      requiredApprovals: p.requiredApprovals,
      myVote: hasVoted ? "已投票" : null,
      status: isCompleted ? "completed" : "active",
      result: p.status === "executed" ? "已执行" : p.status === "approved" ? "已达法定票数" : "审批中",
      winningOption: "通过划款",
      progress: {
        "赞成": p.approvals,
        "门限目标": p.requiredApprovals,
      },
      group: p.groupName || "Team Treasury",
      isAnonymous: false,
      color: p.color || "from-primary to-purple-500",
      showResultsDuring: true,
      amount: p.amount,
      token: p.token,
    }
  })

  // 合并链上提案与自定义治理投票
  const allVotes = [...proposalVotes, ...customVotes]
  const activeVotes = allVotes.filter((v) => v.status === "active")
  const completedVotes = allVotes.filter((v) => v.status === "completed")

  const container = {
    hidden: { opacity: 0 },
    show: {
      opacity: 1,
      transition: {
        staggerChildren: 0.08,
      },
    },
  }

  const item = {
    hidden: { opacity: 0, y: 15 },
    show: { opacity: 1, y: 0 },
  }

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString("zh-CN", {
      year: "numeric",
      month: "short",
      day: "numeric",
    })
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between mb-2">
        <div>
          <h2 className="text-xl font-bold tracking-tight">治理投票与提案</h2>
          <p className="text-xs text-muted-foreground">Sui Move 异步投票、门限协签与影子跟投</p>
        </div>
        <Button
          variant="default"
          size="sm"
          className="bg-gradient-to-r from-primary to-purple-500 hover:opacity-90 shadow-sm"
          onClick={() => setCreateVoteOpen(true)}
        >
          <Plus className="h-4 w-4 mr-1" /> 新建提案
        </Button>
      </div>

      <Tabs defaultValue="active" value={activeTab} onValueChange={setActiveTab} className="w-full">
        <TabsList className="grid w-full grid-cols-2 p-1 bg-muted/50 rounded-xl">
          <TabsTrigger
            value="active"
            className="rounded-lg data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm text-xs font-medium"
          >
            <Clock className="h-3.5 w-3.5 mr-1.5" />
            进行中 ({activeVotes.length})
          </TabsTrigger>
          <TabsTrigger
            value="completed"
            className="rounded-lg data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm text-xs font-medium"
          >
            <CheckCircle2 className="h-3.5 w-3.5 mr-1.5" />
            已结束 ({completedVotes.length})
          </TabsTrigger>
        </TabsList>

        <AnimatePresence mode="wait">
          {activeTab === "active" && (
            <TabsContent value="active" className="mt-3 space-y-3">
              {activeVotes.length === 0 ? (
                <div className="text-center py-10 bg-muted/20 border border-dashed rounded-xl">
                  <Vote className="h-8 w-8 mx-auto text-muted-foreground/60 mb-2" />
                  <p className="text-sm font-medium">暂无进行中的治理提案</p>
                  <p className="text-xs text-muted-foreground mt-0.5">点击右上角「新建提案」发起治理投票</p>
                </div>
              ) : (
                <motion.div variants={container} initial="hidden" animate="show" exit={{ opacity: 0 }} className="space-y-3">
                  {activeVotes.map((vote) => (
                    <motion.div key={vote.id} variants={item}>
                      <Card
                        className="overflow-hidden hover:shadow-md transition-all duration-300 border-none shadow-sm cursor-pointer"
                        onClick={() => setSelectedVote(vote.id)}
                      >
                        <div className={`h-1 bg-gradient-to-r ${vote.color}`}></div>
                        <CardHeader className="p-3 pb-0">
                          <div className="flex items-start justify-between">
                            <div>
                              <h3 className="font-semibold text-sm">{vote.title}</h3>
                              <p className="text-xs text-muted-foreground">{vote.group}</p>
                            </div>
                            <div className="flex items-center space-x-1.5">
                              {vote.isTimeLockedSeal && (
                                <Badge variant="outline" className="text-[10px] bg-purple-500/10 text-purple-600 border-purple-500/20">
                                  <Lock className="h-2.5 w-2.5 mr-0.5" /> SEAL 盲投
                                </Badge>
                              )}
                              {vote.onChainId && (
                                <Badge variant="outline" className="text-[10px] bg-primary/10 text-primary border-primary/20">
                                  链上提案
                                </Badge>
                              )}
                              <Badge variant="default" className="text-xs">
                                进行中
                              </Badge>
                            </div>
                          </div>
                        </CardHeader>
                        <CardContent className="p-3 pt-2">
                          <p className="text-xs text-muted-foreground line-clamp-1 mb-2">{vote.description}</p>
                          <div className="flex items-center justify-between mb-1.5 mt-1">
                            <div className="flex items-center text-xs text-muted-foreground">
                              <CheckCircle2 className="h-3.5 w-3.5 mr-1 text-primary" />
                              <span>门限进度: {vote.totalVotes}/{vote.requiredApprovals || 2} 票</span>
                            </div>
                            <div className="flex items-center text-xs text-muted-foreground">
                              <UserCheck className="h-3.5 w-3.5 mr-1" />
                              <span>{vote.totalVotes} 成员已签署</span>
                            </div>
                          </div>

                          <div className="mt-2 space-y-1">
                            <div className="w-full h-1.5 bg-muted rounded-full overflow-hidden">
                              <div
                                className="h-full bg-gradient-to-r from-primary to-purple-500"
                                style={{
                                  width: `${Math.min(100, (vote.totalVotes / (vote.requiredApprovals || 2)) * 100)}%`,
                                }}
                              />
                            </div>
                          </div>

                          <div className="flex items-center justify-between mt-3">
                            <div className="flex items-center text-xs text-muted-foreground">
                              <CalendarClock className="h-3.5 w-3.5 mr-1" />
                              <span>截止: {formatDate(vote.expiresAt)}</span>
                            </div>
                            <div>
                              {vote.myVote ? (
                                <Badge variant="outline" className="text-xs bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20">
                                  <CheckCircle2 className="h-3 w-3 mr-1" /> 已投票
                                </Badge>
                              ) : (
                                <Button size="sm" className="h-7 text-xs bg-gradient-to-r from-primary to-purple-500 text-white">
                                  参与投票 / 影子跟投
                                </Button>
                              )}
                            </div>
                          </div>
                        </CardContent>
                      </Card>
                    </motion.div>
                  ))}
                </motion.div>
              )}
            </TabsContent>
          )}

          {activeTab === "completed" && (
            <TabsContent value="completed" className="mt-3 space-y-3">
              {completedVotes.length === 0 ? (
                <div className="text-center py-10 bg-muted/20 border border-dashed rounded-xl">
                  <CheckCircle2 className="h-8 w-8 mx-auto text-muted-foreground/60 mb-2" />
                  <p className="text-sm font-medium">暂无已结束的治理记录</p>
                </div>
              ) : (
                <motion.div variants={container} initial="hidden" animate="show" exit={{ opacity: 0 }} className="space-y-3">
                  {completedVotes.map((vote) => (
                    <motion.div key={vote.id} variants={item}>
                      <Card
                        className="overflow-hidden hover:shadow-md transition-all duration-300 border-none shadow-sm cursor-pointer"
                        onClick={() => setSelectedVote(vote.id)}
                      >
                        <div className={`h-1 bg-gradient-to-r ${vote.color}`}></div>
                        <CardHeader className="p-3 pb-0">
                          <div className="flex items-start justify-between">
                            <div>
                              <h3 className="font-semibold text-sm">{vote.title}</h3>
                              <p className="text-xs text-muted-foreground">{vote.group}</p>
                            </div>
                            <Badge
                              variant="outline"
                              className={
                                vote.result === "已执行"
                                  ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20 text-xs"
                                  : "bg-muted text-muted-foreground text-xs"
                              }
                            >
                              {vote.result || "已结项"}
                            </Badge>
                          </div>
                        </CardHeader>
                        <CardContent className="p-3 pt-2">
                          <p className="text-xs text-muted-foreground line-clamp-1 mb-2">{vote.description}</p>
                          <div className="flex items-center justify-between text-xs text-muted-foreground">
                            <span>最终票数: {vote.totalVotes} 票</span>
                            <span>归档时间: {formatDate(vote.endedAt || vote.expiresAt)}</span>
                          </div>
                        </CardContent>
                      </Card>
                    </motion.div>
                  ))}
                </motion.div>
              )}
            </TabsContent>
          )}
        </AnimatePresence>
      </Tabs>

      <VoteDetailsDialog
        open={!!selectedVote}
        onOpenChange={() => setSelectedVote(null)}
        voteId={selectedVote || ""}
      />

      <CreateVoteDialog open={createVoteOpen} onOpenChange={setCreateVoteOpen} />
    </div>
  )
}
