#[test_only]
module agent_vault::vault_policy_tests {
    use sui::test_scenario::{Self as ts};
    use sui::coin;
    use sui::sui::SUI;

    use agent_vault::vault::{Self, AgentVault, OperatorCap, AgentCap};

    const ALICE: address = @0xA11CE;
    const BOB: address = @0xB0B;
    const AGENT: address = @0xCAFE;
    const RECIPIENT: address = @0xDEAF;

    /// 初始化金库 + 存款 + 签发 Operator + 设置流出策略的公共前置。
    fun setup_with_policy(scenario: &mut sui::test_scenario::Scenario, max_epoch_outflow: u64, max_agent_budget: u64) {
        let master_cap = vault::initialize_vault<SUI>(ts::ctx(scenario));
        ts::next_tx(scenario, ALICE);
        {
            let mut v = ts::take_shared<AgentVault<SUI>>(scenario);
            let c = coin::mint_for_testing<SUI>(1_000, ts::ctx(scenario));
            vault::deposit(&mut v, c);
            vault::issue_operator_cap(&master_cap, &v, BOB, ts::ctx(scenario));
            vault::set_outflow_policy(&master_cap, &mut v, max_epoch_outflow, max_agent_budget);
            assert!(vault::max_epoch_outflow(&v) == max_epoch_outflow, 100);
            assert!(vault::epoch_outflow(&v) == 0, 101);
            assert!(vault::max_agent_budget(&v) == max_agent_budget, 102);
            ts::return_shared(v);
        };
        vault::destroy_master_cap_for_testing(master_cap);
    }

    /// 孵化一张日额度为 limit 的卡（须 <= 已设置的 max_agent_budget）。
    fun spawn(scenario: &mut sui::test_scenario::Scenario, agent: address, limit: u64) {
        ts::next_tx(scenario, BOB);
        let op_cap = ts::take_from_sender<OperatorCap>(scenario);
        let mut v = ts::take_shared<AgentVault<SUI>>(scenario);
        vault::spawn_agent_card(&op_cap, &mut v, agent, limit, b"h", ts::ctx(scenario));
        ts::return_to_sender(scenario, op_cap);
        ts::return_shared(v);
    }

    /// 收款方领走并归还 payout 硬币，保持 scenario 对象账面干净。
    fun collect_payout(scenario: &mut sui::test_scenario::Scenario) {
        ts::next_tx(scenario, RECIPIENT);
        let payout = ts::take_from_sender<coin::Coin<SUI>>(scenario);
        ts::return_to_sender(scenario, payout);
    }

    // (1) 孵化额度超过 max_agent_budget：拒绝
    #[test]
    #[expected_failure(abort_code = agent_vault::vault::E_EXCEEDS_AGENT_BUDGET_CAP)]
    fun test_spawn_exceeding_budget_cap_rejected() {
        let mut scenario = ts::begin(ALICE);
        setup_with_policy(&mut scenario, 1_000, 50);

        ts::next_tx(&mut scenario, BOB);
        {
            let op_cap = ts::take_from_sender<OperatorCap>(&scenario);
            let mut v = ts::take_shared<AgentVault<SUI>>(&scenario);
            vault::spawn_agent_card(&op_cap, &mut v, AGENT, 51, b"h", ts::ctx(&mut scenario));
            ts::return_to_sender(&scenario, op_cap);
            ts::return_shared(v);
        };
        ts::end(scenario);
    }

    // (1b) 恰好等于上限的孵化合法；随后调额到超上限必须拒绝
    #[test]
    #[expected_failure(abort_code = agent_vault::vault::E_EXCEEDS_AGENT_BUDGET_CAP)]
    fun test_spawn_at_cap_ok_but_raise_above_cap_rejected() {
        let mut scenario = ts::begin(ALICE);
        setup_with_policy(&mut scenario, 1_000, 50);

        ts::next_tx(&mut scenario, BOB);
        {
            let op_cap = ts::take_from_sender<OperatorCap>(&scenario);
            let mut v = ts::take_shared<AgentVault<SUI>>(&scenario);
            vault::spawn_agent_card(&op_cap, &mut v, AGENT, 50, b"h", ts::ctx(&mut scenario));
            assert!(vault::agent_daily_limit(&v, AGENT) == 50, 110);
            vault::set_agent_budget(&op_cap, &mut v, AGENT, 51);
            ts::return_to_sender(&scenario, op_cap);
            ts::return_shared(v);
        };
        ts::end(scenario);
    }

