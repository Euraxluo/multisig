/**
 * onchain_chat 的 PTB 构造器：建群（三种）、发信（单条/代发/批量）、
 * Subagent Cap、会员经济学（进群/退群/提现/解散/移除）与收益注入。
 *
 * 客户端校验镜像合约常量：bps 合计须为 10000 或 0；批量 1..32 条且逐条
 * 校验 preview/blob 界，整批先验后发（合约语义：坏行不能推进序号前缀）。
 */
import { Transaction, type TransactionArgument } from '@mysten/sui/transactions';
import { AGENT_VAULT_PACKAGE_ID, SUI_CLOCK_OBJECT_ID } from '../org/constants';
import { FINANCE_SUI_TYPE, financeAddress, financeCoin, financeReturnChange, financeU64, type FinanceCoinSource, type FinanceTransactionOptions } from '../finance/validation';
import { CHAT_LIMITS, CHAT_MODULE } from './constants';

const bytesOf = (value: string | Uint8Array): Uint8Array =>
  typeof value === 'string' ? new TextEncoder().encode(value) : value;

function chatTarget(packageId: string | undefined, fn: string): string {
  return `${financeAddress(packageId ?? AGENT_VAULT_PACKAGE_ID)}::${CHAT_MODULE}::${fn}`;
}

const u8s = (tx: Transaction, value: string | Uint8Array) => tx.pure.vector('u8', [...bytesOf(value)]);

function validateMessagePayload(walrusBlobId: Uint8Array, contentPreview: Uint8Array): void {
  if (contentPreview.length > CHAT_LIMITS.maxPreviewBytes) throw new Error(`内容预览最多 ${CHAT_LIMITS.maxPreviewBytes} 字节。`);
  // 空 blob id = 无 Walrus 附件（常态用法），只封上界。
  if (walrusBlobId.length > CHAT_LIMITS.maxBlobIdBytes) throw new Error(`Walrus Blob ID 最多 ${CHAT_LIMITS.maxBlobIdBytes} 字节。`);
}

/** 经典无质押建群（兼容旧 ABI；利息 100% 进 Gas 代付池）。 */
export function buildCreateChannel(input: FinanceTransactionOptions & { packageId?: string; orgId: string; name: string | Uint8Array; initialMembers: string[] }): Transaction {
  const tx = input.transaction ?? new Transaction();
  tx.moveCall({
    target: chatTarget(input.packageId, 'create_channel'),
    arguments: [tx.pure.address(financeAddress(input.orgId)), u8s(tx, input.name), tx.pure.vector('address', input.initialMembers.map((m) => financeAddress(m)))],
  });
  return tx;
}

/** 质押建群：永久利息代付 Gas。 */
export function buildCreateChannelWithStake(
  input: FinanceTransactionOptions & { packageId?: string; orgId: string; name: string | Uint8Array; initialMembers: string[]; stake: FinanceCoinSource },
): Transaction {
  const tx = input.transaction ?? new Transaction();
  tx.moveCall({
    target: chatTarget(input.packageId, 'create_channel_with_stake'),
    arguments: [tx.pure.address(financeAddress(input.orgId)), u8s(tx, input.name), tx.pure.vector('address', input.initialMembers.map((m) => financeAddress(m))), financeCoin(tx, FINANCE_SUI_TYPE, input.stake)],
  });
  return tx;
}

export interface CreatorMonetizedChannelInput {
  orgId: string;
  name: string | Uint8Array;
  creatorStake: FinanceCoinSource;
  /** 入群门票（归创作者，0 为无门票）。 */
  entryFee: bigint;
  /** 进群保本质押（退群 100% 赎回，0 为无要求）。 */
  requiredMemberStake: bigint;
  /** 三个分润基点合计须为 10000（多路分润）或 0（全进 Gas 池）。 */
  creatorYieldShareBps: bigint;
  gasSubsidyShareBps: bigint;
  memberRebateShareBps: bigint;
}

/** 星球/会员群：门票 + 保本质押 + 利息自动三路分润。 */
export function buildCreateCreatorMonetizedChannel(input: FinanceTransactionOptions & { packageId?: string }, monetized: CreatorMonetizedChannelInput): Transaction {
  const sum = monetized.creatorYieldShareBps + monetized.gasSubsidyShareBps + monetized.memberRebateShareBps;
  if (sum !== 10000n && sum !== 0n) throw new Error('三个分润基点之和必须为 10000（多路分润）或 0（全进 Gas 代付池）。');
  const tx = input.transaction ?? new Transaction();
  tx.moveCall({
    target: chatTarget(input.packageId, 'create_creator_monetized_channel'),
    arguments: [
      tx.pure.address(financeAddress(monetized.orgId)), u8s(tx, monetized.name), financeCoin(tx, FINANCE_SUI_TYPE, monetized.creatorStake),
      tx.pure.u64(financeU64(monetized.entryFee)), tx.pure.u64(financeU64(monetized.requiredMemberStake)),
      tx.pure.u64(financeU64(monetized.creatorYieldShareBps)), tx.pure.u64(financeU64(monetized.gasSubsidyShareBps)), tx.pure.u64(financeU64(monetized.memberRebateShareBps)),
    ],
  });
  return tx;
}

