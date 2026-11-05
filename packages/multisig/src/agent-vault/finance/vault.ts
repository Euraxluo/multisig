import { Transaction } from '@mysten/sui/transactions';
import { AGENT_VAULT_PACKAGE_ID } from '../org/constants';
import { FINANCE_SUI_TYPE, financeAddress, financeCoinType, financeFunding, financeU64, type FinanceCoinInput, type FinanceTransactionOptions } from './validation';

export interface VaultOperation extends FinanceTransactionOptions { coinType?: string }
function callVault(input: VaultOperation, name: string, args: (tx: Transaction) => Parameters<Transaction['moveCall']>[0]['arguments']): Transaction {
  const packageId = financeAddress(input.packageId ?? AGENT_VAULT_PACKAGE_ID);
  const coinType = financeCoinType(input.coinType ?? FINANCE_SUI_TYPE);
  const tx = input.transaction ?? new Transaction();
  tx.moveCall({ target: `${packageId}::vault::${name}`, typeArguments: [coinType], arguments: args(tx) });
  return tx;
}

/** initialize_vault returns a linear MasterCap; deliver it explicitly, including sponsored PTBs. */
export function buildInitializeAgentVault(input: VaultOperation & { recipient: string }): Transaction {
  const recipient = financeAddress(input.recipient);
  const tx = input.transaction ?? new Transaction();
  const cap = tx.moveCall({ target: `${financeAddress(input.packageId ?? AGENT_VAULT_PACKAGE_ID)}::vault::initialize_vault`, typeArguments: [financeCoinType(input.coinType ?? FINANCE_SUI_TYPE)] });
  tx.transferObjects([cap], tx.pure.address(recipient));
  return tx;
}
export function buildDepositAgentVault(input: VaultOperation & { vaultId: string; amount: bigint; fundingCoin?: FinanceCoinInput }): Transaction {
  const vaultId = financeAddress(input.vaultId), amount = financeU64(input.amount, true), type = financeCoinType(input.coinType ?? FINANCE_SUI_TYPE);
  return callVault(input, 'deposit', tx => [tx.object(vaultId), financeFunding(tx, type, amount, input.fundingCoin)]);
}
export function buildWithdrawAgentVault(input: VaultOperation & { masterCapId: string; vaultId: string; amount: bigint; recipient: string }): Transaction {
  const master = financeAddress(input.masterCapId), vault = financeAddress(input.vaultId), amount = financeU64(input.amount, true), recipient = financeAddress(input.recipient);
  return callVault(input, 'withdraw', tx => [tx.object(master), tx.object(vault), tx.pure.u64(amount), tx.pure.address(recipient)]);
}
export function buildIssueVaultOperator(input: VaultOperation & { masterCapId: string; vaultId: string; operator: string }): Transaction {
  const master = financeAddress(input.masterCapId), vault = financeAddress(input.vaultId), operator = financeAddress(input.operator);
  return callVault(input, 'issue_operator_cap', tx => [tx.object(master), tx.object(vault), tx.pure.address(operator)]);
}
export function buildSpawnVaultAgent(input: VaultOperation & { operatorCapId: string; vaultId: string; agent: string; dailyBudget: bigint; serviceHash: Uint8Array }): Transaction {
  const operator = financeAddress(input.operatorCapId), vault = financeAddress(input.vaultId), agent = financeAddress(input.agent), budget = financeU64(input.dailyBudget);
  if (input.serviceHash.length > 256) throw new Error('服务标识哈希超过 256 字节。');
  return callVault(input, 'spawn_agent_card', tx => [tx.object(operator), tx.object(vault), tx.pure.address(agent), tx.pure.u64(budget), tx.pure.vector('u8', [...input.serviceHash])]);
}
/** 2026-10-29 起：额度/启停以金库 agents 表为权威，Operator 只凭 Agent 地址即可
 * 跨账户管理（无需也无法引用 Agent 钱包持有的 AgentCap）。 */
