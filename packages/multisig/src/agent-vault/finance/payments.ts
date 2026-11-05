import { Transaction, type TransactionArgument } from '@mysten/sui/transactions';
import { AGENT_VAULT_PACKAGE_ID, SUI_CLOCK_OBJECT_ID } from '../org/constants';
import type { PaymentSnapshot } from './schemas';
import { FINANCE_MAX_U64, FINANCE_ZERO_ADDRESS, financeAddress, financeCoinType, financeFunding, financeU64, type FinanceCoinInput } from './validation';

export const ZERO_SCOPE = FINANCE_ZERO_ADDRESS;
export const FREQUENCY_MS: Readonly<Record<string, bigint>> = {
  daily: 86_400_000n, weekly: 604_800_000n, biweekly: 1_209_600_000n,
  monthly: 2_592_000_000n, quarterly: 7_776_000_000n, yearly: 31_536_000_000n,
};

/** Parse decimals exactly: no rounding, exponent syntax or dropped dust. */
export function paymentUnits(value: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255 || !/^\d+(\.\d+)?$/.test(value)) throw new Error('请输入普通十进制金额。');
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > decimals) throw new Error(`此代币最多支持 ${decimals} 位小数。`);
  return financeU64(BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0'), true);
}
export function recurringCount(startMs: bigint, intervalMs: bigint, endType: string, occurrences: string, endMs?: bigint): bigint {
  financeU64(startMs); financeU64(intervalMs);
  if (intervalMs < 1_000n) throw new Error('付款时间或间隔无效。');
  if (endType === 'never') return 0n;
  if (endType === 'date') {
    if (endMs === undefined || endMs < startMs || endMs > FINANCE_MAX_U64) throw new Error('结束日期必须不早于开始日期。');
    return financeU64((endMs - startMs) / intervalMs + 1n, true);
  }
  if (endType !== 'occurrences' || !/^\d+$/.test(occurrences)) throw new Error('付款次数无效。');
  return financeU64(BigInt(occurrences), true);
}

/** Exact Move vested_down projection; curve=50 is linear, allocation dust vests at the end. */
export function vestedUnits(total: bigint, elapsed: bigint, duration: bigint, curve: number): bigint {
  financeU64(total); financeU64(duration, true); financeU64(elapsed);
  if (!Number.isInteger(curve) || curve < 0 || curve > 100) throw new Error('流支付参数无效。');
  const twice = (elapsed > duration ? duration : elapsed) * 2n;
  const first = twice < duration ? twice : duration;
  return total * (first * BigInt(100 - curve) + (twice - first) * BigInt(curve)) / (duration * 100n);
}

/** Display projection only; canonical Clock and current chain state decide every payout. */
export function claimableUnits(payment: PaymentSnapshot, nowMs = BigInt(Date.now())): bigint {
  if (payment.status.$kind === 'Terminated') return 0n;
  const time = (payment.status.$kind === 'Paused' ? BigInt(payment.status.Paused.at_ms) : nowMs) - BigInt(payment.paused_ms);
  const start = BigInt(payment.start_ms);
  if (time < start) return 0n;
  if (payment.schedule.$kind === 'Stream') {
    const projected = vestedUnits(BigInt(payment.funded), time - start, BigInt(payment.schedule.Stream.duration_ms), payment.schedule.Stream.curve) - BigInt(payment.paid);
    return projected > 0n ? projected : 0n;
  }
  const schedule = payment.schedule.Recurring, end = BigInt(schedule.end_ms);
  const until = end > 0n && end < time ? end : time;
  let due = (until - start) / BigInt(schedule.interval_ms) + 1n;
  const max = BigInt(schedule.max_count);
  if (max > 0n && due > max) due = max;
  const amount = BigInt(schedule.amount);
  return due > BigInt(payment.installments_paid) && BigInt(payment.balance) >= amount ? amount : 0n;
}
function allocationCount(payment: { startMs: bigint; maxCount: bigint; endMs: bigint; intervalMs: bigint }): bigint {
  let count = payment.maxCount || FINANCE_MAX_U64;
  if (payment.endMs > 0n) {
    const endCount = (payment.endMs - payment.startMs) / payment.intervalMs + 1n;
    if (count > endCount) count = endCount;
  }
  return count;
}

export interface NewPayment {
  recipient: string; scope?: string; name: string; coinType: string; funding: bigint; startMs: bigint;
  /** Consume a caller-supplied Coin from this PTB; otherwise resolve exact funding via tx.coin. */
  fundingCoin?: FinanceCoinInput;
  /** Optional canonical Clock snapshot preflight; omitted supports deterministic offline construction. */
  nowMs?: bigint;
}
export interface NewRecurringPayment extends NewPayment {
  amount: bigint; intervalMs: bigint; maxCount: bigint; endMs: bigint; requiresApproval: boolean;
}
export interface NewStreamPayment extends NewPayment { endMs: bigint; curve: number }

