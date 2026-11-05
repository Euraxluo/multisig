/**
 * onchain_chat 读取层：频道快照、成员表、质押凭证、Subagent Cap、
 * 收益累加器与单会员债务。
 *
 * 收益债务是质押加权记账：累加器（accrued MIST / MIST stake × scale，u128）
 * 与每会员债务快照都挂在频道对象自身的动态字段上；computePendingMemberYield
 * 是 take_member_yield 的纯函数镜像 —— gross = acc×stake/scale，
 * pending = max(gross−debt, 0)，payout 再被池余额封顶（舍入尘不能凭空造币）。
 */
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import { bcs } from '@mysten/sui/bcs';
import { normalizeStructTag } from '@mysten/sui/utils';
import { canonicalAddress } from '../org/bcs';
import { ChatChannelBcs, MemberStakeReceiptBcs, MemberYieldKeyBcs, SubagentMessagingCapBcs, YieldAccumulatorKeyBcs } from './schemas';
import { CHAT_LIMITS, CHAT_MODULE } from './constants';

export type ChatReadClient = Pick<SuiGrpcClient, 'getObject' | 'getDynamicField'>;
export interface ChatReadOptions { signal?: AbortSignal }

export interface ChatChannelSnapshot {
  id: string;
  orgId: string;
  name: Uint8Array;
  creator: string;
  membersTableId: string;
  messageSequence: bigint;
  stakedPrincipal: bigint;
  gasSubsidyPool: bigint;
  totalSubsidizedGas: bigint;
  entryFee: bigint;
  requiredMemberStake: bigint;
  creatorYieldShareBps: bigint;
  gasSubsidyShareBps: bigint;
  memberRebateShareBps: bigint;
  membersStakedPool: bigint;
  creatorRevenuePool: bigint;
  memberYieldPool: bigint;
  totalStakedMembers: bigint;
}

export interface MemberStakeReceiptSnapshot {
  id: string;
  channelId: string;
  member: string;
  stakedAmount: bigint;
}

export interface SubagentMessagingCapSnapshot {
  id: string;
  masterOwner: string;
  agentAddress: string;
  channelId: string;
  expiresAtMs: bigint;
  rateLimitPerMinute: bigint;
  messagesSentInWindow: bigint;
  windowStartMs: bigint;
  isRevoked: boolean;
}

function chatType(packageId: string, name: string): string {
  return normalizeStructTag(`${canonicalAddress(packageId)}::${CHAT_MODULE}::${name}`);
}

const isNotFound = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { reason?: unknown }).reason === 'notFound';

export async function readChannel(client: ChatReadClient, config: { packageId: string; channelId: string }, options: ChatReadOptions = {}): Promise<ChatChannelSnapshot> {
  const { object } = await client.getObject({ objectId: config.channelId, include: { content: true }, signal: options.signal });
  if (normalizeStructTag(object.type) !== chatType(config.packageId, 'ChatChannel')) throw new Error('对象不是当前包的 onchain_chat::ChatChannel。');
  const f = ChatChannelBcs.parse(object.content);
  return {
    id: f.id,
    orgId: f.org_id,
    name: new Uint8Array(f.name),
    creator: f.creator,
    membersTableId: f.members.id,
    messageSequence: BigInt(f.message_sequence),
    stakedPrincipal: BigInt(f.staked_principal.value),
    gasSubsidyPool: BigInt(f.gas_subsidy_pool.value),
    totalSubsidizedGas: BigInt(f.total_subsidized_gas),
    entryFee: BigInt(f.entry_fee),
    requiredMemberStake: BigInt(f.required_member_stake),
    creatorYieldShareBps: BigInt(f.creator_yield_share_bps),
    gasSubsidyShareBps: BigInt(f.gas_subsidy_share_bps),
    memberRebateShareBps: BigInt(f.member_rebate_share_bps),
    membersStakedPool: BigInt(f.members_staked_pool.value),
    creatorRevenuePool: BigInt(f.creator_revenue_pool.value),
    memberYieldPool: BigInt(f.member_yield_pool.value),
    totalStakedMembers: BigInt(f.total_staked_members),
  };
}

