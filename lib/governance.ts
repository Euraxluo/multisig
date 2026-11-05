// Browser governance records are configuration/history, never proof of a chain vote.
import { t } from "./i18n/t"

export const GOVERNANCE_KEYS = { votes: "sui_governance_votes", drafts: "sui_governance_vote_drafts", records: "sui_vote_records" } as const

export interface GovernanceOption { id: string; text: string; votes: number | null; percentage: number | null }
export interface GovernanceVoter { id: string; address?: string; name: string; weight?: number; voted: boolean; timestamp?: string; votedFor?: string }
export interface LegacyVoteRecord { optionIds: string[]; digest?: string; at?: string; address: string }
export interface ShadowPolicy {
  enabled: boolean; leaderAddress: string; subagentCapId: string; dailyQuota: number; usedToday: number
  maxAmountPerTx: number; strategyMode: "FOLLOW_LEADER" | "AI_SENTINEL" | "ALWAYS_APPROVE"; minAiScore: number
  lastSyncAt?: string; executedDigest?: string
}
export const emptyShadowPolicy: ShadowPolicy = { enabled: false, leaderAddress: "", subagentCapId: "", dailyQuota: 5, usedToday: 0, maxAmountPerTx: 100, strategyMode: "FOLLOW_LEADER", minAiScore: 75 }
/**
 * A vote row as the dialogs render it.
 *
 * This is the union of three producers — a local draft, a legacy local record,
 * and a chain snapshot — plus the optional configuration fields a draft carries
 * before it is published. Every field is optional except the ones every
 * producer sets, so a reader can tell "this producer does not fill that in"
 * from "this voter has no weight" without a cast.
 *
 * The index signature stays `unknown`: older builds wrote rows with fields this
 * interface does not name, and those rows must still load. `unknown` forces a
 * caller to narrow before using such a field, which is the point — a legacy row
 * is untrusted JSON, not a shape the compiler can vouch for.
 */
export interface GovernanceVote {
  id: string; title: string; description: string; status: "draft" | "active" | "completed" | "approved"
  kind: "draft" | "governance" | "proposal"; color: string; voteType: string; group: string
  options: GovernanceOption[]; voters: GovernanceVoter[]; totalVotes: number | null
  weights: { total: number | null; voted: number | null; required: number | null }
  hasVoted: boolean; myVoteOptionIds: string[]; record?: LegacyVoteRecord
  creator?: { name: string; address?: string }
  /** Which store produced this row: a chain poll, a funds proposal, or local notes. */
  source?: string
  onChainId?: string
  orgId?: string
  /** Organization epoch the snapshot was read at; only chain producers set it. */
  chainEpoch?: string
  chainSyncedAt?: string
  /** The outcome label, and only present once a chain read confirmed it. */
  result?: string
  amountLabel?: string
  amountMist?: string
  recipient?: string
  expiresAt?: string
  deadlineMs?: number
  /** Total voter weight; distinct from `weights`, which counts cast weight. */
  weightType?: string
  weightCalculation?: string
  voterSource?: string
  tokenSymbol?: string
  tokenAddress?: string
  snapshotBlock?: string
  specificBlock?: string
  targetNftType?: string
  isAnonymous?: boolean
  isTimeLockedSeal?: boolean
  showResultsDuring?: boolean
  allowLinkAccess?: boolean
  createTransaction?: boolean
  selectedTransaction?: string
  selectedGroup?: string
  groupId?: string
  creatorAddress?: string
  createdAt?: string
  /** Set by `proposalVoteView` so the dialog can highlight the current voter. */
  myAddress?: string
  [key: string]: unknown
}
const finite = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)
/** A stored string, or `fallback` when the field is absent or not a string. */
const text = (value: unknown, fallback = ""): string => typeof value === "string" && value ? value : fallback
export const shortAddress = (value?: string) => !value ? t("voting.notSynced") : value.length < 14 ? value : `${value.slice(0, 6)}…${value.slice(-4)}`
/**
 * Reads a JSON value from localStorage.
 *
 * Returns `unknown`: the value was written by an older build following a shape
 * this one does not own, so a caller must narrow before using it. The fallback
 * is returned only when the key is absent or holds `null`, not when it fails to
 * parse — a corrupt value is thrown away here, but a caller that needs to
 * surface corruption reads the raw string instead.
 */
