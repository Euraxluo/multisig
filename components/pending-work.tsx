"use client"

import { useEffect, useState } from "react"
import { Wallet, X } from "lucide-react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import Transactions from "@/components/transactions"
import Votes from "@/components/votes"
import { ConnectWalletDialog, type UserAccount } from "@/components/connect-wallet-dialog"
import { useI18n } from "@/components/i18n-provider"
import { Button } from "@/components/ui/button"

/**
 * The wallet session lives in localStorage ("sui_active_account"), written by
 * ConnectWalletDialog. The pending tab is the default landing tab, so it also
 * hosts the unconnected-user prompt instead of leaving them on a bare empty
 * list; the prompt is dismissible and stays dismissed for the session.
 */
function useWalletSession() {
  const [currentUser, setCurrentUser] = useState<UserAccount | null>(null)

  useEffect(() => {
    const load = () => {
      try {
        const saved = localStorage.getItem("sui_active_account")
        const parsed = saved ? JSON.parse(saved) : null
        setCurrentUser(
          parsed?.address && typeof parsed.address === "string" && parsed.address.startsWith("0x") && parsed.address.length >= 42
            ? parsed
            : null,
        )
      } catch {
        setCurrentUser(null)
      }
    }
    load()
    window.addEventListener("sui-account-switched", load)
    window.addEventListener("storage", load)
    return () => {
      window.removeEventListener("sui-account-switched", load)
      window.removeEventListener("storage", load)
    }
  }, [])

  return currentUser
}

export default function PendingWork() {
  const { t } = useI18n()
  const currentUser = useWalletSession()
  const [connectOpen, setConnectOpen] = useState(false)
  const [promptDismissed, setPromptDismissed] = useState(false)

  return <div className="space-y-4">
    <h2 className="text-xl font-bold">{t("dash.pendingTitle")}</h2>

    {!currentUser && !promptDismissed && (
      <section
        aria-labelledby="pending-connect-title"
        className="relative rounded-xl border border-primary/25 bg-primary/5 p-4"
      >
        <button
          type="button"
          aria-label={t("dash.connectPromptDismiss")}
          onClick={() => setPromptDismissed(true)}
          className="absolute right-2 top-2 rounded-md p-1.5 text-muted-foreground hover:bg-muted/60 hover:text-foreground transition-colors"
        >
          <X className="h-4 w-4" />
        </button>
        <div className="flex items-start gap-3">
          <Wallet className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
          <div className="space-y-1">
            <p id="pending-connect-title" className="text-sm font-medium">{t("dash.connectPromptTitle")}</p>
            <p className="text-xs text-muted-foreground">{t("dash.connectPromptBody")}</p>
            <Button size="sm" className="mt-1.5" onClick={() => setConnectOpen(true)}>
              <Wallet className="h-4 w-4 mr-1.5" aria-hidden="true" />
              {t("dash.connectPromptAction")}
            </Button>
          </div>
        </div>
      </section>
    )}

    <Tabs defaultValue="transfers">
      <TabsList className="grid w-full grid-cols-2 rounded-xl bg-muted/50 p-1">
        <TabsTrigger value="transfers" className="rounded-lg">{t("dash.pendingTransfersTab")}</TabsTrigger>
        <TabsTrigger value="governance" className="rounded-lg">{t("dash.pendingVotesTab")}</TabsTrigger>
      </TabsList>
      <TabsContent value="transfers"><Transactions /></TabsContent>
      <TabsContent value="governance"><Votes /></TabsContent>
    </Tabs>

    <ConnectWalletDialog
      open={connectOpen}
      onOpenChange={setConnectOpen}
      currentAccount={currentUser}
    />
  </div>
}
