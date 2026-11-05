// AgentVault on-chain reader and transaction builders.
//
// The deployed `agent_vault::vault` module has no card or log objects: an agent
// is an owned `AgentCap` (a pure spending credential) plus a row in the vault's
// inline `agents` table, and every spend is an `AgentBudgetSpentEvent`. Since
// 2026-10-29 the budget/pause fields are vault-authoritative, so discovery
// verifies each capability the current account holds, then reconciles it against
// the shared vault object and its table. Nothing here is synthesised: an
// unverified capability is reported as such and never shown as an active card.
import { bcs } from "@mysten/sui/bcs"
import type { SuiClientTypes } from "@mysten/sui/client"
import { SuiGrpcClient } from "@mysten/sui/grpc"
import { normalizeStructTag, normalizeSuiAddress, parseStructTag } from "@mysten/sui/utils"
import { Transaction } from "@mysten/sui/transactions"
import {
  AgentCapBcs, AgentVaultBcs, MasterCapBcs, OperatorCapBcs, parseFinanceBcs,
  createAgentVaultWriters as sdkCreateAgentVaultWriters,
} from "multisig/agent-vault/finance"
import { AGENT_VAULT_PACKAGE_ID as SDK_AGENT_VAULT_PACKAGE_ID } from "multisig/agent-vault/org"
import { t } from "@/lib/i18n/t"

export const AGENT_VAULT_PACKAGE_ID = process.env.NEXT_PUBLIC_AGENT_VAULT_PACKAGE_ID || SDK_AGENT_VAULT_PACKAGE_ID
export const AGENT_VAULT_TYPE_ORIGIN = SDK_AGENT_VAULT_PACKAGE_ID
export const SUI_TYPE = normalizeStructTag("0x2::sui::SUI")
const CLOCK = "0x6"

const signal = () => AbortSignal.timeout(20_000)
const id = (value: string) => {
  if (typeof value !== "string" || !/^0x[\da-fA-F]{1,64}$/.test(value) || BigInt(value) === 0n) throw new Error(t("agents.chain.idOrAddressInvalid"))
  return normalizeSuiAddress(value)
}
const coinTag = (value: string) => {
  const tag = parseStructTag(value)
  id(tag.address)
  if (!/^[A-Za-z_][\w]*$/.test(tag.module) || !/^[A-Za-z_][\w]*$/.test(tag.name)) throw new Error(t("agents.chain.coinTagInvalid"))
  return normalizeStructTag(tag)
}

export const agentVaultBcs = AgentVaultBcs
export const masterCapBcs = MasterCapBcs
export const operatorCapBcs = OperatorCapBcs
export const agentCapBcs = AgentCapBcs
export const agentBudgetSpentBcs = bcs.struct("AgentBudgetSpentEvent", {
  vault_id: bcs.Address,
  agent_id: bcs.Address,
  amount: bcs.u64(),
  current_epoch: bcs.u64(),
  recipient: bcs.Address,
})
export const agentStatusChangedBcs = bcs.struct("AgentStatusChangedEvent", { vault_id: bcs.Address, agent_id: bcs.Address, is_active: bcs.bool() })
export const emergencyPurgeBcs = bcs.struct("EmergencyPurgeEvent", { vault_id: bcs.Address, new_version: bcs.u64(), remaining_balance: bcs.u64() })

function parseExact<Output, Input>(codec: { parse(bytes: Uint8Array): Output; serialize(value: Input): { toBytes(): Uint8Array } }, bytes: Uint8Array): Output {
  try {
    return parseFinanceBcs(codec, bytes)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("财务对象 BCS")) throw new Error(`AgentVault ${error.message.slice("财务对象 ".length)}`)
    throw error
  }
}

export interface AgentVaultState {
  vaultId: string
  coinType: string
  balance: bigint
  vaultVersion: bigint
  totalSubagents: bigint
  paused: boolean
  /** 内联 agents 表（2026-10-29 起卡片额度/启停的唯一事实源）。 */
  agents: Map<string, AgentRecordRow>
}

/** 金库 agents 表的一行：以 agent 地址为主键的管理视图。 */
export interface AgentRecordRow {
  dailyBudget: bigint
  spentInEpoch: bigint
  lastSpentEpoch: bigint
  serviceHash: Uint8Array
  isActive: boolean
}

