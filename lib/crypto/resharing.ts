import { ed25519 } from '@noble/curves/ed25519.js';
import { sha512 } from '@noble/hashes/sha2.js';
import {
  mod,
  lagrangeCoefficient,
  CURVE_ORDER,
  randomScalar,
  bytesToScalar,
  scalarToBytes32,
} from './math';
import {
  Point,
  generatePolynomial,
  evaluatePolynomial,
  createCommitments,
  verifyShareCommitment,
} from './vss';
import { bytesEqual, bytesToHex } from './bytes';

export interface ReshareRound1Output {
  senderId: string;
  senderIndex: bigint;
  refreshCommitments: Point[]; // H_{i,0}=ZERO, H_{i,1} ...
}

export interface ReshareFinalResult {
  participantId: string;
  participantIndex: bigint;
  newPrivateShare: bigint;
  groupPublicKey: Uint8Array;
  groupPublicKeyHex: string;
}

export interface DealerHonestyContext {
  orgId: string;
  epoch: number | bigint;
  sessionId: string;
}

export interface DealerHonestyProof {
  dealerId: string;
  dealerIndex: bigint;
  constantCommitment: Uint8Array; // C_{i,0} bytes (32 bytes)
  verificationShareY: Uint8Array; // Y_i bytes (32 bytes)
  noncePointR: Uint8Array;        // R = k * G bytes (32 bytes)
  responseS: bigint;              // s = k + c * z_i mod L
}

export interface GennaroResharePackage {
  senderId: string;
  senderIndex: bigint;
  commitments: Point[];
  subShares: Map<string, bigint>;
  honestyProof?: DealerHonestyProof;
}

/** Dealer 诚实性校验失败（context 不匹配 / 常数承诺与多项式承诺不一致）。 */
export class DealerHonestyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DealerHonestyError';
  }
}

/**
 * 计算 Dealer 诚实性零知识证明的 Fiat-Shamir 挑战标量 c
 * 包含强域隔离上下文: orgId + epoch + sessionId + dealerIndex + C_{i,0} + Y_i + R
 */
export function computeDealerChallenge(
  context: DealerHonestyContext,
  dealerIndex: bigint,
  constantCommitmentBytes: Uint8Array,
  verificationShareYBytes: Uint8Array,
  noncePointRBytes: Uint8Array
): bigint {
  const encoder = new TextEncoder();
  const tagBytes = encoder.encode('DEALER_POK_V1:');
  const orgBytes = encoder.encode(context.orgId);
  const epochBytes = scalarToBytes32(BigInt(context.epoch));
  const sessionBytes = encoder.encode(context.sessionId);
  const indexBytes = scalarToBytes32(dealerIndex);

  const totalLength =
    tagBytes.length +
    orgBytes.length +
    epochBytes.length +
    sessionBytes.length +
    indexBytes.length +
    constantCommitmentBytes.length +
    verificationShareYBytes.length +
    noncePointRBytes.length;

  const buffer = new Uint8Array(totalLength);
  let offset = 0;
  buffer.set(tagBytes, offset); offset += tagBytes.length;
  buffer.set(orgBytes, offset); offset += orgBytes.length;
  buffer.set(epochBytes, offset); offset += epochBytes.length;
  buffer.set(sessionBytes, offset); offset += sessionBytes.length;
  buffer.set(indexBytes, offset); offset += indexBytes.length;
  buffer.set(constantCommitmentBytes, offset); offset += constantCommitmentBytes.length;
  buffer.set(verificationShareYBytes, offset); offset += verificationShareYBytes.length;
  buffer.set(noncePointRBytes, offset); offset += noncePointRBytes.length;

  const digest = sha512(buffer);
  return bytesToScalar(digest);
}

/**
 * 构造 Dealer 诚实性 Schnorr 零知识证明:
 * 证明 Dealer 知晓 z_i = λ_i(0) * s_i，使得 C_{i,0} = z_i * G 且与前任验证份额 Y_i 保持 C_{i,0} == λ_i(0) * Y_i 严格一致，
 * 且绑定当前换届的上下文 (orgId, epoch, sessionId, dealerIndex)。
 */
