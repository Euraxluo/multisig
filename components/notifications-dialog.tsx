"use client"

import { useEffect, useState } from "react"
import { normalizeSuiAddress } from "@mysten/sui/utils"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Button } from "@/components/ui/button"
import { TransactionDetailsDialog } from "@/components/transaction-details-dialog"
import { getActiveAccount, getProposals, type ProposalItem } from "@/lib/onchain-store"
import { buildProposalNotifications, markNotificationsRead, readNotificationKeys } from "@/lib/notifications"
import { Bell, Check, ChevronRight, Clock } from "lucide-react"
import { useI18n } from "@/components/i18n-provider"

interface NotificationsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function NotificationsDialog({ open, onOpenChange }: NotificationsDialogProps) {
  const { t } = useI18n()
  const [proposals, setProposals] = useState<ProposalItem[]>([])
  const [address, setAddress] = useState("")
  const [read, setRead] = useState<string[]>([])
  const [selected, setSelected] = useState("")

  useEffect(() => {
    if (!open) return
    const load = () => {
      const account = getActiveAccount()
      const sender = account ? normalizeSuiAddress(account.address) : ""
      setAddress(sender)
      setProposals(getProposals())
      setRead(readNotificationKeys(sender))
    }
    load()
    window.addEventListener("sui-proposals-updated", load)
    window.addEventListener("sui-account-switched", load)
    window.addEventListener("storage", load)
    return () => {
      window.removeEventListener("sui-proposals-updated", load)
      window.removeEventListener("sui-account-switched", load)
      window.removeEventListener("storage", load)
    }
  }, [open])

  const notifications = buildProposalNotifications(proposals, address)

  function markRead(keys: string[]) {
    setRead(markNotificationsRead(address, keys))
  }

  return <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Bell className="h-5 w-5 text-primary" />{t("misc.nd.title")}</DialogTitle>
          <DialogDescription>{t("misc.nd.description")}</DialogDescription>
        </DialogHeader>
        <div className="flex items-center justify-between text-xs text-muted-foreground"><span>{t("misc.nd.unreadCount", { count: notifications.filter(item => !read.includes(item.key)).length })}</span><Button size="sm" variant="ghost" className="h-7 text-xs text-primary" disabled={!notifications.length} onClick={() => markRead(notifications.map(item => item.key))}><Check className="mr-1 h-3 w-3" />{t("misc.nd.markAll")}</Button></div>
        <ScrollArea className="h-[320px] pr-3">
          <div className="space-y-2 py-1">
            {!notifications.length && <div className="flex flex-col items-center gap-2 py-16 text-muted-foreground"><Bell className="h-8 w-8 opacity-40" /><p className="text-sm">{address ? t("misc.nd.emptySynced") : t("misc.nd.emptyNoWallet")}</p></div>}
            {notifications.map(item => <div key={item.key} className={`rounded-xl p-3 ${read.includes(item.key) ? "bg-muted/20" : "bg-primary/5"}`}>
              <button className="flex w-full items-start gap-2 text-left" onClick={() => { markRead([item.key]); setSelected(item.proposal.id) }}>
                {item.needsVote ? <Clock className="mt-0.5 h-4 w-4 shrink-0 text-primary" /> : <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" />}
                <div className="min-w-0 flex-1"><h3 className="text-sm font-medium">{item.title}</h3><p className="mt-1 truncate text-xs text-muted-foreground">{item.proposal.groupName} · {item.proposal.title}</p><p className="mt-1 text-[11px] text-muted-foreground">{t("misc.nd.weights", { approved: item.proposal.approvals, required: item.proposal.requiredApprovals })}</p></div><ChevronRight className="mt-1 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              </button>
              {!read.includes(item.key) && <button className="ml-6 mt-2 flex items-center text-[11px] text-primary" onClick={() => markRead([item.key])}><Check className="mr-1 h-3 w-3" />{t("misc.nd.markRead")}</button>}
            </div>)}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
    {selected && <TransactionDetailsDialog open onOpenChange={value => { if (!value) setSelected("") }} transactionId={selected} />}
  </>
}
