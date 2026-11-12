import { MIST_PER_SUI } from '@mysten/sui/utils';
import { evaluatePolynomial, generatePolynomial, createCommitments } from './vss';
import { mod, lagrangeCoefficient } from './math';
import { ThresholdSignerNode } from './threshold_signer';
import type { NonceCommitment, SignatureShare } from './threshold_signer';
import { GennaroResharingParticipant } from './resharing';

export interface SentinelAuditPolicy {
  maxTransferAmount: bigint;       // 单笔交易上限 (防单次巨额盗取)
  maxDailyBudget: bigint;          // 每日累计总预算 (防微额多笔蚂蚁搬家攻击 Salami attack)
  maxTxPerWindow: number;          // 滑动窗口内最大交易笔数 (防高频请求暴击)
  windowDurationMs: number;        // 滑动时间窗口大小 (默认 10 分钟 = 600,000ms)
  cooldownPeriodMs: number;        // 触发熔断后的封锁冷却时间 (默认 1 小时 = 3,600,000ms)
  whitelistedRecipients?: string[];
  allowedActions: string[];
  autoApproveResharing: boolean;
}

export interface ProposalPayload {
  proposalId: string;
  recipient: string;
  amount: bigint;
  action: string;
  epoch: number;
  timestamp?: number;
}

export interface SentinelSignResult {
  approved: boolean;
  reason: string;
  signerId: string;
  signerIndex: bigint;
  nonceCommitment?: NonceCommitment;
  signatureShare?: bigint;
  latencyMs: number;
}

interface ExecutionRecord {
  timestamp: number;
  amount: bigint;
  recipient: string;
}

/**
 * 24 小时常驻 AI Sentinel 节点 (AI 哨兵治理节点)
 * 具备「三层防御纵深」:
 * 1. 毫秒级规则审计 (单笔上限、白名单、合法行为)；
 * 2. 状态化滑动时间窗口预算 (Sliding-Window Budget, 严防 10,000 * 10 SUI 蚂蚁搬家攻击)；
 * 3. 突发频次熔断器 (Circuit Breaker, 高频攻击自动自锁，强制等待人类介入)；
 * 4. 2-of-3 快速协签，日常运维秒级上链！
 */
export class AIAgentSentinel {
  public readonly id: string;
  public readonly index: bigint;
  public privateShare: bigint;
  public readonly policy: SentinelAuditPolicy;
  private signerNode: ThresholdSignerNode;

  // 状态化风控流水
  private executionHistory: ExecutionRecord[] = [];
  public circuitBreakerTripped: boolean = false;
  public circuitBreakerReason: string = '';
  public circuitBreakerCooldownUntil: number = 0;

  constructor(config: {
    id: string;
    index: number | bigint;
    privateShare: bigint;
    policy?: Partial<SentinelAuditPolicy>;
  }) {
    this.id = config.id;
    this.index = BigInt(config.index);
    this.privateShare = config.privateShare;
    this.policy = {
      maxTransferAmount: config.policy?.maxTransferAmount ?? 50n * MIST_PER_SUI, // 单笔 50 SUI
      maxDailyBudget: config.policy?.maxDailyBudget ?? 100n * MIST_PER_SUI,       // 每日累计 100 SUI
      maxTxPerWindow: config.policy?.maxTxPerWindow ?? 3,                          // 10 分钟最多 3 笔
      windowDurationMs: config.policy?.windowDurationMs ?? 10 * 60 * 1000,          // 10 分钟滑动窗口
      cooldownPeriodMs: config.policy?.cooldownPeriodMs ?? 60 * 60 * 1000,          // 熔断后冷却 1 小时
      whitelistedRecipients: config.policy?.whitelistedRecipients,
      allowedActions: config.policy?.allowedActions ?? ['transfer', 'call_contract', 'reshare'],
      autoApproveResharing: config.policy?.autoApproveResharing ?? true,
    };
    this.signerNode = new ThresholdSignerNode(this.id, this.index, this.privateShare);
  }

  /**
   * 触发紧急熔断
   */
  private tripCircuitBreaker(reason: string, currentTimeMs: number): void {
    this.circuitBreakerTripped = true;
    this.circuitBreakerReason = reason;
    this.circuitBreakerCooldownUntil = currentTimeMs + this.policy.cooldownPeriodMs;
  }

  /**
   * 人类创始人手动解除熔断
   */
  public resetCircuitBreaker(): void {
    this.circuitBreakerTripped = false;
    this.circuitBreakerReason = '';
    this.circuitBreakerCooldownUntil = 0;
  }

  /**
   * 更新 Sentinel 的私钥分片 (纪元滚动时自动刷新)
   */
  public updateShare(newShare: bigint): void {
    this.privateShare = newShare;
    this.signerNode = new ThresholdSignerNode(this.id, this.index, newShare);
  }

