"use client"

import { bcs } from "@mysten/sui/bcs"
import { MIST_PER_SUI, SUI_TYPE_ARG, normalizeSuiAddress, normalizeStructTag } from "@mysten/sui/utils"
import { AgentVaultClient } from "./vault-client"
import { assertTransactionAccount, getTransactionAccount, resumePendingTransaction, signAndExecuteWithWallet, type WalletTransactionResult } from "./sui-wallet-signer"
import { acknowledgePendingTransaction, getPendingTransaction, getTransactionReceipt, transactionAccountKey, TransactionReceiptError, type PendingTransactionReceipt, type TransactionAccount } from "./pending-transactions"
import { groupVaults } from "./group-vaults"
import { paymentUnits } from "./scheduled-payments-chain"
import { PROPOSAL_PACKAGE_ID, PROPOSAL_TYPE_ORIGIN, proposalClient, readProposalSnapshot, validateApproval, type ProposalSnapshot } from "./proposal-chain"
import { isRecord, readStoredArray, type RecordSourceStatus } from "./local-records"
import { t } from "./i18n/t"

export const TESTNET_PACKAGE_ID = PROPOSAL_PACKAGE_ID
export const KNOWN_TESTNET_ORG_ID = "0xaf0806fadf61ceeb76c21b40af4393e244a5d8ca91ba208d4f58537421eff2e4"
const SUI_TYPE = SUI_TYPE_ARG

export const vaultClient = new AgentVaultClient({ packageId: TESTNET_PACKAGE_ID, defaultCoinType: SUI_TYPE })

export interface TokenBalanceInfo {
  symbol: string
  name: string
  coinType: string
  balance: string
  rawBalance: bigint
}

export interface ProposalItem {
  id: string
  onChainId?: string
  orgId: string
  vaultId?: string
  masterCapId?: string
  treasuryId?: string
  treasuryBindingId?: string
  title: string
  description: string
  amount: number
  amountMist: string
  token: string
  groupId: string
  groupName: string
  recipient: string
  proposer?: string
  status: "pending" | "approved" | "executed" | "rejected"
  approvals: number
  requiredApprovals: number
  createdAt: string
  expiresAt: string
  deadlineMs: number
  type: "transfer" | "contract" | "batch"
  color: string
  isScheduled?: boolean
  scheduledDate?: string
  isConditional?: boolean
  conditionType?: string
  conditionDetails?: string
  isBatch?: boolean
  batchCount?: number
  voters: string[]
  txDigest?: string
  executionDigest?: string
  executedAt?: string
  rejectedAt?: string
  rejectedWeight?: number
  rejectingVoters?: string[]
  memberWeights?: Record<string, number>
  voteWeights?: Record<string, number>
  chainSyncedAt?: string
  chainEpoch?: string
  organizationEpoch?: string
  rejectionSupported?: boolean
  syncError?: string
  sourceStatus?: RecordSourceStatus
  /** Read-only UI projection metadata; raw malformed data stays recoverable. */
  rawRecord?: Record<string, unknown>
  recordIssues?: string[]
  amountLabel?: string
}

export function getActiveAccount(): { address: string; identifier?: string; type?: string; provider?: string } | null {
  if (typeof window === "undefined") return null
  try {
    const parsed = JSON.parse(localStorage.getItem("sui_active_account") || "null")
    if (typeof parsed?.address === "string" && /^0x[0-9a-fA-F]{1,64}$/.test(parsed.address)) return parsed
  } catch {}
  return null
}

/** Raw balances come from testnet. No price feed or inferred token identities are used. */
export async function fetchRealBalances(address: string) {
  const balances: Array<{ coinType: string; balance: string }> = []
  let cursor: string | null = null
  do {
    const page = await proposalClient.listBalances({ owner: address, cursor, signal: AbortSignal.timeout(15_000) })
    balances.push(...page.balances)
    cursor = page.hasNextPage ? page.cursor : null
  } while (cursor)
  const rawBalance = BigInt(balances.find(b => normalizeStructTag(b.coinType) === SUI_TYPE_ARG)?.balance || "0")
  const whole = rawBalance / MIST_PER_SUI
  const fraction = (rawBalance % MIST_PER_SUI).toString().padStart(9, "0").replace(/0+$/, "")
  const sui: TokenBalanceInfo = { symbol: "SUI", name: "Sui Native Coin", coinType: SUI_TYPE, balance: `${whole}${fraction ? `.${fraction}` : ""}`, rawBalance }
  return { sui, tokens: [sui], all: balances.map(b => ({ coinType: b.coinType, totalBalance: BigInt(b.balance) })) }
}

const text = (value: unknown, fallback = "") => typeof value === "string" ? value : fallback
const nonnegative = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0
const stringList = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
const weights = (value: unknown): Record<string, number> => isRecord(value)
  ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, number] => nonnegative(entry[1]))) : {}

