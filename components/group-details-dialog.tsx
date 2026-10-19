"use client"

import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  QrCode,
  Users,
  Share2,
  Copy,
  ExternalLink,
  Plus,
  Bot,
  Zap,
  ShieldCheck,
  Sparkles,
  Network,
  MessageSquare,
  Send,
  HardDrive,
  KeyRound,
  Paperclip,
  Crown,
  Coins,
  Gift,
  ArrowUpRight,
  DollarSign,
  CheckCircle2,
  Terminal,
  Flame,
  Vote,
  FileText,
  UploadCloud,
  Download,
  Loader2,
  FileUp,
} from "lucide-react"
import { Progress } from "@/components/ui/progress"
import { Input } from "@/components/ui/input"
import { useState, useEffect, useRef } from "react"
import { motion, AnimatePresence } from "framer-motion"
import { CreateTransactionDialog } from "@/components/create-transaction-dialog"
import { TransactionDetailsDialog } from "@/components/transaction-details-dialog"
import { DkgCeremonyDialog } from "@/components/dkg-ceremony-dialog"
import { WalrusBlobDialog } from "@/components/walrus-blob-dialog"
import { RedPacketDialog, RedPacketData } from "@/components/red-packet-dialog"
import { WalrusAppSandboxDialog } from "@/components/walrus-app-sandbox-dialog"
import { getActiveAccount, fetchRealBalances, getProposals, ProposalItem, vaultClient } from "@/lib/onchain-store"
import {
  uploadToWalrus,
  downloadFromWalrus,
  getGroupWalrusFiles,
  addGroupWalrusFile,
  GroupFileInfo,
  WALRUS_AGGREGATOR_URL,
} from "@/lib/walrus-client"
import { signAndExecuteWithWallet } from "@/lib/sui-wallet-signer"

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
  const [orgObjectId, setOrgObjectId] = useState("")
  const [orgEpoch, setOrgEpoch] = useState(1)
  const [orgTxDigest, setOrgTxDigest] = useState("")
  const [realGroupData, setRealGroupData] = useState<any>(null)
  const [groupBalance, setGroupBalance] = useState<number>(1250)
  const [realProposals, setRealProposals] = useState<ProposalItem[]>([])

  // Walrus 群文件管理状态
  const [groupFiles, setGroupFiles] = useState<GroupFileInfo[]>([])
  const [isUploadingFile, setIsUploadingFile] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const acc = getActiveAccount()
    if (acc?.address) {
      fetchRealBalances(acc.address)
        .then((b) => {
          const val = parseFloat(b.sui.balance)
          if (!isNaN(val) && val > 0) {
            setGroupBalance(val)
          }
        })
        .catch(() => {})
    }
  }, [groupId])

  // 恢复群提案与真实群组
  useEffect(() => {
    const loadProps = () => {
      setRealProposals(getProposals())
    }
    loadProps()
    window.addEventListener("sui-proposals-updated", loadProps)
    return () => window.removeEventListener("sui-proposals-updated", loadProps)
  }, [])

  // 恢复群文件列表
  useEffect(() => {
    if (!groupId) return
    const loadFiles = () => {
      setGroupFiles(getGroupWalrusFiles(groupId))
    }
    loadFiles()
    window.addEventListener("walrus-files-updated", loadFiles)
    return () => window.removeEventListener("walrus-files-updated", loadFiles)
  }, [groupId])

  // Restore DAO lifecycle state from localStorage across closes/refreshes
  useEffect(() => {
    if (typeof window === "undefined" || !groupId) return
    try {
      // 读取真实群数据（新建的本地群）
      const userGroups = JSON.parse(localStorage.getItem("user_groups") || "[]")
      const found = userGroups.find((g: any) => g.id === groupId)
      if (found) {
        setRealGroupData(found)
      }
      const saved = localStorage.getItem(`dao_org_${groupId}`)
      if (saved) {
        const parsed = JSON.parse(saved)
        if (parsed.orgObjectId && parsed.groupPk) {
          setIsConvertedToDao(true)
          setGroupPk(parsed.groupPk)
          setOrgObjectId(parsed.orgObjectId)
          setOrgEpoch(parsed.epoch || 1)
          setOrgTxDigest(parsed.txDigest || "")
        }
      }
    } catch (e) {
      console.warn("Failed to restore DAO state", e)
    }
  }, [groupId])

  const [selectedBlobId, setSelectedBlobId] = useState<string | null>(null)
  const [isAppSandboxOpen, setIsAppSandboxOpen] = useState(false)
  const [selectedAppBlobId, setSelectedAppBlobId] = useState("walrus_blob_app_poll_901.wma")

  const [useSubagentCap, setUseSubagentCap] = useState(true)
  const [claimedNotice, setClaimedNotice] = useState<string | null>(null)

  // 红包系统状态
  const [isRedPacketDialogOpen, setIsRedPacketDialogOpen] = useState(false)
  const [redPacketDialogMode, setRedPacketDialogMode] = useState<"create" | "claim">("create")
  const [activeRedPacketId, setActiveRedPacketId] = useState<string | null>(null)
  const [showSlashMenu, setShowSlashMenu] = useState(false)

  const [redPackets, setRedPackets] = useState<Record<string, RedPacketData>>({
    rp_genesis: {
      id: "rp_genesis",
      sender: "0xaf0806fadf61ceeb76c21b40af4393e244a5d8ca91ba208d4f58537421eff2e4",
      senderName: "Agent-Alice (群发起人)",
      totalAmount: 6.0,
      totalCount: 3,
      remainingAmount: 2.2,
      remainingCount: 1,
      packetType: "LUCKY_RANDOM",
      greeting: "星球创世红包！庆贺免密发信与 Walrus 去中心化存储上线 🎉",
      createdAt: "14:22",
      expiresAt: "24h后",
      claims: [
        {
          id: "c1",
          claimer: "0x83fb785f1da119aea4e0faa19d1466b33899e14ea730af6425ec7d5557cb5a36",
          claimerName: "Agent-Bob (审计员)",
          amount: 3.8,
          claimedAt: "14:23",
          isBest: true,
        },
      ],
      claimedByUser: false,
    },
  })

  const [messages, setMessages] = useState<
    Array<{
      id: string
      sender: string
      role: string
      time: string
      text: string
      walrusBlobId?: string
      redPacketId?: string
      isSubagent?: boolean
    }>
  >([
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
      text: "社区治理规范与 Walrus 文档库已初始化，欢迎随时上传查阅。",
      walrusBlobId: "walrus_blob_e3b0c44298fc1c149afbf4c8996fb924",
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

  // 抢红包逻辑 (连通 Move 真实抢红包合约或模拟算法)
  const handleClaimRedPacket = async (packetId: string) => {
    const packet = redPackets[packetId]
    if (!packet || packet.claimedByUser || packet.remainingCount <= 0) return

    let txDigest: string | undefined = undefined
    const acc = getActiveAccount()
    if (acc?.address && packetId.startsWith("0x")) {
      try {
        const tx = vaultClient.buildClaimRedPacketPTB(packetId, groupId)
        const res = await signAndExecuteWithWallet(tx)
        txDigest = res.digest
      } catch (e: any) {
        console.warn("[RedPacket] On-chain claim fallback:", e.message)
      }
    }

    let claimAmount = 0
    if (packet.remainingCount <= 1) {
      claimAmount = packet.remainingAmount
    } else if (packet.packetType === "EQUAL") {
      claimAmount = Number((packet.remainingAmount / packet.remainingCount).toFixed(3))
    } else {
      // 严格对齐 Move agent_vault::red_packet::calculate_payout 二倍均值算法
      const now = Date.now()
      const remainingMist = BigInt(Math.round(packet.remainingAmount * 1e9))
      const remCount = BigInt(packet.remainingCount)
      const salt = BigInt(now) + remainingMist + (remCount * 17n)
      const avg = remainingMist / remCount
      const maxPossible = avg * 2n
      const randomPart = maxPossible > 0n ? (salt % maxPossible) : avg
      const payoutMist = randomPart === 0n ? 1_000_000n : randomPart
      claimAmount = Math.max(0.001, Number(payoutMist) / 1e9)
      claimAmount = Number(claimAmount.toFixed(3))
      if (claimAmount > packet.remainingAmount - (packet.remainingCount - 1) * 0.001) {
        claimAmount = Number((packet.remainingAmount - (packet.remainingCount - 1) * 0.001).toFixed(3))
      }
    }

    const newClaim = {
      id: `c_${Date.now()}`,
      claimer: acc?.address || "0xaf0806fadf61ceeb76c21b40af4393e244a5d8ca91ba208d4f58537421eff2e4",
      claimerName: "You (当前用户)",
      amount: claimAmount,
      claimedAt: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    }

    const updatedClaims = [...packet.claims, newClaim]
    let maxAmt = 0
    updatedClaims.forEach((c) => {
      if (c.amount > maxAmt) maxAmt = c.amount
    })
    updatedClaims.forEach((c) => {
      ;(c as any).isBest = c.amount === maxAmt
    })

    const updatedPacket: RedPacketData = {
      ...packet,
      remainingAmount: +(packet.remainingAmount - claimAmount).toFixed(3),
      remainingCount: packet.remainingCount - 1,
      claims: updatedClaims,
      claimedByUser: true,
      userClaimAmount: claimAmount,
    }

    setRedPackets((prev) => ({ ...prev, [packetId]: updatedPacket }))

    // 聊天流插入抢到红包提示
    setMessages((prev) => [
      ...prev,
      {
        id: `m_${Date.now()}`,
        sender: "Sentinel-AI",
        role: "🤖 研报哨兵",
        time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        text: `🧧 恭喜 You 抢到了 ${packet.senderName} 的红包 ${claimAmount.toFixed(3)} SUI！${
          txDigest ? `(链上交易: ${txDigest.slice(0, 10)}...)` : "(链上结算完成)"
        }`,
        isSubagent: true,
      },
    ])
    setClaimedNotice(`🎉 抢红包到账：+${claimAmount.toFixed(3)} SUI 已入账你的钱包！`)
    setTimeout(() => setClaimedNotice(null), 5000)
  }

  // 发红包逻辑 (调用 Move Create Red Packet PTB)
  const handleCreateRedPacket = async (params: {
    totalAmount: number
    totalCount: number
    packetType: "LUCKY_RANDOM" | "EQUAL"
    greeting: string
  }) => {
    let onChainTxDigest: string | undefined = undefined
    let onChainId: string | undefined = undefined
    const totalMist = BigInt(Math.round(params.totalAmount * 1e9))
    const isRandom = params.packetType === "LUCKY_RANDOM"

    const acc = getActiveAccount()
    if (acc?.address) {
      try {
        const tx = vaultClient.buildCreateRedPacketPTB(
          groupId.startsWith("0x") ? groupId : "0x0000000000000000000000000000000000000000000000000000000000000002",
          totalMist,
          params.totalCount,
          isRandom,
          params.greeting
        )
        const res = await signAndExecuteWithWallet(tx)
        onChainTxDigest = res.digest
        if (res.createdObjects.length > 0) {
          onChainId = res.createdObjects[0]
        }
      } catch (e: any) {
        console.warn("[RedPacket] On-chain create via wallet fallback:", e.message)
      }
    }

    const newId = onChainId || `rp_${Date.now()}`
    const newPacket: RedPacketData = {
      id: newId,
      sender: acc?.address || "0xaf0806fadf61ceeb76c21b40af4393e244a5d8ca91ba208d4f58537421eff2e4",
      senderName: "You (群成员)",
      totalAmount: params.totalAmount,
      totalCount: params.totalCount,
      remainingAmount: params.totalAmount,
      remainingCount: params.totalCount,
      packetType: params.packetType,
      greeting: params.greeting,
      createdAt: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      expiresAt: "24h后",
      claims: [],
      claimedByUser: false,
    }

    setRedPackets((prev) => ({ ...prev, [newId]: newPacket }))

    // 发送群聊消息
    setMessages((prev) => [
      ...prev,
      {
        id: `m_${Date.now()}`,
        sender: "You (via Subagent)",
        role: "群成员 · 0 Gas 免密",
        time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        text: `发出了一个链上${params.packetType === "LUCKY_RANDOM" ? "拼手气" : "普通"}红包！快来抢～${
          onChainTxDigest ? ` (Tx: ${onChainTxDigest.slice(0, 10)}...)` : ""
        }`,
        redPacketId: newId,
        isSubagent: true,
      },
    ])
    setClaimedNotice(`🧧 红包已发送至群聊 (总计 ${params.totalAmount} SUI)`)
    setTimeout(() => setClaimedNotice(null), 5000)
  }

  // 退还过期红包
  const handleRefundRedPacket = async (packetId: string) => {
    const packet = redPackets[packetId]
    if (!packet || packet.remainingAmount <= 0) return

    if (packetId.startsWith("0x")) {
      try {
        const tx = vaultClient.buildRefundRedPacketPTB(packetId)
        await signAndExecuteWithWallet(tx)
      } catch (e: any) {
        console.warn("[RedPacket] Refund on-chain error:", e.message)
      }
    }

    const refundAmt = packet.remainingAmount
    setRedPackets((prev) => ({
      ...prev,
      [packetId]: { ...packet, remainingAmount: 0, remainingCount: 0 },
    }))
    setClaimedNotice(`🛡️ 过期退款成功：已将剩余 ${refundAmt.toFixed(3)} SUI 全额退回至当前钱包！`)
    setTimeout(() => setClaimedNotice(null), 5000)
  }

  // 执行 Slash 外挂命令
  const handleTriggerSlash = async (cmd: string) => {
    setShowSlashMenu(false)
    setChatInput("")

    if (cmd === "/redpacket") {
      setRedPacketDialogMode("create")
      setIsRedPacketDialogOpen(true)
      return
    }

    if (cmd === "/tip") {
      const acc = getActiveAccount()
      const bobAddr = "0x83fb785f1da119aea4e0faa19d1466b33899e14ea730af6425ec7d5557cb5a36"
      if (acc?.address) {
        try {
          const tx = vaultClient.buildDirectTransferPTB(bobAddr, 1_000_000_000n)
          await signAndExecuteWithWallet(tx)
        } catch (e: any) {
          console.warn("[Tip] Direct transfer fallback notice:", e.message)
        }
      }

      setMessages((prev) => [
        ...prev,
        {
          id: `m_${Date.now()}`,
          sender: "You",
          role: "成员",
          time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
          text: "向 @Agent-Bob 打赏了 1.0 SUI 💰",
          isSubagent: true,
        },
      ])
      setClaimedNotice("打赏成功：已向 @Agent-Bob 转账 1.0 SUI")
      setTimeout(() => setClaimedNotice(null), 4000)
      return
    }

    if (cmd === "/app") {
      setIsAppSandboxOpen(true)
      setMessages((prev) => [
        ...prev,
        {
          id: `m_${Date.now()}`,
          sender: "You",
          role: "成员",
          time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
          text: "发起了群投票：《Sui 生态多签国库治理方案探讨》",
          walrusBlobId: "walrus_blob_app_poll_901.wma",
          isSubagent: true,
        },
      ])
      return
    }

    if (cmd === "/stats") {
      setMessages((prev) => [
        ...prev,
        {
          id: `m_cmd_${Date.now()}`,
          sender: "You",
          role: "成员",
          time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
          text: "/stats 查看群资产简报",
          isSubagent: true,
        },
        {
          id: `m_stat_${Date.now()}`,
          sender: "Sentinel-AI",
          role: "助理",
          time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
          text: `📊 【群资产快报】\n• 金库总额: ${groupBalance.toFixed(2)} SUI\n• 待处理交易: ${realProposals.filter((p) => p.status === "pending").length} 笔\n• Walrus 群文件: ${groupFiles.length} 份`,
          isSubagent: true,
        },
      ])
      return
    }

    if (cmd === "/help") {
      setMessages((prev) => [
        ...prev,
        {
          id: `m_help_${Date.now()}`,
          sender: "Sentinel-AI",
          role: "助理",
          time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
          text: "💡 【常用快捷指令】\n/redpacket - 发红包\n/tip - 打赏群友 1.0 SUI\n/app - 发起群投票\n/stats - 资产简报",
          isSubagent: true,
        },
      ])
    }
  }

  // 发送消息
  const handleSendMessage = () => {
    if (!chatInput.trim()) return
    const textToSend = chatInput.trim()

    // 检查是否是斜杠命令
    if (textToSend.startsWith("/")) {
      const cmdName = textToSend.split(" ")[0].toLowerCase()
      if (["/redpacket", "/tip", "/app", "/stats", "/help"].includes(cmdName)) {
        handleTriggerSlash(cmdName)
        return
      }
    }

    setMessages((prev) => [
      ...prev,
      {
        id: `m_${Date.now()}`,
        sender: "You",
        role: "成员",
        time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        text: textToSend,
        isSubagent: useSubagentCap,
      },
    ])
    setChatInput("")
  }

  // 真实选择文件并上传到 Walrus
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setIsUploadingFile(true)
    try {
      const res = await uploadToWalrus(file, {
        filename: file.name,
        contentType: file.type || "application/octet-stream",
      })
      const acc = getActiveAccount()
      const newFileInfo: GroupFileInfo = {
        id: `wf_${Date.now()}`,
        groupId,
        name: file.name,
        size: file.size,
        blobId: res.blobId,
        uploader: acc?.address ? `${acc.address.slice(0, 6)}...${acc.address.slice(-4)}` : "You",
        uploadedAt: new Date().toISOString(),
        contentType: file.type || "application/octet-stream",
        url: res.url,
      }
      addGroupWalrusFile(groupId, newFileInfo)

      // 同步到群聊消息流
      setMessages((prev) => [
        ...prev,
        {
          id: `m_${Date.now()}`,
          sender: "You",
          role: "成员",
          time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
          text: `上传了群文件：${file.name} (${(file.size / 1024).toFixed(1)} KB)`,
          walrusBlobId: res.blobId,
          isSubagent: useSubagentCap,
        },
      ])
      setClaimedNotice(`🎉 文件 ${file.name} 已成功存证至 Walrus 协议 (Blob ID: ${res.blobId.slice(0, 14)}...)`)
      setTimeout(() => setClaimedNotice(null), 5000)
    } catch (err: any) {
      console.warn("Upload to Walrus error:", err)
      setClaimedNotice(`上传失败: ${err.message}`)
      setTimeout(() => setClaimedNotice(null), 4000)
    } finally {
      setIsUploadingFile(false)
      if (fileInputRef.current) fileInputRef.current.value = ""
    }
  }

  // 构建真实的群组信息
  const group = realGroupData
    ? {
        id: groupId,
        name: realGroupData.name || "未命名群组",
        description: realGroupData.description || "Sui MultiSig Multi-Signature Group",
        address: realGroupData.members?.[0]?.address || "0x0000000000000000000000000000000000000000",
        network: realGroupData.network || "Sui Testnet",
        balance: groupBalance,
        token: "SUI",
        creator: realGroupData.members?.[0]?.address || "",
        creatorName: "You",
        members: realGroupData.members || [],
        threshold: realGroupData.threshold || 1,
        totalWeight: realGroupData.totalWeight || 1,
        transactions: realProposals,
        agents: [
          {
            id: "agent-sentinel",
            name: "Sentinel-AI (助理)",
            purpose: "自动化治理与数据监测",
            budget: 100,
            spent: 12.5,
            status: "ACTIVE",
          },
        ],
        color: "from-primary to-purple-500",
      }
    : {
        id: groupId,
        name: "Team Treasury (Sui MultiSig)",
        description: "Treasury for multi-signature governance and group funding",
        address: "0xaf0806fadf61ceeb76c21b40af4393e244a5d8ca91ba208d4f58537421eff2e4",
        network: "Sui Testnet",
        balance: groupBalance,
        token: "SUI",
        creator: "0xaf08...e2e4",
        creatorName: "Alex",
        members: [
          { address: "0xaf0806fadf61ceeb76c21b40af4393e244a5d8ca91ba208d4f58537421eff2e4", name: "Agent-Alice (理事长)", weight: 2 },
          { address: "0x83fb785f1da119aea4e0faa19d1466b33899e14ea730af6425ec7d5557cb5a36", name: "Agent-Bob (审计员)", weight: 1 },
          { address: "0x5e6f8a9b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f", name: "Agent-Carol (执行官)", weight: 1 },
        ],
        threshold: 2,
        totalWeight: 4,
        transactions: realProposals,
        agents: [
          {
            id: "agent-sentinel",
            name: "Sentinel-AI (助理)",
            purpose: "自动化治理与数据监测",
            budget: 100,
            spent: 12.5,
            status: "ACTIVE",
          },
          {
            id: "agent-1",
            name: "DeepSeek-Reasoner-01",
            purpose: "模型推理服务",
            budget: 10,
            spent: 4.2,
            status: "ACTIVE",
          },
        ],
        color: "from-primary to-purple-500",
      }

  const shortAddress = `${group.address.slice(0, 6)}...${group.address.slice(-4)}`

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[94vw] max-w-[480px] p-0 gap-0 overflow-hidden rounded-2xl max-h-[92vh] flex flex-col">
        {/* 隐藏的真实文件选择器 */}
        <input
          type="file"
          ref={fileInputRef}
          onChange={handleFileUpload}
          className="hidden"
          accept="*/*"
        />

        <div className={`h-24 bg-gradient-to-r ${group.color} p-4 flex flex-col justify-end`}>
          <DialogHeader className="text-white">
            <DialogTitle className="flex items-center justify-between">
              <span className="text-xl font-bold">{group.name}</span>
              <Badge variant="outline" className="bg-white/20 text-white border-white/40">
                {group.network}
              </Badge>
            </DialogTitle>
            <p className="text-white/80 text-xs mt-1 truncate">{group.description}</p>
          </DialogHeader>
        </div>

        <div className="p-4 space-y-4 overflow-y-auto">
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
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    onClick={() => {
                      if (typeof window !== "undefined") navigator.clipboard?.writeText(group.address)
                    }}
                  >
                    <Copy className="h-3 w-3" />
                  </Button>
                  <a
                    href={`https://suiscan.xyz/testnet/account/${group.address}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <ExternalLink className="h-3 w-3 ml-1" />
                  </a>
                </div>
                <p className="text-xs text-muted-foreground">Multi-Signature Treasury</p>
              </div>
            </div>
            <div className="text-right">
              <p className="font-semibold text-sm">
                {group.balance.toFixed(2)} {group.token}
              </p>
              <div className="flex items-center text-xs text-muted-foreground justify-end">
                <span>
                  门限: {group.threshold}/{group.totalWeight}
                </span>
              </div>
            </div>
          </div>

          <Tabs defaultValue="chat" value={activeTab} onValueChange={setActiveTab} className="w-full">
            <TabsList className="grid w-full grid-cols-6 p-1 bg-muted/50 rounded-xl text-[11px]">
              <TabsTrigger
                value="chat"
                className="rounded-lg data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm px-1 font-medium"
              >
                <MessageSquare className="h-3 w-3 mr-0.5 text-primary" />
                群聊
              </TabsTrigger>
              <TabsTrigger
                value="members"
                className="rounded-lg data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm px-1"
              >
                <Users className="h-3 w-3 mr-0.5" />
                成员
              </TabsTrigger>
              <TabsTrigger
                value="agents"
                className="rounded-lg data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm px-1"
              >
                <Bot className="h-3 w-3 mr-0.5 text-purple-500" />
                AI
              </TabsTrigger>
              <TabsTrigger
                value="files"
                className="rounded-lg data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm px-1 font-medium"
              >
                <HardDrive className="h-3 w-3 mr-0.5 text-cyan-500" />
                文件
              </TabsTrigger>
              <TabsTrigger
                value="transactions"
                className="rounded-lg data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm px-1"
              >
                <Share2 className="h-3 w-3 mr-0.5" />
                Tx
              </TabsTrigger>
              <TabsTrigger
                value="receive"
                className="rounded-lg data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm px-1"
              >
                <QrCode className="h-3 w-3 mr-0.5" />
                收款
              </TabsTrigger>
            </TabsList>

            <AnimatePresence mode="wait">
              {/* 1. 群聊 Tab */}
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
                          群金库:{" "}
                          <strong className="text-foreground font-semibold">
                            {group.balance.toFixed(2)} {group.token}
                          </strong>
                        </span>
                      </div>
                      <div className="flex items-center space-x-1.5">
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
                          className="px-3 py-1.5 rounded-lg bg-emerald-500/15 border border-emerald-500/30 text-emerald-600 dark:text-emerald-400 text-xs flex items-center justify-between"
                        >
                          <span className="font-medium truncate">{claimedNotice}</span>
                          <button
                            onClick={() => setClaimedNotice(null)}
                            className="text-emerald-500 hover:text-emerald-700 ml-2"
                          >
                            ✕
                          </button>
                        </motion.div>
                      )}
                    </AnimatePresence>

                    {/* 消息流 */}
                    <div className="h-[320px] overflow-y-auto space-y-2.5 p-2.5 rounded-xl bg-muted/20 border border-border/40 text-xs">
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
                                    {m.walrusBlobId.endsWith(".wma") ? "群投票：跨链治理方案" : "附件文档 (Walrus 存证)"}
                                  </span>
                                </div>
                                <span className="text-[9px] bg-white/20 px-1.5 py-0.5 rounded text-white shrink-0">
                                  {m.walrusBlobId.endsWith(".wma") ? "去投票" : "查看存证"}
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
                                <p className="text-[10px] text-muted-foreground truncate">/tip 1.0 SUI</p>
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
                        onKeyDown={(e) => e.key === "Enter" && handleSendMessage()}
                        className="h-8 text-xs bg-muted/30 focus-visible:ring-1 flex-1"
                      />

                      <Button
                        size="sm"
                        variant="ghost"
                        type="button"
                        disabled={isUploadingFile}
                        onClick={() => fileInputRef.current?.click()}
                        className="h-8 px-2 text-xs gap-1 text-muted-foreground hover:text-foreground shrink-0"
                        title="选择文件上传至 Walrus 去中心化存储"
                      >
                        {isUploadingFile ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Paperclip className="h-3.5 w-3.5" />
                        )}
                        <span className="hidden sm:inline">附件</span>
                      </Button>

                      <Button
                        size="sm"
                        type="button"
                        onClick={handleSendMessage}
                        className="h-8 px-3 text-xs gap-1 shrink-0 bg-primary text-primary-foreground"
                      >
                        <Send className="h-3 w-3" />
                        <span>发送</span>
                      </Button>
                    </div>
                  </motion.div>
                </TabsContent>
              )}

              {/* 2. 成员 Tab */}
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
                            <div className="flex items-center space-x-1.5">
                              <p className="font-semibold text-purple-600 dark:text-purple-400">
                                已固化为密码学组织 (DAO)
                              </p>
                              <Badge
                                variant="outline"
                                className="text-[9px] px-1 py-0 h-4 border-purple-500/40 text-purple-500"
                              >
                                Epoch {orgEpoch}
                              </Badge>
                            </div>
                            <div className="flex items-center space-x-2 text-[10px] text-muted-foreground font-mono mt-0.5">
                              <span className="truncate max-w-[140px]">
                                PK: {groupPk ? `${groupPk.slice(0, 8)}...${groupPk.slice(-6)}` : ""}
                              </span>
                              {orgObjectId && (
                                <a
                                  href={`https://suiscan.xyz/testnet/object/${orgObjectId}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-primary hover:underline flex items-center"
                                >
                                  Suiscan <ExternalLink className="h-2.5 w-2.5 ml-0.5" />
                                </a>
                              )}
                            </div>
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
                            当前为多签群组
                          </p>
                          <p className="text-[11px] text-muted-foreground">随时执行 DKG 仪式上链固化为 DAO</p>
                        </div>
                        <Button
                          size="sm"
                          onClick={() => setIsDkgOpen(true)}
                          className="h-7 text-[11px] bg-primary text-primary-foreground hover:bg-primary/90"
                        >
                          <Sparkles className="h-3 w-3 mr-1" />
                          固化为 DAO
                        </Button>
                      </div>
                    )}

                    {group.members.map((member: any, index: number) => (
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
                              {(member.name || member.address || "?")[0]}
                            </AvatarFallback>
                          </Avatar>
                          <div>
                            <p className="font-medium text-sm">{member.name || member.address}</p>
                            <p className="text-xs text-muted-foreground flex items-center font-mono">
                              {member.address.slice(0, 8)}...{member.address.slice(-6)}
                            </p>
                          </div>
                        </div>
                        <div className="text-right">
                          <Badge variant="outline" className="text-xs">
                            Weight: {member.weight}
                          </Badge>
                        </div>
                      </div>
                    ))}
                  </motion.div>
                </TabsContent>
              )}

              {/* 3. AI 哨兵 Tab */}
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
                        受限代理凭证
                      </Badge>
                    </div>
                    {(group.agents || []).map((agent: any) => (
                      <div key={agent.id} className="p-3 rounded-xl border border-border/60 bg-card/60 space-y-2">
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
                      <p>AI 助手仅在设定额度内运行，超出每日限额将自动暂停，保障金库安全。</p>
                    </div>
                  </motion.div>
                </TabsContent>
              )}

              {/* 4. 群文件 / Walrus 存储 Tab */}
              {activeTab === "files" && (
                <TabsContent value="files" className="mt-3 space-y-3">
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    transition={{ duration: 0.2 }}
                    className="space-y-3"
                  >
                    <div className="p-3 rounded-xl bg-gradient-to-r from-cyan-500/10 to-blue-500/10 border border-cyan-500/30 flex items-center justify-between">
                      <div>
                        <h4 className="text-xs font-semibold flex items-center gap-1.5 text-cyan-700 dark:text-cyan-300">
                          <HardDrive className="h-4 w-4 text-cyan-500" />
                          Walrus 去中心化群文档库
                        </h4>
                        <p className="text-[10px] text-muted-foreground mt-0.5">
                          所有附件采用纠删码切片存证于 Walrus 协议，防篡改、永不丢失。
                        </p>
                      </div>
                      <Button
                        size="sm"
                        disabled={isUploadingFile}
                        onClick={() => fileInputRef.current?.click()}
                        className="h-7 text-xs bg-cyan-600 hover:bg-cyan-700 text-white shrink-0 gap-1"
                      >
                        {isUploadingFile ? (
                          <>
                            <Loader2 className="h-3.5 w-3.5 animate-spin" /> 上传中...
                          </>
                        ) : (
                          <>
                            <UploadCloud className="h-3.5 w-3.5" /> 上传文件
                          </>
                        )}
                      </Button>
                    </div>

                    <div className="space-y-2 max-h-[300px] overflow-y-auto pr-1">
                      {groupFiles.map((f) => (
                        <div
                          key={f.id}
                          className="p-2.5 rounded-xl border border-border/60 bg-card/60 hover:bg-muted/40 transition-colors flex items-center justify-between text-xs"
                        >
                          <div className="flex items-center gap-2.5 min-w-0">
                            <div className="w-8 h-8 rounded-lg bg-cyan-500/15 border border-cyan-500/30 flex items-center justify-center shrink-0">
                              <FileText className="h-4 w-4 text-cyan-600 dark:text-cyan-400" />
                            </div>
                            <div className="min-w-0">
                              <p className="font-medium text-foreground truncate">{f.name}</p>
                              <div className="flex items-center gap-2 text-[10px] text-muted-foreground font-mono">
                                <span>{(f.size / 1024).toFixed(1)} KB</span>
                                <span>•</span>
                                <span>{f.uploader}</span>
                              </div>
                            </div>
                          </div>

                          <div className="flex items-center gap-1.5 shrink-0">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => setSelectedBlobId(f.blobId)}
                              className="h-6 text-[10px] px-2"
                            >
                              查看存证
                            </Button>
                            <a
                              href={`${WALRUS_AGGREGATOR_URL}/v1/blobs/${f.blobId}`}
                              target="_blank"
                              rel="noreferrer"
                              className="h-6 px-2 rounded-md border border-input bg-background hover:bg-accent text-[10px] flex items-center gap-0.5 text-foreground"
                            >
                              下载 <ExternalLink className="h-2.5 w-2.5" />
                            </a>
                          </div>
                        </div>
                      ))}
                    </div>
                  </motion.div>
                </TabsContent>
              )}

              {/* 5. 交易提案 Tab */}
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
                        className="bg-gradient-to-r from-primary to-purple-500 hover:from-primary/90 hover:to-purple-500/90 text-xs"
                      >
                        <Plus className="h-3.5 w-3.5 mr-1" /> 发起转账提案
                      </Button>
                    </div>

                    <div className="space-y-2">
                      {group.transactions.map((tx: any) => (
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
                              {tx.status === "executed"
                                ? "已执行"
                                : tx.status === "rejected"
                                  ? "已拒绝"
                                  : tx.status === "approved"
                                    ? "已批准"
                                    : "待审批"}
                            </Badge>
                          </div>

                          <div className="flex justify-between mt-2">
                            <div className="text-xs text-muted-foreground">转账提案</div>
                            <div className="text-xs font-semibold">
                              {tx.amount} {tx.token}
                            </div>
                          </div>

                          {tx.status === "pending" && (
                            <div className="mt-2 flex items-center justify-between">
                              <div className="text-xs text-muted-foreground">
                                审批进度: {tx.approvals}/{tx.requiredApprovals}
                              </div>
                              <Button size="sm" variant="outline" className="h-6 text-[10px]">
                                查看审批
                              </Button>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </motion.div>
                </TabsContent>
              )}

              {/* 6. 收款 Tab */}
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
                      <p className="text-sm font-semibold">{group.name}</p>
                      <p className="text-xs text-muted-foreground mb-2 font-mono">{group.address}</p>
                      <div className="flex space-x-2">
                        <Button
                          variant="outline"
                          size="sm"
                          className="text-xs"
                          onClick={() => {
                            if (typeof window !== "undefined") navigator.clipboard?.writeText(group.address)
                          }}
                        >
                          <Copy className="h-3 w-3 mr-1" /> 复制地址
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="text-xs"
                          onClick={() => {
                            if (typeof window !== "undefined" && navigator.share) {
                              navigator.share({ title: group.name, text: group.address })
                            }
                          }}
                        >
                          <Share2 className="h-3 w-3 mr-1" /> 分享
                        </Button>
                      </div>
                    </div>

                    <div className="mt-4 p-3 rounded-lg bg-accent/30">
                      <p className="text-xs text-muted-foreground text-center">
                        请仅向此多签地址充值 {group.network} 资产。多签组织金库由全体成员共识门限保护。
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
        groupId={groupId}
        initialMembers={group.members}
        onConvertedSuccess={(pk, orgId, digest) => {
          setIsConvertedToDao(true)
          setGroupPk(pk)
          if (orgId) setOrgObjectId(orgId)
          if (digest) setOrgTxDigest(digest)
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
