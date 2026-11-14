module agent_vault::cryptographic_org {
    use sui::object::{Self, UID, ID};
    use sui::tx_context::{Self, TxContext};
    use sui::transfer;
    use sui::table::{Self, Table};
    use sui::event;
    use sui::ed25519;
    use sui::balance::{Self, Balance};
    use sui::sui::SUI;
    use sui::coin;
    use sui::clock::{Self, Clock};
    use sui::bcs;
    use std::hash;
    use agent_vault::dkg_committee;


    // --- 域隔离常量与错误码定义 ---
    const DOMAIN_PROPOSAL: vector<u8> = b"SUI_ORG_THRESHOLD_PROPOSAL_V2:";
    const DOMAIN_THRESHOLD_APPROVAL: vector<u8> = b"SUI_ORG_APPROVAL_V1:";
    /// 推进纪元审批域（V2，Round-9 P0）：摘要尾部追加 bcs(key_generation)。
    /// V1 域保留（不删）用于历史摘要辨认，新签名一律走 V2。
    const DOMAIN_EPOCH_ADVANCE_V2: vector<u8> = b"SUI_ORG_EPOCH_ADVANCE_V2:";
    const DOMAIN_KEY_ROTATION: vector<u8> = b"SUI_ORG_KEY_ROTATION_V3:";
    const DOMAIN_ROSTER_UPDATE: vector<u8> = b"SUI_ORG_ROSTER_V1:";
    /// 组织创建 PoP 域（V2）：摘要尾部追加 bcs(key_threshold)，同一份
    /// (members, weights, threshold_weight) 签名无法被重放到另一把密钥门限下。
    const DOMAIN_POP_V2: vector<u8> = b"SUI_ORG_POP_V2:";
    /// 密钥轮换 PoP 域保持 V1：轮换摘要本身已绑定 org_id + next_epoch + pk，
    /// Round-7 只升级创建路径。SDK 侧 computeRotatePopDigest 与此对齐。
    const DOMAIN_POP: vector<u8> = b"SUI_ORG_POP_V1:";
    const DOMAIN_GENESIS_WITHDRAW: vector<u8> = b"SUI_ORG_GENESIS_WITHDRAW_V1:";
    /// 创世质押的协议级硬锁时长（90 天）：锁定期内任何门限签名都无法提前解锁，
    /// 防止"固化即提走"的组织拆解攻击。
    const GENESIS_LOCK_MS: u64 = 7_776_000_000;

    /// 创世质押仍在 90 天硬锁期内（协议级约束，治理不可绕过）。
    const E_GENESIS_LOCKED: u64 = 1011;
    const DEFAULT_CHAIN_ID: vector<u8> = b"sui-testnet:";
    /// Bounds the roster payload and the verification loop. Organizations created
    /// through `create_organization` are not limited, but only rosters up to this
    /// size can be replaced atomically by `update_organization_roster`.
    const MAX_ROSTER_MEMBERS: u64 = 128;

    const E_INVALID_SIGNATURE: u64 = 1001;
    const E_PROPOSAL_ALREADY_EXECUTED: u64 = 1002;
    const E_INVALID_PK_LENGTH: u64 = 1003;
    const E_EMPTY_MEMBERS: u64 = 1005;
    const E_INVALID_NONCE: u64 = 1006;
    const E_SESSION_NOT_FINALIZED: u64 = 1007;
    const E_THRESHOLD_EXCEEDS_SIGNERS: u64 = 1008;
    /// The organization's voting threshold was set below the DKG key threshold.
    const E_THRESHOLD_BELOW_KEY: u64 = 1009;
    /// Proof-of-possession signature (ed25519 under the group key itself) failed.
    const E_INVALID_POP: u64 = 1010;
    /// Confirmed-but-not-attested members left the key-signer roster smaller
    /// than the DKG key threshold: the finalized key could never be signed for.
    const E_KEY_SIGNER_SHORTFALL: u64 = 1012;
    /// The caller of create_organization_from_session is not a session
    /// participant (mirrors dkg_committee::E_NOT_A_PARTICIPANT = 3001).
    const E_NOT_A_PARTICIPANT: u64 = 3001;

    #[error(code = 1)]
    const EInvalidRoster: vector<u8> = b"Roster must contain 1 to 128 distinct nonzero addresses with matching positive weights, and cover the current roster exactly.";
    #[error(code = 2)]
    const EUnreachableThreshold: vector<u8> = b"Threshold weight must be positive and must not exceed the sum of the roster weights.";
    #[error(code = 3)]
    const ENoRosterChange: vector<u8> = b"The supplied roster and threshold are identical to the stored organization.";
    #[error(code = 4)]
    const EKeySignerRemoved: vector<u8> = b"Removing a key signer from the roster requires rotating the group key first.";

    /// 密码学组织共享对象
    public struct Organization has key {
        id: UID,
        group_pk: vector<u8>,                      // FROST 生成的恒定 Ed25519 公钥 (32 字节)
        threshold_weight: u64,                     // 门限权重阈值
        epoch_version: u64,                        // 组织换届/轮换版本号
        last_nonce: u64,                           // 单调递增 nonce (防重放)
        chain_id: vector<u8>,                      // 链标识符域隔离
        members_weight: Table<address, u64>,       // 成员在组织内的权重映射表
        executed_proposals: Table<vector<u8>, bool>,// 已执行提案摘要防重放表
        key_signers: vector<address>,              // 当前 group_pk 的见证签名者名单（随 rotate_group_key 更换）
        key_threshold: u64,                        // 当前 group_pk 的 FROST 门限人数
        // ↓ 创世质押字段（BCS 尾部追加：key_threshold 原注释所指“最后”仅对旧字段成立，
        //   追加字段不破坏既有 BCS 读取方，SDK 同步尾部）
        genesis_stake: Balance<SUI>,             // 创世质押池（submit 阶段超额缴款扫入）
        genesis_bonded_total: u64,               // 创世质押总额快照（含已提取；网络信号分子）
        genesis_withdrawn: u64,                  // 已提取的创世质押数额
        genesis_unlock_at_ms: u64,               // 硬锁到期时间戳（创建时刻 + 90 天；0 = 无质押）
        // ↓ 密钥生成代（Round-9 P0，BCS 尾部追加，所有创建路径为 1）。
        //   仅 rotate_group_key 成功后递增；resharing（保公钥换届）不递增。
        //   epoch-advance 与国库转账摘要 V2 绑定此值：轮换落地瞬间，旧密钥
        //   分片既不能重放旧摘要，也签不出绑定新生成代的新摘要。
        key_generation: u64,
    }

    public struct OrganizationCreatedEvent has copy, drop {
        org_id: ID,
        group_pk: vector<u8>,
        threshold_weight: u64,
        member_count: u64,
    }

    /// 创世质押从 DKG 会话扫入组织（固化时一次性发生）。
    public struct GenesisStakeRecordedEvent has copy, drop {
        org_id: ID,
        total_mist: u64,
        stakers: u64,
        unlock_at_ms: u64,
    }

    /// 创世质押在硬锁到期后被门限签名提取。
    public struct GenesisStakeWithdrawnEvent has copy, drop {
        org_id: ID,
        amount_mist: u64,
        recipient: address,
    }

    public struct ProposalExecutedEvent has copy, drop {
        org_id: ID,
        proposal_hash: vector<u8>,
        action_type: u8,
        epoch_version: u64,
    }

    public struct OrganizationEpochUpdatedEvent has copy, drop {
        org_id: ID,
        new_epoch_version: u64,
    }

    public struct GroupKeyRotatedEvent has copy, drop {
        org_id: ID,
        old_group_pk: vector<u8>,
        new_group_pk: vector<u8>,
        new_epoch_version: u64,
        key_generation: u64,
    }

    /// A threshold-approved roster change. `members` and `weights` are the full
    /// new roster after the transition; the digest committed them, not a diff.
    public struct RosterUpdatedEvent has copy, drop {
        org_id: ID,
        members: vector<address>,
        weights: vector<u64>,
        threshold_weight: u64,
        new_epoch_version: u64,
    }

    /// 1. 创建密码学组织共享对象 (支持指定 chain_id)
    public fun create_organization_with_chain_id(
        group_pk: vector<u8>,
        key_threshold: u64,
        threshold_weight: u64,
        members: vector<address>,
        weights: vector<u64>,
        chain_id: vector<u8>,
        pop_signature: vector<u8>,
        ctx: &mut TxContext
    ): ID {
        assert!(group_pk.length() == 32, E_INVALID_PK_LENGTH);
        let roster_weight = assert_valid_roster(&members, &weights);
        // A zero threshold would make every later proposal executable with no
        // approval at all (and unrejectable, since rejection closes once
        // approvals reach the threshold); a threshold above the roster is
        // permanently unreachable. Both are refused here, at creation, so every
        // downstream snapshot is a real quorum. `update_organization_roster`
        // enforces the same bounds on rotation.
        assert!(
            threshold_weight > 0 && threshold_weight <= roster_weight,
            EUnreachableThreshold,
        );
        // The FROST key threshold must be a real quorum of the signing roster:
        // zero would mean no key holders are needed, and above the roster can
        // never be met. Both would desync "who decides" from "who can sign".
        assert!(key_threshold > 0 && key_threshold <= members.length(), EInvalidRoster);
        // Proof-of-possession: the creator must prove control of the private key
        // behind `group_pk` before the key is trusted as the org's master key.
        // Without it, anyone could register a victim's FROST public key and
        // attribute the resulting org to them. V2 digest additionally binds the
        // FROST key threshold: the same (members, weights, threshold_weight)
        // signature can no longer be replayed under a different key threshold.
        assert!(pop_signature.length() == 64, E_INVALID_POP);
        let pop_digest = compute_create_pop_digest(
            &chain_id,
            &group_pk,
            &members,
            &weights,
            threshold_weight,
            key_threshold
        );
        assert!(
            ed25519::ed25519_verify(&pop_signature, &group_pk, &pop_digest),
            E_INVALID_POP
        );
        let len = members.length();

        let mut members_table = table::new<address, u64>(ctx);
        let mut i = 0;
        while (i < len) {
            let m = members[i];
            let w = weights[i];
            members_table.add(m, w);
            i = i + 1;
        };

        let org_uid = object::new(ctx);
        let org_id = object::uid_to_inner(&org_uid);
        let org = Organization {
            id: org_uid,
            group_pk,
            threshold_weight,
            epoch_version: 1,
            last_nonce: 0,
            chain_id,
            members_weight: members_table,
            executed_proposals: table::new<vector<u8>, bool>(ctx),
            key_signers: members,
            key_threshold,
            genesis_stake: balance::zero<SUI>(),
            genesis_bonded_total: 0,
            genesis_withdrawn: 0,
            genesis_unlock_at_ms: 0,
            key_generation: 1,
        };

        event::emit(OrganizationCreatedEvent {
            org_id,
            group_pk,
            threshold_weight,
            member_count: len,
        });

        transfer::share_object(org);
        org_id
    }

    /// Rejects a roster that `members_weight` cannot represent faithfully.
    ///
    /// The table is keyed by address, so a duplicate would silently overwrite the
    /// earlier weight while `member_count` still reported both, and `@0x0` is not
    /// a member anyone can act as. Creation used to accept both even though
    /// `update_organization_roster` has always rejected them; a shared check keeps
    /// the two entry points from disagreeing about what a roster is.
    ///
    /// Create-time zero weights are permitted (observer semantics); the roster
    /// updater is stricter because it rewrites an existing organization.
    ///
    /// Returns the total roster weight so the caller can check its threshold.
    fun assert_valid_roster(members: &vector<address>, weights: &vector<u64>): u64 {
        let len = members.length();
        assert!(len > 0 && len <= MAX_ROSTER_MEMBERS, EInvalidRoster);
        assert!(len == weights.length(), EInvalidRoster);

        let mut seen = vector[];
        let mut total = 0;
        let mut i = 0;
        while (i < len) {
            let member = members[i];
            // Zero weight is deliberate here: it makes a member readable in the
            // roster while granting no voting power, which
            // `organization_treasury` relies on. The zero *address* and
            // duplicates are not representable in the table, so they are refused.
            assert!(member != @0x0, EInvalidRoster);
            assert!(!seen.contains(&member), EInvalidRoster);
            seen.push_back(member);
            total = total + weights[i];
            i = i + 1;
        };

        // A threshold above the weight the roster can actually vote with can
        // never be met, so the organization would be permanently unable to
        // propose. Refuse it at creation rather than shipping a dead DAO.
        assert!(total > 0, EInvalidRoster);
        total
    }

    /// 1b. 默认创建方法 (使用 DEFAULT_CHAIN_ID = b"sui-testnet:")
    public fun create_organization(
        group_pk: vector<u8>,
        key_threshold: u64,
        threshold_weight: u64,
        members: vector<address>,
        weights: vector<u64>,
        pop_signature: vector<u8>,
        ctx: &mut TxContext
    ): ID {
        create_organization_with_chain_id(group_pk, key_threshold, threshold_weight, members, weights, DEFAULT_CHAIN_ID, pop_signature, ctx)
    }

    /// Entry 封装创建方法
    public fun create_organization_entry(
        group_pk: vector<u8>,
        key_threshold: u64,
        threshold_weight: u64,
        members: vector<address>,
        weights: vector<u64>,
        pop_signature: vector<u8>,
        ctx: &mut TxContext
    ) {
        let _ = create_organization(group_pk, key_threshold, threshold_weight, members, weights, pop_signature, ctx);
    }

    /// 1c. 从已固化的 DKG 会话创建组织（限时门限流程的链上固化入口）
    ///
    /// 安全约束（全部由合约强制，UI 无法绕过）：
    ///   - 会话必须已通过门限固化 (STATUS_FINALIZED)
    ///   - 一次性门：每个会话至多兑换一个组织（assert_org_not_created，
    ///     成功创建后 mark_org_created 落标记，重复兑换 abort 3026）
    ///   - group_pk 直接取 session.final_public_key（v3 固化要求 threshold 个已确认
    ///     成员各自从链上承诺重算并申报同一密钥）
    ///   - members（治理名册）只包含 confirmations 里的地址（未签名者自动被排除）
    ///   - key_signers（密钥见证名单）只包含 **已确认 且 链上申报值等于
    ///     final_public_key** 的参与者（attested_key_matches）：确认≠申报，
    ///     只有真的从承诺重算并写下了同一把密钥的成员才持有可用分片
    ///   - attested 子集人数 < DKG 门限 ⇒ E_KEY_SIGNER_SHORTFALL(1012)：
    ///     申报了这把密钥的成员凑不齐门限，密钥永远签不出来，组织不许成立
    ///   - threshold_weight 必须 >= DKG 门限（低于密钥门限的治理门限会让
    ///     提案在票数达标后仍无法执行，因为执行需要完整门限签名）
    ///   - threshold_weight 不得超过实际签名人数（attested 子集）
    ///   - 调用者必须是会话参与者（E_NOT_A_PARTICIPANT）：路人不得把别人的
    ///     固化会话兑换成自己的组织对象
    public fun create_organization_from_session(
        session: &mut dkg_committee::DkgSession,
        threshold_weight: u64,
        clock: &Clock,
        ctx: &mut TxContext
    ): ID {
        dkg_committee::assert_org_not_created(session);
        assert!(dkg_committee::status(session) == 3, E_SESSION_NOT_FINALIZED);
        assert!(dkg_committee::participants(session).contains(&ctx.sender()), E_NOT_A_PARTICIPANT);

        let all = dkg_committee::participants(session);
        let n = all.length();
        assert!(n > 0, E_EMPTY_MEMBERS);
        let final_pk = dkg_committee::final_public_key(session);
        let mut members = vector[];
        let mut weights = vector[];
        let mut key_signers = vector[];
        let mut i = 0;
        while (i < n) {
            let p = all[i];
            let confirmed = dkg_committee::is_participant_confirmed(session, p);
            if (confirmed) {
                members.push_back(p);
                weights.push_back(1);
            };
            // Key-signer gate: confirmed AND attested to exactly the finalized key.
            if (confirmed && dkg_committee::attested_key_matches(session, p, &final_pk)) {
                key_signers.push_back(p);
            };
            i = i + 1;
        };

        let signed_count = members.length();
        assert!(signed_count > 0, E_EMPTY_MEMBERS);
        let key_threshold = dkg_committee::threshold(session);
        assert!(key_signers.length() >= key_threshold, E_KEY_SIGNER_SHORTFALL);
        // `threshold_weight` is enforced later by `asynchronous_proposal`, which
        // snapshots it onto every proposal. Allowing it below the DKG threshold
        // would let a strict subset of the key's holders govern the organization
        // even though signing still needs the full key threshold — a split
        // between "who decides" and "who can sign" that no caller should pick.
        assert!(threshold_weight >= key_threshold, E_THRESHOLD_BELOW_KEY);
        assert!(threshold_weight <= signed_count, E_THRESHOLD_EXCEEDS_SIGNERS);

        // No PoP signature is required here: unlike direct creation, the group
        // key comes from a finalized DKG session where `threshold` confirmed
        // members each recomputed and attested the same `final_public_key` from
        // on-chain commitments, which is a distributed proof of possession
        // itself. A separate single-key PoP would add nothing.
        // 创世质押扫入：把会话中 submit 阶段各参与者的自愿超额缴款一次性
        // 收归组织托管，并叠加 90 天协议级硬锁。固化后质押不能随退会/超时
        // 流回个人（保证金走 claim_bond，与此处无关），否则"先收割再解散"
        // 的攻击零成本。空扫安全：无人超额缴款时 total=0、stakers=0。
        let (genesis_balance, stakers) = dkg_committee::take_genesis_stakes(session);
        let total_mist = genesis_balance.value();
        let unlock_at_ms = clock.timestamp_ms() + GENESIS_LOCK_MS;
        register_attested_roster(
            final_pk,
            key_signers,
            key_threshold,
            threshold_weight,
            members,
            weights,
            genesis_balance,
            total_mist,
            stakers,
            unlock_at_ms,
            session,
            ctx
        )
    }

    /// Creation tail for the attestation-based path (no PoP): registers the
    /// confirmed roster under the DKG-attested key. `key_signers` is the
    /// attested subset built by the caller (confirmed AND attested-key-matches),
    /// written verbatim; 创世质押在 share 之前写入：shared 对象无法再补写
    /// Balance 字段。组织对象先创建、标记会话、再 share —— org_id 在 share
    /// 前已知，一次性门在 share 前落下，不可重入。
    fun register_attested_roster(
        group_pk: vector<u8>,
        key_signers: vector<address>,
        key_threshold: u64,
        threshold_weight: u64,
        members: vector<address>,
        weights: vector<u64>,
        genesis_balance: Balance<SUI>,
        genesis_total_mist: u64,
        genesis_stakers: u64,
        genesis_unlock_at_ms: u64,
        session: &mut dkg_committee::DkgSession,
        ctx: &mut TxContext
    ): ID {
        assert!(group_pk.length() == 32, E_INVALID_PK_LENGTH);
        let len = members.length();

        let mut members_table = table::new<address, u64>(ctx);
        let mut i = 0;
        while (i < len) {
            members_table.add(members[i], weights[i]);
            i = i + 1;
        };

        let org_uid = object::new(ctx);
        let org_id = object::uid_to_inner(&org_uid);
        let org = Organization {
            id: org_uid,
            group_pk,
            threshold_weight,
            epoch_version: 1,
            last_nonce: 0,
            chain_id: DEFAULT_CHAIN_ID,
            members_weight: members_table,
            executed_proposals: table::new<vector<u8>, bool>(ctx),
            key_signers,
            key_threshold,
            genesis_stake: genesis_balance,
            genesis_bonded_total: genesis_total_mist,
            genesis_withdrawn: 0,
            genesis_unlock_at_ms,
            key_generation: 1,
        };

        event::emit(OrganizationCreatedEvent {
            org_id,
            group_pk,
            threshold_weight,
            member_count: len,
        });

        event::emit(GenesisStakeRecordedEvent {
            org_id,
            total_mist: genesis_total_mist,
            stakers: genesis_stakers,
            unlock_at_ms: genesis_unlock_at_ms,
        });

        // One-shot marker lands before share: org_id is known the moment the
        // UID exists, and a re-entrant call would abort on assert_org_not_created.
        dkg_committee::mark_org_created(session, org_id);

        transfer::share_object(org);
        org_id
    }

    /// PoP 摘要（直接创建，V2）:
    /// H(DOMAIN_POP_V2 || chain_id || group_pk || bcs(members) || bcs(weights)
    ///   || bcs(threshold_weight) || bcs(key_threshold))
    /// V2 尾部追加 bcs(key_threshold)：把 FROST 门限一并绑进签名授权范围。
    public fun compute_create_pop_digest(
        chain_id: &vector<u8>,
        group_pk: &vector<u8>,
        members: &vector<address>,
        weights: &vector<u64>,
        threshold_weight: u64,
        key_threshold: u64
    ): vector<u8> {
        let mut data = vector[];
        vector::append(&mut data, DOMAIN_POP_V2);
        vector::append(&mut data, *chain_id);
        vector::append(&mut data, *group_pk);
        vector::append(&mut data, bcs::to_bytes(members));
        vector::append(&mut data, bcs::to_bytes(weights));
        vector::append(&mut data, bcs::to_bytes(&threshold_weight));
        vector::append(&mut data, bcs::to_bytes(&key_threshold));
        hash::sha2_256(data)
    }

    /// PoP 摘要（密钥轮换）:
    /// H(DOMAIN_POP || chain_id || bcs(org_id) || bcs(new_epoch_version) || new_group_pk)
    public fun compute_rotate_pop_digest(
        chain_id: &vector<u8>,
        org_id: ID,
        new_epoch_version: u64,
        new_group_pk: &vector<u8>
    ): vector<u8> {
        let mut data = vector[];
        vector::append(&mut data, DOMAIN_POP);
        vector::append(&mut data, *chain_id);
        vector::append(&mut data, bcs::to_bytes(&org_id));
        vector::append(&mut data, bcs::to_bytes(&new_epoch_version));
        vector::append(&mut data, *new_group_pk);
        hash::sha2_256(data)
    }

    /// 计算完全更换公钥 (rotate_group_key) 专用的门限批准摘要 (V3):
    /// H(DOMAIN_KEY_ROTATION || chain_id || bcs(org_id) || bcs(epoch_version) ||
    ///   bcs(nonce) || new_group_pk || bcs(new_signers) || bcs(key_threshold))
    /// V2 将新签名者名单绑定进摘要；V3 再把新密钥门限绑进来：同一份门限签名
    /// 不能被重放到另一组签名者或另一个门限参数。
    public fun compute_key_rotation_digest(
        chain_id: &vector<u8>,
        org_id: ID,
        epoch_version: u64,
        nonce: u64,
        new_group_pk: &vector<u8>,
        new_signers: &vector<address>,
        key_threshold: u64
    ): vector<u8> {
        let mut data = vector[];
        vector::append(&mut data, DOMAIN_KEY_ROTATION);
        vector::append(&mut data, *chain_id);
        vector::append(&mut data, bcs::to_bytes(&org_id));
        vector::append(&mut data, bcs::to_bytes(&epoch_version));
        vector::append(&mut data, bcs::to_bytes(&nonce));
        vector::append(&mut data, *new_group_pk);
        vector::append(&mut data, bcs::to_bytes(new_signers));
        vector::append(&mut data, bcs::to_bytes(&key_threshold));
        hash::sha2_256(data)
    }

    /// 计算包含域隔离与防重放绑定的提案摘要 (V2):
    /// H(DOMAIN_PROPOSAL || chain_id || org_id || epoch_version || nonce || payload || bcs(action_type))
    /// V2 将 action_type 追加进摘要：签名授权的是确切的动作类别，而不只是字节串，
    /// 同一 payload 无法被重放到另一个 action_type 下执行。
    public fun compute_proposal_digest(
        chain_id: &vector<u8>,
        org_id: ID,
        epoch_version: u64,
        nonce: u64,
        payload: &vector<u8>,
        action_type: u8
    ): vector<u8> {
        let mut data = vector[];
        vector::append(&mut data, DOMAIN_PROPOSAL);
        vector::append(&mut data, *chain_id);
        vector::append(&mut data, bcs::to_bytes(&org_id));
        vector::append(&mut data, bcs::to_bytes(&epoch_version));
        vector::append(&mut data, bcs::to_bytes(&nonce));
        vector::append(&mut data, *payload);
        vector::append(&mut data, bcs::to_bytes(&action_type));
        hash::sha2_256(data)
    }

    /// 计算推进纪元 (换届/resharing) 专用的门限批准摘要 (V2):
    /// H(DOMAIN_EPOCH_ADVANCE_V2 || chain_id || org_id || epoch_version || nonce ||
    ///   new_epoch_version || key_generation)
    /// V2 尾部追加 bcs(key_generation)（Round-9 P0）：resharing 保公钥完成
    /// 后、rotate_group_key 落地的瞬间 key_generation 递增，旧密钥分片既
    /// 无法重放旧纪元审批摘要（老域+老生成代），也签不出新域+新生成代的
    /// 审批摘要 —— resharing 窗口被 rotate 一键封死。V1 域
    /// SUI_ORG_APPROVAL_V1: 保留不删，仅供历史摘要辨认。
    public fun compute_threshold_approval_digest(
        chain_id: &vector<u8>,
        org_id: ID,
        epoch_version: u64,
        nonce: u64,
        new_epoch_version: u64,
        key_generation: u64
    ): vector<u8> {
        let mut data = vector[];
        vector::append(&mut data, DOMAIN_EPOCH_ADVANCE_V2);
        vector::append(&mut data, *chain_id);
        vector::append(&mut data, bcs::to_bytes(&org_id));
        vector::append(&mut data, bcs::to_bytes(&epoch_version));
        vector::append(&mut data, bcs::to_bytes(&nonce));
        vector::append(&mut data, bcs::to_bytes(&new_epoch_version));
        vector::append(&mut data, bcs::to_bytes(&key_generation));
        hash::sha2_256(data)
    }


    /// 计算成员名册换届 (update_organization_roster) 专用的门限批准摘要:
    /// H(DOMAIN_ROSTER_UPDATE || chain_id || org_id || epoch_version || nonce ||
    ///   new_epoch_version || threshold_weight || bcs(members) || bcs(weights))
    /// The digest binds the complete next roster, its threshold, and the epoch it
    /// produces, so a signed approval cannot be replayed for a different roster.
    public fun compute_roster_update_digest(
        chain_id: &vector<u8>,
        org_id: ID,
        epoch_version: u64,
        nonce: u64,
        new_epoch_version: u64,
        threshold_weight: u64,
        members: &vector<address>,
        weights: &vector<u64>
    ): vector<u8> {
        let mut data = vector[];
        vector::append(&mut data, DOMAIN_ROSTER_UPDATE);
        vector::append(&mut data, *chain_id);
        vector::append(&mut data, bcs::to_bytes(&org_id));
        vector::append(&mut data, bcs::to_bytes(&epoch_version));
        vector::append(&mut data, bcs::to_bytes(&nonce));
        vector::append(&mut data, bcs::to_bytes(&new_epoch_version));
        vector::append(&mut data, bcs::to_bytes(&threshold_weight));
        vector::append(&mut data, bcs::to_bytes(members));
        vector::append(&mut data, bcs::to_bytes(weights));
        hash::sha2_256(data)
    }

    /// 2. 执行门限聚合签名提案 (域隔离、单调 nonce、绑定 org_id + epoch + chain_id 防跨组织与跨纪元重放)
    public fun execute_threshold_proposal(
        org: &mut Organization,
        nonce: u64,
        payload: vector<u8>,
        frost_signature: vector<u8>,
        action_type: u8,
        _ctx: &mut TxContext
    ) {
        // 1. 严格单调递增 nonce 校验
        assert!(nonce > org.last_nonce, E_INVALID_NONCE);

        // 2. 构造绑定 org_id, epoch, chain_id, nonce, payload, action_type 的域隔离摘要
        let org_id = object::uid_to_inner(&org.id);
        let digest = compute_proposal_digest(
            &org.chain_id,
            org_id,
            org.epoch_version,
            nonce,
            &payload,
            action_type
        );

        // 3. 防重放校验
        assert!(!org.executed_proposals.contains(digest), E_PROPOSAL_ALREADY_EXECUTED);

        // 4. 原生 Ed25519 门限聚合签名密码学验证
        let is_valid = ed25519::ed25519_verify(&frost_signature, &org.group_pk, &digest);
        assert!(is_valid, E_INVALID_SIGNATURE);

        // 5. 更新状态与单调 nonce
        org.executed_proposals.add(digest, true);
        org.last_nonce = nonce;

        // 6. 发射审计事件
        event::emit(ProposalExecutedEvent {
            org_id,
            proposal_hash: digest,
            action_type,
            epoch_version: org.epoch_version,
        });
    }

    /// 3. 通过门限签名推进组织换届纪元 (例如 Resharing 之后，保留公钥但递增版本)
    public fun advance_organization_epoch(
        org: &mut Organization,
        nonce: u64,
        frost_signature: vector<u8>,
        _ctx: &mut TxContext
    ) {
        assert!(nonce > org.last_nonce, E_INVALID_NONCE);
        let org_id = object::uid_to_inner(&org.id);
        let next_epoch = org.epoch_version + 1;

        let approval_digest = compute_threshold_approval_digest(
            &org.chain_id,
            org_id,
            org.epoch_version,
            nonce,
            next_epoch,
            org.key_generation
        );

        assert!(!org.executed_proposals.contains(approval_digest), E_PROPOSAL_ALREADY_EXECUTED);
        let is_valid = ed25519::ed25519_verify(&frost_signature, &org.group_pk, &approval_digest);
        assert!(is_valid, E_INVALID_SIGNATURE);

        org.executed_proposals.add(approval_digest, true);
        org.last_nonce = nonce;
        org.epoch_version = next_epoch;

        event::emit(OrganizationEpochUpdatedEvent {
            org_id,
            new_epoch_version: next_epoch,
        });
    }

    /// 3b. 提取创世质押（90 天硬锁到期后，由当前纪元门限签名授权）
    ///
    /// 安全约束：
    ///   - 协议级硬锁：clock.timestamp_ms() >= genesis_unlock_at_ms 才可提取，
    ///     任何门限签名、任何治理动作都无法提前解锁（E_GENESIS_LOCKED）。
    ///   - 域隔离 + 单调 nonce + epoch 绑定（与 advance_organization_epoch 同型）。
    ///   - 金额必须为正且不超过余额；部分提取允许，提取后余额可继续为零。
    /// 网络信号读取方：live 质押 = genesis_bonded_total() - genesis_withdrawn()。
    public fun withdraw_genesis_stake(
        org: &mut Organization,
        nonce: u64,
        amount: u64,
        recipient: address,
        frost_signature: vector<u8>,
        clock: &Clock,
        _ctx: &mut TxContext
    ) {
        assert!(nonce > org.last_nonce, E_INVALID_NONCE);
        assert!(clock.timestamp_ms() >= org.genesis_unlock_at_ms, E_GENESIS_LOCKED);
        assert!(amount > 0 && amount <= org.genesis_stake.value(), E_GENESIS_LOCKED);

        let org_id = object::uid_to_inner(&org.id);
        let digest = compute_genesis_withdraw_digest(
            &org.chain_id,
            org_id,
            org.epoch_version,
            nonce,
            amount,
            recipient
        );

        assert!(!org.executed_proposals.contains(digest), E_PROPOSAL_ALREADY_EXECUTED);
        let is_valid = ed25519::ed25519_verify(&frost_signature, &org.group_pk, &digest);
        assert!(is_valid, E_INVALID_SIGNATURE);

        let withdrawn = org.genesis_stake.split(amount);
        let withdrawn_coin = coin::from_balance<SUI>(withdrawn, _ctx);
        transfer::public_transfer(withdrawn_coin, recipient);

        org.executed_proposals.add(digest, true);
        org.last_nonce = nonce;
        org.genesis_withdrawn = org.genesis_withdrawn + amount;

        event::emit(GenesisStakeWithdrawnEvent {
            org_id,
            amount_mist: amount,
            recipient,
        });
    }

    /// 创世质押提取摘要:
    /// H(DOMAIN_GENESIS_WITHDRAW || chain_id || bcs(org_id) || bcs(epoch) ||
    ///   bcs(nonce) || bcs(amount) || bcs(recipient))
    public fun compute_genesis_withdraw_digest(
        chain_id: &vector<u8>,
        org_id: ID,
        epoch_version: u64,
        nonce: u64,
        amount: u64,
        recipient: address
    ): vector<u8> {
        let mut data = vector[];
        vector::append(&mut data, DOMAIN_GENESIS_WITHDRAW);
        vector::append(&mut data, *chain_id);
        vector::append(&mut data, bcs::to_bytes(&org_id));
        vector::append(&mut data, bcs::to_bytes(&epoch_version));
        vector::append(&mut data, bcs::to_bytes(&nonce));
        vector::append(&mut data, bcs::to_bytes(&amount));
        vector::append(&mut data, bcs::to_bytes(&recipient));
        hash::sha2_256(data)
    }

    /// 4. 彻底轮换组织主公钥 (应对拜占庭恶意节点或旧分片泄露场景)
    /// 当旧成员拒绝擦除私钥分片并存在串谋风险时，保持公钥不变的 Resharing 无法防范共谋；
    /// 此时必须执行 rotate_group_key，由当前 epoch 的法定门限签署授权，将 org.group_pk 替换为全新 DKG 生成的公钥。
    ///
    /// V3 安全约束：
    ///   - 门限摘要绑定 new_signers 与 key_threshold，同一签名无法被重放到
    ///     另一组签名者或另一个门限参数；
    ///   - 必须同时提交新密钥自身的 ed25519 PoP（防止注册不受控/受害者公钥）；
    ///   - new_signers 必须是 1..=MAX_ROSTER_MEMBERS 个非零且互不相同的地址，
    ///     key_threshold 必须是 1..=new_signers.length() 的真实门限；
    ///   - 轮换成功后 org.key_signers = new_signers 且 org.key_threshold = key_threshold。
    public fun rotate_group_key(
        org: &mut Organization,
        nonce: u64,
        new_group_pk: vector<u8>,
        new_signers: vector<address>,
        key_threshold: u64,
        pop_signature: vector<u8>,
        frost_signature: vector<u8>,
        _ctx: &mut TxContext
    ) {
        assert!(new_group_pk.length() == 32, E_INVALID_PK_LENGTH);

        // Validate the new signer list: non-empty, bounded, distinct, nonzero.
        let signer_count = new_signers.length();
        assert!(signer_count > 0 && signer_count <= MAX_ROSTER_MEMBERS, EInvalidRoster);
        let mut seen_signers = vector[];
        let mut si = 0;
        while (si < signer_count) {
            let signer = new_signers[si];
            assert!(signer != @0x0, EInvalidRoster);
            assert!(!seen_signers.contains(&signer), EInvalidRoster);
            seen_signers.push_back(signer);
            si = si + 1;
        };
        // The new key's threshold must be a real quorum of the new signers.
        assert!(key_threshold > 0 && key_threshold <= signer_count, EInvalidRoster);

        assert!(nonce > org.last_nonce, E_INVALID_NONCE);
        let org_id = object::uid_to_inner(&org.id);
        let next_epoch = org.epoch_version + 1;

        // PoP: the NEW key must prove possession of its own private key, bound
        // to this org and the epoch the rotation produces, so an attacker can
        // neither register an uncontrolled key nor replay the PoP elsewhere.
        // (PoP digest unchanged from V1: it already binds org_id + next epoch + pk.)
        assert!(pop_signature.length() == 64, E_INVALID_POP);
        let pop_digest = compute_rotate_pop_digest(&org.chain_id, org_id, next_epoch, &new_group_pk);
        assert!(
            ed25519::ed25519_verify(&pop_signature, &new_group_pk, &pop_digest),
            E_INVALID_POP
        );

        let rotation_digest = compute_key_rotation_digest(
            &org.chain_id,
            org_id,
            org.epoch_version,
            nonce,
            &new_group_pk,
            &new_signers,
            key_threshold
        );

        assert!(!org.executed_proposals.contains(rotation_digest), E_PROPOSAL_ALREADY_EXECUTED);
        let is_valid = ed25519::ed25519_verify(&frost_signature, &org.group_pk, &rotation_digest);
        assert!(is_valid, E_INVALID_SIGNATURE);

        let old_pk = org.group_pk;
        org.executed_proposals.add(rotation_digest, true);
        org.last_nonce = nonce;
        org.epoch_version = next_epoch;
        org.group_pk = new_group_pk;
        org.key_signers = new_signers;
        org.key_threshold = key_threshold;
        // Round-9 P0: a rotation invalidates every shard of the previous key
        // generation. Bump the counter so both V2 digests (epoch advance and
        // treasury transfer) stop accepting signatures from the old shards the
        // moment this transaction lands, closing the resharing window.
        org.key_generation = org.key_generation + 1;

        event::emit(GroupKeyRotatedEvent {
            org_id,
            old_group_pk: old_pk,
            new_group_pk,
            new_epoch_version: next_epoch,
            key_generation: org.key_generation,
        });
    }

    /// 5. 由当前纪元门限签署的成员名册换届 (增删成员、调整权重与门限)
    ///
    /// 名册以完整快照提交而非增量 diff：`new_members` 与 `new_weights` 是换届后的
    /// 全部成员，参数与门限摘要逐字节绑定，因此同一份签名不能用于另一份名册。
    /// 名册变更同时推进 `epoch_version`，让仍在旧纪元创建的提案 (绑定 org_id + epoch)
    /// 立即失效；公钥与共享对象 ID 不变。
    ///
    /// 密钥签名者保护：当前 org.key_signers 中的任何地址都不能被本次换届移除。
    /// 他们是当前 group_pk 分片的持有者；先把他们移出名册再换密钥，会留下一个
    /// “已无治理权却仍能签出有效门限签名” 的窗口。要剔除密钥签名者，必须先
    /// rotate_group_key 更换密钥与 key_signers，再做名册换届。
    ///
    /// `prior_members` 只用于清理旧表的动态字段：合约校验它与链上名册完全一致
    /// (数量相等且逐一存在)，因此调用者无法借省略地址保留已移除成员。它不进入
    /// 签名摘要，签名者只对下一版名册本身负责。
    ///
    /// 校验顺序：新名册形状 → 旧名册一致 → 确有变更 → 门限可达 → 密钥签名者保留 →
    /// nonce 单调 → 摘要未使用 → FROST 聚合签名 → 替换名册并发射事件。
    public fun update_organization_roster(
        org: &mut Organization,
        nonce: u64,
        prior_members: vector<address>,
        new_members: vector<address>,
        new_weights: vector<u64>,
        new_threshold_weight: u64,
        frost_signature: vector<u8>,
        _ctx: &mut TxContext
    ) {
        let count = new_members.length();
        assert!(count > 0 && count <= MAX_ROSTER_MEMBERS, EInvalidRoster);
        assert!(count == new_weights.length(), EInvalidRoster);

        // Validate the complete next snapshot before any other work. Zero-weight
        // entries are rejected so `is_member` and the roster agree.
        let mut sum = 0;
        let mut seen = vector[];
        let mut i = 0;
        while (i < count) {
            let member = new_members[i];
            let weight = new_weights[i];
            assert!(member != @0x0 && weight > 0, EInvalidRoster);
            assert!(!seen.contains(&member), EInvalidRoster);
            seen.push_back(member);
            sum = sum + weight;
            i = i + 1;
        };
        assert!(new_threshold_weight > 0 && new_threshold_weight <= sum, EUnreachableThreshold);
        // The governance threshold must never fall below the live key
        // threshold: signing still requires key_threshold holders, so a lower
        // governance threshold would let a minority approve what only a key
        // quorum can authorize (and brick execution the other way around).
        assert!(new_threshold_weight >= org.key_threshold, E_THRESHOLD_BELOW_KEY);

        // The prior list must enumerate the live table exactly; otherwise an
        // omitted address would silently survive the replacement.
        assert!(covers_current_roster(org, &prior_members), EInvalidRoster);

        // Every current key signer must survive the transition. Dropping one
        // while the key (and its shards) stay live leaves a holder of signing
        // power outside the governed roster.
        assert!(key_signers_retained(org, &new_members), EKeySignerRemoved);

        // Reject a no-op so the event stream records only real transitions and a
        // signed nonce is never consumed for an unchanged roster.
        assert!(!same_roster(org, &new_members, &new_weights) || new_threshold_weight != org.threshold_weight, ENoRosterChange);
        assert!(nonce > org.last_nonce, E_INVALID_NONCE);


        let org_id = object::uid_to_inner(&org.id);
        let next_epoch = org.epoch_version + 1;
        let digest = compute_roster_update_digest(
            &org.chain_id,
            org_id,
            org.epoch_version,
            nonce,
            next_epoch,
            new_threshold_weight,
            &new_members,
            &new_weights
        );

        assert!(!org.executed_proposals.contains(digest), E_PROPOSAL_ALREADY_EXECUTED);
        let is_valid = ed25519::ed25519_verify(&frost_signature, &org.group_pk, &digest);
        assert!(is_valid, E_INVALID_SIGNATURE);

        // Remove the proven-old entries, then add the signed roster. Any address
        // that is both old and new is removed and re-added with its new weight.
        let mut k = 0;
        let prior_len = prior_members.length();
        while (k < prior_len) {
            let previous_weight = org.members_weight.remove(prior_members[k]);
            let _ = previous_weight;
            k = k + 1;
        };
        let mut j = 0;
        while (j < count) {
            org.members_weight.add(new_members[j], new_weights[j]);
            j = j + 1;
        };

        org.executed_proposals.add(digest, true);
        org.last_nonce = nonce;
        org.epoch_version = next_epoch;
        org.threshold_weight = new_threshold_weight;

        event::emit(RosterUpdatedEvent {
            org_id,
            members: new_members,
            weights: new_weights,
            threshold_weight: new_threshold_weight,
            new_epoch_version: next_epoch,
        });
    }

    /// A roster is the same when it has the same addresses with the same weights,
    /// independent of order. Bounded by MAX_ROSTER_MEMBERS at its call site.
    fun same_roster(org: &Organization, members: &vector<address>, weights: &vector<u64>): bool {
        if (org.members_weight.length() != members.length()) return false;
        let mut i = 0;
        let len = members.length();
        while (i < len) {
            let member = members[i];
            if (!org.members_weight.contains(member)) return false;
            if (org.members_weight[member] != weights[i]) return false;
            i = i + 1;
        };
        true
    }

    /// True when `members` is a distinct enumeration of exactly the live roster.
    /// Count equality plus membership proves nothing is missing or invented.
    fun covers_current_roster(org: &Organization, members: &vector<address>): bool {
        let count = members.length();
        if (count != org.members_weight.length()) return false;
        let mut seen = vector[];
        let mut i = 0;
        while (i < count) {
            let member = members[i];
            if (seen.contains(&member) || !org.members_weight.contains(member)) return false;
            seen.push_back(member);
            i = i + 1;
        };
        count > 0
    }

    /// True when every address in `org.key_signers` appears in the candidate
    /// next roster. Key signers hold shards of the live group key; removing one
    /// from governance while the key stays live must go through
    /// `rotate_group_key` (which swaps both the key and this list) first.
    fun key_signers_retained(org: &Organization, new_members: &vector<address>): bool {
        let signer_count = org.key_signers.length();
        let mut i = 0;
        while (i < signer_count) {
            if (!new_members.contains(&org.key_signers[i])) return false;
            i = i + 1;
        };
        true
    }

    // --- 只读查询方法 ---

    public fun org_id(org: &Organization): ID {
        object::uid_to_inner(&org.id)
    }

    public fun group_pk(org: &Organization): vector<u8> {
        org.group_pk
    }

    public fun threshold_weight(org: &Organization): u64 {
        org.threshold_weight
    }

    public fun epoch_version(org: &Organization): u64 {
        org.epoch_version
    }

    public fun last_nonce(org: &Organization): u64 {
        org.last_nonce
    }

    /// Advances the monotonic replay-protection nonce. Callers MUST assert
    /// `nonce > last_nonce(org)` before calling; this setter only writes.
    /// Used by asynchronous_proposal's treasury transfer signature gate.
    public(package) fun set_last_nonce(org: &mut Organization, nonce: u64) {
        org.last_nonce = nonce;
    }

    public fun chain_id(org: &Organization): vector<u8> {
        org.chain_id
    }

    /// 当前 group_pk 的见证签名者名单（创建时为全体成员/确认成员，随 rotate_group_key 更换）。
    public fun key_signers(org: &Organization): vector<address> {
        org.key_signers
    }

    /// 当前 group_pk 的 FROST 门限人数（创建/轮换时写入，轮换时更新）。
    public fun key_threshold(org: &Organization): u64 {
        org.key_threshold
    }

    /// 当前密钥的生成代：所有创建路径为 1，仅 rotate_group_key 成功后递增。
    /// 国库转账与推进纪元的 V2 摘要绑定此值。
    public fun key_generation(org: &Organization): u64 {
        org.key_generation
    }

    // --- 创世质押只读查询 ---

    /// 创世质押总额快照（含已提取部分）；网络信号分子。
    public fun genesis_bonded_total(org: &Organization): u64 {
        org.genesis_bonded_total
    }

    /// 已提取的创世质押数额；网络信号 = genesis_bonded_total() - genesis_withdrawn()。
    public fun genesis_withdrawn(org: &Organization): u64 {
        org.genesis_withdrawn
    }

    /// 硬锁到期时间戳（毫秒）；0 表示组织未持有创世质押。
    public fun genesis_unlock_at_ms(org: &Organization): u64 {
        org.genesis_unlock_at_ms
    }

    /// 创世质押池当前余额（MIST）。
    public fun genesis_stake_balance(org: &Organization): u64 {
        org.genesis_stake.value()
    }

    /// 创世质押提取域前缀（SDK 摘要构造使用）。
    public fun domain_genesis_withdraw(): vector<u8> {
        DOMAIN_GENESIS_WITHDRAW
    }

    /// 创世质押硬锁时长（毫秒）。
    public fun genesis_lock_ms(): u64 {
        GENESIS_LOCK_MS
    }

    public fun is_proposal_executed(org: &Organization, proposal_hash: vector<u8>): bool {
        org.executed_proposals.contains(proposal_hash)
    }

    public fun member_weight(org: &Organization, member: address): u64 {
        if (org.members_weight.contains(member)) {
            org.members_weight[member]
        } else {
            0
        }
    }

    public fun is_member(org: &Organization, member: address): bool {
        member_weight(org, member) > 0
    }

    public fun domain_proposal(): vector<u8> {
        DOMAIN_PROPOSAL
    }

    public fun domain_threshold_approval(): vector<u8> {
        DOMAIN_THRESHOLD_APPROVAL
    }

    /// 推进纪元审批域（V2，尾部追加 bcs(key_generation)；SDK 摘要构造使用）。
    public fun domain_epoch_advance_v2(): vector<u8> {
        DOMAIN_EPOCH_ADVANCE_V2
    }

    public fun default_chain_id(): vector<u8> {
        DEFAULT_CHAIN_ID
    }

    public fun domain_roster_update(): vector<u8> {
        DOMAIN_ROSTER_UPDATE
    }

    /// 组织创建 PoP 域（V2，含 key_threshold 绑定）；轮换 PoP 域仍为
    /// SUI_ORG_POP_V1:（SDK computeRotatePopDigest 与此对齐）。
    public fun domain_pop_v2(): vector<u8> {
        DOMAIN_POP_V2
    }

    public fun max_roster_members(): u64 {
        MAX_ROSTER_MEMBERS
    }

    // === Test-Only Functions ===

    /// 单测专用：跳过 PoP 的创建入口。仅用于不需要真实门限签名的旧逻辑测试；
    /// 生产入口（create_organization*）仍然强制链上 PoP 验证。
    #[test_only]
    public fun create_organization_for_testing(
        group_pk: vector<u8>,
        key_threshold: u64,
        threshold_weight: u64,
        members: vector<address>,
        weights: vector<u64>,
        ctx: &mut TxContext,
    ): ID {
        let roster_weight = assert_valid_roster(&members, &weights);
        assert!(threshold_weight > 0 && threshold_weight <= roster_weight, EUnreachableThreshold);
        assert!(key_threshold > 0 && key_threshold <= members.length(), EInvalidRoster);
        let len = members.length();
        let mut members_table = table::new<address, u64>(ctx);
        let mut i = 0;
        while (i < len) {
            members_table.add(members[i], weights[i]);
            i = i + 1;
        };
        let org_uid = object::new(ctx);
        let org = Organization {
            id: org_uid,
            group_pk,
            chain_id: DEFAULT_CHAIN_ID,
            epoch_version: 1,
            threshold_weight,
            last_nonce: 0,
            members_weight: members_table,
            key_signers: members,
            key_threshold,
            executed_proposals: table::new(ctx),
            genesis_stake: balance::zero<SUI>(),
            genesis_bonded_total: 0,
            genesis_withdrawn: 0,
            genesis_unlock_at_ms: 0,
            key_generation: 1,
        };
        let id = object::uid_to_inner(&org.id);
        transfer::share_object(org);
        id
    }

    #[test_only]
    public fun genesis_recorded_fields(event: &GenesisStakeRecordedEvent): (ID, u64, u64, u64) {
        (event.org_id, event.total_mist, event.stakers, event.unlock_at_ms)
    }

    #[test_only]
    public fun genesis_withdrawn_fields(event: &GenesisStakeWithdrawnEvent): (ID, u64, address) {
        (event.org_id, event.amount_mist, event.recipient)
    }

    #[test_only]
    public fun rotated_event_generation(event: &GroupKeyRotatedEvent): u64 {
        event.key_generation
    }

    #[test_only]
    public fun roster_updated_fields(event: &RosterUpdatedEvent): (ID, vector<address>, vector<u64>, u64, u64) {
        (event.org_id, event.members, event.weights, event.threshold_weight, event.new_epoch_version)
    }

    /// 单测专用：跳过 PoP/门限验签的轮换入口（保留 nonce 单调与名册语义）；
    /// 生产入口 rotate_group_key 强制双重验签。
    #[test_only]
    public fun rotate_group_key_for_testing(
        org: &mut Organization,
        nonce: u64,
        new_group_pk: vector<u8>,
        new_signers: vector<address>,
        key_threshold: u64,
        _ctx: &TxContext,
    ) {
        assert!(new_group_pk.length() == 32, E_INVALID_PK_LENGTH);
        assert!(nonce > org.last_nonce, E_INVALID_NONCE);
        assert!(new_signers.length() > 0 && new_signers.length() <= MAX_ROSTER_MEMBERS, EInvalidRoster);
        assert!(key_threshold > 0 && key_threshold <= new_signers.length(), EInvalidRoster);
        org.group_pk = new_group_pk;
        org.epoch_version = org.epoch_version + 1;
        org.last_nonce = nonce;
        org.key_signers = new_signers;
        org.key_threshold = key_threshold;
        // 与生产 rotate_group_key 保持一致：轮换递增密钥生成代。
        org.key_generation = org.key_generation + 1;
    }

    /// 单测专用：直接替换 key_signers（用于先收窄签名者名册再测试成员移除）。
    #[test_only]
    public fun set_key_signers_for_testing(org: &mut Organization, signers: vector<address>) {
        org.key_signers = signers;
    }

    /// 单测专用：直接注入创世质押状态（绕过 DKG 扫入，测试 withdraw 的
    /// 锁期/签名/nonce 语义本身）。
    #[test_only]
    public fun set_genesis_stake_for_testing(
        org: &mut Organization,
        amount_mist: u64,
        unlock_at_ms: u64,
        ctx: &mut TxContext
    ) {
        let coin = sui::coin::mint_for_testing<SUI>(amount_mist, ctx);
        let stake_balance = sui::coin::into_balance(coin);
        org.genesis_stake.join(stake_balance);
        org.genesis_bonded_total = amount_mist;
        org.genesis_withdrawn = 0;
        org.genesis_unlock_at_ms = unlock_at_ms;
    }
}
