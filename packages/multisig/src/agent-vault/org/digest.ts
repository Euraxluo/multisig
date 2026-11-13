/**
 * 提案摘要与 payload 构造——与 cryptographic_org.move 的实现逐字节一致。
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { AGENT_VAULT_PACKAGE_ID } from './constants';
import { bcsVectorAddress, bcsVectorU64, concat, hexToBytes, u64le, utf8 } from './bcs';

function requireAddress(value: string, field: string): Uint8Array {
  const b = hexToBytes(value);
  if (b.length !== 32) throw new Error(`${field} 必须是 32 字节地址: ${value}`);
  return b;
}

function requireDigest32(value: Uint8Array, field: string): Uint8Array {
  if (value.length !== 32) throw new Error(`${field} 必须是 32 字节摘要，实际 ${value.length}`);
  return value;
}
/** chainId 允许原始字节（不再经字符串往返改写字节序列）。 */
function chainBytes(chainId: Uint8Array | string): Uint8Array {
  return typeof chainId === 'string' ? utf8(chainId) : chainId;
}


/** H(DOMAIN_PROPOSAL || chain_id || org_id || epoch || nonce || payload)。 */
export function computeProposalDigest(input: {
  chainId: Uint8Array | string;
  orgId: string;
  epochVersion: number | bigint;
  nonce: number | bigint;
  payload: Uint8Array;
}): Uint8Array {
  return sha256(
    concat(
      utf8('SUI_ORG_PROPOSAL_V1:'),
      chainBytes(input.chainId),
      requireAddress(input.orgId, 'orgId'),
      u64le(input.epochVersion),
      u64le(input.nonce),
      input.payload,
    ),
  );
}

/** H(DOMAIN_THRESHOLD_APPROVAL || … || new_epoch_version)，advance_organization_epoch 用。 */
export function computeThresholdApprovalDigest(input: {
  chainId: Uint8Array | string;
  orgId: string;
  epochVersion: number | bigint;
  nonce: number | bigint;
  newEpochVersion: number | bigint;
}): Uint8Array {
  return sha256(
    concat(
      utf8('SUI_ORG_APPROVAL_V1:'),
      chainBytes(input.chainId),
      requireAddress(input.orgId, 'orgId'),
      u64le(input.epochVersion),
      u64le(input.nonce),
      u64le(input.newEpochVersion),
    ),
  );
}

/**
 * H(DOMAIN_KEY_ROTATION_V3 || … || new_group_pk || bcs(new_signers) || bcs(key_threshold))，
 * rotate_group_key 用。V3 绑定新公钥、新签名者名单与密钥门限：签名不可重放到
 * 不同的 signer 集合或 key_threshold。
 */
export function computeKeyRotationDigest(input: {
  chainId: Uint8Array | string;
  orgId: string;
  epochVersion: number | bigint;
  nonce: number | bigint;
  newGroupPk: Uint8Array;
  newSigners: string[];
  keyThreshold: number | bigint;
}): Uint8Array {
  return sha256(
    concat(
      utf8('SUI_ORG_KEY_ROTATION_V3:'),
      chainBytes(input.chainId),
      requireAddress(input.orgId, 'orgId'),
      u64le(input.epochVersion),
      u64le(input.nonce),
      requireDigest32(input.newGroupPk, 'newGroupPk'),
      bcsVectorAddress(input.newSigners),
      u64le(input.keyThreshold),
    ),
  );
}

/** H(DOMAIN_POP || chain_id || group_pk || bcs(members) || bcs(weights) || bcs(threshold))，创建组织 PoP。 */
export function computeCreatePopDigest(input: {
  chainId: Uint8Array | string;
  groupPk: Uint8Array;
  members: string[];
  weights: Array<number | bigint>;
  thresholdWeight: number | bigint;
}): Uint8Array {
  if (input.members.length !== input.weights.length) {
    throw new Error(`名册与权重长度不一致: ${input.members.length} vs ${input.weights.length}`);
  }
  return sha256(
    concat(
      utf8('SUI_ORG_POP_V1:'),
      chainBytes(input.chainId),
      requireDigest32(input.groupPk, 'groupPk'),
      bcsVectorAddress(input.members),
      bcsVectorU64(input.weights),
      u64le(input.thresholdWeight),
    ),
  );
}

