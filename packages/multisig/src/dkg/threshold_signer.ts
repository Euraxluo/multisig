import { ed25519 } from '@noble/curves/ed25519.js';
import { sha512 } from '@noble/hashes/sha2.js';
import { mod, randomScalar, bytesToScalar, scalarToBytes32, lagrangeCoefficient } from './math';
import { bytesEqual } from './bytes-equal';
import type { Point } from './vss';

/**
 * 自研 FROST1 门限签名器（Ed25519），协议步骤与 RFC 9591 的对应关系：
 * - Round 1 (§5.1)：`generateNonceCommitment` —— 节点内部生成双 nonce (hide_i, bind_i)，
 *   广播承诺 (D_i, E_i)，并把「自己的承诺」记在节点上供 Round 2 自校验；
 * - Round 2 (§5.2)：`computeSignatureShare` —— 消耗 nonce 前先确认协调者承诺列表里
 *   自己那一条与 Round 1 广播值逐字节一致（OWN_COMMITMENT_MISSING / OWN_COMMITMENT_MISMATCH），
 *   不一致即中止且 nonce 保持未消耗。这是 Drijvers 类承诺替换攻击（协调者对同一批
 *   nonce 提交两组不同承诺，联立解出私钥份额）的核心防线；
 * - 绑定因子 (§4.4)：`computeBindingFactor` —— 逐参与者 ρ_i（域分隔前缀 + 升序承诺
 *   + 消息 + 群公钥 + 自索引后缀）；
 * - 聚合 (§5.4)：`aggregateSignature` —— 可选传入各参与者的分片公钥 Y_i
 *   （`sharePublicKeys`）时，先逐份额验证 z_i·G = D_i + ρ_i·E_i + c·λ_i·Y_i 并
 *   指认肇事者，再做最终 `ed25519.verify`；未传入时退化为仅最终验签（仍
 *   fail-closed，但定位不到坏份额来源）。
 *
 * 与 `bridge/frost-session.ts` 的分工：bridge 那套封装 noble `ed25519_FROST`，
 * 带协议消息签名 / transcript / 设备密封库 / 会话存储，用于设备间两轮 FROST
 * 签名协议；本文件是无传输依赖的进程内 FROST1 签名器，供
 * `agent-vault/org/session.ts`、前端 `lib/crypto/committee-signing.ts`、
 * `lib/frost-exchange.ts` 与 `bin/dkg-cli.ts` 使用。两者不共享网络格式。
 *
 * 与 bridge / RFC 9591 的已知差异：
 * - 承诺点合法性校验与 bridge 同级（恒等元、小子群点、非规范编码一律拒绝）；
 * - RFC 9591 的版本协商与协议消息签名不在本层（由各调用方的传输层负责）；
 * - ρ_i 哈希布局是本仓库自己的域分隔方案（RFC 9591 §4.4 语义的等价实现，
 *   见 BINDING_DOMAIN 注释），跨实现不互通。
 */

/**
 * FROST1 绑定因子域分隔前缀。
 *
 * RFC 9591 §4.4 逐参与者绑定因子：ρ_i 由「全部承诺 + 消息 + 群公钥 + 参与者自身索引」
 * 一起哈希得出。单一全局 ρ（旧实现）在承诺可预测组合下会被抵消攻击利用
 * （如 E_2 = -E_1、D_2 = -D_1 时 R̄ 恒等于恒等元）；逐参与者 ρ_i ≠ ρ_j
 * （索引后缀不同）使该类抵消以压倒性概率失效。
 */
const BINDING_DOMAIN = 'SUI_FROST_BINDING_V1:';

export interface NonceCommitment {
  participantId: string;
  participantIndex: bigint;
  /** 隐藏承诺 D_i = hide_i * G (32 字节压缩点，秘密标量 hide_i 仅保存在节点内部) */
  hiding: Uint8Array;
  /** 绑定承诺 E_i = bind_i * G (32 字节压缩点，秘密标量 bind_i 仅保存在节点内部) */
  binding: Uint8Array;
}

export interface SignatureShare {
  participantId: string;
  participantIndex: bigint;
  shareZ: bigint;
}

