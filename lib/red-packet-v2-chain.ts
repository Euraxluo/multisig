import { bcs } from "@mysten/sui/bcs"
import type { SuiClientTypes } from "@mysten/sui/client"
import type { SuiGrpcClient } from "@mysten/sui/grpc"
import { Transaction } from "@mysten/sui/transactions"
import { isValidSuiAddress, normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils"
import type { ChainPacket } from "./group-chat"
import { PROPOSAL_PACKAGE_ID, PROPOSAL_TYPE_ORIGIN, proposalClient } from "./proposal-chain"
import { t } from "./i18n/t"

export const RED_PACKET_V2_PACKAGE_ID = process.env.NEXT_PUBLIC_RED_PACKET_V2_PACKAGE_ID || PROPOSAL_PACKAGE_ID
const MODULE = "red_packet"
const SUI = normalizeStructTag("0x2::sui::SUI")
const U64_MAX = (1n << 64n) - 1n
const MAX_DURATION = 604_800_000n
const signal = () => AbortSignal.timeout(20_000)
const address = (value: string) => {
  const normalized = normalizeSuiAddress(value)
  if (!isValidSuiAddress(normalized) || BigInt(normalized) === 0n) throw new Error(t("payments.errNeedValidAddress"))
  return normalized
}
const framework = (name: string) => normalizeStructTag(`0x2::${name}`)
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** Storage package and defining origins are different after compatible upgrades. */
export interface RedPacketV2Deployment { packageId: string; typeOrigin: string; chatTypeOrigin: string }
export type RedPacketV2Config = { packageId: string; typeOrigin?: string; chatTypeOrigin?: string }
export class RedPacketV2UnavailableError extends Error {
  readonly code = "RED_PACKET_V2_UNAVAILABLE"
  constructor() {
    super(t("payments.errRedPacketModuleUnavailable"))
    this.name = "RedPacketV2UnavailableError"
  }
}
export class RedPacketV2AbiError extends Error {
  readonly code = "RED_PACKET_V2_ABI_MISMATCH"
  constructor(detail: string) { super(t("payments.errRedPacketAbiIncompatible", { detail })); this.name = "RedPacketV2AbiError" }
}

type GetPackage = SuiGrpcClient["movePackageService"]["getPackage"]
type Package = NonNullable<Awaited<ReturnType<GetPackage>>["response"]["package"]>
type Datatype = Package["modules"][number]["datatypes"][number]
type Field = Datatype["fields"][number]
type Body = NonNullable<Field["type"]>
export type RedPacketV2Client = Pick<SuiGrpcClient, "getObject" | "listEvents" | "getTransaction"> & {
  movePackageService: { getPackage: (...args: Parameters<GetPackage>) => PromiseLike<Pick<Awaited<ReturnType<GetPackage>>, "response">> }
}

const ClaimRecord = bcs.struct("ClaimRecord", { recipient: bcs.Address, amount: bcs.u64(), claimed_at_ms: bcs.u64() })
export const redPacketV2Bcs = bcs.struct("RedPacket", {
  id: bcs.Address, channel_id: bcs.Address, creator: bcs.Address, greeting: bcs.string(), escrow: bcs.u64(),
  initial_amount: bcs.u64(), count: bcs.u64(), is_random: bcs.bool(), expires_at_ms: bcs.u64(),
  claims: bcs.vector(ClaimRecord),
  lifecycle: bcs.enum("Lifecycle", { Open: null, Refunded: bcs.struct("Refunded", { amount: bcs.u64() }) }),
})
export const redPacketV2EventBcs = {
  Created: bcs.struct("Created", {
    packet_id: bcs.Address, channel_id: bcs.Address, amount: bcs.u64(), count: bcs.u64(),
    is_random: bcs.bool(), greeting: bcs.string(), expires_at_ms: bcs.u64(),
  }),
  Claimed: bcs.struct("Claimed", {
    packet_id: bcs.Address, channel_id: bcs.Address, amount: bcs.u64(), claimed_at_ms: bcs.u64(),
    remaining_count: bcs.u64(), remaining_balance: bcs.u64(),
  }),
  Refunded: bcs.struct("Refunded", {
    packet_id: bcs.Address, channel_id: bcs.Address, amount: bcs.u64(), refunded_at_ms: bcs.u64(), unclaimed_count: bcs.u64(),
  }),
}
export type RedPacketV2State = ReturnType<typeof redPacketV2Bcs.parse>
export interface ChainPacketV2 extends ChainPacket { coinType: string }

function bodySignature(body: Body): string {
  const primitives = ["unknown", "address", "bool", "u8", "u16", "u32", "u64", "u128", "u256"]
  if (body.type !== undefined && body.type >= 1 && body.type <= 8 && !body.typeParameterInstantiation.length) return primitives[body.type]
  if (body.type === 9 && body.typeParameterInstantiation.length === 1) return `vector<${bodySignature(body.typeParameterInstantiation[0])}>`
  // Normalize the base name only: $0 is an ABI placeholder, not a Move type tag.
  if (body.type === 10 && body.typeName) return normalizeStructTag(body.typeName) + (body.typeParameterInstantiation.length ? `<${body.typeParameterInstantiation.map(bodySignature).join(",")}>` : "")
  if (body.type === 11 && body.typeParameter !== undefined && !body.typeParameterInstantiation.length) return `$${body.typeParameter}`
  throw new RedPacketV2AbiError(t("payments.rpAbiUnknownSignature"))
}
function checkFields(actual: Field[], expected: string[]) {
  if (actual.length !== expected.length || actual.some((field, index) => field.position !== index || !field.type || `${field.name}:${bodySignature(field.type)}` !== expected[index])) throw new RedPacketV2AbiError(t("payments.rpAbiFieldLayout"))
}

/** Read-only gate: a missing module, incompatible ABI, and a transport failure stay distinct. */
export async function verifyRedPacketV2(client: Pick<RedPacketV2Client, "movePackageService">, config?: string | RedPacketV2Config): Promise<RedPacketV2Deployment> {
  if (!config) throw new RedPacketV2UnavailableError()
  const input = typeof config === "string" ? { packageId: config } : config
  const packageId = address(input.packageId)
  const { response } = await client.movePackageService.getPackage({ packageId }, { abort: signal() })
  const pkg = response.package
  if (!pkg?.storageId || address(pkg.storageId) !== packageId) throw new RedPacketV2AbiError(t("payments.rpAbiPackageIdentity"))
  const modules = pkg.modules.filter(candidate => candidate.name === MODULE)
  if (!modules.length) throw new RedPacketV2UnavailableError()
  if (modules.length !== 1) throw new RedPacketV2AbiError(t("payments.rpAbiDuplicateModule"))
  const moduleDef = modules[0]
  const packet = moduleDef.datatypes.find(type => type.name === "RedPacket")
  if (!packet?.definingId) throw new RedPacketV2AbiError(t("payments.rpAbiMissingDefinition"))
  const typeOrigin = address(packet.definingId)
  if (input.typeOrigin && address(input.typeOrigin) !== typeOrigin) throw new RedPacketV2AbiError(t("payments.rpAbiTypeOrigin"))
  const local = (name: string) => `${typeOrigin}::${MODULE}::${name}`
  const layouts: Record<string, string[]> = {
    RedPacket: ["id:" + framework("object::UID"), "channel_id:" + framework("object::ID"), "creator:address", "greeting:" + normalizeStructTag("0x1::string::String"), "escrow:" + framework("balance::Balance") + "<$0>", "initial_amount:u64", "count:u64", "is_random:bool", "expires_at_ms:u64", "claims:vector<" + local("ClaimRecord") + ">", "lifecycle:" + local("Lifecycle")],
    ClaimRecord: ["recipient:address", "amount:u64", "claimed_at_ms:u64"],
    Created: ["packet_id:" + framework("object::ID"), "channel_id:" + framework("object::ID"), "amount:u64", "count:u64", "is_random:bool", "greeting:" + normalizeStructTag("0x1::string::String"), "expires_at_ms:u64"],
    Claimed: ["packet_id:" + framework("object::ID"), "channel_id:" + framework("object::ID"), "amount:u64", "claimed_at_ms:u64", "remaining_count:u64", "remaining_balance:u64"],
    Refunded: ["packet_id:" + framework("object::ID"), "channel_id:" + framework("object::ID"), "amount:u64", "refunded_at_ms:u64", "unclaimed_count:u64"],
  }
  const names = [...Object.keys(layouts), "Lifecycle"]
  if (moduleDef.datatypes.length !== names.length || new Set(moduleDef.datatypes.map(type => type.name)).size !== names.length) throw new RedPacketV2AbiError(t("payments.rpAbiTypeSet"))
  for (const type of moduleDef.datatypes) {
    if (!type.name || !names.includes(type.name) || !type.definingId || address(type.definingId) !== typeOrigin || type.module !== MODULE || !type.typeName || ![local(type.name), `${packageId}::${MODULE}::${type.name}`].includes(normalizeStructTag(type.typeName))) throw new RedPacketV2AbiError(t("payments.rpAbiTypeIdentity"))
    // Current gRPC servers omit typeOrigins and label descriptor.typeName with storage ID.
    // definingId is the nominal origin; check the origin table as well when the server supplies it.
    const origins = pkg.typeOrigins.filter(origin => origin.moduleName === MODULE && origin.datatypeName === type.name)
    if (pkg.typeOrigins.length && (origins.length !== 1 || !origins[0].packageId || address(origins[0].packageId) !== typeOrigin)) throw new RedPacketV2AbiError(t("payments.rpAbiTypeOriginTable"))
    const abilities = type.name === "RedPacket" ? [4] : type.name === "Lifecycle" ? [2, 3] : type.name === "ClaimRecord" ? [1, 2, 3] : [1, 2]
    const generic = ["RedPacket", "Created", "Claimed", "Refunded"].includes(type.name)
    if (!same([...type.abilities].sort(), abilities) || type.typeParameters.length !== (generic ? 1 : 0) || (generic && (!type.typeParameters[0].isPhantom || type.typeParameters[0].constraints.length))) throw new RedPacketV2AbiError(t("payments.rpAbiAbilitiesOrGenerics"))
    if (type.name === "Lifecycle") {
      if (type.kind !== 2 || type.fields.length || type.variants.length !== 2) throw new RedPacketV2AbiError(t("payments.rpAbiLifecycleEnum"))
      type.variants.forEach((variant, index) => {
        if (variant.position !== index || variant.name !== ["Open", "Refunded"][index]) throw new RedPacketV2AbiError(t("payments.rpAbiLifecycleVariant"))
        checkFields(variant.fields, index === 0 ? [] : ["amount:u64"])
      })
    } else {
      if (type.kind !== 1 || type.variants.length) throw new RedPacketV2AbiError(t("payments.rpAbiStructType"))
      checkFields(type.fields, layouts[type.name])
    }
  }
  const chat = pkg.modules.find(candidate => candidate.name === "onchain_chat")?.datatypes.find(type => type.name === "ChatChannel")
  if (!chat?.definingId || !chat.typeName || chat.module !== "onchain_chat") throw new RedPacketV2AbiError(t("payments.rpAbiMissingChannelType"))
  const chatTypeOrigin = address(chat.definingId)
  const chatType = `${chatTypeOrigin}::onchain_chat::ChatChannel`
  if (![chatType, `${packageId}::onchain_chat::ChatChannel`].includes(normalizeStructTag(chat.typeName)) || (input.chatTypeOrigin && address(input.chatTypeOrigin) !== chatTypeOrigin)) throw new RedPacketV2AbiError(t("payments.rpAbiChannelTypeOrigin"))
  const channelOrigins = pkg.typeOrigins.filter(origin => origin.moduleName === "onchain_chat" && origin.datatypeName === "ChatChannel")
  if (pkg.typeOrigins.length && (channelOrigins.length !== 1 || !channelOrigins[0].packageId || address(channelOrigins[0].packageId) !== chatTypeOrigin)) throw new RedPacketV2AbiError(t("payments.rpAbiChannelOriginTable"))
  const channel = `&${chatType}`, mutablePacket = `&mut ${local("RedPacket")}<$0>`
  const clock = "&" + framework("clock::Clock"), random = "&" + framework("random::Random"), ctx = "&mut " + framework("tx_context::TxContext")
  const expected: Record<string, { visibility: number; isEntry: boolean; parameters: string[]; returns: string[] }> = {
    create: { visibility: 2, isEntry: false, parameters: [channel, framework("coin::Coin") + "<$0>", "u64", "bool", normalizeStructTag("0x1::string::String"), "u64", clock, ctx], returns: [framework("object::ID")] },
    claim_equal: { visibility: 1, isEntry: true, parameters: [mutablePacket, channel, clock, ctx], returns: [] },
    claim_random: { visibility: 1, isEntry: true, parameters: [mutablePacket, channel, clock, random, ctx], returns: [] },
    refund: { visibility: 1, isEntry: true, parameters: [mutablePacket, clock, ctx], returns: [] },
  }
  const callable = moduleDef.functions.filter(fn => fn.visibility !== 1 || fn.isEntry)
  if (callable.length !== 4 || new Set(callable.map(fn => fn.name)).size !== 4) throw new RedPacketV2AbiError(t("payments.rpAbiFunctionSet"))
  for (const fn of callable) {
    const schema = fn.name && expected[fn.name]
    const signature = (parameter: typeof fn.parameters[number]) => {
      if (!parameter.body || (parameter.reference !== undefined && ![0, 1, 2].includes(parameter.reference))) throw new RedPacketV2AbiError(t("payments.rpAbiFunctionParameters"))
      return `${parameter.reference === 2 ? "&mut " : parameter.reference === 1 ? "&" : ""}${bodySignature(parameter.body)}`
    }
    if (!schema || fn.visibility !== schema.visibility || (fn.isEntry ?? false) !== schema.isEntry || fn.typeParameters.length !== 1 || fn.typeParameters[0].constraints.length || !same(fn.parameters.map(signature), schema.parameters) || !same(fn.returns.map(signature), schema.returns)) throw new RedPacketV2AbiError(t("payments.rpAbiFunction", { name: fn.name ?? "" }))
  }
  return { packageId, typeOrigin, chatTypeOrigin }
}

function parseExact<Output, Input>(codec: { parse(bytes: Uint8Array): Output; serialize(value: Input): { toBytes(): Uint8Array } }, bytes: Uint8Array): Output {
  if (bytes.length > 8192) throw new Error(t("payments.rpErrBcsTooLong"))
  const value = codec.parse(bytes)
  // A BCS codec's parsed output is always a valid input to the same codec.
  const canonical = codec.serialize(value as unknown as Input).toBytes()
  if (canonical.length !== bytes.length || canonical.some((byte, index) => byte !== bytes[index])) throw new Error(t("payments.rpErrBcsNotCanonical"))
  return value
}
function uint(value: string): bigint {
  if (!/^\d+$/.test(value) || BigInt(value) > U64_MAX) throw new Error(t("payments.rpErrU64Range"))
  return BigInt(value)
}
/** Check conservation, duplicate recipients, allocation bounds, dust, and lifecycle together. */
export function assertRedPacketV2Conservation(state: RedPacketV2State): void {
  const initial = uint(state.initial_amount), count = uint(state.count), escrow = uint(state.escrow), expiry = uint(state.expires_at_ms)
  if (count < 1n || count > 128n || initial < count || state.claims.length > Number(count) || expiry < 1n || new TextEncoder().encode(state.greeting).length > 256) throw new Error(t("payments.rpErrInvalidPacketFields"))
  address(state.id); address(state.channel_id); address(state.creator)
  const recipients = new Set<string>()
  let balance = initial, lastTime = 0n
  for (const [index, claim] of state.claims.entries()) {
    const recipient = address(claim.recipient), amount = uint(claim.amount), time = uint(claim.claimed_at_ms)
    const remaining = count - BigInt(index)
    const minimum = state.is_random ? remaining === 1n ? balance : 1n : initial / count + (BigInt(index) < initial % count ? 1n : 0n)
    const maximum = state.is_random ? remaining === 1n ? balance : (2n * balance / remaining < balance - remaining + 1n ? 2n * balance / remaining : balance - remaining + 1n) : minimum
    if (recipients.has(recipient) || amount < minimum || amount > maximum || time > expiry || time < lastTime) throw new Error(t("payments.rpErrClaimsMismatch"))
    recipients.add(recipient); balance -= amount; lastTime = time
  }
  if (state.lifecycle.$kind === "Refunded") {
    if (state.claims.length === Number(count) || escrow !== 0n || uint(state.lifecycle.Refunded.amount) !== balance || balance < 1n) throw new Error(t("payments.rpErrRefundConservation"))
  } else if (state.lifecycle.$kind !== "Open" || escrow !== balance || escrow < count - BigInt(state.claims.length)) throw new Error(t("payments.rpErrBalanceConservation"))
}

export interface CreateRedPacketV2 {
  sender: string; channelId: string; coinType: string; amount: bigint; count: number
  isRandom: boolean; greeting: string; durationMs: bigint
  /** Omit for SUI split from gas; other assets require an owned funding coin. */
  fundingCoinId?: string
}
export interface ClaimRedPacketV2 { sender: string; packetId: string; channelId: string; coinType: string; isRandom: boolean }
export interface RefundRedPacketV2 { sender: string; packetId: string; coinType: string }

function createTransaction(d: RedPacketV2Deployment, input: CreateRedPacketV2): Transaction {
  if (!Number.isInteger(input.count) || input.count < 1 || input.count > 128 || input.amount < BigInt(input.count) || input.amount > U64_MAX) throw new Error(t("payments.rpErrCountRange"))
  if (new TextEncoder().encode(input.greeting).length > 256 || new TextDecoder("utf-8", { fatal: true }).decode(new TextEncoder().encode(input.greeting)) !== input.greeting) throw new Error(t("payments.rpErrGreetingUtf8"))
  if (input.durationMs < 1n || input.durationMs > MAX_DURATION || typeof input.isRandom !== "boolean") throw new Error(t("payments.rpErrDurationRange"))
  const tx = new Transaction()
  tx.setSender(address(input.sender))
  const coinType = normalizeStructTag(input.coinType)
  if (coinType !== SUI && !input.fundingCoinId) throw new Error(t("payments.rpErrNeedFundingCoin"))
  const source = input.fundingCoinId ? tx.object(address(input.fundingCoinId)) : tx.gas
  const [funding] = tx.splitCoins(source, [tx.pure.u64(input.amount)])
  tx.moveCall({ target: `${d.packageId}::${MODULE}::create`, typeArguments: [coinType], arguments: [
    tx.object(address(input.channelId)), funding, tx.pure.u64(input.count), tx.pure.bool(input.isRandom),
    tx.pure.string(input.greeting), tx.pure.u64(input.durationMs), tx.object.clock(),
  ] })
  return tx
}
function claimTransaction(d: RedPacketV2Deployment, input: ClaimRedPacketV2): Transaction {
  if (typeof input.isRandom !== "boolean") throw new Error(t("payments.rpErrNeedAllocationMode"))
  const tx = new Transaction()
  tx.setSender(address(input.sender))
  const args = [tx.object(address(input.packetId)), tx.object(address(input.channelId)), tx.object.clock()]
  if (input.isRandom) args.push(tx.object.random())
  tx.moveCall({ target: `${d.packageId}::${MODULE}::claim_${input.isRandom ? "random" : "equal"}`, typeArguments: [normalizeStructTag(input.coinType)], arguments: args })
  return tx
}
function refundTransaction(d: RedPacketV2Deployment, input: RefundRedPacketV2): Transaction {
  const tx = new Transaction()
  tx.setSender(address(input.sender))
  tx.moveCall({ target: `${d.packageId}::${MODULE}::refund`, typeArguments: [normalizeStructTag(input.coinType)], arguments: [tx.object(address(input.packetId)), tx.object.clock()] })
  return tx
}
/** Each builder verifies deployment and starts a fresh PTB; payout stays internal to Move. */
export async function buildCreateRedPacketV2(client: RedPacketV2Client, config: string | RedPacketV2Config | undefined, input: CreateRedPacketV2) { return createTransaction(await verifyRedPacketV2(client, config), input) }
export async function buildClaimRedPacketV2(client: RedPacketV2Client, config: string | RedPacketV2Config | undefined, input: ClaimRedPacketV2) { return claimTransaction(await verifyRedPacketV2(client, config), input) }
export async function buildRefundRedPacketV2(client: RedPacketV2Client, config: string | RedPacketV2Config | undefined, input: RefundRedPacketV2) { return refundTransaction(await verifyRedPacketV2(client, config), input) }

function decodePacket(object: SuiClientTypes.Object<{ content: true }>, d: RedPacketV2Deployment, packetId: string, channelId: string | undefined, coinType: string): RedPacketV2State {
  if (address(object.objectId) !== address(packetId) || normalizeStructTag(object.type) !== normalizeStructTag(`${d.typeOrigin}::${MODULE}::RedPacket<${coinType}>`) || object.owner.$kind !== "Shared") throw new Error(t("payments.rpErrNotSharedPacket"))
  const state = parseExact(redPacketV2Bcs, object.content)
  if (state.id !== address(packetId) || (channelId && state.channel_id !== address(channelId))) throw new Error(t("payments.rpErrPacketIdentityMismatch"))
  assertRedPacketV2Conservation(state)
  return state
}
export async function readRedPacketV2(client: RedPacketV2Client, config: string | RedPacketV2Config | undefined, packetId: string, coinType = SUI, channelId?: string): Promise<RedPacketV2State> {
  const d = await verifyRedPacketV2(client, config)
  const { object } = await client.getObject({ objectId: address(packetId), include: { content: true }, signal: signal() })
  return decodePacket(object, d, packetId, channelId, coinType)
}
function timestamp(value: string): number {
  const result = Number(value)
  if (!Number.isSafeInteger(result) || result < 0 || result > 8_640_000_000_000_000) throw new Error(t("payments.rpErrTimePrecision"))
  return result
}
function displayPacket(raw: RedPacketV2State, coinType: string): ChainPacketV2 {
  return { id: raw.id, channelId: raw.channel_id, sender: raw.creator, greeting: raw.greeting,
    totalMist: raw.initial_amount, remainingMist: raw.escrow, totalCount: Number(raw.count),
    remainingCount: raw.lifecycle.$kind === "Refunded" ? 0 : Number(raw.count) - raw.claims.length,
    random: raw.is_random, expiresAtMs: timestamp(raw.expires_at_ms), refunded: raw.lifecycle.$kind === "Refunded",
    coinType: normalizeStructTag(coinType), claims: raw.claims.map(claim => ({ recipient: claim.recipient, amountMist: claim.amount, timestampMs: timestamp(claim.claimed_at_ms) })) }
}
function matchesCreation(raw: RedPacketV2State, event: ReturnType<typeof redPacketV2EventBcs.Created.parse>, sender: string) {
  if (raw.id !== event.packet_id || raw.channel_id !== event.channel_id || raw.creator !== address(sender) || raw.initial_amount !== event.amount || raw.count !== event.count || raw.is_random !== event.is_random || raw.greeting !== event.greeting || raw.expires_at_ms !== event.expires_at_ms) throw new Error(t("payments.rpErrObjectEventMismatch"))
}

export function createRedPacketV2Reader(client: RedPacketV2Client, config: string | RedPacketV2Config = { packageId: RED_PACKET_V2_PACKAGE_ID, chatTypeOrigin: PROPOSAL_TYPE_ORIGIN }) {
  let deployment: Promise<RedPacketV2Deployment> | undefined
  function requireDeployment() {
    if (!deployment) deployment = verifyRedPacketV2(client, config).catch(error => { deployment = undefined; throw error })
    return deployment
  }
  async function readState(packetId: string, channelId: string, coinType = SUI) {
    const d = await requireDeployment()
    const { object } = await client.getObject({ objectId: address(packetId), include: { content: true }, signal: signal() })
    return decodePacket(object, d, packetId, channelId, coinType)
  }
  async function readPacket(packetId: string, channelId: string, coinType = SUI): Promise<ChainPacketV2> { return displayPacket(await readState(packetId, channelId, coinType), coinType) }
  async function readPackets(channelId: string, coinType = SUI) {
    const d = await requireDeployment(), channel = address(channelId)
    const eventType = normalizeStructTag(`${d.typeOrigin}::${MODULE}::Created<${coinType}>`)
    const packets: (ChainPacketV2 & { digest: string; timestampMs: number })[] = []
    const seen = new Set<string>(), cursors = new Set<string>()
    let before: string | null = null, truncated = false
    for (let pageIndex = 0; pageIndex < 8; pageIndex++) {
      const page = await client.listEvents({ filter: { eventType }, before, order: "descending", limit: 50, signal: signal() })
      for (const event of page.events) {
        if (normalizeStructTag(event.eventType) !== eventType) throw new Error(t("payments.rpErrDiscoveryEventMismatch"))
        const created = parseExact(redPacketV2EventBcs.Created, event.bcs)
        if (created.channel_id !== channel || seen.has(created.packet_id)) continue
        if (packets.length === 50) return { packets, truncated: true }
        const raw = await readState(created.packet_id, channel, coinType)
        matchesCreation(raw, created, event.sender)
        const result = await client.getTransaction({ digest: event.transactionDigest, signal: signal() })
        if (result.$kind !== "Transaction" || result.Transaction.digest !== event.transactionDigest || !result.Transaction.status.success || result.Transaction.timestampMs === null || !Number.isSafeInteger(result.Transaction.timestampMs) || result.Transaction.timestampMs < 0 || result.Transaction.timestampMs > 8_640_000_000_000_000) throw new Error(t("payments.rpErrCreationTxMismatch"))
        packets.push({ ...displayPacket(raw, coinType), digest: event.transactionDigest, timestampMs: result.Transaction.timestampMs })
        seen.add(created.packet_id)
      }
      truncated = page.hasNextPage
      if (!truncated) break
      if (!page.endCursor || cursors.has(page.endCursor)) throw new Error(t("payments.rpErrPaginationStalled"))
      cursors.add(page.endCursor); before = page.endCursor
    }
    return { packets, truncated }
  }
  async function findCreatedPacket(objectIds: string[], channelId: string, coinType = SUI): Promise<ChainPacketV2> {
    const d = await requireDeployment(), channel = address(channelId)
    const expected = normalizeStructTag(`${d.typeOrigin}::${MODULE}::RedPacket<${coinType}>`)
    if (objectIds.length > 256) throw new Error(t("payments.rpErrCreatedObjectsLimit"))
    for (const objectId of new Set(objectIds)) {
      const { object } = await client.getObject({ objectId: address(objectId), include: { content: true }, signal: signal() })
      if (normalizeStructTag(object.type) !== expected) continue
      const state = decodePacket(object, d, objectId, undefined, coinType)
      if (state.channel_id === channel) return displayPacket(state, coinType)
    }
    throw new Error(t("payments.rpErrPacketNotFoundAfterTx"))
  }
  return { requireDeployment, readState, readPacket, readPackets, findCreatedPacket,
    buildCreate: async (input: CreateRedPacketV2) => createTransaction(await requireDeployment(), input),
    buildClaim: async (input: ClaimRedPacketV2) => claimTransaction(await requireDeployment(), input),
    buildRefund: async (input: RefundRedPacketV2) => refundTransaction(await requireDeployment(), input) }
}
export const redPacketV2 = createRedPacketV2Reader(proposalClient, { packageId: RED_PACKET_V2_PACKAGE_ID, chatTypeOrigin: PROPOSAL_TYPE_ORIGIN })

/** Input must be the complete, packet-scoped event stream in ledger order.
 * Event type is emitter authority. packageId/module describe the top-level caller and may be a wrapper.
 */
export function replayRedPacketV2Events(d: RedPacketV2Deployment, coinType: string, events: readonly SuiClientTypes.Event[]): RedPacketV2State {
  const origin = address(d.typeOrigin), suffix = `<${normalizeStructTag(coinType)}>`
  let state: RedPacketV2State | undefined
  for (const event of events) {
    const name = (Object.keys(redPacketV2EventBcs) as (keyof typeof redPacketV2EventBcs)[]).find(name => normalizeStructTag(event.eventType) === normalizeStructTag(`${origin}::${MODULE}::${name}${suffix}`))
    if (!name) throw new Error(t("payments.rpErrReplayEventMismatch"))
    if (name === "Created") {
      if (state) throw new Error(t("payments.rpErrDuplicateCreationEvent"))
      const created = parseExact(redPacketV2EventBcs.Created, event.bcs)
      state = { id: created.packet_id, channel_id: created.channel_id, creator: address(event.sender), greeting: created.greeting,
        escrow: created.amount, initial_amount: created.amount, count: created.count, is_random: created.is_random,
        expires_at_ms: created.expires_at_ms, claims: [], lifecycle: { $kind: "Open", Open: true } }
    } else {
      if (!state || state.lifecycle.$kind !== "Open") throw new Error(t("payments.rpErrLifecycleOrder"))
      if (name === "Claimed") {
        const claim = parseExact(redPacketV2EventBcs.Claimed, event.bcs)
        if (claim.packet_id !== state.id || claim.channel_id !== state.channel_id || BigInt(claim.remaining_balance) + BigInt(claim.amount) !== BigInt(state.escrow) || BigInt(claim.remaining_count) !== BigInt(state.count) - BigInt(state.claims.length) - 1n) throw new Error(t("payments.rpErrClaimEventMismatch"))
        state.claims.push({ recipient: address(event.sender), amount: claim.amount, claimed_at_ms: claim.claimed_at_ms })
        state.escrow = claim.remaining_balance
      } else {
        const refund = parseExact(redPacketV2EventBcs.Refunded, event.bcs)
        if (refund.packet_id !== state.id || refund.channel_id !== state.channel_id || address(event.sender) !== state.creator || refund.amount !== state.escrow || BigInt(refund.refunded_at_ms) <= BigInt(state.expires_at_ms) || BigInt(refund.unclaimed_count) !== BigInt(state.count) - BigInt(state.claims.length)) throw new Error(t("payments.rpErrRefundEventMismatch"))
        state.escrow = "0"; state.lifecycle = { $kind: "Refunded", Refunded: { amount: refund.amount } }
      }
    }
    assertRedPacketV2Conservation(state)
  }
  if (!state) throw new Error(t("payments.rpErrReplayNeedsCreation"))
  return state
}
export function reconcileRedPacketV2Events(state: RedPacketV2State, d: RedPacketV2Deployment, coinType: string, events: readonly SuiClientTypes.Event[]): void {
  assertRedPacketV2Conservation(state)
  const replay: Uint8Array = redPacketV2Bcs.serialize(replayRedPacketV2Events(d, coinType, events)).toBytes()
  const snapshot: Uint8Array = redPacketV2Bcs.serialize(state).toBytes()
  if (replay.length !== snapshot.length || replay.some((byte, index) => byte !== snapshot[index])) throw new Error(t("payments.rpErrReplaySnapshotMismatch"))
}
