/// Weighted asynchronous decisions authenticated by the transaction sender or a
/// delegated co-sign capability. Approval partial_signature bytes are retained
/// as ancillary data; this module does not verify FROST signature shares.
module agent_vault::asynchronous_proposal {
    use sui::object::{Self, UID, ID};
    use sui::tx_context::{Self, TxContext};
    use sui::transfer;
    use sui::table::{Self, Table};
    use sui::clock::{Self, Clock};
    use sui::event;
    use agent_vault::vault::{Self, AgentVault, MasterCap};
    use agent_vault::cryptographic_org::{Self, Organization};
    use sui::dynamic_field;
    use sui::ed25519;
    use sui::bcs;
    use std::hash;

    // 状态常量
    const STATUS_PENDING: u8 = 1;
    const STATUS_EXECUTED: u8 = 2;
    const STATUS_REJECTED: u8 = 3;

    // 错误码
    const E_PROPOSAL_EXPIRED: u64 = 4001;
    const E_PROPOSAL_NOT_PENDING: u64 = 4002;
    const E_ALREADY_VOTED: u64 = 4003;
    const E_THRESHOLD_NOT_MET: u64 = 4004;
    const E_UNAUTHORIZED_SUBAGENT: u64 = 4005;
    const E_SUBAGENT_CAP_EXPIRED: u64 = 4006;
    const E_SUBAGENT_BUDGET_EXCEEDED: u64 = 4007;
    const E_SUBAGENT_REVOKED: u64 = 4008;
    const E_NOT_A_MEMBER: u64 = 4009;
    const E_ARBITRARY_WEIGHT_REJECTED: u64 = 4010;
    const E_EPOCH_MISMATCH: u64 = 4011;
    const E_ORG_MISMATCH: u64 = 4012;
    /// A transfer proposal naming the zero address would pay the burn address.
    const E_ZERO_RECIPIENT: u64 = 4013;
    /// A zero-amount transfer proposal aborts inside the vault on every attempt.
    const E_ZERO_AMOUNT: u64 = 4014;
    /// A proposal whose deadline has already passed can never be executed.
    const E_DEADLINE_IN_THE_PAST: u64 = 4015;
    /// The relayer-supplied threshold signature over the treasury transfer
    /// digest failed native Ed25519 verification against the group key.
    const E_THRESHOLD_SIGNATURE_INVALID: u64 = 2701;
    /// Execution nonces must strictly increase; reusing a nonce that is not
    /// newer than the organization's last one is rejected.
    const E_INVALID_NONCE: u64 = 4016;
    /// Proposal titles must be non-empty and at most 256 bytes.
    const E_INVALID_TITLE: u64 = 4017;
    /// Proposal deadlines must be in the future and at most 365 days away.
    const E_INVALID_DEADLINE: u64 = 4018;

    /// Domain separator for treasury transfer execution signatures.
    const DOMAIN_TREASURY_TRANSFER: vector<u8> = b"SUI_ORG_TREASURY_TRANSFER_V1:";
    /// Transfer 摘要域（V2，Round-9 P0）：尾部追加 bcs(key_generation)。
    /// V1 域保留（不删）用于历史摘要辨认，新签名一律走 V2。
    const DOMAIN_TREASURY_TRANSFER_V2: vector<u8> = b"SUI_ORG_TREASURY_TRANSFER_V2:";

    /// Rolling budget window for `SubagentCoSignCap.daily_budget_limit`.
    const DAY_MS: u64 = 86_400_000;

    /// Maximum length of a proposal title, mirroring the treasury module.
    const MAX_TITLE_BYTES: u64 = 256;
    /// Maximum proposal duration (365 days), mirroring the treasury module.
    const MAX_DURATION_MS: u64 = 31_536_000_000;

    #[error(code = 13)]
    const EApprovalThresholdMet: vector<u8> = b"Rejection voting closes once approvals reach the proposal threshold.";

    /// Proposal UID extension key for the aggregate rejected weight (u64).
    /// Its empty Move struct compiles to dummy_field: bool; BCS name is [0].
    /// Absence means zero, including proposals created before this extension.
    public struct RejectedWeightKey has copy, drop, store {}

