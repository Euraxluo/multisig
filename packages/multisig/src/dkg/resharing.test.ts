import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ed25519 } from '@noble/curves/ed25519.js';
import { randomScalar, lagrangeCoefficient } from './math';
import { generatePolynomial, evaluatePolynomial, createCommitments } from './vss';
import type { Point } from './vss';
import {
  GennaroResharingParticipant,
  type DealerHonestyProof,
  type DealerHonestyContext,
} from './resharing';

/**
 * Dealer 诚实性证明 (#13) 单元测试:
 * 1. Happy path: 所有 Dealer 携带正确 context 出证明，finalizeNewShare 全量校验通过且群公钥恒定；
 * 2. 负例: 证明在错误的 sessionId context 下计算，验证侧必须硬错误拒绝 (无静默回退)；
 * 3. 负例: 证明缺失 (proofs 为空) 时 finalizeNewShare 同样抛错 —— context 现在是强制项。
 */

const t = 2;
const n = 3;
const CONTEXT: DealerHonestyContext = {
  orgId: '0x' + 'ab'.repeat(32),
  epoch: 7,
  sessionId: '0x' + 'cd'.repeat(32),
};

interface Member {
  id: string;
  index: bigint;
  share: bigint;
}

/** t-of-n Shamir split standing in for the prior DKG output. */
function split(threshold: number, count: number) {
  const poly = generatePolynomial(threshold - 1);
  const groupPk = ed25519.Point.BASE.multiply(poly[0]).toBytes();
  const indices = Array.from({ length: count }, (_, i) => BigInt(i + 1));
  return { poly, groupPk, indices, shares: indices.map((x) => evaluatePolynomial(poly, x)) };
}

function runReshare(
  oldCommittee: Member[],
  newThreshold: number,
  dealerContext: DealerHonestyContext,
  verifierContext: DealerHonestyContext
) {
  const oldIndices = oldCommittee.map((m) => m.index);
  const committee = new Map<string, bigint>(
    oldCommittee.map((m) => [m.id, m.index] as [string, bigint])
  );

  const pkgs = oldCommittee.map((member) =>
    new GennaroResharingParticipant({
      id: member.id,
      index: member.index,
      isOldActiveMember: true,
      isNewMember: true,
      currentShare: member.share,
      newThreshold,
    }).generateResharePackage(oldIndices, committee, dealerContext)
  );

  const commitments = new Map<string, Point[]>(pkgs.map((p) => [p.senderId, p.commitments] as [string, Point[]]));
  const proofs = new Map<string, DealerHonestyProof>(
    pkgs.map((p) => [p.senderId, p.honestyProof!] as [string, DealerHonestyProof])
  );

  return oldCommittee.map((member) =>
    new GennaroResharingParticipant({
      id: member.id,
      index: member.index,
      isOldActiveMember: true,
      isNewMember: true,
      newThreshold,
    }).finalizeNewShare(
      new Map<string, bigint>(pkgs.map((p) => [p.senderId, p.subShares.get(member.id)!] as [string, bigint])),
      commitments,
      groupPkOf(pkgs),
      [],
      { dealerHonestyProofs: proofs, oldActiveIndices: oldIndices, context: verifierContext }
    )
  );
}

/** ∑ C_{i,0}：诚实 resharing 下重构的群公钥（round-9 必传的 originalGroupPublicKey）。 */
function groupPkOf(pkgs: { commitments: Point[] }[]): Uint8Array {
  let sum = ed25519.Point.ZERO;
  for (const pkg of pkgs) sum = sum.add(pkg.commitments[0]);
  return sum.toBytes();
}

test('1. happy path: resharing with correct context verifies and preserves the group key', () => {
  const { poly, groupPk, indices, shares } = split(t, n);
  assert.ok(poly.length === t);
  const oldCommittee: Member[] = indices.map((index, i) => ({
    id: `m${i + 1}`,
    index,
    share: shares[i],
  }));

  const results = runReshare(oldCommittee, t, CONTEXT, CONTEXT);
  assert.equal(results.length, n);
  for (const result of results) {
    assert.deepEqual(result.groupPublicKey, groupPk, `${result.participantId} recomputed a different group key`);
  }
  // New shares are actually refreshed (not identical to the old ones).
  for (let i = 0; i < n; i++) {
    assert.notEqual(results[i].newPrivateShare, shares[i]);
  }
});

