// Notifications are derived from locally synchronized group proposals. They are
// not a push subscription: nothing arrives while the app is closed, and a
// proposal that was never synced to this browser cannot appear here.
import { normalizeSuiAddress } from "@mysten/sui/utils"
import type { ProposalItem } from "./onchain-store"
import { t } from "./i18n/t"

export interface ProposalNotification {
  proposal: ProposalItem
  key: string
  title: string
  needsVote: boolean
}

export const NOTIFICATIONS_UPDATED_EVENT = "sui-notifications-updated"
const READ_KEY_PREFIX = "sui_notifications_read:"
const MAX_STORED_READ_KEYS = 500
const MAX_NOTIFICATIONS = 50

export function notificationReadKey(address: string): string {
  return `${READ_KEY_PREFIX}${address}`
}

// Only proposals this browser confirmed against the chain and where the
// connected account is a known voter are eligible. Local drafts stay out.
export function eligibleProposals(proposals: ProposalItem[], address: string): ProposalItem[] {
  if (!address) return []
  const sender = normalizeSuiAddress(address)
  return proposals.filter(proposal =>
    proposal.onChainId && proposal.chainSyncedAt && !proposal.syncError && proposal.memberWeights?.[sender])
}

export function buildProposalNotifications(
  proposals: ProposalItem[],
  address: string,
  now = Date.now(),
): ProposalNotification[] {
  return eligibleProposals(proposals, address).map(proposal => {
    const needsVote = proposal.status === "pending" && proposal.deadlineMs >= now && !proposal.voteWeights?.[address]
    return {
      proposal,
      key: `${proposal.onChainId}:${proposal.status}:${proposal.approvals}:${proposal.rejectedWeight || 0}`,
      title: needsVote ? t("misc.notif.needsVote")
        : proposal.status === "approved" ? t("misc.notif.thresholdReached")
        : proposal.status === "executed" ? t("misc.notif.executed")
        : proposal.status === "rejected" ? t("misc.notif.rejected")
        : proposal.deadlineMs < now ? t("misc.notif.expired")
        : t("misc.notif.updated"),
      needsVote,
    }
  }).slice(0, MAX_NOTIFICATIONS)
}

export function readNotificationKeys(address: string): string[] {
  if (!address || typeof localStorage === "undefined") return []
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(notificationReadKey(address)) || "[]")
    return Array.isArray(saved) ? saved.filter((value): value is string => typeof value === "string") : []
  } catch { return [] }
}

export function unreadCount(notifications: ProposalNotification[], read: string[]): number {
  const readSet = new Set(read)
  return notifications.filter(item => !readSet.has(item.key)).length
}

export function markNotificationsRead(address: string, keys: string[]): string[] {
  if (!address) return []
  const next = [...new Set([...readNotificationKeys(address), ...keys])].slice(-MAX_STORED_READ_KEYS)
  try {
    localStorage.setItem(notificationReadKey(address), JSON.stringify(next))
    if (typeof window !== "undefined") window.dispatchEvent(new Event(NOTIFICATIONS_UPDATED_EVENT))
  } catch { /* Storage may be unavailable; the dialog still shows the in-memory state. */ }
  return next
}
