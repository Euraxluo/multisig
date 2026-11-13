import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha512 } from '@noble/hashes/sha2.js';
import { generatePolynomial, evaluatePolynomial } from './vss';
import type { Point } from './vss';
import { mod, bytesToScalar, lagrangeCoefficient } from './math';
import {
  ThresholdSignerNode,
  computeBindingFactor,
  computeAggregateNonce,
  validateCommitments,
  verifyShare,
} from './threshold_signer';
import type { NonceCommitment, SignatureShare } from './threshold_signer';


/**
 * FROST1 门限签名单元测试:
 * 1. t-of-n 聚合签名通过 ed25519.verify
 * 2. 绑定因子 rho 与独立重算值严格一致 (排序后哈希)
 * 3. 承诺替换攻击 -> 聚合自校验抛错，而非悄悄产出垃圾签名
 * 4. validateCommitments 拒绝重复索引 / 小子群点
 * 5. 腐坏份额 (z+1) -> aggregateSignature 抛错
 * 6. verifyShare 逐份额公钥验证
 */

const t = 2;
const n = 3;

interface Participant {
  id: string;
  index: bigint;
  share: bigint;
  node: ThresholdSignerNode;
  pubKeyPoint: Point;
}

function buildCommittee(): { participants: Participant[]; groupPublicKey: Uint8Array } {
  const poly = generatePolynomial(t - 1);
  const groupSecret = poly[0];
  const groupPublicKey = ed25519.Point.BASE.multiply(groupSecret).toBytes();

  const participants: Participant[] = [];
  for (let i = 1; i <= n; i++) {
    const share = evaluatePolynomial(poly, BigInt(i));
    participants.push({
      id: `node-${i}`,
      index: BigInt(i),
      share,
      node: new ThresholdSignerNode(`node-${i}`, i, share),
      pubKeyPoint: ed25519.Point.BASE.multiply(share),
    });
  }
  return { participants, groupPublicKey };
}

function runSigningRound(
  participants: Participant[],
  message: Uint8Array,
  groupPublicKey: Uint8Array,
  shareTransformer?: (share: SignatureShare) => SignatureShare
): { commitments: NonceCommitment[]; shares: SignatureShare[] } {
  const commitments = participants.map((p) => p.node.generateNonceCommitment());
  const shares = participants.map((p) =>
    p.node.computeSignatureShare(message, groupPublicKey, commitments)
  );
  return { commitments, shares: shareTransformer ? shares.map(shareTransformer) : shares };
}

test('1. t-of-n FROST1 聚合签名通过 ed25519.verify', () => {
  const { participants, groupPublicKey } = buildCommittee();
  const message = new TextEncoder().encode('frost1-threshold-test-message');
  const signingSubset = participants.slice(0, t); // 2-of-3

  const { commitments, shares } = runSigningRound(signingSubset, message, groupPublicKey);

  const signature = ThresholdSignerNode.aggregateSignature(message, groupPublicKey, commitments, shares);

  assert.equal(signature.length, 64);
  assert.ok(
    ed25519.verify(signature, message, groupPublicKey),
    'aggregate signature must verify under native ed25519.verify'
  );
  assert.ok(ThresholdSignerNode.verifyThresholdSignature(signature, message, groupPublicKey));
});

test('2. 逐参与者绑定因子 ρ_i 与独立重算值严格一致 (含乱序输入)', () => {
  const { participants, groupPublicKey } = buildCommittee();
  const message = new TextEncoder().encode('rho-consistency-check');
  const signingSubset = participants.slice(0, t);

  const commitments = signingSubset.map((p) => p.node.generateNonceCommitment());
  // 故意乱序: ρ_i 必须与升序重算一致
  const shuffled = [commitments[1], commitments[0]];
  const sorted = [...shuffled].sort((a, b) => Number(a.participantIndex - b.participantIndex));

  const selfIndex = sorted[0].participantIndex;
  const rhoShuffled = computeBindingFactor(shuffled, message, groupPublicKey, selfIndex);

  // 独立重算 (RFC 9591 §4.4 布局):
  // SHA512(domain ‖ idx_1 ‖ D_1 ‖ E_1 ‖ idx_2 ‖ D_2 ‖ E_2 ‖ msg ‖ Y ‖ idx_self) mod L
  // 承诺条目按 index 升序，索引均为 8 字节小端
  const u64le = (v: bigint) => {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(v);
    return buf;
  };
  const parts: Buffer[] = [
    Buffer.from('SUI_FROST_BINDING_V1:'),
    ...sorted.flatMap((c) => [u64le(c.participantIndex), Buffer.from(c.hiding), Buffer.from(c.binding)]),
    Buffer.from(message),
    Buffer.from(groupPublicKey),
    u64le(selfIndex),
  ];
  const expected = bytesToScalar(sha512(Buffer.concat(parts)));

  assert.equal(rhoShuffled, expected, 'per-participant rho must match independent recomputation');

  // R̄ 一致性: 排序与否得到同一个聚合 nonce
  const r1 = computeAggregateNonce(shuffled, message, groupPublicKey).toBytes();
  const r2 = computeAggregateNonce(sorted, message, groupPublicKey).toBytes();
  assert.deepEqual(r1, r2);
});

