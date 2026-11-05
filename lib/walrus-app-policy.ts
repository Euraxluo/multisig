"use client"

import { bcs } from "@mysten/sui/bcs"
import { type SuiClientTypes } from "@mysten/sui/client"
import { SuiGrpcClient } from "@mysten/sui/grpc"
import { Transaction } from "@mysten/sui/transactions"
import { isValidSuiAddress, normalizeSuiAddress, normalizeStructTag } from "@mysten/sui/utils"
import {
  PaymentPolicyBcs, RegistryBcs,
  buildCreatePolicyRegistry, buildPayWithStakeReceipt, buildRegisterPaymentApp, buildToggleAppStatus,
} from "multisig/agent-vault"
import { PROPOSAL_PACKAGE_ID, PROPOSAL_TYPE_ORIGIN } from "./proposal-chain"
import { t } from "./i18n/t"

/**
 * Walrus mini-app payment policy (`walrus_app_policy`)。
 *
 * The contract separates construction (`new`) from publication (`share`), pins
 * every payment term at registration (no setters), and authorizes each payment
 * with the payer's own live `MemberStakeReceipt` plus an actual `Coin<SUI>`
 * delivered whole to the admin-fixed recipient. This module wires the frontend
 * to that surface: read-only snapshots of a shared registry, offline PTB
 * builders for every entry, and an ABI gate that must resolve all five entry
 * points before any live call is constructed.
 *
 * An ABI probe only confirms that these entry points are available; it does
 * not attest the implementation or discover an existing registry.
 */

export const POLICY_MODULE = "walrus_app_policy"
const requestSignal = () => AbortSignal.timeout(20_000)
const message = (cause: unknown) => cause instanceof Error ? cause.message : t("walrus.chainReadFailed")
const ZERO_ID = /^0x0+$/

function parseObjectId(value: string, label: string): string {
  const id = normalizeSuiAddress(value.trim())
  if (!isValidSuiAddress(id) || ZERO_ID.test(id)) throw new Error(t("walrus.invalidObjectId", { label }))
  return id
}

/** Blob IDs are bounded by the contract at 1..128 bytes. */
function parseBlobId(value: string): string {
  const blobId = value.trim()
  const bytes = new TextEncoder().encode(blobId).length
  if (bytes < 1 || bytes > 128) throw new Error(t("walrus.blobIdLength"))
  return blobId
}

export function policyPackageId(): string {
  return process.env.NEXT_PUBLIC_WALRUS_APP_POLICY_PACKAGE_ID || PROPOSAL_PACKAGE_ID
}

// === Deployment gate ===

/** Every entry the builders target; all must resolve before a live call is built. */
const POLICY_ENTRIES = ["new", "share", "register_payment_app", "toggle_app_status", "pay"] as const

export interface PolicyDeployment {
  /** True only when all five entries resolve in the target package. */
  moduleResolved: boolean
  reason: string
}

export async function verifyPolicyDeployment(
  client: Pick<SuiGrpcClient, "getMoveFunction">,
  packageId = policyPackageId(),
): Promise<PolicyDeployment> {
  for (const name of POLICY_ENTRIES) {
    try {
      await client.getMoveFunction({ packageId, moduleName: POLICY_MODULE, name, signal: requestSignal() })
    } catch (error) {
      // "Function not found" means the module is not there; any other failure
      // (network, malformed id) must not be misread as "not deployed".
      if (error instanceof Error && /^Function not found:/i.test(error.message)) {
        return {
          moduleResolved: false,
          reason: t("walrus.deployMissingEntries"),
        }
      }
      throw error
    }
  }
  return {
    moduleResolved: true,
    reason: t("walrus.deployOk"),
  }
}

// === PTB builders (offline; execution is always a user-signed wallet action) ===

/** Construct and share a new registry, delivering the AdminCap to `sender`. PTB 在 SDK 切片构造。 */
export function initializeRegistry(sender: string, packageId = policyPackageId()): Transaction {
  const owner = parseObjectId(sender, t("walrus.labelSenderAddress"))
  return buildCreatePolicyRegistry({ packageId, adminRecipient: owner }) as unknown as Transaction
}

