// Channel-scoped AI posting delegations (`SubagentMessagingCap`).
//
// `post_message_by_subagent` requires the signer to equal `cap.agent_address`,
// the cap to name this channel, the cap to be unrevoked and unexpired, the
// master to still be a channel member, and the per-minute rate limit to hold.
// The reader mirrors each of those checks and never invents a cap: candidates
// come from issuance events, values from the object, membership from the
// channel's on-chain member table.
import { bcs } from "@mysten/sui/bcs"
import { ObjectError, type SuiClientTypes } from "@mysten/sui/client"
import { normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils"
import { SubagentCapIssuedBcs, SubagentMessagingCapBcs, classifyMessagingCap } from "multisig/agent-vault"
import { proposalClient, PROPOSAL_TYPE_ORIGIN } from "./proposal-chain"
import { ChannelContent, CHANNEL_TYPE } from "./group-chat"
import { t } from "@/lib/i18n/t"

const signal = () => AbortSignal.timeout(20_000)
const id = (value: string) => {
  if (typeof value !== "string" || !/^0x[\da-fA-F]{1,64}$/.test(value) || BigInt(value) === 0n) throw new Error(t("groups.invalidObjectId"))
  return normalizeSuiAddress(value)
}

// BCS 布局与状态分级在 SDK chat 切片（单一事实源）；此处仅保留别名。
export const messagingCapBcs = SubagentMessagingCapBcs
export const messagingCapIssuedBcs = SubagentCapIssuedBcs

export type MessagingCapStatus = "ACTIVE" | "EXPIRED" | "REVOKED" | "STALE"

export interface MessagingDelegation {
  capId: string
  masterOwner: string
  agentAddress: string
  channelId: string
  expiresAtMs: bigint
  rateLimitPerMinute: bigint
  /** Master is still a member of the channel, as the contract requires. */
  masterIsMember: boolean
  custody: "shared" | "address" | "other"
  capOwner: string | null
  status: MessagingCapStatus
  reason: string
}

export interface MessagingCapList {
  channelId: string
  delegations: MessagingDelegation[]
  errors: string[]
  truncated: boolean
}

export type MessagingCapClient = Pick<typeof proposalClient, "getObject" | "listEvents" | "getDynamicField">

const MAX_PAGES = 4
const PAGE_SIZE = 50

export function createMessagingCapReader(
  client: MessagingCapClient,
  channelType = CHANNEL_TYPE,
  now: () => number = Date.now,
) {
  async function isMember(membersTable: string, address: string): Promise<boolean> {
    try {
      const { dynamicField } = await client.getDynamicField({ parentId: membersTable, name: { type: "address", bcs: bcs.Address.serialize(address).toBytes() }, signal: signal() })
      if (dynamicField.value.type !== "bool") throw new Error(t("groups.capsMembersTableMismatch"))
      return bcs.bool().parse(dynamicField.value.bcs)
    } catch (error) {
      if (error instanceof ObjectError && error.reason === "notFound") return false
      throw error
    }
  }

  async function listCapabilities(channelId: string): Promise<MessagingCapList> {
    const channel = id(channelId)
    const { object: channelObject } = await client.getObject({ objectId: channel, include: { content: true }, signal: signal() })
    if (normalizeSuiAddress(channelObject.objectId) !== channel || normalizeStructTag(channelObject.type) !== normalizeStructTag(channelType)) throw new Error(t("groups.notDeployedChatChannel"))
    const raw = ChannelContent.parse(channelObject.content)
    if (raw.id !== channel) throw new Error(t("groups.capsChannelIdMismatch"))
    const eventType = normalizeStructTag(`${PROPOSAL_TYPE_ORIGIN}::onchain_chat::SubagentMessagingCapIssuedEvent`)
    const capType = normalizeStructTag(`${PROPOSAL_TYPE_ORIGIN}::onchain_chat::SubagentMessagingCap`)
    const errors: string[] = [], seen = new Set<string>(), cursors = new Set<string>()
    const issued: Array<{ capId: string; masterOwner: string; agentAddress: string }> = []
    let before: string | null = null, truncated = false
    for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex++) {
      const page: SuiClientTypes.ListEventsResponse = await client.listEvents({ filter: { eventType }, before, order: "descending", limit: PAGE_SIZE, signal: signal() })
      for (const event of page.events) {
        if (normalizeStructTag(event.eventType) !== eventType) continue
        const issuedEvent = messagingCapIssuedBcs.parse(event.bcs)
        if (normalizeSuiAddress(issuedEvent.channel_id) !== channel) continue
        const capId = normalizeSuiAddress(issuedEvent.cap_id)
        if (seen.has(capId)) continue
        seen.add(capId)
        issued.push({ capId, masterOwner: normalizeSuiAddress(issuedEvent.master_owner), agentAddress: normalizeSuiAddress(issuedEvent.agent_address) })
      }
      truncated = page.hasNextPage
      if (!page.hasNextPage) break
      if (!page.endCursor || cursors.has(page.endCursor)) { truncated = true; break }
      cursors.add(page.endCursor); before = page.endCursor
    }
    const membership = new Map<string, boolean>()
    const delegations: MessagingDelegation[] = []
    for (const candidate of issued) {
      try {
        const { object } = await client.getObject({ objectId: candidate.capId, include: { content: true }, signal: signal() })
        if (normalizeSuiAddress(object.objectId) !== candidate.capId || normalizeStructTag(object.type) !== capType) throw new Error(t("groups.notMessagingCap"))
        const cap = messagingCapBcs.parse(object.content)
        if (cap.id !== candidate.capId || normalizeSuiAddress(cap.channel_id) !== channel) throw new Error(t("groups.capChannelMismatch"))
        const masterOwner = normalizeSuiAddress(cap.master_owner), agentAddress = normalizeSuiAddress(cap.agent_address)
        if (masterOwner !== candidate.masterOwner || agentAddress !== candidate.agentAddress) throw new Error(t("groups.capEventMismatch"))
        if (!membership.has(masterOwner)) membership.set(masterOwner, await isMember(raw.members.id, masterOwner))
        const capOwner = object.owner.$kind === "AddressOwner" ? normalizeSuiAddress(object.owner.AddressOwner) : null
        const custody: MessagingDelegation["custody"] = object.owner.$kind === "Shared" ? "shared" : capOwner ? "address" : "other"
        const { status, reason } = classifyMessagingCap({
          cap: { isRevoked: cap.is_revoked, expiresAtMs: BigInt(cap.expires_at_ms), masterOwner, agentAddress },
          nowMs: now(), masterIsMember: !!membership.get(masterOwner), custody, capOwner,
        })
        delegations.push({
          capId: candidate.capId, masterOwner, agentAddress, channelId: channel,
          expiresAtMs: BigInt(cap.expires_at_ms), rateLimitPerMinute: BigInt(cap.rate_limit_per_minute),
          masterIsMember: !!membership.get(masterOwner), custody, capOwner, status, reason,
        })
      } catch (error) {
        errors.push(`${candidate.capId}: ${error instanceof Error ? error.message : t("groups.capReadFailed")}`)
      }
    }
    const order: Record<MessagingCapStatus, number> = { ACTIVE: 0, STALE: 1, EXPIRED: 2, REVOKED: 3 }
    delegations.sort((a, b) => order[a.status] - order[b.status])
    return { channelId: channel, delegations, errors, truncated }
  }

  return { listCapabilities }
}

export const messagingCaps = createMessagingCapReader(proposalClient)
