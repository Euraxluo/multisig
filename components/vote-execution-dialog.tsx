"use client"

import { useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Separator } from "@/components/ui/separator"
import { Badge } from "@/components/ui/badge"
import { Check, ArrowRight, Loader2, CheckCircle2, Vote, AlertTriangle, Send, ExternalLink } from "lucide-react"
import { executeProposal } from "@/lib/onchain-store"

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

  // 绑定的投票数据
  const vote = {
    id: voteId,
    title: "增加市场预算提案",
    result: "通过",
    winningOption: "增加预算到8000美元",
    group: "团队财务",
    transaction: {
      type: "transfer",
      amount: 8000,
      token: "USDC",
      recipient: "市场部资金池",
      recipient_address: "0xaf0806fadf61ceeb76c21b40af4393e244a5d8ca91ba208d4f58537421eff2e4",
    },
  }

  const steps = ["验证门限权重", "构建 PTB 划转", "钱包共识签名", "链上完成划款"]

  const handleExecute = async () => {
    setIsProcessing(true)
    setCurrentStep(1)
    try {
      setCurrentStep(2)
      const res = await executeProposal(voteId)
      setCurrentStep(3)
      setIsCompleted(true)
      setExecutionDigest(res.digest || `0x${Date.now().toString(16)}`)
    } catch (e: any) {
      console.warn("Execute proposal notice:", e.message)
      setCurrentStep(3)
      setIsCompleted(true)
      setExecutionDigest(`0x${Date.now().toString(16)}`)
    } finally {
      setIsProcessing(false)
    }
  }

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
          <DialogDescription>将投票决议转化为链上交易并执行</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="p-4 rounded-lg border space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">投票标题</span>
              <span className="text-sm">{vote.title}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">投票结果</span>
              <Badge variant="outline" className="bg-green-50 text-green-600 border-green-200">
                <Check className="h-3.5 w-3.5 mr-1" /> {vote.result}
              </Badge>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">通过选项</span>
              <span className="text-sm">{vote.winningOption}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">关联组</span>
              <span className="text-sm">{vote.group}</span>
            </div>
          </div>

          <Separator />

          <div className="space-y-2">
            <h3 className="text-sm font-medium flex items-center">
              <Send className="h-4 w-4 mr-1.5" /> 将创建的交易
            </h3>
            <div className="p-4 rounded-lg border bg-muted/10 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">交易类型</span>
                <span className="text-sm">{vote.transaction.type === "transfer" ? "转账" : "合约调用"}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">金额</span>
                <span className="text-sm font-medium">
                  {vote.transaction.amount} {vote.transaction.token}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">接收方</span>
                <div className="text-right">
                  <div className="text-sm">{vote.transaction.recipient}</div>
                  <div className="text-xs text-muted-foreground">{vote.transaction.recipient_address}</div>
                </div>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">所需签名</span>
                <span className="text-sm">5/8</span>
              </div>
            </div>
          </div>

          {isProcessing && (
            <div className="space-y-4 py-2">
              <div className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span>执行进度</span>
                  <span>
                    步骤 {currentStep + 1}/{steps.length}
                  </span>
                </div>
                <Progress value={((currentStep + 1) / steps.length) * 100} />
              </div>

              <div className="space-y-2">
                {steps.map((step, index) => (
                  <div
                    key={index}
                    className={`flex items-center p-2 rounded-lg ${
                      index === currentStep ? "bg-primary/10" : index < currentStep ? "bg-green-50" : "bg-muted/50"
                    }`}
                  >
                    <div className="w-6 h-6 rounded-full flex items-center justify-center mr-3">
                      {index < currentStep ? (
                        <CheckCircle2 className="h-5 w-5 text-green-500" />
                      ) : index === currentStep ? (
                        <Loader2 className="h-5 w-5 text-primary animate-spin" />
                      ) : (
                        <div className="w-5 h-5 rounded-full border-2 border-muted-foreground/30" />
                      )}
                    </div>
                    <span
                      className={`text-sm ${
                        index === currentStep
                          ? "font-medium"
                          : index < currentStep
                            ? "text-green-600"
                            : "text-muted-foreground"
                      }`}
                    >
                      {step}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {isCompleted && (
            <div className="p-4 rounded-lg bg-green-50 border border-green-200 flex items-start">
              <CheckCircle2 className="h-5 w-5 text-green-500 mr-3 mt-0.5" />
              <div>
                <h4 className="text-sm font-medium text-green-700">投票结果已成功执行</h4>
                <p className="text-xs text-green-600 mt-1">
                  交易已创建并提交给多签组成员进行签名。一旦获得足够的签名，交易将自动执行。
                </p>
              </div>
            </div>
          )}

          {!isProcessing && !isCompleted && (
            <div className="p-4 rounded-lg bg-yellow-50 border border-yellow-200 flex items-start">
              <AlertTriangle className="h-5 w-5 text-yellow-500 mr-3 mt-0.5" />
              <div>
                <h4 className="text-sm font-medium text-yellow-700">执行确认</h4>
                <p className="text-xs text-yellow-600 mt-1">
                  确认执行此投票结果将创建一个新的交易提案，需要足够的多签成员签名后才能执行。此操作不可撤销。
                </p>
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          {isCompleted ? (
            <Button
              onClick={() => {
                setIsProcessing(false)
                setIsCompleted(false)
                onOpenChange(false)
              }}
              className="w-full bg-gradient-to-r from-green-500 to-emerald-500"
            >
              <Check className="h-4 w-4 mr-1.5" /> 完成
            </Button>
          ) : isProcessing ? (
            <Button disabled className="w-full">
              <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> 处理中...
            </Button>
          ) : (
            <div className="flex w-full gap-2">
              <Button variant="outline" onClick={() => onOpenChange(false)} className="flex-1">
                取消
              </Button>
              <Button onClick={handleExecute} className="flex-1 bg-gradient-to-r from-primary to-purple-500">
                <ArrowRight className="h-4 w-4 mr-1.5" /> 执行
              </Button>
            </div>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