export function readGovernanceValue(key: string, fallback: unknown = null): unknown {
  try { return JSON.parse(localStorage.getItem(key) || "null") ?? fallback } catch { return fallback }
}
export function readLegacyVoteRecords(): Record<string, LegacyVoteRecord> {
  const raw = readGovernanceValue(GOVERNANCE_KEYS.records, {})
  if (!object(raw)) return {}
  return Object.fromEntries(Object.entries(raw).filter(([, value]) => object(value) && typeof value.address === "string" && Array.isArray(value.optionIds)).map(([id, value]) => {
    const record = value as Record<string, unknown>
    return [id, {
      address: record.address as string,
      optionIds: (record.optionIds as unknown[]).filter((option): option is string => typeof option === "string"),
      digest: typeof record.digest === "string" ? record.digest : undefined,
      at: typeof record.at === "string" ? record.at : undefined,
    }]
  }))
}
export function normalizeGovernanceVote(raw: unknown, draft: boolean, record?: LegacyVoteRecord, address = ""): GovernanceVote | null {
  if (!object(raw) || typeof raw.id !== "string" || !raw.id) return null
  const isDraft = draft || raw.status === "draft" || raw.source === "local-draft"
  const options: GovernanceOption[] = Array.isArray(raw.options) ? raw.options.filter(object).map((option, index) => {
    const percentage = finite(option.percentage)
    return {
      ...option, id: typeof option.id === "string" ? option.id : `option-${index + 1}`, text: typeof option.text === "string" ? option.text : t("voting.unnamedOption"),
      votes: isDraft ? null : finite(option.votes), percentage: isDraft ? null : percentage == null ? null : Math.min(100, percentage),
    }
  }) : []
  const voters: GovernanceVoter[] = Array.isArray(raw.voters) ? raw.voters.filter(object).map((voter, index) => {
    const voterAddress = typeof voter.address === "string" ? voter.address : undefined
    return {
      ...voter, id: typeof voter.id === "string" || typeof voter.id === "number" ? String(voter.id) : String(voterAddress ?? index),
      address: voterAddress, name: typeof voter.name === "string" && voter.name ? voter.name : shortAddress(voterAddress),
      weight: finite(voter.weight) ?? undefined, voted: !isDraft && voter.voted === true,
    }
  }) : []
  const weights = object(raw.weights) ? raw.weights : {}
  // Receipts remain visible with their original owner, never counted as verified ballots.
  const savedRecord = record
  return {
    ...raw, id: raw.id, title: text(raw.title, t("voting.unnamedVote")), description: text(raw.description),
    kind: isDraft ? "draft" : "governance", status: isDraft ? "draft" : typeof raw.status === "string" && ["completed", "executed", "rejected"].includes(raw.status) ? "completed" : "active",
    color: text(raw.color, "from-primary to-purple-500"), voteType: text(raw.voteType, "single"), group: text(raw.group, t("voting.noGroupSelected")),
    creator: object(raw.creator)
      ? { name: text(raw.creator.name, t("voting.localUser")), address: typeof raw.creator.address === "string" ? raw.creator.address : undefined }
      : { name: text(raw.creator, t("voting.localUser")), address: typeof raw.creatorAddress === "string" ? raw.creatorAddress : undefined },
    options, voters, totalVotes: isDraft ? null : finite(raw.totalVotes),
    weights: { total: finite(weights.total), voted: finite(weights.voted), required: finite(weights.required) },
    // Old local receipts are shown separately, never used to mark a verified vote.
    record: savedRecord, hasVoted: false, myVoteOptionIds: [], myAddress: address,
  }
}
export function getGovernanceVotes(address = ""): GovernanceVote[] {
  const records = readLegacyVoteRecords()
  const result = new Map<string, GovernanceVote>()
  for (const [key, draft] of [[GOVERNANCE_KEYS.votes, false], [GOVERNANCE_KEYS.drafts, true]] as const) {
    const rows = readGovernanceValue(key, [])
    if (!Array.isArray(rows)) continue
    for (const row of rows) {
      const vote = normalizeGovernanceVote(row, draft, records[row?.id], address)
      if (vote) result.set(vote.id, vote)
    }
  }
  return [...result.values()]
}
export function saveGovernanceDraft(draft: Record<string, unknown>): void {
  const rows = JSON.parse(localStorage.getItem(GOVERNANCE_KEYS.drafts) || "[]")
  if (!Array.isArray(rows)) throw new Error(t("voting.errDraftStoreInvalid"))
  const value = { ...draft, id: String(draft.id), status: "draft", source: "local-draft", updatedAt: new Date().toISOString() }
  localStorage.setItem(GOVERNANCE_KEYS.drafts, JSON.stringify([value, ...rows.filter(row => row?.id !== value.id)]))
  window.dispatchEvent(new CustomEvent("sui-votes-updated"))
}
export function readShadowPolicy(voteId: string): ShadowPolicy {
  const value = readGovernanceValue(`sui_shadow_vote_policy_${voteId}`, {})
  return object(value) ? { ...emptyShadowPolicy, ...value } : { ...emptyShadowPolicy }
}
export function saveShadowPolicy(voteId: string, policy: ShadowPolicy): void {
  localStorage.setItem(`sui_shadow_vote_policy_${voteId}`, JSON.stringify(policy))
}
export function governanceVoteUrl(base: string, voteId: string): string {
  const url = new URL(base)
  url.search = ""
  url.hash = ""
  url.searchParams.set("vote", voteId)
  return url.toString()
}