    // (2) 零地址收款方：拒绝（资金黑洞防御）
    #[test]
    #[expected_failure(abort_code = agent_vault::vault::E_ZERO_RECIPIENT)]
    fun test_spend_to_zero_address_rejected() {
        let mut scenario = ts::begin(ALICE);
        setup_with_policy(&mut scenario, 1_000, 50);
        spawn(&mut scenario, AGENT, 50);

        ts::next_tx(&mut scenario, AGENT);
        {
            let mut agent_cap = ts::take_from_sender<AgentCap>(&scenario);
            let mut v = ts::take_shared<AgentVault<SUI>>(&scenario);
            vault::spend_x402_budget(&agent_cap, &mut v, 1, @0x0, ts::ctx(&mut scenario));
            ts::return_to_sender(&scenario, agent_cap);
            ts::return_shared(v);
        };
        ts::end(scenario);
    }

    // (3) 金库级 epoch 流出上限：两个 agent 各自 60 与 41（均在单卡 80 限额
    //     之内、金库余额充足），但 60+41=101 > max_epoch_outflow=100，
    //     第二笔必须以 E_EXCEEDS_EPOCH_OUTFLOW 拒绝。
    #[test]
    #[expected_failure(abort_code = agent_vault::vault::E_EXCEEDS_EPOCH_OUTFLOW)]
    fun test_vault_epoch_outflow_cap_enforced() {
        let mut scenario = ts::begin(ALICE);
        setup_with_policy(&mut scenario, 100, 80);
        spawn(&mut scenario, AGENT, 80);
        spawn(&mut scenario, ALICE, 80);

        ts::next_tx(&mut scenario, AGENT);
        {
            let mut agent_cap = ts::take_from_sender<AgentCap>(&scenario);
            let mut v = ts::take_shared<AgentVault<SUI>>(&scenario);
            vault::spend_x402_budget(&agent_cap, &mut v, 60, RECIPIENT, ts::ctx(&mut scenario));
            assert!(vault::epoch_outflow(&v) == 60, 200);
            ts::return_to_sender(&scenario, agent_cap);
            ts::return_shared(v);
        };
        collect_payout(&mut scenario);

        ts::next_tx(&mut scenario, ALICE);
        {
            let mut agent_cap_alice = ts::take_from_sender<AgentCap>(&scenario);
            let mut v = ts::take_shared<AgentVault<SUI>>(&scenario);
            // 单卡侧 41 <= 80 通过；金库侧 60+41=101 > 100 → abort 2013
            vault::spend_x402_budget(&agent_cap_alice, &mut v, 41, RECIPIENT, ts::ctx(&mut scenario));
            ts::return_to_sender(&scenario, agent_cap_alice);
            ts::return_shared(v);
        };
        ts::end(scenario);
    }

    // (3b) per-agent 日限额在金库上限远未触顶时仍然生效（2001 优先触发）
    #[test]
    #[expected_failure(abort_code = agent_vault::vault::E_EXCEEDED_DAILY_QUOTA)]
    fun test_per_agent_daily_limit_still_enforced() {
        let mut scenario = ts::begin(ALICE);
        setup_with_policy(&mut scenario, 10_000, 30);
        spawn(&mut scenario, AGENT, 30);

        ts::next_tx(&mut scenario, AGENT);
        {
            let mut agent_cap = ts::take_from_sender<AgentCap>(&scenario);
            let mut v = ts::take_shared<AgentVault<SUI>>(&scenario);
            vault::spend_x402_budget(&agent_cap, &mut v, 20, RECIPIENT, ts::ctx(&mut scenario));
            vault::spend_x402_budget(&agent_cap, &mut v, 11, RECIPIENT, ts::ctx(&mut scenario));
            ts::return_to_sender(&scenario, agent_cap);
            ts::return_shared(v);
        };
        ts::end(scenario);
    }

