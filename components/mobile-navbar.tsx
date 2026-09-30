"use client"

import type React from "react"

import { useState, useEffect } from "react"
import { Wallet, Plus, Bell, Home, FileText, User, Save, Users, Send, Vote, Bot } from "lucide-react"
import { Button } from "@/components/ui/button"
import { CreateGroupDialog } from "@/components/create-group-dialog"
import { CreateTransactionDialog } from "@/components/create-transaction-dialog"
import { ConnectWalletDialog, UserAccount } from "@/components/connect-wallet-dialog"
import { NotificationsDialog } from "@/components/notifications-dialog"
import { TemplateManagerDialog } from "@/components/template-manager-dialog"
import { CreateVoteDialog } from "@/components/create-vote-dialog"
import { motion } from "framer-motion"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"

interface MobileNavbarProps {
  activeTab: string
  setActiveTab: (tab: string) => void
}

export function MobileNavbar({ activeTab, setActiveTab }: MobileNavbarProps) {
  const [isWalletOpen, setIsWalletOpen] = useState(false)
  const [currentUser, setCurrentUser] = useState<UserAccount | null>(null)
  const [isCreateOpen, setIsCreateOpen] = useState(false)
  const [isCreateTxOpen, setIsCreateTxOpen] = useState(false)
  const [isNotificationsOpen, setIsNotificationsOpen] = useState(false)
  const [isTemplateManagerOpen, setIsTemplateManagerOpen] = useState(false)
  const [isCreateVoteOpen, setIsCreateVoteOpen] = useState(false)
  const [scrolled, setScrolled] = useState(false)

  useEffect(() => {
    try {
      const saved = localStorage.getItem("sui_active_account")
      if (saved) {
        const parsed = JSON.parse(saved)
        if (parsed?.address && typeof parsed.address === "string" && parsed.address.startsWith("0x") && parsed.address.length >= 42) {
          setCurrentUser(parsed)
        } else {
          localStorage.removeItem("sui_active_account")
          setCurrentUser(null)
        }
      }
    } catch (e) {
      console.warn("Failed to load saved session", e)
    }
  }, [])

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
              <DropdownMenuItem onClick={() => { setActiveTab("agent") }}>
                <Bot className="h-4 w-4 mr-2 text-primary" />
                AI 副卡管理
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setIsCreateOpen(true)}>
                <Users className="h-4 w-4 mr-2" />
                新建组
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setIsCreateTxOpen(true)}>
                <Send className="h-4 w-4 mr-2" />
                新建交易
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setIsCreateVoteOpen(true)}>
                <Vote className="h-4 w-4 mr-2" />
                新建投票
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setIsTemplateManagerOpen(true)}>
                <Save className="h-4 w-4 mr-2" />
                管理模板
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            id="btn-nav-wallet"
            variant="outline"
            size="sm"
            onClick={() => setIsWalletOpen(true)}
            className="h-8 px-2.5 text-xs gap-1.5 border-primary/30 bg-primary/5 hover:bg-primary/10 transition-all"
            title="Sui zkLogin / Passkey / 钱包连接"
          >
            {currentUser?.type === "zklogin" ? (
              <span className="flex items-center gap-1 text-[11px] font-medium text-blue-600 dark:text-blue-400">
                <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse"></span>
                zkLogin
              </span>
            ) : currentUser?.type === "passkey" ? (
               <span className="flex items-center gap-1 text-[11px] font-medium text-purple-600 dark:text-purple-400">
                <span className="w-1.5 h-1.5 rounded-full bg-purple-500 animate-pulse"></span>
                Passkey
              </span>
            ) : currentUser?.type === "wallet" ? (
              <span className="flex items-center gap-1 text-[11px] font-medium text-amber-600 dark:text-amber-400">
                <Wallet className="w-3.5 h-3.5" />
                {currentUser.provider}
              </span>
            ) : (
              <span className="flex items-center gap-1.5 text-xs font-semibold text-primary">
                <Wallet className="h-3.5 w-3.5" />
                登录 / 连接钱包
              </span>
            )}
            <span className="font-mono text-[10px] text-muted-foreground hidden sm:inline">
              {currentUser ? `${currentUser.address.slice(0, 4)}...${currentUser.address.slice(-3)}` : ""}
            </span>
          </Button>
        </div>
      </div>

      <div className="fixed bottom-0 left-0 right-0 z-50 bg-background/90 backdrop-blur-md border-t border-border/40 flex justify-around p-1">
        <NavButton
          icon={<Home className="h-5 w-5" />}
          label="组"
          isActive={activeTab === "dashboard"}
          onClick={() => setActiveTab("dashboard")}
        />
        <NavButton
          icon={<Bot className="h-5 w-5" />}
          label="AI副卡"
          isActive={activeTab === "agent"}
          onClick={() => setActiveTab("agent")}
        />
        <NavButton
          icon={<FileText className="h-5 w-5" />}
          label="交易"
          isActive={activeTab === "transactions"}
          onClick={() => setActiveTab("transactions")}
        />
        <NavButton
          icon={<Vote className="h-5 w-5" />}
          label="投票"
          isActive={activeTab === "votes"}
          onClick={() => setActiveTab("votes")}
        />
        <NavButton
          icon={<User className="h-5 w-5" />}
          label="我的"
          isActive={activeTab === "profile"}
          onClick={() => setActiveTab("profile")}
        />
      </div>

      <ConnectWalletDialog
        open={isWalletOpen}
        onOpenChange={setIsWalletOpen}
        currentAccount={currentUser}
        onLoginSuccess={(acc) => {
          setCurrentUser(acc)
          try {
            localStorage.setItem("sui_active_account", JSON.stringify(acc))
          } catch (e) {}
        }}
        onLogout={() => {
          setCurrentUser(null)
          try {
            localStorage.removeItem("sui_active_account")
          } catch (e) {}
        }}
      />
      <CreateGroupDialog open={isCreateOpen} onOpenChange={setIsCreateOpen} />
      <CreateTransactionDialog open={isCreateTxOpen} onOpenChange={setIsCreateTxOpen} />
      <NotificationsDialog open={isNotificationsOpen} onOpenChange={setIsNotificationsOpen} />
      <TemplateManagerDialog open={isTemplateManagerOpen} onOpenChange={setIsTemplateManagerOpen} />
      <CreateVoteDialog open={isCreateVoteOpen} onOpenChange={setIsCreateVoteOpen} />
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
