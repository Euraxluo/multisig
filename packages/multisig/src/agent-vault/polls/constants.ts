/**
 * governance_poll 模块常量：与 agent_vault::governance_poll 一一对应。
 * 错误码注册表并入 org/constants 的 explainAbort 单一事实源。
 */
import { AGENT_VAULT_PACKAGE_ID, MODULES } from '../org/constants';

export const POLL_PACKAGE_DEFAULT = AGENT_VAULT_PACKAGE_ID;
export const POLL_MODULE = MODULES.poll;

/** 与合约常量一致：越界输入必须在客户端先行失败，不烧 gas。 */
export const POLL_LIMITS = {
  maxVoters: 128,
  maxOptions: 16,
  maxWeight: 1_000_000_000n,
  maxDurationMs: 31_536_000_000n, // 365 天
  titleMaxBytes: 256,
  descriptionMaxBytes: 4096,
  optionMaxBytes: 256,
} as const;

/** 0=单选，1=多选赞成，2=完整 Borda 排名。 */
export type PollMode = 0 | 1 | 2;

export function pollModeName(mode: PollMode): string {
  return mode === 0 ? 'single' : mode === 1 ? 'multiple' : 'ranked';
}

// GOVERNANCE_POLL_ERRORS 注册表住在 org/constants（与全部模块错误码同一事实源），此处 re-export。
export { GOVERNANCE_POLL_ERRORS } from '../org/constants';

export const POLL_EVENTS = {
  pollPublished: 'governance_poll::PollPublished',
  ballotCast: 'governance_poll::BallotCast',
} as const;