/** Safe display projection; the original incomplete record is never rewritten by a read. */
/**
 * Projects a stored proposal row into the display shape.
 *
 * The parameter is `unknown`-valued on purpose: this row is untrusted JSON, and
 * every read below already goes through a narrowing helper (`text`,
 * `nonnegative`, `isRecord`). An `any` here would let an unchecked property slip
 * into the projection the first time someone forgets one.
 */
function proposalProjection(record: Record<string, unknown>, index: number): ProposalItem {
  const recordIssues = ["id", "orgId", "title", "description", "amountMist", "token", "groupId", "groupName", "recipient", "createdAt", "expiresAt"]
    .filter(key => typeof record[key] !== "string")
  for (const key of ["amount", "approvals", "requiredApprovals", "deadlineMs"]) if (!nonnegative(record[key])) recordIssues.push(key)
  if (!Array.isArray(record.voters) || record.voters.some((value: unknown) => typeof value !== "string")) recordIssues.push("voters")
  if (typeof record.status !== "string" || !["pending", "approved", "executed", "rejected"].includes(record.status)) recordIssues.push("status")
  if (typeof record.type !== "string" || !["transfer", "contract", "batch"].includes(record.type)) recordIssues.push("type")
  for (const key of ["memberWeights", "voteWeights"]) {
    const value = record[key]
    if (value !== undefined && (!isRecord(value) || Object.values(value).some(weight => !nonnegative(weight)))) recordIssues.push(key)
  }
  if (record.rejectingVoters !== undefined && (!Array.isArray(record.rejectingVoters) || record.rejectingVoters.some((value: unknown) => typeof value !== "string"))) recordIssues.push("rejectingVoters")
  const incomplete = recordIssues.length > 0
  return {
    ...record,
    id: text(record.id) || `legacy-proposal-${index}`, orgId: text(record.orgId),
    onChainId: objectId(record.onChainId), vaultId: objectId(record.vaultId), masterCapId: objectId(record.masterCapId),
    // Retain malformed binding metadata so it can never fall through to legacy authority.
    // The cast is deliberate and load-bearing: narrowing a malformed value to
    // `undefined` here would turn "present but invalid" into "absent", which is
    // exactly the fall-through the line above exists to prevent. The consumers
    // re-validate with `objectId` before use.
    treasuryId: record.treasuryId as string | undefined, treasuryBindingId: record.treasuryBindingId as string | undefined,
    title: text(record.title, t("tx.dfltUntitledProposal")), description: text(record.description, t("tx.dfltIncompleteRecord")),
    amount: nonnegative(record.amount) ? record.amount : 0, amountMist: text(record.amountMist),
    amountLabel: typeof record.amountMist === "string" && /^\d+$/.test(record.amountMist) && record.token === "SUI"
      ? `${formatProposalSui(BigInt(record.amountMist))} SUI`
      : nonnegative(record.amount) ? `${record.amount} ${text(record.token, t("tx.dfltUnknownToken"))}` : t("tx.dfltUnknownAmount"),
    token: text(record.token, t("tx.dfltUnknownToken")), groupId: text(record.groupId), groupName: text(record.groupName, t("tx.dfltUnknownGroup")),
    recipient: text(record.recipient), proposer: text(record.proposer),
    approvals: nonnegative(record.approvals) ? record.approvals : 0,
    requiredApprovals: nonnegative(record.requiredApprovals) ? record.requiredApprovals : 0,
    deadlineMs: nonnegative(record.deadlineMs) ? record.deadlineMs : 0,
    createdAt: text(record.createdAt), expiresAt: text(record.expiresAt),
    status: typeof record.status === "string" && ["pending", "approved", "executed", "rejected"].includes(record.status) ? record.status as ProposalItem["status"] : "pending",
    type: typeof record.type === "string" && ["transfer", "contract", "batch"].includes(record.type) ? record.type as ProposalItem["type"] : "transfer",
    color: text(record.color, "from-primary to-purple-500"),
    voters: stringList(record.voters), rejectingVoters: stringList(record.rejectingVoters),
    memberWeights: weights(record.memberWeights), voteWeights: weights(record.voteWeights),
    chainSyncedAt: incomplete ? undefined : text(record.chainSyncedAt) || undefined,
    sourceStatus: !incomplete && record.sourceStatus === "chain-confirmed" ? "chain-confirmed" : "unverified",
    ...(incomplete ? { rawRecord: isRecord(record.rawRecord) ? record.rawRecord : record, recordIssues } : {}),
  }
}

/** Legacy records remain visible; only a canonical refresh can confirm chain state. */
export function getProposals(): ProposalItem[] {
  return readStoredArray("sui_proposals").filter(isRecord).map(proposalProjection)
}

function objectId(value: unknown): string | undefined {
  return typeof value === "string" && /^0x[0-9a-fA-F]{1,64}$/.test(value) ? normalizeSuiAddress(value) : undefined
}

