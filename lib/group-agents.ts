// Group-scoped AI delegation read from chain.
//
// There is no on-chain link between an organization and an AgentVault, so this
// module never presents a vault or an AgentCap as a "group AI assistant". The
// only verifiable group-scoped delegation is a `SubagentCoSignCap` issued by a
// current organization member: `submit_async_vote_by_subagent` checks that the
// cap belongs to that member's live roster weight. Each cap is re-read from its
// object, and issuance events are only used to discover candidate cap IDs.
import { bcs } from "@mysten/sui/bcs"
import type { SuiClientTypes } from "@mysten/sui/client"
import { SuiGrpcClient } from "@mysten/sui/grpc"
import { normalizeSuiAddress, normalizeStructTag } from "@mysten/sui/utils"
import { OrganizationContent, PROPOSAL_TYPE_ORIGIN, proposalClient, readWeightTable } from "./proposal-chain"
import { t } from "@/lib/i18n/t"

const signal = () => AbortSignal.timeout(20_000)
const id = (value: string) => {
  if (typeof value !== "string" || !/^0x[\da-fA-F]{1,64}$/.test(value) || BigInt(value) === 0n) throw new Error(t("agents.ga.idRequired"))
  return normalizeSuiAddress(value)
}

export const subagentCapBcs = bcs.struct("SubagentCoSignCap", {
  id: bcs.Address, master_owner: bcs.Address, issued_epoch: bcs.u64(), agent_address: bcs.Address, voter_weight: bcs.u64(),
  max_budget_per_tx: bcs.u64(), daily_budget_limit: bcs.u64(), spent_today: bcs.u64(),
  expires_at_ms: bcs.u64(), is_revoked: bcs.bool(),
})
export const subagentCapIssuedBcs = bcs.struct("SubagentCapIssuedEvent", {
  cap_id: bcs.Address, master_owner: bcs.Address, agent_address: bcs.Address,
  voter_weight: bcs.u64(), max_budget_per_tx: bcs.u64(), expires_at_ms: bcs.u64(),
})

export type GroupAgentStatus = "ACTIVE" | "EXHAUSTED" | "EXPIRED" | "REVOKED" | "STALE" | "UNVERIFIED"

export interface GroupAgentDelegation {
  capId: string
  /** Member who issued the delegation; the vote is recorded under this address. */
  masterOwner: string
  agentAddress: string
  /** Weight the cap was issued with. In-epoch it must equal the live roster weight; cross-epoch the contract accepts the smaller of the two. */
  voterWeight: bigint
  /** Live roster weight of the issuing member. Non-members' caps are not group-scoped and are omitted. */
  rosterWeight: bigint
  maxBudgetPerTx: bigint
  dailyBudgetLimit: bigint
  /** `spent_today` is never reset by the contract: it is the cumulative co-signed amount. */
  spent: bigint
  expiresAtMs: bigint
  revoked: boolean
  /**
   * `shared` when the cap was issued with `create_shared_subagent_cap`; `address`
   * when it is owned (only that owner may pass it as `&mut`). Anything else is
   * `other` and unusable.
   */
  custody: "shared" | "address" | "other"
  /** Address owner, when the cap is owned by an address. */
  capOwner: string | null
  status: GroupAgentStatus
  reason: string
}

export interface GroupAgentList {
  orgId: string
  /** Live roster read from the organization's members_weight table. */
  roster: Array<{ address: string; weight: bigint }>
  delegations: GroupAgentDelegation[]
  errors: string[]
  truncated: boolean
}

export type GroupAgentClient = Pick<SuiGrpcClient, "getObject" | "listEvents">

const MAX_PAGES = 4
const PAGE_SIZE = 50

/**
 * `readWeights` is injected so the same reader can run against the real gRPC
 * client and against a fixture in tests. The issuance event supplies candidate
 * IDs; every displayed value comes from the cap object and the live roster.
 */
