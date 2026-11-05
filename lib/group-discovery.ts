"use client"

import { bcs } from "@mysten/sui/bcs"
import { ObjectError } from "@mysten/sui/client"
import type { SuiGrpcClient } from "@mysten/sui/grpc"
import { isValidSuiAddress, normalizeStructTag, normalizeSuiAddress, toHex } from "@mysten/sui/utils"
import { OrganizationContent, PROPOSAL_TYPE_ORIGIN, proposalClient, weightNumber } from "./proposal-chain"
import { t } from "@/lib/i18n/t"

/**
 * Group list discovery.
 *
 * The local `user_groups` collection is a notes overlay: names, descriptions and
 * member display names that only exist on this device. Which organizations a
 * wallet actually belongs to is a chain fact, and it is read from
 * `OrganizationCreatedEvent` + each live `Organization.members_weight` table.
 *
 * The event stream is scanned newest-first with an explicit page and candidate
 * budget. `truncated` means the scan stopped before the end of the ledger, so an
 * absent organization is "not seen in this window", never "does not exist".
 */

export const ORGANIZATION_TYPE = `${PROPOSAL_TYPE_ORIGIN}::cryptographic_org::Organization`
export const ORGANIZATION_CREATED_TYPE = `${PROPOSAL_TYPE_ORIGIN}::cryptographic_org::OrganizationCreatedEvent`
const WEIGHT_FIELD_TYPE = "0x2::dynamic_field::Field<address,u64>"
const requestSignal = () => AbortSignal.timeout(20_000)

// Matches cryptographic_org::OrganizationCreatedEvent.
export const OrganizationCreatedEvent = bcs.struct("OrganizationCreatedEvent", {
  org_id: bcs.Address,
  group_pk: bcs.vector(bcs.u8()),
  threshold_weight: bcs.u64(),
  member_count: bcs.u64(),
})

export interface DiscoveredOrganization {
  orgId: string
  /** Hex-encoded 32-byte FROST group public key, as stored on chain. */
  groupPk: string
  epoch: number
  thresholdWeight: number
  /** Current roster size from the live table, not the creation-time event value. */
  memberCount: number
  /** The discovered account's current weight in this organization. */
  myWeight: number
  createdTxDigest: string
}

export interface GroupDiscoveryResult {
  /** Organizations where the requested account is a current member, newest first. */
  organizations: DiscoveredOrganization[]
  /** Every org id that was successfully examined, member or not. */
  checked: string[]
  scannedEvents: number
  /** The scan stopped at a page or candidate cap before the end of the ledger. */
  truncated: boolean
  /** Organizations that could not be examined; membership there is unknown, not negative. */
  failures: Array<{ orgId: string; reason: string }>
}

export interface GroupDiscoveryOptions {
  maxPages?: number
  pageSize?: number
  maxOrganizations?: number
}

export type GroupDiscoveryClient = Pick<SuiGrpcClient, "getObject" | "getDynamicField" | "listEvents">

const message = (cause: unknown) => cause instanceof Error ? cause.message : t("groups.chainReadFailed")

/** Short, display-only label for an organization that has no local note name. */
export function chainGroupLabel(orgId: string): string {
  const id = normalizeSuiAddress(orgId)
  return t("groups.orgFallbackName", { head: id.slice(0, 8), tail: id.slice(-6) })
}

/**
 * The local notes record created when a user adopts a discovered organization.
 *
 * Everything here is either a chain fact read during discovery or an explicit
 * empty note. No member names, vault, or capability is invented: execution
 * against a discovered organization must go through treasury metadata, which is
 * the only path whose binding the contract can verify.
 */
