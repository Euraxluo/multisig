"use client"

import { useState, useEffect, useRef } from "react"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Check, BarChart2, UserCheck, Calendar, EyeOff, Share2, PanelRight, Vote, LinkIcon, Ghost, Loader2, AlertTriangle, Bot, Lock, Settings2, RefreshCw } from "lucide-react"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { DragDropContext, Droppable, Draggable, type DropResult } from "@hello-pangea/dnd"
import { motion, AnimatePresence } from "framer-motion"
import { getActiveAccount, getProposals } from "@/lib/onchain-store"
import { getGovernanceVotes, proposalVoteView, governanceVoteUrl, readShadowPolicy, saveShadowPolicy, governancePublicationGaps, shortAddress, type GovernanceVote, type GovernanceOption, type ShadowPolicy } from "@/lib/governance"
import { loadGovernanceVote, submitPollBallot, submitGovernanceApproval, submitGovernanceFollow } from "@/lib/governance-chain"
import { CreateVoteDialog } from "@/components/create-vote-dialog"
import { GroupProposalEntryDialog } from "@/components/group-proposal-entry-dialog"
import { useI18n } from "@/components/i18n-provider"

interface VoteDetailsDialogProps { open: boolean; onOpenChange: (open: boolean) => void; voteId: string }
function localContext(id: string): GovernanceVote | null {
  const address = getActiveAccount()?.address || ""
  const proposal = getProposals().find(item => item.id === id || item.onChainId === id)
  return proposal ? proposalVoteView(proposal, address) : getGovernanceVotes(address).find(item => item.id === id) || null
}