    /// Proposal UID extension key for a rejecting member's cast weight (u64).
    /// Its BCS name is exactly the member's 32-byte address.
    public struct RejectingVoterKey has copy, drop, store {
        voter: address,
    }

    /// 协签专用权限凭证：SubagentCoSignCap
    /// 主账号给其专属的 Subagent 签发此 Cap
    /// 赋予 Subagent 在特定时间、特定额度内代表主账号进行异步协签的链上法定资格！
    public struct SubagentCoSignCap has key, store {
        id: UID,
        master_owner: address,       // 所属的人类主账号 (例如 Alice)
        issued_epoch: u64,           // 签发时的组织纪元（跨纪元权重取 min 降级的依据）
        agent_address: address,      // 授权的 Subagent 地址
        voter_weight: u64,           // 代表主账号出资/治理的投票权重
        max_budget_per_tx: u64,      // 单笔协签放行上限
        daily_budget_limit: u64,     // 每日累计协签放行上限
        spent_today: u64,            // 当前窗口内已协签金额
        window_start_ms: u64,        // 当前 24h 窗口起点（惰性滚动）
        expires_at_ms: u64,          // 过期时间戳
        is_revoked: bool,            // 紧急吊销状态
    }

    /// 全异步治理提案共享对象
    /// 绑定 Organization 实体与 Epoch，权重严格由组织名册裁定
    public struct Proposal has key {
        id: UID,
        org_id: ID,
        epoch: u64,
        proposer: address,
        title: vector<u8>,
        recipient: address,
        amount: u64,
        threshold_weight: u64,
        accumulated_weight: u64,
        voters: Table<address, u64>,
        partial_signatures: Table<address, vector<u8>>,
        deadline_ms: u64,
        status: u8,
    }

    // 事件定义
    public struct ProposalCreatedEvent has copy, drop {
        proposal_id: ID,
        org_id: ID,
        epoch: u64,
        proposer: address,
        amount: u64,
        recipient: address,
        deadline_ms: u64,
    }

    public struct SubagentCapIssuedEvent has copy, drop {
        cap_id: ID,
        master_owner: address,
        agent_address: address,
        voter_weight: u64,
        max_budget_per_tx: u64,
        expires_at_ms: u64,
    }

    public struct SubagentCapRevokedEvent has copy, drop {
        cap_id: ID,
        master_owner: address,
        agent_address: address,
    }

    public struct AsyncVoteSubmittedEvent has copy, drop {
        proposal_id: ID,
        voter: address,
        weight: u64,
        total_weight: u64,
    }

    /// A member rejected using the live organization weight. Native event
    /// metadata identifies the sender; the total resynchronizes the aggregate.
    public struct AsyncVoteRejectedEvent has copy, drop {
        proposal_id: ID,
        weight: u64,
        total_rejected_weight: u64,
    }

    public struct ProposalExecutedEvent has copy, drop {
        proposal_id: ID,
        amount: u64,
        recipient: address,
    }

    /// 1. 发起全异步国库转账提案 (严格绑定 Organization 名册、门限阈值与纪元)
    ///
    /// 与 `organization_treasury::create_transfer` 相同的载荷守卫在模块级入口
    /// 自身执行：零收款人、零金额或已过期的截止都会产生「门限通过却永远无法
    /// 执行」的死提案（零地址还会让金库把币转给 0x0），所以在此统一拒绝。
    public fun create_transfer_proposal(
        org: &Organization,
        title: vector<u8>,
        recipient: address,
        amount: u64,
        deadline_ms: u64,
        clock: &Clock,
        ctx: &mut TxContext
    ): ID {
        let sender = ctx.sender();
        assert!(cryptographic_org::is_member(org, sender), E_NOT_A_MEMBER);
        assert!(recipient != @0x0, E_ZERO_RECIPIENT);
        assert!(amount > 0, E_ZERO_AMOUNT);
        let now = clock.timestamp_ms();
        assert!(deadline_ms > now, E_DEADLINE_IN_THE_PAST);
        assert!(!title.is_empty() && title.length() <= MAX_TITLE_BYTES, E_INVALID_TITLE);
        assert!(deadline_ms - now <= MAX_DURATION_MS, E_INVALID_DEADLINE);

        let uid = object::new(ctx);
        let proposal_id = object::uid_to_inner(&uid);
        let org_id = cryptographic_org::org_id(org);
        let epoch = cryptographic_org::epoch_version(org);
        let threshold_weight = cryptographic_org::threshold_weight(org);

        let proposal = Proposal {
            id: uid,
            org_id,
            epoch,
            proposer: sender,
            title,
            recipient,
            amount,
            threshold_weight,
            accumulated_weight: 0,
            voters: table::new<address, u64>(ctx),
            partial_signatures: table::new<address, vector<u8>>(ctx),
            deadline_ms,
            status: STATUS_PENDING,
        };

        event::emit(ProposalCreatedEvent {
            proposal_id,
            org_id,
            epoch,
            proposer: sender,
            amount,
            recipient,
            deadline_ms,
        });

        transfer::share_object(proposal);
        proposal_id
    }

