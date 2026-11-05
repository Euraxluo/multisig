import assert from "node:assert/strict"
import { test } from "node:test"
import { normalizeSuiAddress } from "@mysten/sui/utils"
import type { SuiClientTypes } from "@mysten/sui/client"
import { GroupPollPublished, createGroupPollReader, groupPollObjectId, resolveGroupPollScope } from "./group-polls"
import { OrganizationContent, PROPOSAL_TYPE_ORIGIN, proposalClient } from "./proposal-chain"
import { preparePollPublication, type PollSnapshot } from "./governance-poll-client"

const id = (value: number) => normalizeSuiAddress(`0x${value.toString(16)}`)
const orgId = id(1), otherOrg = id(2), pollId = id(3), creator = id(4), voter = id(5), tableId = id(6), pkg = id(9)
const pollType = `${pkg}::governance_poll::Poll`, eventType = `${pkg}::governance_poll::PollPublished`
function snapshot(patch: Partial<PollSnapshot> = {}): PollSnapshot {
  return { id: pollId, creator, title: "真实群投票", description: "咨询意见", options: ["赞成", "保留"], mode: 0,
    electorate: [creator, voter], weights: ["7", "3"], ballots: [[], ["1"]], cast_at_ms: ["0", "100"],
    deadline_ms: String(Date.now() + 60_000), org_id: orgId, org_epoch: "2", group_voter_count: "2", show_results_during: true, allow_link_access: true, ...patch }
}
function event(poll: PollSnapshot): SuiClientTypes.EventEntry {
  return { eventType, packageId: pkg, module: "governance_poll", json: null, sender: poll.creator, bcs: GroupPollPublished.serialize({ ...poll, poll_id: poll.id }).toBytes(),
    transactionDigest: "confirmed-publication", eventIndex: 0, checkpoint: "10" }
}
function fixture(initial = snapshot()) {
  const org = { id: orgId, group_pk: [], threshold_weight: "7", epoch_version: "2", last_nonce: "0", chain_id: [],
    members_weight: { id: tableId, size: "2" }, executed_proposals: { id: id(7), size: "0" } }
  const state = { orgType: `${PROPOSAL_TYPE_ORIGIN}::cryptographic_org::Organization`, owner: { $kind: "Shared" } as { $kind: string },
    weights: { [creator]: 7, [voter]: 3 }, pollTypeError: null as Error | null, eventError: null as Error | null,
    pages: [{ events: [event(initial)], hasNextPage: false, endCursor: null, startCursor: null }] as SuiClientTypes.ListEventsResponse[] }
  const objects = new Map<string, PollSnapshot | Error>([[initial.id, initial]])
  const requests: SuiClientTypes.ListEventsOptions[] = []
  const weightRequests: string[] = []
  const client = {
    getObject: async ({ objectId }: { objectId: string }) => ({ object: { objectId, type: state.orgType, owner: state.owner, content: OrganizationContent.serialize(org).toBytes() } }),
    listEvents: async (options: SuiClientTypes.ListEventsOptions) => {
      requests.push(options)
      if (state.eventError) throw state.eventError
      return state.pages[Math.min(requests.length - 1, state.pages.length - 1)]
    },
  } as unknown as Pick<typeof proposalClient, "getObject" | "listEvents">
  const reader = createGroupPollReader(client, {
    pollType: async () => { if (state.pollTypeError) throw state.pollTypeError; return pollType },
    readPoll: async objectId => {
      const poll = objects.get(objectId)
      if (poll instanceof Error) throw poll
      if (!poll) throw new Error("Object not found")
      return poll
    },
  }, async table => { weightRequests.push(table); return state.weights })
  return { reader, state, org, objects, requests, weightRequests, initial }
}

test("group context uses its canonical organization link and rejects cross-group IDs or absent bindings", () => {
  const groups = [{ id: "local-group", name: "DAO", orgObjectId: "0x1" }]
  assert.deepEqual(resolveGroupPollScope("local-group", orgId, groups), { groupId: "local-group", name: "DAO", orgId })
  assert.equal(resolveGroupPollScope("local-group", undefined, groups).orgId, orgId)
  assert.equal(resolveGroupPollScope(undefined, "0x1", []).orgId, orgId)
  assert.equal(resolveGroupPollScope("0x1", undefined, []).orgId, orgId)
  assert.throws(() => resolveGroupPollScope("local-group", otherOrg, groups), /不一致/)
  assert.throws(() => resolveGroupPollScope("unknown", undefined, groups), /DKG/)
  for (const bad of ["0x0", "0x", "walrus.wma", "0xzz", `0x${"f".repeat(65)}`]) assert.throws(() => groupPollObjectId(bad), /对象 ID/)
})

test("group creation electorate comes from the exact shared Organization and chain weight table", async () => {
  const f = fixture()
  const org = await f.reader.readOrganization("0x1")
  assert.equal(org.id, orgId); assert.equal(org.epoch, "2")
  assert.deepEqual(f.weightRequests, [tableId])
  const publication = preparePollPublication({ title: "群投票", voteType: "single", options: [{ id: "a", text: "A" }, { id: "b", text: "B" }],
    voters: Object.entries(org.members).map(([address]) => ({ address, weight: 999 })), voterSource: "group", orgId: org.id, groupMembers: org.members,
    expiresAt: new Date(Date.now() + 60_000).toISOString() })
  assert.deepEqual(publication.weights, [7, 3]); assert.deepEqual(publication.manualVoters, [])
  f.org.members_weight.size = "3"
  await assert.rejects(f.reader.readOrganization(orgId), /未完整/)
  f.org.members_weight.size = "2"; f.state.weights[voter] = 0
  await assert.rejects(f.reader.readOrganization(orgId), /权重无效/)
})

