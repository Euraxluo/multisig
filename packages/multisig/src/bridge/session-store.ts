/**
 * FROST 会话 nonce 存储接口与内存实现。
 *
 * nonce 单次消费是签名安全的硬约束：`consume` 必须在签名份额计算前完成
 * 持久化提交。宿主应用负责提供生产存储（如 IndexedDB）以及设备密钥库；
 * 记录状态迁移逻辑由本模块导出，保证不同实现共享同一套不变量。
 */
import type { SealedSecretBox } from './device-vault';
import type { FrostRequest, FrostRound1, FrostRound2, FrostTranscript } from './frost-session';

/**
 * 持久化的 nonce 材料：新记录只存设备密钥库密封盒；旧版明文形状仍可读取，
 * 以便密封上线前写入的记录仍能恰好消费一次。
 */
export type FrostNonceMaterial =
  | { hiding: Uint8Array; binding: Uint8Array }
  | { sealed: SealedSecretBox };

/** 可公开的恢复数据。秘密 nonce 存在独立对象库。 */
export interface FrostSessionRecord {
  request: FrostRequest;
  round1: FrostRound1[];
  transcript?: FrostTranscript;
  round2: FrostRound2[];
  updatedAtMs: number;
}

export interface FrostNonceRecord {
  id: string;
  round1: FrostRound1;
  nonces?: FrostNonceMaterial;
  consumed: boolean;
  transcriptHash?: string;
  round2?: FrostRound2;
}

export interface BurnedFrostNonce { nonces: FrostNonceMaterial }

export type FrostNonceConsumption =
  | { kind: 'fresh'; nonces: FrostNonceMaterial }
  | { kind: 'cached'; round2: FrostRound2 };

