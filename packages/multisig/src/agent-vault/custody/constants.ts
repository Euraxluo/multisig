/**
 * asset_custody 常量：DAO 金库托管任意 owned 对象 + 动用提案。
 *
 * 三层模型：资产以 dynamic object field 子对象托管（原 ID 仍可独立读取）；
 * 动用走 CustodyProposal 加权投票；执行分借出（同 PTB 闪贷式归还）与
 * 转出（按提案冻结的收款人永久转出）两种 kind。
 */
import { normalizeStructTag } from '@mysten/sui/utils';
import { AGENT_VAULT_PACKAGE_ID, MODULES } from '../org/constants';
import { canonicalAddress } from '../org/bcs';

export const ASSET_CUSTODY_MODULE = MODULES.assetCustody;

/** 提案种类（合约 KIND_*）。 */
export const CUSTODY_KIND = {
  /** 借出一个 PTB：take_asset → 使用 → return_asset，收据零 drop 强制归还。 */
  borrow: 1,
  /** 永久转出：execute_release 按提案冻结的 recipient 转移资产。 */
  release: 2,
} as const;

/** 提案状态（合约 STATUS_*）。 */
export const CUSTODY_STATUS = {
  pending: 1,
  executed: 2,
  rejected: 3,
} as const;

/** 协议硬上限（与合约常量逐一对齐）。 */
export const CUSTODY_LIMITS = {
  MAX_TITLE_BYTES: 256,
  MAX_DURATION_MS: 31_536_000_000,
  MAX_DISTINCT_TYPES: 64,
  MAX_SLOTS_PER_TYPE: 128,
} as const;

/** 借出模板的 UpgradeCap 类型参数（托管的最常见资产）。 */
export const UPGRADE_CAP_TYPE = '0x2::package::UpgradeCap';

// ASSET_CUSTODY_ERRORS 注册表住在 org/constants（全模块错误码同一事实源），此处 re-export。
export { ASSET_CUSTODY_ERRORS } from '../org/constants';

/** 事件名（完整 module::Event；匹配时固定类型来源包）。 */
export const ASSET_CUSTODY_EVENTS = {
  custodyCreated: 'asset_custody::AssetCustodyCreated',
  proposalCreated: 'asset_custody::CustodyProposalCreated',
  voteSubmitted: 'asset_custody::CustodyVoteSubmitted',
  voteRejected: 'asset_custody::CustodyVoteRejected',
  assetDeposited: 'asset_custody::AssetDeposited',
  assetTaken: 'asset_custody::AssetTaken',
  assetReturned: 'asset_custody::AssetReturned',
  assetReleased: 'asset_custody::AssetReleased',
} as const;

/** 托管对象的类型标签（归一化全地址形态）。 */
export function assetCustodyType(packageId: string = AGENT_VAULT_PACKAGE_ID): string {
  return normalizeStructTag(`${canonicalAddress(packageId)}::${ASSET_CUSTODY_MODULE}::AssetCustody`);
}

/** 动用提案对象的类型标签（归一化全地址形态）。 */
export function custodyProposalType(packageId: string = AGENT_VAULT_PACKAGE_ID): string {
  return normalizeStructTag(`${canonicalAddress(packageId)}::${ASSET_CUSTODY_MODULE}::CustodyProposal`);
}
