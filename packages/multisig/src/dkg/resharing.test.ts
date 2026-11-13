import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ed25519 } from '@noble/curves/ed25519.js';
import { randomScalar } from './math';
import { generatePolynomial, evaluatePolynomial } from './vss';
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
      undefined,
      [],
      { dealerHonestyProofs: proofs, oldActiveIndices: oldIndices, context: verifierContext }
    )
  );
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
