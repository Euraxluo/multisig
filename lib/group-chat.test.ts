import assert from "node:assert/strict"
import { test } from "node:test"
import { bcs } from "@mysten/sui/bcs"
import { ObjectError, type SuiClientTypes } from "@mysten/sui/client"
import { normalizeSuiAddress } from "@mysten/sui/utils"
import {
  ChannelContent, ChannelCreatedEvent, MessageEvent,
  CHANNEL_TYPE, createGroupChatReader, formatMist, suiMist, type GroupChatClient,
} from "./group-chat"
import { PROPOSAL_TYPE_ORIGIN } from "./proposal-chain"

const id = (value: number) => normalizeSuiAddress(`0x${value.toString(16)}`)
const channelId = id(1), orgId = id(2), sender = id(4), recipient = id(5)
const bytes = (value: string) => [...new TextEncoder().encode(value)]
const channel = {
  id: channelId, org_id: orgId, name: bytes("朋友"), creator: sender,
  members: { id: id(6), size: "2" }, message_sequence: "5", staked_principal: "0", gas_subsidy_pool: "0",
  total_subsidized_gas: "0", entry_fee: "0", required_member_stake: "0", creator_yield_share_bps: "0",
  gas_subsidy_share_bps: "0", member_rebate_share_bps: "0", members_staked_pool: "0",
  creator_revenue_pool: "0", member_yield_pool: "0", total_staked_members: "0",
}
const fields: Record<string, string[]> = {
  ChatChannel: Object.keys(channel),
  ChatMessageEvent: ["channel_id", "sequence", "sender_master", "sender_agent", "walrus_blob_id", "content_preview", "timestamp_ms"],
  ChannelCreatedWithStakeEvent: ["channel_id", "org_id", "name", "creator", "staked_amount"],
}
const moveType = (module: string, name: string) => `${PROPOSAL_TYPE_ORIGIN}::${module}::${name}`

function fixture() {
  const objects = new Map([
    [channelId, { objectId: channelId, type: CHANNEL_TYPE, content: ChannelContent.serialize(channel).toBytes() }],
  ])
  const requests: SuiClientTypes.ListEventsOptions[] = []
  const lookups: SuiClientTypes.GetDynamicFieldOptions[] = []
  const metadata: string[] = []
  const state = {
    events: [] as SuiClientTypes.EventEntry[],
    page: null as SuiClientTypes.ListEventsResponse | null,
    error: null as Error | null,
    memberError: null as Error | null,
    metadataError: null as Error | null,
    memberType: "bool", memberBytes: bcs.bool().serialize(false).toBytes(),
    definingId: PROPOSAL_TYPE_ORIGIN,
  }
  const client = {
    getObject: async ({ objectId }: { objectId: string }) => {
      if (state.error) throw state.error
      const object = objects.get(objectId)
      if (!object) throw new ObjectError("NOT_FOUND", "missing", { reason: "notFound" })
      return { object }
    },
    getDynamicField: async (options: SuiClientTypes.GetDynamicFieldOptions) => {
      lookups.push(options)
      if (state.memberError) throw state.memberError
      return { dynamicField: { value: { type: state.memberType, bcs: state.memberBytes } } }
    },
    listEvents: async (options: SuiClientTypes.ListEventsOptions) => {
      requests.push(options)
      if (state.error) throw state.error
      return state.page || { events: state.events, hasNextPage: false, endCursor: null }
    },
    listOwnedObjects: async () => ({ objects: [], hasNextPage: false, cursor: null }),
    getMoveFunction: async () => { throw new Error("ABI unavailable") },
    movePackageService: {
      getDatatype: async ({ moduleName, name }: { moduleName: string; name: string }) => {
        metadata.push(name)
        if (state.metadataError) throw state.metadataError
        return { response: { datatype: { definingId: state.definingId, fields: fields[name].map(name => ({ name })), typeName: moveType(moduleName, name) } } }
      },
    },
  } as unknown as GroupChatClient
  return { ...state, state, objects, requests, lookups, metadata, reader: createGroupChatReader(client) }
}
function message(sequence = "1", patch: Record<string, unknown> = {}, index = 0): SuiClientTypes.EventEntry {
  return {
    eventType: moveType("onchain_chat", "ChatMessageEvent"), sender, transactionDigest: `tx-${sequence}`,
    eventIndex: index, bcs: MessageEvent.serialize({ channel_id: channelId, sequence, sender_master: sender, sender_agent: sender,
      walrus_blob_id: [], content_preview: bytes("你好"), timestamp_ms: "100", ...patch }).toBytes(),
  } as SuiClientTypes.EventEntry
}

