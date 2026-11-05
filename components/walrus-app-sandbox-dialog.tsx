"use client"

import { useEffect, useRef, useState } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { AlertCircle, ArrowLeft, ArrowUpRight, CalendarDays, CheckCircle2, Eye, Loader2, Plus, RefreshCw, Users, Vote } from "lucide-react"
import { CreateVoteDialog } from "@/components/create-vote-dialog"
import { VoteDetailsDialog } from "@/components/vote-details-dialog"
import { getActiveAccount, getUserGroups } from "@/lib/onchain-store"
import { pollLinks } from "@/lib/governance-poll-client"
import { shortAddress, type GovernanceVote } from "@/lib/governance"
import { groupPollReader, resolveGroupPollScope, type GroupPollList, type GroupPollOrganization, type GroupPollScope } from "@/lib/group-polls"
import { normalizeSuiAddress } from "@mysten/sui/utils"
import { useI18n } from "@/components/i18n-provider"

export interface WalrusAppSandboxDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  groupId?: string
  orgId?: string
  /** Shared group/app entries stay read only unless the parent explicitly opts in. */
  readOnly?: boolean
  initialPollId?: string
  appName?: string
  // Legacy launch metadata never establishes poll identity or voter authority.
  blobId?: string
  author?: string
  isMemberStaked?: boolean
}
const emptyList = (): GroupPollList => ({ votes: [], failures: [], truncated: false })
const MODE_LABEL_KEY: Record<string, string> = { single: "walrus.sandboxModeSingle", multiple: "walrus.sandboxModeMultiple", ranked: "walrus.sandboxModeRanked" }

