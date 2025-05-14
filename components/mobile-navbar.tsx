"use client"

import { useState } from "react"
import { usePathname } from "next/navigation"
import { motion } from "framer-motion"
import { Button } from "@/components/ui/button"
import { CreateBillDialog } from "@/components/create-bill-dialog"
import { CreateGroupDialog } from "@/components/create-group-dialog"
import { CreateTransactionDialog } from "@/components/create-transaction-dialog"
import { CreateVoteDialog } from "@/components/create-vote-dialog"
import { PaymentFeaturesDialog } from "@/components/payment-features-dialog"
import { TemplateManagerDialog } from "@/components/template-manager-dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Home, CreditCard, Clock, User, Plus, FileText, Vote, Wallet, Users, Zap } from "lucide-react"

export function MobileNavbar() {
  const pathname = usePathname()
  const [isCreateBillOpen, setIsCreateBillOpen] = useState(false)
  const [isCreateGroupOpen, setIsCreateGroupOpen] = useState(false)
  const [isCreateTransactionOpen, setIsCreateTransactionOpen] = useState(false)
  const [isCreateVoteOpen, setIsCreateVoteOpen] = useState(false)
  const [isPaymentFeaturesOpen, setIsPaymentFeaturesOpen] = useState(false)
  const [isTemplateManagerOpen, setIsTemplateManagerOpen] = useState(false)

  const tabs = [
    { name: "home", icon: Home, label: "Home" },
    { name: "requests", icon: CreditCard, label: "Requests" },
    { name: "transactions", icon: Clock, label: "Transactions" },
    { name: "votes", icon: Vote, label: "Votes" },
    { name: "payments", icon: Wallet, label: "Payments" },
    { name: "profile", icon: User, label: "Profile" },
  ]

  const getActiveTab = () => {
    if (pathname === "/") return "home"
    return pathname.slice(1)
  }

  const activeTab = getActiveTab()

  return (
    <>
      <div className="fixed bottom-0 left-0 right-0 border-t bg-background z-50">
        <div className="flex items-center justify-around p-2">
          {tabs.map((tab) => (
            <a
              key={tab.name}
              href={tab.name === "home" ? "/" : `/${tab.name}`}
              className={`flex flex-col items-center justify-center py-1 px-3 rounded-lg ${
                activeTab === tab.name ? "text-primary" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <tab.icon className="h-5 w-5" />
              <span className="text-[10px] mt-1">{tab.label}</span>
              {activeTab === tab.name && (
                <motion.div
                  layoutId="activeTab"
                  className="absolute bottom-1 w-1 h-1 rounded-full bg-primary"
                  transition={{ type: "spring", duration: 0.5 }}
                />
              )}
            </a>
          ))}
        </div>
      </div>

      <div className="fixed right-4 bottom-20 z-50">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="icon"
              className="h-12 w-12 rounded-full shadow-lg bg-gradient-to-r from-primary to-purple-500 hover:from-primary/90 hover:to-purple-500/90"
            >
              <Plus className="h-5 w-5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="end" className="mb-2 min-w-[180px]">
            <DropdownMenuItem onClick={() => setIsCreateBillOpen(true)}>
              <FileText className="h-4 w-4 mr-2" />
              <span>Create Bill</span>
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setIsCreateGroupOpen(true)}>
              <Users className="h-4 w-4 mr-2" />
              <span>Create Group</span>
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setIsCreateTransactionOpen(true)}>
              <Clock className="h-4 w-4 mr-2" />
              <span>Create Transaction</span>
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setIsCreateVoteOpen(true)}>
              <Vote className="h-4 w-4 mr-2" />
              <span>Create Vote</span>
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setIsPaymentFeaturesOpen(true)}>
              <Wallet className="h-4 w-4 mr-2" />
              <span>Create Payment</span>
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setIsTemplateManagerOpen(true)}>
              <Zap className="h-4 w-4 mr-2" />
              <span>Templates</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <CreateBillDialog open={isCreateBillOpen} onOpenChange={setIsCreateBillOpen} />
      <CreateGroupDialog open={isCreateGroupOpen} onOpenChange={setIsCreateGroupOpen} />
      <CreateTransactionDialog open={isCreateTransactionOpen} onOpenChange={setIsCreateTransactionOpen} />
      <CreateVoteDialog open={isCreateVoteOpen} onOpenChange={setIsCreateVoteOpen} />
      <PaymentFeaturesDialog open={isPaymentFeaturesOpen} onOpenChange={setIsPaymentFeaturesOpen} />
      <TemplateManagerDialog open={isTemplateManagerOpen} onOpenChange={setIsTemplateManagerOpen} />
    </>
  )
}
