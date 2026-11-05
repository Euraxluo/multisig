import { bcs } from "@mysten/sui/bcs"
import { Transaction } from "@mysten/sui/transactions"
import { normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils"
import { proposalClient, PROPOSAL_PACKAGE_ID, PROPOSAL_TYPE_ORIGIN } from "./proposal-chain"
import type { SuiClientTypes } from "@mysten/sui/client"
import type { GovernanceVote } from "./governance"
import { t } from "./i18n/t"

// New modules get their own type origin on upgrade. Resolve it from the active
// package, never assume the original Organization/Proposal type origin.
export const POLL_PACKAGE_ID = process.env.NEXT_PUBLIC_GOVERNANCE_PACKAGE_ID || PROPOSAL_PACKAGE_ID
export const POLL_LINKS_KEY = "sui_governance_poll_links"
const LIMITS = { voters: 128, options: 16, weight: 1_000_000_000, duration: 365 * 86400_000 } as const
const signal = () => AbortSignal.timeout(20_000)
export const PollContent = bcs.struct("Poll", {
  id: bcs.Address, creator: bcs.Address, title: bcs.string(), description: bcs.string(),
  options: bcs.vector(bcs.string()), mode: bcs.u8(), electorate: bcs.vector(bcs.Address), weights: bcs.vector(bcs.u64()),
  ballots: bcs.vector(bcs.vector(bcs.u64())), cast_at_ms: bcs.vector(bcs.u64()), deadline_ms: bcs.u64(),
  org_id: bcs.option(bcs.Address), org_epoch: bcs.u64(), group_voter_count: bcs.u64(),
  show_results_during: bcs.bool(), allow_link_access: bcs.bool(),
})
export type PollSnapshot = ReturnType<typeof PollContent.parse>
export interface PollDraft {
  title: string; description?: string; voteType: string; options: { id: string; text: string }[]
  voters: { address?: string; weight?: number }[]; expiresAt?: string; voterSource?: string; weightType?: string
  isAnonymous?: boolean; isTimeLockedSeal?: boolean; createTransaction?: boolean; showResultsDuring?: boolean; allowLinkAccess?: boolean
  orgId?: string; groupMembers?: Record<string, number>
}
export interface PollPublication {
  title: string; description: string; mode: number; options: string[]; electorate: string[]; weights: number[]
  deadlineMs: number; showResultsDuring: boolean; allowLinkAccess: boolean
  orgId?: string; groupVoters: string[]; manualVoters: string[]; manualWeights: number[]
}
const utf8Length = (text: string) => new TextEncoder().encode(text).length
function address(value: string): string {
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(value) || BigInt(value) === 0n) throw new Error(t("voting.errNonZeroAddress"))
  return normalizeSuiAddress(value)
}

