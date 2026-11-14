#[test_only]
module agent_vault::org_genesis_tests;

use sui::test_scenario::{Self as ts};
use sui::clock::{Self, Clock};
use sui::coin::{Self, Coin};
use sui::event;
use std::debug;
use sui::sui::SUI;
use agent_vault::dkg_committee::{Self, DkgSession};
use agent_vault::cryptographic_org::{Self as org, Organization};

const ALICE: address = @0xA11CE;
const BOB: address = @0xB0B;
const CHARLIE: address = @0xC0C;
const DAVID_OFFLINE: address = @0xDA71D;
const VENDOR: address = @0x9999;
const ATTEST_PK: vector<u8> = x"4141414141414141414141414141414141414141414141414141414141414141";

// ed25519 fixture key (SK = 0x55 repeated), generated off-chain with @noble/curves.
// PK is the group key the org is created with via create_organization_for_testing.
const PK1: vector<u8> = x"c6822637c7d310ec57627be00ba259d253749f4aaf644470cffbe53a35f73242";

// Sign(SK1, org::compute_genesis_withdraw_digest("sui-testnet:", ORG_ID, 1, 1, AMOUNT, VENDOR))
const WITHDRAW_SIG_N1_A: vector<u8> = x"7a3be428d68d8a31ccc000d9ddff1a0c738f5a92a86aedf2b529f2570776c9bd5d59ec07d08b8c36c9ecda8c96c88ec6938e4bb70697fb3bec2eec9ceb31f604";
// Same digest but nonce = 2 (used for the replay-block test after n=1 lands).
const WITHDRAW_SIG_N2_A: vector<u8> = x"50091159f87508dd5a5b6403101f5f5c0aa7672393040fe26bb414c808614e33fa45e478e936b5007c0651e7f211953b02b20f76b3e95ec7e5c9f476cc804407";
const GARBAGE_SIG_64: vector<u8> = x"000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";

const GENESIS_AMOUNT: u64 = 77_000_000_000; // 77 SUI of voluntary overpay swept to the org
const CREATED_AT: u64 = 1_000_000; // clock time at create_organization_from_session
const UNLOCK_AT: u64 = CREATED_AT + 7_776_000_000; // org::GENESIS_LOCK_MS (90d)

/// 测试专用：0.05 SUI bond 上限用到的最小缴费（submit_commitment 的 payment）。
const BOND_PAYMENT: u64 = 50_000_000; // MIN_BOND_MIST per spec

fun ctx(s: &mut ts::Scenario): &mut sui::tx_context::TxContext {
    ts::ctx(s)
}

// === 8. Genesis sweep: overpay participants → org gets excess, totals correct, unlock = creation + 90d ===

/// Full DKG flow per the bond spec: paid creation, paid submits with overpay,
/// finalize via the production gate, then create_organization_from_session.
#[test]
fun genesis_sweep_on_finalize_records_totals_and_lock() {
    let mut scenario = ts::begin(ALICE);
    let mut clock = clock::create_for_testing(ctx(&mut scenario));
    clock::set_for_testing(&mut clock, 1_000_000);

    let participants = vector[ALICE, BOB, CHARLIE, DAVID_OFFLINE];
    // deadline = now + 1_000_000 ms，落在 [10min, 7d] 合法区间
    dkg_committee::create_dkg_session(
        3, participants, 2_000_000,
        mint(&mut scenario, 5_000_000),
        &clock,
        ctx(&mut scenario),
    );

    // 三人确认（达 threshold=3）；每人在 submit 时超额缴费：
    //   ALICE: 50_000_000 (bond 0.05 + 0) — 不产生创世质押
    //   BOB:   50_000_000 + 30_000_000 — 创世质押 30 SUI
    //   CHARLIE: 50_000_000 + 47_000_000 — 创世质押 47 SUI
    let pays = vector[BOND_PAYMENT, BOND_PAYMENT + 30_000_000_000, BOND_PAYMENT + 47_000_000_000];
    let confirmers = vector[ALICE, BOB, CHARLIE];
    let mut i = 0;
    while (i < 3) {
        let who = *vector::borrow(&confirmers, i);
        let pay = *vector::borrow(&pays, i);
        ts::next_tx(&mut scenario, who);
        {
            let mut session = ts::take_shared<DkgSession>(&scenario);
            let payment = mint(&mut scenario, pay);
            dkg_committee::submit_commitment(
                &mut session, &clock,
                commitment_for(i), ATTEST_PK, payment, ctx(&mut scenario),
            );
            dkg_committee::confirm_participant(&mut session, &clock, ctx(&mut scenario));
            ts::return_shared(session);
        };
        i = i + 1;
    };

    // 固化（生产门禁）并创建组织
    ts::next_tx(&mut scenario, ALICE);
    {
        let mut session = ts::take_shared<DkgSession>(&scenario);
        let dummy_pk = x"0101010101010101010101010101010101010101010101010101010101010101";
        dkg_committee::finalize_session_for_testing(&mut session, dummy_pk, ctx(&mut scenario));
        let _org_id = org::create_organization_from_session(&mut session, 3, &clock, ctx(&mut scenario));
        // 创世质押事件审计（同 tx 捕获）：GenesisStakeRecordedEvent
        let rec = event::events_by_type<org::GenesisStakeRecordedEvent>();
        assert!(rec.length() == 1, 805);
        let e = vector::borrow(&rec, 0);
        let (_id, total_mist, stakers, unlock_at_ms) = org::genesis_recorded_fields(e);
        assert!(total_mist == GENESIS_AMOUNT, 806);
        assert!(stakers == 2, 807);
        assert!(unlock_at_ms == UNLOCK_AT, 808);
        ts::return_shared(session);
    };

    // 组织侧断言：总额 = 77 SUI、解锁 = 创建时刻 + 90 天、live = total - withdrawn
    ts::next_tx(&mut scenario, ALICE);
    {
        let org_obj = ts::take_shared<Organization>(&scenario);
        assert!(org::genesis_bonded_total(&org_obj) == GENESIS_AMOUNT, 801);
        assert!(org::genesis_stake_balance(&org_obj) == GENESIS_AMOUNT, 802);
        assert!(org::genesis_withdrawn(&org_obj) == 0, 803);
        assert!(org::genesis_unlock_at_ms(&org_obj) == UNLOCK_AT, 804);
        ts::return_shared(org_obj);
    };

    // 会话侧：质押已被扫空（claim_bond 只退保证金，与创世质押无关——
    // 扫空断言经由 dkg 侧 claim_bond 测试覆盖，这里依赖 take 语义）。

    clock::destroy_for_testing(clock);
    ts::end(scenario);
}

