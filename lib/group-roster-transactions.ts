"use client"

// Submit a threshold-signed roster change to the live organization.
//
// Both the legacy in-tab committee session and cross-device FROST exchange use
// the same final gate: re-read the organization after deployment validation,
// match the exact signed roster descriptor, verify the Ed25519 group signature,
// and only then construct/pass the transaction to the wallet.
import { ed25519 } from "@noble/curves/ed25519.js"
import { normalizeSuiAddress, isValidSuiAddress, toHex } from "@mysten/sui/utils"
import { computeRosterUpdateDigest } from "./vault-client"
import { adoptLiveEpoch, getCommitteeSession } from "./committee-session"
import { signWithCommittee } from "./crypto/committee-signing"
import { describeRosterChange, planRosterChange, type LiveOrganization, type RosterPlan } from "./group-roster"
import { proposalClient } from "./proposal-chain"
import { vaultClient } from "./onchain-store"
import { advanceDeviceKeyEpoch, readDeviceKey } from "./committee-share-store"
import { acknowledgePendingTransaction, getPendingTransaction, transactionAccountKey, transactionIntentKey, type PendingTransactionReceipt, type TransactionIntent } from "./pending-transactions"
import { getTransactionAccount, resumePendingTransaction, signAndExecuteWithWallet, type WalletTransactionResult } from "./sui-wallet-signer"
import { parsePublicKeyPackage } from "./dkg-key-package"
import { verifyFrostRequest, type FrostRequest, type FrostSigningResult } from "./frost-session"
import { verifyProtocolMessage } from "./wallet-personal-signing"
import { t } from "@/lib/i18n/t"

let rosterFunctionChecked: Promise<void> | undefined

/** Fail closed when the deployed package predates the roster-change function. */
export function ensureRosterUpdateFunction(): Promise<void> {
  if (!rosterFunctionChecked) rosterFunctionChecked = (async () => {
    try {
      await proposalClient.getMoveFunction({
        packageId: vaultClient.packageId, moduleName: "cryptographic_org", name: "update_organization_roster",
        signal: AbortSignal.timeout(20_000),
      })
    } catch (cause) {
      rosterFunctionChecked = undefined
      throw new Error(t("groups.rosterModuleMissing", { detail: cause instanceof Error ? t("groups.parenDetail", { message: cause.message }) : "" }))
    }
  })()
  return rosterFunctionChecked
}

export interface RosterSubmission {
  digest: string
  /** Committee holders whose shares produced the signature. */
  signerIndices: bigint[]
  /** What the wallet approved, for the success notice. */
  changes: string[]
}

export interface RosterSubmissionDependencies {
  ensureFunction?: () => Promise<void>
  readLive?: (orgId: string) => Promise<LiveOrganization>
  getAccount?: typeof getTransactionAccount
  execute?: typeof signAndExecuteWithWallet
  resume?: typeof resumePendingTransaction
  getPending?: typeof getPendingTransaction
  acknowledge?: typeof acknowledgePendingTransaction
  readDeviceKey?: typeof readDeviceKey
  advanceDeviceKeyEpoch?: typeof advanceDeviceKeyEpoch
  verifyRequest?: (request: FrostRequest) => Promise<void>
  verifyExpiredRequest?: (request: FrostRequest) => Promise<void>
  adoptEpoch?: typeof adoptLiveEpoch
}

export type RosterFrostAction = Extract<FrostRequest["action"], { kind: "roster" }>

const hex = (bytes: Uint8Array): string => toHex(bytes)
const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((byte, index) => byte === b[index])
const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((value, index) => value === b[index])

