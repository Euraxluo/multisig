#[test_only]
module agent_vault::dkg_committee_tests {
    use sui::test_scenario::{Self as ts};
    use sui::clock::{Self, Clock};
    use sui::event;
    use sui::coin::{Self};
    use sui::sui::SUI;
    use sui::tx_context::TxContext;
    use agent_vault::dkg_committee::{Self, DkgSession};
    use agent_vault::asynchronous_proposal::{Self, Proposal, SubagentCoSignCap, AsyncVoteRejectedEvent};
    use agent_vault::vault::{Self, AgentVault, MasterCap};
    use agent_vault::cryptographic_org::{Self, Organization};

    const ALICE: address = @0xA11CE;
    const ATTEST_PK: vector<u8> = x"4141414141414141414141414141414141414141414141414141414141414141";
    // Round-7 test constants: a finalized group key for the org-creation tests
    // and a 32-byte X25519 mailbox key for the dual-stack registration test.
    const GROUP_PK_7: vector<u8> = x"7b6a27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da99";
    const X25519_KEY_7: vector<u8> = x"112233445566778899001122334455667788990011223344556677889900aabb";
    const VALID_KEY_65: vector<u8> = x"0401010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101";
    fun fee_coin(ctx: &mut TxContext): coin::Coin<SUI> {
        coin::mint_for_testing<SUI>(dkg_committee::creation_fee_mist(), ctx)
    }

    fun bond_coin(ctx: &mut TxContext): coin::Coin<SUI> {
        let (min_bond, _max) = dkg_committee::bond_bounds();
        coin::mint_for_testing<SUI>(min_bond, ctx)
    }

    fun zero_coin(ctx: &mut TxContext): coin::Coin<SUI> {
        coin::mint_for_testing<SUI>(0, ctx)
    }

    /// T2-a 后投递前置条件：recipient 必须已登记信箱加密公钥。
    fun reg_key(s: &mut ts::Scenario, session: &mut DkgSession, clock: &Clock, who: address) {
        ts::next_tx(s, who);
        dkg_committee::register_encryption_key(session, clock, X25519_KEY_7, ts::ctx(s));
    }

    const BOB: address = @0xB0B;
    const CHARLIE: address = @0xC0C;
    const DAVID_OFFLINE: address = @0xDA71D;
    const EVE_ATTACKER: address = @0xEE7E;
    const VENDOR: address = @0x9999;
    const SUBAGENT_ALICE: address = @0x50B_A11CE;

    use fun rejection_fixture_reject as RejectionFixture.reject;
    use fun rejection_fixture_approve as RejectionFixture.approve;
    use fun rejection_fixture_subagent_approve as RejectionFixture.subagent_approve;
    use fun rejection_fixture_execute as RejectionFixture.execute;
    use fun rejection_fixture_assert_state as RejectionFixture.assert_state;
    use fun rejection_fixture_assert_voter as RejectionFixture.assert_voter;
    use fun rejection_fixture_set_time as RejectionFixture.set_time;
    use fun rejection_fixture_advance_epoch as RejectionFixture.advance_epoch;
    use fun rejection_fixture_reject_other_org as RejectionFixture.reject_other_org;
    use fun rejection_fixture_assert_vault as RejectionFixture.assert_vault;
    use fun rejection_fixture_end as RejectionFixture.end;

    #[test]
    fun test_dkg_session_create_and_commitments() {
        let mut scenario = ts::begin(ALICE);
        let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 1_000_000);

        let participants = vector[ALICE, BOB, CHARLIE, DAVID_OFFLINE];
        let deadline = 2_000_000;

        let _session_id = dkg_committee::create_dkg_session(
            3,
            participants,
            deadline,
            fee_coin(ts::ctx(&mut scenario)), &clock, ts::ctx(&mut scenario)
        );

        ts::next_tx(&mut scenario, ALICE);
        {
            let mut session = ts::take_shared<DkgSession>(&scenario);
            assert!(dkg_committee::status(&session) == 1, 101);

            dkg_committee::submit_commitment(
                &mut session,
                &clock,
                x"0102030405060708091011121314151617181920212223242526272829303132", ATTEST_PK, bond_coin(ts::ctx(&mut scenario)), ts::ctx(&mut scenario)
            );
            ts::return_shared(session);
        };

        ts::next_tx(&mut scenario, BOB);
        {
            let mut session = ts::take_shared<DkgSession>(&scenario);
            dkg_committee::submit_commitment(
                &mut session,
                &clock,
                x"1102030405060708091011121314151617181920212223242526272829303132", ATTEST_PK, bond_coin(ts::ctx(&mut scenario)), ts::ctx(&mut scenario)
            );
            ts::return_shared(session);
        };

        ts::next_tx(&mut scenario, CHARLIE);
        {
            let mut session = ts::take_shared<DkgSession>(&scenario);
            dkg_committee::submit_commitment(
                &mut session,
                &clock,
                x"2102030405060708091011121314151617181920212223242526272829303132", ATTEST_PK, bond_coin(ts::ctx(&mut scenario)), ts::ctx(&mut scenario)
            );
            assert!(dkg_committee::status(&session) == 2, 102);
            ts::return_shared(session);
        };

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    #[test]
    fun test_dkg_async_mailbox_and_quorum_finalization_with_offline_member() {
        let mut scenario = ts::begin(ALICE);
        let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 1_000_000);

        let participants = vector[ALICE, BOB, CHARLIE, DAVID_OFFLINE];
        let deadline = 2_000_000;

        dkg_committee::create_dkg_session(3, participants, deadline, fee_coin(ts::ctx(&mut scenario)), &clock, ts::ctx(&mut scenario));

        // T2-a 门禁：全员先登记信箱加密公钥，随后投递才被接受
        ts::next_tx(&mut scenario, ALICE);
        {
            let mut session = ts::take_shared<DkgSession>(&scenario);
            dkg_committee::register_encryption_key(&mut session, &clock, X25519_KEY_7, ts::ctx(&mut scenario));
            ts::return_shared(session);
        };
        ts::next_tx(&mut scenario, BOB);
        {
            let mut session = ts::take_shared<DkgSession>(&scenario);
            dkg_committee::register_encryption_key(&mut session, &clock, X25519_KEY_7, ts::ctx(&mut scenario));
            ts::return_shared(session);
        };
        ts::next_tx(&mut scenario, CHARLIE);
        {
            let mut session = ts::take_shared<DkgSession>(&scenario);
            dkg_committee::register_encryption_key(&mut session, &clock, X25519_KEY_7, ts::ctx(&mut scenario));
            ts::return_shared(session);
        };
        ts::next_tx(&mut scenario, DAVID_OFFLINE);
        {
            let mut session = ts::take_shared<DkgSession>(&scenario);
            dkg_committee::register_encryption_key(&mut session, &clock, X25519_KEY_7, ts::ctx(&mut scenario));
            ts::return_shared(session);
        };

        // 1. Alice, Bob, Charlie 提交承诺
        ts::next_tx(&mut scenario, ALICE);
        {
            let mut session = ts::take_shared<DkgSession>(&scenario);
            dkg_committee::submit_commitment(&mut session, &clock, x"aaaa000000000000000000000000000000000000000000000000000000000000", ATTEST_PK, bond_coin(ts::ctx(&mut scenario)), ts::ctx(&mut scenario));
            ts::return_shared(session);
        };
        ts::next_tx(&mut scenario, BOB);
        {
            let mut session = ts::take_shared<DkgSession>(&scenario);
            dkg_committee::submit_commitment(&mut session, &clock, x"bbbb000000000000000000000000000000000000000000000000000000000000", ATTEST_PK, bond_coin(ts::ctx(&mut scenario)), ts::ctx(&mut scenario));
            ts::return_shared(session);
        };
        ts::next_tx(&mut scenario, CHARLIE);
        {
            let mut session = ts::take_shared<DkgSession>(&scenario);
            dkg_committee::submit_commitment(&mut session, &clock, x"cccc000000000000000000000000000000000000000000000000000000000000", ATTEST_PK, bond_coin(ts::ctx(&mut scenario)), ts::ctx(&mut scenario));
            ts::return_shared(session);
        };

        // 2. David 此时处于离线状态 (比如在睡觉或无网络)
        // Alice 为离线成员 David 存入 HPKE 密态分片
        ts::next_tx(&mut scenario, ALICE);
        {
            let mut session = ts::take_shared<DkgSession>(&scenario);
            let encrypted_david_share = x"7365637265745f666f725f64617669645f68706b655f7061796c6f6164";
            dkg_committee::deposit_mailbox_share(
                &mut session,
                &clock,
                DAVID_OFFLINE,
                encrypted_david_share,
                ts::ctx(&mut scenario)
            );
            assert!(dkg_committee::has_mailbox_share(&session, ALICE, DAVID_OFFLINE), 201);
            ts::return_shared(session);
        };

        // 3. 在线成员 Alice, Bob, Charlie 分别确认分片收到
        ts::next_tx(&mut scenario, ALICE);
        {
            let mut session = ts::take_shared<DkgSession>(&scenario);
            dkg_committee::confirm_participant(&mut session, &clock, ts::ctx(&mut scenario));
            assert!(dkg_committee::confirmations_count(&session) == 1, 202);
            ts::return_shared(session);
        };

        ts::next_tx(&mut scenario, BOB);
        {
            let mut session = ts::take_shared<DkgSession>(&scenario);
            dkg_committee::confirm_participant(&mut session, &clock, ts::ctx(&mut scenario));
            assert!(dkg_committee::confirmations_count(&session) == 2, 203);
            ts::return_shared(session);
        };

        ts::next_tx(&mut scenario, CHARLIE);
        {
            let mut session = ts::take_shared<DkgSession>(&scenario);
            dkg_committee::confirm_participant(&mut session, &clock, ts::ctx(&mut scenario));
            assert!(dkg_committee::confirmations_count(&session) == 3, 204);

            let group_pk = x"3b6a27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da29";
            dkg_committee::finalize_session_for_testing(&mut session, group_pk, ts::ctx(&mut scenario));

            assert!(dkg_committee::status(&session) == 3, 205);
            assert!(dkg_committee::final_public_key(&session) == group_pk, 206);
            ts::return_shared(session);
        };

        // 4. 离线成员 David 醒来后，从信箱中提取属于自己的密态分片
        ts::next_tx(&mut scenario, DAVID_OFFLINE);
        {
            let session = ts::take_shared<DkgSession>(&scenario);
            assert!(dkg_committee::has_mailbox_share(&session, ALICE, DAVID_OFFLINE), 207);
            let retrieved_share = dkg_committee::get_mailbox_share(&session, ALICE, DAVID_OFFLINE);
            assert!(retrieved_share == x"7365637265745f666f725f64617669645f68706b655f7061796c6f6164", 208);
            ts::return_shared(session);
        };

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    #[test]
    /// 同一 (sender, recipient) 信箱槽位重复投递必须显式 abort (E_MAILBOX_ALREADY_DEPOSITED)，
    /// 而不是静默跳过让发件人误以为密文已替换。
    #[expected_failure(abort_code = agent_vault::dkg_committee::E_MAILBOX_ALREADY_DEPOSITED)]
    fun test_duplicate_mailbox_deposit_aborts() {
        let mut scenario = ts::begin(ALICE);
        let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 1_000_000);

        let participants = vector[ALICE, BOB, CHARLIE];
        dkg_committee::create_dkg_session(2, participants, 2_000_000, fee_coin(ts::ctx(&mut scenario)), &clock, ts::ctx(&mut scenario));

        ts::next_tx(&mut scenario, BOB);
        {
            let mut session = ts::take_shared<DkgSession>(&scenario);
            dkg_committee::register_encryption_key(&mut session, &clock, X25519_KEY_7, ts::ctx(&mut scenario));
            ts::return_shared(session);
        };

        ts::next_tx(&mut scenario, ALICE);
        {
            let mut session = ts::take_shared<DkgSession>(&scenario);
            dkg_committee::deposit_mailbox_share(
                &mut session,
                &clock,
                BOB,
                b"first_payload",
                ts::ctx(&mut scenario)
            );
            // 同槽位第二次投递：必须 abort 3019，链上仍保留首写密文
            dkg_committee::deposit_mailbox_share(
                &mut session,
                &clock,
                BOB,
                b"second_payload",
                ts::ctx(&mut scenario)
            );
            ts::return_shared(session);
        };

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    #[test]
    fun test_fully_async_single_shot_submission() {
        let mut scenario = ts::begin(ALICE);
        let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 1_000_000);

        let participants = vector[ALICE, BOB, CHARLIE, DAVID_OFFLINE];
        let deadline = 2_000_000;

        dkg_committee::create_dkg_session(3, participants, deadline, fee_coin(ts::ctx(&mut scenario)), &clock, ts::ctx(&mut scenario));

        // T2-a 门禁：全员登记信箱加密公钥
        ts::next_tx(&mut scenario, BOB);
        {
            let mut session = ts::take_shared<DkgSession>(&scenario);
            dkg_committee::register_encryption_key(&mut session, &clock, X25519_KEY_7, ts::ctx(&mut scenario));
            ts::return_shared(session);
        };
        ts::next_tx(&mut scenario, CHARLIE);
        {
            let mut session = ts::take_shared<DkgSession>(&scenario);
            dkg_committee::register_encryption_key(&mut session, &clock, X25519_KEY_7, ts::ctx(&mut scenario));
            ts::return_shared(session);
        };
        ts::next_tx(&mut scenario, DAVID_OFFLINE);
        {
            let mut session = ts::take_shared<DkgSession>(&scenario);
            dkg_committee::register_encryption_key(&mut session, &clock, X25519_KEY_7, ts::ctx(&mut scenario));
            ts::return_shared(session);
        };
        ts::next_tx(&mut scenario, ALICE);
        {
            let mut session = ts::take_shared<DkgSession>(&scenario);
            dkg_committee::register_encryption_key(&mut session, &clock, X25519_KEY_7, ts::ctx(&mut scenario));
            ts::return_shared(session);
        };

        // 1. 东京 09:00: Alice 独自一人在线，一次性提交承诺与所有人的信箱分片，随后退出
        ts::next_tx(&mut scenario, ALICE);
        {
            let mut session = ts::take_shared<DkgSession>(&scenario);
            let recipients = vector[BOB, CHARLIE, DAVID_OFFLINE];
            let payloads = vector[x"1111", x"2222", x"3333"];
            dkg_committee::submit_async_package(
                &mut session,
                &clock,
                x"aaaa000000000000000000000000000000000000000000000000000000000000", ATTEST_PK,
                recipients,
                payloads,
                bond_coin(ts::ctx(&mut scenario)), ts::ctx(&mut scenario)
            );
            ts::return_shared(session);
        };

        // 2. 伦敦 14:00: Bob 独自上线，提交自身分片包并确认
        ts::next_tx(&mut scenario, BOB);
        {
            let mut session = ts::take_shared<DkgSession>(&scenario);
            // 验证收到了 Alice 寄来的分片
            assert!(dkg_committee::has_mailbox_share(&session, ALICE, BOB), 301);
            assert!(dkg_committee::get_mailbox_share(&session, ALICE, BOB) == x"1111", 302);

            let recipients = vector[ALICE, CHARLIE, DAVID_OFFLINE];
            let payloads = vector[x"4444", x"5555", x"6666"];
            dkg_committee::submit_async_package(
                &mut session,
                &clock,
                x"bbbb000000000000000000000000000000000000000000000000000000000000", ATTEST_PK,
                recipients,
                payloads,
                bond_coin(ts::ctx(&mut scenario)), ts::ctx(&mut scenario)
            );
            dkg_committee::confirm_participant(&mut session, &clock, ts::ctx(&mut scenario));
            ts::return_shared(session);
        };

        // 3. 纽约 20:00: Charlie 独自上线，提交分片包并确认 -> 触发 3/4 门限一键固化！
        ts::next_tx(&mut scenario, CHARLIE);
        {
            let mut session = ts::take_shared<DkgSession>(&scenario);
            let recipients = vector[ALICE, BOB, DAVID_OFFLINE];
            let payloads = vector[x"7777", x"8888", x"9999"];
            dkg_committee::submit_async_package(
                &mut session,
                &clock,
                x"cccc000000000000000000000000000000000000000000000000000000000000", ATTEST_PK,
                recipients,
                payloads,
                bond_coin(ts::ctx(&mut scenario)), ts::ctx(&mut scenario)
            );
            dkg_committee::confirm_participant(&mut session, &clock, ts::ctx(&mut scenario));

            // Alice 在其时区随后补上确认
            ts::return_shared(session);
        };

        ts::next_tx(&mut scenario, ALICE);
        {
            let mut session = ts::take_shared<DkgSession>(&scenario);
            dkg_committee::confirm_participant(&mut session, &clock, ts::ctx(&mut scenario));
            assert!(dkg_committee::confirmations_count(&session) == 3, 303);

            let group_pk = x"3b6a27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da29";
            dkg_committee::finalize_session_for_testing(&mut session, group_pk, ts::ctx(&mut scenario));
            assert!(dkg_committee::status(&session) == 3, 304);
            ts::return_shared(session);
        };

        // 4. 悉尼 次日 08:00: David 醒来，从信箱提取属于自己的 3 份分片
        ts::next_tx(&mut scenario, DAVID_OFFLINE);
        {
            let session = ts::take_shared<DkgSession>(&scenario);
            assert!(dkg_committee::get_mailbox_share(&session, ALICE, DAVID_OFFLINE) == x"3333", 305);
            assert!(dkg_committee::get_mailbox_share(&session, BOB, DAVID_OFFLINE) == x"6666", 306);
            assert!(dkg_committee::get_mailbox_share(&session, CHARLIE, DAVID_OFFLINE) == x"9999", 307);
            ts::return_shared(session);
        };

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    fun create_test_org(scenario: &mut ts::Scenario): ID {
        let dummy_pk = b"12345678901234567890123456789012";
        let members = vector[ALICE, BOB, CHARLIE];
        let weights = vector[2, 2, 2];
        cryptographic_org::create_organization_for_testing(
            dummy_pk,
            2,
            3,
            members,
            weights,
            ts::ctx(scenario)
        )
    }

