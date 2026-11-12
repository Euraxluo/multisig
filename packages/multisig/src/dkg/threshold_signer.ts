import { ed25519 } from '@noble/curves/ed25519.js';
import { sha512 } from '@noble/hashes/sha2.js';
import { mod, randomScalar, bytesToScalar, scalarToBytes32, lagrangeCoefficient } from './math';
import type { Point } from './vss';

/**
 * FROST1 绑定因子域分隔前缀 (跨轮承诺绑定，防 Drijvers 攻击 / 承诺替换攻击)
 */
const BINDING_DOMAIN = 'SUI_FROST_BINDING_V1:';

export interface NonceCommitment {
  participantId: string;
  participantIndex: bigint;
  /** 隐藏承诺 H_i = hide_i * G (32 字节压缩点，秘密标量 hide_i 仅保存在节点内部) */
  hiding: Uint8Array;
  /** 绑定承诺 B_i = bind_i * G (32 字节压缩点，秘密标量 bind_i 仅保存在节点内部) */
  binding: Uint8Array;
}

export interface SignatureShare {
  participantId: string;
  participantIndex: bigint;
  shareZ: bigint;
}

/**
 * 解析 32 字节压缩点并做完整合法性校验:
 * 曲线上 (assertValidity)、非恒等元 (!is0)、无小子群分量 (isTorsionFree)
 */
function parseValidPoint(bytes: Uint8Array, label: string): Point {
  if (bytes.length !== 32) {
    throw new Error(`[FROST1] ${label}: expected 32-byte compressed point, got ${bytes.length} bytes`);
  }
  const point = ed25519.Point.fromBytes(bytes);
  point.assertValidity();
  if (point.is0()) {
    throw new Error(`[FROST1] ${label}: identity point is not a valid nonce commitment`);
  }
  if (!point.isTorsionFree()) {
    throw new Error(`[FROST1] ${label}: point is not torsion-free (small-order component rejected)`);
  }
  return point;
}

/**
 * 承诺集合合法性校验:
 * - 索引唯一
 * - hiding/binding 均为 32 字节合法压缩点 (非恒等元、无小子群分量)
 */
export function validateCommitments(commitments: NonceCommitment[]): void {
  const seen = new Set<bigint>();
  for (const item of commitments) {
    if (seen.has(item.participantIndex)) {
      throw new Error(`[FROST1] duplicate participantIndex ${item.participantIndex} in nonce commitments`);
    }
    seen.add(item.participantIndex);
    parseValidPoint(item.hiding, `participant ${item.participantId} hiding commitment`);
    parseValidPoint(item.binding, `participant ${item.participantId} binding commitment`);
  }
}

/**
 * 计算 FROST1 绑定因子:
 * rho = SHA512("SUI_FROST_BINDING_V1:" || H_1 || B_1 || H_2 || B_2 || ... || message || groupPublicKey) mod L
 * 承诺点按 participantIndex 升序排序后哈希，保证所有参与方得到一致的 rho
 */
export function computeBindingFactor(
  message: Uint8Array,
  groupPublicKey: Uint8Array,
  allNonceCommitments: NonceCommitment[]
): bigint {
  const sorted = [...allNonceCommitments].sort((a, b) =>
    a.participantIndex < b.participantIndex ? -1 : a.participantIndex > b.participantIndex ? 1 : 0
  );

  const domainBytes = new TextEncoder().encode(BINDING_DOMAIN);
  const totalLen =
    domainBytes.length +
    sorted.length * 64 +
    message.length +
    groupPublicKey.length;
  const input = new Uint8Array(totalLen);

  let offset = 0;
  input.set(domainBytes, offset);
  offset += domainBytes.length;
  for (const item of sorted) {
    input.set(item.hiding, offset);
    offset += 32;
    input.set(item.binding, offset);
    offset += 32;
  }
  input.set(message, offset);
  offset += message.length;
  input.set(groupPublicKey, offset);

  return bytesToScalar(sha512(input));
}

