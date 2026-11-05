"use client"

import { useEffect, useRef, useState } from "react"
import { normalizeSuiAddress } from "@mysten/sui/utils"
import { suiMist } from "@/lib/group-chat"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Gift, Coins, Sparkles, Crown, Clock } from "lucide-react"
import { motion } from "framer-motion"
import { useI18n } from "@/components/i18n-provider"

export interface ClaimRecord {
  id: string
  claimer: string
  claimerName: string
  amount: string
  claimedAt: string
  isBest?: boolean
}

export interface RedPacketData {
  id: string
  sender: string
  senderName: string
  totalAmount: string
  totalCount: number
  remainingAmount: string
  remainingCount: number
  claimedAmount: string
  refunded: boolean
  packetType: "LUCKY_RANDOM" | "EQUAL"
  greeting: string
  createdAt: string
  expiresAt: string
  claims: ClaimRecord[]
  claimedByUser?: boolean
  userClaimAmount?: string
}

interface RedPacketDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  mode: "create" | "claim"
  packetData?: RedPacketData | null
  currentUserName?: string
  currentUserAddress?: string
  onCreatePacket?: (packet: {
    totalAmount: string
    totalCount: number
    packetType: "LUCKY_RANDOM" | "EQUAL"
    greeting: string
    durationHours: number
  }) => Promise<void>
  onClaimPacket?: (packetId: string) => Promise<void>
  onRefundPacket?: (packetId: string) => Promise<void>
}