export interface RegisterPaymentAppInput {
  registryId: string
  adminCapId: string
  blobId: string
  channelId: string
  minMemberStakeMist: bigint
  recipient: string
  maxPaymentMist: bigint
  epochBudgetMist: bigint
}

/** Register immutable payment terms for one app. Mirrors the contract's guard order. */
export function registerPaymentApp(input: RegisterPaymentAppInput, packageId = policyPackageId()): Transaction {
  const registryId = parseObjectId(input.registryId, t("walrus.labelRegistryId"))
  const adminCapId = parseObjectId(input.adminCapId, t("walrus.labelAdminCapId"))
  const channelId = parseObjectId(input.channelId, t("walrus.labelChannelId"))
  const blobId = parseBlobId(input.blobId)
  if (input.minMemberStakeMist <= 0n) throw new Error(t("walrus.minStakePositive"))
  const recipient = parseObjectId(input.recipient, t("walrus.labelRecipient"))
  if (input.maxPaymentMist <= 0n) throw new Error(t("walrus.maxPaymentPositive"))
  if (input.epochBudgetMist <= 0n) throw new Error(t("walrus.epochBudgetPositive"))
  return buildRegisterPaymentApp({ packageId, registryId, adminCapId }, {
    blobId, channelId, minMemberStake: input.minMemberStakeMist, recipient,
    maxPayment: input.maxPaymentMist, epochBudget: input.epochBudgetMist,
  }) as unknown as Transaction
}

export function toggleAppStatus(
  input: { registryId: string; adminCapId: string; blobId: string; isActive: boolean },
  packageId = policyPackageId(),
): Transaction {
  const registryId = parseObjectId(input.registryId, t("walrus.labelRegistryId"))
  const adminCapId = parseObjectId(input.adminCapId, t("walrus.labelAdminCapId"))
  const blobId = parseBlobId(input.blobId)
  return buildToggleAppStatus({ packageId, registryId, adminCapId }, {
    blobId, isActive: input.isActive,
  }) as unknown as Transaction
}

/**
 * Pay one app: the exact amount is split from the sender's gas as a dedicated
 * SUI coin and delivered whole to the admin-fixed recipient. The receipt must
 * belong to the transaction sender and the authoritative channel.
 */
export function payApp(
  input: { registryId: string; blobId: string; channelId: string; receiptId: string; amountMist: bigint },
  packageId = policyPackageId(),
): Transaction {
  const registryId = parseObjectId(input.registryId, t("walrus.labelRegistryId"))
  const channelId = parseObjectId(input.channelId, t("walrus.labelChannelId"))
  const receiptId = parseObjectId(input.receiptId, t("walrus.labelReceiptId"))
  const blobId = parseBlobId(input.blobId)
  if (input.amountMist <= 0n) throw new Error(t("walrus.payAmountPositive"))
  return buildPayWithStakeReceipt(
    { packageId, registryId, channelId, receiptId },
    { blobId, payment: { amount: input.amountMist } },
  ) as unknown as Transaction
}

// === Reads ===

// BCS 布局在 SDK app-policy 切片（单一事实源）；Table 只在此处读 id/size。
const RegistryContent = RegistryBcs

const PaymentPolicyContent = PaymentPolicyBcs

interface PaymentPolicyShape {
  channel_id: string; min_member_stake: string; recipient: string; max_payment: string;
  epoch_budget: string; spent_in_epoch: string; last_payment_epoch: string; is_active: boolean;
}
// SDK 的 BcsStruct 与本仓 @mysten/bcs 私有字段互不兼容（与 Transaction 边界同理），
// 但线格式逐字节一致；字段包装结构在此声明 parse 形状后复用 SDK schema。
const PolicyField = bcs.struct("PolicyField", {
  id: bcs.Address, name: bcs.string(), value: PaymentPolicyContent as never,
}) as unknown as {
  parse(bytes: Uint8Array): { id: string; name: string; value: PaymentPolicyShape };
  serialize(input: { id: string; name: string; value: PaymentPolicyShape }): { toBytes(): Uint8Array };
}

