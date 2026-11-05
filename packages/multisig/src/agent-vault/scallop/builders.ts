/**
 * scallop_yield_adapter 的 PTB 构造器。
 *
 * 本模块的两个币参数都是**中间币**，只接受现成 Coin（`FinanceCoinInput`）：
 * SSUI 仅由同 PTB 前面的 `split_ssui_for_redemption` 铸出，链上没有流通的
 * SSUI；注入的利息 SUI 必须是本 PTB 赎回步骤的产物，否则
 * `total_harvested_yield_sui` 的记账口径就失去意义。因此这里**不提供**
 * 「只给 amount 自动选币」——那会生成一枚来源不明的币，把不变量说成假的。
 */
import { Transaction, type TransactionArgument, type TransactionObjectArgument } from '@mysten/sui/transactions';
import { AGENT_VAULT_PACKAGE_ID } from '../org/constants';
import { financeAddress, financeU64, type FinanceCoinInput, type FinanceTransactionOptions } from '../finance/validation';
import { SCALLOP_MODULE } from './constants';

export interface ScallopOperation extends FinanceTransactionOptions {
  packageId?: string;
  adapterId: string;
}

function scallopTarget(input: { packageId?: string }, fn: string): string {
  return `${financeAddress(input.packageId ?? AGENT_VAULT_PACKAGE_ID)}::${SCALLOP_MODULE}::${fn}`;
}

/** 中间币一律按现成引用传入（对象 ID 或本 PTB 里的结果句柄）。 */
const coinArg = (tx: Transaction, coin: FinanceCoinInput): TransactionObjectArgument =>
  typeof coin === 'string' ? tx.object(financeAddress(coin)) : coin;

/** 为聊天群创建 sSUI 生息适配金库（共享对象在入口内分享）。 */
export function buildCreateScallopAdapter(input: FinanceTransactionOptions & { packageId?: string; channelId: string }): Transaction {
  const tx = input.transaction ?? new Transaction();
  tx.moveCall({ target: scallopTarget(input, 'create_scallop_adapter'), arguments: [tx.object(financeAddress(input.channelId))] });
  return tx;
}

/** 存入本金：`suiAmount` 是记账口径，`ssuiCoin` 必须是同一 PTB 里 Scallop 铸出的 Coin<SSUI>。 */
export function buildDepositToScallop(input: ScallopOperation & { suiAmount: bigint; ssuiCoin: FinanceCoinInput }): Transaction {
  const tx = input.transaction ?? new Transaction();
  tx.moveCall({
    target: scallopTarget(input, 'deposit_to_scallop'),
    arguments: [tx.object(financeAddress(input.adapterId)), tx.pure.u64(financeU64(input.suiAmount, true)), coinArg(tx, input.ssuiCoin)],
  });
  return tx;
}

/** PTB 第一步：切出待赎回的 sSUI；返回 coin 句柄交给 Scallop 赎回调用。 */
export function buildSplitSsuiForRedemption(input: ScallopOperation & { ssuiToRedeem: bigint }): { tx: Transaction; ssuiCoin: TransactionArgument } {
  const tx = input.transaction ?? new Transaction();
  const [ssuiCoin] = tx.moveCall({
    target: scallopTarget(input, 'split_ssui_for_redemption'),
    arguments: [tx.object(financeAddress(input.adapterId)), tx.pure.u64(financeU64(input.ssuiToRedeem, true))],
  });
  return { tx, ssuiCoin };
}

/** PTB 收尾：把赎回得到的 SUI 利息注入群聊（70/20/10 三路分润在链上完成）。
 *
 * `yieldCoin` 应是本 PTB 赎回步骤产出的 SUI：适配器会把它累加进
 * `total_harvested_yield_sui`，凭空塞入的币会让这个记账不再代表真实收割。 */
export function buildFeedHarvestedYieldToChat(input: ScallopOperation & { channelId: string; yieldCoin: FinanceCoinInput }): Transaction {
  const tx = input.transaction ?? new Transaction();
  tx.moveCall({
    target: scallopTarget(input, 'feed_harvested_yield_to_chat'),
    arguments: [tx.object(financeAddress(input.adapterId)), tx.object(financeAddress(input.channelId)), coinArg(tx, input.yieldCoin)],
  });
  return tx;
}

/** 本金对账清算：admin 或收款人本人可记录（合约侧鉴权）。 */
export function buildRecordPrincipalRedemption(input: ScallopOperation & { suiReturned: bigint; recipient: string }): Transaction {
  const tx = input.transaction ?? new Transaction();
  tx.moveCall({
    target: scallopTarget(input, 'record_principal_redemption'),
    arguments: [tx.object(financeAddress(input.adapterId)), tx.pure.u64(financeU64(input.suiReturned, true)), tx.pure.address(financeAddress(input.recipient))],
  });
  return tx;
}
