import { bcs } from "@mysten/sui/bcs"
import { normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils"
import { getActiveAccount, getUserGroups, getProposals, refreshProposal, approveProposal, rejectProposalWithReceipt, vaultClient } from "./onchain-store"
import { pollReader, pollVoteView, pollLinks, rememberPoll, preparePollPublication, POLL_PACKAGE_ID, buildPublishPoll, buildCastPollBallot, validatePollBallot, type PollDraft } from "./governance-poll-client"
import { OrganizationContent, readWeightTable } from "./proposal-chain"
import { proposalClient, PROPOSAL_TYPE_ORIGIN, readProposalSnapshot, validateApproval, type ProposalSnapshot } from "./proposal-chain"
import { assertTransactionAccount, getTransactionAccount, resumePendingTransaction, signAndExecuteWithWallet, type WalletTransactionResult } from "./sui-wallet-signer"
import { acknowledgePendingTransaction, getPendingTransaction, listTransactionReceipts, transactionAccountKey, TransactionReceiptError, type PendingTransactionReceipt } from "./pending-transactions"
import { proposalVoteView, type GovernanceVote, type ShadowPolicy } from "./governance"
import { t } from "./i18n/t"

const publishing = new Set<string>()
const casting = new Set<string>()

export async function loadGovernanceVote(id: string): Promise<GovernanceVote> {
  if (getProposals().some(row => row.id === id || row.onChainId === id)) return loadProposalVote(id)
  // Inspect the object before choosing a reader. Transport/ABI failures must not
  // silently fall through to a different protocol interpretation.
  const { object } = await proposalClient.getObject({ objectId: id, include: { content: false }, signal: AbortSignal.timeout(20_000) })
  if (normalizeStructTag(object.type).endsWith("::governance_poll::Poll")) {
    const value = pollVoteView(await pollReader.readPoll(id), getActiveAccount()?.address)
    try { rememberPoll(value.id) } catch { /* Raw shared links remain readable without browser storage. */ }
    return value
  }
  return loadProposalVote(id)
}
export async function loadKnownPolls(): Promise<{ votes: GovernanceVote[]; failures: { id: string; error: string }[] }> {
  const links = pollLinks()
  // Receipts supplement the browser link index after a successful publish whose UI recovery was interrupted.
  const candidates = listTransactionReceipts().filter(receipt => receipt.status === "success" && receipt.action === "publish-poll").flatMap(receipt => receipt.createdObjects).filter(id => !links.includes(id))
  for (const id of candidates) {
    try { await pollReader.readPoll(id); links.push(id) } catch { /* Other created objects are not polls; preserve the receipt for retry. */ }
  }
  const rows = await Promise.allSettled(links.map(id => pollReader.readPoll(id)))
  const address = getActiveAccount()?.address
  return {
    votes: rows.flatMap(row => row.status === "fulfilled" ? [pollVoteView(row.value, address)] : []),
    failures: rows.flatMap((row, index) => row.status === "rejected" ? [{ id: links[index], error: row.reason instanceof Error ? row.reason.message : t("voting.chainReadFail") }] : []),
  }
}
export function governancePublicationScope(selectedGroup?: string): string { return `${selectedGroup || "manual"}:${POLL_PACKAGE_ID}` }
async function recoverPublishedPoll(receipt: WalletTransactionResult): Promise<{ id: string; digest: string; warning?: string }> {
  let id: string | undefined
  for (const candidate of receipt.createdObjects) {
    try { id = (await pollReader.readPoll(candidate)).id; break } catch { /* Other created objects are not polls. */ }
  }
  if (!id) throw new TransactionReceiptError(t("voting.errPublishConfirmedNoObject"), receipt.receipt)
  let warning: string | undefined
  try { rememberPoll(id) } catch { warning = t("voting.errPublishedLinkSaveFail") }
  acknowledgePendingTransaction(receipt.receipt)
  return { id, digest: receipt.digest, warning }
}
export async function resumeGovernancePoll(receipt: PendingTransactionReceipt) {
  const account = getTransactionAccount()
  if (transactionAccountKey(account) !== transactionAccountKey(receipt.account) || receipt.action !== "publish-poll") throw new Error(t("voting.errWrongAccountResume"))
  return recoverPublishedPoll(await resumePendingTransaction(receipt))
}

export async function publishGovernancePoll(draft: PollDraft & { selectedGroup?: string }): Promise<{ id: string; digest: string; warning?: string }> {
  const account = getTransactionAccount()
  const intent = { account, action: "publish-poll", scope: governancePublicationScope(draft.selectedGroup) }
  const pending = getPendingTransaction(intent)
  if (pending) throw new TransactionReceiptError(t("voting.errPendingPublishExists"), pending)
  if (publishing.has(account.address)) throw new Error(t("voting.errPublishInFlight"))
  publishing.add(account.address)
  try {
    let input = draft
    if (draft.voterSource && draft.voterSource !== "manual") {
      const group = getUserGroups().find(group => group.id === draft.selectedGroup)
      if (!group?.orgObjectId) throw new Error(t("voting.errGroupNotBound"))
      const { object } = await proposalClient.getObject({ objectId: group.orgObjectId, include: { content: true }, signal: AbortSignal.timeout(20_000) })
      if (normalizeStructTag(object.type) !== `${PROPOSAL_TYPE_ORIGIN}::cryptographic_org::Organization`) throw new Error(t("voting.errGroupObjectNotOrg"))
      const org = OrganizationContent.parse(object.content)
      const groupMembers = await readWeightTable(org.members_weight.id)
      if (!groupMembers[normalizeSuiAddress(account.address)]) throw new Error(t("voting.errNotOrgMember"))
      input = { ...draft, orgId: org.id, groupMembers }
    }
    const publication = preparePollPublication(input)
    await pollReader.assertAvailable(!!publication.orgId)
    assertTransactionAccount(account)
    const tx = buildPublishPoll(publication)
    tx.setSender(account.address)
    return recoverPublishedPoll(await signAndExecuteWithWallet(tx, { ...intent, expectedAccount: account, metadata: { title: draft.title } }))
  } finally { publishing.delete(account.address) }
}
export async function submitPollBallot(vote: GovernanceVote, optionIds: string[]): Promise<string> {
  if (vote.source !== "shared-poll" || !vote.onChainId) throw new Error(t("voting.errNotSharedPoll"))
  const account = getActiveAccount()
  if (!account) throw new Error(t("voting.errConnectWallet"))
  const key = `${vote.onChainId}:${account.address}`
  if (casting.has(key)) throw new Error(t("voting.errBallotSigning"))
  casting.add(key)
  try {
    const snapshot = await pollReader.readPoll(vote.onChainId)
    const choices = optionIds.map(id => /^option-\d+$/.test(id) ? Number(id.slice(7)) : -1)
    validatePollBallot(snapshot, account.address, choices)
    if (getActiveAccount()?.address !== account.address) throw new Error(t("voting.errAccountSwitchedVote"))
    const tx = buildCastPollBallot(snapshot.id, choices)
    tx.setSender(account.address)
    const receipt = await signAndExecuteWithWallet(tx)
    return receipt.digest
  } finally { casting.delete(key) }
}

export async function loadProposalVote(id: string): Promise<GovernanceVote> {
  const cached = getProposals().find(proposal => proposal.id === id || proposal.onChainId === id)
  if (cached?.onChainId) return proposalVoteView(await refreshProposal(cached.id), getActiveAccount()?.address)
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(id)) throw new Error(t("voting.errNoChainId"))
  return snapshotView(await readProposalSnapshot(id))
}
function snapshotView(snapshot: ProposalSnapshot): GovernanceVote {
  return proposalVoteView({
    id: snapshot.id, onChainId: snapshot.id, orgId: snapshot.orgId, title: snapshot.title, description: "", groupName: t("voting.chainOrgLabel"),
    approvals: snapshot.approvedWeight, requiredApprovals: snapshot.threshold, status: snapshot.status,
    voters: Object.keys(snapshot.votes).filter(voter => !snapshot.rejectingVoters.includes(voter)),
    voteWeights: snapshot.votes, memberWeights: snapshot.members, rejectingVoters: snapshot.rejectingVoters,
    rejectedWeight: snapshot.rejectionWeight, rejectionSupported: snapshot.rejectionSupported,
    chainSyncedAt: new Date().toISOString(), chainEpoch: snapshot.epoch, organizationEpoch: snapshot.organizationEpoch,
    proposer: snapshot.proposer, amount: Number(snapshot.amountMist) / 1e9, amountMist: snapshot.amountMist, token: "SUI",
    recipient: snapshot.recipient, deadlineMs: snapshot.deadlineMs, expiresAt: new Date(snapshot.deadlineMs).toISOString(),
  }, getActiveAccount()?.address)
}
export async function submitGovernanceApproval(vote: GovernanceVote, reject: boolean): Promise<string> {
  if (vote.kind !== "proposal" || !vote.onChainId) throw new Error(t("voting.errNotBoundProposal"))
  const result = reject ? await rejectProposalWithReceipt(vote.onChainId) : await approveProposal(vote.onChainId)
  if (!result.success || !result.digest) throw new Error(t("voting.errNoReceipt"))
  return result.digest
}

