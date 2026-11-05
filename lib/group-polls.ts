import { bcs } from "@mysten/sui/bcs"
import type { SuiClientTypes } from "@mysten/sui/client"
import { normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils"
import { pollReader, pollVoteView, type PollSnapshot } from "./governance-poll-client"
import { OrganizationContent, PROPOSAL_TYPE_ORIGIN, proposalClient, readWeightTable } from "./proposal-chain"
import type { GovernanceVote } from "./governance"
import { t } from "@/lib/i18n/t"

// Matches the existing governance_poll::PollPublished event. Events discover IDs;
// the typed, shared Poll object remains the source of every displayed result.
export const GroupPollPublished = bcs.struct("PollPublished", {
  poll_id: bcs.Address, title: bcs.string(), description: bcs.string(), options: bcs.vector(bcs.string()), mode: bcs.u8(),
  electorate: bcs.vector(bcs.Address), weights: bcs.vector(bcs.u64()), deadline_ms: bcs.u64(),
  org_id: bcs.option(bcs.Address), org_epoch: bcs.u64(), group_voter_count: bcs.u64(),
  show_results_during: bcs.bool(), allow_link_access: bcs.bool(),
})
const signal = () => AbortSignal.timeout(20_000)
export function groupPollObjectId(value: string): string {
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(value) || BigInt(value) === 0n) throw new Error(t("groups.needNonZeroId"))
  return normalizeSuiAddress(value)
}
export interface GroupPollScope { groupId?: string; orgId: string; name: string }
interface GroupLink { id: string; name?: string; orgObjectId?: string }
export function resolveGroupPollScope(groupId: string | undefined, orgId: string | undefined, groups: GroupLink[]): GroupPollScope {
  const group = groupId ? groups.find(group => group.id === groupId) : undefined
  const linked = group?.orgObjectId ? groupPollObjectId(group.orgObjectId) : undefined
  const requested = orgId ? groupPollObjectId(orgId) : undefined
  if (linked && requested && linked !== requested) throw new Error(t("groups.pollGroupMismatch"))
  const canonical = requested || linked || (groupId?.startsWith("0x") ? groupPollObjectId(groupId) : undefined)
  if (!canonical) throw new Error(t("groups.pollNeedsDkg"))
  return { groupId: group?.id, orgId: canonical, name: group?.name || t("groups.onchainOrgLabel") }
}
export interface GroupPollOrganization { id: string; epoch: string; members: Record<string, number> }
export interface GroupPollList {
  votes: GovernanceVote[]; failures: { id: string; error: string }[]; truncated: boolean; discoveryError?: string
}
type PollReadClient = Pick<typeof pollReader, "pollType" | "readPoll">
type DiscoveryClient = Pick<typeof proposalClient, "getObject" | "listEvents">
const message = (cause: unknown) => cause instanceof Error ? cause.message : t("groups.chainReadFailed")
function publicationBytes(poll: PollSnapshot): Uint8Array {
  return GroupPollPublished.serialize({ ...poll, poll_id: poll.id }).toBytes()
}
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

export function createGroupPollReader(client: DiscoveryClient, polls: PollReadClient, weights: typeof readWeightTable) {
  async function readOrganization(orgId: string): Promise<GroupPollOrganization> {
    const id = groupPollObjectId(orgId)
    const { object } = await client.getObject({ objectId: id, include: { content: true }, signal: signal() })
    if (normalizeSuiAddress(object.objectId) !== id || normalizeStructTag(object.type) !== `${PROPOSAL_TYPE_ORIGIN}::cryptographic_org::Organization` || object.owner.$kind !== "Shared") throw new Error(t("groups.notSharedOrgPoll"))
    const org = OrganizationContent.parse(object.content)
    if (org.id !== id) throw new Error(t("groups.pollOrgIdMismatch"))
    const members = await weights(org.members_weight.id)
    if (BigInt(Object.keys(members).length) !== BigInt(org.members_weight.size) || Object.values(members).some(weight => !Number.isSafeInteger(weight) || weight <= 0)) throw new Error(t("groups.pollRosterInvalid"))
    return { id, epoch: org.epoch_version, members }
  }
  async function readPoll(pollId: string, orgId: string, voter = ""): Promise<GovernanceVote> {
    const poll = await polls.readPoll(groupPollObjectId(pollId))
    if (poll.org_id !== groupPollObjectId(orgId)) throw new Error(t("groups.pollNotOfOrg"))
    return pollVoteView(poll, voter)
  }
  async function listPolls(orgId: string, voter = "", hints: string[] = []): Promise<GroupPollList> {
    const org = groupPollObjectId(orgId)
    const pollType = await polls.pollType()
    const eventType = pollType.replace(/::Poll$/, "::PollPublished")
    const publications = new Map<string, SuiClientTypes.EventEntry>()
    const failures: GroupPollList["failures"] = []
    let before: string | null = null
    let truncated = false
    let discoveryError: string | undefined
    const cursors = new Set<string>()
    try {
      for (let pageIndex = 0; pageIndex < 8; pageIndex++) {
        const page: SuiClientTypes.ListEventsResponse = await client.listEvents({ filter: { eventType }, before, order: "descending", limit: 50, signal: signal() })
        for (const event of page.events) {
          if (normalizeStructTag(event.eventType) !== eventType) continue
          const published = GroupPollPublished.parse(event.bcs)
          if (published.org_id === org && !publications.has(published.poll_id)) publications.set(published.poll_id, event)
        }
        truncated = page.hasNextPage
        if (!page.hasNextPage) break
        if (!page.endCursor || cursors.has(page.endCursor)) throw new Error(t("groups.pollEventsPagingStuck"))
        cursors.add(page.endCursor); before = page.endCursor
      }
    } catch (cause) { discoveryError = message(cause); truncated = true }
    const ids = new Set(publications.keys())
    for (const hint of hints) {
      try { ids.add(groupPollObjectId(hint)) } catch { /* A discovery hint cannot confer identity or authority. */ }
    }
    const votes: GovernanceVote[] = []
    // Bound concurrent object reads without discarding individual failures.
    const candidates = [...ids]
    for (let offset = 0; offset < candidates.length; offset += 8) {
      await Promise.all(candidates.slice(offset, offset + 8).map(async id => {
        try {
          const poll = await polls.readPoll(id)
          if (poll.org_id !== org) {
            if (publications.has(id)) throw new Error(t("groups.pollOrgInconsistent"))
            return
          }
          const event = publications.get(id)
          if (event && (poll.creator !== normalizeSuiAddress(event.sender) || !sameBytes(publicationBytes(poll), event.bcs))) throw new Error(t("groups.pollEventInconsistent"))
          votes.push(pollVoteView(poll, voter))
        } catch (cause) { failures.push({ id, error: message(cause) }) }
      }))
    }
    const order = new Map(candidates.map((id, index) => [id, index]))
    votes.sort((a, b) => order.get(a.id)! - order.get(b.id)!)
    return { votes, failures, truncated, discoveryError }
  }
  return { readOrganization, readPoll, listPolls }
}
export const groupPollReader = createGroupPollReader(proposalClient, pollReader, readWeightTable)