    // (3c) 恰好等于上限的累计支出合法，epoch_outflow 记账与余额正确
    #[test]
    fun test_outflow_exactly_at_cap_passes() {
        let mut scenario = ts::begin(ALICE);
        setup_with_policy(&mut scenario, 100, 100);
        spawn(&mut scenario, AGENT, 100);

        ts::next_tx(&mut scenario, AGENT);
        {
            let mut agent_cap = ts::take_from_sender<AgentCap>(&scenario);
            let mut v = ts::take_shared<AgentVault<SUI>>(&scenario);
            vault::spend_x402_budget(&agent_cap, &mut v, 40, RECIPIENT, ts::ctx(&mut scenario));
            vault::spend_x402_budget(&agent_cap, &mut v, 60, RECIPIENT, ts::ctx(&mut scenario));
            assert!(vault::epoch_outflow(&v) == 100, 300);
            assert!(vault::vault_balance(&v) == 900, 301);
            ts::return_to_sender(&scenario, agent_cap);
            ts::return_shared(v);
        };
        collect_payout(&mut scenario);
        ts::end(scenario);
    }

    // (4) 默认策略（全 0）：deny-by-default，任何孵化都被拒绝
    #[test]
    #[expected_failure(abort_code = agent_vault::vault::E_EXCEEDS_AGENT_BUDGET_CAP)]
    fun test_default_policy_denies_any_spawn() {
        let mut scenario = ts::begin(ALICE);
        let master_cap = vault::initialize_vault<SUI>(ts::ctx(&mut scenario));

        ts::next_tx(&mut scenario, ALICE);
        {
            let mut v = ts::take_shared<AgentVault<SUI>>(&scenario);
            assert!(vault::max_epoch_outflow(&v) == 0, 400);
            assert!(vault::epoch_outflow(&v) == 0, 401);
            assert!(vault::max_agent_budget(&v) == 0, 402);
            vault::issue_operator_cap(&master_cap, &v, BOB, ts::ctx(&mut scenario));
            ts::return_shared(v);
        };
        vault::destroy_master_cap_for_testing(master_cap);

        ts::next_tx(&mut scenario, BOB);
        {
            let op_cap = ts::take_from_sender<OperatorCap>(&scenario);
            let mut v = ts::take_shared<AgentVault<SUI>>(&scenario);
            vault::spawn_agent_card(&op_cap, &mut v, AGENT, 1, b"h", ts::ctx(&mut scenario));
            ts::return_to_sender(&scenario, op_cap);
            ts::return_shared(v);
        };
        ts::end(scenario);
    }

    // (5) 跨金库 MasterCap 不能设置他人金库的流出策略
    #[test]
    #[expected_failure(abort_code = agent_vault::vault::E_UNAUTHORIZED_OPERATOR)]
    fun test_set_outflow_policy_wrong_master_cap_rejected() {
        let mut scenario = ts::begin(ALICE);
        // 金库 A 的 MasterCap
        let master_a = vault::initialize_vault<SUI>(ts::ctx(&mut scenario));
        // 金库 B
        let _master_b = vault::initialize_vault<SUI>(ts::ctx(&mut scenario));

        ts::next_tx(&mut scenario, ALICE);
        {
            // 用 A 的 MasterCap 去设置金库 B 的流出策略：vault_id 不匹配
            // → E_UNAUTHORIZED_OPERATOR
            let vault_b_id = vault::master_vault_id(&_master_b);
            let mut vault_b = ts::take_shared_by_id<AgentVault<SUI>>(&scenario, vault_b_id);
            vault::set_outflow_policy(&master_a, &mut vault_b, 100, 100);
            ts::return_shared(vault_b);
        };
        vault::destroy_master_cap_for_testing(master_a);
        vault::destroy_master_cap_for_testing(_master_b);
        ts::end(scenario);
    }
}