const Cap = bcs.struct("SubagentCoSignCap", {
  id: bcs.Address, master_owner: bcs.Address, issued_epoch: bcs.u64(), agent_address: bcs.Address, voter_weight: bcs.u64(), max_budget_per_tx: bcs.u64(),
  daily_budget_limit: bcs.u64(), spent_today: bcs.u64(), expires_at_ms: bcs.u64(), is_revoked: bcs.bool(),
})
export async function submitGovernanceFollow(vote: GovernanceVote, policy: ShadowPolicy): Promise<string> {
  if (vote.kind !== "proposal" || !vote.onChainId) throw new Error(t("voting.errFollowNeedsProposal"))
  if (!policy.enabled) throw new Error(t("voting.errFollowEnablePolicy"))
  if (!["FOLLOW_LEADER", "AI_SENTINEL", "ALWAYS_APPROVE"].includes(policy.strategyMode)) throw new Error(t("voting.errFollowStrategyUnsupported"))
  if (policy.strategyMode === "AI_SENTINEL") throw new Error(t("voting.errFollowAiNotConfigured"))
  if (!Number.isSafeInteger(policy.dailyQuota) || policy.dailyQuota <= 0 || policy.usedToday >= policy.dailyQuota) throw new Error(t("voting.errFollowQuotaReached"))
  if (!Number.isFinite(policy.maxAmountPerTx) || policy.maxAmountPerTx <= 0) throw new Error(t("voting.errFollowInvalidCap"))
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(policy.subagentCapId)) throw new Error(t("voting.errFollowCapIdInvalid"))
  const account = getActiveAccount()
  if (!account) throw new Error(t("voting.errFollowConnectAgentWallet"))
  const [snapshot, { object }] = await Promise.all([
    readProposalSnapshot(vote.onChainId, vote.orgId),
    proposalClient.getObject({ objectId: policy.subagentCapId, include: { content: true }, signal: AbortSignal.timeout(20_000) }),
  ])
  if (normalizeStructTag(object.type) !== `${PROPOSAL_TYPE_ORIGIN}::asynchronous_proposal::SubagentCoSignCap`) throw new Error(t("voting.errCapTypeMismatch"))
  const cap = Cap.parse(object.content)
  if (normalizeSuiAddress(account.address) !== cap.agent_address) throw new Error(t("voting.errNotCapAgent"))
  if (cap.is_revoked || BigInt(cap.expires_at_ms) < BigInt(Date.now())) throw new Error(t("voting.errCapRevoked"))
  const weight = validateApproval(snapshot, cap.master_owner)
  if (BigInt(weight) !== BigInt(cap.voter_weight)) throw new Error(t("voting.errCapWeightMismatch"))
  const amount = BigInt(snapshot.amountMist)
  if (amount > BigInt(cap.max_budget_per_tx) || amount + BigInt(cap.spent_today) > BigInt(cap.daily_budget_limit)) throw new Error(t("voting.errAmountOverCapLimit"))
  if (Number(snapshot.amountMist) / 1e9 > policy.maxAmountPerTx) throw new Error(t("voting.errAmountOverPolicyLimit"))
  if (policy.strategyMode === "FOLLOW_LEADER") {
    if (!/^0x[0-9a-fA-F]{1,64}$/.test(policy.leaderAddress)) throw new Error(t("voting.errLeaderAddressRequired"))
    const leader = normalizeSuiAddress(policy.leaderAddress)
    if (!Object.hasOwn(snapshot.votes, leader) || snapshot.rejectingVoters.includes(leader)) throw new Error(t("voting.errLeaderNotApproved"))
  }
  if (getActiveAccount()?.address !== account.address) throw new Error(t("voting.errAccountSwitchedFollow"))
  const tx = vaultClient.buildSubmitAsyncVoteBySubagentPTB(snapshot.id, snapshot.orgId, cap.id, new Uint8Array())
  tx.setSender(account.address)
  return (await signAndExecuteWithWallet(tx)).digest
}