/**
 * One locally stored group after `getUserGroups` has normalised it.
 *
 * Every field the UI reads is present: a legacy record that lacked `id`,
 * `name`, or a usable `members` array is filled in rather than dropped, and
 * `rawRecord` preserves the original when that happened. `sourceStatus` says
 * whether the row came from chain discovery or is still only a local note.
 */
export interface LocalGroupRecord {
  id: string
  name: string
  description: string
  network: string
  members: Array<{ address: string; name: string; weight: number; [key: string]: unknown }>
  orgObjectId?: string
  groupPk: string
  orgTxDigest: string
  threshold?: number
  totalWeight?: number
  /** DKG epoch the organization was finalized at; absent for legacy local rows. */
  epoch?: number
  /** Legacy personal-cap vault link. Empty when the row never had one. */
  vaultId: string
  masterCapId: string
  sourceStatus: RecordSourceStatus
  rawRecord?: Record<string, unknown>
  recordIssues?: string[]
  [key: string]: unknown
}

/** One organization link for group details, proposal creation and the indexer. */
export function getUserGroups(): LocalGroupRecord[] {
  const saved = readStoredArray("user_groups")
  let migrated = false
  const records = saved.map(group => {
    if (!isRecord(group) || typeof group.id !== "string") return group
    try {
      const legacy = JSON.parse(localStorage.getItem(`dao_org_${group.id}`) || "null")
      if (!isRecord(legacy) || (legacy.groupId && legacy.groupId !== group.id) || !objectId(legacy.orgObjectId)) return group
      // An existing canonical link is never silently replaced, even if malformed.
      if (group.orgObjectId) return objectId(group.orgObjectId) === objectId(legacy.orgObjectId) ? group : {
        ...group, organizationSyncError: t("tx.errDkgMismatch"),
      }
      migrated = true
      return { ...group, orgObjectId: objectId(legacy.orgObjectId), groupPk: group.groupPk ?? legacy.groupPk,
        epoch: group.epoch ?? legacy.epoch, orgTxDigest: group.orgTxDigest ?? legacy.txDigest }
    } catch { return group }
  })
  if (migrated) {
    try { localStorage.setItem("user_groups", JSON.stringify(records)) } catch {}
  }
  return records.filter(isRecord).map((group, index) => {
    const incomplete = typeof group.id !== "string" || typeof group.name !== "string" || !Array.isArray(group.members) || group.members.some((member: unknown) =>
      !isRecord(member) || typeof member.address !== "string" || (member.name !== undefined && typeof member.name !== "string"))
    const members = Array.isArray(group.members) ? group.members.map((member: unknown) => {
      const value = isRecord(member) ? member : {}
      return { ...value, name: text(value.name, t("tx.dfltUnknownMember")), address: text(value.address),
        weight: nonnegative(value.weight) ? value.weight : 0 }
    }) : []
    return {
      ...group, id: text(group.id) || `legacy-group-${index}`, name: text(group.name, t("tx.dfltUntitledGroup")),
      description: text(group.description), network: text(group.network, t("tx.dfltUnknownNetwork")), members,
      orgObjectId: objectId(group.orgObjectId), groupPk: text(group.groupPk), orgTxDigest: text(group.orgTxDigest),
      threshold: nonnegative(group.threshold) ? group.threshold : undefined,
      totalWeight: nonnegative(group.totalWeight) ? group.totalWeight : undefined,
      epoch: nonnegative(group.epoch) ? group.epoch : undefined,
      vaultId: text(group.vaultId), masterCapId: text(group.masterCapId),
      sourceStatus: !incomplete && group.sourceStatus === "chain-confirmed" ? "chain-confirmed" : "unverified",
      ...(incomplete ? { rawRecord: group, recordIssues: [t("tx.dfltIncompleteGroup")] } : {}),
    }
  })
}

/** Called only after a successful, typed Organization creation transaction. */
export function persistGroupOrganization(groupId: string, record: {
  orgObjectId: string; groupPk: string; epoch: number; txDigest: string;
  [key: string]: unknown;
}): void {
  if (typeof window === "undefined") return
  const orgId = objectId(record.orgObjectId)
  if (!orgId || !record.txDigest) throw new Error(t("tx.errMissingOrgOrDigest"))
  const saved = readStoredArray("user_groups")
  const group = saved.find(value => isRecord(value) && value.id === groupId)
  if (!isRecord(group)) throw new Error(t("tx.errNoDefaultGroup"))
  if (group.orgObjectId && objectId(group.orgObjectId) !== orgId) throw new Error(t("tx.errGroupLinkedOther"))
  let previous: Record<string, unknown> = {}
  try {
    const value = JSON.parse(localStorage.getItem(`dao_org_${groupId}`) || "null")
    if (isRecord(value)) previous = value
  } catch {}
  const updated = { ...group, orgObjectId: orgId, groupPk: record.groupPk, epoch: record.epoch,
    orgTxDigest: record.txDigest, sourceStatus: "chain-confirmed" }
  // Keep a recovery copy if persisting the canonical collection fails.
  localStorage.setItem(`dao_org_${groupId}`, JSON.stringify({ ...previous, ...record, groupId, orgObjectId: orgId }))
  const groups = saved.map(value => value === group ? updated : value)
  localStorage.setItem("user_groups", JSON.stringify(groups))
  window.dispatchEvent(new CustomEvent("sui-groups-updated", { detail: groups }))
}