/**
 * Registry and policy type strings may carry either the type origin or the
 * storage package id depending on how the node reports the deployed module.
 * Both name the same type; the module and struct names are not negotiable.
 */
function isRegistryType(value: string): boolean {
  let normalized: string
  try { normalized = normalizeStructTag(value) } catch { return false }
  return [PROPOSAL_TYPE_ORIGIN, policyPackageId()]
    .map(origin => normalizeStructTag(`${origin}::${POLICY_MODULE}::Registry`))
    .includes(normalized)
}

function isPolicyFieldType(value: string): boolean {
  let normalized: string
  try { normalized = normalizeStructTag(value) } catch { return false }
  const fieldTypes = [PROPOSAL_TYPE_ORIGIN, policyPackageId()]
    .map(origin => normalizeStructTag(`0x2::dynamic_field::Field<0x1::string::String,${origin}::${POLICY_MODULE}::PaymentPolicy>`))
  return fieldTypes.includes(normalized)
}

export interface WalrusPaymentPolicy {
  blobId: string
  channelId: string
  minMemberStakeMist: string
  recipient: string
  maxPaymentMist: string
  epochBudgetMist: string
  spentInEpochMist: string
  lastPaymentEpoch: string
  isActive: boolean
}

export interface RegistrySnapshot {
  registryId: string
  totalApps: string
  policies: WalrusPaymentPolicy[]
  /** The policy table was larger than the bounded read. */
  truncated: boolean
  /** Policies that exist but could not be decoded; they are not silently dropped. */
  failures: Array<{ blobId: string; reason: string }>
}

export type PolicyReaderClient = Pick<SuiGrpcClient, "getObject" | "listDynamicFields" | "getObjects">
export type PolicyClient = PolicyReaderClient & Pick<SuiGrpcClient, "getMoveFunction">

export function parseRegistryId(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) throw new Error(t("walrus.invalidRegistryId"))
  return parseObjectId(trimmed, t("walrus.labelRegistryId"))
}

