import { ed25519 } from '@noble/curves/ed25519.js';
import { mod } from './math';
import {
  Point,
  generatePolynomial,
  evaluatePolynomial,
  createCommitments,
  verifyShareCommitment,
} from './vss';

export interface Round1Output {
  senderId: string;
  senderIndex: bigint;
  commitments: Point[];
  commitmentBytes: Uint8Array[];
}

export interface DKGFinalResult {
  participantId: string;
  participantIndex: bigint;
  privateShare: bigint;
  groupPublicKey: Uint8Array;
  groupPublicKeyHex: string;
}

export class DKGParticipant {
  public readonly id: string;
  public readonly index: bigint;
  public readonly threshold: number;
  public readonly totalParticipants: number;

  private secretPolynomial: bigint[] = [];
  private commitments: Point[] = [];
  private peerCommitments: Map<string, Point[]> = new Map();
  private peerIndices: Map<string, bigint> = new Map();

  constructor(id: string, index: number | bigint, threshold: number, totalParticipants: number) {
    this.id = id;
    this.index = BigInt(index);
    this.threshold = threshold;
    this.totalParticipants = totalParticipants;
  }

  /**
   * Round 1: 生成本地秘密多项式并广播 Pedersen 承诺
   */
  public round1(): Round1Output {
    this.secretPolynomial = generatePolynomial(this.threshold - 1);
    this.commitments = createCommitments(this.secretPolynomial);

    return {
      senderId: this.id,
      senderIndex: this.index,
      commitments: this.commitments,
      commitmentBytes: this.commitments.map((c) => c.toBytes()),
    };
  }

  /**
   * 接收其他参与方在 Round 1 广播的承诺
   */
  public receiveRound1Packages(packages: Round1Output[]) {
    for (const pkg of packages) {
      if (pkg.senderId !== this.id) {
        this.peerCommitments.set(pkg.senderId, pkg.commitments);
        this.peerIndices.set(pkg.senderId, pkg.senderIndex);
      }
    }
  }

  /**
   * 注册对端节点索引 (即使对端处于离线状态)
   */
  public registerPeerIndex(peerId: string, peerIndex: bigint) {
    if (peerId !== this.id) {
      this.peerIndices.set(peerId, peerIndex);
    }
  }

  /**
   * 为指定索引计算多项式求值份额 f_i(targetIndex)
   */
  public evaluateShareForIndex(targetIndex: bigint): bigint {
    return evaluatePolynomial(this.secretPolynomial, targetIndex);
  }

  /**
   * Round 2: 为每个其他成员计算点对点秘密分片 s_{i -> j} = f_i(j)
   */
  public round2(): Map<string, bigint> {
    const sharesOut = new Map<string, bigint>();

    for (const [peerId, peerIndex] of this.peerIndices.entries()) {
      const share = evaluatePolynomial(this.secretPolynomial, peerIndex);
      sharesOut.set(peerId, share);
    }

    // 自己的份额 f_i(i)
    const selfShare = evaluatePolynomial(this.secretPolynomial, this.index);
    sharesOut.set(this.id, selfShare);

    return sharesOut;
  }

  /**
   * Finalize: 校验收到的所有秘密分片，同态求和产出聚合私钥份额 s_i 与群公钥 Y
   */
  public finalize(sharesReceived: Map<string, bigint>): DKGFinalResult {
    let aggregateShare = 0n;

    // 1. 验证并累加自己对自己的份额
    const selfShare = sharesReceived.get(this.id);
    if (selfShare === undefined) {
      throw new Error(`[DKG-${this.id}] Missing self share`);
    }
    if (!verifyShareCommitment(selfShare, this.index, this.commitments)) {
      throw new Error(`[DKG-${this.id}] Self share failed VSS commitment verification`);
    }
    aggregateShare = mod(aggregateShare + selfShare);

    // 2. 验证并累加所有对端节点分发给自己的份额
    for (const [peerId, peerCommitments] of this.peerCommitments.entries()) {
      const share = sharesReceived.get(peerId);
      if (share === undefined) {
        throw new Error(`[DKG-${this.id}] Missing share from peer: ${peerId}`);
      }

      const isValid = verifyShareCommitment(share, this.index, peerCommitments);
      if (!isValid) {
        throw new Error(
          `[DKG-${this.id}] VSS Verification failed for share from peer: ${peerId}`
        );
      }

      aggregateShare = mod(aggregateShare + share);
    }

    // 3. 计算无任何单点私钥存在的全局群公钥 Y = ∑ C_{j,0}
    let groupPublicKeyPoint = this.commitments[0];
    for (const peerCommitments of this.peerCommitments.values()) {
      groupPublicKeyPoint = groupPublicKeyPoint.add(peerCommitments[0]);
    }

    const groupPublicKey = groupPublicKeyPoint.toBytes();
    const groupPublicKeyHex = `0x${Buffer.from(groupPublicKey).toString('hex')}`;

    return {
      participantId: this.id,
      participantIndex: this.index,
      privateShare: aggregateShare,
      groupPublicKey,
      groupPublicKeyHex,
    };
  }
}