test('2. negative: proof computed under a different sessionId is hard-rejected', () => {
  const { indices, shares } = split(t, n);
  const oldCommittee: Member[] = indices.map((index, i) => ({
    id: `m${i + 1}`,
    index,
    share: shares[i],
  }));

  const wrongContext: DealerHonestyContext = { ...CONTEXT, sessionId: '0x' + 'ee'.repeat(32) };
  assert.throws(
    () => runReshare(oldCommittee, t, wrongContext, CONTEXT),
    /dealer honesty proof verification failed/
  );
});

test('3. negative: verifier with wrong context rejects honestly-computed proofs', () => {
  const { indices, shares } = split(t, n);
  const oldCommittee: Member[] = indices.map((index, i) => ({
    id: `m${i + 1}`,
    index,
    share: shares[i],
  }));

  const wrongContext: DealerHonestyContext = { ...CONTEXT, sessionId: '0x' + 'ff'.repeat(32) };
  assert.throws(
    () => runReshare(oldCommittee, t, CONTEXT, wrongContext),
    /dealer honesty proof verification failed/
  );
});

test('4. randomScalar sanity keeps the split non-degenerate', () => {
  // Guards the test helper: a zero constant term would make the group key the
  // identity and trivially "preserve" it.
  const { groupPk } = split(t, n);
  assert.ok(!ed25519.Point.fromBytes(groupPk).equals(ed25519.Point.ZERO));
  assert.ok(randomScalar() > 0n);
});

/**
 * round-9 回归（RT9-T1c4 join 缺口）：
 * 诚实身份的 dealer（Schnorr 证明自洽、expectedY 匹配）投递毒化多项式
 * （常数 z* ≠ λ·s_i，与自己的承诺 commitments[0] 一致）→ finalizeNewShare 必须抛错。
 * 旧代码只验证明不比对 proof.C 与 commitments[0]，静默产出被毒化的群公钥。
 */
