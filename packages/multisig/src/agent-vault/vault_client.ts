import { Transaction, type TransactionArgument } from '@mysten/sui/transactions';

import { AGENT_VAULT_PACKAGE_ID, LIMITS, RED_PACKET_LIMITS, SUI_CLOCK_OBJECT_ID, SUI_RANDOM_OBJECT_ID } from './org/constants';
import { canonicalAddress } from './org/bcs';
import {
  buildCreateAssetCustody, buildDepositAsset, buildCreateCustodyProposal,
  buildSubmitCustodyVote, buildRejectCustodyVote, buildExecuteRelease,
  buildTakeAssetStep, buildReturnAssetStep, buildCustodyUpgradeTemplate,
} from './custody';
import type { BorrowedAssetStep, CustodyProposalInput } from './custody';
import {
  buildInitializeAgentVault, buildWithdrawAgentVault, buildIssueVaultOperator,
  buildSpawnVaultAgent, buildSetVaultAgentBudget, buildSetVaultAgentPaused,
  buildSpendVaultAgent, buildPurgeAgentVault, financeAddress, financeCoin, financeCoinType, financeU64, FINANCE_SUI_TYPE,
  type FinanceCoinSource,
} from './finance';

/** 单一事实源在 org/constants（现行 fresh lineage 包）。 */
export const DEFAULT_AGENT_VAULT_PACKAGE_ID = AGENT_VAULT_PACKAGE_ID;

export interface VaultClientConfig {
  packageId?: string;
  defaultCoinType?: string;
}

export class AgentVaultClient {
  public readonly packageId: string;
  public readonly defaultCoinType: string;

  constructor(config?: VaultClientConfig) {
    this.packageId = config?.packageId ?? DEFAULT_AGENT_VAULT_PACKAGE_ID;
    this.defaultCoinType = config?.defaultCoinType ?? FINANCE_SUI_TYPE;
  }

  /**
   * 1. 部署/初始化金库，产出 MasterCap
   */
  public buildInitializeVaultPTB(
    recipientOrCoinType?: string,
    secondArg?: string
  ): Transaction {
    const tx = new Transaction();
    let recipient: string | undefined;
    let coinType: string;

    if (recipientOrCoinType && recipientOrCoinType.includes('::')) {
      coinType = recipientOrCoinType;
      recipient = secondArg;
    } else {
      recipient = recipientOrCoinType;
      coinType = secondArg && secondArg.includes('::') ? secondArg : this.defaultCoinType;
    }

    if (!recipient) throw new Error('初始化金库必须指定 MasterCap 收件人。');
    return buildInitializeAgentVault({ packageId: this.packageId, coinType, recipient, transaction: tx }) as Transaction;
  }

  /**
   * 存入资金到金库。
   *
   * `payment` 沿支付统一约定：给 `coin`（对象 ID / 本 PTB 句柄 / 列表）原样存入，
   * 或只给 `amount` 由 tx.coin() 生成精确 Coin（自动在地址余额与 owned coin
   * 之间择优，无需调用方预先拼币）。
   */
  public buildDepositPTB(vaultId: string, payment: FinanceCoinSource, coinType?: string, transaction?: Transaction): Transaction {
    const tx = transaction ?? new Transaction();
    const typeArg = financeCoinType(coinType ?? this.defaultCoinType);
    tx.moveCall({
      target: `${financeAddress(this.packageId)}::vault::deposit`,
      typeArguments: [typeArg],
      arguments: [tx.object(financeAddress(vaultId)), financeCoin(tx, typeArg, payment)],
    });
    return tx;
  }

  /**
   * Master 提现本金
   */
  public buildWithdrawPTB(
    masterCapId: string,
    vaultId: string,
    amount: bigint | number,
    recipient: string,
    coinType?: string
  ): Transaction {
    return buildWithdrawAgentVault({ packageId: this.packageId, coinType: coinType ?? this.defaultCoinType, masterCapId, vaultId, amount: financeU64(amount, true), recipient });
  }

  /**
   * 2. Master 颁发 OperatorCap 给运维经理
   */
  public buildIssueOperatorCapPTB(
    masterCapId: string,
    vaultId: string,
    operatorAddress: string,
    coinType?: string
  ): Transaction {
    return buildIssueVaultOperator({ packageId: this.packageId, coinType: coinType ?? this.defaultCoinType, masterCapId, vaultId, operator: operatorAddress });
  }

  /**
   * 3. Operator 孵化 AI Agent 虚拟打工卡
   */
  public buildSpawnAgentCardPTB(
    opCapId: string,
    vaultId: string,
    agentAddress: string,
    dailyBudget: bigint | number,
    serviceHash: Uint8Array | string = new Uint8Array(0),
    coinType?: string
  ): Transaction {
    return buildSpawnVaultAgent({
      packageId: this.packageId, coinType: coinType ?? this.defaultCoinType,
      operatorCapId: opCapId, vaultId, agent: agentAddress, dailyBudget: financeU64(dailyBudget),
      serviceHash: typeof serviceHash === 'string' ? new TextEncoder().encode(serviceHash) : serviceHash,
    });
  }