test('2b. ρ 向量逐参与者互异 (自索引后缀进入哈希)', () => {
  const { participants, groupPublicKey } = buildCommittee();
  const message = new TextEncoder().encode('rho-vector-distinctness');
  const signingSubset = participants.slice(0, t);
  const commitments = signingSubset.map((p) => p.node.generateNonceCommitment());

  const rhoVector = commitments.map((c) =>
    computeBindingFactor(commitments, message, groupPublicKey, c.participantIndex)
  );
  // 同一承诺集合下，不同自索引必须得到不同绑定因子 (旧单 ρ 实现做不到这一点)
  assert.notEqual(rhoVector[0], rhoVector[1]);

  // 自索引不同 ⇒ ρ 不同，且与消息/群钥耦合
  const otherMessage = new TextEncoder().encode('rho-vector-distinctness-2');
  assert.notEqual(
    rhoVector[0],
    computeBindingFactor(commitments, otherMessage, groupPublicKey, commitments[0].participantIndex)
  );
});

test('3. 承诺替换攻击 -> 聚合自校验抛错', () => {
  const { participants, groupPublicKey } = buildCommittee();
  const message = new TextEncoder().encode('commitment-substitution-attack');

  // 受害者 node-1 拿到伪造的 node-2 承诺 (攻击者自己生成的合法点)
  const attackerNode = new ThresholdSignerNode('attacker', 2, 12345n);
  const forgedPeerCommitment = attackerNode.generateNonceCommitment();

  // 真正的 node-2 使用自己的真实承诺
  const { participants: _p } = buildCommittee();
  void _p;
  const victim = participants[0];
  const honest = participants[1];

  const victimCommitment = victim.node.generateNonceCommitment();
  const honestCommitment = honest.node.generateNonceCommitment();

  const victimView: NonceCommitment[] = [victimCommitment, forgedPeerCommitment];
  const honestView: NonceCommitment[] = [victimCommitment, honestCommitment];

  const victimShare = victim.node.computeSignatureShare(message, groupPublicKey, victimView);
  const honestShare = honest.node.computeSignatureShare(message, groupPublicKey, honestView);

  // 聚合器收到真实承诺 + 双方份额: rho/挑战不一致 -> 必须抛错
  assert.throws(
    () =>
      ThresholdSignerNode.aggregateSignature(
        message,
        groupPublicKey,
        honestView,
        [victimShare, honestShare]
      ),
    /self-verification|failed/i,
    'fabricated peer commitment must cause aggregate self-verification failure'
  );
});

test('4. validateCommitments 拒绝重复索引与小子群/恒等元点', () => {
  const { participants, groupPublicKey } = buildCommittee();
  const message = new TextEncoder().encode('validate-commitments');
  void groupPublicKey;
  void message;

  const [a] = participants.map((p) => p.node.generateNonceCommitment());

  // 重复 participantIndex
  assert.throws(
    () => validateCommitments([a, { ...a, participantId: 'dup' }]),
    /duplicate participantIndex/
  );

  // 小子群点 (order 8 torsion): 已知低阶点编码
  const smallOrderHex = '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05';
  const smallOrder = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    smallOrder[i] = parseInt(smallOrderHex.slice(i * 2, i * 2 + 2), 16);
  }
  assert.throws(
    () => validateCommitments([a, { ...a, participantIndex: 99n, hiding: smallOrder }]),
    /torsion-free|identity|bad point/i
  );

  // 恒等元
  assert.throws(
    () => validateCommitments([a, { ...a, participantIndex: 99n, binding: new Uint8Array(32) }]),
    /identity|torsion-free|bad point/i
  );

  // 非 32 字节
  assert.throws(
    () => validateCommitments([a, { ...a, participantIndex: 99n, hiding: new Uint8Array(31) }]),
    /32-byte/
  );
});

test('5. 腐坏份额 (z+1) -> aggregateSignature 抛错', () => {
  const { participants, groupPublicKey } = buildCommittee();
  const message = new TextEncoder().encode('corrupted-share');
  const signingSubset = participants.slice(0, t);

  const { commitments, shares } = runSigningRound(signingSubset, message, groupPublicKey);
  const corrupted = shares.map((s, i) => (i === 0 ? { ...s, shareZ: mod(s.shareZ + 1n) } : s));

  assert.throws(
    () => ThresholdSignerNode.aggregateSignature(message, groupPublicKey, commitments, corrupted),
    /self-verification|failed/i,
    'corrupted share must fail aggregate self-verification'
  );
});