/**
 * 由承诺集合与绑定因子重算聚合随机点 R̄ = Σ (H_i + rho * B_i)
 * (所有参与方 / 聚合器必须得到完全一致的 R̄)
 */
export function computeAggregateNonce(
  rho: bigint,
  allNonceCommitments: NonceCommitment[]
): Point {
  let aggregate = ed25519.Point.ZERO;
  for (const item of allNonceCommitments) {
    const hiding = ed25519.Point.fromBytes(item.hiding);
    const binding = ed25519.Point.fromBytes(item.binding);
    aggregate = aggregate.add(hiding.add(binding.multiply(rho)));
  }
  return aggregate;
}

/**
 * Ed25519 挑战标量 c = SHA512(R̄ || Y || message) mod L (RFC 8032)
 */
function computeChallenge(aggregateR: Point, groupPublicKey: Uint8Array, message: Uint8Array): bigint {
  const hashInput = new Uint8Array(32 + 32 + message.length);
  hashInput.set(aggregateR.toBytes(), 0);
  hashInput.set(groupPublicKey, 32);
  hashInput.set(message, 64);
  return bytesToScalar(sha512(hashInput));
}

/**
 * 单份额验证 (可选): z_i * G == R_i + c * λ_i * Y_i
 * 其中 R_i = H_i + rho * B_i，Y_i 为该成员分片公钥点 (可由 Feldman 承诺导出)
 */
export function verifyShare(
  share: SignatureShare,
  message: Uint8Array,
  groupPublicKey: Uint8Array,
  allNonceCommitments: NonceCommitment[],
  sharePublicKeys: Map<string, Uint8Array>
): boolean {
  const rho = computeBindingFactor(message, groupPublicKey, allNonceCommitments);
  const aggregateR = computeAggregateNonce(rho, allNonceCommitments);
  const c = computeChallenge(aggregateR, groupPublicKey, message);
  const subsetX = allNonceCommitments.map((nc) => nc.participantIndex);
  const lambda = lagrangeCoefficient(share.participantIndex, subsetX, 0n);

  const commitment = allNonceCommitments.find((nc) => nc.participantIndex === share.participantIndex);
  if (!commitment) return false;
  const pkBytes = sharePublicKeys.get(share.participantId);
  if (!pkBytes) return false;

  const R_i = ed25519.Point.fromBytes(commitment.hiding).add(ed25519.Point.fromBytes(commitment.binding).multiply(rho));
  const Y_i = ed25519.Point.fromBytes(pkBytes);
  const left = ed25519.Point.BASE.multiply(mod(share.shareZ));
  const right = R_i.add(Y_i.multiply(mod(c * lambda)));

  return left.equals(right);
}

export class ThresholdSignerNode {
  public readonly id: string;
  public readonly index: bigint;
  public readonly privateShare: bigint;

  // FROST1 双 nonce 秘密标量 (仅本地持有，单次使用后即刻销毁)
  private hidingNonce: bigint = 0n;
  private bindingNonce: bigint = 0n;

  constructor(id: string, index: number | bigint, privateShare: bigint) {
    this.id = id;
    this.index = BigInt(index);
    this.privateShare = privateShare;
  }

  /**
   * 签名阶段 Round 1 (FROST1): 生成一对临时随机标量 (hide_i, bind_i)
   * 并广播承诺 (H_i = hide_i*G, B_i = bind_i*G)。秘密标量永不上链/出网。
   */
  public generateNonceCommitment(): NonceCommitment {
    this.hidingNonce = randomScalar();
    this.bindingNonce = randomScalar();

    return {
      participantId: this.id,
      participantIndex: this.index,
      hiding: ed25519.Point.BASE.multiply(this.hidingNonce).toBytes(),
      binding: ed25519.Point.BASE.multiply(this.bindingNonce).toBytes(),
    };
  }

