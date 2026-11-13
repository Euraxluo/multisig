/**
 * asset_custody 的 PTB 构造器。
 *
 * 单命令入口按 finance 惯例接受可选外接 Transaction；借出是同 PTB
 * 闪贷式往返，提供 buildTakeAssetStep / buildReturnAssetStep 两个步进原语，
 * 调用方在两步之间任意组合对资产的使用（升级模板即一例）。
 */
import { Transaction, type TransactionArgument } from '@mysten/sui/transactions';
import { AGENT_VAULT_PACKAGE_ID, SUI_CLOCK_OBJECT_ID } from '../org/constants';
import { financeAddress, financeCoinType, financeU64, type FinanceTransactionOptions } from '../finance/validation';
import { ASSET_CUSTODY_MODULE, CUSTODY_KIND, CUSTODY_LIMITS } from './constants';

export interface CustodyTarget extends FinanceTransactionOptions {
  /** 调用目标包，默认现行包。 */
  packageId?: string;
}

function custodyTarget(input: CustodyTarget, fn: string): string {
  return `${financeAddress(input.packageId ?? AGENT_VAULT_PACKAGE_ID)}::${ASSET_CUSTODY_MODULE}::${fn}`;
}

const clock = (tx: Transaction): TransactionArgument => tx.object(SUI_CLOCK_OBJECT_ID);

/** 校验并规范化托管资产类型标签（0x2::package::UpgradeCap 等）。 */
export function custodyAssetType(value: string): string {
  return financeCoinType(value);
}

/** #12：actionDigest 归一化为字节（hex 字符串或 Uint8Array；缺省为空）。 */
function digestOf(value: string | Uint8Array | undefined): Uint8Array {
  if (value === undefined) return new Uint8Array(0);
  if (typeof value !== 'string') return value;
  const hex = value.replace(/^0x/i, '');
  if (hex.length !== 64 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error(`actionDigest 必须为 32 字节的 hex 字符串（64 个十六进制位），收到长度 ${hex.length}。`);
  }
  return new Uint8Array(32).map((_, i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16));
}

/** 创建共享托管金库：new + share 一笔完成（发送者须为正权重成员）。 */
export function buildCreateAssetCustody(input: CustodyTarget & { orgId: string }): Transaction {
  const tx = input.transaction ?? new Transaction();
  const custody = tx.moveCall({
    target: custodyTarget(input, 'new'),
    arguments: [tx.object(financeAddress(input.orgId))],
  });
  tx.moveCall({ target: custodyTarget(input, 'share'), arguments: [custody] });
  return tx;
}

/** 存入一件 owned 对象（资产以动态子对象托管，原 ID 仍可独立读取）。 */
export function buildDepositAsset(input: CustodyTarget & { custodyId: string; orgId: string; assetType: string; assetId: string }): Transaction {
  const tx = input.transaction ?? new Transaction();
  tx.moveCall({
    target: custodyTarget(input, 'deposit'),
    typeArguments: [custodyAssetType(input.assetType)],
    arguments: [
      tx.object(financeAddress(input.custodyId)),
      tx.object(financeAddress(input.orgId)),
      tx.object(financeAddress(input.assetId)),
      clock(tx),
    ],
  });
  return tx;
}

export interface CustodyProposalInput extends CustodyTarget {
  custodyId: string;
  orgId: string;
  assetType: string;
  /** CUSTODY_KIND.borrow（借出一个 PTB）或 CUSTODY_KIND.release（永久转出）。 */
  kind: number;
  slot: number | bigint;
  /** 1–256 字节标题。 */
  title: string | Uint8Array;
  /** 绝对毫秒截止（含端点；须在未来且 ≤ 365 天）。 */
  deadlineMs: number | bigint;
  /** #12：借出提案必须承诺的 32 字节 action digest（借出 PTB 的 PersonalMessage digest）；
   *  release 传空/缺省。合约断言 borrow 恰 32 字节、release 恒空（EInvalidActionDigest=23）。 */
  actionDigest?: string | Uint8Array;
  /** 转出收款人（仅 release；borrow 必须缺省）。 */
  recipient?: string;
}