  /**
   * Operator 调整 Agent 每日额度
   */
  public buildSetAgentBudgetPTB(
    opCapId: string,
    vaultId: string,
    agentAddress: string,
    newDailyBudget: bigint | number,
    coinType?: string
  ): Transaction {
    return buildSetVaultAgentBudget({ packageId: this.packageId, coinType: coinType ?? this.defaultCoinType, operatorCapId: opCapId, vaultId, agentAddress, dailyBudget: financeU64(newDailyBudget) });
  }

  /**
   * Operator 暂停 Agent
   */
  public buildPauseAgentPTB(
    opCapId: string,
    vaultId: string,
    agentAddress: string,
    coinType?: string
  ): Transaction {
    return buildSetVaultAgentPaused({ packageId: this.packageId, coinType: coinType ?? this.defaultCoinType, operatorCapId: opCapId, vaultId, agentAddress, paused: true });
  }

  /**
   * Operator 恢复 Agent
   */
  public buildResumeAgentPTB(
    opCapId: string,
    vaultId: string,
    agentAddress: string,
    coinType?: string
  ): Transaction {
    return buildSetVaultAgentPaused({ packageId: this.packageId, coinType: coinType ?? this.defaultCoinType, operatorCapId: opCapId, vaultId, agentAddress, paused: false });
  }

  /**
   * 4. Agent 执行微支付 (核心沙盒防爆与 Epoch 限额扣减)
   */
  public buildSpendX402BudgetPTB(
    agentCapId: string,
    vaultId: string,
    amount: bigint | number,
    recipient: string,
    coinType?: string
  ): Transaction {
    return buildSpendVaultAgent({ packageId: this.packageId, coinType: coinType ?? this.defaultCoinType, agentCapId, vaultId, amount: financeU64(amount, true), recipient });
  }

  /**
   * 5. Master 一键单向紧急熔断并扫走金库余额 (Purge)
   */
  public buildEmergencyPurgePTB(
    masterCapId: string,
    vaultId: string,
    sweepRecipient: string,
    coinType?: string
  ): Transaction {
    return buildPurgeAgentVault({ packageId: this.packageId, coinType: coinType ?? this.defaultCoinType, masterCapId, vaultId, recipient: sweepRecipient });
  }

  /**
   * 6. 创建密码学组织共享对象。
   *
   * 名册与门限在链下先按合约规则校验（cryptographic_org 的 assert_valid_roster +
   * EUnreachableThreshold），因为这两类都是普通调用者常犯的错，不该让钱包先签名
   * 再吃一个 on-chain abort。
   */
  public buildCreateOrganizationPTB(
    groupPk: Uint8Array,
    thresholdWeight: bigint | number,
    members: string[],
    weights: (bigint | number)[]
  ): Transaction {
    if (groupPk.length !== 32) throw new Error('组织群公钥必须是 32 字节。');
    if (members.length !== weights.length) throw new Error('成员地址数与权重数必须一致。');
    if (members.length === 0 || members.length > LIMITS.MAX_ROSTER_MEMBERS) {
      throw new Error(`名册必须包含 1–${LIMITS.MAX_ROSTER_MEMBERS} 名成员。`);
    }
    const seen = new Set<string>();
    let rosterWeight = 0n;
    members.forEach((member, index) => {
      const canonical = canonicalAddress(member);
      if (canonical === canonicalAddress('0x0')) throw new Error(`第 ${index + 1} 名成员是零地址。`);
      if (seen.has(canonical)) throw new Error(`成员 ${member} 重复出现。`);
      seen.add(canonical);
      const weight = BigInt(weights[index]);
      if (weight <= 0n) throw new Error(`成员 ${member} 的权重必须为正。`);
      rosterWeight += weight;
    });
    const threshold = BigInt(thresholdWeight);
    if (threshold <= 0n || threshold > rosterWeight) {
      throw new Error(`门限权重必须为正且不超过名册总权重 ${rosterWeight}。`);
    }

    const tx = new Transaction();
    tx.moveCall({
      target: `${this.packageId}::cryptographic_org::create_organization_entry`,
      typeArguments: [],
      arguments: [
        tx.pure.vector('u8', Array.from(groupPk)),
        tx.pure.u64(threshold),
        tx.pure.vector('address', members),
        tx.pure.vector('u64', weights.map(w => BigInt(w))),
      ],
    });
    return tx;
  }

