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
    const loadSession = () => {
      try {
        const saved = localStorage.getItem("sui_active_account")
        if (saved) {
          const parsed = JSON.parse(saved)
          if (parsed?.address && typeof parsed.address === "string" && parsed.address.startsWith("0x") && parsed.address.length >= 42) {
            setCurrentUser(parsed)
          } else {
            setCurrentUser(null)
          }
        }
      } catch (e) {
        console.warn("Failed to load saved session", e)
      }
    }

    loadSession()
    window.addEventListener("sui-account-switched", loadSession)
    window.addEventListener("storage", loadSession)
    return () => {
      window.removeEventListener("sui-account-switched", loadSession)
      window.removeEventListener("storage", loadSession)
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
      {/* Top Navbar: Mobile-first full width, Desktop centered card */}
      <div
        className={`fixed top-0 left-0 right-0 z-50 flex h-14 items-center justify-between px-4 transition-all duration-200 md:max-w-2xl md:left-1/2 md:-translate-x-1/2 md:top-2 md:rounded-2xl md:border md:border-border/50 ${
          scrolled ? "bg-background/95 backdrop-blur-md shadow-sm" : "bg-background/90 backdrop-blur-sm"
        }`}
      >
        <div className="flex items-center space-x-2">
          <motion.h1
            className="text-base font-bold bg-gradient-to-r from-primary to-purple-500 bg-clip-text text-transparent"
            initial={{ opacity: 0, x: -10 }}
            animate={{ opacity: 1, x: 0 }}
          >
            MultiSig
          </motion.h1>
        </div>
        <div className="flex items-center space-x-1.5">
          <Button variant="ghost" size="icon" onClick={() => setIsNotificationsOpen(true)} className="h-8 w-8 relative text-muted-foreground hover:text-foreground">
            <Bell className="h-4 w-4" />
            <span className="absolute top-1.5 right-1.5 h-1.5 w-1.5 rounded-full bg-red-500"></span>
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="default"
                size="icon"
                className="h-8 w-8 rounded-full bg-gradient-to-r from-primary to-purple-500 hover:opacity-90 shadow-sm"
              >
                <Plus className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem onClick={() => setActiveTab("agent")}>
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
            className="h-8 px-2.5 text-xs gap-1.5 border-border/80 bg-muted/30 hover:bg-muted/60 transition-all rounded-full"
          >
            {currentUser ? (
              <span className="flex items-center gap-1.5 text-xs font-medium">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
                <span className="max-w-[70px] truncate">{currentUser.provider || "已连接"}</span>
                <span className="font-mono text-muted-foreground text-[11px]">
                  {currentUser.address.slice(0, 4)}...{currentUser.address.slice(-3)}
                </span>
              </span>
            ) : (
              <span className="flex items-center gap-1 text-xs font-medium text-foreground">
                <Wallet className="h-3.5 w-3.5 text-primary" />
                登录
              </span>
            )}
          </Button>
        </div>
      </div>

      {/* Bottom Nav: Mobile fixed bottom, Desktop floating dock */}
      <div className="fixed bottom-0 left-0 right-0 z-50 bg-background/95 backdrop-blur-md border-t border-border/40 flex justify-around py-1 px-2 md:max-w-lg md:left-1/2 md:-translate-x-1/2 md:bottom-3 md:rounded-2xl md:border md:shadow-lg">
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
