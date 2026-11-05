"use client"

import { useState, useEffect, useRef } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Switch } from "@/components/ui/switch"
import { Calendar } from "@/components/ui/calendar"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { ScrollArea } from "@/components/ui/scroll-area"
import { motion, AnimatePresence } from "framer-motion"
import { format } from "date-fns"
import { cn } from "@/lib/utils"
import { CalendarIcon, XIcon, PlusIcon, UserIcon, Users, EyeIcon, EyeOffIcon, LinkIcon, Vote, CheckCircle2Icon, ListFilter, AlignLeftIcon, AlertTriangleIcon, BarChartIcon, LockIcon, SparklesIcon } from "lucide-react"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"

import { getActiveAccount, getUserGroups } from "@/lib/onchain-store"
import { getGovernanceVotes, saveGovernanceDraft, governancePublicationGaps } from "@/lib/governance"
import { GroupProposalEntryDialog } from "@/components/group-proposal-entry-dialog"
import { governancePublicationScope, publishGovernancePoll, resumeGovernancePoll } from "@/lib/governance-chain"
import { TransactionReceiptError } from "@/lib/pending-transactions"
import { createSubmissionGuard } from "@/lib/wallet-creation-state"
import { usePendingCreation } from "@/lib/use-pending-creation"
import { groupPollReader, resolveGroupPollScope } from "@/lib/group-polls"
import { useI18n } from "@/components/i18n-provider"

interface CreateVoteDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  draftId?: string
  initialVoteId?: string
  initialGroupId?: string
}

interface VoterGroup {
  id: string
  name: string
  members: Array<{ name: string; address: string; weight: number }>
}

interface VoteOption {
  id: string
  text: string
}

interface Voter {
  id: string
  name?: string
  address: string
  weight: number
  type?: "wallet" | "email"
}

const initialVoteOption = { id: "option-1", text: "" }

