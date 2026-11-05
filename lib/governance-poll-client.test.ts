import assert from "node:assert/strict"
import { test, beforeEach } from "node:test"
import { normalizeSuiAddress } from "@mysten/sui/utils"
import { POLL_FIELDS, POLL_FIELD_TYPES, PollContent, preparePollPublication, buildPublishPoll, buildCastPollBallot, validatePollBallot, pollScores, pollVoteView, createPollReader, pollLinks, rememberPoll, POLL_LINKS_KEY, type PollDraft, type PollSnapshot } from "./governance-poll-client"
import { proposalClient } from "./proposal-chain"

const addr = normalizeSuiAddress
const alice = addr("0xa"), bob = addr("0xb"), pollId = addr("0x10"), pkg = addr("0x999")
const now = 1_000_000
const draft = (patch: Partial<PollDraft> = {}): PollDraft => ({ title: "预算", description: "说明", voteType: "single", options: [{ id: "a", text: "A" }, { id: "b", text: "B" }, { id: "c", text: "C" }], voters: [{ address: alice, weight: 3 }, { address: bob, weight: 2 }], expiresAt: new Date(now + 1000).toISOString(), ...patch })
const snapshot = (patch: Partial<PollSnapshot> = {}): PollSnapshot => ({ id: pollId, creator: alice, title: "预算", description: "公开说明", options: ["A", "B", "C"], mode: 0, electorate: [alice, bob], weights: ["3", "2"], ballots: [[], []], cast_at_ms: ["0", "0"], deadline_ms: String(now + 1000), org_id: null, org_epoch: "0", group_voter_count: "0", show_results_during: false, allow_link_access: true, ...patch })
const values = new Map<string, string>()
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } } })
Object.defineProperty(globalThis, "window", { configurable: true, value: { dispatchEvent() {} } })
beforeEach(() => values.clear())

test("policy preparation preserves exact public mode and rejects every unsupported policy without silently downgrading", () => {
  for (const voteType of ["single", "multiple", "ranked"]) assert.equal(preparePollPublication(draft({ voteType }), now).mode, ["single", "multiple", "ranked"].indexOf(voteType))
  for (const patch of [{ weightType: "token" }, { weightType: "nft" }, { isAnonymous: true }, { isTimeLockedSeal: true }, { createTransaction: true }]) assert.throws(() => preparePollPublication(draft(patch), now), /尚未/)
  assert.throws(() => preparePollPublication(draft({ voters: [{ address: "person@example.com", weight: 3 }] }), now), /地址/)
  assert.throws(() => preparePollPublication(draft({ voters: [{ address: "0xa", weight: 1 }, { address: alice, weight: 3 }] }), now), /重复/)
  assert.throws(() => preparePollPublication(draft({ options: [{ id: "a", text: "重复" }, { id: "b", text: "重复" }] }), now), /不同/)
  assert.throws(() => preparePollPublication(draft({ expiresAt: new Date(now).toISOString() }), now), /截止时间/)
  assert.throws(() => preparePollPublication(draft({ voters: [{ address: alice, weight: 1.5 }] }), now), /安全整数/)
})

test("group and hybrid roster preparation uses chain weights and rejects stale/nonmember group entries", () => {
  const publication = preparePollPublication(draft({ voterSource: "group", orgId: "0x20", groupMembers: { [alice]: 7, [bob]: 9 } }), now)
  assert.deepEqual(publication.weights, [7, 9])
  assert.deepEqual(publication.groupVoters, [alice, bob])
  assert.deepEqual(publication.manualVoters, [])
  assert.throws(() => preparePollPublication(draft({ voterSource: "group", orgId: "0x20", groupMembers: { [alice]: 7 } }), now), /名册/)
  const hybrid = preparePollPublication(draft({ voterSource: "hybrid", orgId: "0x20", groupMembers: { [bob]: 9 } }), now)
  assert.deepEqual(hybrid.groupVoters, [bob]); assert.deepEqual(hybrid.manualVoters, [alice]); assert.deepEqual(hybrid.manualWeights, [3])
})

