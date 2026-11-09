"use client"

import { useEffect, useRef, useState } from "react"
import { Loader2, MessageSquare, QrCode, RefreshCw, Search, Users } from "lucide-react"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { getActiveAccount } from "@/lib/onchain-store"
import { identityConfigured, getIdentityByAddress, resolveRecipient, getFollowing, getFollowers, isFollowing, followRelationship, mintIdentity, renameIdentity, updateProfile, followIdentity, unfollowIdentity, getReceivedObjects, withdrawObject, type IdentityProfile, type ReceivedObject, type FollowerList } from "@/lib/identity-client"
import { IdentityAvatar, safeAvatar } from "@/components/identity-avatar"
import { DirectMessagesDialog } from "@/components/direct-messages-dialog"
import { ShareQrDialog } from "@/components/share-qr-dialog"
import { useI18n } from "@/components/i18n-provider"
import { t as tGlobal } from "@/lib/i18n/t"

export function identityError(error: unknown) {
  return error instanceof Error ? error.message : tGlobal("misc.id.actionFailed")
}

export function IdentityPanel({ target, onProfileLoaded }: { target?: string; onProfileLoaded?: (profile: IdentityProfile | null) => void }) {
  const { t } = useI18n()
  const [address, setAddress] = useState("")
  const [accountReady, setAccountReady] = useState(false)
  const [me, setMe] = useState<IdentityProfile | null>(null)
  const [viewed, setViewed] = useState<IdentityProfile | null>(null)
  const [viewAddress, setViewAddress] = useState("")
  const [lookupKind, setLookupKind] = useState<"address" | "suins" | "protocol" | "">("")
  const [lookup, setLookup] = useState(target || "")
  const [selectedTarget, setSelectedTarget] = useState(target || "")
  const [following, setFollowing] = useState<Array<{ profile: IdentityProfile; mutual: boolean }>>([])
  const [followers, setFollowers] = useState<FollowerList | null>(null)
  const [objects, setObjects] = useState<ReceivedObject[]>([])
  const [followed, setFollowed] = useState(false)
  const [followsMe, setFollowsMe] = useState(false)
  const [label, setLabel] = useState("")
  const [displayName, setDisplayName] = useState("")
  const [avatarUrl, setAvatarUrl] = useState("")
  const [recipient, setRecipient] = useState("")
  const [loading, setLoading] = useState(false)
  const [detailsLoading, setDetailsLoading] = useState(false)
  /** Set when the detail read failed, so empty lists below are not read as "none exist". */
  const [detailsError, setDetailsError] = useState("")
  const [pending, setPending] = useState("")
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [revision, setRevision] = useState(0)
  const [dmPeer, setDmPeer] = useState<IdentityProfile | undefined>()
  const [dmOpen, setDmOpen] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const epoch = useRef(0)
  const configured = identityConfigured()

  useEffect(() => {
    const sync = () => {
      epoch.current++
      setAddress(getActiveAccount()?.address || "")
      setAccountReady(true)
      setMe(null); setViewed(null); setFollowing([]); setFollowers(null); setObjects([])
      setError(""); setNotice(""); setPending(""); setDmOpen(false); setShareOpen(false)
      setRecipient(""); setLabel(""); setDisplayName(""); setAvatarUrl("")
      setRevision(value => value + 1)
    }
    sync()
    const storage = (event: StorageEvent) => { if (!event.key || event.key === "sui_active_account") sync() }
    window.addEventListener("storage", storage)
    window.addEventListener("sui-account-switched", sync)
    const invalidate = () => { epoch.current++ }
    return () => { invalidate(); window.removeEventListener("storage", storage); window.removeEventListener("sui-account-switched", sync) }
  }, [])

  useEffect(() => { setSelectedTarget(target || ""); setLookup(target || "") }, [target])

  useEffect(() => {
    if (!accountReady) return
    let cancelled = false
    const run = ++epoch.current
    setLoading(true); setError(""); setViewed(null); setMe(null); setViewAddress("")
    setFollowing([]); setFollowers(null); setObjects([]); setFollowed(false); setFollowsMe(false)
    async function load() {
      const mine = configured && address ? await getIdentityByAddress(address) : null
      let profile = mine
      let resolvedAddress = address
      let kind: "address" | "suins" | "protocol" | "" = ""
      if (selectedTarget.trim()) {
        const resolved = await resolveRecipient(selectedTarget.trim())
        resolvedAddress = resolved.address
        kind = resolved.kind
        profile = resolved.identity || (configured ? await getIdentityByAddress(resolved.address) : null)
      }
      if (cancelled || run !== epoch.current) return
      setMe(mine); setViewed(profile); setViewAddress(resolvedAddress); setLookupKind(kind)
      setLabel(profile?.label || ""); setDisplayName(profile?.displayName || ""); setAvatarUrl(profile?.avatarUrl || "")
    }
    load().catch(e => { if (!cancelled && run === epoch.current) setError(identityError(e)) })
      .finally(() => { if (!cancelled && run === epoch.current) setLoading(false) })
    return () => { cancelled = true }
  }, [address, accountReady, configured, selectedTarget, revision])

  const own = !!viewed && viewed.address.toLowerCase() === address.toLowerCase()

  useEffect(() => { onProfileLoaded?.(me) }, [me, onProfileLoaded])

  useEffect(() => {
    if (!viewed) return
    let cancelled = false
    setDetailsLoading(true)
    setDetailsError("")
    const load = async () => {
      const list = await getFollowing(viewed)
      const rows = await Promise.all(list.map(async profile => ({ profile, mutual: await isFollowing(profile, viewed.id) })))
      const followsTarget = me && me.id !== viewed.id ? await isFollowing(me, viewed.id) : false
      // The reverse edge is what distinguishes "关注" from "互相关注" and "回关".
      const targetFollowsMe = me && me.id !== viewed.id ? await isFollowing(viewed, me.id) : false
      // Incoming edges are a bounded projection of Followed/Unfollowed events;
      // reuse the outgoing set already read here for the mutual flag.
      const outgoingIds = new Set(list.map(item => item.id))
      const incoming = await getFollowers(viewed, { followingIds: outgoingIds })
      const received = own ? await getReceivedObjects(viewed) : []
      if (!cancelled) { setFollowing(rows); setFollowers(incoming); setFollowed(!!followsTarget); setFollowsMe(!!targetFollowsMe); setObjects(received) }
    }
    load().catch(e => { if (!cancelled) { setError(identityError(e)); setDetailsError(identityError(e)) } })
      .finally(() => { if (!cancelled) setDetailsLoading(false) })
    return () => { cancelled = true }
  }, [viewed, me, own])

  async function mutate(action: string, task: () => Promise<void>) {
    if (pending) return
    const run = epoch.current
    const signer = address
    setPending(action); setError(""); setNotice("")
    try {
      if (!configured) throw new Error(t("misc.id.notConfiguredThrow"))
      if (!signer || getActiveAccount()?.address !== signer) throw new Error(t("misc.id.accountSwitched"))
      await task()
      if (run !== epoch.current || getActiveAccount()?.address !== signer) return
      setNotice(t("misc.id.confirmed"))
      setRevision(value => value + 1)
    } catch (e) { if (run === epoch.current) setError(identityError(e)) }
    finally { if (run === epoch.current) setPending("") }
  }

  function browse(value: string) {
    epoch.current++
    setPending(""); setError(""); setNotice(""); setFollowing([]); setFollowers(null); setObjects([]); setViewed(null)
    setSelectedTarget(value.trim())
    setRevision(value => value + 1)
  }

  const disabled = !!pending || loading
  return <Card className="overflow-hidden rounded-2xl border border-border/60 bg-surface-card shadow-sm">
    <CardHeader className="p-4 pb-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-semibold text-label-primary">{t("misc.id.title")}</h2>
        <div className="flex items-center gap-2"><Badge variant="outline" className="rounded-full">{t("misc.id.nsBadge")}</Badge><Button size="icon" variant="ghost" aria-label={t("misc.id.refreshAria")} disabled={!!pending || loading} onClick={() => setRevision(value => value + 1)} className="rounded-full touch-target-expand"><RefreshCw className="h-4 w-4" /></Button></div>
      </div>
      <p className="text-xs text-muted-foreground">{t("misc.id.intro")}</p>
    </CardHeader>
    <CardContent className="p-4 pt-0 space-y-4">
      {!target && <div className="grid grid-cols-2 gap-2">
        <Button variant="outline" size="sm" className="rounded-xl active:scale-[0.98]" onClick={() => {
          if (me) { setDmPeer(undefined); setDmOpen(true) }
          else setError(!address ? t("misc.id.dmInboxErrorNoWallet") : !configured ? t("misc.id.dmInboxErrorNoProtocol") : t("misc.id.dmInboxErrorNoIdentity"))
        }}><MessageSquare className="mr-1.5 h-4 w-4" />{t("misc.id.dmInbox")}</Button>
        <Button variant="outline" size="sm" className="rounded-xl active:scale-[0.98]" onClick={() => {
          if (me) { browse(""); document.getElementById("identity-following")?.scrollIntoView({ behavior: "smooth", block: "center" }) }
          else setError(!address ? t("misc.id.followsErrorNoWallet") : t("misc.id.followsErrorNoIdentity"))
        }}><Users className="mr-1.5 h-4 w-4" />{t("misc.id.myFollows")}</Button>
      </div>}
      {!configured && <p className="rounded-xl bg-muted/60 p-3 text-sm">{t("misc.id.notConfiguredNotice")}</p>}
      <>
        <form className="flex gap-2" onSubmit={e => { e.preventDefault(); if (lookup.trim()) browse(lookup) }}>
          <Input className="rounded-xl" aria-label={t("misc.id.lookupAria")} placeholder={t("misc.id.lookupPlaceholder")} value={lookup} onChange={e => setLookup(e.target.value)} disabled={!!pending} />
          <Button type="submit" size="icon" className="rounded-xl active:scale-95 touch-target-expand" aria-label={t("misc.id.searchAria")} disabled={disabled || !lookup.trim()}><Search className="h-4 w-4" /></Button>
        </form>
        {selectedTarget && <Button size="sm" variant="ghost" className="rounded-xl active:scale-95" disabled={!!pending} onClick={() => { setLookup(""); browse("") }}>{t("misc.id.backToMine")}</Button>}
        {error && <p role="alert" className="break-words rounded-lg bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
        {notice && <p role="status" className="text-sm text-emerald-600">{notice}</p>}
        {(loading || !accountReady) && <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{t("misc.id.loadingIdentity")}</p>}
        {!loading && accountReady && !viewed && !error && <div className="space-y-3 rounded-xl bg-muted/40 p-3">
          <p className="text-sm">{selectedTarget ? (viewAddress ? t("misc.id.noAddressIdentity") : t("misc.id.notFound")) : address ? t("misc.id.mintForAccount") : t("misc.id.mintIntro")}</p>
          {viewAddress && <p className="break-all font-mono text-xs text-muted-foreground">{viewAddress}</p>}
          {configured && !selectedTarget && address && <form className="flex gap-2" onSubmit={e => { e.preventDefault(); void mutate("mint", () => mintIdentity(label.trim())) }}>
            <Input aria-label={t("misc.id.mintNameAria")} placeholder={t("misc.id.mintNamePlaceholder")} value={label} onChange={e => setLabel(e.target.value)} disabled={disabled} maxLength={63} />
            <Button type="submit" disabled={disabled || !label.trim()}>{pending === "mint" ? t("misc.id.signing") : t("misc.id.freeMint")}</Button>
          </form>}
        </div>}
        {!loading && selectedTarget && viewAddress && <p className="break-all rounded-lg bg-muted/40 p-2 text-xs text-muted-foreground">{lookupKind === "protocol" ? t("misc.id.protocolResolved") : lookupKind === "suins" ? t("misc.id.suinsResolved") : t("misc.id.addressResolved")} {viewAddress}</p>}
        {!loading && viewed && <>
          <div className="flex items-center gap-3">
            <IdentityAvatar profile={viewed} />
            <div className="min-w-0 flex-1"><p className="truncate font-semibold">{viewed.displayName || `${viewed.label}.id`}</p><p className="text-sm text-primary">{viewed.label}.id</p><p className="break-all font-mono text-xs text-muted-foreground">{viewed.address}</p></div>
          </div>
          {(() => {
            const relation = followRelationship(own, followed, followsMe)
            const badge = relation === "mutual" ? t("misc.id.mutual") : relation === "following" ? t("misc.id.following") : relation === "followed-by" ? t("misc.id.followedBy") : ""
            return badge ? <div className="flex flex-wrap items-center gap-2"><Badge variant={relation === "mutual" ? "default" : "secondary"}>{badge}</Badge>{relation === "followed-by" && <span className="text-xs text-muted-foreground">{t("misc.id.followedByHint")}</span>}{relation === "following" && <span className="text-xs text-muted-foreground">{t("misc.id.followingWaitHint")}</span>}</div> : null
          })()}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => setShareOpen(true)}><QrCode className="mr-1 h-4 w-4" />{t("misc.id.myQr")}</Button>
            {me && <Button size="sm" variant="outline" disabled={disabled} onClick={() => { setDmPeer(own ? undefined : viewed); setDmOpen(true) }}><MessageSquare className="mr-1 h-4 w-4" />{own ? t("misc.id.dmInbox") : t("misc.id.dmSend")}</Button>}
            {!own && <Button size="sm" disabled={disabled || !me} onClick={() => me && void mutate("follow", () => followed ? unfollowIdentity(me, viewed) : followIdentity(me, viewed))}>{pending === "follow" ? t("misc.id.signing") : followed ? t("misc.id.unfollow") : followsMe ? t("misc.id.followBack") : t("misc.id.follow")}</Button>}
          </div>
          {!own && !me && <p className="text-xs text-muted-foreground">{t("misc.id.followDmHint")}</p>}
          {own && <div className="space-y-3 rounded-xl border p-3">
            <h3 className="text-sm font-medium">{t("misc.id.profileSection")}</h3>
            <div className="space-y-1"><Label htmlFor="identity-name">{t("misc.id.displayName")}</Label><Input id="identity-name" value={displayName} onChange={e => setDisplayName(e.target.value)} disabled={disabled} maxLength={80} /></div>
            <div className="space-y-1"><Label htmlFor="identity-avatar">{t("misc.id.avatarUrl")}</Label><Input id="identity-avatar" type="url" placeholder="https://…" value={avatarUrl} onChange={e => setAvatarUrl(e.target.value)} disabled={disabled} /><p className="text-xs text-muted-foreground">{t("misc.id.avatarHint")}</p></div>
            <Button size="sm" disabled={disabled} onClick={() => void mutate("profile", async () => { const url = avatarUrl.trim(); if (url && !safeAvatar(url)) throw new Error(t("misc.id.avatarInvalid")); await updateProfile(viewed, displayName.trim(), url) })}>{pending === "profile" ? t("misc.id.signing") : t("misc.id.saveProfile")}</Button>
            <div className="flex gap-2 border-t pt-3"><Input aria-label={t("misc.id.newNameAria")} value={label} onChange={e => setLabel(e.target.value)} disabled={disabled} maxLength={63} /><Button size="sm" variant="outline" disabled={disabled || !label.trim() || label.trim() === viewed.label} onClick={() => void mutate("rename", () => renameIdentity(viewed, label.trim()))}>{t("misc.id.renameNs")}</Button></div>
            <p className="text-xs text-muted-foreground">{t("misc.id.renameHint")}</p>
          </div>}
          <section id="identity-following" className="scroll-mt-20 space-y-2">
            <h3 className="flex items-center gap-1 text-sm font-medium"><Users className="h-4 w-4" />{own ? t("misc.id.myFollows") : t("misc.id.followingTitleOther")} · {viewed.followingCount}</h3>
            {detailsLoading ? <p className="text-xs text-muted-foreground">{t("misc.id.loadingFollows")}</p> : following.length ? following.map(({ profile, mutual }) => <div key={profile.id} className="flex items-center justify-between gap-2 rounded-xl bg-surface-secondary/60 p-2.5 hover:bg-surface-secondary transition-colors">
              <button type="button" disabled={disabled} onClick={() => { setLookup(profile.address); browse(profile.address) }} className="flex min-w-0 items-center gap-2 truncate text-left text-sm text-primary"><IdentityAvatar profile={profile} size="sm" /><span className="truncate">{profile.displayName || `${profile.label}.id`}</span></button>
              <div className="flex shrink-0 items-center gap-1">{mutual && <Badge variant="secondary">{t("misc.id.mutual")}</Badge>}{me && profile.id !== me.id && <Button variant="ghost" size="sm" disabled={disabled} onClick={() => { setDmPeer(profile); setDmOpen(true) }}>{t("misc.id.dm")}</Button>}</div>
            </div>) : <p className="text-xs text-muted-foreground">{detailsError ? t("misc.id.followsFailed") : t("misc.id.noFollows")}</p>}
            <p className="text-xs text-muted-foreground">{t("misc.id.followsSourceHint")}</p>
          </section>
          <section id="identity-followers" className="scroll-mt-20 space-y-2">
            <h3 className="flex items-center gap-1 text-sm font-medium"><Users className="h-4 w-4" />{own ? t("misc.id.followersTitleMine") : t("misc.id.followersTitleOther")}{followers && <> · {followers.followers.length}{followers.truncated ? "+" : ""}</>}</h3>
            {detailsLoading ? <p className="text-xs text-muted-foreground">{t("misc.id.rebuildingFollowers")}</p> : followers && followers.followers.length ? followers.followers.map(({ profile, mutual }) => <div key={profile.id} className="flex items-center justify-between gap-2 rounded-xl bg-surface-secondary/60 p-2.5 hover:bg-surface-secondary transition-colors">
              <button type="button" disabled={disabled} onClick={() => { setLookup(profile.address); browse(profile.address) }} className="flex min-w-0 items-center gap-2 truncate text-left text-sm text-primary"><IdentityAvatar profile={profile} size="sm" /><span className="truncate">{profile.displayName || `${profile.label}.id`}</span></button>
              <div className="flex shrink-0 items-center gap-1">{mutual && <Badge variant="secondary">{t("misc.id.mutual")}</Badge>}{me && profile.id !== me.id && <Button variant="ghost" size="sm" disabled={disabled} onClick={() => { setDmPeer(profile); setDmOpen(true) }}>{t("misc.id.dm")}</Button>}</div>
            </div>) : <p className="text-xs text-muted-foreground">{detailsError ? t("misc.id.followersFailed") : t("misc.id.noFollowers")}</p>}
            {followers?.truncated && <p role="status" className="rounded-lg bg-muted/60 p-2 text-xs text-muted-foreground">{t("misc.id.scanBounded", { count: followers.scannedEvents })}</p>}
            {!!followers?.historicalUnfollows && <p className="text-xs text-muted-foreground">{t("misc.id.historicalUnfollows", { count: followers.historicalUnfollows })}</p>}
            <p className="text-xs text-muted-foreground">{t("misc.id.followersHintA")}<code>Followed</code>/<code>Unfollowed</code>{t("misc.id.followersHintB")}</p>
          </section>
          {own && <section className="space-y-2 border-t pt-3">
            <h3 className="text-sm font-medium">{t("misc.id.inboxSection")}</h3><p className="break-all font-mono text-xs text-muted-foreground">{t("misc.id.receiveObjectId")}{viewed.id}</p>
            <p className="text-xs text-muted-foreground">{t("misc.id.inboxHint")}</p>
            <Input aria-label={t("misc.id.withdrawAria")} placeholder={t("misc.id.withdrawPlaceholder")} value={recipient} onChange={e => setRecipient(e.target.value)} disabled={disabled} />
            {detailsLoading ? <p className="text-xs text-muted-foreground">{t("misc.id.loadingObjects")}</p> : objects.length ? objects.map(object => <div key={object.id} className="flex items-center gap-2 rounded-lg border p-2"><div className="min-w-0 flex-1"><p className="break-all text-xs">{object.type}</p><p className="break-all font-mono text-xs text-muted-foreground">{object.id}</p></div><Button size="sm" variant="outline" disabled={disabled} onClick={() => void mutate(object.id, async () => { const to = recipient.trim() || address; if (getActiveAccount()?.address !== address) throw new Error(t("misc.id.accountSwitchedRetry")); await withdrawObject(viewed, object, to) })}>{pending === object.id ? t("misc.id.signing") : t("misc.id.withdraw")}</Button></div>) : <p className="text-xs text-muted-foreground">{detailsError ? t("misc.id.inboxFailed") : t("misc.id.noObjects")}</p>}
          </section>}
          <ShareQrDialog open={shareOpen} onOpenChange={setShareOpen} title={t("misc.id.shareQrTitle", { label: viewed.label })} kind="person" identifier={viewed.address} description={t("misc.id.shareQrDesc")} />
        </>}
        {me && <DirectMessagesDialog open={dmOpen} onOpenChange={setDmOpen} profile={me} initialRecipient={dmPeer} />}
      </>
    </CardContent>
  </Card>
}
