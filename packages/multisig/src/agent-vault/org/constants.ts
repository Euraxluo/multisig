/**
 * agent_vault 现行包的常量 / ABI / 错误码注册表。
 *
 * 与 `packages/contracts/agent_vault` 一一对应；链上重算与链下构造共用这一份
 * 定义，避免两处漂移。只描述现行包——历史包的对象不在支持范围内（需要旧行为
 * 时从 git 取当时的分支）。
 */

import { SUI_CLOCK_OBJECT_ID as CLOCK_ID, SUI_RANDOM_OBJECT_ID as RANDOM_ID } from '@mysten/sui/utils';

/** 现行调用目标包（2026-11-05 fresh publish，tx X2tVjZgE6Q4e9PNWhA4jtHQHZcJ93ZbnN9oiR8J5Jw3）。 */
export const AGENT_VAULT_PACKAGE_ID = '0x827268c43588a928fc24ce48dee65ab2f89af54d0481e8060a83b54c1ea325e5';

/** 系统对象：取自官方常量，避免手写全地址形态漂移。 */
export const SUI_CLOCK_OBJECT_ID = CLOCK_ID;
export const SUI_RANDOM_OBJECT_ID = RANDOM_ID;

/** 模块名。 */
export const MODULES = {
  vault: 'vault',
  org: 'cryptographic_org',
  dkg: 'dkg_committee',
  asyncProposal: 'asynchronous_proposal',
  poll: 'governance_poll',
  treasury: 'organization_treasury',
  scheduledPayments: 'scheduled_payments',
  chat: 'onchain_chat',
  redPacket: 'red_packet',
  walrusPolicy: 'walrus_app_policy',
  scallop: 'scallop_yield_adapter',
  assetCustody: 'asset_custody',
} as const;

/** 域分隔常量（与 cryptographic_org.move 的 DOMAIN_* 逐字节一致）。 */
export const DOMAINS = {
  PROPOSAL: 'SUI_ORG_PROPOSAL_V1:',
  THRESHOLD_APPROVAL: 'SUI_ORG_APPROVAL_V1:',
  KEY_ROTATION: 'SUI_ORG_KEY_ROTATION_V3:',
  ROSTER_UPDATE: 'SUI_ORG_ROSTER_V1:',
  POP: 'SUI_ORG_POP_V1:',
  TREASURY_TRANSFER: 'SUI_ORG_TREASURY_TRANSFER_V1:',
} as const;

/** 组织绑定的链标识（DEFAULT_CHAIN_ID 固化 sui-testnet:；mainnet 走 create_organization_with_chain_id）。 */
export const CHAIN_IDS = {
  testnet: 'sui-testnet:',
  mainnet: 'sui-mainnet:',
} as const;

/** execute_threshold_proposal 的 action_type（事件里可见，无链上枚举；FROST 演示步自选数值）。 */

/** 协议硬上限。 */
export const LIMITS = {
  /** update_organization_roster 原子替换的名册上限。 */
  MAX_ROSTER_MEMBERS: 128,
} as const;

/** red_packet 协议上限（与合约常量逐一对齐；链下构造前先用它拒绝必拒载荷）。 */
export const RED_PACKET_LIMITS = {
  MAX_COUNT: 128,
  MAX_GREETING_BYTES: 256,
  MAX_DURATION_MS: 604_800_000,
} as const;