test("SUI amount conversion is exact and bounded", () => {
  assert.equal(suiMist("1.000000001"), 1_000_000_001n)
  assert.equal(formatMist("18446744073709551615"), "18446744073.709551615")
  assert.equal(suiMist("18446744073.709551615"), (1n << 64n) - 1n)
  for (const invalid of ["0", "18446744073.709551616", "1.0000000001", "1e-3", "-1", "NaN"]) assert.throws(() => suiMist(invalid))
  assert.equal(suiMist("0", true), 0n)
})

test("channel membership uses table presence with exact address BCS and type", async () => {
  const { reader, lookups } = fixture()
  const result = await reader.readChannel(channelId, orgId, recipient)
  assert.equal(result.isMember, true)
  assert.equal(result.name, "朋友")
  assert.equal(lookups[0].parentId, id(6))
  assert.equal(bcs.Address.parse(lookups[0].name.bcs), recipient)
  assert.equal(lookups[0].name.type, "address")
})

test("only typed missing membership maps to nonmember and transport failures propagate", async () => {
  const { reader, state } = fixture()
  state.memberError = new ObjectError("NOT_FOUND", "missing", { reason: "notFound" })
  assert.equal((await reader.readChannel(channelId, orgId, recipient)).isMember, false)
  state.memberError = new Error("network offline")
  await assert.rejects(reader.readChannel(channelId, orgId, recipient), /network offline/)
  state.memberError = null
  state.memberType = "u64"
  await assert.rejects(reader.readChannel(channelId, orgId, recipient), /成员表类型/)
})

test("channel rejects wrong identity, group, BCS and datatype origin and retries metadata outages", async () => {
  const { reader, objects, state, metadata } = fixture()
  await assert.rejects(reader.readChannel(channelId, id(99)), /群组不匹配/)
  objects.set(channelId, { objectId: channelId, type: CHANNEL_TYPE, content: ChannelContent.serialize({ ...channel, id: id(99) }).toBytes() })
  await assert.rejects(reader.readChannel(channelId, orgId), /群组不匹配/)
  const second = fixture()
  second.state.metadataError = new Error("metadata unavailable")
  await assert.rejects(second.reader.readChannel(channelId, orgId), /metadata unavailable/)
  second.state.metadataError = null
  second.state.definingId = id(99)
  await assert.rejects(second.reader.readChannel(channelId, orgId), /数据类型不兼容/)
  second.state.definingId = PROPOSAL_TYPE_ORIGIN
  assert.equal((await second.reader.readChannel(channelId, orgId)).id, channelId)
  assert.equal(second.metadata.length, 3)
  state.error = new Error("object offline")
  await assert.rejects(reader.readChannel(channelId, orgId), /object offline/)
  assert.equal(metadata.length, 1)
})

test("messages filter exact type and channel, deduplicate receipts and sort u64 sequences", async () => {
  const { reader, state, requests } = fixture()
  const one = message("9007199254740993")
  state.events = [message("9007199254740994"), one, one, message("1", { channel_id: id(90) }), { ...message("2"), eventType: `${id(99)}::onchain_chat::ChatMessageEvent` }]
  const result = await reader.readMessages(channelId)
  assert.deepEqual(result.messages.map(value => value.sequence), ["9007199254740993", "9007199254740994"])
  assert.equal(result.messages[0].text, "你好")
  assert.equal(requests[0].filter?.eventType, moveType("onchain_chat", "ChatMessageEvent"))
})

test("messages reject forged sender, zero sequence, unsafe time and invalid UTF8", async () => {
  for (const event of [{ ...message(), sender: recipient }, message("0"), message("1", { timestamp_ms: "9007199254740992" }), message("1", { content_preview: [255] })]) {
    const { reader, state } = fixture()
    state.events = [event]
    await assert.rejects(reader.readMessages(channelId))
  }
})

test("event pagination rejects cycles, propagates failures and reports bounded history", async () => {
  const { reader, state, requests } = fixture()
  state.page = { events: [], hasNextPage: true, startCursor: "cycle", endCursor: "cycle" }
  await assert.rejects(reader.readMessages(channelId), /分页未前进/)
  assert.equal(requests.length, 2)
  state.page = null
  state.error = new Error("events offline")
  await assert.rejects(reader.readMessages(channelId), /events offline/)
})

