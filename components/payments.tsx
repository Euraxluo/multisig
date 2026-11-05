"use client"

import { useEffect, useState } from "react"
import { ArrowUpRight, Loader2, Plus, Wallet } from "lucide-react"
import { QuickActions } from "@/components/quick-actions"
import { QuickTemplates } from "@/components/quick-templates"
import { RecurringPayments } from "@/components/recurring-payments"
import { InvoiceDrafts } from "@/components/invoice-drafts"
import { CreateBillDialog } from "@/components/create-bill-dialog"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { getActiveAccount, fetchRealBalances } from "@/lib/onchain-store"
import Requests from "@/components/requests"
import { useI18n } from "@/components/i18n-provider"

export default function Payments({ onShowProfile }: { onShowProfile?: () => void }) {
  const { t } = useI18n()
  const [address, setAddress] = useState("")
  const [balance, setBalance] = useState("")
  const [balanceError, setBalanceError] = useState("")
  const [loading, setLoading] = useState(false)
  const [createBillOpen, setCreateBillOpen] = useState(false)
  useEffect(() => {
    const sync = () => setAddress(getActiveAccount()?.address || "")
    sync()
    window.addEventListener("sui-account-switched", sync); window.addEventListener("storage", sync)
    return () => { window.removeEventListener("sui-account-switched", sync); window.removeEventListener("storage", sync) }
  }, [])
  useEffect(() => {
    let cancelled = false
    setBalance(""); setBalanceError(""); setLoading(!!address)
    if (address) void fetchRealBalances(address).then(value => { if (!cancelled) setBalance(value.sui.balance) })
      .catch(error => { if (!cancelled) setBalanceError(error instanceof Error ? error.message : t("payments.payErrBalanceRead")) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [address])

  return <div className="space-y-4">
    <Card className="overflow-hidden border-none bg-gradient-to-br from-primary/10 via-primary/5 to-purple-500/10 shadow-sm">
      <CardContent className="p-4">
        <div className="flex items-center justify-between gap-3"><h2 className="text-sm font-medium text-muted-foreground">{t("payments.payWalletTitle")}</h2><Wallet className="h-4 w-4 text-primary" /></div>
        <div className="mt-2 flex items-end justify-between gap-3">
          <div className="min-w-0 flex-1">
            <p className="break-all text-2xl font-bold tracking-tight">
              {loading ? <Loader2 className="my-1 h-6 w-6 animate-spin" aria-label={t("payments.payLoadingBalance")} /> : address ? balance || "—" : t("payments.payConnectWallet")}
              {balance && <span className="ml-2 text-sm font-medium text-muted-foreground">SUI</span>}
            </p>
            <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
              {address ? `${address.slice(0, 8)}…${address.slice(-6)}` : t("payments.payConnectHint")}
            </p>
          </div>
          {address ? (
            <Button size="sm" variant="ghost" className="shrink-0 text-primary" onClick={onShowProfile}>
              {t("payments.payViewAssets")}<ArrowUpRight className="ml-1 h-4 w-4" />
            </Button>
          ) : null}
        </div>
        {balanceError && <p role="alert" className="mt-2 text-xs text-destructive">{balanceError}</p>}
      </CardContent>
    </Card>
    <QuickActions />
    <QuickTemplates />
    <RecurringPayments />
    <InvoiceDrafts />
    <section className="space-y-3">
      <div className="flex items-center justify-between"><h3 className="text-lg font-semibold">{t("payments.payBillsTitle")}</h3><Button variant="outline" size="sm" className="rounded-lg" onClick={() => setCreateBillOpen(true)}><Plus className="mr-1 h-3.5 w-3.5" />{t("payments.payCreateBill")}</Button></div>
      <Requests />
    </section>
    <CreateBillDialog open={createBillOpen} onOpenChange={setCreateBillOpen} />
  </div>
}
