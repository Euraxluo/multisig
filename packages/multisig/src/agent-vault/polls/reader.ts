/**
 * governance_poll 读取层：Poll 共享对象解析与本地计分。
 *
 * scores() 是链上权威读；本地 computePollScores 以同一算法重算，用于
 * UI 预览与回放校验 —— 两处算法来自同一份合约定义，避免漂移。
 */
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import { normalizeStructTag } from '@mysten/sui/utils';
import { canonicalAddress } from '../org/bcs';
import { POLL_MODULE, type PollMode } from './constants';
import { PollBcs } from './schemas';

export type PollsReadClient = Pick<SuiGrpcClient, 'getObject'>;
export interface PollsReadOptions { signal?: AbortSignal }

export interface PollSnapshot {
  id: string;
  creator: string;
  title: string;
  description: string;
  options: string[];
  mode: PollMode;
  electorate: string[];
  weights: bigint[];
  ballots: bigint[][];
  castAtMs: bigint[];
  deadlineMs: bigint;
  /** null = 手动投票；否则为快照时的组织 ID。 */
  orgId: string | null;
  orgEpoch: bigint;
  groupVoterCount: bigint;
  showResultsDuring: boolean;
  allowLinkAccess: boolean;
}

export function pollType(packageId: string): string {
  return normalizeStructTag(`${canonicalAddress(packageId)}::${POLL_MODULE}::Poll`);
}

export async function readPoll(client: PollsReadClient, config: { packageId: string; pollId: string }, options: PollsReadOptions = {}): Promise<PollSnapshot> {
  const { object } = await client.getObject({ objectId: config.pollId, include: { content: true }, signal: options.signal });
  if (normalizeStructTag(object.type) !== pollType(config.packageId)) throw new Error('对象不是当前包的 governance_poll::Poll。');
  const fields = PollBcs.parse(object.content);
  // BCS 层 u64 解析为 string；统一无损转 bigint。
  const u64 = (value: string) => BigInt(value);
  return {
    id: fields.id,
    creator: fields.creator,
    title: fields.title,
    description: fields.description,
    options: fields.options,
    mode: fields.mode as PollMode,
    electorate: fields.electorate,
    weights: fields.weights.map(u64),
    ballots: fields.ballots.map((ballot) => ballot.map(u64)),
    castAtMs: fields.cast_at_ms.map(u64),
    deadlineMs: u64(fields.deadline_ms),
    orgId: fields.org_id[0] ?? null,
    orgEpoch: u64(fields.org_epoch),
    groupVoterCount: u64(fields.group_voter_count),
    showResultsDuring: fields.show_results_during,
    allowLinkAccess: fields.allow_link_access,
  };
}

/** 选民是否已投（每选民恰好一票，空 ballot 即未投）。 */
export function hasVoted(poll: PollSnapshot, voter: string): boolean {
  const index = poll.electorate.indexOf(voter);
  return index >= 0 && poll.ballots[index].length > 0;
}

/**
 * 镜像链上 scores()：排名模式第 r 位得 (n-1-r) 分，其余模式每选中项 1 分，
 * 乘以选民权重。平局保持平局；这些分数不授权任何金库动作。
 */
export function computePollScores(poll: Pick<PollSnapshot, 'ballots' | 'weights' | 'mode' | 'options'>): bigint[] {
  const scores = poll.options.map(() => 0n);
  for (let voterIndex = 0; voterIndex < poll.ballots.length; voterIndex++) {
    const ballot = poll.ballots[voterIndex];
    for (let rank = 0; rank < ballot.length; rank++) {
      const points = poll.mode === 2 ? BigInt(poll.options.length - 1 - rank) : 1n;
      const optionIndex = Number(ballot[rank]);
      scores[optionIndex] += poll.weights[voterIndex] * points;
    }
  }
  return scores;
}