export function createDealerHonestyProof(
  dealerId: string,
  dealerIndex: bigint,
  dealerShare: bigint,
  oldActiveIndices: bigint[],
  context: DealerHonestyContext
): DealerHonestyProof {
  const lambda_i = lagrangeCoefficient(dealerIndex, oldActiveIndices, 0n);
  const z_i = mod(lambda_i * dealerShare);

  const YiPoint = ed25519.Point.BASE.multiply(dealerShare);
  const Ci0Point = ed25519.Point.BASE.multiply(z_i);

  // 临时随机数 k 与承诺 R = k * G
  const k = randomScalar();
  const RPoint = ed25519.Point.BASE.multiply(k);

  const c0Bytes = Ci0Point.toBytes();
  const yiBytes = YiPoint.toBytes();
  const rBytes = RPoint.toBytes();

  const c = computeDealerChallenge(context, dealerIndex, c0Bytes, yiBytes, rBytes);
  const s = mod(k + c * z_i);

  return {
    dealerId,
    dealerIndex,
    constantCommitment: c0Bytes,
    verificationShareY: yiBytes,
    noncePointR: rBytes,
    responseS: s,
  };
}

/**
 * 校验 Dealer 诚实性 Schnorr 零知识证明
 * 1. 验证 C_{i,0} == λ_i(0) * Y_i (确保多项式常数项承诺严格来自原私钥分片与拉格朗日系数)
 * 2. 验证 s * G == R + c * C_{i,0} (证明知晓离散对数 z_i 且绑定当前 session context)
 * 3. 若提供 expectedVerificationShareY，比对 Y_i 是否与链上或 Roster 记录的历史公钥分片一致
 */
export function verifyDealerHonestyProof(
  proof: DealerHonestyProof,
  oldActiveIndices: bigint[],
  context: DealerHonestyContext,
  expectedVerificationShareY?: Uint8Array
): boolean {
  try {
    if (proof.responseS <= 0n || proof.responseS >= CURVE_ORDER) {
      return false;
    }

    const c0Point = ed25519.Point.fromHex(bytesToHex(proof.constantCommitment));
    const yiPoint = ed25519.Point.fromHex(bytesToHex(proof.verificationShareY));
    const rPoint = ed25519.Point.fromHex(bytesToHex(proof.noncePointR));

    if (
      c0Point.equals(ed25519.Point.ZERO) ||
      yiPoint.equals(ed25519.Point.ZERO) ||
      rPoint.equals(ed25519.Point.ZERO)
    ) {
      return false;
    }

    // 检查历史验证份额是否与预期一致 (防止虚构身份)
    if (expectedVerificationShareY && expectedVerificationShareY.length === 32) {
      if (!bytesEqual(proof.verificationShareY, expectedVerificationShareY)) {
        return false;
      }
    }

    // 1. Dealer 诚实性比对: C_{i,0} == λ_i(0) * Y_i
    const lambda_i = lagrangeCoefficient(proof.dealerIndex, oldActiveIndices, 0n);
    const expectedC0 = yiPoint.multiply(lambda_i);
    if (!expectedC0.equals(c0Point)) {
      return false;
    }

    // 2. Schnorr PoK 挑战检查: s * G == R + c * C_{i,0}
    const c = computeDealerChallenge(
      context,
      proof.dealerIndex,
      proof.constantCommitment,
      proof.verificationShareY,
      proof.noncePointR
    );

    const sG = ed25519.Point.BASE.multiply(proof.responseS);
    const rhs = rPoint.add(c0Point.multiply(c));

    return sG.equals(rhs);
  } catch {
    return false;
  }
}

/**
 * 从任意 t 个新分片通过拉格朗日系数在椭圆曲线指数上重构群公钥:
 * Y = ∑ λ_j(0) · (s'_j · G)
 */
