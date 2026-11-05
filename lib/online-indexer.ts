"use client"

import { getActiveAccount, getProposals, getUserGroups, saveProposals, refreshProposal, type ProposalItem } from "./onchain-store"
import { PROPOSAL_TYPE_ORIGIN, proposalClient, readProposalSnapshot } from "./proposal-chain"
import { bcs } from "@mysten/sui/bcs"
import { normalizeSuiAddress, normalizeStructTag } from "@mysten/sui/utils"
import { groupVaults, type TreasuryTransfer } from "./group-vaults"
import { discoverGroupsCached, mergeDiscoveredGroups, type DiscoveredGroupRow } from "./group-discovery"
import { t } from "./i18n/t"

const ProposalCreatedEvent = bcs.struct("ProposalCreatedEvent", {
  proposal_id: bcs.Address, org_id: bcs.Address, epoch: bcs.u64(), proposer: bcs.Address,
  amount: bcs.u64(), recipient: bcs.Address, deadline_ms: bcs.u64(),
})
export function decodeProposalCreatedEvent(event: { eventType: string; bcs: Uint8Array }) {
  if (normalizeStructTag(event.eventType) !== `${PROPOSAL_TYPE_ORIGIN}::asynchronous_proposal::ProposalCreatedEvent`) throw new Error(t("misc.indexer.eventTypeMismatch"))
  return ProposalCreatedEvent.parse(event.bcs)
}

let indexerInterval: ReturnType<typeof setInterval> | undefined
let syncing: Promise<number> | undefined

/**
 * Organizations whose proposals this account should see.
 *
 * Local records alone are not enough: an on-chain organization the user joined
 * on another device has no local record, and its proposals would never appear.
 * Discovery supplies those, but only for organizations where the current
 * account is a confirmed member.
 */
async function visibleGroups(): Promise<DiscoveredGroupRow[]> {
  const local = getUserGroups().filter(group => group.orgObjectId)
  const account = getActiveAccount()?.address
  if (!account) return mergeDiscoveredGroups(local, null)
  try {
    return mergeDiscoveredGroups(local, await discoverGroupsCached(account))
  } catch (error) {
    // A discovery outage must not prevent saved proposals from refreshing.
    console.debug("[online-indexer:discovery]", error)
    return mergeDiscoveredGroups(local, null)
  }
}

async function syncProposals(): Promise<number> {
  if (typeof window === "undefined") return 0
  let changed = 0
  const groups = await visibleGroups()
  const known = groups.filter(group => group.orgObjectId)
  try {
    if (known.length) await discoverProposals(known, () => { changed++ })
  } catch (error) {
    console.debug("[online-indexer:discovery]", error)
  }
  for (const proposal of getProposals()) {
    if (!proposal.onChainId) continue
    try { await refreshProposal(proposal.id); changed++ }
    catch (error) {
      const message = error instanceof Error ? error.message : t("misc.indexer.syncFailed")
      saveProposals(getProposals().map(current => current.id === proposal.id ? { ...current, syncError: message } : current))
    }
  }
  return changed
}

async function discoverProposals(groups: DiscoveredGroupRow[], added: () => void) {
  // Descending discovery is bounded; saved proposals refresh independently.
  const page = await proposalClient.listEvents({
    filter: { eventType: `${PROPOSAL_TYPE_ORIGIN}::asynchronous_proposal::ProposalCreatedEvent` },
    order: "descending", limit: 50, signal: AbortSignal.timeout(20_000),
  })
  for (const event of page.events) {
    try {
    const fields = decodeProposalCreatedEvent(event)
    const group = groups.find(group => normalizeSuiAddress(group.orgObjectId) === fields.org_id)
    if (!group || getProposals().some(proposal => proposal.onChainId === fields.proposal_id)) continue
    const snapshot = await readProposalSnapshot(fields.proposal_id, group.orgObjectId)
    let treasury: TreasuryTransfer | null = null
    try { treasury = await groupVaults.discoverTreasuryTransfer(snapshot.id, group.orgObjectId) }
    catch (error) {
      const message = error instanceof Error ? error.message : ""
      if (!message.includes("尚无 organization_treasury 模块")) throw error
    }
    const transaction = await proposalClient.getTransaction({ digest: event.transactionDigest, signal: AbortSignal.timeout(20_000) })
    if (transaction.$kind === "FailedTransaction" || !transaction.Transaction.status.success) continue
    const proposal: ProposalItem = {
      id: `chain_${snapshot.id}`, onChainId: snapshot.id, orgId: snapshot.orgId,
      vaultId: treasury?.vaultId || group.vaultId,
      ...(treasury ? { treasuryId: treasury.treasuryId, treasuryBindingId: treasury.bindingId } : { masterCapId: group.masterCapId }),
      title: snapshot.title, description: t("misc.indexer.fundingDescription"), amount: Number(snapshot.amountMist) / 1e9,
      amountMist: snapshot.amountMist, token: "SUI", groupId: group.id, groupName: group.name,
      recipient: snapshot.recipient, status: snapshot.status, approvals: snapshot.approvedWeight,
      requiredApprovals: snapshot.threshold, createdAt: transaction.Transaction.timestampMs ? new Date(transaction.Transaction.timestampMs).toISOString() : "",
      expiresAt: new Date(snapshot.deadlineMs).toISOString(), deadlineMs: snapshot.deadlineMs,
      type: "transfer", color: "from-primary to-purple-500", voters: Object.keys(snapshot.votes).filter(voter => !snapshot.rejectingVoters.includes(voter)), txDigest: event.transactionDigest,
      memberWeights: snapshot.members, voteWeights: snapshot.votes, rejectingVoters: snapshot.rejectingVoters,
      rejectedWeight: snapshot.rejectionWeight, rejectionSupported: snapshot.rejectionSupported,
      chainEpoch: snapshot.epoch, organizationEpoch: snapshot.organizationEpoch,
      chainSyncedAt: new Date().toISOString(), sourceStatus: "chain-confirmed", proposer: snapshot.proposer,
    }
    saveProposals([proposal, ...getProposals()])
    added()
    } catch (error) {
      console.debug("[online-indexer:event]", error)
    }
  }
}

/** Discovery uses events; voting state always comes from the shared Proposal and member tables. */
export function runIncrementalSync(): Promise<number> {
  if (!syncing) syncing = syncProposals().catch(error => {
    console.debug("[online-indexer]", error)
    return 0
  }).finally(() => { syncing = undefined })
  return syncing
}

export function startOnlineIndexer(intervalMs = 4000): void {
  if (indexerInterval || typeof window === "undefined") return
  void runIncrementalSync()
  indexerInterval = setInterval(() => { void runIncrementalSync() }, intervalMs)
}

export function stopOnlineIndexer(): void {
  if (indexerInterval) clearInterval(indexerInterval)
  indexerInterval = undefined
}
