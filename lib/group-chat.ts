import { bcs } from "@mysten/sui/bcs"
import { ObjectError, type SuiClientTypes } from "@mysten/sui/client"
import { MIST_PER_SUI, normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils"
import { PROPOSAL_PACKAGE_ID, PROPOSAL_TYPE_ORIGIN, proposalClient } from "./proposal-chain"
import { t } from "@/lib/i18n/t"

const Table = bcs.struct("Table", { id: bcs.Address, size: bcs.u64() })
export const ChannelContent = bcs.struct("ChatChannel", {
  id: bcs.Address, org_id: bcs.Address, name: bcs.vector(bcs.u8()), creator: bcs.Address,
  members: Table, message_sequence: bcs.u64(), staked_principal: bcs.u64(), gas_subsidy_pool: bcs.u64(),
  total_subsidized_gas: bcs.u64(), entry_fee: bcs.u64(), required_member_stake: bcs.u64(),
  creator_yield_share_bps: bcs.u64(), gas_subsidy_share_bps: bcs.u64(), member_rebate_share_bps: bcs.u64(),
  members_staked_pool: bcs.u64(), creator_revenue_pool: bcs.u64(), member_yield_pool: bcs.u64(), total_staked_members: bcs.u64(),
})
export const MessageEvent = bcs.struct("ChatMessageEvent", {
  channel_id: bcs.Address, sequence: bcs.u64(), sender_master: bcs.Address, sender_agent: bcs.Address,
  walrus_blob_id: bcs.vector(bcs.u8()), content_preview: bcs.vector(bcs.u8()), timestamp_ms: bcs.u64(),
})
export const ChannelCreatedEvent = bcs.struct("ChannelCreatedWithStakeEvent", {
  channel_id: bcs.Address, org_id: bcs.Address, name: bcs.vector(bcs.u8()), creator: bcs.Address, staked_amount: bcs.u64(),
})
const ReceiptContent = bcs.struct("MemberStakeReceipt", { id: bcs.Address, channel_id: bcs.Address, member: bcs.Address, staked_amount: bcs.u64() })
const text = (bytes: number[]) => new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes))
const type = (module: string, name: string) => `${PROPOSAL_TYPE_ORIGIN}::${module}::${name}`
export const CHANNEL_TYPE = type("onchain_chat", "ChatChannel")
const CHANNEL_FIELDS = ["id", "org_id", "name", "creator", "members", "message_sequence", "staked_principal", "gas_subsidy_pool", "total_subsidized_gas", "entry_fee", "required_member_stake", "creator_yield_share_bps", "gas_subsidy_share_bps", "member_rebate_share_bps", "members_staked_pool", "creator_revenue_pool", "member_yield_pool", "total_staked_members"]
const CHANNEL_CREATED_FIELDS = ["channel_id", "org_id", "name", "creator", "staked_amount"]
const MESSAGE_FIELDS = ["channel_id", "sequence", "sender_master", "sender_agent", "walrus_blob_id", "content_preview", "timestamp_ms"]
const integer = (value: string) => {
  const result = Number(value)
  if (!Number.isSafeInteger(result) || result < 0) throw new Error(t("groups.onchainNumberTooPrecise"))
  return result
}
const signal = () => AbortSignal.timeout(20_000)

