import assert from "node:assert/strict"
import { afterEach, mock, test } from "node:test"
import { bcs } from "@mysten/sui/bcs"
import { ObjectError, type SuiClientTypes } from "@mysten/sui/client"
import {
  ORGANIZATION_CREATED_TYPE, ORGANIZATION_TYPE, createGroupDiscovery, discoveredGroupRecord, mergeDiscoveredGroups,
} from "./group-discovery"
import { OrganizationContent, PROPOSAL_TYPE_ORIGIN } from "./proposal-chain"

const address = (digit: string) => `0x${digit.repeat(64)}`
const member = address("1")
const orgId = address("3"), otherOrg = address("4")
const tableId = address("5"), otherTable = address("6")
const digest = "3bYqB1C9dYbDs6mHhJ5s1xktS9ZH4bP1x9aYh1qXhVdq"

const created = (id: string) => ({ eventType: ORGANIZATION_CREATED_TYPE, bcs: bcs.struct("E", {
  org_id: bcs.Address, group_pk: bcs.vector(bcs.u8()), threshold_weight: bcs.u64(), member_count: bcs.u64(),
}).serialize({ org_id: id, group_pk: Array.from({ length: 32 }, (_, i) => i), threshold_weight: "2", member_count: "3" }).toBytes(), transactionDigest: digest })

const page = (events: any[], extra: { hasNextPage?: boolean; endCursor?: string | null } = {}) => ({
  events, hasNextPage: extra.hasNextPage ?? false, endCursor: extra.endCursor ?? null, startCursor: null,
})

function organization(id: string, table: string, size = "3") {
  return {
    objectId: id, type: ORGANIZATION_TYPE, owner: { $kind: "Shared", Shared: { initialSharedVersion: "1" } },
    content: OrganizationContent.serialize({
      id, group_pk: Array.from({ length: 32 }, (_, i) => 255 - i), threshold_weight: "2", epoch_version: "4",
      last_nonce: "0", chain_id: Array.from(new TextEncoder().encode("sui-testnet:")),
      members_weight: { id: table, size }, executed_proposals: { id: address("7"), size: "0" }, key_signers: [], key_threshold: "2", genesis_stake: "0", genesis_bonded_total: "0", genesis_withdrawn: "0", genesis_unlock_at_ms: "0",
    }).toBytes(),
  }
}

const notFound = () => new ObjectError("notExists", "not found", { reason: "notFound" })

/** A client whose org membership table answers only for the ids in `members`. */
function client(options: {
  events?: any[]
  orgs?: Record<string, string | null>
  weights?: Record<string, Record<string, string>>
  onOrg?: (id: string) => void
  onPage?: (index: number) => void
}) {
  const orgs = options.orgs ?? { [orgId]: tableId }
  const weights = options.weights ?? { [tableId]: { [member]: "2" } }
  let pages = 0
  return {
    listEvents: mock.fn(async () => {
      options.onPage?.(pages)
      const events = options.events ?? []
      const value = events[Math.min(pages, events.length - 1)] ?? page([])
      pages++
      return value
    }),
    getObject: mock.fn(async ({ objectId }: SuiClientTypes.GetObjectOptions) => {
      options.onOrg?.(objectId)
      if (!(objectId in orgs)) throw new Error("unexpected object read")
      const table = orgs[objectId]
      if (table === null) throw new Error("org not readable")
      return { object: organization(objectId, table) }
    }),
    getDynamicField: mock.fn(async ({ parentId, name }: SuiClientTypes.GetDynamicFieldOptions) => {
      const key = bcs.Address.parse(name.bcs)
      const value = weights[parentId]?.[key]
      if (value === undefined) throw notFound()
      return {
        dynamicField: {
          $kind: "DynamicField" as const, type: `0x2::dynamic_field::Field<address,u64>`, name,
          value: { type: "u64", bcs: bcs.u64().serialize(value).toBytes() },
        },
      }
    }),
  }
}

afterEach(() => mock.restoreAll())