/** red_packet 命名错误（`#[error(code = N)]`，1–14 与合约逐一对齐）。 */
export const RED_PACKET_ERRORS: Readonly<Record<number, { name: string; message: string }>> = {
  1: { name: 'EChannelMismatch', message: 'Packet must belong to the supplied channel.' },
  2: { name: 'ENotMember', message: 'Sender must be a current member of the bound channel.' },
  3: { name: 'EInvalidCount', message: 'Count must be between one and 128.' },
  4: { name: 'EGreetingTooLong', message: 'Greeting must contain at most 256 UTF-8 bytes.' },
  5: { name: 'EInvalidDuration', message: 'Duration must be between one millisecond and seven days.' },
  6: { name: 'EExpiryOverflow', message: 'Expiry timestamp must fit in u64 milliseconds.' },
  7: { name: 'EInsufficientAmount', message: 'Escrow must fund at least one base unit per claim.' },
  8: { name: 'ERefunded', message: 'Packet has already been refunded.' },
  9: { name: 'EWrongAllocation', message: 'Claim endpoint must match the packet allocation mode.' },
  10: { name: 'EExpired', message: 'Claims must occur at or before the expiry millisecond.' },
  11: { name: 'EExhausted', message: 'Packet must have an unclaimed allocation.' },
  12: { name: 'EAlreadyClaimed', message: 'Sender may claim at most once per packet.' },
  13: { name: 'ENotCreator', message: 'Only the original funding sender may refund escrow.' },
  14: { name: 'ENotExpired', message: 'Refund must occur strictly after the expiry millisecond.' },
};

/** cryptographic_org 数字错误码（1004 与 1010 已随清理删除，不在表内；创建与改册现在统一用 EUnreachableThreshold）。 */
export const ORG_ERRORS: Readonly<Record<number, string>> = {
  1001: 'E_INVALID_SIGNATURE',
  1002: 'E_PROPOSAL_ALREADY_EXECUTED',
  1003: 'E_INVALID_PK_LENGTH',
  1005: 'E_EMPTY_MEMBERS',
  1006: 'E_INVALID_NONCE',
  1007: 'E_SESSION_NOT_FINALIZED',
  1008: 'E_THRESHOLD_EXCEEDS_SIGNERS',
  1009: 'E_THRESHOLD_BELOW_KEY',
  1010: 'E_INVALID_POP',
};

/**
 * cryptographic_org 命名错误（`#[error(code = N)]`，1–3）：名册/门限校验走这套
 * 带消息的错误，与 1001–1009 的数字码**是两套编号空间**，共用同一模块名。
 */
export const ORG_NAMED_ERRORS: Readonly<Record<number, { name: string; message: string }>> = {
  1: { name: 'EInvalidRoster', message: 'Roster must contain 1 to 128 distinct nonzero addresses with matching positive weights, and cover the current roster exactly.' },
  2: { name: 'EUnreachableThreshold', message: 'Threshold weight must be positive and must not exceed the sum of the roster weights.' },
  3: { name: 'ENoRosterChange', message: 'The supplied roster and threshold are identical to the stored organization.' },
  4: { name: 'EKeySignerRemoved', message: 'Removing a key signer from the roster requires rotating the group key first.' },
};

/** agent_vault::vault 数字错误码（2001–2011 与合约常量逐一对齐）。 */
export const VAULT_ERRORS: Readonly<Record<number, string>> = {
  2001: 'E_EXCEEDED_DAILY_QUOTA',
  2002: 'E_AGENT_PAUSED',
  2003: 'E_CAP_VERSION_MISMATCH',
  2004: 'E_INSUFFICIENT_VAULT_BALANCE',
  2005: 'E_UNAUTHORIZED_OPERATOR',
  2006: 'E_ZERO_AMOUNT',
  2007: 'E_UNCHANGED_VALUE',
  2008: 'E_AGENT_NOT_FOUND',
  2009: 'E_AGENT_LIMIT_REACHED',
  2010: 'E_AGENT_ALREADY_SPAWNED',
  2011: 'E_INVALID_SERVICE_HASH',
  2012: 'E_EXCEEDS_AGENT_BUDGET_CAP',
  2013: 'E_EXCEEDS_EPOCH_OUTFLOW',
  2014: 'E_ZERO_RECIPIENT',
};

/** asynchronous_proposal 数字错误码（2701 门限签名校验失败，与合约逐一对齐）。 */
export const ASYNC_PROPOSAL_ERRORS: Readonly<Record<number, string>> = {
  2701: 'E_THRESHOLD_SIGNATURE_INVALID',
};