    #[test]
    #[expected_failure(abort_code = agent_vault::asynchronous_proposal::E_ZERO_RECIPIENT,
        location = agent_vault::asynchronous_proposal)]
    fun transfer_proposal_rejects_the_zero_recipient() {
        // Paying 0x0 would burn the withdrawn coin while the proposal still
        // reads as a normal approved transfer.
        let mut scenario = ts::begin(ALICE);
        let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 1_000_000);
        let _org_id = create_test_org(&mut scenario);
        ts::next_tx(&mut scenario, ALICE);
        {
            let org = ts::take_shared<Organization>(&scenario);
            let _ = asynchronous_proposal::create_transfer_proposal(
                &org, b"Burned", @0x0, 300, 2_000_000, &clock, ts::ctx(&mut scenario),
            );
            ts::return_shared(org);
        };
        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = agent_vault::asynchronous_proposal::E_ZERO_AMOUNT,
        location = agent_vault::asynchronous_proposal)]
    fun transfer_proposal_rejects_a_zero_amount() {
        // A zero-amount proposal aborts inside `vault::withdraw` on every
        // execution attempt, leaving a threshold-approved but dead proposal.
        let mut scenario = ts::begin(ALICE);
        let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 1_000_000);
        let _org_id = create_test_org(&mut scenario);
        ts::next_tx(&mut scenario, ALICE);
        {
            let org = ts::take_shared<Organization>(&scenario);
            let _ = asynchronous_proposal::create_transfer_proposal(
                &org, b"Nothing", VENDOR, 0, 2_000_000, &clock, ts::ctx(&mut scenario),
            );
            ts::return_shared(org);
        };
        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = agent_vault::asynchronous_proposal::E_DEADLINE_IN_THE_PAST,
        location = agent_vault::asynchronous_proposal)]
    fun transfer_proposal_rejects_a_past_deadline() {
        // An already-expired proposal can never execute, and the guard reads the
        // clock rather than trusting the caller to pick a future timestamp.
        let mut scenario = ts::begin(ALICE);
        let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 2_000_000);
        let _org_id = create_test_org(&mut scenario);
        ts::next_tx(&mut scenario, ALICE);
        {
            let org = ts::take_shared<Organization>(&scenario);
            let _ = asynchronous_proposal::create_transfer_proposal(
                &org, b"Too late", VENDOR, 300, 1_000_000, &clock, ts::ctx(&mut scenario),
            );
            ts::return_shared(org);
        };
        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    #[test]
    fun test_asynchronous_proposal_governance() {
        let mut scenario = ts::begin(ALICE);
        let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 1_000_000);

        // 1. 初始化国库金库，存入 1000 SUI，并初始化测试组织 Organization
        let master_cap = vault::initialize_vault<SUI>(ts::ctx(&mut scenario));
        let _org_id = create_test_org(&mut scenario);

        ts::next_tx(&mut scenario, ALICE);
        {
            let mut vault = ts::take_shared<AgentVault<SUI>>(&scenario);
            let coin = coin::mint_for_testing<SUI>(1000, ts::ctx(&mut scenario));
            vault::deposit(&mut vault, coin);
            ts::return_shared(vault);
        };

        // 2. Alice 异步发起转账 300 SUI 给 VENDOR 的治理提案 (严格绑定 Organization 名册)
        ts::next_tx(&mut scenario, ALICE);
        {
            let org = ts::take_shared<Organization>(&scenario);
            let _proposal_id = asynchronous_proposal::create_transfer_proposal(
                &org,
                b"Vendor Infrastructure Payment",
                VENDOR,
                300,
                2_000_000,
                &clock,
                ts::ctx(&mut scenario)
            );
            ts::return_shared(org);
        };

        // 3. 伦敦 14:00: Bob 异步提交赞成票 (名册权重 2)
        ts::next_tx(&mut scenario, BOB);
        {
            let mut proposal = ts::take_shared<Proposal>(&scenario);
            let org = ts::take_shared<Organization>(&scenario);
            asynchronous_proposal::submit_async_vote(
                &mut proposal,
                &org,
                &clock,
                2,
                b"partial_sig_bob",
                ts::ctx(&mut scenario)
            );
            assert!(asynchronous_proposal::accumulated_weight(&proposal) == 2, 401);
            ts::return_shared(org);
            ts::return_shared(proposal);
        };

        // 4. 纽约 20:00: Charlie 异步提交赞成票 (名册权重 2) -> 累积 4 票 >= 门限 3
        ts::next_tx(&mut scenario, CHARLIE);
        {
            let mut proposal = ts::take_shared<Proposal>(&scenario);
            let org = ts::take_shared<Organization>(&scenario);
            asynchronous_proposal::submit_async_vote(
                &mut proposal,
                &org,
                &clock,
                2,
                b"partial_sig_charlie",
                ts::ctx(&mut scenario)
            );
            assert!(asynchronous_proposal::accumulated_weight(&proposal) == 4, 402);
            ts::return_shared(org);
            ts::return_shared(proposal);
        };

        // 5. 任何人在任意时刻调用 execute_transfer_proposal 完成转账
        ts::next_tx(&mut scenario, ALICE);
        {
            let mut proposal = ts::take_shared<Proposal>(&scenario);
            let mut org = ts::take_shared<Organization>(&scenario);
            let mut vault = ts::take_shared<AgentVault<SUI>>(&scenario);

            asynchronous_proposal::execute_transfer_proposal_for_testing<SUI>(
                &mut proposal,
                &mut org,
                &mut vault,
                &master_cap,
                1,
                &clock,
                ts::ctx(&mut scenario)
            );

            assert!(asynchronous_proposal::status(&proposal) == 2, 403); // STATUS_EXECUTED
            assert!(vault::vault_balance(&vault) == 700, 404); // 1000 - 300 = 700

            ts::return_shared(vault);
            ts::return_shared(org);
            ts::return_shared(proposal);
        };

        // 6. 验证供应商 VENDOR 成功收到 300 SUI
        ts::next_tx(&mut scenario, VENDOR);
        {
            let vendor_coin = ts::take_from_sender<coin::Coin<SUI>>(&scenario);
            assert!(coin::value(&vendor_coin) == 300, 405);
            ts::return_to_sender(&scenario, vendor_coin);
        };

        clock::destroy_for_testing(clock);
        vault::destroy_master_cap_for_testing(master_cap);
        ts::end(scenario);
    }

    #[test]
    fun test_dkg_session_timeout() {
        let mut scenario = ts::begin(ALICE);
        let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 1_000_000);

        let participants = vector[ALICE, BOB, CHARLIE, DAVID_OFFLINE];
        let deadline = 2_000_000;

        dkg_committee::create_dkg_session(3, participants, deadline, fee_coin(ts::ctx(&mut scenario)), &clock, ts::ctx(&mut scenario));

        ts::next_tx(&mut scenario, ALICE);
        {
            let mut session = ts::take_shared<DkgSession>(&scenario);
            dkg_committee::submit_commitment(&mut session, &clock, x"aaaa000000000000000000000000000000000000000000000000000000000000", ATTEST_PK, bond_coin(ts::ctx(&mut scenario)), ts::ctx(&mut scenario));
            ts::return_shared(session);
        };
        ts::next_tx(&mut scenario, BOB);
        {
            let mut session = ts::take_shared<DkgSession>(&scenario);
            dkg_committee::submit_commitment(&mut session, &clock, x"bbbb000000000000000000000000000000000000000000000000000000000000", ATTEST_PK, bond_coin(ts::ctx(&mut scenario)), ts::ctx(&mut scenario));
            ts::return_shared(session);
        };

        clock::set_for_testing(&mut clock, 3_000_000);

        ts::next_tx(&mut scenario, ALICE);
        {
            let mut session = ts::take_shared<DkgSession>(&scenario);
            dkg_committee::handle_session_timeout(&mut session, &clock);
            assert!(dkg_committee::status(&session) == 4, 301);
            ts::return_shared(session);
        };

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    /// #20: 会话达到门限但从未有 threshold 份群公钥申报（零 attestation）
    /// 时，超时后必须可以标记 TIMED_OUT —— 否则无密钥可固化的会话将永久卡死。
    #[test]
    fun test_dkg_session_timeout_after_quorum_without_attestation() {
        let mut scenario = ts::begin(ALICE);
        let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 1_000_000);

        let participants = vector[ALICE, BOB, CHARLIE, DAVID_OFFLINE];
        dkg_committee::create_dkg_session(3, participants, 2_000_000, fee_coin(ts::ctx(&mut scenario)), &clock, ts::ctx(&mut scenario));

        // 三人提交承诺 → 进入 Round 2
        ts::next_tx(&mut scenario, ALICE);
        {
            let mut session = ts::take_shared<DkgSession>(&scenario);
            dkg_committee::submit_commitment(&mut session, &clock, x"aaaa000000000000000000000000000000000000000000000000000000000000", ATTEST_PK, bond_coin(ts::ctx(&mut scenario)), ts::ctx(&mut scenario));
            ts::return_shared(session);
        };
        ts::next_tx(&mut scenario, BOB);
        {
            let mut session = ts::take_shared<DkgSession>(&scenario);
            dkg_committee::submit_commitment(&mut session, &clock, x"bbbb000000000000000000000000000000000000000000000000000000000000", ATTEST_PK, bond_coin(ts::ctx(&mut scenario)), ts::ctx(&mut scenario));
            ts::return_shared(session);
        };
        ts::next_tx(&mut scenario, CHARLIE);
        {
            let mut session = ts::take_shared<DkgSession>(&scenario);
            dkg_committee::submit_commitment(&mut session, &clock, x"cccc000000000000000000000000000000000000000000000000000000000000", ATTEST_PK, bond_coin(ts::ctx(&mut scenario)), ts::ctx(&mut scenario));
            ts::return_shared(session);
        };

        // 三人确认 → confirmations_count == threshold（达到门限），
        // 但没有任何人申报群公钥（零 attestation）。
        ts::next_tx(&mut scenario, ALICE);
        {
            let mut session = ts::take_shared<DkgSession>(&scenario);
            dkg_committee::confirm_participant(&mut session, &clock, ts::ctx(&mut scenario));
            ts::return_shared(session);
        };
        ts::next_tx(&mut scenario, BOB);
        {
            let mut session = ts::take_shared<DkgSession>(&scenario);
            dkg_committee::confirm_participant(&mut session, &clock, ts::ctx(&mut scenario));
            ts::return_shared(session);
        };
        ts::next_tx(&mut scenario, CHARLIE);
        {
            let mut session = ts::take_shared<DkgSession>(&scenario);
            dkg_committee::confirm_participant(&mut session, &clock, ts::ctx(&mut scenario));
            assert!(dkg_committee::confirmations_count(&session) == 3, 311);
            assert!(dkg_committee::attestations_for(&session, x"3b6a27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da29") == 0, 312);
            ts::return_shared(session);
        };

        // 超过截止时间 → 超时处理成功，不再被 E_QUORUM_NOT_REACHED 卡死
        clock::set_for_testing(&mut clock, 3_000_000);
        ts::next_tx(&mut scenario, ALICE);
        {
            let mut session = ts::take_shared<DkgSession>(&scenario);
            dkg_committee::handle_session_timeout(&mut session, &clock);
            assert!(dkg_committee::status(&session) == 4, 313);
            ts::return_shared(session);
        };

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    /// #20: 已 FINALIZED 的会话仍然拒绝超时处理（状态保护不变）。
    #[test]
    #[expected_failure(abort_code = agent_vault::dkg_committee::E_INVALID_SESSION_STATUS)]
    fun test_finalized_session_still_refuses_timeout() {
        let mut scenario = ts::begin(ALICE);
        let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 1_000_000);

        let participants = vector[ALICE, BOB, CHARLIE];
        dkg_committee::create_dkg_session(2, participants, 2_000_000, fee_coin(ts::ctx(&mut scenario)), &clock, ts::ctx(&mut scenario));

        ts::next_tx(&mut scenario, ALICE);
        {
            let mut session = ts::take_shared<DkgSession>(&scenario);
            dkg_committee::submit_commitment(&mut session, &clock, x"aaaa000000000000000000000000000000000000000000000000000000000000", ATTEST_PK, bond_coin(ts::ctx(&mut scenario)), ts::ctx(&mut scenario));
            ts::return_shared(session);
        };
        ts::next_tx(&mut scenario, BOB);
        {
            let mut session = ts::take_shared<DkgSession>(&scenario);
            dkg_committee::submit_commitment(&mut session, &clock, x"bbbb000000000000000000000000000000000000000000000000000000000000", ATTEST_PK, bond_coin(ts::ctx(&mut scenario)), ts::ctx(&mut scenario));
            dkg_committee::confirm_participant(&mut session, &clock, ts::ctx(&mut scenario));
            ts::return_shared(session);
        };
        ts::next_tx(&mut scenario, ALICE);
        {
            let mut session = ts::take_shared<DkgSession>(&scenario);
            dkg_committee::confirm_participant(&mut session, &clock, ts::ctx(&mut scenario));
            let group_pk = x"3b6a27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da29";
            dkg_committee::finalize_session_for_testing(&mut session, group_pk, ts::ctx(&mut scenario));
            assert!(dkg_committee::status(&session) == 3, 321);
            ts::return_shared(session);
        };

        clock::set_for_testing(&mut clock, 3_000_000);
        ts::next_tx(&mut scenario, ALICE);
        {
            let mut session = ts::take_shared<DkgSession>(&scenario);
            dkg_committee::handle_session_timeout(&mut session, &clock);
            ts::return_shared(session);
        };

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = agent_vault::dkg_committee::E_NOT_A_PARTICIPANT)]
    fun test_unauthorized_attacker_cannot_submit_commitment() {
        let mut scenario = ts::begin(ALICE);
        let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 1_000_000);

        let participants = vector[ALICE, BOB, CHARLIE];
        let deadline = 2_000_000;

        dkg_committee::create_dkg_session(2, participants, deadline, fee_coin(ts::ctx(&mut scenario)), &clock, ts::ctx(&mut scenario));

        ts::next_tx(&mut scenario, EVE_ATTACKER);
        {
            let mut session = ts::take_shared<DkgSession>(&scenario);
            dkg_committee::submit_commitment(&mut session, &clock, x"eeee000000000000000000000000000000000000000000000000000000000000", ATTEST_PK, bond_coin(ts::ctx(&mut scenario)), ts::ctx(&mut scenario));
            ts::return_shared(session);
        };

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = agent_vault::dkg_committee::E_QUORUM_NOT_REACHED)]
    fun test_cannot_finalize_without_quorum() {
        let mut scenario = ts::begin(ALICE);
        let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 1_000_000);

        let participants = vector[ALICE, BOB, CHARLIE];
        let deadline = 2_000_000;

        dkg_committee::create_dkg_session(2, participants, deadline, fee_coin(ts::ctx(&mut scenario)), &clock, ts::ctx(&mut scenario));

        ts::next_tx(&mut scenario, ALICE);
        {
            let mut session = ts::take_shared<DkgSession>(&scenario);
            dkg_committee::submit_commitment(&mut session, &clock, x"aaaa000000000000000000000000000000000000000000000000000000000000", ATTEST_PK, bond_coin(ts::ctx(&mut scenario)), ts::ctx(&mut scenario));
            ts::return_shared(session);
        };
        ts::next_tx(&mut scenario, BOB);
        {
            let mut session = ts::take_shared<DkgSession>(&scenario);
            dkg_committee::submit_commitment(&mut session, &clock, x"bbbb000000000000000000000000000000000000000000000000000000000000", ATTEST_PK, bond_coin(ts::ctx(&mut scenario)), ts::ctx(&mut scenario));
            let dummy_pk = x"3b6a27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da29";
            dkg_committee::finalize_session_for_testing(&mut session, dummy_pk, ts::ctx(&mut scenario));
            ts::return_shared(session);
        };

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    #[test]
    fun test_resharing_session_with_new_member() {
        let mut scenario = ts::begin(ALICE);
        let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 1_000_000);

        // Epoch 2 新委员会: 退休 Bob，加入新成员 EVE
        let new_committee = vector[ALICE, CHARLIE, EVE_ATTACKER]; // EVE 作为新成员加入
        let deadline = 2_000_000;

        // 创建 Epoch 2 Resharing 仪式
        let _session_id = dkg_committee::create_resharing_session(
            2, // Epoch 2
            3, // 3-of-3 门限：Eve 确认前必须补交承诺 (confirm 需先有 commitment)
            new_committee,
            deadline,
            ts::ctx(&mut scenario)
        );

        // T2-a 门禁：新委员会全员登记信箱加密公钥
        ts::next_tx(&mut scenario, ALICE);
        {
            let mut session = ts::take_shared<DkgSession>(&scenario);
            dkg_committee::register_encryption_key(&mut session, &clock, X25519_KEY_7, ts::ctx(&mut scenario));
            ts::return_shared(session);
        };
        ts::next_tx(&mut scenario, CHARLIE);
        {
            let mut session = ts::take_shared<DkgSession>(&scenario);
            dkg_committee::register_encryption_key(&mut session, &clock, X25519_KEY_7, ts::ctx(&mut scenario));
            ts::return_shared(session);
        };
        ts::next_tx(&mut scenario, EVE_ATTACKER);
        {
            let mut session = ts::take_shared<DkgSession>(&scenario);
            dkg_committee::register_encryption_key(&mut session, &clock, X25519_KEY_7, ts::ctx(&mut scenario));
            ts::return_shared(session);
        };

        // 1. 旧成员 Alice 异步为新委员会投递刷新承诺和给 Eve 的子分片
        ts::next_tx(&mut scenario, ALICE);
        {
            let mut session = ts::take_shared<DkgSession>(&scenario);
            assert!(dkg_committee::epoch(&session) == 2, 401);

            let recipients = vector[CHARLIE, EVE_ATTACKER];
            let payloads = vector[b"refresh_a_to_c", b"refresh_a_to_eve"];
            dkg_committee::submit_async_package(
                &mut session,
                &clock,
                b"commitments_alice_epoch2_padding_32_bytes_!!", ATTEST_PK,
                recipients,
                payloads,
                zero_coin(ts::ctx(&mut scenario)), ts::ctx(&mut scenario)
            );
            dkg_committee::confirm_participant(&mut session, &clock, ts::ctx(&mut scenario));
            ts::return_shared(session);
        };

        // 2. 旧成员 Charlie 异步为新委员会投递刷新承诺和给 Eve 的子分片
        ts::next_tx(&mut scenario, CHARLIE);
        {
            let mut session = ts::take_shared<DkgSession>(&scenario);
            let recipients = vector[ALICE, EVE_ATTACKER];
            let payloads = vector[b"refresh_c_to_a", b"refresh_c_to_eve"];
            dkg_committee::submit_async_package(
                &mut session,
                &clock,
                b"commitments_charlie_epoch2_padding_32_bytes", ATTEST_PK,
                recipients,
                payloads,
                zero_coin(ts::ctx(&mut scenario)), ts::ctx(&mut scenario)
            );
            dkg_committee::confirm_participant(&mut session, &clock, ts::ctx(&mut scenario));
            ts::return_shared(session);
        };

        // 3. 全新成员 Eve 唤醒上线: 补交承诺，从信箱获取 Alice 和 Charlie 留下的子分片，重构自己的新份额并确认
        ts::next_tx(&mut scenario, EVE_ATTACKER);
        {
            let mut session = ts::take_shared<DkgSession>(&scenario);
            assert!(dkg_committee::has_mailbox_share(&session, ALICE, EVE_ATTACKER), 402);
            assert!(dkg_committee::has_mailbox_share(&session, CHARLIE, EVE_ATTACKER), 403);
            assert!(dkg_committee::get_mailbox_share(&session, ALICE, EVE_ATTACKER) == b"refresh_a_to_eve", 404);
            assert!(dkg_committee::get_mailbox_share(&session, CHARLIE, EVE_ATTACKER) == b"refresh_c_to_eve", 405);

            // Eve 先补交自己的承诺 (确认前必须有承诺)，再确认加入新纪元
            dkg_committee::submit_commitment(
                &mut session,
                &clock,
                b"commitments_eve_epoch2_padding_32_bytes", ATTEST_PK, zero_coin(ts::ctx(&mut scenario)), ts::ctx(&mut scenario)
            );
            dkg_committee::confirm_participant(&mut session, &clock, ts::ctx(&mut scenario));

            // 保持原始群公钥不变 (PK_GROUP 永恒不变) 固化 Session
            let original_group_pk = x"3b6a27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da29";
            dkg_committee::finalize_session_for_testing(&mut session, original_group_pk, ts::ctx(&mut scenario));

            assert!(dkg_committee::status(&session) == 3, 406);
            assert!(dkg_committee::final_public_key(&session) == original_group_pk, 407);
            ts::return_shared(session);
        };

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    #[test]
    fun test_subagent_cosign_cap_delegation_and_revocation() {
        let mut scenario = ts::begin(ALICE);
        let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 1_000_000);

        // 1. 初始化国库金库，存入 1000 SUI，并初始化测试组织 Organization
        let master_cap = vault::initialize_vault<SUI>(ts::ctx(&mut scenario));
        let _org_id = create_test_org(&mut scenario);

        ts::next_tx(&mut scenario, ALICE);
        {
            let mut vault = ts::take_shared<AgentVault<SUI>>(&scenario);
            let coin = coin::mint_for_testing<SUI>(1000, ts::ctx(&mut scenario));
            vault::deposit(&mut vault, coin);
            ts::return_shared(vault);
        };

        // 2. Alice 异步发起转账 80 SUI 给 VENDOR 的治理提案 (严格绑定 Organization 名册与门限 3)
        ts::next_tx(&mut scenario, ALICE);
        {
            let org = ts::take_shared<Organization>(&scenario);
            let _proposal_id = asynchronous_proposal::create_transfer_proposal(
                &org,
                b"Cloud Server Billing",
                VENDOR,
                80,
                2_000_000,
                &clock,
                ts::ctx(&mut scenario)
            );
            ts::return_shared(org);
        };

        // 3. Alice (主账号) 为其专属 Subagent 签发并共享协签 Cap (单笔上限 100, 日上限 300, 权重 2)
        ts::next_tx(&mut scenario, ALICE);
        {
            let org = ts::take_shared<Organization>(&scenario);
            asynchronous_proposal::create_shared_subagent_cap(
                &org,
                SUBAGENT_ALICE,
                2, // voter_weight 对应 Alice 在名册中的真实权重 2
                100, // max_budget_per_tx
                300, // daily_budget_limit
                2_000_000, // expires_at_ms
                ts::ctx(&mut scenario)
            );
            ts::return_shared(org);
        };

        // 4. Subagent 独自持有 Cap 代替 Alice 提交异步协签投票！
        ts::next_tx(&mut scenario, SUBAGENT_ALICE);
        {
            let mut proposal = ts::take_shared<Proposal>(&scenario);
            let org = ts::take_shared<Organization>(&scenario);
            let mut cap = ts::take_shared<SubagentCoSignCap>(&scenario);

            asynchronous_proposal::submit_async_vote_by_subagent(
                &mut proposal,
                &org,
                &mut cap,
                &clock,
                b"subagent_alice_partial_sig",
                ts::ctx(&mut scenario)
            );

            // 验证 proposal 记账在 Alice 名下，权重累加为 2
            assert!(asynchronous_proposal::accumulated_weight(&proposal) == 2, 501);
            assert!(asynchronous_proposal::is_voter(&proposal, ALICE), 502);
            assert!(asynchronous_proposal::cap_spent_today(&cap) == 80, 503);

            ts::return_shared(cap);
            ts::return_shared(org);
            ts::return_shared(proposal);
        };

        // 5. Bob (作为另一个人类主账号) 亲自参与投票 (权重 2) -> 累积 4 票 >= 门限 3
        ts::next_tx(&mut scenario, BOB);
        {
            let mut proposal = ts::take_shared<Proposal>(&scenario);
            let org = ts::take_shared<Organization>(&scenario);
            asynchronous_proposal::submit_async_vote(
                &mut proposal,
                &org,
                &clock,
                2,
                b"bob_master_signature",
                ts::ctx(&mut scenario)
            );
            assert!(asynchronous_proposal::accumulated_weight(&proposal) == 4, 504);
            ts::return_shared(org);
            ts::return_shared(proposal);
        };

        // 6. 执行金库转账
        ts::next_tx(&mut scenario, ALICE);
        {
            let mut proposal = ts::take_shared<Proposal>(&scenario);
            let mut org = ts::take_shared<Organization>(&scenario);
            let mut vault = ts::take_shared<AgentVault<SUI>>(&scenario);

            asynchronous_proposal::execute_transfer_proposal_for_testing<SUI>(
                &mut proposal,
                &mut org,
                &mut vault,
                &master_cap,
                1,
                &clock,
                ts::ctx(&mut scenario)
            );

            assert!(asynchronous_proposal::status(&proposal) == 2, 505);
            assert!(vault::vault_balance(&vault) == 920, 506); // 1000 - 80 = 920

            ts::return_shared(vault);
            ts::return_shared(org);
            ts::return_shared(proposal);
        };

        // 7. Alice 主账号单方面吊销 Subagent Cap (Kill Switch 熔断)
        ts::next_tx(&mut scenario, ALICE);
        {
            let mut cap = ts::take_shared<SubagentCoSignCap>(&scenario);
            asynchronous_proposal::revoke_subagent_cosign_cap(&mut cap, ts::ctx(&mut scenario));
            assert!(asynchronous_proposal::cap_is_revoked(&cap), 507);
            ts::return_shared(cap);
        };

        clock::destroy_for_testing(clock);
        vault::destroy_master_cap_for_testing(master_cap);
        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = agent_vault::asynchronous_proposal::E_SUBAGENT_REVOKED)]
    fun test_subagent_cap_revoked_cannot_vote() {
        let mut scenario = ts::begin(ALICE);
        let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 1_000_000);
        let _org_id = create_test_org(&mut scenario);

        ts::next_tx(&mut scenario, ALICE);
        {
            let org = ts::take_shared<Organization>(&scenario);
            let _proposal_id = asynchronous_proposal::create_transfer_proposal(
                &org,
                b"Revoked Test",
                VENDOR,
                50,
                2_000_000,
                &clock,
                ts::ctx(&mut scenario)
            );
            ts::return_shared(org);
        };

        ts::next_tx(&mut scenario, ALICE);
        {
            let org = ts::take_shared<Organization>(&scenario);
            asynchronous_proposal::create_shared_subagent_cap(
                &org,
                SUBAGENT_ALICE,
                2,
                100,
                300,
                2_000_000,
                ts::ctx(&mut scenario)
            );
            ts::return_shared(org);
        };

        // Alice 吊销该 Cap
        ts::next_tx(&mut scenario, ALICE);
        {
            let mut cap = ts::take_shared<SubagentCoSignCap>(&scenario);
            asynchronous_proposal::revoke_subagent_cosign_cap(&mut cap, ts::ctx(&mut scenario));
            ts::return_shared(cap);
        };

        // Subagent 尝试使用已吊销的 Cap 投票 -> 预期失败 E_SUBAGENT_REVOKED
        ts::next_tx(&mut scenario, SUBAGENT_ALICE);
        {
            let mut proposal = ts::take_shared<Proposal>(&scenario);
            let org = ts::take_shared<Organization>(&scenario);
            let mut cap = ts::take_shared<SubagentCoSignCap>(&scenario);
            asynchronous_proposal::submit_async_vote_by_subagent(
                &mut proposal,
                &org,
                &mut cap,
                &clock,
                b"sig",
                ts::ctx(&mut scenario)
            );
            ts::return_shared(cap);
            ts::return_shared(org);
            ts::return_shared(proposal);
        };

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    /// `daily_budget_limit` is a rolling 24h window, not a lifetime cap. The
    /// window resets lazily on the first co-sign after it elapses, so a cap that
    /// spent its whole allowance yesterday is usable again today instead of
    /// becoming permanently dead and forcing a re-issue.
    #[test]
    fun test_subagent_budget_window_rolls_over_after_a_day() {
        let mut scenario = ts::begin(ALICE);
        let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 1_000_000);
        let _org_id = create_test_org(&mut scenario);

        ts::next_tx(&mut scenario, ALICE);
        {
            let org = ts::take_shared<Organization>(&scenario);
            let _ = asynchronous_proposal::create_transfer_proposal(
                &org, b"Daily spend", VENDOR, 50, 2_000_000, &clock, ts::ctx(&mut scenario),
            );
            ts::return_shared(org);
        };
        ts::next_tx(&mut scenario, ALICE);
        {
            // Exactly one transaction's worth of daily allowance. The voter
            // weight must equal Alice's live roster weight (2), or the cap is
            // refused as an arbitrary-weight claim before the budget is read.
            // The cap must outlive both windows of this test.
            let org = ts::take_shared<Organization>(&scenario);
            asynchronous_proposal::create_shared_subagent_cap(
                &org, SUBAGENT_ALICE, 2, 50, 50, 1_000_000 + 2 * 86_400_000, ts::ctx(&mut scenario)
            );
            ts::return_shared(org);
        };

        // First window: the single allowed spend is taken.
        let mut first_window = 0;
        ts::next_tx(&mut scenario, SUBAGENT_ALICE);
        {
            let mut proposal = ts::take_shared<Proposal>(&scenario);
            let org = ts::take_shared<Organization>(&scenario);
            let mut cap = ts::take_shared<SubagentCoSignCap>(&scenario);
            asynchronous_proposal::submit_async_vote_by_subagent(
                &mut proposal, &org, &mut cap, &clock, b"sig", ts::ctx(&mut scenario)
            );
            assert!(asynchronous_proposal::cap_spent_today(&cap) == 50, 900);
            // The window start is stamped from the transaction's epoch
            // timestamp (the chain's creation-time authority), not from the
            // test clock, so only its stability is asserted here.
            first_window = asynchronous_proposal::cap_window_start_ms(&cap);
            ts::return_shared(cap);
            ts::return_shared(org);
            ts::return_shared(proposal);
        };

        // A day later the same cap can spend again: the window rolled over.
        clock::set_for_testing(&mut clock, 1_000_000 + 86_400_000);
        ts::next_tx(&mut scenario, ALICE);
        {
            let org = ts::take_shared<Organization>(&scenario);
            let _ = asynchronous_proposal::create_transfer_proposal(
                &org, b"Next day spend", VENDOR, 50, 1_000_000 + 86_400_000 + 1_000_000, &clock, ts::ctx(&mut scenario),
            );
            ts::return_shared(org);
        };
        ts::next_tx(&mut scenario, SUBAGENT_ALICE);
        {
            let mut proposal = ts::take_shared<Proposal>(&scenario);
            let org = ts::take_shared<Organization>(&scenario);
            let mut cap = ts::take_shared<SubagentCoSignCap>(&scenario);
            asynchronous_proposal::submit_async_vote_by_subagent(
                &mut proposal, &org, &mut cap, &clock, b"sig2", ts::ctx(&mut scenario)
            );
            // Fresh window: the counter restarted rather than accumulating.
            assert!(asynchronous_proposal::cap_spent_today(&cap) == 50, 902);
            assert!(
                asynchronous_proposal::cap_window_start_ms(&cap) != first_window,
                903,
            );
            ts::return_shared(cap);
            ts::return_shared(org);
            ts::return_shared(proposal);
        };

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = agent_vault::asynchronous_proposal::E_SUBAGENT_BUDGET_EXCEEDED)]
    fun test_subagent_cap_budget_exceeded_fails() {        let mut scenario = ts::begin(ALICE);
        let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 1_000_000);
        let _org_id = create_test_org(&mut scenario);

        // 提案金额为 500 SUI
        ts::next_tx(&mut scenario, ALICE);
        {
            let org = ts::take_shared<Organization>(&scenario);
            let _proposal_id = asynchronous_proposal::create_transfer_proposal(
                &org,
                b"Expensive Proposal",
                VENDOR,
                500,
                2_000_000,
                &clock,
                ts::ctx(&mut scenario)
            );
            ts::return_shared(org);
        };

        ts::next_tx(&mut scenario, ALICE);
        {
            let org = ts::take_shared<Organization>(&scenario);
            asynchronous_proposal::create_shared_subagent_cap(
                &org,
                SUBAGENT_ALICE,
                2,
                100, // 单笔上限仅为 100
                300,
                2_000_000,
                ts::ctx(&mut scenario)
            );
            ts::return_shared(org);
        };

        // Subagent 尝试批准超出单笔上限的提案 -> 预期失败 E_SUBAGENT_BUDGET_EXCEEDED
        ts::next_tx(&mut scenario, SUBAGENT_ALICE);
        {
            let mut proposal = ts::take_shared<Proposal>(&scenario);
            let org = ts::take_shared<Organization>(&scenario);
            let mut cap = ts::take_shared<SubagentCoSignCap>(&scenario);
            asynchronous_proposal::submit_async_vote_by_subagent(
                &mut proposal,
                &org,
                &mut cap,
                &clock,
                b"sig",
                ts::ctx(&mut scenario)
            );
            ts::return_shared(cap);
            ts::return_shared(org);
            ts::return_shared(proposal);
        };

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = agent_vault::asynchronous_proposal::E_UNAUTHORIZED_SUBAGENT)]
    fun test_unauthorized_address_cannot_use_subagent_cap() {
        let mut scenario = ts::begin(ALICE);
        let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 1_000_000);
        let _org_id = create_test_org(&mut scenario);

        ts::next_tx(&mut scenario, ALICE);
        {
            let org = ts::take_shared<Organization>(&scenario);
            let _proposal_id = asynchronous_proposal::create_transfer_proposal(
                &org,
                b"Unauthorized Test",
                VENDOR,
                50,
                2_000_000,
                &clock,
                ts::ctx(&mut scenario)
            );
            ts::return_shared(org);
        };

        ts::next_tx(&mut scenario, ALICE);
        {
            let org = ts::take_shared<Organization>(&scenario);
            asynchronous_proposal::create_shared_subagent_cap(
                &org,
                SUBAGENT_ALICE,
                2,
                100,
                300,
                2_000_000,
                ts::ctx(&mut scenario)
            );
            ts::return_shared(org);
        };

        // 黑客/未授权人 EVE_ATTACKER 盗用 Alice 的 Cap 尝试协签 -> 预期失败 E_UNAUTHORIZED_SUBAGENT
        ts::next_tx(&mut scenario, EVE_ATTACKER);
        {
            let mut proposal = ts::take_shared<Proposal>(&scenario);
            let org = ts::take_shared<Organization>(&scenario);
            let mut cap = ts::take_shared<SubagentCoSignCap>(&scenario);
            asynchronous_proposal::submit_async_vote_by_subagent(
                &mut proposal,
                &org,
                &mut cap,
                &clock,
                b"sig",
                ts::ctx(&mut scenario)
            );
            ts::return_shared(cap);
            ts::return_shared(org);
            ts::return_shared(proposal);
        };

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = agent_vault::dkg_committee::E_INVALID_SESSION_STATUS)]
    fun test_late_commitment_rejected_after_round_1_freezes_q() {
        let mut scenario = ts::begin(ALICE);
        let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 1_000_000);

        let participants = vector[ALICE, BOB, CHARLIE, DAVID_OFFLINE];
        let deadline = 2_000_000;

        dkg_committee::create_dkg_session(3, participants, deadline, fee_coin(ts::ctx(&mut scenario)), &clock, ts::ctx(&mut scenario));

        // Alice, Bob, Charlie 提交承诺，达到 3/4 门限
        ts::next_tx(&mut scenario, ALICE);
        {
            let mut session = ts::take_shared<DkgSession>(&scenario);
            dkg_committee::submit_commitment(&mut session, &clock, x"aaaa000000000000000000000000000000000000000000000000000000000000", ATTEST_PK, bond_coin(ts::ctx(&mut scenario)), ts::ctx(&mut scenario));
            ts::return_shared(session);
        };
        ts::next_tx(&mut scenario, BOB);
        {
            let mut session = ts::take_shared<DkgSession>(&scenario);
            dkg_committee::submit_commitment(&mut session, &clock, x"bbbb000000000000000000000000000000000000000000000000000000000000", ATTEST_PK, bond_coin(ts::ctx(&mut scenario)), ts::ctx(&mut scenario));
            ts::return_shared(session);
        };
        ts::next_tx(&mut scenario, CHARLIE);
        {
            let mut session = ts::take_shared<DkgSession>(&scenario);
            dkg_committee::submit_commitment(&mut session, &clock, x"cccc000000000000000000000000000000000000000000000000000000000000", ATTEST_PK, bond_coin(ts::ctx(&mut scenario)), ts::ctx(&mut scenario));
            // 此时已满 3 人，状态推进至 STATUS_ROUND_2_MAILBOX，合格 Dealer 集合 Q 冻结
            assert!(dkg_committee::status(&session) == 2, 901);
            ts::return_shared(session);
        };

        // David 迟到尝试在 Round 2 注入承诺 -> 预期失败 E_INVALID_SESSION_STATUS
        ts::next_tx(&mut scenario, DAVID_OFFLINE);
        {
            let mut session = ts::take_shared<DkgSession>(&scenario);
            dkg_committee::submit_commitment(&mut session, &clock, x"dddd000000000000000000000000000000000000000000000000000000000000", ATTEST_PK, bond_coin(ts::ctx(&mut scenario)), ts::ctx(&mut scenario));
            ts::return_shared(session);
        };

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = agent_vault::dkg_committee::E_INVALID_SESSION_STATUS)]
    fun test_cannot_finalize_session_while_still_in_round_1() {
        let mut scenario = ts::begin(ALICE);
        let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 1_000_000);

        let participants = vector[ALICE, BOB, CHARLIE, DAVID_OFFLINE];
        let deadline = 2_000_000;

        dkg_committee::create_dkg_session(3, participants, deadline, fee_coin(ts::ctx(&mut scenario)), &clock, ts::ctx(&mut scenario));

        // 仅 Alice 提交承诺 (status 依然是 1)
        ts::next_tx(&mut scenario, ALICE);
        {
            let mut session = ts::take_shared<DkgSession>(&scenario);
            dkg_committee::submit_commitment(&mut session, &clock, x"aaaa000000000000000000000000000000000000000000000000000000000000", ATTEST_PK, bond_coin(ts::ctx(&mut scenario)), ts::ctx(&mut scenario));
            assert!(dkg_committee::status(&session) == 1, 902);

            let group_pk = x"3b6a27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da29";
            // 尝试在 Round 1 固化 session -> 预期失败 E_INVALID_SESSION_STATUS
            dkg_committee::finalize_session_for_testing(&mut session, group_pk, ts::ctx(&mut scenario));
            ts::return_shared(session);
        };

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = agent_vault::asynchronous_proposal::E_ARBITRARY_WEIGHT_REJECTED)]
    fun test_voter_arbitrary_weight_rejected() {
        let mut scenario = ts::begin(ALICE);
        let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 1_000_000);
        let _org_id = create_test_org(&mut scenario);

        ts::next_tx(&mut scenario, ALICE);
        {
            let org = ts::take_shared<Organization>(&scenario);
            let _proposal_id = asynchronous_proposal::create_transfer_proposal(
                &org,
                b"Arbitrary Weight Attack",
                VENDOR,
                50,
                2_000_000,
                &clock,
                ts::ctx(&mut scenario)
            );
            ts::return_shared(org);
        };

        // Alice 在名册中的法定权重为 2，但试图恶意虚报 claimed_weight = 10 欺骗合约
        // 合约比对名册发现不一致，必须强行 abort E_ARBITRARY_WEIGHT_REJECTED
        ts::next_tx(&mut scenario, ALICE);
        {
            let mut proposal = ts::take_shared<Proposal>(&scenario);
            let org = ts::take_shared<Organization>(&scenario);
            asynchronous_proposal::submit_async_vote(
                &mut proposal,
                &org,
                &clock,
                10, // 虚假伪造权重
                b"alice_sig",
                ts::ctx(&mut scenario)
            );
            ts::return_shared(org);
            ts::return_shared(proposal);
        };

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = agent_vault::asynchronous_proposal::E_ALREADY_VOTED)]
    fun test_double_voting_rejected() {
        let mut scenario = ts::begin(ALICE);
        let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 1_000_000);
        let _org_id = create_test_org(&mut scenario);

        ts::next_tx(&mut scenario, ALICE);
        {
            let org = ts::take_shared<Organization>(&scenario);
            let _proposal_id = asynchronous_proposal::create_transfer_proposal(
                &org,
                b"Double Voting Attack",
                VENDOR,
                50,
                2_000_000,
                &clock,
                ts::ctx(&mut scenario)
            );
            ts::return_shared(org);
        };

        // Alice 第一次投票 (法定权重 2) -> 成功
        ts::next_tx(&mut scenario, ALICE);
        {
            let mut proposal = ts::take_shared<Proposal>(&scenario);
            let org = ts::take_shared<Organization>(&scenario);
            asynchronous_proposal::submit_async_vote(
                &mut proposal,
                &org,
                &clock,
                2,
                b"alice_sig",
                ts::ctx(&mut scenario)
            );
            ts::return_shared(org);
            ts::return_shared(proposal);
        };

        // Alice 第二次尝试重复投票，必须被 voters 表去重拦截，abort E_ALREADY_VOTED
        ts::next_tx(&mut scenario, ALICE);
        {
            let mut proposal = ts::take_shared<Proposal>(&scenario);
            let org = ts::take_shared<Organization>(&scenario);
            asynchronous_proposal::submit_async_vote(
                &mut proposal,
                &org,
                &clock,
                2,
                b"alice_sig_again",
                ts::ctx(&mut scenario)
            );
            ts::return_shared(org);
            ts::return_shared(proposal);
        };

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = agent_vault::asynchronous_proposal::E_NOT_A_MEMBER)]
    fun test_non_member_cannot_vote() {
        let mut scenario = ts::begin(ALICE);
        let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 1_000_000);
        let _org_id = create_test_org(&mut scenario);

        ts::next_tx(&mut scenario, ALICE);
        {
            let org = ts::take_shared<Organization>(&scenario);
            let _proposal_id = asynchronous_proposal::create_transfer_proposal(
                &org,
                b"Non Member Attack",
                VENDOR,
                50,
                2_000_000,
                &clock,
                ts::ctx(&mut scenario)
            );
            ts::return_shared(org);
        };

        // 局外攻击者 EVE_ATTACKER 试图调用 submit_async_vote
        // 名册查询 member_weight 为 0，必须 abort E_NOT_A_MEMBER
        ts::next_tx(&mut scenario, EVE_ATTACKER);
        {
            let mut proposal = ts::take_shared<Proposal>(&scenario);
            let org = ts::take_shared<Organization>(&scenario);
            asynchronous_proposal::submit_async_vote(
                &mut proposal,
                &org,
                &clock,
                2,
                b"eve_sig",
                ts::ctx(&mut scenario)
            );
            ts::return_shared(org);
            ts::return_shared(proposal);
        };

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = agent_vault::asynchronous_proposal::E_EPOCH_MISMATCH)]
    fun test_async_proposal_cross_epoch_rejected() {
        let mut scenario = ts::begin(ALICE);
        let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 1_000_000);

        // 创建组织 (基于确定性 Ed25519 PK)
        let pk = vector[
            138, 136, 227, 221, 116, 9, 241, 149, 253, 82, 219, 45, 60, 186, 93, 114,
            202, 103, 9, 191, 29, 148, 18, 27, 243, 116, 136, 1, 180, 15, 111, 92
        ];
        let sig_epoch = vector[
            13, 253, 8, 110, 29, 22, 134, 203, 3, 47, 74, 138, 163, 180, 111, 86, 221, 34, 19, 20, 192, 195, 255, 229, 3, 168, 157, 27, 240, 209, 250, 131, 54, 215, 132, 8, 53, 235, 152, 118, 215, 250, 148, 39, 116, 119, 204, 144, 121, 74, 158, 228, 56, 253, 115, 247, 223, 144, 205, 184, 251, 122, 154, 2
        ];
        let members = vector[ALICE, BOB, CHARLIE];
        let weights = vector[2, 2, 2];
        let _org_id = cryptographic_org::create_organization_for_testing(
            pk,
            2,
            3,
            members,
            weights,
            ts::ctx(&mut scenario)
        );

        // 1. 在 Epoch 1 创建提案
        ts::next_tx(&mut scenario, ALICE);
        {
            let org = ts::take_shared<Organization>(&scenario);
            let _proposal_id = asynchronous_proposal::create_transfer_proposal(
                &org,
                b"Epoch 1 Proposal",
                VENDOR,
                50,
                2_000_000,
                &clock,
                ts::ctx(&mut scenario)
            );
            ts::return_shared(org);
        };

        // 2. 组织换届升级到 Epoch 2
        ts::next_tx(&mut scenario, ALICE);
        {
            let mut org = ts::take_shared<Organization>(&scenario);
            cryptographic_org::advance_organization_epoch(&mut org, 2, sig_epoch, ts::ctx(&mut scenario));
            assert!(cryptographic_org::epoch_version(&org) == 2, 903);
            ts::return_shared(org);
        };

        // 3. Bob 尝试在 Epoch 2 对 Epoch 1 的过时旧提案投票 -> 必须 abort E_EPOCH_MISMATCH
        ts::next_tx(&mut scenario, BOB);
        {
            let mut proposal = ts::take_shared<Proposal>(&scenario);
            let org = ts::take_shared<Organization>(&scenario);
            asynchronous_proposal::submit_async_vote(
                &mut proposal,
                &org,
                &clock,
                2,
                b"bob_sig",
                ts::ctx(&mut scenario)
            );
            ts::return_shared(org);
            ts::return_shared(proposal);
        };

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = agent_vault::asynchronous_proposal::E_ORG_MISMATCH)]
    fun test_async_proposal_cross_org_rejected() {
        let mut scenario = ts::begin(ALICE);
        let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 1_000_000);

        let dummy_pk = b"12345678901234567890123456789012";
        let members = vector[ALICE, BOB, CHARLIE];
        let weights = vector[2, 2, 2];

        // 创建两个不同的 Organization A 和 B
        let org_a_id = cryptographic_org::create_organization_for_testing(
            dummy_pk,
            2,
            3,
            members,
            weights,
            ts::ctx(&mut scenario)
        );
        let org_b_id = cryptographic_org::create_organization_for_testing(
            dummy_pk,
            2,
            3,
            members,
            weights,
            ts::ctx(&mut scenario)
        );

        // 1. 为组织 A 创建提案
        ts::next_tx(&mut scenario, ALICE);
        {
            let org_a = ts::take_shared_by_id<Organization>(&scenario, org_a_id);
            let _proposal_id = asynchronous_proposal::create_transfer_proposal(
                &org_a,
                b"Org A Proposal",
                VENDOR,
                50,
                2_000_000,
                &clock,
                ts::ctx(&mut scenario)
            );
            ts::return_shared(org_a);
        };

        // 2. 投票时恶意传入组织 B，企图混淆组织状态与名册 -> 必须 abort E_ORG_MISMATCH
        ts::next_tx(&mut scenario, BOB);
        {
            let mut proposal = ts::take_shared<Proposal>(&scenario);
            let org_b = ts::take_shared_by_id<Organization>(&scenario, org_b_id);
            asynchronous_proposal::submit_async_vote(
                &mut proposal,
                &org_b,
                &clock,
                2,
                b"bob_sig",
                ts::ctx(&mut scenario)
            );
            ts::return_shared(org_b);
            ts::return_shared(proposal);
        };

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    // ===== 限时门限转 DAO：三条核心约束 =====

    /// 约束 1：已签名人数不足 threshold 时，create_organization_from_session 必须失败
    #[test]
    #[expected_failure(abort_code = agent_vault::cryptographic_org::E_SESSION_NOT_FINALIZED)]
    fun test_cannot_create_org_from_unfinalized_session() {
        let mut scenario = ts::begin(ALICE);
        let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 1_000_000);

        let participants = vector[ALICE, BOB, CHARLIE, DAVID_OFFLINE];
        dkg_committee::create_dkg_session(3, participants, 2_000_000, fee_coin(ts::ctx(&mut scenario)), &clock, ts::ctx(&mut scenario));

        // 只有 2 人确认，未达 threshold=3，unfinalized
        ts::next_tx(&mut scenario, ALICE);
        {
            let mut session = ts::take_shared<DkgSession>(&scenario);
            dkg_committee::submit_commitment(&mut session, &clock, x"a100000000000000000000000000000000000000000000000000000000000000", ATTEST_PK, bond_coin(ts::ctx(&mut scenario)), ts::ctx(&mut scenario));
            dkg_committee::confirm_participant(&mut session, &clock, ts::ctx(&mut scenario));
            ts::return_shared(session);
        };
        ts::next_tx(&mut scenario, BOB);
        {
            let mut session = ts::take_shared<DkgSession>(&scenario);
            dkg_committee::submit_commitment(&mut session, &clock, x"b100000000000000000000000000000000000000000000000000000000000000", ATTEST_PK, bond_coin(ts::ctx(&mut scenario)), ts::ctx(&mut scenario));
            dkg_committee::confirm_participant(&mut session, &clock, ts::ctx(&mut scenario));
            ts::return_shared(session);
        };

        ts::next_tx(&mut scenario, ALICE);
        {
            let mut session = ts::take_shared<DkgSession>(&scenario);
            let _ = cryptographic_org::create_organization_from_session(
                &mut session, 2, &clock, ts::ctx(&mut scenario)
            );
            ts::return_shared(session);
        };

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    /// 约束 2：固化后，未签名成员不得进入组织 members
    #[test]
    fun test_unconfirmed_members_excluded_from_organization() {
        let mut scenario = ts::begin(ALICE);
        let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 1_000_000);

        let participants = vector[ALICE, BOB, CHARLIE, DAVID_OFFLINE];
        dkg_committee::create_dkg_session(3, participants, 2_000_000, fee_coin(ts::ctx(&mut scenario)), &clock, ts::ctx(&mut scenario));

        // 三人确认（达 threshold=3），DAVID 不确认
        let confirmers = vector[ALICE, BOB, CHARLIE];
        let mut i = 0;
        while (i < 3) {
            let who = *vector::borrow(&confirmers, i);
            ts::next_tx(&mut scenario, who);
            {
                let mut session = ts::take_shared<DkgSession>(&scenario);
                dkg_committee::submit_commitment(&mut session, &clock, x"c100000000000000000000000000000000000000000000000000000000000000", ATTEST_PK, bond_coin(ts::ctx(&mut scenario)), ts::ctx(&mut scenario));
                dkg_committee::confirm_participant(&mut session, &clock, ts::ctx(&mut scenario));
                ts::return_shared(session);
            };
            i = i + 1;
        };

        ts::next_tx(&mut scenario, ALICE);
        {
            let mut session = ts::take_shared<DkgSession>(&scenario);
            let dummy_pk = x"0101010101010101010101010101010101010101010101010101010101010101";
            dkg_committee::finalize_session_for_testing(&mut session, dummy_pk, ts::ctx(&mut scenario));
            // The governance threshold must be at least the DKG key threshold:
            // a proposal passed by fewer members than the key needs could never
            // be executed, because execution requires the full threshold sig.
            let _org_id = cryptographic_org::create_organization_from_session(
                &mut session, 3, &clock, ts::ctx(&mut scenario)
            );
            ts::return_shared(session);
        };

        // 验证 DAVID_OFFLINE 不在组织内
        ts::next_tx(&mut scenario, ALICE);
        {
            let org = ts::take_shared<Organization>(&scenario);
            assert!(cryptographic_org::member_weight(&org, DAVID_OFFLINE) == 0, 501);
            assert!(cryptographic_org::member_weight(&org, ALICE) == 1, 502);
            assert!(cryptographic_org::member_weight(&org, BOB) == 1, 503);
            assert!(cryptographic_org::member_weight(&org, CHARLIE) == 1, 504);
            ts::return_shared(org);
        };

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    /// 约束 3：会话超时后不可再创建组织
    #[test]
    #[expected_failure(abort_code = agent_vault::cryptographic_org::E_SESSION_NOT_FINALIZED)]
    fun test_timed_out_session_cannot_create_organization() {
        let mut scenario = ts::begin(ALICE);
        let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 1_000_000);

        let participants = vector[ALICE, BOB, CHARLIE, DAVID_OFFLINE];
        dkg_committee::create_dkg_session(3, participants, 2_000_000, fee_coin(ts::ctx(&mut scenario)), &clock, ts::ctx(&mut scenario));

        ts::next_tx(&mut scenario, ALICE);
        {
            let mut session = ts::take_shared<DkgSession>(&scenario);
            dkg_committee::submit_commitment(&mut session, &clock, x"d100000000000000000000000000000000000000000000000000000000000000", ATTEST_PK, bond_coin(ts::ctx(&mut scenario)), ts::ctx(&mut scenario));
            dkg_committee::confirm_participant(&mut session, &clock, ts::ctx(&mut scenario));
            ts::return_shared(session);
        };

        // 时间推进到期限之后
        clock::set_for_testing(&mut clock, 3_000_000);

        ts::next_tx(&mut scenario, ALICE);
        {
            let mut session = ts::take_shared<DkgSession>(&scenario);
            dkg_committee::handle_session_timeout(&mut session, &clock);
            assert!(dkg_committee::status(&session) == 4, 601);
            ts::return_shared(session);
        };

        ts::next_tx(&mut scenario, ALICE);
        {
            let mut session = ts::take_shared<DkgSession>(&scenario);
            let _ = cryptographic_org::create_organization_from_session(
                &mut session, 1, &clock, ts::ctx(&mut scenario)
            );
            ts::return_shared(session);
        };

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    // ===== Round 7：一次性创建门 + attested-only key_signers =====

    /// Round-7 约束 1：同一固化会话第二次 create_organization_from_session
    /// 必须 abort 3026（E_ORG_ALREADY_CREATED）——每个会话至多兑换一个组织。
    #[test]
    #[expected_failure(abort_code = agent_vault::dkg_committee::E_ORG_ALREADY_CREATED, location = agent_vault::dkg_committee)]
    fun second_org_creation_from_same_session_aborts_3026() {
        let mut scenario = ts::begin(ALICE);
        let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 1_000_000);

        let participants = vector[ALICE, BOB, CHARLIE];
        dkg_committee::create_dkg_session(2, participants, 2_000_000, fee_coin(ts::ctx(&mut scenario)), &clock, ts::ctx(&mut scenario));

        let mut i = 0;
        while (i < 2) {
            let who = if (i == 0) { ALICE } else { BOB };
            ts::next_tx(&mut scenario, who);
            {
                let mut session = ts::take_shared<DkgSession>(&scenario);
                let commitment = if (i == 0) {
                    x"e100000000000000000000000000000000000000000000000000000000000000"
                } else {
                    x"e200000000000000000000000000000000000000000000000000000000000000"
                };
                dkg_committee::submit_commitment(&mut session, &clock, commitment, ATTEST_PK, bond_coin(ts::ctx(&mut scenario)), ts::ctx(&mut scenario));
                ts::return_shared(session);
            };
            i = i + 1;
        };

        // Round 2 已达成（第 2 份承诺落链后 status 翻转），再确认+申报。
        let mut i = 0;
        while (i < 2) {
            let who = if (i == 0) { ALICE } else { BOB };
            ts::next_tx(&mut scenario, who);
            {
                let mut session = ts::take_shared<DkgSession>(&scenario);
                dkg_committee::confirm_participant(&mut session, &clock, ts::ctx(&mut scenario));
                dkg_committee::attest_group_key_for_testing(&mut session, &clock, GROUP_PK_7, ts::ctx(&mut scenario));
                ts::return_shared(session);
            };
            i = i + 1;
        };

        ts::next_tx(&mut scenario, ALICE);
        {
            let mut session = ts::take_shared<DkgSession>(&scenario);
            dkg_committee::finalize_session(&mut session, GROUP_PK_7, ts::ctx(&mut scenario));
            let org_id = cryptographic_org::create_organization_from_session(
                &mut session, 2, &clock, ts::ctx(&mut scenario)
            );
            std::debug::print(&org_id);
            ts::return_shared(session);
        };

        // 第二次兑换：会话已标记 OrgCreatedSlot，必须 abort 3026。
        ts::next_tx(&mut scenario, ALICE);
        {
            let mut session = ts::take_shared<DkgSession>(&scenario);
            let _ = cryptographic_org::create_organization_from_session(
                &mut session, 2, &clock, ts::ctx(&mut scenario)
            );
            ts::return_shared(session);
        };

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    /// Round-7 约束 2：非参与者调用 create_organization_from_session
    /// 必须 abort 3001（E_NOT_A_PARTICIPANT）——路人不得兑换别人的会话。
    #[test]
    #[expected_failure(abort_code = agent_vault::cryptographic_org::E_NOT_A_PARTICIPANT, location = agent_vault::cryptographic_org)]
    fun non_participant_cannot_create_org_from_session() {
        let mut scenario = ts::begin(ALICE);
        let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 1_000_000);

        let participants = vector[ALICE, BOB, CHARLIE];
        dkg_committee::create_dkg_session(2, participants, 2_000_000, fee_coin(ts::ctx(&mut scenario)), &clock, ts::ctx(&mut scenario));

        let mut i = 0;
        while (i < 2) {
            let who = if (i == 0) { ALICE } else { BOB };
            ts::next_tx(&mut scenario, who);
            {
                let mut session = ts::take_shared<DkgSession>(&scenario);
                let commitment = if (i == 0) {
                    x"e300000000000000000000000000000000000000000000000000000000000000"
                } else {
                    x"e400000000000000000000000000000000000000000000000000000000000000"
                };
                dkg_committee::submit_commitment(&mut session, &clock, commitment, ATTEST_PK, bond_coin(ts::ctx(&mut scenario)), ts::ctx(&mut scenario));
                ts::return_shared(session);
            };
            i = i + 1;
        };

        let mut i = 0;
        while (i < 2) {
            let who = if (i == 0) { ALICE } else { BOB };
            ts::next_tx(&mut scenario, who);
            {
                let mut session = ts::take_shared<DkgSession>(&scenario);
                dkg_committee::confirm_participant(&mut session, &clock, ts::ctx(&mut scenario));
                dkg_committee::attest_group_key_for_testing(&mut session, &clock, GROUP_PK_7, ts::ctx(&mut scenario));
                ts::return_shared(session);
            };
            i = i + 1;
        };

        ts::next_tx(&mut scenario, ALICE);
        {
            let mut session = ts::take_shared<DkgSession>(&scenario);
            dkg_committee::finalize_session(&mut session, GROUP_PK_7, ts::ctx(&mut scenario));
            ts::return_shared(session);
        };

        // EVE_ATTACKER 从未参与会话：即使会话已固化也不得创建组织。
        ts::next_tx(&mut scenario, EVE_ATTACKER);
        {
            let mut session = ts::take_shared<DkgSession>(&scenario);
            let _ = cryptographic_org::create_organization_from_session(
                &mut session, 2, &clock, ts::ctx(&mut scenario)
            );
            ts::return_shared(session);
        };

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    /// Round-7 约束 3：key_signers 只含「已确认 且 申报=final_pk」的参与者。
    /// 2-of-3 会话（DAVID 类离线成员 CHARLIE 不参与）：ALICE/BOB 提交、确认、
    /// 申报，生产 finalize 门禁固化后创建组织。断言 key_signers 恰为 attested
    /// 子集：未确认的 CHARLIE 被治理名册与密钥见证名单双重排除。
    ///
    /// 「确认但未申报（同一密钥）」的漂移成员在链上规则下必然触发 1012 而非
    /// 静默排除：承诺门数达 threshold 即翻入 Round 2，确认人数上限恰为
    /// threshold，固化时 attested == threshold，任何漂移都会把 attested 子集
    /// 压到门限之下 —— 该情形由
    /// attested_shortfall_below_key_threshold_aborts_1012 钉死。
    #[test]
    fun key_signers_roster_equals_attested_subset_on_formation() {
        let mut scenario = ts::begin(ALICE);
        let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 1_000_000);

        let participants = vector[ALICE, BOB, CHARLIE];
        dkg_committee::create_dkg_session(2, participants, 2_000_000, fee_coin(ts::ctx(&mut scenario)), &clock, ts::ctx(&mut scenario));

        let mut i = 0;
        while (i < 2) {
            let who = if (i == 0) { ALICE } else { BOB };
            ts::next_tx(&mut scenario, who);
            {
                let mut session = ts::take_shared<DkgSession>(&scenario);
                let commitment = if (i == 0) {
                    x"e500000000000000000000000000000000000000000000000000000000000000"
                } else {
                    x"e600000000000000000000000000000000000000000000000000000000000000"
                };
                dkg_committee::submit_commitment(&mut session, &clock, commitment, ATTEST_PK, bond_coin(ts::ctx(&mut scenario)), ts::ctx(&mut scenario));
                ts::return_shared(session);
            };
            i = i + 1;
        };

        let mut i = 0;
        while (i < 2) {
            let who = if (i == 0) { ALICE } else { BOB };
            ts::next_tx(&mut scenario, who);
            {
                let mut session = ts::take_shared<DkgSession>(&scenario);
                dkg_committee::confirm_participant(&mut session, &clock, ts::ctx(&mut scenario));
                dkg_committee::attest_group_key_for_testing(&mut session, &clock, GROUP_PK_7, ts::ctx(&mut scenario));
                ts::return_shared(session);
            };
            i = i + 1;
        };

        ts::next_tx(&mut scenario, ALICE);
        {
            let mut session = ts::take_shared<DkgSession>(&scenario);
            dkg_committee::finalize_session(&mut session, GROUP_PK_7, ts::ctx(&mut scenario));
            ts::return_shared(session);
        };

        ts::next_tx(&mut scenario, ALICE);
        {
            let mut session = ts::take_shared<DkgSession>(&scenario);
            let org_id = cryptographic_org::create_organization_from_session(
                &mut session, 2, &clock, ts::ctx(&mut scenario)
            );
            std::debug::print(&org_id);
            ts::return_shared(session);
        };

        ts::next_tx(&mut scenario, ALICE);
        {
            let org = ts::take_shared<Organization>(&scenario);
            // 治理名册 = 已确认者（ALICE、BOB）；未确认的 CHARLIE 排除在外。
            assert!(cryptographic_org::member_weight(&org, ALICE) == 1, 701);
            assert!(cryptographic_org::member_weight(&org, BOB) == 1, 702);
            assert!(cryptographic_org::member_weight(&org, CHARLIE) == 0, 703);
            // 密钥见证名单 = attested 子集（此处 = 全部确认者）。
            assert!(cryptographic_org::key_signers(&org) == vector[ALICE, BOB], 704);
            assert!(!cryptographic_org::key_signers(&org).contains(&CHARLIE), 705);
            assert!(cryptographic_org::key_threshold(&org) == 2, 706);
            ts::return_shared(org);
        };

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    /// Round-7 约束 4：确认但未申报的成员把 attested 子集压到门限之下时，
    /// create_organization_from_session 必须 abort 1012（E_KEY_SIGNER_SHORTFALL）
    /// ——凑不齐门限的密钥永远签不出有效签名，组织不许成立。
    #[test]
    #[expected_failure(abort_code = agent_vault::cryptographic_org::E_KEY_SIGNER_SHORTFALL, location = agent_vault::cryptographic_org)]
    fun attested_shortfall_below_key_threshold_aborts_1012() {
        let mut scenario = ts::begin(ALICE);
        let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 1_000_000);

        let participants = vector[ALICE, BOB, CHARLIE];
        dkg_committee::create_dkg_session(3, participants, 2_000_000, fee_coin(ts::ctx(&mut scenario)), &clock, ts::ctx(&mut scenario));

        let mut i = 0;
        while (i < 3) {
            let who = if (i == 0) { ALICE } else if (i == 1) { BOB } else { CHARLIE };
            ts::next_tx(&mut scenario, who);
            {
                let mut session = ts::take_shared<DkgSession>(&scenario);
                let commitment = if (i == 0) {
                    x"e800000000000000000000000000000000000000000000000000000000000000"
                } else if (i == 1) {
                    x"e900000000000000000000000000000000000000000000000000000000000000"
                } else {
                    x"ea00000000000000000000000000000000000000000000000000000000000000"
                };
                dkg_committee::submit_commitment(&mut session, &clock, commitment, ATTEST_PK, bond_coin(ts::ctx(&mut scenario)), ts::ctx(&mut scenario));
                ts::return_shared(session);
            };
            i = i + 1;
        };

        let mut i = 0;
        while (i < 3) {
            let who = if (i == 0) { ALICE } else if (i == 1) { BOB } else { CHARLIE };
            ts::next_tx(&mut scenario, who);
            {
                let mut session = ts::take_shared<DkgSession>(&scenario);
                dkg_committee::confirm_participant(&mut session, &clock, ts::ctx(&mut scenario));
                ts::return_shared(session);
            };
            i = i + 1;
        };

        ts::next_tx(&mut scenario, ALICE);
        {
            let mut session = ts::take_shared<DkgSession>(&scenario);
            dkg_committee::finalize_session_for_testing(&mut session, GROUP_PK_7, ts::ctx(&mut scenario));
            // 漂移：BOB 的申报被撤下（确认仍在），attested 子集 = {ALICE, CHARLIE}
            // = 2 < threshold 3 → 1012。
            dkg_committee::unattest_for_testing(&mut session, BOB);
            let _ = cryptographic_org::create_organization_from_session(
                &mut session, 3, &clock, ts::ctx(&mut scenario)
            );
            ts::return_shared(session);
        };

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    /// Round-7 约束 5：32 字节 X25519 信箱加密公钥现在可登记（双栈共存），
    /// 65 字节 P-256 依旧可登记；两者独立占位。
    #[test]
    fun x25519_32_byte_encryption_key_registration_passes() {
        let mut s = ts::begin(ALICE);
        let mut clock = clock::create_for_testing(ts::ctx(&mut s));
        clock::set_for_testing(&mut clock, 1_000_000);
        let _id = dkg_committee::create_dkg_session(
            2, vector[ALICE, BOB], 2_000_000, fee_coin(ts::ctx(&mut s)), &clock, ts::ctx(&mut s),
        );

        ts::next_tx(&mut s, ALICE);
        {
            let mut session = ts::take_shared<DkgSession>(&s);
            // 32-byte X25519 raw public key.
            dkg_committee::register_encryption_key(&mut session, &clock, X25519_KEY_7, ts::ctx(&mut s));
            assert!(dkg_committee::encryption_key(&session, ALICE) == X25519_KEY_7, 0);
            // 65-byte P-256 uncompressed point stays valid (dual stack).
            ts::return_shared(session);
        };

        ts::next_tx(&mut s, BOB);
        {
            let mut session = ts::take_shared<DkgSession>(&s);
            dkg_committee::register_encryption_key(&mut session, &clock, VALID_KEY_65, ts::ctx(&mut s));
            assert!(dkg_committee::encryption_key(&session, BOB) == VALID_KEY_65, 1);
            assert!(dkg_committee::encryption_key(&session, ALICE) == X25519_KEY_7, 2);
            ts::return_shared(session);
        };

        clock::destroy_for_testing(clock);
        ts::end(s);
    }

    // === Rejection Voting Tests ===

    #[test]
    fun rejection_weight_reaches_same_threshold_and_retains_decisions() {
        let mut fixture = start_rejection_fixture(3);
        fixture.assert_state(1, 0, 0);
        fixture.assert_voter(ALICE, false, false, false);
        fixture.reject(ALICE);
        fixture.assert_state(1, 0, 1);
        fixture.assert_voter(ALICE, true, true, false);
        fixture.reject(BOB);
        fixture.assert_state(3, 0, 3);
        fixture.assert_voter(BOB, true, true, false);
        fixture.assert_voter(CHARLIE, false, false, false);
        fixture.assert_vault(100);
        fixture.end();
    }

    #[test]
    fun rejection_above_threshold_is_terminal() {
        let mut fixture = start_rejection_fixture(3);
        fixture.reject(BOB);
        fixture.assert_state(1, 0, 2);
        fixture.reject(CHARLIE);
        fixture.assert_state(3, 0, 5);
        fixture.end();
    }

    #[test]
    fun separate_members_can_approve_and_reject_before_approval_execution() {
        let mut fixture = start_rejection_fixture(3);
        fixture.reject(BOB);
        fixture.approve(ALICE, 1);
        fixture.assert_state(1, 1, 2);
        fixture.approve(CHARLIE, 3);
        fixture.assert_state(1, 4, 2);
        fixture.assert_voter(ALICE, true, false, true);
        fixture.assert_voter(BOB, true, true, false);
        fixture.execute();
        fixture.assert_state(2, 4, 2);
        fixture.assert_vault(90);
        fixture.end();
    }

    #[test]
    fun rejection_accepts_exact_deadline() {
        let mut fixture = start_rejection_fixture(3);
        fixture.set_time(2_000_000);
        fixture.reject(ALICE);
        fixture.assert_state(1, 0, 1);
        fixture.end();
    }

    #[test]
    #[expected_failure(abort_code = 4009, location = agent_vault::asynchronous_proposal)]
    fun rejection_refuses_nonmember() {
        let mut fixture = start_rejection_fixture(3);
        fixture.reject(EVE_ATTACKER);
        fixture.end();
    }

    #[test]
    #[expected_failure(abort_code = 4009, location = agent_vault::asynchronous_proposal)]
    fun rejection_refuses_zero_weight_roster_entry() {
        let mut fixture = start_rejection_fixture(3);
        fixture.reject(DAVID_OFFLINE);
        fixture.end();
    }

    #[test]
    #[expected_failure(abort_code = 4003, location = agent_vault::asynchronous_proposal)]
    fun rejection_refuses_duplicate() {
        let mut fixture = start_rejection_fixture(3);
        fixture.reject(ALICE);
        fixture.reject(ALICE);
        fixture.end();
    }

    #[test]
    #[expected_failure(abort_code = 4003, location = agent_vault::asynchronous_proposal)]
    fun rejection_refuses_member_who_already_approved() {
        let mut fixture = start_rejection_fixture(3);
        fixture.approve(ALICE, 1);
        fixture.reject(ALICE);
        fixture.end();
    }

    #[test]
    #[expected_failure(abort_code = 4003, location = agent_vault::asynchronous_proposal)]
    fun approval_refuses_member_who_already_rejected() {
        let mut fixture = start_rejection_fixture(3);
        fixture.reject(ALICE);
        fixture.approve(ALICE, 1);
        fixture.end();
    }

    #[test]
    #[expected_failure(abort_code = 4003, location = agent_vault::asynchronous_proposal)]
    fun rejection_refuses_member_whose_subagent_approved() {
        let mut fixture = start_rejection_fixture(3);
        fixture.subagent_approve();
        fixture.reject(ALICE);
        fixture.end();
    }

    #[test]
    #[expected_failure(abort_code = 4003, location = agent_vault::asynchronous_proposal)]
    fun subagent_approval_refuses_master_who_rejected() {
        let mut fixture = start_rejection_fixture(3);
        fixture.reject(ALICE);
        fixture.subagent_approve();
        fixture.end();
    }

    #[test]
    #[expected_failure(abort_code = 4012, location = agent_vault::asynchronous_proposal)]
    fun rejection_refuses_wrong_organization_before_membership() {
        let mut fixture = start_rejection_fixture(3);
        fixture.reject_other_org();
        fixture.end();
    }

    #[test]
    #[expected_failure(abort_code = 4011, location = agent_vault::asynchronous_proposal)]
    fun rejection_refuses_stale_epoch() {
        let mut fixture = start_rejection_fixture(3);
        fixture.advance_epoch();
        fixture.reject(ALICE);
        fixture.end();
    }

    #[test]
    #[expected_failure(abort_code = 4001, location = agent_vault::asynchronous_proposal)]
    fun rejection_refuses_after_deadline_before_membership() {
        let mut fixture = start_rejection_fixture(3);
        fixture.set_time(2_000_001);
        fixture.reject(EVE_ATTACKER);
        fixture.end();
    }

    #[test]
    #[expected_failure(abort_code = agent_vault::asynchronous_proposal::EApprovalThresholdMet,
        location = agent_vault::asynchronous_proposal)]
    fun rejection_refuses_when_approvals_already_meet_threshold() {
        let mut fixture = start_rejection_fixture(3);
        fixture.approve(ALICE, 1);
        fixture.approve(BOB, 2);
        fixture.reject(CHARLIE);
        fixture.end();
    }

    /// A zero snapshot threshold would make every proposal executable with no
    /// approval, so organization creation refuses it outright. This replaces
    /// the earlier test that asserted the bypass as expected behaviour.
    #[test]
    #[expected_failure(abort_code = agent_vault::cryptographic_org::EUnreachableThreshold,
        location = agent_vault::cryptographic_org)]
    fun zero_threshold_organization_cannot_be_created() {
        let mut scenario = ts::begin(ALICE);
        let pk = vector[
            138, 136, 227, 221, 116, 9, 241, 149, 253, 82, 219, 45, 60, 186, 93, 114,
            202, 103, 9, 191, 29, 148, 18, 27, 243, 116, 136, 1, 180, 15, 111, 92
        ];
        let _ = cryptographic_org::create_organization_for_testing(
            pk, 2, 0, vector[ALICE, BOB], vector[1, 2], ts::ctx(&mut scenario)
        );
        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = 4003, location = agent_vault::asynchronous_proposal)]
    fun rejection_duplicate_precedes_already_approved_threshold() {
        let mut fixture = start_rejection_fixture(3);
        fixture.approve(CHARLIE, 3);
        fixture.reject(CHARLIE);
        fixture.end();
    }

    #[test]
    #[expected_failure(abort_code = 4002, location = agent_vault::asynchronous_proposal)]
    fun rejection_refuses_rejected_state_before_expiry_and_membership() {
        let mut fixture = start_rejection_fixture(3);
        fixture.reject(CHARLIE);
        fixture.set_time(2_000_001);
        fixture.reject(EVE_ATTACKER);
        fixture.end();
    }

    #[test]
    #[expected_failure(abort_code = 4002, location = agent_vault::asynchronous_proposal)]
    fun rejection_refuses_executed_state() {
        let mut fixture = start_rejection_fixture(3);
        fixture.approve(CHARLIE, 3);
        fixture.execute();
        fixture.reject(ALICE);
        fixture.end();
    }

    #[test]
    #[expected_failure(abort_code = 4002, location = agent_vault::asynchronous_proposal)]
    fun rejected_status_bars_existing_transfer_execution() {
        let mut fixture = start_rejection_fixture(3);
        fixture.reject(CHARLIE);
        fixture.execute();
        fixture.end();
    }

    #[test]
    #[expected_failure(abort_code = 4002, location = agent_vault::asynchronous_proposal)]
    fun rejected_status_bars_direct_approval() {
        let mut fixture = start_rejection_fixture(3);
        fixture.reject(CHARLIE);
        fixture.approve(ALICE, 1);
        fixture.end();
    }

    #[test]
    #[expected_failure(abort_code = 4002, location = agent_vault::asynchronous_proposal)]
    fun rejected_status_bars_subagent_approval() {
        let mut fixture = start_rejection_fixture(3);
        fixture.reject(CHARLIE);
        fixture.subagent_approve();
        fixture.end();
    }

    // === Rejection Fixture ===

    public struct RejectionFixture {
        scenario: ts::Scenario,
        clock: Clock,
        org_id: ID,
        proposal_id: ID,
    }

    fun start_rejection_fixture(threshold: u64): RejectionFixture {
        let mut scenario = ts::begin(ALICE);
        let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 1_000_000);
        // Same deterministic key and object-creation order as the existing
        // authenticated epoch-advance regression fixture above.
        let pk = vector[
            138, 136, 227, 221, 116, 9, 241, 149, 253, 82, 219, 45, 60, 186, 93, 114,
            202, 103, 9, 191, 29, 148, 18, 27, 243, 116, 136, 1, 180, 15, 111, 92
        ];
        let org_id = cryptographic_org::create_organization_for_testing(
            pk, 2, threshold, vector[ALICE, BOB, CHARLIE, DAVID_OFFLINE], vector[1, 2, 3, 0], ts::ctx(&mut scenario)
        );
        let master = vault::initialize_vault<SUI>(ts::ctx(&mut scenario));
        transfer::public_transfer(master, ALICE);

        // Cap issuance now reads the shared Organization, which test_scenario
        // only exposes after the creation tx commits.
        ts::next_tx(&mut scenario, ALICE);
        {
            let org = ts::take_shared<Organization>(&scenario);
            asynchronous_proposal::create_shared_subagent_cap(
                &org, SUBAGENT_ALICE, 1, 100, 100, 2_000_000, ts::ctx(&mut scenario)
            );
            ts::return_shared(org);
        };

        ts::next_tx(&mut scenario, ALICE);
        let org = ts::take_shared_by_id<Organization>(&scenario, org_id);
        let proposal_id = asynchronous_proposal::create_transfer_proposal(
            &org, b"Weighted approval or rejection", VENDOR, 10, 2_000_000, &clock, ts::ctx(&mut scenario)
        );
        ts::return_shared(org);
        let mut vault = ts::take_shared<AgentVault<SUI>>(&scenario);
        let funds = coin::mint_for_testing<SUI>(100, ts::ctx(&mut scenario));
        vault::deposit(&mut vault, funds);
        ts::return_shared(vault);

        ts::next_tx(&mut scenario, ALICE);
        RejectionFixture { scenario, clock, org_id, proposal_id }
    }

    fun rejection_fixture_reject(self: &mut RejectionFixture, voter: address) {
        ts::next_tx(&mut self.scenario, voter);
        let org = ts::take_shared_by_id<Organization>(&self.scenario, self.org_id);
        let mut proposal = ts::take_shared_by_id<Proposal>(&self.scenario, self.proposal_id);
        let previous_weight = asynchronous_proposal::rejected_weight(&proposal);
        let weight = cryptographic_org::member_weight(&org, voter);
        asynchronous_proposal::reject_async_vote(
            &mut proposal, &org, &self.clock, ts::ctx(&mut self.scenario)
        );

        // Assert every event field and replay the primitive delta to the total.
        let events = event::events_by_type<AsyncVoteRejectedEvent>();
        let (proposal_id, event_weight, total) = asynchronous_proposal::rejection_event_fields(
            &events[events.length() - 1]
        );
        assert!(proposal_id == self.proposal_id, 2001);
        assert!(event_weight == weight, 2002);
        assert!(total == previous_weight + weight, 2003);
        assert!(total == asynchronous_proposal::rejected_weight(&proposal), 2004);
        ts::return_shared(proposal);
        ts::return_shared(org);
    }

    fun rejection_fixture_approve(self: &mut RejectionFixture, voter: address, weight: u64) {
        ts::next_tx(&mut self.scenario, voter);
        let org = ts::take_shared_by_id<Organization>(&self.scenario, self.org_id);
        let mut proposal = ts::take_shared_by_id<Proposal>(&self.scenario, self.proposal_id);
        // Empty ancillary bytes are valid: sender authentication is canonical.
        asynchronous_proposal::submit_async_vote(
            &mut proposal, &org, &self.clock, weight, vector[], ts::ctx(&mut self.scenario)
        );
        ts::return_shared(proposal);
        ts::return_shared(org);
    }

    fun rejection_fixture_subagent_approve(self: &mut RejectionFixture) {
        ts::next_tx(&mut self.scenario, SUBAGENT_ALICE);
        let org = ts::take_shared_by_id<Organization>(&self.scenario, self.org_id);
        let mut proposal = ts::take_shared_by_id<Proposal>(&self.scenario, self.proposal_id);
        let mut cap = ts::take_shared<SubagentCoSignCap>(&self.scenario);
        asynchronous_proposal::submit_async_vote_by_subagent(
            &mut proposal, &org, &mut cap, &self.clock, vector[], ts::ctx(&mut self.scenario)
        );
        ts::return_shared(cap);
        ts::return_shared(proposal);
        ts::return_shared(org);
    }

    fun rejection_fixture_execute(self: &mut RejectionFixture) {
        ts::next_tx(&mut self.scenario, ALICE);
        let mut org = ts::take_shared_by_id<Organization>(&self.scenario, self.org_id);
        let mut proposal = ts::take_shared_by_id<Proposal>(&self.scenario, self.proposal_id);
        let mut vault = ts::take_shared<AgentVault<SUI>>(&self.scenario);
        let master = ts::take_from_sender<MasterCap>(&self.scenario);
        asynchronous_proposal::execute_transfer_proposal_for_testing<SUI>(
            &mut proposal, &mut org, &mut vault, &master, 1, &self.clock, ts::ctx(&mut self.scenario)
        );
        ts::return_to_sender(&self.scenario, master);
        ts::return_shared(vault);
        ts::return_shared(proposal);
        ts::return_shared(org);
    }

    fun rejection_fixture_assert_state(self: &mut RejectionFixture, status: u8, approved: u64, rejected: u64) {
        ts::next_tx(&mut self.scenario, ALICE);
        let proposal = ts::take_shared_by_id<Proposal>(&self.scenario, self.proposal_id);
        assert!(asynchronous_proposal::status(&proposal) == status, 2010);
        assert!(asynchronous_proposal::accumulated_weight(&proposal) == approved, 2011);
        assert!(asynchronous_proposal::rejected_weight(&proposal) == rejected, 2012);
        ts::return_shared(proposal);
    }

    fun rejection_fixture_assert_voter(
        self: &mut RejectionFixture, voter: address, voted: bool, rejecting: bool, has_signature: bool
    ) {
        ts::next_tx(&mut self.scenario, ALICE);
        let proposal = ts::take_shared_by_id<Proposal>(&self.scenario, self.proposal_id);
        assert!(asynchronous_proposal::is_voter(&proposal, voter) == voted, 2020);
        assert!(asynchronous_proposal::is_rejecting_voter(&proposal, voter) == rejecting, 2021);
        assert!(asynchronous_proposal::has_partial_signature(&proposal, voter) == has_signature, 2022);
        ts::return_shared(proposal);
    }

    fun rejection_fixture_set_time(self: &mut RejectionFixture, timestamp_ms: u64) {
        clock::set_for_testing(&mut self.clock, timestamp_ms);
    }

    fun rejection_fixture_advance_epoch(self: &mut RejectionFixture) {
        ts::next_tx(&mut self.scenario, ALICE);
        let mut org = ts::take_shared_by_id<Organization>(&self.scenario, self.org_id);
        let signature = vector[
            13, 253, 8, 110, 29, 22, 134, 203, 3, 47, 74, 138, 163, 180, 111, 86, 221, 34, 19, 20, 192, 195, 255, 229, 3, 168, 157, 27, 240, 209, 250, 131, 54, 215, 132, 8, 53, 235, 152, 118, 215, 250, 148, 39, 116, 119, 204, 144, 121, 74, 158, 228, 56, 253, 115, 247, 223, 144, 205, 184, 251, 122, 154, 2
        ];
        cryptographic_org::advance_organization_epoch(&mut org, 2, signature, ts::ctx(&mut self.scenario));
        assert!(cryptographic_org::epoch_version(&org) == 2, 2030);
        ts::return_shared(org);
    }

    fun rejection_fixture_reject_other_org(self: &mut RejectionFixture) {
        ts::next_tx(&mut self.scenario, ALICE);
        let other_id = cryptographic_org::create_organization_for_testing(
            b"12345678901234567890123456789012", 1, 1, vector[BOB], vector[1], ts::ctx(&mut self.scenario)
        );
        ts::next_tx(&mut self.scenario, ALICE);
        let other = ts::take_shared_by_id<Organization>(&self.scenario, other_id);
        let mut proposal = ts::take_shared_by_id<Proposal>(&self.scenario, self.proposal_id);
        asynchronous_proposal::reject_async_vote(
            &mut proposal, &other, &self.clock, ts::ctx(&mut self.scenario)
        );
        ts::return_shared(proposal);
        ts::return_shared(other);
    }

    fun rejection_fixture_assert_vault(self: &mut RejectionFixture, expected: u64) {
        ts::next_tx(&mut self.scenario, ALICE);
        let vault = ts::take_shared<AgentVault<SUI>>(&self.scenario);
        assert!(vault::vault_balance(&vault) == expected, 2040);
        ts::return_shared(vault);
    }

    fun rejection_fixture_end(self: RejectionFixture) {
        let RejectionFixture { scenario, clock, org_id: _, proposal_id: _ } = self;
        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    const TITLE_256_BYTES: vector<u8> = x"61616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161";
    const TITLE_257_BYTES: vector<u8> = x"6161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161";

    // === #18 SubagentCoSignCap epoch-aware weight tests ===

    /// Shared fixture: org at epoch 1 with Alice weight 3; Alice issues a cap
    /// with voter_weight 2 (a lawful partial delegation, 2 <= 3) to
    /// SUBAGENT_ALICE. The key rotation then bumps the org to epoch 2 and the
    /// proposal is created under epoch 2, so voting uses a stale (cross-epoch)
    /// cap against a live roster.
    fun start_cap_epoch_fixture(): (ts::Scenario, Clock, ID, ID) {
        let mut scenario = ts::begin(ALICE);
        let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 1_000_000);
        let pk = b"12345678901234567890123456789012";
        let org_id = cryptographic_org::create_organization_for_testing(
            pk, 1, 4, vector[ALICE, BOB, CHARLIE], vector[3, 2, 3], ts::ctx(&mut scenario)
        );

        // Epoch 1: Alice issues the cap with voter_weight 2 (live weight 3).
        ts::next_tx(&mut scenario, ALICE);
        {
            let org = ts::take_shared<Organization>(&scenario);
            asynchronous_proposal::create_shared_subagent_cap(
                &org, SUBAGENT_ALICE, 2, 100, 300, 2_000_000, ts::ctx(&mut scenario)
            );
            ts::return_shared(org);
        };

        // Key rotation advances the org to epoch 2 (weights unchanged).
        ts::next_tx(&mut scenario, ALICE);
        {
            let mut org = ts::take_shared<Organization>(&scenario);
            cryptographic_org::rotate_group_key_for_testing(
                &mut org, 1, b"99999999999999999999999999999999", vector[ALICE], 1, ts::ctx(&mut scenario)
            );
            assert!(cryptographic_org::epoch_version(&org) == 2, 9101);
            ts::return_shared(org);
        };

        // Epoch 2: the proposal snapshots the new epoch.
        ts::next_tx(&mut scenario, ALICE);
        let proposal_id = {
            let org = ts::take_shared<Organization>(&scenario);
            let id = asynchronous_proposal::create_transfer_proposal(
                &org, b"Stale cap degraded vote", VENDOR, 10, 2_000_000, &clock, ts::ctx(&mut scenario)
            );
            ts::return_shared(org);
            id
        };
        (scenario, clock, org_id, proposal_id)
    }

    #[test]
    fun stale_cap_cross_epoch_votes_with_degraded_min_weight() {
        let (mut scenario, clock, _org_id, proposal_id) = start_cap_epoch_fixture();
        ts::next_tx(&mut scenario, SUBAGENT_ALICE);
        {
            let mut proposal = ts::take_shared_by_id<Proposal>(&scenario, proposal_id);
            let org = ts::take_shared<Organization>(&scenario);
            let mut cap = ts::take_shared<SubagentCoSignCap>(&scenario);
            // Cross-epoch: weight degrades to min(cap 2, live 3) = 2 instead of
            // aborting with E_ARBITRARY_WEIGHT_REJECTED (the pre-fix behavior).
            asynchronous_proposal::submit_async_vote_by_subagent(
                &mut proposal, &org, &mut cap, &clock, b"stale_sig", ts::ctx(&mut scenario)
            );
            assert!(asynchronous_proposal::accumulated_weight(&proposal) == 2, 9102);
            ts::return_shared(cap);
            ts::return_shared(org);
            ts::return_shared(proposal);
        };
        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = 4010, location = agent_vault::asynchronous_proposal)]
    fun in_epoch_weight_mismatch_still_aborts() {
        let mut scenario = ts::begin(ALICE);
        let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 1_000_000);
        let pk = b"12345678901234567890123456789012";
        let _org_id = cryptographic_org::create_organization_for_testing(
            pk, 1, 4, vector[ALICE, BOB, CHARLIE], vector[3, 2, 3], ts::ctx(&mut scenario)
        );
        ts::next_tx(&mut scenario, ALICE);
        {
            let org = ts::take_shared<Organization>(&scenario);
            let proposal_id = asynchronous_proposal::create_transfer_proposal(
                &org, b"In-epoch strict", VENDOR, 10, 2_000_000, &clock, ts::ctx(&mut scenario)
            );
            // Same epoch: partial delegation (cap 2 < live 3) must still abort.
            asynchronous_proposal::create_shared_subagent_cap(
                &org, SUBAGENT_ALICE, 2, 100, 300, 2_000_000, ts::ctx(&mut scenario)
            );
            ts::return_shared(org);
            ts::next_tx(&mut scenario, SUBAGENT_ALICE);
            let mut proposal = ts::take_shared_by_id<Proposal>(&scenario, proposal_id);
            let org2 = ts::take_shared<Organization>(&scenario);
            let mut cap = ts::take_shared<SubagentCoSignCap>(&scenario);
            asynchronous_proposal::submit_async_vote_by_subagent(
                &mut proposal, &org2, &mut cap, &clock, b"tamper_sig", ts::ctx(&mut scenario)
            );
            ts::return_shared(cap);
            ts::return_shared(org2);
            ts::return_shared(proposal);
        };
        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = 4009, location = agent_vault::asynchronous_proposal)]
    fun cap_issuance_by_non_member_aborts() {
        let mut scenario = ts::begin(ALICE);
        let pk = b"12345678901234567890123456789012";
        let _org_id = cryptographic_org::create_organization_for_testing(
            pk, 1, 4, vector[ALICE, BOB, CHARLIE], vector[3, 2, 3], ts::ctx(&mut scenario)
        );
        // EVE_ATTACKER is not on the roster; delegation is members-only.
        ts::next_tx(&mut scenario, EVE_ATTACKER);
        {
            let org = ts::take_shared<Organization>(&scenario);
            asynchronous_proposal::create_shared_subagent_cap(
                &org, SUBAGENT_ALICE, 1, 100, 300, 2_000_000, ts::ctx(&mut scenario)
            );
            ts::return_shared(org);
        };
        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = 4010, location = agent_vault::asynchronous_proposal)]
    fun cap_issuance_above_own_weight_aborts() {
        let mut scenario = ts::begin(ALICE);
        let pk = b"12345678901234567890123456789012";
        let _org_id = cryptographic_org::create_organization_for_testing(
            pk, 1, 4, vector[ALICE, BOB, CHARLIE], vector[3, 2, 3], ts::ctx(&mut scenario)
        );
        // Alice holds weight 3 but tries to delegate weight 4.
        ts::next_tx(&mut scenario, ALICE);
        {
            let org = ts::take_shared<Organization>(&scenario);
            asynchronous_proposal::create_shared_subagent_cap(
                &org, SUBAGENT_ALICE, 4, 100, 300, 2_000_000, ts::ctx(&mut scenario)
            );
            ts::return_shared(org);
        };
        ts::end(scenario);
    }

    // === #19 proposal input bound tests ===

    #[test]
    #[expected_failure(abort_code = 4017, location = agent_vault::asynchronous_proposal)]
    fun oversized_title_is_rejected() {
        let mut scenario = ts::begin(ALICE);
        let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 1_000_000);
        let _org_id = create_test_org(&mut scenario);
        ts::next_tx(&mut scenario, ALICE);
        {
            let org = ts::take_shared<Organization>(&scenario);
            asynchronous_proposal::create_transfer_proposal(
                &org, TITLE_257_BYTES, VENDOR, 10, 2_000_000, &clock, ts::ctx(&mut scenario)
            );
            ts::return_shared(org);
        };
        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = 4018, location = agent_vault::asynchronous_proposal)]
    fun deadline_beyond_one_year_is_rejected() {
        let mut scenario = ts::begin(ALICE);
        let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 1_000_000);
        let _org_id = create_test_org(&mut scenario);
        ts::next_tx(&mut scenario, ALICE);
        {
            let org = ts::take_shared<Organization>(&scenario);
            // now + 366 days (366 * 86_400_000) exceeds MAX_DURATION_MS.
            asynchronous_proposal::create_transfer_proposal(
                &org, b"Too far out", VENDOR, 10, 1_000_000 + 31_622_400_000, &clock, ts::ctx(&mut scenario)
            );
            ts::return_shared(org);
        };
        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    #[test]
    fun boundary_title_and_exactly_one_year_deadline_pass() {
        let mut scenario = ts::begin(ALICE);
        let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 1_000_000);
        let _org_id = create_test_org(&mut scenario);
        ts::next_tx(&mut scenario, ALICE);
        {
            let org = ts::take_shared<Organization>(&scenario);
            asynchronous_proposal::create_transfer_proposal(
                &org, TITLE_256_BYTES, VENDOR, 10, 1_000_000 + 31_536_000_000, &clock, ts::ctx(&mut scenario)
            );
            ts::return_shared(org);
        };
        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }
}

