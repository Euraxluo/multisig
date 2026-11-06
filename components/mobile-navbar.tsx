"use client"

import type React from "react"

import { useState, useEffect } from "react"
import { Wallet, Plus, Bell, CreditCard, FileText, User, Save, Users, Send, Vote, Bot, Languages } from "lucide-react"
import { useI18n } from "@/components/i18n-provider"
import { Button } from "@/components/ui/button"
import { CreateGroupDialog } from "@/components/create-group-dialog"
import { GroupProposalEntryDialog } from "@/components/group-proposal-entry-dialog"
import { PaymentDialog } from "@/components/payment-dialog"
import { ConnectWalletDialog, UserAccount } from "@/components/connect-wallet-dialog"
import { NotificationsDialog } from "@/components/notifications-dialog"
import { TemplateManagerDialog } from "@/components/template-manager-dialog"
import { CreateVoteDialog } from "@/components/create-vote-dialog"
import { motion } from "framer-motion"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { normalizeSuiAddress } from "@mysten/sui/utils"
import { getProposals } from "@/lib/onchain-store"
import { buildProposalNotifications, readNotificationKeys, unreadCount } from "@/lib/notifications"
import { useReducedMotion } from "@/hooks/use-reduced-motion"

interface MobileNavbarProps {
  activeTab: string
  setActiveTab: (tab: string) => void
}