export function buildSetVaultAgentBudget(input: VaultOperation & { operatorCapId: string; vaultId: string; agentAddress: string; dailyBudget: bigint }): Transaction {
  const operator = financeAddress(input.operatorCapId), vault = financeAddress(input.vaultId), agent = financeAddress(input.agentAddress), budget = financeU64(input.dailyBudget);
  return callVault(input, 'set_agent_budget', tx => [tx.object(operator), tx.object(vault), tx.pure.address(agent), tx.pure.u64(budget)]);
}
export function buildSetVaultAgentPaused(input: VaultOperation & { operatorCapId: string; vaultId: string; agentAddress: string; paused: boolean }): Transaction {
  const operator = financeAddress(input.operatorCapId), vault = financeAddress(input.vaultId), agent = financeAddress(input.agentAddress);
  return callVault(input, input.paused ? 'pause_agent' : 'resume_agent', tx => [tx.object(operator), tx.object(vault), tx.pure.address(agent)]);
}
export function buildSpendVaultAgent(input: VaultOperation & { agentCapId: string; vaultId: string; amount: bigint; recipient: string }): Transaction {
  const agent = financeAddress(input.agentCapId), vault = financeAddress(input.vaultId), amount = financeU64(input.amount, true), recipient = financeAddress(input.recipient);
  return callVault(input, 'spend_x402_budget', tx => [tx.object(agent), tx.object(vault), tx.pure.u64(amount), tx.pure.address(recipient)]);
}
export function buildPurgeAgentVault(input: VaultOperation & { masterCapId: string; vaultId: string; recipient: string }): Transaction {
  const master = financeAddress(input.masterCapId), vault = financeAddress(input.vaultId), recipient = financeAddress(input.recipient);
  return callVault(input, 'emergency_unilateral_purge', tx => [tx.object(master), tx.object(vault), tx.pure.address(recipient)]);
}
export function buildUnpauseAgentVault(input: VaultOperation & { masterCapId: string; vaultId: string }): Transaction {
  const master = financeAddress(input.masterCapId), vault = financeAddress(input.vaultId);
  return callVault(input, 'unpause_vault', tx => [tx.object(master), tx.object(vault)]);
}

/** UI convenience adapter. All operations accept an existing PTB as the last argument. */
export function createAgentVaultWriters(packageId = AGENT_VAULT_PACKAGE_ID, coinType = FINANCE_SUI_TYPE) {
  const base = { packageId: financeAddress(packageId), coinType: financeCoinType(coinType) };
  return {
    initializeVault(recipient?: string, transaction?: Transaction) {
      // tx.pure cannot serialize an unknown future sender; require it explicitly.
      return buildInitializeAgentVault({ ...base, transaction, recipient: recipient ?? transaction?.getData().sender ?? (() => { throw new Error('初始化金库必须指定 MasterCap 收件人。'); })() });
    },
    deposit: (vaultId: string, amount: bigint, type = coinType, transaction?: Transaction) => buildDepositAgentVault({ ...base, transaction, coinType: type, vaultId, amount }),
    withdraw: (masterCapId: string, vaultId: string, amount: bigint, recipient: string, transaction?: Transaction) => buildWithdrawAgentVault({ ...base, transaction, masterCapId, vaultId, amount, recipient }),
    issueOperator: (masterCapId: string, vaultId: string, operator: string, transaction?: Transaction) => buildIssueVaultOperator({ ...base, transaction, masterCapId, vaultId, operator }),
    spawnAgent: (operatorCapId: string, vaultId: string, agent: string, dailyBudget: bigint, serviceHash: Uint8Array, transaction?: Transaction) => buildSpawnVaultAgent({ ...base, transaction, operatorCapId, vaultId, agent, dailyBudget, serviceHash }),
    setBudget: (operatorCapId: string, vaultId: string, agentAddress: string, dailyBudget: bigint, transaction?: Transaction) => buildSetVaultAgentBudget({ ...base, transaction, operatorCapId, vaultId, agentAddress, dailyBudget }),
    setPaused: (operatorCapId: string, vaultId: string, agentAddress: string, paused: boolean, transaction?: Transaction) => buildSetVaultAgentPaused({ ...base, transaction, operatorCapId, vaultId, agentAddress, paused }),
    spend: (agentCapId: string, vaultId: string, amount: bigint, recipient: string, transaction?: Transaction) => buildSpendVaultAgent({ ...base, transaction, agentCapId, vaultId, amount, recipient }),
    purge: (masterCapId: string, vaultId: string, recipient: string, transaction?: Transaction) => buildPurgeAgentVault({ ...base, transaction, masterCapId, vaultId, recipient }),
    unpause: (masterCapId: string, vaultId: string, transaction?: Transaction) => buildUnpauseAgentVault({ ...base, transaction, masterCapId, vaultId }),
  };
}
