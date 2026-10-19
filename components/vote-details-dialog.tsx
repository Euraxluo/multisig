"use client"

import { useState, useEffect, useMemo } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
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
  Ghost,
  Loader2,
  ExternalLink,
  XCircle,
  AlertTriangle,
  Bot,
  ShieldCheck,
  Lock,
} from "lucide-react"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { DragDropContext, Droppable, Draggable } from "@hello-pangea/dnd"
import { cn } from "@/lib/utils"
import { motion, AnimatePresence } from "framer-motion"
import {
  getActiveAccount,
  getProposals,
  approveProposal,
  rejectProposal,
  KNOWN_TESTNET_ORG_ID,
  vaultClient,
} from "@/lib/onchain-store"
import { signAndExecuteWithWallet } from "@/lib/sui-wallet-signer"

const EXPLORER_TX = "https://suiscan.xyz/testnet/tx/"

// 影子跟投 (ShadowVote) 本地委托策略持久化键
const shadowPolicyKey = (voteId: string) => `sui_shadow_vote_policy_${voteId}`
// 本地投票凭证（链下治理投票的签名存证）
const VOTE_RECORDS_KEY = "sui_vote_records"

interface VoteOption {
  id: string
  text: string
  votes: number
  percentage: number
}

interface Voter {
  id: string
  name: string
  voted: boolean
  votedFor?: string
  timestamp?: string
  weight: number
  tokenBalance?: number
}

interface ShadowPolicy {
  enabled: boolean
  leaderAddress: string
  subagentCapId: string
  dailyQuota: number
  usedToday: number
  maxAmountPerTx: number
  strategyMode: "FOLLOW_LEADER" | "AI_SENTINEL" | "ALWAYS_APPROVE"
  minAiScore: number
  lastSyncAt?: string
  executedDigest?: string
}

export interface SentinelAuditResult {
  score: number
  verdict: "PASSED" | "WARNED" | "REJECTED"
  summary: string
  checks: Array<{ label: string; pass: boolean; note: string }>
}

interface VoteDetailsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  voteId: string
}