/** 成员表是 Table<address, bool>；查无此键 = 非成员（notFound 结构判定）。 */
export async function isChannelMember(client: ChatReadClient, config: { packageId: string; channelId: string; member: string }, options: ChatReadOptions = {}): Promise<boolean> {
  const channel = await readChannel(client, config, options);
  const expected = normalizeStructTag('0x2::dynamic_field::Field<address,bool>');
  try {
    const { dynamicField } = await client.getDynamicField({
      parentId: channel.membersTableId,
      name: { type: 'address', bcs: bcs.Address.serialize(canonicalAddress(config.member)).toBytes() },
      signal: options.signal,
    });
    if (dynamicField.$kind !== 'DynamicField' || normalizeStructTag(dynamicField.type) !== expected) throw new Error('成员表字段类型不匹配。');
    return bcs.bool().parse(dynamicField.value.bcs);
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

export async function readMemberStakeReceipt(client: ChatReadClient, config: { packageId: string; receiptId: string }, options: ChatReadOptions = {}): Promise<MemberStakeReceiptSnapshot> {
  const { object } = await client.getObject({ objectId: config.receiptId, include: { content: true }, signal: options.signal });
  if (normalizeStructTag(object.type) !== chatType(config.packageId, 'MemberStakeReceipt')) throw new Error('对象不是当前包的 onchain_chat::MemberStakeReceipt。');
  const f = MemberStakeReceiptBcs.parse(object.content);
  return { id: f.id, channelId: f.channel_id, member: f.member, stakedAmount: BigInt(f.staked_amount) };
}

export async function readSubagentMessagingCap(client: ChatReadClient, config: { packageId: string; capId: string }, options: ChatReadOptions = {}): Promise<SubagentMessagingCapSnapshot> {
  const { object } = await client.getObject({ objectId: config.capId, include: { content: true }, signal: options.signal });
  if (normalizeStructTag(object.type) !== chatType(config.packageId, 'SubagentMessagingCap')) throw new Error('对象不是当前包的 onchain_chat::SubagentMessagingCap。');
  const f = SubagentMessagingCapBcs.parse(object.content);
  return {
    id: f.id,
    masterOwner: f.master_owner,
    agentAddress: f.agent_address,
    channelId: f.channel_id,
    expiresAtMs: BigInt(f.expires_at_ms),
    rateLimitPerMinute: BigInt(f.rate_limit_per_minute),
    messagesSentInWindow: BigInt(f.messages_sent_in_window),
    windowStartMs: BigInt(f.window_start_ms),
    isRevoked: f.is_revoked,
  };
}

/** 频道累计收益率（尚未记入任何成员债务快照时为 0）。 */
export async function readYieldAccumulator(client: ChatReadClient, config: { packageId: string; channelId: string }, options: ChatReadOptions = {}): Promise<bigint> {
  const keyType = chatType(config.packageId, 'YieldAccumulatorKey');
  const expected = normalizeStructTag(`0x2::dynamic_field::Field<${keyType},u128>`);
  try {
    const { dynamicField } = await client.getDynamicField({
      parentId: config.channelId,
      name: { type: keyType, bcs: YieldAccumulatorKeyBcs.serialize({ dummy_field: false }).toBytes() },
      signal: options.signal,
    });
    if (dynamicField.$kind !== 'DynamicField' || normalizeStructTag(dynamicField.type) !== expected) throw new Error('收益累加器字段类型不匹配。');
    return BigInt(bcs.u128().parse(dynamicField.value.bcs));
  } catch (error) {
    if (isNotFound(error)) return 0n;
    throw error;
  }
}

/** 成员当前的收益债务快照；从未入账（未进群/已提清）返回 null。 */
export async function readMemberYieldDebt(client: ChatReadClient, config: { packageId: string; channelId: string; member: string }, options: ChatReadOptions = {}): Promise<bigint | null> {
  const keyType = chatType(config.packageId, 'MemberYieldKey');
  const expected = normalizeStructTag(`0x2::dynamic_field::Field<${keyType},u128>`);
  try {
    const { dynamicField } = await client.getDynamicField({
      parentId: config.channelId,
      name: { type: keyType, bcs: MemberYieldKeyBcs.serialize({ member: canonicalAddress(config.member) }).toBytes() },
      signal: options.signal,
    });
    if (dynamicField.$kind !== 'DynamicField' || normalizeStructTag(dynamicField.type) !== expected) throw new Error('收益债务字段类型不匹配。');
    return BigInt(bcs.u128().parse(dynamicField.value.bcs));
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

/** take_member_yield 的链下镜像：当前可领份额（不会发交易，仅为预览）。 */
export function computePendingMemberYield(input: { accumulator: bigint; stakedAmount: bigint; debt: bigint; poolBalance: bigint }): bigint {
  const gross = (input.accumulator * input.stakedAmount) / CHAT_LIMITS.yieldAccScale;
  const pending = gross > input.debt ? gross - input.debt : 0n;
  return pending > input.poolBalance ? input.poolBalance : pending;
}

export type MessagingCapStatus = 'ACTIVE' | 'EXPIRED' | 'REVOKED' | 'STALE';

/** 凭证托管形态：共享对象 / 地址持有 / 其它（合约在代发中拿不到 &mut）。 */
export type MessagingCapCustody = 'shared' | 'address' | 'other';

/**
 * post_message_by_subagent 链上校验的链下镜像，按合约实际拒绝顺序分级：
 * 已吊销 → 已过期 → 主人已退群 → 凭证托管形态不可用 → 凭证不在代理名下 → ACTIVE。
 * reason 文案与前端既有测试逐字一致，供 UI 直接展示。
 */
export function classifyMessagingCap(input: {
  cap: Pick<SubagentMessagingCapSnapshot, 'isRevoked' | 'expiresAtMs' | 'masterOwner' | 'agentAddress'>;
  nowMs: number | bigint;
  masterIsMember: boolean;
  custody: MessagingCapCustody;
  capOwner: string | null;
}): { status: MessagingCapStatus; reason: string } {
  if (input.cap.isRevoked) return { status: 'REVOKED', reason: '主账号已吊销该发信凭证；合约会拒绝代发消息。' };
  if (input.cap.expiresAtMs < BigInt(input.nowMs)) return { status: 'EXPIRED', reason: '发信凭证已过期；合约会拒绝代发消息。' };
  if (!input.masterIsMember) return { status: 'STALE', reason: '签发者已不是频道成员；合约会以 E_NOT_CHANNEL_MEMBER 拒绝。' };
  if (input.custody === 'other') return { status: 'STALE', reason: '凭证既非共享也非地址持有；合约无法在代发中取得 &mut SubagentMessagingCap。' };
  if (input.custody === 'address' && input.capOwner !== input.cap.agentAddress) {
    return { status: 'STALE', reason: '凭证不在代理地址名下；合约要求协签发送者为代理地址。' };
  }
  return { status: 'ACTIVE', reason: '凭证有效，代理可按频控代发频道消息。' };
}
