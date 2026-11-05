// Memory-only outbox for group chat.
//
// Every `post_message` transaction currently pays a full Sui transaction plus a
// 0.001 SUI subsidy transfer. A chat user often types several lines in a row, so
// this outbox collects the burst and submits one PTB containing one
// `post_message` call per line: one wallet approval, one transaction
// certificate, and one shared-object fee instead of N. Messages stay in this
// tab's memory until the PTB is confirmed; a reload drops them rather than
// pretending they were sent.
import { t } from "./i18n/t"
export const MAX_OUTBOX_MESSAGES = 32
/** Wait for a burst to finish before submitting one PTB. */
export const OUTBOX_FLUSH_DELAY_MS = 900

const outboxes = new Map<string, string[]>()
const key = (channelId: string) => channelId.toLowerCase()

/** Add one line; returns the number queued and whether the burst is full. */
export function enqueueChatMessage(channelId: string, text: string): { queued: number; full: boolean } {
  const value = text.trim()
  if (!value) throw new Error(t("misc.outbox.empty"))
  if (value.length > 4_096) throw new Error(t("misc.outbox.tooLong"))
  const current = outboxes.get(key(channelId)) ?? []
  if (current.length >= MAX_OUTBOX_MESSAGES) return { queued: current.length, full: true }
  current.push(value)
  outboxes.set(key(channelId), current)
  return { queued: current.length, full: current.length >= MAX_OUTBOX_MESSAGES }
}

export function peekChatOutbox(channelId: string): string[] {
  return [...(outboxes.get(key(channelId)) ?? [])]
}

/** Remove and return the queued lines, so a failed submit can restore them. */
export function takeChatOutbox(channelId: string): string[] {
  const current = outboxes.get(key(channelId)) ?? []
  outboxes.delete(key(channelId))
  return [...current]
}

/** Put failed lines back in front of anything queued meanwhile. */
export function restoreChatOutbox(channelId: string, texts: string[]): void {
  if (texts.length === 0) return
  const current = outboxes.get(key(channelId)) ?? []
  outboxes.set(key(channelId), [...texts, ...current].slice(0, MAX_OUTBOX_MESSAGES))
}

export function clearChatOutbox(channelId: string): void {
  outboxes.delete(key(channelId))
}
