import assert from "node:assert/strict"
import { test } from "node:test"
import type { SuiClientTypes } from "@mysten/sui/client"
import type { SuiGrpcClient } from "@mysten/sui/grpc"
import { normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils"
import {
  assertRedPacketV2Conservation, buildClaimRedPacketV2, buildCreateRedPacketV2, buildRefundRedPacketV2,
  createRedPacketV2Reader, readRedPacketV2, reconcileRedPacketV2Events, redPacketV2Bcs, redPacketV2EventBcs,
  RedPacketV2AbiError, RedPacketV2UnavailableError, replayRedPacketV2Events, verifyRedPacketV2,
  type CreateRedPacketV2, type RedPacketV2Client, type RedPacketV2State,
} from "./red-packet-v2-chain"

const id = normalizeSuiAddress
const pkg = id("0x999"), origin = id("0x888"), chatOrigin = id("0x777")
const packetId = id("0x10"), channelId = id("0x11"), alice = id("0xa"), bob = id("0xb"), carol = id("0xc")
const sui = normalizeStructTag("0x2::sui::SUI"), token = normalizeStructTag("0x123::token::T")
const deployment = { packageId: pkg, typeOrigin: origin, chatTypeOrigin: chatOrigin }
const local = (name: string) => `${origin}::red_packet::${name}`
const f = (name: string) => normalizeStructTag(`0x2::${name}`)
const objectId = (input: ReturnType<import("@mysten/sui/transactions").Transaction["getData"]>["inputs"][number]) => input.UnresolvedObject?.objectId || input.Object?.SharedObject?.objectId
type Package = NonNullable<Awaited<ReturnType<SuiGrpcClient["movePackageService"]["getPackage"]>>["response"]["package"]>
type Body = NonNullable<Package["modules"][number]["datatypes"][number]["fields"][number]["type"]>

// Wire descriptors use the SDK's protobuf numeric enums; fixtures are local, never RPC execution.
function body(value: string): Body {
  const primitive: Record<string, number> = { address: 1, bool: 2, u64: 6 }
  if (primitive[value]) return { type: primitive[value], typeParameterInstantiation: [] }
  if (value === "$0") return { type: 11, typeParameter: 0, typeParameterInstantiation: [] }
  if (value.startsWith("vector<")) return { type: 9, typeParameterInstantiation: [body(value.slice(7, -1))] }
  const generic = value.indexOf("<")
  return { type: 10, typeName: generic < 0 ? value : value.slice(0, generic), typeParameterInstantiation: generic < 0 ? [] : [body(value.slice(generic + 1, -1))] }
}
const fields = (values: string[]) => values.map((value, position) => {
  const colon = value.indexOf(":")
  return { name: value.slice(0, colon), position, type: body(value.slice(colon + 1)) }
})
function packageFixture(): Package {
  const layouts: Record<string, string[]> = {
    RedPacket: [`id:${f("object::UID")}`, `channel_id:${f("object::ID")}`, "creator:address", `greeting:${normalizeStructTag("0x1::string::String")}`, `escrow:${f("balance::Balance")}<$0>`, "initial_amount:u64", "count:u64", "is_random:bool", "expires_at_ms:u64", `claims:vector<${local("ClaimRecord")}>`, `lifecycle:${local("Lifecycle")}`],
    ClaimRecord: ["recipient:address", "amount:u64", "claimed_at_ms:u64"],
    Created: [`packet_id:${f("object::ID")}`, `channel_id:${f("object::ID")}`, "amount:u64", "count:u64", "is_random:bool", `greeting:${normalizeStructTag("0x1::string::String")}`, "expires_at_ms:u64"],
    Claimed: [`packet_id:${f("object::ID")}`, `channel_id:${f("object::ID")}`, "amount:u64", "claimed_at_ms:u64", "remaining_count:u64", "remaining_balance:u64"],
    Refunded: [`packet_id:${f("object::ID")}`, `channel_id:${f("object::ID")}`, "amount:u64", "refunded_at_ms:u64", "unclaimed_count:u64"],
    Lifecycle: [],
  }
  const datatypes = Object.entries(layouts).map(([name, layout]) => ({ name, module: "red_packet", typeName: local(name), definingId: origin,
    abilities: name === "RedPacket" ? [4] : name === "Lifecycle" ? [2, 3] : name === "ClaimRecord" ? [1, 2, 3] : [1, 2],
    typeParameters: ["RedPacket", "Created", "Claimed", "Refunded"].includes(name) ? [{ isPhantom: true, constraints: [] }] : [],
    kind: name === "Lifecycle" ? 2 : 1, fields: fields(layout), variants: name === "Lifecycle" ? [{ name: "Open", position: 0, fields: [] }, { name: "Refunded", position: 1, fields: fields(["amount:u64"]) }] : [],
  }))
  const channel = `&${chatOrigin}::onchain_chat::ChatChannel`, packet = `&mut ${local("RedPacket")}<$0>`
  const clock = `&${f("clock::Clock")}`, random = `&${f("random::Random")}`, ctx = `&mut ${f("tx_context::TxContext")}`
  const functions: Record<string, string[]> = {
    create: [channel, `${f("coin::Coin")}<$0>`, "u64", "bool", normalizeStructTag("0x1::string::String"), "u64", clock, ctx],
    claim_equal: [packet, channel, clock, ctx], claim_random: [packet, channel, clock, random, ctx], refund: [packet, clock, ctx],
  }
  const signature = (value: string) => ({ reference: value.startsWith("&mut ") ? 2 : value.startsWith("&") ? 1 : 0, body: body(value.replace(/^&mut |^&/, "")) })
  return { storageId: pkg, originalId: id("0x666"), version: 4n, linkage: [],
    typeOrigins: [...datatypes.map(type => ({ moduleName: "red_packet", datatypeName: type.name, packageId: origin })), { moduleName: "onchain_chat", datatypeName: "ChatChannel", packageId: chatOrigin }],
    modules: [{ name: "red_packet", datatypes, functions: Object.entries(functions).map(([name, parameters]) => ({ name, visibility: name === "create" ? 2 : 1, isEntry: name !== "create", typeParameters: [{ constraints: [] }], parameters: parameters.map(signature), returns: name === "create" ? [signature(f("object::ID"))] : [] })) },
      { name: "onchain_chat", functions: [], datatypes: [{ name: "ChatChannel", module: "onchain_chat", typeName: `${chatOrigin}::onchain_chat::ChatChannel`, definingId: chatOrigin, abilities: [4], kind: 1, typeParameters: [], fields: [], variants: [] }] }],
  }
}
const freshState = (): RedPacketV2State => ({ id: packetId, channel_id: channelId, creator: alice, greeting: "恭喜", escrow: "10", initial_amount: "10", count: "3", is_random: false, expires_at_ms: "1000", claims: [], lifecycle: { $kind: "Open", Open: true } })
const input = (): CreateRedPacketV2 => ({ sender: alice, channelId, coinType: sui, amount: 10n, count: 3, isRandom: false, greeting: "恭喜", durationMs: 1000n })
const event = (name: keyof typeof redPacketV2EventBcs, bcs: Uint8Array, sender = alice): SuiClientTypes.EventEntry => ({
  packageId: pkg, module: "red_packet", sender, eventType: normalizeStructTag(`${local(name)}<${sui}>`), bcs, json: null,
  transactionDigest: `digest-${name}`, eventIndex: 0, checkpoint: "1",
})
const created = (channel = channelId, packet = packetId) => event("Created", redPacketV2EventBcs.Created.serialize({ packet_id: packet, channel_id: channel, amount: "10", count: "3", is_random: false, greeting: "恭喜", expires_at_ms: "1000" }).toBytes())
const claimed = () => event("Claimed", redPacketV2EventBcs.Claimed.serialize({ packet_id: packetId, channel_id: channelId, amount: "4", claimed_at_ms: "1000", remaining_count: "2", remaining_balance: "6" }).toBytes(), bob)
const refunded = () => event("Refunded", redPacketV2EventBcs.Refunded.serialize({ packet_id: packetId, channel_id: channelId, amount: "6", refunded_at_ms: "1001", unclaimed_count: "2" }).toBytes())

function fixture() {
  const state = { pkg: packageFixture(), packageError: null as Error | null, objectError: null as Error | null, packageReads: 0,
    pages: [] as SuiClientTypes.ListEventsResponse[], queries: [] as SuiClientTypes.ListEventsOptions[], confirmed: true, timestampMs: 100, digestOverride: "" }
  const objects = new Map<string, { objectId: string; type: string; owner: { $kind: string }; content: Uint8Array }>([
    [packetId, { objectId: packetId, type: normalizeStructTag(`${local("RedPacket")}<${sui}>`), owner: { $kind: "Shared" }, content: redPacketV2Bcs.serialize(freshState()).toBytes() }],
  ])
  const client = {
    movePackageService: { getPackage: async () => { state.packageReads++; if (state.packageError) throw state.packageError; return { response: { package: state.pkg } } } },
    getObject: async ({ objectId }: { objectId: string }) => { if (state.objectError) throw state.objectError; const object = objects.get(objectId); if (!object) throw new Error("missing object"); return { object } },
    listEvents: async (query: SuiClientTypes.ListEventsOptions) => { state.queries.push(query); return state.pages.shift() || { events: [], hasNextPage: false, startCursor: null, endCursor: null } },
    getTransaction: async ({ digest }: { digest: string }) => ({ $kind: "Transaction", Transaction: { digest: state.digestOverride || digest, status: { success: state.confirmed }, timestampMs: state.timestampMs } }),
  } as unknown as RedPacketV2Client
  return { state, objects, client }
}

test("exact ABI derives new defining origin separately from storage and old chat origin", async () => {
  const { client, state } = fixture()
  assert.deepEqual(await verifyRedPacketV2(client, pkg), deployment)
  assert.deepEqual(await verifyRedPacketV2(client, deployment), deployment)
  const reader = createRedPacketV2Reader(client, deployment)
  const before = state.packageReads
  await Promise.all([reader.requireDeployment(), reader.requireDeployment()])
  assert.equal(state.packageReads, before + 1)
  await assert.rejects(verifyRedPacketV2(client, { ...deployment, typeOrigin: id("0x1") }), RedPacketV2AbiError)
})

test("live gRPC descriptor conventions accept storage labels with authoritative defining IDs and absent origin table", async () => {
  const { client, state } = fixture()
  state.pkg.typeOrigins = []
  for (const mod of state.pkg.modules) for (const type of mod.datatypes) type.typeName = `${pkg}::${mod.name}::${type.name}`
  assert.deepEqual(await verifyRedPacketV2(client, deployment), deployment)
  state.pkg.modules[0].datatypes[0].typeName = `${id("0x555")}::red_packet::RedPacket`
  await assert.rejects(verifyRedPacketV2(client, pkg), RedPacketV2AbiError)
})

test("missing module is an explicit deployment gap; transport and ABI errors keep their identity and retry", async () => {
  const { client, state } = fixture(), reader = createRedPacketV2Reader(client, pkg)
  state.pkg.modules = state.pkg.modules.filter(candidate => candidate.name !== "red_packet")
  await assert.rejects(reader.requireDeployment(), RedPacketV2UnavailableError)
  await assert.rejects(verifyRedPacketV2(client), RedPacketV2UnavailableError)
  state.pkg = packageFixture(); state.packageError = new Error("network unavailable")
  await assert.rejects(reader.requireDeployment(), error => error === state.packageError)
  state.packageError = null
  assert.deepEqual(await reader.requireDeployment(), deployment)
})

test("ABI rejects changed field types, positions, origins, phantom flags, enum layout and callable payout returns", async () => {
  const mutations: ((pkg: Package) => void)[] = [
    pkg => { pkg.modules[0].datatypes[0].fields[4].type = body("u64") },
    pkg => { pkg.modules[0].datatypes[0].fields[1].position = 0 },
    pkg => { pkg.modules[0].datatypes[1].definingId = id("0x1") },
    pkg => { pkg.typeOrigins[0].packageId = id("0x1") },
    pkg => { pkg.modules[0].datatypes[0].typeParameters[0].isPhantom = false },
    pkg => { pkg.modules[0].datatypes[5].variants.reverse() },
    pkg => { pkg.modules[0].functions[2].visibility = 2 },
    pkg => { pkg.modules[0].functions[2].returns = [{ body: body("u64") }] },
    pkg => { pkg.modules[0].functions[2].parameters.pop() },
    pkg => { pkg.modules[0].functions.push({ ...pkg.modules[0].functions[1], name: "payout" }) },
    pkg => { pkg.modules[0].datatypes[2].abilities.push(3) },
  ]
  for (const mutate of mutations) { const { client, state } = fixture(); mutate(state.pkg); await assert.rejects(verifyRedPacketV2(client, pkg), RedPacketV2AbiError) }
})

test("create PTB binds generic funding, UTF-8, duration, count and canonical Clock with exact base units", async () => {
  const { client } = fixture()
  const tx = (await buildCreateRedPacketV2(client, pkg, input())).getData()
  assert.equal(tx.sender, alice)
  assert.equal(tx.commands.length, 2)
  assert.equal(tx.commands[0].$kind, "SplitCoins")
  const call = tx.commands[1].MoveCall!
  assert.equal(call.package, pkg); assert.equal(call.module, "red_packet"); assert.equal(call.function, "create")
  assert.deepEqual(call.typeArguments, [sui]); assert.equal(call.arguments.length, 7)
  assert.ok(tx.inputs.some(input => objectId(input) === id("0x6")))
  assert.equal(tx.commands[0].SplitCoins?.coin.$kind, "GasCoin")
  const generic = (await buildCreateRedPacketV2(client, pkg, { ...input(), coinType: token, fundingCoinId: id("0x20") })).getData()
  assert.deepEqual(generic.commands[1].MoveCall?.typeArguments, [token])
  assert.ok(generic.inputs.some(input => input.UnresolvedObject?.objectId === id("0x20")))
  const max = (await buildCreateRedPacketV2(client, pkg, { ...input(), amount: (1n << 64n) - 1n, count: 128, durationMs: 604800000n, greeting: "a".repeat(256) })).getData()
  assert.ok(max.inputs.some(input => input.Pure?.bytes === Buffer.from([255, 255, 255, 255, 255, 255, 255, 255]).toString("base64")))
})

test("claim/refund PTBs expose no payout argument, returned coin transfer, or arbitrary Random/Clock input", async () => {
  const { client } = fixture()
  for (const isRandom of [false, true]) {
    const tx = (await buildClaimRedPacketV2(client, pkg, { sender: bob, packetId, channelId, coinType: sui, isRandom })).getData()
    assert.equal(tx.commands.length, 1); assert.equal(tx.commands[0].MoveCall?.function, isRandom ? "claim_random" : "claim_equal")
    assert.equal(tx.commands[0].MoveCall?.arguments.length, isRandom ? 4 : 3)
    const ids = tx.inputs.map(objectId)
    assert.ok(ids.includes(id("0x6"))); assert.equal(ids.includes(id("0x8")), isRandom)
    assert.equal(tx.inputs.filter(input => input.$kind === "Pure").length, 0)
  }
  const refund = (await buildRefundRedPacketV2(client, pkg, { sender: alice, packetId, coinType: sui })).getData()
  assert.equal(refund.commands.length, 1); assert.equal(refund.commands[0].MoveCall?.function, "refund")
  assert.equal(refund.commands[0].MoveCall?.arguments.length, 2)
  assert.ok(!refund.inputs.some(input => input.UnresolvedObject?.objectId === channelId))
})

test("creation rejects invalid bounds, unpaired UTF-16 surrogates and generic funding omissions", async () => {
  const { client } = fixture()
  for (const change of [{ count: 0 }, { count: 129 }, { count: 1.1 }, { amount: 2n }, { amount: 1n << 64n }, { durationMs: 0n }, { durationMs: 604800001n }, { greeting: "好".repeat(86) }, { greeting: "\ud800" }, { coinType: token }, { sender: "0x0" }]) {
    await assert.rejects(buildCreateRedPacketV2(client, pkg, { ...input(), ...change }))
  }
})

// Independent little-endian BCS fixture, rather than serializing with the decoder under test.
const u64 = (value: bigint) => Buffer.from(value.toString(16).padStart(16, "0").match(/../g)!.reverse().join(""), "hex")
const addr = (value: string) => Buffer.from(value.slice(2), "hex")
const independentPacket = Uint8Array.from(Buffer.concat([
  addr(packetId), addr(channelId), addr(alice), Buffer.from([2, 104, 105]), u64(6n), u64(10n), u64(3n), Buffer.from([0]), u64(1000n),
  Buffer.from([1]), addr(bob), u64(4n), u64(1000n), Buffer.from([0]),
]))

test("reader decodes independent BCS bytes and binds shared ownership, type, object ID, coin and channel", async () => {
  const { client, objects } = fixture(), object = objects.get(packetId)!
  object.content = independentPacket
  const state = await readRedPacketV2(client, pkg, packetId, sui, channelId)
  assert.equal(state.greeting, "hi"); assert.equal(state.escrow, "6"); assert.equal(state.claims[0].amount, "4")
  const reader = createRedPacketV2Reader(client, pkg)
  assert.equal((await reader.readPacket(packetId, channelId)).remainingCount, 2)
  await assert.rejects(reader.readPacket(packetId, id("0x55")))
  await assert.rejects(readRedPacketV2(client, pkg, packetId, token))
  object.owner.$kind = "AddressOwner"; await assert.rejects(reader.readPacket(packetId, channelId)); object.owner.$kind = "Shared"
  object.content = Uint8Array.from([...independentPacket, 0]); await assert.rejects(reader.readPacket(packetId, channelId), /BCS/)
  object.content = redPacketV2Bcs.serialize({ ...freshState(), id: id("0x99") }).toBytes(); await assert.rejects(reader.readPacket(packetId, channelId))
  object.type = normalizeStructTag(`${origin}::red_packet::RedPacket<${sui}>`); await assert.rejects(reader.readPacket(packetId, channelId))
})

test("conservation also rejects wrong equal dust, impossible random bounds, duplicate recipients and exhausted refund", () => {
  const equal = { ...freshState(), escrow: "6", claims: [{ recipient: bob, amount: "4", claimed_at_ms: "1000" }] }
  assert.doesNotThrow(() => assertRedPacketV2Conservation(equal))
  for (const state of [
    { ...equal, escrow: "7", claims: [{ recipient: bob, amount: "3", claimed_at_ms: "1000" }] },
    { ...equal, escrow: "6", claims: [{ recipient: bob, amount: "4", claimed_at_ms: "1001" }] },
    { ...freshState(), is_random: true, escrow: "2", claims: [{ recipient: bob, amount: "8", claimed_at_ms: "100" }] },
    { ...equal, escrow: "3", claims: [...equal.claims, { recipient: bob, amount: "3", claimed_at_ms: "1000" }] },
    { ...freshState(), escrow: "0", claims: [{ recipient: bob, amount: "4", claimed_at_ms: "100" }, { recipient: carol, amount: "3", claimed_at_ms: "100" }, { recipient: alice, amount: "3", claimed_at_ms: "100" }], lifecycle: { $kind: "Refunded" as const, Refunded: { amount: "0" } } },
  ]) assert.throws(() => assertRedPacketV2Conservation(state))
})

test("ordered event replay and reconciliation preserve sender authority, conservation and exact expiry", () => {
  const events = [created(), claimed(), refunded()]
  const state = replayRedPacketV2Events(deployment, sui, events)
  assert.equal(state.creator, alice); assert.equal(state.claims[0].recipient, bob); assert.equal(state.lifecycle.$kind, "Refunded")
  assert.doesNotThrow(() => reconcileRedPacketV2Events(state, deployment, sui, events))
  assert.throws(() => reconcileRedPacketV2Events(freshState(), deployment, sui, events))
  for (const invalid of [[], [claimed()], [created(), created()], [created(), claimed(), claimed()], [created(), claimed(), { ...refunded(), sender: bob }], [...events, claimed()]]) assert.throws(() => replayRedPacketV2Events(deployment, sui, invalid))
  const wrongExpiry = event("Refunded", redPacketV2EventBcs.Refunded.serialize({ packet_id: packetId, channel_id: channelId, amount: "6", refunded_at_ms: "1000", unclaimed_count: "2" }).toBytes())
  assert.throws(() => replayRedPacketV2Events(deployment, sui, [created(), claimed(), wrongExpiry]))
  assert.throws(() => replayRedPacketV2Events(deployment, token, events))
  const wrapped = { ...created(), packageId: id("0x345"), module: "wrapper" }
  assert.equal(replayRedPacketV2Events(deployment, sui, [wrapped]).creator, alice)
})

test("channel-scoped discovery checks creation against current state and confirmed transaction", async () => {
  const { client, state } = fixture(), reader = createRedPacketV2Reader(client, pkg)
  state.pages.push({ events: [created(id("0x55"), id("0x66")), created(), created()], hasNextPage: false, startCursor: null, endCursor: null })
  const result = await reader.readPackets(channelId)
  assert.equal(result.packets.length, 1); assert.equal(result.packets[0].id, packetId); assert.equal(result.packets[0].timestampMs, 100)
  assert.equal(result.truncated, false)
  assert.deepEqual(state.queries[0].filter, { eventType: normalizeStructTag(`${local("Created")}<${sui}>`) })
  state.pages.push({ events: [{ ...created(), sender: bob }], hasNextPage: false, startCursor: null, endCursor: null })
  await assert.rejects(reader.readPackets(channelId), /创建事件/)
  state.confirmed = false; state.pages.push({ events: [created()], hasNextPage: false, startCursor: null, endCursor: null })
  await assert.rejects(reader.readPackets(channelId), /尚未确认/)
  state.confirmed = true; state.digestOverride = "unrelated-digest"
  state.pages.push({ events: [created()], hasNextPage: false, startCursor: null, endCursor: null })
  await assert.rejects(reader.readPackets(channelId), /摘要不匹配/)
  state.digestOverride = ""; state.timestampMs = 8_640_000_000_000_001
  state.pages.push({ events: [created()], hasNextPage: false, startCursor: null, endCursor: null })
  await assert.rejects(reader.readPackets(channelId), /时间无效/)
})

test("event discovery bounds scans, reports truncation and rejects stalled cursors", async () => {
  const { client, state } = fixture(), reader = createRedPacketV2Reader(client, pkg)
  for (let index = 0; index < 8; index++) state.pages.push({ events: [], hasNextPage: true, startCursor: null, endCursor: `cursor-${index}` })
  assert.equal((await reader.readPackets(channelId)).truncated, true)
  assert.equal(state.queries.length, 8)
  state.pages.push({ events: [], hasNextPage: true, startCursor: null, endCursor: "same" }, { events: [], hasNextPage: true, startCursor: null, endCursor: "same" })
  await assert.rejects(reader.readPackets(channelId), /分页/)
})

test("findCreatedPacket skips unrelated types and channels, but propagates RPC errors", async () => {
  const { client, state, objects } = fixture(), reader = createRedPacketV2Reader(client, pkg)
  objects.set(id("0x20"), { objectId: id("0x20"), type: f("coin::Coin") + `<${sui}>`, owner: { $kind: "AddressOwner" }, content: new Uint8Array() })
  objects.set(id("0x21"), { objectId: id("0x21"), type: normalizeStructTag(`${local("RedPacket")}<${sui}>`), owner: { $kind: "Shared" }, content: redPacketV2Bcs.serialize({ ...freshState(), id: id("0x21"), channel_id: id("0x55") }).toBytes() })
  assert.equal((await reader.findCreatedPacket([id("0x20"), id("0x21"), packetId], channelId)).id, packetId)
  await assert.rejects(reader.findCreatedPacket([id("0x21")], channelId), /未找到/)
  state.objectError = new Error("RPC failed")
  await assert.rejects(reader.findCreatedPacket([packetId], channelId), error => error === state.objectError)
})
