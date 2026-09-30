"use client"

import { useState } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Gift, Coins, Sparkles, Crown, Clock, CheckCircle2, AlertCircle, ArrowUpRight, ShieldCheck, Flame } from "lucide-react"
import { motion, AnimatePresence } from "framer-motion"

export interface ClaimRecord {
  id: string
  claimer: string
  claimerName: string
  amount: number
  claimedAt: string
  isBest?: boolean
}

export interface RedPacketData {
  id: string
  sender: string
  senderName: string
  totalAmount: number
  totalCount: number
  remainingAmount: number
  remainingCount: number
  packetType: "LUCKY_RANDOM" | "EQUAL"
  greeting: string
  createdAt: string
  expiresAt: string
  claims: ClaimRecord[]
  claimedByUser?: boolean
  userClaimAmount?: number
}

interface RedPacketDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  mode: "create" | "claim"
  packetData?: RedPacketData | null
  currentUserName?: string
  currentUserAddress?: string
  onCreatePacket?: (packet: {
    totalAmount: number
    totalCount: number
    packetType: "LUCKY_RANDOM" | "EQUAL"
    greeting: string
  }) => void
  onClaimPacket?: (packetId: string) => void
  onRefundPacket?: (packetId: string) => void
}

export function RedPacketDialog({
  open,
  onOpenChange,
  mode,
  packetData,
  currentUserName = "You",
  currentUserAddress = "0x6o7p...8q9r",
  onCreatePacket,
  onClaimPacket,
  onRefundPacket,
}: RedPacketDialogProps) {
  // Create mode form state
  const [packetType, setPacketType] = useState<"LUCKY_RANDOM" | "EQUAL">("LUCKY_RANDOM")
  const [totalAmount, setTotalAmount] = useState("10.0")
  const [totalCount, setTotalCount] = useState("5")
  const [greeting, setGreeting] = useState("恭喜发财，万事大吉！🧧")
  const [isOpening, setIsOpening] = useState(false)
  const [openedJustNow, setOpenedJustNow] = useState(false)
  const [claimedAmountState, setClaimedAmountState] = useState<number | null>(null)

  const handleCreate = () => {
    const amt = parseFloat(totalAmount)
    const cnt = parseInt(totalCount, 10)
    if (isNaN(amt) || amt <= 0 || isNaN(cnt) || cnt <= 0) return

    onCreatePacket?.({
      totalAmount: amt,
      totalCount: cnt,
      packetType,
      greeting: greeting.trim() || "恭喜发财，万事大吉！",
    })
    onOpenChange(false)
  }

  const handleOpenClick = () => {
    if (!packetData || isOpening || packetData.claimedByUser || packetData.remainingCount <= 0) return
    setIsOpening(true)
    setTimeout(() => {
      setIsOpening(false)
      setOpenedJustNow(true)
      onClaimPacket?.(packetData.id)
    }, 700)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[92vw] max-w-[400px] p-0 overflow-hidden border-border/70 bg-background text-foreground shadow-2xl rounded-2xl">
        {mode === "create" ? (
          <div className="p-5 space-y-4">
            <DialogHeader>
              <div className="flex items-center space-x-2.5">
                <div className="p-2 rounded-xl bg-red-500 text-white shadow-md">
                  <Gift className="h-5 w-5" />
                </div>
                <div>
                  <DialogTitle className="text-base font-bold">发红包</DialogTitle>
                  <DialogDescription className="text-xs text-muted-foreground">
                    群内成员可拼手气或等额领取
                  </DialogDescription>
                </div>
              </div>
            </DialogHeader>

            {/* 红包类型切换 */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">分配模式</label>
              <Tabs
                value={packetType}
                onValueChange={(v) => setPacketType(v as "LUCKY_RANDOM" | "EQUAL")}
                className="w-full"
              >
                <TabsList className="grid grid-cols-2 w-full h-9 bg-muted/60 p-0.5 rounded-xl">
                  <TabsTrigger value="LUCKY_RANDOM" className="text-xs gap-1.5 data-[state=active]:bg-background rounded-lg">
                    <Sparkles className="h-3.5 w-3.5 text-amber-500" />
                    拼手气红包
                  </TabsTrigger>
                  <TabsTrigger value="EQUAL" className="text-xs gap-1.5 data-[state=active]:bg-background rounded-lg">
                    <Coins className="h-3.5 w-3.5 text-blue-500" />
                    普通红包
                  </TabsTrigger>
                </TabsList>
              </Tabs>
            </div>

            {/* 总金额与份数 */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">总金额 (SUI)</label>
                <div className="relative">
                  <Input
                    type="number"
                    step="0.1"
                    min="0.1"
                    value={totalAmount}
                    onChange={(e) => setTotalAmount(e.target.value)}
                    className="pr-12 text-sm font-semibold rounded-xl"
                  />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-medium text-muted-foreground">
                    SUI
                  </span>
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">红包个数</label>
                <div className="relative">
                  <Input
                    type="number"
                    min="1"
                    max="100"
                    value={totalCount}
                    onChange={(e) => setTotalCount(e.target.value)}
                    className="pr-8 text-sm font-semibold rounded-xl"
                  />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-medium text-muted-foreground">
                    个
                  </span>
                </div>
              </div>
            </div>

            {/* 祝福语 */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">留言</label>
              <Input
                value={greeting}
                onChange={(e) => setGreeting(e.target.value)}
                placeholder="恭喜发财，万事大吉！"
                className="text-xs rounded-xl"
                maxLength={60}
              />
            </div>

            <div className="flex justify-end space-x-2 pt-2">
              <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} className="rounded-xl">
                取消
              </Button>
              <Button
                size="sm"
                onClick={handleCreate}
                className="bg-red-600 hover:bg-red-700 text-white font-medium px-5 rounded-xl shadow-md"
              >
                <Gift className="h-4 w-4 mr-1.5" />
                塞钱发红包 ({totalAmount} SUI)
              </Button>
            </div>
          </div>
        ) : (
          /* Claim Mode / View Red Packet Modal */
          <div className="flex flex-col">
            {/* 顶部红金背景区 */}
            <div className="relative bg-gradient-to-br from-red-600 via-rose-600 to-amber-600 text-white p-6 pb-10 flex flex-col items-center text-center overflow-hidden">
              <div className="absolute top-0 right-0 transform translate-x-4 -translate-y-4 opacity-10">
                <Gift className="w-48 h-48" />
              </div>

              <div className="relative z-10 flex flex-col items-center">
                <div className="w-12 h-12 rounded-full bg-amber-400/20 border-2 border-amber-300 flex items-center justify-center mb-2 shadow-inner">
                  <span className="text-xl">🧧</span>
                </div>
                <p className="text-sm font-semibold tracking-wide text-amber-100">
                  {packetData?.senderName || "神秘星球群友"} 的红包
                </p>
                <h3 className="text-base font-bold mt-1 text-white/95">
                  &ldquo;{packetData?.greeting || "恭喜发财，万事大吉！"}&rdquo;
                </h3>

                <div className="flex items-center gap-2 mt-2">
                  <Badge variant="outline" className="bg-white/10 text-white border-white/20 text-[10px] px-2">
                    {packetData?.packetType === "LUCKY_RANDOM" ? "拼手气随机" : "普通等额"}
                  </Badge>
                  <span className="text-[11px] text-white/80">
                    共 {packetData?.totalAmount} SUI · 剩余 {packetData?.remainingCount}/{packetData?.totalCount} 个
                  </span>
                </div>

                {/* 开红包按钮 (未领且有剩余) */}
                {!packetData?.claimedByUser && (packetData?.remainingCount ?? 0) > 0 && (
                  <motion.button
                    id="btn-open-red-packet"
                    whileHover={{ scale: 1.05 }}
                    whileTap={{ scale: 0.95 }}
                    animate={isOpening ? { rotate: 360, transition: { repeat: Infinity, duration: 0.6 } } : {}}
                    onClick={handleOpenClick}
                    disabled={isOpening}
                    className="mt-6 w-16 h-16 rounded-full bg-gradient-to-b from-amber-300 to-amber-500 text-red-900 font-extrabold text-xl shadow-xl shadow-black/30 border-2 border-amber-200 flex items-center justify-center cursor-pointer hover:shadow-amber-400/40 transition-all select-none"
                  >
                    {isOpening ? "..." : "開"}
                  </motion.button>
                )}

                {/* 如果当前用户已经领过，显示抢到的金额 */}
                {packetData?.claimedByUser && (
                  <div className="mt-5 p-3 rounded-2xl bg-black/20 backdrop-blur-md border border-white/20 text-center animate-in fade-in zoom-in-95 duration-200">
                    <p className="text-[11px] text-amber-200">你已领取</p>
                    <p className="text-2xl font-black text-amber-300 tracking-tight">
                      {(packetData.userClaimAmount ?? 0).toFixed(3)}{" "}
                      <span className="text-xs font-normal">SUI</span>
                    </p>
                    <p className="text-[10px] text-white/70 mt-0.5">已直接入账钱包</p>
                  </div>
                )}

                {/* 红包已被领光 */}
                {!packetData?.claimedByUser && (packetData?.remainingCount ?? 0) === 0 && (
                  <div className="mt-4 px-3 py-1 rounded-full bg-black/20 text-xs text-white/80">
                    手慢了，红包已被领完！
                  </div>
                )}
              </div>
            </div>

            {/* 下半部：领取记录榜单 */}
            <div className="p-5 bg-card flex-1 max-h-72 overflow-y-auto space-y-3">
              <div className="flex items-center justify-between text-xs text-muted-foreground pb-2 border-b border-border/50">
                <span>已领取 {packetData?.claims.length}/{packetData?.totalCount} 个</span>
                <span>
                  共计 {(packetData ? packetData.totalAmount - packetData.remainingAmount : 0).toFixed(3)} /{" "}
                  {packetData?.totalAmount} SUI
                </span>
              </div>

              {packetData?.claims.length === 0 ? (
                <div className="py-8 text-center text-xs text-muted-foreground">
                  暂无成员领取，快来做第一个运气王！
                </div>
              ) : (
                <div className="space-y-2">
                  {packetData?.claims.map((claim) => (
                    <div
                      key={claim.id}
                      className="flex items-center justify-between p-2 rounded-xl hover:bg-muted/40 transition-colors"
                    >
                      <div className="flex items-center space-x-2.5">
                        <div className="w-8 h-8 rounded-full bg-gradient-to-br from-amber-400 to-rose-500 text-white font-bold flex items-center justify-center text-xs">
                          {claim.claimerName.slice(0, 1)}
                        </div>
                        <div>
                          <div className="flex items-center gap-1.5">
                            <span className="text-xs font-semibold text-foreground">{claim.claimerName}</span>
                            {claim.isBest && (
                              <Badge className="h-4 text-[9px] px-1 bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/30 gap-0.5">
                                <Crown className="h-2.5 w-2.5" /> 手气最佳
                              </Badge>
                            )}
                          </div>
                          <span className="text-[10px] text-muted-foreground">{claim.claimedAt}</span>
                        </div>
                      </div>

                      <div className="text-right">
                        <span className="font-mono font-bold text-xs text-foreground">
                          {claim.amount.toFixed(3)} SUI
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* 过期退款入口 (仅发件人可见，且有剩余) */}
              {packetData && packetData.senderName.includes("You") && packetData.remainingAmount > 0 && (
                <div className="pt-2 border-t border-border/40 flex items-center justify-between text-xs">
                  <span className="text-muted-foreground text-[11px] flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    24h 过期自动全额退款
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      onRefundPacket?.(packetData.id)
                      onOpenChange(false)
                    }}
                    className="h-6 text-[10px] text-rose-500 hover:text-rose-600 hover:bg-rose-500/10"
                  >
                    提前退回剩余 {packetData.remainingAmount.toFixed(3)} SUI
                  </Button>
                </div>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