/** 注入质押利息：deposit 与 distribute 是同一入口的两个名字。 */
export function buildDepositStakingYield(input: FinanceTransactionOptions & { packageId?: string; channelId: string; yield: FinanceCoinSource }): Transaction {
  const tx = input.transaction ?? new Transaction();
  tx.moveCall({ target: chatTarget(input.packageId, 'deposit_staking_yield'), arguments: [tx.object(financeAddress(input.channelId)), financeCoin(tx, FINANCE_SUI_TYPE, input.yield)] });
  return tx;
}

export function buildDistributeStakingYield(input: FinanceTransactionOptions & { packageId?: string; channelId: string; yield: FinanceCoinSource }): Transaction {
  const tx = input.transaction ?? new Transaction();
  tx.moveCall({ target: chatTarget(input.packageId, 'distribute_staking_yield'), arguments: [tx.object(financeAddress(input.channelId)), financeCoin(tx, FINANCE_SUI_TYPE, input.yield)] });
  return tx;
}

/**
 * 进群：门票 + 保本质押一次付清，凭证自动转给发送者（entry 版）。
 *
 * 合约按 `&mut Coin<SUI>` 收币、只从中 split 走门票与质押，**余款留在币里**，
 * 因此这里必须把找零退回发送者，否则整笔交易因未使用有值 Coin 而中止。
 */
export function buildJoinChannel(input: FinanceTransactionOptions & { packageId?: string; channelId: string; payment: FinanceCoinSource }): Transaction {
  const tx = input.transaction ?? new Transaction();
  const coin = financeCoin(tx, FINANCE_SUI_TYPE, input.payment);
  tx.moveCall({ target: chatTarget(input.packageId, 'join_channel_entry'), arguments: [tx.object(financeAddress(input.channelId)), coin] });
  financeReturnChange(tx, coin);
  return tx;
}

/** 创作者提现（entry 版自动转款给发送者）。 */
export function buildClaimCreatorRevenue(input: FinanceTransactionOptions & { packageId?: string; channelId: string }): Transaction {
  const tx = input.transaction ?? new Transaction();
  tx.moveCall({ target: chatTarget(input.packageId, 'claim_creator_revenue_entry'), arguments: [tx.object(financeAddress(input.channelId))] });
  return tx;
}

/** 退群：交还凭证，本金 + 按质押加权的利息分红自动退给发送者（entry 版）。 */
export function buildMemberUnstakeAndLeave(input: FinanceTransactionOptions & { packageId?: string; channelId: string; receiptId: string }): Transaction {
  const tx = input.transaction ?? new Transaction();
  tx.moveCall({ target: chatTarget(input.packageId, 'member_unstake_and_leave_entry'), arguments: [tx.object(financeAddress(input.channelId)), tx.object(financeAddress(input.receiptId))] });
  return tx;
}

/** 创建者移除零质押成员：只对经付费入群且当前无质押在池的成员有效。 */
export function buildRemoveZeroStakeMember(input: FinanceTransactionOptions & { packageId?: string; channelId: string }, member: string): Transaction {
  const tx = input.transaction ?? new Transaction();
  tx.moveCall({ target: chatTarget(input.packageId, 'remove_zero_stake_member'), arguments: [tx.object(financeAddress(input.channelId)), tx.pure.address(financeAddress(member))] });
  return tx;
}

/**
 * 旧包回退：一个 PTB 里逐条 post_message（每条各付一次链上报销）。
 *
 * 整段 burst 共享同一个空 blob 输入，只有正文逐条编码；文本-only 场景与
 * post_message_batch 的语义差异只在 gas 报销次数，事件与序号推进一致。
 */
export function buildPostMessagesSequential(
  input: FinanceTransactionOptions & { packageId?: string; channelId: string },
  contentPreviews: (string | Uint8Array)[],
): Transaction {
  const tx = input.transaction ?? new Transaction();
  const noBlob = tx.pure.vector('u8', []);
  for (const preview of contentPreviews) {
    tx.moveCall({
      target: chatTarget(input.packageId, 'post_message'),
      arguments: [tx.object(financeAddress(input.channelId)), tx.object(SUI_CLOCK_OBJECT_ID), noBlob, u8s(tx, preview)],
    });
  }
  return tx;
}