/** Exact decimal conversion: never round a payment or stake through a JS float. */
export function suiMist(value: string, allowZero = false): bigint {
  if (!/^\d+(\.\d{1,9})?$/.test(value)) throw new Error(t("groups.suiTooManyDecimals"))
  const [whole, decimal = ""] = value.split(".")
  const amount = BigInt(whole) * MIST_PER_SUI + BigInt(decimal.padEnd(9, "0"))
  if ((!allowZero && amount === 0n) || amount > 18_446_744_073_709_551_615n) throw new Error(t("groups.suiAmountOutOfRange"))
  return amount
}
export function formatMist(value: string): string {
  const amount = BigInt(value)
  const decimal = (amount % MIST_PER_SUI).toString().padStart(9, "0").replace(/0+$/, "")
  return `${amount / MIST_PER_SUI}${decimal ? `.${decimal}` : ""}`
}
export interface ChatChannel {
  id: string; orgId: string; name: string; creator: string; membersTable: string; sequence: string
  entryFee: string; memberStake: string; creatorStake: string; memberCount: string; isMember: boolean
}
export interface ChatMessage {
  id: string; digest: string; sequence: string; sender: string; agent: string; text: string; walrusBlobId: string; timestampMs: number
}
export interface ChainPacket {
  id: string; channelId: string; sender: string; greeting: string; totalMist: string; remainingMist: string
  totalCount: number; remainingCount: number; random: boolean; expiresAtMs: number; refunded: boolean
  claims: { recipient: string; amountMist: string; timestampMs: number }[]
}
export type GroupChatClient = Pick<typeof proposalClient, "getObject" | "getDynamicField" | "getMoveFunction" | "listEvents" | "listOwnedObjects" | "movePackageService">
const C = CHANNEL_TYPE
const S = normalizeSuiAddress("0x2")
const coin = `${S}::coin::Coin<${S}::sui::SUI>`
const clock = `&${S}::clock::Clock`
const ctx = `&mut ${S}::tx_context::TxContext`
const id = `${S}::object::ID`
const signatures = {
  create_channel: ["onchain_chat", ["address", "vector<u8>", "vector<address>", ctx], [id], 0],
  create_channel_with_stake: ["onchain_chat", ["address", "vector<u8>", "vector<address>", coin, ctx], [id], 0],
  create_creator_monetized_channel: ["onchain_chat", ["address", "vector<u8>", coin, "u64", "u64", "u64", "u64", "u64", ctx], [id], 0],
  join_channel_entry: ["onchain_chat", [`&mut ${C}`, `&mut ${coin}`, ctx], [], 0],
  member_unstake_and_leave_entry: ["onchain_chat", [`&mut ${C}`, type("onchain_chat", "MemberStakeReceipt"), ctx], [], 0],
  post_message: ["onchain_chat", [`&mut ${C}`, clock, "vector<u8>", "vector<u8>", ctx], [], 0],
  post_message_batch: ["onchain_chat", [`&mut ${C}`, clock, "vector<vector<u8>>", "vector<vector<u8>>", ctx], [], 0],
} as const
export type ChatFunction = keyof typeof signatures
function bodySignature(body: SuiClientTypes.OpenSignatureBody): string {
  if (body.$kind === "datatype") return normalizeStructTag(body.datatype.typeName) + (body.datatype.typeParameters.length ? `<${body.datatype.typeParameters.map(bodySignature).join(",")}>` : "")
  if (body.$kind === "vector") return `vector<${bodySignature(body.vector)}>`
  if (body.$kind === "typeParameter") return `T${body.index}`
  return body.$kind
}