export function discoveredGroupRecord(org: DiscoveredOrganization, now = Date.now()): Record<string, unknown> {
  const orgId = normalizeSuiAddress(org.orgId)
  return {
    // The organization ID doubles as the local id so proposals already saved
    // for this organization (`groupId: orgId`) stay linked after adoption.
    id: orgId,
    name: chainGroupLabel(orgId),
    description: "",
    network: "Sui Testnet",
    members: [],
    threshold: org.thresholdWeight,
    totalWeight: 0,
    orgObjectId: orgId,
    groupPk: org.groupPk,
    epoch: org.epoch,
    orgTxDigest: org.createdTxDigest,
    sourceStatus: "chain-confirmed",
    createdAt: new Date(now).toISOString(),
  }
}

function hex(bytes: number[] | Uint8Array): string {
  return toHex(Uint8Array.from(bytes))
}

export function createGroupDiscovery(client: GroupDiscoveryClient) {
  /** The account's weight in the organization roster, or null when it is absent. */
  async function membershipWeight(tableId: string, account: string): Promise<number | null> {
    try {
      const { dynamicField } = await client.getDynamicField({
        parentId: tableId,
        name: { type: "address", bcs: bcs.Address.serialize(account).toBytes() },
        signal: requestSignal(),
      })
      if (dynamicField.$kind !== "DynamicField" || normalizeStructTag(dynamicField.type) !== normalizeStructTag(WEIGHT_FIELD_TYPE)) {
        throw new Error(t("groups.membersTableTypeMismatch"))
      }
      return weightNumber(bcs.u64().parse(dynamicField.value.bcs))
    } catch (error) {
      // Only a typed missing dynamic field means "not a member". Any other
      // failure leaves membership unknown and must not be reported as absence.
      if (error instanceof ObjectError && error.reason === "notFound") return null
      throw error
    }
  }

  async function readCandidate(orgId: string, account: string, createdTxDigest: string): Promise<DiscoveredOrganization | null> {
    const { object } = await client.getObject({ objectId: orgId, include: { content: true }, signal: requestSignal() })
    if (normalizeStructTag(object.type) !== normalizeStructTag(ORGANIZATION_TYPE)) throw new Error(t("groups.objectNotOrg"))
    if (object.owner.$kind !== "Shared") throw new Error(t("groups.discoveryOrgNotShared"))
    const fields = OrganizationContent.parse(object.content)
    if (normalizeSuiAddress(object.objectId) !== orgId || normalizeSuiAddress(fields.id) !== orgId) throw new Error(t("groups.discoveryOrgIdMismatch"))

    const weight = await membershipWeight(fields.members_weight.id, account)
    if (weight === null) return null

    return {
      orgId,
      groupPk: hex(fields.group_pk),
      epoch: weightNumber(fields.epoch_version),
      thresholdWeight: weightNumber(fields.threshold_weight),
      memberCount: weightNumber(fields.members_weight.size),
      myWeight: weight,
      createdTxDigest,
    }
  }

  async function discover(address: string, options: GroupDiscoveryOptions = {}): Promise<GroupDiscoveryResult> {
    if (!isValidSuiAddress(address)) throw new Error(t("groups.needAddressToDiscover"))
    const account = normalizeSuiAddress(address)
    const maxPages = options.maxPages ?? 10
    const pageSize = options.pageSize ?? 50
    const maxOrganizations = options.maxOrganizations ?? 60
    if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 20) throw new Error(t("groups.invalidDiscoveryPages"))
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50) throw new Error(t("groups.invalidDiscoveryPageSize"))
    if (!Number.isInteger(maxOrganizations) || maxOrganizations < 1 || maxOrganizations > 200) throw new Error(t("groups.invalidDiscoveryCap"))

    // Newest first: the scan budget is spent on the organizations a user is
    // most likely to have joined recently.
    const candidates = new Map<string, string>()
    const cursors = new Set<string>()
    let before: string | null = null
    let scannedEvents = 0
    let truncated = false
    for (let pageIndex = 0; pageIndex < maxPages; pageIndex++) {
      const page = await client.listEvents({
        filter: { eventType: ORGANIZATION_CREATED_TYPE },
        before, limit: pageSize, order: "descending", signal: requestSignal(),
      })
      scannedEvents += page.events.length
      for (const event of page.events) {
        // The event-type filter should make this unreachable; a mismatch means
        // the endpoint returned another contract and must not be decoded.
        if (normalizeStructTag(event.eventType) !== normalizeStructTag(ORGANIZATION_CREATED_TYPE)) throw new Error(t("groups.discoveryEventTypeMismatch"))
        const fields = OrganizationCreatedEvent.parse(event.bcs)
        const orgId = normalizeSuiAddress(fields.org_id)
        if (!candidates.has(orgId)) candidates.set(orgId, event.transactionDigest)
      }
      if (!page.hasNextPage) break
      if (!page.endCursor || cursors.has(page.endCursor) || page.endCursor === before) throw new Error(t("groups.discoveryPagingStuck"))
      if (pageIndex === maxPages - 1) { truncated = true; break }
      cursors.add(page.endCursor)
      before = page.endCursor
    }

    let entries = [...candidates]
    if (entries.length > maxOrganizations) {
      entries = entries.slice(0, maxOrganizations)
      truncated = true
    }

    const organizations: DiscoveredOrganization[] = []
    const checked: string[] = []
    const failures: GroupDiscoveryResult["failures"] = []
    // Four object reads in flight keeps a 60-organization scan from opening 60
    // sockets at once.
    for (let index = 0; index < entries.length; index += 4) {
      const batch = entries.slice(index, index + 4)
      const results = await Promise.all(batch.map(async ([orgId, digest]) => {
        try { return { orgId, organization: await readCandidate(orgId, account, digest), error: null } }
        catch (error) { return { orgId, organization: null, error } }
      }))
      for (const result of results) {
        if (result.error) { failures.push({ orgId: result.orgId, reason: message(result.error) }); continue }
        checked.push(result.orgId)
        if (result.organization) organizations.push(result.organization)
      }
    }

    return { organizations, checked, scannedEvents, truncated, failures }
  }

  return { discover }
}