  /**
   * 7. 执行门限聚合签名提案。
   *
   * nonce 必须由调用方每次读链上 `last_nonce + 1` 后显式传入（`scripts/read_org_state.ts`）。
   * 这里不接受「省略 nonce」的旧签名——那条路径会把 nonce 静默固定成 1，
   * 对任何 last_nonce ≥ 1 的组织必然中止于 E_INVALID_NONCE。
   */
  public buildExecuteThresholdProposalPTB(
    orgId: string,
    nonce: bigint | number,
    payload: Uint8Array,
    frostSignature: Uint8Array,
    actionType: number
  ): Transaction {
    const tx = new Transaction();
    tx.moveCall({
      target: `${this.packageId}::cryptographic_org::execute_threshold_proposal`,
      typeArguments: [],
      arguments: [
        tx.object(orgId),
        tx.pure.u64(BigInt(nonce)),
        tx.pure.vector('u8', Array.from(payload)),
        tx.pure.vector('u8', Array.from(frostSignature)),
        tx.pure.u8(actionType),
      ],
    });
    return tx;
  }

  /**
   * 8. 资产托管：创建共享托管金库（new + share；发送者须为正权重成员）。
   */
  public buildCreateAssetCustodyPTB(orgId: string): Transaction {
    return buildCreateAssetCustody({ packageId: this.packageId, orgId });
  }

  /**
   * 9. 资产托管：存入一件 owned 对象（动态子对象托管，原 ID 仍可独立读取）。
   */
  public buildDepositAssetPTB(custodyId: string, orgId: string, assetType: string, assetId: string): Transaction {
    return buildDepositAsset({ packageId: this.packageId, custodyId, orgId, assetType, assetId });
  }

  /**
   * 10. 资产托管：发起动用提案（借出/转出；权重与门限在创建时快照）。
   */
  public buildCreateCustodyProposalPTB(input: Omit<CustodyProposalInput, 'packageId'>): Transaction {
    return buildCreateCustodyProposal({ ...input, packageId: this.packageId });
  }

  /**
   * 11. 资产托管：赞成 / 否决（claimedWeight 传链上名册权重）。
   */
  public buildSubmitCustodyVotePTB(proposalId: string, orgId: string, claimedWeight: number | bigint): Transaction {
    return buildSubmitCustodyVote({ packageId: this.packageId, proposalId, orgId, claimedWeight });
  }

  public buildRejectCustodyVotePTB(proposalId: string, orgId: string): Transaction {
    return buildRejectCustodyVote({ packageId: this.packageId, proposalId, orgId });
  }

  /**
   * 12. 资产托管：执行转出（资产转移给提案冻结的收款人）。
   */
  public buildExecuteReleasePTB(custodyId: string, proposalId: string, orgId: string, assetType: string): Transaction {
    return buildExecuteRelease({ packageId: this.packageId, custodyId, proposalId, orgId, assetType });
  }

  /**
   * 13. 资产托管：借出步进（take_asset → 使用命令 → return_asset 同 PTB）。
   */
  public buildTakeAssetStep(input: { custodyId: string; proposalId: string; orgId: string; assetType: string; transaction?: Transaction }): BorrowedAssetStep {
    return buildTakeAssetStep({ ...input, packageId: this.packageId });
  }

  public buildReturnAssetStep(input: { custodyId: string; asset: TransactionArgument; receipt: TransactionArgument; assetType: string; transaction?: Transaction }): Transaction {
    return buildReturnAssetStep({ ...input, packageId: this.packageId });
  }

  /**
   * 14. 资产托管升级模板：借出 → 授权 → 升级 → 提交 → 归还 一笔完成。
   */
  public buildCustodyUpgradeTemplatePTB(input: Parameters<typeof buildCustodyUpgradeTemplate>[0] & { packageId?: string }): Transaction {
    return buildCustodyUpgradeTemplate({ ...input, packageId: this.packageId });
  }

  /**
   * 8. 推进组织换届纪元 (Resharing 之后，保留公钥但递增版本)
   */
  public buildAdvanceOrganizationEpochPTB(
    orgId: string,
    nonce: bigint | number,
    frostSignature: Uint8Array
  ): Transaction {
    const tx = new Transaction();
    tx.moveCall({
      target: `${this.packageId}::cryptographic_org::advance_organization_epoch`,
      typeArguments: [],
      arguments: [
        tx.object(orgId),
        tx.pure.u64(BigInt(nonce)),
        tx.pure.vector('u8', Array.from(frostSignature)),
      ],
    });
    return tx;
  }

  /**
   * 9. 完全轮换组织主公钥 (应对拜占庭恶意节点或旧分片泄露场景)
   */
  public buildRotateGroupKeyPTB(
    orgId: string,
    nonce: bigint | number,
    newGroupPk: Uint8Array,
    frostSignature: Uint8Array
  ): Transaction {
    const tx = new Transaction();
    tx.moveCall({
      target: `${this.packageId}::cryptographic_org::rotate_group_key`,
      typeArguments: [],
      arguments: [
        tx.object(orgId),
        tx.pure.u64(BigInt(nonce)),
        tx.pure.vector('u8', Array.from(newGroupPk)),
        tx.pure.vector('u8', Array.from(frostSignature)),
      ],
    });
    return tx;
  }