  /**
   * 签名阶段 Round 2 (FROST1):
   * rho  = SHA512("SUI_FROST_BINDING_V1:" || 排序后承诺 || message || Y) mod L
   * d_i  = hide_i + rho * bind_i            (有效 nonce，秘密标量)
   * c    = SHA512(R̄ || Y || message) mod L
   * z_i  = d_i + c * λ_i * s_i (mod L)
   * 计算完毕后立即销毁双 nonce，防止重放与私钥泄露
   */
  public computeSignatureShare(
    message: Uint8Array,
    groupPublicKey: Uint8Array,
    allNonceCommitments: NonceCommitment[]
  ): SignatureShare {
    if (this.hidingNonce === 0n || this.bindingNonce === 0n) {
      throw new Error(
        `[ThresholdSigner-${this.id}] No ephemeral nonce available or nonce already consumed (nonce reuse prohibited!)`
      );
    }

    validateCommitments(allNonceCommitments);

    // 1. 绑定因子与聚合随机点 R̄ = Σ (H_i + rho * B_i)
    const rho = computeBindingFactor(message, groupPublicKey, allNonceCommitments);
    const aggregateR = computeAggregateNonce(rho, allNonceCommitments);

    // 2. 挑战标量 c = SHA512(R̄ || Y || message) mod L
    const c = computeChallenge(aggregateR, groupPublicKey, message);

    // 3. 本参与者在当前门限子集中的拉格朗日系数 λ_i(0)
    const subsetX = allNonceCommitments.map((nc) => nc.participantIndex);
    const lambda = lagrangeCoefficient(this.index, subsetX, 0n);

    // 4. 有效 nonce d_i = hiding + rho * binding，计算 z_i 后销毁双 nonce
    const effectiveNonce = mod(this.hidingNonce + rho * this.bindingNonce);
    const zi = mod(effectiveNonce + c * lambda * this.privateShare);
    this.hidingNonce = 0n;
    this.bindingNonce = 0n;

    return {
      participantId: this.id,
      participantIndex: this.index,
      shareZ: zi,
    };
  }

  /**
   * 签名聚合器 (FROST1): 以相同 rho 重算 R̄，求和产出标准 64 字节
   * Ed25519 签名 (R̄ || z)，并用 ed25519.verify 自校验，失败即抛错
   * (杜绝承诺替换 / 伪造份额悄悄产出垃圾签名)
   */
  public static aggregateSignature(
    message: Uint8Array,
    groupPublicKey: Uint8Array,
    allNonceCommitments: NonceCommitment[],
    allSignatureShares: SignatureShare[]
  ): Uint8Array {
    validateCommitments(allNonceCommitments);

    const rho = computeBindingFactor(message, groupPublicKey, allNonceCommitments);
    const aggregateR = computeAggregateNonce(rho, allNonceCommitments);

    let aggregateZ = 0n;
    for (const share of allSignatureShares) {
      const commitment = allNonceCommitments.find((nc) => nc.participantIndex === share.participantIndex);
      if (!commitment || commitment.participantId !== share.participantId) {
        throw new Error(
          `[FROST1] signature share from ${share.participantId} has no matching nonce commitment`
        );
      }
      aggregateZ = mod(aggregateZ + share.shareZ);
    }

    const finalSignature = new Uint8Array(64);
    finalSignature.set(aggregateR.toBytes(), 0);
    finalSignature.set(scalarToBytes32(aggregateZ), 32);

    if (!ed25519.verify(finalSignature, message, groupPublicKey)) {
      throw new Error(
        '[FROST1] Aggregate signature failed self-verification under ed25519.verify — commitment or share corruption detected'
      );
    }

    return finalSignature;
  }

  /**
   * 原生 Ed25519 签名校验 (与 Sui 链上 sui::ed25519::ed25519_verify 行为 100% 一致)
   */
  public static verifyThresholdSignature(
    signature: Uint8Array,
    message: Uint8Array,
    groupPublicKey: Uint8Array
  ): boolean {
    return ed25519.verify(signature, message, groupPublicKey);
  }
}
