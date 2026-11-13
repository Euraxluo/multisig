import { ed25519 } from '@noble/curves/ed25519.js';
import { Point, verifyShareCommitment } from './vss';
import { mod } from './math';
import { DKGParticipant, DKGFinalResult } from './ceremony';
import {
  IdentityKeypair,
  MailboxEnvelope,
  ShareDeliveryPayload,
  generateIdentityKeypair,
  encryptMailboxShare,
  decryptMailboxShare,
  bytesToHex,
} from './mailbox';

export interface SingleShotVssPackage {
  senderId: string;
  senderIndex: bigint;
  senderAddress: string;
  commitmentBytes: Uint8Array[];
  envelopes: MailboxEnvelope[];
}

export interface MemberRosterItem {
  id: string;
  index: bigint;
  address: string;
  timezone: string;
  identityKeypair: IdentityKeypair;
}

/**
 * 纯全异步 DKG 节点 (Fully Asynchronous DKG Participant)
 * 核心原则: 零在线假设 (Zero Online Assumption)
 * 成员无需与任何对端维持长连接或实时握手，所有交互基于单阶段投递与链上存储转发信箱
 */
export class FullyAsyncParticipant {
  public readonly id: string;
  public readonly index: bigint;
  public readonly address: string;
  public readonly timezone: string;
  public readonly identityKeypair: IdentityKeypair;
  public readonly threshold: number;
  public readonly totalParticipants: number;
  public readonly sessionId: string;

  private dkgNode: DKGParticipant;
  private myVssPackage?: SingleShotVssPackage;
  private secretPolynomial: bigint[] = [];

  constructor(params: {
    id: string;
    index: number | bigint;
    address: string;
    timezone: string;
    threshold: number;
    totalParticipants: number;
    /** 链上会话 ID：V2 起绑定进信箱密封 AAD，密封与解开必须一致。 */
    sessionId: string;
    identityKeypair?: IdentityKeypair;
  }) {
    this.id = params.id;
    this.index = BigInt(params.index);
    this.address = params.address;
    this.timezone = params.timezone;
    this.threshold = params.threshold;
    this.totalParticipants = params.totalParticipants;
    this.sessionId = params.sessionId;
    this.identityKeypair = params.identityKeypair ?? generateIdentityKeypair(params.address);

    this.dkgNode = new DKGParticipant(
      this.id,
      this.index,
      this.threshold,
      this.totalParticipants
    );
  }

  /**
   * 单阶段一键生成并广播投递包 (Single-Shot Async VSS Submission):
   * 无论对端成员是否在线，立即生成多项式承诺，并为每位成员加密生成信箱包裹
   */
  public async generateSingleShotPackage(
    roster: { id: string; index: bigint; address: string; publicKey: Uint8Array }[]
  ): Promise<SingleShotVssPackage> {
    // 1. 生成秘密多项式与承诺
    const r1 = this.dkgNode.round1();

    // 2. 注册已知对端索引
    for (const peer of roster) {
      if (peer.id !== this.id) {
        this.dkgNode.registerPeerIndex(peer.id, peer.index);
      }
    }

    // 3. 计算对端分片并使用接收方 X25519 预置公钥封装信箱密文
    const envelopes: MailboxEnvelope[] = [];
    const commitmentsHex = r1.commitmentBytes.map((b) => bytesToHex(b));

    for (const peer of roster) {
      if (peer.id === this.id) continue;

      const shareScalar = this.dkgNode.evaluateShareForIndex(peer.index);
      const payload: ShareDeliveryPayload = {
        fromIndex: Number(this.index),
        toIndex: Number(peer.index),
        round: 2,
        epoch: 1,
        secretShareHex: shareScalar.toString(16),
        commitmentsHex,
        senderAddress: this.address,
        recipientAddress: peer.address,
      };

      const env = await encryptMailboxShare({
        sessionId: this.sessionId,
        senderAddress: this.address,
        recipientAddress: peer.address,
        recipientPublicKey: peer.publicKey,
        payload,
        epoch: 1,
      });

      envelopes.push(env);
    }

    this.myVssPackage = {
      senderId: this.id,
      senderIndex: this.index,
      senderAddress: this.address,
      commitmentBytes: r1.commitmentBytes,
      envelopes,
    };

    return this.myVssPackage;
  }

  /**
   * 无论何时登录，拉取链上所有已发布的投递包，解密信箱分片，同态校验并计算私钥份额与主公钥
   */
  public async consumeMailboxAndFinalize(
    allPackagesOnChain: SingleShotVssPackage[]
  ): Promise<DKGFinalResult> {
    // 1. 提取所有有效发布者的承诺包
    const round1Outputs = allPackagesOnChain.map((pkg) => ({
      senderId: pkg.senderId,
      senderIndex: pkg.senderIndex,
      commitments: pkg.commitmentBytes.map((b) => ed25519.Point.fromHex(bytesToHex(b))),
      commitmentBytes: pkg.commitmentBytes,
    }));

    this.dkgNode.receiveRound1Packages(round1Outputs);

    // 2. 检索针对自己的信箱分片并解密
    const incomingShares = new Map<string, bigint>();

    for (const pkg of allPackagesOnChain) {
      if (pkg.senderId === this.id) {
        // 自己对自己的份额
        const selfShare = this.dkgNode.evaluateShareForIndex(this.index);
        incomingShares.set(this.id, selfShare);
      } else {
        // 查找属于当前节点的信封
        const envelope = pkg.envelopes.find(
          (env) => env.recipientAddress === this.address
        );
        if (!envelope) {
          throw new Error(
            `[${this.id}] Missing mailbox envelope from sender ${pkg.senderId}`
          );
        }

        const payload = await decryptMailboxShare(
          envelope,
          this.identityKeypair.secretKey,
          { sessionId: this.sessionId }
        );
        const shareScalar = BigInt(`0x${payload.secretShareHex}`);

        incomingShares.set(pkg.senderId, shareScalar);
      }
    }

    // 3. 执行 VSS 校验与最终私钥份额聚合
    if (this.myVssPackage) {
      return this.dkgNode.finalize(incomingShares);
    }

    // 若当前节点此前完全离线 (未曾作为发布者生成多项式)，直接根据链上承诺与信箱分片聚合
    let aggregateShare = 0n;
    let groupPublicKeyPoint = ed25519.Point.ZERO;

    for (const pkg of allPackagesOnChain) {
      const share = incomingShares.get(pkg.senderId);
      if (share === undefined) {
        throw new Error(`[${this.id}] Missing share from publisher ${pkg.senderId}`);
      }

      const peerCommitments = pkg.commitmentBytes.map((b) =>
        ed25519.Point.fromHex(bytesToHex(b))
      );
      const valid = verifyShareCommitment(share, this.index, peerCommitments);
      if (!valid) {
        throw new Error(
          `[${this.id}] VSS Verification failed for mailbox share from ${pkg.senderId}`
        );
      }

      aggregateShare = mod(aggregateShare + share);
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