/** 瘦 AgentCap：只绑定身份；额度/启停不在卡上，在金库表。 */
export interface AgentCapState {
  capId: string
  vaultId: string
  vaultVersion: bigint
  agentId: string
  /** Sui object owner of the cap. Only this address can sign spends with it. */
  capOwner: string | null
}

export interface AgentCardRecord {
  /** Cap object id; the only stable identifier the contract provides. */
  capId: string
  vaultId: string
  vault: AgentVaultState
  cap: AgentCapState | null
  /** 金库表中该 agent 的行；缺失 = 卡片不在当前金库权威表内。 */
  record: AgentRecordRow | null
  /** `active` only when the cap is owned by the account and matches the live vault version. */
  status: "active" | "quota" | "paused" | "stale" | "unverified"
  reason: string
  /** Counter the contract would use on the next spend: stale epoch counters reset to zero. */
  effectiveSpent: bigint
  /**
   * False when the current epoch could not be read, so `effectiveSpent` is the
   * stored counter rather than a projection. The UI must not present a quota
   * verdict as a fact while this is false.
   */
  epochKnown: boolean
  spentEvents: Array<{ digest: string; amount: bigint; epoch: bigint; recipient: string; timestampMs: number | null }>
  /**
   * Set when the spend-event scan stopped at its page budget or a row cap.
   * `spentEvents` is then the most recent slice, not the full history.
   */
  spentEventsTruncated: boolean
  /**
   * Set when reading the spend feed failed. The cap and vault above are still
   * verified; only the supplementary history is missing. Never folded into
   * `status`, and never rendered as "no spends".
   */
  spentEventsError: string
}

export interface MasterCapState { capId: string; vaultId: string }
export interface OperatorCapState { capId: string; vaultId: string; vaultVersion: bigint; operatorAddress: string }

export interface AgentVaultSnapshot {
  /** Every vault reachable from a capability the account holds, with live state. */
  vaults: AgentVaultState[]
  masterCaps: MasterCapState[]
  operatorCaps: OperatorCapState[]
  cards: AgentCardRecord[]
  errors: string[]
}

export type AgentVaultClient = Pick<SuiGrpcClient, "getObject" | "getObjects" | "listOwnedObjects" | "listEvents" | "getTransaction" | "getCurrentSystemState">

export interface AgentEpochInfo { epoch: bigint; startedAtMs: number; durationMs: number }

