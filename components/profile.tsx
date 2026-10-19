"use client"

import { Badge } from "@/components/ui/badge"

import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { HistoryItem } from "@/components/history-item"
import { motion } from "framer-motion"
import { Copy, ExternalLink, QrCode, ChevronDown } from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useState, useEffect } from "react"
import { fetchRealBalances, getProposals, type TokenBalanceInfo } from "@/lib/onchain-store"

export default function Profile() {
  const [activeAccount, setActiveAccount] = useState("personal")
  const [savedUser, setSavedUser] = useState<any>(null)
  const [tokenBalances, setTokenBalances] = useState<{
    sui: TokenBalanceInfo
    ssui: TokenBalanceInfo
    usdc: TokenBalanceInfo
    wal: TokenBalanceInfo
  }>({
    sui: { symbol: "SUI", name: "Sui Native Coin", coinType: "0x2::sui::SUI", balance: "0.00", usdValue: "0.00", rawBalance: 0n },
    ssui: { symbol: "sSUI", name: "Spring Staked SUI", coinType: "0x...::ssui::SSUI", balance: "0.00", usdValue: "0.00", rawBalance: 0n },
    usdc: { symbol: "USDC", name: "Sui Native USDC", coinType: "0x...::usdc::USDC", balance: "0.00", usdValue: "0.00", rawBalance: 0n },
    wal: { symbol: "WAL", name: "Walrus Protocol", coinType: "0x...::wal::WAL", balance: "0.00", usdValue: "0.00", rawBalance: 0n },
  })
  const [proposalsHistory, setProposalsHistory] = useState<any[]>([])
  const [userGroups, setUserGroups] = useState<any[]>([])

  useEffect(() => {
    let cancelled = false

    const load = async () => {
      let activeAddr = ""
      try {
        const stored = localStorage.getItem("sui_active_account")
        if (stored) {
          const parsed = JSON.parse(stored)
          if (parsed?.address && typeof parsed.address === "string" && parsed.address.startsWith("0x")) {
            if (!cancelled) setSavedUser(parsed)
            activeAddr = parsed.address
          } else {
            localStorage.removeItem("sui_active_account")
            if (!cancelled) setSavedUser(null)
          }
        }
      } catch (e) {
        console.warn("Failed to read user from localStorage", e)
      }

      // 读取真实群组
      try {
        const grps = JSON.parse(localStorage.getItem("user_groups") || "[]")
        if (!cancelled) setUserGroups(grps)
      } catch {}

      // 从 Sui RPC 抓取真实代币余额
      if (activeAddr) {
        try {
          const b = await fetchRealBalances(activeAddr)
          if (!cancelled) {
            setTokenBalances({
              sui: b.sui,
              ssui: b.ssui,
              usdc: b.usdc,
              wal: b.wal,
            })
          }
        } catch (e) {
          console.warn("[Profile] fetchRealBalances failed:", e)
        }
      }

      // 读取提案历史
      try {
        const pList = getProposals()
        const mapped = pList.map((p) => ({
          id: p.id,
          type: p.status === "executed" ? "creation" : p.status === "approved" ? "approval" : "creation",
          title: `${p.title} (${p.status})`,
          description: `${p.amount} ${p.token} to ${p.recipient.slice(0, 8)}...`,
          date: p.createdAt.slice(0, 10),
          group: p.groupName,
        }))
        if (!cancelled) setProposalsHistory(mapped)
      } catch {}
    }

    load()
    const id = window.setInterval(load, 5000)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [])

  const personalAddress = savedUser?.address || "0xaf0806fadf61ceeb76c21b40af4393e244a5d8ca91ba208d4f58537421eff2e4"
  const personalLabel = savedUser ? `${savedUser.identifier} (${savedUser.authMethodLabel || savedUser.type})` : "未连接钱包 (点击右上角登录)"

  const dynamicGroupAccounts = userGroups.map((g: any, idx: number) => ({
    id: g.id || `group-${idx}`,
    name: `${g.name || "群组"} (${g.members?.length || 1} 成员多签)`,
    address: g.orgObjectId || "0xaf0806fadf61ceeb76c21b40af4393e244a5d8ca91ba208d4f58537421eff2e4",
    type: "group",
  }))

  const accounts = [
    {
      id: "personal",
      name: personalLabel,
      address: personalAddress,
      type: "personal",
    },
    ...(dynamicGroupAccounts.length > 0
      ? dynamicGroupAccounts
      : [
          {
            id: "group-1",
            name: "Team Treasury (Sui MultiSig)",
            address: "0xaf0806fadf61ceeb76c21b40af4393e244a5d8ca91ba208d4f58537421eff2e4",
            type: "group",
          },
          {
            id: "group-2",
            name: "DAO Fund (Sui Native)",
            address: "0xaf0806fadf61ceeb76c21b40af4393e244a5d8ca91ba208d4f58537421eff2e4",
            type: "group",
          },
        ]),
  ]

  const currentAccount = accounts.find((a) => a.id === activeAccount) || accounts[0]
  const shortAddress = currentAccount.address.length > 14
    ? `${currentAccount.address.slice(0, 8)}...${currentAccount.address.slice(-6)}`
    : currentAccount.address

  const tokens = [
    {
      symbol: "SUI",
      name: "Sui Native Coin",
      balance: tokenBalances.sui.balance,
      usdValue: tokenBalances.sui.usdValue,
      change: "+4.8%",
      positive: true,
      color: "bg-gradient-to-r from-blue-500 to-indigo-600",
    },
    {
      symbol: "sSUI",
      name: "Spring Staked SUI",
      balance: tokenBalances.ssui.balance,
      usdValue: tokenBalances.ssui.usdValue,
      change: "+7.2%",
      positive: true,
      color: "bg-gradient-to-r from-purple-500 to-pink-500",
    },
    {
      symbol: "USDC",
      name: "Sui Native USDC",
      balance: tokenBalances.usdc.balance,
      usdValue: tokenBalances.usdc.usdValue,
      change: "0.0%",
      positive: true,
      color: "bg-gradient-to-r from-emerald-500 to-teal-500",
    },
    {
      symbol: "WAL",
      name: "Walrus Protocol",
      balance: tokenBalances.wal.balance,
      usdValue: tokenBalances.wal.usdValue,
      change: "+12.4%",
      positive: true,
      color: "bg-gradient-to-r from-cyan-500 to-blue-500",
    },
  ]

  const history = proposalsHistory.length > 0 ? proposalsHistory : [
    {
      id: "tx1",
      type: "approval",
      title: "Eco Grants #1 (pending)",
      description: "100 SUI to Treasury",
      date: new Date().toISOString().slice(0, 10),
      group: "Team Treasury",
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
      <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }}>
        <Card className="overflow-hidden border-none shadow-sm">
          <div className="h-24 bg-gradient-to-r from-primary to-purple-500"></div>
          <CardContent className="p-3 relative">
            <div className="flex items-center justify-between">
              <div className="flex items-center">
                <Avatar className="h-16 w-16 border-4 border-background -mt-12 shadow-md">
                  <AvatarFallback className="bg-gradient-to-br from-primary to-purple-500 text-white">
                    {currentAccount.name[0]}
                  </AvatarFallback>
                </Avatar>
                <div className="ml-3 mt-1">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" className="p-0 h-auto hover:bg-transparent">
                        <h3 className="font-bold text-lg flex items-center">
                          {currentAccount.name} <ChevronDown className="h-4 w-4 ml-1" />
                        </h3>
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="w-56">
                      <DropdownMenuLabel>Switch Account</DropdownMenuLabel>
                      <DropdownMenuSeparator />
                      {accounts.map((account) => (
                        <DropdownMenuItem
                          key={account.id}
                          onClick={() => setActiveAccount(account.id)}
                          className="flex items-center cursor-pointer"
                        >
                          <Avatar className="h-6 w-6 mr-2">
                            <AvatarFallback
                              className={`text-white text-xs ${
                                account.type === "personal"
                                  ? "bg-gradient-to-br from-primary to-purple-500"
                                  : "bg-gradient-to-br from-blue-500 to-cyan-400"
                              }`}
                            >
                              {account.name[0]}
                            </AvatarFallback>
                          </Avatar>
                          <div className="flex flex-col">
                            <span className="text-sm">{account.name}</span>
                            <span className="text-xs text-muted-foreground">
                              {account.address.slice(0, 6)}...{account.address.slice(-4)}
                            </span>
                          </div>
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <div className="flex items-center text-xs text-muted-foreground">
                    {shortAddress}
                    <Button variant="ghost" size="icon" className="h-6 w-6 ml-1">
                      <Copy className="h-3 w-3" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-6 w-6">
                      <ExternalLink className="h-3 w-3" />
                    </Button>
                  </div>
                </div>
              </div>
              <Badge
                variant="outline"
                className={`${
                  currentAccount.type === "personal"
                    ? "border-primary/30 text-primary"
                    : "border-blue-500/30 text-blue-500"
                }`}
              >
                {currentAccount.type === "personal" ? "Personal" : "Multi-Sig"}
              </Badge>
            </div>
          </CardContent>
        </Card>
      </motion.div>

      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, delay: 0.05 }}
        className="mb-4"
      >
        <Card className="border-none shadow-sm overflow-hidden">
          <CardHeader className="p-3 pb-0">
            <div className="flex items-center justify-between">
              <h3 className="font-medium text-sm">Wallet Address</h3>
              <div className="flex space-x-1">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  onClick={() => navigator.clipboard.writeText(currentAccount.address)}
                >
                  <Copy className="h-3 w-3" />
                </Button>
                <Button variant="ghost" size="icon" className="h-6 w-6">
                  <ExternalLink className="h-3 w-3" />
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-3 flex flex-col items-center">
            <div className="bg-white p-3 rounded-lg mb-2 relative group">
              <div className="absolute inset-0 bg-gradient-to-r from-primary/20 to-purple-500/20 opacity-0 group-hover:opacity-100 transition-opacity rounded-lg"></div>
              <QrCode className="h-32 w-32 text-primary" />
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="h-8 w-8 rounded-full bg-white p-1">
                  <div className="h-full w-full rounded-full bg-gradient-to-r from-primary to-purple-500"></div>
                </div>
              </div>
            </div>
            <p className="text-xs text-muted-foreground text-center">Scan this QR code to send assets to this wallet</p>
          </CardContent>
        </Card>
      </motion.div>

      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, delay: 0.1 }}
      >
        <Card className="border-none shadow-sm">
          <CardHeader className="p-3 pb-0">
            <h3 className="font-medium text-sm">Wallet Balance</h3>
          </CardHeader>
          <CardContent className="p-3">
            <motion.div className="space-y-2" variants={container} initial="hidden" animate="show">
              {tokens.map((token) => (
                <motion.div key={token.symbol} variants={item}>
                  <div className="flex items-center p-2 rounded-lg hover:bg-muted/50 transition-colors">
                    <div
                      className={`flex h-8 w-8 items-center justify-center rounded-full text-white text-xs ${token.color}`}
                    >
                      {token.symbol}
                    </div>
                    <div className="ml-3 flex-1">
                      <div className="font-medium text-sm">{token.name}</div>
                      <div className="text-xs text-muted-foreground">{token.symbol}</div>
                    </div>
                    <div className="text-right">
                      <div className="font-medium text-sm">{token.balance}</div>
                      <div className="flex items-center text-xs">
                        <span className="text-muted-foreground mr-1">${token.usdValue}</span>
                        <span className={token.positive ? "text-green-500" : "text-red-500"}>{token.change}</span>
                      </div>
                    </div>
                  </div>
                </motion.div>
              ))}
            </motion.div>
          </CardContent>
        </Card>
      </motion.div>

      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, delay: 0.2 }}
      >
        <Card className="border-none shadow-sm">
          <CardHeader className="p-3 pb-0">
            <h3 className="font-medium text-sm">Activity History</h3>
          </CardHeader>
          <CardContent className="p-3">
            <Tabs defaultValue="all" className="w-full">
              <TabsList className="grid w-full grid-cols-3 p-1 bg-muted/50 rounded-xl">
                <TabsTrigger
                  value="all"
                  className="rounded-lg text-xs data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
                >
                  All
                </TabsTrigger>
                <TabsTrigger
                  value="approvals"
                  className="rounded-lg text-xs data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
                >
                  Approvals
                </TabsTrigger>
                <TabsTrigger
                  value="creations"
                  className="rounded-lg text-xs data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
                >
                  Created
                </TabsTrigger>
              </TabsList>
              <TabsContent value="all" className="mt-3 space-y-3">
                {history.map((item) => (
                  <HistoryItem key={item.id} item={item} />
                ))}
              </TabsContent>
              <TabsContent value="approvals" className="mt-3 space-y-3">
                {history
                  .filter((item) => item.type === "approval")
                  .map((item) => (
                    <HistoryItem key={item.id} item={item} />
                  ))}
              </TabsContent>
              <TabsContent value="creations" className="mt-3 space-y-3">
                {history
                  .filter((item) => item.type === "creation")
                  .map((item) => (
                    <HistoryItem key={item.id} item={item} />
                  ))}
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>
      </motion.div>
    </div>
  )
}