#[test_only]
module agent_vault::dkg_committee_encryption_key_tests {
    use sui::test_scenario::{Self as ts};
    use sui::clock::{Self, Clock};
    use sui::coin;
    use sui::sui::SUI;
    use sui::tx_context::TxContext;
    use agent_vault::dkg_committee::{Self, DkgSession};

    const ALICE: address = @0xA11CE;
    const ATTEST_PK: vector<u8> = x"4141414141414141414141414141414141414141414141414141414141414141";
    const BOB: address = @0xB0B;
    const CHARLIE: address = @0xC0C;
    const EVE: address = @0xEE7E;

    /// A raw uncompressed P-256 point: 0x04 || X(32) || Y(32).
    const VALID_KEY: vector<u8> = x"0401010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101";
    const OTHER_KEY: vector<u8> = x"0402020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202";

    fun fee_coin(ctx: &mut TxContext): coin::Coin<SUI> {
        coin::mint_for_testing<SUI>(dkg_committee::creation_fee_mist(), ctx)
    }

    fun bond_coin(ctx: &mut TxContext): coin::Coin<SUI> {
        let (min_bond, _max) = dkg_committee::bond_bounds();
        coin::mint_for_testing<SUI>(min_bond, ctx)
    }

    fun zero_coin(ctx: &mut TxContext): coin::Coin<SUI> {
        coin::mint_for_testing<SUI>(0, ctx)
    }

