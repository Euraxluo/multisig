"use client"

import { useState, useEffect } from "react"
import Dashboard from "@/components/dashboard"
import Transactions from "@/components/transactions"
import Votes from "@/components/votes"
import Profile from "@/components/profile"
import { MobileNavbar } from "@/components/mobile-navbar"
import { motion, AnimatePresence } from "framer-motion"

export default function Home() {
  const [activeTab, setActiveTab] = useState("dashboard")
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  if (!mounted) return null

  return (
    <main className="flex min-h-screen flex-col bg-gradient-to-b from-background to-background/90 overflow-hidden">
      <MobileNavbar activeTab={activeTab} setActiveTab={setActiveTab} />
      <div className="flex-1 p-3 pt-16 md:p-5 md:pt-20">
        <AnimatePresence mode="wait">
          {activeTab === "dashboard" && (
            <motion.div
              key="dashboard"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              transition={{ duration: 0.3 }}
            >
              <Dashboard />
            </motion.div>
          )}
          {activeTab === "transactions" && (
            <motion.div
              key="transactions"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              transition={{ duration: 0.3 }}
            >
              <Transactions />
            </motion.div>
          )}
          {activeTab === "votes" && (
            <motion.div
              key="votes"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              transition={{ duration: 0.3 }}
            >
              <Votes />
            </motion.div>
          )}
          {activeTab === "profile" && (
            <motion.div
              key="profile"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              transition={{ duration: 0.3 }}
            >
              <Profile />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </main>
  )
}