/** 所有变更只在提交后 resolve。调用方回调不在存储事务内运行。 */
export interface FrostSessionStore {
  prepare(record: FrostNonceRecord): Promise<FrostRound1>;
  publishRound1(id: string, round1: FrostRound1): Promise<FrostRound1>;
  consume(id: string, round1: FrostRound1, transcriptHash: string): Promise<FrostNonceConsumption>;
  saveRound2(id: string, round2: FrostRound2): Promise<void>;
  remember(record: FrostSessionRecord): Promise<void>;
  restore(requestId: string): Promise<FrostSessionRecord | null>;
  list(): Promise<FrostSessionRecord[]>;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
const clone = <T>(value: T): T => structuredClone(value);
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const unsigned = <T extends { signature: string }>(value: T) => ({ ...value, signature: '' });

/** 首次准备 nonce：同 id 重试返回已有记录；已消费/缺 nonce 的记录拒绝。 */
export function prepareNonceRecord(existing: FrostNonceRecord | undefined, candidate: FrostNonceRecord): FrostNonceRecord {
  if (existing) {
    if (existing.round1.requestId !== candidate.round1.requestId || existing.round1.contextHash !== candidate.round1.contextHash || existing.round1.address !== candidate.round1.address || existing.round1.index !== candidate.round1.index) throw new Error('FROST nonce context conflict');
    return existing;
  }
  if (candidate.consumed || !candidate.nonces || candidate.round2 || candidate.transcriptHash) throw new Error('Invalid prepared FROST nonce');
  return clone(candidate);
}

/** 发布已签名承诺：只允许对已准备记录做签名补全或幂等重放。 */
export function publishRound1Record(existing: FrostNonceRecord | undefined, round1: FrostRound1): FrostNonceRecord {
  if (!existing || !same(existing.round1, round1) && (!same(unsigned(existing.round1), unsigned(round1)) || (existing.round1.signature && existing.round1.signature !== round1.signature))) throw new Error('FROST commitment does not match prepared nonce');
  return { ...existing, round1: clone(round1) };
}

/** 单次消费：返回秘密 nonce 或已缓存的 round 2；消费标记由调用方持久化。 */
export function consumeNonceRecord(existing: FrostNonceRecord | undefined, round1: FrostRound1, transcriptHash: string): { record: FrostNonceRecord; result: FrostNonceConsumption } {
  if (!existing || !same(existing.round1, round1)) throw new Error('Missing or conflicting local FROST commitment');
  if (existing.consumed) {
    if (existing.transcriptHash !== transcriptHash) throw new Error('FROST nonce already consumed for another transcript');
    if (!existing.round2) throw new Error('FROST nonce permanently consumed; start a new request');
    return { record: existing, result: { kind: 'cached', round2: clone(existing.round2) } };
  }
  if (!existing.nonces) throw new Error('Missing FROST secret nonce');
  const nonces = clone(existing.nonces);
  const record: FrostNonceRecord = { id: existing.id, round1: clone(existing.round1), consumed: true, transcriptHash };
  return { record, result: { kind: 'fresh', nonces } };
}

/** 保存 round 2：必须匹配已消费 nonce 的签名者、请求与 transcript。 */
export function withRound2Share(existing: FrostNonceRecord | undefined, round2: FrostRound2): FrostNonceRecord {
  if (!existing?.consumed || existing.transcriptHash !== round2.transcriptHash || existing.round1.requestId !== round2.requestId || existing.round1.contextHash !== round2.contextHash || existing.round1.address !== round2.address || existing.round1.index !== round2.index) throw new Error('FROST share does not match consumed nonce');
  if (existing.round2 && (!same(unsigned(existing.round2), unsigned(round2)) || (existing.round2.signature && existing.round2.signature !== round2.signature))) throw new Error('Conflicting FROST signature share');
  return { ...existing, round2: clone(round2) };
}

/** 合并公开恢复记录：请求/转录必须一致，round 按签名者索引合并去重。 */
export function mergeSessionRecord(existing: FrostSessionRecord | undefined, incoming: FrostSessionRecord): FrostSessionRecord {
  if (existing && !same(existing.request, incoming.request)) throw new Error('Conflicting FROST request recovery record');
  if (existing?.transcript && incoming.transcript && !same(existing.transcript, incoming.transcript)) throw new Error('Conflicting FROST transcript recovery record');
  function merge<T extends { index: string; signature: string }>(a: T[], b: T[]): T[] {
    const records = new Map(a.map(value => [value.index, value]));
    for (const value of b) {
      const prior = records.get(value.index);
      if (prior && !same(prior, value)) {
        if (!same(unsigned(prior), unsigned(value)) || (prior.signature && value.signature && prior.signature !== value.signature)) throw new Error('Conflicting FROST round recovery record');
      }
      records.set(value.index, prior?.signature ? prior : value);
    }
    return [...records.values()].sort((x, y) => Number(BigInt(x.index) - BigInt(y.index)));
  }
  return clone({ request: incoming.request, round1: merge(existing?.round1 ?? [], incoming.round1), round2: merge(existing?.round2 ?? [], incoming.round2), ...(incoming.transcript ?? existing?.transcript ? { transcript: incoming.transcript ?? existing?.transcript } : {}), updatedAtMs: Math.max(existing?.updatedAtMs ?? 0, incoming.updatedAtMs) });
}

/** 测试/Node 用内存实现；生产实现必须提供同等的事务语义。 */
export function createMemoryFrostSessionStore(): FrostSessionStore {
  const nonces = new Map<string, FrostNonceRecord>();
  const sessions = new Map<string, FrostSessionRecord>();
  return {
    async prepare(candidate) {
      const record = prepareNonceRecord(nonces.get(candidate.id), candidate);
      nonces.set(candidate.id, record);
      return clone(record.round1);
    },
    async publishRound1(id, round1) {
      const record = publishRound1Record(nonces.get(id), round1);
      nonces.set(id, record);
      return clone(round1);
    },
    async consume(id, round1, transcriptHash) {
      const { record, result } = consumeNonceRecord(nonces.get(id), round1, transcriptHash);
      nonces.set(id, record);
      return result;
    },
    async saveRound2(id, round2) { nonces.set(id, withRound2Share(nonces.get(id), round2)); },
    async remember(record) { sessions.set(record.request.requestId, mergeSessionRecord(sessions.get(record.request.requestId), record)); },
    async restore(requestId) { return clone(sessions.get(requestId) ?? null); },
    async list() { return clone([...sessions.values()].sort((a, b) => b.updatedAtMs - a.updatedAtMs)); },
  };
}