/** Canonical public descriptor signed by every round of a roster-change session. */
export function createRosterFrostAction(live: LiveOrganization, plan: RosterPlan): RosterFrostAction {
  return {
    kind: "roster",
    packageId: vaultClient.packageId,
    orgId: normalizeSuiAddress(live.orgId),
    epoch: live.epoch.toString(),
    nonce: (live.lastNonce + 1n).toString(),
    chainIdHex: hex(live.chainId),
    newEpoch: (live.epoch + 1n).toString(),
    thresholdWeight: plan.thresholdWeight.toString(),
    priorMembers: plan.priorMembers.map(address => normalizeSuiAddress(address)),
    members: plan.members.map(address => normalizeSuiAddress(address)),
    weights: plan.weights.map(weight => weight.toString()),
  }
}

function sameAction(a: RosterFrostAction, b: RosterFrostAction): boolean {
  return a.kind === b.kind && a.packageId === b.packageId &&
    normalizeSuiAddress(a.orgId) === normalizeSuiAddress(b.orgId) &&
    a.epoch === b.epoch && a.nonce === b.nonce && a.chainIdHex === b.chainIdHex &&
    a.newEpoch === b.newEpoch && a.thresholdWeight === b.thresholdWeight &&
    sameList(a.priorMembers, b.priorMembers) && sameList(a.members, b.members) && sameList(a.weights, b.weights)
}

/** Reject a request unless its complete signed action and public key match this exact live plan. */
export function assertRosterFrostRequest(live: LiveOrganization, plan: RosterPlan, request: FrostRequest): void {
  if (!request || request.action?.kind !== "roster") throw new Error(t("groups.frostNotRosterAction"))
  const expected = createRosterFrostAction(live, plan)
  if (!sameAction(request.action, expected)) throw new Error(t("groups.frostRequestStale"))

  const pkg = request.keyPackage
  // Parse through the canonical public-package validator before trusting package
  // metadata. This package is public; no signing share is ever imported here.
  const validated = parsePublicKeyPackage(JSON.stringify({
    network: pkg.network, sessionId: pkg.sessionId, participantAddresses: pkg.participantAddresses,
    dealerAddresses: pkg.dealerAddresses, threshold: pkg.threshold, sessionEpoch: pkg.sessionEpoch,
    commitments: pkg.commitments, groupPk: pkg.groupPk, keyPackageId: pkg.keyPackageId,
  }))
  // DKG sessionEpoch identifies when this key package was created; it may be
  // older than the live organization epoch after roster-only updates. The local
  // bound key's mutable epoch is checked on every signing device before use.
  if (!sameBytes(validated.groupPk, live.groupPk)) {
    throw new Error(t("groups.frostGroupPkMismatch"))
  }
  const liveMemberMap = new Map(live.members.map(member => [normalizeSuiAddress(member.address), member.weight]))
  let totalSignerWeight = 0n
  for (const signer of request.signers) {
    const weight = liveMemberMap.get(normalizeSuiAddress(signer.address))
    if (weight === undefined) {
      throw new Error(t("groups.frostSignerNotInRoster", { address: signer.address }))
    }
    totalSignerWeight += weight
  }
  if (totalSignerWeight < live.thresholdWeight) {
    throw new Error(t("groups.frostSignerWeightShort", { total: totalSignerWeight, threshold: live.thresholdWeight }))
  }
}

/** Compare every signed-input source, including member order and weights. */
export function assertSameLiveRoster(expected: LiveOrganization, actual: LiveOrganization): void {
  const sameMembers = expected.members.length === actual.members.length && expected.members.every((member, index) =>
    normalizeSuiAddress(member.address) === normalizeSuiAddress(actual.members[index].address) && member.weight === actual.members[index].weight)
  if (normalizeSuiAddress(expected.orgId) !== normalizeSuiAddress(actual.orgId) ||
    expected.epoch !== actual.epoch || expected.lastNonce !== actual.lastNonce ||
    expected.thresholdWeight !== actual.thresholdWeight || !sameBytes(expected.groupPk, actual.groupPk) ||
    !sameBytes(expected.chainId, actual.chainId) || !sameMembers) {
    throw new Error(t("groups.chainMovedResign"))
  }
}

