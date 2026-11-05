/**
 * dkg_committee 读取层：会话快照、承诺/确认/协签信箱条目、群公钥申报。
 *
 * 前端原先各自手写这套 BCS（repo C 的 lib/dkg-session.ts），一处漂移就会把
 * 「未提交」读成「全零承诺」。这里把契约收敛到 SDK 单一实现：断言的形状与
 * `dkg_committee.move` 逐字段对应，缺省一律返回 null 而不是空值。
 */
import { bcs } from '@mysten/sui/bcs';
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import { normalizeStructTag, normalizeSuiAddress, parseStructTag } from '@mysten/sui/utils';
import { AGENT_VAULT_PACKAGE_ID } from '../org/constants';
import { COMPRESSED_POINT_BYTES, DKG_MODULE, DKG_SESSION_STATUS } from './constants';

export { COMPRESSED_POINT_BYTES, DKG_MODULE, DKG_SESSION_STATUS };

const TableBcs = bcs.struct('Table', { id: bcs.Address, size: bcs.u64() });

/** DkgSession 的 BCS 布局（字段顺序与 move 结构体一致；Table 只留句柄与长度）。 */
export const DkgSessionBcs = bcs.struct('DkgSession', {
  id: bcs.Address,
  epoch: bcs.u64(),
  threshold: bcs.u64(),
  total_participants: bcs.u64(),
  participants: bcs.vector(bcs.Address),
  commitments: TableBcs,
  encrypted_mailboxes: TableBcs,
  confirmations: TableBcs,
  confirmations_count: bcs.u64(),
  deadline_timestamp_ms: bcs.u64(),
  status: bcs.u8(),
  final_public_key: bcs.vector(bcs.u8()),
});

/** 动态字段键：`GroupKeyAttestationSlot { participant }`。 */
export const GroupKeyAttestationSlotBcs = bcs.struct('GroupKeyAttestationSlot', { participant: bcs.Address });

/** 动态字段键：`EncryptionKeySlot { participant }`。 */
export const EncryptionKeySlotBcs = bcs.struct('EncryptionKeySlot', { participant: bcs.Address });

/** Table 复合键：`MailboxKey { sender, recipient }`。 */
export const MailboxKeyBcs = bcs.struct('MailboxKey', { sender: bcs.Address, recipient: bcs.Address });

export type DkgReadClient = Pick<SuiGrpcClient, 'getObject' | 'getDynamicField'>;
export interface DkgReadOptions { signal?: AbortSignal }

export interface DkgSessionSnapshot {
  sessionId: string;
  epoch: bigint;
  threshold: bigint;
  totalParticipants: bigint;
  participants: string[];
  /** 承诺表句柄与条目数。 */
  commitmentsTableId: string;
  commitmentCount: bigint;
  /** 加密信箱表句柄与条目数。 */
  mailboxTableId: string;
  mailboxCount: bigint;
  /** 确认表句柄与条目数（`confirmationsCount` 是合约自增的独立计数器）。 */
  confirmationsTableId: string;
  confirmationsTableSize: bigint;
  confirmationsCount: bigint;
  deadlineTimestampMs: bigint;
  status: number;
  finalPublicKey: Uint8Array;
}

function dkgTarget(packageId: string, name: string): string {
  return normalizeStructTag(`${normalizeSuiAddress(packageId)}::${DKG_MODULE}::${name}`);
}

/** 读会话快照；类型来源必须是配置的包（新包不能直接消费旧包类型）。 */
export async function readDkgSession(
  client: DkgReadClient,
  config: { sessionId: string; packageId?: string },
  options: DkgReadOptions = {},
): Promise<DkgSessionSnapshot> {
  const packageId = normalizeSuiAddress(config.packageId ?? AGENT_VAULT_PACKAGE_ID);
  const sessionId = normalizeSuiAddress(config.sessionId);
  const { object } = await client.getObject({ objectId: sessionId, include: { content: true }, signal: options.signal });
  const tag = parseStructTag(object.type);
  if (normalizeStructTag(tag) !== dkgTarget(packageId, 'DkgSession')) throw new Error('对象不是当前包的 dkg_committee::DkgSession。');
  const fields = DkgSessionBcs.parse(object.content);
  if (normalizeSuiAddress(fields.id) !== sessionId) throw new Error('会话对象 ID 与链上内容不匹配。');
  const status = Number(fields.status);
  if (![1, 2, 3, 4].includes(status)) throw new Error(`链上会话状态无效：${status}`);
  if (BigInt(fields.threshold) === 0n || BigInt(fields.total_participants) < 2n) throw new Error('链上会话门限或参与人数无效。');
  const participants = fields.participants.map((p) => normalizeSuiAddress(p));
  if (BigInt(participants.length) !== BigInt(fields.total_participants)) throw new Error('会话参与人清单与总数不一致。');
  return {
    sessionId,
    epoch: BigInt(fields.epoch),
    threshold: BigInt(fields.threshold),
    totalParticipants: BigInt(fields.total_participants),
    participants,
    commitmentsTableId: normalizeSuiAddress(fields.commitments.id),
    commitmentCount: BigInt(fields.commitments.size),
    mailboxTableId: normalizeSuiAddress(fields.encrypted_mailboxes.id),
    mailboxCount: BigInt(fields.encrypted_mailboxes.size),
    confirmationsTableId: normalizeSuiAddress(fields.confirmations.id),
    confirmationsTableSize: BigInt(fields.confirmations.size),
    confirmationsCount: BigInt(fields.confirmations_count),
    deadlineTimestampMs: BigInt(fields.deadline_timestamp_ms),
    status,
    finalPublicKey: Uint8Array.from(fields.final_public_key),
  };
}