    /// Creates a 2-of-3 session and returns the shared object as `sender`.
    ///
    /// `take_shared` only sees objects shared in an *earlier* transaction, so
    /// this advances to a fresh transaction after creation. The caller must
    /// return the session and destroy the clock before ending the scenario.
    fun open_session(scenario: &mut ts::Scenario, sender: address): (DkgSession, Clock) {
        let mut clock = clock::create_for_testing(ts::ctx(scenario));
        clock::set_for_testing(&mut clock, 1_000_000);
        let _id = dkg_committee::create_dkg_session(
            2, vector[ALICE, BOB, CHARLIE], 2_000_000, fee_coin(ts::ctx(scenario)), &clock, ts::ctx(scenario),
        );
        ts::next_tx(scenario, sender);
        let session = ts::take_shared<DkgSession>(scenario);
        (session, clock)
    }

    #[test]
    fun a_participant_registers_a_65_byte_key_and_everyone_can_read_it() {
        let mut s = ts::begin(ALICE);
        let (mut session, clock) = open_session(&mut s, ALICE);

        // An unregistered slot reads as empty, which means "not registered" —
        // never "registered an empty key".
        assert!(!dkg_committee::has_encryption_key(&session, ALICE), 0);
        assert!(dkg_committee::encryption_key(&session, ALICE).is_empty(), 1);

        dkg_committee::register_encryption_key(&mut session, &clock, VALID_KEY, ts::ctx(&mut s));

        assert!(dkg_committee::has_encryption_key(&session, ALICE), 2);
        assert!(dkg_committee::encryption_key(&session, ALICE) == VALID_KEY, 3);
        // Another participant's slot is untouched.
        assert!(!dkg_committee::has_encryption_key(&session, BOB), 4);
        assert!(dkg_committee::encryption_key(&session, BOB).is_empty(), 5);

        ts::return_shared(session);
        clock::destroy_for_testing(clock);
        ts::end(s);
    }

