"use client"

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import Transactions from "@/components/transactions"
import Votes from "@/components/votes"
import { useI18n } from "@/components/i18n-provider"

export default function PendingWork() {
  const { t } = useI18n()
  return <div className="space-y-4">
    <h2 className="text-xl font-bold">{t("dash.pendingTitle")}</h2>
    <Tabs defaultValue="transfers">
      <TabsList className="grid w-full grid-cols-2 rounded-xl bg-muted/50 p-1">
        <TabsTrigger value="transfers" className="rounded-lg">{t("dash.pendingTransfersTab")}</TabsTrigger>
        <TabsTrigger value="governance" className="rounded-lg">{t("dash.pendingVotesTab")}</TabsTrigger>
      </TabsList>
      <TabsContent value="transfers"><Transactions /></TabsContent>
      <TabsContent value="governance"><Votes /></TabsContent>
    </Tabs>
  </div>
}