/** dkg_committee 数字错误码（3013 死桩已删除，不在表内）。 */
export const DKG_ERRORS: Readonly<Record<number, string>> = {
  3001: 'E_NOT_A_PARTICIPANT',
  3002: 'E_INVALID_SESSION_STATUS',
  3003: 'E_ALREADY_SUBMITTED',
  3004: 'E_SESSION_EXPIRED',
  3005: 'E_QUORUM_NOT_REACHED',
  3006: 'E_SESSION_NOT_EXPIRED',
  3007: 'E_INVALID_PUBLIC_KEY_LENGTH',
  3008: 'E_PAYLOAD_MISMATCH',
  3009: 'E_INVALID_ENCRYPTION_KEY',
  3010: 'E_ENCRYPTION_KEY_CONFLICT',
  3011: 'E_NOT_CONFIRMED',
  3012: 'E_KEY_NOT_ATTESTED',
  3015: 'E_INVALID_COMMITMENT',
  3016: 'E_COMMITMENT_MISSING',
};

/** asset_custody 命名错误（#[error(code = N)]，1–21 与合约逐一对齐）。 */
export const ASSET_CUSTODY_ERRORS: Readonly<Record<number, { name: string; message: string }>> = {
  1: { name: 'ENotMember', message: 'Custody intake and proposals require a current organization member with positive weight.' },
  2: { name: 'EWrongOrganization', message: 'Organization must match the governing object stored by the custody or proposal.' },
  3: { name: 'EWrongCustody', message: "Custody must match the proposal's stored custody, and a returned asset must re-enter the custody that lent it." },
  4: { name: 'EProposalNotPending', message: 'Only a pending proposal accepts decisions or execution.' },
  5: { name: 'EProposalExpired', message: 'The inclusive proposal deadline has passed.' },
  6: { name: 'EAlreadyVoted', message: 'Each member may cast one approval or rejection per proposal.' },
  7: { name: 'EApprovalThresholdMet', message: 'Rejection voting closes once approvals reach the proposal threshold.' },
  8: { name: 'EThresholdNotMet', message: "Execution requires the proposal's snapshotted approval threshold." },
  9: { name: 'EEpochMismatch', message: "Proposal epoch must match the organization's current epoch." },
  10: { name: 'EWrongProposalKind', message: 'Proposal kind must be borrow for take, release for transfer-out, and known at creation.' },
  11: { name: 'ESlotNotCustodied', message: 'The slot must currently hold a custodied asset.' },
  12: { name: 'ETooManyTypes', message: 'Custody admits at most 64 live asset types.' },
  13: { name: 'ETooManySlots', message: 'Custody admits at most 128 live slots per asset type.' },
  14: { name: 'EInvalidRecipient', message: 'Release proposals must name a nonzero recipient; borrow proposals must name none.' },
  15: { name: 'EInvalidTitle', message: 'Proposal title must contain between 1 and 256 bytes.' },
  16: { name: 'EInvalidDeadline', message: 'Proposal deadline must be in the future and no more than 365 days away in milliseconds.' },
  17: { name: 'EWeightMismatch', message: 'Claimed weight must equal the live organization roster weight.' },
  18: { name: 'EUnknownSlot', message: 'Proposal creation requires a slot that currently holds a custodied asset.' },
  19: { name: 'EWrongAsset', message: 'A returned asset must be the exact object the receipt was issued for.' },
  20: { name: 'ESlotReassigned', message: 'The approved slot now holds a different asset than the proposal approved.' },
  21: { name: 'EBorrowerMismatch', message: "Only the proposal's proposer may borrow; a release remains relayable because its recipient is frozen." },
};