  /**
   * 10. 门限签署的成员名册换届 (增删成员、调整权重与门限)。
   * `priorMembers` 必须逐项列出现存名册，合约用它精确清理旧表；`members` /
   * `weights` 是换届后的完整名册，摘要由 `computeRosterUpdateDigest` 生成。
   */
  public buildUpdateOrganizationRosterPTB(
    orgId: string,
    nonce: bigint | number,
    priorMembers: string[],
    members: string[],
    weights: (bigint | number)[],
    newThresholdWeight: bigint | number,
    frostSignature: Uint8Array
  ): Transaction {
    if (members.length !== weights.length) throw new Error('Roster members and weights must have equal length');
    const tx = new Transaction();
    tx.moveCall({
      target: `${this.packageId}::cryptographic_org::update_organization_roster`,
      typeArguments: [],
      arguments: [
        tx.object(orgId),
        tx.pure.u64(BigInt(nonce)),
        tx.pure.vector('address', priorMembers),
        tx.pure.vector('address', members),
        tx.pure.vector('u64', weights.map(w => BigInt(w))),
        tx.pure.u64(BigInt(newThresholdWeight)),
        tx.pure.vector('u8', Array.from(frostSignature)),
      ],
    });
    return tx;
  }

  // ------------------------------------------------------------------
  // DKG 会话 (dkg_committee)
  // ------------------------------------------------------------------

  /** Clock 共享对象（唯一来源在 org/constants，此处只做静态别名）。 */
  public static readonly CLOCK_OBJECT_ID = SUI_CLOCK_OBJECT_ID;

  /** Sui 系统随机源对象（claim_random 需要）。 */
  public static readonly RANDOM_OBJECT_ID = SUI_RANDOM_OBJECT_ID;

  /** 创建限时门限 DKG 会话。返回 PTB；session_id 从 SessionCreatedEvent 读取。 */
  public buildCreateDkgSessionPTB(
    threshold: bigint | number,
    participants: string[],
    deadlineTimestampMs: bigint | number
  ): Transaction {
    const tx = new Transaction();
    tx.moveCall({
      target: `${this.packageId}::dkg_committee::create_dkg_session`,
      typeArguments: [],
      arguments: [
        tx.pure.u64(BigInt(threshold)),
        tx.pure.vector('address', participants),
        tx.pure.u64(BigInt(deadlineTimestampMs)),
      ],
    });
    return tx;
  }

  /**
   * 密钥不变、成员重分（resharing）：要求 epoch > 1（先 advance_epoch），
   * 参与者集合去重且非空；与普通会话共用 DkgSession 状态机。
   */
  public buildCreateResharingSessionPTB(
    epoch: bigint | number,
    threshold: bigint | number,
    participants: string[],
    deadlineTimestampMs: bigint | number
  ): Transaction {
    if (BigInt(epoch) <= 1n) throw new Error('resharing 会话要求 epoch > 1（先 advance_epoch）。');
    const tx = new Transaction();
    tx.moveCall({
      target: `${this.packageId}::dkg_committee::create_resharing_session`,
      typeArguments: [],
      arguments: [
        tx.pure.u64(BigInt(epoch)),
        tx.pure.u64(BigInt(threshold)),
        tx.pure.vector('address', participants),
        tx.pure.u64(BigInt(deadlineTimestampMs)),
      ],
    });
    return tx;
  }

  /** 参与者链上确认。 */
  public buildConfirmParticipantPTB(sessionId: string): Transaction {
    const tx = new Transaction();
    tx.moveCall({
      target: `${this.packageId}::dkg_committee::confirm_participant`,
      typeArguments: [],
      arguments: [tx.object(sessionId), tx.object(AgentVaultClient.CLOCK_OBJECT_ID)],
    });
    return tx;
  }

  /** Round 1 提交多项式承诺。 */
  public buildSubmitCommitmentPTB(sessionId: string, commitmentBytes: Uint8Array): Transaction {
    const tx = new Transaction();
    tx.moveCall({
      target: `${this.packageId}::dkg_committee::submit_commitment`,
      typeArguments: [],
      arguments: [
        tx.object(sessionId),
        tx.object(AgentVaultClient.CLOCK_OBJECT_ID),
        tx.pure.vector('u8', Array.from(commitmentBytes)),
      ],
    });
    return tx;
  }