    #[test]
    fun each_participant_holds_an_independent_slot() {
        let mut s = ts::begin(ALICE);
        let (mut session, clock) = open_session(&mut s, ALICE);
        dkg_committee::register_encryption_key(&mut session, &clock, VALID_KEY, ts::ctx(&mut s));
        ts::return_shared(session);

        ts::next_tx(&mut s, BOB);
        let mut session = ts::take_shared<DkgSession>(&s);
        dkg_committee::register_encryption_key(&mut session, &clock, OTHER_KEY, ts::ctx(&mut s));
        assert!(dkg_committee::encryption_key(&session, ALICE) == VALID_KEY, 6);
        assert!(dkg_committee::encryption_key(&session, BOB) == OTHER_KEY, 7);
        ts::return_shared(session);

        clock::destroy_for_testing(clock);
        ts::end(s);
    }

    #[test]
    #[expected_failure(abort_code = 3009, location = agent_vault::dkg_committee)]
    fun rejects_a_key_of_the_wrong_length() {
        let mut s = ts::begin(ALICE);
        let (mut session, clock) = open_session(&mut s, ALICE);
        // 64 bytes: a bare X||Y point without the 0x04 prefix.
        dkg_committee::register_encryption_key(
            &mut session, &clock,
            x"0303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303",
            ts::ctx(&mut s),
        );
        ts::return_shared(session);
        clock::destroy_for_testing(clock);
        ts::end(s);
    }

