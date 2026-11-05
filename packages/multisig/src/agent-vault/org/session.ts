/**
 * ThresholdProposalSession —— 门限提案会话（SDK 场景 A1 的核心抽象）。
 *
 * 六态生命周期：create（读链取 nonce/群公钥）→ draft（构造 payload+摘要）→
 * sign（可插拔收集 t 份分片签名并聚合）→ buildPTB（任何人可提交）→
 * execute（调用方签名上链）→ verifyExecution（事件断言）。
 *
 * 签名收集是传输可插拔的：默认 LocalMemoryShareProvider 仅用进程内分片
 * （测试/单机演练）；生产必须接设备密封库 + 真实多设备传输（frost-private-
 * transport E2E 仍是 GAP，见 docs/BOOTSTRAP_PRODUCTION_RUNBOOK.md）。
 * 分片永远不落明文盘——这是硬约束。
 */
import { Transaction } from '@mysten/sui/transactions';
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import { normalizeStructTag } from '@mysten/sui/utils';
import { ed25519 } from '@noble/curves/ed25519.js';
import { ThresholdSignerNode, type NonceCommitment, type SignatureShare } from '../../dkg/threshold_signer';
import {
  AGENT_VAULT_PACKAGE_ID,
  GOVERNANCE_EVENTS,
} from './constants';
import {
  computeKeyRotationDigest,
  computeProposalDigest,
  computeRosterUpdateDigest,
  computeThresholdApprovalDigest,
} from './digest';
import { BcsReader, bytesToHex, canonicalAddress, u64le } from './bcs';
import {
  buildAdvanceEpochPTB,
  buildExecuteThresholdProposalPTB,
  buildRotateGroupKeyPTB,
  buildUpdateRosterPTB,
} from './builders';
import { readOrganization, type OrganizationSnapshot } from './reader';

/** 单个成员的签名材料（privateShare 只在内存/密封库中流转）。 */
export interface SessionShareMaterial {
  id: string;
  participantIndex: number | bigint;
  privateShare: bigint;
}

/** 成员侧本地验签：聚合签名前先独立验证 64 字节 FROST 签名（不烧 nonce 的预检）。 */
export function verifyFrostSignature(message: Uint8Array, signature: Uint8Array, groupPublicKey: Uint8Array): boolean {
  try {
    return signature.length === 64 && groupPublicKey.length === 32 && ed25519.verify(signature, message, groupPublicKey);
  } catch {
    return false;
  }
}

export interface CollectedThresholdSignatures {
  nonces: NonceCommitment[];
  shares: SignatureShare[];
}

/** 可插拔签名收集传输。多设备生产实现：设备密封库 + 私有传输。 */
export interface SessionShareProvider {
  collect(input: { digest: Uint8Array; groupPublicKey: Uint8Array }): Promise<CollectedThresholdSignatures>;
}

/** 单机实现（测试/彩排）：分片仅存内存，nonce 单次使用防重放。 */
export class LocalMemoryShareProvider implements SessionShareProvider {
  private readonly material: SessionShareMaterial[];

  constructor(material: SessionShareMaterial[]) {
    if (material.length === 0) throw new Error('至少需要一份分片');
    this.material = material.map((m) => ({ ...m }));
  }

  async collect({ digest, groupPublicKey }: { digest: Uint8Array; groupPublicKey: Uint8Array }): Promise<CollectedThresholdSignatures> {
    const nodes = this.material.map((m) => new ThresholdSignerNode(m.id, m.participantIndex, m.privateShare));
    const nonces = nodes.map((n) => n.generateNonceCommitment());
    const shares = nodes.map((n) => n.computeSignatureShare(digest, groupPublicKey, nonces));
    return { nonces, shares };
  }
}

export type SessionAction =
  | { kind: 'execute'; payload: Uint8Array; actionType: number }
  | { kind: 'advanceEpoch' }
  | { kind: 'rotateKey'; newGroupPk: Uint8Array }
  | {
      kind: 'roster';
      priorMembers: string[];
      newMembers: string[];
      newWeights: Array<number | bigint>;
      newThresholdWeight: number | bigint;
    };

export interface SessionOptions {
  client: SuiGrpcClient;
  orgId: string;
  action: SessionAction;
  /** 调用目标包（默认现行包）。 */
  packageId?: string;
  /** 组织签名域；显式提供时必须与快照 chain_id 完全相同。 */
  chainId?: string;
}