export function recomputeGroupPublicKeyFromShares(
  shares: { index: bigint | number; share: bigint }[]
): Uint8Array {
  if (shares.length === 0) {
    throw new Error('Cannot recompute group public key from empty shares');
  }
  const allX = shares.map((s) => BigInt(s.index));
  let groupPkPoint = ed25519.Point.ZERO;
  for (const item of shares) {
    const lambda = lagrangeCoefficient(BigInt(item.index), allX, 0n);
    const sharePoint = ed25519.Point.BASE.multiply(item.share);
    const weightedPoint = sharePoint.multiply(lambda);
    groupPkPoint = groupPkPoint.add(weightedPoint);
  }
  return groupPkPoint.toBytes();
}

/**
 * 主动秘密重共享 (Proactive Secret Resharing) 引擎
 * 核心机制:
 * 1. 旧委员会成员生成常数项为 0 的随机多项式 h_i(x) (即 h_i(0) = 0)
 * 2. 分发刷新份额 u_{i -> k} = h_i(k)
 * 3. 新委员会成员合成新份额 s_k'
 * 4. 保证群公钥 Y = S * G 绝对恒定不变！旧成员被剔除后旧份额立即作废。
 */
export class ResharingNode {
  public readonly id: string;
  public readonly index: bigint;
  public readonly isOldMember: boolean;
  public readonly isNewMember: boolean;
  public readonly currentShare?: bigint;
  public readonly newThreshold: number;

  private refreshPolynomial: bigint[] = [];
  private refreshCommitments: Point[] = [];

  constructor(config: {
    id: string;
    index: number | bigint;
    isOldMember: boolean;
    isNewMember: boolean;
    currentShare?: bigint;
    newThreshold: number;
  }) {
    this.id = config.id;
    this.index = BigInt(config.index);
    this.isOldMember = config.isOldMember;
    this.isNewMember = config.isNewMember;
    this.currentShare = config.currentShare;
    this.newThreshold = config.newThreshold;
  }

  /**
   * 阶段 1: 在任旧成员生成常数项为 0 的随机多项式并广播承诺
   */
  public generateRefreshPolynomial(): ReshareRound1Output | null {
    if (!this.isOldMember) return null;

    // h_i(x) = 0 + b_1*x + b_2*x^2 + ... (常数项必须为 0n!)
    this.refreshPolynomial = generatePolynomial(this.newThreshold - 1, 0n);
    this.refreshCommitments = createCommitments(this.refreshPolynomial);

    return {
      senderId: this.id,
      senderIndex: this.index,
      refreshCommitments: this.refreshCommitments,
    };
  }

  /**
   * 阶段 2: 旧成员为新委员会成员计算刷新分片 u_{i -> k} = h_i(k)
   */
  public computeRefreshShares(newCommitteeIndices: Map<string, bigint>): Map<string, bigint> {
    if (!this.isOldMember) return new Map();

    const refreshShares = new Map<string, bigint>();
    for (const [peerId, peerIndex] of newCommitteeIndices.entries()) {
      const u_ik = evaluatePolynomial(this.refreshPolynomial, peerIndex);
      refreshShares.set(peerId, u_ik);
    }
    return refreshShares;
  }

  public static recomputeGroupPublicKeyFromShares(
    shares: { index: bigint | number; share: bigint }[]
  ): Uint8Array {
    return recomputeGroupPublicKeyFromShares(shares);
  }

