/**
 * AgentVaultClient 的前端薄适配层。
 *
 * PTB 构造与域摘要全部委托给 link 的 `multisig` SDK（单一事实源）；本文件只
 * 保留跨 @mysten/sui 版本边界（SDK 2.33 / 本仓 2.36，Transaction 私有字段
 * 互不兼容）所需的一次性转换：SDK 自建 PTB，返回值 `as unknown as Transaction`
 * 断言为本地类型。把本地 Transaction 传进 SDK 永远不可行。
 *
 * 前端独有的 UX 校验（trim 非空、严格 10000 bps、未来到期）保留在此层，
 * 在委托前先行拒绝，错误文案与既有测试逐字一致。
 */
import type { Transaction, TransactionObjectArgument } from '@mysten/sui/transactions';
import { t } from './i18n/t';
import {
  AgentVaultClient as SdkAgentVaultClient,
  CHAIN_IDS,
  DEFAULT_AGENT_VAULT_PACKAGE_ID,
  buildCreateCreatorMonetizedChannel,
  buildCreateChannelWithStake,
  buildCreateSharedSubagentMessagingCap,
  buildJoinChannel,
  buildMemberUnstakeAndLeave,
  buildPostMessageBatch,
  buildPostMessagesSequential,
  buildRevokeSubagentMessagingCap,
  computeKeyRotationDigest as sdkKeyRotationDigest,
  computeProposalDigest as sdkProposalDigest,
  computeRosterUpdateDigest as sdkRosterDigest,
  computeThresholdApprovalDigest as sdkApprovalDigest,
  type VaultClientConfig,
} from 'multisig/agent-vault';

export { DEFAULT_AGENT_VAULT_PACKAGE_ID };
export type { VaultClientConfig };

/** Either an object id or an argument already produced by this transaction. */
type CoinInput = string | TransactionObjectArgument;

/** SDK(2.33) Transaction → 本地(2.36) Transaction 的边界断言。 */
const ptb = (sdkTx: unknown): Transaction => sdkTx as Transaction;

export class AgentVaultClient {
  public static readonly CLOCK_OBJECT_ID = SdkAgentVaultClient.CLOCK_OBJECT_ID;

  public readonly packageId: string;
  public readonly defaultCoinType: string;
  private readonly sdk: SdkAgentVaultClient;

  constructor(config?: VaultClientConfig) {
    this.packageId = config?.packageId ?? DEFAULT_AGENT_VAULT_PACKAGE_ID;
    this.defaultCoinType = config?.defaultCoinType ?? '0x2::sui::SUI';
    this.sdk = new SdkAgentVaultClient(config);
  }

  // ------------------------------------------------------------------
  // 金库 — 全部直通 SDK
  // ------------------------------------------------------------------

  public buildInitializeVaultPTB(recipientOrCoinType?: string, secondArg?: string): Transaction {
    return ptb(this.sdk.buildInitializeVaultPTB(recipientOrCoinType, secondArg));
  }
  public buildDepositPTB(vaultId: string, coinInput: CoinInput, coinType?: string): Transaction {
    return ptb(this.sdk.buildDepositPTB(vaultId, coinInput as unknown as string, coinType));
  }
  public buildWithdrawPTB(masterCapId: string, vaultId: string, amount: bigint | number, recipient: string, coinType?: string): Transaction {
    return ptb(this.sdk.buildWithdrawPTB(masterCapId, vaultId, amount, recipient, coinType));
  }
  public buildIssueOperatorCapPTB(masterCapId: string, vaultId: string, operatorAddress: string, coinType?: string): Transaction {
    return ptb(this.sdk.buildIssueOperatorCapPTB(masterCapId, vaultId, operatorAddress, coinType));
  }
  public buildSpawnAgentCardPTB(opCapId: string, vaultId: string, agentAddress: string, dailyBudget: bigint | number, serviceHash: Uint8Array | string = new Uint8Array(0), coinType?: string): Transaction {
    return ptb(this.sdk.buildSpawnAgentCardPTB(opCapId, vaultId, agentAddress, dailyBudget, serviceHash, coinType));
  }
  public buildSetAgentBudgetPTB(opCapId: string, vaultId: string, agentCapId: string, newDailyBudget: bigint | number, coinType?: string): Transaction {
    return ptb(this.sdk.buildSetAgentBudgetPTB(opCapId, vaultId, agentCapId, newDailyBudget, coinType));
  }
  public buildPauseAgentPTB(opCapId: string, vaultId: string, agentCapId: string, coinType?: string): Transaction {
    return ptb(this.sdk.buildPauseAgentPTB(opCapId, vaultId, agentCapId, coinType));
  }
  public buildResumeAgentPTB(opCapId: string, vaultId: string, agentCapId: string, coinType?: string): Transaction {
    return ptb(this.sdk.buildResumeAgentPTB(opCapId, vaultId, agentCapId, coinType));
  }
  public buildSpendX402BudgetPTB(agentCapId: string, vaultId: string, amount: bigint | number, recipient: string, coinType?: string): Transaction {
    return ptb(this.sdk.buildSpendX402BudgetPTB(agentCapId, vaultId, amount, recipient, coinType));
  }
  public buildEmergencyPurgePTB(masterCapId: string, vaultId: string, sweepRecipient: string, coinType?: string): Transaction {
    return ptb(this.sdk.buildEmergencyPurgePTB(masterCapId, vaultId, sweepRecipient, coinType));
  }