/**
 * The fields `proposalVoteView` reads from a proposal row.
 *
 * Kept as an explicit interface rather than `ProposalItem & …` so this module
 * stays independent of the store, and so a chain snapshot (which has no local
 * record) can be passed directly. No index signature: a caller passing a richer
 * row must satisfy these fields structurally, which `ProposalItem` does.
 */
export interface ProposalVoteSource {
  id: string; onChainId?: string; orgId: string; title: string; description: string; groupName: string
  approvals: number; requiredApprovals: number; status: string; voters: string[]; voteWeights?: Record<string, number>
  memberWeights?: Record<string, number>; rejectingVoters?: string[]; rejectedWeight?: number; chainSyncedAt?: string
  chainEpoch?: string; organizationEpoch?: string; rejectionSupported?: boolean
  proposer?: string; amount?: number; amountMist?: string; token?: string; recipient?: string
  deadlineMs?: number; expiresAt?: string; amountLabel?: string; color?: string
}
export function proposalVoteView(proposal: ProposalVoteSource, address = ""): GovernanceVote {
  const synced = !!proposal.chainSyncedAt
  const rejecting = proposal.rejectingVoters || []
  const voteWeights = proposal.voteWeights || {}
  const memberWeights = proposal.memberWeights || {}
  const addresses = [...new Set([...Object.keys(memberWeights), ...Object.keys(voteWeights), ...proposal.voters, ...rejecting])]
  const voted = (who: string) => synced && (Object.hasOwn(voteWeights, who) || proposal.voters.includes(who) || rejecting.includes(who))
  const myAddress = addresses.find(who => address && who.toLowerCase() === address.toLowerCase())
  const hasVoted = !!myAddress && voted(myAddress)
  const approved = synced ? finite(proposal.approvals) : null
  const rejected = synced && proposal.rejectionSupported ? finite(proposal.rejectedWeight) : null
  const cast = approved == null ? null : approved + (rejected || 0)
  const total = synced && Object.keys(memberWeights).length ? Object.values(memberWeights).reduce((sum, weight) => sum + weight, 0) : null
  return {
    ...proposal, kind: "proposal", title: proposal.title, description: proposal.description, voteType: "approve", group: proposal.groupName,
    color: proposal.color || "from-primary to-purple-500", creator: { name: shortAddress(proposal.proposer), address: proposal.proposer },
    status: ["executed", "rejected"].includes(proposal.status) || (proposal.deadlineMs && proposal.deadlineMs < Date.now()) ? "completed" : proposal.status === "approved" ? "approved" : "active",
    options: [
      { id: "option-approve", text: t("voting.approveProposal"), votes: approved, percentage: cast && approved != null ? Math.round(approved / cast * 100) : null },
      { id: "option-reject", text: t("voting.rejectProposal"), votes: rejected, percentage: cast && rejected != null ? Math.round(rejected / cast * 100) : null },
    ],
    voters: addresses.map(who => ({ id: who, address: who, name: who === myAddress ? t("voting.meCurrentWallet") : shortAddress(who), voted: voted(who), weight: memberWeights[who] ?? voteWeights[who], votedFor: voted(who) ? rejecting.includes(who) ? "option-reject" : "option-approve" : undefined })),
    weights: { total, voted: cast, required: synced ? proposal.requiredApprovals : null },
    totalVotes: synced ? addresses.filter(voted).length : null, hasVoted, myAddress: address,
    myVoteOptionIds: hasVoted ? [rejecting.includes(myAddress!) ? "option-reject" : "option-approve"] : [],
    showResultsDuring: true, isAnonymous: false, amountLabel: proposal.amountLabel || (typeof proposal.amount === "number" && Number.isFinite(proposal.amount) ? `${proposal.amount} ${proposal.token || "SUI"}` : t("voting.unknownAmount")),
    // Every other chain figure above is gated on `synced`. The outcome label is
    // the claim the user actually reads, so it is gated the same way: an
    // unsynced row must not assert that an execution happened.
    result: !synced ? undefined : proposal.status === "executed" ? t("voting.executed") : proposal.status === "rejected" ? t("voting.rejected") : undefined,
  }
}
export function governancePublicationGaps(): string[] {
  return [t("voting.gap1"), t("voting.gap2"), t("voting.gap3")]
}