    /// 1b. 主账号签发 Subagent 协签 Cap
    public fun issue_subagent_cosign_cap(
        org: &Organization,
        agent_address: address,
        voter_weight: u64,
        max_budget_per_tx: u64,
        daily_budget_limit: u64,
        expires_at_ms: u64,
        ctx: &mut TxContext
    ): SubagentCoSignCap {
        let uid = object::new(ctx);
        let cap_id = object::uid_to_inner(&uid);
        let master_owner = ctx.sender();

        // 只有组织成员才能向 Subagent 授予协签资格，且授予的权重不得超过
        // 主账号自身持有的名册权重（防止成员借 Subagent 放大投票权）。
        let issuer_weight = cryptographic_org::member_weight(org, master_owner);
        assert!(issuer_weight > 0, E_NOT_A_MEMBER);
        assert!(voter_weight <= issuer_weight, E_ARBITRARY_WEIGHT_REJECTED);

        event::emit(SubagentCapIssuedEvent {
            cap_id,
            master_owner,
            agent_address,
            voter_weight,
            max_budget_per_tx,
            expires_at_ms,
        });

        SubagentCoSignCap {
            id: uid,
            master_owner,
            issued_epoch: cryptographic_org::epoch_version(org),
            agent_address,
            voter_weight,
            max_budget_per_tx,
            daily_budget_limit,
            spent_today: 0,
            // The first window opens at issuance; `submit_async_vote_by_subagent`
            // rolls it forward lazily so the cap stays usable across days.
            window_start_ms: ctx.epoch_timestamp_ms(),
            expires_at_ms,
            is_revoked: false,
        }
    }


    /// 1b-2. 主账号签发并直接共享 Subagent 协签 Cap (推荐生产模式：双方均可无摩擦接入)
    public fun create_shared_subagent_cap(
        org: &Organization,
        agent_address: address,
        voter_weight: u64,
        max_budget_per_tx: u64,
        daily_budget_limit: u64,
        expires_at_ms: u64,
        ctx: &mut TxContext
    ): ID {
        let cap = issue_subagent_cosign_cap(
            org,
            agent_address,
            voter_weight,
            max_budget_per_tx,
            daily_budget_limit,
            expires_at_ms,
            ctx
        );
        let cap_id = object::uid_to_inner(&cap.id);
        transfer::share_object(cap);
        cap_id
    }

    /// 1c. 主账号单方面吊销 Subagent 的协签资格 (一键注销，即刻生效)
    public fun revoke_subagent_cosign_cap(
        cap: &mut SubagentCoSignCap,
        ctx: &mut TxContext
    ) {
        assert!(ctx.sender() == cap.master_owner, E_UNAUTHORIZED_SUBAGENT);
        cap.is_revoked = true;

        event::emit(SubagentCapRevokedEvent {
            cap_id: object::uid_to_inner(&cap.id),
            master_owner: cap.master_owner,
            agent_address: cap.agent_address,
        });
    }

