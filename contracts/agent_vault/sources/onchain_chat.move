module agent_vault::onchain_chat {
    use sui::object::{Self, UID, ID};
    use sui::tx_context::{Self, TxContext};
    use sui::transfer;
    use sui::table::{Self, Table};
    use sui::dynamic_field::{Self as field};
    use sui::clock::{Self, Clock};
    use sui::balance::{Self, Balance};
    use sui::coin::{Self, Coin};
    use sui::sui::SUI;
    use sui::event;

    // 错误码
    const E_NOT_CHANNEL_MEMBER: u64 = 6001;
    const E_CAP_EXPIRED: u64 = 6002;
    const E_CAP_REVOKED: u64 = 6003;
    const E_UNAUTHORIZED_SUBAGENT: u64 = 6004;
    const E_CHANNEL_MISMATCH: u64 = 6005;
    const E_RATE_LIMIT_EXCEEDED: u64 = 6006;
    const E_INSUFFICIENT_STAKE: u64 = 6007;
    const E_NOT_CHANNEL_CREATOR: u64 = 6008;
    const E_INSUFFICIENT_PAYMENT: u64 = 6009;
    const E_INVALID_BPS_SUM: u64 = 6010;
    const E_ALREADY_MEMBER: u64 = 6011;
    const E_NOT_RECEIPT_OWNER: u64 = 6012;
    const E_MEMBERS_STILL_STAKED: u64 = 6013;
    const E_NO_REVENUE_TO_CLAIM: u64 = 6014;
    const E_EMPTY_BATCH: u64 = 6015;
    const E_BATCH_TOO_LARGE: u64 = 6016;
    const E_BATCH_LENGTH_MISMATCH: u64 = 6017;
    const E_MESSAGE_TOO_LONG: u64 = 6018;
    const E_MEMBER_STAKE_AT_RISK: u64 = 6019;
    const E_CANNOT_REMOVE_CREATOR: u64 = 6020;

    // 单条消息 Gas 报销常量 (1,000,000 MIST = 0.001 SUI)
    const GAS_REBATE_PER_MESSAGE: u64 = 1_000_000;

    /// One batched send carries at most this many lines. Bounds the input vector,
    /// the emitted events and the instruction count of a single transaction.
    const MAX_BATCH_MESSAGES: u64 = 32;

    /// Bound on one preview so a batch cannot grow an event past the framework's
    /// per-event size limit.
    const MAX_PREVIEW_BYTES: u64 = 4096;
    const MAX_BLOB_ID_BYTES: u64 = 128;

    /// Fixed-point scale of the yield accumulator (`accrued MIST of yield per
    /// MIST of stake, times this scale`). Chosen so a 1-MIST stake over a pool
    /// of the entire SUI supply still resolves one distribution step without
    /// truncating to zero.
    const YIELD_ACC_SCALE: u128 = 1_000_000_000_000;

    /// 链上聊天频道（共享对象，管理频道成员、顺序序号、质押本金、Gas 补贴池与知识星球/OnlyFans 会员经济学）
    public struct ChatChannel has key {
        id: UID,
        org_id: address,
        name: vector<u8>,
        creator: address,
        members: Table<address, bool>,
        message_sequence: u64,
        staked_principal: Balance<SUI>,    // 创建者质押建群本金 (保本，解散时 100% 原路退还创建者)
        gas_subsidy_pool: Balance<SUI>,    // 质押利息注入的 Gas 代付池 (全自动为成员发信报销)
        total_subsidized_gas: u64,         // 累计为全员代付补贴的 Gas 总量 (MIST)
        // 知识星球 / OnlyFans / 舰长会员群扩展经济学字段
        entry_fee: u64,                    // 门票收费 (归创作者，0 为无门票)
        required_member_stake: u64,        // 进群保本质押 (退群 100% 赎回，0 为无质押要求)
        creator_yield_share_bps: u64,      // 创作者利息分润基点 (如 7000 = 70%)
        gas_subsidy_share_bps: u64,        // 聊天 Gas 代付池分润基点 (如 2000 = 20%)
        member_rebate_share_bps: u64,      // 成员利息分红返还基点 (如 1000 = 10%)
        members_staked_pool: Balance<SUI>, // 全体进群成员质押本金总池 (隔离保本)
        creator_revenue_pool: Balance<SUI>,// 创作者收益金库 (门票收入 + 利息分润)
        member_yield_pool: Balance<SUI>,   // 成员利息分红金库
        total_staked_members: u64,         // 当前质押进群的有效会员总数
    }

    /// 成员进群质押权益凭证 (类似星球会员卡 / 舰长勋章凭证)
    public struct MemberStakeReceipt has key, store {
        id: UID,
        channel_id: ID,
        member: address,
        staked_amount: u64,
    }

    /// Subagent 免密发信权能凭证 (Session Key Cap)
    /// 允许客户端/本地 Subagent 代表人类主账号在指定频道发信
    /// 解决 Web3 聊天“每次打字都要弹钱包签名”的致命 UX 缺陷！
    public struct SubagentMessagingCap has key, store {
        id: UID,
        master_owner: address,          // 人类主账号 (例如 Alice)
        agent_address: address,         // 授权的本地 Subagent 临时公钥地址
        channel_id: ID,                 // 绑定的聊天室/频道
        expires_at_ms: u64,             // 免密会话有效截止时间 (例如 7 天免密)
        rate_limit_per_minute: u64,     // 每分钟发信频次限制 (防 DoS/防刷屏)
        messages_sent_in_window: u64,   // 当前分钟窗口已发消息数
        window_start_ms: u64,           // 频控滑动窗口起点
        is_revoked: bool,               // 主账号一键注销熔断状态
    }

    // === 收益债务记账 (dynamic fields，不改已发布 ChatChannel 布局) ===

    /// NAME type of the per-channel yield accumulator. The accumulator is the
    /// total member-share yield ever distributed per unit of staked principal,
    /// scaled by `YIELD_ACC_SCALE`. It starts at zero when the first post-fix
    /// distribution runs, so yields banked before the fix stay in
    /// `member_yield_pool` and can only leave through channel close.
    public struct YieldAccumulatorKey has copy, drop, store {}

    /// NAME type of one member's yield debt snapshot: the accumulator value the
    /// member has already been credited with, recorded at join time. A member
    /// with no such field is a pre-fix member and is treated as debt zero at
    /// the accumulator's starting point.
    public struct MemberYieldKey has copy, drop, store { member: address }

    // --- 事件定义 ---
    public struct ChannelCreatedWithStakeEvent has copy, drop {
        channel_id: ID,
        org_id: address,
        name: vector<u8>,
        creator: address,
        staked_amount: u64,
    }

    public struct StakingYieldDepositedEvent has copy, drop {
        channel_id: ID,
        yield_amount: u64,
        pool_balance: u64,
    }

    public struct GasSubsidizedEvent has copy, drop {
        channel_id: ID,
        recipient: address,
        rebate_amount: u64,
        total_subsidized: u64,
    }

    public struct SubagentMessagingCapIssuedEvent has copy, drop {
        cap_id: ID,
        master_owner: address,
        agent_address: address,
        channel_id: ID,
        expires_at_ms: u64,
        rate_limit_per_minute: u64,
    }

    public struct SubagentMessagingCapRevokedEvent has copy, drop {
        cap_id: ID,
        master_owner: address,
        agent_address: address,
    }

    public struct ChatMessageEvent has copy, drop {
        channel_id: ID,
        sequence: u64,
        sender_master: address,       // 人类真实身份
        sender_agent: address,        // 实际签名的 Subagent
        walrus_blob_id: vector<u8>,   // Walrus 上的去中心化密文/多媒体存储索引
        content_preview: vector<u8>,  // 短密文或摘要预览
        timestamp_ms: u64,
    }

    public struct ChannelClosedAndRefundedEvent has copy, drop {
        channel_id: ID,
        creator: address,
        refunded_stake: u64,
        remaining_subsidy: u64,
    }

    public struct MemberJoinedWithStakeEvent has copy, drop {
        channel_id: ID,
        member: address,
        entry_fee_paid: u64,
        staked_amount: u64,
        total_members: u64,
    }

    public struct StakingYieldDistributedEvent has copy, drop {
        channel_id: ID,
        total_yield: u64,
        creator_share: u64,
        gas_subsidy_share: u64,
        member_rebate_share: u64,
    }

    public struct CreatorRevenueClaimedEvent has copy, drop {
        channel_id: ID,
        creator: address,
        claimed_amount: u64,
    }

    public struct MemberUnstakedAndLeftEvent has copy, drop {
        channel_id: ID,
        member: address,
        refunded_principal: u64,
        refunded_yield: u64,
        remaining_members: u64,
    }

    public struct ZeroStakeMemberRemovedEvent has copy, drop {
        channel_id: ID,
        creator: address,
        member: address,
        remaining_members: u64,
    }

    /// 1. 经典无质押建群 (向后兼容)
    public fun create_channel(
        org_id: address,
        name: vector<u8>,
        initial_members: vector<address>,
        ctx: &mut TxContext
    ): ID {
        create_channel_internal(org_id, name, initial_members, balance::zero<SUI>(), 0, 0, 0, 10000, 0, ctx)
    }

    /// 1b. 【质押建群 · 永动免费】质押 SUI 建立频道，享受永久利息代付 Gas！
    public fun create_channel_with_stake(
        org_id: address,
        name: vector<u8>,
        initial_members: vector<address>,
        stake_coin: Coin<SUI>,
        ctx: &mut TxContext
    ): ID {
        let staked_val = stake_coin.value();
        assert!(staked_val > 0, E_INSUFFICIENT_STAKE);
        let principal = stake_coin.into_balance();
        create_channel_internal(org_id, name, initial_members, principal, 0, 0, 0, 10000, 0, ctx)
    }

    /// 1d. 【知识星球 / OnlyFans / 舰长群】支持入群门票收费 + 进群保本质押 + 利息自动多路分润！
    public fun create_creator_monetized_channel(
        org_id: address,
        name: vector<u8>,
        creator_stake_coin: Coin<SUI>,
        entry_fee: u64,
        required_member_stake: u64,
        creator_yield_share_bps: u64,
        gas_subsidy_share_bps: u64,
        member_rebate_share_bps: u64,
        ctx: &mut TxContext
    ): ID {
        let principal = creator_stake_coin.into_balance();
        create_channel_internal(
            org_id,
            name,
            vector[],
            principal,
            entry_fee,
            required_member_stake,
            creator_yield_share_bps,
            gas_subsidy_share_bps,
            member_rebate_share_bps,
            ctx
        )
    }

    fun create_channel_internal(
        org_id: address,
        name: vector<u8>,
        initial_members: vector<address>,
        staked_principal: Balance<SUI>,
        entry_fee: u64,
        required_member_stake: u64,
        creator_yield_share_bps: u64,
        gas_subsidy_share_bps: u64,
        member_rebate_share_bps: u64,
        ctx: &mut TxContext
    ): ID {
        assert!(creator_yield_share_bps + gas_subsidy_share_bps + member_rebate_share_bps == 10000 || (creator_yield_share_bps + gas_subsidy_share_bps + member_rebate_share_bps == 0), E_INVALID_BPS_SUM);
        let uid = object::new(ctx);
        let channel_id = object::uid_to_inner(&uid);
        let creator = ctx.sender();

        let mut members = table::new<address, bool>(ctx);
        members.add(creator, true);

        let mut i = 0;
        let len = initial_members.length();
        while (i < len) {
            let member = initial_members[i];
            if (!members.contains(member)) {
                members.add(member, true);
            };
            i = i + 1;
        };

        let staked_amount = staked_principal.value();

        event::emit(ChannelCreatedWithStakeEvent {
            channel_id,
            org_id,
            name,
            creator,
            staked_amount,
        });

        let channel = ChatChannel {
            id: uid,
            org_id,
            name,
            creator,
            members,
            message_sequence: 0,
            staked_principal,
            gas_subsidy_pool: balance::zero<SUI>(),
            total_subsidized_gas: 0,
            entry_fee,
            required_member_stake,
            creator_yield_share_bps,
            gas_subsidy_share_bps,
            member_rebate_share_bps,
            members_staked_pool: balance::zero<SUI>(),
            creator_revenue_pool: balance::zero<SUI>(),
            member_yield_pool: balance::zero<SUI>(),
            total_staked_members: 0,
        };

        transfer::share_object(channel);
        channel_id
    }

    /// 1c. 注入质押利息收益：支持自动多路分润 (创作者收益 + 聊天 Gas 代付池 + 会员分红)
    public fun deposit_staking_yield(
        channel: &mut ChatChannel,
        yield_coin: Coin<SUI>
    ) {
        distribute_staking_yield(channel, yield_coin);
    }

    public fun distribute_staking_yield(
        channel: &mut ChatChannel,
        yield_coin: Coin<SUI>
    ) {
        let yield_val = yield_coin.value();
        let mut yield_bal = yield_coin.into_balance();

        if (channel.gas_subsidy_share_bps == 10000 || (channel.creator_yield_share_bps == 0 && channel.member_rebate_share_bps == 0)) {
            // 普通频道：100% 注入 Gas 代付池
            channel.gas_subsidy_pool.join(yield_bal);
            event::emit(StakingYieldDepositedEvent {
                channel_id: object::uid_to_inner(&channel.id),
                yield_amount: yield_val,
                pool_balance: channel.gas_subsidy_pool.value(),
            });
        } else {
            // 星球/会员群：按比例多路分润
            let creator_share = (yield_val * channel.creator_yield_share_bps) / 10000;
            let gas_share = (yield_val * channel.gas_subsidy_share_bps) / 10000;
            let member_share = yield_val - creator_share - gas_share;

            if (creator_share > 0) {
                let c_bal = yield_bal.split(creator_share);
                channel.creator_revenue_pool.join(c_bal);
            };

            if (gas_share > 0) {
                let g_bal = yield_bal.split(gas_share);
                channel.gas_subsidy_pool.join(g_bal);
            };

            if (member_share > 0) {
                channel.member_yield_pool.join(yield_bal);
                // Stake-weighted accrual: a channel whose members hold no
                // principal keeps the share banked in the pool (recovered by
                // the creator at close) instead of paying per-head.
                accrue_member_yield(channel, member_share);
            } else {
                yield_bal.destroy_zero();
            };

            event::emit(StakingYieldDistributedEvent {
                channel_id: object::uid_to_inner(&channel.id),
                total_yield: yield_val,
                creator_share,
                gas_subsidy_share: gas_share,
                member_rebate_share: member_share,
            });
        };
    }

    /// 内部自动化 Gas 报销辅助函数：将利息代付金额直接打回交易发送者地址！
    fun auto_subsidize_gas(channel: &mut ChatChannel, recipient: address, ctx: &mut TxContext) {
        if (channel.gas_subsidy_pool.value() >= GAS_REBATE_PER_MESSAGE) {
            let rebate_bal = channel.gas_subsidy_pool.split(GAS_REBATE_PER_MESSAGE);
            let rebate_coin = coin::from_balance(rebate_bal, ctx);
            transfer::public_transfer(rebate_coin, recipient);
            channel.total_subsidized_gas = channel.total_subsidized_gas + GAS_REBATE_PER_MESSAGE;

            event::emit(GasSubsidizedEvent {
                channel_id: object::uid_to_inner(&channel.id),
                recipient,
                rebate_amount: GAS_REBATE_PER_MESSAGE,
                total_subsidized: channel.total_subsidized_gas,
            });
        };
    }

    // === 收益债务记账：质押加权的分红，而非人头均分 ===

    fun yield_accrued_per_stake(channel: &ChatChannel): u128 {
        if (field::exists<YieldAccumulatorKey>(&channel.id, YieldAccumulatorKey {})) {
            *field::borrow<YieldAccumulatorKey, u128>(&channel.id, YieldAccumulatorKey {})
        } else {
            0
        }
    }

    /// Fold one distribution's member share into the per-stake accumulator. The
    /// weight is the live principal pool, so a member who joins after this call
    /// records the new accumulator as debt and cannot claim any of it — an
    /// equal-split free ride on a banked pool is no longer possible.
    fun accrue_member_yield(channel: &mut ChatChannel, member_share: u64) {
        let weight = channel.members_staked_pool.value();
        if (member_share == 0 || weight == 0) return;
        let next = yield_accrued_per_stake(channel)
            + ((member_share as u128) * YIELD_ACC_SCALE) / (weight as u128);
        if (field::exists<YieldAccumulatorKey>(&channel.id, YieldAccumulatorKey {})) {
            *field::borrow_mut<YieldAccumulatorKey, u128>(&mut channel.id, YieldAccumulatorKey {}) = next;
        } else {
            field::add(&mut channel.id, YieldAccumulatorKey {}, next);
        };
    }

    /// Snapshot the debt of a freshly joined member: everything the accumulator
    /// already contains is credited, so only future distributions accrue.
    fun record_member_yield_debt(channel: &mut ChatChannel, member: address, staked_amount: u64) {
        let debt = (yield_accrued_per_stake(channel) * (staked_amount as u128)) / YIELD_ACC_SCALE;
        field::add(&mut channel.id, MemberYieldKey { member }, debt);
    }

    /// Consume the member's debt record and return the yield owed at current
    /// accumulator, bounded by the pool so rounding dust can never mint value.
    /// The debt field is removed even at zero payout so a later rejoin starts
    /// from a fresh snapshot.
    fun take_member_yield(channel: &mut ChatChannel, member: address, staked_amount: u64): u64 {
        let gross = (yield_accrued_per_stake(channel) * (staked_amount as u128)) / YIELD_ACC_SCALE;
        let debt = if (field::exists<MemberYieldKey>(&channel.id, MemberYieldKey { member })) {
            field::remove<MemberYieldKey, u128>(&mut channel.id, MemberYieldKey { member })
        } else {
            0
        };
        let pending = if (gross >= debt) { gross - debt } else { 0 };
        let pool = (channel.member_yield_pool.value() as u128);
        if (pending > pool) {
            (pool as u64)
        } else {
            (pending as u64)
        }
    }

    /// 2. 主账号签发并直接共享 Subagent 发信 Cap (shared 对象，双端随时可调)
    public fun create_shared_subagent_messaging_cap(
        channel: &ChatChannel,
        agent_address: address,
        expires_at_ms: u64,
        rate_limit_per_minute: u64,
        ctx: &mut TxContext
    ): ID {
        let master_owner = ctx.sender();
        assert!(channel.members.contains(master_owner), E_NOT_CHANNEL_MEMBER);

        let uid = object::new(ctx);
        let cap_id = object::uid_to_inner(&uid);
        let channel_id = object::uid_to_inner(&channel.id);

        event::emit(SubagentMessagingCapIssuedEvent {
            cap_id,
            master_owner,
            agent_address,
            channel_id,
            expires_at_ms,
            rate_limit_per_minute,
        });

        let cap = SubagentMessagingCap {
            id: uid,
            master_owner,
            agent_address,
            channel_id,
            expires_at_ms,
            rate_limit_per_minute,
            messages_sent_in_window: 0,
            window_start_ms: 0,
            is_revoked: false,
        };
        transfer::share_object(cap);
        cap_id
    }

    /// 3. 主账号一键注销 Subagent 发信资格 (Kill-Switch)
    public fun revoke_subagent_messaging_cap(
        cap: &mut SubagentMessagingCap,
        ctx: &mut TxContext
    ) {
        assert!(ctx.sender() == cap.master_owner, E_UNAUTHORIZED_SUBAGENT);
        cap.is_revoked = true;

        event::emit(SubagentMessagingCapRevokedEvent {
            cap_id: object::uid_to_inner(&cap.id),
            master_owner: cap.master_owner,
            agent_address: cap.agent_address,
        });
    }

    /// 4. 主账号自身亲自发信（带自动化 Gas 报销）
    public fun post_message(
        channel: &mut ChatChannel,
        clock: &Clock,
        walrus_blob_id: vector<u8>,
        content_preview: vector<u8>,
        ctx: &mut TxContext
    ) {
        let sender = ctx.sender();
        assert!(channel.members.contains(sender), E_NOT_CHANNEL_MEMBER);

        channel.message_sequence = channel.message_sequence + 1;
        let channel_id = object::uid_to_inner(&channel.id);

        event::emit(ChatMessageEvent {
            channel_id,
            sequence: channel.message_sequence,
            sender_master: sender,
            sender_agent: sender,
            walrus_blob_id,
            content_preview,
            timestamp_ms: clock.timestamp_ms(),
        });

        // 自动从质押生息池为用户全额返还 Gas！
        auto_subsidize_gas(channel, sender, ctx);
    }

    /// 5. Subagent 免密自主发信（带自动化 Gas 报销，净花费 0 SUI）
    public fun post_message_by_subagent(
        channel: &mut ChatChannel,
        cap: &mut SubagentMessagingCap,
        clock: &Clock,
        walrus_blob_id: vector<u8>,
        content_preview: vector<u8>,
        ctx: &mut TxContext
    ) {
        let sender = ctx.sender();
        let now = clock.timestamp_ms();
        let channel_id = object::uid_to_inner(&channel.id);

        // 强校验 1: 发送者必须是绑定的 Subagent
        assert!(sender == cap.agent_address, E_UNAUTHORIZED_SUBAGENT);

        // 强校验 2: 频道匹配
        assert!(channel_id == cap.channel_id, E_CHANNEL_MISMATCH);

        // 强校验 3: Cap 未注销且未过期
        assert!(!cap.is_revoked, E_CAP_REVOKED);
        assert!(now <= cap.expires_at_ms, E_CAP_EXPIRED);

        // 强校验 4: 主账号必须仍在频道成员列表中
        assert!(channel.members.contains(cap.master_owner), E_NOT_CHANNEL_MEMBER);

        // 强校验 5: 频控速率限制 (60秒滑动窗口)
        // #20: 复位分支同样受限 — rate_limit 0 的 Cap 连第一条消息都发不出，
        // 否则刷屏者只需等待窗口翻转即可每分钟白嫖一条。
        if (now >= cap.window_start_ms + 60_000) {
            cap.window_start_ms = now;
            cap.messages_sent_in_window = 1;
            assert!(cap.messages_sent_in_window <= cap.rate_limit_per_minute, E_RATE_LIMIT_EXCEEDED);
        } else {
            cap.messages_sent_in_window = cap.messages_sent_in_window + 1;
            assert!(cap.messages_sent_in_window <= cap.rate_limit_per_minute, E_RATE_LIMIT_EXCEEDED);
        };

        channel.message_sequence = channel.message_sequence + 1;

        event::emit(ChatMessageEvent {
            channel_id,
            sequence: channel.message_sequence,
            sender_master: cap.master_owner,
            sender_agent: sender,
            walrus_blob_id,
            content_preview,
            timestamp_ms: now,
        });

        // 自动从质押生息池为 Subagent 报销 Gas 代付！
        auto_subsidize_gas(channel, sender, ctx);
    }

    /// 5b. 主账号一次交易批量发信（单次 Gas 报销，而不是每条消息各转一次）
    ///
    /// `content_previews[i]` 与 `walrus_blob_ids[i]` 一一对应。每条仍然依次占用
    /// 一个 `message_sequence` 并发出独立事件，所以读取端、排序与既有 ABI 完全不变；
    /// 区别只在交易层：一次签名、一次证明、一次共享对象变更，并且整批只做一次
    /// 0.001 SUI 报销转账。批量上限 32 条，空批次、长度不一致或单条超长都直接拒绝。
    public fun post_message_batch(
        channel: &mut ChatChannel,
        clock: &Clock,
        mut content_previews: vector<vector<u8>>,
        mut walrus_blob_ids: vector<vector<u8>>,
        ctx: &mut TxContext
    ) {
        let sender = ctx.sender();
        assert!(channel.members.contains(sender), E_NOT_CHANNEL_MEMBER);

        let count = content_previews.length();
        assert!(count > 0, E_EMPTY_BATCH);
        assert!(count <= MAX_BATCH_MESSAGES, E_BATCH_TOO_LARGE);
        assert!(walrus_blob_ids.length() == count, E_BATCH_LENGTH_MISMATCH);

        let channel_id = object::uid_to_inner(&channel.id);
        let now = clock.timestamp_ms();

        // Validate the whole batch before mutating so a bad line cannot leave the
        // sequence advanced by a prefix of the batch.
        let mut index = 0;
        while (index < count) {
            assert!(content_previews[index].length() <= MAX_PREVIEW_BYTES, E_MESSAGE_TOO_LONG);
            assert!(walrus_blob_ids[index].length() <= MAX_BLOB_ID_BYTES, E_MESSAGE_TOO_LONG);
            index = index + 1;
        };

        // pop_back consumes each entry, and reversing first restores the caller's
        // order, so sequences follow the order the room typed them.
        content_previews.reverse();
        walrus_blob_ids.reverse();
        while (content_previews.length() > 0) {
            let content_preview = content_previews.pop_back();
            let walrus_blob_id = walrus_blob_ids.pop_back();

            channel.message_sequence = channel.message_sequence + 1;
            event::emit(ChatMessageEvent {
                channel_id,
                sequence: channel.message_sequence,
                sender_master: sender,
                sender_agent: sender,
                walrus_blob_id,
                content_preview,
                timestamp_ms: now,
            });
        };

        // One rebate for the whole burst: the transfer is fixed overhead, not a
        // per-line cost, so charging it once is what makes a burst cheaper.
        auto_subsidize_gas(channel, sender, ctx);
    }

    /// 6. 解散解质押：100% 原路退还质押本金 + 创作者收益金库 + 剩余补贴资金给创建者！
    public fun unstake_and_close_channel(
        channel: ChatChannel,
        ctx: &mut TxContext
    ) {
        let sender = ctx.sender();
        assert!(sender == channel.creator, E_NOT_CHANNEL_CREATOR);
        // 关键安全防盗：群主解散群前，普通成员必须已完成退款，创作者不能卷走成员本金！
        assert!(channel.total_staked_members == 0, E_MEMBERS_STILL_STAKED);

        let ChatChannel {
            id,
            org_id: _,
            name: _,
            creator,
            members,
            message_sequence: _,
            mut staked_principal,
            gas_subsidy_pool,
            total_subsidized_gas: _,
            entry_fee: _,
            required_member_stake: _,
            creator_yield_share_bps: _,
            gas_subsidy_share_bps: _,
            member_rebate_share_bps: _,
            members_staked_pool,
            creator_revenue_pool,
            member_yield_pool,
            total_staked_members: _,
        } = channel;

        let channel_id = object::uid_to_inner(&id);
        members.drop();
        id.delete();

        let refunded_stake = staked_principal.value();
        let remaining_subsidy = gas_subsidy_pool.value();

        // 合并所有属于创建者的资金：本金 + 剩余代付池 + 创作者收益金库 + 剩余未分配资金
        staked_principal.join(gas_subsidy_pool);
        staked_principal.join(creator_revenue_pool);
        staked_principal.join(members_staked_pool);
        staked_principal.join(member_yield_pool);

        let total_refund = staked_principal.value();

        if (total_refund > 0) {
            let refund_coin = coin::from_balance(staked_principal, ctx);
            transfer::public_transfer(refund_coin, creator);
        } else {
            staked_principal.destroy_zero();
        };

        event::emit(ChannelClosedAndRefundedEvent {
            channel_id,
            creator,
            refunded_stake,
            remaining_subsidy,
        });
    }

    /// 7. 成员进群：支付入群门票 (Entry Fee，归创作者) + 缴纳进群保本质押 (退群 100% 赎回)
    public fun join_channel_with_stake_and_fee(
        channel: &mut ChatChannel,
        payment_coin: &mut Coin<SUI>,
        ctx: &mut TxContext
    ): MemberStakeReceipt {
        let member = ctx.sender();
        assert!(!channel.members.contains(member), E_ALREADY_MEMBER);

        let total_required = channel.entry_fee + channel.required_member_stake;
        let payment_val = payment_coin.value();
        assert!(payment_val >= total_required, E_INSUFFICIENT_PAYMENT);

        // 1. 门票收入归创作者收益金库
        if (channel.entry_fee > 0) {
            let fee_coin = payment_coin.split(channel.entry_fee, ctx);
            channel.creator_revenue_pool.join(fee_coin.into_balance());
        };

        // 2. 质押金入全体成员质押池 (保本隔离)
        if (channel.required_member_stake > 0) {
            let stake_coin = payment_coin.split(channel.required_member_stake, ctx);
            channel.members_staked_pool.join(stake_coin.into_balance());
        };

        // 3. 登记入群
        channel.members.add(member, true);
        channel.total_staked_members = channel.total_staked_members + 1;
        // Yield debt snapshot at the current accumulator: only distributions
        // after this join accrue to this member. The field also marks the
        // member as one who entered through the paid join path.
        let staked_at_join = channel.required_member_stake;
        record_member_yield_debt(channel, member, staked_at_join);

        let uid = object::new(ctx);
        let receipt = MemberStakeReceipt {
            id: uid,
            channel_id: object::uid_to_inner(&channel.id),
            member,
            staked_amount: channel.required_member_stake,
        };

        event::emit(MemberJoinedWithStakeEvent {
            channel_id: object::uid_to_inner(&channel.id),
            member,
            entry_fee_paid: channel.entry_fee,
            staked_amount: channel.required_member_stake,
            total_members: channel.total_staked_members,
        });

        receipt
    }

    entry fun join_channel_entry(
        channel: &mut ChatChannel,
        payment_coin: &mut Coin<SUI>,
        ctx: &mut TxContext
    ) {
        let receipt = join_channel_with_stake_and_fee(channel, payment_coin, ctx);
        transfer::public_transfer(receipt, ctx.sender());
    }

    /// 8. 创作者随时提现群收益 (门票收入 + 70% 生息分润)
    public fun claim_creator_revenue(
        channel: &mut ChatChannel,
        ctx: &mut TxContext
    ): Coin<SUI> {
        let sender = ctx.sender();
        assert!(sender == channel.creator, E_NOT_CHANNEL_CREATOR);

        let revenue_val = channel.creator_revenue_pool.value();
        assert!(revenue_val > 0, E_NO_REVENUE_TO_CLAIM);

        let revenue_bal = channel.creator_revenue_pool.split(revenue_val);
        let claim_coin = coin::from_balance(revenue_bal, ctx);

        event::emit(CreatorRevenueClaimedEvent {
            channel_id: object::uid_to_inner(&channel.id),
            creator: sender,
            claimed_amount: revenue_val,
        });

        claim_coin
    }

    entry fun claim_creator_revenue_entry(
        channel: &mut ChatChannel,
        ctx: &mut TxContext
    ) {
        let claim_coin = claim_creator_revenue(channel, ctx);
        transfer::public_transfer(claim_coin, ctx.sender());
    }

    /// 9. 成员退群：交还凭证，100% 赎回质押本金 + 按质押加权的利息分红
    /// (分红只累计入群之后的分配，快进快出无法染指存量分红池)
    public fun member_unstake_and_leave(
        channel: &mut ChatChannel,
        receipt: MemberStakeReceipt,
        ctx: &mut TxContext
    ): Coin<SUI> {
        let sender = ctx.sender();
        assert!(sender == receipt.member, E_NOT_RECEIPT_OWNER);
        assert!(receipt.channel_id == object::uid_to_inner(&channel.id), E_CHANNEL_MISMATCH);
        assert!(channel.members.contains(sender), E_NOT_CHANNEL_MEMBER);

        let MemberStakeReceipt { id, channel_id, member: _, staked_amount } = receipt;
        id.delete();

        channel.members.remove(sender);

        let mut refund_bal = if (staked_amount > 0) {
            channel.members_staked_pool.split(staked_amount)
        } else {
            balance::zero<SUI>()
        };

        let yield_share = take_member_yield(channel, sender, staked_amount);
        if (yield_share > 0) {
            refund_bal.join(channel.member_yield_pool.split(yield_share));
        };

        channel.total_staked_members = channel.total_staked_members - 1;

        let refund_coin = coin::from_balance(refund_bal, ctx);

        event::emit(MemberUnstakedAndLeftEvent {
            channel_id,
            member: sender,
            refunded_principal: staked_amount,
            refunded_yield: yield_share,
            remaining_members: channel.total_staked_members,
        });

        refund_coin
    }

    entry fun member_unstake_and_leave_entry(
        channel: &mut ChatChannel,
        receipt: MemberStakeReceipt,
        ctx: &mut TxContext
    ) {
        let refund_coin = member_unstake_and_leave(channel, receipt, ctx);
        transfer::public_transfer(refund_coin, ctx.sender());
    }

    /// 9b. 创作者移除零质押成员：无质押频道里丢凭证/失联的成员不再永久
    /// 堵死解散路径。只能移除经付费入群且当前无质押在池的成员；被移除
    /// 成员手中的旧凭证从此指向非成员地址，自然失效 (凭证内无任何资产)。
    public fun remove_zero_stake_member(
        channel: &mut ChatChannel,
        member: address,
        ctx: &TxContext
    ) {
        let sender = ctx.sender();
        assert!(sender == channel.creator, E_NOT_CHANNEL_CREATOR);
        assert!(channel.required_member_stake == 0, E_MEMBER_STAKE_AT_RISK);
        assert!(member != channel.creator, E_CANNOT_REMOVE_CREATOR);
        assert!(channel.members.contains(member), E_NOT_CHANNEL_MEMBER);
        // Only a member who joined through the paid path is counted in
        // total_staked_members; an initial member was never counted and must
        // not underflow the counter.
        assert!(
            field::exists<MemberYieldKey>(&channel.id, MemberYieldKey { member }),
            E_NOT_RECEIPT_OWNER
        );

        channel.members.remove(member);
        let _ = field::remove<MemberYieldKey, u128>(&mut channel.id, MemberYieldKey { member });
        channel.total_staked_members = channel.total_staked_members - 1;

        event::emit(ZeroStakeMemberRemovedEvent {
            channel_id: object::uid_to_inner(&channel.id),
            creator: sender,
            member,
            remaining_members: channel.total_staked_members,
        });
    }

    // --- 查询与视图方法 ---
    public fun message_sequence(channel: &ChatChannel): u64 {
        channel.message_sequence
    }

    public fun is_member(channel: &ChatChannel, member: address): bool {
        channel.members.contains(member)
    }

    public fun staked_principal(channel: &ChatChannel): u64 {
        channel.staked_principal.value()
    }

    public fun gas_subsidy_pool(channel: &ChatChannel): u64 {
        channel.gas_subsidy_pool.value()
    }

    public fun total_subsidized_gas(channel: &ChatChannel): u64 {
        channel.total_subsidized_gas
    }

    public fun entry_fee(channel: &ChatChannel): u64 {
        channel.entry_fee
    }

    public fun required_member_stake(channel: &ChatChannel): u64 {
        channel.required_member_stake
    }

    public fun creator_yield_share_bps(channel: &ChatChannel): u64 {
        channel.creator_yield_share_bps
    }

    public fun gas_subsidy_share_bps(channel: &ChatChannel): u64 {
        channel.gas_subsidy_share_bps
    }

    public fun member_rebate_share_bps(channel: &ChatChannel): u64 {
        channel.member_rebate_share_bps
    }

    public fun creator_revenue_pool(channel: &ChatChannel): u64 {
        channel.creator_revenue_pool.value()
    }

    public fun members_staked_pool(channel: &ChatChannel): u64 {
        channel.members_staked_pool.value()
    }

    public fun member_yield_pool(channel: &ChatChannel): u64 {
        channel.member_yield_pool.value()
    }

    public fun total_staked_members(channel: &ChatChannel): u64 {
        channel.total_staked_members
    }

    public fun receipt_member(receipt: &MemberStakeReceipt): address {
        receipt.member
    }

    public fun receipt_staked_amount(receipt: &MemberStakeReceipt): u64 {
        receipt.staked_amount
    }

    public fun receipt_channel_id(receipt: &MemberStakeReceipt): ID {
        receipt.channel_id
    }

    public fun cap_master_owner(cap: &SubagentMessagingCap): address {
        cap.master_owner
    }

    public fun cap_agent_address(cap: &SubagentMessagingCap): address {
        cap.agent_address
    }

    public fun cap_is_revoked(cap: &SubagentMessagingCap): bool {
        cap.is_revoked
    }

    public fun cap_messages_sent(cap: &SubagentMessagingCap): u64 {
        cap.messages_sent_in_window
    }

    // === Test-Only Functions ===

    /// Narrow payload snapshot for tests; production reads the event instead.
    #[test_only]
    public fun chat_message_fields(event: &ChatMessageEvent): (ID, u64, address, address, vector<u8>, vector<u8>, u64) {
        (event.channel_id, event.sequence, event.sender_master, event.sender_agent, event.walrus_blob_id, event.content_preview, event.timestamp_ms)
    }

    #[test_only]
    public fun max_batch_messages(): u64 {
        MAX_BATCH_MESSAGES
    }

    #[test_only]
    public fun max_preview_bytes(): u64 {
        MAX_PREVIEW_BYTES
    }
}