test("organization type, owner and object identity must match before any roster is accepted", async () => {
  const f = fixture()
  f.state.orgType = `${pkg}::cryptographic_org::Organization`
  await assert.rejects(f.reader.readOrganization(orgId), /共享组织/)
  f.state.orgType = `${PROPOSAL_TYPE_ORIGIN}::cryptographic_org::Organization`; f.state.owner = { $kind: "AddressOwner" }
  await assert.rejects(f.reader.readOrganization(orgId), /共享组织/)
  f.state.owner = { $kind: "Shared" }; f.org.id = otherOrg
  await assert.rejects(f.reader.readOrganization(orgId), /ID 不匹配/)
  assert.deepEqual(f.weightRequests, [])
})

test("empty-browser discovery uses the added-module type origin and reads actual ballots and weights", async () => {
  const f = fixture()
  const result = await f.reader.listPolls("0x1", voter)
  assert.equal(f.requests[0].filter?.eventType, eventType)
  assert.equal(f.requests[0].order, "descending")
  assert.equal(result.votes.length, 1); assert.equal(result.truncated, false)
  assert.deepEqual(result.failures, [])
  const view = result.votes[0]
  assert.equal(view.source, "shared-poll"); assert.equal(view.totalVotes, 1); assert.equal(view.hasVoted, true)
  assert.deepEqual(view.options.map(option => option.votes), [0, 3])
  assert.equal(view.weights.voted, 3); assert.equal(view.creator?.address, creator)
  assert.equal(view.record, undefined)
})

test("events and saved ID hints cannot attach manual polls or another organization's polls to a group", async () => {
  const f = fixture()
  const other = snapshot({ id: id(11), org_id: otherOrg }), manual = snapshot({ id: id(12), org_id: null, group_voter_count: "0" })
  f.objects.set(other.id, other); f.objects.set(manual.id, manual)
  f.state.pages[0].events.push(event(other), event(manual))
  const result = await f.reader.listPolls(orgId, "", [other.id, manual.id, "not-an-id", pollId, "0x3"])
  assert.deepEqual(result.votes.map(vote => vote.id), [pollId])
  await assert.rejects(f.reader.readPoll(other.id, orgId), /不属于/)
  await assert.rejects(f.reader.readPoll(manual.id, orgId), /不属于/)
  assert.equal((await f.reader.readPoll(pollId, orgId)).id, pollId)
})

test("publication sender and immutable settings are checked against the shared poll object", async () => {
  for (const tamper of ["sender", "title", "org"] as const) {
    const f = fixture()
    if (tamper === "sender") f.state.pages[0].events[0].sender = voter
    else f.objects.set(pollId, { ...f.initial, ...(tamper === "title" ? { title: "伪造" } : { org_id: otherOrg }) })
    const result = await f.reader.listPolls(orgId)
    assert.deepEqual(result.votes, []); assert.equal(result.failures.length, 1)
    assert.match(result.failures[0].error, /不一致/)
  }
})

test("an empty scan-limited page advances the cursor and duplicate events do not duplicate polls", async () => {
  const f = fixture()
  f.state.pages = [{ events: [], hasNextPage: true, endCursor: "cursor-1", startCursor: null },
    { events: [event(f.initial), event(f.initial)], hasNextPage: false, endCursor: "cursor-2", startCursor: null }]
  const result = await f.reader.listPolls(orgId)
  assert.equal(f.requests[1].before, "cursor-1"); assert.equal(result.votes.length, 1)
  assert.equal(result.discoveryError, undefined); assert.equal(result.truncated, false)
})

test("pagination bounds and repeated cursors expose incomplete discovery while valid objects remain readable", async () => {
  const repeated = fixture()
  repeated.state.pages = [{ events: [event(repeated.initial)], hasNextPage: true, endCursor: "same", startCursor: null }]
  const result = await repeated.reader.listPolls(orgId)
  assert.equal(repeated.requests.length, 2); assert.equal(result.truncated, true); assert.match(result.discoveryError || "", /未前进/)
  assert.equal(result.votes.length, 1)
  const bounded = fixture()
  bounded.state.pages = Array.from({ length: 8 }, (_, index) => ({ events: [], hasNextPage: true, endCursor: `cursor-${index}`, startCursor: null }))
  assert.equal((await bounded.reader.listPolls(orgId)).truncated, true); assert.equal(bounded.requests.length, 8)
})

test("RPC, ABI and individual poll failures cannot become an empty success or invented result", async () => {
  const f = fixture()
  f.state.eventError = new Error("RPC offline")
  const fallback = await f.reader.listPolls(orgId, "", [pollId])
  assert.equal(fallback.discoveryError, "RPC offline"); assert.equal(fallback.truncated, true); assert.equal(fallback.votes.length, 1)
  f.state.eventError = null; f.objects.set(pollId, new Error("Object read failed"))
  const failed = await f.reader.listPolls(orgId)
  assert.deepEqual(failed.votes, []); assert.deepEqual(failed.failures, [{ id: pollId, error: "Object read failed" }])
  f.state.pollTypeError = new Error("ABI unavailable")
  await assert.rejects(f.reader.listPolls(orgId), /ABI unavailable/)
})