    /// 2. 主账号自身直接进行异步赞成投票，附带保存未经验证的签名分片数据
    /// 身份由交易发送者认证；partial_signature 不参与 FROST 或其他签名验证。
    /// 强校验：绑定 Organization、绑定 Epoch、名册决算权重、拒绝假冒权重、防重放
    public fun submit_async_vote(
        proposal: &mut Proposal,
        org: &Organization,
        clock: &Clock,
        claimed_weight: u64,
        partial_signature: vector<u8>,
        ctx: &mut TxContext
    ) {
        assert!(proposal.status == STATUS_PENDING, E_PROPOSAL_NOT_PENDING);
        assert!(clock.timestamp_ms() <= proposal.deadline_ms, E_PROPOSAL_EXPIRED);

        // 1. 强绑定 Organization ID 与当前活跃 Epoch，杜绝跨组织或跨纪元假投票
        let org_id = cryptographic_org::org_id(org);
        assert!(proposal.org_id == org_id, E_ORG_MISMATCH);
        assert!(proposal.epoch == cryptographic_org::epoch_version(org), E_EPOCH_MISMATCH);

        // 2. 身份与权重由组织名册严格裁定，杜绝调用者伪造任意权重 (Arbitrary Weight)
        let sender = ctx.sender();
        let actual_weight = cryptographic_org::member_weight(org, sender);
        assert!(actual_weight > 0, E_NOT_A_MEMBER);
        assert!(claimed_weight == actual_weight, E_ARBITRARY_WEIGHT_REJECTED);

        // 3. 严格防重复投票 (Double Voting Deduplication)
        assert!(!proposal.voters.contains(sender), E_ALREADY_VOTED);

        proposal.voters.add(sender, actual_weight);
        proposal.partial_signatures.add(sender, partial_signature);
        proposal.accumulated_weight = proposal.accumulated_weight + actual_weight;

        event::emit(AsyncVoteSubmittedEvent {
            proposal_id: object::uid_to_inner(&proposal.id),
            voter: sender,
            weight: actual_weight,
            total_weight: proposal.accumulated_weight,
        });
    }

    /// Reject with the transaction sender's live membership weight. Each member
    /// may approve or reject once, including approvals delegated to a subagent.
    /// The deadline is inclusive in milliseconds. Rejection is terminal (3)
    /// at the same snapshotted threshold as approval, and cannot race an already
    /// satisfied approval threshold. Extensions remain readable on the shared
    /// proposal after either terminal state; no parent deletion path exists.
    public fun reject_async_vote(
        proposal: &mut Proposal,
        org: &Organization,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        assert!(proposal.status == STATUS_PENDING, E_PROPOSAL_NOT_PENDING);
        assert!(clock.timestamp_ms() <= proposal.deadline_ms, E_PROPOSAL_EXPIRED);
        assert!(proposal.org_id == cryptographic_org::org_id(org), E_ORG_MISMATCH);
        assert!(proposal.epoch == cryptographic_org::epoch_version(org), E_EPOCH_MISMATCH);

        let sender = ctx.sender();
        let actual_weight = cryptographic_org::member_weight(org, sender);
        assert!(actual_weight > 0, E_NOT_A_MEMBER);
        assert!(!proposal.voters.contains(sender), E_ALREADY_VOTED);
        assert!(proposal.accumulated_weight < proposal.threshold_weight, EApprovalThresholdMet);
        let total_rejected_weight = rejected_weight(proposal) + actual_weight;

        // Reserve the existing deduplication slot so published older approval
        // bytecode also rejects direct and delegated double decisions. The
        // approval total and partial_signatures remain approval-only.
        proposal.voters.add(sender, actual_weight);
        dynamic_field::add(&mut proposal.id, RejectingVoterKey { voter: sender }, actual_weight);
        if (dynamic_field::exists(&proposal.id, RejectedWeightKey {})) {
            *dynamic_field::borrow_mut<_, u64>(&mut proposal.id, RejectedWeightKey {}) = total_rejected_weight;
        } else {
            dynamic_field::add(&mut proposal.id, RejectedWeightKey {}, total_rejected_weight);
        };
        if (total_rejected_weight >= proposal.threshold_weight) {
            proposal.status = STATUS_REJECTED;
        };

        event::emit(AsyncVoteRejectedEvent {
            proposal_id: proposal.id.to_inner(),
            weight: actual_weight,
            total_rejected_weight,
        });
    }