/** Validate the exact policy sent on chain; never silently downgrade settings. */
export function preparePollPublication(draft: PollDraft, now = Date.now()): PollPublication {
  if (draft.weightType && draft.weightType !== "manual") throw new Error(t("voting.errWeightSourceNotSupported"))
  if (draft.isAnonymous || draft.isTimeLockedSeal) throw new Error(t("voting.errPrivacyNotSupported"))
  if (draft.createTransaction) throw new Error(t("voting.errExecTemplateNotBound"))
  const mode = ["single", "multiple", "ranked"].indexOf(draft.voteType)
  if (mode < 0) throw new Error(t("voting.errVoteTypeInvalid"))
  const title = draft.title.trim(), description = draft.description?.trim() || ""
  if (!title || utf8Length(title) > 256 || utf8Length(description) > 4096) throw new Error(t("voting.errTitleLength"))
  const options = draft.options.map(option => option.text.trim())
  if (options.length < 2 || options.length > LIMITS.options || options.some(text => !text || utf8Length(text) > 256) || new Set(options).size !== options.length) throw new Error(t("voting.errOptionsInvalid"))
  if (!draft.voters.length || draft.voters.length > LIMITS.voters) throw new Error(t("voting.errVoterCount"))
  const electorate = draft.voters.map(voter => address(voter.address || ""))
  if (new Set(electorate).size !== electorate.length) throw new Error(t("voting.errVoterDuplicate"))
  const deadlineMs = Date.parse(draft.expiresAt || "")
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= now || deadlineMs - now > LIMITS.duration) throw new Error(t("voting.errDeadlineInvalid"))
  const source = draft.voterSource || "manual"
  if (!["manual", "group", "hybrid"].includes(source)) throw new Error(t("voting.errVoterSourceInvalid"))
  const grouped = source !== "manual"
  const orgId = grouped ? address(draft.orgId || "") : undefined
  if (grouped && !draft.groupMembers) throw new Error(t("voting.errRosterNotRead"))
  const groupVoters: string[] = [], manualVoters: string[] = [], manualWeights: number[] = []
  const weights = electorate.map((voter, index) => {
    const groupWeight = grouped ? draft.groupMembers?.[voter] : undefined
    if (groupWeight) { groupVoters.push(voter); return groupWeight }
    if (source === "group") throw new Error(t("voting.errVoterNotInRoster"))
    const weight = draft.voters[index].weight
    manualVoters.push(voter); manualWeights.push(weight ?? 0)
    return weight ?? 0
  })
  if (grouped && !groupVoters.length) throw new Error(t("voting.errGroupNeedsMember"))
  if (weights.some(weight => !Number.isSafeInteger(weight) || weight < 1 || weight > LIMITS.weight)) throw new Error(t("voting.errWeightRange"))
  // Group ballots are stored first in the contract, then explicit manual additions.
  return { title, description, mode, options, electorate, weights, deadlineMs, showResultsDuring: !!draft.showResultsDuring,
    allowLinkAccess: draft.allowLinkAccess !== false, orgId, groupVoters, manualVoters, manualWeights }
}

export function buildPublishPoll(publication: PollPublication, packageId = POLL_PACKAGE_ID): Transaction {
  const tx = new Transaction()
  const textArgs = [tx.pure.string(publication.title), tx.pure.string(publication.description), tx.pure.vector("string", publication.options), tx.pure.u8(publication.mode)]
  const tail = [tx.pure.u64(publication.deadlineMs), tx.pure.bool(publication.showResultsDuring), tx.pure.bool(publication.allowLinkAccess), tx.object("0x6")]
  const poll = publication.orgId ? tx.moveCall({ target: `${packageId}::governance_poll::new_group`, arguments: [tx.object(publication.orgId), ...textArgs,
    tx.pure.vector("address", publication.groupVoters), tx.pure.vector("address", publication.manualVoters), tx.pure.vector("u64", publication.manualWeights), ...tail] })
    : tx.moveCall({ target: `${packageId}::governance_poll::new_manual`, arguments: [...textArgs, tx.pure.vector("address", publication.electorate), tx.pure.vector("u64", publication.weights), ...tail] })
  tx.moveCall({ target: `${packageId}::governance_poll::share`, arguments: [poll] })
  return tx
}