    #[test]
    #[expected_failure(abort_code = 3010, location = agent_vault::dkg_committee)]
    fun a_second_registration_is_rejected_so_delivered_shares_stay_decryptable() {
        let mut s = ts::begin(ALICE);
        let (mut session, clock) = open_session(&mut s, ALICE);
        dkg_committee::register_encryption_key(&mut session, &clock, VALID_KEY, ts::ctx(&mut s));
        // Rotating mid-ceremony would strand every share already sealed to the
        // old key, so the second registration aborts instead of overwriting.
        dkg_committee::register_encryption_key(&mut session, &clock, OTHER_KEY, ts::ctx(&mut s));
        ts::return_shared(session);
        clock::destroy_for_testing(clock);
        ts::end(s);
    }

    #[test]
    #[expected_failure(abort_code = 3001, location = agent_vault::dkg_committee)]
    fun a_non_participant_cannot_register() {
        let mut s = ts::begin(ALICE);
        let (mut session, clock) = open_session(&mut s, ALICE);
        ts::next_tx(&mut s, EVE);
        dkg_committee::register_encryption_key(&mut session, &clock, VALID_KEY, ts::ctx(&mut s));
        ts::return_shared(session);
        clock::destroy_for_testing(clock);
        ts::end(s);
    }

    #[test]
    fun revision_marks_the_registration_feature() {
        assert!(dkg_committee::dkg_revision() == 7, 0);
        let (len32, len65) = dkg_committee::encryption_key_lengths();
        assert!(len32 == 32 && len65 == 65, 1);
    }

    // ===== T2-a（round-10）：deposit_mailbox_share 准入门禁 =====
    const X25519_KEY_T2A: vector<u8> = x"112233445566778899001122334455667788990011223344556677889900aabb";

    /// (a) 2049 字节 payload 超过 MAX_MAILBOX_PAYLOAD_BYTES → 3028
    #[test]
    #[expected_failure(abort_code = agent_vault::dkg_committee::E_PAYLOAD_TOO_LARGE)]
    fun t2a_oversized_payload_aborts_3028() {
        let mut s = ts::begin(ALICE);
        let mut clock = clock::create_for_testing(ts::ctx(&mut s));
        clock::set_for_testing(&mut clock, 1_000_000);
        dkg_committee::create_dkg_session(2, vector[ALICE, BOB], 2_000_000, fee_coin(ts::ctx(&mut s)), &clock, ts::ctx(&mut s));

        ts::next_tx(&mut s, ALICE);
        {
            let mut session = ts::take_shared<DkgSession>(&s);
            dkg_committee::register_encryption_key(&mut session, &clock, X25519_KEY_T2A, ts::ctx(&mut s));
            ts::return_shared(session);
        };
        ts::next_tx(&mut s, BOB);
        {
            let mut session = ts::take_shared<DkgSession>(&s);
            dkg_committee::register_encryption_key(&mut session, &clock, X25519_KEY_T2A, ts::ctx(&mut s));
            ts::return_shared(session);
        };

        ts::next_tx(&mut s, ALICE);
        {
            let mut session = ts::take_shared<DkgSession>(&s);
            let mut junk = vector[];
            let mut i = 0;
            while (i < 2049) { junk.push_back(0xaa); i = i + 1; };
            dkg_committee::deposit_mailbox_share(&mut session, &clock, BOB, junk, ts::ctx(&mut s));
            ts::return_shared(session);
        };

        clock::destroy_for_testing(clock);
        ts::end(s);
    }

    /// (b) 恰好 2048 字节通过上限
    #[test]
    fun t2a_boundary_2048_payload_passes() {
        let mut s = ts::begin(ALICE);
        let mut clock = clock::create_for_testing(ts::ctx(&mut s));
        clock::set_for_testing(&mut clock, 1_000_000);
        dkg_committee::create_dkg_session(2, vector[ALICE, BOB], 2_000_000, fee_coin(ts::ctx(&mut s)), &clock, ts::ctx(&mut s));

        ts::next_tx(&mut s, ALICE);
        {
            let mut session = ts::take_shared<DkgSession>(&s);
            dkg_committee::register_encryption_key(&mut session, &clock, X25519_KEY_T2A, ts::ctx(&mut s));
            ts::return_shared(session);
        };
        ts::next_tx(&mut s, BOB);
        {
            let mut session = ts::take_shared<DkgSession>(&s);
            dkg_committee::register_encryption_key(&mut session, &clock, X25519_KEY_T2A, ts::ctx(&mut s));
            ts::return_shared(session);
        };

        ts::next_tx(&mut s, ALICE);
        {
            let mut session = ts::take_shared<DkgSession>(&s);
            let mut payload = vector[];
            let mut i = 0;
            while (i < 2048) { payload.push_back(0xab); i = i + 1; };
            dkg_committee::deposit_mailbox_share(&mut session, &clock, BOB, payload, ts::ctx(&mut s));
            assert!(dkg_committee::has_mailbox_share(&session, ALICE, BOB), 1);
            ts::return_shared(session);
        };

        clock::destroy_for_testing(clock);
        ts::end(s);
    }

    /// (c) recipient 未登记加密公钥 → 3029
    #[test]
    #[expected_failure(abort_code = agent_vault::dkg_committee::E_RECIPIENT_KEY_MISSING)]
    fun t2a_unregistered_recipient_aborts_3029() {
        let mut s = ts::begin(ALICE);
        let mut clock = clock::create_for_testing(ts::ctx(&mut s));
        clock::set_for_testing(&mut clock, 1_000_000);
        dkg_committee::create_dkg_session(2, vector[ALICE, BOB], 2_000_000, fee_coin(ts::ctx(&mut s)), &clock, ts::ctx(&mut s));

        ts::next_tx(&mut s, ALICE);
        {
            let mut session = ts::take_shared<DkgSession>(&s);
            dkg_committee::register_encryption_key(&mut session, &clock, X25519_KEY_T2A, ts::ctx(&mut s));
            ts::return_shared(session);
        };
        // BOB 不登记

        ts::next_tx(&mut s, ALICE);
        {
            let mut session = ts::take_shared<DkgSession>(&s);
            dkg_committee::deposit_mailbox_share(&mut session, &clock, BOB, b"poison", ts::ctx(&mut s));
            ts::return_shared(session);
        };

        clock::destroy_for_testing(clock);
        ts::end(s);
    }

    /// (d) 正常投递：recipient 已登记 → 通过
    #[test]
    fun t2a_registered_recipient_deposit_passes() {
        let mut s = ts::begin(ALICE);
        let mut clock = clock::create_for_testing(ts::ctx(&mut s));
        clock::set_for_testing(&mut clock, 1_000_000);
        dkg_committee::create_dkg_session(2, vector[ALICE, BOB], 2_000_000, fee_coin(ts::ctx(&mut s)), &clock, ts::ctx(&mut s));

        ts::next_tx(&mut s, ALICE);
        {
            let mut session = ts::take_shared<DkgSession>(&s);
            dkg_committee::register_encryption_key(&mut session, &clock, X25519_KEY_T2A, ts::ctx(&mut s));
            ts::return_shared(session);
        };
        ts::next_tx(&mut s, BOB);
        {
            let mut session = ts::take_shared<DkgSession>(&s);
            dkg_committee::register_encryption_key(&mut session, &clock, X25519_KEY_T2A, ts::ctx(&mut s));
            ts::return_shared(session);
        };

        ts::next_tx(&mut s, ALICE);
        {
            let mut session = ts::take_shared<DkgSession>(&s);
            dkg_committee::deposit_mailbox_share(&mut session, &clock, BOB, b"sealed_share", ts::ctx(&mut s));
            assert!(dkg_committee::has_mailbox_share(&session, ALICE, BOB), 1);
            ts::return_shared(session);
        };

        clock::destroy_for_testing(clock);
        ts::end(s);
    }

    /// (e) submit_async_package 批量路径同样受门禁：一个坏 payload 整包 abort 3028
    #[test]
    #[expected_failure(abort_code = agent_vault::dkg_committee::E_PAYLOAD_TOO_LARGE)]
    fun t2a_async_package_bad_payload_aborts_whole_tx() {
        let mut s = ts::begin(ALICE);
        let mut clock = clock::create_for_testing(ts::ctx(&mut s));
        clock::set_for_testing(&mut clock, 1_000_000);
        dkg_committee::create_dkg_session(2, vector[ALICE, BOB], 2_000_000, fee_coin(ts::ctx(&mut s)), &clock, ts::ctx(&mut s));

        ts::next_tx(&mut s, ALICE);
        {
            let mut session = ts::take_shared<DkgSession>(&s);
            dkg_committee::register_encryption_key(&mut session, &clock, X25519_KEY_T2A, ts::ctx(&mut s));
            ts::return_shared(session);
        };
        ts::next_tx(&mut s, BOB);
        {
            let mut session = ts::take_shared<DkgSession>(&s);
            dkg_committee::register_encryption_key(&mut session, &clock, X25519_KEY_T2A, ts::ctx(&mut s));
            ts::return_shared(session);
        };

        ts::next_tx(&mut s, ALICE);
        {
            let mut session = ts::take_shared<DkgSession>(&s);
            let mut junk = vector[];
            let mut i = 0;
            while (i < 3000) { junk.push_back(0x00); i = i + 1; };
            dkg_committee::submit_async_package(
                &mut session, &clock,
                x"aaaa000000000000000000000000000000000000000000000000000000000000", ATTEST_PK,
                vector[BOB],
                vector[junk],
                bond_coin(ts::ctx(&mut s)), ts::ctx(&mut s),
            );
            ts::return_shared(session);
        };

        clock::destroy_for_testing(clock);
        ts::end(s);
    }
}

/// The group key is no longer whatever the finalize caller supplies. It must be
/// attested by `threshold` confirmed participants, each of whom recomputed it
/// from the on-chain commitments. These tests pin the new gate and prove the two
/// legacy entry points are unreachable.
#[test_only]
module agent_vault::dkg_committee_attestation_tests {
    use sui::test_scenario::{Self as ts};
    use sui::clock::{Self, Clock};
    use sui::coin;
    use sui::sui::SUI;
    use sui::tx_context::TxContext;
    use agent_vault::dkg_committee::{Self, DkgSession};

    const ALICE: address = @0xA11CE;
    const ATTEST_PK: vector<u8> = x"4141414141414141414141414141414141414141414141414141414141414141";
    const BOB: address = @0xB0B;
    const CHARLIE: address = @0xC0C;
    const EVE: address = @0xEE7E;

    const KEY_A: vector<u8> = x"3b6a27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da29";
    const KEY_B: vector<u8> = x"1b4a27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da28";

    fun fee_coin(ctx: &mut TxContext): coin::Coin<SUI> {
        coin::mint_for_testing<SUI>(dkg_committee::creation_fee_mist(), ctx)
    }

    fun bond_coin(ctx: &mut TxContext): coin::Coin<SUI> {
        let (min_bond, _max) = dkg_committee::bond_bounds();
        coin::mint_for_testing<SUI>(min_bond, ctx)
    }

    fun zero_coin(ctx: &mut TxContext): coin::Coin<SUI> {
        coin::mint_for_testing<SUI>(0, ctx)
    }

    /// Creates a 2-of-3 session, has ALICE and BOB submit commitments so the
    /// session advances to Round 2, then returns the shared object as `reader`.
    fun open_round_two(s: &mut ts::Scenario, reader: address): (DkgSession, Clock) {
        let mut clock = clock::create_for_testing(ts::ctx(s));
        clock::set_for_testing(&mut clock, 1_000_000);
        let _id = dkg_committee::create_dkg_session(
            2, vector[ALICE, BOB, CHARLIE], 2_000_000, fee_coin(ts::ctx(s)), &clock, ts::ctx(s),
        );

        ts::next_tx(s, ALICE);
        {
            let mut session = ts::take_shared<DkgSession>(s);
            dkg_committee::submit_commitment(&mut session, &clock, x"0101000000000000000000000000000000000000000000000000000000000000", ATTEST_PK, bond_coin(ts::ctx(s)), ts::ctx(s));
            ts::return_shared(session);
        };
        ts::next_tx(s, BOB);
        {
            let mut session = ts::take_shared<DkgSession>(s);
            dkg_committee::submit_commitment(&mut session, &clock, x"0202000000000000000000000000000000000000000000000000000000000000", ATTEST_PK, bond_coin(ts::ctx(s)), ts::ctx(s));
            ts::return_shared(session);
        };

        ts::next_tx(s, reader);
        let session = ts::take_shared<DkgSession>(s);
        (session, clock)
    }

