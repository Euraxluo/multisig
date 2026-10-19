"use client"

import { useState, useEffect } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Switch } from "@/components/ui/switch"
import { Calendar } from "@/components/ui/calendar"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { ScrollArea } from "@/components/ui/scroll-area"
import { motion, AnimatePresence } from "framer-motion"
import { format } from "date-fns"
import { cn } from "@/lib/utils"
import {
  CalendarIcon,
  XIcon,
  PlusIcon,
  SearchIcon,
  UserIcon,
  Users,
  EyeIcon,
  EyeOffIcon,
  LinkIcon,
  Vote,
  CheckCircle2Icon,
  ListFilter,
  AlignLeftIcon,
  AlertTriangleIcon,
  BarChartIcon,
} from "lucide-react"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"

interface CreateVoteDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

// Mock data for groups
const groups = [
  {
    id: "group-1",
    name: "Team Treasury",
    members: [
      { id: "user-1", name: "Alex", address: "0x1a2b...3c4d", weight: 2 },
      { id: "user-2", name: "Jamie", address: "jamie@gmail.com", weight: 1 },
      { id: "user-3", name: "Taylor", address: "0x2k3l...4m5n", weight: 3 },
      { id: "user-4", name: "Sam", address: "0x6o7p...8q9r", weight: 2 },
    ],
  },
  {
    id: "group-2",
    name: "DAO Fund",
    members: [
      { id: "user-1", name: "Alex", address: "0x1a2b...3c4d", weight: 1 },
      { id: "user-5", name: "Morgan", address: "morgan@gmail.com", weight: 1 },
      { id: "user-6", name: "Riley", address: "0x9a8b...7c6d", weight: 1 },
    ],
  },
]

// Mock data for recent contacts
const recentContacts = [
  { id: "user-1", name: "Alex", address: "0x1a2b...3c4d", type: "wallet" as const },
  { id: "user-2", name: "Jamie", address: "jamie@gmail.com", type: "email" as const },
  { id: "user-3", name: "Taylor", address: "0x2k3l...4m5n", type: "wallet" as const },
  { id: "user-4", name: "Sam", address: "sam@gmail.com", type: "email" as const },
  { id: "user-5", name: "Morgan", address: "morgan@gmail.com", type: "email" as const },
  { id: "user-6", name: "Riley", address: "0x9a8b...7c6d", type: "wallet" as const },
]

interface VoteOption {
  id: string
  text: string
}

interface Voter {
  id: string
  name?: string
  address: string
  weight: number
  type?: "wallet" | "email"
}

const initialVoteOption = { id: "option-1", text: "" }