export function validatePollBallot(poll: PollSnapshot, voter: string, choices: number[], now = Date.now()): number {
  if (now >= Number(poll.deadline_ms)) throw new Error(t("voting.errVoteClosed"))
  const index = poll.electorate.indexOf(address(voter))
  if (index < 0) throw new Error(t("voting.errNotInRoster"))
  if (poll.ballots[index].length) throw new Error(t("voting.errAlreadyVoted"))
  if (!choices.length || choices.length > poll.options.length || choices.some(choice => !Number.isInteger(choice) || choice < 0 || choice >= poll.options.length) || new Set(choices).size !== choices.length || (poll.mode === 0 && choices.length !== 1) || (poll.mode === 2 && choices.length !== poll.options.length)) throw new Error(t("voting.errBallotInvalid"))
  return index
}
export function buildCastPollBallot(pollId: string, choices: number[], packageId = POLL_PACKAGE_ID): Transaction {
  const tx = new Transaction()
  tx.moveCall({ target: `${packageId}::governance_poll::cast_ballot`, arguments: [tx.object(address(pollId)), tx.pure.vector("u64", choices), tx.object("0x6")] })
  return tx
}
export function pollScores(poll: PollSnapshot): number[] {
  const scores = poll.options.map(() => 0)
  poll.ballots.forEach((ballot, voter) => ballot.forEach((choice, rank) => {
    scores[Number(choice)] += Number(poll.weights[voter]) * (poll.mode === 2 ? poll.options.length - 1 - rank : 1)
  }))
  return scores
}

export function pollVoteView(poll: PollSnapshot, voter = "", now = Date.now()): GovernanceVote {
  const scores = pollScores(poll), sum = scores.reduce((total, value) => total + value, 0)
  const index = voter ? poll.electorate.indexOf(address(voter)) : -1
  const completed = now >= Number(poll.deadline_ms)
  const winners = completed && scores.some(score => score > 0) ? scores.flatMap((score, option) => score === Math.max(...scores) ? [poll.options[option]] : []) : []
  return {
    id: poll.id, onChainId: poll.id, kind: "governance", source: "shared-poll", title: poll.title, description: poll.description,
    status: completed ? "completed" : "active", color: "from-primary to-purple-500", voteType: ["single", "multiple", "ranked"][poll.mode],
    group: poll.org_id ? t("voting.sharedPollGroupLabel", { id: `${poll.org_id.slice(0, 8)}…` }) : t("voting.manualVotersLabel"), orgId: poll.org_id || undefined, chainEpoch: poll.org_epoch,
    creator: { name: `${poll.creator.slice(0, 6)}…${poll.creator.slice(-4)}`, address: poll.creator }, weightType: "manual",
    voterSource: poll.org_id ? Number(poll.group_voter_count) < poll.electorate.length ? "hybrid" : "group" : "manual",
    options: poll.options.map((text, option) => ({ id: `option-${option}`, text, votes: scores[option], percentage: sum ? Math.round(scores[option] / sum * 100) : 0 })),
    voters: poll.electorate.map((who, i) => ({ id: who, address: who, name: who === voter ? t("voting.meCurrentWallet") : `${who.slice(0, 6)}…${who.slice(-4)}`,
      weight: Number(poll.weights[i]), voted: !!poll.ballots[i].length, timestamp: poll.ballots[i].length ? new Date(Number(poll.cast_at_ms[i])).toISOString() : undefined,
      votedFor: poll.ballots[i].map(choice => `option-${choice}`).join(",") })),
    totalVotes: poll.ballots.filter(ballot => ballot.length).length,
    weights: { total: poll.weights.reduce((total, weight) => total + Number(weight), 0), voted: poll.weights.reduce((total, weight, i) => total + (poll.ballots[i].length ? Number(weight) : 0), 0), required: null },
    hasVoted: index >= 0 && !!poll.ballots[index].length, myVoteOptionIds: index < 0 ? [] : poll.ballots[index].map(choice => `option-${choice}`),
    showResultsDuring: poll.show_results_during, allowLinkAccess: poll.allow_link_access, isAnonymous: false, isTimeLockedSeal: false,
    expiresAt: new Date(Number(poll.deadline_ms)).toISOString(), deadlineMs: Number(poll.deadline_ms), chainSyncedAt: new Date(now).toISOString(),
    result: completed ? winners.length ? t(winners.length > 1 ? "voting.resultTied" : "voting.resultLeading", { names: winners.join(t("voting.resultSeparator")) }) : t("voting.resultNoVotes") : undefined,
  }
}

