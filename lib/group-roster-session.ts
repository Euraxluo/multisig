import { normalizeSuiAddress } from "@mysten/sui/utils"
import { assertRosterFrostRequest, recoverFrostRosterReceipt, type RosterSubmission, type RosterSubmissionDependencies } from "./group-roster-transactions"
import { getPendingTransaction, transactionAccountKey } from "./pending-transactions"
import { getTransactionAccount } from "./sui-wallet-signer"
import { planRosterChange, type LiveOrganization } from "./group-roster"
import { aggregateFrostSessionForReceiptRecovery, frostProtocolMessage, parseFrostRequest, verifyFrostRequest, verifyFrostRound1, verifyFrostRound2, verifyFrostTranscript, type FrostRound1, type FrostRound2, type ProtocolAuth } from "./frost-session"
import { defaultFrostSessionStore, type FrostSessionRecord, type FrostSessionStore } from "./frost-session-store"
import { t } from "@/lib/i18n/t"

/** Identical signed payloads may be retried; a signer cannot replace its round. */
export function mergeFrostRounds<T extends FrostRound1 | FrostRound2>(current: T[], incoming: T[]): T[] {
  const byIndex = new Map<string, T>()
  for (const round of [...current, ...incoming]) {
    const prior = byIndex.get(round.index)
    if (prior) {
      const a = frostProtocolMessage(prior), b = frostProtocolMessage(round)
      if (a.length !== b.length || a.some((value, i) => value !== b[i])) throw new Error(t("groups.roundDataConflict", { index: round.index }))
    }
    byIndex.set(round.index, prior ?? round)
  }
  return [...byIndex.values()].sort((a, b) => BigInt(a.index) < BigInt(b.index) ? -1 : 1)
}

/** Local discovery only; every selected record is independently verified on restore. */
export async function listRosterSessions(orgId: string, holder: string, store: FrostSessionStore = defaultFrostSessionStore): Promise<FrostSessionRecord[]> {
  const address = normalizeSuiAddress(holder)
  return (await store.list()).filter(record => {
    try {
      const request = record.request
      return request.version === 1 && /^[0-9a-f]{64}$/.test(request.requestId) &&
        Array.isArray(request.signers) && Array.isArray(record.round1) && Array.isArray(record.round2) &&
        record.round1.length <= request.signers.length && record.round2.length <= request.signers.length &&
        Number.isSafeInteger(record.updatedAtMs) && record.updatedAtMs >= 0 &&
        request.action.kind === "roster" && normalizeSuiAddress(request.action.orgId) === normalizeSuiAddress(orgId) &&
        (request.coordinator === address || request.signers.some(signer => signer.address === address))
    } catch { return false }
  }).sort((a, b) => b.updatedAtMs - a.updatedAtMs).slice(0, 20)
}

/** Recover an original receipt from public progress; never restores signing state. */
export async function recoverRosterSessionReceipt(input: {
  requestId: string
  orgId: string
  verify: ProtocolAuth["verify"]
  store?: FrostSessionStore
  dependencies?: RosterSubmissionDependencies
}): Promise<RosterSubmission> {
  const getAccount = input.dependencies?.getAccount ?? getTransactionAccount
  const account = { ...getAccount() }
  const check = () => {
    if (transactionAccountKey(getAccount()) !== transactionAccountKey(account)) throw new Error(t("groups.accountSwitchedLockKept"))
  }
  const saved = await (input.store ?? defaultFrostSessionStore).restore(input.requestId)
  check()
  if (!saved) throw new Error(t("groups.noFrostSessionLocked"))
  const request = parseFrostRequest(JSON.stringify(saved.request))
  if (request.requestId !== input.requestId || request.action.kind !== "roster" || normalizeSuiAddress(request.action.orgId) !== normalizeSuiAddress(input.orgId)) throw new Error(t("groups.sessionNotOrgRoster"))
  const holder = normalizeSuiAddress(account.address)
  if (request.coordinator !== holder && !request.signers.some(signer => signer.address === holder)) throw new Error(t("groups.notCoordinatorOrSigner"))
  const intent = { account, network: "testnet" as const, action: "group-roster-update", scope: `${normalizeSuiAddress(input.orgId)}:${request.action.epoch}` }
  const getPending = input.dependencies?.getPending ?? getPendingTransaction
  const pending = getPending(intent)
  if (!pending) throw new Error(t("groups.noMatchingReceipt"))
  if (!saved.transcript || !Array.isArray(saved.round1) || !Array.isArray(saved.round2) || saved.round1.length > request.signers.length || saved.round2.length !== request.signers.length) throw new Error(t("groups.recoveryNeedsRound2"))
  const verify: ProtocolAuth["verify"] = async (...args) => { check(); await input.verify(...args); check() }
  // Only aggregation can ignore expiry. Normal restore, nonce creation and share
  // production retain strict expiry checks; this entry has no submission fallback.
  const result = await aggregateFrostSessionForReceiptRecovery(request, saved.transcript, saved.round2, verify)
  for (const round of saved.round1) await verifyFrostRound1(request, round, verify)
  mergeFrostRounds(saved.transcript.round1, saved.round1)
  check()
  return recoverFrostRosterReceipt(request, result, {
    ...input.dependencies, getAccount: () => { check(); return account },
    getPending: nextIntent => {
      const original = getPending(nextIntent)
      if (!original || original.id !== pending.id || original.digest !== pending.digest) throw new Error(t("groups.receiptChanged"))
      return original
    },
  })
}

/** Restore public progress only. Nonces remain in their original, one-use store. */
export async function restoreRosterSession(input: {
  requestId: string
  live: LiveOrganization
  holder: string
  verify: ProtocolAuth["verify"]
  store?: FrostSessionStore
}): Promise<FrostSessionRecord> {
  const saved = await (input.store ?? defaultFrostSessionStore).restore(input.requestId)
  if (!saved) throw new Error(t("groups.noFrostSession"))
  const request = parseFrostRequest(JSON.stringify(saved.request))
  if (request.requestId !== input.requestId || request.action.kind !== "roster") throw new Error(t("groups.sessionNotRosterRequest"))
  await verifyFrostRequest(request, input.verify)
  const holder = normalizeSuiAddress(input.holder)
  if (request.coordinator !== holder && !request.signers.some(signer => signer.address === holder)) throw new Error(t("groups.notCoordinatorOrSigner"))
  const action = request.action
  const plan = planRosterChange(input.live, {
    members: action.members.map((address, index) => ({ address, weight: BigInt(action.weights[index]) })),
    thresholdWeight: BigInt(action.thresholdWeight),
  })
  assertRosterFrostRequest(input.live, plan, request)
  if (!Array.isArray(saved.round1) || !Array.isArray(saved.round2) || saved.round1.length > request.signers.length || saved.round2.length > request.signers.length) throw new Error(t("groups.sessionRoundsInvalid"))
  for (const round of saved.round1) await verifyFrostRound1(request, round, input.verify)
  let round1 = mergeFrostRounds([], saved.round1)
  if (saved.transcript) {
    await verifyFrostTranscript(request, saved.transcript, input.verify)
    round1 = mergeFrostRounds(round1, saved.transcript.round1)
  }
  if (saved.round2.length && !saved.transcript) throw new Error(t("groups.round2MissingTranscript"))
  for (const round of saved.round2) await verifyFrostRound2(request, saved.transcript!, round, input.verify)
  return { request, round1, ...(saved.transcript ? { transcript: saved.transcript } : {}), round2: mergeFrostRounds([], saved.round2), updatedAtMs: saved.updatedAtMs }
}
