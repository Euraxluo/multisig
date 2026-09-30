"use client"

import { useState } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import {
  Vote,
  CheckCircle2,
  AlertCircle,
  PauseCircle,
  PlayCircle
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
  appName = "社区投票",
  author = "Alice",
  isMemberStaked = true,
}: WalrusAppSandboxDialogProps) {
  const [isActive, setIsActive] = useState(true)
  const [dailyBudget] = useState(2.0)
  const [spentToday, setSpentToday] = useState(0.1)

  // 投票状态
  const [selectedOption, setSelectedOption] = useState<"A" | "B" | null>(null)
  const [votesA, setVotesA] = useState(14)
  const [votesB, setVotesB] = useState(8)
  const [hasVoted, setHasVoted] = useState(false)

  // 状态提示
  const [alertNotice, setAlertNotice] = useState<{
    type: "success" | "danger"
    text: string
  } | null>(null)

  const handleVoteAction = (option: "A" | "B") => {
    if (!isActive) {
      setAlertNotice({
        type: "danger",
        text: "该投票已暂停",
      })
      return
    }

    if (!isMemberStaked) {
      setAlertNotice({
        type: "danger",
        text: "仅限群成员参与投票",
      })
      return
    }

    const cost = 0.1
    if (spentToday + cost > dailyBudget) {
      setAlertNotice({
        type: "danger",
        text: "已达今日支出上限",
      })
      return
    }

    setSelectedOption(option)
    if (option === "A") setVotesA((v) => v + 1)
    else setVotesB((v) => v + 1)
    setSpentToday((prev) => +(prev + cost).toFixed(3))
    setHasVoted(true)

    setAlertNotice({
      type: "success",
      text: "投票成功！",
    })
  }

  const toggleStatus = () => {
    const next = !isActive
    setIsActive(next)
    setAlertNotice({
      type: next ? "success" : "danger",
      text: next ? "应用已恢复运行" : "应用已暂停",
    })
  }

  const totalVotes = votesA + votesB
  const pctA = totalVotes > 0 ? Math.round((votesA / totalVotes) * 100) : 50
  const pctB = totalVotes > 0 ? 100 - pctA : 50

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[92vw] max-w-[400px] p-0 overflow-hidden border-border bg-background text-foreground shadow-xl rounded-2xl">
        {/* 顶部标题栏 */}
        <div className="p-4 pb-3 border-b border-border/50 bg-muted/30">
          <DialogHeader>
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-2.5">
                <div className="w-8 h-8 rounded-xl bg-purple-500/10 text-purple-600 dark:text-purple-400 flex items-center justify-center shrink-0">
                  <Vote className="w-4 h-4" />
                </div>
                <div className="text-left">
                  <DialogTitle className="text-sm font-semibold flex items-center gap-1.5">
                    {appName}
                  </DialogTitle>
                  <DialogDescription className="text-xs text-muted-foreground mt-0.5">
                    由 {author} 发起
                  </DialogDescription>
                </div>
              </div>

              <div className="flex items-center space-x-1.5 mr-6">
                <Badge
                  variant="outline"
                  className={`text-[10px] px-2 py-0.5 font-normal ${
                    isActive
                      ? "text-emerald-600 dark:text-emerald-400 border-emerald-500/30 bg-emerald-500/10"
                      : "text-muted-foreground border-border bg-muted"
                  }`}
                >
                  {isActive ? "进行中" : "已暂停"}
                </Badge>
                <Button
                  id="btn-kill-switch"
                  size="sm"
                  variant="ghost"
                  onClick={toggleStatus}
                  className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
                  title={isActive ? "暂停" : "恢复"}
                >
                  {isActive ? (
                    <PauseCircle className="w-4 h-4" />
                  ) : (
                    <PlayCircle className="w-4 h-4" />
                  )}
                </Button>
              </div>
            </div>
          </DialogHeader>
        </div>

        {/* 动态通知 */}
        <AnimatePresence>
          {alertNotice && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className={`px-4 py-2 text-xs flex items-center justify-between border-b ${
                alertNotice.type === "success"
                  ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-600 dark:text-emerald-400"
                  : "bg-rose-500/10 border-rose-500/20 text-rose-600 dark:text-rose-400"
              }`}
            >
              <div className="flex items-center gap-1.5">
                {alertNotice.type === "success" ? (
                  <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                ) : (
                  <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                )}
                <span>{alertNotice.text}</span>
              </div>
              <button
                type="button"
                onClick={() => setAlertNotice(null)}
                className="text-xs opacity-60 hover:opacity-100"
              >
                ✕
              </button>
            </motion.div>
          )}
        </AnimatePresence>

        {/* 投票主题与选项 */}
        <div className="p-4 space-y-3.5">
          <div>
            <h4 className="text-xs font-semibold text-foreground">
              议题：Sui 与 Aptos 跨链互操作方案探讨
            </h4>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              共 {totalVotes} 人参与投票
            </p>
          </div>

          <div className="space-y-2.5">
            {/* 选项 A */}
            <div
              id="vote-option-a"
              onClick={() => handleVoteAction("A")}
              className={`p-3 rounded-xl border cursor-pointer transition-all ${
                selectedOption === "A"
                  ? "border-primary bg-primary/5 text-foreground shadow-sm"
                  : "border-border/60 hover:border-border hover:bg-muted/40"
              }`}
            >
              <div className="flex items-center justify-between text-xs mb-1.5">
                <span className="font-medium">方案 A：双轨中继方案</span>
                <span className="font-semibold text-muted-foreground">{pctA}%</span>
              </div>
              <Progress value={pctA} className="h-1.5" />
              <p className="text-[10px] text-muted-foreground mt-1.5">
                兼容多链映射，沉淀更深流动性 ({votesA} 票)
              </p>
            </div>

            {/* 选项 B */}
            <div
              id="vote-option-b"
              onClick={() => handleVoteAction("B")}
              className={`p-3 rounded-xl border cursor-pointer transition-all ${
                selectedOption === "B"
                  ? "border-primary bg-primary/5 text-foreground shadow-sm"
                  : "border-border/60 hover:border-border hover:bg-muted/40"
              }`}
            >
              <div className="flex items-center justify-between text-xs mb-1.5">
                <span className="font-medium">方案 B：轻客户端状态证明</span>
                <span className="font-semibold text-muted-foreground">{pctB}%</span>
              </div>
              <Progress value={pctB} className="h-1.5" />
              <p className="text-[10px] text-muted-foreground mt-1.5">
                去中心化原生证明 ({votesB} 票)
              </p>
            </div>
          </div>

          {hasVoted && (
            <p className="text-[11px] text-emerald-600 dark:text-emerald-400 flex items-center justify-center gap-1 font-medium pt-1">
              <CheckCircle2 className="w-3.5 h-3.5" />
              您的选票已提交并上链
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