export interface ExecutionVerification {
  success: boolean;
  /** ProposalExecutedEvent.proposal_hash 是否与本会话摘要一致（execute 类动作）。 */
  digestMatched: boolean | null;
  matchedEvents: string[];
  failures: string[];
}

type DerivedAction = {
  payload?: Uint8Array;
  actionType?: number;
  digest: Uint8Array;
  buildPTB: (frostSignature: Uint8Array) => Transaction;
  expectedEvents: string[];
};

function copyAction(action: SessionAction): SessionAction {
  switch (action.kind) {
    case 'execute': return { ...action, payload: Uint8Array.from(action.payload) };
    case 'rotateKey': return { ...action, newGroupPk: Uint8Array.from(action.newGroupPk) };
    case 'roster': return {
      ...action, priorMembers: [...action.priorMembers], newMembers: [...action.newMembers], newWeights: [...action.newWeights],
    };
    default: return { ...action };
  }
}

function copySnapshot(snapshot: OrganizationSnapshot): OrganizationSnapshot {
  return { ...snapshot, groupPk: Uint8Array.from(snapshot.groupPk) };
}

export class ThresholdProposalSession {
  private frostSignature: Uint8Array | null = null;
  private signing = false;
  private invalidated = false;

  private constructor(
    private readonly signedSnapshot: OrganizationSnapshot,
    private readonly signedAction: SessionAction,
    public readonly nonce: bigint,
    private readonly derived: DerivedAction,
    private readonly packageId: string,
    private readonly client: SuiGrpcClient | null,
    public readonly chainId: string,
  ) {}

  /** 读链创建会话：nonce = last_nonce + 1，摘要按组织当前 epoch/chain_id 绑定。 */
  static async create(opts: SessionOptions): Promise<ThresholdProposalSession> {
    const snapshot = await readOrganization(opts.client, opts.orgId, opts.packageId);
    return ThresholdProposalSession.fromSnapshot({ snapshot, ...opts, client: opts.client });
  }

  /** 用已知快照创建（离线测试 / 刚读过链不想重复读）。 */
  static fromSnapshot(
    opts: { snapshot: OrganizationSnapshot; action: SessionAction; packageId?: string; chainId?: string; client?: SuiGrpcClient },
  ): ThresholdProposalSession {
    const snapshot = copySnapshot(opts.snapshot);
    const action = copyAction(opts.action);
    const chainId = opts.chainId ?? snapshot.chainId;
    if (chainId !== snapshot.chainId) throw new Error('chainId 与组织签名域不符');
    const nonce = snapshot.lastNonce + 1n;
    if (snapshot.nextNonce !== nonce) throw new Error('快照 nextNonce 与 lastNonce 不一致');
    u64le(nonce);
    u64le(snapshot.epochVersion);
    if (action.kind === 'advanceEpoch' || action.kind === 'rotateKey' || action.kind === 'roster') {
      u64le(snapshot.epochVersion + 1n);
    }
    if (snapshot.groupPk.length !== 32) throw new Error('组织群公钥必须为 32 字节');
    const base = { chainId, orgId: snapshot.id, epochVersion: snapshot.epochVersion, nonce };
    const packageId = canonicalAddress(opts.packageId ?? AGENT_VAULT_PACKAGE_ID);

    let derived: DerivedAction;
    switch (action.kind) {
      case 'execute': {
        const digest = computeProposalDigest({ ...base, payload: action.payload });
        derived = {
          payload: action.payload,
          actionType: action.actionType,
          digest,
          expectedEvents: [GOVERNANCE_EVENTS.proposalExecuted],
          buildPTB: (sig) =>
            buildExecuteThresholdProposalPTB({
              packageId,
              orgId: snapshot.id,
              nonce,
              payload: action.payload,
              frostSignature: sig,
              actionType: action.actionType,
            }),
        };
        break;
      }
      case 'advanceEpoch': {
        const digest = computeThresholdApprovalDigest({ ...base, newEpochVersion: snapshot.epochVersion + 1n });
        derived = {
          digest,
          expectedEvents: [GOVERNANCE_EVENTS.organizationEpochUpdated],
          buildPTB: (sig) => buildAdvanceEpochPTB({ packageId, orgId: snapshot.id, nonce, frostSignature: sig }),
        };
        break;
      }
      case 'rotateKey': {
        const digest = computeKeyRotationDigest({ ...base, newGroupPk: action.newGroupPk });
        derived = {
          digest,
          expectedEvents: [GOVERNANCE_EVENTS.groupKeyRotated],
          buildPTB: (sig) =>
            buildRotateGroupKeyPTB({ packageId, orgId: snapshot.id, nonce, newGroupPk: action.newGroupPk, frostSignature: sig }),
        };
        break;
      }
      case 'roster': {
        const digest = computeRosterUpdateDigest({
          ...base,
          newEpochVersion: snapshot.epochVersion + 1n,
          thresholdWeight: action.newThresholdWeight,
          newMembers: action.newMembers,
          newWeights: action.newWeights,
        });
        derived = {
          digest,
          expectedEvents: [GOVERNANCE_EVENTS.rosterUpdated],
          buildPTB: (sig) =>
            buildUpdateRosterPTB({
              packageId,
              orgId: snapshot.id,
              nonce,
              priorMembers: action.priorMembers,
              newMembers: action.newMembers,
              newWeights: action.newWeights,
              newThresholdWeight: action.newThresholdWeight,
              frostSignature: sig,
            }),
        };
        break;
      }
    }

    return new ThresholdProposalSession(snapshot, action, nonce, derived, packageId, opts.client ?? null, chainId);
  }