export function MobileNavbar({ activeTab, setActiveTab }: MobileNavbarProps) {
  const { t, locale, setLocale } = useI18n()
  const reduceMotion = useReducedMotion()
  const [isWalletOpen, setIsWalletOpen] = useState(false)
  const [currentUser, setCurrentUser] = useState<UserAccount | null>(null)
  const [isCreateOpen, setIsCreateOpen] = useState(false)
  const [isCreateTxOpen, setIsCreateTxOpen] = useState(false)
  const [isPaymentOpen, setIsPaymentOpen] = useState(false)
  const [isNotificationsOpen, setIsNotificationsOpen] = useState(false)
  const [isTemplateManagerOpen, setIsTemplateManagerOpen] = useState(false)
  const [isCreateVoteOpen, setIsCreateVoteOpen] = useState(false)
  const [scrolled, setScrolled] = useState(false)
  const [unread, setUnread] = useState(0)

  // The badge reflects the same locally synchronized proposals the notification
  // dialog lists. Nothing is pushed; this only refreshes on app events.
  useEffect(() => {
    const loadUnread = () => {
      const sender = currentUser?.address ? normalizeSuiAddress(currentUser.address) : ""
      if (!sender) { setUnread(0); return }
      const notifications = buildProposalNotifications(getProposals(), sender)
      setUnread(unreadCount(notifications, readNotificationKeys(sender)))
    }
    loadUnread()
    const events = ["sui-proposals-updated", "sui-account-switched", "sui-notifications-updated", "storage"]
    events.forEach(name => window.addEventListener(name, loadUnread))
    return () => events.forEach(name => window.removeEventListener(name, loadUnread))
  }, [currentUser?.address, isNotificationsOpen])

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
        } else {
          setCurrentUser(null)
        }
      } catch (e) { setCurrentUser(null)
        console.warn("Failed to load saved session", e) }
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
        className={`fixed top-0 left-0 right-0 z-40 flex h-14 items-center justify-between px-4 transition-all duration-200 md:max-w-2xl md:left-1/2 md:-translate-x-1/2 md:top-2 md:rounded-2xl md:border md:border-border/50 ${
          scrolled ? "bg-background/95 backdrop-blur-md shadow-sm" : "bg-background/90 backdrop-blur-sm"
        }`}
      >
        <div className="flex items-center space-x-2">
          <motion.h1
            className="text-base font-bold text-primary"
            initial={reduceMotion ? false : { opacity: 0, x: -10 }}
            animate={reduceMotion ? undefined : { opacity: 1, x: 0 }}
          >
            MultiSig
          </motion.h1>
        </div>
        <div className="flex items-center space-x-1.5">
          <Button variant="ghost" size="icon" aria-label={unread > 0 ? t("shell.notificationsWithUnread", { count: unread }) : t("shell.notifications")} onClick={() => setIsNotificationsOpen(true)} className="h-8 w-8 relative text-muted-foreground hover:text-foreground">
            <Bell className="h-4 w-4" />
            {unread > 0 && (
              <span aria-hidden="true" className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold leading-none text-primary-foreground">
                {unread > 9 ? "9+" : unread}
              </span>
            )}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="default"
                size="icon"
                aria-label={t("shell.menuCreate")}
                className="h-8 w-8 rounded-full bg-gradient-to-r from-primary to-purple-500 hover:opacity-90 shadow-sm"
              >
                <Plus className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem onClick={() => setActiveTab("agent")}>
                <Bot className="h-4 w-4 mr-2 text-primary" />
                {t("shell.menuAgents")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setIsCreateOpen(true)}>
                <Users className="h-4 w-4 mr-2" />
                {t("shell.menuNewGroup")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setIsPaymentOpen(true)}>
                <Send className="h-4 w-4 mr-2" />
                {t("shell.menuPersonalTransfer")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setIsCreateTxOpen(true)}>
                <FileText className="h-4 w-4 mr-2" />
                {t("shell.menuGroupProposal")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setIsCreateVoteOpen(true)}>
                <Vote className="h-4 w-4 mr-2" />
                {t("shell.menuNewVote")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setIsTemplateManagerOpen(true)}>
                <Save className="h-4 w-4 mr-2" />
                {t("shell.menuTemplates")}
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
                <span className="max-w-[70px] truncate">{currentUser.provider || t("shell.connected")}</span>
                <span className="font-mono text-muted-foreground text-[11px]">
                  {currentUser.address.slice(0, 4)}...{currentUser.address.slice(-3)}
                </span>
              </span>
            ) : (
              <span className="flex items-center gap-1 text-xs font-medium text-foreground">
                <Wallet className="h-3.5 w-3.5 text-primary" />
                {t("shell.login")}
              </span>
            )}
          </Button>

          <Button
            variant="outline"
            size="sm"
            aria-label={t("shell.switchLanguage")}
            onClick={() => setLocale(locale === "zh" ? "en" : "zh")}
            className="h-8 px-2 text-xs font-semibold border-border/80 bg-muted/30 hover:bg-muted/60 rounded-full"
          >
            <Languages className="h-3.5 w-3.5 text-primary" />
            {locale === "zh" ? "EN" : "中"}
          </Button>
        </div>
      </div>

      {/* Bottom Nav: Mobile fixed bottom, Desktop floating dock */}
      <nav
        aria-label={t("shell.primaryNav")}
        className="fixed bottom-0 left-0 right-0 z-40 bg-background/95 backdrop-blur-md border-t border-border/40 flex justify-around py-1 px-2 pb-[max(0.25rem,env(safe-area-inset-bottom,0px))] md:max-w-lg md:left-1/2 md:-translate-x-1/2 md:bottom-3 md:rounded-2xl md:border md:shadow-lg"
      >
        <NavButton
          icon={<FileText className="h-5 w-5" />}
          label={t("shell.tabPending")}
          isActive={activeTab === "pending"}
          onClick={() => setActiveTab("pending")}
        />
        <NavButton
          icon={<CreditCard className="h-5 w-5" />}
          label={t("shell.tabPayments")}
          isActive={activeTab === "payments"}
          onClick={() => setActiveTab("payments")}
        />
        <NavButton
          icon={<Users className="h-5 w-5" />}
          label={t("shell.tabGroups")}
          isActive={activeTab === "dashboard"}
          onClick={() => setActiveTab("dashboard")}
        />
        <NavButton
          icon={<Bot className="h-5 w-5" />}
          label={t("shell.tabAgent")}
          isActive={activeTab === "agent"}
          onClick={() => setActiveTab("agent")}
        />
        <NavButton
          icon={<User className="h-5 w-5" />}
          label={t("shell.tabProfile")}
          isActive={activeTab === "profile"}
          onClick={() => setActiveTab("profile")}
        />
      </nav>

      <ConnectWalletDialog
        open={isWalletOpen}
        onOpenChange={setIsWalletOpen}
        currentAccount={currentUser}
        onLoginSuccess={(acc) => {
          setCurrentUser(acc)
          try {
            localStorage.setItem("sui_active_account", JSON.stringify(acc))
          } catch {}
        }}
        onLogout={() => {
          setCurrentUser(null)
          try {
            localStorage.removeItem("sui_active_account")
          } catch {}
        }}
      />
      <CreateGroupDialog open={isCreateOpen} onOpenChange={setIsCreateOpen} />
      <GroupProposalEntryDialog open={isCreateTxOpen} onOpenChange={setIsCreateTxOpen} />
      <PaymentDialog open={isPaymentOpen} onOpenChange={setIsPaymentOpen} title={t("shell.menuPersonalTransfer")} />
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
  const reduceMotion = useReducedMotion()
  return (
    <motion.button
      type="button"
      aria-current={isActive ? "page" : undefined}
      className={`flex min-h-11 flex-1 flex-col items-center justify-center py-2 px-1 rounded-xl relative ${
        isActive ? "text-primary" : "text-muted-foreground"
      }`}
      onClick={onClick}
      whileTap={reduceMotion ? undefined : { scale: 0.95 }}
    >
      {icon}
      <span className="text-xs mt-1">{label}</span>
      {isActive && (
        <motion.div
          layoutId={reduceMotion ? undefined : "activeTab"}
          className="absolute inset-0 bg-primary/10 rounded-xl -z-10"
          transition={{ type: "spring", duration: 0.5 }}
        />
      )}
      {/* Non-color active cue: a filled dot under the label, per WCAG 1.4.1. */}
      <span
        aria-hidden="true"
        className={`absolute bottom-0.5 h-1 w-1 rounded-full transition-opacity ${
          isActive ? "bg-primary opacity-100" : "opacity-0"
        }`}
      />
    </motion.button>
  )
}
