/**
 * 协议身份/命名层：`identity::identity` Move 模块（repo 前端仓
 * contracts/identity/sources/identity.move）的 SDK 封装。
 *
 * 合约尚未部署：没有任何默认包 ID——packageId 与 namesId 必须显式传入，
 * 未配置时报错而不是回落到任何猜测值。读取走官方 gRPC client；所有
 * 构造器自建 Transaction 返回（不设置 sender，由调用方签名执行）。
 */
import { bcs } from '@mysten/sui/bcs';
import type { SuiClientTypes } from '@mysten/sui/client';
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import { Transaction } from '@mysten/sui/transactions';
import { isValidSuiAddress, isValidSuiNSName, normalizeStructTag, normalizeSuiAddress } from '@mysten/sui/utils';
import { resolveSuiNsAddress, type SuiNameServiceCore, type SuinsNameRecordSource } from './suins';

// === 合约边界（与 identity.move 常量一致） ===

export const IDENTITY_LIMITS = {
  minLabelBytes: 3,
  maxLabelBytes: 32,
  maxDisplayNameBytes: 64,
  maxAvatarUrlBytes: 512,
  maxFollowing: 1000,
  minCiphertextBytes: 17,
  maxCiphertextBytes: 4112,
  nonceBytes: 12,
} as const;

export interface IdentityNamespaceConfig {
  /** identity 包地址；合约未部署时由调用方显式配置。 */
  packageId: string;
  /** Names 共享对象 ID。 */
  namesId: string;
  /** 可选 SuiNS core；resolveRecipient 遇到 .sui 输入时需要。 */
  suins?: SuiNameServiceCore;
  /** 可选注册表记录源；与 suins 一起提供时解析走交叉校验路径。 */
  suinsRecordSource?: SuinsNameRecordSource;
}

export function isValidIdentityConfig(config: Pick<IdentityNamespaceConfig, 'packageId' | 'namesId'>): boolean {
  return isValidSuiAddress(config.packageId) && isValidSuiAddress(config.namesId);
}

function requireConfig(config: IdentityNamespaceConfig): void {
  if (!isValidIdentityConfig(config)) {
    throw new Error('身份合约尚未配置：需要部署合约并设置身份包和 Names 对象 ID。');
  }
}

// === 名称规则（镜像合约 normalize_label；SDK 侧先失败，省掉无效 gas） ===

/** 归一化协议名：trim + 小写 + 去 .id 后缀；规则与合约 normalize_label 一致。 */
export function normalizeProtocolName(input: string): string {
  const label = input.trim().toLowerCase().replace(/\.id$/, '');
  if (!/^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/.test(label) || label.includes('--')) {
    throw new Error('名称需为 3–32 位小写字母、数字或连字符，连字符不能连续或位于首尾。');
  }
  return label;
}

// === BCS（与合约结构一一对应） ===

const Table = bcs.struct('Table', { id: bcs.Address, size: bcs.u64() });
const Names = bcs.struct('Names', { id: bcs.Address, labels: Table, accounts: Table, encryption_keys: Table });
const Name = bcs.struct('Name', { id: bcs.Address, label: bcs.string(), display_name: bcs.string(), avatar_url: bcs.string(), following: Table });
/** Followed 与 Unfollowed 共享同一载荷：发出边的 Name 与其目标。 */
const IdentityFollowEdge = bcs.struct('FollowEdge', { sender: bcs.Address, target: bcs.Address });

/** 与合约结构一一对应的 BCS schema，供调用方序列化 / 反序列化链上对象与事件。 */
export const IdentityBcs = { Table, Names, Name, FollowEdge: IdentityFollowEdge } as const;

const requestSignal = () => AbortSignal.timeout(20_000);
const bytes = (value: string) => Array.from(new TextEncoder().encode(value));

export interface IdentityProfile {
  id: string;
  address: string;
  label: string;
  displayName: string;
  avatarUrl: string;
  encryptionKey: number[];
  followingTable: string;
  followingCount: number;
}

