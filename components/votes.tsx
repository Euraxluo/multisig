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
  AlertCircle,
  CalendarClock,
  Plus,
} from "lucide-react"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { VoteDetailsDialog } from "@/components/vote-details-dialog"
import { CreateVoteDialog } from "@/components/create-vote-dialog"

export default function Votes() {
  const [selectedVote, setSelectedVote] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState("active")
  const [createVoteOpen, setCreateVoteOpen] = useState(false)
  const [customVotes, setCustomVotes] = useState<any[]>([])

  useEffect(() => {
    const load = () => {
      try {
        const stored = JSON.parse(localStorage.getItem("sui_governance_votes") || "[]")
        setCustomVotes(stored)
      } catch {}
    }
    load()
    window.addEventListener("sui-votes-updated", load)
    window.addEventListener("storage", load)
    return () => {
      window.removeEventListener("sui-votes-updated", load)
      window.removeEventListener("storage", load)
    }
  }, [])

  // 治理投票提案列表 (Governance Proposals)
  const defaultActiveVotes = [
    {
      id: "vote-1",
      title: "增加市场预算提案",
      description: "提议将每月市场预算从5000美元增加到8000美元",
      creator: "Alex",
      creatorAvatar: "/placeholder.svg?height=40&width=40",
      createdAt: "2025-03-10T12:00:00Z",
      expiresAt: "2025-04-01T12:00:00Z",
      voteType: "single",
      totalVotes: 5,
      myVote: null,
      status: "active",
      progress: {
        option1: 3,
        option2: 2,
      },
      group: "团队财务",
      isAnonymous: false,
      color: "from-green-500 to-emerald-400",
      showResultsDuring: true,
    },
    {
      id: "vote-2",
      title: "选择新的办公空间",
      description: "为团队选择新的办公空间位置",
      creator: "Jamie",
      creatorAvatar: "/placeholder.svg?height=40&width=40",
      createdAt: "2025-03-15T12:00:00Z",
      expiresAt: "2025-03-30T12:00:00Z",
      voteType: "ranked",
      totalVotes: 8,
      myVote: "已投票",
      status: "active",
      progress: {
        option1: 4,
        option2: 2,
        option3: 2,
      },
      group: "管理委员会",
      isAnonymous: true,
      color: "from-blue-500 to-cyan-400",
      showResultsDuring: false,
    },
    {
      id: "vote-3",
      title: "新产品功能优先级",
      description: "为下一季度确定产品功能开发优先级",
      creator: "Taylor",
      creatorAvatar: "/placeholder.svg?height=40&width=40",
      createdAt: "2025-03-18T12:00:00Z",
      expiresAt: "2025-03-28T12:00:00Z",
      voteType: "multiple",
      totalVotes: 12,
      myVote: null,
      status: "active",
      progress: {
        option1: 8,
        option2: 6,
        option3: 4,
        option4: 2,
      },
      group: "产品团队",
      isAnonymous: false,
      color: "from-primary to-purple-500",
      showResultsDuring: true,
    },
  ]

  const activeVotes = [...customVotes, ...defaultActiveVotes]

  const completedVotes = [
    {
      id: "vote-4",
      title: "聘请新的营销总监",
      description: "选择新的营销总监候选人",
      creator: "Alex",
      creatorAvatar: "/placeholder.svg?height=40&width=40",
      createdAt: "2025-02-01T12:00:00Z",
      endedAt: "2025-02-15T12:00:00Z",
      voteType: "single",
      totalVotes: 7,
      myVote: "已投票",
      status: "completed",
      result: "通过",
      winningOption: "Sarah Johnson",
      progress: {
        option1: 5,
        option2: 2,
      },
      group: "管理委员会",
      isAnonymous: false,
      color: "from-primary to-purple-500",
    },
    {
      id: "vote-5",
      title: "季度预算分配",
      description: "决定第二季度的预算分配方案",
      creator: "Jamie",
      creatorAvatar: "/placeholder.svg?height=40&width=40",
      createdAt: "2025-02-10T12:00:00Z",
      endedAt: "2025-02-25T12:00:00Z",
      voteType: "single",
      totalVotes: 9,
      myVote: "已投票",
      status: "completed",
      result: "方案B",
      winningOption: "方案B",
      progress: {
        option1: 3,
        option2: 6,
      },
      group: "团队财务",
      isAnonymous: true,
      color: "from-green-500 to-emerald-400",
    },
    {
      id: "vote-6",
      title: "新Logo设计选择",
      description: "为公司选择新的品牌Logo设计",
      creator: "Riley",
      creatorAvatar: "/placeholder.svg?height=40&width=40",
      createdAt: "2025-02-20T12:00:00Z",
      endedAt: "2025-03-05T12:00:00Z",
      voteType: "ranked",
      totalVotes: 15,
      myVote: "未投票",
      status: "completed",
      result: "设计C",
      winningOption: "设计C",
      progress: {
        option1: 5,
        option2: 4,
        option3: 6,
      },
      group: "设计团队",
      isAnonymous: false,
      color: "from-blue-500 to-cyan-400",
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

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString("zh-CN", {
      year: "numeric",
      month: "short",
      day: "numeric",
    })
  }

  const getVoteTypeIcon = (type: string) => {
    switch (type) {
      case "single":
        return <CheckCircle2 className="h-4 w-4" />
      case "multiple":
        return <BarChart2 className="h-4 w-4" />
      case "ranked":
        return <BarChart className="h-4 w-4" />
      default:
        return <Vote className="h-4 w-4" />
    }
  }

  const getVoteTypeText = (type: string) => {
    switch (type) {
      case "single":
        return "单选投票"
      case "multiple":
        return "多选投票"
      case "ranked":
        return "排序投票"
      default:
        return "投票"
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-xl font-bold">投票提案</h2>
        <Button
          variant="default"
          size="sm"
          className="bg-gradient-to-r from-primary to-purple-500 hover:from-primary/90 hover:to-purple-500/90"
          onClick={() => setCreateVoteOpen(true)}
        >
          <Plus className="h-4 w-4 mr-1" /> 创建投票
        </Button>
      </div>

      <Tabs defaultValue="active" value={activeTab} onValueChange={setActiveTab} className="w-full">
        <TabsList className="grid w-full grid-cols-2 p-1 bg-muted/50 rounded-xl">
          <TabsTrigger
            value="active"
            className="rounded-lg data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
          >
            <Clock className="h-4 w-4 mr-1.5" />
            进行中
          </TabsTrigger>
          <TabsTrigger
            value="completed"
            className="rounded-lg data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
          >
            <CheckCircle2 className="h-4 w-4 mr-1.5" />
            已结束
          </TabsTrigger>
        </TabsList>

        <AnimatePresence mode="wait">
          {activeTab === "active" && (
            <TabsContent value="active" className="mt-3 space-y-3">
              <motion.div variants={container} initial="hidden" animate="show" exit={{ opacity: 0 }}>
                {activeVotes.map((vote) => (
                  <motion.div key={vote.id} variants={item}>
                    <Card
                      className="overflow-hidden hover:shadow-md transition-all duration-300 border-none shadow-sm"
                      onClick={() => setSelectedVote(vote.id)}
                    >
                      <div className={`h-1 bg-gradient-to-r ${vote.color}`}></div>
                      <CardHeader className="p-3 pb-0">
                        <div className="flex items-start justify-between">
                          <div>
                            <h3 className="font-medium text-sm">{vote.title}</h3>
                            <p className="text-xs text-muted-foreground">{vote.group}</p>
                          </div>
                          <div className="flex items-center space-x-2">
                            {vote.isAnonymous ? (
                              <Badge variant="outline" className="text-xs">
                                <EyeOff className="h-3 w-3 mr-1" /> 匿名投票
                              </Badge>
                            ) : (
                              <Badge variant="outline" className="text-xs">
                                <Eye className="h-3 w-3 mr-1" /> 公开投票
                              </Badge>
                            )}
                            <Badge variant="default" className="text-xs">
                              进行中
                            </Badge>
                          </div>
                        </div>
                      </CardHeader>
                      <CardContent className="p-3 pt-2">
                        <div className="flex items-center justify-between mb-1.5 mt-1">
                          <div className="flex items-center text-xs text-muted-foreground">
                            {getVoteTypeIcon(vote.voteType)}
                            <span className="ml-1">{getVoteTypeText(vote.voteType)}</span>
                          </div>
                          <div className="flex items-center text-xs text-muted-foreground">
                            <UserCheck className="h-3 w-3 mr-1" />
                            <span>{vote.totalVotes} 已投票</span>
                          </div>
                        </div>

                        {vote.showResultsDuring && (
                          <div className="mt-2 space-y-1">
                            <div className="flex items-center justify-between text-xs">
                              <span>当前结果</span>
                              <span className="text-muted-foreground">选项数: {Object.keys(vote.progress).length}</span>
                            </div>
                            <Progress
                              value={(Math.max(...(Object.values(vote.progress) as number[])) / (vote.totalVotes || 1)) * 100}
                              className="h-1.5 rounded-full"
                              indicatorClassName={`bg-gradient-to-r ${vote.color}`}
                            />
                          </div>
                        )}

                        <div className="flex items-center justify-between mt-3">
                          <div className="flex items-center text-xs text-muted-foreground">
                            <CalendarClock className="h-3 w-3 mr-1" />
                            <span>截止日期: {formatDate(vote.expiresAt)}</span>
                          </div>
                          <div>
                            {vote.myVote ? (
                              <Badge variant="outline" className="text-xs">
                                <CheckCircle2 className="h-3 w-3 mr-1" /> 已投票
                              </Badge>
                            ) : (
                              <Button size="sm" className="h-7 text-xs">
                                投票
                              </Button>
                            )}
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  </motion.div>
                ))}
              </motion.div>
            </TabsContent>
          )}

          {activeTab === "completed" && (
            <TabsContent value="completed" className="mt-3 space-y-3">
              <motion.div variants={container} initial="hidden" animate="show" exit={{ opacity: 0 }}>
                {completedVotes.map((vote) => (
                  <motion.div key={vote.id} variants={item}>
                    <Card
                      className="overflow-hidden hover:shadow-md transition-all duration-300 border-none shadow-sm"
                      onClick={() => setSelectedVote(vote.id)}
                    >
                      <div className={`h-1 bg-gradient-to-r ${vote.color}`}></div>
                      <CardHeader className="p-3 pb-0">
                        <div className="flex items-start justify-between">
                          <div>
                            <h3 className="font-medium text-sm">{vote.title}</h3>
                            <p className="text-xs text-muted-foreground">{vote.group}</p>
                          </div>
                          <Badge variant="outline" className="text-xs">
                            已结束
                          </Badge>
                        </div>
                      </CardHeader>
                      <CardContent className="p-3 pt-2">
                        <div className="flex items-center justify-between mb-1.5 mt-1">
                          <div className="flex items-center text-xs text-muted-foreground">
                            {getVoteTypeIcon(vote.voteType)}
                            <span className="ml-1">{getVoteTypeText(vote.voteType)}</span>
                          </div>
                          <div className="flex items-center text-xs text-muted-foreground">
                            <UserCheck className="h-3 w-3 mr-1" />
                            <span>{vote.totalVotes} 参与</span>
                          </div>
                        </div>

                        <div className="p-2 bg-muted/50 rounded-lg my-2">
                          <div className="flex items-center justify-between">
                            <span className="text-xs font-medium">结果: {vote.result}</span>
                            {vote.myVote === "已投票" ? (
                              <Badge variant="outline" className="text-xs">
                                <CheckCircle2 className="h-3 w-3 mr-1" /> 已参与
                              </Badge>
                            ) : (
                              <Badge variant="outline" className="text-xs text-destructive border-destructive/50">
                                <AlertCircle className="h-3 w-3 mr-1" /> 未参与
                              </Badge>
                            )}
                          </div>
                        </div>

                        <div className="flex items-center justify-between mt-2">
                          <div className="flex items-center">
                            <Avatar className="h-6 w-6 mr-1.5">
                              <AvatarImage src={vote.creatorAvatar || "/placeholder.svg"} alt={vote.creator} />
                              <AvatarFallback>{vote.creator.charAt(0)}</AvatarFallback>
                            </Avatar>
                            <span className="text-xs">{vote.creator}</span>
                          </div>
                          <div className="text-xs text-muted-foreground">{formatDate(vote.endedAt)}</div>
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

      {/* 投票详情对话框 */}
      <VoteDetailsDialog open={!!selectedVote} onOpenChange={() => setSelectedVote(null)} voteId={selectedVote || ""} />

      {/* 创建投票对话框 */}
      <CreateVoteDialog open={createVoteOpen} onOpenChange={setCreateVoteOpen} />
    </div>
  )
}
