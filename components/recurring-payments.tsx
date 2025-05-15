"use client"

import { useState } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { CalendarClock, Waves, Clock, Calendar, MoreHorizontal, Pause, Play, X } from "lucide-react"
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

export function RecurringPayments({ groupId }: RecurringPaymentsProps) {
  const [cancelPaymentId, setCancelPaymentId] = useState<string | null>(null)

  // Mock recurring payments data
  const recurringPayments = [
    {
      id: "payment-1",
      type: "recurring",
      name: "Team Salaries",
      recipient: "0x1234...5678",
      amount: "1000",
      token: "USDC",
      frequency: "Monthly",
      nextPayment: addDays(new Date(), 15),
      status: "active",
    },
    {
      id: "payment-2",
      type: "stream",
      name: "Contractor Payment",
      recipient: "0xabcd...efgh",
      amount: "500",
      token: "USDC",
      startDate: addDays(new Date(), -10),
      endDate: addDays(new Date(), 20),
      progress: 33,
      status: "active",
    },
    {
      id: "payment-3",
      type: "recurring",
      name: "Server Costs",
      recipient: "0x9876...5432",
      amount: "50",
      token: "USDT",
      frequency: "Weekly",
      nextPayment: addDays(new Date(), 3),
      status: "paused",
    },
  ]

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

  const togglePaymentStatus = (paymentId: string, currentStatus: string) => {
    // In a real app, you would update the payment status here
    console.log(
      `Toggling payment ${paymentId} from ${currentStatus} to ${currentStatus === "active" ? "paused" : "active"}`,
    )
  }

  const cancelPayment = (paymentId: string) => {
    // In a real app, you would cancel the payment here
    console.log(`Cancelling payment ${paymentId}`)
    setCancelPaymentId(null)
  }

  return (
    <>
      <div className="mb-4">
        <h3 className="text-lg font-semibold mb-3">Active Payments</h3>

        {recurringPayments.length === 0 ? (
          <Card className="border-dashed">
            <CardContent className="p-6 flex flex-col items-center justify-center">
              <p className="text-muted-foreground text-sm">No active recurring or stream payments</p>
            </CardContent>
          </Card>
        ) : (
          <motion.div className="grid gap-2" variants={container} initial="hidden" animate="show">
            {recurringPayments.map((payment) => (
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
                              className={`ml-2 text-xs ${payment.status === "active" ? "bg-green-500/20 text-green-700 hover:bg-green-500/20" : "text-muted-foreground"}`}
                            >
                              {payment.status === "active" ? "Active" : "Paused"}
                            </Badge>
                          </div>
                          <p className="text-xs text-muted-foreground">
                            {payment.amount} {payment.token} to {payment.recipient}
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
                          <DropdownMenuLabel>Actions</DropdownMenuLabel>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onClick={() => togglePaymentStatus(payment.id, payment.status)}>
                            {payment.status === "active" ? (
                              <>
                                <Pause className="h-4 w-4 mr-2" />
                                Pause Payment
                              </>
                            ) : (
                              <>
                                <Play className="h-4 w-4 mr-2" />
                                Resume Payment
                              </>
                            )}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => setCancelPaymentId(payment.id)}
                            className="text-destructive focus:text-destructive"
                          >
                            <X className="h-4 w-4 mr-2" />
                            Cancel Payment
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>

                    {payment.type === "recurring" ? (
                      <div className="mt-2 flex items-center text-xs text-muted-foreground">
                        <Clock className="h-3 w-3 mr-1" />
                        Next payment: {format(payment.nextPayment, "MMM d, yyyy")}
                        <span className="mx-1">•</span>
                        <Calendar className="h-3 w-3 mr-1" />
                        {payment.frequency}
                      </div>
                    ) : (
                      <div className="mt-2 space-y-1">
                        <div className="flex items-center justify-between text-xs text-muted-foreground">
                          <span>Progress: {payment.progress}%</span>
                          <span>
                            {format(payment.startDate, "MMM d")} - {format(payment.endDate, "MMM d, yyyy")}
                          </span>
                        </div>
                        <Progress value={payment.progress} className="h-1.5" />
                      </div>
                    )}
                  </CardContent>
                </Card>
              </motion.div>
            ))}
          </motion.div>
        )}
      </div>

      <AlertDialog open={!!cancelPaymentId} onOpenChange={(open) => !open && setCancelPaymentId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel Payment</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to cancel this payment? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => cancelPaymentId && cancelPayment(cancelPaymentId)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Yes, Cancel Payment
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