export function createPolicyReader(client: PolicyReaderClient) {
  async function readRegistry(registryIdInput: string, options: { maxPages?: number; pageSize?: number } = {}): Promise<RegistrySnapshot> {
    const registryId = parseRegistryId(registryIdInput)
    const maxPages = options.maxPages ?? 8
    const pageSize = options.pageSize ?? 50
    if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 20) throw new Error(t("walrus.invalidMaxPages"))
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50) throw new Error(t("walrus.invalidPageSize"))

    const { object } = await client.getObject({ objectId: registryId, include: { content: true }, signal: requestSignal() })
    if (!isRegistryType(object.type)) throw new Error(t("walrus.notRegistryType"))
    if (object.owner.$kind !== "Shared") throw new Error(t("walrus.registryNotShared"))
    const registry = RegistryContent.parse(object.content)
    if (normalizeSuiAddress(registry.id) !== registryId) throw new Error(t("walrus.registryIdMismatch"))

    const entries: Array<{ blobId: string; fieldId: string }> = []
    const cursors = new Set<string>()
    let cursor: string | null = null
    let truncated = false
    for (let pageIndex = 0; pageIndex < maxPages; pageIndex++) {
      const page: SuiClientTypes.ListDynamicFieldsResponse = await client.listDynamicFields({
        parentId: registry.policies.id, cursor, limit: pageSize, signal: requestSignal(),
      })
      for (const entry of page.dynamicFields) {
        if (entry.$kind !== "DynamicField") throw new Error(t("walrus.dynamicObjectFieldUnsupported"))
        entries.push({ blobId: bcs.string().parse(entry.name.bcs), fieldId: entry.fieldId })
      }
      if (!page.hasNextPage) break
      if (!page.cursor || cursors.has(page.cursor) || page.cursor === cursor) throw new Error(t("walrus.registryPaginationStuck"))
      if (pageIndex === maxPages - 1) { truncated = true; break }
      cursors.add(page.cursor)
      cursor = page.cursor
    }
    // A bounded read that stopped early must not be reported as a complete table.
    if (!truncated && BigInt(entries.length) !== BigInt(registry.policies.size)) throw new Error(t("walrus.registryIncomplete"))

    const policies: WalrusPaymentPolicy[] = []
    const failures: RegistrySnapshot["failures"] = []
    for (let index = 0; index < entries.length; index += 20) {
      const batch = entries.slice(index, index + 20)
      const { objects } = await client.getObjects({
        objectIds: batch.map(entry => entry.fieldId), include: { content: true }, signal: requestSignal(),
      })
      for (const [offset, object] of objects.entries()) {
        const expected = batch[offset]
        if (object instanceof Error) { failures.push({ blobId: expected.blobId, reason: message(object) }); continue }
        try {
          if (!isPolicyFieldType(object.type)) throw new Error(t("walrus.policyFieldTypeMismatch"))
          const field = PolicyField.parse(object.content)
          if (field.name !== expected.blobId) throw new Error(t("walrus.policyFieldNameMismatch"))
          policies.push({
            blobId: field.name,
            channelId: normalizeSuiAddress(field.value.channel_id),
            minMemberStakeMist: field.value.min_member_stake,
            recipient: normalizeSuiAddress(field.value.recipient),
            maxPaymentMist: field.value.max_payment,
            epochBudgetMist: field.value.epoch_budget,
            spentInEpochMist: field.value.spent_in_epoch,
            lastPaymentEpoch: field.value.last_payment_epoch,
            isActive: field.value.is_active,
          })
        } catch (cause) { failures.push({ blobId: expected.blobId, reason: message(cause) }) }
      }
    }
    policies.sort((left, right) => left.blobId.localeCompare(right.blobId))
    return { registryId, totalApps: registry.total_apps, policies, truncated, failures }
  }

  return { readRegistry }
}

export const registryClient = new SuiGrpcClient({ network: "testnet", baseUrl: "https://fullnode.testnet.sui.io:443" })
export const policyReader = createPolicyReader(registryClient)
export const policyDeployment = () => verifyPolicyDeployment(registryClient)

// === Created-object resolution ===

function isAdminCapType(value: string): boolean {
  let normalized: string
  try { normalized = normalizeStructTag(value) } catch { return false }
  const capTypes = [PROPOSAL_TYPE_ORIGIN, policyPackageId()]
    .map(origin => normalizeStructTag(`${origin}::${POLICY_MODULE}::AdminCap`))
  return capTypes.includes(normalized)
}

const AdminCapContent = bcs.struct("AdminCap", { id: bcs.Address, registry_id: bcs.Address })

/**
 * Resolve the registry and admin cap created by a user-signed `initialize`
 * transaction. The cap's `registry_id` must name the resolved registry and its
 * owner must be the signer, so a partial or mismatched creation never reports
 * success and is never saved locally.
 */