export interface ReceivedObject { id: string; type: string; version: string; digest: string }
export type ResolvedRecipientKind = 'address' | 'suins' | 'protocol';
export interface ResolvedRecipient { address: string; kind: ResolvedRecipientKind; identity?: IdentityProfile }

// === 读取客户端 ===

export type IdentityRpc = Pick<SuiGrpcClient, 'getObject' | 'getDynamicField' | 'listDynamicFields' | 'listEvents' | 'listOwnedObjects' | 'waitForTransaction'>;

export class IdentityClient {
  readonly config: IdentityNamespaceConfig;
  readonly rpc: IdentityRpc;
  readonly identityModule: string;

  constructor(rpc: IdentityRpc, config: IdentityNamespaceConfig) {
    requireConfig(config);
    this.rpc = rpc;
    this.config = config;
    this.identityModule = `${normalizeSuiAddress(config.packageId)}::identity`;
  }

  private async namesFields() {
    const { object } = await this.rpc.getObject({ objectId: this.config.namesId, include: { content: true }, signal: requestSignal() });
    if (normalizeStructTag(object.type) !== `${this.identityModule}::Names`) throw new Error('Names 对象与配置的身份包不匹配。');
    return Names.parse(object.content);
  }

  private async tableValue(table: string, type: string, key: Uint8Array, valueType: string): Promise<Uint8Array | null> {
    try {
      const { dynamicField } = await this.rpc.getDynamicField({ parentId: table, name: { type, bcs: key }, signal: requestSignal() });
      if (dynamicField.$kind !== 'DynamicField' || normalizeStructTag(dynamicField.type) !== normalizeStructTag(`0x2::dynamic_field::Field<${type},${valueType}>`)) {
        throw new Error('链上身份表字段类型不匹配。');
      }
      return dynamicField.value.bcs;
    } catch (error) {
      // notFound 的 ObjectError 跨 @mysten/sui 版本类身份不同，结构判定；
      // 其余异常是传输失败，必须原样冒泡而不是伪装成「无记录」。
      if (typeof error === 'object' && error !== null && (error as { reason?: unknown }).reason === 'notFound') return null;
      throw error;
    }
  }

  async getIdentity(id: string): Promise<IdentityProfile> {
    const { object } = await this.rpc.getObject({ objectId: id, include: { content: true }, signal: requestSignal() });
    if (normalizeStructTag(object.type) !== `${this.identityModule}::Name`) throw new Error('该对象不是当前协议的身份。');
    if (object.owner?.$kind !== 'AddressOwner') throw new Error('身份对象没有有效的地址所有者。');
    const fields = Name.parse(object.content);
    if (fields.id !== normalizeSuiAddress(id)) throw new Error('身份对象 ID 与链上内容不匹配。');
    const names = await this.namesFields();
    const key = await this.tableValue(names.encryption_keys.id, '0x2::object::ID', bcs.Address.serialize(id).toBytes(), 'vector<u8>');
    // 每个 minted Name 都有 key 条目，未启用消息时为空 vector。
    if (!key) throw new Error('身份对象未登记在当前 Names 注册表中。');
    return {
      id: fields.id, address: normalizeSuiAddress(object.owner.AddressOwner),
      label: fields.label, displayName: fields.display_name, avatarUrl: fields.avatar_url,
      encryptionKey: bcs.vector(bcs.u8()).parse(key),
      followingTable: fields.following.id, followingCount: Number(fields.following.size),
    };
  }

  async getIdentityByAddress(address: string): Promise<IdentityProfile | null> {
    const names = await this.namesFields();
    const id = await this.tableValue(names.accounts.id, 'address', bcs.Address.serialize(address).toBytes(), '0x2::object::ID');
    return id ? this.getIdentity(bcs.Address.parse(id)) : null;
  }