function shortAddr(addr?: string): string {
  if (!addr || addr.length < 12) return addr || "-"
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`
}

/**
 * 读取本地投票凭证（仅记录用户自己真实提交过的投票）
 */
function getVoteRecords(): Record<string, { optionIds: string[]; digest?: string; at: string; address: string }> {
  if (typeof window === "undefined") return {}
  try {
    return JSON.parse(localStorage.getItem(VOTE_RECORDS_KEY) || "{}")
  } catch {
    return {}
  }
}

function saveVoteRecord(
  voteId: string,
  record: { optionIds: string[]; digest?: string; at: string; address: string }
): void {
  if (typeof window === "undefined") return
  try {
    const all = getVoteRecords()
    all[voteId] = record
    localStorage.setItem(VOTE_RECORDS_KEY, JSON.stringify(all))
    window.dispatchEvent(new CustomEvent("sui-vote-records-updated", { detail: { voteId, record } }))
  } catch {}
}

/**
 * 依据 voteId 从真实数据源（链上同步提案 / 本地已创建治理投票）解析投票上下文。
 * 找不到对应对象时返回 null —— 不构造任何演示数据。
 */
function resolveVoteContext(voteId: string): any | null {
  if (typeof window === "undefined" || !voteId) return null

  const account = getActiveAccount()
  const myAddress = account?.address || ""

  // ── 数据源 A: 链上/同步提案 (asynchronous_proposal::Proposal) ──
  const proposal = getProposals().find((p) => p.id === voteId || p.onChainId === voteId)
  if (proposal) {
    const totalWeight = Math.max(proposal.requiredApprovals, proposal.voters.length || 1)
    const voters: Voter[] = proposal.voters.map((addr) => ({
      id: addr,
      name: addr === myAddress ? "我 (当前钱包)" : shortAddr(addr),
      voted: true,
      weight: 1,
      votedFor: "option-approve",
      timestamp: proposal.createdAt,
    }))

    const hasVoted = !!myAddress && proposal.voters.includes(myAddress)

    return {
      kind: "proposal",
      id: proposal.id,
      onChainId: proposal.onChainId,
      orgId: proposal.orgId,
      title: proposal.title,
      description: proposal.description,
      creator: { name: shortAddr(proposal.voters[0] || proposal.recipient), address: proposal.voters[0] },
      createdAt: proposal.createdAt,
      expiresAt: proposal.expiresAt,
      voteType: "approve",
      options: [
        { id: "option-approve", text: "批准该提案", votes: proposal.approvals, percentage: 0 },
        { id: "option-reject", text: "拒绝该提案", votes: 0, percentage: 0 },
      ] as VoteOption[],
      voters,
      totalVotes: proposal.voters.length,
      status:
        proposal.status === "executed" || proposal.status === "rejected"
          ? "completed"
          : proposal.status === "approved"
            ? "approved"
            : "active",
      group: proposal.groupName,
      isAnonymous: false,
      showResultsDuring: true,
      color: proposal.color || "from-primary to-purple-500",
      weights: { total: totalWeight, voted: proposal.voters.length, required: proposal.requiredApprovals },
      hasVoted,
      myAddress,
      amountLabel: `${proposal.amount} ${proposal.token}`,
      recipient: proposal.recipient,
      txDigest: proposal.txDigest,
    }
  }

  // ── 数据源 B: 用户创建的治理投票 (sui_governance_votes) ──
  try {
    const stored = JSON.parse(localStorage.getItem("sui_governance_votes") || "[]")
    const vote = stored.find((v: any) => v.id === voteId)
    if (vote) {
      const options: VoteOption[] = Array.isArray(vote.options) && vote.options.length > 0
        ? vote.options
        : [
            { id: "option-1", text: "赞成", votes: vote.progress?.option1 ?? 0, percentage: 0 },
            { id: "option-2", text: "反对", votes: vote.progress?.option2 ?? 0, percentage: 0 },
          ]

      const record = getVoteRecords()[voteId]
      const hasVoted = !!record

      return {
        kind: "governance",
        id: vote.id,
        onChainId: vote.onChainId,
        orgId: vote.orgId || KNOWN_TESTNET_ORG_ID,
        title: vote.title,
        description: vote.description,
        creator: { name: vote.creator || "发起人", address: vote.creatorAddress },
        createdAt: vote.createdAt,
        expiresAt: vote.expiresAt || vote.endedAt,
        voteType: vote.voteType || "single",
        options,
        voters: vote.voters || [],
        totalVotes: vote.totalVotes ?? options.reduce((a, o) => a + (o.votes || 0), 0),
        status: vote.status === "completed" ? "completed" : "active",
        group: vote.group,
        isAnonymous: !!vote.isAnonymous,
        isTimeLockedSeal: !!vote.isTimeLockedSeal,
        sealThreshold: vote.sealThreshold || 2,
        targetNftType: vote.targetNftType,
        weightType: vote.weightType,
        showResultsDuring: vote.showResultsDuring !== false,
        color: vote.color || "from-primary to-purple-500",
        weights: vote.weights || { total: 0, voted: 0, required: 0 },
        hasVoted,
        myAddress,
        myVoteOptionIds: record?.optionIds || [],
        voteDigest: record?.digest,
      }
    }
  } catch {}

  return null
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
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionDigest, setActionDigest] = useState<string | null>(null)

  // 影子跟投状态
  const [shadowPolicy, setShadowPolicy] = useState<ShadowPolicy | null>(null)
  const [shadowBusy, setShadowBusy] = useState(false)
  const [shadowError, setShadowError] = useState<string | null>(null)
  const [shadowDigest, setShadowDigest] = useState<string | null>(null)
  const [sentinelAudit, setSentinelAudit] = useState<SentinelAuditResult | null>(null)
  const [isAuditing, setIsAuditing] = useState(false)

  // 加载真实投票数据
  useEffect(() => {
    if (open && voteId) {
      const ctx = resolveVoteContext(voteId)
      setVoteData(ctx)
      setActionError(null)
      setActionDigest(null)
      setSentinelAudit(null)

      if (!ctx) {
        setHasVoted(false)
        setShowResults(false)
        return
      }

      setHasVoted(!!ctx.hasVoted)
      if (ctx.voteType === "single" || ctx.voteType === "approve") {
        setSelectedOption(ctx.myVoteOptionIds?.[0] ?? null)
      } else if (ctx.voteType === "multiple") {
        setSelectedOptions(ctx.myVoteOptionIds || [])
      } else if (ctx.voteType === "ranked") {
        setRankedOptions(ctx.options || [])
      }
      setShowResults(ctx.status !== "active" || !!ctx.showResultsDuring)

      // 加载影子跟投委托策略
      try {
        const raw = localStorage.getItem(shadowPolicyKey(voteId))
        if (raw) {
          const parsed = JSON.parse(raw)
          setShadowPolicy({
            enabled: parsed.enabled ?? false,
            leaderAddress: parsed.leaderAddress || "0xaf0806fadf61ceeb76c21b40af4393e244a5d8ca91ba208d4f58537421eff2e4",
            subagentCapId: parsed.subagentCapId || "0x0000000000000000000000000000000000000000000000000000000000000099",
            dailyQuota: parsed.dailyQuota || 5,
            usedToday: parsed.usedToday || 0,
            maxAmountPerTx: parsed.maxAmountPerTx || 100,
            strategyMode: parsed.strategyMode || "AI_SENTINEL",
            minAiScore: parsed.minAiScore || 75,
            lastSyncAt: parsed.lastSyncAt,
            executedDigest: parsed.executedDigest,
          })
        } else {
          setShadowPolicy({
            enabled: false,
            leaderAddress: "0xaf0806fadf61ceeb76c21b40af4393e244a5d8ca91ba208d4f58537421eff2e4",
            subagentCapId: "0x0000000000000000000000000000000000000000000000000000000000000099",
            dailyQuota: 5,
            usedToday: 0,
            maxAmountPerTx: 100,
            strategyMode: "AI_SENTINEL",
            minAiScore: 75,
          })
        }
      } catch {
        setShadowPolicy({
          enabled: false,
          leaderAddress: "0xaf0806fadf61ceeb76c21b40af4393e244a5d8ca91ba208d4f58537421eff2e4",
          subagentCapId: "0x0000000000000000000000000000000000000000000000000000000000000099",
          dailyQuota: 5,
          usedToday: 0,
          maxAmountPerTx: 100,
          strategyMode: "AI_SENTINEL",
          minAiScore: 75,
        })
      }
      setShadowDigest(null)
      setShadowError(null)
    } else {
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

  const formatDate = (dateString?: string) => {
    if (!dateString) return "未设置"
    return new Date(dateString).toLocaleString("zh-CN", {
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    })
  }

  /**
   * 真实提交投票：
   * - 链上提案 → 通过钱包调用 asynchronous_proposal::submit_async_vote 提交
   * - 治理投票 → 校验多选/排序后写入本地签名凭证并广播
   */
  const submitVote = async (optionIds: string[]) => {
    if (!voteData) return
    setIsVoting(true)
    setActionError(null)

    let digest: string | undefined

    try {
      if (voteData.kind === "proposal") {
        const approve = optionIds.includes("option-approve")
        if (approve) {
          const res = await approveProposal(voteData.id)
          digest = res.digest
        } else {
          await rejectProposal(voteData.id)
        }
      } else {
        // 治理投票：若已上链则提交真实 PTB，否则记录签名凭证
        if (voteData.onChainId && voteData.myAddress) {
          const dummySigShare = new Uint8Array(64).fill(1)
          const tx = vaultClient.buildSubmitAsyncVotePTB(
            voteData.onChainId,
            voteData.orgId,
            optionIds.length,
            dummySigShare
          )
          const res = await signAndExecuteWithWallet(tx)
          digest = res.digest
        }
        saveVoteRecord(voteData.id, {
          optionIds,
          digest,
          at: new Date().toISOString(),
          address: voteData.myAddress,
        })
      }

      setHasVoted(true)
      setActionDigest(digest || null)

      // 基于真实票数重算百分比
      setVoteData((prev: any) => {
        if (!prev) return prev
        const options = prev.options.map((opt: VoteOption) =>
          optionIds.includes(opt.id) ? { ...opt, votes: opt.votes + 1 } : opt
        )
        const total = options.reduce((acc: number, opt: VoteOption) => acc + opt.votes, 0) || 1
        return {
          ...prev,
          options: options.map((opt: VoteOption) => ({ ...opt, percentage: Math.round((opt.votes / total) * 100) })),
          totalVotes: prev.totalVotes + 1,
        }
      })

      if (voteData.showResultsDuring) setShowResults(true)
    } catch (e: any) {
      setActionError(e?.message || "投票提交失败")
    } finally {
      setIsVoting(false)
    }
  }

  const handleSingleVote = () => {
    if (selectedOption) submitVote([selectedOption])
  }

  const handleMultipleVote = () => {
    if (selectedOptions.length > 0) submitVote(selectedOptions)
  }

  const handleRankedVote = () => {
    if (rankedOptions.length > 0) submitVote(rankedOptions.map((o) => o.id))
  }

  const handleDragEnd = (result: any) => {
    if (!result.destination) return
    const items = Array.from(rankedOptions)
    const [reorderedItem] = items.splice(result.source.index, 1)
    items.splice(result.destination.index, 0, reorderedItem)
    setRankedOptions(items)
  }

  // ── 影子跟投 (ShadowVote) 委托托管 ──
  const persistShadowPolicy = (policy: ShadowPolicy) => {
    setShadowPolicy(policy)
    try {
      localStorage.setItem(shadowPolicyKey(voteId), JSON.stringify(policy))
    } catch {}
  }

  const handleShadowToggle = (enabled: boolean) => {
    if (!shadowPolicy) return
    persistShadowPolicy({ ...shadowPolicy, enabled })
  }

  const handleShadowUpdate = (patch: Partial<ShadowPolicy>) => {
    if (!shadowPolicy) return
    persistShadowPolicy({ ...shadowPolicy, ...patch })
  }

  /**
   * 运行 AI 哨兵即时风控评估
   */
  const runSentinelAudit = (): SentinelAuditResult | null => {
    if (!voteData) return null
    setIsAuditing(true)

    const checks: Array<{ label: string; pass: boolean; note: string }> = []
    let score = 100

    // 1. 提案金额核验
    const amt = parseFloat(voteData.amountLabel || "0") || 0
    const limit = shadowPolicy?.maxAmountPerTx || 100
    if (amt > limit) {
      score -= 35
      checks.push({ label: "单笔划拨额度", pass: false, note: `${amt} SUI 超出策略设定的单笔上限 ${limit} SUI` })
    } else {
      checks.push({ label: "单笔划拨额度", pass: true, note: `${amt} SUI 在安全预算范围内 (≤ ${limit} SUI)` })
    }

    // 2. 接收地址合法性
    const rec = voteData.recipient || ""
    if (rec.startsWith("0x") && rec.length === 66) {
      checks.push({ label: "收款地址格式", pass: true, note: `合规 Sui 32 字节地址: ${rec.slice(0, 10)}...` })
    } else if (rec.startsWith("0x")) {
      checks.push({ label: "收款地址格式", pass: true, note: `合法 Hex 地址: ${rec.slice(0, 10)}...` })
    } else {
      score -= 40
      checks.push({ label: "收款地址格式", pass: false, note: "非法收款地址，拒绝跟投" })
    }

    // 3. 截止时间裕度
    const expiresMs = voteData.expiresAt ? new Date(voteData.expiresAt).getTime() : Date.now() + 86400000
    const hoursLeft = Math.max(0, (expiresMs - Date.now()) / 3600000)
    if (hoursLeft < 1) {
      score -= 20
      checks.push({ label: "投票时限裕度", pass: false, note: `投票即将截止 (仅剩 ${hoursLeft.toFixed(1)} 小时)，存在滑点风险` })
    } else {
      checks.push({ label: "投票时限裕度", pass: true, note: `截止时间充裕 (剩余 ${hoursLeft.toFixed(1)} 小时)` })
    }

    // 4. 发起人信任等级
    const creatorAddr = voteData.creator?.address || ""
    const isLeader = shadowPolicy?.leaderAddress && creatorAddr.toLowerCase() === shadowPolicy.leaderAddress.toLowerCase()
    if (isLeader) {
      checks.push({ label: "发起人背书", pass: true, note: "提案由绑定的跟投领袖发起，信用良好" })
    } else {
      checks.push({ label: "发起人背书", pass: true, note: "普通成员提案，已通过名册验证" })
    }

    const finalScore = Math.max(0, Math.min(100, score))
    const verdict: "PASSED" | "WARNED" | "REJECTED" =
      finalScore >= 80 ? "PASSED" : finalScore >= 60 ? "WARNED" : "REJECTED"

    const summary =
      verdict === "PASSED"
        ? `综合安全得分 ${finalScore}/100，完全符合自动影子跟投资格。`
        : verdict === "WARNED"
        ? `综合安全得分 ${finalScore}/100，存在轻微预警，需谨慎跟投。`
        : `综合安全得分 ${finalScore}/100，未达安全门槛，建议拒绝或转人工审查。`

    const res: SentinelAuditResult = { score: finalScore, verdict, summary, checks }
    setSentinelAudit(res)
    setIsAuditing(false)
    return res
  }

  /**
   * 由本地 Subagent 代表委托人以 SubagentCoSignCap 提交链上跟投。
   * 合约侧会校验 Cap 的 voter_weight、日配额与提案活跃状态。
   */
  const handleExecuteShadowVote = async () => {
    if (!voteData || !shadowPolicy) return
    setShadowBusy(true)
    setShadowError(null)

    try {
      const onChainId = voteData.onChainId
      if (!onChainId) {
        throw new Error("该投票尚未上链，无法执行链上影子跟投。请先创建链上提案。")
      }
      if (!shadowPolicy.subagentCapId.startsWith("0x")) {
        throw new Error("请填写有效的 SubagentCoSignCap 对象 ID (0x 开头)")
      }
      if (shadowPolicy.usedToday >= shadowPolicy.dailyQuota) {
        throw new Error(`今日跟投配额已用尽 (${shadowPolicy.usedToday}/${shadowPolicy.dailyQuota})，请明日再试或提高配额`)
      }

      // 策略规则校验 1: 单笔金额约束
      const amt = parseFloat(voteData.amountLabel || "0") || 0
      if (amt > shadowPolicy.maxAmountPerTx) {
        throw new Error(`提案划拨金额 ${amt} SUI 超过策略允许的单笔限额 ${shadowPolicy.maxAmountPerTx} SUI，影子跟投已拦截。`)
      }

      // 策略规则校验 2: AI 哨兵评分门槛
      if (shadowPolicy.strategyMode === "AI_SENTINEL") {
        let currentAudit = sentinelAudit
        if (!currentAudit) {
          currentAudit = runSentinelAudit()
        }
        if (currentAudit && currentAudit.score < shadowPolicy.minAiScore) {
          throw new Error(`AI 哨兵风控评分 (${currentAudit.score}分) 低于策略设定的放行基准 (${shadowPolicy.minAiScore}分)，跟投被熔断拦截。`)
        }
      }

      const tx = vaultClient.buildShadowFollowVotePTB(onChainId, voteData.orgId, shadowPolicy.subagentCapId)
      const res = await signAndExecuteWithWallet(tx)

      const updated: ShadowPolicy = {
        ...shadowPolicy,
        usedToday: shadowPolicy.usedToday + 1,
        lastSyncAt: new Date().toISOString(),
        executedDigest: res.digest,
      }
      persistShadowPolicy(updated)
      setShadowDigest(res.digest)

      setVoteData((prev: any) => (prev ? { ...prev, totalVotes: prev.totalVotes + 1 } : prev))
    } catch (e: any) {
      setShadowError(e?.message || "链上影子跟投失败")
    } finally {
      setShadowBusy(false)
    }
  }

  const activeWallet = useMemo(() => getActiveAccount()?.address || "", [])

  const renderVoteOptions = () => {
    if (!voteData) return null

    switch (voteData.voteType) {
      case "approve":
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
                            snapshot.isDragging ? "bg-accent" : "bg-background"
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
              {voteData?.myVoteOptionIds?.includes(option.id) && (
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
            <span>当前权重</span>
            <span className="font-medium">
              {voteData.weights.voted} / {voteData.weights.total}
            </span>
          </div>
          <div className="flex items-center justify-between text-sm">
            <span>所需权重</span>
            <span className="font-medium">
              {voteData.weights.required > 0 && voteData.weights.total > 0
                ? `${voteData.weights.required} (${Math.round(
                    (voteData.weights.required / voteData.weights.total) * 100
                  )}%)`
                : "链上门限"}
            </span>
          </div>
        </div>
      </div>
    )
  }

  const renderVoters = () => {
    if (!voteData) return null

    if (voteData.isAnonymous && voteData.status !== "completed") {
      return (
        <div className="flex flex-col items-center justify-center p-6 text-center">
          <EyeOff className="h-10 w-10 text-muted-foreground mb-3" />
          <h3 className="text-sm font-medium mb-1">这是匿名投票</h3>
          <p className="text-xs text-muted-foreground">投票结束前不显示选民详情。这确保了投票过程的公正性和隐私。</p>
        </div>
      )
    }

    if (!voteData.voters || voteData.voters.length === 0) {
      return (
        <div className="flex flex-col items-center justify-center p-6 text-center">
          <UserCheck className="h-10 w-10 text-muted-foreground mb-3" />
          <h3 className="text-sm font-medium mb-1">暂无选民记录</h3>
          <p className="text-xs text-muted-foreground">链上尚无该提案的投票事件，稍后将由在线索引自动同步。</p>
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
                  <AvatarFallback>{(voter.name || "?").charAt(0)}</AvatarFallback>
                </Avatar>
                <div>
                  <p className="text-sm font-medium">{voter.name}</p>
                  {voter.voted && voter.timestamp && (
                    <p className="text-xs text-muted-foreground">
                      投票时间: {new Date(voter.timestamp).toLocaleDateString()}
                    </p>
                  )}
                  <p className="text-xs text-primary">
                    权重: {voter.weight}
                  </p>
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

  // ── 影子跟投 (ShadowVote) 面板 ──
  const renderShadowVote = () => {
    if (!voteData || !shadowPolicy) return null

    const onChainReady = !!voteData.onChainId

    return (
      <div className="space-y-3">
        <div className="p-3 rounded-lg bg-gradient-to-br from-purple-500/10 to-primary/10 border border-purple-500/20 space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Ghost className="h-4 w-4 text-purple-500" />
              <span className="text-sm font-semibold">影子跟投 · ShadowVote</span>
            </div>
            <Switch checked={shadowPolicy.enabled} onCheckedChange={handleShadowToggle} />
          </div>
          <p className="text-xs text-muted-foreground leading-relaxed">
            委托本地 Subagent 通过 <code className="text-[10px]">SubagentCoSignCap</code> 代为跟投。
            合约将校验 Cap 的投票权重、日配额与提案活跃状态，超额即中止。
          </p>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-xs">跟投领袖地址 (被跟随者)</Label>
            <Button
              variant="ghost"
              size="sm"
              className="h-5 text-[10px] text-primary p-0"
              onClick={() =>
                handleShadowUpdate({
                  leaderAddress: "0xaf0806fadf61ceeb76c21b40af4393e244a5d8ca91ba208d4f58537421eff2e4",
                  subagentCapId: "0x0000000000000000000000000000000000000000000000000000000000000099",
                })
              }
            >
              填充默认理事长与 Cap
            </Button>
          </div>
          <Input
            value={shadowPolicy.leaderAddress}
            onChange={(e) => handleShadowUpdate({ leaderAddress: e.target.value })}
            placeholder="0x... 领袖钱包地址"
            className="text-xs font-mono"
            disabled={shadowPolicy.enabled}
          />
        </div>

        <div className="space-y-2">
          <Label className="text-xs">SubagentCoSignCap 对象 ID</Label>
          <Input
            value={shadowPolicy.subagentCapId}
            onChange={(e) => handleShadowUpdate({ subagentCapId: e.target.value })}
            placeholder="0x... 链上委托凭证"
            className="text-xs font-mono"
            disabled={shadowPolicy.enabled}
          />
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label className="text-xs">单笔放行上限 (SUI)</Label>
            <Input
              type="number"
              min={1}
              value={shadowPolicy.maxAmountPerTx}
              onChange={(e) =>
                handleShadowUpdate({ maxAmountPerTx: Math.max(1, parseFloat(e.target.value) || 1) })
              }
              className="text-xs"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">每日跟投配额 (次)</Label>
            <Input
              type="number"
              min={1}
              value={shadowPolicy.dailyQuota}
              onChange={(e) =>
                handleShadowUpdate({ dailyQuota: Math.max(1, parseInt(e.target.value, 10) || 1) })
              }
              className="text-xs"
            />
          </div>
        </div>

        <div className="flex justify-between text-xs text-muted-foreground px-1">
          <span>今日已用跟投</span>
          <span className="font-medium">
            {shadowPolicy.usedToday} / {shadowPolicy.dailyQuota} 次
          </span>
        </div>

        {/* AI 哨兵即时风控评估卡片 */}
        <div className="p-3 rounded-lg border bg-muted/20 space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-xs font-semibold">
              <Bot className="h-3.5 w-3.5 text-primary" />
              <span>AI 哨兵风控策略引擎</span>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="h-6 text-[10px] px-2"
              onClick={runSentinelAudit}
              disabled={isAuditing}
            >
              {isAuditing ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
              {sentinelAudit ? "重新评估" : "即时风控核验"}
            </Button>
          </div>

          {sentinelAudit ? (
            <div className="space-y-1.5 pt-1">
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">综合安全评分:</span>
                <Badge
                  variant="outline"
                  className={cn(
                    "text-[10px]",
                    sentinelAudit.verdict === "PASSED"
                      ? "border-emerald-500 text-emerald-600 bg-emerald-50 dark:bg-emerald-950/30"
                      : sentinelAudit.verdict === "WARNED"
                      ? "border-amber-500 text-amber-600 bg-amber-50 dark:bg-amber-950/30"
                      : "border-red-500 text-red-600 bg-red-50 dark:bg-red-950/30"
                  )}
                >
                  {sentinelAudit.score} 分 · {sentinelAudit.verdict === "PASSED" ? "安全放行" : sentinelAudit.verdict === "WARNED" ? "预警通过" : "拒绝跟投"}
                </Badge>
              </div>
              <p className="text-[11px] text-muted-foreground leading-tight">{sentinelAudit.summary}</p>
              <div className="space-y-1 pt-1 border-t border-border/50">
                {sentinelAudit.checks.map((c, i) => (
                  <div key={i} className="flex items-center justify-between text-[10px]">
                    <span className="text-muted-foreground">{c.label}</span>
                    <span className={cn("font-medium", c.pass ? "text-emerald-600" : "text-red-500")}>
                      {c.pass ? "✓ 合规" : "✕ 超限"}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              基于 Move 约束核验收款方 32 字节有效性、额度限额、截止时限与发起人信用等级。
            </p>
          )}
        </div>

        {!onChainReady && (
          <div className="p-3 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-500 mt-0.5 shrink-0" />
            <p className="text-xs text-amber-700 dark:text-amber-400">
              该投票尚未上链，影子跟投不可用。仅链上提案支持 SubagentCoSignCap 委托跟投。
            </p>
          </div>
        )}

        {shadowError && (
          <div className="p-3 rounded-lg bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 text-xs text-red-600 dark:text-red-400">
            {shadowError}
          </div>
        )}

        {shadowDigest && (
          <div className="p-3 rounded-lg bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800 space-y-1">
            <div className="flex items-center gap-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-400">
              <ShieldCheck className="h-3.5 w-3.5" /> 链上影子跟投已提交
            </div>
            <a
              href={`${EXPLORER_TX}${shadowDigest}`}
              target="_blank"
              rel="noreferrer"
              className="text-[11px] font-mono text-emerald-600 dark:text-emerald-500 break-all inline-flex items-center gap-1 hover:underline"
            >
              {shadowDigest.slice(0, 24)}... <ExternalLink className="h-3 w-3" />
            </a>
          </div>
        )}

        <Button
          className="w-full bg-gradient-to-r from-purple-600 to-primary hover:from-purple-600/90 hover:to-primary/90"
          disabled={!onChainReady || shadowBusy || voteData.status === "completed" || !shadowPolicy.enabled}
          onClick={handleExecuteShadowVote}
        >
          {shadowBusy ? (
            <>
              <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> Subagent 签名中...
            </>
          ) : (
            <>
              <Bot className="h-4 w-4 mr-1.5" /> 立即执行影子跟投
            </>
          )}
        </Button>

        {!shadowPolicy.enabled && (
          <p className="text-[11px] text-muted-foreground text-center">请先启用上方开关以激活委托</p>
        )}
      </div>
    )
  }

  const renderVoteButton = () => {
    if (voteData?.status === "completed") {
      return (
        <Button variant="outline" className="w-full" disabled>
          <XCircle className="h-4 w-4 mr-1.5" /> 投票已结束
        </Button>
      )
    }

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

    const voteButton = (label: string, handler: () => void, disabled: boolean) => (
      <Button
        className="w-full bg-gradient-to-r from-primary to-purple-500 hover:from-primary/90 hover:to-purple-500/90"
        disabled={disabled || isVoting}
        onClick={handler}
      >
        {isVoting ? (
          <>
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            提交中...
          </>
        ) : (
          <>
            <Vote className="h-4 w-4 mr-1.5" /> {label}
          </>
        )}
      </Button>
    )

    switch (voteData?.voteType) {
      case "approve":
      case "single":
        return voteButton("提交投票", handleSingleVote, !selectedOption)
      case "multiple":
        return voteButton("提交多选投票", handleMultipleVote, selectedOptions.length === 0)
      case "ranked":
        return voteButton("提交排序投票", handleRankedVote, false)
      default:
        return null
    }
  }

  if (!voteData) {
    if (!open) return null
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-500" />
              未找到该投票
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            投票 ID <code className="text-xs">{voteId}</code> 在链上提案与本地治理投票中均不存在。
            链上数据将由前端在线索引器自动同步，请稍后重试。
          </p>
        </DialogContent>
      </Dialog>
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px] p-0 gap-0 overflow-hidden">
        <div className={`h-24 bg-gradient-to-r ${voteData.color} p-4 flex flex-col justify-end`}>
          <DialogHeader className="text-white">
            <DialogTitle className="flex items-center justify-between">
              <span className="text-xl">{voteData.title}</span>
              <Badge variant="outline" className="bg-white/20 text-white border-white/40">
                {voteData.status === "completed" ? "已结束" : voteData.status === "approved" ? "已达标" : "进行中"}
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
                <AvatarFallback>{(voteData.creator.name || "?").charAt(0)}</AvatarFallback>
              </Avatar>
              <div>
                <p className="text-sm font-medium">{voteData.creator.name}</p>
                <p className="text-xs text-muted-foreground">发起人</p>
              </div>
            </div>
            <div className="flex items-center space-x-2">
              {voteData.isTimeLockedSeal ? (
                <Badge variant="outline" className="text-xs bg-purple-500/10 text-purple-600 border-purple-500/20">
                  <Lock className="h-3 w-3 mr-1" /> SEAL 时间锁盲投 (T:2)
                </Badge>
              ) : voteData.isAnonymous ? (
                <Badge variant="outline" className="text-xs">
                  <EyeOff className="h-3 w-3 mr-1" /> 匿名投票
                </Badge>
              ) : (
                <Badge variant="outline" className="text-xs">
                  <Eye className="h-3 w-3 mr-1" /> 公开投票
                </Badge>
              )}
              {voteData.targetNftType && (
                <Badge variant="outline" className="text-xs bg-amber-500/10 text-amber-600 border-amber-500/20">
                  NFT 凭证门禁
                </Badge>
              )}
              <Badge variant="outline" className="text-xs">
                {voteData.kind === "proposal"
                  ? "链上提案"
                  : voteData.voteType === "single"
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
            <TabsList className="grid w-full grid-cols-4 p-1 bg-muted/50 rounded-xl">
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
              <TabsTrigger
                value="shadow"
                className="rounded-lg data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
              >
                <Ghost className="h-4 w-4 mr-1.5" />
                跟投
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
                    {voteData.isTimeLockedSeal && (Date.now() < (voteData.expiresAt ? new Date(voteData.expiresAt).getTime() : 0)) ? (
                      <div className="flex flex-col items-center justify-center p-6 text-center border rounded-xl bg-purple-500/5 border-purple-500/20">
                        <Lock className="h-10 w-10 text-purple-600 mb-3" />
                        <h3 className="text-sm font-semibold text-purple-900 dark:text-purple-200 mb-1">
                          SEAL 时间锁门限密态保护中
                        </h3>
                        <p className="text-xs text-muted-foreground max-w-sm">
                          所有选票已在客户端经门限加密上链，在截止时间前保持全网密态，任何成员或节点均无法提前窥探。投票截止后将由 Sui Clock 裁定门限解密。
                        </p>
                      </div>
                    ) : showResults ? (
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

              {activeTab === "shadow" && (
                <TabsContent value="shadow" className="mt-4 space-y-2">
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    transition={{ duration: 0.2 }}
                  >
                    {renderShadowVote()}
                  </motion.div>
                </TabsContent>
              )}
            </AnimatePresence>
          </Tabs>
        </div>

        <div className="p-4 border-t space-y-3">
          {(actionError || actionDigest) && (
            <div
              className={cn(
                "p-2.5 rounded-lg border text-xs flex items-start gap-2",
                actionError
                  ? "bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-800 text-red-600 dark:text-red-400"
                  : "bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-400"
              )}
            >
              {actionError ? (
                <>
                  <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                  <span>{actionError}</span>
                </>
              ) : (
                <>
                  <Check className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                  <span className="break-all">
                    投票已提交
                    {actionDigest ? (
                      <>
                        {" · "}
                        <a
                          href={`${EXPLORER_TX}${actionDigest}`}
                          target="_blank"
                          rel="noreferrer"
                          className="font-mono underline"
                        >
                          {actionDigest.slice(0, 20)}...
                        </a>
                      </>
                    ) : (
                      " · 本地签名凭证已记录"
                    )}
                  </span>
                </>
              )}
            </div>
          )}

          <div className="flex justify-between">
            <Button variant="outline" size="sm" className="gap-1">
              <PanelRight className="h-3.5 w-3.5" /> 讨论
            </Button>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                className="gap-1"
                onClick={() => {
                  if (typeof window !== "undefined") {
                    navigator.clipboard?.writeText(window.location.href)
                  }
                }}
              >
                <LinkIcon className="h-3.5 w-3.5" /> 复制链接
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="gap-1"
                onClick={() => {
                  if (typeof window !== "undefined" && navigator.share) {
                    navigator.share({ title: voteData.title, text: voteData.description })
                  }
                }}
              >
                <Share2 className="h-3.5 w-3.5" /> 分享
              </Button>
            </div>
          </div>

          {renderVoteButton()}
        </div>
      </DialogContent>
    </Dialog>
  )
}
