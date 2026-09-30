"use client"

import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { QrCode, Users, Share2, Copy, ExternalLink, Plus, Bot, Zap, ShieldCheck, Sparkles, Network, MessageSquare, Send, HardDrive, KeyRound, Paperclip, Crown, Coins, Gift, ArrowUpRight, DollarSign, CheckCircle2, Terminal, Flame } from "lucide-react"
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
      sender: "Alice (群主/创作者)",
      role: "👑 星球主 · Tokyo",
      time: "14:20",
      text: "欢迎新成员 Eve 进群！这是基于 Sui Move 质押建群+保本质押进群的 VIP 知识星球。全群免密发信 0 Gas，退群 100% 赎回质押本金！",
      isSubagent: true,
    },
    {
      id: "m2",
      sender: "Eve",
      role: "💎 舰长会员 · New York",
      time: "14:21",
      text: "大家好！我已质押 50 SUI 进群，持有 MemberStakeReceipt 权益凭证，免弹窗自动发信，还能参与全群 10% POS 生息分红！",
      isSubagent: true,
    },
    {
      id: "m3",
      sender: "Sentinel-AI",
      role: "🤖 24h 研报哨兵",
      time: "14:21",
      text: "🤖 哨兵就绪：检测到 VIP 专属研报附件已上链 Walrus，20% 利息池正自动为您报销 Gas，当前净花费 0 SUI！",
      walrusBlobId: "walrus_blob_0x7f8a9b_proposal_v2.pdf",
      isSubagent: true,
    },
    {
      id: "m4",
      sender: "Alice (群主/创作者)",
      role: "👑 星球主 · Tokyo",
      time: "14:22",
      text: "发出了一个链上拼手气红包！基于 Move 共享对象与二倍均值算法，大家快来开抢 🧧",
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
          sender: "You (via Subagent)",
          role: "VIP 舰长 · 0 Gas 免密",
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          text: "💰 [外挂/Slash] 点对点打赏：向 @Eve 支付 1.0 SUI 创作激励 (PTB 免密即刻确认)",
          isSubagent: true,
        },
      ])
      setClaimedNotice("✨ 点对点打赏已完成：1.0 SUI 已通过链上 PTB 直达 @Eve！")
      setTimeout(() => setClaimedNotice(null), 4000)
      return
    }

    if (cmd === "/app") {
      setIsAppSandboxOpen(true)
      setMessages(prev => [
        ...prev,
        {
          id: `m_${Date.now()}`,
          sender: "You (via Subagent)",
          role: "VIP 舰长 · 0 Gas 免密",
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          text: "🧩 [Walrus Mini-App] 启动了去中心化治理投票插件：选题《Sui 与 Aptos 跨链互操作方案探讨》(Blob ID: walrus_blob_app_poll_901)",
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
          sender: "You (via Subagent)",
          role: "VIP 舰长 · 0 Gas 免密",
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          text: "/stats 呼叫 24h AI 研报哨兵",
          isSubagent: true,
        },
        {
          id: `m_stat_${Date.now()}`,
          sender: "Sentinel-AI",
          role: "🤖 24h 研报哨兵",
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          text: `📊 【VIP 星球 24h 智能金库审计快报】\n• 创作者锁仓: ${creatorStake.toFixed(1)} SUI (保本锁定)\n• 累计门票与利息分润: ${creatorRevenuePool.toFixed(2)} SUI (随时提现)\n• 智能代付 Gas 池: ${gasSubsidyPool.toFixed(3)} SUI (已为群友报销 ${totalSubsidizedGas.toFixed(3)} SUI)\n• 粉丝 POS 利息分红池: ${memberYieldPool.toFixed(2)} SUI (退群均摊全退)\n• 链上安全状态: 🟢 形式化验证通过，0 资产穿仓风险`,
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
          role: "🤖 24h 研报哨兵",
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          text: "💡 【功能外挂与快捷指令指南】\n1. `/redpacket` - 塞钱发链上拼手气/等额红包\n2. `/tip @user [amount]` - 链上点对点打赏\n3. `/app [name]` - 启动 Walrus 去中心化 Mini-App\n4. `/stats` - 呼叫 AI 哨兵生成星球收益统计与链上状态\n5. 输入 `/` 随时弹出外挂功能托盘！",
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
        sender: useSubagentCap ? "You (via Subagent)" : "You",
        role: useSubagentCap ? "VIP 舰长 · 0 Gas 免密" : "Master 签名",
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
    setClaimedNotice(`🎉 提现成功：已提取 ${amount.toFixed(2)} SUI 创作者收益 (门票+70%生息分润) 直达 Alice 钱包！`)
    setTimeout(() => setClaimedNotice(null), 5000)
  }

  const handleMemberUnstake = () => {
    setClaimedNotice(`🛡️ 粉丝保本退群：销毁 MemberStakeReceipt，100% 赎回 50.00 SUI 进群质押本金 + 0.50 SUI 均摊分红 (共 50.50 SUI)！零沉没成本。`)
    setTimeout(() => setClaimedNotice(null), 5000)
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
      { id: "agent-sentinel", name: "Sentinel-AI (24h MPC 哨兵)", purpose: "24/7 永不离线 MPC 协签 · 跨时区 0 阻塞 · 时延 <10ms", budget: 100, spent: 12.5, status: "ACTIVE" },
      { id: "agent-1", name: "DeepSeek-Reasoner-01", purpose: "x402 Model Inference", budget: 10, spent: 4.2, status: "ACTIVE" },
      { id: "agent-2", name: "Web-Scraper-Proxy", purpose: "Market Intel Scraping", budget: 2, spent: 2.0, status: "QUOTA_REACHED" },
    ],
    color: "from-primary to-purple-500",
  }

  const shortAddress = `${group.address.slice(0, 6)}...${group.address.slice(-4)}`

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px] p-0 gap-0 overflow-hidden">
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
                    {/* 双轨解耦状态栏与 Subagent 免密 Cap 控制 */}
                    <div className="p-2.5 rounded-xl bg-gradient-to-r from-emerald-500/10 via-primary/10 to-purple-500/10 border border-emerald-500/20 text-xs flex flex-col gap-2">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center space-x-2">
                          <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
                          <div>
                            <p className="font-semibold text-foreground text-[11px] flex items-center gap-1.5">
                              <span>Sui On-Chain + Walrus 去中心化存储轨</span>
                              <Badge variant="outline" className="text-[9px] h-4 px-1 bg-emerald-500/10 text-emerald-600 border-emerald-500/30">双轨在线</Badge>
                            </p>
                            <p className="text-[10px] text-muted-foreground">
                              {isConvertedToDao ? "Epoch 1 (DAO 固化) · AI 哨兵就绪" : "待执行 DKG 固化 · 7 天免密发信会话"}
                            </p>
                          </div>
                        </div>
                        <Button
                          size="sm"
                          variant={useSubagentCap ? "default" : "outline"}
                          onClick={() => setUseSubagentCap(!useSubagentCap)}
                          className={`h-6 text-[10px] px-2 gap-1 transition-all ${
                            useSubagentCap
                              ? "bg-gradient-to-r from-primary to-purple-600 text-white shadow-sm"
                              : "border-border text-muted-foreground"
                          }`}
                        >
                          <KeyRound className="h-3 w-3" />
                          {useSubagentCap ? "Subagent Cap (免密)" : "主钱包每次弹窗"}
                        </Button>
                      </div>
                    </div>

                    {/* 知识星球 / OnlyFans / 舰长会员群 经济学生态面板 */}
                    <div className="p-3 rounded-xl bg-card border border-purple-500/30 text-xs shadow-sm space-y-2.5">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-1.5">
                          <Crown className="h-4 w-4 text-amber-500" />
                          <span className="font-semibold text-[12px] text-foreground">VIP 星球 / 粉丝群经济学</span>
                          <Badge variant="secondary" className="text-[9px] h-4 px-1.5 bg-purple-500/10 text-purple-600 border border-purple-500/30">
                            保本质押 · 自动分润
                          </Badge>
                          <Badge variant="outline" className="text-[9px] h-4 px-1.5 bg-cyan-500/10 text-cyan-600 border border-cyan-500/30">
                            Scallop sSUI 秒级复利
                          </Badge>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={handleClaimRevenue}
                            disabled={creatorRevenuePool <= 0}
                            className="h-6 text-[10px] px-2 text-amber-600 hover:text-amber-700 hover:bg-amber-500/10 border border-amber-500/30"
                          >
                            <DollarSign className="h-3 w-3 mr-0.5" />
                            提现收益 ({creatorRevenuePool.toFixed(1)} SUI)
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={handleMemberUnstake}
                            className="h-6 text-[10px] px-2 text-cyan-600 hover:text-cyan-700 hover:bg-cyan-500/10 border border-cyan-500/30"
                          >
                            <ShieldCheck className="h-3 w-3 mr-0.5" />
                            保本退群 (赎回50.5 SUI)
                          </Button>
                        </div>
                      </div>

                      {/* 4 项核心经济学指标 */}
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[10px]">
                        <div className="p-2 rounded-lg bg-muted/40 border border-border/50">
                          <p className="text-muted-foreground flex items-center gap-1">
                            <Coins className="h-3 w-3 text-amber-500" />
                            建群质押储备
                          </p>
                          <p className="font-semibold text-foreground text-[11px] mt-0.5">{creatorStake.toFixed(1)} SUI</p>
                          <p className="text-[9px] text-emerald-600">群主保本锁仓</p>
                        </div>

                        <div className="p-2 rounded-lg bg-muted/40 border border-border/50">
                          <p className="text-muted-foreground flex items-center gap-1">
                            <Crown className="h-3 w-3 text-purple-500" />
                            门票 / 质押进群
                          </p>
                          <p className="font-semibold text-foreground text-[11px] mt-0.5">{entryFee} SUI + {memberStake} 质押</p>
                          <p className="text-[9px] text-cyan-600">退群 100% 退本金</p>
                        </div>

                        <div className="p-2 rounded-lg bg-muted/40 border border-border/50">
                          <p className="text-muted-foreground flex items-center gap-1">
                            <Zap className="h-3 w-3 text-emerald-500" />
                            全群 Gas 代付池
                          </p>
                          <p className="font-semibold text-foreground text-[11px] mt-0.5">{gasSubsidyPool.toFixed(3)} SUI</p>
                          <p className="text-[9px] text-emerald-600">20% 利息 · 净Gas=0</p>
                        </div>

                        <div className="p-2 rounded-lg bg-muted/40 border border-border/50">
                          <p className="text-muted-foreground flex items-center gap-1">
                            <Gift className="h-3 w-3 text-pink-500" />
                            粉丝利息分红池
                          </p>
                          <p className="font-semibold text-foreground text-[11px] mt-0.5">{memberYieldPool.toFixed(2)} SUI</p>
                          <p className="text-[9px] text-pink-600">10% 利息 · 粉丝分红</p>
                        </div>
                      </div>

                      {/* 动态通知 Banner */}
                      <AnimatePresence>
                        {claimedNotice && (
                          <motion.div
                            initial={{ opacity: 0, height: 0 }}
                            animate={{ opacity: 1, height: "auto" }}
                            exit={{ opacity: 0, height: 0 }}
                            className="p-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-600 text-[10px] flex items-center gap-1.5"
                          >
                            <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                            <span>{claimedNotice}</span>
                          </motion.div>
                        )}
                        {rebatePill && (
                          <motion.div
                            initial={{ opacity: 0, height: 0 }}
                            animate={{ opacity: 1, height: "auto" }}
                            exit={{ opacity: 0, height: 0 }}
                            className="p-1.5 rounded-lg bg-cyan-500/10 border border-cyan-500/30 text-cyan-600 text-[10px] flex items-center gap-1.5"
                          >
                            <Sparkles className="h-3.5 w-3.5 shrink-0" />
                            <span>{rebatePill}</span>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>

                    {/* 消息流 */}
                    <div className="h-56 overflow-y-auto space-y-2.5 p-2 rounded-xl bg-muted/20 border border-border/40 text-xs">
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
                            className={`p-2 rounded-xl max-w-[85%] text-xs leading-relaxed ${
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
                                className="mt-2 p-3 rounded-xl bg-gradient-to-br from-red-600 via-rose-600 to-amber-600 text-white cursor-pointer shadow-lg hover:shadow-red-500/30 hover:scale-[1.01] transition-all select-none border border-amber-300/30"
                              >
                                <div className="flex items-center space-x-2.5">
                                  <div className="w-9 h-9 rounded-xl bg-amber-400/20 border border-amber-300/50 flex items-center justify-center text-lg shadow-inner">
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
                                        <span className="text-white/80">已被领完 · 查看手气榜 ↗</span>
                                      )}
                                    </p>
                                  </div>
                                </div>
                                <div className="mt-2 pt-1.5 border-t border-white/20 flex justify-between items-center text-[9px] text-white/80">
                                  <span>
                                    {redPackets[m.redPacketId].packetType === "LUCKY_RANDOM"
                                      ? "拼手气红包 (随机)"
                                      : "普通红包 (等额)"}
                                  </span>
                                  <span className="font-mono font-bold text-amber-200">
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
                                className="mt-1.5 pt-1.5 border-t border-white/20 text-[10px] flex items-center justify-between gap-1.5 font-mono text-cyan-200 hover:text-white transition-colors cursor-pointer w-full text-left group/blob"
                              >
                                <div className="flex items-center gap-1.5 truncate">
                                  <HardDrive className="h-3 w-3 shrink-0 text-cyan-400 group-hover/blob:text-cyan-300" />
                                  <span className="truncate underline underline-offset-2">
                                    {m.walrusBlobId.endsWith(".wma") ? `Walrus App: ${m.walrusBlobId}` : `Walrus: ${m.walrusBlobId}`}
                                  </span>
                                </div>
                                <span className="text-[9px] bg-cyan-500/20 group-hover/blob:bg-cyan-500/30 px-1 py-0.5 rounded text-cyan-300 shrink-0">
                                  {m.walrusBlobId.endsWith(".wma") ? "运行沙箱 🛡️" : "查看解密 ↗"}
                                </span>
                              </button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>

                    {/* Slash Command 外挂菜单悬浮面板 */}
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
                              <Terminal className="h-3 w-3 text-primary" />
                              Slash 外挂指令系统 (Sui Move + Walrus)
                            </span>
                            <span>点击或输入快捷键触发</span>
                          </div>
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1 pt-1">
                            <button
                              type="button"
                              onClick={() => handleTriggerSlash("/redpacket")}
                              className="flex items-center space-x-2 p-1.5 rounded-lg hover:bg-muted text-left transition-colors cursor-pointer group"
                            >
                              <div className="p-1 rounded bg-red-500/10 text-red-500 group-hover:bg-red-500/20">
                                <Gift className="h-3.5 w-3.5" />
                              </div>
                              <div className="truncate">
                                <p className="font-mono font-semibold text-[11px] text-foreground">/redpacket</p>
                                <p className="text-[10px] text-muted-foreground truncate">塞钱发链上拼手气红包</p>
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
                                <p className="font-mono font-semibold text-[11px] text-foreground">/tip @Eve 1.0</p>
                                <p className="text-[10px] text-muted-foreground truncate">点对点打赏创作者</p>
                              </div>
                            </button>

                            <button
                              type="button"
                              id="btn-slash-app"
                              onClick={() => handleTriggerSlash("/app")}
                              className="flex items-center space-x-2 p-1.5 rounded-lg hover:bg-muted text-left transition-colors cursor-pointer group"
                            >
                              <div className="p-1 rounded bg-purple-500/10 text-purple-500 group-hover:bg-purple-500/20">
                                <Sparkles className="h-3.5 w-3.5" />
                              </div>
                              <div className="truncate">
                                <p className="font-mono font-semibold text-[11px] text-foreground">/app poll</p>
                                <p className="text-[10px] text-muted-foreground truncate">启动 Walrus 去中心化轻应用</p>
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
                                <p className="font-mono font-semibold text-[11px] text-foreground">/stats</p>
                                <p className="text-[10px] text-muted-foreground truncate">呼叫 24h AI 研报哨兵审计</p>
                              </div>
                            </button>
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>

                    {/* 快速消息输入框与 Walrus 附件及外挂快捷键 */}
                    <div className="flex items-center space-x-1.5 pt-1">
                      <Button
                        size="sm"
                        variant="outline"
                        type="button"
                        onClick={() => setShowSlashMenu((prev) => !prev)}
                        className={`h-8 px-2 text-xs gap-1 border-dashed shrink-0 ${
                          showSlashMenu
                            ? "bg-primary/10 text-primary border-primary/30"
                            : "text-muted-foreground hover:text-foreground"
                        }`}
                        title="查看功能外挂与快捷指令 (Slash Commands)"
                      >
                        <Terminal className="h-3 w-3 text-primary" />
                        <span className="hidden sm:inline">外挂</span>
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
                        title="塞钱发链上拼手气红包"
                      >
                        <Gift className="h-3 w-3 text-red-500" />
                        <span className="hidden sm:inline">发红包</span>
                      </Button>

                      <Input
                        placeholder={
                          useSubagentCap
                            ? "输入消息或 / 查看外挂 (Subagent 免密自动签名)..."
                            : "输入消息或 / 查看外挂 (主钱包每次弹窗签名)..."
                        }
                        value={chatInput}
                        onChange={(e) => setChatInput(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && handleSendMessage(false)}
                        className="h-8 text-xs bg-muted/30 focus-visible:ring-1 flex-1"
                      />

                      <Button
                        size="sm"
                        variant="outline"
                        type="button"
                        onClick={() => handleSendMessage(true)}
                        className="h-8 px-2 text-xs gap-1 border-dashed text-muted-foreground hover:text-foreground shrink-0"
                        title="模拟上传加密大文件至 Walrus 并广播 Blob ID"
                      >
                        <Paperclip className="h-3 w-3" />
                        <span className="hidden sm:inline">Walrus</span>
                      </Button>

                      <Button size="sm" type="button" onClick={() => handleSendMessage(false)} className="h-8 px-3 text-xs gap-1 shrink-0">
                        <Send className="h-3 w-3" />
                        发送
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
                      <span className="text-muted-foreground font-medium">绑定受限 AI 虚拟副卡</span>
                      <Badge variant="outline" className="text-[10px] bg-primary/10 text-primary border-primary/20">
                        Sui Move 沙盒
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
                            {agent.status}
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
                    <div className="p-2.5 rounded-lg bg-primary/5 border border-primary/20 text-[11px] text-muted-foreground space-y-1">
                      <span className="font-semibold text-foreground flex items-center gap-1">
                        <ShieldCheck className="w-3.5 h-3.5 text-primary" />
                        x402 微支付防护机制
                      </span>
                      <p>
                        AI 副卡不持有金库主私钥，仅能在每日限额内扣除 SUI 代币用于调用模型 API。
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

          <div className="flex justify-between pt-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          </div>
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