  /** 付款方必须知道自己要给三类目的地中的哪一类打款：地址 / SuiNS / 协议身份对象。 */
  async resolveRecipient(input: string): Promise<ResolvedRecipient> {
    const value = input.trim();
    if (isValidSuiAddress(value)) return { address: normalizeSuiAddress(value), kind: 'address' };
    // 与前端一致：以 SuiNS 名称形状分派，`alice.id` 这类协议名后缀不会误入此分支。
    if (isValidSuiNSName(value)) {
      if (!this.config.suins) throw new Error('解析 SuiNS 名称需要配置 SuiNS client。');
      return { address: await resolveSuiNsAddress(this.config.suins, value, { recordSource: this.config.suinsRecordSource }), kind: 'suins' };
    }
    const label = normalizeProtocolName(value);
    const names = await this.namesFields();
    const id = await this.tableValue(names.labels.id, '0x1::string::String', bcs.string().serialize(label).toBytes(), '0x2::object::ID');
    if (!id) throw new Error('该协议名称尚未注册。');
    const identity = await this.getIdentity(bcs.Address.parse(id));
    return { address: identity.id, kind: 'protocol', identity };
  }

  async getFollowingIds(profile: IdentityProfile): Promise<Set<string>> {
    const ids = new Set<string>();
    let cursor: string | null = null;
    do {
      const page: SuiClientTypes.ListDynamicFieldsResponse = await this.rpc.listDynamicFields({ parentId: profile.followingTable, cursor, limit: 50, signal: requestSignal() });
      for (const entry of page.dynamicFields) {
        if (entry.$kind !== 'DynamicField' || normalizeStructTag(entry.type) !== normalizeStructTag('0x2::dynamic_field::Field<0x2::object::ID,bool>')) throw new Error('链上关注表字段类型不匹配。');
        ids.add(bcs.Address.parse(entry.name.bcs));
      }
      if (page.hasNextPage && (!page.cursor || page.cursor === cursor)) throw new Error('链上关注表分页未前进。');
      cursor = page.hasNextPage ? page.cursor : null;
    } while (cursor);
    return ids;
  }

  async getFollowing(profile: IdentityProfile): Promise<IdentityProfile[]> {
    const ids = await this.getFollowingIds(profile);
    const result: IdentityProfile[] = [];
    for (const id of ids) result.push(await this.getIdentity(id));
    return result;
  }

  async isFollowing(profile: IdentityProfile, targetId: string): Promise<boolean> {
    const value = await this.tableValue(profile.followingTable, '0x2::object::ID', bcs.Address.serialize(targetId).toBytes(), 'bool');
    return value !== null && bcs.bool().parse(value);
  }

  async getReceivedObjects(profile: IdentityProfile): Promise<ReceivedObject[]> {
    const objects: ReceivedObject[] = [];
    let cursor: string | null = null;
    do {
      const page: SuiClientTypes.ListOwnedObjectsResponse = await this.rpc.listOwnedObjects({ owner: profile.id, cursor, limit: 50, signal: requestSignal() });
      for (const object of page.objects) {
        // transfer-to-object 的收款对象 owner 是 AddressOwner(父 UID)，与动态对象字段不同。
        if (object.owner?.$kind !== 'AddressOwner' || normalizeSuiAddress(object.owner.AddressOwner) !== normalizeSuiAddress(profile.id)) throw new Error('收款对象不属于此身份。');
        if (!object.type || !object.version || !object.digest) throw new Error('收款对象缺少类型或接收版本信息。');
        objects.push({ id: object.objectId, type: object.type, version: object.version, digest: object.digest });
      }
      if (page.hasNextPage && (!page.cursor || page.cursor === cursor)) throw new Error('收款对象分页未前进。');
      cursor = page.hasNextPage ? page.cursor : null;
    } while (cursor);
    return objects;
  }

