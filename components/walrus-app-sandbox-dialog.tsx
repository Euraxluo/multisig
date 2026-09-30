"use client"

import { useState } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  ShieldCheck,
  HardDrive,
  AlertTriangle,
  Lock,
  Unlock,
  CheckCircle2,
  XCircle,
  Vote,
  Sparkles,
  Info,
  Terminal,
  Zap,
  ArrowUpRight,
  RefreshCw,
  Power
} from "lucide-react"
import { motion, AnimatePresence } from "framer-motion"

export interface WalrusAppSandboxDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  blobId?: string
  appName?: string
  author?: string
  isMemberStaked?: boolean
}

export function WalrusAppSandboxDialog({
  open,
  onOpenChange,
  blobId = "walrus_blob_app_poll_901.wma",
  appName = "去中心化治理微投票 (Walrus Mini-App)",
  author = "Alice (0x1a2b...3c4d)",
  isMemberStaked = true,
}: WalrusAppSandboxDialogProps) {
  // 沙箱策略状态
  const [isActive, setIsActive] = useState(true)
  const [maxSpendPerTx] = useState(1.0) // 1.0 SUI
  const [dailyBudget] = useState(2.0) // 2.0 SUI
  const [spentToday, setSpentToday] = useState(0.1) // 初始已消耗 0.1 SUI
  const [allowedPackage] = useState("0x1234567890abcdef")

  // 投票状态
  const [selectedOption, setSelectedOption] = useState<"A" | "B" | null>(null)
  const [votesA, setVotesA] = useState(14)
  const [votesB, setVotesB] = useState(8)
  const [hasVoted, setHasVoted] = useState(false)

  // 沙箱拦截与反馈消息
  const [interceptAlert, setInterceptAlert] = useState<{
    type: "success" | "danger" | "warning"
    title: string
    detail: string
  } | null>(null)

  // 模拟正常调用：发起投票 (消耗 0.1 SUI)
  const handleVoteAction = (option: "A" | "B") => {
    if (!isActive) {
      setInterceptAlert({
        type: "danger",
        title: "🚫 熔断阻断：应用已被管理员下架",
        detail: "Emergency Kill Switch 已触发，所有链上调用被 Move 规则硬阻断。",
      })
      return
    }

    if (!isMemberStaked) {
      setInterceptAlert({
        type: "warning",
        title: "🔒 门禁拦截：未质押进群",
        detail: "该应用受限于 MemberStakeReceipt 门禁，需先质押 50 SUI 进群方可交互。",
      })
      return
    }

    const cost = 0.1
    if (spentToday + cost > dailyBudget) {
      setInterceptAlert({
        type: "danger",
        title: "🚫 限额超限拦截",
        detail: `今日限额 ${dailyBudget.toFixed(2)} SUI 已达上限，沙箱拒绝追加扣款。`,
      })
      return
    }

    // 正常通过 Move 沙箱校验
    setSelectedOption(option)
    if (option === "A") setVotesA((v) => v + 1)
    else setVotesB((v) => v + 1)
    setSpentToday((prev) => +(prev + cost).toFixed(3))
    setHasVoted(true)

    setInterceptAlert({
      type: "success",
      title: "✅ Move 沙箱鉴权通过",
      detail: `目标合约: ${allowedPackage.slice(0, 8)}... | 扣减配额: +${cost} SUI | 剩余单日配额: ${(dailyBudget - (spentToday + cost)).toFixed(2)} SUI`,
    })
  }

  // 模拟恶意调用 1：单笔超额盗取 (试图划扣 5.0 SUI)
  const handleMaliciousExcessiveSpend = () => {
    setInterceptAlert({
      type: "danger",
      title: "🚫 单笔超额拦截 (Tx Limit Exceeded)",
      detail: `网页请求扣除 5.0 SUI，超过沙箱设定的单笔最高限额 ${maxSpendPerTx.toFixed(1)} SUI！主钱包未受任何波及。`,
    })
  }

  // 模拟恶意调用 2：调用未经授权的外部合约 (尝试动用金库)
  const handleMaliciousRogueContract = () => {
    setInterceptAlert({
      type: "danger",
      title: "🚫 越权合约拦截 (Unauthorized Package)",
      detail: `网页试图调用合约 0x9999...9999 (未在 allowed_packages 白名单内)，沙箱立即阻断！`,
    })
  }

  // 切换一键熔断
  const toggleKillSwitch = () => {
    const nextState = !isActive
    setIsActive(nextState)
    setInterceptAlert({
      type: nextState ? "success" : "warning",
      title: nextState ? "🟢 沙箱已重新激活" : "⚠️ 紧急熔断已触发 (Kill Switch Active)",
      detail: nextState
        ? "应用恢复正常运行，遵循 Move 策略配额约束。"
        : "该 Walrus 应用的所有链上 PTB 与网络权限已立即冻结，防止任何资金流出。",
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[620px] p-0 overflow-hidden border-border/80 bg-background text-foreground shadow-2xl rounded-2xl">
        {/* 顶部标题与沙箱状态徽标 */}
        <div className="p-4 pb-3 border-b border-border/60 bg-muted/20">
          <DialogHeader>
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-2">
                <div className="w-8 h-8 rounded-xl bg-purple-500/10 border border-purple-500/30 text-purple-600 dark:text-purple-400 flex items-center justify-center">
                  <Vote className="w-4 h-4" />
                </div>
                <div>
                  <DialogTitle className="text-sm font-bold flex items-center gap-1.5">
                    {appName}
                    <Badge variant="outline" className="text-[10px] bg-primary/10 text-primary border-primary/20">
                      Walrus Mini-App
                    </Badge>
                  </DialogTitle>
                  <DialogDescription className="text-[10px] text-muted-foreground flex items-center gap-1 mt-0.5 font-mono">
                    <HardDrive className="w-2.5 h-2.5 text-cyan-500" />
                    <span>Blob: {blobId}</span>
                    <span className="text-muted-foreground/60">· by {author}</span>
                  </DialogDescription>
                </div>
              </div>

              <div className="flex items-center space-x-1.5">
                <Badge
                  className={`text-[10px] gap-1 px-2 ${
                    isActive
                      ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30"
                      : "bg-rose-500/10 text-rose-600 dark:text-rose-400 border border-rose-500/30"
                  }`}
                >
                  <ShieldCheck className="w-3 h-3" />
                  {isActive ? "Move 沙箱受限运行中" : "已紧急熔断"}
                </Badge>
                <Button
                  id="btn-kill-switch"
                  size="sm"
                  variant="outline"
                  onClick={toggleKillSwitch}
                  className={`h-7 px-2 text-[10px] gap-1 ${
                    isActive
                      ? "text-rose-500 border-rose-500/30 hover:bg-rose-500/10"
                      : "text-emerald-500 border-emerald-500/30 hover:bg-emerald-500/10"
                  }`}
                  title="群主/管理员一键紧急熔断"
                >
                  <Power className="w-2.5 h-2.5" />
                  {isActive ? "紧急熔断" : "恢复上线"}
                </Button>
              </div>
            </div>
          </DialogHeader>

          {/* 4 项受控指标防护栏 */}
          <div className="grid grid-cols-4 gap-2 mt-3 text-[10px]">
            <div className="p-2 rounded-lg bg-card border border-border/50">
              <span className="text-muted-foreground flex items-center gap-1">
                <Lock className="w-2.5 h-2.5 text-blue-500" /> IFrame 隔离
              </span>
              <p className="font-semibold text-foreground mt-0.5 truncate">无Cookie/无重定向</p>
              <p className="text-[9px] text-blue-600">HTML5 Sandbox</p>
            </div>

            <div className="p-2 rounded-lg bg-card border border-border/50">
              <span className="text-muted-foreground flex items-center gap-1">
                <Zap className="w-2.5 h-2.5 text-amber-500" /> 单日限额
              </span>
              <p className="font-semibold text-foreground mt-0.5">
                {spentToday.toFixed(2)} / {dailyBudget.toFixed(1)} SUI
              </p>
              <Progress value={(spentToday / dailyBudget) * 100} className="h-1 mt-1" />
            </div>

            <div className="p-2 rounded-lg bg-card border border-border/50">
              <span className="text-muted-foreground flex items-center gap-1">
                <ShieldCheck className="w-2.5 h-2.5 text-purple-500" /> 合约白名单
              </span>
              <p className="font-semibold font-mono text-foreground mt-0.5 truncate">{allowedPackage.slice(0, 8)}...</p>
              <p className="text-[9px] text-purple-600">仅限投票Package</p>
            </div>

            <div className="p-2 rounded-lg bg-card border border-border/50">
              <span className="text-muted-foreground flex items-center gap-1">
                <Sparkles className="w-2.5 h-2.5 text-emerald-500" /> 门禁状态
              </span>
              <p className="font-semibold text-foreground mt-0.5 flex items-center gap-1">
                {isMemberStaked ? (
                  <span className="text-emerald-600 flex items-center gap-0.5">
                    <CheckCircle2 className="w-2.5 h-2.5" /> 质押已验证
                  </span>
                ) : (
                  <span className="text-rose-600 flex items-center gap-0.5">
                    <XCircle className="w-2.5 h-2.5" /> 未质押门禁阻断
                  </span>
                )}
              </p>
              <p className="text-[9px] text-muted-foreground">VIP 专属解密</p>
            </div>
          </div>
        </div>

        {/* 动态警报与拦截通知 */}
        <AnimatePresence>
          {interceptAlert && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className={`p-2.5 text-xs flex items-start gap-2 border-b ${
                interceptAlert.type === "success"
                  ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-700 dark:text-emerald-300"
                  : interceptAlert.type === "danger"
                  ? "bg-rose-500/10 border-rose-500/30 text-rose-700 dark:text-rose-300"
                  : "bg-amber-500/10 border-amber-500/30 text-amber-700 dark:text-amber-300"
              }`}
            >
              {interceptAlert.type === "success" ? (
                <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5 text-emerald-500" />
              ) : interceptAlert.type === "danger" ? (
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-rose-500" />
              ) : (
                <Info className="w-4 h-4 shrink-0 mt-0.5 text-amber-500" />
              )}
              <div className="flex-1 text-[11px] leading-relaxed">
                <p className="font-semibold">{interceptAlert.title}</p>
                <p className="opacity-90">{interceptAlert.detail}</p>
              </div>
              <button
                type="button"
                onClick={() => setInterceptAlert(null)}
                className="text-xs opacity-60 hover:opacity-100 px-1"
              >
                ✕
              </button>
            </motion.div>
          )}
        </AnimatePresence>

        {/* 沙箱内部运行视图与恶意行为测试工具箱 */}
        <div className="p-4 space-y-4">
          {/* 模拟 Walrus WebApp 网页视图 */}
          <div className="p-3.5 rounded-xl border border-border/80 bg-muted/30 space-y-3 relative overflow-hidden">
            <div className="flex items-center justify-between text-xs pb-2 border-b border-border/50">
              <span className="font-semibold flex items-center gap-1.5 text-foreground">
                <Vote className="w-3.5 h-3.5 text-purple-500" />
                选题研讨：Sui 与 Aptos 跨链互操作方案探讨
              </span>
              <Badge variant="outline" className="text-[9px] bg-background">
                共 {votesA + votesB} 票
              </Badge>
            </div>

            <p className="text-xs text-muted-foreground">
              请投出您的关键一票，每次投票消耗 0.1 SUI 链上燃料 (由受限沙箱代理签名扣款)：
            </p>

            <div className="space-y-2">
              <div
                id="vote-option-a"
                onClick={() => handleVoteAction("A")}
                className={`p-2.5 rounded-xl border cursor-pointer transition-all flex items-center justify-between text-xs ${
                  selectedOption === "A"
                    ? "bg-purple-500/15 border-purple-500 text-purple-600 dark:text-purple-300 shadow-sm"
                    : "bg-card hover:bg-muted/60 border-border/60"
                }`}
              >
                <div>
                  <p className="font-medium">方案 A：基于 Wormhole 与 LayerZero 双轨中继</p>
                  <p className="text-[10px] text-muted-foreground">兼容多链资产映射，流动性沉淀更深</p>
                </div>
                <div className="text-right shrink-0 ml-3">
                  <span className="font-bold text-xs">{votesA} 票</span>
                  <p className="text-[9px] text-muted-foreground">
                    {Math.round((votesA / (votesA + votesB)) * 100)}%
                  </p>
                </div>
              </div>

              <div
                id="vote-option-b"
                onClick={() => handleVoteAction("B")}
                className={`p-2.5 rounded-xl border cursor-pointer transition-all flex items-center justify-between text-xs ${
                  selectedOption === "B"
                    ? "bg-purple-500/15 border-purple-500 text-purple-600 dark:text-purple-300 shadow-sm"
                    : "bg-card hover:bg-muted/60 border-border/60"
                }`}
              >
                <div>
                  <p className="font-medium">方案 B：基于 Walrus 状态证明与 Sui Light Client</p>
                  <p className="text-[10px] text-muted-foreground">100% 去中心化零三方信任，加密原生证明</p>
                </div>
                <div className="text-right shrink-0 ml-3">
                  <span className="font-bold text-xs">{votesB} 票</span>
                  <p className="text-[9px] text-muted-foreground">
                    {Math.round((votesB / (votesA + votesB)) * 100)}%
                  </p>
                </div>
              </div>
            </div>

            {hasVoted && (
              <p className="text-[10px] text-emerald-600 dark:text-emerald-400 flex items-center gap-1 font-medium">
                <CheckCircle2 className="w-3 h-3" />
                已在当前纪元完成投票签名，结果已通过沙箱受限节点广播。
              </p>
            )}
          </div>

          {/* 沙箱防御攻防测试区 (演示限制生效机制) */}
          <div className="p-3 rounded-xl bg-muted/40 border border-border/60 space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="font-semibold flex items-center gap-1 text-foreground">
                <Terminal className="w-3.5 h-3.5 text-primary" />
                沙箱防御测试台 (验证网页限制生效)
              </span>
              <span className="text-[10px] text-muted-foreground">实时模拟恶意网页脚本行为</span>
            </div>

            <div className="grid grid-cols-2 gap-2 text-xs">
              <Button
                id="btn-test-excess"
                size="sm"
                variant="outline"
                type="button"
                onClick={handleMaliciousExcessiveSpend}
                className="h-8 text-[11px] gap-1 text-rose-500 border-rose-500/30 hover:bg-rose-500/10 justify-start"
              >
                <AlertTriangle className="w-3 h-3 shrink-0" />
                <span>测试：尝试单笔超额 (5.0 SUI)</span>
              </Button>

              <Button
                id="btn-test-rogue"
                size="sm"
                variant="outline"
                type="button"
                onClick={handleMaliciousRogueContract}
                className="h-8 text-[11px] gap-1 text-rose-500 border-rose-500/30 hover:bg-rose-500/10 justify-start"
              >
                <XCircle className="w-3 h-3 shrink-0" />
                <span>测试：尝试越权调用未授权合约</span>
              </Button>
            </div>
          </div>

          {/* 权限清单与底层 CSP 详情 */}
          <div className="text-[10px] text-muted-foreground flex items-center justify-between pt-1 border-t border-border/40">
            <span>
              CSP: <code className="bg-muted px-1 py-0.5 rounded font-mono">frame-ancestors 'self'</code> ·{" "}
              <code className="bg-muted px-1 py-0.5 rounded font-mono">allow-scripts allow-forms</code>
            </span>
            <span className="text-primary hover:underline cursor-pointer flex items-center gap-0.5">
              Move 合约验证标准 ↗
            </span>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