/**
 * 解析 32 字节压缩点并做完整合法性校验:
 * 曲线上 (assertValidity)、非恒等元 (!is0)、无小子群分量 (isTorsionFree)、
 * 编码规范 (重编码逐字节一致)。
 * 与 bridge/key-package.ts、bridge/frost-session.ts 的承诺点校验对齐:
 * noble `Point.fromBytes` 默认走 RFC 8032 严格解码 (zip215=false)，已拒绝
 * y ≥ p 的非规范 y 编码与 x=0 且符号位为 1 的编码；末尾的重编码比对是
 * 纵深防御，保证任何被接受的编码都是唯一的规范压缩形式。
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
  if (!bytesEqual(point.toBytes(), bytes)) {
    throw new Error(`[FROST1] ${label}: point encoding is not canonical (must round-trip to the exact RFC 8032 compressed form)`);
  }
  return point;
}

/** u64 小端 8 字节编码（绑定因子哈希布局中索引自标识用）。 */
function u64leBytes(value: bigint): Uint8Array {
  const buf = new Uint8Array(8);
  let cur = value;
  for (let i = 0; i < 8; i++) {
    buf[i] = Number(cur & 0xffn);
    cur >>= 8n;
  }
  return buf;
}

/**
 * 承诺集合合法性校验:
 * - 索引唯一 (任何索引出现两次都拒绝，含「自己的索引出现两条」)
 * - hiding/binding 均为 32 字节合法压缩点 (非恒等元、无小子群分量、规范编码)
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
 * 计算 RFC 9591 §4.4 逐参与者绑定因子:
 * ρ_index = SHA512("SUI_FROST_BINDING_V1:"
 *                  ‖ (index_1 ‖ D_1 ‖ E_1) ‖ (index_2 ‖ D_2 ‖ E_2) ‖ …   (按索引升序)
 *                  ‖ message ‖ groupPublicKey ‖ index_8le) mod L
 *
 * 每个承诺条目以 8 字节小端索引自标识，末尾追加重算者自身的 8 字节索引——
 * 同一承诺集合下不同参与者得到不同的 ρ_i，承诺替换/抵消攻击不再有统一标量可乘。
 * 承诺点按 participantIndex 升序排序后哈希，保证所有参与方逐字节一致的输入。
 */
export function computeBindingFactor(
  allNonceCommitments: NonceCommitment[],
  message: Uint8Array,
  groupPublicKey: Uint8Array,
  participantIndex: bigint,
): bigint {
  const sorted = [...allNonceCommitments].sort((a, b) =>
    a.participantIndex < b.participantIndex ? -1 : a.participantIndex > b.participantIndex ? 1 : 0
  );

  const domainBytes = new TextEncoder().encode(BINDING_DOMAIN);
  const selfIndexBytes = u64leBytes(participantIndex);
  const totalLen =
    domainBytes.length +
    sorted.length * (8 + 64) +
    message.length +
    groupPublicKey.length +
    8;
  const input = new Uint8Array(totalLen);

  let offset = 0;
  input.set(domainBytes, offset);
  offset += domainBytes.length;
  for (const item of sorted) {
    input.set(u64leBytes(item.participantIndex), offset);
    offset += 8;
    input.set(item.hiding, offset);
    offset += 32;
    input.set(item.binding, offset);
    offset += 32;
  }
  input.set(message, offset);
  offset += message.length;
  input.set(groupPublicKey, offset);
  offset += groupPublicKey.length;
  input.set(selfIndexBytes, offset);

  return bytesToScalar(sha512(input));
}

/**
 * 由承诺集合重算聚合随机点 R̄ = Σ (D_i + ρ_i · E_i)，其中每个 ρ_i 由
 * computeBindingFactor 按该参与者的索引逐个重算（RFC 9591 §4.4）。
 * 所有参与方 / 聚合器必须得到完全一致的 R̄。
 */