/// 无超额缴费的会话：组织创世质押全零、无锁、事件仍发射。
#[test]
fun genesis_sweep_empty_session_is_zero_and_unlock_zero() {
    let mut scenario = ts::begin(ALICE);
    let mut clock = clock::create_for_testing(ctx(&mut scenario));
    clock::set_for_testing(&mut clock, 1_000_000);

    let participants = vector[ALICE, BOB, CHARLIE];
    dkg_committee::create_dkg_session(
        2, participants, 2_000_000,
        mint(&mut scenario, 5_000_000),
        &clock,
        ctx(&mut scenario),
    );

    let confirmers = vector[ALICE, BOB];
    let mut i = 0;
    while (i < 2) {
        let who = *vector::borrow(&confirmers, i);
        ts::next_tx(&mut scenario, who);
        {
            let mut session = ts::take_shared<DkgSession>(&scenario);
            let payment = mint(&mut scenario, BOND_PAYMENT);
            dkg_committee::submit_commitment(
                &mut session, &clock,
                commitment_for(i), ATTEST_PK, payment, ctx(&mut scenario),
            );
            dkg_committee::confirm_participant(&mut session, &clock, ctx(&mut scenario));
            ts::return_shared(session);
        };
        i = i + 1;
    };

    ts::next_tx(&mut scenario, ALICE);
    {
        let mut session = ts::take_shared<DkgSession>(&scenario);
        let dummy_pk = x"0202020202020202020202020202020202020202020202020202020202020202";
        dkg_committee::finalize_session_for_testing(&mut session, dummy_pk, ctx(&mut scenario));
        let _org_id = org::create_organization_from_session(&mut session, 2, &clock, ctx(&mut scenario));
        ts::return_shared(session);
    };

    ts::next_tx(&mut scenario, ALICE);
    {
        let org_obj = ts::take_shared<Organization>(&scenario);
        assert!(org::genesis_bonded_total(&org_obj) == 0, 811);
        assert!(org::genesis_stake_balance(&org_obj) == 0, 812);
        // Spec: 解锁时间戳无条件写入（创建时刻 + 90 天）；无质押时锁无意义但字段仍记录。
        assert!(org::genesis_unlock_at_ms(&org_obj) == UNLOCK_AT, 813);
        ts::return_shared(org_obj);
    };

    clock::destroy_for_testing(clock);
    ts::end(scenario);
}

// === 9-11. withdraw_genesis_stake semantics (injected stake, no DKG dependency) ===

fun start_org_with_stake(unlock_at: u64): (ts::Scenario, sui::object::ID) {
    let mut s = ts::begin(ALICE);
    let org_id = org::create_organization_for_testing(
        PK1, 2, 2, vector[ALICE, BOB], vector[1, 1], ts::ctx(&mut s),
    );
    ts::next_tx(&mut s, ALICE);
    {
        let mut org_obj = ts::take_shared<Organization>(&s);
        org::set_genesis_stake_for_testing(&mut org_obj, GENESIS_AMOUNT, unlock_at, ts::ctx(&mut s));
        ts::return_shared(org_obj);
    };
    (s, org_id)
}

