#[test_only]
module agent_vault::agent_vault_tests {
    use sui::test_scenario::{Self as ts};
    use sui::coin::{Self};
    use sui::sui::SUI;
    
    use agent_vault::vault::{Self, AgentVault, MasterCap, OperatorCap, AgentCap};
    use agent_vault::cryptographic_org::{Self, Organization};

    const ALICE: address = @0xA11CE;
    const BOB: address = @0xB0B;
    const CHARLIE_AGENT: address = @0xCAFE;
    const RECIPIENT: address = @0xDEAF;

    #[test]
    fun test_vault_deposit_withdraw_and_state() {
        let mut scenario = ts::begin(ALICE);
        
        // 1. Alice 初始化金库
        let master_cap = vault::initialize_vault<SUI>(ts::ctx(&mut scenario));
        
        ts::next_tx(&mut scenario, ALICE);
        {
            let mut vault = ts::take_shared<AgentVault<SUI>>(&scenario);
            assert!(vault::vault_balance(&vault) == 0, 1);
            assert!(vault::vault_version(&vault) == 1, 2);
            assert!(!vault::is_vault_paused(&vault), 3);

            // 存入 100 SUI
            let coin = coin::mint_for_testing<SUI>(100, ts::ctx(&mut scenario));
            vault::deposit(&mut vault, coin);
            assert!(vault::vault_balance(&vault) == 100, 4);

            // Master 提现 20 SUI
            vault::withdraw(&master_cap, &mut vault, 20, ALICE, ts::ctx(&mut scenario));
            assert!(vault::vault_balance(&vault) == 80, 5);

            ts::return_shared(vault);
        };

        ts::next_tx(&mut scenario, ALICE);
        {
            // 验证提现到账
            let withdrawn_coin = ts::take_from_sender<coin::Coin<SUI>>(&scenario);
            assert!(coin::value(&withdrawn_coin) == 20, 6);
            ts::return_to_sender(&scenario, withdrawn_coin);
        };

        vault::destroy_master_cap_for_testing(master_cap);
        ts::end(scenario);
    }

    #[test]
    fun test_operator_and_agent_lifecycle() {
        let mut scenario = ts::begin(ALICE);
        
        // 1. Alice 初始化金库并授权 Bob 为 Operator
        let master_cap = vault::initialize_vault<SUI>(ts::ctx(&mut scenario));
        
        ts::next_tx(&mut scenario, ALICE);
        {
            let mut vault = ts::take_shared<AgentVault<SUI>>(&scenario);
            let coin = coin::mint_for_testing<SUI>(100, ts::ctx(&mut scenario));
            vault::deposit(&mut vault, coin);

            vault::issue_operator_cap(&master_cap, &vault, BOB, ts::ctx(&mut scenario));
            vault::set_outflow_policy(&master_cap, &mut vault, 1_000_000_000, 1_000_000_000);
            ts::return_shared(vault);
        };

        // 2. Bob 使用 OperatorCap 孵化 AI Agent 打工卡 (限额 50 SUI)
        ts::next_tx(&mut scenario, BOB);
        {
            let op_cap = ts::take_from_sender<OperatorCap>(&scenario);
            let mut vault = ts::take_shared<AgentVault<SUI>>(&scenario);

            vault::spawn_agent_card(&op_cap, &mut vault, CHARLIE_AGENT, 50, b"x402_service_hash", ts::ctx(&mut scenario));

            ts::return_to_sender(&scenario, op_cap);
            ts::return_shared(vault);
        };

        // 3. Charlie (AI) 使用 AgentCap 支付 20 SUI
        ts::next_tx(&mut scenario, CHARLIE_AGENT);
        {
            let mut agent_cap = ts::take_from_sender<AgentCap>(&scenario);
            let mut vault = ts::take_shared<AgentVault<SUI>>(&scenario);

            assert!(vault::agent_daily_limit(&vault, CHARLIE_AGENT) == 50, 10);
            assert!(vault::agent_spent_in_epoch(&vault, CHARLIE_AGENT) == 0, 11);
            assert!(vault::agent_is_active(&vault, CHARLIE_AGENT), 12);

            vault::spend_x402_budget(&agent_cap, &mut vault, 20, RECIPIENT, ts::ctx(&mut scenario));

            assert!(vault::agent_spent_in_epoch(&vault, CHARLIE_AGENT) == 20, 13);
            assert!(vault::vault_balance(&vault) == 80, 14);

            ts::return_to_sender(&scenario, agent_cap);
            ts::return_shared(vault);
        };

        // 4. 收款方验证收到 20 SUI
        ts::next_tx(&mut scenario, RECIPIENT);
        {
            let payout = ts::take_from_sender<coin::Coin<SUI>>(&scenario);
            assert!(coin::value(&payout) == 20, 15);
            ts::return_to_sender(&scenario, payout);
        };

        // 5. Operator 调额与暂停（跨账户：仅凭 OperatorCap + Agent 地址，
        //    无需引用 Charlie 钱包持有的 AgentCap）
        ts::next_tx(&mut scenario, BOB);
        {
            let op_cap = ts::take_from_sender<OperatorCap>(&scenario);
            let mut vault = ts::take_shared<AgentVault<SUI>>(&scenario);

            vault::set_agent_budget(&op_cap, &mut vault, CHARLIE_AGENT, 80);
            assert!(vault::agent_daily_limit(&vault, CHARLIE_AGENT) == 80, 16);

            vault::pause_agent(&op_cap, &mut vault, CHARLIE_AGENT);
            assert!(!vault::agent_is_active(&vault, CHARLIE_AGENT), 17);

            vault::resume_agent(&op_cap, &mut vault, CHARLIE_AGENT);
            assert!(vault::agent_is_active(&vault, CHARLIE_AGENT), 18);

            ts::return_shared(vault);
            ts::return_to_sender(&scenario, op_cap);
        };

        vault::destroy_master_cap_for_testing(master_cap);
        ts::end(scenario);
    }

    /// 单个十六进制数字 → ASCII 字符（0-9 / a-f）。
    fun hex_digit(d: u8): u8 {
        if (d < 10) (48 + d) else (87 + d)
    }