  // ------------------------------------------------------------------
  // 密码学组织 / 门限治理 — 直通
  // ------------------------------------------------------------------

  public buildCreateOrganizationPTB(groupPk: Uint8Array, keyThreshold: bigint | number, thresholdWeight: bigint | number, members: string[], weights: (bigint | number)[], popSignature: Uint8Array): Transaction {
    return ptb(this.sdk.buildCreateOrganizationPTB(groupPk, keyThreshold, thresholdWeight, members, weights, popSignature));
  }
  public buildAdvanceOrganizationEpochPTB(orgId: string, nonce: bigint | number, frostSignature: Uint8Array): Transaction {
    return ptb(this.sdk.buildAdvanceOrganizationEpochPTB(orgId, nonce, frostSignature));
  }
  public buildRotateGroupKeyPTB(orgId: string, nonce: bigint | number, newGroupPk: Uint8Array, newSigners: string[], keyThreshold: bigint | number, popSignature: Uint8Array, frostSignature: Uint8Array): Transaction {
    return ptb(this.sdk.buildRotateGroupKeyPTB(orgId, nonce, newGroupPk, newSigners, keyThreshold, popSignature, frostSignature));
  }
  public buildUpdateOrganizationRosterPTB(orgId: string, nonce: bigint | number, priorMembers: string[], members: string[], weights: (bigint | number)[], newThresholdWeight: bigint | number, frostSignature: Uint8Array): Transaction {
    return ptb(this.sdk.buildUpdateOrganizationRosterPTB(orgId, nonce, priorMembers, members, weights, newThresholdWeight, frostSignature));
  }

  /** 资产托管：创建共享托管金库（new + share；正权重成员发起）。 */
  public buildCreateAssetCustodyPTB(orgId: string): Transaction {
    return ptb(this.sdk.buildCreateAssetCustodyPTB(orgId));
  }

  /** 资产托管：存入一件 owned 对象（动态子对象托管，原 ID 仍可独立读取）。 */
  public buildDepositAssetPTB(custodyId: string, orgId: string, assetType: string, assetId: string): Transaction {
    return ptb(this.sdk.buildDepositAssetPTB(custodyId, orgId, assetType, assetId));
  }

  /** 资产托管：发起动用提案（borrow 借出一个 PTB / release 永久转出，收款人冻结在提案里）。 */
  public buildCreateCustodyProposalPTB(input: {
    custodyId: string; orgId: string; assetType: string; kind: number; slot: bigint | number;
    title: string | Uint8Array; deadlineMs: bigint | number; recipient?: string; actionDigest?: string | Uint8Array;
  }): Transaction {
    return ptb(this.sdk.buildCreateCustodyProposalPTB(input));
  }

  /** 资产托管：赞成 / 否决（claimedWeight 须与链上名册一致）。 */
  public buildSubmitCustodyVotePTB(proposalId: string, orgId: string, claimedWeight: bigint | number): Transaction {
    return ptb(this.sdk.buildSubmitCustodyVotePTB(proposalId, orgId, claimedWeight));
  }