function assertFrostResult(request: FrostRequest, result: FrostSigningResult): void {
  if (request.action.kind !== "roster" || result.action?.kind !== "roster" ||
    result.requestId !== request.requestId || result.contextHash !== request.contextHash ||
    !/^[0-9a-f]{64}$/.test(result.transcriptHash) || !sameAction(result.action, request.action) ||
    hex(result.groupPk) !== request.keyPackage.groupPk) {
    throw new Error(t("groups.aggregateMismatch"))
  }
  const action = request.action
  const chainId = Uint8Array.from(action.chainIdHex.match(/.{2}/g) ?? [], byte => parseInt(byte, 16))
  const digest = computeRosterUpdateDigest(
    chainId, action.orgId, BigInt(action.epoch), BigInt(action.nonce), BigInt(action.newEpoch),
    BigInt(action.thresholdWeight), action.members, action.weights.map(BigInt),
  )
  if (!sameBytes(result.digest, digest)) throw new Error(t("groups.aggregateDigestMismatch"))
  const expectedIndices = request.signers.map(signer => BigInt(signer.index))
  if (result.signerIndices.length !== expectedIndices.length || result.signerIndices.some((index, offset) => index !== expectedIndices[offset])) {
    throw new Error(t("groups.aggregateSignerSetMismatch"))
  }
  if (!ed25519.verify(result.signature, digest, result.groupPk)) throw new Error(t("groups.aggregateVerifyFailed"))
}

// Explicit public fields only: array order belongs to the signed descriptor,
// whereas the chain's membership Table has no matching insertion-order promise.
function rosterMetadata(action: RosterFrostAction, signerIndices: bigint[]): Record<string, string> {
  return {
    orgId: action.orgId, packageId: action.packageId, chainIdHex: action.chainIdHex,
    epoch: action.epoch, newEpoch: action.newEpoch, nonce: action.nonce,
    thresholdWeight: action.thresholdWeight, memberCount: String(action.members.length),
    priorMembers: JSON.stringify(action.priorMembers), members: JSON.stringify(action.members),
    weights: JSON.stringify(action.weights), signerIndices: signerIndices.map(String).join(","),
  }
}

function legacyRosterMetadata(action: RosterFrostAction, groupPk: Uint8Array, signature: Uint8Array, signerIndices: bigint[]): Record<string, string> {
  const chainId = Uint8Array.from(action.chainIdHex.match(/.{2}/g) ?? [], byte => parseInt(byte, 16))
  return {
    ...rosterMetadata(action, signerIndices), legacyBindingVersion: "1", groupPk: hex(groupPk),
    rosterDigest: hex(computeRosterUpdateDigest(chainId, action.orgId, BigInt(action.epoch), BigInt(action.nonce), BigInt(action.newEpoch), BigInt(action.thresholdWeight), action.members, action.weights.map(BigInt))),
    rosterSignature: hex(signature),
  }
}

function frostRosterMetadata(request: FrostRequest, result: FrostSigningResult): Record<string, string> {
  if (request.action.kind !== "roster") throw new Error(t("groups.frostNotRosterAction"))
  return {
    ...rosterMetadata(request.action, result.signerIndices),
    frostBindingVersion: "1", frostRequestId: request.requestId, frostContextHash: request.contextHash,
    frostTranscriptHash: result.transcriptHash, frostKeyPackageId: request.keyPackage.keyPackageId,
    groupPk: request.keyPackage.groupPk, rosterDigest: hex(result.digest),
  }
}

function assertRosterReceipt(receipt: PendingTransactionReceipt, intent: TransactionIntent): void {
  const expected = intent.metadata ?? {}
  const actual = receipt.metadata
  const key = transactionIntentKey(intent)
  if (receipt.key !== key || transactionIntentKey(receipt) !== key || !receipt.digest ||
    receipt.acknowledged || (receipt.status !== "pending" && receipt.status !== "success") ||
    !actual || Object.keys(actual).length !== Object.keys(expected).length ||
    Object.entries(expected).some(([field, value]) => actual[field] !== value)) {
    throw new Error(t("groups.receiptBindingBroken"))
  }
}

