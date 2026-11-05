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

/** H(DOMAIN_KEY_ROTATION || … || new_group_pk)，rotate_group_key 用。 */
export function computeKeyRotationDigest(input: {
  chainId: Uint8Array | string;
  orgId: string;
  epochVersion: number | bigint;
  nonce: number | bigint;
  newGroupPk: Uint8Array;
}): Uint8Array {
  return sha256(
    concat(
      utf8('SUI_ORG_KEY_ROTATION_V1:'),
      chainBytes(input.chainId),
      requireAddress(input.orgId, 'orgId'),
      u64le(input.epochVersion),
      u64le(input.nonce),
      requireDigest32(input.newGroupPk, 'newGroupPk'),
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
