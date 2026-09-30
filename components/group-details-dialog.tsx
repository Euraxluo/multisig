"use client"

import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { QrCode, Users, Share2, Copy, ExternalLink, Plus, Bot, Zap, ShieldCheck, Sparkles, Network, MessageSquare, Send, HardDrive, KeyRound, Paperclip, Crown, Coins, Gift, ArrowUpRight, DollarSign, CheckCircle2, Terminal, Flame, Vote, FileText } from "lucide-react"
import { Progress } from "@/components/ui/progress"
import { Input } from "@/components/ui/input"
import { useState } from "react"
import { motion, AnimatePresence } from "framer-motion"
import { CreateTransactionDialog } from "@/components/create-transaction-dialog"
import { TransactionDetailsDialog } from "@/components/transaction-details-dialog"
import { DkgCeremonyDialog } from "@/components/dkg-ceremony-dialog"
import { WalrusBlobDialog } from "@/components/walrus-blob-dialog"
import { RedPacketDialog, RedPacketData } from "@/components/red-packet-dialog"
import { WalrusAppSandboxDialog } from "@/components/walrus-app-sandbox-dialog"

interface GroupDetailsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  groupId: string
}

export function GroupDetailsDialog({ open, onOpenChange, groupId }: GroupDetailsDialogProps) {
  const [activeTab, setActiveTab] = useState("chat")
  const [isCreateTxOpen, setIsCreateTxOpen] = useState(false)
  const [selectedTx, setSelectedTx] = useState<string | null>(null)
  const [isDkgOpen, setIsDkgOpen] = useState(false)
  const [isConvertedToDao, setIsConvertedToDao] = useState(false)
  const [groupPk, setGroupPk] = useState("")
  const [selectedBlobId, setSelectedBlobId] = useState<string | null>(null)
  const [isAppSandboxOpen, setIsAppSandboxOpen] = useState(false)
  const [selectedAppBlobId, setSelectedAppBlobId] = useState("walrus_blob_app_poll_901.wma")

  const [useSubagentCap, setUseSubagentCap] = useState(true)
  // 知识星球 / OnlyFans / 舰长群 经济学状态
  const [isPlanetMode, setIsPlanetMode] = useState(true)
  const [creatorStake, setCreatorStake] = useState(100.0) // 100 SUI 创作者建群质押
  const [entryFee, setEntryFee] = useState(5.0) // 5 SUI 进群门票
  const [memberStake, setMemberStake] = useState(50.0) // 50 SUI 进群保本质押
  const [creatorRevenuePool, setCreatorRevenuePool] = useState(17.0) // 17 SUI (门票 10 SUI + 70% 利息 7 SUI)
  const [gasSubsidyPool, setGasSubsidyPool] = useState(1.999) // 2.0 SUI 利息池 (20% 利息，已报销 1 次)
  const [memberYieldPool, setMemberYieldPool] = useState(1.0) // 1.0 SUI (10% 利息分红)
  const [totalSubsidizedGas, setTotalSubsidizedGas] = useState(0.001) // 累计报销
  const [rebatePill, setRebatePill] = useState<string | null>(null)
  const [claimedNotice, setClaimedNotice] = useState<string | null>(null)

  // 红包与外挂系统状态
  const [isRedPacketDialogOpen, setIsRedPacketDialogOpen] = useState(false)
  const [redPacketDialogMode, setRedPacketDialogMode] = useState<"create" | "claim">("create")
  const [activeRedPacketId, setActiveRedPacketId] = useState<string | null>(null)
  const [showSlashMenu, setShowSlashMenu] = useState(false)

  const [redPackets, setRedPackets] = useState<Record<string, RedPacketData>>({
    rp_genesis: {
      id: "rp_genesis",
      sender: "0x1a2b...3c4d",
      senderName: "Alice (群主)",
      totalAmount: 6.0,
      totalCount: 3,
      remainingAmount: 2.2,
      remainingCount: 1,
      packetType: "LUCKY_RANDOM",
      greeting: "星球创世红包！庆贺免密发信与质押生息系统上线 🎉",
      createdAt: "14:22",
      expiresAt: "24h后",
      claims: [
        {
          id: "c1",
          claimer: "0x5e6f...7g8h",
          claimerName: "Eve (舰长)",
          amount: 3.8,
          claimedAt: "14:23",
          isBest: true,
        },
      ],
      claimedByUser: false,
    },
  })

  const [messages, setMessages] = useState<Array<{
    id: string
    sender: string
    role: string
    time: string
    text: string
    walrusBlobId?: string
    redPacketId?: string
    isSubagent?: boolean
  }>>([
    {
      id: "m1",
      sender: "Alice",
      role: "群主",
      time: "14:20",
      text: "欢迎新成员 Eve 进群！🎉",
      isSubagent: true,
    },
    {
      id: "m2",
      sender: "Eve",
      role: "成员",
      time: "14:21",
      text: "大家好，很高兴加入！",
      isSubagent: true,
    },
    {
      id: "m3",
      sender: "Sentinel-AI",
      role: "助理",
      time: "14:21",
      text: "社区治理规范已更新，欢迎查阅附件文档。",
      walrusBlobId: "walrus_blob_0x7f8a9b_proposal_v2.pdf",
      isSubagent: true,
    },
    {
      id: "m4",
      sender: "Alice",
      role: "群主",
      time: "14:22",
      text: "发个红包庆祝一下，大家快来抢 🧧",
      redPacketId: "rp_genesis",
      isSubagent: true,
    },
  ])
  const [chatInput, setChatInput] = useState("")

  // 打开红包详情/开红包弹窗
  const handleOpenRedPacketClaim = (packetId: string) => {
    setActiveRedPacketId(packetId)
    setRedPacketDialogMode("claim")
    setIsRedPacketDialogOpen(true)
  }

  // 抢红包逻辑 (Move Double-Average 模拟)
  const handleClaimRedPacket = (packetId: string) => {
    const packet = redPackets[packetId]
    if (!packet || packet.claimedByUser || packet.remainingCount <= 0) return

    let claimAmount = 0
    if (packet.remainingCount === 1) {
      claimAmount = packet.remainingAmount
    } else {
      const avg = packet.remainingAmount / packet.remainingCount
      const maxClaim = Math.min(packet.remainingAmount - (packet.remainingCount - 1) * 0.001, avg * 2)
      claimAmount = +(Math.random() * (maxClaim - 0.05) + 0.05).toFixed(3)
    }

    const newClaim = {
      id: `c_${Date.now()}`,
      claimer: "0x6o7p...8q9r",
      claimerName: "You (VIP 舰长)",
      amount: claimAmount,
      claimedAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    }

    const updatedClaims = [...packet.claims, newClaim]
    let maxAmt = 0
    updatedClaims.forEach(c => {
      if (c.amount > maxAmt) maxAmt = c.amount
    })
    updatedClaims.forEach(c => {
      c.isBest = (c.amount === maxAmt)
    })

    const updatedPacket: RedPacketData = {
      ...packet,
      remainingAmount: +(packet.remainingAmount - claimAmount).toFixed(3),
      remainingCount: packet.remainingCount - 1,
      claims: updatedClaims,
      claimedByUser: true,
      userClaimAmount: claimAmount,
    }

    setRedPackets(prev => ({ ...prev, [packetId]: updatedPacket }))

    // 聊天流插入抢到红包提示
    setMessages(prev => [
      ...prev,
      {
        id: `m_${Date.now()}`,
        sender: "Sentinel-AI",
        role: "🤖 24h 研报哨兵",
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        text: `🧧 恭喜 You 抢到了 ${packet.senderName} 的红包 ${claimAmount.toFixed(3)} SUI！(链上已结算至当前地址)`,
        isSubagent: true,
      },
    ])
    setClaimedNotice(`🎉 抢红包到账：+${claimAmount.toFixed(3)} SUI 已入账你的钱包！`)
    setTimeout(() => setClaimedNotice(null), 5000)
  }

  // 发红包逻辑 (Move Create Red Packet)
  const handleCreateRedPacket = (params: {
    totalAmount: number
    totalCount: number
    packetType: "LUCKY_RANDOM" | "EQUAL"
    greeting: string
  }) => {
    const newId = `rp_${Date.now()}`
    const newPacket: RedPacketData = {
      id: newId,
      sender: "0x6o7p...8q9r",
      senderName: "You (VIP 舰长)",
      totalAmount: params.totalAmount,
      totalCount: params.totalCount,
      remainingAmount: params.totalAmount,
      remainingCount: params.totalCount,
      packetType: params.packetType,
      greeting: params.greeting,
      createdAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      expiresAt: "24h后",
      claims: [],
      claimedByUser: false,
    }

    setRedPackets(prev => ({ ...prev, [newId]: newPacket }))

    // 发送群聊消息
    setMessages(prev => [
      ...prev,
      {
        id: `m_${Date.now()}`,
        sender: "You (via Subagent)",
        role: "VIP 舰长 · 0 Gas 免密",
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        text: `发出了一个链上${params.packetType === "LUCKY_RANDOM" ? "拼手气" : "普通"}红包！快来抢～`,
        redPacketId: newId,
        isSubagent: true,
      },
    ])
    setClaimedNotice(`🧧 链上红包已铸造！生成共享对象 0x${Math.random().toString(16).slice(2, 10)}... (总计 ${params.totalAmount} SUI)`)
    setTimeout(() => setClaimedNotice(null), 5000)
  }

  // 退还过期红包
  const handleRefundRedPacket = (packetId: string) => {
    const packet = redPackets[packetId]
    if (!packet || packet.remainingAmount <= 0) return
    const refundAmt = packet.remainingAmount
    setRedPackets(prev => ({
      ...prev,
      [packetId]: { ...packet, remainingAmount: 0, remainingCount: 0 }
    }))
    setClaimedNotice(`🛡️ 过期退款成功：已将剩余 ${refundAmt.toFixed(3)} SUI 全额退回至 Alice/发起人钱包！`)
    setTimeout(() => setClaimedNotice(null), 5000)
  }

  // 执行 Slash 外挂命令
  const handleTriggerSlash = (cmd: string) => {
    setShowSlashMenu(false)
    setChatInput("")

    if (cmd === "/redpacket") {
      setRedPacketDialogMode("create")
      setIsRedPacketDialogOpen(true)
      return
    }

    if (cmd === "/tip") {
      setMessages(prev => [
        ...prev,
        {
          id: `m_${Date.now()}`,
          sender: "You",
          role: "成员",
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          text: "向 @Eve 打赏了 1.0 SUI 💰",
          isSubagent: true,
        },
      ])
      setClaimedNotice("打赏成功：已向 @Eve 转账 1.0 SUI")
      setTimeout(() => setClaimedNotice(null), 4000)
      return
    }

    if (cmd === "/app") {
      setIsAppSandboxOpen(true)
      setMessages(prev => [
        ...prev,
        {
          id: `m_${Date.now()}`,
          sender: "You",
          role: "成员",
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          text: "发起了群投票：《Sui 与 Aptos 跨链互操作方案探讨》",
          walrusBlobId: "walrus_blob_app_poll_901.wma",
          isSubagent: true,
        },
      ])
      return
    }

    if (cmd === "/stats") {
      setMessages(prev => [
        ...prev,
        {
          id: `m_cmd_${Date.now()}`,
          sender: "You",
          role: "成员",
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          text: "/stats 查看群资产简报",
          isSubagent: true,
        },
        {
          id: `m_stat_${Date.now()}`,
          sender: "Sentinel-AI",
          role: "助理",
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          text: `📊 【群资产快报】\n• 金库总额: 1,250 SUI\n• 待处理交易: 2 笔\n• 活跃成员: 4 人`,
          isSubagent: true,
        },
      ])
      return
    }

    if (cmd === "/help") {
      setMessages(prev => [
        ...prev,
        {
          id: `m_help_${Date.now()}`,
          sender: "Sentinel-AI",
          role: "助理",
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          text: "💡 【常用快捷指令】\n/redpacket - 发红包\n/tip @user 金额 - 打赏群友\n/app - 发起群投票\n/stats - 资产简报",
          isSubagent: true,
        },
      ])
    }
  }

  const handleSendMessage = (hasWalrusAttachment = false) => {
    if (!chatInput.trim() && !hasWalrusAttachment) return
    const textToSend = chatInput.trim() || "上传了治理提案规范文件 (Walrus Blob)"
    const blobId = hasWalrusAttachment ? `walrus_blob_0x${Math.random().toString(16).slice(2, 8)}_doc.pdf` : undefined

    // 检查是否是斜杠命令
    if (textToSend.startsWith("/")) {
      const cmdName = textToSend.split(" ")[0].toLowerCase()
      if (["/redpacket", "/tip", "/app", "/stats", "/help"].includes(cmdName)) {
        handleTriggerSlash(cmdName)
        return
      }
    }

    // 触发自动 Gas 报销 (auto_subsidize_gas)
    if (gasSubsidyPool >= 0.001) {
      setGasSubsidyPool((prev) => +(prev - 0.001).toFixed(3))
      setTotalSubsidizedGas((prev) => +(prev + 0.001).toFixed(3))
      setRebatePill("✨ 智能代付触发：auto_subsidize_gas 已向你的钱包打回 +0.001 SUI 报销！(净 Gas = 0)")
      setTimeout(() => setRebatePill(null), 4000)
    }

    setMessages((prev) => [
      ...prev,
      {
        id: `m_${Date.now()}`,
        sender: "You",
        role: "成员",
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        text: textToSend,
        walrusBlobId: blobId,
        isSubagent: useSubagentCap,
      },
    ])
    setChatInput("")
  }

  const handleClaimRevenue = () => {
    if (creatorRevenuePool <= 0) return
    const amount = creatorRevenuePool
    setCreatorRevenuePool(0)
    setClaimedNotice(`提现成功：已提取 ${amount.toFixed(2)} SUI`)
    setTimeout(() => setClaimedNotice(null), 4000)
  }

  const handleMemberUnstake = () => {
    setClaimedNotice(`已退出群组并赎回 50.50 SUI 质押金`)
    setTimeout(() => setClaimedNotice(null), 4000)
  }

  // Mock data - in a real app, you would fetch this based on groupId
  const group = {
    id: groupId,
    name: "Team Treasury",
    description: "Treasury for our team's expenses and investments",
    address: "0x1a2b3c4d5e6f7g8h9i0j",
    network: "Aptos",
    balance: 1250,
    token: "APT",
    creator: "0x1a2b...3c4d",
    creatorName: "Alex",
    members: [
      { address: "0x5e6f...7g8h", name: "Sam", weight: 2 },
      { address: "jamie@gmail.com", name: "Jamie", weight: 1 },
      { address: "0x2k3l...4m5n", name: "Taylor", weight: 3 },
      { address: "0x6o7p...8q9r", name: "You", weight: 2 },
    ],
    threshold: 5,
    totalWeight: 8,
    transactions: [
      {
        id: "tx1",
        title: "Token Transfer",
        description: "Transfer tokens to external wallet",
        amount: 100,
        token: "APT",
        recipient: "0xabcd...1234",
        status: "pending",
        approvals: 3,
        requiredApprovals: 5,
        createdAt: "2025-03-15T12:00:00Z",
        expiresAt: "2025-04-15T12:00:00Z",
        type: "transfer",
      },
      {
        id: "tx2",
        title: "Contract Interaction",
        description: "Stake tokens in DeFi protocol",
        amount: 500,
        token: "APT",
        recipient: "0xdefi...5678",
        status: "executed",
        approvals: 6,
        requiredApprovals: 5,
        createdAt: "2025-03-10T12:00:00Z",
        executedAt: "2025-03-12T15:30:00Z",
        type: "contract",
      },
      {
        id: "tx3",
        title: "Token Swap",
        description: "Swap APT for USDC",
        amount: 200,
        token: "APT",
        recipient: "0xswap...9012",
        status: "rejected",
        approvals: 2,
        requiredApprovals: 5,
        createdAt: "2025-03-05T12:00:00Z",
        rejectedAt: "2025-03-07T09:15:00Z",
        type: "contract",
      },
    ],
    agents: [
      { id: "agent-sentinel", name: "Sentinel-AI (助理)", purpose: "自动化治理与数据监测", budget: 100, spent: 12.5, status: "ACTIVE" },
      { id: "agent-1", name: "DeepSeek-Reasoner-01", purpose: "模型推理服务", budget: 10, spent: 4.2, status: "ACTIVE" },
      { id: "agent-2", name: "Web-Scraper-Proxy", purpose: "行情与数据抓取", budget: 2, spent: 2.0, status: "QUOTA_REACHED" },
    ],
    color: "from-primary to-purple-500",
  }

  const shortAddress = `${group.address.slice(0, 6)}...${group.address.slice(-4)}`

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[94vw] max-w-[480px] p-0 gap-0 overflow-hidden rounded-2xl max-h-[92vh] flex flex-col">
        <div className={`h-24 bg-gradient-to-r ${group.color} p-4 flex flex-col justify-end`}>
          <DialogHeader className="text-white">
            <DialogTitle className="flex items-center justify-between">
              <span className="text-xl">{group.name}</span>
              <Badge variant="outline" className="bg-white/20 text-white border-white/40">
                {group.network}
              </Badge>
            </DialogTitle>
            <p className="text-white/80 text-sm mt-1">{group.description}</p>
          </DialogHeader>
        </div>

        <div className="p-4 space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center">
              <Avatar className="h-10 w-10 mr-3 border-2 border-background">
                <AvatarFallback className="bg-gradient-to-br from-primary to-purple-500 text-white">
                  {group.name[0]}
                </AvatarFallback>
              </Avatar>
              <div>
                <div className="flex items-center">
                  <p className="text-sm font-medium mr-1">{shortAddress}</p>
                  <Button variant="ghost" size="icon" className="h-6 w-6">
                    <Copy className="h-3 w-3" />
                  </Button>
                  <Button variant="ghost" size="icon" className="h-6 w-6">
                    <ExternalLink className="h-3 w-3" />
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">Multi-Signature Wallet</p>
              </div>
            </div>
            <div className="text-right">
              <p className="font-medium">
                {group.balance} {group.token}
              </p>
              <div className="flex items-center text-xs text-muted-foreground justify-end">
                <span>
                  Threshold: {group.threshold}/{group.totalWeight}
                </span>
              </div>
            </div>
          </div>

          <Tabs defaultValue="chat" value={activeTab} onValueChange={setActiveTab} className="w-full">
            <TabsList className="grid w-full grid-cols-5 p-1 bg-muted/50 rounded-xl text-xs">
              <TabsTrigger
                value="chat"
                className="rounded-lg data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm px-1 font-medium"
              >
                <MessageSquare className="h-3.5 w-3.5 mr-1 text-primary" />
                群聊
              </TabsTrigger>
              <TabsTrigger
                value="members"
                className="rounded-lg data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm px-1"
              >
                <Users className="h-3.5 w-3.5 mr-1" />
                成员
              </TabsTrigger>
              <TabsTrigger
                value="agents"
                className="rounded-lg data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm px-1"
              >
                <Bot className="h-3.5 w-3.5 mr-1 text-purple-500" />
                AI 哨兵
              </TabsTrigger>
              <TabsTrigger
                value="transactions"
                className="rounded-lg data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm px-1"
              >
                <Share2 className="h-3.5 w-3.5 mr-1" />
                Tx
              </TabsTrigger>
              <TabsTrigger
                value="receive"
                className="rounded-lg data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm px-1"
              >
                <QrCode className="h-3.5 w-3.5 mr-1" />
                Receive
              </TabsTrigger>
            </TabsList>

            <AnimatePresence mode="wait">
              {activeTab === "chat" && (
                <TabsContent value="chat" className="mt-3 space-y-3">
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    transition={{ duration: 0.2 }}
                    className="space-y-3"
                  >
                    {/* 顶部简洁状态栏 */}
                    <div className="px-3 py-2 rounded-xl bg-muted/40 border border-border/50 text-xs flex items-center justify-between">
                      <div className="flex items-center space-x-2">
                        <span className="w-2 h-2 rounded-full bg-emerald-500"></span>
                        <span className="text-[11px] text-muted-foreground">
                          群金库: <strong className="text-foreground font-semibold">{group.balance} {group.token}</strong>
                        </span>
                      </div>
                      <div className="flex items-center space-x-1.5">
                        {creatorRevenuePool > 0 && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={handleClaimRevenue}
                            className="h-6 text-[10px] px-2 text-amber-600 hover:text-amber-700 hover:bg-amber-500/10"
                          >
                            提取收益 ({creatorRevenuePool.toFixed(1)} SUI)
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setUseSubagentCap(!useSubagentCap)}
                          className="h-6 text-[10px] px-2 text-muted-foreground hover:text-foreground"
                          title={useSubagentCap ? "免密快速发信" : "每次弹窗确认"}
                        >
                          {useSubagentCap ? "⚡ 免密模式" : "🛡️ 每次确认"}
                        </Button>
                      </div>
                    </div>

                    {/* 动态通知 Banner */}
                    <AnimatePresence>
                      {claimedNotice && (
                        <motion.div
                          initial={{ opacity: 0, height: 0 }}
                          animate={{ opacity: 1, height: "auto" }}
                          exit={{ opacity: 0, height: 0 }}
                          className="p-2 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-600 dark:text-emerald-400 text-xs flex items-center justify-between"
                        >
                          <div className="flex items-center gap-1.5">
                            <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                            <span>{claimedNotice}</span>
                          </div>
                          <button
                            type="button"
                            onClick={() => setClaimedNotice(null)}
                            className="text-xs opacity-60 hover:opacity-100 px-1"
                          >
                            ✕
                          </button>
                        </motion.div>
                      )}
                    </AnimatePresence>

                    {/* 消息流 */}
                    <div className="h-[340px] sm:h-[380px] overflow-y-auto space-y-2.5 p-2.5 rounded-xl bg-muted/20 border border-border/40 text-xs">
                      {messages.map((m) => (
                        <div
                          key={m.id}
                          className={`flex flex-col ${m.sender.startsWith("You") ? "items-end" : "items-start"}`}
                        >
                          <div className="flex items-center space-x-1.5 mb-0.5 text-[10px] text-muted-foreground">
                            <span className="font-medium text-foreground">{m.sender}</span>
                            <span>({m.role})</span>
                            <span>{m.time}</span>
                          </div>
                          <div
                            className={`p-2.5 rounded-xl max-w-[85%] text-xs leading-relaxed ${
                              m.sender.startsWith("You")
                                ? "bg-primary text-primary-foreground rounded-tr-none shadow-sm"
                                : m.sender === "Sentinel-AI"
                                ? "bg-purple-500/15 border border-purple-500/30 text-foreground rounded-tl-none font-mono text-[11px]"
                                : "bg-card border border-border/60 text-foreground rounded-tl-none"
                            }`}
                          >
                            <p className="whitespace-pre-wrap">{m.text}</p>
                            {m.redPacketId && redPackets[m.redPacketId] && (
                              <div
                                id={`red-packet-card-${m.redPacketId}`}
                                onClick={(e) => {
                                  e.stopPropagation()
                                  handleOpenRedPacketClaim(m.redPacketId!)
                                }}
                                className="mt-2 p-3 rounded-xl bg-gradient-to-br from-red-600 via-rose-600 to-amber-600 text-white cursor-pointer shadow-md hover:shadow-red-500/30 hover:scale-[1.01] transition-all select-none border border-amber-300/30"
                              >
                                <div className="flex items-center space-x-2.5">
                                  <div className="w-8 h-8 rounded-xl bg-amber-400/20 border border-amber-300/50 flex items-center justify-center text-base shadow-inner">
                                    🧧
                                  </div>
                                  <div className="flex-1 min-w-0">
                                    <p className="text-xs font-bold text-white truncate">
                                      {redPackets[m.redPacketId].greeting}
                                    </p>
                                    <p className="text-[10px] text-amber-200 flex items-center gap-1 mt-0.5 font-medium">
                                      {redPackets[m.redPacketId].remainingCount > 0 ? (
                                        <span>
                                          点击开红包 · 剩 {redPackets[m.redPacketId].remainingCount}/
                                          {redPackets[m.redPacketId].totalCount} 份
                                        </span>
                                      ) : (
                                        <span className="text-white/80">已被领完 · 查看手气榜</span>
                                      )}
                                    </p>
                                  </div>
                                </div>
                                <div className="mt-2 pt-1.5 border-t border-white/20 flex justify-between items-center text-[9px] text-white/80">
                                  <span>
                                    {redPackets[m.redPacketId].packetType === "LUCKY_RANDOM"
                                      ? "拼手气红包"
                                      : "普通红包"}
                                  </span>
                                  <span className="font-semibold text-amber-200">
                                    {redPackets[m.redPacketId].totalAmount} SUI
                                  </span>
                                </div>
                              </div>
                            )}
                            {m.walrusBlobId && (
                              <button
                                type="button"
                                id={`blob-btn-${m.id}`}
                                onClick={(e) => {
                                  e.stopPropagation()
                                  if (m.walrusBlobId!.endsWith(".wma")) {
                                    setSelectedAppBlobId(m.walrusBlobId!)
                                    setIsAppSandboxOpen(true)
                                  } else {
                                    setSelectedBlobId(m.walrusBlobId!)
                                  }
                                }}
                                className="mt-2 pt-1.5 border-t border-white/20 text-[10px] flex items-center justify-between gap-1.5 text-cyan-200 hover:text-white transition-colors cursor-pointer w-full text-left"
                              >
                                <div className="flex items-center gap-1.5 truncate">
                                  {m.walrusBlobId.endsWith(".wma") ? (
                                    <Vote className="h-3 w-3 shrink-0 text-purple-300" />
                                  ) : (
                                    <FileText className="h-3 w-3 shrink-0 text-cyan-300" />
                                  )}
                                  <span className="truncate">
                                    {m.walrusBlobId.endsWith(".wma") ? "群投票：跨链治理方案" : "附件文档：治理提案规范"}
                                  </span>
                                </div>
                                <span className="text-[9px] bg-white/20 px-1.5 py-0.5 rounded text-white shrink-0">
                                  {m.walrusBlobId.endsWith(".wma") ? "去投票" : "查看"}
                                </span>
                              </button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>

                    {/* 快捷指令弹出面板 */}
                    <AnimatePresence>
                      {(chatInput.startsWith("/") || showSlashMenu) && (
                        <motion.div
                          initial={{ opacity: 0, y: 8, scale: 0.98 }}
                          animate={{ opacity: 1, y: 0, scale: 1 }}
                          exit={{ opacity: 0, y: 8, scale: 0.98 }}
                          className="p-2 rounded-xl bg-card border border-border shadow-xl space-y-1 text-xs"
                        >
                          <div className="flex items-center justify-between px-2 py-1 text-[10px] text-muted-foreground border-b border-border/40">
                            <span className="flex items-center gap-1 font-semibold text-foreground">
                              <Sparkles className="h-3 w-3 text-primary" />
                              快捷功能
                            </span>
                            <span>点击快速使用</span>
                          </div>
                          <div className="grid grid-cols-2 gap-1 pt-1">
                            <button
                              type="button"
                              onClick={() => handleTriggerSlash("/redpacket")}
                              className="flex items-center space-x-2 p-1.5 rounded-lg hover:bg-muted text-left transition-colors cursor-pointer group"
                            >
                              <div className="p-1 rounded bg-red-500/10 text-red-500 group-hover:bg-red-500/20">
                                <Gift className="h-3.5 w-3.5" />
                              </div>
                              <div className="truncate">
                                <p className="font-semibold text-[11px] text-foreground">发红包</p>
                                <p className="text-[10px] text-muted-foreground truncate">/redpacket</p>
                              </div>
                            </button>

                            <button
                              type="button"
                              onClick={() => handleTriggerSlash("/tip")}
                              className="flex items-center space-x-2 p-1.5 rounded-lg hover:bg-muted text-left transition-colors cursor-pointer group"
                            >
                              <div className="p-1 rounded bg-amber-500/10 text-amber-500 group-hover:bg-amber-500/20">
                                <Coins className="h-3.5 w-3.5" />
                              </div>
                              <div className="truncate">
                                <p className="font-semibold text-[11px] text-foreground">打赏群友</p>
                                <p className="text-[10px] text-muted-foreground truncate">/tip @Eve 1.0</p>
                              </div>
                            </button>

                            <button
                              type="button"
                              id="btn-slash-app"
                              onClick={() => handleTriggerSlash("/app")}
                              className="flex items-center space-x-2 p-1.5 rounded-lg hover:bg-muted text-left transition-colors cursor-pointer group"
                            >
                              <div className="p-1 rounded bg-purple-500/10 text-purple-500 group-hover:bg-purple-500/20">
                                <Vote className="h-3.5 w-3.5" />
                              </div>
                              <div className="truncate">
                                <p className="font-semibold text-[11px] text-foreground">群投票</p>
                                <p className="text-[10px] text-muted-foreground truncate">/app</p>
                              </div>
                            </button>

                            <button
                              type="button"
                              onClick={() => handleTriggerSlash("/stats")}
                              className="flex items-center space-x-2 p-1.5 rounded-lg hover:bg-muted text-left transition-colors cursor-pointer group"
                            >
                              <div className="p-1 rounded bg-emerald-500/10 text-emerald-500 group-hover:bg-emerald-500/20">
                                <Bot className="h-3.5 w-3.5" />
                              </div>
                              <div className="truncate">
                                <p className="font-semibold text-[11px] text-foreground">资产简报</p>
                                <p className="text-[10px] text-muted-foreground truncate">/stats</p>
                              </div>
                            </button>
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>

                    {/* 消息输入框与快捷栏 */}
                    <div className="flex items-center space-x-1.5 pt-1">
                      <Button
                        size="sm"
                        variant="outline"
                        type="button"
                        onClick={() => setShowSlashMenu((prev) => !prev)}
                        className={`h-8 px-2 text-xs gap-1 shrink-0 ${
                          showSlashMenu
                            ? "bg-primary/10 text-primary border-primary/30"
                            : "text-muted-foreground hover:text-foreground"
                        }`}
                        title="快捷功能"
                      >
                        <Plus className="h-3.5 w-3.5" />
                        <span className="hidden sm:inline">快捷</span>
                      </Button>

                      <Button
                        size="sm"
                        variant="outline"
                        type="button"
                        onClick={() => {
                          setRedPacketDialogMode("create")
                          setIsRedPacketDialogOpen(true)
                        }}
                        className="h-8 px-2 text-xs gap-1 border-red-500/30 text-red-500 hover:bg-red-500/10 hover:text-red-600 shrink-0"
                        title="发红包"
                      >
                        <Gift className="h-3.5 w-3.5 text-red-500" />
                        <span className="hidden sm:inline">红包</span>
                      </Button>

                      <Input
                        placeholder="输入消息，或输入 / 使用快捷功能..."
                        value={chatInput}
                        onChange={(e) => setChatInput(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && handleSendMessage(false)}
                        className="h-8 text-xs bg-muted/30 focus-visible:ring-1 flex-1"
                      />

                      <Button
                        size="sm"
                        variant="ghost"
                        type="button"
                        onClick={() => handleSendMessage(true)}
                        className="h-8 px-2 text-xs gap-1 text-muted-foreground hover:text-foreground shrink-0"
                        title="发送附件文档"
                      >
                        <Paperclip className="h-3.5 w-3.5" />
                        <span className="hidden sm:inline">附件</span>
                      </Button>

                      <Button size="sm" type="button" onClick={() => handleSendMessage(false)} className="h-8 px-3 text-xs gap-1 shrink-0 bg-primary text-primary-foreground">
                        <Send className="h-3 w-3" />
                        <span>发送</span>
                      </Button>
                    </div>
                  </motion.div>
                </TabsContent>
              )}
              {activeTab === "members" && (
                <TabsContent value="members" className="mt-3 space-y-2">
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    transition={{ duration: 0.2 }}
                  >
                    {isConvertedToDao ? (
                      <div className="p-2.5 rounded-xl bg-purple-500/10 border border-purple-500/30 flex items-center justify-between text-xs mb-3">
                        <div className="flex items-center space-x-2">
                          <Network className="h-4 w-4 text-purple-500" />
                          <div>
                            <p className="font-semibold text-purple-600 dark:text-purple-400">已固化为密码学组织 (DAO)</p>
                            <p className="text-[10px] text-muted-foreground font-mono truncate max-w-[200px]">
                              PK: {groupPk || "0x678a...2018"}
                            </p>
                          </div>
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setIsDkgOpen(true)}
                          className="h-7 text-[11px] border-purple-500/30 text-purple-500 hover:bg-purple-500/10"
                        >
                          换届重分片
                        </Button>
                      </div>
                    ) : (
                      <div className="p-2.5 rounded-xl bg-primary/5 border border-primary/20 flex items-center justify-between text-xs mb-3">
                        <div>
                          <p className="font-semibold text-foreground flex items-center">
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 mr-1.5 inline-block animate-pulse"></span>
                            当前为轻量 P2P 聊天群
                          </p>
                          <p className="text-[11px] text-muted-foreground">随时执行 DKG 仪式上链固化为 DAO</p>
                        </div>
                        <Button
                          size="sm"
                          onClick={() => setIsDkgOpen(true)}
                          className="h-7 text-[11px] bg-primary text-primary-foreground hover:bg-primary/90"
                        >
                          <Sparkles className="h-3 w-3 mr-1" />
                          Convert to DAO
                        </Button>
                      </div>
                    )}

                    {group.members.map((member, index) => (
                      <div
                        key={index}
                        className="flex items-center justify-between p-2 rounded-lg hover:bg-muted/50 transition-colors"
                      >
                        <div className="flex items-center">
                          <Avatar className="h-8 w-8 mr-3">
                            <AvatarFallback
                              className={`text-white ${
                                member.name === "You"
                                  ? "bg-gradient-to-br from-primary to-purple-500"
                                  : "bg-gradient-to-br from-gray-500 to-gray-600"
                              }`}
                            >
                              {member.name[0]}
                            </AvatarFallback>
                          </Avatar>
                          <div>
                            <p className="font-medium text-sm">{member.name}</p>
                            {member.address.includes("@") ? (
                              <p className="text-xs text-muted-foreground flex items-center">
                                <span className="text-xs bg-blue-100 text-blue-600 px-1 rounded mr-1">@</span>
                                {member.address}
                              </p>
                            ) : (
                              <p className="text-xs text-muted-foreground flex items-center">
                                <span className="text-xs bg-purple-100 text-purple-600 px-1 rounded mr-1">Ξ</span>
                                {member.address.slice(0, 6)}...{member.address.slice(-4)}
                              </p>
                            )}
                          </div>
                        </div>
                        <div className="text-right">
                          <Badge variant="outline" className="text-xs">
                            Weight: {member.weight}
                          </Badge>
                        </div>
                      </div>
                    ))}

                    <div className="mt-4 p-3 rounded-lg bg-accent/30">
                      <p className="text-xs">
                        This group requires at least {group.threshold} weight units (
                        {Math.round((group.threshold / group.totalWeight) * 100)}% of total) to approve transactions.
                      </p>
                    </div>
                  </motion.div>
                </TabsContent>
              )}

              {activeTab === "agents" && (
                <TabsContent value="agents" className="mt-3 space-y-2.5">
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    transition={{ duration: 0.2 }}
                    className="space-y-2.5"
                  >
                    <div className="flex items-center justify-between text-xs mb-1">
                      <span className="text-muted-foreground font-medium">群内 AI 助手</span>
                      <Badge variant="outline" className="text-[10px]">
                        限额管理
                      </Badge>
                    </div>
                    {group.agents.map((agent) => (
                      <div
                        key={agent.id}
                        className="p-3 rounded-xl border border-border/60 bg-card/60 space-y-2"
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-primary to-purple-600 flex items-center justify-center text-white">
                              <Bot className="w-3.5 h-3.5" />
                            </div>
                            <div>
                              <p className="font-semibold text-xs">{agent.name}</p>
                              <p className="text-[10px] text-muted-foreground">{agent.purpose}</p>
                            </div>
                          </div>
                          <Badge
                            variant="outline"
                            className={`text-[9px] ${
                              agent.status === "ACTIVE"
                                ? "bg-emerald-500/10 text-emerald-500 border-emerald-500/20"
                                : "bg-amber-500/10 text-amber-500 border-amber-500/20"
                            }`}
                          >
                            {agent.status === "ACTIVE" ? "运行中" : "已达限额"}
                          </Badge>
                        </div>
                        <div className="space-y-1">
                          <div className="flex justify-between text-[11px] text-muted-foreground">
                            <span>今日消耗 / 每日限额</span>
                            <span className="font-mono text-foreground font-medium">
                              {agent.spent} / {agent.budget} SUI
                            </span>
                          </div>
                          <Progress value={(agent.spent / agent.budget) * 100} className="h-1.5" />
                        </div>
                      </div>
                    ))}
                    <div className="p-2.5 rounded-lg bg-muted/30 border border-border/50 text-[11px] text-muted-foreground space-y-1">
                      <span className="font-semibold text-foreground flex items-center gap-1">
                        <ShieldCheck className="w-3.5 h-3.5 text-primary" />
                        安全限额保护
                      </span>
                      <p>
                        AI 助手仅在设定额度内运行，超出每日限额将自动暂停，保障金库安全。
                      </p>
                    </div>
                  </motion.div>
                </TabsContent>
              )}

              {activeTab === "transactions" && (
                <TabsContent value="transactions" className="mt-3 space-y-3">
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    transition={{ duration: 0.2 }}
                  >
                    <div className="flex justify-end mb-2">
                      <Button
                        size="sm"
                        onClick={() => setIsCreateTxOpen(true)}
                        className="bg-gradient-to-r from-primary to-purple-500 hover:from-primary/90 hover:to-purple-500/90"
                      >
                        <Plus className="h-4 w-4 mr-1" /> New Transaction
                      </Button>
                    </div>

                    {group.transactions.map((tx) => (
                      <div
                        key={tx.id}
                        className="p-3 rounded-lg border hover:bg-muted/50 transition-colors cursor-pointer"
                        onClick={() => setSelectedTx(tx.id)}
                      >
                        <div className="flex justify-between items-start">
                          <div>
                            <h3 className="font-medium text-sm">{tx.title}</h3>
                            <p className="text-xs text-muted-foreground">{tx.description}</p>
                          </div>
                          <Badge
                            variant={
                              tx.status === "executed"
                                ? "outline"
                                : tx.status === "rejected"
                                  ? "destructive"
                                  : "default"
                            }
                            className="text-xs"
                          >
                            {tx.status === "executed" ? "Executed" : tx.status === "rejected" ? "Rejected" : "Pending"}
                          </Badge>
                        </div>

                        <div className="flex justify-between mt-2">
                          <div className="text-xs text-muted-foreground">
                            {tx.type === "transfer" ? "Transfer" : "Contract Call"}
                          </div>
                          <div className="text-xs font-medium">
                            {tx.amount} {tx.token}
                          </div>
                        </div>

                        {tx.status === "pending" && (
                          <div className="mt-2 flex items-center justify-between">
                            <div className="text-xs text-muted-foreground">
                              Approvals: {tx.approvals}/{tx.requiredApprovals}
                            </div>
                            <Button size="sm" variant="outline" className="h-7 text-xs">
                              Review
                            </Button>
                          </div>
                        )}
                      </div>
                    ))}
                  </motion.div>
                </TabsContent>
              )}

              {activeTab === "receive" && (
                <TabsContent value="receive" className="mt-3 space-y-3">
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    transition={{ duration: 0.2 }}
                  >
                    <div className="flex flex-col items-center">
                      <div className="bg-white p-4 rounded-lg mb-3 relative group">
                        <div className="absolute inset-0 bg-gradient-to-r from-primary/20 to-purple-500/20 opacity-0 group-hover:opacity-100 transition-opacity rounded-lg"></div>
                        <QrCode className="h-40 w-40 text-primary" />
                        <div className="absolute inset-0 flex items-center justify-center">
                          <div className="h-10 w-10 rounded-full bg-white p-1">
                            <div className="h-full w-full rounded-full bg-gradient-to-r from-primary to-purple-500"></div>
                          </div>
                        </div>
                      </div>
                      <p className="text-sm font-medium">{group.name}</p>
                      <p className="text-xs text-muted-foreground mb-2">{shortAddress}</p>
                      <div className="flex space-x-2">
                        <Button variant="outline" size="sm" className="text-xs">
                          <Copy className="h-3 w-3 mr-1" /> Copy Address
                        </Button>
                        <Button variant="outline" size="sm" className="text-xs">
                          <Share2 className="h-3 w-3 mr-1" /> Share
                        </Button>
                      </div>
                    </div>

                    <div className="mt-4 p-3 rounded-lg bg-accent/30">
                      <p className="text-xs">
                        Send only {group.network} assets to this address. Sending other assets may result in permanent
                        loss.
                      </p>
                    </div>
                  </motion.div>
                </TabsContent>
              )}
            </AnimatePresence>
          </Tabs>
        </div>
      </DialogContent>

      <CreateTransactionDialog open={isCreateTxOpen} onOpenChange={setIsCreateTxOpen} groupId={groupId} />

      {selectedTx && (
        <TransactionDetailsDialog
          open={!!selectedTx}
          onOpenChange={() => setSelectedTx(null)}
          transactionId={selectedTx}
          groupId={groupId}
        />
      )}

      <DkgCeremonyDialog
        open={isDkgOpen}
        onOpenChange={setIsDkgOpen}
        groupName={group.name}
        initialMembers={group.members}
        onConvertedSuccess={(pk) => {
          setIsConvertedToDao(true);
          setGroupPk(pk);
        }}
      />

      <WalrusBlobDialog
        open={!!selectedBlobId}
        onOpenChange={() => setSelectedBlobId(null)}
        blobId={selectedBlobId}
      />

      <RedPacketDialog
        open={isRedPacketDialogOpen}
        onOpenChange={setIsRedPacketDialogOpen}
        mode={redPacketDialogMode}
        packetData={activeRedPacketId ? redPackets[activeRedPacketId] : null}
        onCreatePacket={handleCreateRedPacket}
        onClaimPacket={handleClaimRedPacket}
        onRefundPacket={handleRefundRedPacket}
      />

      <WalrusAppSandboxDialog
        open={isAppSandboxOpen}
        onOpenChange={setIsAppSandboxOpen}
        blobId={selectedAppBlobId}
        isMemberStaked={true}
      />
    </Dialog>
  )
}
