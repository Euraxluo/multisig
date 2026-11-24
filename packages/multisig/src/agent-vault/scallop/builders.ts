/**
 * scallop_yield_adapter 的 PTB 构造器。
 *
 * 适配器没有接入任何借贷协议：`SSUI` 是占位类型，没有铸造入口，也没有 Scallop
 * 兑回步骤可调。存入与赎回两条路径目前都没有可用的调用方式。
 *
 * 本模块的两个币参数都是**中间币**，只接受现成 Coin（`FinanceCoinInput`）：
 * SSUI 仅由同 PTB 前面的 `split_ssui_for_redemption` 铸出，链上没有流通的
 * SSUI；注入频道的 SUI 按设计应是赎回步骤的产物，否则
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

/** 为聊天群创建 sSUI 适配器（共享对象在入口内分享）。适配器不接入任何借贷协议，创建后本金、份额、累计注入都是 0。 */
export function buildCreateScallopAdapter(input: FinanceTransactionOptions & { packageId?: string; channelId: string }): Transaction {
  const tx = input.transaction ?? new Transaction();
  tx.moveCall({ target: scallopTarget(input, 'create_scallop_adapter'), arguments: [tx.object(financeAddress(input.channelId))] });
  return tx;
}

/** 存入本金：记账事实源是 `ssuiCoin.value()`（admin-only）。`ssuiCoin` 必须是同一
 * PTB 里铸出的有值 Coin<SSUI>——合约不收任何裸 u64，申报通道已删除（#21）。
 * 当前包没有接入 Scallop，也没有 SSUI 铸造入口，这个入口目前没有可用的调用方式。 */
export function buildDepositToScallop(input: ScallopOperation & { ssuiCoin: FinanceCoinInput }): Transaction {
  const tx = input.transaction ?? new Transaction();
  tx.moveCall({
    target: scallopTarget(input, 'deposit_to_scallop'),
    arguments: [tx.object(financeAddress(input.adapterId)), coinArg(tx, input.ssuiCoin)],
  });
  return tx;
}

/** PTB 第一步：切出待赎回的 sSUI；返回 coin 句柄，按设计交给 Scallop 赎回调用（当前未接入 Scallop）。 */
export function buildSplitSsuiForRedemption(input: ScallopOperation & { ssuiToRedeem: bigint }): { tx: Transaction; ssuiCoin: TransactionArgument } {
  const tx = input.transaction ?? new Transaction();
  const [ssuiCoin] = tx.moveCall({
    target: scallopTarget(input, 'split_ssui_for_redemption'),
    arguments: [tx.object(financeAddress(input.adapterId)), tx.pure.u64(financeU64(input.ssuiToRedeem, true))],
  });
  return { tx, ssuiCoin };
}

/** PTB 收尾：把 SUI 经适配器注入群聊，按频道创建者设定的 bps 分配
 * （创作者/Gas 补贴/成员；链上没有固定的 70/20/10，比例取自频道字段）。
 *
 * 这笔币不是利息：适配器未接入任何借贷协议，`yieldCoin` 只是被累加进
 * `total_harvested_yield_sui` 的记账数字，链上不校验它来自任何赎回或收益。
 * 合约侧强制 admin + `channelId == adapter.channel_id`（#22）。 */
export function buildFeedHarvestedYieldToChat(input: ScallopOperation & { channelId: string; yieldCoin: FinanceCoinInput }): Transaction {
  const tx = input.transaction ?? new Transaction();
  tx.moveCall({
    target: scallopTarget(input, 'feed_harvested_yield_to_chat'),
    arguments: [tx.object(financeAddress(input.adapterId)), tx.object(financeAddress(input.channelId)), coinArg(tx, input.yieldCoin)],
  });
  return tx;
}

/** 本金对账清算（admin-only）：`suiCoin` 是本 PTB 里兑回得到的真实 Coin<SUI>
 * （按设计经 Scallop 兑回；当前未接入），记账与链上交割都以 coin.value() 为事实源（#21），`ssuiBurned` 记录对应 sSUI 份额。 */
export function buildRecordPrincipalRedemption(input: ScallopOperation & { suiCoin: FinanceCoinInput; ssuiBurned: bigint; recipient: string }): Transaction {
  const tx = input.transaction ?? new Transaction();
  tx.moveCall({
    target: scallopTarget(input, 'record_principal_redemption'),
    arguments: [tx.object(financeAddress(input.adapterId)), coinArg(tx, input.suiCoin), tx.pure.u64(financeU64(input.ssuiBurned, true)), tx.pure.address(financeAddress(input.recipient))],
  });
  return tx;
}