export function createGroupAgentReader(
  client: GroupAgentClient,
  readWeights: (tableId: string) => Promise<Record<string, number>> = readWeightTable,
  now: () => number = Date.now,
) {
  function statusOf(cap: ReturnType<typeof subagentCapBcs.parse>, rosterWeight: bigint, custody: GroupAgentDelegation["custody"], capOwner: string | null): { status: GroupAgentStatus; reason: string } {
    if (cap.is_revoked) return { status: "REVOKED", reason: t("agents.ga.reasonRevoked") }
    if (BigInt(cap.expires_at_ms) < BigInt(now())) return { status: "EXPIRED", reason: t("agents.ga.reasonExpired") }
    if (BigInt(cap.voter_weight) !== rosterWeight) return { status: "STALE", reason: t("agents.ga.reasonWeightMismatch", { capWeight: cap.voter_weight, rosterWeight }) }
    if (BigInt(cap.spent_today) >= BigInt(cap.daily_budget_limit)) return { status: "EXHAUSTED", reason: t("agents.ga.reasonExhausted") }
    // A shared cap can be passed by the agent. An owned cap must be owned by the
    // agent address; the contract checks the signer, so another owner cannot sign.
    if (custody === "address" && capOwner !== normalizeSuiAddress(cap.agent_address)) return { status: "STALE", reason: t("agents.ga.reasonCustody") }
    if (custody === "other") return { status: "STALE", reason: t("agents.ga.reasonOtherCustody") }
    return { status: "ACTIVE", reason: t("agents.ga.reasonActive") }
  }

  async function readOrganization(orgId: string) {
    const org = id(orgId)
    const { object } = await client.getObject({ objectId: org, include: { content: true }, signal: signal() })
    if (normalizeSuiAddress(object.objectId) !== org || normalizeStructTag(object.type) !== `${PROPOSAL_TYPE_ORIGIN}::cryptographic_org::Organization` || object.owner.$kind !== "Shared") {
      throw new Error(t("agents.ga.notSharedOrg"))
    }
    const content = OrganizationContent.parse(object.content)
    if (content.id !== org || BigInt(content.threshold_weight) <= 0n) throw new Error(t("agents.ga.orgInvalid"))
    id(content.members_weight.id)
    return content
  }

  async function readRoster(orgId: string): Promise<{ org: ReturnType<typeof OrganizationContent.parse>; weights: Map<string, bigint> }> {
    const org = await readOrganization(orgId)
    const weights = await readWeights(org.members_weight.id)
    return { org, weights: new Map(Object.entries(weights).map(([address, weight]) => [normalizeSuiAddress(address), BigInt(weight)])) }
  }

  async function listDelegations(orgId: string): Promise<GroupAgentList> {
    const { org, weights: roster } = await readRoster(orgId)
    const eventType = normalizeStructTag(`${PROPOSAL_TYPE_ORIGIN}::asynchronous_proposal::SubagentCapIssuedEvent`)
    const capType = normalizeStructTag(`${PROPOSAL_TYPE_ORIGIN}::asynchronous_proposal::SubagentCoSignCap`)
    const errors: string[] = [], seen = new Set<string>(), cursors = new Set<string>()
    const issued: Array<{ capId: string; masterOwner: string; agentAddress: string }> = []
    let before: string | null = null, truncated = false
    for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex++) {
      const page: SuiClientTypes.ListEventsResponse = await client.listEvents({ filter: { eventType }, before, order: "descending", limit: PAGE_SIZE, signal: signal() })
      for (const event of page.events) {
        if (normalizeStructTag(event.eventType) !== eventType) continue
        const issuedEvent = subagentCapIssuedBcs.parse(event.bcs)
        const capId = normalizeSuiAddress(issuedEvent.cap_id)
        if (seen.has(capId)) continue
        seen.add(capId)
        // Only a current member's delegation is group-scoped. Anyone can issue a
        // cap, so the roster check is what makes this list about this group.
        if (!roster.has(normalizeSuiAddress(issuedEvent.master_owner))) continue
        issued.push({ capId, masterOwner: normalizeSuiAddress(issuedEvent.master_owner), agentAddress: normalizeSuiAddress(issuedEvent.agent_address) })
      }
      truncated = page.hasNextPage
      if (!page.hasNextPage) break
      if (!page.endCursor || cursors.has(page.endCursor)) { truncated = true; break }
      cursors.add(page.endCursor); before = page.endCursor
    }
    const delegations: GroupAgentDelegation[] = []
    for (const candidate of issued) {
      try {
        const { object } = await client.getObject({ objectId: candidate.capId, include: { content: true }, signal: signal() })
        if (normalizeSuiAddress(object.objectId) !== candidate.capId || normalizeStructTag(object.type) !== capType) throw new Error(t("agents.ga.notSubagentCap"))
        const cap = subagentCapBcs.parse(object.content)
        if (normalizeSuiAddress(cap.id) !== candidate.capId) throw new Error(t("agents.ga.capIdMismatch"))
        const masterOwner = normalizeSuiAddress(cap.master_owner), agentAddress = normalizeSuiAddress(cap.agent_address)
        if (masterOwner !== candidate.masterOwner || agentAddress !== candidate.agentAddress) throw new Error(t("agents.ga.eventObjectMismatch"))
        // The issuance event already proved this master is on the live roster.
        const rosterWeight = roster.get(masterOwner)
        if (rosterWeight === undefined) throw new Error(t("agents.ga.issuerNotOnRoster"))
        const capOwner = object.owner.$kind === "AddressOwner" ? normalizeSuiAddress(object.owner.AddressOwner) : null
        const custody: GroupAgentDelegation["custody"] = object.owner.$kind === "Shared" ? "shared" : capOwner ? "address" : "other"
        const { status, reason } = statusOf(cap, rosterWeight, custody, capOwner)
        delegations.push({
          capId: candidate.capId, masterOwner, agentAddress,
          voterWeight: BigInt(cap.voter_weight), rosterWeight,
          maxBudgetPerTx: BigInt(cap.max_budget_per_tx), dailyBudgetLimit: BigInt(cap.daily_budget_limit),
          spent: BigInt(cap.spent_today), expiresAtMs: BigInt(cap.expires_at_ms),
          revoked: cap.is_revoked, custody, capOwner, status, reason,
        })
      } catch (error) {
        errors.push(`${candidate.capId}: ${error instanceof Error ? error.message : t("agents.ga.capReadFailed")}`)
      }
    }
    // Active delegations first, then the rest by issuance order.
    const order: Record<GroupAgentStatus, number> = { ACTIVE: 0, STALE: 1, EXHAUSTED: 2, EXPIRED: 3, REVOKED: 4, UNVERIFIED: 5 }
    delegations.sort((a, b) => order[a.status] - order[b.status])
    return {
      orgId: normalizeSuiAddress(org.id),
      roster: [...roster.entries()].map(([address, weight]) => ({ address, weight })).sort((a, b) => a.address.localeCompare(b.address)),
      delegations, errors, truncated,
    }
  }

  return { listDelegations, readOrganization }
}

export const groupAgents = createGroupAgentReader(proposalClient)