const SUI = normalizeSuiAddress("0x2"), STD = normalizeSuiAddress("0x1")
export const POLL_FIELDS = ["id", "creator", "title", "description", "options", "mode", "electorate", "weights", "ballots", "cast_at_ms", "deadline_ms", "org_id", "org_epoch", "group_voter_count", "show_results_during", "allow_link_access"]
export const POLL_FIELD_TYPES = [`${SUI}::object::UID`, "address", `${STD}::string::String`, `${STD}::string::String`, `vector<${STD}::string::String>`, "u8", "vector<address>", "vector<u64>", "vector<vector<u64>>", "vector<u64>", "u64", `${STD}::option::Option<${SUI}::object::ID>`, "u64", "u64", "bool", "bool"]
function signatureBody(body: SuiClientTypes.OpenSignatureBody): string {
  if (body.$kind === "vector") return `vector<${signatureBody(body.vector)}>`
  if (body.$kind === "datatype") return normalizeStructTag(body.datatype.typeName) + (body.datatype.typeParameters.length ? `<${body.datatype.typeParameters.map(signatureBody).join(",")}>` : "")
  if (body.$kind === "typeParameter") return `T${body.index}`
  return body.$kind
}
type PollRpc = Pick<typeof proposalClient, "getObject" | "getMoveFunction" | "movePackageService">
export function createPollReader(client: PollRpc, packageId = POLL_PACKAGE_ID) {
  let typePromise: Promise<string> | undefined
  function pollType(): Promise<string> {
    if (!typePromise) typePromise = Promise.resolve(client.movePackageService.getDatatype({ packageId, moduleName: "governance_poll", name: "Poll" }, { abort: signal() })).then(({ response }) => {
      const datatype = response.datatype, type = datatype?.typeName
      if (!type || !datatype?.definingId) throw new Error(t("voting.errModuleNotDeployed"))
      const origin = address(datatype.definingId)
      const canonical = `${origin}::governance_poll::Poll`
      const storageLabel = `${address(packageId)}::governance_poll::Poll`
      if (datatype.module !== "governance_poll" || datatype.name !== "Poll" || ![canonical, storageLabel].includes(normalizeStructTag(type))) throw new Error(t("voting.errPollTypeIncompatible"))
      // Raw protobuf signatures use their numeric enum, unlike getMoveFunction.
      const rawBody = (body: NonNullable<NonNullable<typeof datatype>["fields"][number]["type"]>): string => {
        if (body.type === 9) return `vector<${body.typeParameterInstantiation.map(rawBody).join(",")}>`
        if (body.type === 10 && body.typeName) return normalizeStructTag(body.typeName) + (body.typeParameterInstantiation.length ? `<${body.typeParameterInstantiation.map(rawBody).join(",")}>` : "")
        return ({ 1: "address", 2: "bool", 3: "u8", 6: "u64" } as Record<number, string>)[body.type || 0] || "unknown"
      }
      if (datatype.kind !== 1 || JSON.stringify(datatype.abilities) !== "[4]" || datatype.typeParameters.length || datatype.variants.length || datatype.fields.some((field, index) => field.position !== index) || JSON.stringify(datatype.fields.map(field => field.name)) !== JSON.stringify(POLL_FIELDS) || JSON.stringify(datatype.fields.map(field => field.type ? rawBody(field.type) : "unknown")) !== JSON.stringify(POLL_FIELD_TYPES)) throw new Error(t("voting.errPollLayoutIncompatible"))
      return canonical
    }).catch(error => { typePromise = undefined; throw error })
    return typePromise
  }
  async function assertAvailable(grouped: boolean): Promise<void> {
    const poll = await pollType(), ctx = `&mut ${SUI}::tx_context::TxContext`, clock = `&${SUI}::clock::Clock`
    const text = [`${STD}::string::String`, `${STD}::string::String`, `vector<${STD}::string::String>`, "u8"]
    const tail = ["u64", "bool", "bool", clock, ctx]
    const contracts: [string, string[], string[]][] = [[grouped ? "new_group" : "new_manual",
      grouped ? [`&${PROPOSAL_TYPE_ORIGIN}::cryptographic_org::Organization`, ...text, "vector<address>", "vector<address>", "vector<u64>", ...tail] : [...text, "vector<address>", "vector<u64>", ...tail], [poll]],
      ["share", [poll], []], ["cast_ballot", [`&mut ${poll}`, "vector<u64>", clock, `&${SUI}::tx_context::TxContext`], []]]
    await Promise.all(contracts.map(async ([name, parameters, returns]) => {
      const { function: fn } = await client.getMoveFunction({ packageId, moduleName: "governance_poll", name, signal: signal() })
      const signature = (value: SuiClientTypes.OpenSignature) => `${value.reference === "mutable" ? "&mut " : value.reference === "immutable" ? "&" : ""}${signatureBody(value.body)}`
      if (fn.visibility !== "public" || fn.typeParameters.length || JSON.stringify(fn.parameters.map(signature)) !== JSON.stringify(parameters) || JSON.stringify(fn.returns.map(signature)) !== JSON.stringify(returns)) throw new Error(t("voting.errEntryIncompatible", { name }))
    }))
  }
  async function readPoll(id: string): Promise<PollSnapshot> {
    const expected = await pollType()
    const { object } = await client.getObject({ objectId: address(id), include: { content: true }, signal: signal() })
    if (normalizeSuiAddress(object.objectId) !== address(id) || normalizeStructTag(object.type) !== expected || object.owner.$kind !== "Shared") throw new Error(t("voting.errNotSharedPollObject"))
    const poll = PollContent.parse(object.content)
    if (poll.id !== address(id) || poll.mode > 2 || poll.options.length < 2 || poll.options.length > LIMITS.options || poll.electorate.length < 1 || poll.electorate.length > LIMITS.voters || [poll.weights.length, poll.ballots.length, poll.cast_at_ms.length].some(length => length !== poll.electorate.length) || new Set(poll.electorate).size !== poll.electorate.length || poll.weights.some(weight => Number(weight) < 1 || Number(weight) > LIMITS.weight) || !Number.isSafeInteger(Number(poll.deadline_ms))) throw new Error(t("voting.errPollBoundsInvalid"))
    for (const ballot of poll.ballots) {
      if (ballot.length && (ballot.length > poll.options.length || new Set(ballot).size !== ballot.length || ballot.some(choice => BigInt(choice) >= BigInt(poll.options.length)) || (poll.mode === 0 && ballot.length !== 1) || (poll.mode === 2 && ballot.length !== poll.options.length))) throw new Error(t("voting.errOnChainBallotInvalid"))
    }
    return poll
  }
  return { readPoll, assertAvailable, pollType }
}
export const pollReader = createPollReader(proposalClient)

/** Local discovery hints only. Every displayed count is fetched from the object. */
export function pollLinks(): string[] {
  let rows: unknown
  try { rows = JSON.parse(localStorage.getItem(POLL_LINKS_KEY) || "[]") } catch { return [] }
  return Array.isArray(rows) ? [...new Set(rows.filter((id): id is string => typeof id === "string" && /^0x[0-9a-fA-F]{1,64}$/.test(id)).map(id => normalizeSuiAddress(id)))] : []
}
export function rememberPoll(id: string): void {
  const raw = localStorage.getItem(POLL_LINKS_KEY)
  if (raw && !Array.isArray(JSON.parse(raw))) throw new Error(t("voting.errLinksStoreInvalid"))
  const links = pollLinks()
  const normalized = address(id)
  if (links.includes(normalized)) return
  localStorage.setItem(POLL_LINKS_KEY, JSON.stringify([normalized, ...links]))
  window.dispatchEvent(new CustomEvent("sui-votes-updated"))
}