test("PTBs publish then share a real object, and cast only chosen indices against Clock", () => {
  const publication = preparePollPublication(draft(), now)
  const commands = buildPublishPoll(publication, pkg).getData().commands
  assert.deepEqual(commands.map(command => command.MoveCall?.function), ["new_manual", "share"])
  assert.equal(commands[1].MoveCall?.arguments[0].$kind, "Result")
  const group = preparePollPublication(draft({ voterSource: "group", orgId: "0x20", groupMembers: { [alice]: 7, [bob]: 9 } }), now)
  assert.equal(buildPublishPoll(group, pkg).getData().commands[0].MoveCall?.function, "new_group")
  const ballot = buildCastPollBallot(pollId, [2, 0, 1], pkg).getData()
  assert.equal(ballot.commands.length, 1)
  assert.equal(ballot.commands[0].MoveCall?.function, "cast_ballot")
  assert.equal(ballot.commands[0].MoveCall?.package, pkg)
  assert.equal(ballot.commands[0].MoveCall?.arguments.length, 3)
})

test("ballot guards pin exclusive deadline, member identity, duplicates and full rankings", () => {
  assert.equal(validatePollBallot(snapshot(), "0xa", [1], now + 999), 0)
  assert.throws(() => validatePollBallot(snapshot(), alice, [1], now + 1000), /截止/)
  assert.throws(() => validatePollBallot(snapshot(), "0xe", [1], now), /名册/)
  assert.throws(() => validatePollBallot(snapshot({ ballots: [["1"], []] }), alice, [99], now), /已经投票/)
  for (const choices of [[], [0, 1], [3], [-1], [0.5]]) assert.throws(() => validatePollBallot(snapshot(), alice, choices, now), /选票/)
  assert.throws(() => validatePollBallot(snapshot({ mode: 1 }), alice, [1, 1], now), /选票/)
  assert.throws(() => validatePollBallot(snapshot({ mode: 2 }), alice, [1, 0], now), /排序票/)
  assert.equal(validatePollBallot(snapshot({ mode: 2 }), alice, [2, 1, 0], now), 0)
})

test("views compute approval and Borda scores from exact chain ballots, expose ties and no fabricated receipt", () => {
  const single = snapshot({ ballots: [["1"], ["0"]], cast_at_ms: ["100", "200"] })
  assert.deepEqual(pollScores(single), [2, 3, 0])
  const view = pollVoteView(single, "0xa", now)
  assert.equal(view.source, "shared-poll"); assert.equal(view.hasVoted, true)
  assert.equal(view.weights.total, 5); assert.equal(view.weights.voted, 5)
  assert.deepEqual(view.myVoteOptionIds, ["option-1"])
  assert.equal(view.record, undefined)
  assert.deepEqual(pollScores(snapshot({ mode: 1, ballots: [["0", "2"], ["2"]] })), [3, 0, 5])
  assert.deepEqual(pollScores(snapshot({ mode: 2, ballots: [["2", "0", "1"], ["1", "0", "2"]] })), [5, 4, 6])
  assert.match(pollVoteView(snapshot({ weights: ["2", "2"], ballots: [["1"], ["0"]] }), "", now + 1000).result ?? "", /并列领先/)
  assert.equal(pollVoteView(snapshot(), "", now + 1000).result, "无人投票")
})

test("object link hints are never proof of voting and malformed historical stores are preserved", () => {
  values.set(POLL_LINKS_KEY, JSON.stringify(["0x10", pollId, "broken"]))
  assert.deepEqual(pollLinks(), [pollId])
  rememberPoll("0x20")
  assert.equal(pollLinks().length, 2)
  values.set(POLL_LINKS_KEY, '{"history":true}')
  assert.throws(() => rememberPoll("0x30"), /原数据/)
  assert.equal(values.get(POLL_LINKS_KEY), '{"history":true}')
})

