/**
 * governance_poll 的 PTB 构造器：创建（manual / group）与投票。
 *
 * 所有客户端校验镜像合约常量（governance_poll::new_poll / cast_ballot 的
 * assert 顺序），无效输入在构造时就失败。创建类 builder 把 new_* 的返回值
 * 交给同 PTB 的 share —— Poll 按值返回，不消费会卡住整笔交易。
 */
import { Transaction } from '@mysten/sui/transactions';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { SUI_CLOCK_OBJECT_ID } from '../org/constants';
import { POLL_LIMITS, POLL_MODULE, type PollMode } from './constants';

const bytes = (value: string) => new TextEncoder().encode(value).length;

function address(value: string): string {
  return normalizeSuiAddress(value);
}

function target(packageId: string, fn: string): string {
  return `${address(packageId)}::${POLL_MODULE}::${fn}`;
}

export interface PollTextInput {
  title: string;
  description: string;
  options: string[];
  mode: PollMode;
  deadlineMs: bigint;
  showResultsDuring: boolean;
  allowLinkAccess: boolean;
  /** 提供时镜像合约的截止窗口校验：now < deadline ≤ now + 365 天。 */
  nowMs?: bigint;
}

function validatePollText(input: PollTextInput): void {
  if (input.mode !== 0 && input.mode !== 1 && input.mode !== 2) throw new Error('投票模式必须是 0（单选）、1（多选）或 2（完整排名）。');
  if (bytes(input.title) === 0 || bytes(input.title) > POLL_LIMITS.titleMaxBytes) throw new Error(`标题须为 1 到 ${POLL_LIMITS.titleMaxBytes} 字节。`);
  if (bytes(input.description) > POLL_LIMITS.descriptionMaxBytes) throw new Error(`描述最多 ${POLL_LIMITS.descriptionMaxBytes} 字节。`);
  if (input.options.length < 2 || input.options.length > POLL_LIMITS.maxOptions) throw new Error(`投票须有 2 到 ${POLL_LIMITS.maxOptions} 个选项。`);
  const seen = new Set<string>();
  for (const option of input.options) {
    const size = bytes(option);
    if (size === 0 || size > POLL_LIMITS.optionMaxBytes) throw new Error(`选项文本须为 1 到 ${POLL_LIMITS.optionMaxBytes} 字节。`);
    if (seen.has(option)) throw new Error('选项不能重复。');
    seen.add(option);
  }
  if (input.deadlineMs <= 0n) throw new Error('截止时间必须是正数毫秒。');
  if (input.nowMs !== undefined) {
    if (input.deadlineMs <= input.nowMs) throw new Error('截止时间必须晚于当前时间。');
    if (input.deadlineMs - input.nowMs > POLL_LIMITS.maxDurationMs) throw new Error('截止时间距现在不能超过 365 天。');
  }
}

function validateElectorate(electorate: string[], weights: bigint[]): void {
  if (electorate.length === 0 || electorate.length > POLL_LIMITS.maxVoters || electorate.length !== weights.length) {
    throw new Error(`选民须为 1 到 ${POLL_LIMITS.maxVoters} 个且与权重一一对应。`);
  }
  const seen = new Set<string>();
  for (const voter of electorate) {
    const normalized = address(voter);
    if (BigInt(normalized) === 0n || seen.has(normalized)) throw new Error('选民必须互不相同且非零地址。');
    seen.add(normalized);
  }
  for (const weight of weights) {
    if (weight <= 0n || weight > POLL_LIMITS.maxWeight) throw new Error(`每个权重须在 1 到 ${POLL_LIMITS.maxWeight} 之间。`);
  }
}

export interface CreateManualPollInput extends PollTextInput {
  electorate: string[];
  weights: bigint[];
}