/** 发起动用提案（kind 取 CUSTODY_KIND；返回 PTB，proposalId 从事件读取）。 */
export function buildCreateCustodyProposal(input: CustodyProposalInput): Transaction {
  const tx = input.transaction ?? new Transaction();
  const kind = input.kind;
  if (kind !== CUSTODY_KIND.borrow && kind !== CUSTODY_KIND.release) throw new Error(`kind 必须为 ${CUSTODY_KIND.borrow}(borrow) 或 ${CUSTODY_KIND.release}(release)`);
  if (kind === CUSTODY_KIND.borrow && input.recipient !== undefined) {
    throw new Error('借出提案不携带收款人（take_asset 后同 PTB 归还）。');
  }
  if (kind === CUSTODY_KIND.release && input.recipient === undefined) {
    throw new Error('转出提案必须冻结收款人 recipient。');
  }
  const digestBytes = digestOf(input.actionDigest);
  if (kind === CUSTODY_KIND.borrow && digestBytes.length !== 32) {
    throw new Error(`借出提案必须承诺恰 32 字节 actionDigest，实际 ${digestBytes.length}。`);
  }
  if (kind === CUSTODY_KIND.release && digestBytes.length !== 0) {
    throw new Error('转出提案不携带 actionDigest（合约恒存空值）。');
  }
  const title = typeof input.title === 'string' ? new TextEncoder().encode(input.title) : input.title;
  if (title.length === 0 || title.length > CUSTODY_LIMITS.MAX_TITLE_BYTES) {
    throw new Error(`标题须为 1–${CUSTODY_LIMITS.MAX_TITLE_BYTES} 字节，实际 ${title.length}`);
  }
  tx.moveCall({
    target: custodyTarget(input, 'create_proposal'),
    typeArguments: [custodyAssetType(input.assetType)],
    arguments: [
      tx.object(financeAddress(input.custodyId)),
      tx.object(financeAddress(input.orgId)),
      tx.pure.u8(kind),
      tx.pure.vector('u8', Array.from(title)),
      tx.pure.u64(financeU64(input.slot)),
      tx.pure.address(input.recipient === undefined ? '0x0' : financeAddress(input.recipient)),
      tx.pure.u64(financeU64(input.deadlineMs)),
      tx.pure.vector('u8', Array.from(digestBytes)),
      clock(tx),
    ],
  });
  return tx;
}

/** 赞成票：claimed_weight 传链上名册权重（合约要求与活跃名册完全一致）。 */
export function buildSubmitCustodyVote(input: CustodyTarget & { proposalId: string; orgId: string; claimedWeight: number | bigint }): Transaction {
  const tx = input.transaction ?? new Transaction();
  tx.moveCall({
    target: custodyTarget(input, 'submit_vote'),
    arguments: [
      tx.object(financeAddress(input.proposalId)),
      tx.object(financeAddress(input.orgId)),
      clock(tx),
      tx.pure.u64(financeU64(input.claimedWeight)),
    ],
  });
  return tx;
}

/** 否决票（达到快照门限即终态）。 */
export function buildRejectCustodyVote(input: CustodyTarget & { proposalId: string; orgId: string }): Transaction {
  const tx = input.transaction ?? new Transaction();
  tx.moveCall({
    target: custodyTarget(input, 'reject_vote'),
    arguments: [tx.object(financeAddress(input.proposalId)), tx.object(financeAddress(input.orgId)), clock(tx)],
  });
  return tx;
}

/** 执行转出：资产转移给提案冻结的收款人（收款人不可被 relayer 改写）。 */
export function buildExecuteRelease(input: CustodyTarget & { custodyId: string; proposalId: string; orgId: string; assetType: string }): Transaction {
  const tx = input.transaction ?? new Transaction();
  tx.moveCall({
    target: custodyTarget(input, 'execute_release'),
    typeArguments: [custodyAssetType(input.assetType)],
    arguments: [
      tx.object(financeAddress(input.custodyId)),
      tx.object(financeAddress(input.proposalId)),
      tx.object(financeAddress(input.orgId)),
      clock(tx),
    ],
  });
  return tx;
}

export interface BorrowedAssetStep {
  tx: Transaction;
  /** 借出的资产（UpgradeCap 等按值对象），交给同 PTB 的后续使用命令。 */
  asset: TransactionArgument;
  /** 零 drop 归还收据：本 PTB 结束前必须喂给 buildReturnAssetStep。 */
  receipt: TransactionArgument;
}