    /// 2b. Subagent 持有主账号授予的 SubagentCoSignCap 进行合规受限协签！
    /// 身份由交易发送者和 Cap 认证；partial_signature 仅保存，不做 FROST 验证。
    public fun submit_async_vote_by_subagent(
        proposal: &mut Proposal,
        org: &Organization,
        cap: &mut SubagentCoSignCap,
        clock: &Clock,
        partial_signature: vector<u8>,
        ctx: &mut TxContext
    ) {
        assert!(proposal.status == STATUS_PENDING, E_PROPOSAL_NOT_PENDING);
        assert!(clock.timestamp_ms() <= proposal.deadline_ms, E_PROPOSAL_EXPIRED);

        // 绑定校验
        let org_id = cryptographic_org::org_id(org);
        assert!(proposal.org_id == org_id, E_ORG_MISMATCH);
        assert!(proposal.epoch == cryptographic_org::epoch_version(org), E_EPOCH_MISMATCH);

        // 强校验 1: 发送者必须是该 Cap 绑定的特定 Subagent
        let sender = ctx.sender();
        assert!(sender == cap.agent_address, E_UNAUTHORIZED_SUBAGENT);

        // 强校验 2: Cap 未被主账号吊销，且未过期
        assert!(!cap.is_revoked, E_SUBAGENT_REVOKED);
        assert!(clock.timestamp_ms() <= cap.expires_at_ms, E_SUBAGENT_CAP_EXPIRED);

        // 强校验 3: 单笔与累计限额校验。窗口按 24h 惰性滚动：跨窗口后的第一笔
        // 协签把 spent_today 归零，否则「每日上限」会退化成终身上限，cap 在
        // 打满后永久不可用（只能重新签发）。
        let now = clock.timestamp_ms();
        let window_open = now >= cap.window_start_ms && now - cap.window_start_ms < DAY_MS;
        let spent_in_window = if (window_open) cap.spent_today else 0;
        assert!(proposal.amount <= cap.max_budget_per_tx, E_SUBAGENT_BUDGET_EXCEEDED);
        assert!(spent_in_window + proposal.amount <= cap.daily_budget_limit, E_SUBAGENT_BUDGET_EXCEEDED);

        // 强校验 4: 主账号名册归属与权重校验，杜绝伪造投票权重
        let master = cap.master_owner;
        let actual_weight = cryptographic_org::member_weight(org, master);
        assert!(actual_weight > 0, E_NOT_A_MEMBER);
        // 纪元感知的权重裁决：签发纪元内要求 cap 权重与名册权重严格一致
        // （捕获篡改）；跨纪元（名册换届）后降级为 min(cap, 名册)，避免
        // 硬中止把旧 Cap 变成砖块 —— 但只按降级后的权重计票。
        let effective_weight = if (cap.issued_epoch == cryptographic_org::epoch_version(org)) {
            assert!(cap.voter_weight == actual_weight, E_ARBITRARY_WEIGHT_REJECTED);
            actual_weight
        } else {
            let degraded = if (cap.voter_weight < actual_weight) cap.voter_weight else actual_weight;
            assert!(degraded > 0, E_NOT_A_MEMBER);
            degraded
        };

        // 强校验 5: 代表 master_owner 记录投票 (防止主账号和其 subagent 重复投票)
        assert!(!proposal.voters.contains(master), E_ALREADY_VOTED);

        cap.spent_today = spent_in_window + proposal.amount;
        cap.window_start_ms = if (window_open) cap.window_start_ms else now;
        proposal.voters.add(master, effective_weight);
        proposal.partial_signatures.add(master, partial_signature);
        proposal.accumulated_weight = proposal.accumulated_weight + effective_weight;

        event::emit(AsyncVoteSubmittedEvent {
            proposal_id: object::uid_to_inner(&proposal.id),
            voter: master,
            weight: effective_weight,
            total_weight: proposal.accumulated_weight,
        });
    }

