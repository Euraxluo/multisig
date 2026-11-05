import type { SuiGrpcClient } from '@mysten/sui/grpc';
import { normalizeStructTag, parseStructTag } from '@mysten/sui/utils';
import { AGENT_VAULT_PACKAGE_ID } from '../org/constants';
import {
  AgentVaultBcs, AgentCapBcs, OperatorCapBcs, MasterCapBcs, OrganizationTreasuryBcs,
  TransferBindingBcs, AsyncTransferProposalBcs, PaymentBcs, PaymentCapBcs, parseFinanceBcs,
} from './schemas';
import { FINANCE_SUI_TYPE, financeAddress, financeU64 } from './validation';

export type FinanceReadClient = Pick<SuiGrpcClient, 'getObject'>;
export interface FinanceDeployment {
  /** Fresh packages own distinct types; historical origins require explicit configuration. */
  packageId?: string;
  vaultTypeOrigin?: string;
  treasuryTypeOrigin?: string;
  proposalTypeOrigin?: string;
  paymentsTypeOrigin?: string;
}
export interface FinanceReadOptions { signal?: AbortSignal }
export type VaultSnapshot = Omit<ReturnType<typeof AgentVaultBcs.parse>, 'balance' | 'vault_version' | 'total_subagents'> & {
  coinType: string; balance: bigint; vault_version: bigint; total_subagents: bigint;
};
export type TreasurySnapshot = ReturnType<typeof OrganizationTreasuryBcs.parse>;
export type TransferBindingSnapshot = ReturnType<typeof TransferBindingBcs.parse>;
export type TransferProposalSnapshot = ReturnType<typeof AsyncTransferProposalBcs.parse>;
export interface BoundTransferSnapshot { binding: TransferBindingSnapshot; treasury: TreasurySnapshot; proposal: TransferProposalSnapshot; vault: VaultSnapshot }
export interface FinanceReader {
  readVault(id: string, options?: FinanceReadOptions): Promise<VaultSnapshot>;
  readTreasury(id: string, expectedOrgId?: string, options?: FinanceReadOptions): Promise<TreasurySnapshot>;
  readTransferBinding(id: string, options?: FinanceReadOptions): Promise<TransferBindingSnapshot>;
  readTransferProposal(id: string, options?: FinanceReadOptions): Promise<TransferProposalSnapshot>;
  readBoundTransfer(id: string, expectedOrgId?: string, options?: FinanceReadOptions): Promise<BoundTransferSnapshot>;
  readPayment(id: string, options?: FinanceReadOptions): Promise<import('./schemas').PaymentSnapshot>;
  readPaymentCap(id: string, expectedPaymentId: string, expectedOwner?: string, options?: FinanceReadOptions): Promise<ReturnType<typeof PaymentCapBcs.parse>>;
  readMasterCap(id: string, expectedOwner?: string, options?: FinanceReadOptions): Promise<ReturnType<typeof MasterCapBcs.parse>>;
  readOperatorCap(id: string, expectedOwner?: string, options?: FinanceReadOptions): Promise<ReturnType<typeof OperatorCapBcs.parse>>;
  readAgentCap(id: string, expectedOwner?: string, options?: FinanceReadOptions): Promise<ReturnType<typeof AgentCapBcs.parse>>;
}

