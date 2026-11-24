import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AsyncDkgCoordinator } from './async_coordinator';
import type { Point } from './vss';

/**
 * AsyncDkgCoordinator 截止时间语义 (#I8) 单元测试:
 * 截止时间此前只被存储、从不检查（'TIMED_OUT' 不可达）。现在写入路径
 * （submitRound1 / processRound2Shares / finalizeSession）先按当前时钟
 * 强制过期再放行，超时会话一律硬错误拒绝；FINALIZED 永不被翻成 TIMED_OUT。
 * deadline 一律锚定 Date.now() 的固定偏移（无 sleep、不依赖真实时间推进）。
 *
 * 32 字节演示地址（V2 信箱 AAD 校验地址必须为 32 字节）。
 */

const demoAddr = (name: string) => '0x' + name.padStart(64, '0');

function makeCoordinator() {
  const coordinator = new AsyncDkgCoordinator();
  coordinator.registerParticipant('Alice', 1, demoAddr('a11ce'), true);
  coordinator.registerParticipant('Bob', 2, demoAddr('b0b'), true);
  coordinator.registerParticipant('Charlie', 3, demoAddr('c0c'), true);
  return coordinator;
}

function initSession(
  coordinator: AsyncDkgCoordinator,
  deadlineTimestampMs: number,
  participantIds: string[] = ['Alice', 'Bob', 'Charlie']
) {
  return coordinator.initSession({
    sessionId: 'session_deadline_test',
    threshold: 2,
    participantIds,
    deadlineTimestampMs,
  });
}

/** 在线两方完成 Round 1/2 交换，返回可直接交给 finalizeSession 的份额表。 */
async function exchangeShares(coordinator: AsyncDkgCoordinator, ids: string[]) {
  for (const id of ids) coordinator.submitRound1(id);
  coordinator.distributeRound1Commitments();
  const rounds = new Map<string, Awaited<ReturnType<AsyncDkgCoordinator['processRound2Shares']>>>();
  for (const id of ids) rounds.set(id, await coordinator.processRound2Shares(id));
  const onlineShares = new Map<string, Map<string, bigint>>();
  for (const recipient of ids) {
    const received = new Map<string, bigint>();
    for (const sender of ids) {
      received.set(sender, rounds.get(sender)!.directShares.get(recipient)!);
    }
    onlineShares.set(recipient, received);
  }
  return onlineShares;
}

test('deadline: session completing before the deadline still finalizes normally', async () => {
  const t0 = Date.now();
  const coordinator = makeCoordinator();
  const session = initSession(coordinator, t0 + 60_000);

  assert.equal(coordinator.checkDeadline(t0), false);
  assert.equal(coordinator.expireIfNeeded(t0), false);
  assert.equal(session.status, 'ROUND_1_COMMITMENTS');

  const onlineShares = await exchangeShares(coordinator, ['Alice', 'Bob']);
  assert.equal(session.status, 'ROUND_2_MAILBOX');

  coordinator.confirmParticipant('Alice');
  const { canFinalize } = coordinator.confirmParticipant('Bob');
  assert.equal(canFinalize, true);

  const finalized = coordinator.finalizeSession(onlineShares);
  assert.equal(finalized.epoch, 1);
  assert.equal(finalized.finalizedResults.size, 2);
  assert.equal(session.status, 'FINALIZED');
});

test('deadline: passing the deadline without FINALIZED flips status to TIMED_OUT', () => {
  const t0 = 1_000_000;
  const coordinator = makeCoordinator();
  const session = initSession(coordinator, t0 + 60_000);

  // 截止前：纯查询与强制过期都不改变状态。
  assert.equal(coordinator.checkDeadline(t0 + 59_999), false);
  assert.equal(coordinator.expireIfNeeded(t0 + 59_999), false);
  assert.equal(session.status, 'ROUND_1_COMMITMENTS');

  // 到达截止时间（>= deadline）即超时；重复调用幂等。
  assert.equal(coordinator.checkDeadline(t0 + 60_000), true);
  assert.equal(coordinator.expireIfNeeded(t0 + 60_000), true);
  assert.equal(coordinator.expireIfNeeded(t0 + 61_000), true);
  assert.equal(session.status, 'TIMED_OUT');
});

test('deadline: TIMED_OUT sessions reject any further round 1 commitment submissions', () => {
  const deadline = Date.now() + 60_000;
  const coordinator = makeCoordinator();
  const session = initSession(coordinator, deadline);
  coordinator.submitRound1('Alice'); // 截止前正常提交

  coordinator.expireIfNeeded(deadline);
  assert.equal(session.status, 'TIMED_OUT');

  assert.throws(() => coordinator.submitRound1('Bob'), /timed out/);
});

test('deadline: TIMED_OUT sessions reject mailbox share submissions', async () => {
  const deadline = Date.now() + 60_000;
  const coordinator = makeCoordinator();
  const session = initSession(coordinator, deadline);
  coordinator.submitRound1('Alice');
  coordinator.submitRound1('Bob');
  coordinator.distributeRound1Commitments();

  coordinator.expireIfNeeded(deadline);
  assert.equal(session.status, 'TIMED_OUT');

  await assert.rejects(() => coordinator.processRound2Shares('Alice'), /timed out/);
});