test('6. verifyShare 逐份额验证 + nonce 单次使用', () => {
  const { participants, groupPublicKey } = buildCommittee();
  const message = new TextEncoder().encode('verify-share-check');
  const signingSubset = participants.slice(0, t);

  const sharePubKeys = new Map<string, Uint8Array>(
    signingSubset.map((p) => [p.id, p.pubKeyPoint.toBytes()] as const)
  );

  const { commitments, shares } = runSigningRound(signingSubset, message, groupPublicKey);

  for (const share of shares) {
    assert.ok(
      verifyShare(share, message, groupPublicKey, commitments, sharePubKeys),
      `share from ${share.participantId} must verify against its public share key`
    );
  }

  // 篡改份额后 verifyShare 必须失败
  const badShare = { ...shares[0], shareZ: mod(shares[0].shareZ + 7n) };
  assert.ok(!verifyShare(badShare, message, groupPublicKey, commitments, sharePubKeys));

  // nonce 已销毁: 再次直接计算份额必须抛错
  assert.throws(
    () => signingSubset[0].node.computeSignatureShare(message, groupPublicKey, commitments),
    /nonce|consumed/i
  );
});

test('7. 抵消攻击回归: E_2 = -E_1、D_2 = -D_1 的伪造承诺对无法把 R̄ 压成恒等元', () => {
  // 旧单 ρ 实现: R̄ = Σ(D_i + ρ·E_i)，合法成员 2 提交 D_2=-D_1、E_2=-E_1 时
  // 两项严格抵消，R̄ 恒等于恒等元且其有效 nonce 点也是 0 ⇒ 攻击者无需知道
  // 任何 dlog 就能算出 z_2 = c·λ_2·s_2，产出 R̄=0 的退化「有效」签名。
  // 逐参与者 ρ_i ≠ ρ_2 ⇒ 抵消对的有效 nonce 点 D_2 + ρ_2·E_2 = -(D_1 + ρ_2·E_1) ≠ 0，
  // 攻击者不知道该点的 dlog，无法产出可验证的份额。
  const { participants, groupPublicKey } = buildCommittee();
  const message = new TextEncoder().encode('cancellation-attack-regression');

  const honest = participants[0]; // index 1
  const attacker = participants[1]; // index 2，合法成员持有真实份额 s_2
  const honestCommitment = honest.node.generateNonceCommitment();

  const hidingPoint = ed25519.Point.fromBytes(honestCommitment.hiding);
  const bindingPoint = ed25519.Point.fromBytes(honestCommitment.binding);

  const crafted: NonceCommitment = {
    participantId: attacker.id,
    participantIndex: attacker.index,
    hiding: hidingPoint.negate().toBytes(),
    binding: bindingPoint.negate().toBytes(),
  };
  const commitments = [honestCommitment, crafted];

  // (a) 逐参与者 ρ 互异: ρ_1 ≠ ρ_2
  const rho1 = computeBindingFactor(commitments, message, groupPublicKey, 1n);
  const rho2 = computeBindingFactor(commitments, message, groupPublicKey, 2n);
  assert.notEqual(rho1, rho2);

  // (b) R̄ 不塌缩为恒等元 (旧单 ρ 代码在这里会得到 ZERO)
  const aggregateR = computeAggregateNonce(commitments, message, groupPublicKey);
  assert.ok(!aggregateR.equals(ed25519.Point.ZERO));

  // (c) 攻击者按旧方案的假设 (自身有效 nonce = 0) 产出 z_2 = c·λ_2·s_2
  const c = bytesToScalar(sha512(
    Buffer.concat([Buffer.from(aggregateR.toBytes()), Buffer.from(groupPublicKey), Buffer.from(message)])
  ));
  const lambda2 = lagrangeCoefficient(2n, [1n, 2n], 0n);
  const attackerAttempt = { participantId: attacker.id, participantIndex: 2n, shareZ: mod(c * lambda2 * attacker.share) };

  // 诚实参与者照常产出份额
  const honestShare = honest.node.computeSignatureShare(message, groupPublicKey, commitments);

  // (d) 聚合必须失败 (攻击者份额与真实 ρ_2 下的有效 nonce 不自洽)
  assert.throws(
    () => ThresholdSignerNode.aggregateSignature(message, groupPublicKey, commitments, [honestShare, attackerAttempt]),
    /self-verification|failed/i,
    'crafted cancellation pair must not yield a verifiable aggregate'
  );

  // (e) 份额级验证: 诚实份额通过，攻击者伪造份额被抓住
  const sharePubKeys = new Map<string, Uint8Array>([
    [honest.id, ed25519.Point.BASE.multiply(honest.share).toBytes()],
    [attacker.id, ed25519.Point.BASE.multiply(attacker.share).toBytes()],
  ]);
  assert.ok(verifyShare(honestShare, message, groupPublicKey, commitments, sharePubKeys));
  assert.ok(!verifyShare(attackerAttempt, message, groupPublicKey, commitments, sharePubKeys));
});