  public buildRejectCustodyVotePTB(proposalId: string, orgId: string): Transaction {
    return ptb(this.sdk.buildRejectCustodyVotePTB(proposalId, orgId));
  }

  /** 资产托管：执行转出（资产转给提案冻结的收款人）。 */
  public buildExecuteReleasePTB(custodyId: string, proposalId: string, orgId: string, assetType: string): Transaction {
    return ptb(this.sdk.buildExecuteReleasePTB(custodyId, proposalId, orgId, assetType));
  }

  /**
   * 资产托管升级模板：借出 → 授权 → 升级 → 提交 → 归还 一笔完成。
   * 六命令 PTB 全在 SDK 侧构建后一次跨界（模板内部有 Upgrade 命令，不可拆）。
   */
  public buildCustodyUpgradeTemplatePTB(input: {
    custodyId: string; proposalId: string; orgId: string;
    modules: string[] | number[][]; dependencies: string[]; digest32: Uint8Array;
    currentPackageId: string; gasBudgetMist?: bigint;
  }): Transaction {
    return ptb(this.sdk.buildCustodyUpgradeTemplatePTB(input));
  }
  public buildCreateOrganizationFromSessionPTB(sessionId: string, thresholdWeight: bigint | number): Transaction {
    return ptb(this.sdk.buildCreateOrganizationFromSessionPTB(sessionId, thresholdWeight));
  }

  // ------------------------------------------------------------------
  // DKG 会话 (dkg_committee) — 直通
  // ------------------------------------------------------------------

  public buildCreateDkgSessionPTB(sender: string, threshold: bigint | number, participants: string[], deadlineTimestampMs: bigint | number): Transaction {
    return ptb(this.sdk.buildCreateDkgSessionPTB(sender, threshold, participants, deadlineTimestampMs));
  }
  public buildConfirmParticipantPTB(sessionId: string): Transaction {
    return ptb(this.sdk.buildConfirmParticipantPTB(sessionId));
  }
  public buildSubmitCommitmentPTB(sessionId: string, commitmentBytes: Uint8Array): Transaction {
    return ptb(this.sdk.buildSubmitCommitmentPTB(sessionId, commitmentBytes));
  }
  public buildRegisterEncryptionKeyPTB(sessionId: string, encryptionPublicKey: Uint8Array): Transaction {
    return ptb(this.sdk.buildRegisterEncryptionKeyPTB(sessionId, encryptionPublicKey));
  }
  public buildDepositMailboxSharePTB(sessionId: string, recipient: string, encryptedPayload: Uint8Array): Transaction {
    return ptb(this.sdk.buildDepositMailboxSharePTB(sessionId, recipient, encryptedPayload));
  }
  public buildSubmitAsyncPackagePTB(sessionId: string, commitmentBytes: Uint8Array, attestPublicKey: Uint8Array, recipients: string[], encryptedPayloads: Uint8Array[]): Transaction {
    return ptb(this.sdk.buildSubmitAsyncPackagePTB(sessionId, commitmentBytes, attestPublicKey, recipients, encryptedPayloads));
  }
  /** 现行 attest_group_key 入口不再读 Clock；clockId 仅保留兼容旧签名，忽略。 */
  public buildAttestGroupKeyPTB(sessionId: string, groupPublicKey: Uint8Array, attestationSignature: Uint8Array, _clockId = AgentVaultClient.CLOCK_OBJECT_ID): Transaction {
    return ptb(this.sdk.buildAttestGroupKeyPTB(sessionId, groupPublicKey, attestationSignature));
  }
  public buildFinalizeSessionPTB(sessionId: string, groupPublicKey: Uint8Array): Transaction {
    return ptb(this.sdk.buildFinalizeSessionPTB(sessionId, groupPublicKey));
  }
  public buildHandleSessionTimeoutPTB(sessionId: string): Transaction {
    return ptb(this.sdk.buildHandleSessionTimeoutPTB(sessionId));
  }