    #[test]
    fun an_unattested_key_is_not_counted_as_any_attestation() {
        let mut s = ts::begin(ALICE);
        let (session, clock) = open_round_two(&mut s, ALICE);

        assert!(dkg_committee::attestations_for(&session, KEY_A) == 0, 0);
        // No slot means "never attested": the borrow accessor aborts on a
        // missing slot, and attested_key_matches is simply false.
        assert!(!dkg_committee::attested_key_matches(&session, ALICE, &KEY_A), 1);
        assert!(!dkg_committee::attested_key_matches(&session, BOB, &KEY_A), 2);

        ts::return_shared(session);
        clock::destroy_for_testing(clock);
        ts::end(s);
    }

    #[test]
    #[expected_failure(abort_code = 3012, location = agent_vault::dkg_committee)]
    fun finalize_rejects_a_key_no_one_attested() {
        let mut s = ts::begin(ALICE);
        let (mut session, clock) = open_round_two(&mut s, ALICE);

        dkg_committee::confirm_participant(&mut session, &clock, ts::ctx(&mut s));
        ts::return_shared(session);

        ts::next_tx(&mut s, BOB);
        {
            let mut session = ts::take_shared<DkgSession>(&s);
            dkg_committee::confirm_participant(&mut session, &clock, ts::ctx(&mut s));
            ts::return_shared(session);
        };

        ts::next_tx(&mut s, CHARLIE);
        {
            let mut session = ts::take_shared<DkgSession>(&s);
            // Quorum confirmed, but nobody attested to this key.
            dkg_committee::finalize_session(&mut session, KEY_A, ts::ctx(&mut s));
            ts::return_shared(session);
        };

        clock::destroy_for_testing(clock);
        ts::end(s);
    }

    #[test]
    #[expected_failure(abort_code = 3011, location = agent_vault::dkg_committee)]
    fun an_unconfirmed_member_cannot_attest() {
        let mut s = ts::begin(ALICE);
        let (mut session, clock) = open_round_two(&mut s, ALICE);

        dkg_committee::confirm_participant(&mut session, &clock, ts::ctx(&mut s));
        ts::return_shared(session);

        // CHARLIE never confirmed, so it cannot know the key it claims to vouch for.
        ts::next_tx(&mut s, CHARLIE);
        {
            let mut session = ts::take_shared<DkgSession>(&s);
            dkg_committee::attest_group_key_for_testing(&mut session, &clock, KEY_A, ts::ctx(&mut s));
            ts::return_shared(session);
        };

        clock::destroy_for_testing(clock);
        ts::end(s);
    }

    #[test]
    #[expected_failure(abort_code = 3001, location = agent_vault::dkg_committee)]
    fun a_non_participant_cannot_attest() {
        let mut s = ts::begin(ALICE);
        let (mut session, clock) = open_round_two(&mut s, ALICE);
        ts::return_shared(session);

        ts::next_tx(&mut s, EVE);
        {
            let mut session = ts::take_shared<DkgSession>(&s);
            dkg_committee::attest_group_key_for_testing(&mut session, &clock, KEY_A, ts::ctx(&mut s));
            ts::return_shared(session);
        };

        clock::destroy_for_testing(clock);
        ts::end(s);
    }

    #[test]
    #[expected_failure(abort_code = 3004, location = agent_vault::dkg_committee)]
    fun attestation_after_the_deadline_is_rejected() {
        let mut s = ts::begin(ALICE);
        let (mut session, mut clock) = open_round_two(&mut s, ALICE);

        dkg_committee::confirm_participant(&mut session, &clock, ts::ctx(&mut s));
        clock::set_for_testing(&mut clock, 2_000_001);
        dkg_committee::attest_group_key_for_testing(&mut session, &clock, KEY_A, ts::ctx(&mut s));

        ts::return_shared(session);
        clock::destroy_for_testing(clock);
        ts::end(s);
    }

    #[test]
    fun threshold_members_attesting_the_same_key_finalize_it() {
        let mut s = ts::begin(ALICE);
        let (mut session, clock) = open_round_two(&mut s, ALICE);

        dkg_committee::confirm_participant(&mut session, &clock, ts::ctx(&mut s));
        dkg_committee::attest_group_key_for_testing(&mut session, &clock, KEY_A, ts::ctx(&mut s));
        ts::return_shared(session);

        ts::next_tx(&mut s, BOB);
        {
            let mut session = ts::take_shared<DkgSession>(&s);
            dkg_committee::confirm_participant(&mut session, &clock, ts::ctx(&mut s));
            dkg_committee::attest_group_key_for_testing(&mut session, &clock, KEY_A, ts::ctx(&mut s));
            assert!(dkg_committee::attestations_for(&session, KEY_A) == 2, 0);
            ts::return_shared(session);
        };

        // Any address may finalize once the attestations exist; the caller's
        // identity no longer decides the key.
        ts::next_tx(&mut s, CHARLIE);
        {
            let mut session = ts::take_shared<DkgSession>(&s);
            assert!(dkg_committee::status(&session) == 2, 1);
            dkg_committee::finalize_session(&mut session, KEY_A, ts::ctx(&mut s));
            assert!(dkg_committee::status(&session) == 3, 2);
            assert!(dkg_committee::final_public_key(&session) == KEY_A, 3);
            ts::return_shared(session);
        };

        clock::destroy_for_testing(clock);
        ts::end(s);
    }

    #[test]
    #[expected_failure(abort_code = 3012, location = agent_vault::dkg_committee)]
    fun attestations_split_across_different_keys_do_not_add_up() {
        let mut s = ts::begin(ALICE);
        let (mut session, clock) = open_round_two(&mut s, ALICE);

        dkg_committee::confirm_participant(&mut session, &clock, ts::ctx(&mut s));
        dkg_committee::attest_group_key_for_testing(&mut session, &clock, KEY_A, ts::ctx(&mut s));
        ts::return_shared(session);

        ts::next_tx(&mut s, BOB);
        {
            let mut session = ts::take_shared<DkgSession>(&s);
            dkg_committee::confirm_participant(&mut session, &clock, ts::ctx(&mut s));
            dkg_committee::attest_group_key_for_testing(&mut session, &clock, KEY_B, ts::ctx(&mut s));
            assert!(dkg_committee::attestations_for(&session, KEY_A) == 1, 0);
            assert!(dkg_committee::attestations_for(&session, KEY_B) == 1, 1);
            ts::return_shared(session);
        };

        ts::next_tx(&mut s, CHARLIE);
        {
            let mut session = ts::take_shared<DkgSession>(&s);
            // One vote each is not two votes for either key.
            dkg_committee::finalize_session(&mut session, KEY_A, ts::ctx(&mut s));
            ts::return_shared(session);
        };

        clock::destroy_for_testing(clock);
        ts::end(s);
    }

    #[test]
    fun re_attesting_overwrites_the_earlier_value() {
        let mut s = ts::begin(ALICE);
        let (mut session, clock) = open_round_two(&mut s, ALICE);

        dkg_committee::confirm_participant(&mut session, &clock, ts::ctx(&mut s));
        dkg_committee::attest_group_key_for_testing(&mut session, &clock, KEY_A, ts::ctx(&mut s));
        assert!(dkg_committee::attested_key_of(&session, ALICE) == &KEY_A, 0);
        ts::return_shared(session);

        ts::next_tx(&mut s, ALICE);
        {
            let mut session = ts::take_shared<DkgSession>(&s);
            dkg_committee::attest_group_key_for_testing(&mut session, &clock, KEY_B, ts::ctx(&mut s));
            assert!(dkg_committee::attested_key_of(&session, ALICE) == &KEY_B, 1);
            // The old value is gone, not accumulated.
            assert!(dkg_committee::attestations_for(&session, KEY_A) == 0, 2);
            ts::return_shared(session);
        };

        clock::destroy_for_testing(clock);
        ts::end(s);
    }

    #[test]
    #[expected_failure(abort_code = 3002, location = agent_vault::dkg_committee)]
    fun finalize_is_rejected_before_round_two() {
        let mut s = ts::begin(ALICE);
        let mut clock = clock::create_for_testing(ts::ctx(&mut s));
        clock::set_for_testing(&mut clock, 1_000_000);
        let _id = dkg_committee::create_dkg_session(
            2, vector[ALICE, BOB, CHARLIE], 2_000_000, fee_coin(ts::ctx(&mut s)), &clock, ts::ctx(&mut s),
        );

        ts::next_tx(&mut s, ALICE);
        {
            let mut session = ts::take_shared<DkgSession>(&s);
            dkg_committee::finalize_session(&mut session, KEY_A, ts::ctx(&mut s));
            ts::return_shared(session);
        };

        clock::destroy_for_testing(clock);
        ts::end(s);
    }

    #[test]
    #[expected_failure(abort_code = 3014, location = agent_vault::dkg_committee)]
    fun create_rejects_a_duplicated_participant() {
        // Duplicates are the dangerous case, not merely a dead session:
        // `attestation_count_for` walks the participant list and reads one
        // dynamic field per entry, so one address listed twice is tallied twice
        // while `confirmations` (keyed by address) still holds a single entry.
        // Two real members could then satisfy a threshold of 3.
        let mut s = ts::begin(ALICE);
        let mut clock = clock::create_for_testing(ts::ctx(&mut s));
        clock::set_for_testing(&mut clock, 1_000_000);
        let _id = dkg_committee::create_dkg_session(
            2, vector[ALICE, ALICE, BOB], 2_000_000, fee_coin(ts::ctx(&mut s)), &clock, ts::ctx(&mut s),
        );
        clock::destroy_for_testing(clock);
        ts::end(s);
    }

    #[test]
    #[expected_failure(abort_code = 3014, location = agent_vault::dkg_committee)]
    fun create_rejects_the_zero_address() {
        let mut s = ts::begin(ALICE);
        let mut clock = clock::create_for_testing(ts::ctx(&mut s));
        clock::set_for_testing(&mut clock, 1_000_000);
        let _id = dkg_committee::create_dkg_session(
            1, vector[ALICE, @0x0], 2_000_000, fee_coin(ts::ctx(&mut s)), &clock, ts::ctx(&mut s),
        );
        clock::destroy_for_testing(clock);
        ts::end(s);
    }

    #[test]
    #[expected_failure(abort_code = 3014, location = agent_vault::dkg_committee)]
    fun resharing_creation_rejects_a_duplicated_participant() {
        let mut s = ts::begin(ALICE);
        let _id = dkg_committee::create_resharing_session(
            2, 2, vector[ALICE, ALICE], 2_000_000, ts::ctx(&mut s),
        );
        ts::end(s);
    }

    #[test]
    #[expected_failure(abort_code = 3001, location = agent_vault::dkg_committee)]
    fun create_rejects_a_creator_who_is_not_a_participant() {
        // A creator outside the committee could otherwise mint a session whose
        // state machine nobody in the list ever consented to.
        let mut s = ts::begin(ALICE);
        let mut clock = clock::create_for_testing(ts::ctx(&mut s));
        clock::set_for_testing(&mut clock, 1_000_000);
        let _id = dkg_committee::create_dkg_session(
            2, vector[BOB, CHARLIE], 2_000_000, fee_coin(ts::ctx(&mut s)), &clock, ts::ctx(&mut s),
        );
        clock::destroy_for_testing(clock);
        ts::end(s);
    }

    #[test]
    #[expected_failure(abort_code = 3014, location = agent_vault::dkg_committee)]
    fun create_rejects_more_than_128_participants() {
        // The participant-set walk is O(n) per attestation count; without a
        // cap a caller could pin a session with a pathologically long list.
        let mut s = ts::begin(ALICE);
        let mut clock = clock::create_for_testing(ts::ctx(&mut s));
        clock::set_for_testing(&mut clock, 1_000_000);
        // 129 entries, all distinct, non-zero, and including the creator:
        // only the length is invalid.
        let participants = vector[@0xA11CE, @0x2, @0x3, @0x4, @0x5, @0x6, @0x7, @0x8, @0x9, @0xa, @0xb, @0xc, @0xd, @0xe, @0xf, @0x10, @0x11, @0x12, @0x13, @0x14, @0x15, @0x16, @0x17, @0x18, @0x19, @0x1a, @0x1b, @0x1c, @0x1d, @0x1e, @0x1f, @0x20, @0x21, @0x22, @0x23, @0x24, @0x25, @0x26, @0x27, @0x28, @0x29, @0x2a, @0x2b, @0x2c, @0x2d, @0x2e, @0x2f, @0x30, @0x31, @0x32, @0x33, @0x34, @0x35, @0x36, @0x37, @0x38, @0x39, @0x3a, @0x3b, @0x3c, @0x3d, @0x3e, @0x3f, @0x40, @0x41, @0x42, @0x43, @0x44, @0x45, @0x46, @0x47, @0x48, @0x49, @0x4a, @0x4b, @0x4c, @0x4d, @0x4e, @0x4f, @0x50, @0x51, @0x52, @0x53, @0x54, @0x55, @0x56, @0x57, @0x58, @0x59, @0x5a, @0x5b, @0x5c, @0x5d, @0x5e, @0x5f, @0x60, @0x61, @0x62, @0x63, @0x64, @0x65, @0x66, @0x67, @0x68, @0x69, @0x6a, @0x6b, @0x6c, @0x6d, @0x6e, @0x6f, @0x70, @0x71, @0x72, @0x73, @0x74, @0x75, @0x76, @0x77, @0x78, @0x79, @0x7a, @0x7b, @0x7c, @0x7d, @0x7e, @0x7f, @0x80, @0x83];
        let _id = dkg_committee::create_dkg_session(
            2, participants, 2_000_000, fee_coin(ts::ctx(&mut s)), &clock, ts::ctx(&mut s),
        );
        clock::destroy_for_testing(clock);
        ts::end(s);
    }

    #[test]
    #[expected_failure(abort_code = 3015, location = agent_vault::dkg_committee)]
    fun a_commitment_shorter_than_32_bytes_is_rejected() {
        // A commitment is read off-chain as a curve point; 16 bytes can never
        // be one, so it is rejected rather than stored as opaque data.
        let mut s = ts::begin(ALICE);
        let mut clock = clock::create_for_testing(ts::ctx(&mut s));
        clock::set_for_testing(&mut clock, 1_000_000);
        let _id = dkg_committee::create_dkg_session(
            2, vector[ALICE, BOB, CHARLIE], 2_000_000, fee_coin(ts::ctx(&mut s)), &clock, ts::ctx(&mut s),
        );

        ts::next_tx(&mut s, ALICE);
        {
            let mut session = ts::take_shared<DkgSession>(&mut s);
            dkg_committee::submit_commitment(
                &mut session, &clock,
                x"0102030405060708090a0b0c0d0e0f10", ATTEST_PK, bond_coin(ts::ctx(&mut s)), ts::ctx(&mut s),
            );
            ts::return_shared(session);
        };

        clock::destroy_for_testing(clock);
        ts::end(s);
    }

    #[test]
    #[expected_failure(abort_code = 3016, location = agent_vault::dkg_committee)]
    fun confirming_before_submitting_a_commitment_is_rejected() {
        // A confirmation vouches for shares checked against the commitments;
        // with none on file there is nothing to have checked.
        let mut s = ts::begin(ALICE);
        let mut clock = clock::create_for_testing(ts::ctx(&mut s));
        clock::set_for_testing(&mut clock, 1_000_000);
        let _id = dkg_committee::create_dkg_session(
            2, vector[ALICE, BOB, CHARLIE], 2_000_000, fee_coin(ts::ctx(&mut s)), &clock, ts::ctx(&mut s),
        );

        ts::next_tx(&mut s, ALICE);
        {
            let mut session = ts::take_shared<DkgSession>(&mut s);
            dkg_committee::confirm_participant(&mut session, &clock, ts::ctx(&mut s));
            ts::return_shared(session);
        };

        clock::destroy_for_testing(clock);
        ts::end(s);
    }

    #[test]
    #[expected_failure(abort_code = 3002, location = agent_vault::dkg_committee)]
    fun attesting_during_round_one_is_rejected() {
        // Round 1 is still collecting commitments, so the key they add up to
        // is not fixed yet; vouching for any value now is premature.
        let mut s = ts::begin(ALICE);
        let mut clock = clock::create_for_testing(ts::ctx(&mut s));
        clock::set_for_testing(&mut clock, 1_000_000);
        let _id = dkg_committee::create_dkg_session(
            2, vector[ALICE, BOB, CHARLIE], 2_000_000, fee_coin(ts::ctx(&mut s)), &clock, ts::ctx(&mut s),
        );

        ts::next_tx(&mut s, ALICE);
        {
            let mut session = ts::take_shared<DkgSession>(&mut s);
            dkg_committee::submit_commitment(
                &mut session, &clock,
                x"0101000000000000000000000000000000000000000000000000000000000000", ATTEST_PK, bond_coin(ts::ctx(&mut s)), ts::ctx(&mut s),
            );
            assert!(dkg_committee::status(&session) == 1, 0);
            dkg_committee::confirm_participant(&mut session, &clock, ts::ctx(&mut s));
            dkg_committee::attest_group_key_for_testing(&mut session, &clock, KEY_A, ts::ctx(&mut s));
            ts::return_shared(session);
        };

        clock::destroy_for_testing(clock);
        ts::end(s);
    }


    // === Attestation 绑定（真实路径，#16 修复） ===

    const REAL_GROUP_PK: vector<u8> = x"3b6a27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da29";
    // sk=0x41*32 的真实 ed25519 公钥（签名 fixture 与之配套）
    const REAL_ATTEST_PK: vector<u8> = x"db995fe25169d141cab9bbba92baa01f9f2e1ece7df4cb2ac05190f37fcc1f9d";
    const ATTEST_SIG_VALID: vector<u8> = x"78d273339ec6b5a2462309bb4e02dbae0004be713a9e7c11a9a0b25995f8c86c0bb651fe89867ed14e3ce2727a0cd97cda55830da1b259c25ce941c5065f270f";
    const ATTEST_SIG_FORGED: vector<u8> = x"01010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101";
    // 对「全零 group_pk」摘要签出的合法签名 — 用于证明摘要绑定 group_pk
    const ATTEST_SIG_WRONG_DIGEST: vector<u8> = x"c3b6105f8686197f9fe1e0e1140644a9591a926f176ed8e50018a6cbd2242fe53c6e76f3a176980d61bb9cfe9a28fa811d4028a6a960e052ea104855e44bd30a";

    /// 有效签名：公布公钥下对 (session_id ‖ group_pk) 的真实 ed25519 签名 → attest 成功，finalize 成功。
    #[test]
    fun real_path_attest_with_valid_signature_finalizes() {
        let mut scenario = ts::begin(ALICE);
        let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 1_000_000);
        let participants = vector[ALICE, BOB];
        dkg_committee::create_dkg_session(2, participants, 2_000_000, fee_coin(ts::ctx(&mut scenario)), &clock, ts::ctx(&mut scenario));

        ts::next_tx(&mut scenario, ALICE);
        {
            let mut session = ts::take_shared<DkgSession>(&scenario);
            dkg_committee::submit_commitment(&mut session, &clock, x"aaaa000000000000000000000000000000000000000000000000000000000000", REAL_ATTEST_PK, bond_coin(ts::ctx(&mut scenario)), ts::ctx(&mut scenario));
            ts::return_shared(session);
        };
        ts::next_tx(&mut scenario, BOB);
        {
            let mut session = ts::take_shared<DkgSession>(&scenario);
            dkg_committee::submit_commitment(&mut session, &clock, x"bbbb000000000000000000000000000000000000000000000000000000000000", REAL_ATTEST_PK, bond_coin(ts::ctx(&mut scenario)), ts::ctx(&mut scenario));
            dkg_committee::confirm_participant(&mut session, &clock, ts::ctx(&mut scenario));
            dkg_committee::attest_group_key(&mut session, &clock, REAL_GROUP_PK, ATTEST_SIG_VALID, ts::ctx(&mut scenario));
            ts::return_shared(session);
        };
        ts::next_tx(&mut scenario, ALICE);
        {
            let mut session = ts::take_shared<DkgSession>(&scenario);
            dkg_committee::confirm_participant(&mut session, &clock, ts::ctx(&mut scenario));
            dkg_committee::attest_group_key(&mut session, &clock, REAL_GROUP_PK, ATTEST_SIG_VALID, ts::ctx(&mut scenario));
            ts::return_shared(session);
        };
        ts::next_tx(&mut scenario, ALICE);
        {
            let mut session = ts::take_shared<DkgSession>(&scenario);
            dkg_committee::finalize_session(&mut session, REAL_GROUP_PK, ts::ctx(&mut scenario));
            assert!(dkg_committee::status(&session) == 3, 3100);
            ts::return_shared(session);
        };
        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    /// 伪造签名（未用公布公钥签出摘要）→ E_ATTEST_SIGNATURE_INVALID (3018)。
    #[test]
    #[expected_failure(abort_code = 3018, location = agent_vault::dkg_committee)]
    fun real_path_attest_with_forged_signature_aborts() {
        let mut scenario = ts::begin(ALICE);
        let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 1_000_000);
        let participants = vector[ALICE, BOB];
        dkg_committee::create_dkg_session(2, participants, 2_000_000, fee_coin(ts::ctx(&mut scenario)), &clock, ts::ctx(&mut scenario));

