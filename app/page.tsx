"use client"

import { useState, useEffect } from "react"
import Dashboard from "@/components/dashboard"
import Payments from "@/components/payments"
import PendingWork from "@/components/pending-work"
import Profile from "@/components/profile"
import AgentGuard from "@/components/agent-guard"
import { MobileNavbar } from "@/components/mobile-navbar"
import { FirstRunDialog } from "@/components/first-run-dialog"
import { motion, AnimatePresence } from "framer-motion"
import { startOnlineIndexer, stopOnlineIndexer } from "@/lib/online-indexer"
import { useReducedMotion } from "@/hooks/use-reduced-motion"
import { IdentityPanel } from "@/components/identity-panel"
import { GroupDetailsDialog } from "@/components/group-details-dialog"
import { VoteDetailsDialog } from "@/components/vote-details-dialog"
import { TreasuryDepositDialog } from "@/components/group-treasury"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { ErrorBoundary } from "@/components/error-boundary"
import { clearLegacyDevKeys } from "@/lib/dev-keystore"
import { useI18n } from "@/components/i18n-provider"

export default function Home() {
  const { t } = useI18n()
  const reduceMotion = useReducedMotion()
  const [activeTab, setActiveTab] = useState("pending")
  const [mounted, setMounted] = useState(false)
  const [sharedPerson, setSharedPerson] = useState("")
  const [sharedGroup, setSharedGroup] = useState("")
  const [sharedVote, setSharedVote] = useState("")
  const [sharedTreasury, setSharedTreasury] = useState<{ id: string; orgId: string } | null>(null)

  useEffect(() => {
    clearLegacyDevKeys()
    setMounted(true)
    const params = new URLSearchParams(window.location.search)
    const person = params.get("person")?.trim()
    const group = params.get("group")?.trim()
    const vote = params.get("vote")?.trim()
    const treasury = params.get("treasury")?.trim()
    const org = params.get("org")?.trim()
    if (treasury && org) setSharedTreasury({ id: treasury, orgId: org })
    else if (person) setSharedPerson(person)
    else if (group) setSharedGroup(group)
    else if (vote) { setSharedVote(vote); setActiveTab("pending") }
    startOnlineIndexer(4000)
    return () => {
      stopOnlineIndexer()
    }
  }, [])

  if (!mounted) return null

  return (
    <main className="flex min-h-screen flex-col bg-background text-foreground">
      <FirstRunDialog />
      <MobileNavbar activeTab={activeTab} setActiveTab={setActiveTab} />
      <div className="flex-1 w-full max-w-lg md:max-w-2xl mx-auto px-3 pt-16 pb-28 md:px-5 md:pt-20 md:pb-32">
        <AnimatePresence mode="wait">
          {activeTab === "dashboard" && (
            <motion.div
              key="dashboard"
              initial={reduceMotion ? false : { opacity: 0, y: 20 }}
              animate={reduceMotion ? undefined : { opacity: 1, y: 0 }}
              exit={reduceMotion ? undefined : { opacity: 0, y: -20 }}
              transition={{ duration: 0.3 }}
            >
              <ErrorBoundary label={t("shell.boundaryDashboard")}><Dashboard /></ErrorBoundary>
            </motion.div>
          )}
          {activeTab === "agent" && (
            <motion.div
              key="agent"
              initial={reduceMotion ? false : { opacity: 0, y: 20 }}
              animate={reduceMotion ? undefined : { opacity: 1, y: 0 }}
              exit={reduceMotion ? undefined : { opacity: 0, y: -20 }}
              transition={{ duration: 0.3 }}
            >
              <ErrorBoundary label={t("shell.boundaryAgent")}><AgentGuard /></ErrorBoundary>
            </motion.div>
          )}
          {activeTab === "payments" && (
            <motion.div
              key="payments"
              initial={reduceMotion ? false : { opacity: 0, y: 20 }}
              animate={reduceMotion ? undefined : { opacity: 1, y: 0 }}
              exit={reduceMotion ? undefined : { opacity: 0, y: -20 }}
              transition={{ duration: 0.3 }}
            >
              <ErrorBoundary label={t("shell.boundaryPayments")}><Payments onShowProfile={() => setActiveTab("profile")} /></ErrorBoundary>
            </motion.div>
          )}
          {activeTab === "pending" && (
            <motion.div
              key="pending"
              initial={reduceMotion ? false : { opacity: 0, y: 20 }}
              animate={reduceMotion ? undefined : { opacity: 1, y: 0 }}
              exit={reduceMotion ? undefined : { opacity: 0, y: -20 }}
              transition={{ duration: 0.3 }}
            >
              <ErrorBoundary label={t("shell.boundaryPending")}><PendingWork /></ErrorBoundary>
            </motion.div>
          )}
          {activeTab === "profile" && (
            <motion.div
              key="profile"
              initial={reduceMotion ? false : { opacity: 0, y: 20 }}
              animate={reduceMotion ? undefined : { opacity: 1, y: 0 }}
              exit={reduceMotion ? undefined : { opacity: 0, y: -20 }}
              transition={{ duration: 0.3 }}
            >
              <ErrorBoundary label={t("shell.boundaryProfile")}><Profile onShowGroups={() => setActiveTab("dashboard")} /></ErrorBoundary>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      <Dialog open={!!sharedPerson} onOpenChange={open => { if (!open) setSharedPerson("") }}>
        <DialogContent className="max-h-[90dvh] w-[calc(100%-2rem)] max-w-lg overflow-y-auto rounded-xl">
          <DialogHeader><DialogTitle>{t("shell.viewIdentityTitle")}</DialogTitle><DialogDescription>{t("shell.viewIdentityDescription")}</DialogDescription></DialogHeader>
          {sharedPerson && <IdentityPanel target={sharedPerson} />}
        </DialogContent>
      </Dialog>
      {sharedTreasury && <TreasuryDepositDialog open orgId={sharedTreasury.orgId} treasuryId={sharedTreasury.id} allowFunding={false} onOpenChange={open => { if (!open) setSharedTreasury(null) }} />}
      {sharedGroup && <GroupDetailsDialog open={!!sharedGroup} readOnly onOpenChange={open => { if (!open) setSharedGroup("") }} groupId={sharedGroup} />}
      {sharedVote && <VoteDetailsDialog open onOpenChange={open => { if (!open) setSharedVote("") }} voteId={sharedVote} />}
    </main>
  )
}
