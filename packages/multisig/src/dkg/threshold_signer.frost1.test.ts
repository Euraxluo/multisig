import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha512 } from '@noble/hashes/sha2.js';
import { generatePolynomial, evaluatePolynomial } from './vss';
import type { Point } from './vss';
import { mod, bytesToScalar } from './math';
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

test('2. 绑定因子 rho 与独立重算值严格一致 (含乱序输入)', () => {
  const { participants, groupPublicKey } = buildCommittee();
  const message = new TextEncoder().encode('rho-consistency-check');
  const signingSubset = participants.slice(0, t);

  const commitments = signingSubset.map((p) => p.node.generateNonceCommitment());
  // 故意乱序: rho 必须与升序重算一致
  const shuffled = [commitments[1], commitments[0]];

  const rhoShuffled = computeBindingFactor(message, groupPublicKey, shuffled);

  // 独立重算: SHA512(domain || H_1 || B_1 || H_2 || B_2 || msg || Y) mod L，承诺按 index 升序
  const sorted = [...shuffled].sort((a, b) => Number(a.participantIndex - b.participantIndex));
  const parts: Uint8Array[] = [
    new TextEncoder().encode('SUI_FROST_BINDING_V1:'),
    ...sorted.flatMap((c) => [c.hiding, c.binding]),
    message,
    groupPublicKey,
  ];
  const totalLen = parts.reduce((acc, p) => acc + p.length, 0);
  const input = new Uint8Array(totalLen);
  let offset = 0;
  for (const p of parts) {
    input.set(p, offset);
    offset += p.length;
  }
  const expected = bytesToScalar(sha512(input));

  assert.equal(rhoShuffled, expected, 'rho must match independent recomputation');

  // R̄ 一致性: 排序与否得到同一个聚合 nonce
  const r1 = computeAggregateNonce(rhoShuffled, shuffled).toBytes();
  const r2 = computeAggregateNonce(computeBindingFactor(message, groupPublicKey, sorted), sorted).toBytes();
  assert.deepEqual(r1, r2);
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