  /**
   * 阶段 3: 新委员会成员汇总刷新分片，计算新的私钥份额 s_k'
   * @param baselineShare 自己的基线份额 (若为新成员则通过旧委员会插值产生，若为老成员则为原有份额)
   * @param refreshSharesReceived 各旧委员会成员分发给自己的 u_{i -> k}
   * @param peerRefreshCommitments 各旧委员会成员广播的刷新承诺
   * @param originalGroupPublicKey 恒定的原始群公钥
   * @param newCommitteeShares 可选的新委员会成员分片 (用于在椭圆曲线指数上重构验证群公钥)
   */
  public finalizeResharing(
    baselineShare: bigint,
    refreshSharesReceived: Map<string, bigint>,
    peerRefreshCommitments: Map<string, Point[]>,
    originalGroupPublicKey?: Uint8Array,
    newCommitteeShares?: { index: bigint | number; share: bigint }[]
  ): ReshareFinalResult {
    if (!this.isNewMember) {
      throw new Error(`[Resharing-${this.id}] Node is not a member of the new committee`);
    }

    let updatedShare = baselineShare;

    // 校验并叠加每一个旧成员发来的刷新多项式取值
    for (const [peerId, commitments] of peerRefreshCommitments.entries()) {
      const u_ik = refreshSharesReceived.get(peerId);
      if (u_ik === undefined) {
        throw new Error(`[Resharing-${this.id}] Missing refresh share from: ${peerId}`);
      }

      // 验证同态匹配
      const isValid = verifyShareCommitment(u_ik, this.index, commitments);
      if (!isValid) {
        throw new Error(
          `[Resharing-${this.id}] Refresh share verification failed for peer: ${peerId}`
        );
      }

      updatedShare = mod(updatedShare + u_ik);
    }

    let computedGroupPublicKey: Uint8Array;
    if (newCommitteeShares && newCommitteeShares.length >= this.newThreshold) {
      computedGroupPublicKey = recomputeGroupPublicKeyFromShares(newCommitteeShares);
    } else if (originalGroupPublicKey) {
      computedGroupPublicKey = Uint8Array.from(originalGroupPublicKey);
    } else {
      throw new Error(
        `[Resharing-${this.id}] Either new committee shares or expected group public key must be provided`
      );
    }

    if (originalGroupPublicKey && newCommitteeShares && newCommitteeShares.length >= this.newThreshold) {
      if (!bytesEqual(computedGroupPublicKey, originalGroupPublicKey)) {
        throw new Error(
          `[Resharing-${this.id}] Recomputed group public key does not match expected group public key`
        );
      }
    }

    return {
      participantId: this.id,
      participantIndex: this.index,
      newPrivateShare: updatedShare,
      groupPublicKey: computedGroupPublicKey,
      groupPublicKeyHex: `0x${bytesToHex(computedGroupPublicKey)}`,
    };
  }

  /**
   * 工具方法: 当有全新成员加入时，利用旧委员会任意 t 个节点的现有份额插值计算新成员的基线份额
   */
  public static interpolateBaselineShareForNewMember(
    newMemberIndex: bigint,
    subsetOldShares: { index: bigint; share: bigint }[]
  ): bigint {
    const allX = subsetOldShares.map((s) => s.index);
    let baseline = 0n;

    for (const item of subsetOldShares) {
      const lambda = lagrangeCoefficient(item.index, allX, newMemberIndex);
      baseline = mod(baseline + lambda * item.share);
    }

    return baseline;
  }
}

/**
 * 纯 Gennaro/Herzberg 动态委员会主动秘密重共享 (Pure Gennaro Proactive Secret Resharing)
 * 特点:
 * 1. 彻底消灭对 "Baseline 插值" 的依赖，任何单点都不可能接触到历史分片组合；
 * 2. 活跃旧成员 P_i (属于 t_old 活跃子集) 在本地计算 z_i = λ_i(0) * s_i mod L；
 * 3. P_i 独立生成阶数为 t_new - 1 的多项式 g_i(x)，使得常数项 g_i(0) = z_i；
 * 4. P_i 为新委员会的所有成员 k 计算子分片 w_{i -> k} = g_i(k)，并广播公开承诺向量 G_{i,m}；
 * 5. 新委员会的成员 k (无论是老成员还是新加入的 Eve) 接收各 P_i 发来的 w_{i -> k} 并验签；
 * 6. 成员 k 累加求和得出自己的全新分片: s_k' = ∑ w_{i -> k} mod L；
 * 7. 群公钥保持 100% 绝对恒定不变，全程零知识保护，绝不泄露根私钥！
 */
export class GennaroResharingParticipant {
  public readonly id: string;
  public readonly index: bigint;
  public readonly isOldActiveMember: boolean;
  public readonly isNewMember: boolean;
  public readonly currentShare?: bigint;
  public readonly newThreshold: number;

