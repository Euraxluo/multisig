/**
 * asynchronous_proposal 的非资金读路径：否决态与 SubagentCoSignCap 快照。
 *
 * 提案主体（Proposal）走 finance/reader 的 readTransferProposal；本文件补齐
 * 两处只有异步投票路径才需要、且**不在 Proposal 内联字段里**的状态：
 *
 * - 否决权重与逐人否决标记存在 Proposal 对象的动态字段上（RejectedWeightKey
 *   为空结构 `[0]`，RejectingVoterKey 为单地址键），内联 BCS 读不到；
 * - SubagentCoSignCap 是独立的共享对象，有自己的窗口/额度/吊销状态。
 *
 * 链上键的 BCS 有坑：空结构是**单字节 `[0]`**（dummy_field: bool），不是
 * 0 字节——写错会把真实否决权重静默读成 0（合约侧有同名不变量测试锁定）。
 */
import { bcs } from '@mysten/sui/bcs';
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import { normalizeStructTag, normalizeSuiAddress } from '@mysten/sui/utils';
import { AGENT_VAULT_PACKAGE_ID } from '../org/constants';

export const PROPOSAL_MODULE = 'asynchronous_proposal';

/** `RejectedWeightKey {}` 的 BCS：空结构含一个 dummy_field，编码为单字节 0。 */
export const REJECTED_WEIGHT_KEY_BCS = new Uint8Array([0]);

/** `RejectingVoterKey { voter }` 的 BCS 就是单个地址。 */
export function rejectingVoterKeyBcs(voter: string): Uint8Array {
  return bcs.Address.serialize(normalizeSuiAddress(voter)).toBytes();
}

/** SubagentCoSignCap 的链上布局（字段顺序与 move 结构体一致）。 */
export const SubagentCoSignCapBcs = bcs.struct('SubagentCoSignCap', {
  id: bcs.Address,
  master_owner: bcs.Address,
  agent_address: bcs.Address,
  voter_weight: bcs.u64(),
  max_budget_per_tx: bcs.u64(),
  daily_budget_limit: bcs.u64(),
  spent_today: bcs.u64(),
  window_start_ms: bcs.u64(),
  expires_at_ms: bcs.u64(),
  is_revoked: bcs.bool(),
});

export type ProposalGovernanceReadClient = Pick<SuiGrpcClient, 'getObject' | 'getDynamicField'>;
export interface ProposalGovernanceReadOptions { signal?: AbortSignal }

export interface SubagentCoSignCapSnapshot {
  id: string;
  masterOwner: string;
  agentAddress: string;
  voterWeight: bigint;
  maxBudgetPerTx: bigint;
  dailyBudgetLimit: bigint;
  spentToday: bigint;
  windowStartMs: bigint;
  expiresAtMs: bigint;
  isRevoked: boolean;
}

function proposalTarget(packageId: string, name: string): string {
  return normalizeStructTag(`${normalizeSuiAddress(packageId)}::${PROPOSAL_MODULE}::${name}`);
}

/** 读协签凭证快照。共享对象，因此不校验 owner；类型来源严格校验。 */
export async function readSubagentCoSignCap(
  client: ProposalGovernanceReadClient,
  config: { capId: string; packageId?: string },
  options: ProposalGovernanceReadOptions = {},
): Promise<SubagentCoSignCapSnapshot> {
  const packageId = normalizeSuiAddress(config.packageId ?? AGENT_VAULT_PACKAGE_ID);
  const capId = normalizeSuiAddress(config.capId);
  const { object } = await client.getObject({ objectId: capId, include: { content: true }, signal: options.signal });
  if (normalizeStructTag(object.type) !== proposalTarget(packageId, 'SubagentCoSignCap')) {
    throw new Error('对象不是当前包的 asynchronous_proposal::SubagentCoSignCap。');
  }
  if (object.owner.$kind !== 'Shared') throw new Error('协签凭证应为共享对象。');
  const fields = SubagentCoSignCapBcs.parse(object.content);
  if (normalizeSuiAddress(fields.id) !== capId) throw new Error('协签凭证 UID 与对象 ID 不符。');
  if (BigInt(fields.voter_weight) === 0n) throw new Error('协签凭证的投票权重无效。');
  if (BigInt(fields.expires_at_ms) === 0n) throw new Error('协签凭证的过期时间无效。');
  return {
    id: capId,
    masterOwner: normalizeSuiAddress(fields.master_owner),
    agentAddress: normalizeSuiAddress(fields.agent_address),
    voterWeight: BigInt(fields.voter_weight),
    maxBudgetPerTx: BigInt(fields.max_budget_per_tx),
    dailyBudgetLimit: BigInt(fields.daily_budget_limit),
    spentToday: BigInt(fields.spent_today),
    windowStartMs: BigInt(fields.window_start_ms),
    expiresAtMs: BigInt(fields.expires_at_ms),
    isRevoked: fields.is_revoked,
  };
}

async function readProposalDynamicU64(
  client: ProposalGovernanceReadClient,
  proposalId: string,
  packageId: string,
  keyName: string,
  keyBcs: Uint8Array,
  options: ProposalGovernanceReadOptions,
): Promise<bigint | null> {
  const keyType = proposalTarget(packageId, keyName);
  try {
    const { dynamicField } = await client.getDynamicField({ parentId: proposalId, name: { type: keyType, bcs: keyBcs }, signal: options.signal });
    if (dynamicField.$kind !== 'DynamicField') throw new Error('提案扩展字段形态异常。');
    return BigInt(bcs.u64().parse(dynamicField.value.bcs));
  } catch (error) {
    // 没有任何人否决过时字段不存在（合约 `rejected_weight` 对此返回 0）。
    if ((error as { reason?: string }).reason === 'notFound') return null;
    throw error;
  }
}

/** 提案累计否决权重；无人否决返回 0n（与合约 `rejected_weight()` 语义一致）。 */
export async function readProposalRejectedWeight(
  client: ProposalGovernanceReadClient,
  config: { proposalId: string; packageId?: string },
  options: ProposalGovernanceReadOptions = {},
): Promise<bigint> {
  const packageId = normalizeSuiAddress(config.packageId ?? AGENT_VAULT_PACKAGE_ID);
  const value = await readProposalDynamicU64(client, normalizeSuiAddress(config.proposalId), packageId, 'RejectedWeightKey', REJECTED_WEIGHT_KEY_BCS, options);
  return value ?? 0n;
}

/** 某成员是否投了否决票（合约 `is_rejecting_voter`）。 */
export async function hasRejectingVoter(
  client: ProposalGovernanceReadClient,
  config: { proposalId: string; voter: string; packageId?: string },
  options: ProposalGovernanceReadOptions = {},
): Promise<boolean> {
  const packageId = normalizeSuiAddress(config.packageId ?? AGENT_VAULT_PACKAGE_ID);
  const value = await readProposalDynamicU64(client, normalizeSuiAddress(config.proposalId), packageId, 'RejectingVoterKey', rejectingVoterKeyBcs(config.voter), options);
  return value !== null;
}