export async function findCreatedRegistry(
  client: Pick<SuiGrpcClient, "getObjects">,
  createdObjects: string[],
  query: { expectedOwner: string },
): Promise<{ registryId: string; adminCapId: string }> {
  if (!createdObjects.length) throw new Error(t("walrus.noCreatedObjects"))
  const { objects } = await client.getObjects({ objectIds: createdObjects, include: { content: true }, signal: requestSignal() })
  const registries = objects.filter(object => !(object instanceof Error) && isRegistryType(object.type))
  const caps = objects.filter(object => !(object instanceof Error) && isAdminCapType(object.type))
  if (registries.length !== 1 || caps.length !== 1) throw new Error(t("walrus.ambiguousCreation"))
  const registryObject = registries[0]
  const capObject = caps[0]
  if (registryObject instanceof Error || capObject instanceof Error) throw new Error(t("walrus.createdReadFailed"))
  if (registryObject.owner.$kind !== "Shared") throw new Error(t("walrus.newRegistryNotShared"))
  const registry = RegistryContent.parse(registryObject.content)
  const registryId = normalizeSuiAddress(registryObject.objectId)
  if (normalizeSuiAddress(registry.id) !== registryId) throw new Error(t("walrus.registryIdMismatch"))
  const cap = AdminCapContent.parse(capObject.content)
  if (normalizeSuiAddress(cap.id) !== normalizeSuiAddress(capObject.objectId)) throw new Error(t("walrus.adminCapIdMismatch"))
  if (normalizeSuiAddress(cap.registry_id) !== registryId) throw new Error(t("walrus.adminCapRegistryMismatch"))
  const owner = capObject.owner && typeof capObject.owner === "object" ? (capObject.owner as { $kind?: string; AddressOwner?: string }) : {}
  const capOwner = owner.$kind === "AddressOwner" && owner.AddressOwner ? normalizeSuiAddress(owner.AddressOwner) : null
  if (capOwner === null || capOwner !== normalizeSuiAddress(query.expectedOwner)) {
    throw new Error(t("walrus.adminCapOwnerMismatch", { address: normalizeSuiAddress(query.expectedOwner) }))
  }
  return { registryId, adminCapId: normalizeSuiAddress(capObject.objectId) }
}

// === Payer's stake receipts ===

const StakeReceiptContent = bcs.struct("MemberStakeReceipt", {
  id: bcs.Address,
  channel_id: bcs.Address,
  member: bcs.Address,
  staked_amount: bcs.u64(),
})

export interface StakeReceiptEntry {
  receiptId: string
  channelId: string
  member: string
  stakedAmountMist: string
}

export type StakeReceiptClient = Pick<SuiGrpcClient, "listOwnedObjects">

function isStakeReceiptType(value: string): boolean {
  let normalized: string
  try { normalized = normalizeStructTag(value) } catch { return false }
  const receiptTypes = [PROPOSAL_TYPE_ORIGIN, policyPackageId()]
    .map(origin => normalizeStructTag(`${origin}::onchain_chat::MemberStakeReceipt`))
  return receiptTypes.includes(normalized)
}

/**
 * List the payer's own `MemberStakeReceipt` objects from onchain_chat. The
 * chain re-validates receipt ownership, channel membership and the minimum
 * stake on every pay(); this only offers real owned objects in the form
 * instead of hand-typed ids, so a mistyped channel/receipt pair cannot be
 * signed. Decoding failures are surfaced, never skipped.
 */
export async function listOwnStakeReceipts(
  client: StakeReceiptClient,
  owner: string,
  options: { maxPages?: number; pageSize?: number } = {},
): Promise<StakeReceiptEntry[]> {
  const normalizedOwner = parseObjectId(owner, t("walrus.labelAccount"))
  const maxPages = options.maxPages ?? 4
  const pageSize = options.pageSize ?? 50
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 10) throw new Error(t("walrus.receiptInvalidMaxPages"))
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50) throw new Error(t("walrus.receiptInvalidPageSize"))
  const filterType = normalizeStructTag(`${PROPOSAL_TYPE_ORIGIN}::onchain_chat::MemberStakeReceipt`)

  const receipts: StakeReceiptEntry[] = []
  const seen = new Set<string>()
  const cursors = new Set<string>()
  let cursor: string | null = null
  for (let pageIndex = 0; pageIndex < maxPages; pageIndex++) {
    const page: SuiClientTypes.ListOwnedObjectsResponse<{ content: true }> = await client.listOwnedObjects({
      owner: normalizedOwner, type: filterType, cursor, limit: pageSize, include: { content: true }, signal: requestSignal(),
    })
    for (const object of page.objects) {
      const receiptId = normalizeSuiAddress(object.objectId)
      if (seen.has(receiptId)) continue
      seen.add(receiptId)
      if (!isStakeReceiptType(object.type)) throw new Error(t("walrus.receiptTypeMismatch"))
      const receipt = StakeReceiptContent.parse(object.content)
      if (normalizeSuiAddress(receipt.id) !== receiptId) throw new Error(t("walrus.receiptIdMismatch"))
      if (normalizeSuiAddress(receipt.member) !== normalizedOwner) throw new Error(t("walrus.receiptOwnerMismatch"))
      receipts.push({
        receiptId,
        channelId: normalizeSuiAddress(receipt.channel_id),
        member: normalizeSuiAddress(receipt.member),
        stakedAmountMist: receipt.staked_amount,
      })
    }
    if (!page.hasNextPage) break
    if (!page.cursor || cursors.has(page.cursor) || page.cursor === cursor) throw new Error(t("walrus.receiptPaginationStuck"))
    cursors.add(page.cursor)
    cursor = page.cursor
  }
  receipts.sort((left, right) => left.channelId.localeCompare(right.channelId) || left.receiptId.localeCompare(right.receiptId))
  return receipts
}