export function saveProposals(proposals: ProposalItem[]): void {
  if (typeof window === "undefined") return
  // Invalid/unknown legacy entries are not an excuse to erase stored data.
  const unknown = readStoredArray("sui_proposals").filter(value => !isRecord(value))
  const records = proposals.map(proposal => proposal.rawRecord && proposal.sourceStatus !== "chain-confirmed" ? proposal.rawRecord : proposal)
  localStorage.setItem("sui_proposals", JSON.stringify([...records, ...unknown]))
  window.dispatchEvent(new CustomEvent("sui-proposals-updated", { detail: proposals }))
}

/** Creation effects contain table children too; select by canonical Move type. */
export async function findCreatedProtocolObject(createdObjects: string[], moduleName: string, typeName: string): Promise<string> {
  if (!createdObjects.length) throw new Error(t("tx.errTypeNotFound", { type: typeName }))
  const { objects } = await proposalClient.getObjects({ objectIds: createdObjects, signal: AbortSignal.timeout(20_000) })
  const expectedType = normalizeStructTag(`${PROPOSAL_TYPE_ORIGIN}::${moduleName}::${typeName}`)
  const matches = objects.filter(object => !(object instanceof Error) && normalizeStructTag(object.type) === expectedType)
  if (matches.length !== 1) throw new Error(t("tx.errTypeAmbiguous", { type: typeName }))
  const match = matches[0]
  if (match instanceof Error) throw match
  return match.objectId
}

export const TREASURY_PROPOSAL_CREATE = "group-treasury-proposal-create"
export const LEGACY_PROPOSAL_CREATE = "personal-cap-proposal-create"
const creating = new Set<string>()

export function proposalAmountMist(amount: string): bigint {
  if (typeof amount !== "string") throw new Error(t("tx.errDecimalAmount"))
  return paymentUnits(amount.trim(), 9)
}
export function formatProposalSui(mist: bigint): string {
  const fraction = (mist % MIST_PER_SUI).toString().padStart(9, "0").replace(/0+$/, "")
  return `${mist / MIST_PER_SUI}${fraction ? `.${fraction}` : ""}`
}
function assertProposalContext(account: TransactionAccount, groupId: string, orgId: string) {
  try { assertTransactionAccount(account) } catch (cause) { throw new Error(t("tx.errAccountSwitchedConfirm"), { cause }) }
  if (!groupId || !objectId(orgId) || !getUserGroups().some(group => group.id === groupId && objectId(group.orgObjectId) === objectId(orgId))) {
    throw new Error(t("tx.errOrgChangedOrMissing"))
  }
}
function hasTreasuryMetadata(target: ProposalItem): boolean {
  return target.treasuryId !== undefined || target.treasuryBindingId !== undefined
}
function treasuryIds(target: ProposalItem): { treasuryId: string; bindingId: string } {
  const treasuryId = objectId(target.treasuryId), bindingId = objectId(target.treasuryBindingId)
  if (!treasuryId || !bindingId) throw new Error(t("tx.errTreasuryProposalInvalid"))
  return { treasuryId, bindingId }
}
async function verifyTreasuryProposal(target: ProposalItem) {
  const { treasuryId, bindingId } = treasuryIds(target)
  if (!target.onChainId) throw new Error(t("tx.errTreasuryProposalNoChain"))
  const transfer = await groupVaults.findCreatedTransfer([target.onChainId, bindingId], treasuryId, target.orgId)
  if (objectId(transfer.proposalId) !== objectId(target.onChainId) || objectId(transfer.bindingId) !== bindingId ||
      objectId(transfer.treasuryId) !== treasuryId || (target.vaultId && objectId(transfer.vaultId) !== objectId(target.vaultId))) {
    throw new Error(t("tx.errTreasuryProposalMismatch"))
  }
  return transfer
}

