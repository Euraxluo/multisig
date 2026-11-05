/**
 * governance_poll 的 BCS schema：Poll 共享对象与两个事件的字节布局。
 * Option<ID> 在 BCS 中是 vector<Address>（0 或 1 个元素）。
 */
import { bcs } from '@mysten/sui/bcs';

export const PollBcs = bcs.struct('Poll', {
  id: bcs.Address,
  creator: bcs.Address,
  title: bcs.string(),
  description: bcs.string(),
  options: bcs.vector(bcs.string()),
  mode: bcs.u8(),
  electorate: bcs.vector(bcs.Address),
  weights: bcs.vector(bcs.u64()),
  ballots: bcs.vector(bcs.vector(bcs.u64())),
  cast_at_ms: bcs.vector(bcs.u64()),
  deadline_ms: bcs.u64(),
  org_id: bcs.vector(bcs.Address),
  org_epoch: bcs.u64(),
  group_voter_count: bcs.u64(),
  show_results_during: bcs.bool(),
  allow_link_access: bcs.bool(),
});

export const PollPublishedBcs = bcs.struct('PollPublished', {
  poll_id: bcs.Address,
  title: bcs.string(),
  description: bcs.string(),
  options: bcs.vector(bcs.string()),
  mode: bcs.u8(),
  electorate: bcs.vector(bcs.Address),
  weights: bcs.vector(bcs.u64()),
  deadline_ms: bcs.u64(),
  org_id: bcs.vector(bcs.Address),
  org_epoch: bcs.u64(),
  group_voter_count: bcs.u64(),
  show_results_during: bcs.bool(),
  allow_link_access: bcs.bool(),
});

export const BallotCastBcs = bcs.struct('BallotCast', {
  poll_id: bcs.Address,
  choices: bcs.vector(bcs.u64()),
  weight: bcs.u64(),
  cast_at_ms: bcs.u64(),
});