function assertResumedRosterReceipt(result: WalletTransactionResult, pending: PendingTransactionReceipt, intent: TransactionIntent): void {
  assertRosterReceipt(result.receipt, intent)
  if (result.digest !== pending.digest || result.receipt.digest !== pending.digest ||
    result.receipt.id !== pending.id || result.receipt.status !== "success") {
    throw new Error(t("groups.recoveryNotSuccess"))
  }
}

function dependencies(input: RosterSubmissionDependencies): Required<RosterSubmissionDependencies> {
  return {
    ensureFunction: input.ensureFunction ?? ensureRosterUpdateFunction,
    readLive: input.readLive ?? (orgId => import("./group-roster").then(({ readLiveOrganization }) => readLiveOrganization(proposalClient, orgId))),
    getAccount: input.getAccount ?? getTransactionAccount,
    execute: input.execute ?? signAndExecuteWithWallet,
    resume: input.resume ?? resumePendingTransaction,
    getPending: input.getPending ?? getPendingTransaction,
    acknowledge: input.acknowledge ?? acknowledgePendingTransaction,
    readDeviceKey: input.readDeviceKey ?? readDeviceKey,
    advanceDeviceKeyEpoch: input.advanceDeviceKeyEpoch ?? advanceDeviceKeyEpoch,
    verifyRequest: input.verifyRequest ?? (request => verifyFrostRequest(request, verifyProtocolMessage)),
    verifyExpiredRequest: input.verifyExpiredRequest ?? (request => verifyFrostRequest(request, verifyProtocolMessage, { allowExpired: true })),
    adoptEpoch: input.adoptEpoch ?? adoptLiveEpoch,
  }
}

async function migrateBoundDeviceKey(
  fresh: LiveOrganization,
  account: ReturnType<typeof getTransactionAccount>,
  deps: Required<RosterSubmissionDependencies>,
): Promise<void> {
  const currentAccount = deps.getAccount()
  if (transactionAccountKey(currentAccount) !== transactionAccountKey(account)) {
    throw new Error(t("groups.accountSwitchedNoMigration"))
  }
  const current = await deps.readDeviceKey(fresh.orgId, account.address)
  if (transactionAccountKey(deps.getAccount()) !== transactionAccountKey(account)) {
    throw new Error(t("groups.accountSwitchedNoMigration"))
  }
  if (!current) return
  if (current.holder !== normalizeSuiAddress(account.address)) {
    throw new Error(t("groups.deviceKeyHolderMismatch"))
  }
  if (!sameBytes(current.groupPk, fresh.groupPk)) {
    throw new Error(t("groups.groupPkRotatedNoMigration"))
  }
  if (current.epoch === fresh.epoch) return
  if (current.epoch > fresh.epoch) {
    throw new Error(t("groups.epochRollbackRefused"))
  }
  if (current.epoch !== fresh.epoch - 1n) {
    throw new Error(t("groups.epochMigrationImpossible", { current: current.epoch, before: fresh.epoch - 1n }))
  }
  await deps.advanceDeviceKeyEpoch(fresh.orgId, account.address, {
    fromEpoch: current.epoch,
    toEpoch: fresh.epoch,
    groupPk: fresh.groupPk,
    creationDigest: current.creationDigest,
  })
  if (transactionAccountKey(deps.getAccount()) !== transactionAccountKey(account)) {
    throw new Error(t("groups.accountSwitchedStopsRelease"))
  }
}

function assertRosterUpdatePostState(
  before: LiveOrganization,
  after: LiveOrganization,
  plan: RosterPlan,
  nonce: bigint,
): void {
  const expectedWeights = new Map(plan.members.map((address, index) => [normalizeSuiAddress(address), plan.weights[index]]))
  const actualWeights = new Map(after.members.map(member => [normalizeSuiAddress(member.address), member.weight]))
  const sameMembers = actualWeights.size === expectedWeights.size && [...expectedWeights].every(([address, weight]) => actualWeights.get(address) === weight)
  if (normalizeSuiAddress(after.orgId) !== normalizeSuiAddress(before.orgId) ||
    after.epoch !== before.epoch + 1n || after.lastNonce !== nonce ||
    after.thresholdWeight !== plan.thresholdWeight || !sameBytes(after.groupPk, before.groupPk) ||
    !sameBytes(after.chainId, before.chainId) || !sameMembers) {
    throw new Error(t("groups.postTxStateUnexpected"))
  }
}