export function WalrusAppSandboxDialog({ open, onOpenChange, groupId, orgId, readOnly = true, initialPollId, appName }: WalrusAppSandboxDialogProps) {
  const { t, locale } = useI18n()
  // An absent deadline is not a date to render: it is shown as unset rather than
  // formatted from `undefined`, which would print "Invalid Date".
  const dateLabel = (value?: string) => value ? new Date(value).toLocaleString(locale === "zh" ? "zh-CN" : "en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : t("walrus.sandboxDateUnset")
  const [scope, setScope] = useState<GroupPollScope | null>(null)
  const [organization, setOrganization] = useState<GroupPollOrganization | null>(null)
  const [list, setList] = useState<GroupPollList>(emptyList)
  const [selected, setSelected] = useState<GovernanceVote | null>(null)
  const [pollId, setPollId] = useState("")
  const [address, setAddress] = useState("")
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)
  const [reading, setReading] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [voteOpen, setVoteOpen] = useState(false)
  const [revision, setRevision] = useState(0)
  const generation = useRef(0)
  const selectionGeneration = useRef(0)
  const currentContext = useRef("")
  const context = `${groupId || ""}:${orgId || ""}:${readOnly}:${initialPollId || ""}`
  const [loadedContext, setLoadedContext] = useState("")
  const ready = loadedContext === context

  useEffect(() => {
    if (!open) return
    const update = () => setRevision(value => value + 1)
    const accountChanged = () => {
      generation.current++; selectionGeneration.current++
      setSelected(null); setOrganization(null); setList(emptyList()); setAddress("")
      setCreateOpen(false); setVoteOpen(false); update()
    }
    const storage = (event: StorageEvent) => event.key === "sui_active_account" ? accountChanged() : update()
    const events = ["sui-votes-updated", "sui-vote-records-updated"]
    events.forEach(event => window.addEventListener(event, update))
    window.addEventListener("sui-account-switched", accountChanged)
    window.addEventListener("sui-account-changed", accountChanged)
    window.addEventListener("storage", storage)
    return () => {
      events.forEach(event => window.removeEventListener(event, update))
      window.removeEventListener("sui-account-switched", accountChanged)
      window.removeEventListener("sui-account-changed", accountChanged)
      window.removeEventListener("storage", storage)
    }
  }, [open])

  useEffect(() => {
    const run = ++generation.current
    selectionGeneration.current++
    if (!open) { currentContext.current = ""; setSelected(null); setCreateOpen(false); setVoteOpen(false); return }
    const changed = currentContext.current !== context
    currentContext.current = context
    if (changed) { setSelected(null); setCreateOpen(false); setVoteOpen(false); setPollId(initialPollId || ""); setList(emptyList()) }
    setLoading(true); setReading(false); setError(""); setOrganization(null); setLoadedContext(context)
    void (async () => {
      try {
        const resolved = resolveGroupPollScope(groupId, orgId, getUserGroups())
        const voter = getActiveAccount()?.address || ""
        if (run !== generation.current) return
        setScope(resolved); setAddress(voter)
        const org = await groupPollReader.readOrganization(resolved.orgId)
        if (run !== generation.current) return
        setOrganization(org)
        const hints = [...pollLinks(), ...(initialPollId ? [initialPollId] : [])]
        try {
          const result = await groupPollReader.listPolls(resolved.orgId, voter, hints)
          if (run !== generation.current) return
          setList(result)
          setSelected(previous => {
            const id = changed ? initialPollId : previous?.id
            return id ? result.votes.find(vote => vote.id === normalizeSuiAddress(id)) || null : null
          })
        } catch (cause) {
          if (run === generation.current) { setList(emptyList()); setSelected(null); setError(cause instanceof Error ? cause.message : t("walrus.sandboxPollsReadFailed")) }
        }
      } catch (cause) {
        if (run === generation.current) { setScope(null); setList(emptyList()); setSelected(null); setCreateOpen(false); setVoteOpen(false); setError(cause instanceof Error ? cause.message : t("walrus.sandboxPollsReadFailed")) }
      } finally { if (run === generation.current) setLoading(false) }
    })()
    const invalidate = () => { generation.current++; selectionGeneration.current++ }
    return () => { invalidate() }
  }, [open, groupId, orgId, readOnly, initialPollId, revision, context])

  const readPoll = async () => {
    if (!scope || reading) return
    const run = ++selectionGeneration.current, view = generation.current
    setReading(true); setError("")
    try {
      const vote = await groupPollReader.readPoll(pollId.trim(), scope.orgId, address)
      if (run !== selectionGeneration.current || view !== generation.current) return
      setSelected(vote)
      setList(current => ({ ...current, votes: [vote, ...current.votes.filter(row => row.id !== vote.id)] }))
    } catch (cause) { if (run === selectionGeneration.current && view === generation.current) setError(cause instanceof Error ? cause.message : t("walrus.sandboxPollReadFailed")) }
    finally { if (run === selectionGeneration.current && view === generation.current) setReading(false) }
  }
  const member = !!organization && !!address && !!organization.members[normalizeSuiAddress(address)]
  const canCreate = ready && !readOnly && !!scope?.groupId && member && !loading
  const eligible = !!selected && !!address && selected.voters.some(voter => voter.address === normalizeSuiAddress(address))
  const showResults = !!selected && (selected.status === "completed" || selected.showResultsDuring)
  const closeCreate = (value: boolean) => { setCreateOpen(value); if (!value) setRevision(value => value + 1) }
  const closeVote = (value: boolean) => { setVoteOpen(value); if (!value) setRevision(value => value + 1) }

  return <>
    <Dialog open={open && !createOpen && !voteOpen} onOpenChange={onOpenChange}>
      <DialogContent className="w-[92vw] max-w-[440px] max-h-[88dvh] p-0 gap-0 overflow-y-auto border-border bg-background text-foreground shadow-xl rounded-2xl">
        <div className="p-4 pr-10 border-b border-border/50 bg-gradient-to-br from-purple-500/10 via-primary/5 to-background">
          <DialogHeader>
            <div className="flex items-center gap-2.5">
              <div className="w-9 h-9 rounded-xl bg-purple-500/10 text-purple-600 dark:text-purple-400 flex items-center justify-center shrink-0"><Vote className="w-4 h-4" /></div>
              <div className="min-w-0 text-left"><DialogTitle className="text-sm font-semibold">{appName ?? t("walrus.sandboxDefaultAppName")}</DialogTitle><DialogDescription className="text-xs mt-1 truncate">{ready && scope ? scope.name : t("walrus.sandboxOrgGovernance")} · Sui Testnet</DialogDescription></div>
              <Badge variant="outline" className="ml-auto text-[10px] shrink-0 bg-background/60">{readOnly ? t("walrus.sandboxReadOnly") : t("walrus.sandboxLiveVoting")}</Badge>
            </div>
          </DialogHeader>
        </div>
        <div className="p-4 space-y-4">
          <div className="flex items-center justify-between gap-2">
            {ready && selected ? <Button variant="ghost" size="sm" className="h-8 px-2 text-xs" onClick={() => { selectionGeneration.current++; setSelected(null); setReading(false) }}><ArrowLeft className="w-3.5 h-3.5 mr-1" />{t("walrus.sandboxAllPolls")}</Button> : <p className="text-xs font-medium">{t("walrus.sandboxOrgPolls")}</p>}
            <div className="flex gap-1"><Button variant="ghost" size="sm" aria-label={t("walrus.sandboxRefreshAria")} className="h-8 w-8 p-0" disabled={loading} onClick={() => setRevision(value => value + 1)}><RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} /></Button>{canCreate && <Button size="sm" className="h-8 text-xs rounded-lg" onClick={() => setCreateOpen(true)}><Plus className="w-3.5 h-3.5 mr-1" />{t("walrus.sandboxCreatePoll")}</Button>}</div>
          </div>
          {error && <div role="alert" className="rounded-xl border border-destructive/20 bg-destructive/5 p-3 text-xs text-destructive flex items-start gap-2"><AlertCircle className="w-4 h-4 shrink-0" /><span className="break-words">{error}</span></div>}
          {loading || !ready ? <div role="status" className="py-8 text-center text-xs text-muted-foreground"><Loader2 className="w-5 h-5 mx-auto mb-2 animate-spin" />{t("walrus.sandboxLoading")}</div> : selected ? <div className="space-y-3">
            <div className="space-y-2"><div className="flex items-start justify-between gap-3"><h3 className="text-sm font-semibold break-words">{selected.title}</h3><Badge variant="outline" className="text-[10px] shrink-0">{selected.status === "completed" ? t("walrus.sandboxCompleted") : t("walrus.sandboxActive")}</Badge></div><p className="text-xs text-muted-foreground whitespace-pre-wrap break-words">{selected.description || t("walrus.sandboxNoDescription")}</p></div>
            <div className="text-[11px] text-muted-foreground space-y-1.5"><p className="flex items-center gap-1.5"><Users className="w-3.5 h-3.5" />{t("walrus.sandboxParticipation", { voted: selected.totalVotes ?? "", voters: selected.voters.length })} · {t(MODE_LABEL_KEY[selected.voteType])}</p><p className="flex items-center gap-1.5"><CalendarDays className="w-3.5 h-3.5" />{t("walrus.sandboxDeadline", { date: dateLabel(selected.expiresAt) })}</p><p>{t("walrus.sandboxCreatorMeta", { creator: shortAddress(selected.creator?.address), epoch: selected.chainEpoch ?? "" })}</p></div>
            <div className="space-y-2">{selected.options.map(option => <div key={option.id} className="rounded-xl border border-border/70 bg-muted/20 p-3 flex items-start justify-between gap-3 text-xs"><span className="break-words">{option.text}</span>{showResults && <span className="shrink-0 font-medium tabular-nums">{option.votes} {selected.voteType === "ranked" ? t("walrus.sandboxPoints") : t("walrus.sandboxWeight")}</span>}</div>)}</div>
            {!showResults && <p className="text-[11px] text-muted-foreground flex gap-1.5 items-center"><Eye className="w-3.5 h-3.5" />{t("walrus.sandboxResultsLater")}</p>}
            {selected.result && <p className="text-xs font-medium">{selected.result}</p>}
            {selected.hasVoted && <p className="text-xs text-emerald-600 dark:text-emerald-400 flex items-center gap-1.5"><CheckCircle2 className="w-3.5 h-3.5" />{t("walrus.sandboxBallotRead")}</p>}
            {!readOnly && <Button className="w-full rounded-xl text-xs" onClick={() => setVoteOpen(true)}><ArrowUpRight className="w-3.5 h-3.5 mr-1.5" />{eligible && !selected.hasVoted && selected.status !== "completed" ? t("walrus.sandboxVoteNow") : t("walrus.sandboxOpenDetails")}</Button>}
            <p className="font-mono text-[10px] text-muted-foreground break-all">Poll {selected.id}</p>
          </div> : <div className="space-y-2.5">
            {list.votes.map(vote => <button type="button" key={vote.id} onClick={() => { selectionGeneration.current++; setReading(false); setSelected(vote) }} className="w-full text-left rounded-xl border border-border/70 p-3.5 bg-gradient-to-br from-background to-muted/20 hover:border-primary/40 hover:bg-primary/5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><div className="flex items-start justify-between gap-3"><span className="text-xs font-semibold break-words">{vote.title}</span><Badge variant="outline" className="text-[10px] shrink-0">{vote.status === "completed" ? t("walrus.sandboxCompleted") : t("walrus.sandboxActive")}</Badge></div><p className="text-[11px] text-muted-foreground mt-2">{t(MODE_LABEL_KEY[vote.voteType])} · {t("walrus.sandboxParticipation", { voted: vote.totalVotes ?? "", voters: vote.voters.length })}</p><p className="text-[10px] text-muted-foreground mt-1">{t("walrus.sandboxDeadline", { date: dateLabel(vote.expiresAt) })}{vote.hasVoted ? t("walrus.sandboxHasVotedSuffix") : ""}</p></button>)}
            {!list.votes.length && !error && <div className="rounded-xl border border-dashed py-7 px-4 text-center"><Vote className="w-7 h-7 mx-auto text-primary/60 mb-2" /><p className="text-xs font-medium">{list.discoveryError ? t("walrus.sandboxListPartial") : t("walrus.sandboxListEmpty")}</p><p className="text-[11px] text-muted-foreground mt-1.5">{canCreate ? t("walrus.sandboxListEmptyCanCreate") : t("walrus.sandboxListEmptyReadOnly")}</p></div>}
          </div>}
          {!loading && ready && (list.truncated || list.failures.length > 0) && <div role="status" className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-3 text-[11px] text-muted-foreground space-y-1"><p>{list.discoveryError || (list.truncated ? t("walrus.sandboxTruncated") : t("walrus.sandboxSomeFailed"))}</p>{list.failures.map(failure => <p key={failure.id} className="break-words">{shortAddress(failure.id)}: {failure.error}</p>)}</div>}
          {ready && scope && !loading && <form className="space-y-2 pt-3 border-t border-border/50" onSubmit={event => { event.preventDefault(); void readPoll() }}><label htmlFor="group-poll-object-id" className="text-[11px] font-medium">{t("walrus.sandboxReadShared")}</label><div className="flex gap-2"><Input id="group-poll-object-id" value={pollId} onChange={event => setPollId(event.target.value)} placeholder={t("walrus.sandboxPollIdPlaceholder")} className="h-8 text-xs font-mono min-w-0" /><Button type="submit" variant="outline" size="sm" className="h-8 text-xs shrink-0" disabled={reading || !pollId.trim()}>{reading ? t("walrus.sandboxReading") : t("walrus.sandboxRead")}</Button></div></form>}
          <div className="rounded-xl bg-muted/35 p-3 text-[10px] leading-relaxed text-muted-foreground space-y-1"><p>{t("walrus.sandboxFootnote1")}</p><p>{readOnly ? t("walrus.sandboxFootnote2Ro") : t("walrus.sandboxFootnote2Live")}</p>{!readOnly && !member && <p>{t("walrus.sandboxNotMember")}</p>}{ready && scope && <p className="font-mono break-all">{t("walrus.sandboxOrgLabel", { orgId: scope.orgId })}</p>}</div>
        </div>
      </DialogContent>
    </Dialog>
    <CreateVoteDialog open={open && ready && !readOnly && createOpen} onOpenChange={closeCreate} initialGroupId={scope?.groupId} />
    {selected && <VoteDetailsDialog open={open && ready && !readOnly && voteOpen} onOpenChange={closeVote} voteId={selected.id} />}
  </>
}
