"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { motion } from "framer-motion"
import {
  Calendar,
  Clock,
  Repeat,
  FileText,
  Send,
  Plus,
  ArrowRight,
  Receipt,
  Users,
  Wallet,
  Zap,
  CheckCircle,
  AlertCircle,
} from "lucide-react"
import { PaymentFeaturesDialog } from "@/components/payment-features-dialog"
import { TemplateManagerDialog } from "@/components/template-manager-dialog"

export default function PaymentHub() {
  const [isPaymentDialogOpen, setIsPaymentDialogOpen] = useState(false)
  const [isTemplateDialogOpen, setIsTemplateDialogOpen] = useState(false)
  const [activeTab, setActiveTab] = useState("active")

  // Mock data for payments
  const activePayments = [
    {
      id: "payment-1",
      title: "Monthly Team Salaries",
      type: "recurring",
      amount: 2500,
      token: "USDC",
      status: "active",
      nextPayment: "2025-04-01T12:00:00Z",
      recipients: 5,
      color: "from-primary to-purple-500",
    },
    {
      id: "payment-2",
      title: "Developer Grant",
      type: "stream",
      amount: 5000,
      token: "USDT",
      status: "active",
      progress: 25,
      endDate: "2025-07-01T12:00:00Z",
      color: "from-blue-500 to-cyan-400",
    },
    {
      id: "payment-3",
      title: "Marketing Services",
      type: "invoice",
      amount: 1200,
      token: "USDC",
      status: "pending",
      dueDate: "2025-04-15T12:00:00Z",
      color: "from-amber-500 to-orange-500",
    },
  ]

  const completedPayments = [
    {
      id: "payment-4",
      title: "Q1 Contractor Payments",
      type: "batch",
      amount: 3500,
      token: "USDC",
      status: "completed",
      completedDate: "2025-03-15T12:00:00Z",
      recipients: 3,
      color: "from-green-500 to-emerald-400",
    },
    {
      id: "payment-5",
      title: "Software License",
      type: "transfer",
      amount: 800,
      token: "APT",
      status: "completed",
      completedDate: "2025-03-10T12:00:00Z",
      color: "from-primary to-purple-500",
    },
  ]

  const container = {
    hidden: { opacity: 0 },
    show: {
      opacity: 1,
      transition: {
        staggerChildren: 0.1,
      },
    },
  }

  const item = {
    hidden: { opacity: 0, y: 20 },
    show: { opacity: 1, y: 0 },
  }

  const getPaymentIcon = (type: string) => {
    switch (type) {
      case "recurring":
        return <Repeat className="h-3 w-3 mr-1" />
      case "stream":
        return <Clock className="h-3 w-3 mr-1" />
      case "batch":
        return <Users className="h-3 w-3 mr-1" />
      case "invoice":
        return <Receipt className="h-3 w-3 mr-1" />
      default:
        return <Send className="h-3 w-3 mr-1" />
    }
  }

  const getPaymentTypeText = (type: string) => {
    switch (type) {
      case "recurring":
        return "Recurring Payment"
      case "stream":
        return "Stream Payment"
      case "batch":
        return "Batch Payment"
      case "invoice":
        return "Invoice"
      default:
        return "Transfer"
    }
  }

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "active":
        return (
          <Badge variant="outline" className="text-xs flex items-center text-green-500 bg-green-50">
            <CheckCircle className="h-3 w-3 mr-1" /> Active
          </Badge>
        )
      case "pending":
        return (
          <Badge variant="outline" className="text-xs flex items-center text-amber-500 bg-amber-50">
            <AlertCircle className="h-3 w-3 mr-1" /> Pending
          </Badge>
        )
      case "completed":
        return (
          <Badge variant="outline" className="text-xs flex items-center">
            <CheckCircle className="h-3 w-3 mr-1" /> Completed
          </Badge>
        )
      default:
        return null
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-xl font-bold">Payment Hub</h2>
        <div className="flex space-x-2">
          <Button variant="outline" size="sm" onClick={() => setIsTemplateDialogOpen(true)}>
            <FileText className="h-4 w-4 mr-1" /> Templates
          </Button>
          <Button
            variant="default"
            size="sm"
            className="bg-gradient-to-r from-primary to-purple-500 hover:from-primary/90 hover:to-purple-500/90"
            onClick={() => setIsPaymentDialogOpen(true)}
          >
            <Plus className="h-4 w-4 mr-1" /> New Payment
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 mb-4">
        <Card className="bg-gradient-to-br from-primary/10 to-purple-500/10 border-none shadow-sm">
          <CardContent className="p-3 flex flex-col items-center justify-center">
            <Wallet className="h-8 w-8 text-primary mb-1" />
            <p className="text-lg font-bold">$9,000</p>
            <p className="text-xs text-muted-foreground">Active Payments</p>
          </CardContent>
        </Card>
        <Card className="bg-gradient-to-br from-amber-500/10 to-orange-500/10 border-none shadow-sm">
          <CardContent className="p-3 flex flex-col items-center justify-center">
            <Calendar className="h-8 w-8 text-amber-500 mb-1" />
            <p className="text-lg font-bold">3</p>
            <p className="text-xs text-muted-foreground">Upcoming Payments</p>
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="active" value={activeTab} onValueChange={setActiveTab} className="w-full">
        <TabsList className="grid w-full grid-cols-2 p-1 bg-muted/50 rounded-xl">
          <TabsTrigger
            value="active"
            className="rounded-lg data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
          >
            <Zap className="h-4 w-4 mr-1.5" />
            Active
          </TabsTrigger>
          <TabsTrigger
            value="completed"
            className="rounded-lg data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
          >
            <CheckCircle className="h-4 w-4 mr-1.5" />
            Completed
          </TabsTrigger>
        </TabsList>

        <TabsContent value="active" className="mt-3 space-y-3">
          <motion.div variants={container} initial="hidden" animate="show">
            {activePayments.map((payment) => (
              <motion.div key={payment.id} variants={item}>
                <Card className="overflow-hidden hover:shadow-md transition-all duration-300 border-none shadow-sm">
                  <div className={`h-1 bg-gradient-to-r ${payment.color}`}></div>
                  <CardHeader className="p-3 pb-0">
                    <div className="flex items-start justify-between">
                      <div>
                        <h3 className="font-medium text-sm">{payment.title}</h3>
                        <p className="text-xs text-muted-foreground">
                          {payment.amount} {payment.token}
                        </p>
                      </div>
                      <div className="flex space-x-2">{getStatusBadge(payment.status)}</div>
                    </div>
                  </CardHeader>
                  <CardContent className="p-3">
                    <div className="flex items-center justify-between mb-1.5">
                      <div className="flex items-center text-xs text-muted-foreground">
                        {getPaymentIcon(payment.type)}
                        {getPaymentTypeText(payment.type)}
                      </div>

                      {payment.type === "recurring" && (
                        <div className="text-xs">Next: {new Date(payment.nextPayment).toLocaleDateString()}</div>
                      )}

                      {payment.type === "stream" && <div className="text-xs">{payment.progress}% Complete</div>}

                      {payment.type === "invoice" && (
                        <div className="text-xs">Due: {new Date(payment.dueDate).toLocaleDateString()}</div>
                      )}
                    </div>

                    {payment.type === "stream" && (
                      <div className="w-full h-1.5 bg-muted rounded-full mt-2 overflow-hidden">
                        <div
                          className={`h-full bg-gradient-to-r ${payment.color}`}
                          style={{ width: `${payment.progress}%` }}
                        />
                      </div>
                    )}

                    <div className="mt-3 flex items-center justify-between">
                      {payment.recipients && (
                        <div className="text-xs text-muted-foreground">{payment.recipients} Recipients</div>
                      )}

                      <Button size="sm" variant="ghost" className="h-7 text-xs text-primary flex items-center gap-1">
                        Details <ArrowRight className="h-3 w-3" />
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              </motion.div>
            ))}
          </motion.div>
        </TabsContent>

        <TabsContent value="completed" className="mt-3 space-y-3">
          <motion.div variants={container} initial="hidden" animate="show">
            {completedPayments.map((payment) => (
              <motion.div key={payment.id} variants={item}>
                <Card className="overflow-hidden hover:shadow-md transition-all duration-300 border-none shadow-sm">
                  <div className={`h-1 bg-gradient-to-r ${payment.color}`}></div>
                  <CardHeader className="p-3 pb-0">
                    <div className="flex items-start justify-between">
                      <div>
                        <h3 className="font-medium text-sm">{payment.title}</h3>
                        <p className="text-xs text-muted-foreground">
                          {payment.amount} {payment.token}
                        </p>
                      </div>
                      <div className="flex space-x-2">{getStatusBadge(payment.status)}</div>
                    </div>
                  </CardHeader>
                  <CardContent className="p-3">
                    <div className="flex items-center justify-between mb-1.5">
                      <div className="flex items-center text-xs text-muted-foreground">
                        {getPaymentIcon(payment.type)}
                        {getPaymentTypeText(payment.type)}
                      </div>

                      <div className="text-xs">Completed: {new Date(payment.completedDate).toLocaleDateString()}</div>
                    </div>

                    <div className="mt-3 flex items-center justify-between">
                      {payment.recipients && (
                        <div className="text-xs text-muted-foreground">{payment.recipients} Recipients</div>
                      )}

                      <Button size="sm" variant="ghost" className="h-7 text-xs text-primary flex items-center gap-1">
                        Details <ArrowRight className="h-3 w-3" />
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              </motion.div>
            ))}
          </motion.div>
        </TabsContent>
      </Tabs>

      <PaymentFeaturesDialog open={isPaymentDialogOpen} onOpenChange={setIsPaymentDialogOpen} />

      <TemplateManagerDialog open={isTemplateDialogOpen} onOpenChange={setIsTemplateDialogOpen} />
    </div>
  )
}
