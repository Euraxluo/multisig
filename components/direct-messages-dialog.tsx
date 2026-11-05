"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { Loader2, RefreshCw, Search, Send } from "lucide-react"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { getActiveAccount } from "@/lib/onchain-store"
import { getFollowing, getFollowers, getIdentity, getIdentityByAddress, resolveRecipient, type IdentityProfile } from "@/lib/identity-client"
import { IdentityAvatar } from "@/components/identity-avatar"
import { followersNotFollowed } from "@/lib/contact-lists"
import { enablePrivateMessages, hasMessagingKey, listPrivateConversations, sendPrivateMessage, getPrivateMessages, type PrivateConversation, type PrivateMessage } from "@/lib/private-messages"
import { useI18n } from "@/components/i18n-provider"
import { t as tGlobal } from "@/lib/i18n/t"

interface DirectMessagesDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  profile: IdentityProfile
  initialRecipient?: IdentityProfile
}

const errorMessage = (error: unknown) => error instanceof Error ? error.message : tGlobal("misc.dmd.failed")

export function DirectMessagesDialog({ open, onOpenChange, profile, initialRecipient }: DirectMessagesDialogProps) {
  const { t, locale } = useI18n()
  const dateLocale = locale === "zh" ? "zh-CN" : "en-US"
  const [peer, setPeer] = useState<IdentityProfile | null>(null)
  const [peerKeyReady, setPeerKeyReady] = useState(false)
  const [following, setFollowing] = useState<IdentityProfile[]>([])
  const [followers, setFollowers] = useState<IdentityProfile[]>([])
  /** Set when the follower projection could not be read, so an empty list is not read as "nobody". */
  const [followersError, setFollowersError] = useState("")
  const [conversations, setConversations] = useState<PrivateConversation[]>([])
  const [inboxTruncated, setInboxTruncated] = useState(false)
  const [inboxFailures, setInboxFailures] = useState<Array<{ senderId: string; reason: string }>>([])
  const [messages, setMessages] = useState<PrivateMessage[]>([])
  const [lookup, setLookup] = useState("")
  const [text, setText] = useState("")
  const [keyReady, setKeyReady] = useState(false)
  const [loading, setLoading] = useState(false)
  const [pending, setPending] = useState("")
  const [error, setError] = useState("")
  const [revision, setRevision] = useState(0)
  const generation = useRef(0)
  const lookupGeneration = useRef(0)
  const textBytes = new TextEncoder().encode(text.trim()).length
  const active = useCallback(() => getActiveAccount()?.address.toLowerCase() === profile.address.toLowerCase(), [profile.address])

  useEffect(() => {
    generation.current++
    lookupGeneration.current++
    setPeer(initialRecipient || null); setPeerKeyReady(!!initialRecipient?.encryptionKey.length); setMessages([]); setConversations([]); setInboxTruncated(false); setInboxFailures([]); setFollowing([]); setFollowers([]); setFollowersError(""); setText(""); setLookup("")
    setError(""); setKeyReady(false); setPending("")
    if (!open) return
    const close = () => {
      generation.current++; lookupGeneration.current++
      setMessages([]); setText(""); setPeer(null); setKeyReady(false); onOpenChange(false)
    }
    const storage = (event: StorageEvent) => { if (!event.key || event.key === "sui_active_account") close() }
    window.addEventListener("storage", storage)
    window.addEventListener("sui-account-switched", close)
    const invalidate = () => { generation.current++; lookupGeneration.current++ }
    return () => { invalidate(); window.removeEventListener("storage", storage); window.removeEventListener("sui-account-switched", close) }
  }, [open, profile.id, initialRecipient, onOpenChange])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    async function load() {
      if (!active()) throw new Error(t("misc.dmd.accountSwitched"))
      const liveProfile = await getIdentity(profile.id)
      // Incoming edges are the people most likely to write first; without them
      // a one-way follower can only be reached by typing an address by hand.
      // A failed projection must not hide the outgoing list or the inbox.
      const [ready, list, inbox] = await Promise.all([hasMessagingKey(liveProfile), getFollowing(liveProfile), listPrivateConversations(liveProfile)])
      // Keep the reason: `identity-client` throws rather than returning an empty
      // list precisely so a failed projection is never rendered as "nobody".
      let incoming: Awaited<ReturnType<typeof getFollowers>> | null = null
      let followersFailure = ""
      try { incoming = await getFollowers(liveProfile, { followingIds: new Set(list.map(person => person.id)) }) }
      catch (e) { followersFailure = errorMessage(e) }
      if (!cancelled && active()) {
        setKeyReady(ready); setFollowing(list); setConversations(inbox.conversations); setInboxTruncated(inbox.truncated); setInboxFailures(inbox.failures)
        setFollowers(incoming?.followers.map(row => row.profile) ?? []); setFollowersError(followersFailure)
      }
    }
    load().catch(e => { if (!cancelled) setError(errorMessage(e)) })
    return () => { cancelled = true }
  }, [open, profile, revision, active])

  useEffect(() => {
    setMessages([])
    if (!open || !peer) return
    let cancelled = false
    setLoading(true)
    Promise.all([getPrivateMessages(profile, peer), getIdentity(peer.id)])
      .then(([rows, livePeer]) => { if (!cancelled && active()) { setMessages(rows); setPeerKeyReady(!!livePeer.encryptionKey.length) } })
      .catch(e => { if (!cancelled) setError(errorMessage(e)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [open, profile, peer, revision, active])

  async function lookupPeer() {
    const value = lookup.trim()
    if (!value || pending) return
    const run = generation.current
    const lookupRun = ++lookupGeneration.current
    setPending("lookup"); setError("")
    try {
      const resolved = await resolveRecipient(value)
      const found = resolved.identity || await getIdentityByAddress(resolved.address)
      if (!found) throw new Error(t("misc.dmd.noProtocolIdentity"))
      if (found.id === profile.id) throw new Error(t("misc.dmd.pickOther"))
      if (run === generation.current && lookupRun === lookupGeneration.current && active()) { setPeer(found); setText("") }
    } catch (e) { if (run === generation.current && lookupRun === lookupGeneration.current) setError(errorMessage(e)) }
    finally { if (run === generation.current && lookupRun === lookupGeneration.current) setPending("") }
  }

  async function mutate(action: "enable" | "send") {
    if (pending) return
    const run = generation.current
    setPending(action); setError("")
    try {
      if (!active()) throw new Error(t("misc.dmd.accountSwitched"))
      if (action === "enable") {
        await enablePrivateMessages(profile)
        if (run !== generation.current || !active()) return
        const refreshed = await getIdentity(profile.id)
        if (run !== generation.current) return
        setKeyReady(await hasMessagingKey(refreshed))
        setRevision(value => value + 1)
      } else {
        if (!peer || !text.trim()) return
        if (textBytes > 1000) throw new Error(t("misc.dmd.msgTooLong"))
        const [sender, recipientProfile] = await Promise.all([getIdentity(profile.id), getIdentity(peer.id)])
        if (run !== generation.current || !active()) return
        if (!sender.encryptionKey.length) throw new Error(t("misc.dmd.enableFirst"))
        if (!recipientProfile.encryptionKey.length) throw new Error(t("misc.dmd.peerNotEnabled"))
        await sendPrivateMessage(sender, recipientProfile, text.trim())
      }
      if (run !== generation.current || !active()) return
      if (action === "send") setText("")
      setRevision(value => value + 1)
    } catch (e) { if (run === generation.current) setError(errorMessage(e)) }
    finally { if (run === generation.current) setPending("") }
  }

  // One-way followers: shown once, and never duplicated against the following list.
  const incomingOnly = followersNotFollowed(profile, following, followers)

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-h-[90dvh] w-[calc(100%-2rem)] max-w-lg overflow-y-auto rounded-xl">
      <DialogHeader><DialogTitle>{t("misc.dmd.title")}</DialogTitle><DialogDescription>{t("misc.dmd.description")}</DialogDescription></DialogHeader>
      <div className="rounded-lg border bg-muted/40 p-3 text-xs leading-relaxed text-muted-foreground">{t("misc.dmd.privacyNotice")}</div>
      {error && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}
      {!keyReady && <div className="space-y-2 rounded-lg border p-3"><p className="text-sm">{t("misc.dmd.enableIntro")}</p><Button disabled={!!pending} onClick={() => void mutate("enable")}>{pending === "enable" ? t("misc.dmd.enabling") : t("misc.dmd.enableHere")}</Button></div>}
      <form className="flex gap-2" onSubmit={e => { e.preventDefault(); void lookupPeer() }}><Input aria-label={t("misc.dmd.lookupAria")} value={lookup} onChange={e => setLookup(e.target.value)} placeholder={t("misc.dmd.lookupPlaceholder")} disabled={!!pending} /><Button type="submit" size="icon" aria-label={t("misc.dmd.searchAria")} disabled={!!pending || !lookup.trim()}><Search className="h-4 w-4" /></Button></form>
      {!peer && <div className="space-y-2 border-t pt-3"><div className="flex items-center justify-between gap-2"><h3 className="text-sm font-semibold">{t("misc.dmd.recent")}</h3><span className="text-xs text-muted-foreground">{t("misc.dmd.convCount", { count: conversations.length })}</span></div>{inboxTruncated && <p className="rounded-lg bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-300">{t("misc.dmd.inboxTruncated")}</p>}{inboxFailures.length > 0 && <p className="rounded-lg bg-destructive/10 p-2 text-xs text-destructive">{t("misc.dmd.inboxFailures", { count: inboxFailures.length })}</p>}{conversations.length ? conversations.map(conversation => <button key={conversation.peer.id} type="button" disabled={!!pending} onClick={() => { generation.current++; setPeer(conversation.peer); setText(""); setError("") }} className="flex w-full items-center gap-3 rounded-lg border p-2 text-left transition-colors hover:bg-muted/50"><IdentityAvatar profile={conversation.peer} /><span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{conversation.peer.displayName || `${conversation.peer.label}.id`}</span><span className="block truncate text-xs text-muted-foreground">{conversation.lastMessage?.text || conversation.lastMessage?.unavailableReason || t("misc.dmd.undecryptable")}</span></span><span className="shrink-0 text-right text-[10px] text-muted-foreground"><span className="block">{conversation.lastMessage ? new Date(conversation.lastMessage.timestampMs).toLocaleDateString(dateLocale) : "—"}</span><span>{t("misc.dmd.msgCount", { count: conversation.messageCount })}</span></span></button>) : <p className="py-4 text-center text-sm text-muted-foreground">{t("misc.dmd.noConversations")}</p>}</div>}
      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">{t("misc.dmd.pickHint")}</p>
        <div className="flex flex-wrap gap-2">{following.filter(person => person.id !== profile.id).map(person => <Button key={person.id} variant={peer?.id === person.id ? "secondary" : "outline"} size="sm" disabled={!!pending} onClick={() => { generation.current++; setPeer(person); setText(""); setError("") }}><span className="mr-1.5 inline-flex"><IdentityAvatar profile={person} size="sm" /></span>{person.displayName || `${person.label}.id`}</Button>)}</div>
        {!following.length && <p className="text-xs text-muted-foreground">{t("misc.dmd.noFollowContacts")}</p>}
        {/* Followers you have not followed back are still reachable without
            typing an address. This list is the bounded event projection. */}
        {followersError && <p role="status" className="text-[11px] text-amber-600">{t("misc.dmd.followersFailed", { error: followersError })}</p>}
        {incomingOnly.length > 0 && <>
          <p className="pt-1 text-xs text-muted-foreground">{t("misc.dmd.followedBy")}</p>
          <div className="flex flex-wrap gap-2">{incomingOnly.map(person => <Button key={person.id} variant="outline" size="sm" disabled={!!pending} onClick={() => { generation.current++; setPeer(person); setText(""); setError("") }}><span className="mr-1.5 inline-flex"><IdentityAvatar profile={person} size="sm" /></span>{person.displayName || `${person.label}.id`}</Button>)}</div>
        </>}
      </div>
      {peer ? <>
        <div className="flex items-center justify-between gap-2 border-t pt-3"><div className="min-w-0"><h3 className="truncate text-sm font-semibold">{peer.displayName || `${peer.label}.id`}</h3><p className="break-all font-mono text-xs text-muted-foreground">{peer.address}</p></div><Button variant="ghost" size="icon" aria-label={t("misc.dmd.refreshAria")} disabled={!!pending || loading} onClick={() => { setError(""); setRevision(value => value + 1) }}><RefreshCw className="h-4 w-4" /></Button></div>
        {!peerKeyReady && <p className="text-xs text-muted-foreground">{t("misc.dmd.peerNotReady")}</p>}
        <div aria-live="polite" className="max-h-72 min-h-32 space-y-3 overflow-y-auto rounded-lg bg-muted/30 p-3">
          {loading ? <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{t("misc.dmd.loadingMessages")}</p> : messages.length ? messages.map(message => <div key={message.id} className={`flex ${message.senderId === profile.id ? "justify-end" : "justify-start"}`}><div className={`max-w-[90%] rounded-lg p-2.5 ${message.senderId === profile.id ? "bg-primary/10" : "bg-background"}`}><p className="whitespace-pre-wrap break-words text-sm">{message.text ?? message.unavailableReason ?? t("misc.dmd.undecryptable")}</p><time className="mt-1 block text-[10px] text-muted-foreground">{new Date(message.timestampMs).toLocaleString(dateLocale)}</time></div></div>) : <p className="text-sm text-muted-foreground">{t("misc.dmd.noMessages")}</p>}
        </div>
        <form className="space-y-2" onSubmit={e => { e.preventDefault(); void mutate("send") }}><Textarea aria-label={t("misc.dmd.composerAria")} placeholder={t("misc.dmd.composerPlaceholder")} value={text} onChange={e => setText(e.target.value)} disabled={!!pending || !keyReady || !peerKeyReady} /><div className="flex items-center justify-between gap-2"><span className={`text-xs ${textBytes > 1000 ? "text-destructive" : "text-muted-foreground"}`}>{t("misc.dmd.bytes", { count: textBytes })}</span><Button type="submit" disabled={!!pending || !keyReady || !peerKeyReady || !text.trim() || textBytes > 1000}><Send className="mr-1 h-4 w-4" />{pending === "send" ? t("misc.dmd.sending") : t("misc.dmd.send")}</Button></div></form>
      </> : <p className="py-4 text-center text-sm text-muted-foreground">{t("misc.dmd.pickPeerFirst")}</p>}
    </DialogContent>
  </Dialog>
}