export function CreateVoteDialog({ open, onOpenChange, draftId, initialVoteId, initialGroupId }: CreateVoteDialogProps) {
  const { t } = useI18n()
  const [step, setStep] = useState(1)
  const [groups, setGroups] = useState<VoterGroup[]>([])
  const [recentContacts] = useState<Array<{ id: string; name: string; address: string; type: "wallet" | "email" }>>([])

  useEffect(() => {
    setGroups(getUserGroups().filter(g => Array.isArray(g.members)))
  }, [open])
  const [saveError, setSaveError] = useState<string | null>(null)
  const [title, setTitle] = useState("")
  const [description, setDescription] = useState("")
  const [voteType, setVoteType] = useState("single") // single, multiple, ranked
  const [voterSource, setVoterSource] = useState("manual") // manual, group, hybrid
  const [selectedGroup, setSelectedGroup] = useState("")
  const [voters, setVoters] = useState<Voter[]>([])
  const [searchTerm, setSearchTerm] = useState("")
  const [voteOptions, setVoteOptions] = useState<VoteOption[]>([initialVoteOption])
  const [isAnonymous, setIsAnonymous] = useState(false)
  const [showResults, setShowResults] = useState("after") // after, during
  const [expiryDate, setExpiryDate] = useState<Date | undefined>(undefined)
  const [createTransaction, setCreateTransaction] = useState(false)
  const [selectedTransaction, setSelectedTransaction] = useState<string | undefined>(undefined)
  const [weightType, setWeightType] = useState("manual") // manual, token, nft
  const [tokenAddress, setTokenAddress] = useState("")
  const [tokenSymbol, setTokenSymbol] = useState("")
  const [weightCalculation, setWeightCalculation] = useState("linear") // linear, sqrt, quadratic
  const [snapshotBlock, setSnapshotBlock] = useState("latest") // latest, specific
  const [specificBlock, setSpecificBlock] = useState("")
  const [isTimeLockedSeal, setIsTimeLockedSeal] = useState(false) // 仅保存设置草稿，尚未接入 SEAL
  const [targetNftType, setTargetNftType] = useState("") // NFT Gating 合约类型

  const [allowLinkAccess, setAllowLinkAccess] = useState(true)
  const [publicationInfo, setPublicationInfo] = useState(false)
  const [fundingOpen, setFundingOpen] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [published, setPublished] = useState<{ id: string; digest: string; warning?: string } | null>(null)
  const recovery = usePendingCreation(open, "publish-poll", governancePublicationScope(selectedGroup))
  const publicationGuard = useRef(createSubmissionGuard())
  const initialRosterGeneration = useRef(0)

  // Hydrate every setting when resuming. No delayed reset can erase a reopened draft.
  useEffect(() => {
    if (!open) return
    const run = ++initialRosterGeneration.current
    const saved = getGovernanceVotes().find(vote => vote.id === (draftId || initialVoteId))
    const groupStart = !saved && !!initialGroupId
    setSaveError(null); setPublished(null); setPublicationInfo(false); setStep(1); setSearchTerm("")
    setTitle(saved?.title || ""); setDescription(saved?.description || "")
    setVoteType(saved?.voteType || "single"); setVoterSource(saved?.voterSource || (groupStart ? "group" : "manual"))
    setSelectedGroup(saved?.selectedGroup || saved?.groupId || initialGroupId || "")
    setVoters(saved?.voters.map(voter => ({ ...voter, address: voter.address || "", weight: voter.weight ?? 1 })) || [])
    setVoteOptions(saved?.options.length ? saved.options.map(option => ({ id: option.id, text: option.text })) : [initialVoteOption])
    setIsAnonymous(!!saved?.isAnonymous); setShowResults(saved?.showResultsDuring ? "during" : "after")
    setExpiryDate(saved?.expiresAt && Number.isFinite(Date.parse(saved.expiresAt)) ? new Date(saved.expiresAt) : undefined)
    setCreateTransaction(!!saved?.createTransaction); setSelectedTransaction(saved?.selectedTransaction)
    setWeightType(saved?.weightType || "manual"); setTokenAddress(saved?.tokenAddress || ""); setTokenSymbol(saved?.tokenSymbol || "")
    setWeightCalculation(saved?.weightCalculation || "linear"); setSnapshotBlock(saved?.snapshotBlock || "latest"); setSpecificBlock(saved?.specificBlock || "")
    setIsTimeLockedSeal(!!saved?.isTimeLockedSeal); setTargetNftType(saved?.targetNftType || "")
    setAllowLinkAccess(saved?.allowLinkAccess !== false)
    if (groupStart) {
      try {
        const scope = resolveGroupPollScope(initialGroupId, undefined, getUserGroups())
        if (!scope.groupId) throw new Error(t("voting.errGroupScope"))
        void groupPollReader.readOrganization(scope.orgId).then(org => {
          if (run !== initialRosterGeneration.current) return
          setVoters(Object.entries(org.members).map(([address, weight]) => ({ id: address, name: address, address, weight, type: "wallet" as const })))
        }).catch(error => { if (run === initialRosterGeneration.current) setSaveError(error instanceof Error ? error.message : t("voting.errRosterRead")) })
      } catch (error) { setSaveError(error instanceof Error ? error.message : t("voting.errRosterReadShort")) }
    }
    const invalidate = () => { initialRosterGeneration.current++ }
    return () => { invalidate() }
  }, [open, draftId, initialVoteId, initialGroupId])

  const selectGroup = (groupId: string) => {
    initialRosterGeneration.current++
    setSelectedGroup(groupId)
    const members = groups.find(group => group.id === groupId)?.members.map(member => ({
      // Voter rows are keyed by id; the address is the only stable identity a
      // group roster carries, so it doubles as one.
      ...member, id: member.address, weight: member.weight ?? 1, type: "wallet" as const,
    })) || []
    setVoters(current => voterSource === "group" ? members : [...current, ...members.filter(member => !current.some(voter => voter.address.toLowerCase() === member.address.toLowerCase()))])
  }

  const addVoteOption = () => {
    setVoteOptions([...voteOptions, { id: `option-${Date.now()}`, text: "" }])
  }

  const updateVoteOption = (id: string, text: string) => {
    setVoteOptions(voteOptions.map((option) => (option.id === id ? { ...option, text } : option)))
  }

  const removeVoteOption = (id: string) => {
    if (voteOptions.length > 1) {
      setVoteOptions(voteOptions.filter((option) => option.id !== id))
    }
  }

  const addVoter = (contact: (typeof recentContacts)[0]) => {
    if (!voters.some((v) => v.address.toLowerCase() === contact.address.toLowerCase())) {
      setVoters([
        ...voters,
        {
          id: contact.id,
          name: contact.name,
          address: contact.address,
          weight: 1,
          type: contact.type,
        },
      ])
    }
  }

  const removeVoter = (id: string) => {
    setVoters(voters.filter((voter) => voter.id !== id))
  }

  const updateVoterWeight = (id: string, weight: number) => {
    setVoters(voters.map((voter) => (voter.id === id ? { ...voter, weight } : voter)))
  }

  const nextStep = () => {
    setStep(step + 1)
  }

  const prevStep = () => {
    setStep(step - 1)
  }

  const voteDraft = () => {
    const previous = draftId ? getGovernanceVotes().find(vote => vote.id === draftId) : undefined
    return {
      ...previous,
      id: draftId || `draft-${crypto.randomUUID()}`,
      title: title.trim(), description: description.trim(),
      creator: previous?.creator || getActiveAccount()?.address || t("voting.localUser"),
      creatorAddress: previous?.creatorAddress || getActiveAccount()?.address,
      createdAt: previous?.createdAt || new Date().toISOString(),
      expiresAt: expiryDate?.toISOString(),
      voteType, status: "draft", source: "local-draft",
      selectedGroup, groupId: selectedGroup, voterSource, createTransaction, selectedTransaction, allowLinkAccess,
      group: groups.find(g => g.id === selectedGroup)?.name || previous?.group || t("voting.noGroupSelected"),
      isAnonymous, isTimeLockedSeal, weightType, targetNftType,
      weightCalculation, tokenAddress, tokenSymbol, snapshotBlock, specificBlock,
      showResultsDuring: showResults === "during", voters,
      color: previous?.color || "from-primary to-purple-500",
      options: voteOptions.map(opt => ({ id: opt.id, text: opt.text.trim() })),
    }
  }
  const handleCreateVote = () => {
    setSaveError(null)
    if (!title.trim()) { setSaveError(t("voting.errTitleRequired")); return }
    try {
      saveGovernanceDraft(voteDraft())
      onOpenChange(false)
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : t("voting.errDraftSaveFail"))
    }
  }
  const handleResumeVote = async () => {
    if (!recovery.pending || !publicationGuard.current.enter()) return
    setPublishing(true); setSaveError(null)
    try { setPublished(await resumeGovernancePoll(recovery.pending)); recovery.setPending(undefined) }
    catch (error) {
      if (error instanceof TransactionReceiptError) recovery.setPending(error.status === "failed" ? undefined : error.receipt)
      setSaveError(error instanceof Error ? error.message : t("voting.errResumeNotConfirmed"))
    } finally { publicationGuard.current.leave(); setPublishing(false) }
  }
  const handlePublishVote = async () => {
    if (publishing || published || recovery.blocked || !publicationGuard.current.enter()) return
    setPublishing(true); setSaveError(null); setPublicationInfo(true)
    const draft = voteDraft()
    try {
      // Save every selected policy before capability/transaction checks. A
      // failed publication leaves a resumable configuration, never a fake poll.
      saveGovernanceDraft(draft)
      const result = await publishGovernancePoll(draft)
      setPublished(result)
    } catch (error) {
      if (error instanceof TransactionReceiptError) recovery.setPending(error.status === "failed" ? undefined : error.receipt)
      setSaveError(error instanceof Error ? error.message : t("voting.errPublishFail"))
    } finally { publicationGuard.current.leave(); setPublishing(false) }
  }

  // Filter contacts based on search term
  const filteredContacts = searchTerm
    ? recentContacts.filter(
        (contact) =>
          contact.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
          contact.address.toLowerCase().includes(searchTerm.toLowerCase()),
      )
    : recentContacts

  return (<>
    <Dialog open={open && !fundingOpen} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px] max-h-[90dvh] overflow-y-auto p-0 gap-0">
        <DialogHeader className="p-4 pb-0">
          <DialogTitle>{draftId ? t("voting.dialogTitleEdit") : initialVoteId ? t("voting.dialogTitleFromHistory") : t("voting.newVote")}</DialogTitle>
          <DialogDescription>{t("voting.dialogDesc")}</DialogDescription>
        </DialogHeader>

        <div className="relative overflow-hidden">
          <div className="flex justify-between px-4 pt-4">
            {[1, 2, 3].map((i) => (
              <button
                key={i}
                type="button"
                disabled={i >= step}
                onClick={() => setStep(i)}
                aria-current={i === step ? "step" : undefined}
                aria-label={t("voting.stepAria", { index: i, label: [t("voting.stepBasic"), t("voting.stepOptions"), t("voting.stepSettings")][i - 1] })}
                className="flex flex-col items-center rounded-md disabled:cursor-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                <div
                  className={`h-8 w-8 rounded-full flex items-center justify-center text-sm ${
                    i < step
                      ? "bg-primary text-primary-foreground"
                      : i === step
                        ? "bg-primary/20 text-primary border-2 border-primary"
                        : "bg-muted text-muted-foreground"
                  }`}
                >
                  {i}
                </div>
                <div className="text-xs mt-1 text-muted-foreground">
                  {i === 1 ? t("voting.stepBasic") : i === 2 ? t("voting.stepOptions") : t("voting.stepSettings")}
                </div>
              </button>
            ))}
            <div className="absolute top-[28px] left-[68px] w-[120px] h-[2px] bg-muted">
              <div className={`h-full bg-primary transition-all ${step > 1 ? "w-full" : "w-0"}`}></div>
            </div>
            <div className="absolute top-[28px] right-[68px] w-[120px] h-[2px] bg-muted">
              <div className={`h-full bg-primary transition-all ${step > 2 ? "w-full" : "w-0"}`}></div>
            </div>
          </div>

          <AnimatePresence mode="wait">
            {step === 1 && (
              <motion.div
                key="step1"
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 20 }}
                transition={{ duration: 0.3 }}
                className="px-4 py-4"
              >
                <div className="space-y-3">
                  <div className="space-y-1">
                    <Label htmlFor="title" className="text-xs font-medium">
                      {t("voting.titleLabel")}
                    </Label>
                    <Input
                      id="title"
                      placeholder={t("voting.titlePlaceholder")}
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                    />
                  </div>

                  <div className="space-y-1">
                    <Label htmlFor="description" className="text-xs font-medium">
                      {t("voting.descriptionLabel")}
                    </Label>
                    <Textarea
                      id="description"
                      placeholder={t("voting.descriptionPlaceholder")}
                      className="resize-none h-24"
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                    />
                  </div>

                  <div className="space-y-1">
                    <Label className="text-xs font-medium">{t("voting.voteTypeLabel")}</Label>
                    <Tabs value={voteType} onValueChange={setVoteType} className="w-full">
                      <TabsList className="grid w-full grid-cols-3 p-1 bg-muted/50 rounded-xl h-9">
                        <TabsTrigger
                          value="single"
                          className="rounded-lg text-xs data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
                        >
                          {t("voting.modeSingle")}
                        </TabsTrigger>
                        <TabsTrigger
                          value="multiple"
                          className="rounded-lg text-xs data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
                        >
                          {t("voting.modeMultiple")}
                        </TabsTrigger>
                        <TabsTrigger
                          value="ranked"
                          className="rounded-lg text-xs data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
                        >
                          {t("voting.modeRanked")}
                        </TabsTrigger>
                      </TabsList>
                    </Tabs>
                    <p className="text-xs text-muted-foreground mt-1">
                      {voteType === "single"
                        ? t("voting.hintSingle")
                        : voteType === "multiple"
                          ? t("voting.hintMultiple")
                          : t("voting.hintRanked")}
                    </p>
                  </div>

                  <div className="space-y-1">
                    <Label className="text-xs font-medium">{t("voting.weightTypeLabel")}</Label>
                    <Tabs value={weightType} onValueChange={setWeightType} className="w-full">
                      <TabsList className="grid w-full grid-cols-3 p-1 bg-muted/50 rounded-xl h-9">
                        <TabsTrigger
                          value="manual"
                          className="rounded-lg text-xs data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
                        >
                          {t("voting.weightManualTab")}
                        </TabsTrigger>
                        <TabsTrigger
                          value="token"
                          className="rounded-lg text-xs data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
                        >
                          {t("voting.weightToken")}
                        </TabsTrigger>
                        <TabsTrigger
                          value="nft"
                          className="rounded-lg text-xs data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
                        >
                          {t("voting.weightNftTab")}
                        </TabsTrigger>
                      </TabsList>
                    </Tabs>
                    <p className="text-xs text-muted-foreground mt-1">
                      {weightType === "manual"
                        ? t("voting.hintWeightManual")
                        : weightType === "token"
                          ? t("voting.hintWeightToken")
                          : t("voting.hintWeightNft")}
                    </p>
                  </div>

                  {weightType === "token" && (
                    <div className="space-y-3 mt-3 p-3 rounded-lg border">
                      <div className="space-y-1">
                        <Label htmlFor="tokenAddress" className="text-xs font-medium">
                          {t("voting.tokenAddressLabel")}
                        </Label>
                        <Input
                          id="tokenAddress"
                          placeholder="0x..."
                          value={tokenAddress}
                          onChange={(e) => setTokenAddress(e.target.value)}
                        />
                      </div>

                      <div className="space-y-1">
                        <Label htmlFor="tokenSymbol" className="text-xs font-medium">
                          {t("voting.tokenSymbolLabel")}
                        </Label>
                        <Input
                          id="tokenSymbol"
                          placeholder={t("voting.tokenSymbolPlaceholder")}
                          value={tokenSymbol}
                          onChange={(e) => setTokenSymbol(e.target.value)}
                        />
                      </div>

                      <div className="space-y-1">
                        <Label className="text-xs font-medium">{t("voting.calcLabel")}</Label>
                        <Select value={weightCalculation} onValueChange={setWeightCalculation}>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="linear">{t("voting.calcLinearOption")}</SelectItem>
                            <SelectItem value="sqrt">{t("voting.calcSqrtOption")}</SelectItem>
                            <SelectItem value="quadratic">{t("voting.calcQuadraticOption")}</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>

                      <div className="space-y-1">
                        <Label className="text-xs font-medium">{t("voting.snapshotLabel")}</Label>
                        <Select value={snapshotBlock} onValueChange={setSnapshotBlock}>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="latest">{t("voting.snapshotLatestOption")}</SelectItem>
                            <SelectItem value="specific">{t("voting.snapshotSpecificOption")}</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>

                      {snapshotBlock === "specific" && (
                        <div className="space-y-1">
                          <Label htmlFor="specificBlock" className="text-xs font-medium">
                            {t("voting.blockHeightLabel")}
                          </Label>
                          <Input
                            id="specificBlock"
                            placeholder={t("voting.blockHeightPlaceholder")}
                            value={specificBlock}
                            onChange={(e) => setSpecificBlock(e.target.value)}
                          />
                        </div>
                      )}
                    </div>
                  )}

                  {weightType === "nft" && (
                    <div className="space-y-3 mt-3 p-3 rounded-lg border bg-muted/20">
                      <div className="space-y-1">
                        <Label htmlFor="targetNftType" className="text-xs font-medium flex items-center">
                          <SparklesIcon className="h-3.5 w-3.5 mr-1 text-purple-500" />
                          {t("voting.nftTypeLabel")}
                        </Label>
                        <Input
                          id="targetNftType"
                          placeholder={t("voting.nftTypePlaceholder")}
                          value={targetNftType}
                          onChange={(e) => setTargetNftType(e.target.value)}
                        />
                        <p className="text-[11px] text-muted-foreground mt-1">
                          {t("voting.nftNote")}
                        </p>
                      </div>
                    </div>
                  )}

                  <div className="space-y-1">
                    <Label htmlFor="expiry" className="text-xs font-medium">
                      {t("voting.expiryLabel")}
                    </Label>
                    <Popover>
                      <PopoverTrigger asChild>
                        <Button
                          variant={"outline"}
                          className={cn(
                            "w-full justify-start text-left font-normal",
                            !expiryDate && "text-muted-foreground",
                          )}
                        >
                          <CalendarIcon className="mr-2 h-4 w-4" />
                          {expiryDate ? format(expiryDate, "PPP") : t("voting.pickDate")}
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent className="w-auto p-0">
                        <Calendar mode="single" selected={expiryDate} onSelect={setExpiryDate} />
                      </PopoverContent>
                    </Popover>
                  </div>
                </div>
              </motion.div>
            )}

            {step === 2 && (
              <motion.div
                key="step2"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                transition={{ duration: 0.3 }}
                className="px-4 py-4"
              >
                <div className="space-y-4">
                  {/* 投票选项部分 */}
                  <div className="space-y-2">
                    <Label className="text-xs font-medium flex items-center">
                      <ListFilter className="h-4 w-4 mr-1.5" />
                      {t("voting.optionsSection")}
                    </Label>

                    <div className="space-y-2">
                      {voteOptions.map((option, index) => (
                        <div key={option.id} className="flex items-center gap-2">
                          <div className="w-8 h-8 flex items-center justify-center bg-primary/10 rounded-full text-xs font-medium">
                            {index + 1}
                          </div>
                          <Input
                            placeholder={t("voting.optionPlaceholder", { index: index + 1 })}
                            value={option.text}
                            onChange={(e) => updateVoteOption(option.id, e.target.value)}
                            className="flex-1"
                          />
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            onClick={() => removeVoteOption(option.id)}
                            className="h-8 w-8"
                            disabled={voteOptions.length <= 1}
                          >
                            <XIcon className="h-4 w-4" />
                          </Button>
                        </div>
                      ))}
                    </div>

                    <Button type="button" variant="outline" size="sm" onClick={addVoteOption} className="w-full mt-2">
                      <PlusIcon className="h-4 w-4 mr-1" /> {t("voting.addOption")}
                    </Button>
                  </div>

                  {/* 选民选择部分 */}
                  <div className="space-y-2 pt-4 border-t">
                    <Label className="text-xs font-medium flex items-center">
                      <Users className="h-4 w-4 mr-1.5" />
                      {t("voting.votersSection")}
                    </Label>

                    <div className="space-y-2">
                      <Tabs value={voterSource} onValueChange={setVoterSource} className="w-full">
                        <TabsList className="grid w-full grid-cols-3 p-1 bg-muted/50 rounded-xl h-9">
                          <TabsTrigger
                            value="manual"
                            className="rounded-lg text-xs data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
                          >
                            {t("voting.addManually")}
                          </TabsTrigger>
                          <TabsTrigger
                            value="group"
                            className="rounded-lg text-xs data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
                          >
                            {t("voting.syncFromGroup")}
                          </TabsTrigger>
                          <TabsTrigger
                            value="hybrid"
                            className="rounded-lg text-xs data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
                          >
                            {t("voting.hybridMode")}
                          </TabsTrigger>
                        </TabsList>
                      </Tabs>

                      {(voterSource === "group" || voterSource === "hybrid") && (
                        <div className="space-y-1 mt-2">
                          <Label htmlFor="group" className="text-xs font-medium">
                            {t("voting.selectGroupLabel")}
                          </Label>
                          <Select value={selectedGroup} onValueChange={selectGroup}>
                            <SelectTrigger id="group">
                              <SelectValue placeholder={t("voting.selectGroupPlaceholder")} />
                            </SelectTrigger>
                            <SelectContent>
                              {groups.map((group) => (
                                <SelectItem key={group.id} value={group.id}>
                                  {group.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      )}

                      {(voterSource === "manual" || voterSource === "hybrid") && (
                        <div className="mt-2">
                          <div className="flex items-center gap-2 mb-2">
                            <Input
                              placeholder={t("voting.searchContactsPlaceholder")}
                              value={searchTerm}
                              onChange={(e) => setSearchTerm(e.target.value)}
                              className="flex-1"
                            />
                            <Button type="button" variant="outline" size="icon" className="h-9 w-9"onClick={() => {
                              const address = searchTerm.trim()
                              if (!/^0x[0-9a-fA-F]{1,64}$/.test(address) && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) { setSaveError(t("voting.errInvalidVoterInput")); return }
                              addVoter({ id: address.toLowerCase(), name: address, address, type: address.includes("@") ? "email" : "wallet" })
                              setSearchTerm(""); setSaveError(null)
                            }} aria-label={t("voting.addVoterAria")}>
                              <PlusIcon className="h-4 w-4" />
                            </Button>
                          </div>

                          <ScrollArea className="h-[150px] border rounded-md p-2">
                            <div className="space-y-1">
                              {filteredContacts.map((contact) => (
                                <div
                                  key={contact.id}
                                  className="flex items-center justify-between p-2 rounded-lg hover:bg-muted/50 transition-colors cursor-pointer"
                                  onClick={() => addVoter(contact)}
                                >
                                  <div className="flex items-center">
                                    <Avatar className="h-6 w-6 mr-2">
                                      <AvatarFallback
                                        className={
                                          contact.type === "email"
                                            ? "bg-blue-100 text-blue-600"
                                            : "bg-purple-100 text-purple-600"
                                        }
                                      >
                                        {contact.name.charAt(0)}
                                      </AvatarFallback>
                                    </Avatar>
                                    <div>
                                      <p className="text-sm font-medium">{contact.name}</p>
                                      <p className="text-xs text-muted-foreground truncate max-w-[200px]">
                                        {contact.address}
                                      </p>
                                    </div>
                                  </div>
                                  <PlusIcon className="h-4 w-4 opacity-50 hover:opacity-100" />
                                </div>
                              ))}
                              {filteredContacts.length === 0 && (
                                <div className="p-2 text-center text-sm text-muted-foreground">{t("voting.noContactsFound")}</div>
                              )}
                            </div>
                          </ScrollArea>
                        </div>
                      )}

                      {/* 已选择的投票人 */}
                      {voters.length > 0 && (
                        <div className="mt-3">
                          <Label className="text-xs font-medium">{t("voting.selectedVoters", { count: voters.length })}</Label>
                          <ScrollArea className="h-[150px] border rounded-md p-2 mt-1">
                            <div className="space-y-1">
                              {voters.map((voter) => (
                                <div
                                  key={voter.id}
                                  className="flex items-center justify-between p-2 rounded-lg hover:bg-muted/50 transition-colors"
                                >
                                  <div className="flex items-center">
                                    <Avatar className="h-6 w-6 mr-2">
                                      <AvatarFallback
                                        className={
                                          voter.type === "email"
                                            ? "bg-blue-100 text-blue-600"
                                            : "bg-purple-100 text-purple-600"
                                        }
                                      >
                                        {voter.name?.charAt(0) || "U"}
                                      </AvatarFallback>
                                    </Avatar>
                                    <div>
                                      <p className="text-sm font-medium">{voter.name || voter.address}</p>
                                      <p className="text-xs text-muted-foreground truncate max-w-[150px]">
                                        {voter.address}
                                      </p>
                                    </div>
                                  </div>
                                  <div className="flex items-center gap-2">
                                    <div className="flex items-center gap-1">
                                      <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon"
                                        onClick={() => updateVoterWeight(voter.id, Math.max(1, voter.weight - 1))}
                                        className="h-6 w-6"
                                      >
                                        <svg
                                          xmlns="http://www.w3.org/2000/svg"
                                          width="16"
                                          height="16"
                                          viewBox="0 0 24 24"
                                          fill="none"
                                          stroke="currentColor"
                                          strokeWidth="2"
                                          strokeLinecap="round"
                                          strokeLinejoin="round"
                                        >
                                          <path d="M5 12h14" />
                                        </svg>
                                      </Button>
                                      <span className="text-xs font-medium w-5 text-center">{voter.weight}</span>
                                      <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon"
                                        onClick={() => updateVoterWeight(voter.id, voter.weight + 1)}
                                        className="h-6 w-6"
                                      >
                                        <PlusIcon className="h-3 w-3" />
                                      </Button>
                                    </div>
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="icon"
                                      onClick={() => removeVoter(voter.id)}
                                      className="h-6 w-6 text-destructive"
                                    >
                                      <XIcon className="h-3 w-3" />
                                    </Button>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </ScrollArea>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </motion.div>
            )}

            {step === 3 && (
              <motion.div
                key="step3"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                transition={{ duration: 0.3 }}
                className="px-4 py-4"
              >
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label className="text-xs font-medium flex items-center">
                      <EyeIcon className="h-4 w-4 mr-1.5" />
                      {t("voting.privacySection")}
                    </Label>

                    <div className="space-y-2">
                      <div className="flex items-center justify-between p-2.5 rounded-lg border bg-gradient-to-r from-purple-500/10 via-primary/5 to-transparent">
                        <div className="flex items-center">
                          <div className="h-8 w-8 rounded-full bg-purple-500/15 flex items-center justify-center mr-2 text-purple-600">
                            <LockIcon className="h-4 w-4" />
                          </div>
                          <div>
                            <div className="flex items-center gap-1.5">
                              <p className="text-sm font-semibold">{t("voting.sealTimeLockTitle")}</p>
                              <span className="text-[10px] bg-purple-500/15 text-purple-700 dark:text-purple-300 font-semibold px-1.5 py-0.5 rounded">
                                {t("voting.notWiredBadge")}
                              </span>
                            </div>
                            <p className="text-xs text-muted-foreground mt-0.5">
                              {t("voting.sealTimeLockDesc")}
                            </p>
                          </div>
                        </div>
                        <Switch checked={isTimeLockedSeal} onCheckedChange={setIsTimeLockedSeal} />
                      </div>

                      <div className="flex items-center justify-between p-2 rounded-lg border">
                        <div className="flex items-center">
                          <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center mr-2">
                            {isAnonymous ? (
                              <EyeOffIcon className="h-4 w-4 text-primary" />
                            ) : (
                              <UserIcon className="h-4 w-4 text-primary" />
                            )}
                          </div>
                          <div>
                            <p className="text-sm font-medium">{t("voting.anonymousTitle")}</p>
                            <p className="text-xs text-muted-foreground">
                              {isAnonymous ? t("voting.anonymousOn") : t("voting.anonymousOff")}
                            </p>
                          </div>
                        </div>
                        <Switch checked={isAnonymous} onCheckedChange={setIsAnonymous} />
                      </div>

                      <div className="flex items-center justify-between p-2 rounded-lg border">
                        <div className="flex items-center">
                          <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center mr-2">
                            {showResults === "after" ? (
                              <BarChartIcon className="h-4 w-4 text-primary" />
                            ) : (
                              <AlignLeftIcon className="h-4 w-4 text-primary" />
                            )}
                          </div>
                          <div>
                            <p className="text-sm font-medium">{t("voting.resultsTimingTitle")}</p>
                            <p className="text-xs text-muted-foreground">
                              {showResults === "after" ? t("voting.resultsAfterHint") : t("voting.resultsDuringHint")}
                            </p>
                          </div>
                        </div>
                        <Select value={showResults} onValueChange={setShowResults}>
                          <SelectTrigger className="w-[120px]">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="after">{t("voting.resultsAfter")}</SelectItem>
                            <SelectItem value="during">{t("voting.resultsDuring")}</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>

                      <div className="flex items-center justify-between p-2 rounded-lg border">
                        <div className="flex items-center">
                          <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center mr-2">
                            <LinkIcon className="h-4 w-4 text-primary" />
                          </div>
                          <div>
                            <p className="text-sm font-medium">{t("voting.linkAccessTitle")}</p>
                            <p className="text-xs text-muted-foreground">{allowLinkAccess ? t("voting.linkAccessOn") : t("voting.linkAccessOff")}</p>
                          </div>
                        </div>
                        <Switch checked={allowLinkAccess} onCheckedChange={setAllowLinkAccess} />
                      </div>
                    </div>
                  </div>

                  <div className="space-y-2 pt-4 border-t">
                    <Label className="text-xs font-medium flex items-center">
                      <CheckCircle2Icon className="h-4 w-4 mr-1.5" />
                      {t("voting.settingsExecution")}
                    </Label>

                    <div className="space-y-2">
                      <div className="flex items-center justify-between p-2 rounded-lg border">
                        <div className="flex items-center">
                          <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center mr-2">
                            <Vote className="h-4 w-4 text-primary" />
                          </div>
                          <div>
                            <p className="text-sm font-medium">{t("voting.createTxTitle")}</p>
                            <p className="text-xs text-muted-foreground">
                              {createTransaction ? t("voting.createTxOn") : t("voting.createTxOff")}
                            </p>
                          </div>
                        </div>
                        <Switch checked={createTransaction} onCheckedChange={setCreateTransaction} />
                      </div>

                      {createTransaction && (
                        <div className="space-y-1 pl-10">
                          <Label className="text-xs font-medium">{t("voting.selectTemplateLabel")}</Label>
                          <Select value={selectedTransaction} onValueChange={setSelectedTransaction}>
                            <SelectTrigger>
                              <SelectValue placeholder={t("voting.selectTemplateLabel")} />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="template-1">{t("voting.templateTransfer")}</SelectItem>
                              <SelectItem value="template-2">{t("voting.templateStake")}</SelectItem>
                              <SelectItem value="template-3">{t("voting.templateSwap")}</SelectItem>
                            </SelectContent>
                          </Select>
                          <p className="text-xs text-muted-foreground mt-1">{t("voting.templateNote")}</p>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="bg-yellow-50 p-3 rounded-lg border border-yellow-200 mt-4">
                    <div className="flex items-start">
                      <AlertTriangleIcon className="h-5 w-5 text-yellow-500 mr-2 mt-0.5" />
                      <div>
                        <p className="text-sm font-medium text-yellow-700">{t("voting.confirmTitle")}</p>
                        <p className="text-xs text-yellow-600 mt-1">
                          {t("voting.confirmBody")}
                          {expiryDate && (
                            <>
                              <br />
                              {t("voting.draftDeadlinePrefix")} <strong>{format(expiryDate, "PPP")}</strong>{t("voting.draftDeadlineSuffix")}
                            </>
                          )}
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {recovery.pending && <div role="status" className="mx-4 mb-3 rounded-lg border p-3 text-xs space-y-2 break-all"><p>{t("voting.recoveryIntro")}{recovery.pending.digest || t("voting.noDigestYet")}{t("voting.recoveryTail")}</p>{!recovery.pending.persistent && <p>{t("voting.storageUnavailable")}</p>}<Button size="sm" variant="outline" disabled={publishing || !recovery.pending.digest} onClick={() => void handleResumeVote()}>{t("voting.resumeByDigest")}</Button></div>}
        {recovery.receiptError && <p role="alert" className="px-4 text-xs text-destructive">{recovery.receiptError}</p>}
        {publicationInfo && <div className="mx-4 mb-3 rounded-lg border bg-muted/30 p-3 space-y-2 text-xs" role="status">
          {governancePublicationGaps().map(gap => <p key={gap}>{gap}</p>)}
          <Button size="sm" variant="outline" onClick={() => setFundingOpen(true)}>{t("voting.createFundingProposal")}</Button>
        </div>}
        {published && <div className="mx-4 mb-3 rounded-lg border p-3 text-xs space-y-2" role="status"><p>{t("voting.voteTxConfirmed")}{published.warning}</p><a className="block break-all underline" href={`?vote=${published.id}`}>{t("voting.openSharedVote", { id: published.id })}</a><a className="block break-all underline" target="_blank" rel="noreferrer" href={`https://suiscan.xyz/testnet/tx/${published.digest}`}>{t("voting.viewRealReceipt", { digest: published.digest })}</a><p className="text-muted-foreground">{t("voting.originalDraftKept")}</p></div>}
        {saveError && <p role="alert" className="px-4 text-xs text-destructive">{saveError}</p>}
        <DialogFooter className="p-4 pt-2">
          {step > 1 ? (
            <div className="flex w-full justify-between">
              <Button type="button" variant="outline" onClick={prevStep} size="sm">
                {t("voting.prevStep")}
              </Button>
              {step < 3 ? (
                <Button type="button" onClick={nextStep} size="sm">
                  {t("voting.nextStep")}
                </Button>
              ) : (
                <div className="flex flex-wrap gap-2">
                  <Button type="button" size="sm" variant="outline" onClick={handleCreateVote}>{t("voting.saveDraft")}</Button>
                  <Button type="button" size="sm" disabled={publishing || !!published || recovery.blocked} onClick={() => void handlePublishVote()} className="bg-gradient-to-r from-primary to-purple-500">{publishing ? t("voting.waitingSignatureConfirm") : published ? t("voting.publishedLabel") : t("voting.publishVote")}</Button>
                </div>
              )}
            </div>
          ) : (
            <Button type="button" onClick={nextStep} className="w-full">
              {t("voting.nextStep")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <GroupProposalEntryDialog open={open && fundingOpen} onOpenChange={setFundingOpen} />
  </>)
}
