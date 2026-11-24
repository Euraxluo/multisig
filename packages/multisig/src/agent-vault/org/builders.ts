/**
 * 治理 PTB 构造器（纯函数：Transaction 进、Transaction 出，可自由组合）。
 * 与现行包入口一一对应。对象动用（含升级）走 asset_custody 的链上提案与
 * custody/builders 的托管模板。
 */
import { Transaction } from '@mysten/sui/transactions';
import { AGENT_VAULT_PACKAGE_ID, LIMITS, SUI_CLOCK_OBJECT_ID } from './constants';
import { canonicalAddress, u64le } from './bcs';

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

/** A1d 群密钥轮换（新公钥 32 字节；签名摘要用 computeKeyRotationDigest，V3 含 key_threshold）。 */
export function buildRotateGroupKeyPTB(
  input: GovernanceTarget & {
    orgId: string;
    nonce: number | bigint;
    newGroupPk: Uint8Array;
    newSigners: string[];
    keyThreshold: number | bigint;
    popSignature: Uint8Array;
    frostSignature: Uint8Array;
  },
): Transaction {
  if (input.newGroupPk.length !== 32) throw new Error(`newGroupPk 必须 32 字节，实际 ${input.newGroupPk.length}`);
  const signers = [...input.newSigners];
  const seen = new Set<string>();
  for (const s of signers) {
    const c = s.toLowerCase();
    if (seen.has(c)) throw new Error(`newSigners 重复: ${s}`);
    seen.add(c);
  }
  if (signers.length === 0 || signers.length > LIMITS.MAX_ROSTER_MEMBERS) {
    throw new Error(`newSigners 数量须在 1..${LIMITS.MAX_ROSTER_MEMBERS}，实际 ${signers.length}`);
  }
  const keyThreshold = checkedU64(input.keyThreshold);
  if (keyThreshold <= 0n || keyThreshold > BigInt(signers.length)) {
    throw new Error(`keyThreshold 须在 1..${signers.length}，实际 ${keyThreshold}`);
  }
  const tx = new Transaction();
  tx.moveCall({
    target: `${pkg(input)}::cryptographic_org::rotate_group_key`,
    arguments: [
      tx.object(input.orgId),
      tx.pure.u64(checkedU64(input.nonce)),
      tx.pure.vector('u8', Array.from(input.newGroupPk)),
      tx.pure.vector('address', signers),
      tx.pure.u64(keyThreshold),
      tx.pure.vector('u8', Array.from(input.popSignature)),
      tx.pure.vector('u8', Array.from(input.frostSignature)),
    ],
  });
  return tx;
}

/** 创建组织（PoP：群私钥对 computeCreatePopDigest 的 ed25519 签名）。 */
export function buildCreateOrganizationPTB(
  input: GovernanceTarget & {
    groupPk: Uint8Array;
    keyThreshold: number | bigint;
    thresholdWeight: number | bigint;
    members: string[];
    weights: Array<number | bigint>;
    popSignature: Uint8Array;
  },
): Transaction {
  if (input.groupPk.length !== 32) throw new Error(`groupPk 必须 32 字节，实际 ${input.groupPk.length}`);
  if (input.members.length !== input.weights.length) throw new Error('名册与权重长度不一致');
  if (input.members.length === 0) throw new Error('名册不能为空');
  const keyThreshold = checkedU64(input.keyThreshold);
  if (keyThreshold <= 0n || keyThreshold > BigInt(input.members.length)) {
    throw new Error(`keyThreshold 须在 1..${input.members.length}，实际 ${keyThreshold}`);
  }
  const tx = new Transaction();
  tx.moveCall({
    target: `${pkg(input)}::cryptographic_org::create_organization`,
    arguments: [
      tx.pure.vector('u8', Array.from(input.groupPk)),
      tx.pure.u64(keyThreshold),
      tx.pure.u64(checkedU64(input.thresholdWeight)),
      tx.pure.vector('address', input.members),
      tx.pure.vector('u64', input.weights.map((w) => checkedU64(w))),
      tx.pure.vector('u8', Array.from(input.popSignature)),
    ],
  });
  return tx;
}

/** Master 设置金库流出策略（默认全 0 = 拒绝一切 agent 花费，直到显式放宽）。 */
export function buildSetOutflowPolicyPTB(
  input: GovernanceTarget & {
    coinType: string;
    masterCapId: string;
    vaultId: string;
    maxEpochOutflow: number | bigint;
    maxAgentBudget: number | bigint;
  },
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${pkg(input)}::vault::set_outflow_policy`,
    typeArguments: [input.coinType],
    arguments: [
      tx.object(input.masterCapId),
      tx.object(input.vaultId),
      tx.pure.u64(checkedU64(input.maxEpochOutflow)),
      tx.pure.u64(checkedU64(input.maxAgentBudget)),
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

/**
 * 创世质押提取（withdraw_genesis_stake）：FROST 门限签名 + nonce 单调 +
 * 90 天协议硬锁（unlock_at_ms 由 Clock 链上校验，签名摘要用
 * computeGenesisWithdrawDigest）。
 */
export function buildWithdrawGenesisStakePTB(
  input: GovernanceTarget & {
    orgId: string;
    nonce: number | bigint;
    amount: number | bigint;
    recipient: string;
    frostSignature: Uint8Array;
  },
): Transaction {
  if (input.frostSignature.length !== 64) {
    throw new Error(`frostSignature 必须 64 字节，实际 ${input.frostSignature.length}`);
  }
  const tx = new Transaction();
  tx.moveCall({
    target: `${pkg(input)}::cryptographic_org::withdraw_genesis_stake`,
    arguments: [
      tx.object(input.orgId),
      tx.pure.u64(checkedU64(input.nonce)),
      tx.pure.u64(checkedU64(input.amount)),
      tx.pure.address(input.recipient),
      tx.pure.vector('u8', Array.from(input.frostSignature)),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

/** 领回 DKG 参与质押（claim_bond）：会话 FINALIZED/TIMED_OUT 后原额退款。 */
export function buildClaimBondPTB(
  input: GovernanceTarget & {
    sessionId: string;
  },
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${pkg(input)}::dkg_committee::claim_bond`,
    arguments: [tx.object(input.sessionId)],
  });
  return tx;
}