  /**
   * 从 Followed / Unfollowed 事件重建入向关注边。
   * 合约只存出向表，入向是投影：每个发送者的最新事件决定当前状态。
   * 扫描有界，越界时报告 truncated 而不是暗示列表完整。
   */
  async getFollowers(
    profile: IdentityProfile,
    options: { maxPages?: number; pageSize?: number; resolveProfile?: (id: string) => Promise<IdentityProfile>; followingIds?: Set<string> } = {},
  ): Promise<FollowerList> {
    const maxPages = options.maxPages ?? 20;
    const pageSize = options.pageSize ?? 50;
    if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 20 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50) throw new Error('粉丝查询范围无效。');

    const edges: Array<{ senderId: string; active: boolean; sender: string }> = [];
    const cursors = new Set<string>();
    let before: string | null = null;
    let truncated = false;
    let scannedEvents = 0;
    for (let pageIndex = 0; pageIndex < maxPages; pageIndex++) {
      const page = await this.rpc.listEvents({ filter: { emitModule: this.identityModule }, before, limit: pageSize, order: 'descending', signal: requestSignal() });
      scannedEvents += page.events.length;
      for (const event of page.events) {
        const type = normalizeStructTag(event.eventType);
        const active = type === normalizeStructTag(`${this.identityModule}::Followed`) ? true
          : type === normalizeStructTag(`${this.identityModule}::Unfollowed`) ? false : null;
        if (active === null) continue;
        if (event.checkpoint === null) throw new Error('链上关注事件缺少 checkpoint。');
        const raw = IdentityFollowEdge.parse(event.bcs);
        if (raw.target === profile.id) edges.push({ senderId: raw.sender, active, sender: event.sender });
      }
      if (!page.hasNextPage) break;
      if (!page.endCursor || cursors.has(page.endCursor) || page.endCursor === before) throw new Error('链上关注事件分页未前进。');
      if (pageIndex === maxPages - 1) { truncated = true; break; }
      cursors.add(page.endCursor);
      before = page.endCursor;
    }

    // 流是最新优先，同一发送者的第一条事件即当前边，其后都是历史。
    const latest = new Map<string, { active: boolean; sender: string }>();
    for (const edge of edges) if (!latest.has(edge.senderId)) latest.set(edge.senderId, { active: edge.active, sender: edge.sender });

    const resolveProfile = options.resolveProfile ?? ((id: string) => this.getIdentity(id));
    // 调用方已取过出向集合时直接复用，避免每次粉丝投影都重读关注表。
    const followingIds = options.followingIds ?? await this.getFollowingIds(profile);
    const live = [...latest].filter(([, edge]) => edge.active).map(([senderId]) => senderId);
    const profiles = new Map<string, IdentityProfile>();
    for (let index = 0; index < live.length; index += 4) {
      const batch = live.slice(index, index + 4);
      const resolved = await Promise.all(batch.map(async id => [id, await resolveProfile(id)] as const));
      for (const [id, sender] of resolved) profiles.set(id, sender);
    }
    const followers: Array<{ profile: IdentityProfile; mutual: boolean }> = [];
    let historicalUnfollows = 0;
    for (const [senderId, edge] of latest) {
      if (!edge.active) { historicalUnfollows++; continue; }
      const sender = profiles.get(senderId)!;
      // 事件由发送者自己的 Name 发出，交易签名者必须是其身份所有者；不一致即伪造投影。
      if (normalizeSuiAddress(edge.sender) !== normalizeSuiAddress(sender.address)) throw new Error('链上关注事件发送方与身份所有者不匹配。');
      followers.push({ profile: sender, mutual: followingIds.has(sender.id) });
    }
    followers.sort((a, b) => a.profile.label.localeCompare(b.profile.label) || a.profile.id.localeCompare(b.profile.id));
    return { followers, historicalUnfollows, scannedEvents, truncated };
  }

  async waitForTransaction(digest: string): Promise<void> {
    const result = await this.rpc.waitForTransaction({ digest, include: { effects: true }, timeout: 30_000 });
    if (result.$kind === 'FailedTransaction') throw new Error(result.FailedTransaction.status.error?.message || '链上交易失败。');
    if (!result.Transaction.status.success || !result.Transaction.effects?.status.success) throw new Error('链上交易失败或无法确认执行状态。');
  }
}

