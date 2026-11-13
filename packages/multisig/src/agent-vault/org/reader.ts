/**
 * 组织 / UpgradeCap 的只读解析（gRPC 字节流 → 结构化快照）。
 *
 * 升级 nonce 台账与签名前群公钥读取都走这里；托管的 UpgradeCap 作为
 * dynamic object field 子对象仍可用原 ID 独立 getObject（asset_custody）。
 * gRPC client 的 getObject 返回已解码的 Uint8Array content。
 */
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import { normalizeStructTag } from '@mysten/sui/utils';
import { BcsReader, bytesToHex, canonicalAddress } from './bcs';
import { AGENT_VAULT_PACKAGE_ID } from './constants';

/** 组织快照（成员/重放 Table 只读 size；逐键遍历走 dynamic-field 查询，按需再加）。 */
export interface OrganizationSnapshot {
  id: string;
  groupPk: Uint8Array;
  groupPkHex: string;
  thresholdWeight: bigint;
  epochVersion: bigint;
  lastNonce: bigint;
  chainId: string;
  memberCount: bigint;
  replayTableSize: bigint;
  /** 当前轮换周期的密钥签名者名单（rotate_group_key 设置；改册不可移除）。 */
  keySigners: string[];
  /** 密钥门限（rotate/create 设置；名册门限不得低于它）。 */
  keyThreshold: bigint;
  /** 下一提案 nonce = last_nonce + 1（提案前必须重读链上，防撞号）。 */
  nextNonce: bigint;
  /** 创世质押余款（Balance<SUI> 的 value；BCS 编码即裸 u64）。 */
  genesisStake: bigint;
  /** 创世质押累计入账总额（= 参与者超额支付合计，含已提取部分）。 */
  genesisBondedTotal: bigint;
  /** 已从创世质押提取的累计金额；live net = bonded_total - withdrawn。 */
  genesisWithdrawn: bigint;
  /** 创世质押 90 天硬锁解锁时刻（ms）；0 = 直接创建路径（无质押）。 */
  genesisUnlockAtMs: bigint;
}

/** UpgradeCap BCS = uid(32) || package(32) || version u64 || policy u8 = 73B。 */
export interface UpgradeCapSnapshot {
  id: string;
  packageId: string;
  version: bigint;
  /** 0 = compatible。 */
  policy: number;
}

/** 取回对象 BCS 内容，并核验：返回 ID、精确类型（不含泛型/额外段）、首 32 字节 UID 都与请求一致。 */
async function objectContentBytes(
  client: SuiGrpcClient,
  objectId: string,
  expectedType: string,
): Promise<Uint8Array> {
  const requestedId = canonicalAddress(objectId);
  const { object } = await client.getObject({ objectId: requestedId, include: { content: true } });
  if (canonicalAddress(object.objectId) !== requestedId) throw new Error('返回对象 ID 与请求不符');
  if (normalizeStructTag(object.type) !== normalizeStructTag(expectedType)) throw new Error(`对象类型不符: ${object.type}`);
  if (!(object.content instanceof Uint8Array)) throw new Error(`对象 ${objectId} 无 BCS content`);
  if (object.content.length < 32 || '0x' + bytesToHex(object.content.slice(0, 32)) !== requestedId) {
    throw new Error('BCS UID 与请求对象 ID 不符');
  }
  return object.content;
}

/** 解析共享 Organization 对象。 */
export function parseOrganization(b: Uint8Array): OrganizationSnapshot {
  const r = new BcsReader(b);
  const id = r.address();
  const groupPk = r.vector();
  const thresholdWeight = r.u64();
  const epochVersion = r.u64();
  const lastNonce = r.u64();
  if (groupPk.length !== 32) throw new Error('Organization.group_pk 必须为 32 字节');
  const chainBytes = r.vector();
  // Move 存的是任意字节；不能用替换字符改变签名域。
  const chainId = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(chainBytes);
  const membersWeight = r.table();
  const executedProposals = r.table();
  const signerCount = r.uleb();
  const keySigners: string[] = [];
  for (let i = 0; i < signerCount; i++) keySigners.push(r.address());
  if (r.remaining < 8) throw new Error('Organization BCS 缺少尾随 key_threshold u64（旧布局不再支持）');
  const keyThreshold = r.u64();
  // 尾随创世质押四元组：genesis_stake: Balance<SUI>（BCS = 裸 u64 value）、
  // genesis_bonded_total、genesis_withdrawn、genesis_unlock_at_ms。
  if (r.remaining < 32) throw new Error('Organization BCS 缺少尾随创世质押四元组（旧布局不再支持）');
  const genesisStake = r.u64();
  const genesisBondedTotal = r.u64();
  const genesisWithdrawn = r.u64();
  const genesisUnlockAtMs = r.u64();
  if (r.remaining !== 0) throw new Error('Organization BCS 存在多余字节');
  return {
    id,
    groupPk,
    groupPkHex: '0x' + bytesToHex(groupPk),
    thresholdWeight,
    epochVersion,
    lastNonce,
    chainId,
    memberCount: membersWeight.size,
    replayTableSize: executedProposals.size,
    keySigners,
    keyThreshold,
    nextNonce: lastNonce + 1n,
    genesisStake,
    genesisBondedTotal,
    genesisWithdrawn,
    genesisUnlockAtMs,
  };
}

/** 读组织快照 + nonce 台账。每次提案前调用（签名绑定 nonce，撞号直接 abort）。 */
export async function readOrganization(
  client: SuiGrpcClient,
  orgId: string,
  packageId = AGENT_VAULT_PACKAGE_ID,
): Promise<OrganizationSnapshot> {
  const type = `${canonicalAddress(packageId)}::cryptographic_org::Organization`;
  return parseOrganization(await objectContentBytes(client, orgId, type));
}

/** 解析独立 UpgradeCap（托管后仍以原 ID 独立可读——asset_custody 动态子对象的设计要点）。 */
export function parseUpgradeCap(objectId: string, b: Uint8Array): UpgradeCapSnapshot {
  if (b.length !== 73) throw new Error(`UpgradeCap BCS 应为 73 字节，实际 ${b.length}`);
  const r = new BcsReader(b);
  const id = r.address();
  if (id !== canonicalAddress(objectId)) throw new Error('UpgradeCap UID 与对象 ID 不符');
  const packageId = r.address();
  const version = r.u64();
  const policy = r.u8();
  return { id, packageId, version, policy };
}