    /// 3. 法定门限达成后，任何人均可触发执行并调用国库划转
    public fun execute_transfer_proposal<T>(
        proposal: &mut Proposal,
        org: &mut Organization,
        vault: &mut AgentVault<T>,
        master_cap: &MasterCap,
        nonce: u64,
        frost_signature: vector<u8>,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        assert!(proposal.status == STATUS_PENDING, E_PROPOSAL_NOT_PENDING);
        assert!(clock.timestamp_ms() <= proposal.deadline_ms, E_PROPOSAL_EXPIRED);

        // 校验 Organization 绑定与纪元一致性 (若已换届/重置，旧纪元未完成提案立即作废)
        let org_id = cryptographic_org::org_id(org);
        assert!(proposal.org_id == org_id, E_ORG_MISMATCH);
        let epoch = cryptographic_org::epoch_version(org);
        assert!(proposal.epoch == epoch, E_EPOCH_MISMATCH);

        // 校验门限累积权重
        assert!(proposal.accumulated_weight >= proposal.threshold_weight, E_THRESHOLD_NOT_MET);

        // 门限签名门：单调 nonce 防重放 + 对转账摘要的原生 Ed25519 验签。
        // 摘要绑定 chain_id/org_id/epoch/nonce/proposal_id/recipient/amount/
        // key_generation，任何字段被替换都会导致验签失败。签名验证通过后才推进 nonce。
        assert!(nonce > cryptographic_org::last_nonce(org), E_INVALID_NONCE);
        let digest = transfer_digest(
            &cryptographic_org::chain_id(org),
            &org_id,
            epoch,
            nonce,
            &object::uid_to_inner(&proposal.id),
            &proposal.recipient,
            proposal.amount,
            cryptographic_org::key_generation(org),
        );
        assert!(
            ed25519::ed25519_verify(&frost_signature, &cryptographic_org::group_pk(org), &digest),
            E_THRESHOLD_SIGNATURE_INVALID,
        );
        cryptographic_org::set_last_nonce(org, nonce);

        proposal.status = STATUS_EXECUTED;

        // 调用 agent_vault 国库执行转账
        vault::withdraw<T>(master_cap, vault, proposal.amount, proposal.recipient, ctx);

        event::emit(ProposalExecutedEvent {
            proposal_id: object::uid_to_inner(&proposal.id),
            amount: proposal.amount,
            recipient: proposal.recipient,
        });
    }

    /// 单测专用：跳过门限签名门的执行入口（仅用于旧流程测试的下游断言）；
    /// 生产入口 execute_transfer_proposal 仍然强制链上 Ed25519 门限验签。
    #[test_only]
    public fun execute_transfer_proposal_for_testing<T>(
        proposal: &mut Proposal,
        org: &mut Organization,
        vault: &mut AgentVault<T>,
        master_cap: &MasterCap,
        nonce: u64,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        assert!(proposal.status == STATUS_PENDING, E_PROPOSAL_NOT_PENDING);
        assert!(clock.timestamp_ms() <= proposal.deadline_ms, E_PROPOSAL_EXPIRED);
        let org_id = cryptographic_org::org_id(org);
        assert!(proposal.org_id == org_id, E_ORG_MISMATCH);
        assert!(proposal.epoch == cryptographic_org::epoch_version(org), E_EPOCH_MISMATCH);
        assert!(proposal.accumulated_weight >= proposal.threshold_weight, E_THRESHOLD_NOT_MET);
        assert!(nonce > cryptographic_org::last_nonce(org), E_INVALID_NONCE);
        cryptographic_org::set_last_nonce(org, nonce);
        proposal.status = STATUS_EXECUTED;
        vault::withdraw<T>(master_cap, vault, proposal.amount, proposal.recipient, ctx);
        event::emit(ProposalExecutedEvent {
            proposal_id: object::uid_to_inner(&proposal.id),
            amount: proposal.amount,
            recipient: proposal.recipient,
        });
    }