export const GOVERNANCE_POLL_ERRORS: Readonly<Record<number, { name: string; message: string }>> = {
  1: { name: 'EInvalidMode', message: 'Mode must be single (0), multiple approval (1), or full Borda ranking (2).' },
  2: { name: 'EInvalidText', message: 'Title, description, or option text violates its byte bound, or options repeat.' },
  3: { name: 'EInvalidOptions', message: 'A poll requires between 2 and 16 options.' },
  4: { name: 'EInvalidElectorate', message: 'A poll requires 1 to 128 distinct, nonzero voters with matching weights.' },
  5: { name: 'EInvalidWeight', message: 'Each weight must be between 1 and 1000000000.' },
  6: { name: 'EInvalidDeadline', message: 'Deadline must be after Clock time and no more than 365 days away.' },
  7: { name: 'ENotGroupMember', message: 'Publisher and selected group voters must be members of this Organization.' },
  8: { name: 'EManualGroupMember', message: 'A group member cannot bypass their group weight through the manual electorate.' },
  9: { name: 'EClosed', message: 'Voting is closed at and after deadline_ms.' },
  10: { name: 'ENotVoter', message: 'The transaction sender is not in this poll\'s fixed electorate.' },
  11: { name: 'EAlreadyVoted', message: 'A voter may cast exactly one ballot in this poll.' },
  12: { name: 'EInvalidBallot', message: 'Ballot must contain distinct valid indices with the cardinality required by the poll mode.' },
};

export const SCALLOP_ERRORS: Readonly<Record<number, string>> = {
  7001: 'E_NOT_AUTHORIZED',
  7002: 'E_NO_YIELD_AVAILABLE',
  7003: 'E_INSUFFICIENT_SSUI',
};

export const WALRUS_POLICY_ERRORS: Readonly<Record<number, { name: string; message: string }>> = {
  1: { name: 'EWrongRegistry', message: 'Admin capability must belong to this exact registry.' },
  2: { name: 'EInvalidBlobId', message: 'Blob ID must contain between one and 128 UTF-8 bytes.' },
  3: { name: 'EAlreadyRegistered', message: 'Payment app must not already be registered.' },
  4: { name: 'ERegistryFull', message: 'Registry must contain fewer than 128 apps before registration.' },
  5: { name: 'EZeroStakeChannel', message: 'Payment channel must require a positive member stake.' },
  6: { name: 'EInvalidMinStake', message: 'Minimum member stake must be positive.' },
  7: { name: 'EMinStakeTooHigh', message: 'Minimum member stake must not exceed the channel requirement.' },
  8: { name: 'EInvalidRecipient', message: 'Payment recipient must not be the zero address.' },
  9: { name: 'EInvalidMaxPayment', message: 'Maximum payment must be positive MIST.' },
  10: { name: 'EInvalidEpochBudget', message: 'Per-epoch payment budget must be positive MIST.' },
  11: { name: 'EAppNotFound', message: 'Payment app must be registered in this registry.' },
  12: { name: 'EAppDisabled', message: 'Payment app must be active.' },
  13: { name: 'EUnchangedStatus', message: 'New app status must differ from its current status.' },
  14: { name: 'EWrongChannel', message: 'Policy, channel and stake receipt must identify the same channel.' },
  15: { name: 'ENotReceiptMember', message: 'Sender must be the original member embedded in the receipt.' },
  16: { name: 'EInvalidReceiptStake', message: 'Receipt stake must equal the positive channel requirement and meet the policy minimum.' },
  17: { name: 'ENotMember', message: 'Receipt member must still belong to the channel.' },
  18: { name: 'EZeroPayment', message: 'Actual payment coin value must be positive MIST.' },
  19: { name: 'EExceededTxLimit', message: 'Actual payment coin value must not exceed the per-payment limit.' },
  20: { name: 'EExceededEpochBudget', message: "Actual payment coin value must fit the app's remaining epoch budget." },
};

/** onchain_chat 数字错误码（6001–6020 与合约常量逐一对齐）。 */
export const CHAT_ERRORS: Readonly<Record<number, string>> = {
  6001: 'E_NOT_CHANNEL_MEMBER',
  6002: 'E_CAP_EXPIRED',
  6003: 'E_CAP_REVOKED',
  6004: 'E_UNAUTHORIZED_SUBAGENT',
  6005: 'E_CHANNEL_MISMATCH',
  6006: 'E_RATE_LIMIT_EXCEEDED',
  6007: 'E_INSUFFICIENT_STAKE',
  6008: 'E_NOT_CHANNEL_CREATOR',
  6009: 'E_INSUFFICIENT_PAYMENT',
  6010: 'E_INVALID_BPS_SUM',
  6011: 'E_ALREADY_MEMBER',
  6012: 'E_NOT_RECEIPT_OWNER',
  6013: 'E_MEMBERS_STILL_STAKED',
  6014: 'E_NO_REVENUE_TO_CLAIM',
  6015: 'E_EMPTY_BATCH',
  6016: 'E_BATCH_TOO_LARGE',
  6017: 'E_BATCH_LENGTH_MISMATCH',
  6018: 'E_MESSAGE_TOO_LONG',
  6019: 'E_MEMBER_STAKE_AT_RISK',
  6020: 'E_CANNOT_REMOVE_CREATOR',
};