/** H(DOMAIN_POP || chain_id || bcs(org_id) || bcs(new_epoch) || new_group_pk)，轮换 PoP（新公钥自证持有私钥）。 */
export function computeRotatePopDigest(input: {
  chainId: Uint8Array | string;
  orgId: string;
  newEpochVersion: number | bigint;
  newGroupPk: Uint8Array;
}): Uint8Array {
  return sha256(
    concat(
      utf8('SUI_ORG_POP_V1:'),
      chainBytes(input.chainId),
      requireAddress(input.orgId, 'orgId'),
      u64le(input.newEpochVersion),
      requireDigest32(input.newGroupPk, 'newGroupPk'),
    ),
  );
}

/** H(DOMAIN_TREASURY_TRANSFER || … || bcs(proposal_id) || bcs(recipient) || bcs(amount))，国库转账门限执行。 */
export function computeTreasuryTransferDigest(input: {
  chainId: Uint8Array | string;
  orgId: string;
  epochVersion: number | bigint;
  nonce: number | bigint;
  proposalId: string;
  recipient: string;
  amount: number | bigint;
}): Uint8Array {
  return sha256(
    concat(
      utf8('SUI_ORG_TREASURY_TRANSFER_V1:'),
      chainBytes(input.chainId),
      requireAddress(input.orgId, 'orgId'),
      u64le(input.epochVersion),
      u64le(input.nonce),
      requireAddress(input.proposalId, 'proposalId'),
      requireAddress(input.recipient, 'recipient'),
      u64le(input.amount),
    ),
  );
}

/**
 * H(DOMAIN_ROSTER_UPDATE || … || new_epoch || threshold || bcs(members) || bcs(weights))。
 * 名册摘要绑定完整下一届名册、阈值及其产生的纪元，签名不可重放到不同名册。
 */
export function computeRosterUpdateDigest(input: {
  chainId: Uint8Array | string;
  orgId: string;
  epochVersion: number | bigint;
  nonce: number | bigint;
  newEpochVersion: number | bigint;
  thresholdWeight: number | bigint;
  newMembers: string[];
  newWeights: Array<number | bigint>;
}): Uint8Array {
  if (input.newMembers.length !== input.newWeights.length) {
    throw new Error(`名册与权重长度不一致: ${input.newMembers.length} vs ${input.newWeights.length}`);
  }
  return sha256(
    concat(
      utf8('SUI_ORG_ROSTER_V1:'),
      chainBytes(input.chainId),
      requireAddress(input.orgId, 'orgId'),
      u64le(input.epochVersion),
      u64le(input.nonce),
      u64le(input.newEpochVersion),
      u64le(input.thresholdWeight),
      bcsVectorAddress(input.newMembers),
      bcsVectorU64(input.newWeights),
    ),
  );
}

/** 默认调用目标包（便于 builder 缺省）。 */
export const DEFAULT_TARGET_PACKAGE = AGENT_VAULT_PACKAGE_ID;

/**
 * DKG attestation 绑定摘要——与 dkg_committee.move 逐字节一致：
 * H("SUI_DKG_ATTEST_V1:" || bcs(ID) || group_pk)
 * bcs(object::ID) 即 32 字节原始地址；签名须用参与者在 Round 1 公布的
 * ed25519 公钥对应的私钥作出，链上验签（E_ATTEST_SIGNATURE_INVALID=3018）。
 */
export function computeDkgAttestationDigest(input: {
  sessionId: string;
  groupPublicKey: Uint8Array;
}): Uint8Array {
  const sid = requireAddress(input.sessionId, 'sessionId');
  if (input.groupPublicKey.length !== 32) throw new Error('groupPublicKey 必须是 32 字节');
  return sha256(concat(utf8('SUI_DKG_ATTEST_V1:'), sid, input.groupPublicKey));
}