function planFromRosterAction(action: RosterFrostAction): RosterPlan {
  if (action.members.length !== action.weights.length || action.priorMembers.length === 0) {
    throw new Error(t("groups.descriptorIncomplete"))
  }
  return {
    priorMembers: action.priorMembers.map(address => normalizeSuiAddress(address)),
    members: action.members.map(address => normalizeSuiAddress(address)),
    weights: action.weights.map(weight => BigInt(weight)),
    thresholdWeight: BigInt(action.thresholdWeight),
  }
}

function assertRecoveredRosterPostState(
  live: LiveOrganization,
  action: RosterFrostAction,
  groupPk: Uint8Array,
): RosterPlan {
  const plan = planFromRosterAction(action)
  if (action.members.some(address => !isValidSuiAddress(address))) {
    throw new Error(t("groups.originalInvalidMember"))
  }
  const expectedWeights = new Map(plan.members.map((address, index) => [address, plan.weights[index]]))
  const actualWeights = new Map(live.members.map(member => [normalizeSuiAddress(member.address), member.weight]))
  const sameMembers = actualWeights.size === expectedWeights.size && [...expectedWeights].every(([address, weight]) => actualWeights.get(address) === weight)
  if (normalizeSuiAddress(live.orgId) !== normalizeSuiAddress(action.orgId) ||
    live.epoch !== BigInt(action.newEpoch) || live.lastNonce !== BigInt(action.nonce) ||
    live.thresholdWeight !== plan.thresholdWeight || hex(live.chainId) !== action.chainIdHex ||
    !sameBytes(live.groupPk, groupPk) || !sameMembers) {
    throw new Error(t("groups.confirmedButStateMismatch"))
  }
  return plan
}

async function recoverPendingRosterUpdate(input: {
  request: FrostRequest
  result: FrostSigningResult
  deps: Required<RosterSubmissionDependencies>
}): Promise<RosterSubmission | null> {
  if (input.request.action.kind !== "roster") return null
  const account = input.deps.getAccount()
  const action = input.request.action
  const intent = {
    account,
    action: "group-roster-update",
    scope: `${normalizeSuiAddress(action.orgId)}:${action.epoch}`,
    network: "testnet" as const,
  }
  const pending = input.deps.getPending(intent)
  if (!pending) return null
  const boundIntent = { ...intent, metadata: frostRosterMetadata(input.request, input.result) }
  assertRosterReceipt(pending, boundIntent)
  await input.deps.verifyExpiredRequest(input.request)
  assertFrostResult(input.request, input.result)
  if (transactionAccountKey(input.deps.getAccount()) !== transactionAccountKey(account)) {
    throw new Error(t("groups.accountSwitchedNoLookup"))
  }
  return finishRosterReceiptRecovery({
    action, groupPk: input.result.groupPk, signerIndices: input.result.signerIndices,
    pending, intent: boundIntent, account, deps: input.deps,
  })
}