test("discovers a member organization with the live roster, not the creation-time event values", async () => {
  const reader = createGroupDiscovery(client({ events: [page([created(orgId)])] }) as any)
  const result = await reader.discover(member)
  assert.equal(result.truncated, false)
  assert.deepEqual(result.failures, [])
  assert.deepEqual(result.checked, [orgId])
  assert.equal(result.scannedEvents, 1)
  assert.equal(result.organizations.length, 1)
  const org = result.organizations[0]
  assert.equal(org.orgId, orgId)
  assert.equal(org.myWeight, 2)
  // epoch/threshold/size come from the Organization object; the event's
  // threshold "2" and member_count "3" are creation-time and may be stale.
  assert.equal(org.epoch, 4)
  assert.equal(org.thresholdWeight, 2)
  assert.equal(org.memberCount, 3)
  assert.equal(org.groupPk.length, 64)
  assert.equal(org.groupPk.slice(0, 2), "ff")
  assert.equal(org.createdTxDigest, digest)
})

test("excludes organizations where the account has no membership row", async () => {
  const reader = createGroupDiscovery(client({
    events: [page([created(orgId), created(otherOrg)])],
    orgs: { [orgId]: tableId, [otherOrg]: otherTable },
    weights: { [tableId]: { [member]: "1" }, [otherTable]: {} },
  }) as any)
  const result = await reader.discover(member)
  assert.deepEqual(result.organizations.map(org => org.orgId), [orgId])
  // An examined non-member is a recorded negative, which lets the merge layer
  // state "not a member" instead of "unknown".
  assert.deepEqual([...result.checked].sort(), [orgId, otherOrg].sort())
  assert.deepEqual(result.failures, [])
})

test("a failed organization read is a failure, never reported as non-membership", async () => {
  const reader = createGroupDiscovery(client({
    events: [page([created(orgId), created(otherOrg)])],
    orgs: { [orgId]: tableId, [otherOrg]: null },
    weights: { [tableId]: { [member]: "1" } },
  }) as any)
  const result = await reader.discover(member)
  assert.deepEqual(result.organizations.map(org => org.orgId), [orgId])
  assert.deepEqual(result.checked, [orgId])
  assert.equal(result.failures.length, 1)
  assert.equal(result.failures[0].orgId, otherOrg)
  assert.match(result.failures[0].reason, /org not readable/)
})

test("only a typed notFound dynamic field means absent; other errors surface", async () => {
  const fake = client({ events: [page([created(orgId)])], weights: { [tableId]: { [member]: "1" } } })
  fake.getDynamicField = mock.fn(async () => { throw new Error("rpc unavailable") }) as any
  const reader = createGroupDiscovery(fake as any)
  const result = await reader.discover(member)
  assert.deepEqual(result.organizations, [])
  assert.equal(result.failures.length, 1)
  assert.match(result.failures[0].reason, /rpc unavailable/)
})

test("marks a page-capped scan as truncated so absence is never implied", async () => {
  const reader = createGroupDiscovery(client({
    events: [page([created(orgId)], { hasNextPage: true, endCursor: "cursor-1" })],
  }) as any)
  const result = await reader.discover(member, { maxPages: 1 })
  assert.equal(result.truncated, true)
  assert.equal(result.organizations.length, 1)
})

test("follows cursors across pages and collapses repeated organizations", async () => {
  const seen: number[] = []
  const reader = createGroupDiscovery(client({
    events: [
      page([created(orgId)], { hasNextPage: true, endCursor: "cursor-1" }),
      page([created(orgId), created(otherOrg)], { hasNextPage: true, endCursor: "cursor-2" }),
      page([], { hasNextPage: false }),
    ],
    orgs: { [orgId]: tableId, [otherOrg]: otherTable },
    weights: { [tableId]: { [member]: "1" }, [otherTable]: { [member]: "3" } },
    onPage: index => seen.push(index),
  }) as any)
  const result = await reader.discover(member)
  assert.equal(result.truncated, false)
  assert.deepEqual(seen, [0, 1, 2])
  // Newest first: the organization's first appearance wins.
  assert.deepEqual(result.organizations.map(org => org.orgId), [orgId, otherOrg])
  assert.equal(result.organizations[1].myWeight, 3)
})

