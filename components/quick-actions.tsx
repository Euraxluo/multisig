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
import { PaymentDialog } from "./payment-dialog"
import { motion } from "framer-motion"
import { useI18n } from "@/components/i18n-provider"

interface QuickActionsProps {
  groupId?: string
}

export function QuickActions({ groupId }: QuickActionsProps) {
  const { t } = useI18n()
  const [isPaymentSchedulerOpen, setIsPaymentSchedulerOpen] = useState(false)
  const [isStreamPaymentOpen, setIsStreamPaymentOpen] = useState(false)
  const [isInvoiceGeneratorOpen, setIsInvoiceGeneratorOpen] = useState(false)
  const [isPaymentRequestOpen, setIsPaymentRequestOpen] = useState(false)
  const [isTemplateManagerOpen, setIsTemplateManagerOpen] = useState(false)
  const [isCreateTransactionOpen, setIsCreateTransactionOpen] = useState(false)

  const quickActions = [
    {
      title: groupId ? t("dash.qaNewProposal") : t("dash.qaTransfer"),
      icon: <Send className="h-4 w-4" />,
      color: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
      onClick: () => setIsCreateTransactionOpen(true),
    },
    {
      title: t("dash.qaRequest"),
      icon: <ArrowUpRight className="h-4 w-4" />,
      color: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
      onClick: () => setIsPaymentRequestOpen(true),
    },
    {
      title: t("dash.qaScheduled"),
      icon: <CalendarClock className="h-4 w-4" />,
      color: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
      onClick: () => setIsPaymentSchedulerOpen(true),
    },
    {
      title: t("dash.qaStream"),
      icon: <Waves className="h-4 w-4" />,
      color: "bg-purple-500/10 text-purple-600 dark:text-purple-400",
      onClick: () => setIsStreamPaymentOpen(true),
    },
    {
      title: t("dash.qaInvoice"),
      icon: <Receipt className="h-4 w-4" />,
      color: "bg-rose-500/10 text-rose-600 dark:text-rose-400",
      onClick: () => setIsInvoiceGeneratorOpen(true),
    },
    {
      title: t("dash.qaTemplates"),
      icon: <FileText className="h-4 w-4" />,
      color: "bg-primary/10 text-primary",
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
        <h3 className="text-lg font-semibold mb-3">{groupId ? t("dash.qaGroupTools") : t("dash.qaPaymentTools")}</h3>
        <motion.div className="grid grid-cols-3 gap-2" variants={container} initial="hidden" animate="show">
          {quickActions.map((action, index) => (
            <motion.div key={index} variants={item}>
              <Card
                className="cursor-pointer hover:shadow-sm active:scale-[0.96] transition-all duration-150 rounded-2xl border border-border/60 bg-surface-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                role="button"
                tabIndex={0}
                aria-label={action.title}
                onClick={action.onClick}
                onKeyDown={(event) => {
                  if (event.target === event.currentTarget && ["Enter", " "].includes(event.key)) {
                    event.preventDefault()
                    action.onClick()
                  }
                }}
              >
                <CardContent className="p-3.5 flex flex-col items-center justify-center">
                  <div
                    className={`h-10 w-10 rounded-2xl ${action.color} flex items-center justify-center mb-2 shadow-xs transition-transform`}
                  >
                    {action.icon}
                  </div>
                  <span className="text-xs font-medium text-label-primary text-center">{action.title}</span>
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

      {groupId ? (
        <CreateTransactionDialog
          open={isCreateTransactionOpen}
          onOpenChange={setIsCreateTransactionOpen}
          groupId={groupId}
        />
      ) : (
        <PaymentDialog open={isCreateTransactionOpen} onOpenChange={setIsCreateTransactionOpen} title={t("shell.menuPersonalTransfer")} />
      )}
    </>
  )
}