export interface FollowerList {
  /** 每个发送者的最新边；最后事件是 Unfollowed 的发送者不算粉丝。 */
  followers: Array<{ profile: IdentityProfile; mutual: boolean }>;
  /** 扫描窗口内看到的 Unfollow 边，作为历史保留而不是粉丝。 */
  historicalUnfollows: number;
  scannedEvents: number;
  /** 扫描停在页边界时为 true，更早的边可能缺失。 */
  truncated: boolean;
}

// === 纯视图辅助 ===

/** 观看者与被观看身份对彼此的意义，由两条有向边得出。 */
export type FollowRelationship = 'self' | 'mutual' | 'following' | 'followed-by' | 'none';

export function followRelationship(own: boolean, following: boolean, followedBy: boolean): FollowRelationship {
  if (own) return 'self';
  if (following && followedBy) return 'mutual';
  return following ? 'following' : followedBy ? 'followed-by' : 'none';
}

/** 资产到三类目的地的路由提示：协议身份是收件箱，持有人需另行提取，界面不代提。 */
export function describeRecipientRoute(resolved: Pick<ResolvedRecipient, 'kind'>): { tone: 'plain' | 'caution'; message: string } | null {
  if (resolved.kind === 'protocol') return {
    tone: 'caution',
    message: '这是协议 .id 身份对象，不是钱包地址。转出的资产会进入该身份的收件箱，需要身份持有人另行提取；界面不会代为触发提取。',
  };
  if (resolved.kind === 'suins') return { tone: 'plain', message: 'SuiNS 已解析为下面的钱包地址。' };
  return null;
}

// === PTB 构造器（自建 Transaction，不设 sender） ===

function targetOf(packageId: string, fn: string): string {
  if (!isValidSuiAddress(packageId)) throw new Error('身份合约尚未配置：需要有效的身份包地址。');
  return `${normalizeSuiAddress(packageId)}::identity::${fn}`;
}

export function buildMintName(config: Pick<IdentityNamespaceConfig, 'packageId' | 'namesId'>, label: string): Transaction {
  const tx = new Transaction();
  tx.moveCall({ target: targetOf(config.packageId, 'mint'), arguments: [tx.object(config.namesId), tx.pure.vector('u8', bytes(normalizeProtocolName(label)))] });
  return tx;
}

export function buildRenameName(config: Pick<IdentityNamespaceConfig, 'packageId' | 'namesId'>, nameId: string, label: string): Transaction {
  const tx = new Transaction();
  tx.moveCall({ target: targetOf(config.packageId, 'rename'), arguments: [tx.object(config.namesId), tx.object(nameId), tx.pure.vector('u8', bytes(normalizeProtocolName(label)))] });
  return tx;
}

export function buildSetProfile(
  config: Pick<IdentityNamespaceConfig, 'packageId'>,
  nameId: string,
  profile: { displayName: string; avatarUrl: string },
): Transaction {
  if (bytes(profile.displayName).length > IDENTITY_LIMITS.maxDisplayNameBytes || bytes(profile.avatarUrl).length > IDENTITY_LIMITS.maxAvatarUrlBytes) {
    throw new Error(`显示名称最多 ${IDENTITY_LIMITS.maxDisplayNameBytes} 字节，头像网址最多 ${IDENTITY_LIMITS.maxAvatarUrlBytes} 字节。`);
  }
  if (profile.avatarUrl) {
    const url = new URL(profile.avatarUrl);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('请使用 HTTPS 头像网址。');
  }
  const tx = new Transaction();
  tx.moveCall({ target: targetOf(config.packageId, 'set_profile'), arguments: [tx.object(nameId), tx.pure.vector('u8', bytes(profile.displayName)), tx.pure.vector('u8', bytes(profile.avatarUrl))] });
  return tx;
}

