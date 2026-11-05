/** onchain_chat 的 BCS schema：频道、凭证、Cap 与全部事件。Balance<T> 布局为 {value: u64}。 */
import { bcs } from '@mysten/sui/bcs';

const Balance = bcs.struct('Balance', { value: bcs.u64() });
const Table = bcs.struct('Table', { id: bcs.Address, size: bcs.u64() });

export const ChatChannelBcs = bcs.struct('ChatChannel', {
  id: bcs.Address,
  org_id: bcs.Address,
  name: bcs.vector(bcs.u8()),
  creator: bcs.Address,
  members: Table,
  message_sequence: bcs.u64(),
  staked_principal: Balance,
  gas_subsidy_pool: Balance,
  total_subsidized_gas: bcs.u64(),
  entry_fee: bcs.u64(),
  required_member_stake: bcs.u64(),
  creator_yield_share_bps: bcs.u64(),
  gas_subsidy_share_bps: bcs.u64(),
  member_rebate_share_bps: bcs.u64(),
  members_staked_pool: Balance,
  creator_revenue_pool: Balance,
  member_yield_pool: Balance,
  total_staked_members: bcs.u64(),
});

export const MemberStakeReceiptBcs = bcs.struct('MemberStakeReceipt', {
  id: bcs.Address, channel_id: bcs.Address, member: bcs.Address, staked_amount: bcs.u64(),
});

export const SubagentMessagingCapBcs = bcs.struct('SubagentMessagingCap', {
  id: bcs.Address,
  master_owner: bcs.Address,
  agent_address: bcs.Address,
  channel_id: bcs.Address,
  expires_at_ms: bcs.u64(),
  rate_limit_per_minute: bcs.u64(),
  messages_sent_in_window: bcs.u64(),
  window_start_ms: bcs.u64(),
  is_revoked: bcs.bool(),
});

export const ChannelCreatedWithStakeBcs = bcs.struct('ChannelCreatedWithStakeEvent', {
  channel_id: bcs.Address, org_id: bcs.Address, name: bcs.vector(bcs.u8()), creator: bcs.Address, staked_amount: bcs.u64(),
});
export const StakingYieldDepositedBcs = bcs.struct('StakingYieldDepositedEvent', {
  channel_id: bcs.Address, yield_amount: bcs.u64(), pool_balance: bcs.u64(),
});
export const StakingYieldDistributedBcs = bcs.struct('StakingYieldDistributedEvent', {
  channel_id: bcs.Address, total_yield: bcs.u64(), creator_share: bcs.u64(), gas_subsidy_share: bcs.u64(), member_rebate_share: bcs.u64(),
});
export const GasSubsidizedBcs = bcs.struct('GasSubsidizedEvent', {
  channel_id: bcs.Address, recipient: bcs.Address, rebate_amount: bcs.u64(), total_subsidized: bcs.u64(),
});
export const SubagentCapIssuedBcs = bcs.struct('SubagentMessagingCapIssuedEvent', {
  cap_id: bcs.Address, master_owner: bcs.Address, agent_address: bcs.Address, channel_id: bcs.Address,
  expires_at_ms: bcs.u64(), rate_limit_per_minute: bcs.u64(),
});
export const SubagentCapRevokedBcs = bcs.struct('SubagentMessagingCapRevokedEvent', {
  cap_id: bcs.Address, master_owner: bcs.Address, agent_address: bcs.Address,
});
export const ChatMessageBcs = bcs.struct('ChatMessageEvent', {
  channel_id: bcs.Address, sequence: bcs.u64(), sender_master: bcs.Address, sender_agent: bcs.Address,
  walrus_blob_id: bcs.vector(bcs.u8()), content_preview: bcs.vector(bcs.u8()), timestamp_ms: bcs.u64(),
});
export const ChannelClosedAndRefundedBcs = bcs.struct('ChannelClosedAndRefundedEvent', {
  channel_id: bcs.Address, creator: bcs.Address, refunded_stake: bcs.u64(), remaining_subsidy: bcs.u64(),
});
export const MemberJoinedWithStakeBcs = bcs.struct('MemberJoinedWithStakeEvent', {
  channel_id: bcs.Address, member: bcs.Address, entry_fee_paid: bcs.u64(), staked_amount: bcs.u64(), total_members: bcs.u64(),
});
export const CreatorRevenueClaimedBcs = bcs.struct('CreatorRevenueClaimedEvent', {
  channel_id: bcs.Address, creator: bcs.Address, claimed_amount: bcs.u64(),
});
export const MemberUnstakedAndLeftBcs = bcs.struct('MemberUnstakedAndLeftEvent', {
  channel_id: bcs.Address, member: bcs.Address, refunded_principal: bcs.u64(), refunded_yield: bcs.u64(), remaining_members: bcs.u64(),
});
export const ZeroStakeMemberRemovedBcs = bcs.struct('ZeroStakeMemberRemovedEvent', {
  channel_id: bcs.Address, creator: bcs.Address, member: bcs.Address, remaining_members: bcs.u64(),
});

/** 收益累加器动态字段键（空 struct；挂在频道对象自身的动态字段上）。
 * 空 struct 的 BCS 是**一个 false 字节**（Move 会编译出 dummy_field: bool），
 * 不是零字节——`bcs.struct(name, {})` 会编码成 `[]`，用它查动态字段永远查不到。 */
export const YieldAccumulatorKeyBcs = bcs.struct('YieldAccumulatorKey', { dummy_field: bcs.bool() });
/** 单会员收益债务快照动态字段键。 */
export const MemberYieldKeyBcs = bcs.struct('MemberYieldKey', { member: bcs.Address });