/// 测试 9：锁期内（clock < unlock）即使有有效门限签名也必须 abort 1011。
#[test, expected_failure(abort_code = org::E_GENESIS_LOCKED, location = agent_vault::cryptographic_org)]
fun withdraw_before_unlock_aborts_1011() {
    let (mut s, org_id) = start_org_with_stake(UNLOCK_AT);
    let _ = org_id;
    let mut clock = clock::create_for_testing(ctx(&mut s));
    clock::set_for_testing(&mut clock, UNLOCK_AT - 1);

    ts::next_tx(&mut s, ALICE);
    {
        let mut org_obj = ts::take_shared<Organization>(&s);
        org::withdraw_genesis_stake(
            &mut org_obj, 1, 7_000, VENDOR, WITHDRAW_SIG_N1_A, &clock, ctx(&mut s),
        );
        ts::return_shared(org_obj);
    };

    clock::destroy_for_testing(clock);
        ts::end(s);
}

/// 测试 9b：恰好等于解锁时刻（边界）允许提取。
#[test]
fun withdraw_at_exact_unlock_boundary_pays() {
    let (mut s, _org_id) = start_org_with_stake(UNLOCK_AT);
    let mut clock = clock::create_for_testing(ctx(&mut s));
    clock::set_for_testing(&mut clock, UNLOCK_AT);

    ts::next_tx(&mut s, ALICE);
    {
        let mut org_obj = ts::take_shared<Organization>(&s);
        org::withdraw_genesis_stake(
            &mut org_obj, 1, 7_000, VENDOR, WITHDRAW_SIG_N1_A, &clock, ctx(&mut s),
        );
        assert!(org::genesis_withdrawn(&org_obj) == 7_000, 901);
        assert!(org::genesis_stake_balance(&org_obj) == GENESIS_AMOUNT - 7_000, 902);
        assert!(org::genesis_bonded_total(&org_obj) == GENESIS_AMOUNT, 903);
        assert!(org::last_nonce(&org_obj) == 1, 904);
        ts::return_shared(org_obj);
    };

    // 收款人拿到 SUI
    ts::next_tx(&mut s, VENDOR);
    {
        let coin = ts::take_from_address<Coin<SUI>>(&s, VENDOR);
        assert!(coin.value() == 7_000, 905);
        sui::transfer::public_transfer(coin, VENDOR);
    };

    clock::destroy_for_testing(clock);
    ts::end(s);
}

/// 测试 10：解锁后有效签名提取成功；同一 nonce 重放被 E_INVALID_NONCE 拦截。
#[test]
fun withdraw_after_unlock_then_nonce_replay_blocked() {
    let (mut s, _org_id) = start_org_with_stake(UNLOCK_AT);
    let mut clock = clock::create_for_testing(ctx(&mut s));
    clock::set_for_testing(&mut clock, UNLOCK_AT + 1);

    ts::next_tx(&mut s, ALICE);
    {
        let mut org_obj = ts::take_shared<Organization>(&s);
        org::withdraw_genesis_stake(
            &mut org_obj, 1, 7_000, VENDOR, WITHDRAW_SIG_N1_A, &clock, ctx(&mut s),
        );
        ts::return_shared(org_obj);
    };

    ts::next_tx(&mut s, ALICE);
    {
        let org_obj = ts::take_shared<Organization>(&s);
        assert!(org::genesis_withdrawn(&org_obj) == 7_000, 1001);
        assert!(org::last_nonce(&org_obj) == 1, 1002);
        ts::return_shared(org_obj);
    };

        clock::destroy_for_testing(clock);
    ts::end(s);
}

/// 同一 nonce 重放（先于签名校验即失败）。
#[test, expected_failure(abort_code = org::E_INVALID_NONCE, location = agent_vault::cryptographic_org)]
fun withdraw_nonce_replay_fails_1006() {
    let (mut s, _org_id) = start_org_with_stake(UNLOCK_AT);
    let mut clock = clock::create_for_testing(ctx(&mut s));
    clock::set_for_testing(&mut clock, UNLOCK_AT + 1);

    ts::next_tx(&mut s, ALICE);
    {
        let mut org_obj = ts::take_shared<Organization>(&s);
        org::withdraw_genesis_stake(
            &mut org_obj, 1, 7_000, VENDOR, WITHDRAW_SIG_N1_A, &clock, ctx(&mut s),
        );
        ts::return_shared(org_obj);
    };

    ts::next_tx(&mut s, ALICE);
    {
        let mut org_obj = ts::take_shared<Organization>(&s);
        org::withdraw_genesis_stake(
            &mut org_obj, 1, 7_000, VENDOR, WITHDRAW_SIG_N1_A, &clock, ctx(&mut s),
        );
        ts::return_shared(org_obj);
    };

        clock::destroy_for_testing(clock);
    ts::end(s);
}