export function buildSetEncryptionKey(
  config: Pick<IdentityNamespaceConfig, 'packageId' | 'namesId'>,
  nameId: string,
  key: Uint8Array,
): Transaction {
  // 空 key 表示停用；否则必须 65 字节且以非压缩前缀 4 开头（镜像合约校验）。
  if (!(key.length === 0 || (key.length === 65 && key[0] === 4))) throw new Error('密钥必须为空，或 65 字节且以非压缩点前缀 4 开头。');
  const tx = new Transaction();
  tx.moveCall({ target: targetOf(config.packageId, 'set_encryption_key'), arguments: [tx.object(nameId), tx.object(config.namesId), tx.pure.vector('u8', Array.from(key))] });
  return tx;
}

export function buildFollowName(
  config: Pick<IdentityNamespaceConfig, 'packageId' | 'namesId'>,
  nameId: string,
  targetId: string,
): Transaction {
  const tx = new Transaction();
  tx.moveCall({ target: targetOf(config.packageId, 'follow'), arguments: [tx.object(nameId), tx.object(config.namesId), tx.pure.id(targetId)] });
  return tx;
}

export function buildUnfollowName(config: Pick<IdentityNamespaceConfig, 'packageId'>, nameId: string, targetId: string): Transaction {
  const tx = new Transaction();
  tx.moveCall({ target: targetOf(config.packageId, 'unfollow'), arguments: [tx.object(nameId), tx.pure.id(targetId)] });
  return tx;
}

export interface PrivateMessageInput {
  recipientId: string;
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  ephemeralPublicKey: Uint8Array;
  /** 加密时使用的接收方密钥；合约用它绑定确切的加密纪元。 */
  expectedRecipientKey: Uint8Array;
}

export function buildSendMessage(
  config: Pick<IdentityNamespaceConfig, 'packageId' | 'namesId'>,
  nameId: string,
  message: PrivateMessageInput,
): Transaction {
  if (message.ciphertext.length < IDENTITY_LIMITS.minCiphertextBytes || message.ciphertext.length > IDENTITY_LIMITS.maxCiphertextBytes) {
    throw new Error(`密文长度须在 ${IDENTITY_LIMITS.minCiphertextBytes} 到 ${IDENTITY_LIMITS.maxCiphertextBytes} 字节之间。`);
  }
  if (message.nonce.length !== IDENTITY_LIMITS.nonceBytes) throw new Error(`AES-GCM nonce 必须为 ${IDENTITY_LIMITS.nonceBytes} 字节。`);
  if (!(message.ephemeralPublicKey.length === 65 && message.ephemeralPublicKey[0] === 4)) throw new Error('临时公钥必须为 65 字节且以非压缩点前缀 4 开头。');
  const tx = new Transaction();
  tx.moveCall({
    target: targetOf(config.packageId, 'send_message'),
    arguments: [
      tx.object(nameId), tx.object(config.namesId), tx.pure.id(message.recipientId),
      tx.pure.vector('u8', Array.from(message.ciphertext)), tx.pure.vector('u8', Array.from(message.nonce)),
      tx.pure.vector('u8', Array.from(message.ephemeralPublicKey)), tx.pure.vector('u8', Array.from(message.expectedRecipientKey)),
    ],
  });
  return tx;
}

export function buildWithdrawToAddress(
  config: Pick<IdentityNamespaceConfig, 'packageId'>,
  nameId: string,
  received: ReceivedObject,
  recipient: string,
): Transaction {
  if (!isValidSuiAddress(recipient) || BigInt(recipient) === 0n || normalizeSuiAddress(recipient) === normalizeSuiAddress(nameId)) throw new Error('请选择有效的提取地址。');
  const tx = new Transaction();
  tx.moveCall({
    target: targetOf(config.packageId, 'withdraw'),
    typeArguments: [received.type],
    arguments: [tx.object(nameId), tx.receivingRef({ objectId: received.id, version: received.version, digest: received.digest }), tx.pure.address(recipient)],
  });
  return tx;
}
