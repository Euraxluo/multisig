"use client"

import { useState } from "react"
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

export default function Dashboard() {
  const [selectedGroup, setSelectedGroup] = useState<string | null>(null)
  const [isCreateGroupOpen, setIsCreateGroupOpen] = useState(false)

  const groups = [
    {
      id: "group-1",
      name: "Team Treasury",
      balance: 1250,
      token: "APT",
      members: 4,
      pendingTransactions: 2,
      network: "Aptos",
      color: "from-primary to-purple-500",
    },
    {
      id: "group-2",
      name: "DAO Fund",
      balance: 5000,
      token: "USDC",
      members: 7,
      pendingTransactions: 1,
      network: "Ethereum",
      color: "from-blue-500 to-cyan-400",
    },
    {
      id: "group-3",
      name: "Project Alpha",
      balance: 750,
      token: "SOL",
      members: 3,
      pendingTransactions: 0,
      network: "Solana",
      color: "from-green-500 to-emerald-400",
    },
  ]

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
            <p className="text-lg font-bold">$7,000</p>
            <p className="text-xs text-muted-foreground">Total Assets</p>
          </CardContent>
        </Card>
        <Card className="bg-gradient-to-br from-amber-500/10 to-orange-500/10 border-none shadow-sm">
          <CardContent className="p-3 flex flex-col items-center justify-center">
            <Clock className="h-8 w-8 text-amber-500 mb-1" />
            <p className="text-lg font-bold">3</p>
            <p className="text-xs text-muted-foreground">Pending Transactions</p>
          </CardContent>
        </Card>
      </div>

      <motion.div className="grid gap-3" variants={container} initial="hidden" animate="show">
        {groups.map((group) => (
          <motion.div key={group.id} variants={item}>
            <Card
              className="overflow-hidden hover:shadow-md transition-all duration-300 border-none shadow-sm"
              onClick={() => setSelectedGroup(group.id)}
            >
              <div className={`h-1 bg-gradient-to-r ${group.color}`}></div>
              <CardHeader className="p-3 pb-0">
                <div className="flex items-start justify-between">
                  <div>
                    <h3 className="font-medium text-sm">{group.name}</h3>
                    <p className="text-xs text-muted-foreground">{group.network} Network</p>
                  </div>
                  <Badge variant="outline" className="text-xs">
                    {group.pendingTransactions} Pending
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="p-3">
                <div className="flex items-center justify-between mb-1.5">
                  <div className="text-xs text-muted-foreground flex items-center">
                    <Users className="h-3 w-3 mr-1" />
                    {group.members} Members
                  </div>
                  <div className="font-medium text-sm">
                    {group.balance} {group.token}
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
        groupId={selectedGroup || ""}
      />

      <CreateGroupDialog open={isCreateGroupOpen} onOpenChange={setIsCreateGroupOpen} />
    </div>
  )
}
