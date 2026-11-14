#[test_only]
module agent_vault::onchain_chat_tests {
    use sui::test_scenario::{Self as ts};
    use sui::clock::{Self};
    use sui::coin::{Self};
    use sui::sui::SUI;
    use sui::event;
    use agent_vault::onchain_chat::{Self, ChatChannel, ChatMessageEvent, SubagentMessagingCap, MemberStakeReceipt};

    const ALICE: address = @0xA11CE;
    const BOB: address = @0xB0B;
    const CHARLIE: address = @0xC0C;
    const SUBAGENT_ALICE: address = @0x50B_A11CE;
    const EVE_ATTACKER: address = @0xEE7E;
    const DAO_ORG: address = @0xDA0;

    #[test]
    fun test_chat_channel_and_subagent_messaging_lifecycle() {
        let mut scenario = ts::begin(ALICE);
        let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 1_000_000);

        // 1. Alice 创建链上聊天频道并共享
        let members = vector[ALICE, BOB, CHARLIE];
        let _channel_id = onchain_chat::create_channel(
            DAO_ORG,
            b"Core Engineering Alpha",
            members,
            ts::ctx(&mut scenario)
        );

        // 2. Alice 为其本地前端/守护进程的 Subagent 签发 7 天免密发信 Cap
        // 频控设为每分钟最多发 10 条
        ts::next_tx(&mut scenario, ALICE);
        {
            let channel = ts::take_shared<ChatChannel>(&scenario);
            let _cap_id = onchain_chat::create_shared_subagent_messaging_cap(
                &channel,
                SUBAGENT_ALICE,
                1_000_000 + 7 * 86400 * 1000, // 7 天后到期
                10, // 每分钟上限 10 条
                ts::ctx(&mut scenario)
            );
            ts::return_shared(channel);
        };

        // 3. Subagent 独立自主签名发信！(无需 Alice 钱包弹窗确认，毫秒级直接上链广播)
        ts::next_tx(&mut scenario, SUBAGENT_ALICE);
        {
            let mut channel = ts::take_shared<ChatChannel>(&scenario);
            let mut cap = ts::take_shared<SubagentMessagingCap>(&scenario);

            let walrus_blob_id = b"walrus_blob_0x789abc_encrypted_attachment";
            let content_preview = b"Subagent online: DKG ceremony is ready.";

            onchain_chat::post_message_by_subagent(
                &mut channel,
                &mut cap,
                &clock,
                walrus_blob_id,
                content_preview,
                ts::ctx(&mut scenario)
            );

            assert!(onchain_chat::message_sequence(&channel) == 1, 101);
            assert!(onchain_chat::cap_messages_sent(&cap) == 1, 102);

            ts::return_shared(cap);
            ts::return_shared(channel);
        };

        // 4. Bob 主账号亲自发信
        ts::next_tx(&mut scenario, BOB);
        {
            let mut channel = ts::take_shared<ChatChannel>(&scenario);
            onchain_chat::post_message(
                &mut channel,
                &clock,
                b"walrus_blob_0x111222",
                b"Bob: Ack, reviewing the proposal now.",
                ts::ctx(&mut scenario)
            );
            assert!(onchain_chat::message_sequence(&channel) == 2, 103);
            ts::return_shared(channel);
        };