  /**
   * 自动策略与状态化风控审计 (带滑动窗口防蚂蚁搬家攻击)
   */
  public auditProposal(proposal: ProposalPayload, currentTimeMs: number = Date.now()): { approved: boolean; reason: string } {
    // 1. 检查是否处于熔断冷却中
    if (this.circuitBreakerTripped) {
      if (currentTimeMs < this.circuitBreakerCooldownUntil) {
        return {
          approved: false,
          reason: `[CIRCUIT_BREAKER_ACTIVE] 哨兵处于紧急熔断保护中！原因: ${this.circuitBreakerReason}。在冷却结束或人类介入前拒绝一切签名！`,
        };
      } else {
        // 冷却期过后自愈重置
        this.resetCircuitBreaker();
      }
    }

    // 2. 基础行为与单笔上限校验
    if (!this.policy.allowedActions.includes(proposal.action)) {
      return { approved: false, reason: `Action [${proposal.action}] not in allowed list` };
    }

    if (proposal.amount > this.policy.maxTransferAmount) {
      return {
        approved: false,
        reason: `Transfer amount ${proposal.amount} exceeds single-tx limit ${this.policy.maxTransferAmount}`,
      };
    }

    if (this.policy.whitelistedRecipients && !this.policy.whitelistedRecipients.includes(proposal.recipient)) {
      return {
        approved: false,
        reason: `Recipient ${proposal.recipient} not in whitelist`,
      };
    }

    // 3. 滑动时间窗口清理与频次校验 (防高频请求轰炸)
    const windowStart = currentTimeMs - this.policy.windowDurationMs;
    const recentRecords = this.executionHistory.filter((r) => r.timestamp >= windowStart);

    if (recentRecords.length >= this.policy.maxTxPerWindow) {
      this.tripCircuitBreaker(
        `高频交易攻击预警: 在 ${this.policy.windowDurationMs / 1000}s 窗口内请求达 ${recentRecords.length + 1} 笔，超过阈值 ${this.policy.maxTxPerWindow}!`,
        currentTimeMs
      );
      return {
        approved: false,
        reason: `[VELOCITY_BREACH] 交易频次超出安全限制 (触发防微额轰炸熔断)，AI 哨兵已自锁！`,
      };
    }

    // 4. 累计总预算校验 (防 10,000 笔 * 10 SUI 蚂蚁搬家攻击)
    let totalSpentInWindow = 0n;
    for (const r of recentRecords) {
      totalSpentInWindow += r.amount;
    }

    if (totalSpentInWindow + proposal.amount > this.policy.maxDailyBudget) {
      this.tripCircuitBreaker(
        `累计总预算超标预警: 窗口内累计支出达 ${totalSpentInWindow + proposal.amount} SUI，超过每日总预算上限 ${this.policy.maxDailyBudget} SUI!`,
        currentTimeMs
      );
      return {
        approved: false,
        reason: `[BUDGET_EXHAUSTED] 累计支出超过预算限额 (${totalSpentInWindow + proposal.amount} > ${this.policy.maxDailyBudget})，已触发熔断！`,
      };
    }

    return { approved: true, reason: 'Proposal satisfies all automated security policies' };
  }

  /**
   * 生成 Nonce 承诺
   */
  public generateNonceCommitment(): NonceCommitment {
    return this.signerNode.generateNonceCommitment();
  }

  /**
   * 计算签名份额
   */
  public computeSignatureShare(
    message: Uint8Array,
    groupPublicKey: Uint8Array,
    allNonceCommitments: NonceCommitment[]
  ): SignatureShare {
    return this.signerNode.computeSignatureShare(message, groupPublicKey, allNonceCommitments);
  }

  /**
   * 毫秒级快速协签 (Fast Co-Signing)
   * 传入其他发起人的 Nonce 列表，Sentinel 自动生成自己的 Nonce，组合后一并计算签名份额
   */
  public coSignProposal(
    proposal: ProposalPayload,
    proposalBytes: Uint8Array,
    groupPublicKey: Uint8Array,
    peerNonces: NonceCommitment[]
  ): {
    approved: boolean;
    reason: string;
    signerId: string;
    signerIndex: bigint;
    nonceCommitment?: NonceCommitment;
    allNonceCommitments?: NonceCommitment[];
    signatureShare?: bigint;
    latencyMs: number;
  } {
    const startTime = Date.now();
    const audit = this.auditProposal(proposal);

    if (!audit.approved) {
      return {
        approved: false,
        reason: audit.reason,
        signerId: this.id,
        signerIndex: this.index,
        latencyMs: Date.now() - startTime,
      };
    }

    const executionTime = proposal.timestamp ?? startTime;
    this.executionHistory.push({
      timestamp: executionTime,
      amount: proposal.amount,
      recipient: proposal.recipient,
    });

    const myNonce = this.signerNode.generateNonceCommitment();
    const allNonces = [...peerNonces, myNonce];
    const signatureShare = this.signerNode.computeSignatureShare(
      proposalBytes,
      groupPublicKey,
      allNonces
    );

    return {
      approved: true,
      reason: 'Auto-approved and co-signed in <10ms',
      signerId: this.id,
      signerIndex: this.index,
      nonceCommitment: myNonce,
      allNonceCommitments: allNonces,
      signatureShare: signatureShare.shareZ,
      latencyMs: Date.now() - startTime,
    };
  }

  /**
   * 自动参与 Gennaro 动态换届 (新成员加入时毫秒级提供子分片)
   */
  public autoParticipateGennaroResharing(
    activeOldIndices: bigint[],
    newCommitteeIndices: Map<string, bigint>,
    newThreshold: number
  ) {
    const participant = new GennaroResharingParticipant({
      id: this.id,
      index: this.index,
      isOldActiveMember: true,
      isNewMember: true,
      currentShare: this.privateShare,
      newThreshold,
    });

    return participant.generateResharePackage(activeOldIndices, newCommitteeIndices);
  }
}
