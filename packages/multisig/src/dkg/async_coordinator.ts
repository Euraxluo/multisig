import { ed25519 } from '@noble/curves/ed25519.js';
import { mod } from './math';
import { Point, verifyShareCommitment } from './vss';
import { DKGParticipant, Round1Output, DKGFinalResult } from './ceremony';
import {
  IdentityKeypair,
  MailboxEnvelope,
  ShareDeliveryPayload,
  generateIdentityKeypair,
  encryptMailboxShare,
  decryptMailboxShare,
  hexToBytes,
  bytesToHex,
} from './mailbox';

export interface AsyncParticipantInfo {
  id: string;
  index: bigint;
  address: string;
  identityKeypair: IdentityKeypair;
  isOnline: boolean;
}

export interface AsyncSessionState {
  sessionId: string;
  threshold: number;
  totalParticipants: number;
  participantIds: string[];
  deadlineTimestampMs: number;
  status: 'ROUND_1_COMMITMENTS' | 'ROUND_2_MAILBOX' | 'FINALIZED' | 'TIMED_OUT';
  commitments: Map<string, Round1Output>;
  mailboxes: Map<string, MailboxEnvelope[]>; // recipientAddress -> envelopes
  confirmations: Set<string>;
  finalPublicKey?: Uint8Array;
  finalPublicKeyHex?: string;
  epoch: number;
}

/**
 * 异步跨时区 DKG 协调器
 * 支持离线成员 (HPKE/X25519 密态信箱)、法定人数门限激活 (无需全员在线)、超时保护
 */
export class AsyncDkgCoordinator {
  private participants: Map<string, AsyncParticipantInfo> = new Map();
  private dkgNodes: Map<string, DKGParticipant> = new Map();
  private session?: AsyncSessionState;

  /**
   * 注册参与方身份 (包含 X25519 预置公钥与 Sui 地址)
   */
  public registerParticipant(
    id: string,
    index: number | bigint,
    address: string,
    isOnline: boolean = true,
    customKeypair?: IdentityKeypair
  ): AsyncParticipantInfo {
    const identityKeypair = customKeypair ?? generateIdentityKeypair(address);
    const info: AsyncParticipantInfo = {
      id,
      index: BigInt(index),
      address,
      identityKeypair,
      isOnline,
    };
    this.participants.set(id, info);
    return info;
  }

  /**
   * 设置参与者在线状态 (模拟用户离线/飞行模式/休眠)
   */
  public setParticipantOnline(id: string, isOnline: boolean) {
    const p = this.participants.get(id);
    if (p) {
      p.isOnline = isOnline;
    }
  }

  /**
   * 初始化异步 DKG 仪式会话
   */
  public initSession(params: {
    sessionId: string;
    threshold: number;
    participantIds: string[];
    deadlineTimestampMs: number;
  }): AsyncSessionState {
    const { sessionId, threshold, participantIds, deadlineTimestampMs } = params;

    // 初始化各个节点的 DKG 引擎
    this.dkgNodes.clear();
    for (const pid of participantIds) {
      const p = this.participants.get(pid);
      if (!p) throw new Error(`Participant not found: ${pid}`);
      const node = new DKGParticipant(pid, p.index, threshold, participantIds.length);
      for (const otherId of participantIds) {
        if (otherId !== pid) {
          const other = this.participants.get(otherId);
          if (other) {
            node.registerPeerIndex(otherId, other.index);
          }
        }
      }
      this.dkgNodes.set(pid, node);
    }

    this.session = {
      sessionId,
      threshold,
      totalParticipants: participantIds.length,
      participantIds,
      deadlineTimestampMs,
      status: 'ROUND_1_COMMITMENTS',
      commitments: new Map(),
      mailboxes: new Map(),
      confirmations: new Set(),
      epoch: 1,
    };

    return this.session;
  }

  /**
   * 参与者异步提交 Round 1 承诺
   */
  public submitRound1(participantId: string): Round1Output {
    if (!this.session) throw new Error('No active session');
    if (this.session.status !== 'ROUND_1_COMMITMENTS' && this.session.status !== 'ROUND_2_MAILBOX') {
      throw new Error(`Invalid session status: ${this.session.status}`);
    }

    const node = this.dkgNodes.get(participantId);
    if (!node) throw new Error(`Node not found: ${participantId}`);

    const r1 = node.round1();
    this.session.commitments.set(participantId, r1);

    // 检查是否达到 Round 1 法定人数
    if (this.session.commitments.size >= this.session.threshold) {
      this.session.status = 'ROUND_2_MAILBOX';
    }

    return r1;
  }

  /**
   * 广播 Round 1 承诺给各节点
   */
  public distributeRound1Commitments() {
    if (!this.session) throw new Error('No active session');
    const allCommitments = Array.from(this.session.commitments.values());
    for (const node of this.dkgNodes.values()) {
      node.receiveRound1Packages(allCommitments);
    }
  }