async function finishRosterReceiptRecovery(input: {
  action: RosterFrostAction
  groupPk: Uint8Array
  signerIndices: bigint[]
  pending: PendingTransactionReceipt
  intent: TransactionIntent
  account: ReturnType<typeof getTransactionAccount>
  deps: Required<RosterSubmissionDependencies>
}): Promise<RosterSubmission> {
  if (transactionAccountKey(input.deps.getAccount()) !== transactionAccountKey(input.account)) throw new Error(t("groups.accountSwitchedLockKept"))
  const result = await input.deps.resume(input.pending)
  assertResumedRosterReceipt(result, input.pending, input.intent)
  const confirmed = await input.deps.readLive(input.action.orgId)
  assertRecoveredRosterPostState(confirmed, input.action, input.groupPk)
  const account = input.account
  await migrateBoundDeviceKey(confirmed, account, input.deps)
  if (transactionAccountKey(input.deps.getAccount()) !== transactionAccountKey(account)) {
    throw new Error(t("groups.accountSwitchedNoRelease"))
  }
  input.deps.adoptEpoch(confirmed.orgId, { groupPk: confirmed.groupPk, epoch: confirmed.epoch })
  try { input.deps.acknowledge(result.receipt) }
  catch (error) { throw new Error(t("groups.txConfirmedLockReleaseFailed", { digest: result.digest, reason: error instanceof Error ? error.message : t("groups.storageUnavailable") })) }
  return { digest: result.digest, signerIndices: input.signerIndices, changes: [] }
}

/** Existing-receipt only; no fresh transaction fallback. */
export async function recoverFrostRosterReceipt(request: FrostRequest, result: FrostSigningResult, overrides: RosterSubmissionDependencies = {}): Promise<RosterSubmission> {
  const recovered = await recoverPendingRosterUpdate({ request, result, deps: dependencies(overrides) })
  if (!recovered) throw new Error(t("groups.noMatchingReceipt"))
  return recovered
}

/** Recover a legacy receipt using its original public signature, without shares. */
export async function recoverLegacyRosterReceipt(pending: PendingTransactionReceipt, overrides: RosterSubmissionDependencies = {}): Promise<RosterSubmission> {
  const deps = dependencies(overrides)
  const account = deps.getAccount()
  const metadata = pending.metadata
  if (!metadata || metadata.legacyBindingVersion !== "1") throw new Error(t("groups.legacyNoBinding"))
  const action: RosterFrostAction = {
    kind: "roster", orgId: metadata.orgId, packageId: metadata.packageId, chainIdHex: metadata.chainIdHex,
    epoch: metadata.epoch, newEpoch: metadata.newEpoch, nonce: metadata.nonce, thresholdWeight: metadata.thresholdWeight,
    priorMembers: JSON.parse(metadata.priorMembers), members: JSON.parse(metadata.members), weights: JSON.parse(metadata.weights),
  }
  const u64 = /^(0|[1-9][0-9]*)$/
  if (!Array.isArray(action.priorMembers) || !Array.isArray(action.members) || !Array.isArray(action.weights) ||
    !action.members.length || action.members.length > 1000 || action.members.length !== action.weights.length ||
    ![action.epoch, action.newEpoch, action.nonce, action.thresholdWeight, ...action.weights].every(value => u64.test(value) && BigInt(value) < (1n << 64n)) ||
    BigInt(action.newEpoch) !== BigInt(action.epoch) + 1n || !/^(?:[0-9a-f]{2})+$/.test(action.chainIdHex) ||
    !/^[0-9a-f]{64}$/.test(metadata.groupPk) || !/^[0-9a-f]{128}$/.test(metadata.rosterSignature) ||
    ![action.orgId, action.packageId, ...action.priorMembers, ...action.members].every(address => isValidSuiAddress(address) && normalizeSuiAddress(address) === address) ||
    !action.priorMembers.length || new Set(action.priorMembers).size !== action.priorMembers.length) {
    throw new Error(t("groups.legacyInvalidOrigin"))
  }
  if (new Set(action.members).size !== action.members.length || action.members.some(address => BigInt(address) === 0n) ||
    action.weights.some(weight => BigInt(weight) === 0n) || BigInt(action.thresholdWeight) === 0n ||
    BigInt(action.thresholdWeight) > action.weights.reduce((sum, weight) => sum + BigInt(weight), 0n)) {
    throw new Error(t("groups.legacyInvalidRoster"))
  }
  const signerIndices = metadata.signerIndices.split(",").map(value => {
    if (!/^[1-9][0-9]*$/.test(value)) throw new Error(t("groups.legacyInvalidIndex"))
    return BigInt(value)
  })
  if (new Set(signerIndices.map(String)).size !== signerIndices.length) throw new Error(t("groups.legacyDuplicateIndex"))
  const groupPk = Uint8Array.from(metadata.groupPk.match(/../g)!, byte => parseInt(byte, 16))
  const signature = Uint8Array.from(metadata.rosterSignature.match(/../g)!, byte => parseInt(byte, 16))
  const expected = legacyRosterMetadata(action, groupPk, signature, signerIndices)
  const intent = { account, action: "group-roster-update", scope: `${action.orgId}:${action.epoch}`, network: "testnet" as const, metadata: expected }
  assertRosterReceipt(pending, intent)
  const original = deps.getPending(intent)
  if (!original || original.id !== pending.id || original.digest !== pending.digest) throw new Error(t("groups.receiptChanged"))
  assertRosterReceipt(original, intent)
  if (!ed25519.verify(signature, Uint8Array.from(expected.rosterDigest.match(/../g)!, byte => parseInt(byte, 16)), groupPk)) throw new Error(t("groups.legacyBadSignature"))
  return finishRosterReceiptRecovery({ action, groupPk, signerIndices, pending: original, intent, account, deps })
}