  /** 写入密态信箱份额（sender/recipient 均须为参与者；首写优先，不可覆盖）。 */
  public buildDepositMailboxSharePTB(
    sessionId: string,
    recipient: string,
    encryptedPayload: Uint8Array
  ): Transaction {
    const tx = new Transaction();
    tx.moveCall({
      target: `${this.packageId}::dkg_committee::deposit_mailbox_share`,
      typeArguments: [],
      arguments: [
        tx.object(sessionId),
        tx.object(AgentVaultClient.CLOCK_OBJECT_ID),
        tx.pure.address(recipient),
        tx.pure.vector('u8', Array.from(encryptedPayload)),
      ],
    });
    return tx;
  }

  /**
   * 登记本参与者的信箱加密公钥（65 字节未压缩 P-256 点）。
   *
   * deposit_mailbox_share 的载荷对任何能读链的人都是公开的，份额必须先密封
   * 给收件人；没有这一步就没有收件人公钥可用。
   */
  public buildRegisterEncryptionKeyPTB(
    sessionId: string,
    encryptionPublicKey: Uint8Array
  ): Transaction {
    if (encryptionPublicKey.length !== 65) throw new Error('信箱加密公钥必须是 65 字节的未压缩 P-256 点。');
    const tx = new Transaction();
    tx.moveCall({
      target: `${this.packageId}::dkg_committee::register_encryption_key`,
      typeArguments: [],
      arguments: [
        tx.object(sessionId),
        tx.object(AgentVaultClient.CLOCK_OBJECT_ID),
        tx.pure.vector('u8', Array.from(encryptionPublicKey)),
      ],
    });
    return tx;
  }

  /**
   * 一次性提交承诺 + 给多名收件人的密态份额（对应 Move 的 submit_async_package）。
   */
  public buildSubmitAsyncPackagePTB(
    sessionId: string,
    commitmentBytes: Uint8Array,
    recipients: string[],
    encryptedPayloads: Uint8Array[]
  ): Transaction {
    if (recipients.length !== encryptedPayloads.length) {
      throw new Error('recipients and encryptedPayloads length mismatch');
    }
    const tx = new Transaction();
    tx.moveCall({
      target: `${this.packageId}::dkg_committee::submit_async_package`,
      typeArguments: [],
      arguments: [
        tx.object(sessionId),
        tx.object(AgentVaultClient.CLOCK_OBJECT_ID),
        tx.pure.vector('u8', Array.from(commitmentBytes)),
        tx.pure.vector('address', recipients),
        (tx.pure as any).vector('vector<u8>', encryptedPayloads.map(p => Array.from(p))),
      ],
    });
    return tx;
  }

  /**
   * v3 固化：群公钥必须由 threshold 个已确认成员各自申报。
   *
   * 每个成员在自己的设备上从链上承诺重算 Σ C_0 后提交申报；伪造需要控制达到
   * 门限的已确认地址，与 DKG 的信任假设一致。v1/v2 自 v6 起无条件 abort。
   */
  public buildAttestGroupKeyPTB(
    sessionId: string,
    groupPublicKey: Uint8Array
  ): Transaction {
    if (groupPublicKey.length !== 32) throw new Error('groupPublicKey must be 32 bytes');
    const tx = new Transaction();
    tx.moveCall({
      target: `${this.packageId}::dkg_committee::attest_group_key`,
      typeArguments: [],
      arguments: [
        tx.object(sessionId),
        tx.object(AgentVaultClient.CLOCK_OBJECT_ID),
        tx.pure.vector('u8', Array.from(groupPublicKey)),
      ],
    });
    return tx;
  }

  /** v3 固化：申报数达到门限后，任意地址可提交；最终公钥取自成员申报。 */
  public buildFinalizeSessionPTB(
    sessionId: string,
    groupPublicKey: Uint8Array
  ): Transaction {
    if (groupPublicKey.length !== 32) throw new Error('groupPublicKey must be 32 bytes');
    const tx = new Transaction();
    tx.moveCall({
      target: `${this.packageId}::dkg_committee::finalize_session`,
      typeArguments: [],
      arguments: [
        tx.object(sessionId),
        tx.pure.vector('u8', Array.from(groupPublicKey)),
      ],
    });
    return tx;
  }


  /** 到期且法定人数不足时任何人触发链上作废。 */
  public buildHandleSessionTimeoutPTB(sessionId: string): Transaction {
    const tx = new Transaction();
    tx.moveCall({
      target: `${this.packageId}::dkg_committee::handle_session_timeout`,
      typeArguments: [],
      arguments: [tx.object(sessionId), tx.object(AgentVaultClient.CLOCK_OBJECT_ID)],
    });
    return tx;
  }

  // ------------------------------------------------------------------
  // 全异步治理提案 (asynchronous_proposal) —— 链上待签提案 + 真金库转账
  // ------------------------------------------------------------------