test('5. join gap: honest proof + poisoned polynomial is now hard-rejected', () => {
  const { indices, shares, groupPk } = split(t, n);
  // 活跃 dealer 集 = [1,2]（踢 3 的换届场景）；λ 按 dealer 集取，∑λ·s = f(0)。
  const oldIndices = [1n, 2n];
  const dealerShares = new Map<bigint, bigint>(indices.map((x, i) => [x, shares[i]]));
  const committee = new Map<string, bigint>([
    ['m1', 1n], ['m2', 2n], ['m4', 4n],
  ]);

  // 诚实 dealer m1：正常出包。
  const honestPkg = new GennaroResharingParticipant({
    id: 'm1', index: 1n, isOldActiveMember: true, isNewMember: true,
    currentShare: dealerShares.get(1n)!, newThreshold: 2,
  }).generateResharePackage(oldIndices, committee, CONTEXT);

  // 恶意 dealer m2：身份诚实（证明用真实分片构造，Y_2 与 λ_2·s_2 自洽），
  // 但投递的 resharing 多项式常数是随机 z* ≠ λ_2·s_2。假多项式的承诺向量与
  // 子份额完全自洽（VSS 通过），证明也与"真实"多项式自洽——旧代码在此静默放行。
  const lambda2 = lagrangeCoefficient(2n, oldIndices, 0n);
  const honestDealer = new GennaroResharingParticipant({
    id: 'm2', index: 2n, isOldActiveMember: true, isNewMember: true,
    currentShare: dealerShares.get(2n)!, newThreshold: 2,
  });
  const honestProof = honestDealer.generateResharePackage(oldIndices, committee, CONTEXT).honestyProof!;
  const zStar = randomScalar();
  const poisonPoly = [zStar, randomScalar()];
  const poisonCommitments = createCommitments(poisonPoly);
  const poisonSubShares = new Map<string, bigint>(
    [...committee.keys()].map((id) => [id, evaluatePolynomial(poisonPoly, committee.get(id)!)])
  );

  const incoming = new Map<string, bigint>([
    ['m1', honestPkg.subShares.get('m4')!],
    ['m2', poisonSubShares.get('m4')!],
  ]);
  const commitments = new Map<string, Point[]>([
    ['m1', honestPkg.commitments],
    ['m2', poisonCommitments],
  ]);
  const proofs = new Map<string, DealerHonestyProof>([
    ['m1', honestPkg.honestyProof!],
    ['m2', honestProof],
  ]);
  const realY2 = ed25519.Point.BASE.multiply(dealerShares.get(2n)!).toBytes();

  // (a) 毒化多项式 + 诚实证明（连 expectedY 都传）→ constant commitment mismatch。
  assert.throws(
    () => new GennaroResharingParticipant({
      id: 'm4', index: 4n, isOldActiveMember: false, isNewMember: true, newThreshold: 2,
    }).finalizeNewShare(incoming, commitments, groupPk, [], {
      dealerHonestyProofs: proofs,
      oldActiveIndices: oldIndices,
      context: CONTEXT,
      expectedVerificationShares: new Map([['m2', realY2]]),
    }),
    /constant commitment mismatch/
  );

  // (b) 无 originalGroupPublicKey → 入口硬校验拒绝（去可选化回归）。
  assert.throws(
    () => new GennaroResharingParticipant({
      id: 'm4', index: 4n, isOldActiveMember: false, isNewMember: true, newThreshold: 2,
    }).finalizeNewShare(incoming, commitments, undefined as unknown as Uint8Array, [], {
      dealerHonestyProofs: proofs, oldActiveIndices: oldIndices, context: CONTEXT,
    }),
    /originalGroupPublicKey is required/
  );

  // (c) 全诚实 dealer → 通过，且重构群公钥逐字节等于真群公钥。
  const honestPkg2 = honestDealer.generateResharePackage(oldIndices, committee, CONTEXT);
  const okResult = new GennaroResharingParticipant({
    id: 'm4', index: 4n, isOldActiveMember: false, isNewMember: true, newThreshold: 2,
  }).finalizeNewShare(
    new Map<string, bigint>([
      ['m1', honestPkg.subShares.get('m4')!],
      ['m2', honestPkg2.subShares.get('m4')!],
    ]),
    new Map<string, Point[]>([
      ['m1', honestPkg.commitments],
      ['m2', honestPkg2.commitments],
    ]),
    groupPk,
    [],
    { dealerHonestyProofs: new Map([['m1', honestPkg.honestyProof!], ['m2', honestPkg2.honestyProof!]]), oldActiveIndices: oldIndices, context: CONTEXT }
  );
  assert.deepEqual(okResult.groupPublicKey, groupPk);
});

/** round-9 回归：proof.C 与 commitments[0] 一致但 context 错误 → 仍由 PoK 校验拒绝。 */
test('6. dealer honesty failures still surface as DealerHonestyError', () => {
  const { indices, shares, groupPk } = split(t, n);
  const oldIndices = indices;
  const committee = new Map<string, bigint>(indices.map((x) => [`m${x}`, x] as [string, bigint]));
  const wrongContext: DealerHonestyContext = { ...CONTEXT, sessionId: '0x' + '11'.repeat(32) };
  const pkgs = indices.map((x, i) =>
    new GennaroResharingParticipant({
      id: `m${x}`, index: x, isOldActiveMember: true, isNewMember: true,
      currentShare: shares[i], newThreshold: 2,
    }).generateResharePackage(oldIndices, committee, wrongContext)
  );
  assert.throws(
    () => new GennaroResharingParticipant({
      id: 'm1', index: 1n, isOldActiveMember: true, isNewMember: true, newThreshold: 2,
    }).finalizeNewShare(
      new Map(pkgs.map((p) => [p.senderId, p.subShares.get('m1')!] as [string, bigint])),
      new Map(pkgs.map((p) => [p.senderId, p.commitments] as [string, Point[]])),
      groupPk, [],
      { dealerHonestyProofs: new Map(pkgs.map((p) => [p.senderId, p.honestyProof!] as [string, DealerHonestyProof])), oldActiveIndices: oldIndices, context: CONTEXT }
    ),
    (error: unknown) => error instanceof Error && error.name === 'DealerHonestyError'
  );
});
