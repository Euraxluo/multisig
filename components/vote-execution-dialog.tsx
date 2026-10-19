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
import { Badge } from "@/components/ui/badge"
import { Check, Vote, Play, ExternalLink } from "lucide-react"
import { executeProposal, getProposals, type ProposalItem } from "@/lib/onchain-store"

interface VoteExecutionDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  voteId: string
}

export function VoteExecutionDialog({ open, onOpenChange, voteId }: VoteExecutionDialogProps) {
  const [isProcessing, setIsProcessing] = useState(false)
  const [isCompleted, setIsCompleted] = useState(false)
  const [currentStep, setCurrentStep] = useState(0)
  const [executionDigest, setExecutionDigest] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [targetProposal, setTargetProposal] = useState<ProposalItem | null>(null)

  useEffect(() => {
    if (!open) {
      setIsProcessing(false)
      setIsCompleted(false)
      setCurrentStep(0)
      setExecutionDigest(null)
      setErrorMessage(null)
      return
    }

    const proposals = getProposals()
    const found = proposals.find((p) => p.id === voteId || p.onChainId === voteId)
    if (found) {
      setTargetProposal(found)
    } else if (proposals.length > 0) {
      setTargetProposal(proposals[0])
    }
  }, [open, voteId])

  const steps = ["验证门限权重", "构建 PTB 划转", "钱包共识签名", "链上完成划款"]

  const handleExecute = async () => {
    if (!targetProposal) return
    setIsProcessing(true)
    setErrorMessage(null)
    setCurrentStep(1)
    try {
      setCurrentStep(2)
      const res = await executeProposal(targetProposal.id)
      setCurrentStep(3)
      setIsCompleted(true)
      if (res.digest) {
        setExecutionDigest(res.digest)
      }
    } catch (e: any) {
      console.warn("Execute proposal notice:", e.message)
      setErrorMessage(e.message || "执行提案失败")
    } finally {
      setIsProcessing(false)
    }
  }

  const title = targetProposal?.title || "治理提案执行"
  const amountStr = targetProposal ? `${targetProposal.amount} ${targetProposal.token}` : "金库出款"
  const recipientStr = targetProposal?.recipient || "受款方"

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!isProcessing) {
          onOpenChange(value)
        }
      }}
    >
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Vote className="h-5 w-5 text-primary" />
            执行投票结果
          </DialogTitle>
          <DialogDescription>将投票决议转化为链上交易并由金库正式执行</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="p-4 rounded-lg border space-y-2 text-xs">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">提案标题</span>
              <span className="font-medium text-foreground">{title}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">当前状态</span>
              <Badge variant="outline" className="bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/20">
                <Check className="h-3 w-3 mr-1" />{" "}
                {targetProposal?.status === "executed" ? "已执行" : "法定票数已达成"}
              </Badge>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">划转金额</span>
              <span className="font-semibold text-primary">{amountStr}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">受款地址</span>
              <span className="font-mono truncate max-w-[220px]">{recipientStr}</span>
            </div>
          </div>

          <div className="space-y-2">
            <span className="text-xs font-medium">执行流程</span>
            <div className="grid grid-cols-4 gap-1.5 text-center">
              {steps.map((step, idx) => (
                <div
                  key={idx}
                  className={`p-2 rounded text-[11px] font-medium transition-colors ${
                    idx < currentStep || isCompleted
                      ? "bg-primary text-primary-foreground"
                      : idx === currentStep && isProcessing
                        ? "bg-primary/20 text-primary border border-primary/40 animate-pulse"
                        : "bg-muted text-muted-foreground"
                  }`}
                >
                  {step}
                </div>
              ))}
            </div>
          </div>

          {executionDigest && (
            <div className="p-3 bg-emerald-500/10 border border-emerald-500/20 rounded-lg text-xs">
              <p className="text-emerald-600 dark:text-emerald-400 font-medium">
                ✅ 提案已在 Sui 链上金库成功执行！
              </p>
              <div className="flex items-center gap-1 font-mono text-[11px] mt-1 break-all">
                <span>Tx: {executionDigest}</span>
                <a
                  href={`https://suiscan.xyz/testnet/tx/${executionDigest}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-primary hover:opacity-80"
                >
                  <ExternalLink className="h-3 w-3" />
                </a>
              </div>
            </div>
          )}

          {errorMessage && (
            <div className="p-2.5 text-xs text-red-500 bg-red-500/10 border border-red-500/20 rounded-md">
              {errorMessage}
            </div>
          )}
        </div>

        <DialogFooter className="pt-2">
          {isCompleted ? (
            <Button onClick={() => onOpenChange(false)} className="w-full">
              完成并关闭
            </Button>
          ) : (
            <Button
              onClick={handleExecute}
              disabled={isProcessing || targetProposal?.status === "executed"}
              className="w-full bg-gradient-to-r from-primary to-purple-500 hover:opacity-90 text-white"
            >
              {isProcessing ? "正在执行链上划转 PTB..." : (
                <>
                  <Play className="h-4 w-4 mr-1.5" /> 确认执行划转
                </>
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
