import { Transaction } from '@mysten/sui/transactions';
import { AGENT_VAULT_PACKAGE_ID, SUI_CLOCK_OBJECT_ID } from '../org/constants';
import { financeAddress, financeU64, type FinanceTransactionOptions } from './validation';

export interface TreasuryTransferInput { title: string; recipient: string; amount: bigint; deadlineMs: bigint }
function target(input: FinanceTransactionOptions, name: string): `${string}::${string}::${string}` {
  return `${financeAddress(input.packageId ?? AGENT_VAULT_PACKAGE_ID)}::organization_treasury::${name}`;
}

/** Creates a SUI vault and shares the wrapper holding its sole MasterCap. Deposit in a later PTB. */
export function buildCreateOrganizationTreasury(input: FinanceTransactionOptions & { orgId: string }): Transaction {
  const org = financeAddress(input.orgId), tx = input.transaction ?? new Transaction();
  const treasury = tx.moveCall({ target: target(input, 'new'), arguments: [tx.object(org)] });
  tx.moveCall({ target: target(input, 'share'), arguments: [treasury] });
  return tx;
}

/** Proposal recipient and amount are committed on chain with an immutable treasury binding. */
export function buildCreateTreasuryTransfer(input: FinanceTransactionOptions & TreasuryTransferInput & { treasuryId: string; orgId: string; nowMs?: bigint }): Transaction {
  const treasury = financeAddress(input.treasuryId), org = financeAddress(input.orgId), recipient = financeAddress(input.recipient);
  const title = new TextEncoder().encode(input.title), amount = financeU64(input.amount, true), deadline = financeU64(input.deadlineMs);
  // Optional clock preflight. The canonical Sui Clock always decides execution validity.
  if (!title.length || title.length > 256) throw new Error('国库提案标题必须为 1..256 字节。');
  if (input.nowMs !== undefined) {
    const now = financeU64(input.nowMs);
    if (deadline <= now || deadline - now > 31_536_000_000n) throw new Error('国库提案截止时间无效。');
  }
  const tx = input.transaction ?? new Transaction();
  tx.moveCall({ target: target(input, 'create_transfer'), arguments: [tx.object(treasury), tx.object(org), tx.pure.vector('u8', [...title]), tx.pure.address(recipient), tx.pure.u64(amount), tx.pure.u64(deadline), tx.object(SUI_CLOCK_OBJECT_ID)] });
  return tx;
}

/** Permissionless relay; no recipient/amount override exists on the execution path. */
export function buildExecuteTreasuryTransfer(input: FinanceTransactionOptions & { treasuryId: string; bindingId: string; orgId: string; proposalId: string; vaultId: string }): Transaction {
  const ids = [input.treasuryId, input.bindingId, input.orgId, input.proposalId, input.vaultId].map(id => financeAddress(id));
  const tx = input.transaction ?? new Transaction();
  tx.moveCall({ target: target(input, 'execute'), arguments: [...ids.map(id => tx.object(id)), tx.object(SUI_CLOCK_OBJECT_ID)] });
  return tx;
}

/** Weighted approvals authenticate the transaction sender; partial_signature is ancillary, not FROST verification. */
export function buildApproveTreasuryTransfer(input: FinanceTransactionOptions & { proposalId: string; orgId: string; memberWeight: bigint; partialSignature?: Uint8Array }): Transaction {
  const proposal = financeAddress(input.proposalId), org = financeAddress(input.orgId), weight = financeU64(input.memberWeight, true);
  const tx = input.transaction ?? new Transaction();
  tx.moveCall({ target: `${financeAddress(input.packageId ?? AGENT_VAULT_PACKAGE_ID)}::asynchronous_proposal::submit_async_vote`, arguments: [tx.object(proposal), tx.object(org), tx.object(SUI_CLOCK_OBJECT_ID), tx.pure.u64(weight), tx.pure.vector('u8', [...(input.partialSignature ?? [])])] });
  return tx;
}
export function buildRejectTreasuryTransfer(input: FinanceTransactionOptions & { proposalId: string; orgId: string }): Transaction {
  const proposal = financeAddress(input.proposalId), org = financeAddress(input.orgId), tx = input.transaction ?? new Transaction();
  tx.moveCall({ target: `${financeAddress(input.packageId ?? AGENT_VAULT_PACKAGE_ID)}::asynchronous_proposal::reject_async_vote`, arguments: [tx.object(proposal), tx.object(org), tx.object(SUI_CLOCK_OBJECT_ID)] });
  return tx;
}
