import { Transaction } from '@mysten/sui/transactions';

export const DEFAULT_AGENT_VAULT_PACKAGE_ID = '0x83fb785f1da119aea4e0faa19d1466b33899e14ea730af6425ec7d5557cb5a36';

export interface VaultClientConfig {
  packageId?: string;
  defaultCoinType?: string;
}

export class AgentVaultClient {
  public readonly packageId: string;
  public readonly defaultCoinType: string;

  constructor(config?: VaultClientConfig) {
    this.packageId = config?.packageId ?? DEFAULT_AGENT_VAULT_PACKAGE_ID;
    this.defaultCoinType = config?.defaultCoinType ?? '0x2::sui::SUI';
  }

  /**
   * 1. 部署/初始化金库，产出 MasterCap
   */
  public buildInitializeVaultPTB(coinType?: string): Transaction {
    const tx = new Transaction();
    const typeArg = coinType ?? this.defaultCoinType;
    tx.moveCall({
      target: `${this.packageId}::vault::initialize_vault`,
      typeArguments: [typeArg],
      arguments: [],
    });
    return tx;
  }

  /**
   * 存入资金到金库
   */
  public buildDepositPTB(vaultId: string, coinInput: any, coinType?: string): Transaction {
    const tx = new Transaction();
    const typeArg = coinType ?? this.defaultCoinType;
    tx.moveCall({
      target: `${this.packageId}::vault::deposit`,
      typeArguments: [typeArg],
      arguments: [tx.object(vaultId), typeof coinInput === 'string' ? tx.object(coinInput) : coinInput],
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
    const tx = new Transaction();
    const typeArg = coinType ?? this.defaultCoinType;
    tx.moveCall({
      target: `${this.packageId}::vault::withdraw`,
      typeArguments: [typeArg],
      arguments: [
        tx.object(masterCapId),
        tx.object(vaultId),
        tx.pure.u64(BigInt(amount)),
        tx.pure.address(recipient),
      ],
    });
    return tx;
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
    const tx = new Transaction();
    const typeArg = coinType ?? this.defaultCoinType;
    tx.moveCall({
      target: `${this.packageId}::vault::issue_operator_cap`,
      typeArguments: [typeArg],
      arguments: [
        tx.object(masterCapId),
        tx.object(vaultId),
        tx.pure.address(operatorAddress),
      ],
    });
    return tx;
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
    const tx = new Transaction();
    const typeArg = coinType ?? this.defaultCoinType;
    const hashBytes = typeof serviceHash === 'string' ? new TextEncoder().encode(serviceHash) : serviceHash;

    tx.moveCall({
      target: `${this.packageId}::vault::spawn_agent_card`,
      typeArguments: [typeArg],
      arguments: [
        tx.object(opCapId),
        tx.object(vaultId),
        tx.pure.address(agentAddress),
        tx.pure.u64(BigInt(dailyBudget)),
        tx.pure.vector('u8', Array.from(hashBytes)),
      ],
    });
    return tx;
  }

  /**
   * Operator 调整 Agent 每日额度
   */
  public buildSetAgentBudgetPTB(
    opCapId: string,
    vaultId: string,
    agentCapId: string,
    newDailyBudget: bigint | number,
    coinType?: string
  ): Transaction {
    const tx = new Transaction();
    const typeArg = coinType ?? this.defaultCoinType;
    tx.moveCall({
      target: `${this.packageId}::vault::set_agent_budget`,
      typeArguments: [typeArg],
      arguments: [
        tx.object(opCapId),
        tx.object(vaultId),
        tx.object(agentCapId),
        tx.pure.u64(BigInt(newDailyBudget)),
      ],
    });
    return tx;
  }

  /**
   * Operator 暂停 Agent
   */
  public buildPauseAgentPTB(
    opCapId: string,
    vaultId: string,
    agentCapId: string,
    coinType?: string
  ): Transaction {
    const tx = new Transaction();
    const typeArg = coinType ?? this.defaultCoinType;
    tx.moveCall({
      target: `${this.packageId}::vault::pause_agent`,
      typeArguments: [typeArg],
      arguments: [tx.object(opCapId), tx.object(vaultId), tx.object(agentCapId)],
    });
    return tx;
  }

  /**
   * Operator 恢复 Agent
   */
  public buildResumeAgentPTB(
    opCapId: string,
    vaultId: string,
    agentCapId: string,
    coinType?: string
  ): Transaction {
    const tx = new Transaction();
    const typeArg = coinType ?? this.defaultCoinType;
    tx.moveCall({
      target: `${this.packageId}::vault::resume_agent`,
      typeArguments: [typeArg],
      arguments: [tx.object(opCapId), tx.object(vaultId), tx.object(agentCapId)],
    });
    return tx;
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
    const tx = new Transaction();
    const typeArg = coinType ?? this.defaultCoinType;
    tx.moveCall({
      target: `${this.packageId}::vault::spend_x402_budget`,
      typeArguments: [typeArg],
      arguments: [
        tx.object(agentCapId),
        tx.object(vaultId),
        tx.pure.u64(BigInt(amount)),
        tx.pure.address(recipient),
      ],
    });
    return tx;
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
    const tx = new Transaction();
    const typeArg = coinType ?? this.defaultCoinType;
    tx.moveCall({
      target: `${this.packageId}::vault::emergency_unilateral_purge`,
      typeArguments: [typeArg],
      arguments: [
        tx.object(masterCapId),
        tx.object(vaultId),
        tx.pure.address(sweepRecipient),
      ],
    });
    return tx;
  }

  /**
   * 6. 创建密码学组织共享对象
   */
  public buildCreateOrganizationPTB(
    groupPk: Uint8Array,
    thresholdWeight: bigint | number,
    members: string[],
    weights: (bigint | number)[]
  ): Transaction {
    const tx = new Transaction();
    tx.moveCall({
      target: `${this.packageId}::cryptographic_org::create_organization_entry`,
      typeArguments: [],
      arguments: [
        tx.pure.vector('u8', Array.from(groupPk)),
        tx.pure.u64(BigInt(thresholdWeight)),
        tx.pure.vector('address', members),
        tx.pure.vector('u64', weights.map(w => BigInt(w))),
      ],
    });
    return tx;
  }

  /**
   * 7. 执行门限聚合签名提案
   */
  public buildExecuteThresholdProposalPTB(
    orgId: string,
    arg1: Uint8Array | bigint | number,
    arg2: Uint8Array,
    arg3?: Uint8Array | number,
    arg4?: number
  ): Transaction {
    const tx = new Transaction();
    let nonce: bigint;
    let payload: Uint8Array;
    let frostSignature: Uint8Array;
    let actionType: number;

    if (arg1 instanceof Uint8Array) {
      // 兼容旧签名: (orgId, payload, frostSig, actionType)
      nonce = 1n;
      payload = arg1;
      frostSignature = arg2;
      actionType = typeof arg3 === 'number' ? arg3 : 1;
    } else {
      // 标准新签名: (orgId, nonce, payload, frostSig, actionType)
      nonce = BigInt(arg1);
      payload = arg2;
      frostSignature = (arg3 as Uint8Array) ?? new Uint8Array(64);
      actionType = typeof arg4 === 'number' ? arg4 : 1;
    }

    tx.moveCall({
      target: `${this.packageId}::cryptographic_org::execute_threshold_proposal`,
      typeArguments: [],
      arguments: [
        tx.object(orgId),
        tx.pure.u64(nonce),
        tx.pure.vector('u8', Array.from(payload)),
        tx.pure.vector('u8', Array.from(frostSignature)),
        tx.pure.u8(actionType),
      ],
    });
    return tx;
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

  // ------------------------------------------------------------------
  // DKG 会话 (dkg_committee)
  // ------------------------------------------------------------------

  /** Clock 共享对象固定地址 (Sui 框架时钟)。 */
  public static readonly CLOCK_OBJECT_ID =
    '0x0000000000000000000000000000000000000000000000000000000000000006';

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
   * v2 固化：要求 FROST 聚合签名绑定 (SESSION_CERT_V1: || bcs(session_id) || group_pk)，
   * 由 group_pk 的门限成员钥匙签名，防止调用方编造公钥。
   */
  public buildFinalizeSessionV2PTB(
    sessionId: string,
    groupPublicKey: Uint8Array,
    frostSignature: Uint8Array
  ): Transaction {
    if (groupPublicKey.length !== 32) throw new Error('groupPublicKey must be 32 bytes');
    if (frostSignature.length !== 64) throw new Error('frostSignature must be 64 bytes');
    const tx = new Transaction();
    tx.moveCall({
      target: `${this.packageId}::dkg_committee::finalize_session_v2`,
      typeArguments: [],
      arguments: [
        tx.object(sessionId),
        tx.pure.vector('u8', Array.from(groupPublicKey)),
        tx.pure.vector('u8', Array.from(frostSignature)),
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
      arguments: [tx.object(sessionId)],
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
      ],
    });
    return tx;
  }

  /** 成员异步投票（权重由组织名册裁定，claimed_weight 必须 == 名册实际权重）。 */
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
   * Subagent 代理投票（记录在 cap.master_owner 名下，受单笔/日限额约束）。
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

  /** 创建群聊链上红包（支持 SUI / 任意 Coin<T>，支持拼手气与等额红包） */
  public buildCreateRedPacketPTB(
    channelId: string,
    totalAmount: bigint | number,
    count: number,
    isRandom: boolean,
    message: string = "恭喜发财，万事大吉！",
    durationMs: number = 86400000,
    coinType: string = "0x2::sui::SUI"
  ): Transaction {
    const tx = new Transaction();
    const amountBig = BigInt(totalAmount);
    let coinArg: any;
    if (coinType === "0x2::sui::SUI" || coinType.endsWith("::sui::SUI")) {
      const [splitCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(amountBig)]);
      coinArg = splitCoin;
    } else {
      throw new Error("Non-SUI coin splitting requires explicit Coin object input");
    }

    tx.moveCall({
      target: `${this.packageId}::red_packet::create_red_packet`,
      typeArguments: [coinType],
      arguments: [
        tx.object(channelId),
        coinArg,
        tx.pure.u64(BigInt(count)),
        tx.pure.bool(isRandom),
        tx.pure.vector('u8', Array.from(new TextEncoder().encode(message))),
        tx.object(AgentVaultClient.CLOCK_OBJECT_ID),
        tx.pure.u64(BigInt(durationMs)),
      ],
    });
    return tx;
  }

  /** 成员抢红包入口 (claim_red_packet_entry) */
  public buildClaimRedPacketPTB(
    packetId: string,
    channelId: string,
    coinType: string = "0x2::sui::SUI"
  ): Transaction {
    const tx = new Transaction();
    tx.moveCall({
      target: `${this.packageId}::red_packet::claim_red_packet_entry`,
      typeArguments: [coinType],
      arguments: [
        tx.object(packetId),
        tx.object(channelId),
        tx.object(AgentVaultClient.CLOCK_OBJECT_ID),
      ],
    });
    return tx;
  }

  /** 发起人过期赎回未领取的剩余红包 */
  public buildRefundRedPacketPTB(
    packetId: string,
    coinType: string = "0x2::sui::SUI"
  ): Transaction {
    const tx = new Transaction();
    tx.moveCall({
      target: `${this.packageId}::red_packet::refund_expired_red_packet`,
      typeArguments: [coinType],
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
    const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(BigInt(amountMist))]);
    tx.transferObjects([coin], tx.pure.address(recipient));
    return tx;
  }

  /** 批量转账 / 工资发放 (单笔 PTB 同时向多名收款人转账，大幅节省 Gas) */
  public buildBatchTransferPTB(
    transfers: { recipient: string; amountMist: bigint | number }[]
  ): Transaction {
    const tx = new Transaction();
    const amounts = transfers.map((t) => tx.pure.u64(BigInt(t.amountMist)));
    const splitResult = tx.splitCoins(tx.gas, amounts);
    transfers.forEach((t, i) => {
      tx.transferObjects([splitResult[i]], tx.pure.address(t.recipient));
    });
    return tx;
  }

  // ------------------------------------------------------------------
  // 影子跟投 (ShadowVote / 影子代签投票)
  // ------------------------------------------------------------------

  /**
   * 影子跟投：基于 SubagentCoSignCap，代理跟随策略或领投人自动执行链上治理投票。
   */
  public buildShadowFollowVotePTB(
    proposalId: string,
    orgId: string,
    subagentCapId: string
  ): Transaction {
    const dummySignature = new Uint8Array(64).fill(0x5a); // 影子委托签名标识
    return this.buildSubmitAsyncVoteBySubagentPTB(
      proposalId,
      orgId,
      subagentCapId,
      dummySignature
    );
  }
}

// --------------------------------------------------------------------
// 域隔离摘要 (与 agent_vault::cryptographic_org 的 compute_*_digest 严格一致)
// 字节序: DOMAIN || chain_id || bcs(org_id) || bcs(epoch_version) || bcs(nonce) || …
// --------------------------------------------------------------------

import { bcs } from '@mysten/sui/bcs';
import { sha256 } from '@noble/hashes/sha2.js';

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

const utf8 = (s: string) => new TextEncoder().encode(s);

function orgIdBytes(orgId: string): Uint8Array {
  return bcs.Address.serialize(orgId).toBytes();
}

function u64Bytes(v: bigint | number): Uint8Array {
  return bcs.u64().serialize(BigInt(v)).toBytes();
}

/** H(DOMAIN_PROPOSAL || chain_id || org_id || epoch || nonce || payload) —— execute_threshold_proposal 验证对象 */
export function computeProposalDigest(
  chainId: Uint8Array | string,
  orgId: string,
  epochVersion: bigint | number,
  nonce: bigint | number,
  payload: Uint8Array
): Uint8Array {
  return sha256(
    concatBytes(
      utf8('SUI_ORG_PROPOSAL_V1:'),
      typeof chainId === 'string' ? utf8(chainId) : chainId,
      orgIdBytes(orgId),
      u64Bytes(epochVersion),
      u64Bytes(nonce),
      payload
    )
  );
}

/** H(DOMAIN_THRESHOLD_APPROVAL || chain_id || org_id || epoch || nonce || new_epoch_version) —— advance_organization_epoch 验证对象 */
export function computeThresholdApprovalDigest(
  chainId: Uint8Array | string,
  orgId: string,
  epochVersion: bigint | number,
  nonce: bigint | number,
  newEpochVersion: bigint | number
): Uint8Array {
  return sha256(
    concatBytes(
      utf8('SUI_ORG_APPROVAL_V1:'),
      typeof chainId === 'string' ? utf8(chainId) : chainId,
      orgIdBytes(orgId),
      u64Bytes(epochVersion),
      u64Bytes(nonce),
      u64Bytes(newEpochVersion)
    )
  );
}

/** H(DOMAIN_KEY_ROTATION || chain_id || org_id || epoch || nonce || new_group_pk) —— rotate_group_key 验证对象 */
export function computeKeyRotationDigest(
  chainId: Uint8Array | string,
  orgId: string,
  epochVersion: bigint | number,
  nonce: bigint | number,
  newGroupPk: Uint8Array
): Uint8Array {
  return sha256(
    concatBytes(
      utf8('SUI_ORG_KEY_ROTATION_V1:'),
      typeof chainId === 'string' ? utf8(chainId) : chainId,
      orgIdBytes(orgId),
      u64Bytes(epochVersion),
      u64Bytes(nonce),
      newGroupPk
    )
  );
}

/** H(SESSION_CERT_V1: || bcs(session_id) || group_pk) —— finalize_session_v2 验证消息（先 sha256 由 ThresholdSignerNode 消化） */
export function computeSessionCertPayload(
  sessionId: string,
  groupPublicKey: Uint8Array
): Uint8Array {
  return concatBytes(utf8('SESSION_CERT_V1:'), orgIdBytes(sessionId), groupPublicKey);
}

/** 默认链域，与合约 DEFAULT_CHAIN_ID 一致。 */
export const DEFAULT_ORG_CHAIN_ID = 'sui-testnet:';