/** 治理事件名；匹配时必须同时固定完整类型来源包，不能仅比较后缀。 */
export const GOVERNANCE_EVENTS = {
  proposalExecuted: 'cryptographic_org::ProposalExecutedEvent',
  organizationEpochUpdated: 'cryptographic_org::OrganizationEpochUpdatedEvent',
  groupKeyRotated: 'cryptographic_org::GroupKeyRotatedEvent',
  rosterUpdated: 'cryptographic_org::RosterUpdatedEvent',
  organizationCreated: 'cryptographic_org::OrganizationCreatedEvent',
} as const;

/** 把执行回执里的 MoveAbort 子状态翻译成可读错误。 */
export function explainAbort(substatus: string): string | null {
  // 形如 "MoveAbort(UserSubstatus(ModuleAddress(0x75ae…), cryptographic_org, 1006)) in ..."
  const m = substatus.match(/MoveAbort\(.*?ModuleAddress\(0x[0-9a-f]+\),\s*(\w+),\s*(\d+)\)/);
  if (!m) return null;
  const [, module, codeStr] = m;
  const code = Number(codeStr);
  if (module === 'cryptographic_org' && ORG_ERRORS[code]) return `cryptographic_org ${ORG_ERRORS[code]} (${code})`;
  if (module === 'cryptographic_org' && ORG_NAMED_ERRORS[code]) {
    return `cryptographic_org ${ORG_NAMED_ERRORS[code].name} (${code}): ${ORG_NAMED_ERRORS[code].message}`;
  }
  if (module === 'dkg_committee' && DKG_ERRORS[code]) return `dkg_committee ${DKG_ERRORS[code]} (${code})`;
  if (module === 'asset_custody' && ASSET_CUSTODY_ERRORS[code]) {
    return `asset_custody ${ASSET_CUSTODY_ERRORS[code].name} (${code}): ${ASSET_CUSTODY_ERRORS[code].message}`;
  }
  if (module === 'governance_poll' && GOVERNANCE_POLL_ERRORS[code]) {
    return `governance_poll ${GOVERNANCE_POLL_ERRORS[code].name} (${code}): ${GOVERNANCE_POLL_ERRORS[code].message}`;
  }
  if (module === 'scallop_yield_adapter' && SCALLOP_ERRORS[code]) return `scallop_yield_adapter ${SCALLOP_ERRORS[code]} (${code})`;
  if (module === 'walrus_app_policy' && WALRUS_POLICY_ERRORS[code]) {
    return `walrus_app_policy ${WALRUS_POLICY_ERRORS[code].name} (${code}): ${WALRUS_POLICY_ERRORS[code].message}`;
  }
  if (module === 'onchain_chat' && CHAT_ERRORS[code]) return `onchain_chat ${CHAT_ERRORS[code]} (${code})`;
  if (module === 'red_packet' && RED_PACKET_ERRORS[code]) {
    return `red_packet ${RED_PACKET_ERRORS[code].name} (${code}): ${RED_PACKET_ERRORS[code].message}`;
  }
  if (module === 'vault' && VAULT_ERRORS[code]) return `vault ${VAULT_ERRORS[code]} (${code})`;
  if (module === 'asynchronous_proposal' && ASYNC_PROPOSAL_ERRORS[code]) return `asynchronous_proposal ${ASYNC_PROPOSAL_ERRORS[code]} (${code})`;
  return `${module} error ${code} (未注册)`;
}