async function recoverTransferProposalCreation(result: WalletTransactionResult): Promise<{ proposal: ProposalItem; digest: string }> {
  try {
    const receipt = result.receipt, meta = receipt.metadata
    if (!meta || ![TREASURY_PROPOSAL_CREATE, LEGACY_PROPOSAL_CREATE].includes(receipt.action) || !objectId(meta.orgId) || !meta.groupId) throw new Error(t("tx.errReceiptMissingMeta"))
    assertProposalContext(receipt.account, meta.groupId, meta.orgId)
    let onChainId: string, vaultId: string | undefined, treasuryBindingId: string | undefined
    const isTreasury = receipt.action === TREASURY_PROPOSAL_CREATE
    if (isTreasury) {
      if (!objectId(meta.treasuryId) || receipt.scope !== objectId(meta.treasuryId)) throw new Error(t("tx.errReceiptTreasuryScope"))
      const transfer = await groupVaults.findCreatedTransfer(result.createdObjects, meta.treasuryId, meta.orgId)
      if (objectId(transfer.treasuryId) !== objectId(meta.treasuryId)) throw new Error(t("tx.errReceiptOtherTreasury"))
      onChainId = transfer.proposalId; vaultId = transfer.vaultId; treasuryBindingId = transfer.bindingId
    } else {
      if (!objectId(meta.vaultId) || !objectId(meta.masterCapId) || receipt.scope !== objectId(meta.vaultId)) throw new Error(t("tx.errReceiptMissingVault"))
      onChainId = await findCreatedProtocolObject(result.createdObjects, "asynchronous_proposal", "Proposal")
      vaultId = meta.vaultId
    }
    const snapshot = await readProposalSnapshot(onChainId, meta.orgId)
    if (snapshot.title !== meta.title || objectId(snapshot.recipient) !== objectId(meta.recipient) || snapshot.amountMist !== meta.amountMist ||
        String(snapshot.deadlineMs) !== meta.deadlineMs || objectId(snapshot.proposer) !== objectId(receipt.account.address)) {
      throw new Error(t("tx.errReceiptMismatch"))
    }
    assertProposalContext(receipt.account, meta.groupId, meta.orgId)
    const base: ProposalItem = {
      id: `chain_${onChainId}`, onChainId, orgId: meta.orgId, vaultId,
      ...(isTreasury ? { treasuryId: meta.treasuryId, treasuryBindingId } : { masterCapId: meta.masterCapId }),
      title: meta.title, description: meta.description || "", amount: Number(meta.amountMist) / 1e9,
      amountMist: meta.amountMist, token: "SUI", groupId: meta.groupId, groupName: meta.groupName,
      recipient: snapshot.recipient, status: snapshot.status, approvals: snapshot.approvedWeight, requiredApprovals: snapshot.threshold,
      createdAt: new Date(receipt.createdAt).toISOString(), expiresAt: new Date(snapshot.deadlineMs).toISOString(), deadlineMs: snapshot.deadlineMs,
      type: "transfer", color: "from-primary to-purple-500", voters: [], txDigest: result.digest,
    }
    const latest = getProposals(), existing = latest.find(proposal => objectId(proposal.onChainId) === objectId(onChainId))
    const proposal = applySnapshot({ ...existing, ...base, id: existing?.id || base.id }, snapshot)
    saveProposals(existing ? latest.map(row => row === existing ? proposal : row) : [proposal, ...latest])
    acknowledgePendingTransaction(receipt)
    return { proposal, digest: result.digest }
  } catch (cause) {
    throw new TransactionReceiptError(`${t("tx.errPropConfirmed", { digest: result.digest })}${cause instanceof Error ? cause.message : ""}`, result.receipt, { cause })
  }
}

/** Restore only the original digest, original group and original treasury; never sign again. */
export async function resumeTransferProposalCreation(receiptOrId: PendingTransactionReceipt | string) {
  const receipt = getTransactionReceipt(receiptOrId)
  if (![TREASURY_PROPOSAL_CREATE, LEGACY_PROPOSAL_CREATE].includes(receipt.action)) throw new Error(t("tx.errNotProposalReceipt"))
  const account = getTransactionAccount()
  if (transactionAccountKey(account) !== transactionAccountKey(receipt.account)) throw new Error(t("tx.errWrongAccount"))
  return recoverTransferProposalCreation(await resumePendingTransaction(receipt))
}