  /** 发起转账提案（调用者必须是 org 成员；threshold 自动取自 org）。 */
  public buildCreateTransferProposalPTB(
    orgId: string,
    title: string,
    recipient: string,
    amount: bigint | number,
    deadlineMs: bigint | number
  ): Transaction {
    const tx = new Transaction();
    tx.moveCall({
      target: `${this.packageId}::asynchronous_proposal::create_transfer_proposal`,
      typeArguments: [],
      arguments: [
        tx.object(orgId),
        tx.pure.vector('u8', Array.from(new TextEncoder().encode(title))),
        tx.pure.address(recipient),
        tx.pure.u64(BigInt(amount)),
        tx.pure.u64(BigInt(deadlineMs)),
        tx.object(SUI_CLOCK_OBJECT_ID),
      ],
    });
    return tx;
  }

  /**
   * 成员赞成投票（交易发送者认证；权重由组织名册裁定，claimed_weight 必须匹配）。
   * partialSignature 仅作为附带数据保存，合约不验证 FROST 分片；可传空字节。
   */
  public buildSubmitAsyncVotePTB(
    proposalId: string,
    orgId: string,
    claimedWeight: bigint | number,
    partialSignature: Uint8Array
  ): Transaction {
    const tx = new Transaction();
    tx.moveCall({
      target: `${this.packageId}::asynchronous_proposal::submit_async_vote`,
      typeArguments: [],
      arguments: [
        tx.object(proposalId),
        tx.object(orgId),
        tx.object(AgentVaultClient.CLOCK_OBJECT_ID),
        tx.pure.u64(BigInt(claimedWeight)),
        tx.pure.vector('u8', Array.from(partialSignature)),
      ],
    });
    return tx;
  }

  /**
   * 成员反对投票（权重从实时组织名册读取；与本人或代理赞成票互斥）。
   * 反对权重达到同一提案门限后终止提案；赞成已达门限时不能再反对。
   * Requires a package version exposing reject_async_vote.
   */
  public buildRejectAsyncVotePTB(proposalId: string, orgId: string): Transaction {
    const tx = new Transaction();
    tx.moveCall({
      target: `${this.packageId}::asynchronous_proposal::reject_async_vote`,
      typeArguments: [],
      arguments: [
        tx.object(proposalId),
        tx.object(orgId),
        tx.object(AgentVaultClient.CLOCK_OBJECT_ID),
      ],
    });
    return tx;
  }

  /**
   * Subagent 代理投票（记录在 cap.master_owner 名下，受单笔/日限额约束）。
   * 由交易发送者和 Cap 认证；partialSignature 仅保存，合约不验证 FROST 分片。
   */
  public buildSubmitAsyncVoteBySubagentPTB(
    proposalId: string,
    orgId: string,
    subagentCapId: string,
    partialSignature: Uint8Array
  ): Transaction {
    const tx = new Transaction();
    tx.moveCall({
      target: `${this.packageId}::asynchronous_proposal::submit_async_vote_by_subagent`,
      typeArguments: [],
      arguments: [
        tx.object(proposalId),
        tx.object(orgId),
        tx.object(subagentCapId),
        tx.object(AgentVaultClient.CLOCK_OBJECT_ID),
        tx.pure.vector('u8', Array.from(partialSignature)),
      ],
    });
    return tx;
  }

  /**
   * 门限达标后任何人触发执行：内部真调 vault::withdraw 完成金库划转。
   */
  public buildExecuteTransferProposalPTB(
    proposalId: string,
    orgId: string,
    vaultId: string,
    masterCapId: string,
    coinType?: string
  ): Transaction {
    const tx = new Transaction();
    const typeArg = coinType ?? this.defaultCoinType;
    tx.moveCall({
      target: `${this.packageId}::asynchronous_proposal::execute_transfer_proposal`,
      typeArguments: [typeArg],
      arguments: [
        tx.object(proposalId),
        tx.object(orgId),
        tx.object(vaultId),
        tx.object(masterCapId),
        tx.object(AgentVaultClient.CLOCK_OBJECT_ID),
      ],
    });
    return tx;
  }

  /** 签发并共享 SubagentCoSignCap（推荐生产模式）。返回 PTB；cap_id 从事件/共享对象读取。 */
  public buildCreateSharedSubagentCapPTB(
    agentAddress: string,
    voterWeight: bigint | number,
    maxBudgetPerTx: bigint | number,
    dailyBudgetLimit: bigint | number,
    expiresAtMs: bigint | number
  ): Transaction {
    const tx = new Transaction();
    tx.moveCall({
      target: `${this.packageId}::asynchronous_proposal::create_shared_subagent_cap`,
      typeArguments: [],
      arguments: [
        tx.pure.address(agentAddress),
        tx.pure.u64(BigInt(voterWeight)),
        tx.pure.u64(BigInt(maxBudgetPerTx)),
        tx.pure.u64(BigInt(dailyBudgetLimit)),
        tx.pure.u64(BigInt(expiresAtMs)),
      ],
    });
    return tx;
  }