    /// Treasury transfer execution digest (V2):
    /// H(DOMAIN_V2 || chain_id || bcs(org_id) || bcs(epoch) || bcs(nonce) ||
    ///   bcs(proposal_id) || bcs(recipient) || bcs(amount) || bcs(key_generation))
    /// V2 尾部追加 bcs(key_generation)（Round-9 P0）：rotate_group_key 落地后
    /// 生成代递增，旧密钥分片签出的旧摘要不再可重放，新摘要只有持新钥者能签。
    /// Implemented locally (std::hash) so cryptographic_org keeps no public
    /// helper for it; org_id/epoch/key_generation are read at call time and
    /// equality with the proposal snapshot is already asserted above.
    fun transfer_digest(
        chain_id: &vector<u8>,
        org_id: &ID,
        epoch: u64,
        nonce: u64,
        proposal_id: &ID,
        recipient: &address,
        amount: u64,
        key_generation: u64,
    ): vector<u8> {
        let mut data = DOMAIN_TREASURY_TRANSFER_V2;
        vector::append(&mut data, *chain_id);
        vector::append(&mut data, bcs::to_bytes(org_id));
        vector::append(&mut data, bcs::to_bytes(&epoch));
        vector::append(&mut data, bcs::to_bytes(&nonce));
        vector::append(&mut data, bcs::to_bytes(proposal_id));
        vector::append(&mut data, bcs::to_bytes(recipient));
        vector::append(&mut data, bcs::to_bytes(&amount));
        vector::append(&mut data, bcs::to_bytes(&key_generation));
        hash::sha2_256(data)
    }

    // --- 查询方法 ---
    public fun status(proposal: &Proposal): u8 {
        proposal.status
    }

    public fun org_id(proposal: &Proposal): ID {
        proposal.org_id
    }

    public fun epoch(proposal: &Proposal): u64 {
        proposal.epoch
    }

    public fun threshold_weight(proposal: &Proposal): u64 {
        proposal.threshold_weight
    }

    public fun accumulated_weight(proposal: &Proposal): u64 {
        proposal.accumulated_weight
    }

    /// Whether a member has cast either decision. Approval can be identified
    /// by is_voter && !is_rejecting_voter; partial_signatures is approval-only.
    public fun is_voter(proposal: &Proposal, voter: address): bool {
        proposal.voters.contains(voter)
    }

    /// Rejected weight is zero for proposals without the dynamic extension.
    public fun rejected_weight(proposal: &Proposal): u64 {
        if (dynamic_field::exists(&proposal.id, RejectedWeightKey {})) {
            *dynamic_field::borrow<_, u64>(&proposal.id, RejectedWeightKey {})
        } else {
            0
        }
    }

    /// Whether this member rejected. False for pre-extension proposals.
    public fun is_rejecting_voter(proposal: &Proposal, voter: address): bool {
        dynamic_field::exists_with_type<_, u64>(&proposal.id, RejectingVoterKey { voter })
    }

    public fun has_partial_signature(proposal: &Proposal, voter: address): bool {
        proposal.partial_signatures.contains(voter)
    }

    public fun cap_master_owner(cap: &SubagentCoSignCap): address {
        cap.master_owner
    }

    public fun cap_agent_address(cap: &SubagentCoSignCap): address {
        cap.agent_address
    }

    public fun cap_is_revoked(cap: &SubagentCoSignCap): bool {
        cap.is_revoked
    }

    public fun cap_spent_today(cap: &SubagentCoSignCap): u64 {
        cap.spent_today
    }

    /// Start of the rolling 24h window that `spent_today` is counted in.
    public fun cap_window_start_ms(cap: &SubagentCoSignCap): u64 {
        cap.window_start_ms
    }

    // === Test-Only Functions ===

    #[test]
    fun rejection_dynamic_field_keys_have_rpc_readable_bcs_layouts() {
        assert!(sui::bcs::to_bytes(&RejectedWeightKey {}) == vector[0], 1);
        assert!(
            sui::bcs::to_bytes(&RejectingVoterKey { voter: @0xA11CE }) == sui::bcs::to_bytes(&@0xA11CE),
            2
        );
    }

    #[test_only]
    public fun rejection_event_fields(event: &AsyncVoteRejectedEvent): (ID, u64, u64) {
        (event.proposal_id, event.weight, event.total_rejected_weight)
    }
}