export async function createTransferProposalOnChain(params: {
  title: string; recipient: string; amount: string; token?: string; description?: string;
  groupId?: string; groupName?: string; deadlineMs?: number; orgId?: string;
  treasuryId?: string; legacyVaultId?: string; legacyMasterCapId?: string;
  expectedAccount?: TransactionAccount; assertContext?: () => void;
}): Promise<{ proposal: ProposalItem; digest: string }> {
  if ((params.token || "SUI") !== "SUI") throw new Error(t("tx.errSuiOnly"))
  const mist = proposalAmountMist(params.amount), orgId = objectId(params.orgId)
  if (!orgId) throw new Error(t("tx.errNeedOrgGroup"))
  const group = getUserGroups().find(g => g.id === params.groupId && objectId(g.orgObjectId) === orgId)
  if (!group) throw new Error(t("tx.errNoOrgRecord"))
  const account = getTransactionAccount()
  if (params.expectedAccount) assertTransactionAccount(params.expectedAccount)
  const title = params.title.trim(), titleSize = new TextEncoder().encode(title).length
  if (!titleSize || titleSize > 4096) throw new Error(t("tx.errTitleSize"))
  const deadlineMs = params.deadlineMs ?? Date.now() + 86400000 * 7
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= Date.now() || !Number.isFinite(new Date(deadlineMs).getTime())) throw new Error(t("tx.errDeadline"))
  const treasuryId = objectId(params.treasuryId), legacyVaultId = objectId(params.legacyVaultId), legacyMasterCapId = objectId(params.legacyMasterCapId)
  if (params.treasuryId !== undefined && !treasuryId) throw new Error(t("tx.errInvalidTreasuryId"))
  if (!treasuryId && (!legacyVaultId || !legacyMasterCapId)) throw new Error(t("tx.errPickTreasuryOrVault"))
  if (treasuryId && (params.legacyVaultId || params.legacyMasterCapId)) throw new Error(t("tx.errNoMixTreasuryVault"))
  const action = treasuryId ? TREASURY_PROPOSAL_CREATE : LEGACY_PROPOSAL_CREATE, scope = treasuryId || legacyVaultId!
  const intent = { account, action, scope }
  const pending = getPendingTransaction(intent)
  if (pending) throw new TransactionReceiptError(t("tx.errPendingRecovery"), pending)
  const lock = `${transactionAccountKey(account)}:${action}:${scope}`
  if (creating.has(lock)) throw new Error(t("tx.errCreatingInFlight"))
  creating.add(lock)
  const checkContext = () => { assertProposalContext(account, group.id, orgId); params.assertContext?.() }
  try {
    const { resolveRecipient } = await import("./identity-client")
    const { address: recipient } = await resolveRecipient(params.recipient)
    if (!objectId(recipient) || BigInt(recipient) === 0n) throw new Error(t("tx.errInvalidRecipient"))
    checkContext()
    let tx
    if (treasuryId) {
      const treasury = await groupVaults.readTreasury(treasuryId, orgId)
      if (objectId(treasury.treasuryId) !== treasuryId || objectId(treasury.orgId) !== orgId || !treasury.authority.verified || treasury.authority.status !== "organization-treasury" || normalizeStructTag(treasury.coinType) !== normalizeStructTag(SUI_TYPE)) throw new Error(t("tx.errTreasuryUnverified"))
      if (treasury.paused || mist > treasury.balance) throw new Error(t("tx.errTreasuryPausedOrInsufficient"))
      tx = await groupVaults.buildCreateTreasuryTransfer(account.address, treasuryId, orgId, { title, recipient, amount: mist, deadlineMs: BigInt(deadlineMs) })
    } else {
      await verifyPersonalCap(account, legacyVaultId!, legacyMasterCapId!)
      tx = vaultClient.buildCreateTransferProposalPTB(orgId, title, recipient, mist, deadlineMs)
      tx.setSender(account.address)
    }
    checkContext()
    const metadata = { groupId: group.id, groupName: group.name, orgId, title, description: params.description || "", recipient,
      amountMist: mist.toString(), deadlineMs: String(deadlineMs), ...(treasuryId ? { treasuryId } : { vaultId: legacyVaultId!, masterCapId: legacyMasterCapId! }) }
    return recoverTransferProposalCreation(await signAndExecuteWithWallet(tx, { action, scope, expectedAccount: account, metadata }))
  } finally { creating.delete(lock) }
}

function applySnapshot(target: ProposalItem, snapshot: ProposalSnapshot): ProposalItem {
  return {
    ...target, onChainId: snapshot.id, orgId: snapshot.orgId, title: snapshot.title,
    recipient: snapshot.recipient, proposer: snapshot.proposer, amountMist: snapshot.amountMist, amount: Number(snapshot.amountMist) / 1e9,
    amountLabel: `${formatProposalSui(BigInt(snapshot.amountMist))} SUI`,
    approvals: snapshot.approvedWeight, requiredApprovals: snapshot.threshold,
    voters: Object.keys(snapshot.votes).filter(address => !snapshot.rejectingVoters.includes(address)),
    voteWeights: snapshot.votes, memberWeights: snapshot.members, rejectingVoters: snapshot.rejectingVoters,
    rejectedWeight: snapshot.rejectionWeight, status: snapshot.status, deadlineMs: snapshot.deadlineMs,
    expiresAt: new Date(snapshot.deadlineMs).toISOString(), chainEpoch: snapshot.epoch,
    organizationEpoch: snapshot.organizationEpoch, rejectionSupported: snapshot.rejectionSupported,
    chainSyncedAt: new Date().toISOString(), syncError: undefined, sourceStatus: "chain-confirmed",
  }
}

export async function refreshProposal(proposalId: string): Promise<ProposalItem> {
  const target = getProposals().find(p => p.id === proposalId || p.onChainId === proposalId)
  if (!target?.onChainId) throw new Error(t("tx.errNoChainObject"))
  if (hasTreasuryMetadata(target)) await verifyTreasuryProposal(target)
  const snapshot = await readProposalSnapshot(target.onChainId, target.orgId)
  const latest = getProposals()
  const updated = applySnapshot(latest.find(p => p.id === target.id) || target, snapshot)
  saveProposals(latest.map(p => p.id === target.id ? updated : p))
  return updated
}