/**
 * I3 组织金库 Agent 授权（delegate_agent_authority）：门限签名对
 * computeTreasuryAgentDelegationDigest 验签后，密封的 MasterCap 被受控借出，
 * 设置流出上限并向 operator 签发 OperatorCap。链上校验（E10/E11/E12）在
 * 链下镜像先拒：operator 必须是能签名的地址（非零，且不是组织、财政库、
 * 金库这三个对象地址）、双上限为正；nonce 须为 last_nonce+1 起。其它对象
 * 或包地址链上无法识别，签给它们的卡无人可用，需在签名前人工核对。
 * operator 只接受 64 位十六进制的完整写法，与摘要函数一致：这里若替调用方
 * 补零，签名人心里的地址与链上收到的地址就可能不同，而链上只会报 E14。
 * 重复授权不回收旧卡；要收回全部 operator / agent 卡，用
 * buildSetTreasuryOutflowPolicyPTB 把任一上限设为 0（见其注释）。
 * 授权设下的 epoch 上限对治理转账同样生效：已批准的转账超过本 epoch
 * 剩余额度时以 vault E_EXCEEDS_EPOCH_OUTFLOW 中止。
 */
export function buildDelegateAgentAuthorityPTB(
  input: GovernanceTarget & {
    treasuryId: string;
    orgId: string;
    vaultId: string;
    operator: string;
    maxEpochOutflow: number | bigint;
    maxAgentBudget: number | bigint;
    nonce: number | bigint;
    frostSignature: Uint8Array;
  },
): Transaction {
  if (input.frostSignature.length !== 64) {
    throw new Error(`frostSignature 必须 64 字节，实际 ${input.frostSignature.length}`);
  }
  const operator = canonicalAddress(input.operator);
  if (/^0+$/.test(operator.slice(2))) {
    throw new Error('operator 不能是零地址（链上 E10）');
  }
  if ([input.treasuryId, input.orgId, input.vaultId].some((id) => canonicalAddress(id) === operator)) {
    throw new Error('operator 不能是组织、财政库或金库的对象地址：这些地址无法签名（链上 E10）');
  }
  if (input.operator.replace(/^0x/i, '').length !== 64) {
    throw new Error(`operator 必须写成 64 位十六进制的完整地址（与摘要逐字节一致）: ${input.operator}`);
  }
  const maxEpochOutflow = checkedU64(input.maxEpochOutflow);
  const maxAgentBudget = checkedU64(input.maxAgentBudget);
  if (maxEpochOutflow <= 0n) throw new Error('maxEpochOutflow 必须为正（链上 E11）');
  if (maxAgentBudget <= 0n) throw new Error('maxAgentBudget 必须为正（链上 E12）');
  const tx = new Transaction();
  tx.moveCall({
    target: `${pkg(input)}::organization_treasury::delegate_agent_authority`,
    arguments: [
      tx.object(input.treasuryId),
      tx.object(input.orgId),
      tx.object(input.vaultId),
      tx.pure.address(input.operator),
      tx.pure.u64(maxEpochOutflow),
      tx.pure.u64(maxAgentBudget),
      tx.pure.u64(checkedU64(input.nonce)),
      tx.pure.vector('u8', Array.from(input.frostSignature)),
    ],
  });
  return tx;
}

/**
 * I3 组织金库流出策略（set_agent_outflow_policy）：门限签名对
 * computeTreasuryOutflowPolicyDigest 验签后调整密封金库的流出上限。
 * 与授权入口不同，两个上限都可以为 0：
 * - 任一上限为 0：治理层停机。除变更上限外还撤销全部已签发的
 *   OperatorCap / AgentCap（金库版本号递增、Agent 登记表清空），之后调高
 *   上限也不会让旧卡复活，恢复 Agent 花费只能重新走授权入口。epoch 上限
 *   归零同时解除对治理转账的额度约束。
 * - 两个上限都为正：只移动上限，已签发的卡继续有效，但每张卡每个 epoch
 *   最多花「卡面额度」与「当前 maxAgentBudget」中的较小值，调低
 *   maxAgentBudget 对已发卡立即生效。
 */
export function buildSetTreasuryOutflowPolicyPTB(
  input: GovernanceTarget & {
    treasuryId: string;
    orgId: string;
    vaultId: string;
    maxEpochOutflow: number | bigint;
    maxAgentBudget: number | bigint;
    nonce: number | bigint;
    frostSignature: Uint8Array;
  },
): Transaction {
  if (input.frostSignature.length !== 64) {
    throw new Error(`frostSignature 必须 64 字节，实际 ${input.frostSignature.length}`);
  }
  const tx = new Transaction();
  tx.moveCall({
    target: `${pkg(input)}::organization_treasury::set_agent_outflow_policy`,
    arguments: [
      tx.object(input.treasuryId),
      tx.object(input.orgId),
      tx.object(input.vaultId),
      tx.pure.u64(checkedU64(input.maxEpochOutflow)),
      tx.pure.u64(checkedU64(input.maxAgentBudget)),
      tx.pure.u64(checkedU64(input.nonce)),
      tx.pure.vector('u8', Array.from(input.frostSignature)),
    ],
  });
  return tx;
}
