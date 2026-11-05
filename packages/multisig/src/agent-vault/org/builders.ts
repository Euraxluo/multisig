/**
 * 治理 PTB 构造器（纯函数：Transaction 进、Transaction 出，可自由组合）。
 * 与现行包入口一一对应。对象动用（含升级）走 asset_custody 的链上提案与
 * custody/builders 的托管模板。
 */
import { Transaction } from '@mysten/sui/transactions';
import { AGENT_VAULT_PACKAGE_ID, LIMITS } from './constants';
import { u64le } from './bcs';

function checkedU64(value: number | bigint): bigint {
  u64le(value);
  return BigInt(value);
}

export interface GovernanceTarget {
  /** 调用目标包，默认现行包。 */
  packageId?: string;
}

function pkg(t: GovernanceTarget | undefined): string {
  return t?.packageId ?? AGENT_VAULT_PACKAGE_ID;
}

function u8Args(tx: Transaction, payload: Uint8Array, signature: Uint8Array) {
  return [
    tx.pure.vector('u8', Array.from(payload)),
    tx.pure.vector('u8', Array.from(signature)),
  ];
}

/** 通用门限提案执行（payload + actionType 自选；提案摘要由调用方按 computeProposalDigest 构造签名）。 */
export function buildExecuteThresholdProposalPTB(
  input: GovernanceTarget & {
    orgId: string;
    nonce: number | bigint;
    payload: Uint8Array;
    frostSignature: Uint8Array;
    actionType: number;
  },
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${pkg(input)}::cryptographic_org::execute_threshold_proposal`,
    arguments: [
      tx.object(input.orgId),
      tx.pure.u64(checkedU64(input.nonce)),
      ...u8Args(tx, input.payload, input.frostSignature),
      tx.pure.u8(input.actionType),
    ],
  });
  return tx;
}

/** A1d 纪元推进（resharing 后保公钥递增版本）。 */
export function buildAdvanceEpochPTB(
  input: GovernanceTarget & {
    orgId: string;
    nonce: number | bigint;
    frostSignature: Uint8Array;
  },
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${pkg(input)}::cryptographic_org::advance_organization_epoch`,
    arguments: [tx.object(input.orgId), tx.pure.u64(checkedU64(input.nonce)), tx.pure.vector('u8', Array.from(input.frostSignature))],
  });
  return tx;
}

/** A1d 群密钥轮换（新公钥 32 字节；签名摘要用 computeKeyRotationDigest）。 */
export function buildRotateGroupKeyPTB(
  input: GovernanceTarget & {
    orgId: string;
    nonce: number | bigint;
    newGroupPk: Uint8Array;
    frostSignature: Uint8Array;
  },
): Transaction {
  if (input.newGroupPk.length !== 32) throw new Error(`newGroupPk 必须 32 字节，实际 ${input.newGroupPk.length}`);
  const tx = new Transaction();
  tx.moveCall({
    target: `${pkg(input)}::cryptographic_org::rotate_group_key`,
    arguments: [
      tx.object(input.orgId),
      tx.pure.u64(checkedU64(input.nonce)),
      tx.pure.vector('u8', Array.from(input.newGroupPk)),
      tx.pure.vector('u8', Array.from(input.frostSignature)),
    ],
  });
  return tx;
}

/** A1c 名册换届（原子替换整届名册；签名摘要用 computeRosterUpdateDigest）。 */
export function buildUpdateRosterPTB(
  input: GovernanceTarget & {
    orgId: string;
    nonce: number | bigint;
    priorMembers: string[];
    newMembers: string[];
    newWeights: Array<number | bigint>;
    newThresholdWeight: number | bigint;
    frostSignature: Uint8Array;
  },
): Transaction {
  const { newMembers, newWeights, priorMembers } = input;
  if (newMembers.length !== newWeights.length) throw new Error('名册与权重长度不一致');
  if (newMembers.length === 0) throw new Error('新名册不能为空');
  if (newMembers.length > LIMITS.MAX_ROSTER_MEMBERS) {
    throw new Error(`名册上限 ${LIMITS.MAX_ROSTER_MEMBERS}，实际 ${newMembers.length}`);
  }
  const tx = new Transaction();
  tx.moveCall({
    target: `${pkg(input)}::cryptographic_org::update_organization_roster`,
    arguments: [
      tx.object(input.orgId),
      tx.pure.u64(checkedU64(input.nonce)),
      tx.pure.vector('address', priorMembers),
      tx.pure.vector('address', newMembers),
      tx.pure.vector('u64', newWeights.map((w) => checkedU64(w))),
      tx.pure.u64(checkedU64(input.newThresholdWeight)),
      tx.pure.vector('u8', Array.from(input.frostSignature)),
    ],
  });
  return tx;
}