export function createAgentVaultReader(client: AgentVaultClient, _packageId = AGENT_VAULT_PACKAGE_ID, typeOrigin = AGENT_VAULT_TYPE_ORIGIN) {
  const origin = id(typeOrigin)
  const vaultType = (type: string) => normalizeStructTag(`${origin}::vault::AgentVault<${type}>`)
  const capType = (name: string) => normalizeStructTag(`${origin}::vault::${name}`)

  function decodeAgentCap(objectId: string, cap: ReturnType<typeof agentCapBcs.parse>, owner: unknown): AgentCapState {
    if (cap.id !== objectId) throw new Error(t("agents.chain.capIdMismatch"))
    const ownerKind = owner && typeof owner === "object" ? (owner as { $kind?: string; AddressOwner?: string }) : {}
    return {
      capId: objectId, vaultId: normalizeSuiAddress(cap.vault_id), vaultVersion: BigInt(cap.vault_version), agentId: normalizeSuiAddress(cap.agent_id),
      capOwner: ownerKind.$kind === "AddressOwner" && ownerKind.AddressOwner ? normalizeSuiAddress(ownerKind.AddressOwner) : null,
    }
  }

  /** VecMap<address, AgentRecord> 内联表 → 按 agent 地址索引的行。 */
  function decodeAgentTable(raw: { contents?: Array<{ key: string; value: Record<string, unknown> }> } | undefined): Map<string, AgentRecordRow> {
    const rows = new Map<string, AgentRecordRow>()
    for (const entry of raw?.contents ?? []) {
      if (!entry || typeof entry.key !== "string" || !entry.value || typeof entry.value !== "object") continue
      const value = entry.value as { daily_budget_limit?: string | number; spent_in_current_epoch?: string | number; last_spent_epoch?: string | number; service_target_hash?: Array<string | number>; is_active?: boolean }
      rows.set(normalizeSuiAddress(entry.key), {
        dailyBudget: BigInt(String(value.daily_budget_limit ?? "0")),
        spentInEpoch: BigInt(String(value.spent_in_current_epoch ?? "0")),
        lastSpentEpoch: BigInt(String(value.last_spent_epoch ?? "0")),
        serviceHash: Uint8Array.from((value.service_target_hash ?? []).map(Number)),
        isActive: Boolean(value.is_active),
      })
    }
    return rows
  }

  async function readVault(vaultId: string, coinType = SUI_TYPE): Promise<AgentVaultState> {
    const objectId = id(vaultId)
    const expected = vaultType(coinTag(coinType))
    const { object } = await client.getObject({ objectId, include: { content: true }, signal: signal() })
    if (normalizeSuiAddress(object.objectId) !== objectId || normalizeStructTag(object.type) !== expected || object.owner.$kind !== "Shared") throw new Error(t("agents.chain.notSharedVault"))
    const vault = parseExact(agentVaultBcs, object.content)
    if (vault.id !== objectId || BigInt(vault.vault_version) < 1n) throw new Error(t("agents.chain.vaultIdOrVersionInvalid"))
    return { vaultId: objectId, coinType: coinTag(coinType), balance: BigInt(vault.balance), vaultVersion: BigInt(vault.vault_version), totalSubagents: BigInt(vault.total_subagents), paused: vault.paused, agents: decodeAgentTable(vault.agents) }
  }

  async function readAgentCap(capId: string): Promise<AgentCapState> {
    const objectId = id(capId)
    const { object } = await client.getObject({ objectId, include: { content: true }, signal: signal() })
    if (normalizeSuiAddress(object.objectId) !== objectId || normalizeStructTag(object.type) !== capType("AgentCap")) throw new Error(t("agents.chain.notAgentCap"))
    return decodeAgentCap(objectId, parseExact(agentCapBcs, object.content), object.owner)
  }

  async function owned(address: string, type: string) {
    const owner = id(address), ids: string[] = []
    const cursors = new Set<string>()
    let cursor: string | null = null
    for (let pageIndex = 0; pageIndex < 8; pageIndex++) {
      const page: SuiClientTypes.ListOwnedObjectsResponse = await client.listOwnedObjects({ owner, type, cursor, limit: 50, signal: signal() })
      for (const object of page.objects) ids.push(normalizeSuiAddress(object.objectId))
      if (!page.hasNextPage) return ids
      if (!page.cursor || cursors.has(page.cursor)) throw new Error(t("agents.chain.capPaginationStuck"))
      cursors.add(page.cursor); cursor = page.cursor
    }
    throw new Error(t("agents.chain.capReadLimit"))
  }

  /**
   * The spend feed is a bounded scan of the *global* `AgentBudgetSpentEvent`
   * stream, filtered to one agent locally, so it can end before reaching this
   * agent's history. That is reported as `truncated` rather than a short list
   * that looks complete — every other reader in this codebase does the same.
   */
  // `_coinType` is part of the reader's call shape; the event stream is per-vault
  // and the coin is already fixed by the vault's type argument.
  async function spendEvents(vaultId: string, agentId: string, _coinType: string) {
    const eventType = normalizeStructTag(`${origin}::vault::AgentBudgetSpentEvent`)
    const target = id(vaultId), agent = id(agentId)
    const rows: AgentCardRecord["spentEvents"] = []
    const cursors = new Set<string>()
    let before: string | null = null
    let truncated = false
    for (let pageIndex = 0; pageIndex < 4; pageIndex++) {
      const page: SuiClientTypes.ListEventsResponse = await client.listEvents({ filter: { eventType }, before, order: "descending", limit: 50, signal: signal() })
      for (const event of page.events) {
        if (normalizeStructTag(event.eventType) !== eventType) continue
        const spent = parseExact(agentBudgetSpentBcs, event.bcs)
        if (spent.vault_id !== target || spent.agent_id !== agent) continue
        let timestampMs: number | null = null
        try {
          const tx = await client.getTransaction({ digest: event.transactionDigest, signal: signal() })
          if (tx.$kind === "Transaction" && tx.Transaction.status.success) timestampMs = tx.Transaction.timestampMs ?? null
        } catch { timestampMs = null }
        rows.push({ digest: event.transactionDigest, amount: BigInt(spent.amount), epoch: BigInt(spent.current_epoch), recipient: normalizeSuiAddress(spent.recipient), timestampMs })
        if (rows.length >= 50) return { rows, truncated: true }
      }
      if (!page.hasNextPage) break
      // A cursor that repeats would loop forever; that is a failed read, not
      // a clean end, so it must not look like "this agent never spent".
      if (!page.endCursor || cursors.has(page.endCursor)) throw new Error(t("agents.chain.spendPaginationStuck"))
      if (pageIndex === 3) { truncated = true; break }
      cursors.add(page.endCursor); before = page.endCursor
    }
    return { rows, truncated }
  }

  /**
   * Every cap reachable from `address`, reconciled against the live shared
   * vault. `spawn_agent_card` transfers the AgentCap to the agent address, so a
   * card issued to a separate agent key never appears in the operator's owned
   * objects: `indexedCapIds` supplies IDs only, and each one must still verify
   * as a real AgentCap joined to a live vault. The index never supplies values.
   */
  async function snapshot(address: string, indexedCapIds: string[] = []): Promise<AgentVaultSnapshot> {
    const owner = id(address), errors: string[] = []
    let currentEpoch: bigint | null = null
    try { currentEpoch = (await readAgentEpoch(client)).epoch } catch { currentEpoch = null }
    const [masterCapIds, operatorCapIds, discoveredCapIds] = await Promise.all([
      owned(owner, capType("MasterCap")), owned(owner, capType("OperatorCap")), owned(owner, capType("AgentCap")),
    ])
    const agentCapIds: string[] = []
    for (const capId of [...discoveredCapIds, ...indexedCapIds]) {
      const value = id(capId)
      if (!agentCapIds.includes(value)) agentCapIds.push(value)
    }
    const vaults = new Map<string, Promise<AgentVaultState>>()
    const readVaultOnce = (vaultId: string) => {
      if (!vaults.has(vaultId)) vaults.set(vaultId, readVault(vaultId))
      return vaults.get(vaultId)!
    }
    const masterCaps: MasterCapState[] = []
    for (const capId of masterCapIds) {
      try {
        const cap = await readMasterCap(capId)
        await readVaultOnce(cap.vaultId)
        masterCaps.push(cap)
      } catch (error) {
        errors.push(`${capId}: ${error instanceof Error ? error.message : t("agents.chain.masterCapReadFailed")}`)
      }
    }
    const operatorCaps: OperatorCapState[] = []
    for (const capId of operatorCapIds) {
      try {
        const cap = await readOperatorCap(capId)
        await readVaultOnce(cap.vaultId)
        operatorCaps.push(cap)
      } catch (error) {
        errors.push(`${capId}: ${error instanceof Error ? error.message : t("agents.chain.operatorCapReadFailed")}`)
      }
    }
    const cards: AgentCardRecord[] = []
    for (const capId of agentCapIds) {
      // Verification and the optional spend feed are separated on purpose: a
      // spend-feed timeout must not demote a cap whose object and vault both
      // read correctly. Folding them together made a network blip look like an
      // authority/version mismatch.
      let cap: AgentCapState
      let vault: AgentVaultState
      try {
        cap = await readAgentCap(capId)
        vault = await readVaultOnce(cap.vaultId)
      } catch (error) {
        const message = error instanceof Error ? error.message : t("agents.chain.agentCapReadFailed")
        errors.push(`${capId}: ${message}`)
        cards.push({ capId, vaultId: "", vault: { vaultId: "", coinType: SUI_TYPE, balance: 0n, vaultVersion: 0n, totalSubagents: 0n, paused: false, agents: new Map() }, cap: null, record: null, status: "unverified", reason: message, effectiveSpent: 0n, epochKnown: currentEpoch !== null, spentEvents: [], spentEventsTruncated: false, spentEventsError: "" })
        continue
      }
      // 额度/启停以金库 agents 表为权威（2026-10-29 合约改进）。
      // `spend_x402_budget` resets spent_in_current_epoch only when the next
      // spend happens in a later epoch. Before then the stored counter may be
      // stale, so the remaining budget is projected from the real epoch.
      const record = vault.agents.get(cap.agentId) ?? null
      const epoch = currentEpoch
      const epochKnown = epoch !== null
      const effectiveSpent = record && epoch !== null && epoch > record.lastSpentEpoch ? 0n : record ? record.spentInEpoch : 0n
      let status: AgentCardRecord["status"], reason: string
      if (!record) {
        status = "stale"
        reason = t("agents.chain.reasonNoRecord")
      } else if (cap.vaultVersion !== vault.vaultVersion) {
        status = "stale"
        reason = t("agents.chain.reasonVersionMismatch", { capVersion: cap.vaultVersion, vaultVersion: vault.vaultVersion })
      } else if (vault.paused) {
        status = "paused"
        reason = t("agents.chain.reasonVaultPaused")
      } else if (!record.isActive) {
        status = "paused"
        reason = t("agents.chain.reasonAgentPaused")
      } else if (effectiveSpent >= record.dailyBudget) {
        status = "quota"
        // Without a live epoch this counter may be last epoch's; say so instead
        // of asserting the budget is exhausted.
        reason = epochKnown
          ? t("agents.chain.reasonQuota")
          : t("agents.chain.reasonQuotaEpochUnknown")
      } else {
        status = "active"
        reason = t("agents.chain.reasonActive")
      }
      let spent: Awaited<ReturnType<typeof spendEvents>> = { rows: [], truncated: false }
      let spentEventsError = ""
      try { spent = await spendEvents(cap.vaultId, cap.agentId, vault.coinType) }
      catch (error) { spentEventsError = error instanceof Error ? error.message : t("agents.chain.spendEventsReadFailed") }
      cards.push({ capId, vaultId: cap.vaultId, vault, cap, record, status, reason, effectiveSpent, epochKnown, spentEvents: spent.rows, spentEventsTruncated: spent.truncated, spentEventsError })
    }
    const resolved: AgentVaultState[] = []
    for (const [vaultId, pending] of vaults) {
      try { resolved.push(await pending) }
      catch (error) {
        const message = error instanceof Error ? error.message : t("agents.chain.vaultReadFailed")
        if (!errors.some(entry => entry.startsWith(`${vaultId}:`))) errors.push(`${vaultId}: ${message}`)
      }
    }
    return { vaults: resolved, masterCaps, operatorCaps, cards, errors }
  }

  async function readMasterCap(capId: string): Promise<MasterCapState> {
    const objectId = id(capId)
    const { object } = await client.getObject({ objectId, include: { content: true }, signal: signal() })
    if (normalizeSuiAddress(object.objectId) !== objectId || normalizeStructTag(object.type) !== capType("MasterCap")) throw new Error(t("agents.chain.notMasterCap"))
    const cap = parseExact(masterCapBcs, object.content)
    if (cap.id !== objectId) throw new Error(t("agents.chain.masterCapIdMismatch"))
    return { capId: objectId, vaultId: normalizeSuiAddress(cap.vault_id) }
  }

  async function readOperatorCap(capId: string): Promise<OperatorCapState> {
    const objectId = id(capId)
    const { object } = await client.getObject({ objectId, include: { content: true }, signal: signal() })
    if (normalizeSuiAddress(object.objectId) !== objectId || normalizeStructTag(object.type) !== capType("OperatorCap")) throw new Error(t("agents.chain.notOperatorCap"))
    const cap = parseExact(operatorCapBcs, object.content)
    if (cap.id !== objectId) throw new Error(t("agents.chain.operatorCapIdMismatch"))
    return { capId: objectId, vaultId: normalizeSuiAddress(cap.vault_id), vaultVersion: BigInt(cap.vault_version), operatorAddress: normalizeSuiAddress(cap.operator_address) }
  }

  return { readVault, readAgentCap, readMasterCap, readOperatorCap, snapshot, spendEvents, readEpoch: () => readAgentEpoch(client), client }
}