const voting = new Set<string>()
async function submitProposalVote(proposalId: string, reject: boolean) {
  const target = getProposals().find(p => p.id === proposalId || p.onChainId === proposalId)
  const onChainId = target?.onChainId || (!target ? objectId(proposalId) : undefined)
  if (!onChainId) throw new Error(t("tx.errNoChainObject"))
  const key = normalizeSuiAddress(onChainId)
  if (voting.has(key)) throw new Error(t("tx.errVoteInFlight"))
  const account = getActiveAccount()
  if (!account) throw new Error(t("tx.errConnectWallet"))
  voting.add(key)
  try {
    const snapshot = await readProposalSnapshot(onChainId, target?.orgId)
    const weight = validateApproval(snapshot, account.address)
    if (reject && !snapshot.rejectionSupported) throw new Error(t("tx.errRejectionNotSupported"))
    if (reject && snapshot.approvedWeight >= snapshot.threshold) throw new Error(t("tx.errAlreadyAtThreshold"))
    if (getActiveAccount()?.address !== account.address) throw new Error(t("tx.errAccountSwitchedVote"))
    // The transaction signature authenticates the member. Ancillary bytes are not a FROST proof.
    const tx = reject
      ? vaultClient.buildRejectAsyncVotePTB(snapshot.id, snapshot.orgId)
      : vaultClient.buildSubmitAsyncVotePTB(snapshot.id, snapshot.orgId, BigInt(weight), new Uint8Array())
    tx.setSender(account.address)
    const { digest } = await signAndExecuteWithWallet(tx)
    let isNowApproved = false
    try {
      if (target) isNowApproved = (await refreshProposal(target.id)).status === "approved"
      else isNowApproved = (await readProposalSnapshot(snapshot.id, snapshot.orgId)).status === "approved"
    } catch (error) {
      const message = error instanceof Error ? error.message : t("tx.readFailed")
      if (target) saveProposals(getProposals().map(p => p.id === target.id ? { ...p, syncError: t("tx.errVoteConfirmedRefreshFail", { digest, message }) } : p))
    }
    return { success: true, isNowApproved, digest }
  } finally { voting.delete(key) }
}

export async function approveProposal(proposalId: string): Promise<{ success: boolean; isNowApproved: boolean; digest?: string }> {
  return submitProposalVote(proposalId, false)
}

export async function rejectProposalWithReceipt(proposalId: string): Promise<{ success: boolean; isNowApproved: boolean; digest?: string }> {
  return submitProposalVote(proposalId, true)
}

export async function rejectProposal(proposalId: string): Promise<boolean> {
  const result = await rejectProposalWithReceipt(proposalId)
  return result.success
}

const executing = new Set<string>()
const MasterCapContent = bcs.struct("MasterCap", { id: bcs.Address, vault_id: bcs.Address })