export const groupDiscovery = createGroupDiscovery(proposalClient)

// Discovery is account-scoped and shared by every group list, so a module-level
// cache dedupes the event scan and the per-organization reads between them. It
// is keyed by account, never shared across accounts, and short-lived so a newly
// joined organization appears without a reload.
const CACHE_TTL_MS = 60_000
const cache = new Map<string, { at: number; result: GroupDiscoveryResult }>()
const inflight = new Map<string, Promise<GroupDiscoveryResult>>()

export function discoverGroupsCached(address: string, force = false): Promise<GroupDiscoveryResult> {
  const key = normalizeSuiAddress(address)
  if (!force) {
    const hit = cache.get(key)
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return Promise.resolve(hit.result)
  }
  const pending = inflight.get(key)
  if (pending) return pending
  const run = groupDiscovery.discover(key).then(result => {
    cache.set(key, { at: Date.now(), result })
    return result
  }).finally(() => { inflight.delete(key) })
  inflight.set(key, run)
  return run
}

/** Drop cached discovery for one account, or all accounts when omitted. */
export function invalidateGroupDiscovery(address?: string): void {
  if (address) cache.delete(normalizeSuiAddress(address))
  else cache.clear()
}

export interface DiscoveredGroupRow {
  id: string
  name: string
  description: string
  network: string
  orgObjectId: string
  groupPk: string
  epoch: number | null
  threshold: number | null
  /** Authoritative member count when read from chain; otherwise the local roster size. */
  memberCount: number | null
  /** Local member notes only. Chain rows carry no invented names. */
  members: Array<{ address: string; weight: number; name?: string }>
  sourceStatus: "local" | "unverified" | "chain-confirmed"
  /** "chain" means discovered on chain with no local note record. */
  origin: "local" | "chain"
  myWeight: number | null
  /** "unknown" covers truncated scans and read failures; absence is never claimed. */
  membership: "confirmed" | "not-member" | "unknown"
  /** Legacy personal-cap execution source. Local notes only; never inferred from chain. */
  vaultId: string
  masterCapId: string
  chain?: DiscoveredOrganization
}