  // ------------------------------------------------------------------
  // 全异步治理提案 (asynchronous_proposal) — 直通
  // ------------------------------------------------------------------

  public buildCreateTransferProposalPTB(orgId: string, title: string, recipient: string, amount: bigint | number, deadlineMs: bigint | number): Transaction {
    return ptb(this.sdk.buildCreateTransferProposalPTB(orgId, title, recipient, amount, deadlineMs));
  }
  public buildSubmitAsyncVotePTB(proposalId: string, orgId: string, claimedWeight: bigint | number, partialSignature: Uint8Array): Transaction {
    return ptb(this.sdk.buildSubmitAsyncVotePTB(proposalId, orgId, claimedWeight, partialSignature));
  }
  public buildRejectAsyncVotePTB(proposalId: string, orgId: string): Transaction {
    return ptb(this.sdk.buildRejectAsyncVotePTB(proposalId, orgId));
  }
  public buildSubmitAsyncVoteBySubagentPTB(proposalId: string, orgId: string, subagentCapId: string, partialSignature: Uint8Array): Transaction {
    return ptb(this.sdk.buildSubmitAsyncVoteBySubagentPTB(proposalId, orgId, subagentCapId, partialSignature));
  }
  public buildExecuteTransferProposalPTB(proposalId: string, orgId: string, vaultId: string, masterCapId: string, coinType?: string): Transaction {
    return ptb(this.sdk.buildExecuteTransferProposalPTB(proposalId, orgId, vaultId, masterCapId, coinType));
  }
  public buildCreateSharedSubagentCapPTB(orgId: string, agentAddress: string, voterWeight: bigint | number, maxBudgetPerTx: bigint | number, dailyBudgetLimit: bigint | number, expiresAtMs: bigint | number): Transaction {
    return ptb(this.sdk.buildCreateSharedSubagentCapPTB(orgId, agentAddress, voterWeight, maxBudgetPerTx, dailyBudgetLimit, expiresAtMs));
  }
  public buildRevokeSubagentCapPTB(capId: string): Transaction {
    return ptb(this.sdk.buildRevokeSubagentCapPTB(capId));
  }
  public buildShadowFollowVotePTB(proposalId: string, orgId: string, subagentCapId: string): Transaction {
    return ptb(this.sdk.buildShadowFollowVotePTB(proposalId, orgId, subagentCapId));
  }

  // ------------------------------------------------------------------
  // 链上红包 (red_packet_v2) — 直通；红包+消息同 PTB 组合保留在此层
  // ------------------------------------------------------------------

  public buildCreateRedPacketPTB(channelId: string, totalAmount: bigint | number, count: number, isRandom: boolean, message: string = "恭喜发财，万事大吉！", durationMs: number = 86400000, coinType?: string): Transaction {
    return ptb(this.sdk.buildCreateRedPacketPTB(channelId, totalAmount, count, isRandom, message, durationMs, coinType));
  }
  public buildClaimRedPacketPTB(packetId: string, channelId: string, coinType?: string): Transaction {
    return ptb(this.sdk.buildClaimRedPacketPTB(packetId, channelId, coinType));
  }
  public buildRefundRedPacketPTB(packetId: string, coinType?: string): Transaction {
    return ptb(this.sdk.buildRefundRedPacketPTB(packetId, coinType));
  }

  /** Create a packet and publish its greeting in the same atomic PTB. */
  public buildCreateRedPacketWithMessagePTB(channelId: string, totalAmount: bigint | number, count: number, isRandom: boolean, message: string, durationMs: number = 86400000, coinType?: string): Transaction {
    // 在 SDK 事务对象上继续拼接（操作的是 SDK 自建事务，不跨版本传值）。
    const tx = this.sdk.buildCreateRedPacketPTB(channelId, totalAmount, count, isRandom, message, durationMs, coinType);
    tx.moveCall({
      target: `${this.packageId}::onchain_chat::post_message`,
      arguments: [tx.object(channelId), tx.object(AgentVaultClient.CLOCK_OBJECT_ID), tx.pure.vector('u8', []), tx.pure.vector('u8', Array.from(new TextEncoder().encode(message)))],
    });
    return ptb(tx);
  }