async function verifyPersonalCap(account: TransactionAccount, vaultId: string, masterCapId: string) {
  if (!objectId(vaultId) || !objectId(masterCapId)) throw new Error(t("tx.errPersonalExecUnavailable"))
  const { objects } = await proposalClient.getObjects({ objectIds: [vaultId, masterCapId], include: { content: true }, signal: AbortSignal.timeout(20_000) })
  const [vault, cap] = objects
  if (!vault || !cap || vault instanceof Error || cap instanceof Error) throw new Error(t("tx.errReadVaultCapFail"))
  if (objectId(vault.objectId) !== objectId(vaultId) || objectId(cap.objectId) !== objectId(masterCapId) ||
      normalizeStructTag(vault.type) !== normalizeStructTag(`${PROPOSAL_TYPE_ORIGIN}::vault::AgentVault<${SUI_TYPE}>`) ||
      normalizeStructTag(cap.type) !== normalizeStructTag(`${PROPOSAL_TYPE_ORIGIN}::vault::MasterCap`)) throw new Error(t("tx.errVaultCapTypeMismatch"))
  const fields = MasterCapContent.parse(cap.content)
  if (objectId(fields.id) !== objectId(masterCapId) || objectId(fields.vault_id) !== objectId(vaultId)) throw new Error(t("tx.errCapWrongVault"))
  if (cap.owner.$kind !== "AddressOwner" || objectId(cap.owner.AddressOwner) !== objectId(account.address)) throw new Error(t("tx.errCapNotOwner"))
}
function sameExecutionSource(left: ProposalItem, right: ProposalItem): boolean {
  return ["onChainId", "orgId", "groupId", "treasuryId", "treasuryBindingId", "vaultId", "masterCapId"].every(key =>
    left[key as keyof ProposalItem] === right[key as keyof ProposalItem])
}
async function recoverProposalExecution(result: WalletTransactionResult, target: ProposalItem) {
  try {
    const meta = result.receipt.metadata
    if (!meta || objectId(meta.proposalId) !== objectId(target.onChainId) || objectId(meta.orgId) !== objectId(target.orgId) || meta.groupId !== target.groupId ||
        meta.treasuryId !== (target.treasuryId || "") || meta.bindingId !== (target.treasuryBindingId || "") || meta.vaultId !== (target.vaultId || "") || meta.masterCapId !== (target.masterCapId || "")) throw new Error(t("tx.errExecMetaMismatch"))
    assertProposalContext(result.receipt.account, target.groupId, target.orgId)
    // Preserve the confirmed digest even if the canonical read or the final save fails.
    saveProposals(getProposals().map(proposal => proposal.id === target.id ? { ...proposal, executionDigest: result.digest } : proposal))
    if (hasTreasuryMetadata(target)) await verifyTreasuryProposal(target)
    const snapshot = await readProposalSnapshot(target.onChainId!, target.orgId)
    if (snapshot.status !== "executed") throw new Error(t("tx.errNotExecutedOnChain"))
    assertProposalContext(result.receipt.account, target.groupId, target.orgId)
    const latest = getProposals(), current = latest.find(row => row.id === target.id)
    if (!current || !sameExecutionSource(current, target)) throw new Error(t("tx.errSourceChangedKeep"))
    const updated = { ...applySnapshot(current, snapshot), executionDigest: result.digest, executedAt: new Date().toISOString() }
    saveProposals(latest.map(proposal => proposal.id === target.id ? updated : proposal))
    acknowledgePendingTransaction(result.receipt)
    return { success: true, digest: result.digest }
  } catch (cause) {
    const message = t("tx.errExecConfirmed", { digest: result.digest, message: cause instanceof Error ? cause.message : t("tx.readFailed") })
    try { saveProposals(getProposals().map(proposal => proposal.id === target.id ? { ...proposal, executionDigest: result.digest, syncError: message } : proposal)) } catch { /* Original receipt remains unacknowledged, including when all browser writes fail. */ }
    // The digest is confirmed. Keep the receipt locked for a later canonical refresh instead of replaying execution.
    return { success: true, digest: result.digest }
  }
}

/** Pending execution always queries its original digest before considering another signature. */
export async function executeProposal(proposalId: string): Promise<{ success: boolean; digest?: string }> {
  const target = getProposals().find(proposal => proposal.id === proposalId || proposal.onChainId === proposalId)
  if (!target?.onChainId) throw new Error(t("tx.errNoChainObject"))
  const account = getTransactionAccount(), scope = normalizeSuiAddress(target.onChainId)
  const treasury = hasTreasuryMetadata(target)
  const action = treasury ? "group-treasury-proposal-execute" : "personal-cap-proposal-execute"
  if (executing.has(scope)) throw new Error(t("tx.errExecuteInFlight"))
  executing.add(scope)
  try {
    const pending = getPendingTransaction({ account, action, scope })
    if (pending) return await recoverProposalExecution(await resumePendingTransaction(pending), target)
    const snapshot = await readProposalSnapshot(target.onChainId, target.orgId)
    if (snapshot.status !== "approved") throw new Error(t("tx.errNotApproved"))
    if (Date.now() > snapshot.deadlineMs || snapshot.epoch !== snapshot.organizationEpoch) throw new Error(t("tx.errExpiredOrEpoch"))
    assertProposalContext(account, target.groupId, snapshot.orgId)
    if (target.token !== "SUI") throw new Error(t("tx.errExecSuiOnly"))
    let tx
    if (treasury) {
      const { treasuryId, bindingId } = treasuryIds(target)
      // The wrapper checks immutable treasury/proposal binding and custody on chain.
      tx = await groupVaults.buildExecuteTreasury(account.address, treasuryId, snapshot.orgId, snapshot.id, bindingId)
    } else {
      // A legacy Proposal has no vault binding; use only the explicitly saved personal-cap source.
      const vaultId = target.vaultId, masterCapId = target.masterCapId
      if (!vaultId || !masterCapId) throw new Error(t("tx.errMissingOriginalVault"))
      await verifyPersonalCap(account, vaultId, masterCapId)
      tx = vaultClient.buildExecuteTransferProposalPTB(snapshot.id, snapshot.orgId, vaultId, masterCapId, SUI_TYPE)
      tx.setSender(account.address)
    }
    assertProposalContext(account, target.groupId, snapshot.orgId)
    const current = getProposals().find(row => row.id === target.id)
    if (!current || !sameExecutionSource(current, target)) throw new Error(t("tx.errSourceChangedReread"))
    const metadata = { proposalId: snapshot.id, groupId: target.groupId, orgId: snapshot.orgId,
      treasuryId: target.treasuryId || "", bindingId: target.treasuryBindingId || "", vaultId: target.vaultId || "", masterCapId: target.masterCapId || "" }
    return await recoverProposalExecution(await signAndExecuteWithWallet(tx, { action, scope, expectedAccount: account, metadata }), target)
  } finally { executing.delete(scope) }
}