export function computeAggregateNonce(
  allNonceCommitments: NonceCommitment[],
  message: Uint8Array,
  groupPublicKey: Uint8Array,
): Point {
  let aggregate = ed25519.Point.ZERO;
  for (const item of allNonceCommitments) {
    const rho_i = computeBindingFactor(allNonceCommitments, message, groupPublicKey, item.participantIndex);
    const hiding = ed25519.Point.fromBytes(item.hiding);
    const binding = ed25519.Point.fromBytes(item.binding);
    aggregate = aggregate.add(hiding.add(binding.multiply(rho_i)));
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
 * 分片公钥 Y_i = g^{s_i}（32 字节压缩点编码）。
 *
 * 持有私分片的一方本地即可算出，随签名份额一起交给聚合器后，聚合器的
 * 逐份额验签（verifyShare / RFC 9591 §5.4）就能归因坏份额。注意：聚合器
 * 拿到的 Y_i 由签名方自报，单独用它不能证明该成员确是群成员——那一步由
 * 最终的 ed25519.verify(聚合签名) 把守；逐份额验证的价值是把「谁的份额
 * 坏了」从一次聚合失败细化成具体索引。
 */
export function sharePublicKeyFromPrivate(privateShare: bigint): Uint8Array {
  return ed25519.Point.BASE.multiply(mod(privateShare)).toBytes();
}

/**
 * 单份额验证 (可选), RFC 9591 §4.4:
 * z_i · G ?= D_i + ρ_i · E_i + c · λ_i · Y_i
 * 其中 D_i/E_i 为该参与者的隐藏/绑定承诺，ρ_i 按其索引重算，
 * Y_i 为该成员分片公钥点 (可由 Feldman 承诺导出)。
 */
export function verifyShare(
  share: SignatureShare,
  message: Uint8Array,
  groupPublicKey: Uint8Array,
  allNonceCommitments: NonceCommitment[],
  sharePublicKeys: Map<string, Uint8Array>
): boolean {
  const aggregateR = computeAggregateNonce(allNonceCommitments, message, groupPublicKey);
  const c = computeChallenge(aggregateR, groupPublicKey, message);
  const subsetX = allNonceCommitments.map((nc) => nc.participantIndex);
  const lambda = lagrangeCoefficient(share.participantIndex, subsetX, 0n);

  const commitment = allNonceCommitments.find((nc) => nc.participantIndex === share.participantIndex);
  if (!commitment) return false;
  const pkBytes = sharePublicKeys.get(share.participantId);
  if (!pkBytes) return false;

  const rho_i = computeBindingFactor(allNonceCommitments, message, groupPublicKey, share.participantIndex);
  const D_i = ed25519.Point.fromBytes(commitment.hiding);
  const E_i = ed25519.Point.fromBytes(commitment.binding);
  const Y_i = ed25519.Point.fromBytes(pkBytes);
  const left = ed25519.Point.BASE.multiply(mod(share.shareZ));
  const right = D_i.add(E_i.multiply(rho_i)).add(Y_i.multiply(mod(c * lambda)));

  return left.equals(right);
}

export class ThresholdSignerNode {
  public readonly id: string;
  public readonly index: bigint;
  public readonly privateShare: bigint;

  // FROST1 双 nonce 秘密标量 (仅本地持有，单次使用后即刻销毁)
  private hidingNonce: bigint = 0n;
  private bindingNonce: bigint = 0n;
  // 本节点最近一次广播的承诺 (D_i, E_i)，Round 2 与协调者列表比对用 (RFC 9591 §5.2)
  private ownCommitment: { hiding: Uint8Array; binding: Uint8Array } | null = null;

  constructor(id: string, index: number | bigint, privateShare: bigint) {
    this.id = id;
    this.index = BigInt(index);
    this.privateShare = privateShare;
  }

  /**
   * 签名阶段 Round 1 (FROST1): 生成一对临时随机标量 (hide_i, bind_i)
   * 并广播承诺 (D_i = hide_i*G, E_i = bind_i*G)。秘密标量永不上链/出网。
   * 承诺同时记在节点内部，Round 2 时与协调者发回的列表逐字节比对。
   */
  public generateNonceCommitment(): NonceCommitment {
    this.hidingNonce = randomScalar();
    this.bindingNonce = randomScalar();
    this.ownCommitment = {
      hiding: ed25519.Point.BASE.multiply(this.hidingNonce).toBytes(),
      binding: ed25519.Point.BASE.multiply(this.bindingNonce).toBytes(),
    };

    return {
      participantId: this.id,
      participantIndex: this.index,
      hiding: this.ownCommitment.hiding,
      binding: this.ownCommitment.binding,
    };
  }

  /**
   * 签名阶段 Round 2 (FROST1, RFC 9591 §5.2/§4.4):
   * 先校验协调者承诺列表 (结构合法性 + 自己那一条与 Round 1 广播值逐字节一致)，
   * 任何失败都立即中止且 nonce 保持未消耗——用正确的列表重试可以成功。
   * 这是 Drijvers 类承诺替换攻击的核心防线: 协调者若对同一批 nonce 换发
   * 修改过的承诺列表，这里会拒绝签名而不是烧掉 nonce。
   * 通过后再计算:
   * ρ_i  = SHA512("SUI_FROST_BINDING_V1:" ‖ (index‖D‖E)*升序 ‖ message ‖ Y ‖ index_i) mod L
   * d_i  = hide_i + ρ_i * bind_i           (有效 nonce，秘密标量)
   * R̄    = Σ (D_j + ρ_j · E_j)            (ρ_j 逐参与者重算)
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

    // 拒绝重复索引 (含「自己的索引出现两条」) 与非法承诺点
    validateCommitments(allNonceCommitments);

    // 0. RFC 9591 §5.2: 消耗 nonce 前确认协调者列表里自己那一条与本节点
    //    Round 1 广播的 (D_i, E_i) 完全一致，不一致即中止 (nonce 不烧)。
    const own = allNonceCommitments.find((nc) => nc.participantIndex === this.index);
    if (!own) {
      throw new Error(
        `[FROST1] OWN_COMMITMENT_MISSING: coordinator commitment list has no entry for participant ${this.id} (index ${this.index}); aborting without consuming nonce`
      );
    }
    if (
      !this.ownCommitment ||
      !bytesEqual(own.hiding, this.ownCommitment.hiding) ||
      !bytesEqual(own.binding, this.ownCommitment.binding)
    ) {
      throw new Error(
        `[FROST1] OWN_COMMITMENT_MISMATCH: commitment for participant ${this.id} (index ${this.index}) differs from the one this node published in round 1; aborting without consuming nonce`
      );
    }

    // 1. 本参与者绑定因子 ρ_i 与聚合随机点 R̄ = Σ (D_j + ρ_j · E_j)
    const rho = computeBindingFactor(allNonceCommitments, message, groupPublicKey, this.index);
    const aggregateR = computeAggregateNonce(allNonceCommitments, message, groupPublicKey);

    // 2. 挑战标量 c = SHA512(R̄ || Y || message) mod L
    const c = computeChallenge(aggregateR, groupPublicKey, message);

    // 3. 本参与者在当前门限子集中的拉格朗日系数 λ_i(0)
    const subsetX = allNonceCommitments.map((nc) => nc.participantIndex);
    const lambda = lagrangeCoefficient(this.index, subsetX, 0n);

    // 4. 有效 nonce d_i = hiding + ρ_i * binding，计算 z_i 后销毁双 nonce
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
   * 签名聚合器 (FROST1, RFC 9591 §5.4): 按每个索引逐个重算 ρ_i 得到
   * R̄ = Σ (D_i + ρ_i·E_i)，求和产出标准 64 字节 Ed25519 签名 (R̄ || z)。
   *
   * 逐份额验证 (§5.4): 传入 `sharePublicKeys` (participantId → 分片公钥 Y_i
   * 的 32 字节压缩点，可由 Feldman 承诺 / DKG 结果导出) 时，聚合前先用
   * verifyShare 验证每个份额 z_i·G = D_i + ρ_i·E_i + c·λ_i·Y_i，失败即抛错
   * 并带上肇事参与者的索引——坏份额不再是笼统的「聚合签名无效」。
   * 未传入 Y_i 时该步无法执行 (份额验证在数学上必需各参与者的分片公钥)，
   * 退化为仅最终 ed25519 验签：仍然 fail-closed (任何坏份额都会被抓住)，
   * 只是定位不到肇事者。传入的 map 若缺某个参与者的公钥，该参与者的份额
   * 同样按验证失败处理 (fail-closed)。
   */
  public static aggregateSignature(
    message: Uint8Array,
    groupPublicKey: Uint8Array,
    allNonceCommitments: NonceCommitment[],
    allSignatureShares: SignatureShare[],
    sharePublicKeys?: Map<string, Uint8Array>
  ): Uint8Array {
    validateCommitments(allNonceCommitments);

    const aggregateR = computeAggregateNonce(allNonceCommitments, message, groupPublicKey);

    let aggregateZ = 0n;
    for (const share of allSignatureShares) {
      const commitment = allNonceCommitments.find((nc) => nc.participantIndex === share.participantIndex);
      if (!commitment || commitment.participantId !== share.participantId) {
        throw new Error(
          `[FROST1] signature share from ${share.participantId} has no matching nonce commitment`
        );
      }
      // RFC 9591 §5.4: 聚合前逐份额验签，失败指认肇事参与者
      if (sharePublicKeys && !verifyShare(share, message, groupPublicKey, allNonceCommitments, sharePublicKeys)) {
        throw new Error(
          `[FROST1] SHARE_VERIFICATION_FAILED: signature share from participant ${share.participantId} (index ${share.participantIndex}) failed per-share verification (z_i·G ≠ D_i + ρ_i·E_i + c·λ_i·Y_i)`
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