test("rejects a cursor that does not advance instead of looping", async () => {
  const reader = createGroupDiscovery(client({
    events: [page([created(orgId)], { hasNextPage: true, endCursor: "same" })],
  }) as any)
  // Second page reports the same cursor, so the guard throws.
  await assert.rejects(reader.discover(member), /分页未前进/)
})

test("caps the candidate count and reports the cap as truncation", async () => {
  const ids = [address("8"), address("9")]
  const reader = createGroupDiscovery(client({
    events: [page(ids.map(created))],
    orgs: { [ids[0]]: tableId, [ids[1]]: otherTable },
    weights: { [tableId]: { [member]: "1" }, [otherTable]: { [member]: "1" } },
  }) as any)
  const result = await reader.discover(member, { maxOrganizations: 1 })
  assert.equal(result.truncated, true)
  assert.deepEqual(result.organizations.map(org => org.orgId), [ids[0]])
})

test("rejects events from a different contract and non-organization objects", async () => {
  const wrongEvent = { ...created(orgId), eventType: `${PROPOSAL_TYPE_ORIGIN}::other::OrganizationCreatedEvent` }
  const bad = createGroupDiscovery(client({ events: [page([wrongEvent])] }) as any)
  await assert.rejects(bad.discover(member), /事件类型不匹配/)

  const fake = client({ events: [page([created(orgId)])] })
  fake.getObject = mock.fn(async ({ objectId }: SuiClientTypes.GetObjectOptions) => ({
    object: { ...organization(objectId, tableId), owner: { $kind: "AddressOwner", AddressOwner: member } },
  })) as any
  const result = await createGroupDiscovery(fake as any).discover(member)
  assert.deepEqual(result.organizations, [])
  assert.match(result.failures[0].reason, /共享对象/)
})

test("validates the account address and scan bounds before any network read", async () => {
  const fake = client({ events: [page([])] })
  const reader = createGroupDiscovery(fake as any)
  await assert.rejects(reader.discover("not-an-address"), /钱包地址/)
  await assert.rejects(reader.discover(member, { maxPages: 0 }), /扫描页数/)
  await assert.rejects(reader.discover(member, { pageSize: 51 }), /分页大小/)
  await assert.rejects(reader.discover(member, { maxOrganizations: 201 }), /候选上限/)
  assert.equal(fake.listEvents.mock.callCount(), 0)
})

test("merge keeps every local group and labels chain-only discoveries", () => {
  const soloOrg = address("a")
  const discovery = {
    organizations: [
      { orgId, groupPk: "aa", epoch: 3, thresholdWeight: 2, memberCount: 5, myWeight: 1, createdTxDigest: digest },
      { orgId: soloOrg, groupPk: "bb", epoch: 1, thresholdWeight: 1, memberCount: 2, myWeight: 1, createdTxDigest: digest },
    ],
    checked: [orgId, otherOrg, soloOrg], scannedEvents: 3, truncated: false, failures: [],
  }
  const rows = mergeDiscoveredGroups([
    { id: "local-1", name: "本机备注群", members: [{ address: member, weight: 1 }], threshold: 1, orgObjectId: orgId },
    { id: "local-2", name: "未关联群", members: [], threshold: 1 },
    { id: "local-3", name: "已退出的群", members: [], orgObjectId: otherOrg },
  ], discovery)

  assert.deepEqual(rows.map(row => row.id), ["local-1", "local-2", "local-3", soloOrg])
  // Local notes stay authoritative for name and members even when chain data exists.
  assert.equal(rows[0].name, "本机备注群")
  assert.equal(rows[0].members.length, 1)
  // Live chain values win for threshold and member count.
  assert.equal(rows[0].threshold, 2)
  assert.equal(rows[0].memberCount, 5)
  assert.equal(rows[0].membership, "confirmed")
  assert.equal(rows[1].membership, "unknown")
  // A local link to an organization the chain says the account is not in is
  // still listed — removal is a user decision, not a discovery side effect.
  assert.equal(rows[2].membership, "not-member")
  assert.match(rows[3].name, /^链上组织 0x/)
  assert.equal(rows[3].origin, "chain")
  assert.deepEqual(rows[3].members, [])
})