export function VoteDetailsDialog({ open, onOpenChange, voteId }: VoteDetailsDialogProps) {
  const { t, locale } = useI18n()
  const [activeTab, setActiveTab] = useState("details")
  const [vote, setVote] = useState<GovernanceVote | null>(null)
  const [single, setSingle] = useState("")
  const [multiple, setMultiple] = useState<string[]>([])
  const [ranked, setRanked] = useState<GovernanceOption[]>([])
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [message, setMessage] = useState("")
  const [digest, setDigest] = useState("")
  const [policy, setPolicy] = useState<ShadowPolicy | null>(null)
  const [checks, setChecks] = useState<string[]>([])
  const [editOpen, setEditOpen] = useState(false)
  const [fundingOpen, setFundingOpen] = useState(false)
  const [revision, setRevision] = useState(0)
  const generation = useRef(0)
  const pending = useRef(false)
  const openedId = useRef("")
  // Locale-aware date label: the helper lives in the component so a locale
  // switch re-renders it (and formats dates for the active locale).
  const dateLabel = (value?: string) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString(locale === "zh" ? "zh-CN" : "en-US", { year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" }) : t("voting.notSet")

  useEffect(() => {
    const run = ++generation.current
    if (!open || !voteId) { setVote(null); openedId.current = ""; return }
    const initial = localContext(voteId)
    const changed = openedId.current !== voteId
    openedId.current = voteId
    setVote(initial); setError(""); setMessage("")
    if (changed) {
      setActiveTab("details"); setDigest(""); setChecks([]); setPolicy(readShadowPolicy(voteId))
      setSingle(initial?.myVoteOptionIds[0] || ""); setMultiple(initial?.myVoteOptionIds || []); setRanked(initial?.options || [])
    }
    const chainId = initial?.kind === "proposal" || initial?.source === "shared-poll" ? initial.onChainId : !initial && /^0x[0-9a-fA-F]{1,64}$/.test(voteId) ? voteId : null
    if (!chainId) { setLoading(false); return }
    setLoading(true)
    loadGovernanceVote(chainId).then(value => {
      if (run !== generation.current) return
      setVote(value)
      if (changed || value.hasVoted) {
        setSingle(value.myVoteOptionIds[0] || ""); setMultiple(value.myVoteOptionIds)
        setRanked(value.hasVoted && value.voteType === "ranked" ? value.myVoteOptionIds.map(id => value.options.find(option => option.id === id)!).filter(Boolean) : value.options)
      }
    }).catch(cause => { if (run === generation.current) setError(cause instanceof Error ? cause.message : t("voting.chainReadFail")) })
      .finally(() => { if (run === generation.current) setLoading(false) })
    const invalidate = () => { generation.current++ }
    return () => { invalidate() }
  }, [open, voteId, revision])

  useEffect(() => {
    if (!open) return
    const update = () => setRevision(value => value + 1)
    const account = () => { generation.current++; setVote(null); openedId.current = ""; setSingle(""); setMultiple([]); setRanked([]); setRevision(value => value + 1) }
    const storage = (event: StorageEvent) => event.key === "sui_active_account" ? account() : update()
    const events = ["sui-votes-updated", "sui-vote-records-updated"]
    events.forEach(event => window.addEventListener(event, update))
    window.addEventListener("sui-account-switched", account); window.addEventListener("storage", storage)
    return () => { events.forEach(event => window.removeEventListener(event, update)); window.removeEventListener("sui-account-switched", account); window.removeEventListener("storage", storage) }
  }, [open])

  const showResults = !!vote && vote.kind !== "draft" && (vote.status === "completed" || !!vote.showResultsDuring)
  const link = () => governanceVoteUrl(window.location.href, vote?.kind === "proposal" ? vote.onChainId || vote.id : voteId)
  const discussionText = () => vote ? t("voting.discussionShareText", { title: vote.title, description: vote.description, group: vote.group, deadline: dateLabel(vote.expiresAt), link: link() }) : ""
  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); setMessage(t("common.copied")) } catch { setError(t("voting.copyFailManual")) }
  }
  const share = async () => {
    if (!vote) return
    const url = link()
    try {
      if (navigator.share) await navigator.share({ title: vote.title, text: vote.description || t("voting.shareVoteTitle", { title: vote.title }), url })
      else await copy(url)
    } catch (cause) { if (!(cause instanceof Error && cause.name === "AbortError")) setError(t("voting.shareFail")) }
  }
  const updatePolicy = (patch: Partial<ShadowPolicy>) => { setPolicy(current => current ? { ...current, ...patch } : current); setChecks([]) }
  const persistPolicy = () => {
    if (!policy) return
    try { saveShadowPolicy(voteId, policy); setMessage(t("voting.policySaved")) } catch { setError(t("voting.policySaveFail")) }
  }
  const mutate = async (follow = false) => {
    if (!vote || pending.current) return
    pending.current = true; setBusy(true); setError(""); setMessage(""); setDigest("")
    const current = generation.current
    try {
      let confirmed: string | undefined
      if (follow) {
        if (!policy) throw new Error(t("voting.errConfigurePolicyFirst"))
        confirmed = await submitGovernanceFollow(vote, policy)
      } else if (vote.source === "shared-poll") confirmed = await submitPollBallot(vote, vote.voteType === "ranked" ? ranked.map(option => option.id) : vote.voteType === "multiple" ? multiple : [single])
      else confirmed = await submitGovernanceApproval(vote, single === "option-reject")
      if (current !== generation.current) return
      setDigest(confirmed || ""); setMessage(t("voting.voteConfirmedReloading"))
      if (follow && policy) {
        const updated = { ...policy, usedToday: policy.usedToday + 1, lastSyncAt: new Date().toISOString(), executedDigest: confirmed }
        setPolicy(updated)
        try { saveShadowPolicy(voteId, updated) } catch { setMessage(t("voting.followCountSaveFail")) }
      }
      try {
        const updated = await loadGovernanceVote(vote.onChainId || vote.id)
        if (current === generation.current) setVote(updated)
      }
      catch (cause) { if (current === generation.current) setError(t("voting.confirmedReadFail", { cause: cause instanceof Error ? cause.message : t("voting.retryRefresh") })) }
    } catch (cause) { if (current === generation.current) setError(cause instanceof Error ? cause.message : t("voting.voteSubmitFail")) }
    finally { pending.current = false; setBusy(false) }
  }
  const dragEnd = ({ source, destination }: DropResult) => {
    if (!destination) return
    setRanked(current => { const next = [...current]; const [option] = next.splice(source.index, 1); next.splice(destination.index, 0, option); return next })
  }
  const renderOptions = () => {
    if (!vote) return null
    if (!vote.options.length) return <p className="py-4 text-sm text-muted-foreground">{t("voting.noOptionsSaved")}</p>
    if (vote.voteType === "ranked") return <DragDropContext onDragEnd={dragEnd}><Droppable droppableId="ranked-options">{provided => <div {...provided.droppableProps} ref={provided.innerRef} className="space-y-2">{ranked.map((option, index) => <Draggable key={option.id} draggableId={option.id} index={index} isDragDisabled={busy || vote.hasVoted}>{(drag, snapshot) => <div ref={drag.innerRef} {...drag.draggableProps} {...drag.dragHandleProps} className={`rounded-lg border p-3 flex gap-3 items-center ${snapshot.isDragging ? "bg-accent" : "bg-background"}`}><span className="rounded-full bg-primary/10 w-6 h-6 text-center text-xs leading-6">{index + 1}</span><span className="text-sm">{option.text}</span></div>}</Draggable>)}{provided.placeholder}</div>}</Droppable></DragDropContext>
    if (vote.voteType === "multiple") return <div className="space-y-2">{vote.options.map(option => <Label key={option.id} className="flex items-center gap-3 rounded-lg border p-3"><Checkbox checked={multiple.includes(option.id)} onCheckedChange={checked => setMultiple(current => checked ? [...current, option.id] : current.filter(id => id !== option.id))} disabled={busy || vote.hasVoted} /><span className="flex-1 text-sm">{option.text}</span></Label>)}</div>
    return <RadioGroup value={single} onValueChange={setSingle} disabled={busy || vote.hasVoted} className="space-y-2">{vote.options.map(option => <Label key={option.id} className="flex items-center gap-3 rounded-lg border p-3"><RadioGroupItem value={option.id} /><span className="flex-1 text-sm">{option.text}</span>{showResults && <span className="text-xs text-muted-foreground">{option.votes ?? t("voting.notSynced")}{vote.kind === "proposal" || vote.source === "shared-poll" ? t("voting.unitWeightSpaced") : t("voting.unitVoteSpaced")}</span>}</Label>)}</RadioGroup>
  }
  // These lookups index by a field that only a draft fills in, so the key is
  // narrowed first: an unset option is "未设置", not a lookup on undefined.
  const modeLabel = vote?.voteType ? ({ single: t("voting.modeSingle"), multiple: t("voting.modeMultiple"), ranked: t("voting.modeRanked"), approve: t("voting.modeApprove") } as Record<string, string>)[vote.voteType] : undefined
  const weightTypeLabel = vote?.weightType ? ({ manual: t("voting.weightManual"), token: t("voting.weightToken"), nft: t("voting.weightNft") } as Record<string, string>)[vote.weightType] : undefined
  const weightCalculationLabel = vote?.weightCalculation ? ({ linear: t("voting.calcLinear"), sqrt: t("voting.calcSqrt"), quadratic: t("voting.calcQuadratic") } as Record<string, string>)[vote.weightCalculation] : undefined
  const voterSourceLabel = vote?.voterSource ? ({ manual: t("voting.voterSourceManual"), group: t("voting.voterSourceGroup"), hybrid: t("voting.voterSourceHybrid") } as Record<string, string>)[vote.voterSource] : undefined
  const settings = vote ? [
    [t("voting.settingsVoteMode"), modeLabel || vote.voteType],
    [t("voting.settingsWeightSource"), weightTypeLabel || (vote.kind === "proposal" || vote.source === "shared-poll" ? t("voting.chainFixedRoster") : t("voting.notSet"))],
    [t("voting.settingsCalcRule"), weightCalculationLabel || t("voting.notSet")],
    [t("voting.settingsToken"), [vote.tokenSymbol, vote.tokenAddress].filter(Boolean).join(" · ") || t("voting.notSet")],
    [t("voting.snapshotLabel"), vote.snapshotBlock === "specific" ? t("voting.snapshotAtBlock", { block: vote.specificBlock || t("voting.notFilled") }) : vote.snapshotBlock === "latest" ? t("voting.snapshotLatest") : t("voting.notSet")],
    [t("voting.settingsNftType"), vote.targetNftType || t("voting.notSet")], [t("voting.settingsPrivacy"), `${vote.isAnonymous ? t("voting.anonAnonymous") : t("voting.anonPublic")}${vote.isTimeLockedSeal ? t("voting.sealTimeLockSuffix") : ""}`],
    [t("voting.settingsResultDisplay"), vote.showResultsDuring ? t("voting.resultsDuring") : t("voting.resultsAfter")], [t("voting.settingsVoterSource"), voterSourceLabel || t("voting.notRecorded")],
    [t("voting.settingsExecution"), vote.createTransaction ? t("voting.execExpectTemplate", { template: vote.selectedTransaction || t("voting.noTemplateSelected") }) : t("voting.execNotSet")],
  ] : []

  return <>
    <Dialog open={open && !editOpen && !fundingOpen} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px] max-h-[90dvh] overflow-y-auto p-0 gap-0">
        {!vote ? <div className="p-5 space-y-3"><DialogHeader><DialogTitle className="flex items-center gap-2">{loading ? <Loader2 className="h-5 w-5 animate-spin" /> : <AlertTriangle className="h-5 w-5 text-amber-500" />}{loading ? t("voting.loadingVote") : t("voting.voteNotFound")}</DialogTitle><DialogDescription>{t("voting.notFoundDesc")}</DialogDescription></DialogHeader><p className="break-all font-mono text-xs text-muted-foreground">{voteId}</p>{error && <p role="alert" className="text-sm text-destructive">{error}</p>}<Button variant="outline" onClick={() => setRevision(value => value + 1)}>{t("voting.reread")}</Button></div> : <>
          <div className={`relative bg-gradient-to-r ${vote.color} px-4 pt-6 pb-4 text-white`}><div className="absolute inset-0 bg-black/45" aria-hidden /><DialogHeader className="relative"><DialogTitle className="flex justify-between gap-4 pr-5"><span className="text-xl break-words">{vote.title}</span><Badge variant="outline" className="h-fit shrink-0 bg-white/20 text-white border-white/40">{vote.status === "draft" ? t("voting.badgeDraft") : vote.status === "completed" ? t("voting.tabCompleted") : vote.status === "approved" ? t("voting.badgeThresholdMet") : t("voting.tabActive")}</Badge></DialogTitle><DialogDescription className="flex items-center text-white"><Calendar className="mr-1 h-3.5 w-3.5" />{t("voting.deadlineAt", { date: dateLabel(vote.expiresAt) })}</DialogDescription></DialogHeader></div>
          <div className="p-4 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3"><div className="flex items-center gap-2"><Avatar className="h-9 w-9"><AvatarFallback>{(vote.creator?.name || "?").charAt(0)}</AvatarFallback></Avatar><div><p className="text-sm font-medium">{vote.creator?.name || t("voting.creatorNotSynced")}</p><p className="text-xs text-muted-foreground">{vote.group}</p></div></div><div className="flex flex-wrap gap-1.5"><Badge variant="outline" className="text-[10px]">{vote.source === "shared-poll" ? t("voting.badgeSharedPollRead") : vote.kind === "proposal" ? vote.chainSyncedAt ? t("voting.badgeChainRead") : t("voting.badgePendingChainRead") : vote.kind === "draft" ? t("voting.badgeLocalDraft") : t("voting.badgeLegacyRecord")}</Badge>{vote.isTimeLockedSeal && <Badge variant="outline" className="text-[10px]"><Lock className="h-3 w-3 mr-1" />{t("voting.badgeSeal")}</Badge>}{vote.isAnonymous && <Badge variant="outline" className="text-[10px]"><EyeOff className="h-3 w-3 mr-1" />{t("voting.badgeAnonymous")}</Badge>}</div></div>
            <p className="text-sm whitespace-pre-wrap break-words">{vote.description || t("voting.noDescription")}</p>
            {vote.source === "shared-poll" ? <div className="rounded-lg border bg-muted/20 p-3 text-xs space-y-2"><p>{t("voting.pollRulesIntro")}{vote.voteType === "ranked" ? t("voting.ruleRanked") : vote.voteType === "multiple" ? t("voting.ruleMultiple") : t("voting.ruleSingle")}</p><p>{t("voting.pollPrivacyNote")}</p><Button variant="outline" size="sm" disabled={loading || busy} onClick={() => setRevision(value => value + 1)}>{t("voting.refreshChainVote")}</Button></div> : vote.kind === "proposal" ? <div className="rounded-lg border bg-muted/20 p-3 space-y-1 text-xs"><p className="break-all">{t("voting.payee", { recipient: vote.recipient ?? "" })} · {vote.amountLabel}</p><p>{t("voting.proposalStatsDialog", { approved: vote.options[0]?.votes ?? t("voting.notSynced"), required: vote.weights.required ?? t("voting.notSynced"), voters: vote.totalVotes ?? t("voting.notSynced") })}</p><div className="flex flex-wrap items-center justify-between gap-2"><span className="text-muted-foreground">{vote.chainSyncedAt ? t("voting.lastReadAt", { time: dateLabel(vote.chainSyncedAt) }) : t("voting.chainStateUnverified")}</span><Button variant="ghost" size="sm" className="h-6 text-xs" disabled={loading || busy} onClick={() => setRevision(value => value + 1)}><RefreshCw className={`mr-1 h-3 w-3 ${loading ? "animate-spin" : ""}`} />{t("voting.refresh")}</Button></div></div> : <div className="rounded-lg bg-muted/30 p-3 text-xs text-muted-foreground">{vote.kind === "draft" ? t("voting.draftLocalNote") : t("voting.legacyNote")} {t("voting.savedConfigNote")}</div>}
            {vote.record && <div className="rounded-lg border p-3 text-xs space-y-1"><p className="font-medium">{t("voting.oldReceiptTitle")}</p><p>{t("voting.optionsLabel")}{vote.record.optionIds.map(id => vote.options.find(option => option.id === id)?.text || id).join(t("voting.listSeparator"))}</p><p>{t("voting.timeLabel")}{dateLabel(vote.record.at)}</p>{vote.record.digest && <p className="break-all">{t("voting.receiptDigestLabel")}{vote.record.digest}</p>}<p className="text-muted-foreground">{t("voting.receiptNotCounted")}</p></div>}
            <Tabs value={activeTab} onValueChange={setActiveTab}>
              <TabsList className="grid w-full grid-cols-5 p-1 bg-muted/50 rounded-xl h-auto">{[{ id: "details", label: t("voting.tabDetails"), icon: Vote }, { id: "results", label: t("voting.tabResults"), icon: BarChart2 }, { id: "voters", label: t("voting.tabVoters"), icon: UserCheck }, { id: "shadow", label: t("voting.tabShadow"), icon: Ghost }, { id: "settings", label: t("voting.tabSettings"), icon: Settings2 }].map(({ id, label, icon: Icon }) => <TabsTrigger key={id} value={id} className="rounded-lg text-xs px-1 py-2"><Icon className="h-3.5 w-3.5 mr-1" />{label}</TabsTrigger>)}</TabsList>
              <AnimatePresence mode="wait"><motion.div key={activeTab} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }}>
                <TabsContent value="details" className="mt-4 space-y-3">{renderOptions()}{vote.kind !== "proposal" && vote.source !== "shared-poll" && <p className="text-xs text-muted-foreground">{t("voting.previewNote")}</p>}</TabsContent>
                <TabsContent value="results" className="mt-4 space-y-3">{vote.kind === "draft" ? <p className="py-6 text-center text-sm text-muted-foreground">{t("voting.draftNoResults")}</p> : !showResults ? <div className="py-6 text-center text-sm text-muted-foreground"><EyeOff className="mx-auto mb-2 h-7 w-7" />{t("voting.resultsHiddenNote")}{vote.isTimeLockedSeal && <p className="mt-2 text-xs">{t("voting.sealNotEncrypted")}</p>}</div> : <>{vote.options.map(option => <div key={option.id} className="space-y-1.5 border-b py-2"><div className="flex justify-between gap-3 text-sm"><span>{option.text}</span><span className="shrink-0 font-medium">{option.votes ?? t("voting.notSynced")} {vote.kind === "proposal" ? t("voting.unitWeight") : vote.source === "shared-poll" ? vote.voteType === "ranked" ? t("voting.unitPoints") : t("voting.unitWeight") : t("voting.unitVote")}{option.percentage == null ? "" : t("voting.percentShare", { value: option.percentage })}</span></div>{option.percentage != null && <div role="meter" aria-label={t("voting.optionShareAria", { option: option.text })} aria-valuemin={0} aria-valuemax={100} aria-valuenow={option.percentage} title={t("voting.optionShareTitle", { option: option.text, votes: option.votes ?? 0, percent: option.percentage ?? 0 })} className="h-2 overflow-hidden rounded-full bg-muted"><motion.div initial={{ width: 0 }} animate={{ width: `${option.percentage}%` }} transition={{ duration: 0.45 }} className="h-full rounded-r bg-primary" /></div>}</div>)}<div className="rounded-lg bg-muted/30 p-3 text-xs space-y-1"><p>{t("voting.totalParticipants", { count: vote.totalVotes ?? t("voting.notSynced") })}</p><p>{t("voting.participatedWeight", { voted: vote.weights.voted ?? t("voting.notSynced"), total: vote.weights.total ?? t("voting.notSynced") })}</p><p>{t("voting.requiredWeight", { required: vote.weights.required ?? t("voting.notSynced") })}</p>{vote.kind === "governance" && vote.source !== "shared-poll" && <p className="text-muted-foreground">{t("voting.legacyLocalStats")}</p>}</div></>}</TabsContent>
                <TabsContent value="voters" className="mt-4 space-y-2">{vote.isAnonymous && vote.kind !== "draft" && vote.status !== "completed" ? <p className="py-6 text-center text-sm text-muted-foreground">{t("voting.anonymousHidden")}</p> : vote.voters.length ? vote.voters.map(voter => <div key={voter.id} className="flex justify-between items-center gap-2 rounded-lg p-2 hover:bg-muted/50"><div className="min-w-0"><p className="truncate text-sm">{voter.name || shortAddress(voter.address)}</p><p className="text-xs text-muted-foreground">{t("voting.voterWeightLine", { weight: voter.weight ?? t("voting.notSynced") })}{voter.timestamp ? ` · ${dateLabel(voter.timestamp)}` : ""}</p></div><Badge variant="outline" className="text-[10px] shrink-0">{vote.source === "shared-poll" ? voter.voted ? t("voting.voterBadgeChainVoted") : t("voting.voterBadgeNotVoted") : vote.kind === "draft" ? t("voting.voterBadgePlanned") : vote.kind === "governance" ? voter.voted ? t("voting.voterBadgeLocalVoted") : t("voting.voterBadgeLocal") : voter.voted ? voter.votedFor === "option-reject" ? t("voting.rejected") : t("voting.voterBadgeApproved") : t("voting.voterBadgeNotVoted")}</Badge></div>) : <p className="py-6 text-center text-sm text-muted-foreground">{t("voting.noVoters")}</p>}</TabsContent>
                <TabsContent value="settings" className="mt-4"><dl className="space-y-2">{settings.map(([label, value]) => <div key={label} className="grid grid-cols-[5rem_1fr] gap-3 border-b pb-2 text-xs"><dt className="text-muted-foreground">{label}</dt><dd className="break-all">{value}</dd></div>)}</dl></TabsContent>
                <TabsContent value="shadow" className="mt-4 space-y-3">{policy && <>
                  <div className="rounded-lg border bg-gradient-to-br from-purple-500/10 to-primary/10 p-3 space-y-2"><div className="flex items-center justify-between gap-2"><span className="text-sm font-semibold">{t("voting.shadowTitle")}</span><Switch checked={policy.enabled} onCheckedChange={enabled => updatePolicy({ enabled })} /></div><p className="text-xs text-muted-foreground">{t("voting.shadowDesc")}</p></div>
                  <div className="space-y-1"><Label className="text-xs">{t("voting.shadowLeaderLabel")}</Label><Input value={policy.leaderAddress} onChange={event => updatePolicy({ leaderAddress: event.target.value })} placeholder="0x…" className="text-xs font-mono" /></div>
                  <div className="space-y-1"><Label className="text-xs">{t("voting.shadowCapLabel")}</Label><Input value={policy.subagentCapId} onChange={event => updatePolicy({ subagentCapId: event.target.value })} placeholder={t("voting.shadowCapPlaceholder")} className="text-xs font-mono" /></div>
                  <div className="space-y-1"><Label className="text-xs">{t("voting.shadowPolicyLabel")}</Label><Select value={policy.strategyMode} onValueChange={value => updatePolicy({ strategyMode: value as ShadowPolicy["strategyMode"] })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="FOLLOW_LEADER">{t("voting.strategyFollowLeader")}</SelectItem><SelectItem value="AI_SENTINEL">{t("voting.strategyAiSentinel")}</SelectItem><SelectItem value="ALWAYS_APPROVE">{t("voting.strategyAlwaysApprove")}</SelectItem></SelectContent></Select></div>
                  <div className="grid grid-cols-2 gap-3"><div className="space-y-1"><Label className="text-xs">{t("voting.shadowPerTxLimit")}</Label><Input type="number" min="0" value={policy.maxAmountPerTx} onChange={event => updatePolicy({ maxAmountPerTx: Number(event.target.value) })} /></div><div className="space-y-1"><Label className="text-xs">{t("voting.shadowDailyPref")}</Label><Input type="number" min="1" value={policy.dailyQuota} onChange={event => updatePolicy({ dailyQuota: Number(event.target.value) })} /></div></div>
                  <div className="space-y-1"><Label className="text-xs">{t("voting.shadowMinAiScore")}</Label><Input type="number" min="0" max="100" value={policy.minAiScore} onChange={event => updatePolicy({ minAiScore: Number(event.target.value) })} /></div><p className="text-xs text-muted-foreground">{t("voting.shadowUsageNote", { count: policy.usedToday })}</p>
                  <div className="rounded-lg border bg-muted/20 p-3 space-y-2"><p className="flex items-center text-xs font-semibold"><Bot className="h-3.5 w-3.5 mr-1" />{t("voting.shadowChecksTitle")}</p><p className="text-xs text-muted-foreground">{t("voting.shadowChecksDesc")}</p><Button variant="outline" size="sm" onClick={() => setChecks([t("voting.checkChainState", { value: vote.chainSyncedAt ? t("voting.checkStateRead") : t("voting.checkStatePending") }), t("voting.checkAmountLimit", { value: vote.kind === "proposal" ? Number(vote.amountMist) / 1e9 <= policy.maxAmountPerTx ? t("voting.checkAmountOk") : t("voting.checkAmountOver") : t("voting.checkAmountNone") }), t("voting.checkLeaderApproval", { value: vote.kind === "proposal" && vote.voters.some(voter => voter.address?.toLowerCase() === policy.leaderAddress.toLowerCase() && voter.votedFor === "option-approve") ? t("voting.checkLeaderSeen") : t("voting.checkLeaderNone") }), t("voting.checkCredentialNote")])}>{t("voting.runChecks")}</Button>{checks.map(check => <p key={check} className="text-xs text-muted-foreground">{check}</p>)}</div>
                  <div className="flex gap-2"><Button variant="outline" className="flex-1" onClick={persistPolicy}>{t("voting.savePolicy")}</Button><Button className="flex-1" disabled={busy || loading} onClick={() => void mutate(true)}>{busy ? t("voting.waitingSignature") : t("voting.signShadowVote")}</Button></div>
                </>}</TabsContent>
                <TabsContent value="discussion" className="mt-4 space-y-3"><h3 className="text-sm font-semibold">{t("voting.discussionTitle", { title: vote.title })}</h3><p className="text-xs text-muted-foreground">{t("voting.discussionDesc")}</p><textarea aria-label={t("voting.discussionAria")} readOnly value={discussionText()} className="w-full min-h-36 rounded-lg border bg-muted/20 p-3 text-xs" /><Button variant="outline" size="sm" onClick={() => void copy(discussionText())}>{t("voting.copyDiscussion")}</Button></TabsContent>
              </motion.div></AnimatePresence>
            </Tabs>
          </div>
          <div className="p-4 border-t space-y-3">
            {(error || message || digest) && <div aria-live="polite" className={`rounded-lg border p-3 text-xs space-y-1 ${error ? "text-destructive" : "text-muted-foreground"}`}>{error && <p role="alert">{error}</p>}{message && <p>{message}</p>}{digest && <a target="_blank" rel="noreferrer" href={`https://suiscan.xyz/testnet/tx/${digest}`} className="block break-all underline">{t("voting.viewConfirmTx", { digest })}</a>}</div>}
            <div className="flex flex-wrap justify-between gap-2"><Button variant="outline" size="sm" className="gap-1" onClick={() => setActiveTab("discussion")}><PanelRight className="h-3.5 w-3.5" />{t("voting.discussionBtn")}</Button><div className="flex gap-2"><Button variant="outline" size="sm" className="gap-1" onClick={() => void copy(link())}><LinkIcon className="h-3.5 w-3.5" />{t("voting.copyLink")}</Button><Button variant="outline" size="sm" className="gap-1" onClick={() => void share()}><Share2 className="h-3.5 w-3.5" />{t("voting.share")}</Button></div></div>
            {vote.kind !== "proposal" && vote.source !== "shared-poll" && <p className="text-[11px] text-muted-foreground">{t("voting.localLinkNote")}</p>}
            {vote.source === "shared-poll" ? <Button className="w-full" disabled={busy || loading || vote.hasVoted || vote.status === "completed" || (vote.voteType === "single" ? !single : vote.voteType === "multiple" ? !multiple.length : ranked.length !== vote.options.length)} onClick={() => void mutate()}>{busy ? t("voting.waitingSignatureConfirm") : vote.hasVoted ? t("voting.alreadyVotedWallet") : vote.status === "completed" ? t("voting.votingEnded") : t("voting.signBallot")}</Button> : vote.kind === "proposal" ? <Button className="w-full" disabled={busy || loading || vote.hasVoted || vote.status === "completed" || !single} onClick={() => void mutate()}>{busy ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Check className="h-4 w-4 mr-2" />}{vote.hasVoted ? t("voting.alreadyVotedWallet") : vote.status === "completed" ? t("voting.votingEnded") : single === "option-reject" ? t("voting.signReject") : t("voting.signApprove")}</Button> : <div className="space-y-2"><Button className="w-full" onClick={() => setEditOpen(true)}>{vote.kind === "draft" ? t("voting.continueDraft") : t("voting.draftFromVote")}</Button><Button variant="outline" className="w-full" onClick={() => { setMessage(governancePublicationGaps().join(" ")); setActiveTab("settings") }}>{t("voting.verifyCapability")}</Button><Button variant="ghost" className="w-full" onClick={() => setFundingOpen(true)}>{t("voting.createFundingProposal")}</Button></div>}
            <input aria-label={t("voting.voteLinkAria")} readOnly value={typeof window === "undefined" ? "" : link()} className="w-full rounded-md border bg-muted/20 px-2 py-1 text-[11px] text-muted-foreground" onFocus={event => event.target.select()} />
          </div>
        </>}
      </DialogContent>
    </Dialog>
    <CreateVoteDialog open={open && editOpen} onOpenChange={setEditOpen} draftId={vote?.kind === "draft" ? vote.id : undefined} initialVoteId={vote?.kind === "governance" ? vote.id : undefined} />
    <GroupProposalEntryDialog open={open && fundingOpen} onOpenChange={setFundingOpen} />
  </>
}