        // 5. Alice 主账号单方面吊销 Subagent 发信权 (Kill-Switch)
        ts::next_tx(&mut scenario, ALICE);
        {
            let mut cap = ts::take_shared<SubagentMessagingCap>(&scenario);
            onchain_chat::revoke_subagent_messaging_cap(&mut cap, ts::ctx(&mut scenario));
            assert!(onchain_chat::cap_is_revoked(&cap), 104);
            ts::return_shared(cap);
        };

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = agent_vault::onchain_chat::E_CAP_REVOKED)]
    fun test_revoked_subagent_cannot_post_message() {
        let mut scenario = ts::begin(ALICE);
        let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 1_000_000);

        let members = vector[ALICE, BOB];
        onchain_chat::create_channel(DAO_ORG, b"Security Room", members, ts::ctx(&mut scenario));

        ts::next_tx(&mut scenario, ALICE);
        {
            let channel = ts::take_shared<ChatChannel>(&scenario);
            onchain_chat::create_shared_subagent_messaging_cap(
                &channel,
                SUBAGENT_ALICE,
                2_000_000,
                5,
                ts::ctx(&mut scenario)
            );
            ts::return_shared(channel);
        };

        // Alice 吊销该 Cap
        ts::next_tx(&mut scenario, ALICE);
        {
            let mut cap = ts::take_shared<SubagentMessagingCap>(&scenario);
            onchain_chat::revoke_subagent_messaging_cap(&mut cap, ts::ctx(&mut scenario));
            ts::return_shared(cap);
        };

        // Subagent 尝试发信 -> 预期失败 E_CAP_REVOKED
        ts::next_tx(&mut scenario, SUBAGENT_ALICE);
        {
            let mut channel = ts::take_shared<ChatChannel>(&scenario);
            let mut cap = ts::take_shared<SubagentMessagingCap>(&scenario);
            onchain_chat::post_message_by_subagent(
                &mut channel,
                &mut cap,
                &clock,
                b"blob_id",
                b"blocked message",
                ts::ctx(&mut scenario)
            );
            ts::return_shared(cap);
            ts::return_shared(channel);
        };

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = agent_vault::onchain_chat::E_UNAUTHORIZED_SUBAGENT)]
    fun test_unauthorized_attacker_cannot_impersonate_subagent() {
        let mut scenario = ts::begin(ALICE);
        let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 1_000_000);

        let members = vector[ALICE, BOB];
        onchain_chat::create_channel(DAO_ORG, b"General", members, ts::ctx(&mut scenario));

        ts::next_tx(&mut scenario, ALICE);
        {
            let channel = ts::take_shared<ChatChannel>(&scenario);
            onchain_chat::create_shared_subagent_messaging_cap(
                &channel,
                SUBAGENT_ALICE,
                2_000_000,
                5,
                ts::ctx(&mut scenario)
            );
            ts::return_shared(channel);
        };

        // 外部攻击者 EVE 尝试调用 Alice 的 Subagent Cap 发信 -> 预期失败 E_UNAUTHORIZED_SUBAGENT
        ts::next_tx(&mut scenario, EVE_ATTACKER);
        {
            let mut channel = ts::take_shared<ChatChannel>(&scenario);
            let mut cap = ts::take_shared<SubagentMessagingCap>(&scenario);
            onchain_chat::post_message_by_subagent(
                &mut channel,
                &mut cap,
                &clock,
                b"blob_id",
                b"spoofed message",
                ts::ctx(&mut scenario)
            );
            ts::return_shared(cap);
            ts::return_shared(channel);
        };

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = agent_vault::onchain_chat::E_RATE_LIMIT_EXCEEDED)]
    fun test_rate_limit_exceeded_fails() {
        let mut scenario = ts::begin(ALICE);
        let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 1_000_000);

        let members = vector[ALICE, BOB];
        onchain_chat::create_channel(DAO_ORG, b"General", members, ts::ctx(&mut scenario));

        ts::next_tx(&mut scenario, ALICE);
        {
            let channel = ts::take_shared<ChatChannel>(&scenario);
            // 设定每分钟最多发 2 条消息
            onchain_chat::create_shared_subagent_messaging_cap(
                &channel,
                SUBAGENT_ALICE,
                2_000_000,
                2,
                ts::ctx(&mut scenario)
            );
            ts::return_shared(channel);
        };

        // 消息 1: 成功
        ts::next_tx(&mut scenario, SUBAGENT_ALICE);
        {
            let mut channel = ts::take_shared<ChatChannel>(&scenario);
            let mut cap = ts::take_shared<SubagentMessagingCap>(&scenario);
            onchain_chat::post_message_by_subagent(
                &mut channel,
                &mut cap,
                &clock,
                b"blob_1",
                b"msg 1",
                ts::ctx(&mut scenario)
            );
            ts::return_shared(cap);
            ts::return_shared(channel);
        };

        // 消息 2: 成功
        ts::next_tx(&mut scenario, SUBAGENT_ALICE);
        {
            let mut channel = ts::take_shared<ChatChannel>(&scenario);
            let mut cap = ts::take_shared<SubagentMessagingCap>(&scenario);
            onchain_chat::post_message_by_subagent(
                &mut channel,
                &mut cap,
                &clock,
                b"blob_2",
                b"msg 2",
                ts::ctx(&mut scenario)
            );
            ts::return_shared(cap);
            ts::return_shared(channel);
        };

        // 消息 3 (在同一分钟内超频刷屏): 预期失败 E_RATE_LIMIT_EXCEEDED
        ts::next_tx(&mut scenario, SUBAGENT_ALICE);
        {
            let mut channel = ts::take_shared<ChatChannel>(&scenario);
            let mut cap = ts::take_shared<SubagentMessagingCap>(&scenario);
            onchain_chat::post_message_by_subagent(
                &mut channel,
                &mut cap,
                &clock,
                b"blob_3",
                b"msg 3 spam",
                ts::ctx(&mut scenario)
            );
            ts::return_shared(cap);
            ts::return_shared(channel);
        };

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    /// #20: rate_limit_per_minute = 0 的 Cap 连第一条消息（含窗口翻转后的
    /// 复位分支）都必须拒绝 —— 否则刷屏者每分钟仍可白嫖一条。
    #[test]
    #[expected_failure(abort_code = agent_vault::onchain_chat::E_RATE_LIMIT_EXCEEDED)]
    fun test_zero_rate_limit_rejects_even_the_first_message() {
        let mut scenario = ts::begin(ALICE);
        let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 1_000_000);

        let members = vector[ALICE, BOB];
        onchain_chat::create_channel(DAO_ORG, b"Muted", members, ts::ctx(&mut scenario));

        ts::next_tx(&mut scenario, ALICE);
        {
            let channel = ts::take_shared<ChatChannel>(&scenario);
            onchain_chat::create_shared_subagent_messaging_cap(
                &channel,
                SUBAGENT_ALICE,
                2_000_000,
                0, // 每分钟上限 0 条
                ts::ctx(&mut scenario)
            );
            ts::return_shared(channel);
        };

        // Subagent 尝试发送第一条消息（落在窗口复位分支）→ 预期 6006
        ts::next_tx(&mut scenario, SUBAGENT_ALICE);
        {
            let mut channel = ts::take_shared<ChatChannel>(&scenario);
            let mut cap = ts::take_shared<SubagentMessagingCap>(&scenario);
            onchain_chat::post_message_by_subagent(
                &mut channel,
                &mut cap,
                &clock,
                b"blob_first",
                b"first message under a zero rate limit",
                ts::ctx(&mut scenario)
            );
            ts::return_shared(cap);
            ts::return_shared(channel);
        };

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    #[test]
    fun test_stake_to_create_group_and_yield_funded_gas_subsidy() {
        let mut scenario = ts::begin(ALICE);
        let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 1_000_000);

        // 1. Alice 质押 100 SUI 建群 (保本质押)
        let members = vector[ALICE, BOB];
        let stake_coin = coin::mint_for_testing<SUI>(100_000_000_000, ts::ctx(&mut scenario)); // 100 SUI
        let _channel_id = onchain_chat::create_channel_with_stake(
            DAO_ORG,
            b"Staked DAO Treasury Chat",
            members,
            stake_coin,
            ts::ctx(&mut scenario)
        );

        ts::next_tx(&mut scenario, ALICE);
        {
            let channel = ts::take_shared<ChatChannel>(&scenario);
            assert!(onchain_chat::staked_principal(&channel) == 100_000_000_000, 301);
            assert!(onchain_chat::gas_subsidy_pool(&channel) == 0, 302);

            // 签发 Subagent Cap
            onchain_chat::create_shared_subagent_messaging_cap(
                &channel,
                SUBAGENT_ALICE,
                2_000_000,
                30,
                ts::ctx(&mut scenario)
            );
            ts::return_shared(channel);
        };

        // 2. 模拟质押生息：将 5 SUI 的 Staking 利息自动注入 Gas 代付池
        ts::next_tx(&mut scenario, ALICE);
        {
            let mut channel = ts::take_shared<ChatChannel>(&scenario);
            let yield_coin = coin::mint_for_testing<SUI>(5_000_000_000, ts::ctx(&mut scenario)); // 5 SUI
            onchain_chat::deposit_staking_yield(&mut channel, yield_coin);
            assert!(onchain_chat::gas_subsidy_pool(&channel) == 5_000_000_000, 303);
            ts::return_shared(channel);
        };

        // 3. Subagent 发信：合约自动从利息池中直接把 0.001 SUI 报销转回发信人钱包！
        ts::next_tx(&mut scenario, SUBAGENT_ALICE);
        {
            let mut channel = ts::take_shared<ChatChannel>(&scenario);
            let mut cap = ts::take_shared<SubagentMessagingCap>(&scenario);

            onchain_chat::post_message_by_subagent(
                &mut channel,
                &mut cap,
                &clock,
                b"walrus_blob_staked",
                b"Subagent: Gas is 100% free via Staking Yield!",
                ts::ctx(&mut scenario)
            );

            assert!(onchain_chat::total_subsidized_gas(&channel) == 1_000_000, 304); // 已代付 0.001 SUI
            assert!(onchain_chat::gas_subsidy_pool(&channel) == 5_000_000_000 - 1_000_000, 305);

            ts::return_shared(cap);
            ts::return_shared(channel);
        };

        // 4. 验证 Subagent 确实收到了合约打回的 0.001 SUI Gas 报销硬币 (Net Gas Spent = 0)
        ts::next_tx(&mut scenario, SUBAGENT_ALICE);
        {
            let rebate_coin = ts::take_from_sender<coin::Coin<SUI>>(&scenario);
            assert!(coin::value(&rebate_coin) == 1_000_000, 306);
            ts::return_to_sender(&scenario, rebate_coin);
        };

        // 5. 频道解散退出：Alice 100% 取回质押本金 (100 SUI) 和剩余补贴池
        ts::next_tx(&mut scenario, ALICE);
        {
            let channel = ts::take_shared<ChatChannel>(&scenario);
            onchain_chat::unstake_and_close_channel(channel, ts::ctx(&mut scenario));
        };

        // 6. 验证创建者 Alice 成功赎回 100 SUI 本金 + 剩余全部利息资金
        ts::next_tx(&mut scenario, ALICE);
        {
            let refund = ts::take_from_sender<coin::Coin<SUI>>(&scenario);
            assert!(coin::value(&refund) == 100_000_000_000 + 4_999_000_000, 307);
            ts::return_to_sender(&scenario, refund);
        };

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = agent_vault::onchain_chat::E_NOT_CHANNEL_CREATOR)]
    fun test_non_creator_cannot_close_channel_and_steal_stake() {
        let mut scenario = ts::begin(ALICE);
        let stake_coin = coin::mint_for_testing<SUI>(100_000_000_000, ts::ctx(&mut scenario));
        let members = vector[ALICE, BOB];
        onchain_chat::create_channel_with_stake(DAO_ORG, b"Alice Staked Chat", members, stake_coin, ts::ctx(&mut scenario));

        // 攻击者 Bob 企图盗取解散频道并偷走 Alice 的 100 SUI 本金 -> 预期失败 E_NOT_CHANNEL_CREATOR
        ts::next_tx(&mut scenario, BOB);
        {
            let channel = ts::take_shared<ChatChannel>(&scenario);
            onchain_chat::unstake_and_close_channel(channel, ts::ctx(&mut scenario));
        };

        ts::end(scenario);
    }

    #[test]
    fun test_creator_monetized_planet_membership_lifecycle() {
        let mut scenario = ts::begin(ALICE);
        let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 1_000_000);

        // 1. Alice 创建知识星球/舰长群：
        // 建群质押 100 SUI，门票 5 SUI，进群质押 50 SUI，
        // 分润比例：创作者 70%，Gas代付池 20%，会员分红 10%
        let creator_stake = coin::mint_for_testing<SUI>(100_000_000_000, ts::ctx(&mut scenario));
        onchain_chat::create_creator_monetized_channel(
            DAO_ORG,
            b"Alice VIP Knowledge Planet",
            creator_stake,
            5_000_000_000,   // 5 SUI 门票 (归创作者)
            50_000_000_000,  // 50 SUI 进群保本质押
            7000,            // 70% 创作者分润
            2000,            // 20% Gas 代付池
            1000,            // 10% 会员利息分红
            ts::ctx(&mut scenario)
        );

        // 2. 粉丝 Bob 进群：支付 55 SUI (5 SUI 门票 + 50 SUI 质押本金)
        ts::next_tx(&mut scenario, BOB);
        {
            let mut channel = ts::take_shared<ChatChannel>(&scenario);
            let mut payment = coin::mint_for_testing<SUI>(55_000_000_000, ts::ctx(&mut scenario));
            let receipt = onchain_chat::join_channel_with_stake_and_fee(&mut channel, &mut payment, ts::ctx(&mut scenario));
            coin::destroy_zero(payment);

            assert!(onchain_chat::is_member(&channel, BOB), 401);
            assert!(onchain_chat::total_staked_members(&channel) == 1, 402);
            assert!(onchain_chat::creator_revenue_pool(&channel) == 5_000_000_000, 403);
            assert!(onchain_chat::members_staked_pool(&channel) == 50_000_000_000, 404);

            transfer::public_transfer(receipt, BOB);
            ts::return_shared(channel);
        };

        // 3. 粉丝 Charlie 进群：同样支付 55 SUI
        ts::next_tx(&mut scenario, CHARLIE);
        {
            let mut channel = ts::take_shared<ChatChannel>(&scenario);
            let mut payment = coin::mint_for_testing<SUI>(55_000_000_000, ts::ctx(&mut scenario));
            let receipt = onchain_chat::join_channel_with_stake_and_fee(&mut channel, &mut payment, ts::ctx(&mut scenario));
            coin::destroy_zero(payment);

            assert!(onchain_chat::is_member(&channel, CHARLIE), 405);
            assert!(onchain_chat::total_staked_members(&channel) == 2, 406);
            assert!(onchain_chat::creator_revenue_pool(&channel) == 10_000_000_000, 407); // 5 SUI * 2 = 10 SUI
            assert!(onchain_chat::members_staked_pool(&channel) == 100_000_000_000, 408); // 50 SUI * 2 = 100 SUI

            transfer::public_transfer(receipt, CHARLIE);
            ts::return_shared(channel);
        };

        // 4. POS 质押节点生息：注入 10 SUI 收益，触发三路自动分润
        // 70% (7 SUI) -> 创作者金库 (累计 10 + 7 = 17 SUI)
        // 20% (2 SUI) -> 全群发信 Gas 代付池 (2,000,000,000 MIST)
        // 10% (1 SUI) -> 会员利息分红池 (1,000,000,000 MIST)
        ts::next_tx(&mut scenario, ALICE);
        {
            let mut channel = ts::take_shared<ChatChannel>(&scenario);
            let yield_coin = coin::mint_for_testing<SUI>(10_000_000_000, ts::ctx(&mut scenario));
            onchain_chat::distribute_staking_yield(&mut channel, yield_coin);

            assert!(onchain_chat::creator_revenue_pool(&channel) == 17_000_000_000, 409);
            assert!(onchain_chat::gas_subsidy_pool(&channel) == 2_000_000_000, 410);
            assert!(onchain_chat::member_yield_pool(&channel) == 1_000_000_000, 411);

            ts::return_shared(channel);
        };

        // 5. 创作者 Alice 提现星球收益：提取 17 SUI 门票与生息收益
        ts::next_tx(&mut scenario, ALICE);
        {
            let mut channel = ts::take_shared<ChatChannel>(&scenario);
            let revenue_coin = onchain_chat::claim_creator_revenue(&mut channel, ts::ctx(&mut scenario));
            assert!(coin::value(&revenue_coin) == 17_000_000_000, 412);
            assert!(onchain_chat::creator_revenue_pool(&channel) == 0, 413);
            transfer::public_transfer(revenue_coin, ALICE);
            ts::return_shared(channel);
        };

        // 6. 成员 Bob 亲自发信：享受 Gas 代付池报销 0.001 SUI
        ts::next_tx(&mut scenario, BOB);
        {
            let mut channel = ts::take_shared<ChatChannel>(&scenario);
            onchain_chat::post_message(
                &mut channel,
                &clock,
                b"walrus_blob_bob_intro",
                b"Bob: Hello Alice Planet!",
                ts::ctx(&mut scenario)
            );
            assert!(onchain_chat::total_subsidized_gas(&channel) == 1_000_000, 414);
            assert!(onchain_chat::gas_subsidy_pool(&channel) == 2_000_000_000 - 1_000_000, 415);
            ts::return_shared(channel);
        };

        // 7. 粉丝 Bob 退群：交回 MemberStakeReceipt，100% 赎回 50 SUI 质押本金 + 均分到的利息分红 (0.5 SUI = 500,000,000 MIST)
        ts::next_tx(&mut scenario, BOB);
        {
            let mut channel = ts::take_shared<ChatChannel>(&scenario);
            let receipt = ts::take_from_sender<MemberStakeReceipt>(&scenario);
            let refund_coin = onchain_chat::member_unstake_and_leave(&mut channel, receipt, ts::ctx(&mut scenario));

            // Bob 成功拿回本金 50 SUI + 利息 0.5 SUI = 50.5 SUI (实现粉丝保本质押 + 自动生息分润！)
            assert!(coin::value(&refund_coin) == 50_000_000_000 + 500_000_000, 416);
            assert!(!onchain_chat::is_member(&channel, BOB), 417);
            assert!(onchain_chat::total_staked_members(&channel) == 1, 418);
            assert!(onchain_chat::members_staked_pool(&channel) == 50_000_000_000, 419);

            transfer::public_transfer(refund_coin, BOB);
            ts::return_shared(channel);
        };

        // 8. 粉丝 Charlie 同样退群：赎回 50 SUI 本金 + 剩余 0.5 SUI 利息分红
        ts::next_tx(&mut scenario, CHARLIE);
        {
            let mut channel = ts::take_shared<ChatChannel>(&scenario);
            let receipt = ts::take_from_sender<MemberStakeReceipt>(&scenario);
            let refund_coin = onchain_chat::member_unstake_and_leave(&mut channel, receipt, ts::ctx(&mut scenario));

            assert!(coin::value(&refund_coin) == 50_000_000_000 + 500_000_000, 420);
            assert!(!onchain_chat::is_member(&channel, CHARLIE), 421);
            assert!(onchain_chat::total_staked_members(&channel) == 0, 422);

            transfer::public_transfer(refund_coin, CHARLIE);
            ts::return_shared(channel);
        };

        // 9. 全体成员已平稳退出退款，Alice 解散群组：赎回 100 SUI 建群本金 + 剩余全部 Gas 代付金
        ts::next_tx(&mut scenario, ALICE);
        {
            let channel = ts::take_shared<ChatChannel>(&scenario);
            onchain_chat::unstake_and_close_channel(channel, ts::ctx(&mut scenario));
        };

        // 10. 验证 Alice 收到 100 SUI 本金 + 剩余 Gas 池 (2 SUI - 0.001 SUI)
        ts::next_tx(&mut scenario, ALICE);
        {
            let refund = ts::take_from_sender<coin::Coin<SUI>>(&scenario);
            assert!(coin::value(&refund) == 100_000_000_000 + (2_000_000_000 - 1_000_000), 423);
            ts::return_to_sender(&scenario, refund);
        };

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = agent_vault::onchain_chat::E_MEMBERS_STILL_STAKED)]
    fun test_creator_cannot_close_channel_when_members_staked_protects_funds() {
        let mut scenario = ts::begin(ALICE);
        let creator_stake = coin::mint_for_testing<SUI>(100_000_000_000, ts::ctx(&mut scenario));
        onchain_chat::create_creator_monetized_channel(
            DAO_ORG,
            b"Protected Planet",
            creator_stake,
            0,
            50_000_000_000,
            7000,
            2000,
            1000,
            ts::ctx(&mut scenario)
        );

        // Bob 质押进群
        ts::next_tx(&mut scenario, BOB);
        {
            let mut channel = ts::take_shared<ChatChannel>(&scenario);
            let mut payment = coin::mint_for_testing<SUI>(50_000_000_000, ts::ctx(&mut scenario));
            let receipt = onchain_chat::join_channel_with_stake_and_fee(&mut channel, &mut payment, ts::ctx(&mut scenario));
            coin::destroy_zero(payment);
            transfer::public_transfer(receipt, BOB);
            ts::return_shared(channel);
        };

        // Alice 企图直接解散频道卷走 Bob 的 50 SUI 质押金 -> 预期被拦截报错 E_MEMBERS_STILL_STAKED
        ts::next_tx(&mut scenario, ALICE);
        {
            let channel = ts::take_shared<ChatChannel>(&scenario);
            onchain_chat::unstake_and_close_channel(channel, ts::ctx(&mut scenario));
        };

        ts::end(scenario);
    }

    // === Batch send ===

    /// Event payload snapshot for one batch line, so order and content are pinned.
    fun batch_events(): vector<ChatMessageEvent> {
        event::events_by_type<ChatMessageEvent>()
    }

    fun batch_sequence(event: &ChatMessageEvent): u64 {
        let (_, sequence, _, _, _, _, _) = onchain_chat::chat_message_fields(event);
        sequence
    }

    fun batch_preview(event: &ChatMessageEvent): vector<u8> {
        let (_, _, _, _, _, preview, _) = onchain_chat::chat_message_fields(event);
        preview
    }

    fun batch_blob(event: &ChatMessageEvent): vector<u8> {
        let (_, _, _, _, blob, _, _) = onchain_chat::chat_message_fields(event);
        blob
    }

    #[test]
    fun batch_send_keeps_caller_order_and_spends_one_rebate() {
        let mut scenario = ts::begin(ALICE);
        let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 1_000_000);

        let members = vector[ALICE, BOB];
        let stake = coin::mint_for_testing<SUI>(5_000_000_000, ts::ctx(&mut scenario));
        onchain_chat::create_channel_with_stake(DAO_ORG, b"Burst", members, stake, ts::ctx(&mut scenario));

        ts::next_tx(&mut scenario, ALICE);
        {
            let mut channel = ts::take_shared<ChatChannel>(&scenario);
            let yield_coin = coin::mint_for_testing<SUI>(5_000_000_000, ts::ctx(&mut scenario));
            onchain_chat::deposit_staking_yield(&mut channel, yield_coin);
            ts::return_shared(channel);
        };

        ts::next_tx(&mut scenario, ALICE);
        {
            let mut channel = ts::take_shared<ChatChannel>(&scenario);
            let events_before = batch_events().length();
            onchain_chat::post_message_batch(
                &mut channel,
                &clock,
                vector[b"first line", b"second line", b"third line"],
                vector[b"", b"blob-second", b""],
                ts::ctx(&mut scenario)
            );
            assert!(onchain_chat::message_sequence(&channel) == 3, 501);
            // One burst = one 0.001 SUI rebate, not one per line.
            assert!(onchain_chat::total_subsidized_gas(&channel) == 1_000_000, 502);
            assert!(onchain_chat::gas_subsidy_pool(&channel) == 5_000_000_000 - 1_000_000, 503);

            let events = batch_events();
            assert!(events.length() == events_before + 3, 504);
            let first = events_before;
            assert!(batch_sequence(&events[first]) == 1, 505);
            assert!(batch_sequence(&events[first + 1]) == 2, 506);
            assert!(batch_sequence(&events[first + 2]) == 3, 507);
            // pop_back + reverse must preserve the order the caller typed.
            assert!(batch_preview(&events[first]) == b"first line", 508);
            assert!(batch_preview(&events[first + 1]) == b"second line", 509);
            assert!(batch_preview(&events[first + 2]) == b"third line", 510);
            assert!(batch_blob(&events[first + 1]) == b"blob-second", 511);
            assert!(batch_blob(&events[first]) == b"", 512);
            ts::return_shared(channel);
        };

        ts::next_tx(&mut scenario, ALICE);
        {
            let mut rebate = ts::take_from_sender<coin::Coin<SUI>>(&scenario);
            assert!(coin::value(&rebate) == 1_000_000, 513);
            transfer::public_transfer(rebate, ALICE);
        };

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    #[test]
    fun batch_send_continues_the_existing_sequence() {
        let mut scenario = ts::begin(ALICE);
        let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 1_000_000);
        onchain_chat::create_channel(DAO_ORG, b"Continue", vector[ALICE], ts::ctx(&mut scenario));

        ts::next_tx(&mut scenario, ALICE);
        {
            let mut channel = ts::take_shared<ChatChannel>(&scenario);
            onchain_chat::post_message(&mut channel, &clock, b"", b"single", ts::ctx(&mut scenario));
            onchain_chat::post_message_batch(&mut channel, &clock, vector[b"a", b"b"], vector[b"", b""], ts::ctx(&mut scenario));
            assert!(onchain_chat::message_sequence(&channel) == 3, 520);
            ts::return_shared(channel);
        };

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = agent_vault::onchain_chat::E_EMPTY_BATCH)]
    fun batch_send_rejects_an_empty_batch() {
        let mut scenario = ts::begin(ALICE);
        let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));
        onchain_chat::create_channel(DAO_ORG, b"Empty", vector[ALICE], ts::ctx(&mut scenario));

        ts::next_tx(&mut scenario, ALICE);
        {
            let mut channel = ts::take_shared<ChatChannel>(&scenario);
            onchain_chat::post_message_batch(&mut channel, &clock, vector[], vector[], ts::ctx(&mut scenario));
            ts::return_shared(channel);
        };

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = agent_vault::onchain_chat::E_BATCH_LENGTH_MISMATCH)]
    fun batch_send_rejects_mismatched_blob_ids() {
        let mut scenario = ts::begin(ALICE);
        let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));
        onchain_chat::create_channel(DAO_ORG, b"Mismatch", vector[ALICE], ts::ctx(&mut scenario));

        ts::next_tx(&mut scenario, ALICE);
        {
            let mut channel = ts::take_shared<ChatChannel>(&scenario);
            onchain_chat::post_message_batch(&mut channel, &clock, vector[b"a", b"b"], vector[b""], ts::ctx(&mut scenario));
            ts::return_shared(channel);
        };

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = agent_vault::onchain_chat::E_BATCH_TOO_LARGE)]
    fun batch_send_rejects_more_than_the_cap() {
        let mut scenario = ts::begin(ALICE);
        let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));
        onchain_chat::create_channel(DAO_ORG, b"Cap", vector[ALICE], ts::ctx(&mut scenario));

        let mut previews = vector[];
        let mut blobs = vector[];
        let mut index: u64 = 0;
        while (index < onchain_chat::max_batch_messages() + 1) {
            previews.push_back(b"x");
            blobs.push_back(b"");
            index = index + 1;
        };

        ts::next_tx(&mut scenario, ALICE);
        {
            let mut channel = ts::take_shared<ChatChannel>(&scenario);
            onchain_chat::post_message_batch(&mut channel, &clock, previews, blobs, ts::ctx(&mut scenario));
            ts::return_shared(channel);
        };

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = agent_vault::onchain_chat::E_MESSAGE_TOO_LONG)]
    fun batch_send_rejects_an_oversized_preview_before_mutating() {
        let mut scenario = ts::begin(ALICE);
        let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));
        onchain_chat::create_channel(DAO_ORG, b"Long", vector[ALICE], ts::ctx(&mut scenario));

        let mut too_long = vector[];
        let mut index: u64 = 0;
        while (index < onchain_chat::max_preview_bytes() + 1) {
            too_long.push_back(0);
            index = index + 1;
        };

        ts::next_tx(&mut scenario, ALICE);
        {
            let mut channel = ts::take_shared<ChatChannel>(&scenario);
            onchain_chat::post_message_batch(&mut channel, &clock, vector[b"ok", too_long], vector[b"", b""], ts::ctx(&mut scenario));
            ts::return_shared(channel);
        };

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = agent_vault::onchain_chat::E_NOT_CHANNEL_MEMBER)]
    fun batch_send_requires_channel_membership() {
        let mut scenario = ts::begin(ALICE);
        let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));
        onchain_chat::create_channel(DAO_ORG, b"Members only", vector[ALICE], ts::ctx(&mut scenario));

        ts::next_tx(&mut scenario, EVE_ATTACKER);
        {
            let mut channel = ts::take_shared<ChatChannel>(&scenario);
            onchain_chat::post_message_batch(&mut channel, &clock, vector[b"spam"], vector[b""], ts::ctx(&mut scenario));
            ts::return_shared(channel);
        };

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    // === 收益债务记账：晚进群不能收割存量分红池 ===

    #[test]
    fun late_joiner_earns_no_share_of_banked_yield_and_leaves_with_principal_only() {
        let mut scenario = ts::begin(ALICE);
        // 100% member-share channel: entry 0, 50 SUI member stake, no creator/gas cut.
        let creator_stake = coin::mint_for_testing<SUI>(100_000_000_000, ts::ctx(&mut scenario));
        onchain_chat::create_creator_monetized_channel(
            DAO_ORG, b"Debt Planet", creator_stake, 0, 50_000_000_000, 0, 0, 10000,
            ts::ctx(&mut scenario)
        );

        ts::next_tx(&mut scenario, BOB);
        {
            let mut channel = ts::take_shared<ChatChannel>(&scenario);
            let mut payment = coin::mint_for_testing<SUI>(50_000_000_000, ts::ctx(&mut scenario));
            let receipt = onchain_chat::join_channel_with_stake_and_fee(&mut channel, &mut payment, ts::ctx(&mut scenario));
            coin::destroy_zero(payment);
            transfer::public_transfer(receipt, BOB);
            ts::return_shared(channel);
        };

        ts::next_tx(&mut scenario, CHARLIE);
        {
            let mut channel = ts::take_shared<ChatChannel>(&scenario);
            let mut payment = coin::mint_for_testing<SUI>(50_000_000_000, ts::ctx(&mut scenario));
            let receipt = onchain_chat::join_channel_with_stake_and_fee(&mut channel, &mut payment, ts::ctx(&mut scenario));
            coin::destroy_zero(payment);
            transfer::public_transfer(receipt, CHARLIE);
            ts::return_shared(channel);
        };

        // 10 SUI of member-share yield lands while only Bob and Charlie hold stake.
        ts::next_tx(&mut scenario, ALICE);
        {
            let mut channel = ts::take_shared<ChatChannel>(&scenario);
            let yield_coin = coin::mint_for_testing<SUI>(10_000_000_000, ts::ctx(&mut scenario));
            onchain_chat::distribute_staking_yield(&mut channel, yield_coin);
            assert!(onchain_chat::member_yield_pool(&channel) == 10_000_000_000, 601);
            ts::return_shared(channel);
        };

        // Eve joins after the distribution: her debt snapshot equals the whole
        // accumulator, so a same-instant leave refunds principal only.
        ts::next_tx(&mut scenario, EVE_ATTACKER);
        {
            let mut channel = ts::take_shared<ChatChannel>(&scenario);
            let mut payment = coin::mint_for_testing<SUI>(50_000_000_000, ts::ctx(&mut scenario));
            let receipt = onchain_chat::join_channel_with_stake_and_fee(&mut channel, &mut payment, ts::ctx(&mut scenario));
            coin::destroy_zero(payment);
            let refund_coin = onchain_chat::member_unstake_and_leave(&mut channel, receipt, ts::ctx(&mut scenario));
            assert!(coin::value(&refund_coin) == 50_000_000_000, 602);
            assert!(onchain_chat::member_yield_pool(&channel) == 10_000_000_000, 603);
            assert!(onchain_chat::total_staked_members(&channel) == 2, 604);
            transfer::public_transfer(refund_coin, EVE_ATTACKER);
            ts::return_shared(channel);
        };

        // The members who held stake through the distribution split it exactly.
        ts::next_tx(&mut scenario, BOB);
        {
            let mut channel = ts::take_shared<ChatChannel>(&scenario);
            let receipt = ts::take_from_sender<MemberStakeReceipt>(&scenario);
            let refund_coin = onchain_chat::member_unstake_and_leave(&mut channel, receipt, ts::ctx(&mut scenario));
            assert!(coin::value(&refund_coin) == 50_000_000_000 + 5_000_000_000, 605);
            assert!(onchain_chat::member_yield_pool(&channel) == 5_000_000_000, 606);
            transfer::public_transfer(refund_coin, BOB);
            ts::return_shared(channel);
        };

        ts::next_tx(&mut scenario, CHARLIE);
        {
            let mut channel = ts::take_shared<ChatChannel>(&scenario);
            let receipt = ts::take_from_sender<MemberStakeReceipt>(&scenario);
            let refund_coin = onchain_chat::member_unstake_and_leave(&mut channel, receipt, ts::ctx(&mut scenario));
            // Conservation: the two present members received the entire 10 SUI.
            assert!(coin::value(&refund_coin) == 50_000_000_000 + 5_000_000_000, 607);
            assert!(onchain_chat::member_yield_pool(&channel) == 0, 608);
            transfer::public_transfer(refund_coin, CHARLIE);
            ts::return_shared(channel);
        };

        // With every member out, the creator can close and recover the principal.
        ts::next_tx(&mut scenario, ALICE);
        {
            let channel = ts::take_shared<ChatChannel>(&scenario);
            onchain_chat::unstake_and_close_channel(channel, ts::ctx(&mut scenario));
        };

        ts::end(scenario);
    }

    #[test]
    fun creator_removes_a_stranded_zero_stake_member_and_closes() {
        let mut scenario = ts::begin(ALICE);
        // Entry-fee channel with no member stake: receipts carry no funds.
        let creator_stake = coin::mint_for_testing<SUI>(100_000_000_000, ts::ctx(&mut scenario));
        onchain_chat::create_creator_monetized_channel(
            DAO_ORG, b"Free Planet", creator_stake, 5_000_000_000, 0, 7000, 2000, 1000,
            ts::ctx(&mut scenario)
        );

        // Bob joins paying only the entry fee and then loses the receipt.
        ts::next_tx(&mut scenario, BOB);
        {
            let mut channel = ts::take_shared<ChatChannel>(&scenario);
            let mut payment = coin::mint_for_testing<SUI>(5_000_000_000, ts::ctx(&mut scenario));
            let receipt = onchain_chat::join_channel_with_stake_and_fee(&mut channel, &mut payment, ts::ctx(&mut scenario));
            coin::destroy_zero(payment);
            assert!(onchain_chat::total_staked_members(&channel) == 1, 610);
            transfer::public_transfer(receipt, BOB);
            ts::return_shared(channel);
        };

        // The creator removes the stranded member, then closes without touching
        // any principal (there is none at risk in this channel).
        ts::next_tx(&mut scenario, ALICE);
        {
            let mut channel = ts::take_shared<ChatChannel>(&scenario);
            onchain_chat::remove_zero_stake_member(&mut channel, BOB, ts::ctx(&mut scenario));
            assert!(!onchain_chat::is_member(&channel, BOB), 611);
            assert!(onchain_chat::total_staked_members(&channel) == 0, 612);
            ts::return_shared(channel);
        };

        // Close is reachable again: creator recovers principal + revenue + pools.
        ts::next_tx(&mut scenario, ALICE);
        {
            let channel = ts::take_shared<ChatChannel>(&scenario);
            onchain_chat::unstake_and_close_channel(channel, ts::ctx(&mut scenario));
        };

        ts::next_tx(&mut scenario, ALICE);
        {
            let refund = ts::take_from_sender<coin::Coin<SUI>>(&scenario);
            assert!(coin::value(&refund) == 100_000_000_000 + 5_000_000_000, 613);
            ts::return_to_sender(&scenario, refund);
        };

        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = agent_vault::onchain_chat::E_MEMBER_STAKE_AT_RISK)]
    fun creator_cannot_remove_a_member_with_principal_at_risk() {
        let mut scenario = ts::begin(ALICE);
        let creator_stake = coin::mint_for_testing<SUI>(100_000_000_000, ts::ctx(&mut scenario));
        onchain_chat::create_creator_monetized_channel(
            DAO_ORG, b"Staked Planet", creator_stake, 0, 50_000_000_000, 7000, 2000, 1000,
            ts::ctx(&mut scenario)
        );

        ts::next_tx(&mut scenario, BOB);
        {
            let mut channel = ts::take_shared<ChatChannel>(&scenario);
            let mut payment = coin::mint_for_testing<SUI>(50_000_000_000, ts::ctx(&mut scenario));
            let receipt = onchain_chat::join_channel_with_stake_and_fee(&mut channel, &mut payment, ts::ctx(&mut scenario));
            coin::destroy_zero(payment);
            transfer::public_transfer(receipt, BOB);
            ts::return_shared(channel);
        };

        ts::next_tx(&mut scenario, ALICE);
        {
            let mut channel = ts::take_shared<ChatChannel>(&scenario);
            // A staked member can only be released through their own receipt.
            onchain_chat::remove_zero_stake_member(&mut channel, BOB, ts::ctx(&mut scenario));
            ts::return_shared(channel);
        };

        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = agent_vault::onchain_chat::E_NOT_RECEIPT_OWNER)]
    fun removal_only_applies_to_members_who_joined_through_the_paid_path() {
        let mut scenario = ts::begin(ALICE);
        // Legacy zero-stake channel that seats BOB as an initial member.
        onchain_chat::create_channel(DAO_ORG, b"Initial Planet", vector[ALICE, BOB], ts::ctx(&mut scenario));

        ts::next_tx(&mut scenario, ALICE);
        {
            let mut channel = ts::take_shared<ChatChannel>(&scenario);
            // BOB sits in the member table as an initial member but was never
            // counted in total_staked_members; removal must refuse so the
            // counter cannot underflow.
            onchain_chat::remove_zero_stake_member(&mut channel, BOB, ts::ctx(&mut scenario));
            ts::return_shared(channel);
        };

        ts::end(scenario);
    }
}