/** Exact origins, shared/owned custody, UID and canonical BCS are verified before returning state. */
export function createFinanceReader(client: FinanceReadClient, config: FinanceDeployment = {}): FinanceReader {
  const pkg = financeAddress(config.packageId ?? AGENT_VAULT_PACKAGE_ID);
  const origins = {
    vault: financeAddress(config.vaultTypeOrigin ?? pkg), organization_treasury: financeAddress(config.treasuryTypeOrigin ?? pkg),
    asynchronous_proposal: financeAddress(config.proposalTypeOrigin ?? pkg), scheduled_payments: financeAddress(config.paymentsTypeOrigin ?? pkg),
  };
  async function read<Output extends { id: string }, Input>(
    id: string, module: keyof typeof origins, name: string,
    codec: { parse(bytes: Uint8Array): Output; serialize(value: Input): { toBytes(): Uint8Array } },
    generic: boolean, shared: boolean, options: FinanceReadOptions = {}, expectedOwner?: string,
  ) {
    const objectId = financeAddress(id);
    const { object } = await client.getObject({ objectId, include: { content: true }, signal: options.signal });
    if (financeAddress(object.objectId) !== objectId) throw new Error('链上对象 ID 不匹配。');
    const tag = parseStructTag(object.type);
    if (financeAddress(tag.address) !== origins[module] || tag.module !== module || tag.name !== name || tag.typeParams.length !== (generic ? 1 : 0) || (generic && typeof tag.typeParams[0] !== 'object')) throw new Error(`对象不是配置部署的 ${module}::${name}；新包不能直接消费旧包类型。`);
    if (shared ? object.owner.$kind !== 'Shared' : object.owner.$kind !== 'AddressOwner') throw new Error('财务对象托管方式不匹配。');
    if (expectedOwner && (object.owner.$kind !== 'AddressOwner' || financeAddress(object.owner.AddressOwner) !== financeAddress(expectedOwner))) throw new Error('权限对象不属于指定账户。');
    const value = parseFinanceBcs(codec, object.content);
    if (value.id !== objectId) throw new Error('财务对象 UID 不匹配。');
    const coinType = generic ? normalizeStructTag(tag.typeParams[0] as ReturnType<typeof parseStructTag>) : undefined;
    return { value, coinType, owner: object.owner };
  }
  async function readVault(vaultId: string, options?: FinanceReadOptions) {
    const { value, coinType } = await read(vaultId, 'vault', 'AgentVault', AgentVaultBcs, true, true, options);
    if (BigInt(value.vault_version) < 1n) throw new Error('金库版本无效。');
    return { ...value, coinType: coinType!, balance: BigInt(value.balance), vault_version: BigInt(value.vault_version), total_subagents: BigInt(value.total_subagents) };
  }
  async function readTreasury(treasuryId: string, expectedOrgId?: string, options?: FinanceReadOptions) {
    const { value } = await read(treasuryId, 'organization_treasury', 'OrganizationTreasury', OrganizationTreasuryBcs, false, true, options);
    if (expectedOrgId && value.org_id !== financeAddress(expectedOrgId)) throw new Error('组织与国库绑定不匹配。');
    if (value.master_cap.vault_id !== value.vault_id) throw new Error('国库内联 MasterCap 与金库绑定不匹配。');
    financeAddress(value.org_id); financeAddress(value.vault_id); financeAddress(value.master_cap.id);
    return value;
  }
  async function readTransferBinding(bindingId: string, options?: FinanceReadOptions) {
    const { value } = await read(bindingId, 'organization_treasury', 'TransferBinding', TransferBindingBcs, false, true, options);
    financeAddress(value.treasury_id); financeAddress(value.proposal_id);
    return value;
  }
  async function readTransferProposal(proposalId: string, options?: FinanceReadOptions) {
    const { value } = await read(proposalId, 'asynchronous_proposal', 'Proposal', AsyncTransferProposalBcs, false, true, options);
    if (![1, 2, 3].includes(value.status) || BigInt(value.threshold_weight) === 0n) throw new Error('转账提案状态或门限无效。');
    return value;
  }
  async function readBoundTransfer(bindingId: string, expectedOrgId?: string, options?: FinanceReadOptions) {
    const binding = await readTransferBinding(bindingId, options);
    const [treasury, proposal] = await Promise.all([readTreasury(binding.treasury_id, expectedOrgId, options), readTransferProposal(binding.proposal_id, options)]);
    const vault = await readVault(treasury.vault_id, options);
    if (proposal.org_id !== treasury.org_id || vault.coinType !== FINANCE_SUI_TYPE) throw new Error('国库提案的组织或 SUI 资产绑定不匹配。');
    return { binding, treasury, proposal, vault };
  }
  async function readPayment(paymentId: string, options?: FinanceReadOptions) {
    const { value, coinType } = await read(paymentId, 'scheduled_payments', 'Payment', PaymentBcs, true, true, options);
    if (BigInt(value.funded) !== BigInt(value.paid) + BigInt(value.refunded) + BigInt(value.balance)) throw new Error('链上托管付款金额不守恒。');
    if (value.name.length > 256 || value.recipient === financeAddress('0x0', true)) throw new Error('付款名称或收款人无效。');
    if (value.schedule.$kind === 'Stream') {
      if (BigInt(value.schedule.Stream.duration_ms) === 0n || value.schedule.Stream.curve > 100) throw new Error('流支付参数无效。');
    } else {
      const s = value.schedule.Recurring;
      if (BigInt(s.amount) === 0n || BigInt(s.interval_ms) < 1_000n || (BigInt(s.end_ms) > 0n && BigInt(s.end_ms) < BigInt(value.start_ms))) throw new Error('周期付款参数无效。');
    }
    return { ...value, coinType: coinType! };
  }
  async function readPaymentCap(capId: string, expectedPaymentId: string, expectedOwner?: string, options?: FinanceReadOptions) {
    const { value } = await read(capId, 'scheduled_payments', 'PaymentCap', PaymentCapBcs, false, false, options, expectedOwner);
    if (value.payment_id !== financeAddress(expectedPaymentId)) throw new Error('PaymentCap 不属于此付款计划。');
    return value;
  }
  async function readMasterCap(capId: string, expectedOwner?: string, options?: FinanceReadOptions) {
    return (await read(capId, 'vault', 'MasterCap', MasterCapBcs, false, false, options, expectedOwner)).value;
  }
  async function readOperatorCap(capId: string, expectedOwner?: string, options?: FinanceReadOptions) {
    return (await read(capId, 'vault', 'OperatorCap', OperatorCapBcs, false, false, options, expectedOwner)).value;
  }
  async function readAgentCap(capId: string, expectedOwner?: string, options?: FinanceReadOptions) {
    return (await read(capId, 'vault', 'AgentCap', AgentCapBcs, false, false, options, expectedOwner)).value;
  }
  return { readVault, readTreasury, readTransferBinding, readTransferProposal, readBoundTransfer, readPayment, readPaymentCap, readMasterCap, readOperatorCap, readAgentCap };
}

/** No majority formula: the exact threshold snapshotted by the proposal is authoritative. */
export function treasuryTransferExecutable(input: { proposal: ReturnType<typeof AsyncTransferProposalBcs.parse>; organizationEpoch: bigint; organizationId: string; vaultBalance: bigint; nowMs: bigint }): boolean {
  const p = input.proposal;
  return p.status === 1 && p.org_id === financeAddress(input.organizationId) && BigInt(p.epoch) === input.organizationEpoch
    && BigInt(p.threshold_weight) > 0n && BigInt(p.accumulated_weight) >= BigInt(p.threshold_weight)
    && financeU64(input.nowMs) <= BigInt(p.deadline_ms) && BigInt(p.amount) > 0n && BigInt(p.amount) <= input.vaultBalance;
}