async function submitVerifiedRosterSignature(input: {
  live: LiveOrganization
  plan: RosterPlan
  action: RosterFrostAction
  signature: Uint8Array
  signerIndices: bigint[]
  frostMetadata?: Record<string, string>
  deps: Required<RosterSubmissionDependencies>
}): Promise<RosterSubmission> {
  await input.deps.ensureFunction()
  // Re-read only after deployment validation, as close as possible to the wallet
  // prompt. A stale nonce, epoch, key or roster never reaches transaction signing.
  const fresh = await input.deps.readLive(input.live.orgId)
  assertSameLiveRoster(input.live, fresh)
  const freshPlan = planRosterChange(fresh, { members: input.plan.members.map((address, index) => ({ address, weight: input.plan.weights[index] })), thresholdWeight: input.plan.thresholdWeight })
  const freshAction = createRosterFrostAction(fresh, freshPlan)
  if (!sameAction(input.action, freshAction)) throw new Error(t("groups.descriptorMismatchNoBuild"))
  const digest = computeRosterUpdateDigest(
    fresh.chainId, fresh.orgId, fresh.epoch, BigInt(freshAction.nonce), BigInt(freshAction.newEpoch),
    freshPlan.thresholdWeight, freshPlan.members, freshPlan.weights,
  )
  if (!ed25519.verify(input.signature, digest, fresh.groupPk)) throw new Error(t("groups.thresholdSignatureStale"))

  const account = input.deps.getAccount()
  const metadata = input.frostMetadata ?? legacyRosterMetadata(freshAction, fresh.groupPk, input.signature, input.signerIndices)
  const intent = {
    account,
    action: "group-roster-update",
    scope: `${fresh.orgId}:${fresh.epoch}`,
    network: "testnet" as const,
    metadata,
  }

  let result: WalletTransactionResult
  const pending = input.deps.getPending(intent)
  if (pending) {
    // A prior wallet/RPC timeout may have committed the transaction. Resume only
    // the original digest; never create a fresh transaction or ask for a new
    // signature while this intent remains locked.
    assertRosterReceipt(pending, intent)
    result = await input.deps.resume(pending)
    assertResumedRosterReceipt(result, pending, intent)
  } else {
    const tx = vaultClient.buildUpdateOrganizationRosterPTB(
      fresh.orgId, BigInt(freshAction.nonce), freshPlan.priorMembers, freshPlan.members, freshPlan.weights, freshPlan.thresholdWeight, input.signature,
    )
    result = await input.deps.execute(tx, {
      action: intent.action, scope: intent.scope,
      expectedAccount: account,
      metadata,
    })
  }

  assertRosterReceipt(result.receipt, intent)
  if (result.receipt.status !== "success" || result.receipt.digest !== result.digest) {
    throw new Error(t("groups.noConsistentReceipt"))
  }

  // A successful receipt is not enough to release the retry lock. Re-read the
  // complete object and prove the exact key-preserving roster post-state first.
  const confirmed = await input.deps.readLive(fresh.orgId)
  assertRosterUpdatePostState(fresh, confirmed, freshPlan, BigInt(freshAction.nonce))
  const active = input.deps.getAccount()
  if (transactionAccountKey(active) !== transactionAccountKey(account)) {
    throw new Error(t("groups.accountSwitchedNoKeyMigration"))
  }
  await migrateBoundDeviceKey(confirmed, account, input.deps)
  if (transactionAccountKey(input.deps.getAccount()) !== transactionAccountKey(account)) {
    throw new Error(t("groups.accountSwitchedNoRelease"))
  }
  input.deps.adoptEpoch(confirmed.orgId, { groupPk: confirmed.groupPk, epoch: confirmed.epoch })

  try { input.deps.acknowledge(result.receipt) }
  catch (error) { throw new Error(t("groups.txConfirmedLockReleaseFailed", { digest: result.digest, reason: error instanceof Error ? error.message : t("groups.storageUnavailable") })) }
  return { digest: result.digest, signerIndices: input.signerIndices, changes: describeRosterChange(fresh, freshPlan) }
}

