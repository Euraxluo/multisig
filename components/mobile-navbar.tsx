"use client"

import type React from "react"

import { useState, useEffect } from "react"
import { Wallet, Plus, Bell, Home, FileText, User, Save, Users, Send } from "lucide-react"
import { Button } from "@/components/ui/button"
import { CreateGroupDialog } from "@/components/create-group-dialog"
import { CreateTransactionDialog } from "@/components/create-transaction-dialog"
import { ConnectWalletDialog } from "@/components/connect-wallet-dialog"
import { NotificationsDialog } from "@/components/notifications-dialog"
import { TemplateManagerDialog } from "@/components/template-manager-dialog"
import { motion } from "framer-motion"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"

interface MobileNavbarProps {
  activeTab: string
  setActiveTab: (tab: string) => void
}

export function MobileNavbar({ activeTab, setActiveTab }: MobileNavbarProps) {
  const [isWalletOpen, setIsWalletOpen] = useState(false)
  const [isCreateOpen, setIsCreateOpen] = useState(false)
  const [isCreateTxOpen, setIsCreateTxOpen] = useState(false)
  const [isNotificationsOpen, setIsNotificationsOpen] = useState(false)
  const [isTemplateManagerOpen, setIsTemplateManagerOpen] = useState(false)
  const [scrolled, setScrolled] = useState(false)

  useEffect(() => {
    const handleScroll = () => {
      setScrolled(window.scrollY > 10)
    }
    window.addEventListener("scroll", handleScroll)
    return () => window.removeEventListener("scroll", handleScroll)
  }, [])

  return (
    <>
      <div
        className={`fixed top-0 left-0 right-0 z-50 flex h-14 items-center justify-between px-4 transition-all duration-300 ${
          scrolled ? "bg-background/90 backdrop-blur-md shadow-sm" : "bg-background"
        }`}
      >
        <div className="flex items-center">
          <motion.h1
            className="text-lg font-bold bg-gradient-to-r from-primary to-purple-500 bg-clip-text text-transparent"
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.5 }}
          >
            MultiSig Wallet
          </motion.h1>
        </div>
        <div className="flex items-center space-x-1">
          <Button variant="ghost" size="icon" onClick={() => setIsNotificationsOpen(true)} className="relative">
            <Bell className="h-5 w-5" />
            <span className="absolute top-1 right-1 h-2 w-2 rounded-full bg-red-500"></span>
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <motion.div whileHover={{ scale: 1.1 }} whileTap={{ scale: 0.95 }}>
                <Button
                  variant="default"
                  size="icon"
                  className="bg-gradient-to-r from-primary to-purple-500 hover:from-primary/90 hover:to-purple-500/90 transition-all"
                >
                  <Plus className="h-5 w-5" />
                </Button>
              </motion.div>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setIsCreateOpen(true)}>
                <Users className="h-4 w-4 mr-2" />
                New Group
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setIsCreateTxOpen(true)}>
                <Send className="h-4 w-4 mr-2" />
                New Transaction
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setIsTemplateManagerOpen(true)}>
                <Save className="h-4 w-4 mr-2" />
                Manage Templates
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button variant="ghost" size="icon" onClick={() => setIsWalletOpen(true)}>
            <Wallet className="h-5 w-5" />
          </Button>
        </div>
      </div>

      <div className="fixed bottom-0 left-0 right-0 z-50 bg-background/90 backdrop-blur-md border-t border-border/40 flex justify-around p-1">
        <NavButton
          icon={<Home className="h-5 w-5" />}
          label="Groups"
          isActive={activeTab === "dashboard"}
          onClick={() => setActiveTab("dashboard")}
        />
        <NavButton
          icon={<FileText className="h-5 w-5" />}
          label="Transactions"
          isActive={activeTab === "transactions"}
          onClick={() => setActiveTab("transactions")}
        />
        <NavButton
          icon={<User className="h-5 w-5" />}
          label="Profile"
          isActive={activeTab === "profile"}
          onClick={() => setActiveTab("profile")}
        />
      </div>

      <ConnectWalletDialog open={isWalletOpen} onOpenChange={setIsWalletOpen} />
      <CreateGroupDialog open={isCreateOpen} onOpenChange={setIsCreateOpen} />
      <CreateTransactionDialog open={isCreateTxOpen} onOpenChange={setIsCreateTxOpen} />
      <NotificationsDialog open={isNotificationsOpen} onOpenChange={setIsNotificationsOpen} />
      <TemplateManagerDialog open={isTemplateManagerOpen} onOpenChange={setIsTemplateManagerOpen} />
    </>
  )
}

interface NavButtonProps {
  icon: React.ReactNode
  label: string
  isActive: boolean
  onClick: () => void
}

function NavButton({ icon, label, isActive, onClick }: NavButtonProps) {
  return (
    <motion.button
      className={`flex flex-col items-center justify-center py-2 px-5 rounded-xl relative ${
        isActive ? "text-primary" : "text-muted-foreground"
      }`}
      onClick={onClick}
      whileTap={{ scale: 0.95 }}
    >
      {icon}
      <span className="text-xs mt-1">{label}</span>
      {isActive && (
        <motion.div
          layoutId="activeTab"
          className="absolute inset-0 bg-primary/10 rounded-xl -z-10"
          transition={{ type: "spring", duration: 0.5 }}
        />
      )}
    </motion.button>
  )
}
