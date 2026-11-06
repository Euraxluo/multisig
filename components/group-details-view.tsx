"use client"

import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"

/**
 * The `/groups/[id]` route renders this view standalone (no Radix Dialog
 * ancestor), while the dashboard opens it inside `GroupDetailsDialog`. Radix's
 * `DialogTitle` throws outside a Dialog context, so the header picks the
 * wrapper by mount context: the dialog variant keeps the accessible name
 * Radix requires, the page variant renders the same visible header.
 */
function DialogAwareHeader({ isDialog, className, children }: { isDialog: boolean; className?: string; children: React.ReactNode }) {
  if (!isDialog) return <div className={className}>{children}</div>
  return (
    <DialogHeader className={className}>
      <DialogTitle className="flex items-center justify-between">{children}</DialogTitle>
    </DialogHeader>
  )
}
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  QrCode,
  Users,
  Share2,
  Copy,
  ExternalLink,
  Plus,
  Bot,
  ShieldCheck,
  Sparkles,
  Network,
  MessageSquare,
  Send,
  HardDrive,
  Paperclip,
  Coins,
  Gift,
  Vote,
  FileText,
  UploadCloud,
  Loader2,
  Lock,
  Settings2,
  Sprout,
  Landmark,
} from "lucide-react"
import { Progress } from "@/components/ui/progress"
import { Input } from "@/components/ui/input"
import { useState, useEffect, useRef } from "react"
import { motion, AnimatePresence } from "framer-motion"
import { CreateTransactionDialog } from "@/components/create-transaction-dialog"
import { TransactionDetailsDialog } from "@/components/transaction-details-dialog"
import { DkgCeremonyDialog } from "@/components/dkg-ceremony-dialog"
import { WalrusBlobDialog } from "@/components/walrus-blob-dialog"
import { RedPacketDialog, RedPacketData } from "@/components/red-packet-dialog"
import { WalrusAppSandboxDialog } from "@/components/walrus-app-sandbox-dialog"
import { getActiveAccount, getProposals, ProposalItem, vaultClient, getUserGroups, type LocalGroupRecord } from "@/lib/onchain-store"
import { GroupTreasury } from "@/components/group-treasury"
import { useGroupVaults } from "@/lib/use-group-vaults"
import { useGroupAgents } from "@/lib/use-group-agents"
import { useGroupMessagingCaps } from "@/lib/use-group-messaging-caps"
import { GroupAgentDialog } from "@/components/group-agent-dialog"
import { MessagingCapDialog } from "@/components/messaging-cap-dialog"
import { ScallopYieldPanel } from "@/components/scallop-yield"
import { AssetCustodyPanel } from "@/components/asset-custody"
import { revokeGroupAgentDelegation } from "@/lib/group-agent-transactions"
import { revokeMessagingDelegation } from "@/lib/group-messaging-transactions"
import type { GroupAgentDelegation, GroupAgentStatus } from "@/lib/group-agents"
import type { MessagingCapStatus, MessagingDelegation } from "@/lib/group-messaging-caps"
import {
  uploadToWalrus,
  getGroupWalrusFiles,
  addGroupWalrusFile,
  GroupFileInfo,
} from "@/lib/walrus-client"
import { assertTransactionAccount, getTransactionAccount, resumePendingTransaction, signAndExecuteWithWallet, type WalletTransactionOptions, type WalletTransactionResult } from "@/lib/sui-wallet-signer"
import { acknowledgePendingTransaction, listTransactionReceipts, transactionAccountKey, TransactionReceiptError, type PendingTransactionReceipt } from "@/lib/pending-transactions"
import { PaymentDialog } from "@/components/payment-dialog"
import { ShareQrDialog } from "@/components/share-qr-dialog"
import { useI18n } from "@/components/i18n-provider"
import { GroupRosterDialog } from "@/components/group-roster-dialog"
import { OrganizationContent, PROPOSAL_TYPE_ORIGIN, proposalClient, readWeightTable, weightNumber } from "@/lib/proposal-chain"
import { normalizeSuiAddress, normalizeStructTag, toHex } from "@mysten/sui/utils"
import type { Transaction } from "@mysten/sui/transactions"
import { ObjectError } from "@mysten/sui/client"
import { encodeGroupFilePreview, groupFileMessageText, sharedGroupFiles } from "@/lib/group-files"
import { redPacketV2 } from "@/lib/red-packet-v2-chain"
import { groupChat, chatChannelStorageKey, readStoredChatChannel, formatMist, suiMist, type ChatChannel } from "@/lib/group-chat"
import { MAX_OUTBOX_MESSAGES, OUTBOX_FLUSH_DELAY_MS, enqueueChatMessage, peekChatOutbox, restoreChatOutbox, takeChatOutbox } from "@/lib/chat-outbox"
import { SsmSettingsPanel } from "@/components/ssm-settings-panel"
import { UnifiedChatMessage, type UnifiedChatRow } from "@/components/unified-chat-message"
import { useSsmChat } from "@/lib/use-ssm-chat"
import { describeSsmError } from "@/lib/sui-stack-messaging"
import { useMemberProfiles } from "@/lib/use-member-profiles"
import { IdentityAvatar } from "@/components/identity-avatar"

export interface GroupDetailsViewProps {
  groupId: string
  readOnly?: boolean
  isDialog?: boolean
  onClose?: () => void
}



/**
 * The saved group row this dialog renders, plus the chain fields merged in
 * after the live organization read.
 *
 * `chainMembers` and `chainThreshold` are only ever set together by that read
 * (line ~226), which is why their presence is the "this roster is verified"
 * flag the UI branches on. Extending `LocalGroupRecord` keeps the local note
 * fields (name, description, members) exactly as the store writes them instead
 * of re-declaring them here and letting the two drift apart.
 */
interface GroupDetailsRecord extends LocalGroupRecord {
  chainMembers?: Record<string, number>
  chainThreshold?: number
}

