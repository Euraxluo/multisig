"use client"

// Transaction builders for group-scoped AI co-sign delegations.
//
// `create_shared_subagent_cap` and `revoke_subagent_cosign_cap` are the only
// group-scoped delegation functions in the deployed proposal module. Both are
// verified against the live package before a transaction is built, so a stale
// deployment fails with a configuration message instead of a silent abort.
import { bcs } from "@mysten/sui/bcs"
import { normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils"
import { proposalClient, PROPOSAL_TYPE_ORIGIN } from "./proposal-chain"
import { vaultClient } from "./onchain-store"
import { acknowledgePendingTransaction } from "./pending-transactions"
import { getTransactionAccount, signAndExecuteWithWallet } from "./sui-wallet-signer"
import { t } from "@/lib/i18n/t"

export const SubagentCapContent = bcs.struct("SubagentCoSignCap", {
  id: bcs.Address, master_owner: bcs.Address, agent_address: bcs.Address, voter_weight: bcs.u64(),
  max_budget_per_tx: bcs.u64(), daily_budget_limit: bcs.u64(), spent_today: bcs.u64(),
  expires_at_ms: bcs.u64(), is_revoked: bcs.bool(),
})

const signal = () => AbortSignal.timeout(20_000)
const objectId = (value: string) => {
  if (typeof value !== "string" || !/^0x[\da-fA-F]{1,64}$/.test(value) || BigInt(value) === 0n) throw new Error(t("agents.ga.idRequired"))
  return normalizeSuiAddress(value)
}

let functionsChecked: Promise<void> | undefined
/** Fail closed when the deployed package predates either delegation function. */
export function ensureGroupAgentFunctions(): Promise<void> {
  if (!functionsChecked) functionsChecked = (async () => {
    for (const name of ["create_shared_subagent_cap", "revoke_subagent_cosign_cap"]) {
      try {
        await proposalClient.getMoveFunction({ packageId: vaultClient.packageId, moduleName: "asynchronous_proposal", name, signal: signal() })
      } catch (cause) {
        functionsChecked = undefined
        throw new Error(t("agents.ga.missingFunction", { name }) + (cause instanceof Error ? `（${cause.message}）` : ""))
      }
    }
  })()
  return functionsChecked
}

/**
 * `create_shared_subagent_cap` shares the new cap, so it is never among the
 * sender's owned objects. Resolve it from the confirmed creation set.
 */
export async function findCreatedDelegationCap(createdObjects: string[], masterOwner: string, agentAddress: string): Promise<{ capId: string; voterWeight: bigint }> {
  const ids = [...new Set(createdObjects.map(objectId))]
  if (!ids.length) throw new Error(t("agents.ga.noCreatedCap"))
  const { objects } = await proposalClient.getObjects({ objectIds: ids, include: { content: true }, signal: signal() })
  const caps = objects.filter(object => !(object instanceof Error) && normalizeStructTag(object.type) === `${PROPOSAL_TYPE_ORIGIN}::asynchronous_proposal::SubagentCoSignCap`)
  if (caps.length !== 1) throw new Error(t("agents.ga.capNotUnique"))
  const object = caps[0]
  if (object instanceof Error) throw new Error(t("agents.ga.delegationReadFailed"))
  const cap = SubagentCapContent.parse(object.content)
  if (normalizeSuiAddress(cap.id) !== normalizeSuiAddress(object.objectId)) throw new Error(t("agents.ga.delegationIdMismatch"))
  if (normalizeSuiAddress(cap.master_owner) !== normalizeSuiAddress(masterOwner) || normalizeSuiAddress(cap.agent_address) !== normalizeSuiAddress(agentAddress)) {
    throw new Error(t("agents.ga.delegationMismatch"))
  }
  return { capId: normalizeSuiAddress(object.objectId), voterWeight: BigInt(cap.voter_weight) }
}

export interface IssueDelegationInput {
  agentAddress: string
  voterWeight: bigint
  maxBudgetPerTx: bigint
  dailyBudgetLimit: bigint
  expiresAtMs: bigint
  orgId: string
}

/** Real `create_shared_subagent_cap`; the vote is later recorded under the signer. */
export async function issueGroupAgentDelegation(input: IssueDelegationInput): Promise<{ capId: string; digest: string }> {
  await ensureGroupAgentFunctions()
  const account = getTransactionAccount()
  if (input.voterWeight <= 0n) throw new Error(t("agents.ga.issuerNotMember"))
  if (input.maxBudgetPerTx <= 0n) throw new Error(t("agents.ga.perTxPositive"))
  if (input.dailyBudgetLimit < input.maxBudgetPerTx) throw new Error(t("agents.ga.limitBelowPerTx"))
  if (input.expiresAtMs <= BigInt(Date.now())) throw new Error(t("agents.ga.expiryFuture"))
  const tx = vaultClient.buildCreateSharedSubagentCapPTB(input.agentAddress, input.voterWeight, input.maxBudgetPerTx, input.dailyBudgetLimit, input.expiresAtMs)
  const result = await signAndExecuteWithWallet(tx, {
    action: "group-agent-delegate", scope: `${input.orgId}:${input.agentAddress}`,
    expectedAccount: account,
    metadata: { orgId: input.orgId, agentAddress: normalizeSuiAddress(input.agentAddress), voterWeight: input.voterWeight.toString() },
  })
  try { acknowledgePendingTransaction(result.receipt) }
  catch (error) { throw new Error(t("agents.txConfirmedLockStuck", { digest: result.digest }) + (error instanceof Error ? error.message : t("agents.storageUnavailable"))) }
  const { capId } = await findCreatedDelegationCap(result.createdObjects, account.address, input.agentAddress)
  return { capId, digest: result.digest }
}

/** Real `revoke_subagent_cosign_cap`; only the issuing member can sign it. */
export async function revokeGroupAgentDelegation(capId: string, orgId: string): Promise<string> {
  await ensureGroupAgentFunctions()
  const account = getTransactionAccount()
  const tx = vaultClient.buildRevokeSubagentCapPTB(objectId(capId))
  const result = await signAndExecuteWithWallet(tx, {
    action: "group-agent-revoke", scope: `${orgId}:${capId}`,
    expectedAccount: account, metadata: { orgId, capId },
  })
  try { acknowledgePendingTransaction(result.receipt) }
  catch (error) { throw new Error(t("agents.txConfirmedLockStuck", { digest: result.digest }) + (error instanceof Error ? error.message : t("agents.storageUnavailable"))) }
  return result.digest
}