/** 缺省（尚未提交）返回 null；真实读失败照常抛出，不与「没有」混为一谈。 */
async function readFieldOrNull(
  client: DkgReadClient,
  parentId: string,
  nameType: string,
  nameBcs: Uint8Array,
  options: DkgReadOptions,
): Promise<Uint8Array | null> {
  try {
    const { dynamicField } = await client.getDynamicField({ parentId, name: { type: nameType, bcs: nameBcs }, signal: options.signal });
    if (dynamicField.$kind !== 'DynamicField') throw new Error('动态字段形态异常。');
    return Uint8Array.from(dynamicField.value.bcs);
  } catch (error) {
    // gRPC 对不存在的字段回 notFound；这是「尚未提交」而不是错误。
    const reason = (error as { reason?: string }).reason;
    if (reason === 'notFound') return null;
    throw error;
  }
}

/** 参与者第 1 轮承诺（VSS 承诺向量）；未提交返回 null。 */
export async function readDkgCommitment(
  client: DkgReadClient,
  session: DkgSessionSnapshot,
  participant: string,
  options: DkgReadOptions = {},
): Promise<Uint8Array | null> {
  const raw = await readFieldOrNull(client, session.commitmentsTableId, 'address', bcs.Address.serialize(normalizeSuiAddress(participant)).toBytes(), options);
  return raw === null ? null : Uint8Array.from(bcs.vector(bcs.u8()).parse(raw));
}

/** 参与者对定稿群公钥的申报；未申报返回 null。 */
export async function readDkgAttestation(
  client: DkgReadClient,
  session: DkgSessionSnapshot,
  participant: string,
  packageId?: string,
  options: DkgReadOptions = {},
): Promise<Uint8Array | null> {
  const pkg = normalizeSuiAddress(packageId ?? AGENT_VAULT_PACKAGE_ID);
  const name = GroupKeyAttestationSlotBcs.serialize({ participant: normalizeSuiAddress(participant) }).toBytes();
  // 申报字段直接挂在 session 对象本身（不是 Table），键类型由发行包决定。
  const raw = await readFieldOrNull(client, session.sessionId, dkgTarget(pkg, 'GroupKeyAttestationSlot'), name, options);
  return raw === null ? null : Uint8Array.from(bcs.vector(bcs.u8()).parse(raw));
}

/** 参与者是否已确认最终包；未确认返回 null。 */
export async function readDkgConfirmation(
  client: DkgReadClient,
  session: DkgSessionSnapshot,
  participant: string,
  options: DkgReadOptions = {},
): Promise<boolean | null> {
  const raw = await readFieldOrNull(client, session.confirmationsTableId, 'address', bcs.Address.serialize(normalizeSuiAddress(participant)).toBytes(), options);
  return raw === null ? null : bcs.bool().parse(raw);
}

/** 参与者在 session 上预置的 X25519 信箱加密公钥；未登记返回 null。 */
export async function readDkgEncryptionKey(
  client: DkgReadClient,
  session: DkgSessionSnapshot,
  participant: string,
  packageId?: string,
  options: DkgReadOptions = {},
): Promise<Uint8Array | null> {
  const pkg = normalizeSuiAddress(packageId ?? AGENT_VAULT_PACKAGE_ID);
  const name = EncryptionKeySlotBcs.serialize({ participant: normalizeSuiAddress(participant) }).toBytes();
  const raw = await readFieldOrNull(client, session.sessionId, dkgTarget(pkg, 'EncryptionKeySlot'), name, options);
  return raw === null ? null : Uint8Array.from(bcs.vector(bcs.u8()).parse(raw));
}

/** 成员 sender 留给 recipient 的密态分片密文；不存在返回 null。 */
export async function readDkgMailboxShare(
  client: DkgReadClient,
  session: DkgSessionSnapshot,
  sender: string,
  recipient: string,
  packageId?: string,
  options: DkgReadOptions = {},
): Promise<Uint8Array | null> {
  const pkg = normalizeSuiAddress(packageId ?? AGENT_VAULT_PACKAGE_ID);
  const name = MailboxKeyBcs.serialize({
    sender: normalizeSuiAddress(sender),
    recipient: normalizeSuiAddress(recipient),
  }).toBytes();
  const raw = await readFieldOrNull(client, session.mailboxTableId, dkgTarget(pkg, 'MailboxKey'), name, options);
  return raw === null ? null : Uint8Array.from(bcs.vector(bcs.u8()).parse(raw));
}

/** 拼接压缩点为链上承诺 blob（每个点恰好 32 字节）。 */
export function encodeCommitments(points: Uint8Array[]): Uint8Array {
  if (points.length === 0) throw new Error('承诺向量不能为空。');
  for (const point of points) {
    if (point.length !== COMPRESSED_POINT_BYTES) throw new Error(`承诺点必须是 ${COMPRESSED_POINT_BYTES} 字节压缩点。`);
  }
  const out = new Uint8Array(points.length * COMPRESSED_POINT_BYTES);
  points.forEach((point, index) => out.set(point, index * COMPRESSED_POINT_BYTES));
  return out;
}

/** 将链上承诺 blob 拆解为 32 字节压缩点数组。 */
export function decodeCommitments(blob: Uint8Array): Uint8Array[] {
  if (blob.length === 0 || blob.length % COMPRESSED_POINT_BYTES !== 0) throw new Error('链上承诺长度不是 32 字节的整数倍。');
  const points: Uint8Array[] = [];
  for (let offset = 0; offset < blob.length; offset += COMPRESSED_POINT_BYTES) {
    points.push(blob.subarray(offset, offset + COMPRESSED_POINT_BYTES));
  }
  return points;
}