/**
 * The budget resets when the Sui epoch advances, not on a 24h wall clock. The
 * UI shows the real epoch window so a reset is never promised earlier or later.
 */
export async function readAgentEpoch(client: Pick<AgentVaultClient, "getCurrentSystemState">): Promise<AgentEpochInfo> {
  const { systemState } = await client.getCurrentSystemState({ signal: signal() })
  const epoch = BigInt(systemState.epoch), startedAtMs = Number(systemState.epochStartTimestampMs), durationMs = Number(systemState.parameters.epochDurationMs)
  if (epoch < 0n || !Number.isFinite(startedAtMs) || !Number.isFinite(durationMs) || durationMs <= 0) throw new Error(t("agents.chain.epochWindowInvalid"))
  return { epoch, startedAtMs, durationMs }
}

// --- Transaction builders ---------------------------------------------------

export interface AgentVaultWriters {
  initializeVault(recipient?: string): Transaction
  deposit(vaultId: string, units: bigint, coin?: string): Transaction
  withdraw(masterCapId: string, vaultId: string, units: bigint, recipient: string): Transaction
  issueOperator(masterCapId: string, vaultId: string, operator: string): Transaction
  spawnAgent(operatorCapId: string, vaultId: string, agent: string, dailyBudget: bigint, serviceHash: Uint8Array): Transaction
  setBudget(operatorCapId: string, vaultId: string, agentAddress: string, dailyBudget: bigint): Transaction
  setPaused(operatorCapId: string, vaultId: string, agentAddress: string, paused: boolean): Transaction
  spend(agentCapId: string, vaultId: string, units: bigint, recipient: string): Transaction
  purge(masterCapId: string, vaultId: string, sweepRecipient: string): Transaction
  unpause(masterCapId: string, vaultId: string): Transaction
}

