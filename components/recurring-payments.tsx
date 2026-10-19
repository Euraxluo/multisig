"use client"

import { useState, useEffect } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { CalendarClock, Waves, MoreHorizontal, Pause, Play, X } from "lucide-react"
import { motion } from "framer-motion"
import { format, addDays } from "date-fns"
import { Progress } from "@/components/ui/progress"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"

interface RecurringPaymentsProps {
  groupId?: string
}

interface PaymentRecord {
  id: string
  type: "recurring" | "stream"
  name: string
  recipient: string
  amount: string
  token: string
  frequency?: string
  nextPayment?: any
  startDate?: any
  endDate?: any
  progress?: number
  status: "active" | "paused"
}

const DEFAULT_PAYMENTS: PaymentRecord[] = [
  {
    id: "payment-1",
    type: "recurring",
    name: "Team Salaries (核心开发者津贴)",
    recipient: "0xaf0806fadf61ceeb76c21b40af4393e244a5d8ca91ba208d4f58537421eff2e4",
    amount: "100",
    token: "SUI",
    frequency: "Monthly",
    nextPayment: addDays(new Date(), 15),
    status: "active",
  },
  {
    id: "payment-2",
    type: "stream",
    name: "Audit Stream (Move 安全审计流支付)",
    recipient: "0x83fb785f1da119aea4e0faa19d1466b33899e14ea730af6425ec7d5557cb5a36",
    amount: "50",
    token: "USDC",
    startDate: addDays(new Date(), -5),
    endDate: addDays(new Date(), 25),
    progress: 20,
    status: "active",
  },
]

export function RecurringPayments({ groupId }: RecurringPaymentsProps) {
  const [payments, setPayments] = useState<PaymentRecord[]>(DEFAULT_PAYMENTS)
  const [cancelPaymentId, setCancelPaymentId] = useState<string | null>(null)

  useEffect(() => {
    const load = () => {
      try {
        const stored = localStorage.getItem("sui_recurring_payments")
        if (stored) {
          const parsed = JSON.parse(stored)
          if (Array.isArray(parsed) && parsed.length > 0) {
            setPayments(parsed)
            return
          }
        }
        localStorage.setItem("sui_recurring_payments", JSON.stringify(DEFAULT_PAYMENTS))
      } catch {}
    }
    load()
    window.addEventListener("sui-recurring-updated", load)
    window.addEventListener("storage", load)
    return () => {
      window.removeEventListener("sui-recurring-updated", load)
      window.removeEventListener("storage", load)
    }
  }, [])

  const saveList = (updated: PaymentRecord[]) => {
    setPayments(updated)
    try {
      localStorage.setItem("sui_recurring_payments", JSON.stringify(updated))
      window.dispatchEvent(new CustomEvent("sui-recurring-updated", { detail: updated }))
    } catch {}
  }

  const togglePaymentStatus = (paymentId: string) => {
    const updated = payments.map((p) => {
      if (p.id === paymentId) {
        return {
          ...p,
          status: (p.status === "active" ? "paused" : "active") as "active" | "paused",
        }
      }
      return p
    })
    saveList(updated)
  }

  const cancelPayment = (paymentId: string) => {
    const updated = payments.filter((p) => p.id !== paymentId)
    saveList(updated)
    setCancelPaymentId(null)
  }

  const container = {
    hidden: { opacity: 0 },
    show: {
      opacity: 1,
      transition: {
        staggerChildren: 0.05,
      },
    },
  }

  const item = {
    hidden: { opacity: 0, y: 10 },
    show: { opacity: 1, y: 0 },
  }

  return (
    <>
      <div className="mb-4">
        <h3 className="text-lg font-semibold mb-3">周期与流支付</h3>

        {payments.length === 0 ? (
          <Card className="border-dashed">
            <CardContent className="p-6 flex flex-col items-center justify-center">
              <p className="text-muted-foreground text-sm">暂无活跃的周期计划或流支付</p>
            </CardContent>
          </Card>
        ) : (
          <motion.div className="grid gap-2" variants={container} initial="hidden" animate="show">
            {payments.map((payment) => (
              <motion.div key={payment.id} variants={item}>
                <Card className="overflow-hidden border-none shadow-sm">
                  <div
                    className={`h-1 bg-gradient-to-r ${payment.type === "recurring" ? "from-orange-500 to-amber-400" : "from-purple-500 to-violet-400"}`}
                  ></div>
                  <CardContent className="p-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center">
                        <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center mr-3">
                          {payment.type === "recurring" ? (
                            <CalendarClock className="h-4 w-4 text-orange-500" />
                          ) : (
                            <Waves className="h-4 w-4 text-purple-500" />
                          )}
                        </div>
                        <div>
                          <div className="flex items-center">
                            <h4 className="text-sm font-medium">{payment.name}</h4>
                            <Badge
                              variant={payment.status === "active" ? "default" : "outline"}
                              className={`ml-2 text-xs ${payment.status === "active" ? "bg-green-500/20 text-green-700 dark:text-green-400 border-green-500/30" : "text-muted-foreground"}`}
                            >
                              {payment.status === "active" ? "生效中" : "已暂停"}
                            </Badge>
                          </div>
                          <p className="text-xs text-muted-foreground font-mono">
                            {payment.amount} {payment.token} → {payment.recipient.length > 14 ? `${payment.recipient.slice(0, 8)}...${payment.recipient.slice(-4)}` : payment.recipient}
                          </p>
                        </div>
                      </div>

                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-8 w-8">
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuLabel>操作菜单</DropdownMenuLabel>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onClick={() => togglePaymentStatus(payment.id)}>
                            {payment.status === "active" ? (
                              <>
                                <Pause className="h-4 w-4 mr-2" />
                                暂停计划
                              </>
                            ) : (
                              <>
                                <Play className="h-4 w-4 mr-2" />
                                恢复计划
                              </>
                            )}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => setCancelPaymentId(payment.id)}
                            className="text-destructive focus:text-destructive"
                          >
                            <X className="h-4 w-4 mr-2" />
                            终止计划
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>

                    {payment.type === "recurring" && payment.nextPayment && (
                      <div className="mt-2 pt-2 border-t flex justify-between text-xs text-muted-foreground">
                        <span>周期: {payment.frequency}</span>
                        <span>下期划款: {format(new Date(payment.nextPayment), "yyyy-MM-dd")}</span>
                      </div>
                    )}

                    {payment.type === "stream" && (
                      <div className="mt-2 pt-2 border-t space-y-1">
                        <div className="flex justify-between text-xs text-muted-foreground">
                          <span>流式释放进度</span>
                          <span>{payment.progress || 0}%</span>
                        </div>
                        <Progress value={payment.progress || 0} className="h-1.5" />
                      </div>
                    )}
                  </CardContent>
                </Card>
              </motion.div>
            ))}
          </motion.div>
        )}
      </div>

      <AlertDialog open={!!cancelPaymentId} onOpenChange={() => setCancelPaymentId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认终止该划款计划？</AlertDialogTitle>
            <AlertDialogDescription>
              终止后将停止后续所有自动化周期划转或流支付释放。此操作不可逆。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => cancelPaymentId && cancelPayment(cancelPaymentId)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              确认终止
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