  /** 主账号吊销 Subagent 协签资格。 */
  public buildRevokeSubagentCapPTB(capId: string): Transaction {
    const tx = new Transaction();
    tx.moveCall({
      target: `${this.packageId}::asynchronous_proposal::revoke_subagent_cosign_cap`,
      typeArguments: [],
      arguments: [tx.object(capId)],
    });
    return tx;
  }

  /** 从已固化会话创建组织（members=已确认参与者，weight 全 1）。 */
  public buildCreateOrganizationFromSessionPTB(
    sessionId: string,
    thresholdWeight: bigint | number
  ): Transaction {
    const tx = new Transaction();
    tx.moveCall({
      target: `${this.packageId}::cryptographic_org::create_organization_from_session`,
      typeArguments: [],
      arguments: [tx.object(sessionId), tx.pure.u64(BigInt(thresholdWeight))],
    });
    return tx;
  }

  // ------------------------------------------------------------------
  // 链上红包 (agent_vault::red_packet)
  // ------------------------------------------------------------------

  /**
   * 创建群聊链上红包。
   *
   * `payment` 沿支付统一约定：给 `coin`（对象 ID / 本 PTB 句柄 / 列表）原样
   * 作为红包资金；只给 `amount` 时由 tx.coin() 生成精确的 Coin<coinType>
   * （客户端在地址余额与 owned coin 之间择优）。省略 `payment` 等价于
   * `{ amount: totalAmount }`。
   */
  public buildCreateRedPacketPTB(
    channelId: string,
    totalAmount: bigint | number,
    count: number,
    isRandom: boolean,
    message: string = "恭喜发财，万事大吉！",
    durationMs: number = 86400000,
    coinType?: string,
    payment?: FinanceCoinSource,
  ): Transaction {
    const tx = new Transaction();
    const typeArg = financeCoinType(coinType ?? this.defaultCoinType);
    const amountBig = BigInt(totalAmount);
    // 链下先行拒绝合约必拒的载荷（red_packet::create 的四个 assert 逐一镜像），
    // 免得钱包先签名再吃一个 on-chain abort。
    if (!Number.isInteger(count) || count <= 0 || count > RED_PACKET_LIMITS.MAX_COUNT) {
      throw new Error(`红包份数必须为 1–${RED_PACKET_LIMITS.MAX_COUNT} 的整数。`);
    }
    if (new TextEncoder().encode(message).length > RED_PACKET_LIMITS.MAX_GREETING_BYTES) {
      throw new Error(`红包祝福语最多 ${RED_PACKET_LIMITS.MAX_GREETING_BYTES} 字节。`);
    }
    if (!Number.isInteger(durationMs) || durationMs <= 0 || durationMs > RED_PACKET_LIMITS.MAX_DURATION_MS) {
      throw new Error(`红包有效期必须为 1–${RED_PACKET_LIMITS.MAX_DURATION_MS} 毫秒（7 天）。`);
    }
    if (amountBig < BigInt(count)) {
      throw new Error("红包总金额至少要够每份 1 MIST。");
    }
    const coinArg = financeCoin(tx, typeArg, payment ?? { amount: amountBig });

    tx.moveCall({
      target: `${this.packageId}::red_packet::create`,
      typeArguments: [typeArg],
      arguments: [
        tx.object(channelId),
        coinArg,
        tx.pure.u64(BigInt(count)),
        tx.pure.bool(isRandom),
        tx.pure.string(message),
        tx.pure.u64(BigInt(durationMs)),
        tx.object(AgentVaultClient.CLOCK_OBJECT_ID),
      ],
    });
    return tx;
  }

  /** 成员抢红包入口 (claim_red_packet_entry) */
  public buildClaimRedPacketPTB(
    packetId: string,
    channelId: string,
    coinType?: string
  ): Transaction {
    const tx = new Transaction();
    const typeArg = coinType ?? this.defaultCoinType;
    tx.moveCall({
      target: `${this.packageId}::red_packet::claim_equal`,
      typeArguments: [typeArg],
      arguments: [
        tx.object(packetId),
        tx.object(channelId),
        tx.object(AgentVaultClient.CLOCK_OBJECT_ID),
      ],
    });
    return tx;
  }

  /** 成员拼手气红包入口 (claim_random，需要系统 Random 对象) */
  public buildClaimRandomRedPacketPTB(
    packetId: string,
    channelId: string,
    coinType?: string
  ): Transaction {
    const tx = new Transaction();
    const typeArg = coinType ?? this.defaultCoinType;
    tx.moveCall({
      target: `${this.packageId}::red_packet::claim_random`,
      typeArguments: [typeArg],
      arguments: [
        tx.object(packetId),
        tx.object(channelId),
        tx.object(AgentVaultClient.CLOCK_OBJECT_ID),
        tx.object(AgentVaultClient.RANDOM_OBJECT_ID),
      ],
    });
    return tx;
  }