test('deadline: finalizeSession is rejected after the deadline even with quorum reached', () => {
  const coordinator = makeCoordinator();
  const session = initSession(coordinator, Date.now() + 60_000);

  // 截止前先达成门限确认，随后会话过期——固化必须先于 quorum 检查被拒绝。
  coordinator.confirmParticipant('Alice');
  coordinator.confirmParticipant('Bob');
  coordinator.expireIfNeeded(Date.now() + 60_000);
  assert.equal(session.status, 'TIMED_OUT');

  assert.throws(
    () => coordinator.finalizeSession(new Map()),
    /timed out/,
    'finalize after deadline must be rejected ahead of the quorum check'
  );
});

test('deadline: TIMED_OUT sessions reject further confirmations and commitment distribution', () => {
  const deadline = Date.now() + 60_000;
  const coordinator = makeCoordinator();
  const session = initSession(coordinator, deadline);
  coordinator.submitRound1('Alice');

  coordinator.expireIfNeeded(deadline);
  assert.equal(session.status, 'TIMED_OUT');

  // 超时后继续确认只会得到误导性的 canFinalize=true；分发与确认一律拒绝。
  assert.throws(() => coordinator.distributeRound1Commitments(), /timed out/);
  assert.throws(() => coordinator.confirmParticipant('Alice'), /timed out/);
  assert.equal(session.confirmations.size, 0);
});

test('deadline: offline wakeup before finalization fails explicitly instead of returning an undefined group key', async () => {
  const coordinator = makeCoordinator();
  coordinator.registerParticipant('David', 4, demoAddr('da71d'), false); // 离线
  const session = initSession(coordinator, Date.now() + 60_000, ['Alice', 'Bob', 'Charlie', 'David']);

  const onlineShares = await exchangeShares(coordinator, ['Alice', 'Bob']);
  const allCommitmentsMap = new Map<string, Point[]>();
  for (const [id, output] of session.commitments) {
    allCommitmentsMap.set(id, output.commitments);
  }

  // 未固化：离线唤醒显式报错，而不是返回 groupPublicKey 为 undefined 的假结果。
  await assert.rejects(
    () => coordinator.offlineParticipantWakeupAndSync('David', allCommitmentsMap),
    /finalizeSession/
  );

  coordinator.confirmParticipant('Alice');
  coordinator.confirmParticipant('Bob');
  const finalized = coordinator.finalizeSession(onlineShares);
  assert.equal(session.status, 'FINALIZED');

  // 固化后：唤醒成功，且拿到的群公钥与固化结果一致。
  const david = await coordinator.offlineParticipantWakeupAndSync('David', allCommitmentsMap);
  assert.deepEqual(david.groupPublicKey, finalized.groupPublicKey);
  assert.equal(david.groupPublicKeyHex, finalized.groupPublicKeyHex);
});

test('deadline: write paths self-expire stale sessions without an explicit expireIfNeeded call', () => {
  const coordinator = makeCoordinator();
  // 截止时间已在真实时钟之前：从不手动调用 expireIfNeeded，写入闸门自行
  // 置 TIMED_OUT 并拒绝提交。
  const session = initSession(coordinator, Date.now() - 1);

  assert.throws(() => coordinator.submitRound1('Alice'), /timed out/);
  assert.equal(session.status, 'TIMED_OUT');
});

test('deadline: FINALIZED sessions never expire', async () => {
  const deadline = Date.now() + 60_000;
  const coordinator = makeCoordinator();
  const session = initSession(coordinator, deadline);

  const onlineShares = await exchangeShares(coordinator, ['Alice', 'Bob']);
  coordinator.confirmParticipant('Alice');
  coordinator.confirmParticipant('Bob');
  coordinator.finalizeSession(onlineShares);
  assert.equal(session.status, 'FINALIZED');

  // 已 FINALIZED：远超截止时间也不会被翻成 TIMED_OUT。
  assert.equal(coordinator.expireIfNeeded(deadline + 10 * 60_000), false);
  assert.equal(coordinator.checkDeadline(deadline + 10 * 60_000), true);
  assert.equal(session.status, 'FINALIZED');
});

test('deadline: a new initSession is the only way out of TIMED_OUT (fresh state, new deadline)', () => {
  const deadline = Date.now() + 60_000;
  const coordinator = makeCoordinator();
  const session = initSession(coordinator, deadline);
  coordinator.expireIfNeeded(deadline);
  assert.equal(session.status, 'TIMED_OUT');

  // 重新 initSession 拿到全新会话：状态与截止时间重置，写入恢复可用。
  const revived = initSession(coordinator, Date.now() + 120_000);
  assert.equal(revived.status, 'ROUND_1_COMMITMENTS');
  assert.equal(coordinator.getSession()!.status, 'ROUND_1_COMMITMENTS');
  const r1 = coordinator.submitRound1('Alice');
  assert.equal(r1.senderId, 'Alice');
});
