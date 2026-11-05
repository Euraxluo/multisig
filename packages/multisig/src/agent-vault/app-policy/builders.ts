/**
 * walrus_app_policy 的 PTB 构造器。
 *
 * pay 消耗整枚 Coin<SUI>（先在同 PTB split 出精确金额）；授权完全由链上的
 * receipt 绑定校验完成 —— 调用方不提供金额/布尔，客户端只镜像 blob ID 与
 * 正数金额这些可本地判定的合约常量。
 */
import { Transaction } from '@mysten/sui/transactions';
import { AGENT_VAULT_PACKAGE_ID } from '../org/constants';
import { FINANCE_SUI_TYPE, financeAddress, financeCoin, financeU64, type FinanceCoinSource, type FinanceTransactionOptions } from '../finance/validation';
import { APP_POLICY_LIMITS, APP_POLICY_MODULE } from './constants';

const bytes = (value: string) => new TextEncoder().encode(value).length;

function policyTarget(packageId: string | undefined, fn: string): string {
  return `${financeAddress(packageId ?? AGENT_VAULT_PACKAGE_ID)}::${APP_POLICY_MODULE}::${fn}`;
}

/** blob ID：1..128 UTF-8 字节（镜像 assert_blob_id）。 */
export function validateBlobId(blobId: string): void {
  const size = bytes(blobId);
  if (size === 0 || size > APP_POLICY_LIMITS.maxBlobIdBytes) throw new Error(`Blob ID 须为 1 到 ${APP_POLICY_LIMITS.maxBlobIdBytes} 字节。`);
}

/** 建 registry + admin cap：share registry 后必须把 cap 明确转给接收人。 */
export function buildCreatePolicyRegistry(input: FinanceTransactionOptions & { packageId?: string; adminRecipient: string }): Transaction {
  const recipient = financeAddress(input.adminRecipient);
  const tx = input.transaction ?? new Transaction();
  const [registry, cap] = tx.moveCall({ target: policyTarget(input.packageId, 'new') });
  tx.moveCall({ target: policyTarget(input.packageId, 'share'), arguments: [registry] });
  tx.transferObjects([cap], tx.pure.address(recipient));
  return tx;
}

export interface RegisterPaymentAppInput {
  blobId: string;
  channelId: string;
  /** 正数，且 ≤ 频道要求质押（后者由合约按频道对象校验）。 */
  minMemberStake: bigint;
  recipient: string;
  maxPayment: bigint;
  epochBudget: bigint;
}

/** 登记固定付费条款：登记后没有 recipient/channel/质押/限额的任何 setter。 */
export function buildRegisterPaymentApp(
  input: FinanceTransactionOptions & { packageId?: string; registryId: string; adminCapId: string },
  app: RegisterPaymentAppInput,
): Transaction {
  validateBlobId(app.blobId);
  if (app.minMemberStake <= 0n) throw new Error('最小成员质押必须为正数 MIST。');
  const recipient = financeAddress(app.recipient); // 零地址在此被拒（镜像 EInvalidRecipient）
  if (app.maxPayment <= 0n) throw new Error('单笔上限必须为正数 MIST。');
  if (app.epochBudget <= 0n) throw new Error('每纪元预算必须为正数 MIST。');
  const tx = input.transaction ?? new Transaction();
  tx.moveCall({
    target: policyTarget(input.packageId, 'register_payment_app'),
    arguments: [
      tx.object(financeAddress(input.registryId)), tx.object(financeAddress(input.adminCapId)),
      tx.pure.string(app.blobId), tx.object(financeAddress(app.channelId)),
      tx.pure.u64(financeU64(app.minMemberStake, true)), tx.pure.address(recipient),
      tx.pure.u64(financeU64(app.maxPayment, true)), tx.pure.u64(financeU64(app.epochBudget, true)),
    ],
  });
  return tx;
}

/** 暂停/恢复新付款；不影响成员资格，也不限制退群/退款。 */
export function buildToggleAppStatus(
  input: FinanceTransactionOptions & { packageId?: string; registryId: string; adminCapId: string },
  app: { blobId: string; isActive: boolean },
): Transaction {
  validateBlobId(app.blobId);
  const tx = input.transaction ?? new Transaction();
  tx.moveCall({
    target: policyTarget(input.packageId, 'toggle_app_status'),
    arguments: [
      tx.object(financeAddress(input.registryId)), tx.object(financeAddress(input.adminCapId)),
      tx.pure.string(app.blobId), tx.pure.bool(app.isActive),
    ],
  });
  return tx;
}

/** 持原始成员 receipt 付款：整枚 coin 原样送达登记收款人，授权全部在链上校验。
 *
 * 币源二选一：`payment.coin`（对象 ID / 本 PTB 句柄 / 列表）原样付；
 * 或只给 `payment.amount` 由 tx.coin() 生成精确 Coin<SUI>（pay 仅收 Coin<SUI>）。
 */
export function buildPayWithStakeReceipt(
  input: FinanceTransactionOptions & { packageId?: string; registryId: string; channelId: string; receiptId: string },
  app: { blobId: string; payment: FinanceCoinSource },
): Transaction {
  validateBlobId(app.blobId);
  const tx = input.transaction ?? new Transaction();
  const payment = financeCoin(tx, FINANCE_SUI_TYPE, app.payment);
  tx.moveCall({
    target: policyTarget(input.packageId, 'pay'),
    arguments: [
      tx.object(financeAddress(input.registryId)),
      tx.pure.string(app.blobId),
      tx.object(financeAddress(input.channelId)),
      tx.object(financeAddress(input.receiptId)),
      payment,
    ],
  });
  return tx;
}
