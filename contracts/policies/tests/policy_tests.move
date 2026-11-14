#[test_only]
module policies::policy_tests;

use sui::clock;
use liquidity_core::receipts;
use policies::policy_manager;

#[test]
fun test_policy_manager_full_flow() {
    let mut ctx = tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let pool_id = object::id_from_address(@0x1234);

    let config = policy_manager::create_config_for_testing(
        pool_id,
        true, // oracle enabled
        100,  // max deviation 1% (100 bps)
        &mut ctx,
    );

    // 1. Pre-swap hook: oracle price $2.00, pool price $2.01 -> passes!
    let permit = policy_manager::before_swap(
        &config,
        900,
        10_000,
        2_010_000_000,
        2_000_000_000,
        &clock,
        &mut ctx,
    );

    // Simulate swap returning receipt
    let (_sender, _, policy_data) = receipts::consume_permit(permit, pool_id, 100);
    let receipt = receipts::create_receipt(pool_id, @0x42, 1000, 950, 30, 5, policy_data);

    // 2. Post-swap hook: completes swap, consumes receipt
    let (ain, aout, total_fee) = policy_manager::after_swap(&config, receipt);
    assert!(ain == 1000, 0);
    assert!(aout == 950, 1);
    assert!(total_fee == 35, 2);

    policy_manager::destroy_config_for_testing(config);
    clock::destroy_for_testing(clock);
}

#[test]
#[expected_failure(abort_code = 1011, location = policies::oracle_guard)]
fun test_policy_manager_oracle_deviation_abort() {
    let mut ctx = tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let pool_id = object::id_from_address(@0x1234);

    let config = policy_manager::create_config_for_testing(
        pool_id,
        true,
        50, // 50 bps max deviation
        &mut ctx,
    );

    // Pool price $2.10 vs oracle $2.00 (5% = 500 bps deviation) -> should abort!
    let permit = policy_manager::before_swap(
        &config,
        900,
        10_000,
        2_100_000_000,
        2_000_000_000,
        &clock,
        &mut ctx,
    );

    receipts::destroy_permit_for_testing(permit);
    policy_manager::destroy_config_for_testing(config);
    clock::destroy_for_testing(clock);
}

#[test]
#[expected_failure(abort_code = 1008, location = liquidity_core::receipts)]
fun test_policy_receipt_cannot_be_consumed_directly_without_policy() {
    let mut ctx = tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let pool_id = object::id_from_address(@0x1234);

    let config = policy_manager::create_config_for_testing(
        pool_id,
        false,
        100,
        &mut ctx,
    );

    let permit = policy_manager::before_swap(
        &config,
        900,
        10_000,
        2_000_000_000,
        2_000_000_000,
        &clock,
        &mut ctx,
    );

    let (_sender, _, policy_data) = receipts::consume_permit(permit, pool_id, 100);
    let receipt = receipts::create_receipt(pool_id, @0x42, 1000, 950, 30, 5, policy_data);

    // Attacker tries to bypass policy manager by calling receipts::consume_receipt directly!
    // This MUST fail with e_unauthorized (1007)!
    let (_s, _ai, _ao, _fp, _pf) = receipts::consume_receipt(receipt, pool_id);

    policy_manager::destroy_config_for_testing(config);
    clock::destroy_for_testing(clock);
}
