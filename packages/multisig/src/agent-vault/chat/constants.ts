/**
 * onchain_chat 常量：链上聊天频道 + 会员经济学 + Subagent 免密发信。
 */
import { MODULES } from '../org/constants';

export const CHAT_MODULE = MODULES.chat;

/** 与合约常量一致；批量与单条共用 preview/blob 界。 */
export const CHAT_LIMITS = {
  /** 每条消息的 Gas 报销（1,000,000 MIST = 0.001 SUI）。 */
  gasRebatePerMessage: 1_000_000n,
  maxBatchMessages: 32,
  maxPreviewBytes: 4096,
  maxBlobIdBytes: 128,
  /** 收益累加器定点比例（ accrued MIST / MIST stake × scale ）。 */
  yieldAccScale: 1_000_000_000_000n,
} as const;

export const CHAT_EVENTS = {
  channelCreatedWithStake: 'onchain_chat::ChannelCreatedWithStakeEvent',
  stakingYieldDeposited: 'onchain_chat::StakingYieldDepositedEvent',
  stakingYieldDistributed: 'onchain_chat::StakingYieldDistributedEvent',
  gasSubsidized: 'onchain_chat::GasSubsidizedEvent',
  subagentCapIssued: 'onchain_chat::SubagentMessagingCapIssuedEvent',
  subagentCapRevoked: 'onchain_chat::SubagentMessagingCapRevokedEvent',
  chatMessage: 'onchain_chat::ChatMessageEvent',
  channelClosedAndRefunded: 'onchain_chat::ChannelClosedAndRefundedEvent',
  memberJoinedWithStake: 'onchain_chat::MemberJoinedWithStakeEvent',
  creatorRevenueClaimed: 'onchain_chat::CreatorRevenueClaimedEvent',
  memberUnstakedAndLeft: 'onchain_chat::MemberUnstakedAndLeftEvent',
  zeroStakeMemberRemoved: 'onchain_chat::ZeroStakeMemberRemovedEvent',
} as const;

// CHAT_ERRORS 注册表住在 org/constants（全模块错误码同一事实源），此处 re-export。
export { CHAT_ERRORS } from '../org/constants';