  /** 返回独立副本，调用方不能更改签名绑定的状态。 */
  get snapshot(): OrganizationSnapshot { return copySnapshot(this.signedSnapshot); }
  get action(): SessionAction { return copyAction(this.signedAction); }

  /** 链下可验的提案摘要（成员本地重算比对一致后才签名）。 */
  get proposalDigest(): Uint8Array {
    return Uint8Array.from(this.derived.digest);
  }

  get proposalDigestHex(): string {
    return '0x' + bytesToHex(this.derived.digest);
  }

  get isSigned(): boolean {
    return this.frostSignature !== null;
  }

  /** 收集 t 份分片并聚合为 64 字节 FROST 门限签名。 */
  async sign(provider: SessionShareProvider): Promise<Uint8Array> {
    if (this.invalidated) throw new Error('会话已失效，必须新建会话');
    if (this.frostSignature) throw new Error('会话已签名；换提案请新建会话（nonce 单调燃烧）');
    if (this.signing) throw new Error('会话正在收集签名');
    this.signing = true;
    try {
      const collected = await provider.collect({ digest: this.proposalDigest, groupPublicKey: Uint8Array.from(this.signedSnapshot.groupPk) });
      if (this.invalidated) throw new Error('会话已失效，必须新建会话');
      const signature = ThresholdSignerNode.aggregateSignature(collected.nonces, collected.shares);
      if (!verifyFrostSignature(this.derived.digest, signature, this.signedSnapshot.groupPk)) {
        throw new Error('FROST 聚合签名未通过组织群公钥验证');
      }
      this.frostSignature = Uint8Array.from(signature);
      return Uint8Array.from(signature);
    } finally {
      this.signing = false;
    }
  }

  /** 构造执行 PTB（聚合签名后任何人可提交；execute_threshold_proposal 不校验 sender）。 */
  buildPTB(): Transaction {
    if (this.invalidated) throw new Error('会话已失效，必须新建会话');
    if (!this.frostSignature) throw new Error('先 sign() 再 buildPTB()');
    return this.derived.buildPTB(this.frostSignature);
  }

  /**
   * 提交前重读组织：签名域、公钥、nonce 或 epoch 漂移时作废会话及既有签名。
   * 快照保持不变，调用方必须根据新链上状态重建会话。
   */
  async refresh(): Promise<{ changed: boolean }> {
    if (!this.client) throw new Error('本会话无 client（fromSnapshot 离线构造），请重建会话');
    const latest = await readOrganization(this.client, this.signedSnapshot.id, this.packageId);
    const changed = latest.lastNonce !== this.signedSnapshot.lastNonce || latest.epochVersion !== this.signedSnapshot.epochVersion
      || latest.chainId !== this.signedSnapshot.chainId || bytesToHex(latest.groupPk) !== bytesToHex(this.signedSnapshot.groupPk);
    if (changed) {
      const wasSigned = this.frostSignature !== null;
      this.invalidated = true;
      this.frostSignature = null;
      if (wasSigned) throw new Error('链上签名状态已漂移：必须丢弃签名并新建会话');
    }
    return { changed };
  }

