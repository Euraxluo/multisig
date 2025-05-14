"use client"

import { useState } from "react"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { AnimatePresence, motion } from "framer-motion"
import { Home, CreditCard, Clock, User, Vote, Wallet } from "lucide-react"
import { MobileNavbar } from "@/components/mobile-navbar"
import { useMobile } from "@/hooks/use-mobile"
import Dashboard from "@/components/dashboard"
import Requests from "@/components/requests"
import Transactions from "@/components/transactions"
import Profile from "@/components/profile"
import Votes from "@/components/votes"
import PaymentHub from "@/components/payment-hub"

export default function Page() {
  const isMobile = useMobile()
  const [activeTab, setActiveTab] = useState("home")

  const tabs = [
    { id: "home", label: "Home", icon: Home },
    { id: "requests", label: "Requests", icon: CreditCard },
    { id: "transactions", label: "Transactions", icon: Clock },
    { id: "votes", label: "Votes", icon: Vote },
    { id: "payments", label: "Payments", icon: Wallet },
    { id: "profile", label: "Profile", icon: User },
  ]

  return (
    <div className="container max-w-md mx-auto p-4 pb-20">
      {!isMobile && (
        <Tabs defaultValue="home" value={activeTab} onValueChange={setActiveTab} className="w-full mb-6">
          <TabsList className="grid w-full grid-cols-6">
            {tabs.map((tab) => (
              <TabsTrigger key={tab.id} value={tab.id} className="flex items-center gap-1.5">
                <tab.icon className="h-4 w-4" />
                <span>{tab.label}</span>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      )}

      <AnimatePresence mode="wait">
        <motion.div
          key={activeTab}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -10 }}
          transition={{ duration: 0.2 }}
        >
          {activeTab === "home" && <Dashboard />}
          {activeTab === "requests" && <Requests />}
          {activeTab === "transactions" && <Transactions />}
          {activeTab === "votes" && <Votes />}
          {activeTab === "payments" && <PaymentHub />}
          {activeTab === "profile" && <Profile />}
        </motion.div>
      </AnimatePresence>

      {isMobile && <MobileNavbar />}
    </div>
  )
}
