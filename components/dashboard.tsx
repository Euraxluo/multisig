"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { GroupDetailsDialog } from "@/components/group-details-dialog"
import { motion } from "framer-motion"
import { ArrowRight, TrendingUp, Clock, Users, Plus } from "lucide-react"
import { CreateGroupDialog } from "@/components/create-group-dialog"
import { QuickActions } from "@/components/quick-actions"
import { QuickTemplates } from "@/components/quick-templates"
import { RecurringPayments } from "@/components/recurring-payments"
import { getActiveAccount, fetchRealBalances, getProposals } from "@/lib/onchain-store"

export default function Dashboard() {
  const [selectedGroup, setSelectedGroup] = useState<{ id: string; name: string } | null>(null)
  const [isCreateGroupOpen, setIsCreateGroupOpen] = useState(false)
  const [userGroups, setUserGroups] = useState<any[]>([])
  const [totalAssetsUsd, setTotalAssetsUsd] = useState<number>(0)
  const [pendingCount, setPendingCount] = useState<number>(0)

  useEffect(() => {
    let cancelled = false

    const loadData = async () => {
      // 1. 读取群组列表
      try {
        const saved = JSON.parse(localStorage.getItem("user_groups") || "[]")
        if (!cancelled) setUserGroups(saved)
      } catch {}

      // 2. 读取待处理提案数
      try {
        const props = getProposals()
        const pending = props.filter((p) => p.status === "pending").length
        if (!cancelled) setPendingCount(pending)
      } catch {}

      // 3. 从 Sui 真实全节点 RPC 读取活跃钱包链上资产
      const account = getActiveAccount()
      if (account?.address) {
        try {
          const balances = await fetchRealBalances(account.address)
          if (!cancelled) {
            setTotalAssetsUsd(balances.totalUsdValue)
          }
        } catch (e) {
          console.warn("[Dashboard] fetchRealBalances failed:", e)
        }
      } else {
        if (!cancelled) setTotalAssetsUsd(0)
      }
    }

    loadData()

    const onStorage = () => loadData()
    const onProposalsUpdated = () => loadData()
    window.addEventListener("storage", onStorage)
    window.addEventListener("sui-proposals-updated", onProposalsUpdated)
    const id = window.setInterval(loadData, 4000)

    return () => {
      cancelled = true
      window.removeEventListener("storage", onStorage)
      window.removeEventListener("sui-proposals-updated", onProposalsUpdated)
      window.clearInterval(id)
    }
  }, [])

  // 群组列表只来自用户真实创建的数据，不再展示 demo 假数据


  const container = {
    hidden: { opacity: 0 },
    show: {
      opacity: 1,
      transition: {
        staggerChildren: 0.1,
      },
    },
  }

  const item = {
    hidden: { opacity: 0, y: 20 },
    show: { opacity: 1, y: 0 },
  }

  return (
    <div className="space-y-4">
      {/* Quick Actions, Templates, and Recurring Payments Section */}
      <div className="space-y-4">
        <QuickActions />
        <QuickTemplates />
        <RecurringPayments />
      </div>

      <div className="flex items-center justify-between mb-2">
        <h2 className="text-xl font-bold">Your Groups</h2>
        <Button
          variant="default"
          size="sm"
          className="bg-gradient-to-r from-primary to-purple-500 hover:from-primary/90 hover:to-purple-500/90"
          onClick={() => setIsCreateGroupOpen(true)}
        >
          <Plus className="h-4 w-4 mr-1" /> New Group
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-3 mb-4">
        <Card className="bg-gradient-to-br from-primary/10 to-purple-500/10 border-none shadow-sm">
          <CardContent className="p-3 flex flex-col items-center justify-center">
            <TrendingUp className="h-8 w-8 text-primary mb-1" />
            <p className="text-lg font-bold">
              ${totalAssetsUsd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </p>
            <p className="text-xs text-muted-foreground">Total Assets (RPC)</p>
          </CardContent>
        </Card>
        <Card className="bg-gradient-to-br from-amber-500/10 to-orange-500/10 border-none shadow-sm">
          <CardContent className="p-3 flex flex-col items-center justify-center">
            <Clock className="h-8 w-8 text-amber-500 mb-1" />
            <p className="text-lg font-bold">{pendingCount}</p>
            <p className="text-xs text-muted-foreground">Pending Transactions</p>
          </CardContent>
        </Card>
      </div>

      <motion.div className="grid gap-3" variants={container} initial="hidden" animate="show">
        {userGroups.map((g: any) => ({
            id: g.id,
            name: g.name,
            network: g.network || "Sui",
            members: g.members?.length ?? 0,
            threshold: g.threshold || 1,
            color: "from-primary to-purple-500",
          }
          )).map((group: any) => (
          <motion.div key={group.id} variants={item}>
            <Card
              className="overflow-hidden hover:shadow-md transition-all duration-300 border-none shadow-sm"
              onClick={() => setSelectedGroup({ id: group.id, name: group.name })}
            >
              <div className={`h-1 bg-gradient-to-r ${group.color}`}></div>
              <CardHeader className="p-3 pb-0">
                <div className="flex items-start justify-between">
                  <div>
                    <h3 className="font-medium text-sm">{group.name}</h3>
                    <p className="text-xs text-muted-foreground">{group.network} Network</p>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="p-3">
                <div className="flex items-center justify-between mb-1.5">
                  <div className="text-xs text-muted-foreground flex items-center">
                    <Users className="h-3 w-3 mr-1" />
                    {group.members} Members
                  </div>
                  <div className="font-medium text-sm">
                    Threshold {group.threshold}
                  </div>
                </div>
                <div className="mt-3 flex items-center justify-between">
                  <div className="flex -space-x-2">
                    {Array.from({ length: Math.min(group.members, 3) }).map((_, i) => (
                      <Avatar key={`member-${i}`} className="border-2 border-background h-6 w-6">
                        <AvatarFallback className="text-xs bg-gradient-to-br from-primary/80 to-purple-500/80 text-white">
                          {String.fromCharCode(65 + i)}
                        </AvatarFallback>
                      </Avatar>
                    ))}
                    {group.members > 3 && (
                      <Avatar className="border-2 border-background h-6 w-6">
                        <AvatarFallback className="text-xs bg-muted">+{group.members - 3}</AvatarFallback>
                      </Avatar>
                    )}
                  </div>
                  <Button size="sm" variant="ghost" className="h-7 text-xs text-primary flex items-center gap-1">
                    View Details <ArrowRight className="h-3 w-3" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          </motion.div>
        ))}
      </motion.div>

      <GroupDetailsDialog
        open={!!selectedGroup}
        onOpenChange={() => setSelectedGroup(null)}
        groupId={selectedGroup?.id || ""}
      />

      <CreateGroupDialog open={isCreateGroupOpen} onOpenChange={setIsCreateGroupOpen} />
    </div>
  )
}