  /**
   * 在线节点生成 Round 2 分片：
   * - 对在线成员：直接交换
   * - 对离线成员：使用离线成员的 X25519 公钥加密，存入其链上密态信箱！
   */
  public async processRound2Shares(senderId: string): Promise<{
    directShares: Map<string, bigint>;
    depositedEnvelopes: MailboxEnvelope[];
  }> {
    if (!this.session) throw new Error('No active session');
    const sender = this.participants.get(senderId);
    const node = this.dkgNodes.get(senderId);
    if (!sender || !node) throw new Error(`Sender not found: ${senderId}`);

    const rawShares = node.round2();
    const directShares = new Map<string, bigint>();
    const depositedEnvelopes: MailboxEnvelope[] = [];

    const senderCommitments = this.session.commitments.get(senderId)?.commitments || [];
    const commitmentsHex = senderCommitments.map((c) => bytesToHex(c.toBytes()));

    for (const [targetId, shareScalar] of rawShares.entries()) {
      const target = this.participants.get(targetId);
      if (!target) continue;

      if (target.isOnline) {
        // 在线成员直接接收
        directShares.set(targetId, shareScalar);
      } else {
        // 离线成员：封入密态信箱 (HPKE / ECIES with AES-256-GCM)
        const payload: ShareDeliveryPayload = {
          fromIndex: Number(sender.index),
          toIndex: Number(target.index),
          round: 2,
          epoch: this.session.epoch,
          secretShareHex: shareScalar.toString(16),
          commitmentsHex,
          senderAddress: sender.address,
          recipientAddress: target.address,
        };

        const envelope = await encryptMailboxShare({
          sessionId: this.session.sessionId,
          senderAddress: sender.address,
          recipientAddress: target.address,
          recipientPublicKey: target.identityKeypair.publicKey,
          payload,
          epoch: this.session.epoch,
        });

        depositedEnvelopes.push(envelope);

        // 存入协调器/链上信箱
        const existing = this.session.mailboxes.get(target.address) || [];
        existing.push(envelope);
        this.session.mailboxes.set(target.address, existing);
      }
    }

    return { directShares, depositedEnvelopes };
  }

  /**
   * 成员异步确认已收到分片 (Round 2 Confirmation)
   */
  public confirmParticipant(participantId: string): {
    confirmedCount: number;
    threshold: number;
    canFinalize: boolean;
  } {
    if (!this.session) throw new Error('No active session');
    this.session.confirmations.add(participantId);
    const confirmedCount = this.session.confirmations.size;
    const canFinalize = confirmedCount >= this.session.threshold;
    return {
      confirmedCount,
      threshold: this.session.threshold,
      canFinalize,
    };
  }

  /**
   * 法定人数达成后，一键固化并激活主公钥！
   * 关键特性：即使有成员离线（如 David 离线），只要确认数达到 threshold，即可完成激活！
   */
  public finalizeSession(onlineSharesMap: Map<string, Map<string, bigint>>): {
    groupPublicKey: Uint8Array;
    groupPublicKeyHex: string;
    epoch: number;
    finalizedResults: Map<string, DKGFinalResult>;
  } {
    if (!this.session) throw new Error('No active session');
    if (this.session.confirmations.size < this.session.threshold) {
      throw new Error(
        `Quorum not reached. Confirmed: ${this.session.confirmations.size}, Threshold: ${this.session.threshold}`
      );
    }

    const finalizedResults = new Map<string, DKGFinalResult>();
    let groupPk: Uint8Array | undefined;
    let groupPkHex: string | undefined;

    // 为所有已在线确认的成员计算并验证最终私钥分片与群公钥
    for (const pid of this.session.confirmations) {
      const node = this.dkgNodes.get(pid);
      if (!node) continue;
      const received = onlineSharesMap.get(pid);
      if (!received) continue;

      const result = node.finalize(received);
      finalizedResults.set(pid, result);
      groupPk = result.groupPublicKey;
      groupPkHex = result.groupPublicKeyHex;
    }

    if (!groupPk || !groupPkHex) {
      throw new Error('Failed to finalize group public key');
    }

    this.session.status = 'FINALIZED';
    this.session.finalPublicKey = groupPk;
    this.session.finalPublicKeyHex = groupPkHex;

    return {
      groupPublicKey: groupPk,
      groupPublicKeyHex: groupPkHex,
      epoch: this.session.epoch,
      finalizedResults,
    };
  }

  /**
   * 离线成员上线唤醒：从信箱中提取密态分片，解密并同步计算自身私钥分片
   */
  public async offlineParticipantWakeupAndSync(
    participantId: string,
    allPeerCommitments: Map<string, Point[]>
  ): Promise<DKGFinalResult> {
    if (!this.session) throw new Error('No active session');
    const participant = this.participants.get(participantId);
    if (!participant) throw new Error(`Participant not found: ${participantId}`);

    // 从信箱取出加密包裹
    const envelopes = this.session.mailboxes.get(participant.address) || [];
    if (envelopes.length === 0) {
      throw new Error(`No mailbox envelopes found for ${participant.address}`);
    }

    // 解密所有寄来的秘密分片
    const decryptedShares = new Map<string, bigint>();
    for (const env of envelopes) {
      const payload = await decryptMailboxShare(env, participant.identityKeypair.secretKey, { sessionId: this.session.sessionId });
      const shareScalar = BigInt(`0x${payload.secretShareHex}`);

      // 验证 VSS 承诺
      const senderInfo = Array.from(this.participants.values()).find(
        (p) => p.address === payload.senderAddress
      );
      if (senderInfo) {
        const peerCommitments = allPeerCommitments.get(senderInfo.id);
        if (peerCommitments) {
          const valid = verifyShareCommitment(shareScalar, participant.index, peerCommitments);
          if (!valid) {
            throw new Error(`Mailbox share verification failed from sender ${senderInfo.id}`);
          }
        }
        decryptedShares.set(senderInfo.id, shareScalar);
      }
    }

    // 累加计算该离线成员的最终聚合私钥分片
    let aggregateShare = 0n;
    for (const share of decryptedShares.values()) {
      aggregateShare = mod(aggregateShare + share);
    }

    return {
      participantId,
      participantIndex: participant.index,
      privateShare: aggregateShare,
      groupPublicKey: this.session.finalPublicKey!,
      groupPublicKeyHex: this.session.finalPublicKeyHex!,
    };
  }

  public getSession(): AsyncSessionState | undefined {
    return this.session;
  }
}