    /// 由序号派生互不相同的 agent 地址（64 位 hex：前 62 位 '0' + i 的两位十六进制）。
    fun nth_agent(i: u64): address {
        let mut hex = vector[
            48u8, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48,
            48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48,
            48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48,
            48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48,
            48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48,
            48, 48,
        ];
        vector::push_back(&mut hex, hex_digit(((i / 16) as u8)));
        vector::push_back(&mut hex, hex_digit(((i % 16) as u8)));
        sui::address::from_ascii_bytes(&hex)
    }

    #[test]
    #[expected_failure(abort_code = agent_vault::vault::E_AGENT_ALREADY_SPAWNED)]
    fun test_spawn_duplicate_agent_address_rejected() {
        let mut scenario = ts::begin(ALICE);
        let master_cap = vault::initialize_vault<SUI>(ts::ctx(&mut scenario));

        ts::next_tx(&mut scenario, ALICE);
        {
            let mut vault = ts::take_shared<AgentVault<SUI>>(&scenario);
            let coin = coin::mint_for_testing<SUI>(100, ts::ctx(&mut scenario));
            vault::deposit(&mut vault, coin);
            vault::issue_operator_cap(&master_cap, &vault, BOB, ts::ctx(&mut scenario));
            vault::set_outflow_policy(&master_cap, &mut vault, 1_000_000_000, 1_000_000_000);
            ts::return_shared(vault);
        };

        // 同一地址二次孵化打工卡：VecMap 以地址为主键，必须拒绝重复
        ts::next_tx(&mut scenario, BOB);
        {
            let op_cap = ts::take_from_sender<OperatorCap>(&scenario);
            let mut vault = ts::take_shared<AgentVault<SUI>>(&scenario);
            vault::spawn_agent_card(&op_cap, &mut vault, CHARLIE_AGENT, 30, b"h", ts::ctx(&mut scenario));
            vault::spawn_agent_card(&op_cap, &mut vault, CHARLIE_AGENT, 50, b"h", ts::ctx(&mut scenario));
            ts::return_to_sender(&scenario, op_cap);
            ts::return_shared(vault);
        };

        vault::destroy_master_cap_for_testing(master_cap);
        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = agent_vault::vault::E_ZERO_AMOUNT)]
    fun test_spawn_zero_budget_rejected() {
        let mut scenario = ts::begin(ALICE);
        let master_cap = vault::initialize_vault<SUI>(ts::ctx(&mut scenario));

        ts::next_tx(&mut scenario, ALICE);
        {
            let mut vault = ts::take_shared<AgentVault<SUI>>(&scenario);
            let coin = coin::mint_for_testing<SUI>(100, ts::ctx(&mut scenario));
            vault::deposit(&mut vault, coin);
            vault::issue_operator_cap(&master_cap, &vault, BOB, ts::ctx(&mut scenario));
            vault::set_outflow_policy(&master_cap, &mut vault, 1_000_000_000, 1_000_000_000);
            ts::return_shared(vault);
        };

        ts::next_tx(&mut scenario, BOB);
        {
            let op_cap = ts::take_from_sender<OperatorCap>(&scenario);
            let mut vault = ts::take_shared<AgentVault<SUI>>(&scenario);
            vault::spawn_agent_card(&op_cap, &mut vault, CHARLIE_AGENT, 0, b"h", ts::ctx(&mut scenario));
            ts::return_to_sender(&scenario, op_cap);
            ts::return_shared(vault);
        };

        vault::destroy_master_cap_for_testing(master_cap);
        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = agent_vault::vault::E_INVALID_SERVICE_HASH)]
    fun test_spawn_rejects_an_oversized_service_hash() {
        let mut scenario = ts::begin(ALICE);
        let master_cap = vault::initialize_vault<SUI>(ts::ctx(&mut scenario));

        ts::next_tx(&mut scenario, ALICE);
        {
            let mut vault = ts::take_shared<AgentVault<SUI>>(&scenario);
            let coin = coin::mint_for_testing<SUI>(100, ts::ctx(&mut scenario));
            vault::deposit(&mut vault, coin);
            vault::issue_operator_cap(&master_cap, &vault, BOB, ts::ctx(&mut scenario));
            vault::set_outflow_policy(&master_cap, &mut vault, 1_000_000_000, 1_000_000_000);
            ts::return_shared(vault);
        };

        ts::next_tx(&mut scenario, BOB);
        {
            let op_cap = ts::take_from_sender<OperatorCap>(&scenario);
            let mut vault = ts::take_shared<AgentVault<SUI>>(&scenario);
            // 257 字节：服务标识哈希内联存在金库 agents 表里，必须与链下上限一致。
            let oversized = std::vector::tabulate!(257, |i| (i % 256) as u8);
            vault::spawn_agent_card(&op_cap, &mut vault, CHARLIE_AGENT, 100, oversized, ts::ctx(&mut scenario));
            ts::return_to_sender(&scenario, op_cap);
            ts::return_shared(vault);
        };

        vault::destroy_master_cap_for_testing(master_cap);
        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = agent_vault::vault::E_AGENT_NOT_FOUND)]
    fun test_admin_ops_on_unknown_agent_rejected() {
        let mut scenario = ts::begin(ALICE);
        let master_cap = vault::initialize_vault<SUI>(ts::ctx(&mut scenario));

        ts::next_tx(&mut scenario, ALICE);
        {
            let mut vault = ts::take_shared<AgentVault<SUI>>(&scenario);
            let coin = coin::mint_for_testing<SUI>(100, ts::ctx(&mut scenario));
            vault::deposit(&mut vault, coin);
            vault::issue_operator_cap(&master_cap, &vault, BOB, ts::ctx(&mut scenario));
            vault::set_outflow_policy(&master_cap, &mut vault, 1_000_000_000, 1_000_000_000);
            ts::return_shared(vault);
        };

        // 未孵化过的地址不在表中：调额/暂停必须先于一切变更失败
        ts::next_tx(&mut scenario, BOB);
        {
            let op_cap = ts::take_from_sender<OperatorCap>(&scenario);
            let mut vault = ts::take_shared<AgentVault<SUI>>(&scenario);
            vault::set_agent_budget(&op_cap, &mut vault, RECIPIENT, 30);
            ts::return_to_sender(&scenario, op_cap);
            ts::return_shared(vault);
        };

        vault::destroy_master_cap_for_testing(master_cap);
        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = agent_vault::vault::E_UNCHANGED_VALUE)]
    fun test_set_agent_budget_noop_transition_rejected() {
        let mut scenario = ts::begin(ALICE);
        let master_cap = vault::initialize_vault<SUI>(ts::ctx(&mut scenario));

        ts::next_tx(&mut scenario, ALICE);
        {
            let mut vault = ts::take_shared<AgentVault<SUI>>(&scenario);
            let coin = coin::mint_for_testing<SUI>(100, ts::ctx(&mut scenario));
            vault::deposit(&mut vault, coin);
            vault::issue_operator_cap(&master_cap, &vault, BOB, ts::ctx(&mut scenario));
            vault::set_outflow_policy(&master_cap, &mut vault, 1_000_000_000, 1_000_000_000);
            ts::return_shared(vault);
        };

        ts::next_tx(&mut scenario, BOB);
        {
            let op_cap = ts::take_from_sender<OperatorCap>(&scenario);
            let mut vault = ts::take_shared<AgentVault<SUI>>(&scenario);
            vault::spawn_agent_card(&op_cap, &mut vault, CHARLIE_AGENT, 30, b"h", ts::ctx(&mut scenario));
            // 同额 setter 不构成状态转移，必须拒绝（老/新值成对的事件只记录真实转移）
            vault::set_agent_budget(&op_cap, &mut vault, CHARLIE_AGENT, 30);
            ts::return_to_sender(&scenario, op_cap);
            ts::return_shared(vault);
        };

        vault::destroy_master_cap_for_testing(master_cap);
        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = agent_vault::vault::E_AGENT_LIMIT_REACHED)]
    fun test_agent_capacity_bound_enforced() {
        let mut scenario = ts::begin(ALICE);
        let master_cap = vault::initialize_vault<SUI>(ts::ctx(&mut scenario));

        ts::next_tx(&mut scenario, ALICE);
        {
            let mut vault = ts::take_shared<AgentVault<SUI>>(&scenario);
            let coin = coin::mint_for_testing<SUI>(1_000_000, ts::ctx(&mut scenario));
            vault::deposit(&mut vault, coin);
            vault::issue_operator_cap(&master_cap, &vault, BOB, ts::ctx(&mut scenario));
            vault::set_outflow_policy(&master_cap, &mut vault, 1_000_000_000, 1_000_000_000);
            ts::return_shared(vault);
        };

        // 满 100 张卡（序号地址 0x1..0x64 互不相同），表容量边界先验证可达
        ts::next_tx(&mut scenario, BOB);
        {
            let op_cap = ts::take_from_sender<OperatorCap>(&scenario);
            let mut vault = ts::take_shared<AgentVault<SUI>>(&scenario);

            let mut i = 1;
            while (i <= 100) {
                vault::spawn_agent_card(&op_cap, &mut vault, nth_agent(i), 1, b"h", ts::ctx(&mut scenario));
                i = i + 1;
            };
            assert!(vault::agent_count(&vault) == 100, 80);

            // 第 101 张必须拒绝：有界集合不可无声膨胀
            vault::spawn_agent_card(&op_cap, &mut vault, nth_agent(101), 1, b"h", ts::ctx(&mut scenario));

            ts::return_to_sender(&scenario, op_cap);
            ts::return_shared(vault);
        };

        vault::destroy_master_cap_for_testing(master_cap);
        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = agent_vault::vault::E_EXCEEDED_DAILY_QUOTA)]
    fun test_agent_spend_exceeds_budget_fails() {
        let mut scenario = ts::begin(ALICE);
        let master_cap = vault::initialize_vault<SUI>(ts::ctx(&mut scenario));
        
        ts::next_tx(&mut scenario, ALICE);
        {
            let mut vault = ts::take_shared<AgentVault<SUI>>(&scenario);
            let coin = coin::mint_for_testing<SUI>(100, ts::ctx(&mut scenario));
            vault::deposit(&mut vault, coin);
            vault::issue_operator_cap(&master_cap, &vault, BOB, ts::ctx(&mut scenario));
            vault::set_outflow_policy(&master_cap, &mut vault, 1_000_000_000, 1_000_000_000);
            ts::return_shared(vault);
        };

        // 限额 30 SUI
        ts::next_tx(&mut scenario, BOB);
        {
            let op_cap = ts::take_from_sender<OperatorCap>(&scenario);
            let mut vault = ts::take_shared<AgentVault<SUI>>(&scenario);
            vault::spawn_agent_card(&op_cap, &mut vault, CHARLIE_AGENT, 30, b"x402_hash", ts::ctx(&mut scenario));
            ts::return_to_sender(&scenario, op_cap);
            ts::return_shared(vault);
        };

        // 尝试支出 35 SUI，超出 30 SUI 限额，必须 abort
        ts::next_tx(&mut scenario, CHARLIE_AGENT);
        {
            let mut agent_cap = ts::take_from_sender<AgentCap>(&scenario);
            let mut vault = ts::take_shared<AgentVault<SUI>>(&scenario);

            vault::spend_x402_budget(&agent_cap, &mut vault, 35, RECIPIENT, ts::ctx(&mut scenario));

            ts::return_to_sender(&scenario, agent_cap);
            ts::return_shared(vault);
        };

        vault::destroy_master_cap_for_testing(master_cap);
        ts::end(scenario);
    }

    #[test]
    fun test_epoch_rollover_resets_budget() {
        let mut scenario = ts::begin(ALICE);
        let master_cap = vault::initialize_vault<SUI>(ts::ctx(&mut scenario));
        
        ts::next_tx(&mut scenario, ALICE);
        {
            let mut vault = ts::take_shared<AgentVault<SUI>>(&scenario);
            let coin = coin::mint_for_testing<SUI>(100, ts::ctx(&mut scenario));
            vault::deposit(&mut vault, coin);
            vault::issue_operator_cap(&master_cap, &vault, BOB, ts::ctx(&mut scenario));
            vault::set_outflow_policy(&master_cap, &mut vault, 1_000_000_000, 1_000_000_000);
            ts::return_shared(vault);
        };

        // 限额 30 SUI
        ts::next_tx(&mut scenario, BOB);
        {
            let op_cap = ts::take_from_sender<OperatorCap>(&scenario);
            let mut vault = ts::take_shared<AgentVault<SUI>>(&scenario);
            vault::spawn_agent_card(&op_cap, &mut vault, CHARLIE_AGENT, 30, b"x402_hash", ts::ctx(&mut scenario));
            ts::return_to_sender(&scenario, op_cap);
            ts::return_shared(vault);
        };

        // 第 0 纪元支出 25 SUI
        ts::next_tx(&mut scenario, CHARLIE_AGENT);
        {
            let mut agent_cap = ts::take_from_sender<AgentCap>(&scenario);
            let mut vault = ts::take_shared<AgentVault<SUI>>(&scenario);

            vault::spend_x402_budget(&agent_cap, &mut vault, 25, RECIPIENT, ts::ctx(&mut scenario));
            assert!(vault::agent_spent_in_epoch(&vault, CHARLIE_AGENT) == 25, 20);

            ts::return_to_sender(&scenario, agent_cap);
            ts::return_shared(vault);
        };

        // 跨越到下一个纪元 (epoch rollover)
        ts::next_epoch(&mut scenario, CHARLIE_AGENT);
        {
            let mut agent_cap = ts::take_from_sender<AgentCap>(&scenario);
            let mut vault = ts::take_shared<AgentVault<SUI>>(&scenario);

            // 新纪元中再支出 20 SUI (此时 20 <= 30，跨纪元自动清零生效，成功通过！)
            vault::spend_x402_budget(&agent_cap, &mut vault, 20, RECIPIENT, ts::ctx(&mut scenario));
            assert!(vault::agent_spent_in_epoch(&vault, CHARLIE_AGENT) == 20, 21);

            ts::return_to_sender(&scenario, agent_cap);
            ts::return_shared(vault);
        };

        vault::destroy_master_cap_for_testing(master_cap);
        ts::end(scenario);
    }

    #[test]
    fun test_emergency_unilateral_purge_invalidates_all_caps() {
        let mut scenario = ts::begin(ALICE);
        let master_cap = vault::initialize_vault<SUI>(ts::ctx(&mut scenario));
        
        ts::next_tx(&mut scenario, ALICE);
        {
            let mut vault = ts::take_shared<AgentVault<SUI>>(&scenario);
            let coin = coin::mint_for_testing<SUI>(100, ts::ctx(&mut scenario));
            vault::deposit(&mut vault, coin);
            vault::issue_operator_cap(&master_cap, &vault, BOB, ts::ctx(&mut scenario));
            vault::set_outflow_policy(&master_cap, &mut vault, 1_000_000_000, 1_000_000_000);
            ts::return_shared(vault);
        };

        ts::next_tx(&mut scenario, BOB);
        {
            let op_cap = ts::take_from_sender<OperatorCap>(&scenario);
            let mut vault = ts::take_shared<AgentVault<SUI>>(&scenario);
            vault::spawn_agent_card(&op_cap, &mut vault, CHARLIE_AGENT, 30, b"x402_hash", ts::ctx(&mut scenario));
            ts::return_to_sender(&scenario, op_cap);
            ts::return_shared(vault);
        };

        // Master 启动单向紧急熔断：全额资金扫到 ALICE，且递增 vault_version
        ts::next_tx(&mut scenario, ALICE);
        {
            let mut vault = ts::take_shared<AgentVault<SUI>>(&scenario);
            vault::emergency_unilateral_purge(&master_cap, &mut vault, ALICE, ts::ctx(&mut scenario));

            assert!(vault::vault_balance(&vault) == 0, 30);
            assert!(vault::vault_version(&vault) == 2, 31);
            assert!(vault::is_vault_paused(&vault), 32);

            ts::return_shared(vault);
        };

        // 验证 ALICE 收到扫出的 100 SUI
        ts::next_tx(&mut scenario, ALICE);
        {
            let swept_coin = ts::take_from_sender<coin::Coin<SUI>>(&scenario);
            assert!(coin::value(&swept_coin) == 100, 33);
            ts::return_to_sender(&scenario, swept_coin);
        };

        vault::destroy_master_cap_for_testing(master_cap);
        ts::end(scenario);
    }

    #[test]
    fun test_cryptographic_org_initialization() {
        let mut scenario = ts::begin(ALICE);
        
        let dummy_pk = b"12345678901234567890123456789012"; // 32 字节 Ed25519 PK
        let members = vector[ALICE, BOB];
        let weights = vector[60, 40];

        let org_id = cryptographic_org::create_organization_for_testing(
            dummy_pk,
            2,
            70,
            members,
            weights,
            ts::ctx(&mut scenario)
        );
        std::debug::print(&org_id);

        ts::next_tx(&mut scenario, ALICE);
        {
            let org = ts::take_shared<Organization>(&scenario);
            assert!(cryptographic_org::group_pk(&org) == dummy_pk, 40);
            assert!(cryptographic_org::threshold_weight(&org) == 70, 41);
            assert!(cryptographic_org::epoch_version(&org) == 1, 42);
            assert!(cryptographic_org::member_weight(&org, ALICE) == 60, 43);
            assert!(cryptographic_org::member_weight(&org, BOB) == 40, 44);
            assert!(cryptographic_org::member_weight(&org, @0x999) == 0, 45);
            ts::return_shared(org);
        };

        ts::end(scenario);
    }

    #[test]
    fun test_cryptographic_org_threshold_signature_execution_and_replay() {
        let mut scenario = ts::begin(ALICE);

        let pk = vector[
            138, 136, 227, 221, 116, 9, 241, 149, 253, 82, 219, 45, 60, 186, 93, 114,
            202, 103, 9, 191, 29, 148, 18, 27, 243, 116, 136, 1, 180, 15, 111, 92
        ];
        let msg = vector[
            104, 101, 108, 108, 111, 95, 115, 117, 105, 95, 102, 114, 111, 115, 116, 95,
            116, 104, 114, 101, 115, 104, 111, 108, 100, 95, 97, 99, 116, 105, 111, 110
        ];
        let sig1 = vector[
            29, 118, 42, 8, 14, 38, 15, 162, 200, 241, 83, 176, 80, 171, 212, 141,
            208, 62, 59, 155, 106, 173, 79, 184, 1, 200, 166, 120, 116, 160, 175, 187,
            118, 46, 138, 173, 227, 45, 187, 9, 199, 218, 171, 113, 155, 25, 44, 74,
            91, 225, 253, 9, 3, 99, 242, 231, 15, 199, 71, 242, 31, 155, 54, 1
        ];
        let sig_epoch = vector[
            130, 246, 124, 149, 97, 137, 160, 20, 229, 62, 163, 56, 140, 157, 39, 84,
            142, 34, 227, 87, 245, 195, 110, 207, 186, 183, 216, 211, 51, 190, 52, 138,
            124, 222, 156, 38, 7, 183, 47, 83, 97, 183, 223, 132, 15, 213, 220, 232,
            173, 86, 130, 102, 140, 234, 184, 6, 45, 120, 101, 12, 5, 173, 200, 9
        ];
        let sig2 = vector[
            73, 24, 122, 166, 180, 166, 35, 77, 30, 192, 14, 241, 182, 19, 195, 26,
            234, 241, 29, 113, 202, 97, 149, 125, 105, 75, 246, 53, 102, 232, 208, 52,
            171, 0, 83, 69, 101, 194, 186, 137, 64, 80, 63, 202, 84, 172, 160, 112,
            156, 217, 219, 97, 172, 95, 183, 215, 113, 84, 181, 8, 113, 153, 165, 15
        ];

        let members = vector[ALICE, BOB];
        let weights = vector[60, 40];

        let _org_id = cryptographic_org::create_organization_for_testing(
            pk,
            2,
            70,
            members,
            weights,
            ts::ctx(&mut scenario)
        );

        // 1. 在 Epoch 1 验证签名并执行提案 (Nonce 1)
        ts::next_tx(&mut scenario, ALICE);
        {
            let mut org = ts::take_shared<Organization>(&scenario);
            let org_id = cryptographic_org::org_id(&org);
            let digest1 = cryptographic_org::compute_proposal_digest(
                &cryptographic_org::chain_id(&org),
                org_id,
                1,
                1,
                &msg,
                1
            );
            assert!(!cryptographic_org::is_proposal_executed(&org, digest1), 50);

            cryptographic_org::execute_threshold_proposal(
                &mut org,
                1, // nonce
                msg,
                sig1,
                1, // action_type: 1
                ts::ctx(&mut scenario)
            );

            assert!(cryptographic_org::is_proposal_executed(&org, digest1), 51);
            assert!(cryptographic_org::last_nonce(&org) == 1, 52);
            ts::return_shared(org);
        };

        // 2. 推进纪元换届到 Epoch 2 (Nonce 2)
        ts::next_tx(&mut scenario, ALICE);
        {
            let mut org = ts::take_shared<Organization>(&scenario);
            cryptographic_org::advance_organization_epoch(
                &mut org,
                2, // nonce
                sig_epoch,
                ts::ctx(&mut scenario)
            );
            assert!(cryptographic_org::epoch_version(&org) == 2, 53);
            assert!(cryptographic_org::last_nonce(&org) == 2, 54);
            ts::return_shared(org);
        };

        // 3. 在 Epoch 2 验证新纪元下的门限提案执行 (Nonce 3)
        ts::next_tx(&mut scenario, ALICE);
        {
            let mut org = ts::take_shared<Organization>(&scenario);
            let org_id = cryptographic_org::org_id(&org);
            let digest2 = cryptographic_org::compute_proposal_digest(
                &cryptographic_org::chain_id(&org),
                org_id,
                2,
                3,
                &msg,
                1
            );

            cryptographic_org::execute_threshold_proposal(
                &mut org,
                3, // nonce
                msg,
                sig2,
                1,
                ts::ctx(&mut scenario)
            );

            assert!(cryptographic_org::is_proposal_executed(&org, digest2), 55);
            assert!(cryptographic_org::last_nonce(&org) == 3, 56);
            ts::return_shared(org);
        };

        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = agent_vault::cryptographic_org::E_INVALID_NONCE)]
    fun test_cryptographic_org_replay_same_nonce_fails() {
        let mut scenario = ts::begin(ALICE);

        let pk = vector[
            138, 136, 227, 221, 116, 9, 241, 149, 253, 82, 219, 45, 60, 186, 93, 114,
            202, 103, 9, 191, 29, 148, 18, 27, 243, 116, 136, 1, 180, 15, 111, 92
        ];
        let msg = vector[
            104, 101, 108, 108, 111, 95, 115, 117, 105, 95, 102, 114, 111, 115, 116, 95,
            116, 104, 114, 101, 115, 104, 111, 108, 100, 95, 97, 99, 116, 105, 111, 110
        ];
        let sig1 = vector[
            29, 118, 42, 8, 14, 38, 15, 162, 200, 241, 83, 176, 80, 171, 212, 141,
            208, 62, 59, 155, 106, 173, 79, 184, 1, 200, 166, 120, 116, 160, 175, 187,
            118, 46, 138, 173, 227, 45, 187, 9, 199, 218, 171, 113, 155, 25, 44, 74,
            91, 225, 253, 9, 3, 99, 242, 231, 15, 199, 71, 242, 31, 155, 54, 1
        ];

        let members = vector[ALICE, BOB];
        let weights = vector[60, 40];

        let _org_id = cryptographic_org::create_organization_for_testing(
            pk,
            2,
            70,
            members,
            weights,
            ts::ctx(&mut scenario)
        );

        // 第一次执行成功 (Nonce 1)
        ts::next_tx(&mut scenario, ALICE);
        {
            let mut org = ts::take_shared<Organization>(&scenario);
            cryptographic_org::execute_threshold_proposal(&mut org, 1, msg, sig1, 1, ts::ctx(&mut scenario));
            ts::return_shared(org);
        };

        // 第二次重放同个 Nonce 1，由于单调递增要求，必须拒绝并抛出 E_INVALID_NONCE
        ts::next_tx(&mut scenario, ALICE);
        {
            let mut org = ts::take_shared<Organization>(&scenario);
            cryptographic_org::execute_threshold_proposal(&mut org, 1, msg, sig1, 1, ts::ctx(&mut scenario));
            ts::return_shared(org);
        };

        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = agent_vault::cryptographic_org::E_INVALID_SIGNATURE)]
    fun test_cryptographic_org_tampered_signature_fails() {
        let mut scenario = ts::begin(ALICE);

        let pk = vector[
            138, 136, 227, 221, 116, 9, 241, 149, 253, 82, 219, 45, 60, 186, 93, 114,
            202, 103, 9, 191, 29, 148, 18, 27, 243, 116, 136, 1, 180, 15, 111, 92
        ];
        let msg = vector[
            104, 101, 108, 108, 111, 95, 115, 117, 105, 95, 102, 114, 111, 115, 116, 95,
            116, 104, 114, 101, 115, 104, 111, 108, 100, 95, 97, 99, 116, 105, 111, 110
        ];
        // 篡改最后一个字节：1 -> 2
        let bad_sig = vector[
            29, 118, 42, 8, 14, 38, 15, 162, 200, 241, 83, 176, 80, 171, 212, 141,
            208, 62, 59, 155, 106, 173, 79, 184, 1, 200, 166, 120, 116, 160, 175, 187,
            118, 46, 138, 173, 227, 45, 187, 9, 199, 218, 171, 113, 155, 25, 44, 74,
            91, 225, 253, 9, 3, 99, 242, 231, 15, 199, 71, 242, 31, 155, 54, 2
        ];

        let members = vector[ALICE, BOB];
        let weights = vector[60, 40];

        let _org_id = cryptographic_org::create_organization_for_testing(
            pk,
            2,
            70,
            members,
            weights,
            ts::ctx(&mut scenario)
        );

        // 尝试使用被篡改的签名执行，必须 abort E_INVALID_SIGNATURE
        ts::next_tx(&mut scenario, ALICE);
        {
            let mut org = ts::take_shared<Organization>(&scenario);
            cryptographic_org::execute_threshold_proposal(&mut org, 1, msg, bad_sig, 1, ts::ctx(&mut scenario));
            ts::return_shared(org);
        };

        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = agent_vault::cryptographic_org::E_INVALID_SIGNATURE)]
    fun test_cryptographic_org_cross_epoch_replay_rejected() {
        let mut scenario = ts::begin(ALICE);

        let pk = vector[
            138, 136, 227, 221, 116, 9, 241, 149, 253, 82, 219, 45, 60, 186, 93, 114,
            202, 103, 9, 191, 29, 148, 18, 27, 243, 116, 136, 1, 180, 15, 111, 92
        ];
        let msg = vector[
            104, 101, 108, 108, 111, 95, 115, 117, 105, 95, 102, 114, 111, 115, 116, 95,
            116, 104, 114, 101, 115, 104, 111, 108, 100, 95, 97, 99, 116, 105, 111, 110
        ];
        let sig1 = vector[
            29, 118, 42, 8, 14, 38, 15, 162, 200, 241, 83, 176, 80, 171, 212, 141,
            208, 62, 59, 155, 106, 173, 79, 184, 1, 200, 166, 120, 116, 160, 175, 187,
            118, 46, 138, 173, 227, 45, 187, 9, 199, 218, 171, 113, 155, 25, 44, 74,
            91, 225, 253, 9, 3, 99, 242, 231, 15, 199, 71, 242, 31, 155, 54, 1
        ];
        let sig_epoch = vector[
            130, 246, 124, 149, 97, 137, 160, 20, 229, 62, 163, 56, 140, 157, 39, 84,
            142, 34, 227, 87, 245, 195, 110, 207, 186, 183, 216, 211, 51, 190, 52, 138,
            124, 222, 156, 38, 7, 183, 47, 83, 97, 183, 223, 132, 15, 213, 220, 232,
            173, 86, 130, 102, 140, 234, 184, 6, 45, 120, 101, 12, 5, 173, 200, 9
        ];

        let members = vector[ALICE, BOB];
        let weights = vector[60, 40];

        let _org_id = cryptographic_org::create_organization_for_testing(
            pk,
            2,
            70,
            members,
            weights,
            ts::ctx(&mut scenario)
        );

        // 1. 推进纪元换届到 Epoch 2 (Nonce 2)
        ts::next_tx(&mut scenario, ALICE);
        {
            let mut org = ts::take_shared<Organization>(&scenario);
            cryptographic_org::advance_organization_epoch(
                &mut org,
                2,
                sig_epoch,
                ts::ctx(&mut scenario)
            );
            assert!(cryptographic_org::epoch_version(&org) == 2, 60);
            ts::return_shared(org);
        };

        // 2. 攻击者尝试将原本只在 Epoch 1 签发的签名 sig1，在 Epoch 2 (Nonce 3) 重新提交执行！
        // 由于域隔离哈希中强绑定了 epoch_version，哈希不匹配，原生 Ed25519 必然拒绝！
        ts::next_tx(&mut scenario, ALICE);
        {
            let mut org = ts::take_shared<Organization>(&scenario);
            cryptographic_org::execute_threshold_proposal(
                &mut org,
                3, // 新 nonce
                msg,
                sig1, // 旧纪元签名
                1,
                ts::ctx(&mut scenario)
            );
            ts::return_shared(org);
        };

        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = agent_vault::cryptographic_org::E_INVALID_SIGNATURE)]
    fun test_cryptographic_org_cross_org_replay_rejected() {
        let mut scenario = ts::begin(ALICE);

        let pk = vector[
            138, 136, 227, 221, 116, 9, 241, 149, 253, 82, 219, 45, 60, 186, 93, 114,
            202, 103, 9, 191, 29, 148, 18, 27, 243, 116, 136, 1, 180, 15, 111, 92
        ];
        let msg = vector[
            104, 101, 108, 108, 111, 95, 115, 117, 105, 95, 102, 114, 111, 115, 116, 95,
            116, 104, 114, 101, 115, 104, 111, 108, 100, 95, 97, 99, 116, 105, 111, 110
        ];
        let sig1 = vector[
            29, 118, 42, 8, 14, 38, 15, 162, 200, 241, 83, 176, 80, 171, 212, 141,
            208, 62, 59, 155, 106, 173, 79, 184, 1, 200, 166, 120, 116, 160, 175, 187,
            118, 46, 138, 173, 227, 45, 187, 9, 199, 218, 171, 113, 155, 25, 44, 74,
            91, 225, 253, 9, 3, 99, 242, 231, 15, 199, 71, 242, 31, 155, 54, 1
        ];

        let members = vector[ALICE, BOB];
        let weights = vector[60, 40];

        // 1. 创建组织 A (其 Org ID 绑定在 sig1 的签名摘要中)
        let _org_a = cryptographic_org::create_organization_for_testing(
            pk,
            2,
            70,
            members,
            weights,
            ts::ctx(&mut scenario)
        );

        // 2. 创建组织 B (同公钥，但拥有独立不同的 Org ID)
        let _org_b = cryptographic_org::create_organization_for_testing(
            pk,
            2,
            70,
            members,
            weights,
            ts::ctx(&mut scenario)
        );

        // 3. 攻击者截获组织 A 的门限签名 sig1，尝试拿到组织 B 上执行！
        // 期望：由于域隔离哈希中强绑定了 org_id，哈希不一致，必须 abort E_INVALID_SIGNATURE
        ts::next_tx(&mut scenario, ALICE);
        {
            let mut org = ts::take_shared<Organization>(&scenario);
            cryptographic_org::execute_threshold_proposal(
                &mut org,
                1,
                msg,
                sig1,
                1,
                ts::ctx(&mut scenario)
            );
            ts::return_shared(org);
        };

        ts::end(scenario);
    }

    #[test]
    fun test_cryptographic_org_rotate_group_key_and_execution_under_new_key() {
        let mut scenario = ts::begin(ALICE);

        let old_pk = vector[
            138, 136, 227, 221, 116, 9, 241, 149, 253, 82, 219, 45, 60, 186, 93, 114,
            202, 103, 9, 191, 29, 148, 18, 27, 243, 116, 136, 1, 180, 15, 111, 92
        ];
        let new_pk = vector[
            129, 57, 119, 14, 168, 125, 23, 95, 86, 163, 84, 102, 195, 76, 126, 204,
            203, 141, 138, 145, 180, 238, 55, 162, 93, 246, 15, 91, 143, 201, 179, 148
        ];
        let msg = vector[
            104, 101, 108, 108, 111, 95, 115, 117, 105, 95, 102, 114, 111, 115, 116, 95,
            116, 104, 114, 101, 115, 104, 111, 108, 100, 95, 97, 99, 116, 105, 111, 110
        ];
        let sig1 = vector[
            29, 118, 42, 8, 14, 38, 15, 162, 200, 241, 83, 176, 80, 171, 212, 141,
            208, 62, 59, 155, 106, 173, 79, 184, 1, 200, 166, 120, 116, 160, 175, 187,
            118, 46, 138, 173, 227, 45, 187, 9, 199, 218, 171, 113, 155, 25, 44, 74,
            91, 225, 253, 9, 3, 99, 242, 231, 15, 199, 71, 242, 31, 155, 54, 1
        ];
        let sig_rotate = vector[
            209, 81, 226, 250, 8, 158, 74, 142, 48, 133, 56, 22, 121, 83, 89, 58,
            70, 171, 179, 191, 48, 247, 59, 206, 47, 166, 177, 117, 222, 106, 174, 74,
            209, 167, 64, 74, 22, 208, 154, 166, 161, 47, 178, 118, 211, 196, 108, 204,
            83, 195, 27, 1, 71, 56, 17, 185, 32, 216, 41, 90, 166, 168, 143, 9
        ];
        let sig_with_new_key = vector[
            107, 120, 252, 152, 125, 156, 147, 243, 207, 251, 42, 89, 13, 131, 136, 71,
            168, 42, 108, 27, 48, 175, 91, 25, 41, 92, 222, 103, 50, 56, 155, 75,
            93, 47, 37, 98, 217, 149, 194, 142, 166, 112, 156, 106, 127, 151, 213, 71,
            181, 144, 67, 87, 32, 252, 174, 145, 26, 130, 210, 170, 116, 203, 193, 9
        ];

        let members = vector[ALICE, BOB];
        let weights = vector[60, 40];

        let _org_id = cryptographic_org::create_organization_for_testing(
            old_pk,
            2,
            70,
            members,
            weights,
            ts::ctx(&mut scenario)
        );

        // 1. 在 Epoch 1 执行旧公钥签名提案 (Nonce 1)
        ts::next_tx(&mut scenario, ALICE);
        {
            let mut org = ts::take_shared<Organization>(&scenario);
            cryptographic_org::execute_threshold_proposal(
                &mut org,
                1,
                msg,
                sig1,
                1,
                ts::ctx(&mut scenario)
            );
            assert!(cryptographic_org::last_nonce(&org) == 1, 70);
            assert!(cryptographic_org::epoch_version(&org) == 1, 71);
            assert!(cryptographic_org::group_pk(&org) == old_pk, 72);
            ts::return_shared(org);
        };

        // 2. 执行 rotate_group_key 彻底轮换主公钥 (Nonce 2)
        ts::next_tx(&mut scenario, ALICE);
        {
            let mut org = ts::take_shared<Organization>(&scenario);
            cryptographic_org::rotate_group_key_for_testing(
                &mut org,
                2,
                new_pk,
                vector[ALICE, BOB],
                2,
                ts::ctx(&mut scenario)
            );
            assert!(cryptographic_org::last_nonce(&org) == 2, 73);
            assert!(cryptographic_org::epoch_version(&org) == 2, 74);
            assert!(cryptographic_org::group_pk(&org) == new_pk, 75);
            ts::return_shared(org);
        };

        // 3. 在 Epoch 2 使用新公钥授权执行新提案 (Nonce 3)
        ts::next_tx(&mut scenario, ALICE);
        {
            let mut org = ts::take_shared<Organization>(&scenario);
            let org_id = cryptographic_org::org_id(&org);
            let digest3 = cryptographic_org::compute_proposal_digest(
                &cryptographic_org::chain_id(&org),
                org_id,
                2,
                3,
                &msg,
                1
            );

            cryptographic_org::execute_threshold_proposal(
                &mut org,
                3,
                msg,
                sig_with_new_key,
                1,
                ts::ctx(&mut scenario)
            );

            assert!(cryptographic_org::is_proposal_executed(&org, digest3), 76);
            assert!(cryptographic_org::last_nonce(&org) == 3, 77);
            ts::return_shared(org);
        };

        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = agent_vault::cryptographic_org::E_INVALID_POP)]
    fun test_cryptographic_org_rotate_group_key_invalid_signature_fails() {
        let mut scenario = ts::begin(ALICE);

        let old_pk = vector[
            138, 136, 227, 221, 116, 9, 241, 149, 253, 82, 219, 45, 60, 186, 93, 114,
            202, 103, 9, 191, 29, 148, 18, 27, 243, 116, 136, 1, 180, 15, 111, 92
        ];
        let new_pk = vector[
            129, 57, 119, 14, 168, 125, 23, 95, 86, 163, 84, 102, 195, 76, 126, 204,
            203, 141, 138, 145, 180, 238, 55, 162, 93, 246, 15, 91, 143, 201, 179, 148
        ];
        // 篡改最后一个字节：9 -> 10
        let bad_sig_rotate = vector[
            209, 81, 226, 250, 8, 158, 74, 142, 48, 133, 56, 22, 121, 83, 89, 58,
            70, 171, 179, 191, 48, 247, 59, 206, 47, 166, 177, 117, 222, 106, 174, 74,
            209, 167, 64, 74, 22, 208, 154, 166, 161, 47, 178, 118, 211, 196, 108, 204,
            83, 195, 27, 1, 71, 56, 17, 185, 32, 216, 41, 90, 166, 168, 143, 10
        ];

        let members = vector[ALICE, BOB];
        let weights = vector[60, 40];

        let _org_id = cryptographic_org::create_organization_for_testing(
            old_pk,
            2,
            70,
            members,
            weights,
            ts::ctx(&mut scenario)
        );

        // 尝试使用篡改后的签名进行公钥轮换，必须 abort E_INVALID_SIGNATURE
        ts::next_tx(&mut scenario, ALICE);
        {
            let mut org = ts::take_shared<Organization>(&scenario);
            cryptographic_org::rotate_group_key(
                &mut org,
                1,
                new_pk,
                vector[ALICE, BOB],
                2,
                bad_sig_rotate,
                bad_sig_rotate,
                ts::ctx(&mut scenario)
            );
            ts::return_shared(org);
        };

        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = agent_vault::cryptographic_org::E_INVALID_SIGNATURE)]
    fun test_cryptographic_org_old_key_cannot_sign_after_rotation() {
        let mut scenario = ts::begin(ALICE);

        let old_pk = vector[
            138, 136, 227, 221, 116, 9, 241, 149, 253, 82, 219, 45, 60, 186, 93, 114,
            202, 103, 9, 191, 29, 148, 18, 27, 243, 116, 136, 1, 180, 15, 111, 92
        ];
        let new_pk = vector[
            129, 57, 119, 14, 168, 125, 23, 95, 86, 163, 84, 102, 195, 76, 126, 204,
            203, 141, 138, 145, 180, 238, 55, 162, 93, 246, 15, 91, 143, 201, 179, 148
        ];
        let msg = vector[
            104, 101, 108, 108, 111, 95, 115, 117, 105, 95, 102, 114, 111, 115, 116, 95,
            116, 104, 114, 101, 115, 104, 111, 108, 100, 95, 97, 99, 116, 105, 111, 110
        ];
        let sig_rotate = vector[
            209, 81, 226, 250, 8, 158, 74, 142, 48, 133, 56, 22, 121, 83, 89, 58,
            70, 171, 179, 191, 48, 247, 59, 206, 47, 166, 177, 117, 222, 106, 174, 74,
            209, 167, 64, 74, 22, 208, 154, 166, 161, 47, 178, 118, 211, 196, 108, 204,
            83, 195, 27, 1, 71, 56, 17, 185, 32, 216, 41, 90, 166, 168, 143, 9
        ];
        let sig_with_old_key = vector[
            1, 214, 45, 225, 51, 207, 255, 83, 57, 73, 135, 85, 6, 113, 57, 168,
            239, 13, 223, 130, 170, 33, 162, 127, 215, 204, 55, 29, 133, 181, 137, 63,
            149, 93, 26, 174, 238, 8, 232, 196, 14, 69, 83, 142, 5, 55, 84, 194,
            69, 109, 155, 61, 89, 147, 110, 139, 55, 176, 100, 166, 225, 244, 214, 7
        ];

        let members = vector[ALICE, BOB];
        let weights = vector[60, 40];

        let _org_id = cryptographic_org::create_organization_for_testing(
            old_pk,
            2,
            70,
            members,
            weights,
            ts::ctx(&mut scenario)
        );

        // 1. 成功轮换为 new_pk (Nonce 1)
        ts::next_tx(&mut scenario, ALICE);
        {
            let mut org = ts::take_shared<Organization>(&scenario);
            cryptographic_org::rotate_group_key_for_testing(
                &mut org,
                1,
                new_pk,
                vector[ALICE, BOB],
                2,
                ts::ctx(&mut scenario)
            );
            ts::return_shared(org);
        };

        // 2. 轮换后，攻击者或被移除的成员尝试用旧私钥签名新提案 (Nonce 2)！
        // 期望：由于公钥已彻底替换为 new_pk，旧签名验证失败，必须 abort E_INVALID_SIGNATURE
        ts::next_tx(&mut scenario, ALICE);
        {
            let mut org = ts::take_shared<Organization>(&scenario);
            cryptographic_org::execute_threshold_proposal(
                &mut org,
                2,
                msg,
                sig_with_old_key,
                1,
                ts::ctx(&mut scenario)
            );
            ts::return_shared(org);
        };

        ts::end(scenario);
    }
}