  private resharingPolynomial: bigint[] = [];
  private resharingCommitments: Point[] = [];

  constructor(config: {
    id: string;
    index: number | bigint;
    isOldActiveMember: boolean;
    isNewMember: boolean;
    currentShare?: bigint;
    newThreshold: number;
  }) {
    this.id = config.id;
    this.index = BigInt(config.index);
    this.isOldActiveMember = config.isOldActiveMember;
    this.isNewMember = config.isNewMember;
    this.currentShare = config.currentShare;
    this.newThreshold = config.newThreshold;
  }

  /**
   * 阶段 1: 活跃旧成员为新委员会生成 Gennaro 刷新多项式及 Dealer 诚实性零知识证明
   * @param oldActiveIndices 参与本次换届的 t_old 个活跃旧成员的 index 列表
   * @param newCommitteeIndices 新委员会所有成员的 (id -> index) 映射
   * @param context 必填的会话域隔离上下文 (orgId, epoch, sessionId)
   */
  public generateResharePackage(
    oldActiveIndices: bigint[],
    newCommitteeIndices: Map<string, bigint>,
    context: DealerHonestyContext
  ): GennaroResharePackage {
    if (!this.isOldActiveMember || this.currentShare === undefined) {
      throw new Error(`[Gennaro-${this.id}] Not an active old member or missing current share`);
    }

    // 1. 本地计算加权常数项 z_i = λ_i(0) * s_i mod L
    const lambda_i = lagrangeCoefficient(this.index, oldActiveIndices, 0n);
    const z_i = mod(lambda_i * this.currentShare);

    // 2. 生成阶数为 t_new - 1 的随机多项式 g_i(x)，常数项为 z_i
    this.resharingPolynomial = generatePolynomial(this.newThreshold - 1, z_i);
    this.resharingCommitments = createCommitments(this.resharingPolynomial);

    // 3. 为新委员会所有成员 (包括老成员和新加入的 Eve) 计算子分片 w_{i -> k} = g_i(k)
    const subShares = new Map<string, bigint>();
    for (const [peerId, peerIndex] of newCommitteeIndices.entries()) {
      const w_ik = evaluatePolynomial(this.resharingPolynomial, peerIndex);
      subShares.set(peerId, w_ik);
    }

    const honestyProof = createDealerHonestyProof(
      this.id,
      this.index,
      this.currentShare,
      oldActiveIndices,
      context
    );

    return {
      senderId: this.id,
      senderIndex: this.index,
      commitments: this.resharingCommitments,
      subShares,
      honestyProof,
    };
  }