test("merge treats an incomplete scan as unknown membership, never as absence", () => {
  const rows = mergeDiscoveredGroups([{ id: "local-1", name: "g", members: [], orgObjectId: orgId }],
    { organizations: [], checked: [], scannedEvents: 0, truncated: true, failures: [] })
  assert.equal(rows[0].membership, "unknown")

  const failed = mergeDiscoveredGroups([{ id: "local-1", name: "g", members: [], orgObjectId: orgId }],
    { organizations: [], checked: [], scannedEvents: 0, truncated: false, failures: [{ orgId, reason: "rpc" }] })
  assert.equal(failed[0].membership, "unknown")

  // With no discovery result at all (RPC failure before any read), the local
  // record is untouched rather than downgraded.
  assert.equal(mergeDiscoveredGroups([{ id: "local-1", name: "g", members: [] }], null)[0].membership, "unknown")
})

test("adopting a discovered organization records chain facts only, never invented notes", () => {
  const org = { orgId, groupPk: "ab".repeat(32), epoch: 7, thresholdWeight: 2, memberCount: 4, myWeight: 1, createdTxDigest: digest }
  const record = discoveredGroupRecord(org, 1_700_000_000_000)
  assert.equal(record.orgObjectId, orgId)
  assert.equal(record.groupPk, org.groupPk)
  assert.equal(record.epoch, 7)
  assert.equal(record.threshold, 2)
  assert.equal(record.sourceStatus, "chain-confirmed")
  assert.equal(record.orgTxDigest, digest)
  assert.deepEqual(record.members, [])
  assert.equal(record.vaultId, undefined)
  assert.equal(record.chain, undefined)
  assert.match(String(record.name), /^链上组织 0x/)
  // The organization ID is the local id, so proposals already saved with
  // `groupId: orgId` keep resolving after adoption.
  assert.equal(record.id, orgId)
  // A stable adopter: the record round-trips through the merge unchanged.
  const [row] = mergeDiscoveredGroups([record], { organizations: [org], checked: [orgId], scannedEvents: 1, truncated: false, failures: [] })
  assert.equal(row.membership, "confirmed")
  assert.equal(row.threshold, 2)
  assert.equal(row.myWeight, 1)
})

test("a group whose chain re-read failed loses its chain-confirmed badge", () => {
  // The badge means "verified against the chain". When the read that would have
  // re-earned it fails, keeping the badge presents a stale trust claim — the
  // same failure `membership` already handles by degrading to "unknown".
  const stored = { id: "local-1", name: "g", members: [], orgObjectId: orgId, sourceStatus: "chain-confirmed" as const }
  const failedRead = mergeDiscoveredGroups([stored],
    { organizations: [], checked: [], scannedEvents: 0, truncated: false, failures: [{ orgId, reason: "rpc" }] })
  assert.equal(failedRead[0].membership, "unknown")
  assert.equal(failedRead[0].sourceStatus, "unverified")

  // A scan that simply did not cover this org is a different case: no read was
  // attempted, so the stored badge stands rather than being invented away.
  const notScanned = mergeDiscoveredGroups([stored],
    { organizations: [], checked: [], scannedEvents: 0, truncated: true, failures: [] })
  assert.equal(notScanned[0].sourceStatus, "chain-confirmed")

  // A successful re-read keeps it, of course.
  const live = mergeDiscoveredGroups([stored], {
    organizations: [{ orgId, groupPk: "aa", epoch: 1, thresholdWeight: 1, memberCount: 1, myWeight: 1, createdTxDigest: "d" }],
    checked: [orgId], scannedEvents: 1, truncated: false, failures: [],
  })
  assert.equal(live[0].sourceStatus, "chain-confirmed")
})