/** 借出步进：从托管摘出资产 + 归还收据；使用命令插在本步与归还步之间。
 *  发送者必须与提案 proposer 一致（合约 EBorrowerMismatch），否则请让 proposer 本人签发。 */
export function buildTakeAssetStep(input: CustodyTarget & { custodyId: string; proposalId: string; orgId: string; assetType: string }): BorrowedAssetStep {
  const tx = input.transaction ?? new Transaction();
  const [asset, receipt] = tx.moveCall({
    target: custodyTarget(input, 'take_asset'),
    typeArguments: [custodyAssetType(input.assetType)],
    arguments: [
      tx.object(financeAddress(input.custodyId)),
      tx.object(financeAddress(input.proposalId)),
      tx.object(financeAddress(input.orgId)),
      clock(tx),
    ],
  });

  return { tx, asset, receipt };
}

/** 归还步进：资产按收据回到原托管、原类型、原槽位（热土豆收据在此消耗）。 */
export function buildReturnAssetStep(
  input: CustodyTarget & { custodyId: string; asset: TransactionArgument; receipt: TransactionArgument; assetType: string },
): Transaction {
  const tx = input.transaction ?? new Transaction();
  tx.moveCall({
    target: custodyTarget(input, 'return_asset'),
    typeArguments: [custodyAssetType(input.assetType)],
    arguments: [tx.object(financeAddress(input.custodyId)), input.asset, input.receipt],
  });
  return tx;
}

export interface CustodyUpgradeTemplateInput extends CustodyTarget {
  custodyId: string;
  proposalId: string;
  orgId: string;
  /** 托管中的 UpgradeCap（类型参数固定 0x2::package::UpgradeCap）。 */
  assetType?: string;
  /** `sui move build --dump-bytecode-as-base64` 产物。 */
  modules: string[] | number[][];
  dependencies: string[];
  /** 32 字节编译摘要。 */
  digest32: Uint8Array;
  /** 被升级的当前包 id（从托管 cap 的 BCS 推导，见 reader）。 */
  currentPackageId: string;
  /** 显式 gas 预算（模块字节大的升级 PTB 惯例 ~1 SUI）。 */
  gasBudgetMist?: bigint;
}

/**
 * 托管升级模板：一笔 PTB 完成借出 → 授权 → 升级 → 提交 → 归还。
 *
 * 六命令链：take_asset → upgrade_policy → authorize_upgrade → Upgrade →
 * commit_upgrade → return_asset。policy 从链上 cap 现取（防漂移）；ticket/
 * receipt 热土豆全程 PTB 内流转。digest 错只会在同 PTB 内 abort，可安全重试。
 */
export function buildCustodyUpgradeTemplate(input: CustodyUpgradeTemplateInput): Transaction {
  if (input.digest32.length !== 32) throw new Error(`digest32 必须 32 字节，实际 ${input.digest32.length}`);
  const step = buildTakeAssetStep({ ...input, assetType: input.assetType ?? '0x2::package::UpgradeCap' });
  const tx = step.tx;
  const policy = tx.moveCall({
    target: '0x2::package::upgrade_policy',
    arguments: [step.asset],
  });
  const ticket = tx.moveCall({
    target: '0x2::package::authorize_upgrade',
    arguments: [step.asset, policy, tx.pure.vector('u8', Array.from(input.digest32))],
  });
  const upgradeReceipt = tx.upgrade({
    modules: input.modules,
    dependencies: input.dependencies,
    package: input.currentPackageId,
    ticket,
  });
  tx.moveCall({
    target: '0x2::package::commit_upgrade',
    arguments: [step.asset, upgradeReceipt],
  });
  buildReturnAssetStep({
    packageId: input.packageId,
    transaction: tx,
    custodyId: input.custodyId,
    asset: step.asset,
    receipt: step.receipt,
    assetType: input.assetType ?? '0x2::package::UpgradeCap',
  });
  if (input.gasBudgetMist !== undefined) tx.setGasBudgetIfNotSet(financeU64(input.gasBudgetMist));
  return tx;
}