export function createGroupChatReader(client: GroupChatClient) {
  const checks = new Map<string, Promise<void>>()
  async function ensureFunction(name: ChatFunction): Promise<void> {
    const key = `function:${name}`
    if (!checks.has(key)) checks.set(key, (async () => {
      const [moduleName, parameters, returns, generics] = signatures[name]
      const { function: fn } = await client.getMoveFunction({ packageId: PROPOSAL_PACKAGE_ID, moduleName, name, signal: signal() })
      const signature = (value: SuiClientTypes.OpenSignature) => `${value.reference === "mutable" ? "&mut " : value.reference === "immutable" ? "&" : ""}${bodySignature(value.body)}`
      if (!(fn.visibility === "public" || fn.isEntry) || fn.typeParameters.length !== generics || JSON.stringify(fn.parameters.map(signature)) !== JSON.stringify(parameters) || JSON.stringify(fn.returns.map(signature)) !== JSON.stringify(returns)) throw new Error(t("groups.deployedAbiIncompatible", { name }))
    })().catch(error => { checks.delete(key); throw error }))
    return checks.get(key)!
  }
  // A burst sender probes before choosing its entry point. A false answer only
  // ever selects the single-transaction fallback, which the package always
  // exposes, so a transient read error degrades cost, never correctness.
  async function supportsFunction(name: ChatFunction): Promise<boolean> {
    try { await ensureFunction(name); return true } catch { return false }
  }
  async function ensureDatatype(moduleName: string, name: string, fields: string[]) {
    const key = `type:${moduleName}:${name}`
    if (!checks.has(key)) checks.set(key, (async () => {
      const { response } = await client.movePackageService.getDatatype({ packageId: PROPOSAL_PACKAGE_ID, moduleName, name }, { abort: signal() })
      const data = response.datatype
      if (!data?.definingId || normalizeSuiAddress(data.definingId) !== PROPOSAL_TYPE_ORIGIN || JSON.stringify(data.fields.map(field => field.name)) !== JSON.stringify(fields)) throw new Error(t("groups.deployedDataIncompatible", { name }))
    })().catch(error => { checks.delete(key); throw error }))
    await checks.get(key)
  }
  async function readChannel(channelId: string, orgId: string, address?: string): Promise<ChatChannel> {
    await ensureDatatype("onchain_chat", "ChatChannel", CHANNEL_FIELDS)
    const { object } = await client.getObject({ objectId: channelId, include: { content: true }, signal: signal() })
    if (normalizeSuiAddress(object.objectId) !== normalizeSuiAddress(channelId) || normalizeStructTag(object.type) !== CHANNEL_TYPE) throw new Error(t("groups.notChatChannel"))
    const raw = ChannelContent.parse(object.content)
    if (raw.id !== normalizeSuiAddress(channelId) || raw.org_id !== normalizeSuiAddress(orgId)) throw new Error(t("groups.channelGroupMismatch"))
    let isMember = false
    if (address) {
      try {
        const { dynamicField } = await client.getDynamicField({ parentId: raw.members.id, name: { type: "address", bcs: bcs.Address.serialize(address).toBytes() }, signal: signal() })
        if (dynamicField.value.type !== "bool") throw new Error(t("groups.channelMembersTypeInvalid"))
        // Membership in deployed Move is table presence; decode the stored value as well.
        bcs.bool().parse(dynamicField.value.bcs)
        isMember = true
      } catch (error) { if (!(error instanceof ObjectError && error.reason === "notFound")) throw error }
    }
    return { id: raw.id, orgId: raw.org_id, name: text(raw.name), creator: raw.creator, membersTable: raw.members.id,
      sequence: raw.message_sequence, entryFee: raw.entry_fee, memberStake: raw.required_member_stake,
      creatorStake: raw.staked_principal, memberCount: raw.members.size, isMember }
  }
  async function events(moduleName: string, name: string) {
    const eventType = type(moduleName, name)
    const result: SuiClientTypes.EventEntry[] = []
    const cursors = new Set<string>()
    let before: string | null = null
    let truncated = false
    for (let pageIndex = 0; pageIndex < 8; pageIndex++) {
      const page = await client.listEvents({ filter: { eventType }, before, order: "descending", limit: 50, signal: signal() })
      for (const event of page.events) if (normalizeStructTag(event.eventType) === eventType) result.push(event)
      truncated = page.hasNextPage
      if (!page.hasNextPage) break
      if (!page.endCursor || cursors.has(page.endCursor)) throw new Error(t("groups.chatEventsPagingStuck"))
      cursors.add(page.endCursor); before = page.endCursor
    }
    return { events: result, truncated }
  }
  async function discoverChannels(orgId: string): Promise<{ ids: string[]; truncated: boolean }> {
    await ensureDatatype("onchain_chat", "ChannelCreatedWithStakeEvent", CHANNEL_CREATED_FIELDS)
    const page = await events("onchain_chat", "ChannelCreatedWithStakeEvent")
    const ids = new Set<string>()
    for (const event of page.events) {
      const raw = ChannelCreatedEvent.parse(event.bcs)
      if (raw.org_id === normalizeSuiAddress(orgId)) {
        if (raw.creator !== normalizeSuiAddress(event.sender)) throw new Error(t("groups.channelCreatorMismatch"))
        ids.add(raw.channel_id)
      }
    }
    return { ids: [...ids], truncated: page.truncated }
  }
  async function readMessages(channelId: string) {
    await ensureDatatype("onchain_chat", "ChatMessageEvent", MESSAGE_FIELDS)
    const page = await events("onchain_chat", "ChatMessageEvent")
    const messages = new Map<string, ChatMessage>()
    for (const event of page.events) {
      const raw = MessageEvent.parse(event.bcs)
      if (raw.channel_id !== normalizeSuiAddress(channelId)) continue
      if (raw.sender_agent !== normalizeSuiAddress(event.sender) || BigInt(raw.sequence) < 1n) throw new Error(t("groups.channelMessageEventInvalid"))
      const eventId = `${event.transactionDigest}:${event.eventIndex}`
      messages.set(eventId, { id: eventId, digest: event.transactionDigest, sequence: raw.sequence,
        sender: raw.sender_master, agent: raw.sender_agent, text: text(raw.content_preview), walrusBlobId: text(raw.walrus_blob_id), timestampMs: integer(raw.timestamp_ms) })
    }
    return { messages: [...messages.values()].sort((a, b) => BigInt(a.sequence) < BigInt(b.sequence) ? -1 : BigInt(a.sequence) > BigInt(b.sequence) ? 1 : a.id.localeCompare(b.id)), truncated: page.truncated }
  }
  async function findCreatedChannel(objectIds: string[], orgId: string, address: string): Promise<ChatChannel> {
    for (const objectId of objectIds) {
      const { object } = await client.getObject({ objectId, signal: signal() })
      if (normalizeStructTag(object.type) === CHANNEL_TYPE) return readChannel(objectId, orgId, address)
    }
    throw new Error(t("groups.channelNotFoundAfterTx"))
  }
  async function memberReceipt(channelId: string, address: string): Promise<string | null> {
    let cursor: string | null = null
    const cursors = new Set<string>()
    for (let pageIndex = 0; pageIndex < 10; pageIndex++) {
      const page: SuiClientTypes.ListOwnedObjectsResponse<{ content: true }> = await client.listOwnedObjects({ owner: address, type: type("onchain_chat", "MemberStakeReceipt"), include: { content: true }, cursor, limit: 50, signal: signal() })
      for (const object of page.objects) {
        if (normalizeStructTag(object.type) !== type("onchain_chat", "MemberStakeReceipt")) throw new Error(t("groups.stakeReceiptTypeInvalid"))
        const raw = ReceiptContent.parse(object.content)
        if (raw.channel_id === normalizeSuiAddress(channelId) && raw.member === normalizeSuiAddress(address)) return object.objectId
      }
      if (!page.hasNextPage) return null
      if (!page.cursor || cursors.has(page.cursor)) throw new Error(t("groups.stakeReceiptsPagingStuck"))
      cursors.add(page.cursor); cursor = page.cursor
    }
    throw new Error(t("groups.stakeReceiptsOverLimit"))
  }
  return { ensureFunction, supportsFunction, readChannel, discoverChannels, readMessages, findCreatedChannel, memberReceipt }
}
export const groupChat = createGroupChatReader(proposalClient)
// The key is version-stable on purpose: an upgrade changes PROPOSAL_PACKAGE_ID but
// must not orphan the channel a member already selected on this device.
export const chatChannelStorageKey = (orgId: string) => `sui_group_channel:${normalizeSuiAddress(orgId)}`
// Earlier builds embedded the package id in the key. Both ids that can appear in
// those legacy keys are enumerated so an existing selection survives the upgrade
// and is migrated to the stable key on first read.
const LEGACY_CHAT_CHANNEL_PACKAGE_IDS = [
  PROPOSAL_TYPE_ORIGIN,
  "0x83fb785f1da119aea4e0faa19d1466b33899e14ea730af6425ec7d5557cb5a36",
]
export const legacyChatChannelStorageKeys = (orgId: string) => {
  const normalized = normalizeSuiAddress(orgId)
  return LEGACY_CHAT_CHANNEL_PACKAGE_IDS.map(packageId => `sui_group_channel:${packageId}:${normalized}`)
}
/** Storage subset used here; keeps the migration testable without a browser. */
export type ChatChannelStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">
/**
 * Read the channel selected for an organization, migrating a legacy key that
 * embedded the package id. Returns null when nothing valid is stored; storage
 * errors propagate to the caller so they can be shown instead of swallowed.
 */
export function readStoredChatChannel(storage: ChatChannelStorage, orgId: string): string | null {
  const current = chatChannelStorageKey(orgId)
  const stored = storage.getItem(current)
  if (stored) return stored
  for (const legacy of legacyChatChannelStorageKeys(orgId)) {
    const value = storage.getItem(legacy)
    if (!value) continue
    storage.setItem(current, value)
    storage.removeItem(legacy)
    return value
  }
  return null
}