export function createAgentVaultWriters(packageId = AGENT_VAULT_PACKAGE_ID, coinType = SUI_TYPE): AgentVaultWriters {
  return sdkCreateAgentVaultWriters(packageId, coinType) as unknown as AgentVaultWriters
}

/** SUI amounts use 9 decimals; other coin types must pass their real decimals. */
export function agentSuiUnits(value: string, decimals = 9): bigint {
  const text = value.trim()
  if (!/^\d+(\.\d+)?$/.test(text)) throw new Error(t("agents.chain.decimalAmount"))
  const [whole, fraction = ""] = text.split(".")
  if (fraction.length > decimals) throw new Error(t("agents.chain.precisionExceeded", { decimals }))
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0")
}

export function formatSuiUnits(units: bigint, decimals = 9): string {
  const base = 10n ** BigInt(decimals)
  const fraction = (units % base).toString().padStart(decimals, "0").replace(/0+$/, "")
  return `${units / base}${fraction ? `.${fraction}` : ""}`
}

/** Where to resolve freshly created vault objects from, and who must hold the cap. */
export interface CreatedVaultQuery {
  /** Original package that owns the vault types; defaults to the current package. */
  typeOrigin?: string
  coinType?: string
  /** Require the MasterCap to be address-owned by exactly this account. */
  expectedOwner?: string
}