export function RedPacketDialog({
  open,
  onOpenChange,
  mode,
  packetData,
  // Kept in the component's public shape for callers that show the current
  // member's name; no caller supplies it today, so it stays unused here.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  currentUserName = "You",
  currentUserAddress = "",
  onCreatePacket,
  onClaimPacket,
  onRefundPacket,
}: RedPacketDialogProps) {
  const { t } = useI18n()
  // Create mode form state
  const [packetType, setPacketType] = useState<"LUCKY_RANDOM" | "EQUAL">("LUCKY_RANDOM")
  const [totalAmount, setTotalAmount] = useState("10.0")
  const [totalCount, setTotalCount] = useState("5")
  const [durationHours, setDurationHours] = useState("24")
  const [greeting, setGreeting] = useState(t("payments.rpDefaultGreeting"))
  const [isOpening, setIsOpening] = useState(false)
  const [now, setNow] = useState(Date.now)
  const actionPending = useRef(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const expiresAt = packetData ? new Date(packetData.expiresAt).getTime() : NaN
  const expired = Number.isFinite(expiresAt) && now > expiresAt
  const isSender = !!packetData && /^0x[0-9a-fA-F]{1,64}$/.test(currentUserAddress) && normalizeSuiAddress(currentUserAddress) === normalizeSuiAddress(packetData.sender)
  useEffect(() => {
    if (!open) return
    setActionError(null)
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [open, mode, packetData?.id])

  const handleCreate = async () => {
    if (actionPending.current) return
    setActionError(null)
    actionPending.current = true
    setIsOpening(true)
    try {
      const amount = totalAmount.trim()
      const count = Number(totalCount)
      const hours = Number(durationHours)
      if (!Number.isSafeInteger(count) || count < 1 || count > 128 || suiMist(amount) < BigInt(count)) throw new Error(t("payments.rpErrCountMist"))
      if (!Number.isSafeInteger(hours) || hours < 1 || hours > 168) throw new Error(t("payments.rpErrHours"))
      if (new TextEncoder().encode(greeting).length > 256) throw new Error(t("payments.rpErrGreetingBytes"))
      if (!onCreatePacket) throw new Error(t("payments.rpErrCreateNotWired"))
      await onCreatePacket({ totalAmount: amount, totalCount: count, packetType, greeting, durationHours: hours })
      onOpenChange(false)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : t("payments.rpErrCreateFailed"))
    } finally {
      actionPending.current = false
      setIsOpening(false)
    }
  }
  const handleOpenClick = async () => {
    if (!packetData || actionPending.current) return
    setActionError(null)
    actionPending.current = true
    setIsOpening(true)
    try {
      if (!onClaimPacket) throw new Error(t("payments.rpErrClaimNotWired"))
      if (packetData.claimedByUser || packetData.remainingCount < 1 || expired || packetData.refunded) throw new Error(t("payments.rpErrAlreadyHandled"))
      await onClaimPacket(packetData.id)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : t("payments.rpErrClaimFailed"))
    } finally {
      actionPending.current = false
      setIsOpening(false)
    }
  }
  const handleRefund = async () => {
    if (!packetData || actionPending.current) return
    setActionError(null)
    actionPending.current = true
    setIsOpening(true)
    try {
      if (!onRefundPacket) throw new Error(t("payments.rpErrRefundNotWired"))
      if (!isSender || !expired || packetData.refunded) throw new Error(t("payments.rpErrOnlySenderRefund"))
      await onRefundPacket(packetData.id)
      onOpenChange(false)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : t("payments.rpErrRefundFailed"))
    } finally {
      actionPending.current = false
      setIsOpening(false)
    }
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
                  <DialogTitle className="text-base font-bold">{t("payments.rpCreateTitle")}</DialogTitle>
                  <DialogDescription className="text-xs text-muted-foreground">
                    {t("payments.rpCreateDescription")}
                  </DialogDescription>
                </div>
              </div>
            </DialogHeader>

            {/* 红包类型切换 */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">{t("payments.rpModeLabel")}</label>
              <Tabs
                value={packetType}
                onValueChange={(v) => setPacketType(v as "LUCKY_RANDOM" | "EQUAL")}
                className="w-full"
              >
                <TabsList className="grid grid-cols-2 w-full h-9 bg-muted/60 p-0.5 rounded-xl">
                  <TabsTrigger value="LUCKY_RANDOM" className="text-xs gap-1.5 data-[state=active]:bg-background rounded-lg">
                    <Sparkles className="h-3.5 w-3.5 text-amber-500" />
                    {t("payments.rpModeLucky")}
                  </TabsTrigger>
                  <TabsTrigger value="EQUAL" className="text-xs gap-1.5 data-[state=active]:bg-background rounded-lg">
                    <Coins className="h-3.5 w-3.5 text-blue-500" />
                    {t("payments.rpModeEqual")}
                  </TabsTrigger>
                </TabsList>
              </Tabs>
            </div>

            {/* 总金额与份数 */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">{t("payments.rpTotalAmountLabel")}</label>
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
                <label className="text-xs font-medium text-muted-foreground">{t("payments.rpCountLabel")}</label>
                <div className="relative">
                  <Input
                    type="number"
                    min="1"
                    max="128"
                    value={totalCount}
                    onChange={(e) => setTotalCount(e.target.value)}
                    className="pr-8 text-sm font-semibold rounded-xl"
                  />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-medium text-muted-foreground">
                    {t("payments.rpCountUnit")}
                  </span>
                </div>
              </div>
            </div>

            <div className="space-y-1.5">
              <label htmlFor="packet-duration" className="text-xs font-medium text-muted-foreground">{t("payments.rpDurationLabel")}</label>
              <Input id="packet-duration" type="number" min="1" max="168" value={durationHours} onChange={event => setDurationHours(event.target.value)} className="text-xs rounded-xl" />
              <p className="text-[10px] text-muted-foreground">{t("payments.rpDurationNote")}</p>
            </div>
            {/* 祝福语 */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">{t("payments.rpGreetingLabel")}</label>
              <Input
                value={greeting}
                onChange={(e) => setGreeting(e.target.value)}
                placeholder={t("payments.rpGreetingPlaceholder")}
                className="text-xs rounded-xl"
                maxLength={60}
              />
            </div>

            {actionError && <p role="alert" className="px-5 py-2 text-xs text-destructive">{actionError}</p>}
            <div className="flex justify-end space-x-2 pt-2">
              <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} className="rounded-xl">
                {t("common.cancel")}
              </Button>
              <Button
                size="sm"
                onClick={handleCreate}
                disabled={isOpening}
                className="bg-red-600 hover:bg-red-700 text-white font-medium px-5 rounded-xl shadow-md"
              >
                <Gift className="h-4 w-4 mr-1.5" />
                {t("payments.rpSendButton", { amount: totalAmount })}
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
                  {t("payments.rpFromSender", { name: packetData?.senderName || t("payments.rpAnonymousSender") })}
                </p>
                <h3 className="text-base font-bold mt-1 text-white/95">
                  &ldquo;{packetData?.greeting || t("payments.rpGreetingPlaceholder")}&rdquo;
                </h3>

                <div className="flex items-center gap-2 mt-2">
                  {actionError && <p role="alert" className="text-xs text-rose-100 mt-2 max-w-[280px]">{actionError}</p>}
                  <Badge variant="outline" className="bg-white/10 text-white border-white/20 text-[10px] px-2">
                    {packetData?.packetType === "LUCKY_RANDOM" ? t("payments.rpBadgeLucky") : t("payments.rpBadgeEqual")}
                  </Badge>
                  <span className="text-[11px] text-white/80">
                    {t("payments.rpTotalLine", { amount: packetData?.totalAmount ?? "", remaining: packetData?.remainingCount ?? 0, total: packetData?.totalCount ?? 0 })}
                  </span>
                </div>

                {/* 开红包按钮 (未领且有剩余) */}
                {!packetData?.claimedByUser && (packetData?.remainingCount ?? 0) > 0 && !expired && !packetData?.refunded && (
                  <motion.button
                    id="btn-open-red-packet"
                    whileHover={{ scale: 1.05 }}
                    whileTap={{ scale: 0.95 }}
                    animate={isOpening ? { rotate: 360, transition: { repeat: Infinity, duration: 0.6 } } : {}}
                    onClick={handleOpenClick}
                    disabled={isOpening}
                    className="mt-6 w-16 h-16 rounded-full bg-gradient-to-b from-amber-300 to-amber-500 text-red-900 font-extrabold text-xl shadow-xl shadow-black/30 border-2 border-amber-200 flex items-center justify-center cursor-pointer hover:shadow-amber-400/40 transition-all select-none"
                  >
                    {isOpening ? "..." : t("payments.rpOpenGlyph")}
                  </motion.button>
                )}

                {/* 如果当前用户已经领过，显示抢到的金额 */}
                {packetData?.claimedByUser && (
                  <div className="mt-5 p-3 rounded-2xl bg-black/20 backdrop-blur-md border border-white/20 text-center animate-in fade-in zoom-in-95 duration-200">
                    <p className="text-[11px] text-amber-200">{t("payments.rpYouClaimed")}</p>
                    <p className="text-2xl font-black text-amber-300 tracking-tight">
                      {packetData.userClaimAmount ?? t("payments.rpAmountUnread")}{" "}
                      {packetData.userClaimAmount && <span className="text-xs font-normal">SUI</span>}
                    </p>
                    <p className="text-[10px] text-white/70 mt-0.5">{packetData.userClaimAmount ? t("payments.rpCreditedToWallet") : t("payments.rpClaimedButUnread")}</p>
                  </div>
                )}

                {/* 红包已被领光 */}
                {packetData && (expired || packetData.refunded) && <p className="mt-4 text-xs text-white/80">{packetData.refunded ? t("payments.rpRefundedNote") : t("payments.rpExpiredNote")}</p>}
                {/* `packetData` null means the packet was not read at all —
                    claiming "已领完" from a missing object is a false fact. */}
                {!packetData && <div className="mt-4 px-3 py-1 rounded-full bg-black/20 text-xs text-white/80">{t("payments.rpDataUnreadNote")}</div>}
                {packetData && !packetData.claimedByUser && !packetData.refunded && packetData.remainingCount === 0 && (
                  <div className="mt-4 px-3 py-1 rounded-full bg-black/20 text-xs text-white/80">
                    {t("payments.rpAllClaimedNote")}
                  </div>
                )}
              </div>
            </div>

            {/* 下半部：领取记录榜单 */}
            <div className="p-5 bg-card flex-1 max-h-72 overflow-y-auto space-y-3">
              <div className="flex items-center justify-between text-xs text-muted-foreground pb-2 border-b border-border/50">
                <span>{t("payments.rpClaimedCount", { claimed: packetData?.claims.length ?? 0, total: packetData?.totalCount ?? 0 })}</span>
                <span>
                  {t("payments.rpClaimedTotal", { claimed: packetData ? `${packetData.claimedAmount || "0"} / ${packetData.totalAmount}` : t("payments.rpUnread") })}
                </span>
              </div>

              {packetData?.claims.length === 0 ? (
                <div className="py-8 text-center text-xs text-muted-foreground">
                  {t("payments.rpNoClaimsYet")}
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
                                <Crown className="h-2.5 w-2.5" /> {t("payments.rpBestLuck")}
                              </Badge>
                            )}
                          </div>
                          <span className="text-[10px] text-muted-foreground">{claim.claimedAt}</span>
                        </div>
                      </div>

                      <div className="text-right">
                        <span className="font-mono font-bold text-xs text-foreground">
                          {claim.amount} SUI
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* 过期退款入口 (仅发件人可见，且有剩余) */}
              {packetData && isSender && packetData.remainingAmount !== "0" && !packetData.refunded && (
                <div className="pt-2 border-t border-border/40 flex items-center justify-between text-xs">
                  <span className="text-muted-foreground text-[11px] flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    {t("payments.rpRefundOnlyAfterExpiry")}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={isOpening || !expired}
                    onClick={handleRefund}
                    className="h-6 text-[10px] text-rose-500 hover:text-rose-600 hover:bg-rose-500/10"
                  >
                    {t("payments.rpRefundRemaining", { amount: packetData.remainingAmount })}
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