/** 手动加权投票：创建者自定全名单；new_manual + share 同 PTB。 */
export function buildCreateManualPoll(config: { packageId: string }, input: CreateManualPollInput): Transaction {
  validatePollText(input);
  validateElectorate(input.electorate, input.weights);
  const tx = new Transaction();
  const [poll] = tx.moveCall({
    target: target(config.packageId, 'new_manual'),
    arguments: [
      tx.pure.string(input.title),
      tx.pure.string(input.description),
      tx.pure.vector('string', input.options),
      tx.pure.u8(input.mode),
      tx.pure.vector('address', input.electorate.map(address)),
      tx.pure.vector('u64', input.weights),
      tx.pure.u64(input.deadlineMs),
      tx.pure.bool(input.showResultsDuring),
      tx.pure.bool(input.allowLinkAccess),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  });
  tx.moveCall({ target: target(config.packageId, 'share'), arguments: [poll] });
  return tx;
}

export interface CreateGroupPollInput extends PollTextInput {
  groupVoters: string[];
  manualVoters: string[];
  manualWeights: bigint[];
}

/** 群快照投票：群成员权重由 Organization 权威给出，手动名单不能含群成员（合约侧校验）。 */
export function buildCreateGroupPoll(config: { packageId: string; orgId: string }, input: CreateGroupPollInput): Transaction {
  validatePollText(input);
  if (input.groupVoters.length === 0) throw new Error('群投票至少需要 1 个群成员。');
  if (input.groupVoters.length + input.manualVoters.length > POLL_LIMITS.maxVoters) throw new Error(`选民总数不能超过 ${POLL_LIMITS.maxVoters}。`);
  if (input.manualVoters.length !== input.manualWeights.length) throw new Error('手动选民与权重必须一一对应。');
  // 合约在链上校验手动选民不是群成员；客户端先查重两者交集，能省一次注定失败的交易。
  const group = new Set(input.groupVoters.map(address));
  for (const voter of input.manualVoters) {
    if (group.has(address(voter))) throw new Error('手动选民不能同时是群成员（权重以群快照为准）。');
  }
  validateElectorate([...input.groupVoters, ...input.manualVoters], [...new Array<bigint>(input.groupVoters.length).fill(1n), ...input.manualWeights]);
  const tx = new Transaction();
  const [poll] = tx.moveCall({
    target: target(config.packageId, 'new_group'),
    arguments: [
      tx.object(address(config.orgId)),
      tx.pure.string(input.title),
      tx.pure.string(input.description),
      tx.pure.vector('string', input.options),
      tx.pure.u8(input.mode),
      tx.pure.vector('address', input.groupVoters.map(address)),
      tx.pure.vector('address', input.manualVoters.map(address)),
      tx.pure.vector('u64', input.manualWeights),
      tx.pure.u64(input.deadlineMs),
      tx.pure.bool(input.showResultsDuring),
      tx.pure.bool(input.allowLinkAccess),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  });
  tx.moveCall({ target: target(config.packageId, 'share'), arguments: [poll] });
  return tx;
}

/** 票型形状校验：单选恰好 1 个；多选 1..n 互异；排名模式全索引各一次。顺序只在排名模式有意义。 */
export function validateBallotShape(choices: readonly bigint[], mode: PollMode, optionCount: number): void {
  if (!Number.isInteger(optionCount) || optionCount < 2) throw new Error('选项数量无效。');
  if (choices.length === 0 || choices.length > optionCount) throw new Error('选票必须包含 1 到选项总数的不同索引。');
  if (mode === 0 && choices.length !== 1) throw new Error('单选模式只能投一个选项。');
  if (mode === 2 && choices.length !== optionCount) throw new Error('完整排名模式必须对所有选项排序。');
  const seen = new Set<number>();
  for (const choice of choices) {
    const index = Number(choice);
    if (!Number.isInteger(index) || choice < 0n || index >= optionCount) throw new Error('选票包含无效的选项索引。');
    if (seen.has(index)) throw new Error('选票索引不能重复。');
    seen.add(index);
  }
}

export interface CastBallotInput {
  choices: bigint[];
  /** 投票人已知的投票模式与选项数；用于构造前的票型校验。 */
  mode: PollMode;
  optionCount: number;
}

/** 投出一票：截止前每人恰好一次，无替换与撤回。 */
export function buildCastBallot(config: { packageId: string; pollId: string }, input: CastBallotInput): Transaction {
  validateBallotShape(input.choices, input.mode, input.optionCount);
  const tx = new Transaction();
  tx.moveCall({
    target: target(config.packageId, 'cast_ballot'),
    arguments: [tx.object(address(config.pollId)), tx.pure.vector('u64', input.choices), tx.object(SUI_CLOCK_OBJECT_ID)],
  });
  return tx;
}
