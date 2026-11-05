"use client"

import { useState, useEffect } from "react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { motion, AnimatePresence } from "framer-motion"
import { Clock, Vote, CheckCircle2, CalendarClock, Plus, Lock, FilePenLine } from "lucide-react"
import { VoteDetailsDialog } from "@/components/vote-details-dialog"
import { CreateVoteDialog } from "@/components/create-vote-dialog"
import { getActiveAccount, getProposals } from "@/lib/onchain-store"
import { getGovernanceVotes, proposalVoteView, type GovernanceVote } from "@/lib/governance"
import { loadKnownPolls } from "@/lib/governance-chain"
import { getLocale } from "@/lib/i18n/locale-store"
import { useI18n } from "@/components/i18n-provider"

export default function Votes() {
  const { t } = useI18n()
  const [selectedVote, setSelectedVote] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState("active")
  const [createVoteOpen, setCreateVoteOpen] = useState(false)
  const [editingDraft, setEditingDraft] = useState<string | undefined>()
  const [votes, setVotes] = useState<GovernanceVote[]>([])
  const [pollFailures, setPollFailures] = useState<{ id: string; error: string }[]>([])

  useEffect(() => {
    let generation = 0
    const load = () => {
      const run = ++generation
      const address = getActiveAccount()?.address || ""
      const proposals = getProposals().map(proposal => proposalVoteView(proposal, address))
      const ids = new Set(proposals.flatMap(proposal => [proposal.id, proposal.onChainId]).filter(Boolean))
      const base = [...proposals, ...getGovernanceVotes(address).filter(vote => !ids.has(vote.id))]
      setVotes(base)
      void loadKnownPolls().then(({ votes: polls, failures }) => {
        if (run !== generation) return
        setPollFailures(failures)
        const pollIds = new Set(polls.map(poll => poll.id))
        setVotes([...polls, ...base.filter(vote => !pollIds.has(vote.id))])
      }).catch(error => { if (run === generation) setPollFailures([{ id: "", error: error instanceof Error ? error.message : t("voting.sharedPollReadFail") }]) })
    }
    load()
    const timer = window.setInterval(load, 30_000)
    const events = ["sui-proposals-updated", "sui-votes-updated", "sui-vote-records-updated", "sui-account-switched", "storage"]
    events.forEach(event => window.addEventListener(event, load))
    return () => { generation++; window.clearInterval(timer); events.forEach(event => window.removeEventListener(event, load)) }
  }, [])

  const partitions = {
    active: votes.filter(vote => vote.status === "active" || vote.status === "approved"),
    completed: votes.filter(vote => vote.status === "completed"),
    draft: votes.filter(vote => vote.status === "draft"),
  }
  const container = { hidden: { opacity: 0 }, show: { opacity: 1, transition: { staggerChildren: 0.08 } } }
  const item = { hidden: { opacity: 0, y: 15 }, show: { opacity: 1, y: 0 } }
  const formatDate = (value?: string) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleDateString(getLocale() === "zh" ? "zh-CN" : "en-US") : t("voting.notSet")
  const tabs = [
    { id: "active", label: t("voting.tabActive"), icon: Clock },
    { id: "completed", label: t("voting.tabCompleted"), icon: CheckCircle2 },
    { id: "draft", label: t("voting.tabDraft"), icon: FilePenLine },
  ] as const

  return <div className="space-y-4">
    <div className="flex items-center justify-between gap-3 mb-2">
      <div><h2 className="text-xl font-bold tracking-tight">{t("voting.page")}</h2><p className="text-xs text-muted-foreground">{t("voting.pageSubtitle")}</p></div>
      <Button size="sm" className="shrink-0 bg-gradient-to-r from-primary to-purple-500 hover:opacity-90 shadow-sm" onClick={() => { setEditingDraft(undefined); setCreateVoteOpen(true) }}><Plus className="h-4 w-4 mr-1" />{t("voting.newVote")}</Button>
    </div>
    {!!pollFailures.length && <div className="rounded-lg border p-3 space-y-2 text-xs" role="status"><p>{t("voting.pollFailuresNotice")}</p>{pollFailures.map(failure => <div key={failure.id} className="space-y-1">{failure.id && <button className="block break-all underline text-left" onClick={() => setSelectedVote(failure.id)}>{failure.id}</button>}<p className="text-muted-foreground break-words">{failure.error}</p></div>)}</div>}
    <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
      <TabsList className="grid w-full grid-cols-3 p-1 bg-muted/50 rounded-xl">
        {tabs.map(({ id, label, icon: Icon }) => <TabsTrigger key={id} value={id} className="rounded-lg data-[state=active]:bg-background data-[state=active]:shadow-sm text-xs font-medium"><Icon className="h-3.5 w-3.5 mr-1" />{label} ({partitions[id].length})</TabsTrigger>)}
      </TabsList>
      <AnimatePresence mode="wait">
        {tabs.filter(tab => tab.id === activeTab).map(({ id, label }) => <TabsContent key={id} value={id} className="mt-3 space-y-3">
          {!partitions[id].length ? <div className="text-center py-10 bg-muted/20 border border-dashed rounded-xl"><Vote className="h-8 w-8 mx-auto text-muted-foreground/60 mb-2" /><p className="text-sm font-medium">{t("voting.emptyFor", { label })}</p><p className="text-xs text-muted-foreground mt-1">{t("voting.emptyHint")}</p></div> : <motion.div variants={container} initial="hidden" animate="show" exit={{ opacity: 0 }} className="space-y-3">
            {partitions[id].map(vote => <motion.div key={vote.id} variants={item}>
              <Card role="button" tabIndex={0} aria-label={t("voting.viewVoteAria", { title: vote.title })} onKeyDown={event => { if (event.target === event.currentTarget && ["Enter", " "].includes(event.key)) { event.preventDefault(); setSelectedVote(vote.id) } }} onClick={() => setSelectedVote(vote.id)} className="overflow-hidden hover:shadow-md transition-all duration-300 border-none shadow-sm cursor-pointer">
                <div className={`h-1 bg-gradient-to-r ${vote.color}`} />
                <CardHeader className="p-3 pb-0"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><h3 className="font-semibold text-sm break-words">{vote.title}</h3><p className="text-xs text-muted-foreground">{vote.group}</p></div><Badge variant="outline" className="shrink-0 text-[10px]">{vote.status === "draft" ? t("voting.badgeDraft") : vote.kind === "proposal" && !vote.chainSyncedAt ? t("voting.badgeResultPending") : vote.result || (vote.status === "approved" ? t("voting.badgeThresholdMet") : label)}</Badge></div></CardHeader>
                <CardContent className="p-3 pt-2 space-y-2">
                  <p className="text-xs text-muted-foreground line-clamp-2">{vote.description || t("voting.noDescription")}</p>
                  <div className="flex flex-wrap gap-1.5">
                    <Badge variant="outline" className="text-[10px]">{vote.source === "shared-poll" ? t("voting.badgeSharedPollRead") : vote.kind === "proposal" ? vote.chainSyncedAt ? t("voting.badgeChainRead") : t("voting.badgeProposalPendingRead") : vote.kind === "draft" ? t("voting.badgeLocalBrowser") : t("voting.badgeLegacyLocal")}</Badge>
                    {vote.isTimeLockedSeal && <Badge variant="outline" className="text-[10px] text-purple-600"><Lock className="h-2.5 w-2.5 mr-1" />{t("voting.badgeSeal")}</Badge>}
                    {vote.record && <Badge variant="outline" className="text-[10px]">{t("voting.badgeOldReceipt")}</Badge>}
                  </div>
                  {vote.source === "shared-poll" ? <p className="text-xs text-muted-foreground">{t("voting.sharedPollStats", { voters: vote.totalVotes ?? 0, voted: vote.weights.voted ?? 0, total: vote.weights.total ?? 0 })}</p> : vote.kind === "proposal" ? <p className="text-xs text-muted-foreground">{t("voting.proposalStats", { approved: vote.options[0]?.votes ?? t("voting.notSynced"), required: vote.weights.required ?? t("voting.notSynced"), voters: vote.totalVotes ?? t("voting.notSynced") })}</p> : vote.kind === "draft" ? <p className="text-xs text-muted-foreground">{t("voting.draftStats")}</p> : <p className="text-xs text-muted-foreground">{t("voting.legacyStats", { votes: vote.totalVotes ?? t("voting.notRecorded") })}</p>}
                  {vote.kind === "proposal" && vote.chainSyncedAt && vote.options[0]?.votes != null && vote.weights.required != null && vote.weights.required > 0 && <div role="meter" aria-label={t("voting.meterAria")} aria-valuemin={0} aria-valuemax={vote.weights.required} aria-valuenow={Math.min(vote.options[0].votes, vote.weights.required)} title={t("voting.meterTitle", { approved: vote.options[0].votes, required: vote.weights.required })} className="h-1.5 overflow-hidden rounded-full bg-muted"><motion.div initial={{ width: 0 }} animate={{ width: `${Math.min(100, vote.options[0].votes / vote.weights.required * 100)}%` }} className="h-full rounded-r bg-primary" /></div>}
                  <div className="flex items-center justify-between gap-2 pt-1"><span className="flex items-center text-xs text-muted-foreground"><CalendarClock className="h-3.5 w-3.5 mr-1" />{t("voting.deadlineAt", { date: formatDate(vote.expiresAt) })}</span>
                    {vote.kind === "draft" ? <Button size="sm" className="h-7 text-xs" onClick={event => { event.stopPropagation(); setEditingDraft(vote.id); setCreateVoteOpen(true) }}>{t("voting.continueEditing")}</Button> : <Button size="sm" variant="outline" className="h-7 text-xs">{vote.hasVoted ? t("voting.votedViewDetails") : t("voting.viewVote")}</Button>}
                  </div>
                </CardContent>
              </Card>
            </motion.div>)}
          </motion.div>}
        </TabsContent>)}
      </AnimatePresence>
    </Tabs>
    <VoteDetailsDialog open={!!selectedVote} onOpenChange={open => { if (!open) setSelectedVote(null) }} voteId={selectedVote || ""} />
    <CreateVoteDialog open={createVoteOpen} onOpenChange={setCreateVoteOpen} draftId={editingDraft} />
  </div>
}
