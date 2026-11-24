import { bcs } from '@mysten/sui/bcs';

export const FinanceTableBcs = bcs.struct('Table', { id: bcs.Address, size: bcs.u64() });
/** vault::AgentRecord（金库内联表行，BCS 与合约字段顺序一致）。 */
export const AgentRecordBcs = bcs.struct('AgentRecord', {
  daily_budget_limit: bcs.u64(), spent_in_current_epoch: bcs.u64(), last_spent_epoch: bcs.u64(),
  service_target_hash: bcs.vector(bcs.u8()), is_active: bcs.bool(),
});
/** sui::vec_map::VecMap<address, AgentRecord>（单字段 contents 的 vector 条目）。 */
export const AgentVecMapBcs = bcs.struct('VecMap', {
  contents: bcs.vector(bcs.struct('Entry', { key: bcs.Address, value: AgentRecordBcs })),
});
export const AgentVaultBcs = bcs.struct('AgentVault', {
  id: bcs.Address, balance: bcs.u64(), vault_version: bcs.u64(), total_subagents: bcs.u64(), paused: bcs.bool(),
  agents: AgentVecMapBcs,
  max_epoch_outflow: bcs.u64(), epoch_outflow: bcs.u64(), outflow_epoch: bcs.u64(), max_agent_budget: bcs.u64(),
});
export const MasterCapBcs = bcs.struct('MasterCap', { id: bcs.Address, vault_id: bcs.Address });
export const OperatorCapBcs = bcs.struct('OperatorCap', { id: bcs.Address, vault_id: bcs.Address, vault_version: bcs.u64(), operator_address: bcs.Address });
/** 2026-10-29 起瘦身为纯消费凭证：额度/启停权威全部在金库 agents 表。 */
export const AgentCapBcs = bcs.struct('AgentCap', {
  id: bcs.Address, vault_id: bcs.Address, vault_version: bcs.u64(), agent_id: bcs.Address,
});
export const OrganizationTreasuryBcs = bcs.struct('OrganizationTreasury', {
  id: bcs.Address, org_id: bcs.Address, vault_id: bcs.Address, master_cap: MasterCapBcs,
});
export const TransferBindingBcs = bcs.struct('TransferBinding', { id: bcs.Address, treasury_id: bcs.Address, proposal_id: bcs.Address });
export const TreasuryCreatedBcs = bcs.struct('TreasuryCreated', { treasury_id: bcs.Address, org_id: bcs.Address, vault_id: bcs.Address });
export const TreasuryTransferCreatedBcs = bcs.struct('TransferCreated', { binding_id: bcs.Address, treasury_id: bcs.Address, proposal_id: bcs.Address });
export const AsyncTransferProposalBcs = bcs.struct('Proposal', {
  id: bcs.Address, org_id: bcs.Address, epoch: bcs.u64(), proposer: bcs.Address, title: bcs.vector(bcs.u8()),
  recipient: bcs.Address, amount: bcs.u64(), threshold_weight: bcs.u64(), accumulated_weight: bcs.u64(),
  voters: FinanceTableBcs, partial_signatures: FinanceTableBcs, deadline_ms: bcs.u64(), status: bcs.u8(),
});

/** cryptographic_org::Organization 的 BCS 布局（字段顺序与 Move 一致；尾追字段见各注释）。
 *  唯一布局权威：lib/proposal-chain.ts 与测试 fixture 均从此导入，不再私定义副本。 */
export const OrganizationContentBcs = bcs.struct('Organization', {
  id: bcs.Address, group_pk: bcs.vector(bcs.u8()), threshold_weight: bcs.u64(),
  epoch_version: bcs.u64(), last_nonce: bcs.u64(), chain_id: bcs.vector(bcs.u8()),
  members_weight: FinanceTableBcs, executed_proposals: FinanceTableBcs,
  key_signers: bcs.vector(bcs.Address), key_threshold: bcs.u64(),
  genesis_stake: bcs.u64(), genesis_bonded_total: bcs.u64(),
  genesis_withdrawn: bcs.u64(), genesis_unlock_at_ms: bcs.u64(),
  key_generation: bcs.u64(),
});

export const ScheduleBcs = bcs.enum('Schedule', {
  Recurring: bcs.struct('Recurring', { amount: bcs.u64(), interval_ms: bcs.u64(), max_count: bcs.u64(), end_ms: bcs.u64(), requires_approval: bcs.bool() }),
  Stream: bcs.struct('Stream', { duration_ms: bcs.u64(), curve: bcs.u8() }),
});
export const StatusBcs = bcs.enum('Status', { Active: null, Paused: bcs.struct('Paused', { at_ms: bcs.u64() }), Terminated: null });
export const PaymentBcs = bcs.struct('Payment', {
  id: bcs.Address, recipient: bcs.Address, refund_address: bcs.Address, scope: bcs.Address, name: bcs.vector(bcs.u8()),
  schedule: ScheduleBcs, start_ms: bcs.u64(), paused_ms: bcs.u64(), status: StatusBcs,
  balance: bcs.u64(), funded: bcs.u64(), paid: bcs.u64(), refunded: bcs.u64(), installments_paid: bcs.u64(),
});
export const PaymentCapBcs = bcs.struct('PaymentCap', { id: bcs.Address, payment_id: bcs.Address });
export const PaymentCreatedBcs = bcs.struct('PaymentCreated', {
  payment_id: bcs.Address, recipient: bcs.Address, scope: bcs.Address, name: bcs.vector(bcs.u8()),
  schedule: ScheduleBcs, start_ms: bcs.u64(), funded: bcs.u64(),
});

/** vault::AgentBudgetUpdatedEvent（I9：Operator 调额审计事件，老/新额度成对）。 */
export const AgentBudgetUpdatedBcs = bcs.struct('AgentBudgetUpdatedEvent', {
  vault_id: bcs.Address, agent_id: bcs.Address, old_daily_budget: bcs.u64(), new_daily_budget: bcs.u64(),
});
/** vault::VaultUnpausedEvent（I9：Master 解除全金库暂停审计事件）。 */
export const VaultUnpausedBcs = bcs.struct('VaultUnpausedEvent', { vault_id: bcs.Address });
export type PaymentSnapshot = ReturnType<typeof PaymentBcs.parse> & { coinType: string; capId?: string };

/** BCS parse alone can accept trailing bytes. Roundtrip requires the exact canonical layout. */
export function parseFinanceBcs<Output, Input>(codec: { parse(bytes: Uint8Array): Output; serialize(value: Input): { toBytes(): Uint8Array } }, bytes: Uint8Array): Output {
  if (!(bytes instanceof Uint8Array) || bytes.length > 16_384) throw new Error('财务对象 BCS 数据缺失或超过上限。');
  const value = codec.parse(bytes);
  const canonical = codec.serialize(value as unknown as Input).toBytes();
  if (canonical.length !== bytes.length || canonical.some((byte, index) => byte !== bytes[index])) throw new Error('财务对象 BCS 数据不规范或含尾随字节。');
  return value;
}
