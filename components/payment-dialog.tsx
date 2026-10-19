"use client"

import { useState, useEffect } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { ArrowRight, Loader2, CheckCircle2, ExternalLink, Wallet } from "lucide-react"
import { motion, AnimatePresence } from "framer-motion"
import { vaultClient, fetchRealBalances, getActiveAccount } from "@/lib/onchain-store"
import { signAndExecuteWithWallet } from "@/lib/sui-wallet-signer"

interface PaymentDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  bill?: any
  amount?: number
  recipientAddress?: string
  title?: string
}

export function PaymentDialog({ open, onOpenChange, bill, amount: initialAmount, recipientAddress, title }: PaymentDialogProps) {
  const displayTitle = title || bill?.title || "即时支付 / 转账"
  const defaultRecipient = recipientAddress || bill?.creator || "0xaf0806fadf61ceeb76c21b40af4393e244a5d8ca91ba208d4f58537421eff2e4"
  const defaultAmount = (initialAmount || bill?.amount || 1.0).toString()

  const [paymentToken, setPaymentToken] = useState(bill?.token || "SUI")
  const [recipient, setRecipient] = useState(defaultRecipient)
  const [paymentAmount, setPaymentAmount] = useState(defaultAmount)
  const [isProcessing, setIsProcessing] = useState(false)
  const [processingStatus, setProcessingStatus] = useState<string>("")
  const [txDigest, setTxDigest] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [walletBalance, setWalletBalance] = useState<{ sui: string; usdc: string }>({ sui: "0.00", usdc: "0.00" })

  const activeAccount = getActiveAccount()

  useEffect(() => {
    if (open && activeAccount?.address) {
      fetchRealBalances(activeAccount.address).then((res) => {
        setWalletBalance({
          sui: res.sui.balance,
          usdc: res.usdc.balance,
        })
      })
    }
  }, [open, activeAccount?.address])

  useEffect(() => {
    if (!open) {
      setTxDigest(null)
      setErrorMessage(null)
      setIsProcessing(false)
    } else {
      if (initialAmount) setPaymentAmount(initialAmount.toString())
      if (recipientAddress) setRecipient(recipientAddress)
    }
  }, [open, initialAmount, recipientAddress])

  const handleExecutePayment = async () => {
    const amt = parseFloat(paymentAmount)
    if (isNaN(amt) || amt <= 0) {
      setErrorMessage("请输入有效的转账金额")
      return
    }
    if (!recipient.trim().startsWith("0x")) {
      setErrorMessage("请输入合法的 Sui 收款地址 (0x...)")
      return
    }

    setErrorMessage(null)
    setIsProcessing(true)
    setProcessingStatus("正在构建 Sui 原生转账交易 PTB...")

    try {
      const amountMist = BigInt(Math.round(amt * 1e9))
      const tx = vaultClient.buildDirectTransferPTB(recipient.trim(), amountMist)

      setProcessingStatus("请在连接的 Sui 钱包中确认并签署支付...")
      const res = await signAndExecuteWithWallet(tx)

      setTxDigest(res.digest)
      setProcessingStatus("支付已在 Sui 链上确认成功！")

      // 若为支付账单，广播更新
      if (bill?.id) {
        window.dispatchEvent(new CustomEvent("sui-bill-paid", { detail: { billId: bill.id, amount: amt, txDigest: res.digest } }))
      }
    } catch (err: any) {
      console.error("[PaymentDialog] Execution error:", err)
      setErrorMessage(err.message || "钱包签署或网络提交失败")
    } finally {
      setIsProcessing(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[92vw] max-w-[420px] rounded-2xl p-0 overflow-hidden bg-background border border-border shadow-2xl">
        <div className="bg-gradient-to-r from-primary to-purple-600 p-4 text-white">
          <DialogHeader className="text-left">
            <DialogTitle className="text-base font-bold flex items-center gap-2">
              <Wallet className="w-4 h-4" />
              <span>{displayTitle}</span>
            </DialogTitle>
            <DialogDescription className="text-white/80 text-xs">
              通过 Sui 原生可编程交易块 (PTB) 即时向链上收款方转账
            </DialogDescription>
          </DialogHeader>
        </div>

        <div className="p-4 space-y-4 text-xs">
          {!txDigest ? (
            <>
              {/* 收款人与金额卡片 */}
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label className="text-xs font-semibold">收款地址 (Recipient)</Label>
                  <Input
                    value={recipient}
                    onChange={(e) => setRecipient(e.target.value)}
                    placeholder="0x..."
                    className="font-mono text-xs"
                    disabled={isProcessing}
                  />
                </div>

                <div className="space-y-1.5">
                  <div className="flex justify-between items-center">
                    <Label className="text-xs font-semibold">支付金额</Label>
                    <span className="text-[11px] text-muted-foreground">
                      钱包余额: <strong className="text-foreground">{walletBalance.sui} SUI</strong>
                    </span>
                  </div>
                  <div className="relative">
                    <Input
                      type="number"
                      step="0.01"
                      value={paymentAmount}
                      onChange={(e) => setPaymentAmount(e.target.value)}
                      className="text-sm pr-16"
                      disabled={isProcessing}
                    />
                    <span className="absolute right-3 top-2.5 text-xs font-bold text-muted-foreground">
                      {paymentToken}
                    </span>
                  </div>
                </div>

                {/* 状态与费用估算 */}
                <div className="p-2.5 rounded-lg bg-muted/40 border border-border/50 text-[11px] space-y-1 text-muted-foreground">
                  <div className="flex justify-between">
                    <span>网络协议:</span>
                    <span className="font-medium text-foreground">Sui Testnet (v3)</span>
                  </div>
                  <div className="flex justify-between">
                    <span>预估 Gas:</span>
                    <span className="font-medium text-foreground">&lt; 0.002 SUI</span>
                  </div>
                  <div className="flex justify-between">
                    <span>签名方式:</span>
                    <span className="font-medium text-emerald-600 dark:text-emerald-400">Sui Wallet Standard 本地签署</span>
                  </div>
                </div>

                {errorMessage && (
                  <div className="p-2.5 rounded-md bg-destructive/10 border border-destructive/20 text-destructive text-xs">
                    {errorMessage}
                  </div>
                )}
              </div>

              {isProcessing ? (
                <div className="py-3 flex flex-col items-center justify-center space-y-2">
                  <Loader2 className="w-6 h-6 animate-spin text-primary" />
                  <p className="text-xs font-medium text-center text-muted-foreground">{processingStatus}</p>
                </div>
              ) : (
                <div className="flex justify-end gap-2 pt-2">
                  <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
                    取消
                  </Button>
                  <Button
                    size="sm"
                    onClick={handleExecutePayment}
                    className="bg-gradient-to-r from-primary to-purple-600 text-white hover:from-primary/90 hover:to-purple-600/90 gap-1.5"
                  >
                    <span>确认支付</span>
                    <ArrowRight className="w-3.5 h-3.5" />
                  </Button>
                </div>
              )}
            </>
          ) : (
            /* 支付成功视图 */
            <div className="py-4 space-y-4 text-center">
              <div className="w-12 h-12 rounded-full bg-emerald-100 dark:bg-emerald-950/40 text-emerald-600 flex items-center justify-center mx-auto">
                <CheckCircle2 className="w-6 h-6" />
              </div>
              <div>
                <h4 className="text-sm font-bold text-foreground">支付已成功完成！</h4>
                <p className="text-xs text-muted-foreground mt-1">
                  已转出 {paymentAmount} {paymentToken} 至收款方
                </p>
              </div>

              <div className="p-2.5 rounded-md bg-muted font-mono text-[11px] break-all select-all text-left border border-border">
                <div className="text-[10px] text-muted-foreground mb-0.5">Sui 交易摘要 (Digest):</div>
                {txDigest}
              </div>

              <div className="flex justify-center gap-2 pt-2">
                <a
                  href={`https://suiscan.xyz/testnet/tx/${txDigest}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center justify-center h-8 px-3 text-xs font-medium rounded-md border border-input bg-background hover:bg-accent hover:text-accent-foreground gap-1"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  <span>在 Suiscan 查看</span>
                </a>
                <Button
                  size="sm"
                  onClick={() => onOpenChange(false)}
                  className="h-8 bg-gradient-to-r from-primary to-purple-600 text-white"
                >
                  完成并关闭
                </Button>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
