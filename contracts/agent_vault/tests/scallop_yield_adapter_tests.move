#[test_only]
module agent_vault::scallop_yield_adapter_tests {
    use sui::test_scenario::{Self as ts};
    use sui::coin::{Self};
    use sui::sui::SUI;
    use sui::object;
    use agent_vault::onchain_chat::{Self, ChatChannel};
    use agent_vault::scallop_yield_adapter::{Self, ScallopVaultAdapter, SSUI};

    const ALICE: address = @0xA11CE;
    const BOB: address = @0xB0B;
    const DAO_ORG: address = @0xDA0;

    #[test]
    fun test_scallop_ssui_vault_adapter_continuous_yield_lifecycle() {
        let mut scenario = ts::begin(ALICE);

        // 1. 创建 Alice VIP 知识星球 (70% 创作者, 20% Gas池, 10% 会员分红)
        let creator_stake = coin::mint_for_testing<SUI>(100_000_000_000, ts::ctx(&mut scenario));
        let _channel_id = onchain_chat::create_creator_monetized_channel(
            DAO_ORG,
            b"Scallop Powered VIP Planet",
            creator_stake,
            0,               // 0 门票
            50_000_000_000,  // 50 SUI 进群保本质押
            7000,            // 70% 创作者
            2000,            // 20% Gas 代付池
            1000,            // 10% 会员分红
            ts::ctx(&mut scenario)
        );

        // 2. 为频道挂载 Scallop sSUI 生息适配器
        ts::next_tx(&mut scenario, ALICE);
        let adapter_id;
        {
            let channel = ts::take_shared<ChatChannel>(&scenario);
            adapter_id = scallop_yield_adapter::create_scallop_adapter(&channel, ts::ctx(&mut scenario));
            ts::return_shared(channel);
        };

        // 3. 将 150 SUI (100 SUI 建群储备 + 50 SUI 粉丝质押) 存入 Scallop 换取 sSUI 份额
        ts::next_tx(&mut scenario, ALICE);
        {
            let mut adapter = ts::take_shared<ScallopVaultAdapter>(&scenario);
            assert!(object::id(&adapter) == adapter_id, 500); // 创建事件/返回值与 shared 对象同锚
            let ssui_minted = coin::mint_for_testing<SSUI>(150_000_000_000, ts::ctx(&mut scenario));
            scallop_yield_adapter::deposit_to_scallop(&mut adapter, ts::ctx(&mut scenario), ssui_minted);

            assert!(scallop_yield_adapter::total_staked_sui_principal(&adapter) == 150_000_000_000, 501);
            assert!(scallop_yield_adapter::ssui_balance(&adapter) == 150_000_000_000, 502);
            ts::return_shared(adapter);
        };

        // 4. 模拟 Scallop 借贷池随出块产生实时利息 (累积增值 10 SUI)
        // Sentinel-AI 哨兵发起单笔 PTB：
        // ① split_ssui_for_redemption 切出增值利息对应的 sSUI
        // ② Scallop 赎回 10 SUI
        // ③ feed_harvested_yield_to_chat 注入聊天合约触发三路分润！
        ts::next_tx(&mut scenario, ALICE);
        {
            let mut adapter = ts::take_shared<ScallopVaultAdapter>(&scenario);
            let mut channel = ts::take_shared<ChatChannel>(&scenario);

            // 切出对应的 sSUI 并模拟从 Scallop 兑回 10 SUI 增值利息
            let ssui_yield_portion = scallop_yield_adapter::split_ssui_for_redemption(&mut adapter, 9_375_000_000, ts::ctx(&mut scenario));
            coin::burn_for_testing(ssui_yield_portion);

            let redeemed_yield_sui = coin::mint_for_testing<SUI>(10_000_000_000, ts::ctx(&mut scenario));
            scallop_yield_adapter::feed_harvested_yield_to_chat(&mut adapter, &mut channel, redeemed_yield_sui, ts::ctx(&mut scenario));

            // 验证累计收割总量
            assert!(scallop_yield_adapter::total_harvested_yield(&adapter) == 10_000_000_000, 503);

            // 验证群聊三路智能分润：
            // 70% (7 SUI) -> 创作者金库
            // 20% (2 SUI) -> 聊天 Gas 代付池
            // 10% (1 SUI) -> 会员利息分红池
            assert!(onchain_chat::creator_revenue_pool(&channel) == 7_000_000_000, 504);
            assert!(onchain_chat::gas_subsidy_pool(&channel) == 2_000_000_000, 505);
            assert!(onchain_chat::member_yield_pool(&channel) == 1_000_000_000, 506);

            ts::return_shared(channel);
            ts::return_shared(adapter);
        };

        // 5. 粉丝 Bob 申请退群，由金库管理员 Alice 执行 Scallop 份额赎回与本金清算
        ts::next_tx(&mut scenario, ALICE);
        {
            let mut adapter = ts::take_shared<ScallopVaultAdapter>(&scenario);
            let bob_principal_ssui = scallop_yield_adapter::split_ssui_for_redemption(&mut adapter, 50_000_000_000, ts::ctx(&mut scenario));
            coin::burn_for_testing(bob_principal_ssui);

            {
            let redeemed = coin::mint_for_testing<SUI>(50_000_000_000, ts::ctx(&mut scenario));
            scallop_yield_adapter::record_principal_redemption(&mut adapter, redeemed, 50_000_000_000, BOB, ts::ctx(&mut scenario));
        };
            assert!(scallop_yield_adapter::total_staked_sui_principal(&adapter) == 100_000_000_000, 507);

            ts::return_shared(adapter);
        };

        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = scallop_yield_adapter::E_NOT_AUTHORIZED, location = agent_vault::scallop_yield_adapter)]
    fun test_unauthorized_split_ssui_rejected() {
        let mut scenario = ts::begin(ALICE);
        let creator_stake = coin::mint_for_testing<SUI>(100_000_000_000, ts::ctx(&mut scenario));
        let _channel_id = onchain_chat::create_creator_monetized_channel(
            DAO_ORG,
            b"Scallop Channel",
            creator_stake,
            0,
            50_000_000_000,
            7000,
            2000,
            1000,
            ts::ctx(&mut scenario)
        );

        ts::next_tx(&mut scenario, ALICE);
        {
            let channel = ts::take_shared<ChatChannel>(&scenario);
            scallop_yield_adapter::create_scallop_adapter(&channel, ts::ctx(&mut scenario));
            ts::return_shared(channel);
        };

        ts::next_tx(&mut scenario, ALICE);
        {
            let mut adapter = ts::take_shared<ScallopVaultAdapter>(&scenario);
            let ssui_minted = coin::mint_for_testing<SSUI>(100_000_000_000, ts::ctx(&mut scenario));
            scallop_yield_adapter::deposit_to_scallop(&mut adapter, ts::ctx(&mut scenario), ssui_minted);
            ts::return_shared(adapter);
        };

        // 非 admin (BOB) 尝试越权切走 sSUI 份额 -> 必须 abort 7001 (E_NOT_AUTHORIZED)
        ts::next_tx(&mut scenario, BOB);
        {
            let mut adapter = ts::take_shared<ScallopVaultAdapter>(&scenario);
            let ssui = scallop_yield_adapter::split_ssui_for_redemption(&mut adapter, 10_000_000_000, ts::ctx(&mut scenario));
            coin::burn_for_testing(ssui);
            ts::return_shared(adapter);
        };

        ts::end(scenario);
    }

    // ===== #21/#22 安全回归（红队第五轮实弹路径的负向化）=====

    /// #21: 非 admin 携 sSUI 调 deposit → 7001 拦截（旧代码可写入 1000 SUI 幻影本金）。
    #[test]
    #[expected_failure(abort_code = 7001, location = agent_vault::scallop_yield_adapter)]
    fun non_admin_cannot_deposit() {
        let mut scenario = ts::begin(ALICE);
        // 频道: org=DAO_ORG, 成员空
        let channel_id = onchain_chat::create_channel(DAO_ORG, b"victim", vector[], ts::ctx(&mut scenario));
        ts::next_tx(&mut scenario, ALICE);
        let adapter_id;
        {
            let channel = ts::take_shared_by_id<ChatChannel>(&scenario, channel_id);
            adapter_id = scallop_yield_adapter::create_scallop_adapter(&channel, ts::ctx(&mut scenario));
            ts::return_shared(channel);
        };
        // 攻击者 BOB（非 admin）试图入账
        ts::next_tx(&mut scenario, BOB);
        {
            let mut adapter = ts::take_shared_by_id<ScallopVaultAdapter>(&scenario, adapter_id);
            let fake = coin::mint_for_testing<SSUI>(1_000_000_000_000, ts::ctx(&mut scenario));
            scallop_yield_adapter::deposit_to_scallop(&mut adapter, ts::ctx(&mut scenario), fake);
            ts::return_shared(adapter);
        };
        ts::end(scenario);
    }

    /// #21: admin 存入 3 SUI 的 sSUI → principal 恰好 +3 SUI（事实源=coin.value()，无另报通道）。
    #[test]
    fun deposit_records_coin_value_not_claimed_amount() {
        let mut scenario = ts::begin(ALICE);
        let channel_id = onchain_chat::create_channel(DAO_ORG, b"t", vector[], ts::ctx(&mut scenario));
        ts::next_tx(&mut scenario, ALICE);
        let adapter_id;
        {
            let channel = ts::take_shared_by_id<ChatChannel>(&scenario, channel_id);
            adapter_id = scallop_yield_adapter::create_scallop_adapter(&channel, ts::ctx(&mut scenario));
            ts::return_shared(channel);
        };
        ts::next_tx(&mut scenario, ALICE);
        {
            let mut adapter = ts::take_shared_by_id<ScallopVaultAdapter>(&scenario, adapter_id);
            let ssui = coin::mint_for_testing<SSUI>(3_000_000_000, ts::ctx(&mut scenario));
            scallop_yield_adapter::deposit_to_scallop(&mut adapter, ts::ctx(&mut scenario), ssui);
            assert!(scallop_yield_adapter::total_staked_sui_principal(&adapter) == 3_000_000_000, 600);
            assert!(scallop_yield_adapter::ssui_balance(&adapter) == 3_000_000_000, 601);
            ts::return_shared(adapter);
        };
        ts::end(scenario);
    }

    /// #22: admin 把收益喂进非绑定频道 → 7004 拦截。
    #[test]
    #[expected_failure(abort_code = 7004, location = agent_vault::scallop_yield_adapter)]
    fun feed_into_wrong_channel_is_rejected() {
        let mut scenario = ts::begin(ALICE);
        let bound_id = onchain_chat::create_channel(DAO_ORG, b"bound", vector[], ts::ctx(&mut scenario));
        let other_id = onchain_chat::create_channel(DAO_ORG, b"other", vector[], ts::ctx(&mut scenario));
        ts::next_tx(&mut scenario, ALICE);
        let adapter_id;
        {
            let channel = ts::take_shared_by_id<ChatChannel>(&scenario, bound_id);
            adapter_id = scallop_yield_adapter::create_scallop_adapter(&channel, ts::ctx(&mut scenario));
            ts::return_shared(channel);
        };
        ts::next_tx(&mut scenario, ALICE);
        {
            let mut adapter = ts::take_shared_by_id<ScallopVaultAdapter>(&scenario, adapter_id);
            let mut other = ts::take_shared_by_id<ChatChannel>(&scenario, other_id);
            let y = coin::mint_for_testing<SUI>(1_000_000, ts::ctx(&mut scenario));
            scallop_yield_adapter::feed_harvested_yield_to_chat(&mut adapter, &mut other, y, ts::ctx(&mut scenario));
            ts::return_shared(other);
            ts::return_shared(adapter);
        };
        ts::end(scenario);
    }
}