export function CreateVoteDialog({ open, onOpenChange }: CreateVoteDialogProps) {
  const [step, setStep] = useState(1)
  const [title, setTitle] = useState("")
  const [description, setDescription] = useState("")
  const [voteType, setVoteType] = useState("single") // single, multiple, ranked
  const [voterSource, setVoterSource] = useState("manual") // manual, group, hybrid
  const [selectedGroup, setSelectedGroup] = useState("")
  const [voters, setVoters] = useState<Voter[]>([])
  const [searchTerm, setSearchTerm] = useState("")
  const [voteOptions, setVoteOptions] = useState<VoteOption[]>([initialVoteOption])
  const [isAnonymous, setIsAnonymous] = useState(false)
  const [showResults, setShowResults] = useState("after") // after, during
  const [expiryDate, setExpiryDate] = useState<Date | undefined>(undefined)
  const [createTransaction, setCreateTransaction] = useState(false)
  const [selectedTransaction, setSelectedTransaction] = useState<string | undefined>(undefined)
  const [weightType, setWeightType] = useState("manual") // manual, token, nft
  const [tokenAddress, setTokenAddress] = useState("")
  const [tokenSymbol, setTokenSymbol] = useState("")
  const [weightCalculation, setWeightCalculation] = useState("linear") // linear, sqrt, quadratic
  const [snapshotBlock, setSnapshotBlock] = useState("latest") // latest, specific
  const [specificBlock, setSpecificBlock] = useState("")

  // Reset state when dialog opens/closes
  useEffect(() => {
    if (!open) {
      setTimeout(() => {
        setStep(1)
        setTitle("")
        setDescription("")
        setVoteType("single")
        setVoterSource("manual")
        setSelectedGroup("")
        setVoters([])
        setSearchTerm("")
        setVoteOptions([initialVoteOption])
        setIsAnonymous(false)
        setShowResults("after")
        setExpiryDate(undefined)
        setCreateTransaction(false)
        setSelectedTransaction(undefined)
        // 重置新添加的状态
        setWeightType("manual")
        setTokenAddress("")
        setTokenSymbol("")
        setWeightCalculation("linear")
        setSnapshotBlock("latest")
        setSpecificBlock("")
      }, 300)
    }
  }, [open])

  // When a group is selected, sync the voters
  useEffect(() => {
    if (selectedGroup && voterSource === "group") {
      const group = groups.find((g) => g.id === selectedGroup)
      if (group) {
        setVoters(
          group.members.map((member) => ({
            id: member.id,
            name: member.name,
            address: member.address,
            weight: member.weight,
            type: member.address.includes("@") ? ("email" as const) : ("wallet" as const),
          })),
        )
      }
    }
  }, [selectedGroup, voterSource])

  const addVoteOption = () => {
    setVoteOptions([...voteOptions, { id: `option-${voteOptions.length + 1}`, text: "" }])
  }

  const updateVoteOption = (id: string, text: string) => {
    setVoteOptions(voteOptions.map((option) => (option.id === id ? { ...option, text } : option)))
  }

  const removeVoteOption = (id: string) => {
    if (voteOptions.length > 1) {
      setVoteOptions(voteOptions.filter((option) => option.id !== id))
    }
  }

  const addVoter = (contact: (typeof recentContacts)[0]) => {
    if (!voters.some((v) => v.id === contact.id)) {
      setVoters([
        ...voters,
        {
          id: contact.id,
          name: contact.name,
          address: contact.address,
          weight: 1,
          type: contact.type,
        },
      ])
    }
  }

  const removeVoter = (id: string) => {
    setVoters(voters.filter((voter) => voter.id !== id))
  }

  const updateVoterWeight = (id: string, weight: number) => {
    setVoters(voters.map((voter) => (voter.id === id ? { ...voter, weight } : voter)))
  }

  const nextStep = () => {
    setStep(step + 1)
  }

  const prevStep = () => {
    setStep(step - 1)
  }

  const handleCreateVote = () => {
    if (!title.trim()) return

    const newVote = {
      id: `vote-${Date.now()}`,
      title: title.trim(),
      description: description.trim(),
      creator: "Me (Organizer)",
      creatorAvatar: "/placeholder.svg?height=40&width=40",
      createdAt: new Date().toISOString(),
      expiresAt: expiryDate ? expiryDate.toISOString() : new Date(Date.now() + 86400000 * 7).toISOString(),
      voteType,
      totalVotes: 1,
      myVote: null,
      status: "active",
      progress: {
        option1: 1,
        option2: 0,
      },
      group: groups.find((g) => g.id === selectedGroup)?.name || "团队财务",
      isAnonymous,
      color: "from-primary to-purple-500",
      showResultsDuring: showResults === "always",
      options: voteOptions.map((opt) => ({
        id: opt.id,
        text: opt.text,
        votes: 0,
        percentage: 0,
      })),
    }

    try {
      const stored = JSON.parse(localStorage.getItem("sui_governance_votes") || "[]")
      stored.unshift(newVote)
      localStorage.setItem("sui_governance_votes", JSON.stringify(stored))
      window.dispatchEvent(new CustomEvent("sui-votes-updated", { detail: stored }))
    } catch (e) {
      console.warn("Failed to save vote to localStorage", e)
    }

    onOpenChange(false)
  }

  // Filter contacts based on search term
  const filteredContacts = searchTerm
    ? recentContacts.filter(
        (contact) =>
          contact.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
          contact.address.toLowerCase().includes(searchTerm.toLowerCase()),
      )
    : recentContacts

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px] p-0 gap-0 overflow-hidden">
        <DialogHeader className="p-4 pb-0">
          <DialogTitle>创建投票提案</DialogTitle>
          <DialogDescription>创建一个新的投票提案供成员投票</DialogDescription>
        </DialogHeader>

        <div className="relative overflow-hidden">
          <div className="flex justify-between px-4 pt-4">
            {[1, 2, 3].map((i) => (
              <div key={i} className="flex flex-col items-center" onClick={() => i < step && setStep(i)}>
                <div
                  className={`h-8 w-8 rounded-full flex items-center justify-center text-sm ${
                    i < step
                      ? "bg-primary text-primary-foreground"
                      : i === step
                        ? "bg-primary/20 text-primary border-2 border-primary"
                        : "bg-muted text-muted-foreground"
                  }`}
                >
                  {i}
                </div>
                <div className="text-xs mt-1 text-muted-foreground">
                  {i === 1 ? "基本信息" : i === 2 ? "选项和选民" : "设置和确认"}
                </div>
              </div>
            ))}
            <div className="absolute top-[28px] left-[68px] w-[120px] h-[2px] bg-muted">
              <div className={`h-full bg-primary transition-all ${step > 1 ? "w-full" : "w-0"}`}></div>
            </div>
            <div className="absolute top-[28px] right-[68px] w-[120px] h-[2px] bg-muted">
              <div className={`h-full bg-primary transition-all ${step > 2 ? "w-full" : "w-0"}`}></div>
            </div>
          </div>

          <AnimatePresence mode="wait">
            {step === 1 && (
              <motion.div
                key="step1"
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 20 }}
                transition={{ duration: 0.3 }}
                className="px-4 py-4"
              >
                <div className="space-y-3">
                  <div className="space-y-1">
                    <Label htmlFor="title" className="text-xs font-medium">
                      投票标题
                    </Label>
                    <Input
                      id="title"
                      placeholder="例如：增加市场预算提案"
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                    />
                  </div>

                  <div className="space-y-1">
                    <Label htmlFor="description" className="text-xs font-medium">
                      详细描述
                    </Label>
                    <Textarea
                      id="description"
                      placeholder="提供关于此投票的详细信息..."
                      className="resize-none h-24"
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                    />
                  </div>

                  <div className="space-y-1">
                    <Label className="text-xs font-medium">投票类型</Label>
                    <Tabs value={voteType} onValueChange={setVoteType} className="w-full">
                      <TabsList className="grid w-full grid-cols-3 p-1 bg-muted/50 rounded-xl h-9">
                        <TabsTrigger
                          value="single"
                          className="rounded-lg text-xs data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
                        >
                          单选
                        </TabsTrigger>
                        <TabsTrigger
                          value="multiple"
                          className="rounded-lg text-xs data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
                        >
                          多选
                        </TabsTrigger>
                        <TabsTrigger
                          value="ranked"
                          className="rounded-lg text-xs data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
                        >
                          排序
                        </TabsTrigger>
                      </TabsList>
                    </Tabs>
                    <p className="text-xs text-muted-foreground mt-1">
                      {voteType === "single"
                        ? "选民只能选择一个选项"
                        : voteType === "multiple"
                          ? "选民可以选择多个选项"
                          : "选民对选项进行排序投票"}
                    </p>
                  </div>

                  <div className="space-y-1">
                    <Label className="text-xs font-medium">投票权重类型</Label>
                    <Tabs value={weightType} onValueChange={setWeightType} className="w-full">
                      <TabsList className="grid w-full grid-cols-3 p-1 bg-muted/50 rounded-xl h-9">
                        <TabsTrigger
                          value="manual"
                          className="rounded-lg text-xs data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
                        >
                          手动设置
                        </TabsTrigger>
                        <TabsTrigger
                          value="token"
                          className="rounded-lg text-xs data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
                        >
                          代币余额
                        </TabsTrigger>
                        <TabsTrigger
                          value="nft"
                          className="rounded-lg text-xs data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
                        >
                          NFT持有
                        </TabsTrigger>
                      </TabsList>
                    </Tabs>
                    <p className="text-xs text-muted-foreground mt-1">
                      {weightType === "manual"
                        ? "手动为每个选民设置投票权重"
                        : weightType === "token"
                          ? "根据选民持有的代币数量确定投票权重"
                          : "根据选民持有的NFT数量确定投票权重"}
                    </p>
                  </div>

                  {weightType === "token" && (
                    <div className="space-y-3 mt-3 p-3 rounded-lg border">
                      <div className="space-y-1">
                        <Label htmlFor="tokenAddress" className="text-xs font-medium">
                          代币合约地址
                        </Label>
                        <Input
                          id="tokenAddress"
                          placeholder="0x..."
                          value={tokenAddress}
                          onChange={(e) => setTokenAddress(e.target.value)}
                        />
                      </div>

                      <div className="space-y-1">
                        <Label htmlFor="tokenSymbol" className="text-xs font-medium">
                          代币符号
                        </Label>
                        <Input
                          id="tokenSymbol"
                          placeholder="例如：ETH, USDC"
                          value={tokenSymbol}
                          onChange={(e) => setTokenSymbol(e.target.value)}
                        />
                      </div>

                      <div className="space-y-1">
                        <Label className="text-xs font-medium">权重计算方式</Label>
                        <Select value={weightCalculation} onValueChange={setWeightCalculation}>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="linear">线性 (1代币 = 1票)</SelectItem>
                            <SelectItem value="sqrt">平方根 (票数 = √代币数)</SelectItem>
                            <SelectItem value="quadratic">二次方 (票数 = 代币数²)</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>

                      <div className="space-y-1">
                        <Label className="text-xs font-medium">余额快照</Label>
                        <Select value={snapshotBlock} onValueChange={setSnapshotBlock}>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="latest">使用最新区块</SelectItem>
                            <SelectItem value="specific">使用特定区块</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>

                      {snapshotBlock === "specific" && (
                        <div className="space-y-1">
                          <Label htmlFor="specificBlock" className="text-xs font-medium">
                            区块高度
                          </Label>
                          <Input
                            id="specificBlock"
                            placeholder="例如：16123456"
                            value={specificBlock}
                            onChange={(e) => setSpecificBlock(e.target.value)}
                          />
                        </div>
                      )}
                    </div>
                  )}

                  <div className="space-y-1">
                    <Label htmlFor="expiry" className="text-xs font-medium">
                      投票截止日期
                    </Label>
                    <Popover>
                      <PopoverTrigger asChild>
                        <Button
                          variant={"outline"}
                          className={cn(
                            "w-full justify-start text-left font-normal",
                            !expiryDate && "text-muted-foreground",
                          )}
                        >
                          <CalendarIcon className="mr-2 h-4 w-4" />
                          {expiryDate ? format(expiryDate, "PPP") : "选择日期"}
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent className="w-auto p-0">
                        <Calendar mode="single" selected={expiryDate} onSelect={setExpiryDate} />
                      </PopoverContent>
                    </Popover>
                  </div>
                </div>
              </motion.div>
            )}

            {step === 2 && (
              <motion.div
                key="step2"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                transition={{ duration: 0.3 }}
                className="px-4 py-4"
              >
                <div className="space-y-4">
                  {/* 投票选项部分 */}
                  <div className="space-y-2">
                    <Label className="text-xs font-medium flex items-center">
                      <ListFilter className="h-4 w-4 mr-1.5" />
                      投票选项
                    </Label>

                    <div className="space-y-2">
                      {voteOptions.map((option, index) => (
                        <div key={option.id} className="flex items-center gap-2">
                          <div className="w-8 h-8 flex items-center justify-center bg-primary/10 rounded-full text-xs font-medium">
                            {index + 1}
                          </div>
                          <Input
                            placeholder={`选项 ${index + 1}`}
                            value={option.text}
                            onChange={(e) => updateVoteOption(option.id, e.target.value)}
                            className="flex-1"
                          />
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            onClick={() => removeVoteOption(option.id)}
                            className="h-8 w-8"
                            disabled={voteOptions.length <= 1}
                          >
                            <XIcon className="h-4 w-4" />
                          </Button>
                        </div>
                      ))}
                    </div>

                    <Button type="button" variant="outline" size="sm" onClick={addVoteOption} className="w-full mt-2">
                      <PlusIcon className="h-4 w-4 mr-1" /> 添加选项
                    </Button>
                  </div>

                  {/* 选民选择部分 */}
                  <div className="space-y-2 pt-4 border-t">
                    <Label className="text-xs font-medium flex items-center">
                      <Users className="h-4 w-4 mr-1.5" />
                      投票人员
                    </Label>

                    <div className="space-y-2">
                      <Tabs value={voterSource} onValueChange={setVoterSource} className="w-full">
                        <TabsList className="grid w-full grid-cols-3 p-1 bg-muted/50 rounded-xl h-9">
                          <TabsTrigger
                            value="manual"
                            className="rounded-lg text-xs data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
                          >
                            手动添加
                          </TabsTrigger>
                          <TabsTrigger
                            value="group"
                            className="rounded-lg text-xs data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
                          >
                            从组同步
                          </TabsTrigger>
                          <TabsTrigger
                            value="hybrid"
                            className="rounded-lg text-xs data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
                          >
                            混合模式
                          </TabsTrigger>
                        </TabsList>
                      </Tabs>

                      {(voterSource === "group" || voterSource === "hybrid") && (
                        <div className="space-y-1 mt-2">
                          <Label htmlFor="group" className="text-xs font-medium">
                            选择组
                          </Label>
                          <Select value={selectedGroup} onValueChange={setSelectedGroup}>
                            <SelectTrigger id="group">
                              <SelectValue placeholder="选择一个组" />
                            </SelectTrigger>
                            <SelectContent>
                              {groups.map((group) => (
                                <SelectItem key={group.id} value={group.id}>
                                  {group.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      )}

                      {(voterSource === "manual" || voterSource === "hybrid") && (
                        <div className="mt-2">
                          <div className="flex items-center gap-2 mb-2">
                            <Input
                              placeholder="搜索联系人..."
                              value={searchTerm}
                              onChange={(e) => setSearchTerm(e.target.value)}
                              className="flex-1"
                            />
                            <Button type="button" variant="outline" size="icon" className="h-9 w-9">
                              <SearchIcon className="h-4 w-4" />
                            </Button>
                          </div>

                          <ScrollArea className="h-[150px] border rounded-md p-2">
                            <div className="space-y-1">
                              {filteredContacts.map((contact) => (
                                <div
                                  key={contact.id}
                                  className="flex items-center justify-between p-2 rounded-lg hover:bg-muted/50 transition-colors cursor-pointer"
                                  onClick={() => addVoter(contact)}
                                >
                                  <div className="flex items-center">
                                    <Avatar className="h-6 w-6 mr-2">
                                      <AvatarFallback
                                        className={
                                          contact.type === "email"
                                            ? "bg-blue-100 text-blue-600"
                                            : "bg-purple-100 text-purple-600"
                                        }
                                      >
                                        {contact.name.charAt(0)}
                                      </AvatarFallback>
                                    </Avatar>
                                    <div>
                                      <p className="text-sm font-medium">{contact.name}</p>
                                      <p className="text-xs text-muted-foreground truncate max-w-[200px]">
                                        {contact.address}
                                      </p>
                                    </div>
                                  </div>
                                  <PlusIcon className="h-4 w-4 opacity-50 hover:opacity-100" />
                                </div>
                              ))}
                              {filteredContacts.length === 0 && (
                                <div className="p-2 text-center text-sm text-muted-foreground">未找到匹配的联系人</div>
                              )}
                            </div>
                          </ScrollArea>
                        </div>
                      )}

                      {/* 已选择的投票人 */}
                      {voters.length > 0 && (
                        <div className="mt-3">
                          <Label className="text-xs font-medium">已选择的投票人 ({voters.length})</Label>
                          <ScrollArea className="h-[150px] border rounded-md p-2 mt-1">
                            <div className="space-y-1">
                              {voters.map((voter) => (
                                <div
                                  key={voter.id}
                                  className="flex items-center justify-between p-2 rounded-lg hover:bg-muted/50 transition-colors"
                                >
                                  <div className="flex items-center">
                                    <Avatar className="h-6 w-6 mr-2">
                                      <AvatarFallback
                                        className={
                                          voter.type === "email"
                                            ? "bg-blue-100 text-blue-600"
                                            : "bg-purple-100 text-purple-600"
                                        }
                                      >
                                        {voter.name?.charAt(0) || "U"}
                                      </AvatarFallback>
                                    </Avatar>
                                    <div>
                                      <p className="text-sm font-medium">{voter.name || voter.address}</p>
                                      <p className="text-xs text-muted-foreground truncate max-w-[150px]">
                                        {voter.address}
                                      </p>
                                    </div>
                                  </div>
                                  <div className="flex items-center gap-2">
                                    <div className="flex items-center gap-1">
                                      <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon"
                                        onClick={() => updateVoterWeight(voter.id, Math.max(1, voter.weight - 1))}
                                        className="h-6 w-6"
                                      >
                                        <svg
                                          xmlns="http://www.w3.org/2000/svg"
                                          width="16"
                                          height="16"
                                          viewBox="0 0 24 24"
                                          fill="none"
                                          stroke="currentColor"
                                          strokeWidth="2"
                                          strokeLinecap="round"
                                          strokeLinejoin="round"
                                        >
                                          <path d="M5 12h14" />
                                        </svg>
                                      </Button>
                                      <span className="text-xs font-medium w-5 text-center">{voter.weight}</span>
                                      <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon"
                                        onClick={() => updateVoterWeight(voter.id, voter.weight + 1)}
                                        className="h-6 w-6"
                                      >
                                        <PlusIcon className="h-3 w-3" />
                                      </Button>
                                    </div>
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="icon"
                                      onClick={() => removeVoter(voter.id)}
                                      className="h-6 w-6 text-destructive"
                                    >
                                      <XIcon className="h-3 w-3" />
                                    </Button>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </ScrollArea>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </motion.div>
            )}

            {step === 3 && (
              <motion.div
                key="step3"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                transition={{ duration: 0.3 }}
                className="px-4 py-4"
              >
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label className="text-xs font-medium flex items-center">
                      <EyeIcon className="h-4 w-4 mr-1.5" />
                      隐私设置
                    </Label>

                    <div className="space-y-2">
                      <div className="flex items-center justify-between p-2 rounded-lg border">
                        <div className="flex items-center">
                          <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center mr-2">
                            {isAnonymous ? (
                              <EyeOffIcon className="h-4 w-4 text-primary" />
                            ) : (
                              <UserIcon className="h-4 w-4 text-primary" />
                            )}
                          </div>
                          <div>
                            <p className="text-sm font-medium">匿名投票</p>
                            <p className="text-xs text-muted-foreground">
                              {isAnonymous ? "投票人的身份将被隐藏" : "投票人的身份将公开显示"}
                            </p>
                          </div>
                        </div>
                        <Switch checked={isAnonymous} onCheckedChange={setIsAnonymous} />
                      </div>

                      <div className="flex items-center justify-between p-2 rounded-lg border">
                        <div className="flex items-center">
                          <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center mr-2">
                            {showResults === "after" ? (
                              <BarChartIcon className="h-4 w-4 text-primary" />
                            ) : (
                              <AlignLeftIcon className="h-4 w-4 text-primary" />
                            )}
                          </div>
                          <div>
                            <p className="text-sm font-medium">结果显示时间</p>
                            <p className="text-xs text-muted-foreground">
                              {showResults === "after" ? "投票结束后显示结果" : "投票期间实时显示结果"}
                            </p>
                          </div>
                        </div>
                        <Select value={showResults} onValueChange={setShowResults}>
                          <SelectTrigger className="w-[120px]">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="after">投票结束后</SelectItem>
                            <SelectItem value="during">投票期间</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>

                      <div className="flex items-center justify-between p-2 rounded-lg border">
                        <div className="flex items-center">
                          <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center mr-2">
                            <LinkIcon className="h-4 w-4 text-primary" />
                          </div>
                          <div>
                            <p className="text-sm font-medium">访问链接</p>
                            <p className="text-xs text-muted-foreground">创建可共享的链接供未添加的用户访问</p>
                          </div>
                        </div>
                        <Switch defaultChecked />
                      </div>
                    </div>
                  </div>

                  <div className="space-y-2 pt-4 border-t">
                    <Label className="text-xs font-medium flex items-center">
                      <CheckCircle2Icon className="h-4 w-4 mr-1.5" />
                      执行设置
                    </Label>

                    <div className="space-y-2">
                      <div className="flex items-center justify-between p-2 rounded-lg border">
                        <div className="flex items-center">
                          <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center mr-2">
                            <Vote className="h-4 w-4 text-primary" />
                          </div>
                          <div>
                            <p className="text-sm font-medium">投票后创建交易</p>
                            <p className="text-xs text-muted-foreground">
                              {createTransaction ? "投票通过后自动创建交易执行" : "仅记录投票结果，不执行交易"}
                            </p>
                          </div>
                        </div>
                        <Switch checked={createTransaction} onCheckedChange={setCreateTransaction} />
                      </div>

                      {createTransaction && (
                        <div className="space-y-1 pl-10">
                          <Label className="text-xs font-medium">选择交易模板</Label>
                          <Select value={selectedTransaction} onValueChange={setSelectedTransaction}>
                            <SelectTrigger>
                              <SelectValue placeholder="选择交易模板" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="template-1">转账到外部钱包</SelectItem>
                              <SelectItem value="template-2">质押代币</SelectItem>
                              <SelectItem value="template-3">代币兑换</SelectItem>
                            </SelectContent>
                          </Select>
                          <p className="text-xs text-muted-foreground mt-1">投票通过后将使用所选模板创建交易</p>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="bg-yellow-50 p-3 rounded-lg border border-yellow-200 mt-4">
                    <div className="flex items-start">
                      <AlertTriangleIcon className="h-5 w-5 text-yellow-500 mr-2 mt-0.5" />
                      <div>
                        <p className="text-sm font-medium text-yellow-700">提交前确认</p>
                        <p className="text-xs text-yellow-600 mt-1">
                          请确认所有投票设置正确。投票创建后，部分设置将无法更改。
                          {expiryDate && (
                            <>
                              <br />
                              投票将在 <strong>{format(expiryDate, "PPP")}</strong> 结束。
                            </>
                          )}
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <DialogFooter className="p-4 pt-2">
          {step > 1 ? (
            <div className="flex w-full justify-between">
              <Button type="button" variant="outline" onClick={prevStep} size="sm">
                上一步
              </Button>
              {step < 3 ? (
                <Button type="button" onClick={nextStep} size="sm">
                  下一步
                </Button>
              ) : (
                <Button
                  type="submit"
                  size="sm"
                  onClick={handleCreateVote}
                  className="bg-gradient-to-r from-primary to-purple-500 hover:from-primary/90 hover:to-purple-500/90"
                >
                  创建投票
                </Button>
              )}
            </div>
          ) : (
            <Button type="button" onClick={nextStep} className="w-full">
              下一步
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