// === Channel pre-check ===

function isChatChannelType(value: string): boolean {
  let normalized: string
  try { normalized = normalizeStructTag(value) } catch { return false }
  const channelTypes = [PROPOSAL_TYPE_ORIGIN, policyPackageId()]
    .map(origin => normalizeStructTag(`${origin}::onchain_chat::ChatChannel`))
  return channelTypes.includes(normalized)
}

/**
 * Pre-check one channel object before an app is registered against it: the
 * object must exist and be a shared `ChatChannel` of this package. The
 * contract still validates the channel at register time; this only stops an
 * obvious typo or foreign object from being signed (and paying gas).
 */
export async function verifyChatChannel(
  client: Pick<SuiGrpcClient, "getObject">,
  channelId: string,
): Promise<{ channelId: string }> {
  const id = parseObjectId(channelId, t("walrus.labelChannelId"))
  const { object } = await client.getObject({ objectId: id, include: { content: true }, signal: requestSignal() })
  if (!isChatChannelType(object.type)) throw new Error(t("walrus.notChatChannelType"))
  if (object.owner.$kind !== "Shared") throw new Error(t("walrus.channelNotShared"))
  return { channelId: id }
}

// === Local registry pointer ===

/** Local, user-supplied registry id. Nothing is published on this device's behalf. */
const REGISTRY_STORAGE_KEY = "sui_walrus_policy_registry"
/**
 * Local pointer to the user's own AdminCap. An object id is not authority —
 * the chain checks cap ownership on every admin call — this only prefills the
 * register/toggle forms for the account that initialized the registry.
 */
const REGISTRY_ADMIN_CAP_STORAGE_KEY = "sui_walrus_policy_registry_admin_cap"

export function readSavedRegistryId(): string {
  if (typeof window === "undefined") return ""
  try {
    const value = localStorage.getItem(REGISTRY_STORAGE_KEY) || ""
    return value ? parseRegistryId(value) : ""
  } catch { return "" }
}

export function saveRegistryId(value: string): string {
  const id = parseRegistryId(value)
  localStorage.setItem(REGISTRY_STORAGE_KEY, id)
  return id
}

export function clearSavedRegistryId(): void {
  try { localStorage.removeItem(REGISTRY_STORAGE_KEY) } catch {}
}

export function readSavedRegistryAdminCapId(): string {
  if (typeof window === "undefined") return ""
  try {
    const value = localStorage.getItem(REGISTRY_ADMIN_CAP_STORAGE_KEY) || ""
    return value ? parseObjectId(value, t("walrus.labelAdminCapId")) : ""
  } catch { return "" }
}

export function saveRegistryAdminCapId(value: string): string {
  const id = parseObjectId(value, t("walrus.labelAdminCapId"))
  localStorage.setItem(REGISTRY_ADMIN_CAP_STORAGE_KEY, id)
  return id
}

export function clearSavedRegistryAdminCapId(): void {
  try { localStorage.removeItem(REGISTRY_ADMIN_CAP_STORAGE_KEY) } catch {}
}

export function registryIdFromEnv(): string {
  try { return parseRegistryId(process.env.NEXT_PUBLIC_WALRUS_APP_REGISTRY_ID || "") }
  catch { return "" }
}