  // ------------------------------------------------------------------
  // 链上群聊 (onchain_chat) — SDK chat 切片 + 钱包流（gas 支付）变体
  // ------------------------------------------------------------------

  public buildCreateChatChannelPTB(orgAddress: string, name: string, initialMembers: string[]): Transaction {
    return ptb(this.sdk.buildCreateChatChannelPTB(orgAddress, name, initialMembers));
  }

  /** Creator stake and member economics are explicit; no yield is generated by this call. */
  public buildCreateStakedChatChannelPTB(orgAddress: string, name: string, initialMembers: string[], creatorStake: bigint): Transaction {
    if (creatorStake <= 0n) throw new Error('Creator stake must be positive');
    return ptb(buildCreateChannelWithStake({ packageId: this.packageId, orgId: orgAddress, name, initialMembers, stake: { amount: creatorStake } }));
  }

  public buildCreateMembershipChatChannelPTB(orgAddress: string, name: string, creatorStake: bigint, entryFee: bigint, memberStake: bigint, shares: [number, number, number]): Transaction {
    if ([creatorStake, entryFee, memberStake].some(value => value < 0n)) throw new Error('Amounts cannot be negative');
    if (shares.some(value => !Number.isInteger(value) || value < 0) || shares.reduce((sum, value) => sum + value, 0) !== 10000) throw new Error('Yield shares must total 10000 BPS');
    return ptb(buildCreateCreatorMonetizedChannel({ packageId: this.packageId }, {
      orgId: orgAddress, name, creatorStake: { amount: creatorStake }, entryFee, requiredMemberStake: memberStake,
      creatorYieldShareBps: BigInt(shares[0]), gasSubsidyShareBps: BigInt(shares[1]), memberRebateShareBps: BigInt(shares[2]),
    }));
  }

  /**
   * 入群：门票 + 保本质押一次付清，receipt 直接转给实际发送者。
   * `paymentAmount` 是该频道的应付总额（门票 + 质押，来自频道状态）；
   * 币源由 SDK 统一解析——地址余额与 owned coin 之间自动择优。
   */
  public buildJoinChatChannelPTB(channelId: string, paymentAmount: bigint): Transaction {
    if (paymentAmount < 0n) throw new Error('Payment amount cannot be negative');
    return ptb(buildJoinChannel({ packageId: this.packageId, channelId, payment: { amount: paymentAmount } }));
  }

  /** Consumes the sender's typed receipt and returns principal through the entry sink. */
  public buildLeaveChatChannelPTB(channelId: string, receiptId: string): Transaction {
    return ptb(buildMemberUnstakeAndLeave({ packageId: this.packageId, channelId, receiptId }));
  }

  /** 发送频道消息（附带 Walrus 去中心化存储 Blob ID 索引） */
  public buildPostChatMessagePTB(channelId: string, contentPreview: string, walrusBlobId: string = ""): Transaction {
    return ptb(this.sdk.buildPostChatMessagePTB(channelId, contentPreview, walrusBlobId));
  }

  /**
   * Send a burst through the deployed `post_message_batch` entry point: the
   * contract advances one sequence and emits one event per line, but the
   * transaction and the 0.001 SUI subsidy transfer are paid once for the burst.
   */
  public buildPostChatMessageBatchPTB(channelId: string, contentPreviews: string[]): Transaction {
    if (contentPreviews.length === 0) throw new Error(t("vault.noMessagesToSend"))
    if (contentPreviews.length > 32) throw new Error(t("vault.maxMergedMessages"))
    if (contentPreviews.some(text => !text.trim())) throw new Error(t("vault.emptyMessage"))
    return ptb(buildPostMessageBatch({ packageId: this.packageId, channelId }, contentPreviews.map(text => ({
      walrusBlobId: new Uint8Array(),
      contentPreview: new TextEncoder().encode(text),
    }))));
  }

  /**
   * Fallback for an older package: one `post_message` per line inside one PTB.
   * Each line still triggers its own subsidy transfer in that contract, so this
   * saves only the transaction envelope, not the per-line rebate.
   */
  public buildPostChatMessagesPTB(channelId: string, contentPreviews: string[]): Transaction {
    if (contentPreviews.length === 0) throw new Error(t("vault.noMessagesToSend"))
    if (contentPreviews.length > 32) throw new Error(t("vault.maxMergedMessages"))
    if (contentPreviews.some(text => !text.trim())) throw new Error(t("vault.emptyMessage"))
    return ptb(buildPostMessagesSequential({ packageId: this.packageId, channelId }, contentPreviews));
  }