// Independent raw protobuf ABI fixture; numeric type enums come from the pinned
// installed Sui protocol definition, rather than the reader's decoder.
function rawType(type: string): any {
  if (type.startsWith("vector<")) return { type: 9, typeParameterInstantiation: [rawType(type.slice(7, -1))] }
  const primitive = ({ address: 1, bool: 2, u8: 3, u64: 6 } as Record<string, number>)[type]
  if (primitive) return { type: primitive, typeParameterInstantiation: [] }
  const [name, args] = type.split("<")
  return { type: 10, typeName: name, typeParameterInstantiation: args ? [rawType(args.slice(0, -1))] : [] }
}
function fixtureClient(poll = snapshot()) {
  const descriptor = { typeName: `${pkg}::governance_poll::Poll`, definingId: pkg, module: "governance_poll", name: "Poll", kind: 1, abilities: [4], typeParameters: [], variants: [], fields: POLL_FIELDS.map((name, index) => ({ name, position: index, type: rawType(POLL_FIELD_TYPES[index]) })) }
  let owner: any = { $kind: "Shared", Shared: { initialSharedVersion: "1" } }
  let type = descriptor.typeName
  const client = {
    getObject: async () => ({ object: { objectId: pollId, type, owner, content: PollContent.serialize(poll).toBytes() } }),
    getMoveFunction: async () => { throw new Error("Unexpected function call") },
    movePackageService: { getDatatype: async () => ({ response: { datatype: descriptor } }) },
  } as unknown as Pick<typeof proposalClient, "getObject" | "getMoveFunction" | "movePackageService">
  return { descriptor, client, setOwner(value: any) { owner = value }, setType(value: string) { type = value } }
}

test("raw shared object reader resolves added-module type origins and rejects wrong owner, type, ABI and malformed ballots", async () => {
  const fixture = fixtureClient()
  const reader = createPollReader(fixture.client, pkg)
  assert.deepEqual(await reader.readPoll(pollId), snapshot())
  fixture.setOwner({ $kind: "AddressOwner", AddressOwner: alice })
  await assert.rejects(reader.readPoll(pollId), /共享治理/)
  fixture.setOwner({ $kind: "Shared", Shared: { initialSharedVersion: "1" } }); fixture.setType(`${pkg}::other::Poll`)
  await assert.rejects(reader.readPoll(pollId), /共享治理/)
  const wrongAbi = fixtureClient(); wrongAbi.descriptor.fields[5].type = rawType("u64")
  await assert.rejects(createPollReader(wrongAbi.client, pkg).readPoll(pollId), /布局/)
  const invalid = fixtureClient(snapshot({ mode: 2, ballots: [["0", "0", "1"], []] }))
  await assert.rejects(createPollReader(invalid.client, pkg).readPoll(pollId), /选票/)
})

test("compatible upgrades use definingId when metadata labels Poll with the storage package", async () => {
  const origin = addr("0x888")
  const fixture = fixtureClient()
  fixture.descriptor.definingId = origin
  fixture.setType(`${origin}::governance_poll::Poll`)
  const reader = createPollReader(fixture.client, pkg)
  assert.equal(await reader.pollType(), `${origin}::governance_poll::Poll`)
  assert.deepEqual(await reader.readPoll(pollId), snapshot())
  for (const mutate of [
    (f: ReturnType<typeof fixtureClient>) => { f.descriptor.typeName = `${alice}::governance_poll::Poll` },
    (f: ReturnType<typeof fixtureClient>) => { f.descriptor.abilities = [1] },
    (f: ReturnType<typeof fixtureClient>) => { f.descriptor.fields[0].position = 1 },
    (f: ReturnType<typeof fixtureClient>) => { f.descriptor.definingId = "" },
  ]) {
    const bad = fixtureClient(); mutate(bad)
    await assert.rejects(createPollReader(bad.client, pkg).pollType())
  }
})

test("deployment failures propagate before signing and are retriable rather than cached as unsupported", async () => {
  const fixture = fixtureClient()
  const client = fixture.client
  const original = client.movePackageService.getDatatype
  let calls = 0
  client.movePackageService.getDatatype = ((...args: Parameters<typeof original>) => {
    calls++
    if (calls === 1) return Promise.reject(new Error("RPC unavailable"))
    return original(...args)
  }) as typeof original
  const reader = createPollReader(client, pkg)
  await assert.rejects(reader.pollType(), /RPC unavailable/)
  assert.equal(await reader.pollType(), `${pkg}::governance_poll::Poll`)
  assert.equal(calls, 2)
})