/**
 * `initialize_vault` shares the vault and transfers the MasterCap to the sender
 * in one transaction, but neither ID can be referenced until the transaction
 * confirms. This resolves both IDs from the confirmed object set so the next
 * step never guesses a vault address. With `expectedOwner` the MasterCap must
 * also be address-owned by exactly that account before success is reported.
 */
export async function findCreatedVaultObjects(
  client: Pick<AgentVaultClient, "getObjects">,
  createdObjects: string[],
  query: CreatedVaultQuery = {},
): Promise<{ vaultId: string; masterCapId: string }> {
  if (!createdObjects.length) throw new Error(t("agents.chain.noCreatedVault"))
  const origin = id(query.typeOrigin ?? AGENT_VAULT_TYPE_ORIGIN)
  const coinType = query.coinType ?? SUI_TYPE
  const vaultType = normalizeStructTag(`${origin}::vault::AgentVault<${coinTag(coinType)}>`)
  const capType = normalizeStructTag(`${origin}::vault::MasterCap`)
  const { objects } = await client.getObjects({ objectIds: createdObjects, include: { content: true }, signal: signal() })
  const vaults = objects.filter(object => !(object instanceof Error) && normalizeStructTag(object.type) === vaultType)
  const caps = objects.filter(object => !(object instanceof Error) && normalizeStructTag(object.type) === capType)
  if (vaults.length !== 1 || caps.length !== 1) throw new Error(t("agents.chain.vaultNotUnique"))
  const vaultObject = vaults[0]
  const capObject = caps[0]
  if (vaultObject instanceof Error || capObject instanceof Error) throw new Error(t("agents.chain.createdObjectsReadFailed"))
  const vault = parseExact(agentVaultBcs, vaultObject.content)
  const cap = parseExact(masterCapBcs, capObject.content)
  if (normalizeSuiAddress(cap.vault_id) !== normalizeSuiAddress(vaultObject.objectId) || normalizeSuiAddress(vault.id) !== normalizeSuiAddress(vaultObject.objectId)) throw new Error(t("agents.chain.newVaultCapMismatch"))
  if (query.expectedOwner !== undefined) {
    const owner = capObject.owner && typeof capObject.owner === "object" ? (capObject.owner as { $kind?: string; AddressOwner?: string }) : {}
    const capOwner = owner.$kind === "AddressOwner" && owner.AddressOwner ? normalizeSuiAddress(owner.AddressOwner) : null
    if (capOwner === null || capOwner !== normalizeSuiAddress(query.expectedOwner)) throw new Error(t("agents.chain.masterCapOwnerMismatch", { owner: normalizeSuiAddress(query.expectedOwner) }))
  }
  return { vaultId: normalizeSuiAddress(vaultObject.objectId), masterCapId: normalizeSuiAddress(capObject.objectId) }
}