  /** Subagent / AI 哨兵代发频道消息 */
  public buildPostChatMessageBySubagentPTB(channelId: string, capId: string, contentPreview: string, walrusBlobId: string = ""): Transaction {
    return ptb(this.sdk.buildPostChatMessageBySubagentPTB(channelId, capId, contentPreview, walrusBlobId));
  }

  /** 签发并共享 Subagent 发信 Cap；cap_id 从创建对象/事件读取。 */
  public buildCreateSharedSubagentMessagingCapPTB(channelId: string, agentAddress: string, expiresAtMs: bigint | number, rateLimitPerMinute: bigint | number): Transaction {
    if (BigInt(rateLimitPerMinute) <= 0n) throw new Error('Rate limit must be positive');
    if (BigInt(expiresAtMs) <= BigInt(Date.now())) throw new Error('Expiry must be in the future');
    return ptb(buildCreateSharedSubagentMessagingCap({ packageId: this.packageId, channelId }, {
      agentAddress, expiresAtMs: BigInt(expiresAtMs), rateLimitPerMinute: BigInt(rateLimitPerMinute),
    }));
  }

  /** 主账号吊销 Subagent 发信资格。 */
  public buildRevokeSubagentMessagingCapPTB(capId: string): Transaction {
    return ptb(buildRevokeSubagentMessagingCap({ packageId: this.packageId, capId }));
  }

  // ------------------------------------------------------------------
  // 核心钱包能力 (Direct Wallet Transfers & Batch Payments) — 直通
  // ------------------------------------------------------------------

  public buildDirectTransferPTB(recipient: string, amountMist: bigint | number): Transaction {
    return ptb(this.sdk.buildDirectTransferPTB(recipient, amountMist));
  }
  public buildBatchTransferPTB(transfers: { recipient: string; amountMist: bigint | number }[]): Transaction {
    return ptb(this.sdk.buildBatchTransferPTB(transfers));
  }
}

// --------------------------------------------------------------------
// 域隔离摘要 — 算法在 SDK org/digest（单一事实源），此处仅保留前端
// 一直使用的位置参数签名包装。
// --------------------------------------------------------------------

export function computeProposalDigest(chainId: Uint8Array | string, orgId: string, epochVersion: bigint | number, nonce: bigint | number, payload: Uint8Array, actionType: number): Uint8Array {
  return sdkProposalDigest({ chainId, orgId, epochVersion, nonce, payload, actionType });
}

export function computeThresholdApprovalDigest(chainId: Uint8Array | string, orgId: string, epochVersion: bigint | number, nonce: bigint | number, newEpochVersion: bigint | number): Uint8Array {
  return sdkApprovalDigest({ chainId, orgId, epochVersion, nonce, newEpochVersion });
}

export function computeKeyRotationDigest(chainId: Uint8Array | string, orgId: string, epochVersion: bigint | number, nonce: bigint | number, newGroupPk: Uint8Array, newSigners: string[], keyThreshold: bigint | number): Uint8Array {
  return sdkKeyRotationDigest({ chainId, orgId, epochVersion, nonce, newGroupPk, newSigners, keyThreshold });
}

export function computeRosterUpdateDigest(chainId: Uint8Array | string, orgId: string, epochVersion: bigint | number, nonce: bigint | number, newEpochVersion: bigint | number, thresholdWeight: bigint | number, members: string[], weights: (bigint | number)[]): Uint8Array {
  if (members.length !== weights.length) throw new Error('Roster members and weights must have equal length')
  return sdkRosterDigest({ chainId, orgId, epochVersion, nonce, newEpochVersion, thresholdWeight, newMembers: members, newWeights: weights });
}


/** 默认链域，与合约 DEFAULT_CHAIN_ID 一致。 */
export const DEFAULT_ORG_CHAIN_ID = CHAIN_IDS.testnet;
