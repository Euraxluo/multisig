"use client"

// Issue and revoke channel-scoped subagent posting delegation.
//
// `create_shared_subagent_messaging_cap` requires the signer to be a channel
// member; `revoke_subagent_messaging_cap` requires the cap's `master_owner` to
// sign. Both are verified against the deployed package before building, so a
// stale deployment fails with a configuration message instead of an abort.
import { normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils"
import { proposalClient, PROPOSAL_TYPE_ORIGIN } from "./proposal-chain"
import { vaultClient } from "./onchain-store"
import { acknowledgePendingTransaction } from "./pending-transactions"
import { getTransactionAccount, signAndExecuteWithWallet } from "./sui-wallet-signer"
import { messagingCapBcs } from "./group-messaging-caps"
import { t } from "@/lib/i18n/t"

const signal = () => AbortSignal.timeout(20_000)
const objectId = (value: string) => {
  if (typeof value !== "string" || !/^0x[\da-fA-F]{1,64}$/.test(value) || BigInt(value) === 0n) throw new Error(t("groups.invalidObjectId"))
  return normalizeSuiAddress(value)
}

let functionsChecked: Promise<void> | undefined
export function ensureMessagingCapFunctions(): Promise<void> {
  if (!functionsChecked) functionsChecked = (async () => {
    for (const name of ["create_shared_subagent_messaging_cap", "revoke_subagent_messaging_cap"]) {
      try {
        await proposalClient.getMoveFunction({ packageId: vaultClient.packageId, moduleName: "onchain_chat", name, signal: signal() })
      } catch (cause) {
        functionsChecked = undefined
        throw new Error(t("groups.messagingModuleMissing", { detail: cause instanceof Error ? t("groups.parenDetail", { message: cause.message }) : "" }))
      }
    }
  })()
  return functionsChecked
}

export async function findCreatedMessagingCap(createdObjects: string[], channelId: string, masterOwner: string, agentAddress: string): Promise<string> {
  const ids = [...new Set(createdObjects.map(objectId))]
  if (!ids.length) throw new Error(t("groups.txCreatedNoCap"))
  const { objects } = await proposalClient.getObjects({ objectIds: ids, include: { content: true }, signal: signal() })
  const caps = objects.filter(object => !(object instanceof Error) && normalizeStructTag(object.type) === `${PROPOSAL_TYPE_ORIGIN}::onchain_chat::SubagentMessagingCap`)
  if (caps.length !== 1) throw new Error(t("groups.txCapAmbiguous"))
  const object = caps[0]
  if (object instanceof Error) throw new Error(t("groups.capReadFailed"))
  const cap = messagingCapBcs.parse(object.content)
  if (cap.id !== normalizeSuiAddress(object.objectId) || normalizeSuiAddress(cap.channel_id) !== normalizeSuiAddress(channelId)
    || normalizeSuiAddress(cap.master_owner) !== normalizeSuiAddress(masterOwner) || normalizeSuiAddress(cap.agent_address) !== normalizeSuiAddress(agentAddress)) {
    throw new Error(t("groups.newCapTxMismatch"))
  }
  return normalizeSuiAddress(object.objectId)
}

export interface IssueMessagingInput {
  channelId: string
  agentAddress: string
  expiresAtMs: bigint
  rateLimitPerMinute: bigint
  orgId: string
}

export async function issueMessagingDelegation(input: IssueMessagingInput): Promise<{ capId: string; digest: string }> {
  await ensureMessagingCapFunctions()
  const account = getTransactionAccount()
  if (input.rateLimitPerMinute <= 0n) throw new Error(t("groups.rateLimitPositive"))
  if (input.expiresAtMs <= BigInt(Date.now())) throw new Error(t("groups.expiryInFuture"))
  // The contract reads the channel, so build the transaction with the deployed
  // signature only after the channel is confirmed to be the chat channel type.
  const { object } = await proposalClient.getObject({ objectId: objectId(input.channelId), include: { content: true }, signal: signal() })
  if (normalizeStructTag(object.type) !== `${PROPOSAL_TYPE_ORIGIN}::onchain_chat::ChatChannel`) throw new Error(t("groups.notChatChannel"))
  const tx = vaultClient.buildCreateSharedSubagentMessagingCapPTB(input.channelId, input.agentAddress, input.expiresAtMs, input.rateLimitPerMinute)
  const result = await signAndExecuteWithWallet(tx, {
    action: "group-messaging-delegate", scope: `${input.orgId}:${input.channelId}:${input.agentAddress}`,
    expectedAccount: account,
    metadata: { orgId: input.orgId, channelId: input.channelId, agentAddress: normalizeSuiAddress(input.agentAddress) },
  })
  try { acknowledgePendingTransaction(result.receipt) }
  catch (error) { throw new Error(t("groups.txConfirmedLockReleaseFailed", { digest: result.digest, reason: error instanceof Error ? error.message : t("groups.storageUnavailable") })) }
  const capId = await findCreatedMessagingCap(result.createdObjects, input.channelId, account.address, input.agentAddress)
  return { capId, digest: result.digest }
}

export async function revokeMessagingDelegation(capId: string, orgId: string): Promise<string> {
  await ensureMessagingCapFunctions()
  const account = getTransactionAccount()
  const tx = vaultClient.buildRevokeSubagentMessagingCapPTB(objectId(capId))
  const result = await signAndExecuteWithWallet(tx, {
    action: "group-messaging-revoke", scope: `${orgId}:${capId}`, expectedAccount: account, metadata: { orgId, capId },
  })
  try { acknowledgePendingTransaction(result.receipt) }
  catch (error) { throw new Error(t("groups.txConfirmedLockReleaseFailed", { digest: result.digest, reason: error instanceof Error ? error.message : t("groups.storageUnavailable") })) }
  return result.digest
}