/**
 * `spawn_agent_card` transfers the new AgentCap to the agent address, so a
 * freshly issued card is not among the sender's owned objects. Resolve it from
 * the confirmed creation set instead of guessing a cap id. With `expectedOwner`
 * the cap must additionally be address-owned by exactly that account — the
 * caller asserts the card actually reached its intended agent. The cap carries
 * identity only; budget/pause state lives in the vault's agents table.
 */
export async function findCreatedAgentCap(
  client: Pick<AgentVaultClient, "getObjects">,
  createdObjects: string[],
  query: { typeOrigin?: string; expectedOwner?: string } = {},
): Promise<AgentCapState> {
  if (!createdObjects.length) throw new Error(t("agents.chain.noCreatedCap"))
  const capType = normalizeStructTag(`${id(query.typeOrigin ?? AGENT_VAULT_TYPE_ORIGIN)}::vault::AgentCap`)
  const { objects } = await client.getObjects({ objectIds: createdObjects, include: { content: true }, signal: signal() })
  const matches = objects.filter(object => !(object instanceof Error) && normalizeStructTag(object.type) === capType)
  if (matches.length !== 1) throw new Error(t("agents.chain.capNotUnique"))
  const object = matches[0]
  if (object instanceof Error) throw new Error(t("agents.chain.capObjectReadFailed"))
  const objectId = normalizeSuiAddress(object.objectId)
  const cap = parseExact(agentCapBcs, object.content)
  if (cap.id !== objectId) throw new Error(t("agents.chain.capIdMismatch"))
  const owner = object.owner && typeof object.owner === "object" ? (object.owner as { $kind?: string; AddressOwner?: string }) : {}
  const capOwner = owner.$kind === "AddressOwner" && owner.AddressOwner ? normalizeSuiAddress(owner.AddressOwner) : null
  if (query.expectedOwner !== undefined && (capOwner === null || capOwner !== normalizeSuiAddress(query.expectedOwner))) throw new Error(t("agents.chain.capOwnerMismatch", { owner: normalizeSuiAddress(query.expectedOwner) }))
  return {
    capId: objectId, vaultId: normalizeSuiAddress(cap.vault_id), vaultVersion: BigInt(cap.vault_version), agentId: normalizeSuiAddress(cap.agent_id),
    capOwner,
  }
}

/** Local-only display labels. Never treated as chain data. */
export interface AgentVaultLabel { capId: string; name: string; purpose: string; category: string }
export const AGENT_LABEL_KEY = "sui_agent_labels_v1"

export function parseAgentLabels(raw: string | null): Record<string, AgentVaultLabel> {
  const result: Record<string, AgentVaultLabel> = {}
  if (!raw) return result
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return result }
  if (!Array.isArray(parsed)) return result
  for (const value of parsed) {
    if (!value || typeof value !== "object") continue
    const row = value as Record<string, unknown>
    if (typeof row.capId !== "string" || !/^0x[\da-fA-F]{1,64}$/.test(row.capId)) continue
    result[normalizeSuiAddress(row.capId)] = {
      capId: normalizeSuiAddress(row.capId),
      name: typeof row.name === "string" ? row.name.slice(0, 60) : "",
      purpose: typeof row.purpose === "string" ? row.purpose.slice(0, 200) : "",
      category: typeof row.category === "string" ? row.category : "CUSTOM",
    }
  }
  return result
}