/**
 * Legacy compatibility path. The in-tab CommitteeSession still works, but is
 * now subject to the same fresh-live-descriptor and final-signature gate.
 */
export async function submitRosterChange(
  live: LiveOrganization,
  draft: Parameters<typeof planRosterChange>[1],
  overrides: RosterSubmissionDependencies = {},
): Promise<RosterSubmission> {
  const deps = dependencies(overrides)
  const pending = deps.getPending({ account: deps.getAccount(), action: "group-roster-update", scope: `${normalizeSuiAddress(live.orgId)}:${live.epoch}`, network: "testnet" })
  if (pending) {
    const expected = rosterMetadata(createRosterFrostAction(live, planRosterChange(live, draft)), [])
    if (Object.entries(expected).some(([field, value]) => field !== "signerIndices" && pending.metadata?.[field] !== value)) {
      throw new Error(t("groups.previewMismatchLegacy"))
    }
    return recoverLegacyRosterReceipt(pending, overrides)
  }
  const plan = planRosterChange(live, draft)
  const session = getCommitteeSession(live.orgId)
  if (!session) {
    throw new Error(t("groups.noLegacySharesInTab"))
  }
  const action = createRosterFrostAction(live, plan)
  const digest = computeRosterUpdateDigest(
    live.chainId, live.orgId, live.epoch, BigInt(action.nonce), BigInt(action.newEpoch),
    plan.thresholdWeight, plan.members, plan.weights,
  )
  const signed = signWithCommittee(session, digest, { groupPk: live.groupPk, epoch: live.epoch })
  return submitVerifiedRosterSignature({ live, plan, action, signature: signed.signature, signerIndices: signed.signerIndices, deps })
}

/** Submit only a fully aggregated, verified cross-device FROST roster signature. */
export async function submitFrostRosterChange(
  live: LiveOrganization,
  draft: Parameters<typeof planRosterChange>[1],
  request: FrostRequest,
  result: FrostSigningResult,
  overrides: RosterSubmissionDependencies = {},
): Promise<RosterSubmission> {
  const deps = dependencies(overrides)
  const recovered = await recoverPendingRosterUpdate({ request, result, deps })
  if (recovered) return recovered
  await deps.verifyRequest(request)
  const plan = planRosterChange(live, draft)
  assertRosterFrostRequest(live, plan, request)
  assertFrostResult(request, result)
  return submitVerifiedRosterSignature({
    live, plan, action: request.action as RosterFrostAction,
    signature: result.signature, signerIndices: result.signerIndices,
    frostMetadata: frostRosterMetadata(request, result), deps,
  })
}
