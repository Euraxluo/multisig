"use client"

import { useState, useEffect } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Check,
  BarChart2,
  UserCheck,
  Clock,
  Calendar,
  Eye,
  EyeOff,
  Share2,
  PanelRight,
  Vote,
  LinkIcon,
} from "lucide-react"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { DragDropContext, Droppable, Draggable } from "@hello-pangea/dnd"
import { cn } from "@/lib/utils"
import { motion, AnimatePresence } from "framer-motion"

// 类型定义
interface VoteOption {
  id: string
  text: string
  votes: number
  percentage: number
}

interface Voter {
  id: string
  name: string
  avatar?: string
  voted: boolean
  votedFor?: string
  timestamp?: string
  weight: number
}

interface VoteDetailsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  voteId: string
}

export function VoteDetailsDialog({ open, onOpenChange, voteId }: VoteDetailsDialogProps) {
  const [activeTab, setActiveTab] = useState("details")
  const [selectedOption, setSelectedOption] = useState<string | null>(null)
  const [selectedOptions, setSelectedOptions] = useState<string[]>([])
  const [rankedOptions, setRankedOptions] = useState<VoteOption[]>([])
  const [isVoting, setIsVoting] = useState(false)
  const [hasVoted, setHasVoted] = useState(false)
  const [showResults, setShowResults] = useState(false)
  const [voteData, setVoteData] = useState<any>(null)

  // 加载投票数据 - 在实际应用中从API获取
  useEffect(() => {
    if (open && voteId) {
      // 模拟从API获取数据的过程
      setTimeout(() => {
        const mockVoteData = getMockVoteData(voteId)
        setVoteData(mockVoteData)

        // 设置已经投票的状态
        if (mockVoteData?.myVote) {
          setHasVoted(true)

          if (mockVoteData.voteType === "single") {
            setSelectedOption(mockVoteData.myVote.optionId)
          } else if (mockVoteData.voteType === "multiple") {
            setSelectedOptions(mockVoteData.myVote.optionIds || [])
          } else if (mockVoteData.voteType === "ranked") {
            setRankedOptions(mockVoteData.options)
          }
        } else {
          setHasVoted(false)

          // 初始化投票选项状态
          if (mockVoteData?.voteType === "ranked" && mockVoteData?.options) {
            setRankedOptions([...mockVoteData.options])
          }
        }

        // 是否显示结果
        if (mockVoteData?.status === "completed" || mockVoteData?.showResultsDuring) {
          setShowResults(true)
        } else {
          setShowResults(false)
        }
      }, 300)
    } else {
      // 重置状态
      setVoteData(null)
      setSelectedOption(null)
      setSelectedOptions([])
      setRankedOptions([])
      setIsVoting(false)
      setHasVoted(false)
      setShowResults(false)
      setActiveTab("details")
    }
  }, [open, voteId])

  const getMockVoteData = (id: string) => {
    // 这里模拟从API返回的数据
    const mockVoteOptions: VoteOption[] = [
      { id: "option-1", text: "增加预算到8000美元", votes: 3, percentage: 60 },
      { id: "option-2", text: "维持当前预算", votes: 2, percentage: 40 },
    ]

    const voters: Voter[] = [
      {
        id: "user-1",
        name: "Alex",
        avatar: "/placeholder.svg?height=40&width=40",
        voted: true,
        votedFor: "option-1",
        timestamp: "2025-03-20T10:15:00Z",
        weight: 1,
      },
      {
        id: "user-2",
        name: "Jamie",
        avatar: "/placeholder.svg?height=40&width=40",
        voted: true,
        votedFor: "option-1",
        timestamp: "2025-03-21T11:20:00Z",
        weight: 1,
      },
      {
        id: "user-3",
        name: "Taylor",
        avatar: "/placeholder.svg?height=40&width=40",
        voted: true,
        votedFor: "option-1",
        timestamp: "2025-03-21T14:30:00Z",
        weight: 1,
      },
      {
        id: "user-4",
        name: "Morgan",
        avatar: "/placeholder.svg?height=40&width=40",
        voted: true,
        votedFor: "option-2",
        timestamp: "2025-03-22T09:45:00Z",
        weight: 1,
      },
      {
        id: "user-5",
        name: "Riley",
        avatar: "/placeholder.svg?height=40&width=40",
        voted: true,
        votedFor: "option-2",
        timestamp: "2025-03-22T16:10:00Z",
        weight: 1,
      },
      { id: "user-6", name: "Casey", avatar: "/placeholder.svg?height=40&width=40", voted: false, weight: 1 },
      { id: "user-7", name: "Sam", avatar: "/placeholder.svg?height=40&width=40", voted: false, weight: 1 },
    ]

    return {
      id,
      title: "增加市场预算提案",
      description:
        "提议将每月市场预算从5000美元增加到8000美元，以支持新的市场活动和更广泛的受众覆盖。增加的预算将用于社交媒体广告、影响者营销和内容创作。",
      creator: {
        id: "user-1",
        name: "Alex",
        avatar: "/placeholder.svg?height=40&width=40",
      },
      createdAt: "2025-03-10T12:00:00Z",
      expiresAt: "2025-04-01T12:00:00Z",
      voteType: "single", // single, multiple, ranked
      options: mockVoteOptions,
      voters,
      totalVotes: 5,
      myVote: null, // 如果用户已投票，这将包含他们的选择
      status: "active", // active, completed
      group: "团队财务",
      isAnonymous: false,
      showResultsDuring: true,
      color: "from-green-500 to-emerald-400",
      weights: {
        total: 7,
        voted: 5,
        required: 4,
      },
    }
  }

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleString("zh-CN", {
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    })
  }

  const handleSingleVote = () => {
    if (!selectedOption) return

    setIsVoting(true)

    // 模拟API调用
    setTimeout(() => {
      setIsVoting(false)
      setHasVoted(true)

      // 更新投票数据
      if (voteData) {
        const updatedVoteData = { ...voteData }
        updatedVoteData.myVote = { optionId: selectedOption }
        updatedVoteData.totalVotes += 1

        // 更新选项的投票数
        updatedVoteData.options = updatedVoteData.options.map((opt: VoteOption) => {
          if (opt.id === selectedOption) {
            return { ...opt, votes: opt.votes + 1 }
          }
          return opt
        })

        // 重新计算百分比
        const totalVotes = updatedVoteData.options.reduce((acc: number, opt: VoteOption) => acc + opt.votes, 0)
        updatedVoteData.options = updatedVoteData.options.map((opt: VoteOption) => ({
          ...opt,
          percentage: Math.round((opt.votes / totalVotes) * 100),
        }))

        setVoteData(updatedVoteData)

        if (updatedVoteData.showResultsDuring) {
          setShowResults(true)
        }
      }
    }, 1000)
  }

  const handleMultipleVote = () => {
    if (selectedOptions.length === 0) return

    setIsVoting(true)

    // 模拟API调用
    setTimeout(() => {
      setIsVoting(false)
      setHasVoted(true)

      // 更新投票数据
      if (voteData) {
        const updatedVoteData = { ...voteData }
        updatedVoteData.myVote = { optionIds: selectedOptions }
        updatedVoteData.totalVotes += 1

        // 更新选项的投票数
        updatedVoteData.options = updatedVoteData.options.map((opt: VoteOption) => {
          if (selectedOptions.includes(opt.id)) {
            return { ...opt, votes: opt.votes + 1 }
          }
          return opt
        })

        // 重新计算百分比
        const totalVotes = updatedVoteData.options.reduce((acc: number, opt: VoteOption) => acc + opt.votes, 0)
        updatedVoteData.options = updatedVoteData.options.map((opt: VoteOption) => ({
          ...opt,
          percentage: Math.round((opt.votes / totalVotes) * 100),
        }))

        setVoteData(updatedVoteData)

        if (updatedVoteData.showResultsDuring) {
          setShowResults(true)
        }
      }
    }, 1000)
  }

  const handleRankedVote = () => {
    if (rankedOptions.length === 0) return

    setIsVoting(true)

    // 模拟API调用
    setTimeout(() => {
      setIsVoting(false)
      setHasVoted(true)

      // 更新投票数据
      if (voteData) {
        const updatedVoteData = { ...voteData }
        updatedVoteData.myVote = { rankedOptions: rankedOptions.map((opt) => opt.id) }
        updatedVoteData.totalVotes += 1

        // 在真实应用中，这里会有更复杂的排序计分逻辑
        setVoteData(updatedVoteData)

        if (updatedVoteData.showResultsDuring) {
          setShowResults(true)
        }
      }
    }, 1000)
  }

  const handleDragEnd = (result: any) => {
    if (!result.destination) return

    const items = Array.from(rankedOptions)
    const [reorderedItem] = items.splice(result.source.index, 1)
    items.splice(result.destination.index, 0, reorderedItem)

    setRankedOptions(items)
  }

  // 渲染投票选项的不同视图
  const renderVoteOptions = () => {
    if (!voteData) return null

    switch (voteData.voteType) {
      case "single":
        return (
          <RadioGroup
            value={selectedOption || ""}
            onValueChange={setSelectedOption}
            className="space-y-2"
            disabled={hasVoted || isVoting}
          >
            {voteData.options.map((option: VoteOption) => (
              <div key={option.id} className="flex items-center space-x-2">
                <RadioGroupItem value={option.id} id={option.id} />
                <Label htmlFor={option.id} className="flex-1">
                  {option.text}
                </Label>
                {showResults && (
                  <div className="flex items-center text-xs">
                    <span className="font-medium mr-1">{option.votes}</span>
                    <span className="text-muted-foreground">({option.percentage}%)</span>
                  </div>
                )}
              </div>
            ))}
          </RadioGroup>
        )

      case "multiple":
        return (
          <div className="space-y-2">
            {voteData.options.map((option: VoteOption) => (
              <div key={option.id} className="flex items-center space-x-2">
                <Checkbox
                  id={option.id}
                  checked={selectedOptions.includes(option.id)}
                  onCheckedChange={(checked) => {
                    if (checked) {
                      setSelectedOptions([...selectedOptions, option.id])
                    } else {
                      setSelectedOptions(selectedOptions.filter((id) => id !== option.id))
                    }
                  }}
                  disabled={hasVoted || isVoting}
                />
                <Label htmlFor={option.id} className="flex-1">
                  {option.text}
                </Label>
                {showResults && (
                  <div className="flex items-center text-xs">
                    <span className="font-medium mr-1">{option.votes}</span>
                    <span className="text-muted-foreground">({option.percentage}%)</span>
                  </div>
                )}
              </div>
            ))}
          </div>
        )

      case "ranked":
        return (
          <DragDropContext onDragEnd={handleDragEnd}>
            <Droppable droppableId="ranked-options">
              {(provided) => (
                <div {...provided.droppableProps} ref={provided.innerRef} className="space-y-2">
                  {rankedOptions.map((option, index) => (
                    <Draggable
                      key={option.id}
                      draggableId={option.id}
                      index={index}
                      isDragDisabled={hasVoted || isVoting}
                    >
                      {(provided, snapshot) => (
                        <div
                          ref={provided.innerRef}
                          {...provided.draggableProps}
                          {...provided.dragHandleProps}
                          className={cn(
                            "p-3 rounded-lg border flex items-center",
                            snapshot.isDragging ? "bg-accent" : "bg-background",
                          )}
                        >
                          <div className="w-6 h-6 flex items-center justify-center bg-primary/10 rounded-full text-xs font-medium mr-3">
                            {index + 1}
                          </div>
                          <span className="flex-1">{option.text}</span>
                          {showResults && (
                            <div className="flex items-center text-xs">
                              <span className="font-medium mr-1">{option.votes}</span>
                              <span className="text-muted-foreground">({option.percentage}%)</span>
                            </div>
                          )}
                        </div>
                      )}
                    </Draggable>
                  ))}
                  {provided.placeholder}
                </div>
              )}
            </Droppable>
          </DragDropContext>
        )

      default:
        return null
    }
  }

  // 渲染投票结果
  const renderVoteResults = () => {
    if (!voteData || !showResults) return null

    return (
      <div className="space-y-3">
        {voteData.options.map((option: VoteOption) => (
          <div key={option.id} className="space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-sm">{option.text}</span>
              <span className="text-sm font-medium">{option.percentage}%</span>
            </div>
            <div className="w-full h-2 bg-muted rounded-full overflow-hidden">
              <motion.div
                initial={{ width: 0 }}
                animate={{ width: `${option.percentage}%` }}
                transition={{ duration: 0.5, ease: "easeOut" }}
                className={`h-full ${
                  option.percentage >= 50
                    ? "bg-gradient-to-r from-green-500 to-emerald-400"
                    : "bg-gradient-to-r from-primary to-purple-500"
                }`}
              />
            </div>
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>{option.votes} 票</span>
              {voteData?.myVote?.optionId === option.id && (
                <Badge variant="outline" className="text-xs border-primary/30 text-primary">
                  <Check className="h-3 w-3 mr-1" /> 我的选择
                </Badge>
              )}
            </div>
          </div>
        ))}

        <div className="p-3 rounded-lg bg-muted/30 mt-2 space-y-1">
          <div className="flex items-center justify-between text-sm">
            <span>总参与人数</span>
            <span className="font-medium">{voteData.totalVotes} 人</span>
          </div>
          <div className="flex items-center justify-between text-sm">
            <span>总投票权重</span>
            <span className="font-medium">
              {voteData.weights.voted} / {voteData.weights.total}
            </span>
          </div>
          <div className="flex items-center justify-between text-sm">
            <span>所需权重</span>
            <span className="font-medium">
              {voteData.weights.required} ({Math.round((voteData.weights.required / voteData.weights.total) * 100)}%)
            </span>
          </div>
        </div>
      </div>
    )
  }

  const renderVoteButton = () => {
    if (hasVoted) {
      return (
        <Button
          variant="outline"
          className="w-full flex items-center justify-center"
          onClick={() => onOpenChange(false)}
        >
          <Check className="h-4 w-4 mr-1.5" /> 已投票
        </Button>
      )
    }

    switch (voteData?.voteType) {
      case "single":
        return (
          <Button
            className="w-full bg-gradient-to-r from-primary to-purple-500 hover:from-primary/90 hover:to-purple-500/90"
            disabled={!selectedOption || isVoting}
            onClick={handleSingleVote}
          >
            {isVoting ? (
              <>
                <div className="animate-spin mr-2 h-4 w-4 border-2 border-current border-t-transparent rounded-full" />
                处理中...
              </>
            ) : (
              <>
                <Vote className="h-4 w-4 mr-1.5" /> 提交投票
              </>
            )}
          </Button>
        )

      case "multiple":
        return (
          <Button
            className="w-full bg-gradient-to-r from-primary to-purple-500 hover:from-primary/90 hover:to-purple-500/90"
            disabled={selectedOptions.length === 0 || isVoting}
            onClick={handleMultipleVote}
          >
            {isVoting ? (
              <>
                <div className="animate-spin mr-2 h-4 w-4 border-2 border-current border-t-transparent rounded-full" />
                处理中...
              </>
            ) : (
              <>
                <Vote className="h-4 w-4 mr-1.5" /> 提交多选投票
              </>
            )}
          </Button>
        )

      case "ranked":
        return (
          <Button
            className="w-full bg-gradient-to-r from-primary to-purple-500 hover:from-primary/90 hover:to-purple-500/90"
            disabled={isVoting}
            onClick={handleRankedVote}
          >
            {isVoting ? (
              <>
                <div className="animate-spin mr-2 h-4 w-4 border-2 border-current border-t-transparent rounded-full" />
                处理中...
              </>
            ) : (
              <>
                <Vote className="h-4 w-4 mr-1.5" /> 提交排序投票
              </>
            )}
          </Button>
        )

      default:
        return null
    }
  }

  // 渲染选民列表
  const renderVoters = () => {
    if (!voteData) return null

    // 如果是匿名投票且还没结束，则隐藏详情
    if (voteData.isAnonymous && voteData.status !== "completed") {
      return (
        <div className="flex flex-col items-center justify-center p-6 text-center">
          <EyeOff className="h-10 w-10 text-muted-foreground mb-3" />
          <h3 className="text-sm font-medium mb-1">这是匿名投票</h3>
          <p className="text-xs text-muted-foreground">投票结束前不显示选民详情。这确保了投票过程的公正性和隐私。</p>
        </div>
      )
    }

    return (
      <ScrollArea className="h-[300px] pr-4">
        <div className="space-y-2">
          {voteData.voters.map((voter: Voter) => (
            <div
              key={voter.id}
              className="flex items-center justify-between p-2 rounded-lg hover:bg-muted/50 transition-colors"
            >
              <div className="flex items-center">
                <Avatar className="h-8 w-8 mr-3">
                  <AvatarImage src={voter.avatar || "/placeholder.svg"} alt={voter.name} />
                  <AvatarFallback>{voter.name.charAt(0)}</AvatarFallback>
                </Avatar>
                <div>
                  <p className="text-sm font-medium">{voter.name}</p>
                  {voter.voted && voter.timestamp && (
                    <p className="text-xs text-muted-foreground">
                      投票时间: {new Date(voter.timestamp).toLocaleDateString()}
                    </p>
                  )}
                </div>
              </div>
              <div>
                {voter.voted ? (
                  <Badge variant="outline" className="text-xs border-green-500/30 text-green-500">
                    <Check className="h-3 w-3 mr-1" /> 已投票
                  </Badge>
                ) : (
                  <Badge variant="outline" className="text-xs">
                    <Clock className="h-3 w-3 mr-1" /> 待投票
                  </Badge>
                )}
              </div>
            </div>
          ))}
        </div>
      </ScrollArea>
    )
  }

  if (!voteData) {
    return null
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px] p-0 gap-0 overflow-hidden">
        <div className={`h-24 bg-gradient-to-r ${voteData.color} p-4 flex flex-col justify-end`}>
          <DialogHeader className="text-white">
            <DialogTitle className="flex items-center justify-between">
              <span className="text-xl">{voteData.title}</span>
              <Badge variant="outline" className="bg-white/20 text-white border-white/40">
                {voteData.status === "completed" ? "已结束" : "进行中"}
              </Badge>
            </DialogTitle>
            <div className="flex items-center text-white/80 text-sm mt-1">
              <Calendar className="h-3.5 w-3.5 mr-1" />
              {formatDate(voteData.expiresAt)}
            </div>
          </DialogHeader>
        </div>

        <div className="p-4">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center">
              <Avatar className="h-10 w-10 mr-3 border-2 border-background">
                <AvatarImage src={voteData.creator.avatar || "/placeholder.svg"} alt={voteData.creator.name} />
                <AvatarFallback>{voteData.creator.name.charAt(0)}</AvatarFallback>
              </Avatar>
              <div>
                <p className="text-sm font-medium">{voteData.creator.name}</p>
                <p className="text-xs text-muted-foreground">发起人</p>
              </div>
            </div>
            <div className="flex items-center space-x-2">
              {voteData.isAnonymous ? (
                <Badge variant="outline" className="text-xs">
                  <EyeOff className="h-3 w-3 mr-1" /> 匿名投票
                </Badge>
              ) : (
                <Badge variant="outline" className="text-xs">
                  <Eye className="h-3 w-3 mr-1" /> 公开投票
                </Badge>
              )}
              <Badge variant="outline" className="text-xs">
                {voteData.voteType === "single"
                  ? "单选投票"
                  : voteData.voteType === "multiple"
                    ? "多选投票"
                    : "排序投票"}
              </Badge>
            </div>
          </div>

          <div className="mb-4">
            <p className="text-sm">{voteData.description}</p>
          </div>

          <Tabs defaultValue="details" value={activeTab} onValueChange={setActiveTab} className="w-full">
            <TabsList className="grid w-full grid-cols-3 p-1 bg-muted/50 rounded-xl">
              <TabsTrigger
                value="details"
                className="rounded-lg data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
              >
                <Vote className="h-4 w-4 mr-1.5" />
                投票
              </TabsTrigger>
              <TabsTrigger
                value="results"
                className="rounded-lg data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
              >
                <BarChart2 className="h-4 w-4 mr-1.5" />
                结果
              </TabsTrigger>
              <TabsTrigger
                value="voters"
                className="rounded-lg data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
              >
                <UserCheck className="h-4 w-4 mr-1.5" />
                选民
              </TabsTrigger>
            </TabsList>

            <AnimatePresence mode="wait">
              {activeTab === "details" && (
                <TabsContent value="details" className="mt-4 space-y-2">
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    transition={{ duration: 0.2 }}
                  >
                    {renderVoteOptions()}
                  </motion.div>
                </TabsContent>
              )}

              {activeTab === "results" && (
                <TabsContent value="results" className="mt-4 space-y-2">
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    transition={{ duration: 0.2 }}
                  >
                    {showResults ? (
                      renderVoteResults()
                    ) : (
                      <div className="flex flex-col items-center justify-center p-6 text-center">
                        <EyeOff className="h-10 w-10 text-muted-foreground mb-3" />
                        <h3 className="text-sm font-medium mb-1">结果暂不可见</h3>
                        <p className="text-xs text-muted-foreground">根据投票设置，结果将在投票结束后公布。</p>
                      </div>
                    )}
                  </motion.div>
                </TabsContent>
              )}

              {activeTab === "voters" && (
                <TabsContent value="voters" className="mt-4 space-y-2">
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    transition={{ duration: 0.2 }}
                  >
                    {renderVoters()}
                  </motion.div>
                </TabsContent>
              )}
            </AnimatePresence>
          </Tabs>
        </div>

        <div className="p-4 border-t">
          <div className="flex justify-between mb-4">
            <Button variant="outline" size="sm" className="gap-1">
              <PanelRight className="h-3.5 w-3.5" /> 讨论
            </Button>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" className="gap-1">
                <LinkIcon className="h-3.5 w-3.5" /> 复制链接
              </Button>
              <Button variant="outline" size="sm" className="gap-1">
                <Share2 className="h-3.5 w-3.5" /> 分享
              </Button>
            </div>
          </div>

          {voteData.status !== "completed" && renderVoteButton()}
        </div>
      </DialogContent>
    </Dialog>
  )
}