        ts::next_tx(&mut scenario, ALICE);
        {
            let mut session = ts::take_shared<DkgSession>(&scenario);
            dkg_committee::submit_commitment(&mut session, &clock, x"aaaa000000000000000000000000000000000000000000000000000000000000", REAL_ATTEST_PK, bond_coin(ts::ctx(&mut scenario)), ts::ctx(&mut scenario));
            ts::return_shared(session);
        };
        ts::next_tx(&mut scenario, BOB);
        {
            let mut session = ts::take_shared<DkgSession>(&scenario);
            dkg_committee::submit_commitment(&mut session, &clock, x"bbbb000000000000000000000000000000000000000000000000000000000000", REAL_ATTEST_PK, bond_coin(ts::ctx(&mut scenario)), ts::ctx(&mut scenario));
            dkg_committee::confirm_participant(&mut session, &clock, ts::ctx(&mut scenario));
            dkg_committee::attest_group_key(&mut session, &clock, REAL_GROUP_PK, ATTEST_SIG_FORGED, ts::ctx(&mut scenario));
            ts::return_shared(session);
        };
        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    /// 签名绑定的摘要里换了 group_pk（对全零公钥签的）→ 也必须 3018。
    #[test]
    #[expected_failure(abort_code = 3018, location = agent_vault::dkg_committee)]
    fun real_path_attest_with_signature_over_other_pk_aborts() {
        let mut scenario = ts::begin(ALICE);
        let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 1_000_000);
        let participants = vector[ALICE, BOB];
        dkg_committee::create_dkg_session(2, participants, 2_000_000, fee_coin(ts::ctx(&mut scenario)), &clock, ts::ctx(&mut scenario));

        ts::next_tx(&mut scenario, ALICE);
        {
            let mut session = ts::take_shared<DkgSession>(&scenario);
            dkg_committee::submit_commitment(&mut session, &clock, x"aaaa000000000000000000000000000000000000000000000000000000000000", REAL_ATTEST_PK, bond_coin(ts::ctx(&mut scenario)), ts::ctx(&mut scenario));
            ts::return_shared(session);
        };
        ts::next_tx(&mut scenario, BOB);
        {
            let mut session = ts::take_shared<DkgSession>(&scenario);
            dkg_committee::submit_commitment(&mut session, &clock, x"bbbb000000000000000000000000000000000000000000000000000000000000", REAL_ATTEST_PK, bond_coin(ts::ctx(&mut scenario)), ts::ctx(&mut scenario));
            dkg_committee::confirm_participant(&mut session, &clock, ts::ctx(&mut scenario));
            dkg_committee::attest_group_key(&mut session, &clock, REAL_GROUP_PK, ATTEST_SIG_WRONG_DIGEST, ts::ctx(&mut scenario));
            ts::return_shared(session);
        };
        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }
}

/// 准入经济学（Revision 6）测试：创建费销毁、截止时长夹取、参与保证金
/// 托管与 Pull 模型退款、创世质押托管。保证金走 claim_bond 两种终态
/// 一视同仁全额退款；超额缴款是自愿创世质押，由组织固化扫入（org 侧测试）。
#[test_only]
module agent_vault::dkg_committee_economics_tests {
    use sui::test_scenario::{Self as ts};
    use sui::clock::{Self, Clock};
    use sui::coin::{Self};
    use sui::sui::SUI;
    use sui::tx_context::TxContext;
    use agent_vault::dkg_committee::{Self, DkgSession};

    const ALICE: address = @0xA11CE;
    const BOB: address = @0xB0B;
    const CHARLIE: address = @0xC0C;
    const ATTEST_PK: vector<u8> = x"4141414141414141414141414141414141414141414141414141414141414141";
    const COMMITMENT: vector<u8> = x"aaaa000000000000000000000000000000000000000000000000000000000000";

    fun fee_coin(ctx: &mut TxContext): coin::Coin<SUI> {
        coin::mint_for_testing<SUI>(dkg_committee::creation_fee_mist(), ctx)
    }

    fun bond_coin(ctx: &mut TxContext): coin::Coin<SUI> {
        let (min_bond, _max) = dkg_committee::bond_bounds();
        coin::mint_for_testing<SUI>(min_bond, ctx)
    }

    fun under_bond_coin(ctx: &mut TxContext): coin::Coin<SUI> {
        let (min_bond, _max) = dkg_committee::bond_bounds();
        coin::mint_for_testing<SUI>(min_bond - 1, ctx)
    }

    /// 2-of-3 会话：ALICE 与 BOB 已按 bond 缴款提交承诺（时钟 1_000_000）。
    /// 返回 (session, clock)，调用方负责 return_shared + destroy + end。
    fun open_two_submitted(s: &mut ts::Scenario): (DkgSession, Clock) {
        let mut clock = clock::create_for_testing(ts::ctx(s));
        clock::set_for_testing(&mut clock, 1_000_000);
        let _id = dkg_committee::create_dkg_session(
            2, vector[ALICE, BOB, CHARLIE], 2_000_000, fee_coin(ts::ctx(s)), &clock, ts::ctx(s),
        );

        ts::next_tx(s, ALICE);
        {
            let mut session = ts::take_shared<DkgSession>(s);
            dkg_committee::submit_commitment(&mut session, &clock, COMMITMENT, ATTEST_PK, bond_coin(ts::ctx(s)), ts::ctx(s));
            ts::return_shared(session);
        };
        ts::next_tx(s, BOB);
        {
            let mut session = ts::take_shared<DkgSession>(s);
            dkg_committee::submit_commitment(&mut session, &clock, COMMITMENT, ATTEST_PK, bond_coin(ts::ctx(s)), ts::ctx(s));
            ts::return_shared(session);
        };
        ts::next_tx(s, ALICE);
        {
            let mut session = ts::take_shared<DkgSession>(s);
            dkg_committee::confirm_participant(&mut session, &clock, ts::ctx(s));
            ts::return_shared(session);
        };
        ts::next_tx(s, BOB);
        {
            let mut session = ts::take_shared<DkgSession>(s);
            dkg_committee::confirm_participant(&mut session, &clock, ts::ctx(s));
            ts::return_shared(session);
        };

        ts::next_tx(s, ALICE);
        let session = ts::take_shared<DkgSession>(s);
        (session, clock)
    }

    // (6) 创建费 < 0.005 SUI → E_BOND_INSUFFICIENT_PAYMENT (3022)
    #[test]
    #[expected_failure(abort_code = agent_vault::dkg_committee::E_BOND_INSUFFICIENT_PAYMENT)]
    fun creation_fee_below_minimum_aborts() {
        let mut s = ts::begin(ALICE);
        let mut clock = clock::create_for_testing(ts::ctx(&mut s));
        clock::set_for_testing(&mut clock, 1_000_000);
        let min_fee = dkg_committee::creation_fee_mist();
        let short_fee = coin::mint_for_testing<SUI>(min_fee - 1, ts::ctx(&mut s));
        let _ = dkg_committee::create_dkg_session(
            2, vector[ALICE, BOB, CHARLIE], 2_000_000, short_fee, &clock, ts::ctx(&mut s),
        );
        clock::destroy_for_testing(clock);
        ts::end(s);
    }

    // (7a) 时长 < 10 分钟 → E_DEADLINE_OUT_OF_RANGE (3025)
    #[test]
    #[expected_failure(abort_code = agent_vault::dkg_committee::E_DEADLINE_OUT_OF_RANGE)]
    fun deadline_shorter_than_floor_aborts() {
        let mut s = ts::begin(ALICE);
        let mut clock = clock::create_for_testing(ts::ctx(&mut s));
        clock::set_for_testing(&mut clock, 1_000_000);
        // now + 599_999 ms：比 10 分钟下限少 1ms
        let _ = dkg_committee::create_dkg_session(
            2, vector[ALICE, BOB, CHARLIE], 1_000_000 + 599_999, fee_coin(ts::ctx(&mut s)), &clock, ts::ctx(&mut s),
        );
        clock::destroy_for_testing(clock);
        ts::end(s);
    }

    // (7b) 时长 > 7 天 → E_DEADLINE_OUT_OF_RANGE (3025)
    #[test]
    #[expected_failure(abort_code = agent_vault::dkg_committee::E_DEADLINE_OUT_OF_RANGE)]
    fun deadline_beyond_ceiling_aborts() {
        let mut s = ts::begin(ALICE);
        let mut clock = clock::create_for_testing(ts::ctx(&mut s));
        clock::set_for_testing(&mut clock, 1_000_000);
        // now + 604_800_000 + 1 ms：比 7 天上限多 1ms
        let _ = dkg_committee::create_dkg_session(
            2, vector[ALICE, BOB, CHARLIE], 1_000_000 + 604_800_001, fee_coin(ts::ctx(&mut s)), &clock, ts::ctx(&mut s),
        );
        clock::destroy_for_testing(clock);
        ts::end(s);
    }

    // (7 边界) 时长恰好 10 分钟与 7 天必须通过（下上界含端点）
    #[test]
    fun deadline_exact_bounds_pass() {
        let mut s = ts::begin(ALICE);
        let mut clock = clock::create_for_testing(ts::ctx(&mut s));
        clock::set_for_testing(&mut clock, 1_000_000);
        let (_min_dur, max_dur) = dkg_committee::session_duration_bounds_ms();

        let id_lo = dkg_committee::create_dkg_session(
            1, vector[ALICE], 1_000_000 + 600_000, fee_coin(ts::ctx(&mut s)), &clock, ts::ctx(&mut s),
        );
        let _id_hi = dkg_committee::create_dkg_session(
            1, vector[ALICE], 1_000_000 + max_dur, fee_coin(ts::ctx(&mut s)), &clock, ts::ctx(&mut s),
        );
        assert!(id_lo != _id_hi, 0);

        clock::destroy_for_testing(clock);
        ts::end(s);
    }

    // (1) 缴款低于保证金 → E_BOND_INSUFFICIENT_PAYMENT (3022)
    // 独立建会（无人提交、仍在 Round 1）：缴费校验位于 E_ALREADY_SUBMITTED
    // 与状态检查之后，必须让未提交的参与者来触发 3022。
    #[test]
    #[expected_failure(abort_code = agent_vault::dkg_committee::E_BOND_INSUFFICIENT_PAYMENT)]
    fun under_bond_payment_aborts() {
        let mut s = ts::begin(ALICE);
        let mut clock = clock::create_for_testing(ts::ctx(&mut s));
        clock::set_for_testing(&mut clock, 1_000_000);
        let _id = dkg_committee::create_dkg_session(
            2, vector[ALICE, BOB, CHARLIE], 2_000_000, fee_coin(ts::ctx(&mut s)), &clock, ts::ctx(&mut s),
        );

        ts::next_tx(&mut s, CHARLIE);
        {
            let mut session = ts::take_shared<DkgSession>(&s);
            dkg_committee::submit_commitment(&mut session, &clock, COMMITMENT, ATTEST_PK, under_bond_coin(ts::ctx(&mut s)), ts::ctx(&mut s));
            ts::return_shared(session);
        };

        clock::destroy_for_testing(clock);
        ts::end(s);
    }

    // (4) 终态前 claim → E_SESSION_NOT_TERMINAL (3024)
    #[test]
    #[expected_failure(abort_code = agent_vault::dkg_committee::E_SESSION_NOT_TERMINAL)]
    fun claim_before_terminal_state_aborts() {
        let mut s = ts::begin(ALICE);
        let (mut session, clock) = open_two_submitted(&mut s);
        dkg_committee::claim_bond(&mut session, ts::ctx(&mut s));
        ts::return_shared(session);
        clock::destroy_for_testing(clock);
        ts::end(s);
    }

    // (2) 固化后 claim_bond 全额退款
    #[test]
    fun claim_bond_after_finalize_refunds_full_bond() {
        let mut s = ts::begin(ALICE);
        let (mut session, clock) = open_two_submitted(&mut s);
        let bond_paid = dkg_committee::participant_bond_mist(&session, ALICE);
        assert!(bond_paid > 0, 0);
        let group_pk = x"3b6a27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da29";
        dkg_committee::finalize_session_for_testing(&mut session, group_pk, ts::ctx(&mut s));
        assert!(dkg_committee::status(&session) == 3, 1);
        ts::return_shared(session);

        ts::next_tx(&mut s, ALICE);
        {
            let mut session = ts::take_shared<DkgSession>(&s);
            dkg_committee::claim_bond(&mut session, ts::ctx(&mut s));
            assert!(dkg_committee::participant_bond_mist(&session, ALICE) == 0, 2);
            ts::return_shared(session);
        };

        // 退款全额到账（Pull 模型：币直接转给参与者）
        ts::next_tx(&mut s, ALICE);
        {
            let refund = ts::take_from_sender<coin::Coin<SUI>>(&s);
            assert!(coin::value(&refund) == bond_paid, 3);
            ts::return_to_sender(&s, refund);
        };

        clock::destroy_for_testing(clock);
        ts::end(s);
    }

    // (3) 超时后 claim_bond 全额退款 —— 反收割保证：退会不没收
    #[test]
    fun claim_bond_after_timeout_refunds_full_bond() {
        let mut s = ts::begin(ALICE);
        let (mut session, mut clock) = open_two_submitted(&mut s);
        let bond_paid = dkg_committee::participant_bond_mist(&session, ALICE);
        assert!(bond_paid > 0, 0);
        ts::return_shared(session);

        clock::set_for_testing(&mut clock, 3_000_000);
        ts::next_tx(&mut s, ALICE);
        {
            let mut session = ts::take_shared<DkgSession>(&s);
            dkg_committee::handle_session_timeout(&mut session, &clock);
            assert!(dkg_committee::status(&session) == 4, 1);
            dkg_committee::claim_bond(&mut session, ts::ctx(&mut s));
            ts::return_shared(session);
        };

        ts::next_tx(&mut s, ALICE);
        {
            let refund = ts::take_from_sender<coin::Coin<SUI>>(&s);
            assert!(coin::value(&refund) == bond_paid, 2);
            ts::return_to_sender(&s, refund);
        };

        clock::destroy_for_testing(clock);
        ts::end(s);
    }

    // 【审计 H-02 回归】TIMED_OUT 会话中，超额创世质押可通过 claim_stake 原路退回
    #[test]
    fun audit_h02_timed_out_session_refunds_genesis_stake() {
        let mut s = ts::begin(ALICE);
        let mut clock = clock::create_for_testing(ts::ctx(&mut s));
        clock::set_for_testing(&mut clock, 1_000_000);
        let _id = dkg_committee::create_dkg_session(
            2, vector[ALICE, BOB, CHARLIE], 2_000_000, fee_coin(ts::ctx(&mut s)), &clock, ts::ctx(&mut s),
        );
        let (min_bond, _max) = dkg_committee::bond_bounds();
        let extra_stake = 20_000_000u64; // 超额缴纳 → 记入创世质押

        ts::next_tx(&mut s, ALICE);
        {
            let mut session = ts::take_shared<DkgSession>(&s);
            let paid = coin::mint_for_testing<SUI>(min_bond + extra_stake, ts::ctx(&mut s));
            dkg_committee::submit_commitment(&mut session, &clock, COMMITMENT, ATTEST_PK, paid, ts::ctx(&mut s));
            assert!(dkg_committee::participant_bond_mist(&session, ALICE) == min_bond, 3);
            ts::return_shared(session);
        };
        // 只有 1 人提交（< threshold 2），过 deadline 后超时
        clock::set_for_testing(&mut clock, 3_000_000);
        ts::next_tx(&mut s, ALICE);
        {
            let mut session = ts::take_shared<DkgSession>(&s);
            dkg_committee::handle_session_timeout(&mut session, &clock);
            assert!(dkg_committee::status(&session) == 4, 1);
            dkg_committee::claim_bond(&mut session, ts::ctx(&mut s));
            dkg_committee::claim_stake(&mut session, ts::ctx(&mut s));
            ts::return_shared(session);
        };

        // bond 和 stake 是两笔独立转账（claim_bond / claim_stake 各一枚 coin）
        ts::next_tx(&mut s, ALICE);
        {
            let refund_a = ts::take_from_sender<coin::Coin<SUI>>(&s);
            let refund_b = ts::take_from_sender<coin::Coin<SUI>>(&s);
            let total = coin::value(&refund_a) + coin::value(&refund_b);
            assert!(total == min_bond + extra_stake, 2);
            ts::return_to_sender(&s, refund_a);
            ts::return_to_sender(&s, refund_b);
        };

        clock::destroy_for_testing(clock);
        ts::end(s);
    }

    // 【审计 H-02 反向】FINALIZED 会话不得走 claim_stake（质押已扫入 org）
    #[test]
    #[expected_failure(abort_code = agent_vault::dkg_committee::E_INVALID_SESSION_STATUS)]
    fun audit_h02_claim_stake_rejected_on_finalized() {
        let mut s = ts::begin(ALICE);
        let (mut session, clock) = open_two_submitted(&mut s);
        let group_pk = x"3b6a27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da29";
        dkg_committee::finalize_session_for_testing(&mut session, group_pk, ts::ctx(&mut s));
        ts::return_shared(session);

        ts::next_tx(&mut s, ALICE);
        {
            let mut session = ts::take_shared<DkgSession>(&s);
            dkg_committee::claim_stake(&mut session, ts::ctx(&mut s));
            ts::return_shared(session);
        };

        clock::destroy_for_testing(clock);
        ts::end(s);
    }

    // (5) 重复 claim → E_NO_BOND_TO_CLAIM (3023)
    #[test]
    #[expected_failure(abort_code = agent_vault::dkg_committee::E_NO_BOND_TO_CLAIM)]
    fun double_claim_aborts() {
        let mut s = ts::begin(ALICE);
        let (mut session, clock) = open_two_submitted(&mut s);
        let group_pk = x"3b6a27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da29";
        dkg_committee::finalize_session_for_testing(&mut session, group_pk, ts::ctx(&mut s));
        ts::return_shared(session);

        ts::next_tx(&mut s, ALICE);
        {
            let mut session = ts::take_shared<DkgSession>(&s);
            dkg_committee::claim_bond(&mut session, ts::ctx(&mut s));
            ts::return_shared(session);
        };
        // 第二次 claim：槽位已清空 → 3023
        ts::next_tx(&mut s, ALICE);
        {
            let mut session = ts::take_shared<DkgSession>(&s);
            dkg_committee::claim_bond(&mut session, ts::ctx(&mut s));
            ts::return_shared(session);
        };

        clock::destroy_for_testing(clock);
        ts::end(s);
    }

    // 超额缴款：bond 之外的部分作为创世质押托管，session 侧可读、org 侧扫入
    #[test]
    fun overpay_escrows_excess_as_genesis_stake() {
        let mut s = ts::begin(ALICE);
        let mut clock = clock::create_for_testing(ts::ctx(&mut s));
        clock::set_for_testing(&mut clock, 1_000_000);
        let (min_bond, _max) = dkg_committee::bond_bounds();
        let overpay = min_bond + 12345;
        let _id = dkg_committee::create_dkg_session(
            1, vector[ALICE], 2_000_000, fee_coin(ts::ctx(&mut s)), &clock, ts::ctx(&mut s),
        );

        ts::next_tx(&mut s, ALICE);
        {
            let mut session = ts::take_shared<DkgSession>(&s);
            dkg_committee::submit_commitment(&mut session, &clock, COMMITMENT, ATTEST_PK, coin::mint_for_testing<SUI>(overpay, ts::ctx(&mut s)), ts::ctx(&mut s));
            assert!(dkg_committee::participant_bond_mist(&session, ALICE) == min_bond, 0);
            assert!(dkg_committee::participant_stake_mist(&session, ALICE) == 12345, 1);
            ts::return_shared(session);
        };

        clock::destroy_for_testing(clock);
        ts::end(s);
    }

    // 精确缴款：创世质押槽位存在但为 0（扫入时空扫安全的前提）
    #[test]
    fun exact_payment_leaves_zero_stake_slot() {
        let mut s = ts::begin(ALICE);
        let mut clock = clock::create_for_testing(ts::ctx(&mut s));
        clock::set_for_testing(&mut clock, 1_000_000);
        let _id = dkg_committee::create_dkg_session(
            1, vector[ALICE], 2_000_000, fee_coin(ts::ctx(&mut s)), &clock, ts::ctx(&mut s),
        );

        ts::next_tx(&mut s, ALICE);
        {
            let mut session = ts::take_shared<DkgSession>(&s);
            dkg_committee::submit_commitment(&mut session, &clock, COMMITMENT, ATTEST_PK, bond_coin(ts::ctx(&mut s)), ts::ctx(&mut s));
            assert!(dkg_committee::participant_bond_mist(&session, ALICE) > 0, 0);
            assert!(dkg_committee::participant_stake_mist(&session, ALICE) == 0, 1);
            ts::return_shared(session);
        };

        clock::destroy_for_testing(clock);
        ts::end(s);
    }
}