/** 发信载荷：Walrus blob ID（可为空 = 无附件）与正文预览。 */
export interface ChatMessagePayload {
  walrusBlobId: Uint8Array;
  contentPreview: string | Uint8Array;
}

function messageArgs(tx: Transaction, payload: ChatMessagePayload) {
  const blob = payload.walrusBlobId;
  const preview = bytesOf(payload.contentPreview);
  validateMessagePayload(blob, preview);
  return [tx.pure.vector('u8', [...blob]), tx.pure.vector('u8', [...preview])];
}

/** 主账号亲自发信（带自动化 Gas 报销）。 */
export function buildPostMessage(
  input: FinanceTransactionOptions & { packageId?: string; channelId: string },
  payload: ChatMessagePayload,
): Transaction {
  const tx = input.transaction ?? new Transaction();
  tx.moveCall({
    target: chatTarget(input.packageId, 'post_message'),
    arguments: [tx.object(financeAddress(input.channelId)), tx.object(SUI_CLOCK_OBJECT_ID), ...messageArgs(tx, payload)],
  });
  return tx;
}

/** Subagent 免密自主发信：链上校验 agent 身份、频道绑定、吊销与过期、频控。 */
export function buildPostMessageBySubagent(
  input: FinanceTransactionOptions & { packageId?: string; channelId: string; capId: string },
  payload: ChatMessagePayload,
): Transaction {
  const tx = input.transaction ?? new Transaction();
  tx.moveCall({
    target: chatTarget(input.packageId, 'post_message_by_subagent'),
    arguments: [
      tx.object(financeAddress(input.channelId)),
      tx.object(financeAddress(input.capId)),
      tx.object(SUI_CLOCK_OBJECT_ID),
      ...messageArgs(tx, payload),
    ],
  });
  return tx;
}

/**
 * 批量发信：参数序是 previews 在前、blob_ids 在后。
 *
 * 整批先验后发——任何一行越界都在构造期拒绝，镜像合约「坏行不能推进序号前缀」
 * 的语义。
 */
export function buildPostMessageBatch(
  input: FinanceTransactionOptions & { packageId?: string; channelId: string },
  payloads: ChatMessagePayload[],
): Transaction {
  if (payloads.length === 0) throw new Error('批量不能为空。');
  if (payloads.length > CHAT_LIMITS.maxBatchMessages) throw new Error(`单批最多 ${CHAT_LIMITS.maxBatchMessages} 条。`);
  const previews = payloads.map((p) => bytesOf(p.contentPreview));
  const blobIds = payloads.map((p) => p.walrusBlobId);
  previews.forEach((preview, i) => validateMessagePayload(blobIds[i], preview));
  const tx = input.transaction ?? new Transaction();
  tx.moveCall({
    target: chatTarget(input.packageId, 'post_message_batch'),
    arguments: [
      tx.object(financeAddress(input.channelId)),
      tx.object(SUI_CLOCK_OBJECT_ID),
      tx.pure.vector('vector<u8>', previews.map((p) => [...p])),
      tx.pure.vector('vector<u8>', blobIds.map((b) => [...b])),
    ],
  });
  return tx;
}

/** 签发并直接共享 Subagent Cap（双端随时可调，无需转移）。 */
export function buildCreateSharedSubagentMessagingCap(
  input: FinanceTransactionOptions & { packageId?: string; channelId: string },
  cap: { agentAddress: string; expiresAtMs: bigint; rateLimitPerMinute: bigint },
): Transaction {
  const tx = input.transaction ?? new Transaction();
  tx.moveCall({
    target: chatTarget(input.packageId, 'create_shared_subagent_messaging_cap'),
    arguments: [
      tx.object(financeAddress(input.channelId)),
      tx.pure.address(financeAddress(cap.agentAddress)),
      tx.pure.u64(financeU64(cap.expiresAtMs)),
      tx.pure.u64(financeU64(cap.rateLimitPerMinute)),
    ],
  });
  return tx;
}

/** 吊销 Subagent Cap：只有 master_owner 能调（合约侧校验）。 */
export function buildRevokeSubagentMessagingCap(
  input: FinanceTransactionOptions & { packageId?: string; capId: string },
): Transaction {
  const tx = input.transaction ?? new Transaction();
  tx.moveCall({ target: chatTarget(input.packageId, 'revoke_subagent_messaging_cap'), arguments: [tx.object(financeAddress(input.capId))] });
  return tx;
}

/** 解散频道并退款：创建者专属，且成员必须全部已退群（合约侧校验）。 */
export function buildUnstakeAndCloseChannel(
  input: FinanceTransactionOptions & { packageId?: string; channelId: string },
): Transaction {
  const tx = input.transaction ?? new Transaction();
  tx.moveCall({ target: chatTarget(input.packageId, 'unstake_and_close_channel'), arguments: [tx.object(financeAddress(input.channelId))] });
  return tx;
}