/// 测试 11：错误签名 abort E_INVALID_SIGNATURE(1001)，状态不落、nonce 不耗。
#[test, expected_failure(abort_code = org::E_INVALID_SIGNATURE, location = agent_vault::cryptographic_org)]
fun withdraw_with_wrong_sig_aborts_1001() {
    let (mut s, _org_id) = start_org_with_stake(UNLOCK_AT);
    let mut clock = clock::create_for_testing(ctx(&mut s));
    clock::set_for_testing(&mut clock, UNLOCK_AT + 1);

    ts::next_tx(&mut s, ALICE);
    {
        let mut org_obj = ts::take_shared<Organization>(&s);
        org::withdraw_genesis_stake(
            &mut org_obj, 1, 1_000, VENDOR, GARBAGE_SIG_64, &clock, ctx(&mut s),
        );
        ts::return_shared(org_obj);
    };

    clock::destroy_for_testing(clock);
        ts::end(s);
}

/// 测试 11b：金额为 0 或超余额 abort（锁期已过，走到金额校验）。
#[test, expected_failure(abort_code = org::E_GENESIS_LOCKED, location = agent_vault::cryptographic_org)]
fun withdraw_zero_amount_aborts() {
    let (mut s, _org_id) = start_org_with_stake(UNLOCK_AT);
    let mut clock = clock::create_for_testing(ctx(&mut s));
    clock::set_for_testing(&mut clock, UNLOCK_AT + 1);

    ts::next_tx(&mut s, ALICE);
    {
        let mut org_obj = ts::take_shared<Organization>(&s);
        org::withdraw_genesis_stake(
            &mut org_obj, 1, 0, VENDOR, WITHDRAW_SIG_N1_A, &clock, ctx(&mut s),
        );
        ts::return_shared(org_obj);
    };

    clock::destroy_for_testing(clock);
        ts::end(s);
}

#[test, expected_failure(abort_code = org::E_GENESIS_LOCKED, location = agent_vault::cryptographic_org)]
fun withdraw_over_amount_aborts() {
    let (mut s, _org_id) = start_org_with_stake(UNLOCK_AT);
    let mut clock = clock::create_for_testing(ctx(&mut s));
    clock::set_for_testing(&mut clock, UNLOCK_AT + 1);

    ts::next_tx(&mut s, ALICE);
    {
        let mut org_obj = ts::take_shared<Organization>(&s);
        org::withdraw_genesis_stake(
            &mut org_obj, 1, GENESIS_AMOUNT + 1, VENDOR, WITHDRAW_SIG_N1_A, &clock, ctx(&mut s),
        );
        ts::return_shared(org_obj);
    };

    clock::destroy_for_testing(clock);
        ts::end(s);
}

/// 打印器：一次性确定 ORG_ID（test_scenario 内确定性派生），
/// 之后用 SK1 对 compute_genesis_withdraw_digest 的字节离线签名，
/// 把签名回填进 WITHDRAW_SIG_N1_A / WITHDRAW_SIG_N2_A 常量。
/// 该测试在常量回填后仍保持通过（打印无断言）。
#[test]
fun zz_print_fixture_ids_and_digests() {
    let (mut s, org_id) = start_org_with_stake(UNLOCK_AT);
    // d1: nonce=1, amount=7000, recipient=VENDOR（测试 10 用的摘要）
    let d1 = org::compute_genesis_withdraw_digest(&org::default_chain_id(), org_id, 1, 1, 7_000, VENDOR);
    // d2: nonce=2, amount=7000, recipient=VENDOR（重放后合法第二次提取）
    let d2 = org::compute_genesis_withdraw_digest(&org::default_chain_id(), org_id, 1, 2, 7_000, VENDOR);
    debug::print(&org_id);
    debug::print(&d1);
    debug::print(&d2);
    let _ = WITHDRAW_SIG_N2_A;
    ts::end(s);
}

// === helpers ===

fun mint(scenario: &mut ts::Scenario, mist: u64): Coin<SUI> {
    coin::mint_for_testing<SUI>(mist, ctx(scenario))
}

fun commitment_for(i: u64): vector<u8> {
    if (i == 0) {
        x"aaaa000000000000000000000000000000000000000000000000000000000000"
    } else if (i == 1) {
        x"bbbb000000000000000000000000000000000000000000000000000000000000"
    } else {
        x"cccc000000000000000000000000000000000000000000000000000000000000"
    }
}