/** Creates one funded shared payment and transfers PaymentCap to the transaction sender. */
export function buildCreatePayment(input: NewRecurringPayment | NewStreamPayment, packageId = AGENT_VAULT_PACKAGE_ID, transaction?: Transaction): Transaction {
  const recipient = financeAddress(input.recipient), scope = financeAddress(input.scope ?? ZERO_SCOPE, true), type = financeCoinType(input.coinType);
  financeU64(input.funding, true); financeU64(input.startMs); financeU64(input.endMs);
  if (new TextEncoder().encode(input.name).length > 256) throw new Error('付款名称超过 256 字节。');
  if (input.nowMs !== undefined && input.startMs < financeU64(input.nowMs)) throw new Error('付款开始时间早于链上时间。');
  const pkg = financeAddress(packageId);
  if ('intervalMs' in input) {
    financeU64(input.amount, true); financeU64(input.intervalMs); financeU64(input.maxCount);
    if (input.intervalMs < 1_000n || input.funding % input.amount || (input.endMs !== 0n && input.endMs < input.startMs)) throw new Error('周期付款参数无效。');
    if (input.funding > input.amount * allocationCount(input)) throw new Error('注资超过计划总额。');
  } else if (input.endMs <= input.startMs || !Number.isInteger(input.curve) || input.curve < 0 || input.curve > 100) throw new Error('流支付日期或曲线无效。');
  const tx = transaction ?? new Transaction();
  const args: TransactionArgument[] = [financeFunding(tx, type, input.funding, input.fundingCoin), tx.pure.address(recipient), tx.pure.address(scope), tx.pure.vector('u8', [...new TextEncoder().encode(input.name)])];
  if ('intervalMs' in input) {
    tx.moveCall({ target: `${pkg}::scheduled_payments::create_recurring`, typeArguments: [type], arguments: [...args, tx.pure.u64(input.amount), tx.pure.u64(input.intervalMs), tx.pure.u64(input.maxCount), tx.pure.u64(input.startMs), tx.pure.u64(input.endMs), tx.pure.bool(input.requiresApproval), tx.object(SUI_CLOCK_OBJECT_ID)] });
  } else {
    tx.moveCall({ target: `${pkg}::scheduled_payments::create_stream`, typeArguments: [type], arguments: [...args, tx.pure.u64(input.startMs), tx.pure.u64(input.endMs), tx.pure.u8(input.curve), tx.object(SUI_CLOCK_OBJECT_ID)] });
  }
  return tx;
}

export type PaymentAction = 'claim' | 'execute_installment' | 'pause' | 'resume' | 'terminate' | 'fund' | 'destroy_cap';
export function buildPaymentAction(payment: PaymentSnapshot, action: PaymentAction, funding?: bigint, packageId = AGENT_VAULT_PACKAGE_ID, transaction?: Transaction): Transaction {
  if (!['claim', 'execute_installment', 'pause', 'resume', 'terminate', 'fund', 'destroy_cap'].includes(action)) throw new Error('未知付款操作。');
  const id = financeAddress(payment.id), type = financeCoinType(payment.coinType), pkg = financeAddress(packageId);
  if (action === 'destroy_cap') {
    if (payment.status.$kind !== 'Terminated') throw new Error('只有终止后的付款才能销毁管理权限。');
  } else if (payment.status.$kind === 'Terminated') throw new Error('付款已终止。');
  if (action !== 'claim' && !payment.capId) throw new Error('当前账户没有此计划的 PaymentCap 管理权限。');
  if (action === 'claim' && payment.schedule.$kind === 'Recurring' && payment.schedule.Recurring.requires_approval) throw new Error('此计划需要管理者逐期审批并执行。');
  if (action === 'execute_installment' && payment.schedule.$kind !== 'Recurring') throw new Error('只有周期计划支持逐期执行。');
  if (action === 'fund') {
    if (payment.schedule.$kind !== 'Recurring' || funding === undefined) throw new Error('补资金额或计划类型无效。');
    financeU64(funding, true);
    const recurring = payment.schedule.Recurring, amount = BigInt(recurring.amount), total = BigInt(payment.funded) + funding;
    const limit = allocationCount({ startMs: BigInt(payment.start_ms), maxCount: BigInt(recurring.max_count), endMs: BigInt(recurring.end_ms), intervalMs: BigInt(recurring.interval_ms) });
    if (funding % amount || total > FINANCE_MAX_U64 || total > limit * amount) throw new Error('补资须为完整期款，且不能超过计划总额。');
  }
  const cap = payment.capId ? financeAddress(payment.capId) : undefined;
  const tx = transaction ?? new Transaction(), args: TransactionArgument[] = [tx.object(id)];
  if (action !== 'claim') args.push(tx.object(cap!));
  if (action === 'fund') args.push(financeFunding(tx, type, funding!));
  else if (action !== 'destroy_cap') args.push(tx.object(SUI_CLOCK_OBJECT_ID));
  tx.moveCall({ target: `${pkg}::scheduled_payments::${action}`, typeArguments: [type], arguments: args });
  return tx;
}