  /** 发起人过期赎回未领取的剩余红包 */
  public buildRefundRedPacketPTB(
    packetId: string,
    coinType?: string
  ): Transaction {
    const tx = new Transaction();
    const typeArg = coinType ?? this.defaultCoinType;
    tx.moveCall({
      target: `${this.packageId}::red_packet::refund`,
      typeArguments: [typeArg],
      arguments: [
        tx.object(packetId),
        tx.object(AgentVaultClient.CLOCK_OBJECT_ID),
      ],
    });
    return tx;
  }

  // ------------------------------------------------------------------
  // 链上群聊 (agent_vault::onchain_chat)
  // ------------------------------------------------------------------

  /** 创建链上抗女巫聊天频道 */
  public buildCreateChatChannelPTB(
    orgAddress: string,
    name: string,
    initialMembers: string[]
  ): Transaction {
    const tx = new Transaction();
    tx.moveCall({
      target: `${this.packageId}::onchain_chat::create_channel`,
      typeArguments: [],
      arguments: [
        tx.pure.address(orgAddress),
        tx.pure.vector('u8', Array.from(new TextEncoder().encode(name))),
        tx.pure.vector('address', initialMembers),
      ],
    });
    return tx;
  }

  /** 发送频道消息（附带 Walrus 去中心化存储 Blob ID 索引） */
  public buildPostChatMessagePTB(
    channelId: string,
    contentPreview: string,
    walrusBlobId: string = ""
  ): Transaction {
    const tx = new Transaction();
    tx.moveCall({
      target: `${this.packageId}::onchain_chat::post_message`,
      typeArguments: [],
      arguments: [
        tx.object(channelId),
        tx.object(AgentVaultClient.CLOCK_OBJECT_ID),
        tx.pure.vector('u8', Array.from(new TextEncoder().encode(walrusBlobId))),
        tx.pure.vector('u8', Array.from(new TextEncoder().encode(contentPreview))),
      ],
    });
    return tx;
  }

  /** Subagent / AI 哨兵代发频道消息 */
  public buildPostChatMessageBySubagentPTB(
    channelId: string,
    capId: string,
    contentPreview: string,
    walrusBlobId: string = ""
  ): Transaction {
    const tx = new Transaction();
    tx.moveCall({
      target: `${this.packageId}::onchain_chat::post_message_by_subagent`,
      typeArguments: [],
      arguments: [
        tx.object(channelId),
        tx.object(capId),
        tx.object(AgentVaultClient.CLOCK_OBJECT_ID),
        tx.pure.vector('u8', Array.from(new TextEncoder().encode(walrusBlobId))),
        tx.pure.vector('u8', Array.from(new TextEncoder().encode(contentPreview))),
      ],
    });
    return tx;
  }

  // ------------------------------------------------------------------
  // 核心钱包能力 (Direct Wallet Transfers & Batch Payments)
  // ------------------------------------------------------------------

  /** 原生单笔快速转账 */
  public buildDirectTransferPTB(
    recipient: string,
    amountMist: bigint | number
  ): Transaction {
    const tx = new Transaction();
    const coin = financeCoin(tx, this.defaultCoinType, { amount: amountMist });
    tx.transferObjects([coin], tx.pure.address(recipient));
    return tx;
  }

  /** 批量转账 / 工资发放 (单笔 PTB 同时向多名收款人转账，大幅节省 Gas) */
  public buildBatchTransferPTB(
    transfers: { recipient: string; amountMist: bigint | number }[]
  ): Transaction {
    const tx = new Transaction();
    for (const t of transfers) {
      const coin = financeCoin(tx, this.defaultCoinType, { amount: t.amountMist });
      tx.transferObjects([coin], tx.pure.address(t.recipient));
    }
    return tx;
  }

  // ------------------------------------------------------------------
  // 影子跟投 (ShadowVote / 影子代签投票)
  // ------------------------------------------------------------------

  /**
   * 影子跟投：基于 SubagentCoSignCap，代理跟随策略或领投人自动执行链上治理投票。
   * partial_signature 是附带记录，合约不做 FROST 校验，因此这里传空字节而不是
   * 伪造一个签名——伪造的 64 字节会以「看似已签」的形态写进提案表，误导审计。
   */
  public buildShadowFollowVotePTB(
    proposalId: string,
    orgId: string,
    subagentCapId: string
  ): Transaction {
    return this.buildSubmitAsyncVoteBySubagentPTB(
      proposalId,
      orgId,
      subagentCapId,
      new Uint8Array(0)
    );
  }
}

// --------------------------------------------------------------------
// --------------------------------------------------------------------
// 域隔离摘要已迁至 org/digest.ts（单一实现，链上真值向量校验）。
// 位置参数旧 API 已删除：改用对象参数 computeProposalDigest({...}) 等，
// chain_id 取 'sui-testnet:' / 'sui-mainnet:'（org/constants CHAIN_IDS）。
// --------------------------------------------------------------------
