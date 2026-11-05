"use client"

// One row in the merged group conversation. Both transports project into this
// shape so the chat tab has a single list: the on-chain channel and the
// Sui Stack Messaging channel differ in delivery and trust, not in layout.
import { FileText, ShieldAlert, ShieldCheck, Vote } from "lucide-react"
import { safeAvatar } from "@/components/identity-avatar"
import { useI18n } from "@/components/i18n-provider"

export type ChatTransport = "onchain" | "ssm" | "local"

export interface UnifiedChatRow {
  key: string
  transport: ChatTransport
  /** Timestamp used only for ordering across transports; absent on legacy notes. */
  at?: number
  mine: boolean
  sender: string
  role: string
  time: string
  text: string
  walrusBlobId?: string
  redPacketId?: string
  /** Sui Stack rows only: the SDK's per-message sender signature check. */
  senderVerified?: boolean
  deleted?: boolean
  edited?: boolean
  /** On-chain avatar for the sender's protocol identity, when one exists. */
  avatarUrl?: string
}

interface UnifiedChatMessageProps {
  row: UnifiedChatRow
  redPacket?: React.ReactNode
  onOpenBlob?: (blobId: string) => void
}

export function UnifiedChatMessage({ row, redPacket, onOpenBlob }: UnifiedChatMessageProps) {
  const { t } = useI18n()
  const ssm = row.transport === "ssm"
  const avatar = row.avatarUrl ? safeAvatar(row.avatarUrl) : undefined
  return (
    <div className={`flex flex-col ${row.mine ? "items-end" : "items-start"}`}>
      <div className="flex items-center space-x-1.5 mb-0.5 text-[10px] text-muted-foreground">
        {/* The avatar host comes from the sender's identity, so it cannot be
            listed in `images.remotePatterns` ahead of time. `safeAvatar` has
            already rejected anything that is not https. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {!row.mine && avatar && <img src={avatar} referrerPolicy="no-referrer" alt="" className="h-3.5 w-3.5 rounded-full object-cover" />}
        <span className="font-medium text-foreground">{row.sender}</span>
        <span>({row.role})</span>
        <span>{row.time}</span>
        {ssm && (row.senderVerified
          ? <ShieldCheck className="h-3 w-3 text-emerald-500" aria-label={t("misc.ucm.verifiedAria")} />
          : <ShieldAlert className="h-3 w-3 text-amber-500" aria-label={t("misc.ucm.unverifiedAria")} />)}
        {row.edited && <span>{t("misc.ucm.edited")}</span>}
      </div>
      <div
        className={`p-2.5 rounded-xl max-w-[85%] text-xs leading-relaxed ${
          row.mine
            ? "bg-primary text-primary-foreground rounded-tr-none shadow-sm"
            : row.role === "AI"
              ? "bg-purple-500/15 border border-purple-500/30 text-foreground rounded-tl-none font-mono text-[11px]"
              : "bg-card border border-border/60 text-foreground rounded-tl-none"
        }`}
      >
        <p className="whitespace-pre-wrap">{row.deleted ? t("misc.ucm.deleted") : row.text}</p>
        {redPacket}
        {row.walrusBlobId && (
          <button
            type="button"
            id={`blob-btn-${row.key}`}
            onClick={(e) => {
              e.stopPropagation()
              onOpenBlob?.(row.walrusBlobId!)
            }}
            className="mt-2 pt-1.5 border-t border-white/20 text-[10px] flex items-center justify-between gap-1.5 text-cyan-200 hover:text-white transition-colors cursor-pointer w-full text-left"
          >
            <div className="flex items-center gap-1.5 truncate">
              {row.walrusBlobId.endsWith(".wma") ? (
                <Vote className="h-3 w-3 shrink-0 text-purple-300" />
              ) : (
                <FileText className="h-3 w-3 shrink-0 text-cyan-300" />
              )}
              {/* The blob id says nothing about the content. Naming it a poll
                  with a specific title invented both the type and the subject. */}
              <span className="truncate">
                {row.walrusBlobId.endsWith(".wma") ? t("misc.ucm.walrusAudio") : t("misc.ucm.walrusDoc")}
              </span>
            </div>
            <span className="text-[9px] bg-white/20 px-1.5 py-0.5 rounded text-white shrink-0">
              {t("misc.ucm.viewBlob")}
            </span>
          </button>
        )}
      </div>
      {!row.mine && ssm && !row.senderVerified && <span className="mt-0.5 text-[9px] text-amber-600">{t("misc.ucm.unverifiedWarning")}</span>}
    </div>
  )
}
