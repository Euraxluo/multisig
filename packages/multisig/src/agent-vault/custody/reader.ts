/**
 * asset_custody 读取层：托管清单与提案快照（单次 getObject 读全量内联状态）。
 *
 * CustodyProposal.voters 是 Table（键值在动态字段里），投票明细走
 * listDynamicFields —— repo C 前端的 readCustodyVoters 以本 reader 的
 * 快照为基准 join。
 */
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import { normalizeStructTag } from '@mysten/sui/utils';
import { canonicalAddress } from '../org/bcs';
import { AGENT_VAULT_PACKAGE_ID } from '../org/constants';
import { ASSET_CUSTODY_MODULE, assetCustodyType, custodyProposalType } from './constants';
import { AssetCustodyBcs, CustodyProposalBcs } from './schemas';

export type CustodyReadClient = Pick<SuiGrpcClient, 'getObject'>;
export interface CustodyReadOptions { signal?: AbortSignal }

/** TypeName BCS 字节 → 可读类型标签；链上存全地址形态（Move TypeName 惯例**无 0x 前缀**，如
 *  "0000…0002::package::UpgradeCap"），统一缩短为惯例短形态（"0x2::package::UpgradeCap"）。 */
export function typeNameToString(bytes: Uint8Array | number[]): string {
  const raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Uint8Array.from(bytes));
  // 头部与泛型参数内的地址一视同仁；SDK 2.33.1 的 normalizeSuiAddress 不去前导零，手工剥
  return raw.replace(/(?:0x)?[0-9a-fA-F]{64}(?=[<:])/g, (m) => '0x' + (m.replace(/^0x/, '').replace(/^0+/, '') || '0'));
}

export interface SlotRow {
  slot: bigint;
  objectId: string;
  depositor: string;
  depositedMs: bigint;
}

export interface TypeFamily {
  /** 该资产类型的完整类型标签（TypeName 的字符串形态）。 */
  typeName: string;
  /** 下一新槽号（live 存续期单调递增，不复用）。 */
  nextSlot: bigint;
  slots: SlotRow[];
}

export interface AssetCustodySnapshot {
  id: string;
  orgId: string;
  families: TypeFamily[];
}

/** 读托管金库全量清单（inventory 内联，一次 getObject 即完整快照）。 */
export async function readAssetCustody(
  client: CustodyReadClient,
  config: { custodyId: string; packageId?: string },
  options: CustodyReadOptions = {},
): Promise<AssetCustodySnapshot> {
  const packageId = config.packageId ?? AGENT_VAULT_PACKAGE_ID;
  const { object } = await client.getObject({ objectId: config.custodyId, include: { content: true }, signal: options.signal });
  if (normalizeStructTag(object.type) !== assetCustodyType(packageId)) {
    throw new Error('对象不是当前包的 asset_custody::AssetCustody。');
  }
  const fields = AssetCustodyBcs.parse(object.content);
  return {
    id: canonicalAddress(fields.id),
    orgId: canonicalAddress(fields.org_id),
    families: fields.inventory.contents.map((entry) => ({
      typeName: typeNameToString(entry.key),
      nextSlot: BigInt(entry.value.next_slot),
      slots: entry.value.slots.contents.map((row) => ({
        slot: BigInt(row.key),
        objectId: canonicalAddress(row.value.object_id),
        depositor: canonicalAddress(row.value.depositor),
        depositedMs: BigInt(row.value.deposited_ms),
      })),
    })),
  };
}

export interface CustodyProposalSnapshot {
  id: string;
  custodyId: string;
  orgId: string;
  epoch: bigint;
  kind: number;
  typeName: string;
  slot: bigint;
  /** 提案冻结的具体资产对象 ID（槽位号复用时不会误伤新存入的对象）。 */
  objectId: string;
  /** 转出收款人（borrow 恒 0x0；release 冻结不可改）。 */
  recipient: string;
  proposer: string;
  title: string;
  thresholdWeight: bigint;
  accumulatedWeight: bigint;
  rejectedWeight: bigint;
  /** 投票去重表句柄与大小；明细走 listDynamicFields。 */
  votersTableId: string;
  voterCount: bigint;
  deadlineMs: bigint;
  status: number;
}

/** 读动用提案快照（权重与门限为创建时的组织快照）。 */
export async function readCustodyProposal(
  client: CustodyReadClient,
  config: { proposalId: string; packageId?: string },
  options: CustodyReadOptions = {},
): Promise<CustodyProposalSnapshot> {
  const packageId = config.packageId ?? AGENT_VAULT_PACKAGE_ID;
  const { object } = await client.getObject({ objectId: config.proposalId, include: { content: true }, signal: options.signal });
  if (normalizeStructTag(object.type) !== custodyProposalType(packageId)) {
    throw new Error('对象不是当前包的 asset_custody::CustodyProposal。');
  }
  const fields = CustodyProposalBcs.parse(object.content);
  return {
    id: canonicalAddress(fields.id),
    custodyId: canonicalAddress(fields.custody_id),
    orgId: canonicalAddress(fields.org_id),
    epoch: BigInt(fields.epoch),
    kind: fields.kind,
    typeName: typeNameToString(fields.type_name),
    slot: BigInt(fields.slot),
    objectId: canonicalAddress(fields.object_id),
    recipient: canonicalAddress(fields.recipient),
    proposer: canonicalAddress(fields.proposer),
    title: new TextDecoder('utf-8', { fatal: false }).decode(Uint8Array.from(fields.title)),
    thresholdWeight: BigInt(fields.threshold_weight),
    accumulatedWeight: BigInt(fields.accumulated_weight),
    rejectedWeight: BigInt(fields.rejected_weight),
    votersTableId: canonicalAddress(fields.voters.id),
    voterCount: BigInt(fields.voters.size),
    deadlineMs: BigInt(fields.deadline_ms),
    status: fields.status,
  };
}