export const AGENT_LABEL_CATEGORIES = ["LLM_INFERENCE", "DATA_SCRAPING", "STORAGE", "DEFI_EXECUTION", "CUSTOM"] as const

/** Local index of AgentCap ids this browser created, used only to ask the chain about them. */
export const AGENT_CAP_INDEX_KEY = "sui_agent_cap_index_v1"

/**
 * Reads the index and says whether it was readable.
 *
 * A cap handed to a separate agent address never appears in the operator's
 * owned objects, so this index is the only way that card is ever discovered.
 * Corrupt JSON or blocked storage therefore silently hides real cards, which is
 * why the failure is returned instead of folded into an empty list.
 */
export function readAgentCapIndex(raw: string | null): { ids: string[]; error: string } {
  if (!raw) return { ids: [], error: "" }
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return { ids: [], error: t("agents.chain.indexInvalidJson") } }
  if (!Array.isArray(parsed)) return { ids: [], error: t("agents.chain.indexInvalidFormat") }
  return { ids: parseAgentCapIndex(raw), error: "" }
}

export function parseAgentCapIndex(raw: string | null): string[] {
  if (!raw) return []
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return [] }  if (!Array.isArray(parsed)) return []
  const ids: string[] = []
  for (const value of parsed) {
    if (typeof value !== "string" || !/^0x[\da-fA-F]{1,64}$/.test(value)) continue
    const id = normalizeSuiAddress(value)
    if (!ids.includes(id)) ids.push(id)
  }
  return ids.slice(0, 200)
}

export function addAgentCapIndex(records: string[], capId: string): string[] {
  const id = normalizeSuiAddress(capId)
  return [id, ...records.filter(value => value !== id)].slice(0, 200)
}

/** Drop an ID only after the chain reports the object no longer exists. */
export function removeAgentCapIndex(records: string[], capId: string): string[] {
  const id = normalizeSuiAddress(capId)
  return records.filter(value => value !== id)
}

/** Merge one label into the stored list without dropping other browsers' entries. */
export function writeAgentLabel(records: AgentVaultLabel[], label: AgentVaultLabel): AgentVaultLabel[] {
  if (typeof label.capId !== "string" || !/^0x[\da-fA-F]{1,64}$/.test(label.capId) || BigInt(label.capId) === 0n) throw new Error(t("agents.chain.labelCapIdInvalid"))
  const normalized: AgentVaultLabel = {
    capId: normalizeSuiAddress(label.capId), name: label.name.trim().slice(0, 60),
    purpose: label.purpose.trim().slice(0, 200),
    category: (AGENT_LABEL_CATEGORIES as readonly string[]).includes(label.category) ? label.category : "CUSTOM",
  }
  return [normalized, ...records.filter(record => record.capId !== normalized.capId)]
}

/** Legacy local records from before the chain-backed page; never shown as chain facts. */
export interface LegacyAgentRecord { name: string; address: string; dailyBudget: string; purpose: string }

export function parseLegacyAgentRecords(cards: unknown[], logs: unknown[]): { cards: LegacyAgentRecord[]; logs: number } {
  const records: LegacyAgentRecord[] = []
  for (const value of cards) {
    if (!value || typeof value !== "object") continue
    const row = value as Record<string, unknown>
    records.push({
      name: typeof row.name === "string" ? row.name.slice(0, 60) : t("agents.chain.unnamedLegacy"),
      address: typeof row.address === "string" ? row.address : "",
      dailyBudget: typeof row.dailyBudget === "number" && Number.isFinite(row.dailyBudget) ? String(row.dailyBudget) : t("agents.chain.unknownValue"),
      purpose: typeof row.purpose === "string" ? row.purpose.slice(0, 200) : "",
    })
  }
  return { cards: records, logs: logs.filter(value => value && typeof value === "object").length }
}

export const agentVaultClient = new SuiGrpcClient({ network: "testnet", baseUrl: "https://fullnode.testnet.sui.io:443" })
export const agentVaultReader = createAgentVaultReader(agentVaultClient)
export { CLOCK as AGENT_VAULT_CLOCK_ID }