test("channel discovery checks creation sender and selected organization", async () => {
  const { reader, state } = fixture()
  const event = { eventType: moveType("onchain_chat", "ChannelCreatedWithStakeEvent"), sender,
    bcs: ChannelCreatedEvent.serialize({ channel_id: channelId, org_id: orgId, name: bytes("朋友"), creator: sender, staked_amount: "0" }).toBytes() } as SuiClientTypes.EventEntry
  state.events = [event, event]
  assert.deepEqual((await reader.discoverChannels(orgId)).ids, [channelId])
  assert.deepEqual((await reader.discoverChannels(id(99))).ids, [])
  state.events = [{ ...event, sender: recipient }]
  await assert.rejects(reader.discoverChannels(orgId), /签名者不匹配/)
})

test("unavailable deployed function checks do not silently allow transaction submission", async () => {
  const { reader } = fixture()
  await assert.rejects(reader.ensureFunction("post_message"), /ABI unavailable/)
  await assert.rejects(reader.ensureFunction("post_message"), /ABI unavailable/)
})

test("the burst probe selects the batch entry only when the deployed ABI matches it", async () => {
  const dt = (name: string, generic = false) => ({ $kind: "datatype", datatype: { typeName: name, typeParameters: generic ? [{ $kind: "typeParameter", index: 0 }] : [] } })
  const param = (body: object, reference: string | null = null) => ({ body, reference })
  const bytes = { $kind: "vector", vector: { $kind: "u8" } }
  const batch = [param(dt(CHANNEL_TYPE), "mutable"), param(dt("0x2::clock::Clock"), "immutable"), param({ $kind: "vector", vector: bytes }), param({ $kind: "vector", vector: bytes }), param(dt("0x2::tx_context::TxContext"), "mutable")]
  const deployed: Record<string, { visibility: string; typeParameters: object[]; parameters: object[]; returns: object[] }> = {
    post_message_batch: { visibility: "public", typeParameters: [], parameters: batch, returns: [] },
    post_message: { visibility: "public", typeParameters: [], parameters: [param(dt(CHANNEL_TYPE), "mutable"), param(dt("0x2::clock::Clock"), "immutable"), param(bytes), param(bytes), param(dt("0x2::tx_context::TxContext"), "mutable")], returns: [] },
  }
  let abi = deployed
  const client = { getMoveFunction: async ({ name }: { name: string }) => { const fn = abi[name]; if (!fn) throw new Error("Function not found"); return { function: { name, ...fn } } } } as unknown as GroupChatClient
  const reader = createGroupChatReader(client)
  assert.equal(await reader.supportsFunction("post_message_batch"), true)
  // A package published before the batch entry: probing it must select the fallback, not throw.
  abi = { post_message: deployed.post_message }
  const older = createGroupChatReader(client)
  assert.equal(await older.supportsFunction("post_message_batch"), false)
  assert.equal(await older.supportsFunction("post_message"), true)
  // A transport failure degrades to the fallback rather than blocking the burst.
  const offline = createGroupChatReader({ getMoveFunction: async () => { throw new Error("network down") } } as unknown as GroupChatClient)
  assert.equal(await offline.supportsFunction("post_message_batch"), false)
  // An ABI that differs from the source signature must not be trusted with a batch call.
  abi = { post_message_batch: { ...deployed.post_message_batch, parameters: [param(dt(CHANNEL_TYPE), "mutable"), param(bytes), param(bytes), param(dt("0x2::tx_context::TxContext"), "mutable")] } }
  assert.equal(await createGroupChatReader(client).supportsFunction("post_message_batch"), false)
})

test("channel selection migrates a legacy package-scoped key to the stable key", async () => {
  const { chatChannelStorageKey, legacyChatChannelStorageKeys, readStoredChatChannel } = await import("./group-chat")
  const store = new Map<string, string>()
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value) },
    removeItem: (key: string) => { store.delete(key) },
  }
  const selected = id(9)
  store.set(legacyChatChannelStorageKeys(orgId)[0], selected)
  assert.equal(readStoredChatChannel(storage, orgId), selected)
  assert.equal(store.get(chatChannelStorageKey(orgId)), selected)
  assert.equal(store.has(legacyChatChannelStorageKeys(orgId)[0]), false)
  // The stable key wins once it exists; no legacy read overrides a newer choice.
  const newer = id(10)
  store.set(chatChannelStorageKey(orgId), newer)
  assert.equal(readStoredChatChannel(storage, orgId), newer)
  assert.equal(readStoredChatChannel(storage, id(11)), null)
})