export function GroupDetailsView({ groupId, readOnly = false, isDialog = false, onClose }: GroupDetailsViewProps) {
  const open = true;
  const onOpenChange = (val: boolean) => { if (!val && onClose) onClose(); };
  const { t } = useI18n()
  const [activeTab, setActiveTab] = useState("chat")
  const [shareQrOpen, setShareQrOpen] = useState(false)
  const [chainLoading, setChainLoading] = useState(false)
  const [chainError, setChainError] = useState("")
  const [chainGroup, setChainGroup] = useState<{ id: string; epoch: number; groupPk: string } | null>(null)
  const [loadedGroupId, setLoadedGroupId] = useState("")
  const [isCreateTxOpen, setIsCreateTxOpen] = useState(false)
  const [selectedTx, setSelectedTx] = useState<string | null>(null)
  const [isDkgOpen, setIsDkgOpen] = useState(false)
  const [isRosterOpen, setIsRosterOpen] = useState(false)
  const [isConvertedToDao, setIsConvertedToDao] = useState(false)
  const [groupPk, setGroupPk] = useState("")
  const [orgObjectId, setOrgObjectId] = useState("")
  const [orgEpoch, setOrgEpoch] = useState(1)
  const [realGroupData, setRealGroupData] = useState<GroupDetailsRecord | null>(null)
  const treasuryOrgId = loadedGroupId === groupId ? realGroupData?.orgObjectId || orgObjectId : ""
  const treasury = useGroupVaults(open, treasuryOrgId)
  // The AI tab is the only consumer of the delegation scan, so it loads on demand.
  const [agentDialogOpen, setAgentDialogOpen] = useState(false)
  const [agentActionError, setAgentActionError] = useState("")
  const [agentBusyCap, setAgentBusyCap] = useState("")
  const [agentAccount, setAgentAccount] = useState<string | null>(null)
  const groupAgentsState = useGroupAgents(open && activeTab === "agents", treasuryOrgId)
  useEffect(() => {
    if (!open) return
    const sync = () => setAgentAccount(getActiveAccount()?.address ?? null)
    sync()
    window.addEventListener("sui-account-switched", sync)
    window.addEventListener("sui-account-changed", sync)
    return () => {
      window.removeEventListener("sui-account-switched", sync)
      window.removeEventListener("sui-account-changed", sync)
    }
  }, [open])
  const agentRoster = groupAgentsState.data?.roster ?? []
  const agentMember = agentAccount ? agentRoster.find(member => normalizeSuiAddress(member.address) === normalizeSuiAddress(agentAccount)) ?? null : null
  const revokeDelegation = async (delegation: GroupAgentDelegation) => {
    if (agentBusyCap) return
    setAgentActionError("")
    if (!agentAccount || normalizeSuiAddress(delegation.masterOwner) !== normalizeSuiAddress(agentAccount)) { setAgentActionError(t("groups.capRevokeMemberOnly")); return }
    setAgentBusyCap(delegation.capId)
    try {
      const digest = await revokeGroupAgentDelegation(delegation.capId, groupAgentsState.data?.orgId || treasuryOrgId)
      setAgentActionError(t("groups.revokeConfirmed", { p0: digest }))
      await groupAgentsState.reload()
    } catch (cause) {
      setAgentActionError(cause instanceof Error ? cause.message : t("groups.revokeFailed"))
    } finally {
      setAgentBusyCap("")
    }
  }
  const AGENT_STATUS_LABEL: Record<GroupAgentStatus, string> = {
    ACTIVE: t("groups.capAvailable"), EXHAUSTED: t("groups.capExhausted"), EXPIRED: t("groups.capExpired"), REVOKED: t("groups.capRevoked"), STALE: t("groups.capUnavailable"), UNVERIFIED: t("groups.capUnverified"),
  }
  const AGENT_STATUS_TONE: Record<GroupAgentStatus, string> = {
    ACTIVE: "bg-emerald-500/10 text-emerald-500 border-emerald-500/20",
    EXHAUSTED: "bg-amber-500/10 text-amber-500 border-amber-500/20",
    EXPIRED: "bg-muted text-muted-foreground border-border/60",
    REVOKED: "bg-destructive/10 text-destructive border-destructive/20",
    STALE: "bg-amber-500/10 text-amber-500 border-amber-500/20",
    UNVERIFIED: "bg-muted text-muted-foreground border-border/60",
  }
  const suiVaults = treasury.data?.vaults.filter(row => row.treasuryId && normalizeStructTag(row.coinType) === normalizeStructTag("0x2::sui::SUI")) || []
  const groupBalance = suiVaults.length ? formatMist(suiVaults.reduce((sum, row) => sum + row.balance, 0n).toString()) : null
  const balanceError = treasury.error || treasury.data?.errors.length || treasury.data?.discoveryError || treasury.data?.truncated
    ? t("groups.custodyPartialPending") : treasury.loading ? t("groups.custodyReading") : t("groups.noVerifiedCustody")
  const [realProposals, setRealProposals] = useState<ProposalItem[]>([])

  // Walrus 群文件管理状态
  const [groupFiles, setGroupFiles] = useState<GroupFileInfo[]>([])
  const [chainFiles, setChainFiles] = useState<GroupFileInfo[]>([])
  const [pendingFile, setPendingFile] = useState<{ file: GroupFileInfo; channelId: string; sender: string } | null>(null)
  const [pendingChatReceipt, setPendingChatReceipt] = useState<PendingTransactionReceipt | null>(null)
  const [tipOpen, setTipOpen] = useState(false)
  const [tipRecipient, setTipRecipient] = useState("")
  const [tipPaymentOpen, setTipPaymentOpen] = useState(false)
  const [fileError, setFileError] = useState("")
  const [fileReceipt, setFileReceipt] = useState("")
  const fileUploadPending = useRef(false)
  const [isUploadingFile, setIsUploadingFile] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // 恢复群提案与真实群组
  useEffect(() => {
    const loadProps = () => {
      setRealProposals(getProposals())
    }
    loadProps()
    window.addEventListener("sui-proposals-updated", loadProps)
    return () => window.removeEventListener("sui-proposals-updated", loadProps)
  }, [])

  // 恢复群文件列表
  useEffect(() => {
    if (!groupId) return
    setGroupFiles([]); setChainFiles([]); setPendingFile(null); setFileError(""); setFileReceipt("")
    const loadFiles = () => {
      try { setGroupFiles(getGroupWalrusFiles(groupId)) }
      catch (error) { setFileError(error instanceof Error ? error.message : t("groups.readGroupFilesFailed")) }
    }
    loadFiles()
    window.addEventListener("walrus-files-updated", loadFiles)
    return () => window.removeEventListener("walrus-files-updated", loadFiles)
  }, [groupId])

  // A shared link may identify an organization absent from this device's local groups.
  useEffect(() => {
    let cancelled = false
    let restoreVersion = 0
    const restore = async () => {
      const run = ++restoreVersion
      const current = () => !cancelled && run === restoreVersion
      const savedGroups = getUserGroups()
      const found = savedGroups.find((group) => group.id === groupId || group.orgObjectId === groupId)
      if (!current()) return
      setRealGroupData(found || null)
      // A saved `orgObjectId` is a local note, not proof the object is live. The
      // DAO card below claims a cryptographic on-chain organization, so the flag
      // starts false and is only raised by the verified read underneath.
      setIsConvertedToDao(false)
      setOrgObjectId(found?.orgObjectId || "")
      setGroupPk(found?.groupPk || "")
      setOrgEpoch(found?.epoch || 1)
      const organizationId = found?.orgObjectId || (/^0x[0-9a-fA-F]{1,64}$/.test(groupId) ? groupId : "")
      if (!organizationId) return
      setChainLoading(true)
      try {
        const { object } = await proposalClient.getObject({ objectId: organizationId, include: { content: true }, signal: AbortSignal.timeout(20_000) })
        if (normalizeStructTag(object.type) !== `${PROPOSAL_TYPE_ORIGIN}::cryptographic_org::Organization`) throw new Error(t("groups.notProtocolOrg"))
        const fields = OrganizationContent.parse(object.content)
        if (normalizeSuiAddress(object.objectId) !== normalizeSuiAddress(organizationId) || fields.id !== normalizeSuiAddress(organizationId) || object.owner.$kind !== "Shared") throw new Error(t("groups.orgIdOwnerMismatch"))
        const members = await readWeightTable(fields.members_weight.id)
        if (BigInt(Object.keys(members).length) !== BigInt(fields.members_weight.size)) throw new Error(t("groups.orgRosterIncomplete"))
        if (!current()) return
        const pk = toHex(Uint8Array.from(fields.group_pk))
        const epoch = weightNumber(fields.epoch_version)
        if (!current()) return
        setChainGroup({ id: object.objectId, epoch, groupPk: pk })
        setOrgObjectId(object.objectId); setOrgEpoch(epoch); setGroupPk(pk); setIsConvertedToDao(true)
        setChainError("")
        if (found) setRealGroupData({ ...found, chainMembers: members, chainThreshold: weightNumber(fields.threshold_weight), sourceStatus: "chain-confirmed" })
      } catch (error) {
        if (!cancelled) setChainError(error instanceof Error ? error.message : t("groups.orgReadFailedShort"))
      } finally { if (!cancelled) setChainLoading(false) }
    }
    setLoadedGroupId(groupId)
    setRealGroupData(null); setChainGroup(null); setChainError(""); setChainLoading(false)
    setOrgObjectId(""); setGroupPk(""); setOrgEpoch(1); setIsConvertedToDao(false)
    setShareQrOpen(false); setIsDkgOpen(false); setIsRosterOpen(false); setIsCreateTxOpen(false); setSelectedTx(null)
    const load = () => { void restore() }
    load()
    window.addEventListener("sui-groups-updated", load)
    window.addEventListener("storage", load)
    return () => {
      cancelled = true
      window.removeEventListener("sui-groups-updated", load)
      window.removeEventListener("storage", load)
    }
  }, [groupId, open])

  const [selectedBlobId, setSelectedBlobId] = useState<string | null>(null)
  const [isAppSandboxOpen, setIsAppSandboxOpen] = useState(false)
  const [selectedAppBlobId, setSelectedAppBlobId] = useState("")

  const [claimedNotice, setClaimedNotice] = useState<string | null>(null)

  // 红包系统状态
  const [isRedPacketDialogOpen, setIsRedPacketDialogOpen] = useState(false)
  const [redPacketDialogMode, setRedPacketDialogMode] = useState<"create" | "claim">("create")
  const [activeRedPacketId, setActiveRedPacketId] = useState<string | null>(null)
  const [showSlashMenu, setShowSlashMenu] = useState(false)
  const [chatChannel, setChatChannel] = useState<ChatChannel | null>(null)
  const [chatChannelError, setChatChannelError] = useState("")
  /** Channel discovery stopped at its scan cap, so "no channel" is not a fact. */
  const [chatChannelUnresolved, setChatChannelUnresolved] = useState(false)
  // Channel posting delegation is a separate contract surface; it needs a real channel.
  const [messagingDialogOpen, setMessagingDialogOpen] = useState(false)
  const [messagingBusyCap, setMessagingBusyCap] = useState("")
  const [messagingActionError, setMessagingActionError] = useState("")
  const messagingCapsState = useGroupMessagingCaps(open && activeTab === "agents" && !!chatChannel, chatChannel?.id ?? "")
  const MESSAGING_STATUS_LABEL: Record<MessagingCapStatus, string> = { ACTIVE: t("groups.capAvailable"), EXPIRED: t("groups.capExpired"), REVOKED: t("groups.capRevoked"), STALE: t("groups.capUnavailable") }
  const MESSAGING_STATUS_TONE: Record<MessagingCapStatus, string> = {
    ACTIVE: "bg-emerald-500/10 text-emerald-500 border-emerald-500/20",
    EXPIRED: "bg-muted text-muted-foreground border-border/60",
    REVOKED: "bg-destructive/10 text-destructive border-destructive/20",
    STALE: "bg-amber-500/10 text-amber-500 border-amber-500/20",
  }
  const revokeMessaging = async (delegation: MessagingDelegation) => {
    if (messagingBusyCap) return
    setMessagingActionError("")
    if (!agentAccount || normalizeSuiAddress(delegation.masterOwner) !== normalizeSuiAddress(agentAccount)) { setMessagingActionError(t("groups.capRevokeWalletOnly")); return }
    setMessagingBusyCap(delegation.capId)
    try {
      const digest = await revokeMessagingDelegation(delegation.capId, treasuryOrgId)
      setMessagingActionError(t("groups.revokeConfirmed", { p0: digest }))
      await messagingCapsState.reload()
    } catch (cause) {
      setMessagingActionError(cause instanceof Error ? cause.message : t("groups.revokeFailed"))
    } finally {
      setMessagingBusyCap("")
    }
  }
  const [chatMessages, setChatMessages] = useState<Array<{ id: string; sender: string; senderAddress?: string; role: string; time: string; at: number; text: string; walrusBlobId?: string; redPacketId?: string; isSubagent?: boolean }>>([])
  const [chatNotes, setChatNotes] = useState<Array<{ id: string; sender: string; role: string; time: string; at: number; text: string; walrusBlobId?: string }>>([])
  const chatTransactionPending = useRef(false)
  const [chatBusy, setChatBusy] = useState(false)
  const [channelSetupOpen, setChannelSetupOpen] = useState(false)
  const [channelStake, setChannelStake] = useState("")
  const [channelEntryFee, setChannelEntryFee] = useState("0")
  const [channelMemberStake, setChannelMemberStake] = useState("0")
  const [channelCreatorShare, setChannelCreatorShare] = useState("")
  const [channelGasShare, setChannelGasShare] = useState("")
  const [channelMemberShare, setChannelMemberShare] = useState("")
  const [chatRefresh, setChatRefresh] = useState(0)

  const [redPackets, setRedPackets] = useState<Record<string, RedPacketData>>({})

  const [chatInput, setChatInput] = useState("")
  // One conversation, two transports. The toggle only decides how the next
  // message is delivered and which rows the list reads; it never changes the
  // layout, so there is a single message list and a single composer.
  const [chatTransport, setChatTransport] = useState<"onchain" | "ssm">("onchain")
  const [ssmSettingsOpen, setSsmSettingsOpen] = useState(false)
  const ssm = useSsmChat({ groupId, accountAddress: agentAccount ?? "", enabled: activeTab === "chat" && chatTransport === "ssm" && open, readOnly })
  const [outboxCount, setOutboxCount] = useState(0)
  const chatChannelRef = useRef<ChatChannel | null>(null)
  const outboxTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const outboxFlushing = useRef(false)
  const flushOutboxRef = useRef<() => Promise<void>>(async () => {})
  // Keep the async flush and its timer pointed at the current channel/account
  // instead of the closure captured when the timer was scheduled.
  useEffect(() => { chatChannelRef.current = chatChannel }, [chatChannel])
  const [chatLoadedGroup, setChatLoadedGroup] = useState("")
  useEffect(() => {
    const account = getActiveAccount()?.address
    const accountRecord = getActiveAccount()
    const recoverable = accountRecord ? listTransactionReceipts().find(receipt => receipt.status !== "failed" && !receipt.acknowledged && transactionAccountKey(receipt.account) === transactionAccountKey(accountRecord) && receipt.metadata?.groupId === groupId) : undefined
    setPendingChatReceipt(recoverable || null)
    setChatChannel(null); setChatMessages([]); setRedPackets({}); setChainFiles([])
    if (!orgObjectId || !account || loadedGroupId !== groupId || !open) return
    let cancelled = false
    const loadChat = async () => {
      setChatChannelError("")
      setChatChannelUnresolved(false)
      try {
        let savedChannel: string | null = null
        // A storage failure here is not fatal — discovery below still runs — but
        // it must be visible, because it means "no remembered channel" is an
        // unread fact rather than an absent one.
        try { savedChannel = readStoredChatChannel(localStorage, orgObjectId) }
        catch (error) { setChatChannelError(t("groups.storedChannelUnreadable", { p0: error instanceof Error ? error.message : t("groups.storageUnavailable") })) }
        let channelId = savedChannel && /^0x[0-9a-fA-F]{1,64}$/.test(savedChannel) ? savedChannel : ""
        if (channelId) {
          try { await groupChat.readChannel(channelId, orgObjectId, account) }
          catch (error) {
            if (!(error instanceof ObjectError && error.reason === "notFound")) throw error
            channelId = ""
          }
        }
        if (!channelId) {
          const discovered = await groupChat.discoverChannels(orgObjectId)
          for (const candidate of discovered.ids) {
            try { const candidateChannel = await groupChat.readChannel(candidate, orgObjectId, account); channelId = candidateChannel.id; break }
            catch (error) { if (!(error instanceof ObjectError && error.reason === "notFound")) throw error }
          }
          // The scan is a bounded window over the protocol-wide channel stream.
          // When it stopped early, "no channel" is unfounded and creating one
          // would lock a second stake while the first stays invisible.
          if (!channelId && discovered.truncated && !cancelled) {
            setChatChannelUnresolved(true)
            setChatChannelError(t("groups.channelScanLimit"))
          }
        }
        if (!channelId) { if (!cancelled) setChatChannel(null); return }
        const channel = await groupChat.readChannel(channelId, orgObjectId, account)
        if (cancelled) return
        setChatChannel(channel)
        const [messagesResult, v2Result] = await Promise.allSettled([
          groupChat.readMessages(channel.id), redPacketV2.readPackets(channel.id),
        ])
        if (cancelled) return
        const issues: string[] = []
        for (const result of [messagesResult, v2Result]) {
          if (result.status === "rejected") issues.push(result.reason instanceof Error ? result.reason.message : t("groups.chatOrPacketFailed"))
          else if (result.value.truncated) issues.push(t("groups.eventScanLimit"))
        }
        const packets = [
          ...(v2Result.status === "fulfilled" ? v2Result.value.packets : []),
        ].sort((a, b) => b.timestampMs - a.timestampMs)
        try { localStorage.setItem(chatChannelStorageKey(orgObjectId), channel.id) } catch {}
        if (messagesResult.status === "fulfilled") setChainFiles(sharedGroupFiles(groupId, channel.id, messagesResult.value.messages))
        const packetMap: Record<string, RedPacketData> = {}
        for (const packet of packets) {
          const ownClaim = packet.claims.find(claim => claim.recipient === normalizeSuiAddress(account))
          const claimedMist = packet.claims.reduce((sum, claim) => sum + BigInt(claim.amountMist), 0n)
          const best = packet.random && packet.remainingCount === 0 && !packet.refunded ? packet.claims.reduce((max, claim) => BigInt(claim.amountMist) > max ? BigInt(claim.amountMist) : max, 0n) : 0n
          packetMap[packet.id] = {
            id: packet.id, sender: packet.sender,
            senderName: packet.sender === normalizeSuiAddress(account) ? "You" : `${packet.sender.slice(0, 6)}...${packet.sender.slice(-4)}`,
            totalAmount: formatMist(packet.totalMist), totalCount: packet.totalCount,
            remainingAmount: formatMist(packet.remainingMist), remainingCount: packet.remainingCount,
            claimedAmount: formatMist(claimedMist.toString()), refunded: packet.refunded,
            packetType: packet.random ? "LUCKY_RANDOM" : "EQUAL", greeting: packet.greeting,
            createdAt: new Date(packet.timestampMs).toISOString(), expiresAt: new Date(packet.expiresAtMs).toISOString(),
            claims: packet.claims.map((claim, index) => ({
              id: `${packet.id}:${index}`, claimer: claim.recipient,
              claimerName: claim.recipient === normalizeSuiAddress(account) ? "You" : `${claim.recipient.slice(0, 6)}...${claim.recipient.slice(-4)}`,
              amount: formatMist(claim.amountMist), isBest: best > 0n && BigInt(claim.amountMist) === best,
              claimedAt: new Date(claim.timestampMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
            })),
            claimedByUser: !!ownClaim, userClaimAmount: ownClaim ? formatMist(ownClaim.amountMist) : undefined,
          }
        }
        setRedPackets(packetMap)
        if (messagesResult.status === "fulfilled") setChatMessages(messagesResult.value.messages.map(message => {
          const packetMatch = message.text.match(/\[redpacket:(0x[0-9a-fA-F]{1,64})\]/)
          return { id: message.id, sender: message.sender === normalizeSuiAddress(account) ? "You" : `${message.sender.slice(0, 6)}...${message.sender.slice(-4)}`, senderAddress: message.sender, role: message.agent === message.sender ? t("groups.membersLabel") : "Subagent", time: new Date(message.timestampMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), at: message.timestampMs, text: groupFileMessageText(message.text).replace(/\s*\[redpacket:0x[0-9a-fA-F]{1,64}\]/, ""), walrusBlobId: message.walrusBlobId, redPacketId: packetMatch?.[1], isSubagent: message.agent !== message.sender }
        }))
        setChatChannelError([...new Set(issues)].join(" "))
      } catch (error) { if (!cancelled) setChatChannelError(error instanceof Error ? error.message : t("groups.readChatFailed")) }
    }
    void loadChat()
    return () => { cancelled = true }
  }, [orgObjectId, loadedGroupId, groupId, chatRefresh, open])

  useEffect(() => {
    const onSwitch = () => {
      actionContext.current.version++
      setChatRefresh(value => value + 1); setChatChannel(null); setChatMessages([])
      setPendingFile(null); setPendingChatReceipt(null); setChainFiles([]); setRedPackets({})
      setIsRedPacketDialogOpen(false); setActiveRedPacketId(null); setTipOpen(false); setTipPaymentOpen(false)
    }
    window.addEventListener("sui-account-switched", onSwitch)
    window.addEventListener("sui-account-changed", onSwitch)
    window.addEventListener("storage", onSwitch)
    return () => { window.removeEventListener("sui-account-switched", onSwitch); window.removeEventListener("sui-account-changed", onSwitch); window.removeEventListener("storage", onSwitch) }
  }, [])

  useEffect(() => {
    setChatMessages([]); setChatNotes([]); setRedPackets({}); setChatInput(""); setClaimedNotice(null)
    setIsRedPacketDialogOpen(false); setActiveRedPacketId(null); setTipOpen(false); setTipPaymentOpen(false); setTipRecipient("")
    try { const saved = JSON.parse(localStorage.getItem(`sui_group_notes_${groupId}`) || "[]"); if (Array.isArray(saved)) setChatNotes(saved.filter((note: { text?: unknown }) => typeof note?.text === "string").map((note: { id: string; sender: string; role: string; time: string; at?: number; text: string; walrusBlobId?: string }) => ({ ...note, at: typeof note.at === "number" ? note.at : 0 }))) } catch {}
    setChatLoadedGroup(groupId)
  }, [groupId])
  useEffect(() => {
    if (!groupId || chatLoadedGroup !== groupId) return
    try { localStorage.setItem(`sui_group_notes_${groupId}`, JSON.stringify(chatNotes)) } catch {}
  }, [groupId, chatLoadedGroup, chatNotes])

  // 打开红包详情/开红包弹窗
  const handleOpenRedPacketClaim = (packetId: string) => {
    setActiveRedPacketId(packetId)
    setRedPacketDialogMode("claim")
    setIsRedPacketDialogOpen(true)
  }

  const actionContext = useRef({ groupId, open, version: 0 })
  if (actionContext.current.groupId !== groupId || actionContext.current.open !== open) actionContext.current = { groupId, open, version: actionContext.current.version + 1 }
  const captureChatAction = () => {
    const account = getTransactionAccount()
    const version = actionContext.current.version
    const assertCurrent = () => {
      assertTransactionAccount(account)
      if (!actionContext.current.open || actionContext.current.version !== version) throw new Error(t("groups.groupAccountSwitched"))
    }
    return {
      account, assertCurrent,
      current: () => { try { assertCurrent(); return true } catch { return false } },
    }
  }
  const refreshChainChat = () => setChatRefresh(value => value + 1)
  const recoverChatResult = async (result: WalletTransactionResult) => {
    const context = captureChatAction()
    const assertReceiptContext = () => {
      context.assertCurrent()
      if (result.receipt.metadata?.groupId !== actionContext.current.groupId || transactionAccountKey(result.receipt.account) !== transactionAccountKey(context.account)) throw new TransactionReceiptError(t("groups.returnGroupAccountForTx"), result.receipt)
    }
    assertReceiptContext()
    if (result.receipt.action === "group-channel-create") {
      const channel = await groupChat.findCreatedChannel(result.createdObjects, result.receipt.metadata?.orgId || orgObjectId, result.receipt.account.address)
      assertReceiptContext()
      try { localStorage.setItem(chatChannelStorageKey(channel.orgId), channel.id) } catch {}
      setChatChannel(channel); setChannelSetupOpen(false)
    } else if (result.receipt.action === "group-packet-create") {
      const packet = await redPacketV2.findCreatedPacket(result.createdObjects, result.receipt.metadata?.channelId || chatChannel?.id || "")
      assertReceiptContext()
      setActiveRedPacketId(packet.id)
    } else if (result.receipt.action === "group-file-anchor") {
      setPendingFile(null)
      setFileReceipt(t("groups.fileShareConfirmed", { p0: result.digest, p1: result.receipt.metadata?.blobId || t("groups.checkChannelRecord") }))
    }
    acknowledgePendingTransaction(result.receipt)
    setPendingChatReceipt(null)
    refreshChainChat()
  }
  const handleResumeChatTransaction = async () => {
    if (!pendingChatReceipt || chatTransactionPending.current) return
    const context = (() => { try { return captureChatAction() } catch (error) { setClaimedNotice(error instanceof Error ? error.message : t("groups.connectOriginalAccountFirst")); return null } })()
    if (!context) return
    chatTransactionPending.current = true; setChatBusy(true)
    try {
      const result = await resumePendingTransaction(pendingChatReceipt)
      context.assertCurrent()
      await recoverChatResult(result)
      setClaimedNotice(t("groups.originalTxConfirmed", { p0: result.digest }))
    } catch (error) {
      if (context.current()) {
        if (error instanceof TransactionReceiptError) setPendingChatReceipt(error.status === "failed" ? null : error.receipt)
        setClaimedNotice(error instanceof Error ? error.message : t("groups.originalTxQueryFailed"))
      }
    } finally { chatTransactionPending.current = false; setChatBusy(false) }
  }
  const runChatTransaction = async (build: () => Transaction, success: string, options?: WalletTransactionOptions) => {
    if (chatTransactionPending.current) throw new Error(t("groups.chatTxInFlight"))
    if (pendingChatReceipt) throw new TransactionReceiptError(t("groups.queryOriginalChatTxFirst"), pendingChatReceipt)
    const account = getActiveAccount()
    if (!account) throw new Error(t("groups.connectWalletFirst"))
    const context = captureChatAction()
    chatTransactionPending.current = true
    setChatBusy(true); setClaimedNotice(null)
    let confirmed: WalletTransactionResult | undefined
    try {
      confirmed = await signAndExecuteWithWallet(build(), options || { action: "group-chat", scope: orgObjectId, expectedAccount: account, metadata: { groupId, orgId: orgObjectId } })
      context.assertCurrent()
      await recoverChatResult(confirmed)
      setClaimedNotice(t("groups.actionConfirmed", { p0: success, p1: confirmed.digest }))
      return confirmed
    } catch (error) {
      if (context.current()) {
        if (confirmed) setPendingChatReceipt(confirmed.receipt)
        else if (error instanceof TransactionReceiptError) setPendingChatReceipt(error.status === "failed" ? null : error.receipt)
        setClaimedNotice(confirmed ? t("groups.txConfirmedRetryData", { p0: confirmed.digest, p1: error instanceof Error ? error.message : t("groups.readFailed") }) : error instanceof Error ? error.message : t("groups.chainTxFailed"))
      }
      throw error
    } finally { chatTransactionPending.current = false; setChatBusy(false) }
  }
  const handleClaimRedPacket = async (packetId: string) => {
    const context = captureChatAction()
    if (!chatChannel?.isMember) throw new Error(t("groups.notChannelMember"))
    if (!redPackets[packetId]) throw new Error(t("groups.refreshPacketSourceFirst"))
    const packet = await redPacketV2.readPacket(packetId, chatChannel.id)
    if (packet.refunded || packet.remainingCount < 1 || Date.now() > packet.expiresAtMs || packet.claims.some(claim => claim.recipient === context.account.address)) throw new Error(t("groups.packetGoneRefresh"))
    const tx = await redPacketV2.buildClaim({ sender: context.account.address, packetId, channelId: chatChannel.id, coinType: "0x2::sui::SUI", isRandom: packet.random })
    context.assertCurrent()
    await runChatTransaction(() => tx, t("groups.packetClaimTx"), { action: "group-redpacket-claim", scope: packetId, expectedAccount: context.account, metadata: { groupId, channelId: chatChannel.id, packetId } })
  }
  const handleCreateRedPacket = async (params: { totalAmount: string; totalCount: number; packetType: "LUCKY_RANDOM" | "EQUAL"; greeting: string; durationHours: number }) => {
    const context = captureChatAction()
    if (!chatChannel?.isMember) throw new Error(t("groups.notChannelMemberNoPacket"))
    const tx = await redPacketV2.buildCreate({ sender: context.account.address, channelId: chatChannel.id, coinType: "0x2::sui::SUI", amount: suiMist(params.totalAmount), count: params.totalCount, isRandom: params.packetType === "LUCKY_RANDOM", greeting: params.greeting, durationMs: BigInt(params.durationHours) * 3_600_000n })
    context.assertCurrent()
    await runChatTransaction(() => tx, t("groups.packetV2CreateTx"), { action: "group-packet-v2-create", scope: chatChannel.id, expectedAccount: context.account, metadata: { groupId, channelId: chatChannel.id } })
  }
  const handleRefundRedPacket = async (packetId: string) => {
    const context = captureChatAction()
    if (!chatChannel) throw new Error(t("groups.noChannelYet"))
    if (!redPackets[packetId]) throw new Error(t("groups.refreshPacketSourceFirst"))
    const packet = await redPacketV2.readPacket(packetId, chatChannel.id)
    if (packet.sender !== context.account.address) throw new Error(t("groups.onlySenderRefund"))
    if (Date.now() <= packet.expiresAtMs || packet.refunded || packet.remainingCount < 1) throw new Error(t("groups.packetNotRefundable"))
    const tx = await redPacketV2.buildRefund({ sender: context.account.address, packetId, coinType: "0x2::sui::SUI" })
    context.assertCurrent()
    await runChatTransaction(() => tx, t("groups.packetRefundTx"), { action: "group-redpacket-refund", scope: packetId, expectedAccount: context.account, metadata: { groupId, channelId: chatChannel.id, packetId } })
  }

  const handleCreateChannel = async () => {
    const context = captureChatAction()
    const address = context.account.address
    if (!orgObjectId) throw new Error(t("groups.noOrgNoChannel"))
    const stake = channelStake.trim() ? suiMist(channelStake) : 0n
    const entryFee = suiMist(channelEntryFee || "0", true)
    const memberStake = suiMist(channelMemberStake || "0", true)
    const shares = [channelCreatorShare, channelGasShare, channelMemberShare].map(value => Number(value))
    if (entryFee > 0n || memberStake > 0n) {
      if (stake === 0n) throw new Error(t("groups.memberChannelPositiveStake"))
      if (shares.some(value => !Number.isInteger(value) || value < 0) || shares.reduce((sum, value) => sum + value, 0) !== 10000) throw new Error(t("groups.bpsMustSum10000"))
      await groupChat.ensureFunction("create_creator_monetized_channel")
    }
    await groupChat.ensureFunction(entryFee > 0n || memberStake > 0n ? "create_creator_monetized_channel" : stake > 0n ? "create_channel_with_stake" : "create_channel")
    context.assertCurrent()
    await runChatTransaction(() => entryFee > 0n || memberStake > 0n
      ? vaultClient.buildCreateMembershipChatChannelPTB(orgObjectId, group.name, stake, entryFee, memberStake, shares as [number, number, number])
      : stake > 0n
        ? vaultClient.buildCreateStakedChatChannelPTB(orgObjectId, group.name, [address], stake)
        : vaultClient.buildCreateChatChannelPTB(orgObjectId, group.name, [address]), t("groups.channelCreateTx"), { action: "group-channel-create", scope: orgObjectId, expectedAccount: context.account, metadata: { groupId, orgId: orgObjectId } })
  }
  const handleJoinChannel = async () => {
    const context = captureChatAction()
    if (!chatChannel) throw new Error(t("groups.noChannelYet"))
    await groupChat.ensureFunction("join_channel_entry")
    context.assertCurrent()
    // 应付总额 = 门票 + 保本质押（合约 join_channel_with_stake_and_fee 的 total_required）
    const joinPayment = suiMist(chatChannel.entryFee) + suiMist(chatChannel.memberStake)
    await runChatTransaction(() => vaultClient.buildJoinChatChannelPTB(chatChannel.id, joinPayment), t("groups.channelJoinTx"), { action: "group-channel-join", scope: chatChannel.id, expectedAccount: context.account, metadata: { groupId, channelId: chatChannel.id } })
  }

  const handleTip = () => {
    setTipOpen(false)
    if (!tipRecipient.trim()) { setClaimedNotice(t("groups.enterMemberAddressFirst")); return }
    setTipPaymentOpen(true)
  }

  const handleTriggerSlash = async (cmd: string) => {
    setShowSlashMenu(false)
    setChatInput("")
    if (cmd === "/redpacket") {
      setRedPacketDialogMode("create")
      setIsRedPacketDialogOpen(true)
    } else if (cmd === "/tip") {
      setTipOpen(true)
    } else if (cmd === "/app") {
      setIsAppSandboxOpen(true)
    } else if (cmd === "/stats") {
      setClaimedNotice(treasury.data?.vaults.length
        ? t("groups.vaultsVerifiedSummary", { p0: treasury.data.vaults.length, p1: groupBalance === null ? "" : t("groups.suiCustodyTotalSuffix", { p0: groupBalance }), p2: treasury.data.errors.length || treasury.data.truncated || treasury.data.discoveryError ? t("groups.readIncompleteSeePayments") : t("groups.otherCoinsSeePayments") })
        : treasury.error || t("groups.noVaultsSeePayments"))
    } else if (cmd === "/help") {
      setClaimedNotice(t("groups.chatInputHint"))
    }
  }

  // Chain messages share one PTB per burst; /note stays device-only.
  //
  // Two entry points exist for a burst:
  // - `post_message_batch` (in the local source tree only, not yet in the v4
  //   testnet package): one event per line, but one shared-object mutation and
  //   one gas rebate for the whole burst.
  // - `post_message` per line in a single PTB: the deployed fallback. It still
  //   saves the transaction envelope (signature, certificate, gas coin), which
  //   dominates the cost of a one-line message, but each line keeps its own
  //   rebate transfer.
  // The probe fails closed to the fallback, so an undeployed batch entry point
  // can slow the burst down but never blocks sending.
  const flushChatOutbox = async () => {
    if (outboxFlushing.current || chatBusy || pendingChatReceipt) return
    const channel = chatChannelRef.current
    if (!channel?.isMember) return
    const texts = takeChatOutbox(channel.id)
    if (texts.length === 0) { setOutboxCount(0); return }
    outboxFlushing.current = true
    try {
      const context = captureChatAction()
      await groupChat.ensureFunction("post_message")
      const batched = await groupChat.supportsFunction("post_message_batch")
      if (batched) await groupChat.ensureFunction("post_message_batch")
      context.assertCurrent()
      await runChatTransaction(
        () => batched ? vaultClient.buildPostChatMessageBatchPTB(channel.id, texts) : vaultClient.buildPostChatMessagesPTB(channel.id, texts),
        texts.length > 1 ? t("groups.chatMessageCount", { p0: texts.length }) : t("groups.groupMessageKind"),
        { action: "group-message-post", scope: `${channel.id}:${texts.join("\u0000")}`, expectedAccount: context.account, metadata: { groupId, channelId: channel.id, messageCount: String(texts.length), batchEntry: batched ? "post_message_batch" : "post_message_ptb" } },
      )
      setOutboxCount(peekChatOutbox(channel.id).length)
    } catch (error) {
      restoreChatOutbox(channel.id, texts)
      setOutboxCount(peekChatOutbox(channel.id).length)
      setClaimedNotice(error instanceof Error ? error.message : t("groups.groupMessageSendFailed"))
    } finally {
      outboxFlushing.current = false
      // A line typed while the wallet prompt was open must not wait for another Enter.
      if (peekChatOutbox(channel.id).length > 0 && !chatTransactionPending.current) scheduleOutboxFlush()
    }
  }
  const scheduleOutboxFlush = () => {
    if (outboxTimer.current) clearTimeout(outboxTimer.current)
    outboxTimer.current = setTimeout(() => { outboxTimer.current = null; void flushOutboxRef.current() }, OUTBOX_FLUSH_DELAY_MS)
  }
  // The timer callback outlives the render that scheduled it, so it must call the
  // latest flush closure (fresh channel/account) instead of a stale one.
  useEffect(() => { flushOutboxRef.current = flushChatOutbox })

  useEffect(() => () => { if (outboxTimer.current) clearTimeout(outboxTimer.current) }, [])

  const handleSendMessage = async () => {
    const textToSend = chatInput.trim()
    if (!textToSend || chatBusy) return
    if (textToSend.startsWith("/")) {
      const [cmdName, ...rest] = textToSend.split(" ")
      if (cmdName.toLowerCase() === "/note") {
        const note = rest.join(" ").trim()
        if (note) setChatNotes(prev => [...prev, { id: `note_${Date.now()}`, sender: "You", role: t("groups.localNoteKind"), time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), at: Date.now(), text: note }])
        setChatInput("")
        return
      }
      if (["/redpacket", "/tip", "/app", "/stats", "/help"].includes(cmdName.toLowerCase())) { await handleTriggerSlash(cmdName.toLowerCase()); return }
    }
    if (!chatChannel?.isMember) { setClaimedNotice(t("groups.notMemberCreateOrJoin")); return }
    try {
      const queued = enqueueChatMessage(chatChannel.id, textToSend)
      setChatInput(current => current === textToSend ? "" : current)
      setOutboxCount(queued.queued)
      if (queued.full) {
        if (outboxTimer.current) { clearTimeout(outboxTimer.current); outboxTimer.current = null }
        void flushChatOutbox()
        return
      }
      scheduleOutboxFlush()
    } catch (error) { setClaimedNotice(error instanceof Error ? error.message : t("groups.groupMessageSendFailed")) }
  }

  const publishFile = async (pending: { file: GroupFileInfo; channelId: string; sender: string }) => {
    const context = captureChatAction()
    if (!chatChannel || chatChannel.id !== pending.channelId || !chatChannel.isMember) throw new Error(t("groups.returnChannelToShare"))
    if (context.account.address !== pending.sender) throw new Error(t("groups.accountSwitchedShareFile"))
    const channel = await groupChat.readChannel(pending.channelId, orgObjectId, pending.sender)
    if (!channel.isMember) throw new Error(t("groups.noLongerChannelMember"))
    await groupChat.ensureFunction("post_message")
    context.assertCurrent()
    const result = await runChatTransaction(() => {
      const tx = vaultClient.buildPostChatMessagePTB(channel.id, encodeGroupFilePreview(pending.file), pending.file.blobId)
      tx.setSender(pending.sender)
      return tx
    }, t("groups.fileShareTx"), { action: "group-file-anchor", scope: `${pending.channelId}:${pending.file.blobId}`, expectedAccount: context.account, metadata: { groupId, channelId: pending.channelId, blobId: pending.file.blobId, name: pending.file.name, size: String(pending.file.size), contentType: pending.file.contentType } })
    setPendingFile(null)
    setFileReceipt(t("groups.fileShareConfirmed", { p0: result.digest, p1: pending.file.blobId }))
  }

  const handleRetryFileShare = async () => {
    if (!pendingFile || fileUploadPending.current) return
    fileUploadPending.current = true
    setIsUploadingFile(true)
    try { await publishFile(pendingFile) }
    catch (error) { setFileError(t("groups.uploadedSharePending", { p0: pendingFile.file.blobId, p1: error instanceof Error ? error.message : t("groups.retryShare") })) }
    finally { fileUploadPending.current = false; setIsUploadingFile(false) }
  }

  // Upload once; a failed wallet confirmation retries only the on-chain reference.
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file || fileUploadPending.current) return
    fileUploadPending.current = true
    setIsUploadingFile(true); setFileError(""); setFileReceipt("")
    let uploaded: GroupFileInfo | null = null
    let context: ReturnType<typeof captureChatAction> | undefined
    try {
      context = captureChatAction()
      if (!chatChannel?.isMember) throw new Error(t("groups.joinChannelBeforeUpload"))
      const sender = context.account.address
      const channelId = chatChannel.id
      encodeGroupFilePreview({ name: file.name, size: file.size, contentType: file.type || "application/octet-stream" })
      await groupChat.ensureFunction("post_message")
      context.assertCurrent()
      const res = await uploadToWalrus(file, { filename: file.name, contentType: file.type || "application/octet-stream" })
      uploaded = {
        id: `wf_${crypto.randomUUID()}`, groupId, name: file.name, size: file.size,
        blobId: res.blobId, uploader: sender, uploadedAt: res.uploadedAt,
        contentType: res.contentType, url: res.url, source: "local", channelId,
      }
      const pending = { file: uploaded, channelId, sender }
      try { addGroupWalrusFile(groupId, uploaded) }
      catch (error) { if (context.current()) setFileError(error instanceof Error ? error.message : t("groups.localIndexMissing", { p0: res.blobId })) }
      context.assertCurrent()
      setPendingFile(pending)
      setFileReceipt(t("groups.publisherBlobReady", { p0: res.blobId }))
      setGroupFiles(current => current.some(value => value.id === uploaded!.id) ? current : [uploaded!, ...current])
      await publishFile(pending)
    } catch (error) {
      if (!context || context.current()) setFileError(uploaded
        ? t("groups.uploadedGroupSharePending", { p0: uploaded.blobId, p1: error instanceof Error ? error.message : t("groups.retryShare") })
        : t("groups.uploadFailedDetail", { p0: error instanceof Error ? error.message : t("groups.requestFailed") }))
    } finally {
      fileUploadPending.current = false
      setIsUploadingFile(false)
      if (fileInputRef.current) fileInputRef.current.value = ""
    }
  }

  const visibleGroupFiles = [
    ...chainFiles,
    ...groupFiles.filter(file => !chainFiles.some(shared => shared.blobId === file.blobId)),
  ]

  // 构建真实的群组信息
  const group = realGroupData
    ? {
        id: groupId,
        name: realGroupData.name || t("groups.unnamedGroup"),
        description: realGroupData.description || "Sui MultiSig Multi-Signature Group",
        address: realGroupData.orgObjectId || orgObjectId || "",
        network: realGroupData.network || "Sui Testnet",
        balance: groupBalance,
        token: "SUI",
        creator: realGroupData.members?.[0]?.address || "",
        creatorName: "You",
        members: realGroupData.chainMembers
          ? Object.entries(realGroupData.chainMembers).map(([address, weight]) => {
              const noted = realGroupData.members?.find((member) => { try { return normalizeSuiAddress(member.address) === address } catch { return false } })
              // A verified member the user never named locally has no note name.
              // Empty, not a placeholder: the row falls back to the address, so a
              // missing note is visible as one rather than looking like a name.
              return { address, weight, name: noted?.name ?? "" }
            })
          : realGroupData.members || [],
        threshold: realGroupData.chainThreshold ?? realGroupData.threshold ?? 0,
        totalWeight: realGroupData.chainMembers ? Object.values(realGroupData.chainMembers).reduce((sum, weight) => sum + BigInt(weight), 0n).toString() : realGroupData.totalWeight ?? 0,
        transactions: realProposals.filter(p => p.groupId === groupId || p.orgId === (realGroupData.orgObjectId || orgObjectId)),
        color: "from-primary to-purple-500",
      }
    : {
        id: groupId, name: t("groups.groupNotFound"), description: "", address: "", network: "Sui Testnet",
        balance: groupBalance, token: "SUI", creator: "", creatorName: "", members: [],
        threshold: 0, totalWeight: 0, transactions: [], color: "from-primary to-purple-500",
      }

  const chainOrgId = loadedGroupId === groupId ? (realGroupData?.orgObjectId || orgObjectId || "") : ""
  const validGroupAddress = /^0x[0-9a-fA-F]{1,64}$/.test(chainOrgId) ? chainOrgId : ""
  const memberAddresses = group.members.map((member) => typeof member?.address === "string" ? member.address : "").filter((value) => /^0x[0-9a-fA-F]{1,64}$/.test(value))
  // On-chain avatars for members, when they minted a protocol identity. Local
  // note names stay authoritative for display names; identity only adds avatar.
  const memberProfiles = useMemberProfiles(memberAddresses)
  // Chat senders are channel members, which can include addresses absent from
  // the local member notes. Resolve them separately instead of reusing the
  // member list, so a sender outside the note set still gets an avatar.
  const chatSenderAddresses = [
    ...chatMessages.filter(message => message.sender !== "You").map(message => message.senderAddress ?? ""),
    ...ssm.rows.map(row => row.sender),
  ].filter((value): value is string => /^0x[0-9a-fA-F]{1,64}$/.test(value))
  const senderProfiles = useMemberProfiles(chatSenderAddresses)
  const shortAddress = validGroupAddress ? `${validGroupAddress.slice(0, 6)}...${validGroupAddress.slice(-4)}` : t("groups.orgNotCreatedYet")

  // Both transports project into the same row shape so the chat tab has one
  // list. Roles carry the difference: 成员 / Subagent / AI / 本机笔记.
  const chainRows: UnifiedChatRow[] = chatMessages.map(message => ({
    key: `chain:${message.id}`,
    transport: "onchain" as const,
    at: message.at,
    mine: message.sender.startsWith("You"),
    sender: message.sender,
    role: message.role,
    time: message.time,
    avatarUrl: message.senderAddress ? senderProfiles.profiles[message.senderAddress.toLowerCase()]?.avatarUrl : undefined,
    text: message.text,
    walrusBlobId: message.walrusBlobId,
    redPacketId: message.redPacketId,
  })).sort((left, right) => (left.at ?? 0) - (right.at ?? 0))
  const ssmRows: UnifiedChatRow[] = ssm.rows.map(row => ({
    key: `ssm:${row.id}`,
    transport: "ssm" as const,
    at: row.createdAt,
    mine: !!agentAccount && normalizeSuiAddress(row.sender) === normalizeSuiAddress(agentAccount),
    sender: agentAccount && normalizeSuiAddress(row.sender) === normalizeSuiAddress(agentAccount) ? "You" : `${row.sender.slice(0, 6)}…${row.sender.slice(-4)}`,
    role: t("groups.encryptedMembers"),
    time: new Date(row.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    text: row.text,
    senderVerified: row.senderVerified,
    deleted: row.deleted,
    edited: row.edited,
    avatarUrl: senderProfiles.profiles[row.sender.toLowerCase()]?.avatarUrl,
  }))

  const sendOnActiveTransport = async () => {
    const textToSend = chatInput.trim()
    if (!textToSend) return
    if (chatTransport === "ssm") {
      if (readOnly) return
      try {
        await ssm.send(textToSend)
        setChatInput(current => current === textToSend ? "" : current)
      } catch (error) { setClaimedNotice(describeSsmError(error)) }
      return
    }
    await handleSendMessage()
  }

  if (readOnly && realGroupData && loadedGroupId === groupId) {
    const readOnlyBody = (
      <div className="space-y-4 p-6 bg-card border border-border rounded-2xl shadow-sm">
        <div>
          <h2 className="text-xl font-bold">{group.name}</h2>
          <p className="text-xs text-muted-foreground mt-1">{t("groups.readOnlyViewNotice")}</p>
        </div>
        <div className="space-y-3">
          <p className="break-all font-mono text-xs bg-muted/50 p-2 rounded-lg">{validGroupAddress || t("groups.groupNoOrgYet")}</p>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" disabled={!validGroupAddress} onClick={() => setShareQrOpen(true)}>
              <QrCode className="mr-2 h-4 w-4" />{t("groups.shareGroupQr")}
            </Button>
            <Button variant="outline" size="sm" onClick={() => setIsAppSandboxOpen(true)}>
              <Vote className="mr-2 h-4 w-4" />{t("groups.readOnlyVotes")}
            </Button>
          </div>
        </div>
        <GroupTreasury groupId={groupId} orgId={validGroupAddress} readOnly data={treasury.data} error={treasury.error} loading={treasury.loading} reload={treasury.reload} />
      </div>
    )

    if (isDialog) {
      return (
        <Dialog open={open} onOpenChange={onOpenChange}>
          <DialogContent className="w-[calc(100%-2rem)] max-w-lg max-h-[90dvh] overflow-y-auto rounded-xl">
            {readOnlyBody}
          </DialogContent>
          <ShareQrDialog open={shareQrOpen && !!validGroupAddress} onOpenChange={setShareQrOpen} title={t("groups.qrTitleSuffix", { p0: group.name })} kind="group" identifier={validGroupAddress} description={t("groups.scanViewOnlyOrg")} />
          <WalrusAppSandboxDialog open={isAppSandboxOpen} onOpenChange={setIsAppSandboxOpen} groupId={groupId} orgId={validGroupAddress} readOnly />
        </Dialog>
      )
    }

    return (
      <div className="w-full space-y-4">
        {readOnlyBody}
        <ShareQrDialog open={shareQrOpen && !!validGroupAddress} onOpenChange={setShareQrOpen} title={t("groups.qrTitleSuffix", { p0: group.name })} kind="group" identifier={validGroupAddress} description={t("groups.scanViewOnlyOrg")} />
        <WalrusAppSandboxDialog open={isAppSandboxOpen} onOpenChange={setIsAppSandboxOpen} groupId={groupId} orgId={validGroupAddress} readOnly />
      </div>
    )
  }

  // Remote organizations are presented as a read-only record, never as the demo treasury.
  if (loadedGroupId !== groupId || !realGroupData) {
    const remoteBody = (
      <div className="space-y-4 p-6 bg-card border border-border rounded-2xl shadow-sm">
        <h2 className="text-xl font-bold">{t("groups.orgDetailsTitle")}</h2>
        {loadedGroupId !== groupId || chainLoading ? (
          <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin text-primary" />
            <span>{t("groups.readingOrg")}</span>
          </div>
        ) : chainError || !chainGroup ? (
          <p role="alert" className="text-sm text-destructive py-4">{chainError || t("groups.orgNotFound")}</p>
        ) : (
          <div className="space-y-3">
            <p className="break-all font-mono text-xs bg-muted/50 p-2 rounded-lg">{chainGroup.id}</p>
            <Badge variant="outline">Epoch {chainGroup.epoch}</Badge>
            <p className="text-sm text-muted-foreground">{t("groups.orgNotLocalNotice")}</p>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={() => setShareQrOpen(true)}><QrCode className="mr-2 h-4 w-4" />{t("groups.groupQrLabel")}</Button>
              <Button variant="outline" size="sm" onClick={() => setIsAppSandboxOpen(true)}><Vote className="mr-2 h-4 w-4" />{t("groups.readOnlyVotes")}</Button>
              <Button variant="outline" size="sm" asChild><a href={`https://suiscan.xyz/testnet/object/${chainGroup.id}`} target="_blank" rel="noreferrer">{t("groups.viewOnchainObject")}</a></Button>
            </div>
            <GroupTreasury groupId={groupId} orgId={chainGroup.id} readOnly data={treasury.data} error={treasury.error} loading={treasury.loading} reload={treasury.reload} />
          </div>
        )}
      </div>
    )

    if (isDialog) {
      return (
        <Dialog open={open} onOpenChange={onOpenChange}>
          <DialogContent className="w-[calc(100%-2rem)] max-w-lg max-h-[90dvh] overflow-y-auto rounded-xl">
            {remoteBody}
          </DialogContent>
          <WalrusAppSandboxDialog open={isAppSandboxOpen} onOpenChange={setIsAppSandboxOpen} groupId={groupId} orgId={chainGroup?.id} readOnly />
          {chainGroup && <ShareQrDialog open={shareQrOpen} onOpenChange={setShareQrOpen} title={t("groups.orgQrTitle")} kind="group" identifier={chainGroup.id} description={t("groups.scanViewOnlyTransfer")} />}
        </Dialog>
      )
    }

    return (
      <div className="w-full space-y-4">
        {remoteBody}
        <WalrusAppSandboxDialog open={isAppSandboxOpen} onOpenChange={setIsAppSandboxOpen} groupId={groupId} orgId={chainGroup?.id} readOnly />
        {chainGroup && <ShareQrDialog open={shareQrOpen} onOpenChange={setShareQrOpen} title={t("groups.orgQrTitle")} kind="group" identifier={chainGroup.id} description={t("groups.scanViewOnlyTransfer")} />}
      </div>
    )
  }

  return (
    <div className={`w-full flex flex-col ${isDialog ? "max-h-[85vh] overflow-hidden" : "space-y-6"}`}>
      <div className={`w-full overflow-hidden rounded-2xl border border-border bg-card shadow-sm flex flex-col ${isDialog ? "flex-1 overflow-hidden" : ""}`}>
        {/* 隐藏的真实文件选择器 */}
        <input
          type="file"
          ref={fileInputRef}
          onChange={handleFileUpload}
          className="hidden"
          accept="*/*"
        />

        <div className={`relative ${isDialog ? "h-24 p-4" : "h-32 p-6"} bg-gradient-to-r ${group.color} flex flex-col justify-end`}>
          {/* Scrim under the white text. The palette includes light endpoints
              (`to-cyan-400`, `to-amber-400`) that put white text at 1.7-1.9:1
              on their own; black/45 lifts the worst endpoint above 5:1 in both
              themes without changing the gradient the user chose. */}
          <div className="absolute inset-0 bg-black/45" aria-hidden />
          <DialogAwareHeader isDialog={isDialog} className="relative text-white">
            <span className="text-xl font-bold">{group.name}</span>
            <Badge variant="outline" className="bg-white/20 text-white border-white/40">
              {group.network}
            </Badge>
            <p className="text-white/80 text-xs mt-1 truncate">{group.description}</p>
            <p className="text-white/80 text-xs">{realGroupData.sourceStatus === "chain-confirmed" ? t("groups.orgVerifiedBadge") : t("groups.localRecordBadge")}</p>
          </DialogAwareHeader>
        </div>

        <div className="p-4 space-y-4 overflow-y-auto">
          <div className="flex items-center justify-between">
            <div className="flex items-center">
              <Avatar className="h-10 w-10 mr-3 border-2 border-background">
                <AvatarFallback className="bg-gradient-to-br from-primary to-purple-500 text-white">
                  {group.name[0]}
                </AvatarFallback>
              </Avatar>
              <div>
                <div className="flex items-center">
                  <p className="text-sm font-medium mr-1">{shortAddress}</p>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    disabled={!validGroupAddress}
                    aria-label={t("groups.copyOrgId")}
                    onClick={() => {
                      if (validGroupAddress) navigator.clipboard?.writeText(validGroupAddress).catch(() => setChainError(t("groups.copyOrgIdFailed")))
                    }}
                  >
                    <Copy className="h-3 w-3" />
                  </Button>
                  {validGroupAddress && <a
                    href={`https://suiscan.xyz/testnet/object/${validGroupAddress}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-muted-foreground hover:text-foreground"
                    aria-label={t("groups.viewOnchainOrg")}
                  >
                    <ExternalLink className="h-3 w-3 ml-1" />
                  </a>}
                </div>
                <p className="text-xs text-muted-foreground">{t("groups.localGroupInfoTitle")}</p>
              </div>
            </div>
            <div className="text-right">
              <p className="font-semibold text-sm">
                {group.balance === null ? balanceError : `${group.balance} SUI`}
              </p>
              <p className="text-[10px] text-muted-foreground">{group.balance !== null && (treasury.data?.errors.length || treasury.data?.truncated || treasury.data?.discoveryError) ? t("groups.partialVerifiedSui") : t("groups.verifiedSui")}</p>
              <div className="flex items-center text-xs text-muted-foreground justify-end">
                {/* Threshold comes from the chain read; the local record is only a
                    note. Directly under "已核验 SUI 托管余额", an unlabelled local
                    threshold would borrow that verification. */}
                <span>
                  {chainGroup ? t("groups.thresholdRatio", { p0: group.threshold, p1: group.totalWeight }) : t("groups.thresholdUnverifiedSuffix", { p0: group.threshold || group.totalWeight ? t("groups.localThresholdNote", { p0: group.threshold, p1: group.totalWeight }) : "" })}
                </span>
              </div>
            </div>
          </div>

          <Tabs defaultValue="chat" value={activeTab} onValueChange={setActiveTab} className="w-full">
            {/* Tabs must never rely on horizontal scrolling: the scrollbar is
                hidden on mobile (scrollbar-none), so clipped tabs are
                undiscoverable and unreachable by tap. Letting the list wrap
                keeps every tab visible and tappable at any width. */}
            <TabsList className="flex w-full flex-wrap items-center gap-1.5 p-1.5 bg-muted/60 rounded-xl text-xs md:text-sm font-medium">
              <TabsTrigger
                value="chat"
                className="flex-1 min-w-0 py-1.5 px-1 sm:py-2 sm:px-2.5 sm:min-w-[70px] md:min-w-[80px] rounded-lg data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm transition-all flex items-center justify-center gap-1.5 font-medium"
              >
                <MessageSquare className="hidden sm:block h-3 w-3 mr-0.5 text-primary" />
                {t("groups.tabChat")}</TabsTrigger>
              <TabsTrigger
                value="members"
                className="flex-1 min-w-0 py-1.5 px-1 sm:py-2 sm:px-2.5 sm:min-w-[70px] md:min-w-[80px] rounded-lg data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm transition-all flex items-center justify-center gap-1.5"
              >
                <Users className="hidden sm:block h-3 w-3 mr-0.5" />
                {t("groups.membersLabel")}</TabsTrigger>
              <TabsTrigger
                value="agents"
                className="flex-1 min-w-0 py-1.5 px-1 sm:py-2 sm:px-2.5 sm:min-w-[70px] md:min-w-[80px] rounded-lg data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm transition-all flex items-center justify-center gap-1.5"
              >
                <Bot className="hidden sm:block h-3 w-3 mr-0.5 text-purple-500" />
                AI
              </TabsTrigger>
              <TabsTrigger
                value="files"
                className="flex-1 min-w-0 py-1.5 px-1 sm:py-2 sm:px-2.5 rounded-lg data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm font-medium"
              >
                <HardDrive className="hidden sm:block h-3 w-3 mr-0.5 text-cyan-500" />
                {t("groups.tabFiles")}</TabsTrigger>
              <TabsTrigger
                value="transactions"
                className="flex-1 min-w-0 py-1.5 px-1 sm:py-2 sm:px-2.5 sm:min-w-[70px] md:min-w-[80px] rounded-lg data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm transition-all flex items-center justify-center gap-1.5"
              >
                <Share2 className="hidden sm:block h-3 w-3 mr-0.5" />
                Tx
              </TabsTrigger>
              <TabsTrigger
                value="receive"
                className="flex-1 min-w-0 py-1.5 px-1 sm:py-2 sm:px-2.5 sm:min-w-[70px] md:min-w-[80px] rounded-lg data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm transition-all flex items-center justify-center gap-1.5"
              >
                <QrCode className="hidden sm:block h-3 w-3 mr-0.5" />
                {t("groups.tabPayments")}</TabsTrigger>
              <TabsTrigger
                value="yield"
                className="flex-1 min-w-0 py-1.5 px-1 sm:py-2 sm:px-2.5 sm:min-w-[70px] md:min-w-[80px] rounded-lg data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm transition-all flex items-center justify-center gap-1.5"
              >
                <Sprout className="hidden sm:block h-3 w-3 mr-0.5 text-emerald-500" />
                {t("groups.tabYield")}</TabsTrigger>
              <TabsTrigger
                value="custody"
                className="flex-1 min-w-0 py-1.5 px-1 sm:py-2 sm:px-2.5 sm:min-w-[70px] md:min-w-[80px] rounded-lg data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm transition-all flex items-center justify-center gap-1.5"
              >
                <Landmark className="hidden sm:block h-3 w-3 mr-0.5 text-amber-500" />
                {t("groups.tabCustody")}</TabsTrigger>
            </TabsList>

            <AnimatePresence mode="wait">
              {/* 1. 本机笔记 Tab */}
              {activeTab === "chat" && (
                <TabsContent value="chat" className="mt-3 space-y-3">
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    transition={{ duration: 0.2 }}
                    className="space-y-3"
                  >
                    {/* 顶部简洁状态栏：一个会话，两种传输 */}
                    <div className="px-3 py-2 rounded-xl bg-muted/40 border border-border/50 text-xs space-y-2">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center space-x-2">
                          <span className={`w-2 h-2 rounded-full ${chatTransport === "ssm" ? "bg-emerald-500" : "bg-emerald-500"}`}></span>
                          <span className="text-[11px] text-muted-foreground">
                            {chatTransport === "onchain"
                              ? chatChannel ? t("groups.onchainChannelBadge", { p0: chatChannel.isMember ? t("groups.joinedLabel") : t("groups.notJoinedLabel") }) : chatChannelUnresolved ? t("groups.channelUnconfirmed") : t("groups.channelNotConfigured")
                              : ssm.status.configured ? t("groups.e2eBadge", { p0: ssm.status.relayerSource === "local" ? t("groups.localRelayer") : t("groups.envRelayer") }) : t("groups.e2eNoRelayer")}
                          </span>
                        </div>
                        <div className="flex items-center space-x-1.5">
                          {chatTransport === "onchain" ? <>
                            <Button size="sm" variant="ghost" onClick={refreshChainChat} disabled={chatBusy} className="h-6 text-[10px] px-2">{t("groups.refresh")}</Button>
                            {!chatChannel && !chatChannelUnresolved && validGroupAddress && <Button size="sm" variant="outline" onClick={() => setChannelSetupOpen(true)} disabled={chatBusy} className="h-6 text-[10px] px-2">{t("groups.createChannel")}</Button>}
                            {!chatChannel && chatChannelUnresolved && validGroupAddress && <Button size="sm" variant="outline" onClick={() => setChannelSetupOpen(true)} disabled={chatBusy} className="h-6 text-[10px] px-2">{t("groups.createChannelAnyway")}</Button>}
                            {chatChannel && !chatChannel.isMember && <Button size="sm" variant="outline" onClick={() => void handleJoinChannel().catch(error => setClaimedNotice(error instanceof Error ? error.message : t("groups.joinChannelFailed")))} disabled={chatBusy} className="h-6 text-[10px] px-2">{t("groups.joinChannel")}</Button>}
                          </> : <>
                            <Button size="sm" variant="ghost" className="h-6 text-[10px] px-2" disabled={ssm.loadingRows} onClick={() => void ssm.load()}>{t("groups.refresh")}</Button>
                            <Button size="sm" variant="ghost" className={`h-6 px-2 text-[10px] ${ssmSettingsOpen ? "text-primary" : ""}`} onClick={() => setSsmSettingsOpen(value => !value)}><Settings2 className="h-3 w-3 mr-0.5" />{t("groups.settingsLabel")}</Button>
                          </>}
                        </div>
                      </div>
                      {/* 传输切换：只决定这条消息怎么送，不改变界面结构。两者成员域不同，
                          所以并列显示而不是按时间混排——混排会让看不到的一侧静默缺消息。 */}
                      <div className="flex items-center gap-1 rounded-lg bg-background/60 p-0.5 border border-border/40" role="group" aria-label={t("groups.messageTransport")}>
                        <button
                          type="button" aria-pressed={chatTransport === "onchain"}
                          onClick={() => setChatTransport("onchain")}
                          className={`flex-1 rounded-md px-2 py-1 text-[10px] transition-colors ${chatTransport === "onchain" ? "bg-background shadow-sm text-foreground font-medium" : "text-muted-foreground"}`}
                        >{t("groups.onchainChannelLabel")}</button>
                        <button
                          type="button" aria-pressed={chatTransport === "ssm"}
                          onClick={() => setChatTransport("ssm")}
                          className={`flex-1 rounded-md px-2 py-1 text-[10px] transition-colors flex items-center justify-center gap-1 ${chatTransport === "ssm" ? "bg-background shadow-sm text-foreground font-medium" : "text-muted-foreground"}`}
                        ><Lock className="h-3 w-3" />{t("groups.e2eLabel")}<span className="text-[9px] opacity-70">Beta</span></button>
                      </div>
                      <p className="text-[9px] leading-relaxed text-muted-foreground">
                        {chatTransport === "onchain"
                          ? t("groups.onchainTransportDesc")
                          : t("groups.e2eTransportDesc")}
                      </p>
                    </div>

                    {chatTransport === "ssm" && ssmSettingsOpen && <SsmSettingsPanel controller={ssm} />}

                    {/* 动态通知 Banner */}
                    <AnimatePresence>
                      {claimedNotice && (
                        <motion.div
                          initial={{ opacity: 0, height: 0 }}
                          animate={{ opacity: 1, height: "auto" }}
                          exit={{ opacity: 0, height: 0 }}
                          className="px-3 py-1.5 rounded-lg bg-emerald-500/15 border border-emerald-500/30 text-emerald-600 dark:text-emerald-400 text-xs flex items-center justify-between"
                        >
                          <span className="font-medium truncate">{claimedNotice}</span>
                          <button
                            onClick={() => setClaimedNotice(null)}
                            className="text-emerald-500 hover:text-emerald-700 ml-2"
                          >
                            ✕
                          </button>
                        </motion.div>
                      )}
                    </AnimatePresence>

                    {/* 消息流：一个列表，两种传输 */}
                    <div className="h-[320px] overflow-y-auto space-y-2.5 p-2.5 rounded-xl bg-muted/20 border border-border/40 text-xs">
                      {chatTransport === "onchain" ? <>
                        {chatChannelError && <p role="alert" className="text-[11px] text-amber-600">{chatChannelError}</p>}
                        {pendingChatReceipt && <div role="status" className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-2 space-y-1"><p className="text-[11px]">{t("groups.pendingTxNoSend")}</p><p className="font-mono text-[10px] break-all">{pendingChatReceipt.digest || t("groups.digestMissing")}</p><Button size="sm" variant="outline" onClick={() => void handleResumeChatTransaction()} disabled={chatBusy}>{t("groups.queryOriginalTx")}</Button></div>}
                        {Object.values(redPackets).filter(packet => !chatMessages.some(message => message.redPacketId === packet.id)).map(packet => (
                          <button key={packet.id} type="button" onClick={() => handleOpenRedPacketClaim(packet.id)} className="block w-full rounded-xl border border-amber-300/30 bg-gradient-to-br from-red-600 via-rose-600 to-amber-600 p-3 text-left text-white shadow-sm">
                            <span className="flex items-center gap-2"><Gift className="h-5 w-5" /><span className="font-semibold">{packet.greeting || t("groups.groupPacketLabel")}</span></span>
                            <span className="mt-1 block text-[11px] text-amber-100">{packet.senderName} · {packet.totalAmount} SUI · {packet.refunded ? t("groups.remainderRefunded") : t("groups.packetRemainder", { p0: packet.remainingCount, p1: packet.totalCount })}</span>
                          </button>
                        ))}
                        {chatNotes.length > 0 && <div className="space-y-2 border-t border-border/40 pt-2"><p className="text-[10px] font-semibold text-muted-foreground">{t("groups.localNoteKind")}</p>{chatNotes.map(note => <div key={note.id} className="rounded-lg border border-border/50 bg-card p-2 text-xs"><div className="text-[10px] text-muted-foreground">{note.time} · {note.role}</div><p className="whitespace-pre-wrap">{note.text}</p></div>)}</div>}
                        {chatMessages.length === 0 && chatNotes.length === 0 && <p className="text-muted-foreground">{t("groups.chatEmpty")}</p>}
                        {chainRows.map(row => (
                          <UnifiedChatMessage
                            key={row.key}
                            row={row}
                            onOpenBlob={blobId => {
                              if (blobId.endsWith(".wma")) { setSelectedAppBlobId(blobId); setIsAppSandboxOpen(true) }
                              else setSelectedBlobId(blobId)
                            }}
                            redPacket={row.redPacketId && redPackets[row.redPacketId] ? (
                              <div
                                id={`red-packet-card-${row.redPacketId}`}
                                onClick={(e) => {
                                  e.stopPropagation()
                                  handleOpenRedPacketClaim(row.redPacketId!)
                                }}
                                className="mt-2 p-3 rounded-xl bg-gradient-to-br from-red-600 via-rose-600 to-amber-600 text-white cursor-pointer shadow-md hover:shadow-red-500/30 hover:scale-[1.01] transition-all select-none border border-amber-300/30"
                              >
                                <div className="flex items-center space-x-2.5">
                                  <div className="w-8 h-8 rounded-xl bg-amber-400/20 border border-amber-300/50 flex items-center justify-center text-base shadow-inner">
                                    🧧
                                  </div>
                                  <div className="flex-1 min-w-0">
                                    <p className="text-xs font-bold text-white truncate">
                                      {redPackets[row.redPacketId].greeting}
                                    </p>
                                    <p className="text-[10px] text-amber-200 flex items-center gap-1 mt-0.5 font-medium">
                                      {redPackets[row.redPacketId].remainingCount > 0 ? (
                                        <span>
                                          {t("groups.openPacketPrefix")}{redPackets[row.redPacketId].remainingCount}/
                                          {redPackets[row.redPacketId].totalCount} {t("groups.packetSharesSuffix")}</span>
                                      ) : (
                                        <span className="text-white/80">{t("groups.packetExhausted")}</span>
                                      )}
                                    </p>
                                  </div>
                                </div>
                                <div className="mt-2 pt-1.5 border-t border-white/20 flex justify-between items-center text-[9px] text-white/80">
                                  <span>
                                    {redPackets[row.redPacketId].packetType === "LUCKY_RANDOM"
                                      ? t("groups.luckyPacket")
                                      : t("groups.normalPacket")}
                                  </span>
                                  <span className="font-semibold text-amber-200">
                                    {redPackets[row.redPacketId].totalAmount} SUI
                                  </span>
                                </div>
                              </div>
                            ) : undefined}
                          />
                        ))}
                      </> : <>
                        {ssm.messageError && <p role="alert" className="text-[11px] text-amber-600">{ssm.messageError}</p>}
                        {ssm.loadingRows && ssm.rows.length === 0 && <p className="text-muted-foreground">{t("groups.readingRelayer")}</p>}
                        {!ssm.messageError && !ssm.loadingRows && ssm.rows.length === 0 && <p className="text-muted-foreground">{ssm.activeGroup ? t("groups.relayerEmpty") : t("groups.noEncryptedGroup")}</p>}
                        {ssmRows.map(row => <UnifiedChatMessage key={row.key} row={row} />)}
                      </>}
                    </div>

                    {/* 快捷指令弹出面板 */}
                    <AnimatePresence>
                      {chatTransport === "onchain" && (chatInput.startsWith("/") || showSlashMenu) && (
                        <motion.div
                          initial={{ opacity: 0, y: 8, scale: 0.98 }}
                          animate={{ opacity: 1, y: 0, scale: 1 }}
                          exit={{ opacity: 0, y: 8, scale: 0.98 }}
                          className="p-2 rounded-xl bg-card border border-border shadow-xl space-y-1 text-xs"
                        >
                          <div className="flex items-center justify-between px-2 py-1 text-[10px] text-muted-foreground border-b border-border/40">
                            <span className="flex items-center gap-1 font-semibold text-foreground">
                              <Sparkles className="h-3 w-3 text-primary" />
                              {t("groups.quickActions")}</span>
                            <span>{t("groups.tapToUse")}</span>
                          </div>
                          <div className="grid grid-cols-2 gap-1 pt-1">
                            <button
                              type="button"
                              onClick={() => handleTriggerSlash("/redpacket")}
                              className="flex items-center space-x-2 p-1.5 rounded-lg hover:bg-muted text-left transition-colors cursor-pointer group"
                            >
                              <div className="p-1 rounded bg-red-500/10 text-red-500 group-hover:bg-red-500/20">
                                <Gift className="h-3.5 w-3.5" />
                              </div>
                              <div className="truncate">
                                <p className="font-semibold text-[11px] text-foreground">{t("groups.sendPacket")}</p>
                                <p className="text-[10px] text-muted-foreground truncate">/redpacket</p>
                              </div>
                            </button>

                            <button
                              type="button"
                              onClick={() => handleTriggerSlash("/tip")}
                              className="flex items-center space-x-2 p-1.5 rounded-lg hover:bg-muted text-left transition-colors cursor-pointer group"
                            >
                              <div className="p-1 rounded bg-amber-500/10 text-amber-500 group-hover:bg-amber-500/20">
                                <Coins className="h-3.5 w-3.5" />
                              </div>
                              <div className="truncate">
                                <p className="font-semibold text-[11px] text-foreground">{t("groups.tipMembers")}</p>
                                <p className="text-[10px] text-muted-foreground truncate">/tip 1.0 SUI</p>
                              </div>
                            </button>

                            <button
                              type="button"
                              id="btn-slash-app"
                              onClick={() => handleTriggerSlash("/app")}
                              className="flex items-center space-x-2 p-1.5 rounded-lg hover:bg-muted text-left transition-colors cursor-pointer group"
                            >
                              <div className="p-1 rounded bg-purple-500/10 text-purple-500 group-hover:bg-purple-500/20">
                                <Vote className="h-3.5 w-3.5" />
                              </div>
                              <div className="truncate">
                                <p className="font-semibold text-[11px] text-foreground">{t("groups.groupPolls")}</p>
                                <p className="text-[10px] text-muted-foreground truncate">/app</p>
                              </div>
                            </button>

                            <button
                              type="button"
                              onClick={() => handleTriggerSlash("/stats")}
                              className="flex items-center space-x-2 p-1.5 rounded-lg hover:bg-muted text-left transition-colors cursor-pointer group"
                            >
                              <div className="p-1 rounded bg-emerald-500/10 text-emerald-500 group-hover:bg-emerald-500/20">
                                <Bot className="h-3.5 w-3.5" />
                              </div>
                              <div className="truncate">
                                <p className="font-semibold text-[11px] text-foreground">{t("groups.assetBrief")}</p>
                                <p className="text-[10px] text-muted-foreground truncate">/stats</p>
                              </div>
                            </button>
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>

                    {/* 消息输入框与快捷栏：同一个输入框，按当前传输发送 */}
                    <div className="flex items-center space-x-1.5 pt-1">
                      {chatTransport === "onchain" && <>
                        <Button
                          size="sm"
                          variant="outline"
                          type="button"
                          onClick={() => setShowSlashMenu((prev) => !prev)}
                          className={`h-8 px-2 text-xs gap-1 shrink-0 ${
                            showSlashMenu
                              ? "bg-primary/10 text-primary border-primary/30"
                              : "text-muted-foreground hover:text-foreground"
                          }`}
                          title={t("groups.quickActions")}
                        >
                          <Plus className="h-3.5 w-3.5" />
                          <span className="hidden sm:inline">{t("groups.quickShort")}</span>
                        </Button>

                        <Button
                          size="sm"
                          variant="outline"
                          type="button"
                          onClick={() => {
                            setRedPacketDialogMode("create")
                            setIsRedPacketDialogOpen(true)
                          }}
                          className="h-8 px-2 text-xs gap-1 border-red-500/30 text-red-500 hover:bg-red-500/10 hover:text-red-600 shrink-0"
                          title={t("groups.sendPacket")}
                        >
                          <Gift className="h-3.5 w-3.5 text-red-500" />
                          <span className="hidden sm:inline">{t("groups.packetShort")}</span>
                        </Button>
                      </>}

                      <Input
                        placeholder={chatTransport === "ssm"
                          ? !ssm.status.configured ? t("groups.e2eRelayMissing") : !ssm.activeGroup ? t("groups.pickEncryptedGroupFirst") : readOnly ? t("groups.readOnlyMode") : t("groups.encryptedInputPlaceholder")
                          : outboxCount > 0 ? t("groups.outboxQueued", { p0: outboxCount, p1: MAX_OUTBOX_MESSAGES }) : t("groups.chatInputPlaceholder")}
                        value={chatInput}
                        onChange={(e) => setChatInput(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") void sendOnActiveTransport() }}
                        disabled={chatTransport === "ssm" && (!ssm.status.configured || !ssm.activeGroup || readOnly)}
                        aria-label={chatTransport === "ssm" ? t("groups.encryptedMessageAria") : t("groups.groupMessageAria")}
                        className="h-8 text-xs bg-muted/30 focus-visible:ring-1 flex-1"
                      />

                      {chatTransport === "onchain" && <Button
                        size="sm"
                        variant="ghost"
                        type="button"
                        disabled={isUploadingFile}
                        onClick={() => fileInputRef.current?.click()}
                        className="h-8 px-2 text-xs gap-1 text-muted-foreground hover:text-foreground shrink-0"
                        title={t("groups.filePickAria")}
                      >
                        {isUploadingFile ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Paperclip className="h-3.5 w-3.5" />
                        )}
                        <span className="hidden sm:inline">{t("groups.attachmentsTab")}</span>
                      </Button>}

                      <Button
                        size="sm"
                        type="button"
                        onClick={() => void sendOnActiveTransport()}
                        disabled={chatTransport === "ssm" && (!ssm.status.configured || !ssm.activeGroup || readOnly || ssm.sending)}
                        className="h-8 px-3 text-xs gap-1 shrink-0 bg-primary text-primary-foreground"
                      >
                        {chatTransport === "ssm" && ssm.sending ? <Loader2 className="h-3 w-3 animate-spin" /> : chatTransport === "ssm" ? <Lock className="h-3 w-3" /> : <Send className="h-3 w-3" />}
                        <span className="hidden sm:inline">{t("groups.sendLabel")}</span>
                      </Button>
                    </div>
                    {chatTransport === "ssm" && <p className="text-[10px] leading-relaxed text-muted-foreground">
                      {t("groups.e2eSendNotice")}</p>}
                    {chatTransport === "onchain" && chatChannelError && <p className="text-[11px] text-amber-600">{chatChannelError}</p>}
                    {channelSetupOpen && <div className="rounded-xl border border-border/60 bg-card p-3 space-y-2">
                      <p className="text-xs font-semibold">{t("groups.createOnchainChannel")}</p>
                      <p className="text-[10px] text-muted-foreground">{t("groups.channelSetupDesc")}</p>
                      <Input value={channelStake} onChange={event => setChannelStake(event.target.value)} placeholder={t("groups.creatorStakeLabel")} className="h-8 text-xs" />
                      <Input value={channelEntryFee} onChange={event => setChannelEntryFee(event.target.value)} placeholder={t("groups.ticketLabel")} className="h-8 text-xs" />
                      <Input value={channelMemberStake} onChange={event => setChannelMemberStake(event.target.value)} placeholder={t("groups.memberStakeLabel")} className="h-8 text-xs" />
                      {(channelEntryFee !== "0" || channelMemberStake !== "0") && <div className="grid grid-cols-3 gap-1"><Input value={channelCreatorShare} onChange={event => setChannelCreatorShare(event.target.value)} placeholder={t("groups.creatorBps")} className="h-8 text-xs" /><Input value={channelGasShare} onChange={event => setChannelGasShare(event.target.value)} placeholder="Gas BPS" className="h-8 text-xs" /><Input value={channelMemberShare} onChange={event => setChannelMemberShare(event.target.value)} placeholder={t("groups.memberBps")} className="h-8 text-xs" /></div>}
                      <div className="flex justify-end gap-2"><Button size="sm" variant="ghost" onClick={() => setChannelSetupOpen(false)}>{t("groups.cancel")}</Button><Button size="sm" onClick={() => void handleCreateChannel().catch(error => setClaimedNotice(error instanceof Error ? error.message : t("groups.createChannelFailed")))} disabled={chatBusy}>{t("groups.confirmCreate")}</Button></div>
                    </div>}
                  </motion.div>
                </TabsContent>
              )}

              {/* 2. 成员 Tab */}
              {activeTab === "members" && (
                <TabsContent value="members" className="mt-3 space-y-2">
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    transition={{ duration: 0.2 }}
                  >
                    {!isConvertedToDao && orgObjectId && (
                      <div className="mb-3 rounded-xl border border-amber-500/40 bg-amber-500/5 p-2.5 text-[11px] text-amber-700 dark:text-amber-300">
                        {t("groups.localRecordedOrgPrefix")}{orgObjectId.slice(0, 10)}{t("groups.orgReadInvalidSuffix")}{chainError ? t("groups.parenWrap", { p0: chainError }) : t("groups.readingParen")}{t("groups.orgReadFailNote")}</div>
                    )}
                    {isConvertedToDao ? (
                      <div className="p-2.5 rounded-xl bg-purple-500/10 border border-purple-500/30 flex items-center justify-between text-xs mb-3">
                        <div className="flex items-center space-x-2">
                          <Network className="h-4 w-4 text-purple-500" />
                          <div>
                            <div className="flex items-center space-x-1.5">
                              <p className="font-semibold text-purple-600 dark:text-purple-400">
                                {t("groups.finalizedDao")}</p>
                              <Badge
                                variant="outline"
                                className="text-[9px] px-1 py-0 h-4 border-purple-500/40 text-purple-500"
                              >
                                Epoch {orgEpoch}
                              </Badge>
                            </div>
                            <div className="flex items-center space-x-2 text-[10px] text-muted-foreground font-mono mt-0.5">
                              <span className="truncate max-w-[140px]">
                                PK: {groupPk ? `${groupPk.slice(0, 8)}...${groupPk.slice(-6)}` : ""}
                              </span>
                              {orgObjectId && (
                                <a
                                  href={`https://suiscan.xyz/testnet/object/${orgObjectId}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-primary hover:underline flex items-center"
                                >
                                  Suiscan <ExternalLink className="h-2.5 w-2.5 ml-0.5" />
                                </a>
                              )}
                            </div>
                          </div>
                        </div>
                        <div className="flex flex-col gap-1">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setIsDkgOpen(true)}
                            className="h-7 text-[11px] border-purple-500/30 text-purple-500 hover:bg-purple-500/10"
                          >
                            {t("groups.rotateReshare")}</Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setIsRosterOpen(true)}
                            disabled={!treasuryOrgId}
                            title={treasuryOrgId ? undefined : t("groups.rotationNeedsOrg")}
                            className="h-7 text-[11px] border-purple-500/30 text-purple-500 hover:bg-purple-500/10"
                          >
                            {treasuryOrgId ? t("groups.rosterRotationShort") : t("groups.rosterRotationPending")}
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div className="p-2.5 rounded-xl bg-primary/5 border border-primary/20 flex items-center justify-between text-xs mb-3">
                        <div>
                          <p className="font-semibold text-foreground flex items-center">
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 mr-1.5 inline-block animate-pulse"></span>
                            {t("groups.multisigNow")}</p>
                          <p className="text-[11px] text-muted-foreground">{t("groups.dkgAnytime")}</p>
                        </div>
                        <Button
                          size="sm"
                          onClick={() => setIsDkgOpen(true)}
                          className="h-7 text-[11px] bg-primary text-primary-foreground hover:bg-primary/90"
                        >
                          <Sparkles className="h-3 w-3 mr-1" />
                          {t("groups.finalizeDao")}</Button>
                      </div>
                    )}

                    <p className="text-[11px] text-muted-foreground">{realGroupData?.chainMembers ? t("groups.rosterFromChainNote") : t("groups.rosterLocalOnlyNote")}</p>
                    {group.members.map((member, index: number) => (
                      <div
                        key={index}
                        className="flex items-center justify-between p-2 rounded-lg hover:bg-muted/50 transition-colors"
                      >
                        <div className="flex items-center">
                          {(() => {
                            const identity = memberProfiles.profiles[member.address?.toLowerCase?.() ?? ""]
                            return identity
                              ? <span className="mr-3"><IdentityAvatar profile={identity} size="sm" /></span>
                              : <Avatar className="h-8 w-8 mr-3">
                                  <AvatarFallback
                                    className={`text-white ${
                                      member.name === "You"
                                        ? "bg-gradient-to-br from-primary to-purple-500"
                                        : "bg-gradient-to-br from-gray-500 to-gray-600"
                                    }`}
                                  >
                                    {(member.name || member.address || "?")[0]}
                                  </AvatarFallback>
                                </Avatar>
                          })()}
                          <div>
                            <p className="font-medium text-sm truncate max-w-[200px]">{member.name || `${member.address?.slice(0, 8) ?? ""}…${member.address?.slice(-6) ?? ""}`}</p>
                            <p className="text-xs text-muted-foreground flex items-center font-mono">
                              {member.address?.slice(0, 8)}...{member.address?.slice(-6)}
                            </p>
                          </div>
                        </div>
                        <div className="text-right">
                          <Badge variant="outline" className="text-xs">
                            Weight: {member.weight}
                          </Badge>
                        </div>
                      </div>
                    ))}
                  </motion.div>
                </TabsContent>
              )}

              {/* 3. AI 哨兵 Tab */}
              {activeTab === "agents" && (
                <TabsContent value="agents" className="mt-3 space-y-2.5">
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    transition={{ duration: 0.2 }}
                    className="space-y-2.5"
                  >
                    <div className="flex items-center justify-between text-xs mb-1">
                      <span className="text-muted-foreground font-medium">{t("groups.agentCoSignSection")}</span>
                      <Badge variant="outline" className="text-[10px]">
                        SubagentCoSignCap
                      </Badge>
                    </div>
                    {/* Every row comes from a SubagentCoSignCap whose issuer is on the live roster. */}
                    {groupAgentsState.loading && <p role="status" className="text-[11px] text-muted-foreground">{t("groups.readingAgentCaps")}</p>}
                    {!groupAgentsState.loading && groupAgentsState.error && <p role="alert" className="break-all text-[11px] text-destructive">{groupAgentsState.error}</p>}
                    {!groupAgentsState.loading && !groupAgentsState.error && !treasuryOrgId && (
                      <p className="text-[11px] text-muted-foreground">{t("groups.noVerifiedOrgNoAgents")}</p>
                    )}
                    {!groupAgentsState.loading && groupAgentsState.data?.delegations.map(delegation => {
                      const own = !!agentAccount && normalizeSuiAddress(delegation.masterOwner) === normalizeSuiAddress(agentAccount)
                      const percent = delegation.dailyBudgetLimit > 0n ? Number(delegation.spent * 1000n / delegation.dailyBudgetLimit) / 10 : 0
                      return (
                        <div key={delegation.capId} className="p-3 rounded-xl border border-border/60 bg-card/60 space-y-2">
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-2 min-w-0">
                              <div className="w-7 h-7 shrink-0 rounded-lg bg-gradient-to-br from-primary to-purple-600 flex items-center justify-center text-white">
                                <Bot className="w-3.5 h-3.5" />
                              </div>
                              <div className="min-w-0">
                                <p className="font-semibold text-xs truncate">{own ? t("groups.yourCoSignAgent") : t("groups.memberAgentShort", { p0: delegation.masterOwner.slice(0, 6), p1: delegation.masterOwner.slice(-4) })}</p>
                                <p className="text-[10px] text-muted-foreground font-mono truncate">{t("groups.agentPrefix")}{delegation.agentAddress.slice(0, 8)}…{delegation.agentAddress.slice(-6)}</p>
                              </div>
                            </div>
                            <Badge variant="outline" className={`text-[9px] shrink-0 ${AGENT_STATUS_TONE[delegation.status]}`}>
                              {AGENT_STATUS_LABEL[delegation.status]}
                            </Badge>
                          </div>
                          <div className="space-y-1">
                            <div className="flex justify-between text-[11px] text-muted-foreground">
                              <span>{t("groups.coSignQuotaLabel")}</span>
                              <span className="font-mono text-foreground font-medium">{formatMist(delegation.spent.toString())} / {formatMist(delegation.dailyBudgetLimit.toString())} SUI</span>
                            </div>
                            <Progress value={Math.min(percent, 100)} className="h-1.5" />
                          </div>
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
                            <span>{t("groups.weightPrefix")}{delegation.voterWeight.toString()}{t("groups.rosterParenPrefix")}{delegation.rosterWeight.toString()}{t("groups.closeParen")}</span>
                            <span>{t("groups.perTxFloorPrefix")}{formatMist(delegation.maxBudgetPerTx.toString())} SUI</span>
                            <span>{t("groups.expiryPrefix")}{new Date(Number(delegation.expiresAtMs)).toLocaleString()}</span>
                            <span>{delegation.custody === "shared" ? t("groups.sharedCredential") : delegation.custody === "address" ? t("groups.heldByAddress", { p0: delegation.capOwner?.slice(0, 6) ?? "" }) : t("groups.holderAnomaly")}</span>
                          </div>
                          {delegation.status !== "ACTIVE" && <p className="text-[10px] text-amber-600 dark:text-amber-400">{delegation.reason}</p>}
                          {own && delegation.status !== "REVOKED" && (
                            <Button size="sm" variant="outline" className="h-6 text-[10px] px-2" disabled={!!agentBusyCap} onClick={() => void revokeDelegation(delegation)}>
                              {agentBusyCap === delegation.capId ? t("groups.awaitingWalletSign") : t("groups.onchainRevoke")}
                            </Button>
                          )}
                          <p className="text-[10px] text-muted-foreground font-mono break-all">Cap {delegation.capId}</p>
                        </div>
                      )
                    })}
                    {!groupAgentsState.loading && !groupAgentsState.error && treasuryOrgId && groupAgentsState.data?.delegations.length === 0 && (
                      <p className="text-[11px] text-muted-foreground">{t("groups.noAgentCapsYet")}</p>
                    )}
                    {groupAgentsState.data?.truncated && <p className="text-[10px] text-amber-600 dark:text-amber-400">{t("groups.agentCapScanLimit")}</p>}
                    {groupAgentsState.data?.errors.map(error => <p key={error} className="break-all text-[10px] text-amber-600 dark:text-amber-400">{error}</p>)}
                    <div className="flex items-center justify-between gap-2">
                      <Button size="sm" variant="outline" className="h-7 text-[11px]" disabled={!treasuryOrgId || !agentMember} onClick={() => { setAgentActionError(""); setAgentDialogOpen(true) }}>
                        <Bot className="mr-1 h-3 w-3" />{t("groups.issueCoSign")}</Button>
                      <Button size="sm" variant="ghost" className="h-7 text-[11px]" disabled={groupAgentsState.loading || !treasuryOrgId} onClick={() => void groupAgentsState.reload()}>{t("groups.refreshAgentCaps")}</Button>
                    </div>
                    {agentAccount && treasuryOrgId && !groupAgentsState.loading && !agentMember && !groupAgentsState.error && (
                      <p className="text-[10px] text-muted-foreground">{t("groups.currentWalletPrefix")}{agentAccount.slice(0, 6)}…{agentAccount.slice(-4)} {t("groups.walletNotInRosterSuffix")}</p>
                    )}
                    {agentActionError && <p role="alert" className="break-all text-[11px] text-destructive">{agentActionError}</p>}
                    <div className="p-2.5 rounded-lg bg-muted/30 border border-border/50 text-[11px] text-muted-foreground space-y-1">
                      <span className="font-semibold text-foreground flex items-center gap-1">
                        <ShieldCheck className="w-3.5 h-3.5 text-primary" />
                        {t("groups.coSignScope")}</span>
                      <p>{t("groups.coSignScopeDesc")}</p>
                    </div>

                    {/* Channel-scoped posting delegation is a different cap and contract module. */}
                    <div className="flex items-center justify-between text-xs mt-1">
                      <span className="text-muted-foreground font-medium">{t("groups.relayCapSection")}</span>
                      <Badge variant="outline" className="text-[10px]">SubagentMessagingCap</Badge>
                    </div>
                    {!chatChannel && (
                      <p className="text-[11px] text-muted-foreground">{t("groups.noChannelNoRelayCap")}</p>
                    )}
                    {chatChannel && messagingCapsState.loading && <p role="status" className="text-[11px] text-muted-foreground">{t("groups.readingRelayCaps")}</p>}
                    {chatChannel && !messagingCapsState.loading && messagingCapsState.error && <p role="alert" className="break-all text-[11px] text-destructive">{messagingCapsState.error}</p>}
                    {chatChannel && !messagingCapsState.loading && messagingCapsState.data?.delegations.map(delegation => {
                      const own = !!agentAccount && normalizeSuiAddress(delegation.masterOwner) === normalizeSuiAddress(agentAccount)
                      return (
                        <div key={delegation.capId} className="p-3 rounded-xl border border-border/60 bg-card/60 space-y-1.5">
                          <div className="flex items-center justify-between gap-2">
                            <div className="min-w-0">
                              <p className="font-semibold text-xs truncate">{own ? t("groups.yourRelayAgent") : t("groups.memberRelayAgent", { p0: delegation.masterOwner.slice(0, 6), p1: delegation.masterOwner.slice(-4) })}</p>
                              <p className="text-[10px] text-muted-foreground font-mono truncate">{t("groups.agentPrefix")}{delegation.agentAddress.slice(0, 8)}…{delegation.agentAddress.slice(-6)}</p>
                            </div>
                            <Badge variant="outline" className={`text-[9px] shrink-0 ${MESSAGING_STATUS_TONE[delegation.status]}`}>{MESSAGING_STATUS_LABEL[delegation.status]}</Badge>
                          </div>
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
                            <span>{t("groups.perMinutePrefix")}{delegation.rateLimitPerMinute.toString()}</span>
                            <span>{t("groups.expiryPrefix")}{new Date(Number(delegation.expiresAtMs)).toLocaleString()}</span>
                            <span>{delegation.custody === "shared" ? t("groups.sharedCredential") : delegation.custody === "address" ? t("groups.heldByAddress", { p0: delegation.capOwner?.slice(0, 6) ?? "" }) : t("groups.holderAnomaly")}</span>
                          </div>
                          {delegation.status !== "ACTIVE" && <p className="text-[10px] text-amber-600 dark:text-amber-400">{delegation.reason}</p>}
                          {own && delegation.status !== "REVOKED" && (
                            <Button size="sm" variant="outline" className="h-6 text-[10px] px-2" disabled={!!messagingBusyCap} onClick={() => void revokeMessaging(delegation)}>
                              {messagingBusyCap === delegation.capId ? t("groups.awaitingWalletSign") : t("groups.onchainRevoke")}
                            </Button>
                          )}
                          <p className="text-[10px] text-muted-foreground font-mono break-all">Cap {delegation.capId}</p>
                        </div>
                      )
                    })}
                    {chatChannel && !messagingCapsState.loading && !messagingCapsState.error && messagingCapsState.data?.delegations.length === 0 && (
                      <p className="text-[11px] text-muted-foreground">{t("groups.noRelayCapsYet")}</p>
                    )}
                    {messagingCapsState.data?.truncated && <p className="text-[10px] text-amber-600 dark:text-amber-400">{t("groups.agentCapScanLimit")}</p>}
                    {messagingCapsState.data?.errors.map(error => <p key={error} className="break-all text-[10px] text-amber-600 dark:text-amber-400">{error}</p>)}
                    <div className="flex items-center justify-between gap-2">
                      <Button size="sm" variant="outline" className="h-7 text-[11px]" disabled={!chatChannel?.isMember} onClick={() => { setMessagingActionError(""); setMessagingDialogOpen(true) }}>
                        <MessageSquare className="mr-1 h-3 w-3" />{t("groups.issueRelayCap")}</Button>
                      <Button size="sm" variant="ghost" className="h-7 text-[11px]" disabled={messagingCapsState.loading || !chatChannel} onClick={() => void messagingCapsState.reload()}>{t("groups.refreshRelayCaps")}</Button>
                    </div>
                    {chatChannel && !chatChannel.isMember && <p className="text-[10px] text-muted-foreground">{t("groups.joinFirstRelayCap")}</p>}
                    {messagingActionError && <p role="alert" className="break-all text-[11px] text-destructive">{messagingActionError}</p>}
                    <div className="p-2.5 rounded-lg bg-muted/30 border border-border/50 text-[11px] text-muted-foreground space-y-1">
                      <span className="font-semibold text-foreground flex items-center gap-1">
                        <ShieldCheck className="w-3.5 h-3.5 text-primary" />
                        {t("groups.relayScope")}</span>
                      <p>{t("groups.relayScopeDesc")}</p>
                    </div>
                  </motion.div>
                </TabsContent>
              )}

              {/* 4. 群文件 / Walrus 存储 Tab */}
              {activeTab === "files" && (
                <TabsContent value="files" className="mt-3 space-y-3">
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    transition={{ duration: 0.2 }}
                    className="space-y-3"
                  >
                    <div className="p-3 rounded-xl bg-gradient-to-r from-cyan-500/10 to-blue-500/10 border border-cyan-500/30 flex items-center justify-between">
                      <div>
                        <h4 className="text-xs font-semibold flex items-center gap-1.5 text-cyan-700 dark:text-cyan-300">
                          <HardDrive className="h-4 w-4 text-cyan-500" />
                          {t("groups.walrusLibraryTitle")}</h4>
                        <p className="text-[10px] text-muted-foreground mt-0.5">
                          {t("groups.walrusLibraryDesc")}</p>
                      </div>
                      <Button
                        size="sm"
                        disabled={isUploadingFile}
                        onClick={() => fileInputRef.current?.click()}
                        className="h-7 text-xs bg-cyan-600 hover:bg-cyan-700 text-white shrink-0 gap-1"
                      >
                        {isUploadingFile ? (
                          <>
                            <Loader2 className="h-3.5 w-3.5 animate-spin" /> {t("groups.uploadingLabel")}</>
                        ) : (
                          <>
                            <UploadCloud className="h-3.5 w-3.5" /> {t("groups.uploadFile")}</>
                        )}
                      </Button>
                    </div>

                    {fileError && <p role="alert" className="text-xs text-destructive break-all">{fileError}</p>}
                    {fileReceipt && <p role="status" className="text-xs text-muted-foreground break-all">{fileReceipt}</p>}
                    {pendingChatReceipt?.action === "group-file-anchor"
                      ? <div role="status" className="text-xs break-all space-y-2"><p>{t("groups.fileTxPendingPrefix")}{pendingChatReceipt.digest || t("groups.digestNotReturned")}</p><p>{t("groups.blobIdPrefix")}{pendingChatReceipt.metadata?.blobId || t("groups.checkOriginalTx")}</p><Button size="sm" variant="outline" disabled={chatBusy} onClick={() => void handleResumeChatTransaction()}>{t("groups.queryOriginalFileTx")}</Button></div>
                      : pendingFile && <Button size="sm" variant="outline" disabled={isUploadingFile} onClick={handleRetryFileShare}>{t("groups.reconfirmFileShare")}</Button>}
                    <div className="space-y-2 max-h-[300px] overflow-y-auto pr-1">
                      {visibleGroupFiles.length === 0 && <p className="py-5 text-center text-xs text-muted-foreground">{t("groups.noFilesYet")}</p>}
                      {visibleGroupFiles.map((f, index) => (
                        <div
                          key={`${f.source}:${f.id}:${index}`}
                          className="p-2.5 rounded-xl border border-border/60 bg-card/60 hover:bg-muted/40 transition-colors flex items-center justify-between text-xs"
                        >
                          <div className="flex items-center gap-2.5 min-w-0">
                            <div className="w-8 h-8 rounded-lg bg-cyan-500/15 border border-cyan-500/30 flex items-center justify-center shrink-0">
                              <FileText className="h-4 w-4 text-cyan-600 dark:text-cyan-400" />
                            </div>
                            <div className="min-w-0">
                              <p className="font-medium text-foreground truncate">{f.name}</p>
                              <div className="flex items-center gap-2 text-[10px] text-muted-foreground font-mono">
                                <span>{f.size === null ? t("groups.sizeUnknown") : `${(f.size / 1024).toFixed(1)} KB`}</span>
                                <span>•</span>
                                <span className="truncate max-w-24">{f.uploader}</span>
                              </div>
                              <p className="text-[10px] text-muted-foreground">{f.source === "chain" ? t("groups.confirmedAttachment") : t("groups.localAttachment")}</p>
                              {!!f.recordIssues?.length && <p className="text-[10px] text-amber-600">{f.recordIssues.join(t("groups.cnSemicolon"))}</p>}
                            </div>
                          </div>

                          <div className="flex items-center gap-1.5 shrink-0">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => setSelectedBlobId(f.blobId)}
                              className="h-6 text-[10px] px-2"
                            >
                              {t("groups.viewAttestation")}</Button>
                            <a
                              href={f.url || undefined}
                              onClick={f.url ? undefined : (event) => { event.preventDefault(); setFileError(t("groups.invalidHistoryBlobId", { p0: f.blobId || t("groups.missingLabel") })) }}
                              target="_blank"
                              rel="noreferrer"
                              className="h-6 px-2 rounded-md border border-input bg-background hover:bg-accent text-[10px] flex items-center gap-0.5 text-foreground"
                            >
                              {t("groups.downloadPrefix")}<ExternalLink className="h-2.5 w-2.5" />
                            </a>
                          </div>
                        </div>
                      ))}
                    </div>
                  </motion.div>
                </TabsContent>
              )}

              {/* 5. 交易提案 Tab */}
              {activeTab === "transactions" && (
                <TabsContent value="transactions" className="mt-3 space-y-3">
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    transition={{ duration: 0.2 }}
                  >
                    <div className="flex justify-end mb-2">
                      <Button
                        size="sm"
                        onClick={() => setIsCreateTxOpen(true)}
                        className="bg-gradient-to-r from-primary to-purple-500 hover:from-primary/90 hover:to-purple-500/90 text-xs"
                      >
                        <Plus className="h-3.5 w-3.5 mr-1" /> {t("groups.newTransferProposal")}</Button>
                    </div>

                    <div className="space-y-2">
                      {group.transactions.map((tx) => (
                        <div
                          key={tx.id}
                          className="p-3 rounded-lg border hover:bg-muted/50 transition-colors cursor-pointer"
                          onClick={() => setSelectedTx(tx.id)}
                        >
                          <div className="flex justify-between items-start">
                            <div>
                              <h3 className="font-medium text-sm">{tx.title}</h3>
                              <p className="text-xs text-muted-foreground">{tx.description}</p>
                              {tx.sourceStatus !== "chain-confirmed" && <p className="text-xs text-amber-600">{t("groups.localHistoryNote")}</p>}
                            </div>
                            <Badge
                              variant={
                                tx.status === "executed"
                                  ? "outline"
                                  : tx.status === "rejected"
                                    ? "destructive"
                                    : "default"
                              }
                              className="text-xs"
                            >
                              {tx.sourceStatus !== "chain-confirmed" ? t("groups.historyPending") : tx.status === "executed"
                                ? t("groups.statusExecuted")
                                : tx.status === "rejected"
                                  ? t("groups.statusRejected")
                                  : tx.status === "approved"
                                    ? t("groups.statusApproved")
                                    : t("groups.statusPendingApproval")}
                            </Badge>
                          </div>

                          <div className="flex justify-between mt-2">
                            <div className="text-xs text-muted-foreground">{t("groups.transferProposalsTitle")}</div>
                            <div className="text-xs font-semibold">
                              {tx.sourceStatus === "chain-confirmed" ? `${formatMist(tx.amountMist)} ${tx.token}` : tx.amountLabel || t("groups.historyAmountPending")}
                            </div>
                          </div>

                          {tx.status === "pending" && tx.sourceStatus === "chain-confirmed" && (
                            <div className="mt-2 flex items-center justify-between">
                              <div className="text-xs text-muted-foreground">
                                {t("groups.approvalProgressPrefix")}{tx.approvals}/{tx.requiredApprovals}
                              </div>
                              <Button size="sm" variant="outline" className="h-6 text-[10px]">
                                {t("groups.viewApproval")}</Button>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </motion.div>
                </TabsContent>
              )}

              {/* 6. 收款 Tab */}
              {activeTab === "receive" && (
                <TabsContent value="receive" className="mt-3 space-y-3">
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    transition={{ duration: 0.2 }}
                  >
                    <GroupTreasury groupId={groupId} orgId={chainOrgId} data={treasury.data} error={treasury.error} loading={treasury.loading} reload={treasury.reload} />
                    <div className="mt-4 flex flex-col items-center space-y-3 rounded-xl border p-4">
                      <p className="text-sm font-semibold">{group.name} {t("groups.groupProfileSuffix")}</p>
                      {validGroupAddress ? <p className="break-all text-center font-mono text-xs text-muted-foreground">{validGroupAddress}</p> : <p className="text-center text-xs text-muted-foreground">{t("groups.groupNoOrgSentence")}</p>}
                      <Button variant="outline" size="sm" disabled={!validGroupAddress} onClick={() => setShareQrOpen(true)}><QrCode className="mr-2 h-4 w-4" />{t("groups.viewShareQr")}</Button>
                      <p className="text-center text-xs text-muted-foreground">{validGroupAddress ? t("groups.qrSafetyNotice") : t("groups.qrNeedsDkg")}</p>
                      {chainError && <p role="alert" className="text-xs text-destructive">{chainError}</p>}
                    </div>
                  </motion.div>
                </TabsContent>
              )}
              {/* 7. Scallop 收益 Tab */}
              {activeTab === "yield" && (
                <TabsContent value="yield" className="mt-3">
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    transition={{ duration: 0.2 }}
                  >
                    <ScallopYieldPanel channelId={chatChannel?.id} readOnly={readOnly} busy={chatBusy} run={(build, success) => runChatTransaction(build, success)} />
                  </motion.div>
                </TabsContent>
              )}
              {/* 8. 资产托管 Tab */}
              {activeTab === "custody" && (
                <TabsContent value="custody" className="mt-3">
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    transition={{ duration: 0.2 }}
                  >
                    <AssetCustodyPanel orgId={treasuryOrgId} readOnly={readOnly} busy={chatBusy} run={(build, success) => runChatTransaction(build, success)} />
                  </motion.div>
                </TabsContent>
              )}
            </AnimatePresence>
          </Tabs>
        </div>
      </div>

      <ShareQrDialog open={shareQrOpen && !!validGroupAddress} onOpenChange={setShareQrOpen} title={t("groups.qrTitleSuffix", { p0: group.name })} kind="group" identifier={validGroupAddress} description={t("groups.scanViewOnlyOrg")} />

      <GroupAgentDialog
        open={agentDialogOpen}
        onOpenChange={setAgentDialogOpen}
        orgId={treasuryOrgId}
        member={agentMember}
        accountAddress={agentAccount}
        onIssued={digest => {
          setAgentActionError(t("groups.coSignIssued", { p0: digest }))
          void groupAgentsState.reload()
        }}
      />

      <MessagingCapDialog
        open={messagingDialogOpen}
        onOpenChange={setMessagingDialogOpen}
        orgId={treasuryOrgId}
        channelId={chatChannel?.id ?? ""}
        isMember={!!chatChannel?.isMember}
        accountAddress={agentAccount}
        onIssued={digest => {
          setMessagingActionError(t("groups.relayCapIssued", { p0: digest }))
          void messagingCapsState.reload()
        }}
      />

      <CreateTransactionDialog open={isCreateTxOpen} onOpenChange={setIsCreateTxOpen} groupId={groupId} />

      {selectedTx && (
        <TransactionDetailsDialog
          open={!!selectedTx}
          onOpenChange={() => setSelectedTx(null)}
          transactionId={selectedTx}
          groupId={groupId}
        />
      )}

      <GroupRosterDialog open={isRosterOpen && !!treasuryOrgId} onOpenChange={setIsRosterOpen} orgId={treasuryOrgId} groupId={groupId} />

      <DkgCeremonyDialog
        open={isDkgOpen}
        onOpenChange={setIsDkgOpen}
        groupName={group.name}
        groupId={groupId}
        initialMembers={group.members}
        onConvertedSuccess={(pk, orgId) => {
          setIsConvertedToDao(true)
          setGroupPk(pk)
          if (orgId) setOrgObjectId(orgId)
        }}
      />

      <WalrusBlobDialog
        open={!!selectedBlobId}
        onOpenChange={() => setSelectedBlobId(null)}
        blobId={selectedBlobId}
      />

      <RedPacketDialog
        open={isRedPacketDialogOpen}
        onOpenChange={setIsRedPacketDialogOpen}
        mode={redPacketDialogMode}
        packetData={activeRedPacketId ? redPackets[activeRedPacketId] : null}
        onCreatePacket={handleCreateRedPacket}
        onClaimPacket={handleClaimRedPacket}
        onRefundPacket={handleRefundRedPacket}
        currentUserAddress={getActiveAccount()?.address || ""}
      />

      <PaymentDialog open={tipPaymentOpen} onOpenChange={setTipPaymentOpen} title={t("groups.groupTip")} recipientAddress={tipRecipient} />

      {tipOpen && <Dialog open={tipOpen} onOpenChange={setTipOpen}>
        <DialogContent className="w-[92vw] max-w-sm">
          <DialogHeader><DialogTitle>{t("groups.tipMembers")}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">{t("groups.tipConfirmNotice")}</p>
            {realGroupData?.chainMembers && <div className="max-h-44 overflow-y-auto space-y-1" aria-label={t("groups.verifiedOrgMembers")}>
              <p className="text-xs text-muted-foreground">{t("groups.verifiedOnchainMembers")}</p>
              {group.members.map((member) => <Button key={member.address} variant={tipRecipient === member.address ? "secondary" : "ghost"} className="w-full justify-start h-auto py-2" onClick={() => setTipRecipient(member.address)}><span className="min-w-0 text-left"><span className="block text-xs truncate">{member.name || `${member.address.slice(0, 8)}…${member.address.slice(-6)}`}</span><span className="block font-mono text-[10px] text-muted-foreground truncate">{member.address}</span></span></Button>)}
            </div>}
            <Input value={tipRecipient} onChange={event => setTipRecipient(event.target.value)} placeholder={t("groups.addressPlaceholder")} aria-label={t("groups.tipRecipient")} />
            <div className="flex justify-end gap-2"><Button variant="outline" onClick={() => setTipOpen(false)}>{t("groups.cancel")}</Button><Button onClick={handleTip}>{t("groups.continuePickAmount")}</Button></div>
          </div>
        </DialogContent>
      </Dialog>}

      <WalrusAppSandboxDialog
        open={isAppSandboxOpen}
        onOpenChange={setIsAppSandboxOpen}
        groupId={groupId}
        orgId={chainOrgId}
        readOnly={readOnly}
        blobId={selectedAppBlobId}
        isMemberStaked={false}
      />
    </div>
  )
}
