"use client"

import { useState } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { CalendarClock, Waves, FileText, Send, Receipt, ArrowUpRight } from "lucide-react"
import { PaymentSchedulerDialog } from "./payment-scheduler-dialog"
import { StreamPaymentDialog } from "./stream-payment-dialog"
import { InvoiceGeneratorDialog } from "./invoice-generator-dialog"
import { PaymentRequestDialog } from "./payment-request-dialog"
import { TemplateManagerDialog } from "./template-manager-dialog"
import { CreateTransactionDialog } from "./create-transaction-dialog"
import { motion } from "framer-motion"

interface QuickActionsProps {
  groupId?: string
}

export function QuickActions({ groupId }: QuickActionsProps) {
  const [isPaymentSchedulerOpen, setIsPaymentSchedulerOpen] = useState(false)
  const [isStreamPaymentOpen, setIsStreamPaymentOpen] = useState(false)
  const [isInvoiceGeneratorOpen, setIsInvoiceGeneratorOpen] = useState(false)
  const [isPaymentRequestOpen, setIsPaymentRequestOpen] = useState(false)
  const [isTemplateManagerOpen, setIsTemplateManagerOpen] = useState(false)
  const [isCreateTransactionOpen, setIsCreateTransactionOpen] = useState(false)

  const quickActions = [
    {
      title: "Send",
      icon: <Send className="h-4 w-4" />,
      color: "from-blue-500 to-cyan-400",
      onClick: () => setIsCreateTransactionOpen(true),
    },
    {
      title: "Request",
      icon: <ArrowUpRight className="h-4 w-4" />,
      color: "from-green-500 to-emerald-400",
      onClick: () => setIsPaymentRequestOpen(true),
    },
    {
      title: "Schedule",
      icon: <CalendarClock className="h-4 w-4" />,
      color: "from-orange-500 to-amber-400",
      onClick: () => setIsPaymentSchedulerOpen(true),
    },
    {
      title: "Stream",
      icon: <Waves className="h-4 w-4" />,
      color: "from-purple-500 to-violet-400",
      onClick: () => setIsStreamPaymentOpen(true),
    },
    {
      title: "Invoice",
      icon: <Receipt className="h-4 w-4" />,
      color: "from-pink-500 to-rose-400",
      onClick: () => setIsInvoiceGeneratorOpen(true),
    },
    {
      title: "Templates",
      icon: <FileText className="h-4 w-4" />,
      color: "from-primary to-purple-500",
      onClick: () => setIsTemplateManagerOpen(true),
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

  return (
    <>
      <div className="mb-4">
        <h3 className="text-lg font-semibold mb-3">Quick Actions</h3>
        <motion.div className="grid grid-cols-3 gap-2" variants={container} initial="hidden" animate="show">
          {quickActions.map((action, index) => (
            <motion.div key={index} variants={item}>
              <Card
                className="cursor-pointer hover:shadow-md transition-all duration-200 border-none"
                onClick={action.onClick}
              >
                <CardContent className="p-3 flex flex-col items-center justify-center">
                  <div
                    className={`h-8 w-8 rounded-full bg-gradient-to-br ${action.color} flex items-center justify-center text-white mb-2`}
                  >
                    {action.icon}
                  </div>
                  <span className="text-xs font-medium">{action.title}</span>
                </CardContent>
              </Card>
            </motion.div>
          ))}
        </motion.div>
      </div>

      <PaymentSchedulerDialog
        open={isPaymentSchedulerOpen}
        onOpenChange={setIsPaymentSchedulerOpen}
        groupId={groupId}
      />

      <StreamPaymentDialog open={isStreamPaymentOpen} onOpenChange={setIsStreamPaymentOpen} groupId={groupId} />

      <InvoiceGeneratorDialog
        open={isInvoiceGeneratorOpen}
        onOpenChange={setIsInvoiceGeneratorOpen}
        groupId={groupId}
      />

      <PaymentRequestDialog open={isPaymentRequestOpen} onOpenChange={setIsPaymentRequestOpen} groupId={groupId} />

      <TemplateManagerDialog open={isTemplateManagerOpen} onOpenChange={setIsTemplateManagerOpen} />

      <CreateTransactionDialog
        open={isCreateTransactionOpen}
        onOpenChange={setIsCreateTransactionOpen}
        groupId={groupId}
      />
    </>
  )
}
