// Threshold-signed roster change for an on-chain organization.
//
// The contract `cryptographic_org::update_organization_roster` replaces the whole
// membership table with a snapshot signed by the FROST group key. This module owns
// the off-chain half: reading the live roster, validating a draft against the same
// rules the contract enforces, and producing the exact digest that is signed. The
// transaction itself lives in group-roster-transactions.ts so this logic stays
// pure and testable.
import type { SuiGrpcClient } from "@mysten/sui/grpc"
import { normalizeSuiAddress, normalizeStructTag, isValidSuiAddress } from "@mysten/sui/utils"
import { OrganizationContent, PROPOSAL_TYPE_ORIGIN, readWeightTable } from "./proposal-chain"
import { t } from "@/lib/i18n/t"

/** Mirrors `cryptographic_org::MAX_ROSTER_MEMBERS`. */
export const MAX_ROSTER_MEMBERS = 128

export interface RosterMember {
  address: string
  weight: bigint
}

export interface LiveOrganization {
  orgId: string
  groupPk: Uint8Array
  epoch: bigint
  lastNonce: bigint
  thresholdWeight: bigint
  /** Bytes stored on chain; the signed digest must use these, not a default. */
  chainId: Uint8Array
  members: RosterMember[]
}

export interface RosterPlan {
  /** Every live address, used by the contract to clear the old table exactly. */
  priorMembers: string[]
  members: string[]
  weights: bigint[]
  thresholdWeight: bigint
}

export type RosterClient = Pick<SuiGrpcClient, "getObject">

const signal = () => AbortSignal.timeout(20_000)

function objectId(value: string): string {
  if (typeof value !== "string" || !/^0x[\da-fA-F]{1,64}$/.test(value) || BigInt(value) === 0n) {
    throw new Error(t("groups.invalidObjectId"))
  }
  return normalizeSuiAddress(value)
}

/** Read and type-check the live organization plus its weight table. */
export async function readLiveOrganization(client: RosterClient, orgId: string): Promise<LiveOrganization> {
  const id = objectId(orgId)
  const { object } = await client.getObject({ objectId: id, include: { content: true }, signal: signal() })
  if (normalizeSuiAddress(object.objectId) !== id) throw new Error(t("groups.orgIdMismatch"))
  if (normalizeStructTag(object.type) !== `${PROPOSAL_TYPE_ORIGIN}::cryptographic_org::Organization`) {
    throw new Error(t("groups.notAnOrg"))
  }
  if (object.owner.$kind !== "Shared") throw new Error(t("groups.orgNotShared"))
  const content = OrganizationContent.parse(object.content)
  if (content.id !== id) throw new Error(t("groups.orgInnerIdMismatch"))
  if (content.group_pk.length !== 32) throw new Error(t("groups.orgPkLength"))

  const weights = await readWeightTable(content.members_weight.id)
  if (BigInt(Object.keys(weights).length) !== BigInt(content.members_weight.size)) {
    throw new Error(t("groups.rosterReadTruncated"))
  }
  const members = Object.entries(weights)
    .map(([address, weight]) => ({ address: normalizeSuiAddress(address), weight: BigInt(weight) }))
    .sort((left, right) => left.address.localeCompare(right.address))

  return {
    orgId: id,
    groupPk: new Uint8Array(content.group_pk),
    epoch: BigInt(content.epoch_version),
    lastNonce: BigInt(content.last_nonce),
    thresholdWeight: BigInt(content.threshold_weight),
    chainId: new Uint8Array(content.chain_id),
    members,
  }
}

/**
 * Validate a draft against the contract's guard order and return the exact
 * arguments to sign and submit. Addresses are normalized. Throws a message that
 * names the same rule the contract would abort with, so the user sees the reason
 * before a wallet prompt.
 */
export function planRosterChange(live: LiveOrganization, draft: { members: RosterMember[]; thresholdWeight: bigint }): RosterPlan {
  // `create_organization` never produces an empty table, so an empty read means
  // the roster could not be verified and the prior list would be wrong.
  if (live.members.length === 0) throw new Error(t("groups.rosterEmptyOrUnverified"))
  if (draft.members.length === 0) throw new Error(t("groups.rosterMinMembers"))
  if (draft.members.length > MAX_ROSTER_MEMBERS) throw new Error(t("groups.rosterMaxMembers", { max: MAX_ROSTER_MEMBERS }))

  const seen = new Set<string>()
  let sum = 0n
  const members: string[] = []
  const weights: bigint[] = []
  for (const member of draft.members) {
    if (!isValidSuiAddress(member.address)) throw new Error(t("groups.invalidMemberAddress", { address: member.address || t("groups.emptyAddress") }))
    const address = normalizeSuiAddress(member.address)
    if (BigInt(address) === 0n) throw new Error(t("groups.rosterZeroAddress"))
    if (seen.has(address)) throw new Error(t("groups.duplicateMemberAddress", { address }))
    if (member.weight <= 0n) throw new Error(t("groups.rosterWeightPositive"))
    seen.add(address)
    members.push(address)
    weights.push(member.weight)
    sum += member.weight
  }

  if (draft.thresholdWeight <= 0n) throw new Error(t("groups.thresholdPositive"))
  if (draft.thresholdWeight > sum) throw new Error(t("groups.thresholdOverSum", { threshold: draft.thresholdWeight, sum }))

  // The contract requires an exact enumeration of the live table; the read above
  // already proved it is complete, so this list is derived, never user-edited.
  const priorMembers = live.members.map(member => member.address)

  const unchangedRoster = live.members.length === members.length
    && live.members.every(member => {
      const index = members.indexOf(member.address)
      return index >= 0 && weights[index] === member.weight
    })
  if (unchangedRoster && draft.thresholdWeight === live.thresholdWeight) {
    throw new Error(t("groups.rosterUnchanged"))
  }

  return { priorMembers, members, weights, thresholdWeight: draft.thresholdWeight }
}


/** Wallet-facing summary of what changed, for confirmation before signing. */
export function describeRosterChange(live: LiveOrganization, plan: RosterPlan): string[] {
  const before = new Map(live.members.map(member => [member.address, member.weight]))
  const after = new Map(plan.members.map((address, index) => [address, plan.weights[index]]))
  const lines: string[] = []
  for (const [address] of before) {
    if (!after.has(address)) lines.push(t("groups.diffRemoved", { address }))
  }
  for (const [address, weight] of after) {
    if (!before.has(address)) lines.push(t("groups.diffAdded", { address, weight }))
    else if (before.get(address) !== weight) lines.push(t("groups.diffWeight", { address, from: before.get(address)!, weight }))
  }
  if (plan.thresholdWeight !== live.thresholdWeight) lines.push(t("groups.diffThreshold", { from: live.thresholdWeight, to: plan.thresholdWeight }))
  return lines
}