/**
 * Merge chain discovery with the local notes overlay.
 *
 * Local rows always survive: a saved group is an entry point the user already
 * had, and discovery must never hide it. Chain-only organizations are appended
 * with a generated label; their notes stay empty until the user saves them.
 */
export function mergeDiscoveredGroups(localGroups: unknown[], discovery: GroupDiscoveryResult | null): DiscoveredGroupRow[] {
  const chain = new Map((discovery?.organizations ?? []).map(org => [normalizeSuiAddress(org.orgId), org]))
  // `map(normalizeSuiAddress)` would pass the array index as the function's
  // `forceAdd0x` argument and produce `0x0x…` for every element but the first.
  const checked = new Set((discovery?.checked ?? []).map(id => normalizeSuiAddress(id)))
  const rows: DiscoveredGroupRow[] = []
  const seen = new Set<string>()

  for (const entry of localGroups) {
    // A stored row is untrusted JSON: anything that is not an object carries no
    // fields this merge can use, so it contributes nothing.
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue
    const group = entry as Record<string, unknown>
    const rawOrg = typeof group.orgObjectId === "string" && isValidSuiAddress(group.orgObjectId) ? normalizeSuiAddress(group.orgObjectId) : ""
    const live = rawOrg ? chain.get(rawOrg) : undefined
    if (rawOrg) seen.add(rawOrg)
    const members = Array.isArray(group?.members) ? group.members : []
    // An org this scan tried and failed to read is not the same as one it never
    // saw. `live` is the only thing that re-confirms the chain today, so a
    // stored badge is demoted when the read that would have re-earned it failed.
    const readFailed = !!discovery && discovery.failures.some(failure => normalizeSuiAddress(failure.orgId) === rawOrg)
    const membership = live ? "confirmed" : rawOrg && discovery && !discovery.truncated && checked.has(rawOrg) ? "not-member" : "unknown"
    rows.push({
      id: typeof group?.id === "string" ? group.id : "",
      name: typeof group?.name === "string" ? group.name : t("groups.unnamedLegacyGroup"),
      description: typeof group?.description === "string" ? group.description : "",
      network: typeof group?.network === "string" ? group.network : "Sui Testnet",
      orgObjectId: rawOrg,
      groupPk: live?.groupPk ?? (typeof group?.groupPk === "string" ? group.groupPk : ""),
      epoch: live?.epoch ?? (typeof group.epoch === "number" && Number.isSafeInteger(group.epoch) ? group.epoch : null),
      threshold: live?.thresholdWeight ?? (typeof group?.threshold === "number" ? group.threshold : null),
      memberCount: live?.memberCount ?? (members.length || null),
      members,
      sourceStatus: live || (!readFailed && group?.sourceStatus === "chain-confirmed") ? "chain-confirmed" : "unverified",
      origin: "local",
      myWeight: live?.myWeight ?? null,
      membership,
      vaultId: typeof group?.vaultId === "string" ? group.vaultId : "",
      masterCapId: typeof group?.masterCapId === "string" ? group.masterCapId : "",
      chain: live,
    })
  }

  for (const org of discovery?.organizations ?? []) {
    if (seen.has(normalizeSuiAddress(org.orgId))) continue
    seen.add(normalizeSuiAddress(org.orgId))
    rows.push({
      id: org.orgId,
      name: chainGroupLabel(org.orgId),
      description: "",
      network: "Sui Testnet",
      orgObjectId: org.orgId,
      groupPk: org.groupPk,
      epoch: org.epoch,
      threshold: org.thresholdWeight,
      memberCount: org.memberCount,
      members: [],
      sourceStatus: "chain-confirmed",
      origin: "chain",
      myWeight: org.myWeight,
      membership: "confirmed",
      // A chain-only organization has no saved notes, so it has no recorded
      // personal-cap source. Execution falls back to treasury metadata only.
      vaultId: "",
      masterCapId: "",
      chain: org,
    })
  }

  return rows
}