  /**
   * 阶段 2: 新委员会成员 (老成员或新加入的 Eve) 接收子分片并合成自己的新私钥分片
   * 没有任何 Baseline 依赖！
   * @param incomingSubShares 来自各活跃旧成员的 w_{i -> this.index}
   * @param peerCommitments 各活跃旧成员广播的承诺向量
   * @param originalGroupPublicKey 必传的恒定组织公钥（round-9 去可选化）：
   *   无它时恶意 dealer 可静默产出被毒化的群公钥（RT9-T1c join 缺口）。
   * @param newCommitteeShares 可选的新委员会成员分片
   * @param options 必填的 Dealer 诚实性证明校验选项 (证明各 Dealer 的常数承诺 C_{i,0} == λ_i(0) * Y_i 且绑定会话上下文；不再存在无 context 的静默跳过路径)
   */
  public finalizeNewShare(
    incomingSubShares: Map<string, bigint>,
    peerCommitments: Map<string, Point[]>,
    originalGroupPublicKey: Uint8Array,
    newCommitteeShares: { index: bigint | number; share: bigint }[] = [],
    options: {
      dealerHonestyProofs: Map<string, DealerHonestyProof>;
      oldActiveIndices: bigint[];
      context: DealerHonestyContext;
      expectedVerificationShares?: Map<string, Uint8Array>;
    }
  ): ReshareFinalResult {
    if (!this.isNewMember) {
      throw new Error(`[Gennaro-${this.id}] Node is not a member of the new committee`);
    }
    if (!(originalGroupPublicKey instanceof Uint8Array) || originalGroupPublicKey.length !== 32) {
      throw new Error(
        `[Gennaro-${this.id}] originalGroupPublicKey is required (32 bytes): without it a poisoned resharing polynomial silently corrupts the group public key`
      );
    }

    // 严格校验所有 Dealer 的 PoK —— 证明与 context 不匹配即为硬错误，无任何静默回退
    for (const [senderId, proof] of options.dealerHonestyProofs.entries()) {
      // round-9 join 缺口闭合（RT9-T1c4）：证明的常数承诺 C_{i,0} 必须与该 dealer
      // 投递的 resharing 多项式承诺 commitments[0] 逐字节一致。缺一即拒——
      // 诚实身份 + 毒化多项式（常数 z* ≠ λ·s_i）的组合在此被硬拒。
      const commitments = peerCommitments.get(senderId);
      if (!commitments || commitments.length === 0) {
        throw new Error(
          `[Gennaro-${this.id}] Dealer honesty proof has no matching resharing commitments for sender: ${senderId}`
        );
      }
      if (!bytesEqual(proof.constantCommitment, commitments[0].toBytes())) {
        throw new DealerHonestyError(
          `[Gennaro-${this.id}] constant commitment mismatch for sender: ${senderId}`
        );
      }
      const expectedY = options.expectedVerificationShares?.get(senderId);
      const isValid = verifyDealerHonestyProof(
        proof,
        options.oldActiveIndices,
        options.context,
        expectedY
      );
      if (!isValid) {
        throw new DealerHonestyError(
          `[Gennaro-${this.id}] Sub-share dealer honesty proof verification failed for sender: ${senderId}`
        );
      }
    }

    let accumulatedShare = 0n;

    for (const [senderId, commitments] of peerCommitments.entries()) {
      const w_ik = incomingSubShares.get(senderId);
      if (w_ik === undefined) {
        throw new Error(`[Gennaro-${this.id}] Missing sub-share from active sender: ${senderId}`);
      }

      // 同态验证 w_{i -> k} * G == ∑ k^m * G_{i,m}
      const isValid = verifyShareCommitment(w_ik, this.index, commitments);
      if (!isValid) {
        throw new Error(
          `[Gennaro-${this.id}] Sub-share commitment verification failed for sender: ${senderId}`
        );
      }

      accumulatedShare = mod(accumulatedShare + w_ik);
    }

    // 核心密码学计算：在椭圆曲线指数上从活跃旧节点的承诺常数项 ∑ C_{i,0} 或新分片重构真实群公钥
    let computedGroupPublicKey: Uint8Array;
    if (newCommitteeShares && newCommitteeShares.length >= this.newThreshold) {
      computedGroupPublicKey = recomputeGroupPublicKeyFromShares(newCommitteeShares);
    } else {
      let groupPublicKeyPoint = ed25519.Point.ZERO;
      for (const [, commitments] of peerCommitments.entries()) {
        groupPublicKeyPoint = groupPublicKeyPoint.add(commitments[0]);
      }
      if (this.isOldActiveMember && this.resharingCommitments.length > 0 && !peerCommitments.has(this.id)) {
        groupPublicKeyPoint = groupPublicKeyPoint.add(this.resharingCommitments[0]);
      }
      computedGroupPublicKey = groupPublicKeyPoint.toBytes();
    }

    // round-9：originalGroupPublicKey 必传且必查（32 字节在方法入口已硬校验）。
    if (!bytesEqual(computedGroupPublicKey, originalGroupPublicKey)) {
      throw new DealerHonestyError(
        `[Gennaro-${this.id}] Recomputed group public key does not match original group public key`
      );
    }

    return {
      participantId: this.id,
      participantIndex: this.index,
      newPrivateShare: accumulatedShare,
      groupPublicKey: computedGroupPublicKey,
      groupPublicKeyHex: `0x${bytesToHex(computedGroupPublicKey)}`,
    };
  }
}