  /** 上链后核验实际 gRPC 状态、完整事件类型及 Move BCS 字段。 */
  async verifyExecution(txDigest: string): Promise<ExecutionVerification> {
    if (!this.client) throw new Error('本会话无 client，无法核验事件');
    const failures: string[] = [];
    const matched: string[] = [];
    let digestMatched: boolean | null = null;
    const res = await this.client.getTransaction({ digest: txDigest, include: { events: true, effects: true } });
    const tx = res.$kind === 'Transaction' ? res.Transaction : res.FailedTransaction;
    if (!tx || res.$kind !== 'Transaction' || tx.status?.success !== true || tx.effects?.status?.success !== true) {
      const error = tx?.status?.error ?? tx?.effects?.status?.error;
      return { success: false, digestMatched: null, matchedEvents: [], failures: [error?.message ?? '交易失败或缺少成功状态'] };
    }
    if (tx.digest !== txDigest || tx.effects.transactionDigest !== txDigest) {
      return { success: false, digestMatched: null, matchedEvents: [], failures: ['返回交易摘要与请求不符'] };
    }

    for (const expected of this.derived.expectedEvents) {
      const expectedType = normalizeStructTag(`${canonicalAddress(this.packageId)}::${expected}`);
      const events = (tx.events ?? []).filter((event) => {
        try {
          return normalizeStructTag(event.eventType) === expectedType;
        } catch { return false; }
      });
      const valid = events.some((event) => this.matchesEvent(expected, event.bcs));
      if (expected === GOVERNANCE_EVENTS.proposalExecuted && events.length > 0) {
        digestMatched = events.some((event) => {
          try {
            const r = new BcsReader(event.bcs);
            return r.address() === canonicalAddress(this.signedSnapshot.id) && bytesToHex(r.vector()) === bytesToHex(this.derived.digest);
          } catch { return false; }
        });
      }
      if (valid) matched.push(expected);
      else failures.push(events.length === 0 ? `缺少事件 ${expected}` : `事件 ${expected} 与会话字段不符或 BCS 无效`);
    }
    return { success: failures.length === 0, digestMatched, matchedEvents: matched, failures };
  }

  private matchesEvent(expected: string, bytes: Uint8Array): boolean {
    try {
      const r = new BcsReader(bytes);
      const action = this.signedAction;
      const orgId = canonicalAddress(this.signedSnapshot.id);
      const nextEpoch = this.signedSnapshot.epochVersion + 1n;
      const sameBytes = (a: Uint8Array, b: Uint8Array) => bytesToHex(a) === bytesToHex(b);
      let valid = false;
      switch (expected) {
        case GOVERNANCE_EVENTS.proposalExecuted:
          valid = r.address() === orgId && sameBytes(r.vector(), this.derived.digest)
            && r.u8() === this.derived.actionType && r.u64() === this.signedSnapshot.epochVersion;
          break;
        case GOVERNANCE_EVENTS.organizationEpochUpdated:
          valid = r.address() === orgId && r.u64() === nextEpoch;
          break;
        case GOVERNANCE_EVENTS.groupKeyRotated:
          valid = action.kind === 'rotateKey' && r.address() === orgId
            && sameBytes(r.vector(), this.signedSnapshot.groupPk) && sameBytes(r.vector(), action.newGroupPk) && r.u64() === nextEpoch;
          break;
        case GOVERNANCE_EVENTS.rosterUpdated: {
          if (action.kind !== 'roster' || r.address() !== orgId || r.uleb() !== action.newMembers.length) return false;
          if (!action.newMembers.every((member) => r.address() === canonicalAddress(member))) return false;
          if (r.uleb() !== action.newWeights.length || !action.newWeights.every((weight) => r.u64() === BigInt(weight))) return false;
          valid = r.u64() === BigInt(action.newThresholdWeight) && r.u64() === nextEpoch;
          break;
        }
      }
      return valid && r.remaining === 0;
    } catch { return false; }
  }
}
