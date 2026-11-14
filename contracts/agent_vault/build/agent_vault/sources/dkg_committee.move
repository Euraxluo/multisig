module agent_vault::dkg_committee {
    use sui::object::{Self, UID, ID};
    use sui::tx_context::{Self, TxContext};
    use sui::transfer;
    use sui::table::{Self, Table};
    use sui::clock::{Self, Clock};
    use sui::coin::{Self, Coin};
    use sui::balance::{Self, Balance};
    use sui::sui::SUI;
    use sui::event;
    use sui::dynamic_field;
    use sui::ed25519;
    use sui::bcs;
    use std::hash::sha2_256;

    // --- 状态与错误码定义 ---
    const STATUS_ROUND_1_COMMITMENTS: u8 = 1;
    const STATUS_ROUND_2_MAILBOX: u8 = 2;
    const STATUS_FINALIZED: u8 = 3;
    const STATUS_TIMED_OUT: u8 = 4;

    const E_NOT_A_PARTICIPANT: u64 = 3001;
    const E_INVALID_SESSION_STATUS: u64 = 3002;
    const E_ALREADY_SUBMITTED: u64 = 3003;
    const E_SESSION_EXPIRED: u64 = 3004;
    const E_QUORUM_NOT_REACHED: u64 = 3005;
    const E_SESSION_NOT_EXPIRED: u64 = 3006;
    const E_INVALID_PUBLIC_KEY_LENGTH: u64 = 3007;
    /// identity / order-8 小阶公钥编码（rt-lit-ed25519-verify 实测链上接受 → 拉黑）
    const E_SMALL_ORDER_PUBLIC_KEY: u64 = 3027;
    const E_PAYLOAD_MISMATCH: u64 = 3008;
    /// The registered encryption key does not match the length this module requires.
    const E_INVALID_ENCRYPTION_KEY: u64 = 3009;
    /// The participant registered a key that differs from the one already on file.
    const E_ENCRYPTION_KEY_CONFLICT: u64 = 3010;
    /// The caller tried to attest a group key before confirming the shares it opened.
    const E_NOT_CONFIRMED: u64 = 3011;
    /// Fewer than `threshold` confirmed participants attested to this group key.
    /// Finalization is refused: the key is not the one the committee agreed on.
    const E_KEY_NOT_ATTESTED: u64 = 3012;
    /// The participant list repeats an address, or contains the zero address.
    const E_INVALID_PARTICIPANT_SET: u64 = 3014;
    /// A commitment payload shorter than a compressed elliptic-curve point.
    /// Commitments are consumed off-chain as curve points; a shorter blob can
    /// only be an error or an attempt to store arbitrary data on-chain.
    const E_INVALID_COMMITMENT: u64 = 3015;
    /// The caller tried to confirm before publishing its own commitment.
    /// A confirmation asserts "I verified the shares against the commitments",
    /// which is meaningless when the confirmer never published one.
    const E_COMMITMENT_MISSING: u64 = 3016;
    /// 参与者未在 Round 1 公布签名公钥，或公布的公钥格式非法。
    const E_ATTEST_KEY_MISSING: u64 = 3017;
    /// attestation 签名验证失败（未用公布公钥签出 session_id‖group_pk 摘要）。
    const E_ATTEST_SIGNATURE_INVALID: u64 = 3018;
    // 小阶点编码黑名单（P1-1，round7 文献审计）：ed25519_verify 接受 identity 公钥
    // （任何人可签），链上无曲线运算只能编码拉黑。两个 8 阶点的规范编码：
    //   identity (1,0)   → 0x0100…00
    //   order-8 (0,-1)   → 0xecff…ff（-1 mod p 的编码头）
    const SMALL_ORDER_PK_1: vector<u8> = x"0100000000000000000000000000000000000000000000000000000000000000";
    const SMALL_ORDER_PK_2: vector<u8> = x"ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f";
    const SMALL_ORDER_PK_3: vector<u8> = x"0000000000000000000000000000000000000000000000000000000000000000";

    /// 红队 rt-lit-ed25519-verify：identity pk 被链上接受 → 拒绝全部小阶编码。
    public fun assert_not_small_order_pk(pk: &vector<u8>) {
        assert!(*pk != SMALL_ORDER_PK_1, E_SMALL_ORDER_PUBLIC_KEY);
        assert!(*pk != SMALL_ORDER_PK_2, E_SMALL_ORDER_PUBLIC_KEY);
        assert!(*pk != SMALL_ORDER_PK_3, E_SMALL_ORDER_PUBLIC_KEY);
    }
    /// 同一 (sender, recipient) 信箱槽位的重复投递。此前静默跳过会让发件人
    /// 以为替换成功，而链上仍保留首写密文；现在显式拒绝。
    const E_MAILBOX_ALREADY_DEPOSITED: u64 = 3019;
    /// 保证金金额低于下限 MIN_BOND_MIST（为将来可配置化预留的校验槽位）。
    const E_BOND_BELOW_MIN: u64 = 3020;
    /// 保证金金额高于上限 MAX_BOND_MIST（为将来可配置化预留的校验槽位）。
    const E_BOND_ABOVE_MAX: u64 = 3021;
    /// 缴款低于应缴额（创建费不足或提交保证金不足）。
    const E_BOND_INSUFFICIENT_PAYMENT: u64 = 3022;
    /// 参与者无保证金可领（未提交过承诺，或已 claim 过）。
    const E_NO_BOND_TO_CLAIM: u64 = 3023;
    /// 会话尚未进入终态（FINALIZED / TIMED_OUT），保证金不可取回。
    const E_SESSION_NOT_TERMINAL: u64 = 3024;
    /// 截止时间距 now 不在 [MIN_SESSION_DURATION_MS, MAX_SESSION_DURATION_MS]。
    const E_DEADLINE_OUT_OF_RANGE: u64 = 3025;
    /// 本会话已创建过 Organization：一次性创建门（每会话至多兑换一个组织）。
    const E_ORG_ALREADY_CREATED: u64 = 3026;
    /// T2-a（round-10）：信箱载荷超过 MAX_MAILBOX_PAYLOAD_BYTES（2048B）。
    const E_PAYLOAD_TOO_LARGE: u64 = 3028;
    /// T2-a（round-10）：接收方未登记信箱加密公钥（EncryptionKeySlot），投递拒绝。
    const E_RECIPIENT_KEY_MISSING: u64 = 3029;
    /// 信箱密文载荷长度上限：合法 HPKE/AEAD 封装份额远小于此；超长 blob 是垃圾数据。
    const MAX_MAILBOX_PAYLOAD_BYTES: u64 = 2048;

    /// 保证金下限：0.05 SUI。
    const MIN_BOND_MIST: u64 = 50_000_000;
    /// 保证金上限：0.5 SUI。
    const MAX_BOND_MIST: u64 = 500_000_000;
    /// 会话创建费：0.005 SUI，全额转 @0x0（不可花费地址，等效销毁）的防垃圾定价。
    const SESSION_CREATION_FEE_MIST: u64 = 5_000_000;
    /// 会话时长下限：10 分钟（杜绝"秒超时"抢跑）。
    const MIN_SESSION_DURATION_MS: u64 = 600_000;
    /// 会话时长上限：7 天（杜绝永不超时的僵尸会话）。
    const MAX_SESSION_DURATION_MS: u64 = 604_800_000;
    /// Attestation 绑定摘要域: H(DOMAIN ‖ session_id ‖ group_pk)
    const DOMAIN_ATTESTATION: vector<u8> = b"SUI_DKG_ATTEST_V1:";

    /// 密态信箱加密公钥采用双栈共存（不设单一固定长度）：
    ///   - 32 字节：X25519 原始公钥；
    ///   - 65 字节：P-256 未压缩点 (`0x04 || X || Y`)，即
    ///     `crypto.subtle.exportKey("raw", ...)` 对 ECDH P-256 密钥的输出。
    /// 新旧客户端在过渡期各自选择栈，链上只拒绝两种合法形态之外的长度。
    /// 信箱载荷的封装方案（X25519 ECIES / P-256 ECIES）由密钥长度自描述。
    const ENCRYPTION_KEY_LENGTH_X25519: u64 = 32;
    const ENCRYPTION_KEY_LENGTH_P256: u64 = 65;

    /// Administrative authority revision. Bumped whenever a rule that off-chain
    /// callers depend on changes.
    ///
    /// Revision 2 added participant encryption-key registration, which is what
    /// makes the store-and-forward mailbox usable: before it, a sender had no key
    /// to seal a share to.
    ///
    /// Revision 3 fixes a critical flaw. `finalize_session` (v1) wrote
    /// `final_public_key` from a caller-supplied argument with **no** check at all,
    /// and `finalize_session_v2` verified the "proof" against that same argument,
    /// so it only proved "the caller knows the private key of the key the caller
    /// chose". Anyone could finalize a quorum-reaching session onto a key they
    /// controlled and then create an `Organization` with it. Revision 3 replaces
    /// the trust anchor: the group key must now be **attested by `threshold`
    /// confirmed participants**, each of whom read the on-chain commitments and
    /// recomputed the key independently. See `finalize_session`.
    ///
    /// Revision 4 rejects malformed participant sets at session creation. Revision
    /// 3 counted attestations by walking participant-list indices while
    /// `confirmations` is address-keyed, so a list containing the same address
    /// twice let one member satisfy a threshold-2 attestation gate and finalize a
    /// key of their choosing. Both `create_dkg_session` and
    /// `create_resharing_session` now reject duplicates and the zero address with
    /// `E_INVALID_PARTICIPANT_SET` (3014).
    ///
    /// Revision 5 closes the remaining state-machine gaps: the session creator
    /// must itself be a participant and the committee is capped at 128 members;
    /// commitments must be at least 32 bytes; a confirmation requires the
    /// confirmer's own commitment to exist; and key attestation is only
    /// accepted once the session reached Round 2 (commitments frozen), so a
    /// key cannot be vouched for against a commitment set still in flux.
    ///
    /// Revision 6 adds the admission economics: session creation burns a
    /// spam-pricing fee to @0x0 and clamps the deadline to
    /// [MIN_SESSION_DURATION_MS, MAX_SESSION_DURATION_MS]; every commitment
    /// submission escrows a participation bond (fixed at MIN_BOND_MIST for
    /// `create_dkg_session` sessions), refundable in full by the depositor
    /// once the session reaches a terminal state (`claim_bond`), with any
    /// overpayment recorded as a genesis stake that organization creation
    /// sweeps under a 90-day hard lock.
    ///
    /// Revision 7 is the Round-7 hardening: mailbox encryption keys accept the
    /// dual stack (32-byte X25519 or 65-byte P-256 uncompressed); organization
    /// creation off a finalized session becomes one-shot per session
    /// (`assert_org_not_created` / `mark_org_created`); and
    /// `create_organization_from_session` builds the key-signer roster only
    /// from participants whose attested key matches the finalized group key.
    const DKG_REVISION: u64 = 7;

    /// Dynamic-field key recording one participant's current group-key
    /// attestation. Keyed by participant alone so the attested value can be read
    /// back cheaply and overwritten when a member recomputes.
    ///
    /// A dynamic field keeps `DkgSession`'s published layout intact, which a
    /// compatible upgrade cannot change.
    public struct GroupKeyAttestationSlot has copy, drop, store {
        participant: address,
    }

    /// Dynamic-field key recording a participant's mailbox encryption key on its
    /// own session. A dynamic field keeps `DkgSession`'s published layout intact,
    /// which a compatible upgrade cannot change.
    /// Dynamic-field key recording the per-participant ed25519 attestation
    /// public key published in Round 1 alongside the commitment. Attestations
    /// must be signed under this key, binding them to the participant.
    public struct AttestationKeySlot has copy, drop, store {
        participant: address,
    }

    public struct EncryptionKeySlot has copy, drop, store {
        participant: address,
    }

    /// 密态信箱寻址复合键 (发送者 -> 接收者)
    /// 确保任意成员跨时区独立投递，并发无锁、互不覆盖
    public struct MailboxKey has copy, drop, store {
        sender: address,
        recipient: address,
    }

    /// 纯全异步 DKG 会话共享对象
    /// 成员无须任何实时在线握手，完全基于存储转发 (Store-and-Forward) 密态信箱与链上状态机
    public struct DkgSession has key {
        id: UID,
        epoch: u64,
        threshold: u64,
        total_participants: u64,
        participants: vector<address>,
        commitments: Table<address, vector<u8>>,
        // 离线密态信箱表: (Sender, Recipient) -> HPKE 加密分片包裹
        encrypted_mailboxes: Table<MailboxKey, vector<u8>>,
        // 成员异步签收确认表
        confirmations: Table<address, bool>,
        confirmations_count: u64,
        deadline_timestamp_ms: u64,
        status: u8,
        final_public_key: vector<u8>,
    }

    /// 会话级保证金配置单例键：BondConfigSlot -> bond_mist (u64)。
    /// `create_dkg_session` 固定写入 MIN_BOND_MIST；resharing 会话不配置，读作 0。
    /// 用动态字段保持 `DkgSession` 已发布布局不变（兼容升级不能改布局）。
    public struct BondConfigSlot has copy, drop, store {
        dummy: bool,
    }

    /// 参与者保证金托管槽：ParticipantBondSlot -> Balance<SUI>。
    /// 提交承诺时强制缴入，会话进入终态（固化/超时）后由本人 claim_bond 全额取回。
    public struct ParticipantBondSlot has copy, drop, store {
        participant: address,
    }

    /// 参与者创世质押槽：ParticipantStakeSlot -> Balance<SUI>。
    /// 缴款超出保证金的部分视为自愿质押一并托管；组织固化时一次性扫入
    /// Organization 并叠加 90 天协议级硬锁（不走 claim_bond 退款）。
    public struct ParticipantStakeSlot has copy, drop, store {
        participant: address,
    }

    /// 会话级一次性组织创建标记键：OrgCreatedSlot -> org_id。
    /// `create_organization_from_session` 成功后写入；门禁只看存在性，
    /// 防止同一固化会话被反复兑换成组织对象。用动态字段保持
    /// `DkgSession` 已发布布局不变（兼容升级不能改布局）。
    public struct OrgCreatedSlot has copy, drop, store {
        dummy: bool,
    }

    // --- 审计事件 ---
    public struct SessionCreatedEvent has copy, drop {
        session_id: ID,
        epoch: u64,
        threshold: u64,
        deadline_ms: u64,
    }

    public struct CommitmentSubmittedEvent has copy, drop {
        session_id: ID,
        participant: address,
    }

    public struct MailboxDepositedEvent has copy, drop {
        session_id: ID,
        sender: address,
        recipient: address,
    }

    public struct EncryptionKeyRegisteredEvent has copy, drop {
        session_id: ID,
        participant: address,
    }

    public struct ParticipantConfirmedEvent has copy, drop {
        session_id: ID,
        participant: address,
        confirmations_count: u64,
        threshold: u64,
    }

    public struct SessionFinalizedEvent has copy, drop {
        session_id: ID,
        epoch: u64,
        group_pk: vector<u8>,
        confirmations_count: u64,
    }

    public struct SessionTimedOutEvent has copy, drop {
        session_id: ID,
        confirmations_count: u64,
        threshold: u64,
    }

    /// Emitted on every (re-)attestation so off-chain callers can show progress
    /// toward the `threshold` this key needs without scanning dynamic fields.
    public struct GroupKeyAttestedEvent has copy, drop {
        session_id: ID,
        participant: address,
        group_pk: vector<u8>,
    }

    /// Emitted at session creation: the bond every participant must escrow to
    /// submit a commitment (MIST). Off-chain callers read it once to size the
    /// payment coin instead of hard-coding MIN_BOND_MIST.
    public struct SessionBondConfiguredEvent has copy, drop {
        session_id: ID,
        bond_mist: u64,
    }

    /// Emitted when organization creation sweeps the genesis stakes out of a
    /// finalized session. `stakers` counts participants whose escrowed excess
    /// was actually non-zero; bonds are not part of this sweep.
    public struct GenesisStakeSweptEvent has copy, drop {
        session_id: ID,
        total_mist: u64,
        stakers: u64,
    }

    /// Emitted on every bond refund so off-chain callers can reconcile the
    /// pull-model payouts without scanning dynamic fields.
    public struct BondClaimedEvent has copy, drop {
        session_id: ID,
        participant: address,
        amount_mist: u64,
    }

    /// Rejects a participant list the session state machine cannot represent.
    ///
    /// `confirmations` and `commitments` are keyed by address, so a repeated
    /// address can only ever act once — while `attestation_count_for` walks the
    /// participant *list* and reads one dynamic field per entry. A duplicate is
    /// therefore counted twice in the attestation tally but cannot add a second
    /// confirmation, which lets fewer distinct members than `threshold` reach the
    /// attestation gate. `@0x0` can never sign, so it is refused too.
    fun assert_participant_set(participants: &vector<address>) {
        let len = participants.length();
        let mut seen = vector[];
        let mut i = 0;
        while (i < len) {
            let who = participants[i];
            assert!(who != @0x0, E_INVALID_PARTICIPANT_SET);
            assert!(!seen.contains(&who), E_INVALID_PARTICIPANT_SET);
            seen.push_back(who);
            i = i + 1;
        };
    }

    /// 1. 创建全异步 DKG 仪式会话
    ///
    /// 准入经济学（防垃圾/女巫定价）：
    ///   - `creation_fee` ≥ SESSION_CREATION_FEE_MIST，全额转 @0x0 销毁
    ///     （不可花费地址，等效燃烧；多付是调用方自己的选择）；
    ///   - 截止时间距 now 夹取在 [MIN_SESSION_DURATION_MS, MAX_SESSION_DURATION_MS]；
    ///   - 会话保证金固定为 MIN_BOND_MIST（BondConfigSlot 单例），
    ///     submit_commitment 时逐人托管。
    public fun create_dkg_session(
        threshold: u64,
        participants: vector<address>,
        deadline_timestamp_ms: u64,
        creation_fee: Coin<SUI>,
        clock: &Clock,
        ctx: &mut TxContext
    ): ID {
        let len = participants.length();
        assert!(threshold > 0 && threshold <= len, E_QUORUM_NOT_REACHED);
        assert!(participants.contains(&ctx.sender()), E_NOT_A_PARTICIPANT);
        assert!(len >= 1 && len <= 128, E_INVALID_PARTICIPANT_SET);
        assert_participant_set(&participants);

        // 创建费：先验额再整体转 @0x0（精确或多付均销毁）。
        assert!(
            creation_fee.value() >= SESSION_CREATION_FEE_MIST,
            E_BOND_INSUFFICIENT_PAYMENT,
        );
        transfer::public_transfer(creation_fee, @0x0);

        // 截止时长夹取：第一层挡"落在过去"（防减法下溢），第二层夹 [10 分钟, 7 天]。
        let now = clock.timestamp_ms();
        assert!(deadline_timestamp_ms >= now, E_DEADLINE_OUT_OF_RANGE);
        assert!(
            deadline_timestamp_ms - now >= MIN_SESSION_DURATION_MS
                && deadline_timestamp_ms - now <= MAX_SESSION_DURATION_MS,
            E_DEADLINE_OUT_OF_RANGE,
        );

        // 保证金配置单例：本会话每人应缴 bond（当前固定 MIN_BOND_MIST）。
        let uid = object::new(ctx);
        let session_id = object::uid_to_inner(&uid);

        let mut session = DkgSession {
            id: uid,
            epoch: 1,
            threshold,
            total_participants: len,
            participants,
            commitments: table::new<address, vector<u8>>(ctx),
            encrypted_mailboxes: table::new<MailboxKey, vector<u8>>(ctx),
            confirmations: table::new<address, bool>(ctx),
            confirmations_count: 0,
            deadline_timestamp_ms,
            status: STATUS_ROUND_1_COMMITMENTS,
            final_public_key: vector[],
        };
        dynamic_field::add(&mut session.id, BondConfigSlot { dummy: true }, MIN_BOND_MIST);

        event::emit(SessionCreatedEvent {
            session_id,
            epoch: 1,
            threshold,
            deadline_ms: deadline_timestamp_ms,
        });
        event::emit(SessionBondConfiguredEvent {
            session_id,
            bond_mist: MIN_BOND_MIST,
        });

        transfer::share_object(session);
        session_id
    }

    /// 1b. 创建新纪元重置会话 (支持新成员加入或移除成员，推进 Epoch)
    public fun create_resharing_session(
        epoch: u64,
        threshold: u64,
        participants: vector<address>,
        deadline_timestamp_ms: u64,
        ctx: &mut TxContext
    ): ID {
        assert!(epoch > 1, E_INVALID_SESSION_STATUS);
        let len = participants.length();
        assert!(threshold > 0 && threshold <= len, E_QUORUM_NOT_REACHED);
        assert_participant_set(&participants);
        assert!(participants.contains(&ctx.sender()), E_NOT_A_PARTICIPANT);
        assert!(len >= 1 && len <= 128, E_INVALID_PARTICIPANT_SET);

        let uid = object::new(ctx);
        let session_id = object::uid_to_inner(&uid);

        let session = DkgSession {
            id: uid,
            epoch,
            threshold,
            total_participants: len,
            participants,
            commitments: table::new<address, vector<u8>>(ctx),
            encrypted_mailboxes: table::new<MailboxKey, vector<u8>>(ctx),
            confirmations: table::new<address, bool>(ctx),
            confirmations_count: 0,
            deadline_timestamp_ms,
            status: STATUS_ROUND_1_COMMITMENTS,
            final_public_key: vector[],
        };

        event::emit(SessionCreatedEvent {
            session_id,
            epoch,
            threshold,
            deadline_ms: deadline_timestamp_ms,
        });

        transfer::share_object(session);
        session_id
    }

    /// 2. 参与者异步提交多项式承诺点 (仅在 Round 1 允许提交，达到门限后冻结合格 Dealer 集合 Q)
    ///
    /// `payment` ≥ 会话保证金（BondConfigSlot，动态字段读取）：
    ///   - 保证金部分托管在 ParticipantBondSlot，终态后 claim_bond 全额取回；
    ///   - 超额部分（可为 0）作为自愿创世质押托管在 ParticipantStakeSlot，
    ///     组织固化时扫入 Organization 并加 90 天硬锁。
    /// 两个槽位与承诺同事务原子写入：任一失败整笔回滚，已缴款项原路退回；
    /// 重复提交仍由 E_ALREADY_SUBMITTED 先行拦截，不会二次扣款。
    public fun submit_commitment(
        session: &mut DkgSession,
        clock: &Clock,
        commitment_bytes: vector<u8>,
        attest_public_key: vector<u8>,
        payment: Coin<SUI>,
        ctx: &mut TxContext
    ) {
        assert!(session.status == STATUS_ROUND_1_COMMITMENTS, E_INVALID_SESSION_STATUS);
        assert!(clock.timestamp_ms() <= session.deadline_timestamp_ms, E_SESSION_EXPIRED);

        let sender = ctx.sender();
        assert!(session.participants.contains(&sender), E_NOT_A_PARTICIPANT);
        assert!(!session.commitments.contains(sender), E_ALREADY_SUBMITTED);
        assert!(commitment_bytes.length() >= 32, E_INVALID_COMMITMENT);
        // 承诺必须同时公布 32 字节 ed25519 attestation 公钥；后续
        // attest_group_key 的签名将在此公钥下链上验证，防止移植/代签。
        assert!(attest_public_key.length() == 32, E_ATTEST_KEY_MISSING);

        // 缴款拆分：bond 部分强制托管，余额（可为 0）记为创世质押。
        let bond_mist = session_bond_mist(session);
        assert!(payment.value() >= bond_mist, E_BOND_INSUFFICIENT_PAYMENT);
        let mut paid = coin::into_balance(payment);
        let bond = balance::split(&mut paid, bond_mist);
        dynamic_field::add(&mut session.id, ParticipantBondSlot { participant: sender }, bond);
        dynamic_field::add(&mut session.id, ParticipantStakeSlot { participant: sender }, paid);

        session.commitments.add(sender, commitment_bytes);
        let key_slot = AttestationKeySlot { participant: sender };
        dynamic_field::add(&mut session.id, key_slot, attest_public_key);

        event::emit(CommitmentSubmittedEvent {
            session_id: object::uid_to_inner(&session.id),
            participant: sender,
        });

        if (session.commitments.length() >= session.threshold) {
            session.status = STATUS_ROUND_2_MAILBOX;
        };
    }

    /// 3. 为对端成员向信箱投递加密分片包 (完全异步，无需等待任何人在线)
    public fun deposit_mailbox_share(
        session: &mut DkgSession,
        clock: &Clock,
        recipient: address,
        encrypted_payload: vector<u8>,
        ctx: &mut TxContext
    ) {
        assert!(session.status == STATUS_ROUND_1_COMMITMENTS || session.status == STATUS_ROUND_2_MAILBOX, E_INVALID_SESSION_STATUS);
        assert!(clock.timestamp_ms() <= session.deadline_timestamp_ms, E_SESSION_EXPIRED);

        let sender = ctx.sender();
        assert!(session.participants.contains(&sender), E_NOT_A_PARTICIPANT);
        assert!(session.participants.contains(&recipient), E_NOT_A_PARTICIPANT);
        // TODO(round-11+): 信封发送方签名归责需要改双栈 envelope 结构，本轮不做。
        // T2-a（round-10）：毒信封/junk 载荷门禁。链上无解密能力，只能做结构约束：
        // 合法密文（HPKE/AEAD 封装 32B 份额）远小于此上限，超长 blob 只能是垃圾或存储滥用。
        assert!(
            encrypted_payload.length() <= MAX_MAILBOX_PAYLOAD_BYTES,
            E_PAYLOAD_TOO_LARGE
        );
        // 接收方必须已在 Round 1/2 登记 TLS 加密公钥（EncryptionKeySlot）；
        // 向未登记密钥的成员投递意味着其份额永远无法解密 → 静默作废 → finalize 卡死。
        assert!(
            dynamic_field::exists<EncryptionKeySlot>(&session.id, EncryptionKeySlot { participant: recipient }),
            E_RECIPIENT_KEY_MISSING
        );

        let key = MailboxKey { sender, recipient };
        assert!(
            !session.encrypted_mailboxes.contains(key),
            E_MAILBOX_ALREADY_DEPOSITED
        );
        session.encrypted_mailboxes.add(key, encrypted_payload);

        event::emit(MailboxDepositedEvent {
            session_id: object::uid_to_inner(&session.id),
            sender,
            recipient,
        });
    }

    /// 4. 登记本参与者的信箱加密公钥 (双栈: X25519 32 字节原始公钥，或
    /// P-256 65 字节未压缩点)。封装方案由密钥长度自描述，两栈过渡期共存。
    ///
    /// 有了它，其他成员才能把份额密封给收件人；在此之前邮箱只能存明文包裹，
    /// 而 `deposit_mailbox_share` 的载荷对任何 RPC 读取者都是公开的。
    /// 同一参与者只能登记一次：先写优先，避免中途换钥让已投递的份额无法解开。
    public fun register_encryption_key(
        session: &mut DkgSession,
        clock: &Clock,
        encryption_public_key: vector<u8>,
        ctx: &mut TxContext
    ) {
        assert!(session.status == STATUS_ROUND_1_COMMITMENTS || session.status == STATUS_ROUND_2_MAILBOX, E_INVALID_SESSION_STATUS);
        assert!(clock.timestamp_ms() <= session.deadline_timestamp_ms, E_SESSION_EXPIRED);
        let key_len = encryption_public_key.length();
        assert!(
            key_len == ENCRYPTION_KEY_LENGTH_X25519 || key_len == ENCRYPTION_KEY_LENGTH_P256,
            E_INVALID_ENCRYPTION_KEY,
        );

        let sender = ctx.sender();
        assert!(session.participants.contains(&sender), E_NOT_A_PARTICIPANT);

        let slot = EncryptionKeySlot { participant: sender };
        assert!(!dynamic_field::exists(&session.id, slot), E_ENCRYPTION_KEY_CONFLICT);
        dynamic_field::add(&mut session.id, slot, encryption_public_key);

        event::emit(EncryptionKeyRegisteredEvent {
            session_id: object::uid_to_inner(&session.id),
            participant: sender,
        });
    }

    /// 5. 纯全异步单阶段一键投递包 (Single-Shot Async VSS Submission):
    /// 成员无论何时打开 App，一次性广播自身承诺点，并为所有成员投递密态分片，操作完毕即可关闭 App！
    public fun submit_async_package(
        session: &mut DkgSession,
        clock: &Clock,
        commitment_bytes: vector<u8>,
        attest_public_key: vector<u8>,
        recipients: vector<address>,
        encrypted_payloads: vector<vector<u8>>,
        payment: Coin<SUI>,
        ctx: &mut TxContext
    ) {
        submit_commitment(session, clock, commitment_bytes, attest_public_key, payment, ctx);

        let len = recipients.length();
        assert!(len == encrypted_payloads.length(), E_PAYLOAD_MISMATCH);
        let mut i = 0;
        while (i < len) {
            let recipient = recipients[i];
            let payload = encrypted_payloads[i];
            deposit_mailbox_share(session, clock, recipient, payload, ctx);
            i = i + 1;
        };
    }

    /// 6. 成员随时上线后验证分片并提交确认 (只要确认数达到 threshold 即可激活!)
    public fun confirm_participant(
        session: &mut DkgSession,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        assert!(session.status == STATUS_ROUND_1_COMMITMENTS || session.status == STATUS_ROUND_2_MAILBOX, E_INVALID_SESSION_STATUS);
        assert!(clock.timestamp_ms() <= session.deadline_timestamp_ms, E_SESSION_EXPIRED);

        let sender = ctx.sender();
        assert!(session.participants.contains(&sender), E_NOT_A_PARTICIPANT);
        assert!(!session.confirmations.contains(sender), E_ALREADY_SUBMITTED);
        // Confirming means "I checked the shares against the published
        // commitments"; a member with no commitment on file has nothing to
        // check against.
        assert!(session.commitments.contains(sender), E_COMMITMENT_MISSING);

        session.confirmations.add(sender, true);
        session.confirmations_count = session.confirmations_count + 1;

        event::emit(ParticipantConfirmedEvent {
            session_id: object::uid_to_inner(&session.id),
            participant: sender,
            confirmations_count: session.confirmations_count,
            threshold: session.threshold,
        });
    }

    /// 7b. 固化（v3）：门限成员申报的群公钥。
    ///
    /// 信任锚的替换：不再信任「调用方声称的密钥」或「对自选密钥的签名」，
    /// 而是要求 **`threshold` 个已确认参与者各自独立申报**同一个群公钥。
    ///
    /// 每个成员在自己的设备上从链上承诺重算 `Σ C_0`（`sui::ed25519` 未暴露
    /// 曲线运算，链上无法重算，只能由成员在客户端算），然后调用
    /// `attest_group_key` 把结果写入自己的动态字段。由于每个参与者只能写自
    /// 己的槽位，伪造需要控制达到门限的已确认成员地址——这与 DKG 本身的信任
    /// 假设一致，而不再是「任意路人一键劫持」。
    ///
    /// 申报门槛用 `threshold` 而非「全部参与者」：与 `confirm_participant`
    /// 的语义保持一致，且离线成员不应阻塞已达成共识的多数。
    public fun finalize_session(
        session: &mut DkgSession,
        group_public_key: vector<u8>,
        _ctx: &mut TxContext
    ) {
        assert!(session.status == STATUS_ROUND_2_MAILBOX, E_INVALID_SESSION_STATUS);
        assert!(session.confirmations_count >= session.threshold, E_QUORUM_NOT_REACHED);
        assert!(vector::length(&group_public_key) == 32, E_INVALID_PUBLIC_KEY_LENGTH);
        assert_not_small_order_pk(&group_public_key);

        // Count confirmed participants who attested to *this* key. An attestation
        // for a different key is not counted, so a minority cannot smuggle in a
        // key by out-voting the honest quorum's silence.
        let attested = attestation_count_for(session, group_public_key);
        assert!(attested >= session.threshold, E_KEY_NOT_ATTESTED);

        session.final_public_key = group_public_key;
        session.status = STATUS_FINALIZED;
        event::emit(SessionFinalizedEvent {
            session_id: object::uid_to_inner(&session.id),
            epoch: session.epoch,
            group_pk: group_public_key,
            confirmations_count: session.confirmations_count,
        });
    }

    /// 7c. 确认成员申报群公钥。
    ///
    /// 必须在 `confirm_participant` 之后调用：只确认了份额、还没算出群公钥的
    /// 成员无法为任何密钥背书。同一成员可重复调用以修改申报（链上承诺在
    /// Round 2 冻结，正常情况下不会变；允许覆盖是为了让误算的成员能纠正）。
    public fun attest_group_key(
        session: &mut DkgSession,
        clock: &Clock,
        group_public_key: vector<u8>,
        attestation_signature: vector<u8>,
        ctx: &mut TxContext
    ) {
        // Round 1 is still collecting commitments: the key they add up to is
        // not fixed yet, so attesting to any value is premature.
        assert!(session.status == STATUS_ROUND_2_MAILBOX, E_INVALID_SESSION_STATUS);
        assert!(clock.timestamp_ms() <= session.deadline_timestamp_ms, E_SESSION_EXPIRED);
        assert!(group_public_key.length() == 32, E_INVALID_PUBLIC_KEY_LENGTH);
        // P1-1（rt-lit-ed25519-verify）：identity/小阶公钥被 ed25519_verify 接受，链上拉黑
        assert_not_small_order_pk(&group_public_key);

        let sender = ctx.sender();
        assert!(session.participants.contains(&sender), E_NOT_A_PARTICIPANT);
        // Only a member who has actually opened and verified the shares can know
        // the key, so the attestation is anchored to that fact.
        assert!(session.confirmations.contains(sender), E_NOT_CONFIRMED);

        // 绑定验签：签名必须由该参与者在 Round 1 公布的公钥作出，
        // 摘要绑定 (session_id, group_pk)，杜绝移植/跨会话重放/代签。
        let key_slot = AttestationKeySlot { participant: sender };
        assert!(dynamic_field::exists(&session.id, key_slot), E_ATTEST_KEY_MISSING);
        let attest_pk = *dynamic_field::borrow(&session.id, key_slot);
        assert!(attestation_signature.length() == 64, E_ATTEST_SIGNATURE_INVALID);
        let mut digest = vector[];
        vector::append(&mut digest, DOMAIN_ATTESTATION);
        let sid = object::uid_to_inner(&session.id);
        vector::append(&mut digest, bcs::to_bytes(&sid));
        vector::append(&mut digest, group_public_key);
        assert!(
            ed25519::ed25519_verify(&attestation_signature, &attest_pk, &sha2_256(digest)),
            E_ATTEST_SIGNATURE_INVALID,
        );

        let slot = GroupKeyAttestationSlot { participant: sender };
        if (dynamic_field::exists(&session.id, slot)) {
            *dynamic_field::borrow_mut(&mut session.id, slot) = group_public_key;
        } else {
            dynamic_field::add(&mut session.id, slot, group_public_key);
        };

        event::emit(GroupKeyAttestedEvent {
            session_id: object::uid_to_inner(&session.id),
            participant: sender,
            group_pk: group_public_key,
        });
    }

    /// Counts confirmed participants whose current attestation is `group_pk`.
    /// Bounded by the participant list, which `create_dkg_session` fixes.
    fun attestation_count_for(session: &DkgSession, group_pk: vector<u8>): u64 {
        let mut count = 0;
        let n = session.participants.length();
        let mut i = 0;
        while (i < n) {
            let participant = session.participants[i];
            if (session.confirmations.contains(participant)) {
                let slot = GroupKeyAttestationSlot { participant };
                if (dynamic_field::exists(&session.id, slot)) {
                    if (*dynamic_field::borrow(&session.id, slot) == group_pk) {
                        count = count + 1;
                    };
                };
            };
            i = i + 1;
        };
        count
    }

    /// 单测专用：跳过签名验签的申报入口（保留状态/成员/确认门禁）。
    /// 生产入口 attest_group_key 强制公布公钥下的链上验签。
    #[test_only]
    public fun attest_group_key_for_testing(
        session: &mut DkgSession,
        clock: &Clock,
        group_public_key: vector<u8>,
        ctx: &mut TxContext
    ) {
        assert!(session.status == STATUS_ROUND_2_MAILBOX, E_INVALID_SESSION_STATUS);
        assert!(clock.timestamp_ms() <= session.deadline_timestamp_ms, E_SESSION_EXPIRED);
        assert!(group_public_key.length() == 32, E_INVALID_PUBLIC_KEY_LENGTH);
        // P1-1（rt-lit-ed25519-verify）：identity/小阶公钥被 ed25519_verify 接受，链上拉黑
        assert_not_small_order_pk(&group_public_key);
        let sender = ctx.sender();
        assert!(session.participants.contains(&sender), E_NOT_A_PARTICIPANT);
        assert!(session.confirmations.contains(sender), E_NOT_CONFIRMED);
        let slot = GroupKeyAttestationSlot { participant: sender };
        if (dynamic_field::exists(&session.id, slot)) {
            *dynamic_field::borrow_mut(&mut session.id, slot) = group_public_key;
        } else {
            dynamic_field::add(&mut session.id, slot, group_public_key);
        };
        event::emit(GroupKeyAttestedEvent {
            session_id: object::uid_to_inner(&session.id),
            participant: sender,
            group_pk: group_public_key,
        });
    }

    /// 公开只读：有多少已确认成员申报了 `group_pk`。
    public fun attestations_for(session: &DkgSession, group_pk: vector<u8>): u64 {
        attestation_count_for(session, group_pk)
    }

    /// 公开只读：借取某成员当前申报的群公钥（动态字段槽位必须存在）。
    /// 「尚未申报」不是空向量 —— 槽位缺失时本访问器直接 abort；存在性判断
    /// 请用 `attested_key_matches`（exists && equal），计数用 `attestations_for`。
    /// 申报值恒为 32 字节（attest 门禁强制），空向量在该槽位里不可能出现。
    public fun attested_key_of(session: &DkgSession, participant: address): &vector<u8> {
        let slot = GroupKeyAttestationSlot { participant };
        dynamic_field::borrow(&session.id, slot)
    }

    /// 公开只读：该参与者的申报存在且等于 `final_pk`。组织侧过滤用：
    /// key_signers 名单 = 已确认 且 本谓词为真的参与者；未申报即 false。
    public fun attested_key_matches(session: &DkgSession, participant: address, final_pk: &vector<u8>): bool {
        let slot = GroupKeyAttestationSlot { participant };
        if (dynamic_field::exists(&session.id, slot)) {
            let attested: &vector<u8> = dynamic_field::borrow(&session.id, slot);
            attested == final_pk
        } else {
            false
        }
    }

    /// 一次性组织创建门（只读断言）：本会话尚未兑换过 Organization。
    /// `create_organization_from_session` 的第一道门；每个固化会话至多
    /// 产生一个组织对象，重复兑换以 E_ORG_ALREADY_CREATED(3026) 拒绝。
    public fun assert_org_not_created(session: &DkgSession) {
        assert!(
            !dynamic_field::exists(&session.id, OrgCreatedSlot { dummy: true }),
            E_ORG_ALREADY_CREATED,
        );
    }

    /// 一次性组织创建门（写入）：组织对象创建成功后（share 之前）写入
    /// org_id 标记。调用方必须先通过 `assert_org_not_created`；本函数对
    /// 重复标记直接 abort（dynamic_field::add 拒绝已存在的键），宁可响
    /// 也不静默覆盖。
    public fun mark_org_created(session: &mut DkgSession, org_id: ID) {
        dynamic_field::add(&mut session.id, OrgCreatedSlot { dummy: true }, org_id);
    }

    /// 仅供 Move 单测使用：替已确认成员写下申报，再走**同一个**
    /// `finalize_session` 门禁。
    ///
    /// `attest_group_key` 取 `tx_context::sender`，测试里无法让多个地址在同一个
    /// 交易中轮流调用，因此这里直接写动态字段。它不跳过任何检查——申报门槛仍
    /// 由 `finalize_session` 校验，测试覆盖的就是生产路径。
    #[test_only]
    public fun finalize_session_for_testing(
        session: &mut DkgSession,
        group_public_key: vector<u8>,
        _ctx: &mut TxContext
    ) {
        let n = session.participants.length();
        let mut i = 0;
        let mut attested = 0;
        while (i < n && attested < session.threshold) {
            let participant = session.participants[i];
            if (session.confirmations.contains(participant)) {
                let slot = GroupKeyAttestationSlot { participant };
                if (dynamic_field::exists(&session.id, slot)) {
                    *dynamic_field::borrow_mut(&mut session.id, slot) = group_public_key;
                } else {
                    dynamic_field::add(&mut session.id, slot, group_public_key);
                };
                attested = attested + 1;
            };
            i = i + 1;
        };

        finalize_session(session, group_public_key, _ctx);
    }

    /// 仅供 Move 单测使用：让一名**已确认**成员的申报与固化密钥脱钩
    /// （attested_key_matches 变 false），构造「确认但未申报（同一密钥）」
    /// 的参与者 —— `create_organization_from_session` 的 key_signers 过滤
    /// 与 E_KEY_SIGNER_SHORTFALL 门禁正是针对这种漂移。生产上这只可能
    /// 来自误算后不再修正的成员；测试用同一个 finalize 门禁固化，随后
    /// 人为制造漂移。
    #[test_only]
    public fun unattest_for_testing(session: &mut DkgSession, participant: address) {
        let slot = GroupKeyAttestationSlot { participant };
        if (dynamic_field::exists(&session.id, slot)) {
            dynamic_field::remove<GroupKeyAttestationSlot, vector<u8>>(&mut session.id, slot);
        };
    }

    /// 8. 超时处理：若超过截止时间仍未达到法定门限，标记会话超时
    public fun handle_session_timeout(
        session: &mut DkgSession,
        clock: &Clock
    ) {
        assert!(session.status != STATUS_FINALIZED, E_INVALID_SESSION_STATUS);
        assert!(clock.timestamp_ms() > session.deadline_timestamp_ms, E_SESSION_NOT_EXPIRED);
        // #20: quorum-reached sessions may time out when no key was
        // attested. Since final_public_key is only written by finalize_session
        // (FINALIZED is already excluded above), it is still empty here, so
        // attestation_count_for returns 0 — a non-finalized session past its
        // deadline can therefore always be retired. Spec formula:
        // quorum short OR (Round 2 AND attestations of final_public_key
        // below threshold); every attestation is exactly 32 bytes, so none
        // can ever match an empty vector.
        let final_pk = session.final_public_key;
        let attested = attestation_count_for(session, final_pk);
        assert!(
            session.confirmations_count < session.threshold
                || (session.status == STATUS_ROUND_2_MAILBOX && attested < session.threshold),
            E_QUORUM_NOT_REACHED,
        );

        session.status = STATUS_TIMED_OUT;

        event::emit(SessionTimedOutEvent {
            session_id: object::uid_to_inner(&session.id),
            confirmations_count: session.confirmations_count,
            threshold: session.threshold,
        });
    }

    /// 8b. 参与保证金取回（Pull 模型退款）。
    ///
    /// 会话进入终态（FINALIZED / TIMED_OUT）后，参与者本人随时可全额取回
    /// 自己托管的保证金 —— 两种终态一视同仁，纯退款、无罚没：超时退出不
    /// 没收押金，"押金收割"无从谈起。资金在取回前一直托管在会话上。
    /// 创世质押（超额缴款）不属于本退款，它随组织固化扫入 Organization
    /// 并受 90 天硬锁约束。
    public fun claim_bond(session: &mut DkgSession, ctx: &mut TxContext) {
        let sender = ctx.sender();
        assert!(session.participants.contains(&sender), E_NOT_A_PARTICIPANT);

        let slot = ParticipantBondSlot { participant: sender };
        assert!(
            dynamic_field::exists(&mut session.id, slot),
            E_NO_BOND_TO_CLAIM,
        );
        assert!(
            session.status == STATUS_FINALIZED || session.status == STATUS_TIMED_OUT,
            E_SESSION_NOT_TERMINAL,
        );

        let bond: Balance<SUI> = dynamic_field::remove(&mut session.id, slot);
        let amount_mist = balance::value(&bond);
        let refund = coin::from_balance(bond, ctx);
        transfer::public_transfer(refund, sender);

        event::emit(BondClaimedEvent {
            session_id: object::uid_to_inner(&session.id),
            participant: sender,
            amount_mist,
        });
    }

    /// 8c. 创世质押扫入（仅供本包 Organization 的固化路径调用）。
    ///
    /// 一次性抽干全部 ParticipantStakeSlot，返回 (总余额, 有效质押人数)。
    /// 保证金槽位不在扫入范围 —— 它们由 claim_bond 逐人退款。
    /// 空扫安全：无人超额缴款时返回 (零余额, 0)，零值槽位会被清理且不计数。
    /// 可见性 public(package)：返回的 Balance 可被调用方自由处分，绝不能
    /// 让包外任意地址直接调用拿走别人的质押。
    public(package) fun take_genesis_stakes(session: &mut DkgSession): (Balance<SUI>, u64) {
        assert!(session.status == STATUS_FINALIZED, E_INVALID_SESSION_STATUS);

        let mut total = balance::zero<SUI>();
        let mut stakers = 0;
        let n = session.participants.length();
        let mut i = 0;
        while (i < n) {
            let participant = session.participants[i];
            let slot = ParticipantStakeSlot { participant };
            if (dynamic_field::exists(&mut session.id, slot)) {
                let stake: Balance<SUI> = dynamic_field::remove(&mut session.id, slot);
                if (balance::value(&stake) > 0) {
                    stakers = stakers + 1;
                };
                total.join(stake);
            };
            i = i + 1;
        };

        event::emit(GenesisStakeSweptEvent {
            session_id: object::uid_to_inner(&session.id),
            total_mist: total.value(),
            stakers,
        });
        (total, stakers)
    }

    // --- 只读查询方法 ---

    // --- 准入经济学只读 ---

    /// 保证金上下界：(MIN_BOND_MIST, MAX_BOND_MIST)。
    public fun bond_bounds(): (u64, u64) {
        (MIN_BOND_MIST, MAX_BOND_MIST)
    }

    /// 会话创建费（MIST）：全额转 @0x0 销毁的防垃圾定价。
    public fun creation_fee_mist(): u64 {
        SESSION_CREATION_FEE_MIST
    }

    /// 截止时长夹取范围：(MIN_SESSION_DURATION_MS, MAX_SESSION_DURATION_MS)。
    public fun session_duration_bounds_ms(): (u64, u64) {
        (MIN_SESSION_DURATION_MS, MAX_SESSION_DURATION_MS)
    }

    /// 本会话每人应缴的保证金（MIST）；未配置（如 resharing 会话）读作 0。
    public fun session_bond_mist(session: &DkgSession): u64 {
        let slot = BondConfigSlot { dummy: true };
        if (dynamic_field::exists(&session.id, slot)) {
            *dynamic_field::borrow(&session.id, slot)
        } else {
            0
        }
    }

    /// 参与者已托管的保证金（MIST）；未提交过承诺或已 claim 读作 0。
    public fun participant_bond_mist(session: &DkgSession, participant: address): u64 {
        let slot = ParticipantBondSlot { participant };
        if (dynamic_field::exists(&session.id, slot)) {
            let bond: &Balance<SUI> = dynamic_field::borrow(&session.id, slot);
            balance::value(bond)
        } else {
            0
        }
    }

    /// 参与者已托管的创世质押（MIST）；未超额缴款或已被扫入读作 0。
    public fun participant_stake_mist(session: &DkgSession, participant: address): u64 {
        let slot = ParticipantStakeSlot { participant };
        if (dynamic_field::exists(&session.id, slot)) {
            let stake: &Balance<SUI> = dynamic_field::borrow(&session.id, slot);
            balance::value(stake)
        } else {
            0
        }
    }

    public fun session_id(session: &DkgSession): ID {
        object::uid_to_inner(&session.id)
    }

    public fun threshold(session: &DkgSession): u64 {
        session.threshold
    }

    public fun participants(session: &DkgSession): vector<address> {
        session.participants
    }

    public fun deadline_timestamp_ms(session: &DkgSession): u64 {
        session.deadline_timestamp_ms
    }

    public fun epoch(session: &DkgSession): u64 {
        session.epoch
    }

    public fun status(session: &DkgSession): u8 {
        session.status
    }

    public fun confirmations_count(session: &DkgSession): u64 {
        session.confirmations_count
    }

    public fun final_public_key(session: &DkgSession): vector<u8> {
        session.final_public_key
    }

    public fun is_participant_confirmed(session: &DkgSession, participant: address): bool {
        session.confirmations.contains(participant)
    }

    public fun has_mailbox_share(session: &DkgSession, sender: address, recipient: address): bool {
        let key = MailboxKey { sender, recipient };
        session.encrypted_mailboxes.contains(key)
    }

    public fun get_mailbox_share(session: &DkgSession, sender: address, recipient: address): vector<u8> {
        let key = MailboxKey { sender, recipient };
        if (session.encrypted_mailboxes.contains(key)) {
            session.encrypted_mailboxes[key]
        } else {
            vector[]
        }
    }

    /// 参与者登记的信箱加密公钥；未登记时返回空向量。
    /// 空向量必须被解读为「尚未登记」，而不是「登记了一个空密钥」。
    public fun encryption_key(session: &DkgSession, participant: address): vector<u8> {
        let slot = EncryptionKeySlot { participant };
        if (dynamic_field::exists(&session.id, slot)) {
            *dynamic_field::borrow(&session.id, slot)
        } else {
            vector[]
        }
    }

    public fun has_encryption_key(session: &DkgSession, participant: address): bool {
        dynamic_field::exists(&session.id, EncryptionKeySlot { participant })
    }

    /// Off-chain feature detection: revision 2 adds encryption-key registration.
    public fun dkg_revision(): u64 {
        DKG_REVISION
    }

    /// 双栈长度：(32, 65) —— X25519 原始公钥与 P-256 未压缩点。
    public fun encryption_key_lengths(): (u64, u64) {
        (ENCRYPTION_KEY_LENGTH_X25519, ENCRYPTION_KEY_LENGTH_P256)
    }

    /// 该长度是否为当前接受的合法信箱加密公钥形态（32 或 65 字节）。
    public fun is_valid_encryption_key_length(len: u64): bool {
        len == ENCRYPTION_KEY_LENGTH_X25519 || len == ENCRYPTION_KEY_LENGTH_P256
    }
}
