/**
 * asset_custody 的 BCS schema：托管对象、动用提案与事件。
 *
 * TypeName 单字段（vector<u8>）序列化即字节串本身；VecMap 单字段
 * contents: vector<{key,value}>（空表恰 1 字节 ULEB 0）；Table 只存
 * {id, size}（键值在动态字段里，读投票明细走 listDynamicFields）。
 */
import { bcs, type BcsType } from '@mysten/sui/bcs';

/** std::type_name::TypeName（唯一字段 name: String → vector<u8>）。 */
export const TypeNameBcs = bcs.vector(bcs.u8());

function vecMap<K extends BcsType<any, any>, V extends BcsType<any, any>>(name: string, key: K, value: V) {
  return bcs.struct(name, { contents: bcs.vector(bcs.struct('Entry', { key, value })) });
}

export const SlotRecordBcs = bcs.struct('SlotRecord', {
  object_id: bcs.Address,
  depositor: bcs.Address,
  deposited_ms: bcs.u64(),
});

export const TypeIndexBcs = bcs.struct('TypeIndex', {
  next_slot: bcs.u64(),
  slots: vecMap('SlotMap', bcs.u64(), SlotRecordBcs),
});

export const AssetCustodyBcs = bcs.struct('AssetCustody', {
  id: bcs.Address,
  org_id: bcs.Address,
  inventory: vecMap('Inventory', TypeNameBcs, TypeIndexBcs),
});

/** sui::table::Table 的链上形状（仅句柄与大小；明细经动态字段读取）。 */
const TableHandle = bcs.struct('Table', { id: bcs.Address, size: bcs.u64() });

export const CustodyProposalBcs = bcs.struct('CustodyProposal', {
  id: bcs.Address,
  custody_id: bcs.Address,
  org_id: bcs.Address,
  epoch: bcs.u64(),
  kind: bcs.u8(),
  type_name: TypeNameBcs,
  slot: bcs.u64(),
  /** The exact custodied object this approval is bound to. */
  object_id: bcs.Address,
  recipient: bcs.Address,
  proposer: bcs.Address,
  title: bcs.vector(bcs.u8()),
  threshold_weight: bcs.u64(),
  accumulated_weight: bcs.u64(),
  rejected_weight: bcs.u64(),
  voters: TableHandle,
  deadline_ms: bcs.u64(),
  /** borrow proposals must be taken within this window (min(deadline, creation+5min)); #12 mitigation */
  borrow_deadline_ms: bcs.u64(),
  status: bcs.u8(),
});

export const AssetCustodyCreatedBcs = bcs.struct('AssetCustodyCreated', {
  custody_id: bcs.Address,
  org_id: bcs.Address,
});

export const CustodyProposalCreatedBcs = bcs.struct('CustodyProposalCreated', {
  proposal_id: bcs.Address,
  custody_id: bcs.Address,
  org_id: bcs.Address,
  epoch: bcs.u64(),
  kind: bcs.u8(),
  type_name: TypeNameBcs,
  slot: bcs.u64(),
  recipient: bcs.Address,
  deadline_ms: bcs.u64(),
});

export const CustodyVoteSubmittedBcs = bcs.struct('CustodyVoteSubmitted', {
  proposal_id: bcs.Address,
  voter: bcs.Address,
  weight: bcs.u64(),
  total_weight: bcs.u64(),
});

export const CustodyVoteRejectedBcs = bcs.struct('CustodyVoteRejected', {
  proposal_id: bcs.Address,
  weight: bcs.u64(),
  total_rejected_weight: bcs.u64(),
});

export const AssetDepositedBcs = bcs.struct('AssetDeposited', {
  custody_id: bcs.Address,
  type_name: TypeNameBcs,
  slot: bcs.u64(),
  object_id: bcs.Address,
});

export const AssetTakenBcs = bcs.struct('AssetTaken', {
  proposal_id: bcs.Address,
  custody_id: bcs.Address,
  type_name: TypeNameBcs,
  slot: bcs.u64(),
  object_id: bcs.Address,
});

export const AssetReturnedBcs = bcs.struct('AssetReturned', {
  custody_id: bcs.Address,
  type_name: TypeNameBcs,
  slot: bcs.u64(),
  object_id: bcs.Address,
});

export const AssetReleasedBcs = bcs.struct('AssetReleased', {
  proposal_id: bcs.Address,
  custody_id: bcs.Address,
  type_name: TypeNameBcs,
  slot: bcs.u64(),
  object_id: bcs.Address,
  recipient: bcs.Address,
});
