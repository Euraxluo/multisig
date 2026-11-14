module policies::policy_manager;

use sui::clock::{Self, Clock};
use liquidity_core::types;
use liquidity_core::receipts::{Self, SwapPermit, SwapReceipt};
use liquidity_core::events;
use policies::oracle_guard;

public struct PolicyConfig has key {
    id: UID,
    pool_id: ID,
    oracle_enabled: bool,
    oracle_max_deviation_bps: u64,
    dynamic_fee_enabled: bool,
    base_fee_bps: u64,
    volatility_bps: u64,
    imbalance_bps: u64,
}

public fun create_policy_config(
    pool_id: ID,
    oracle_enabled: bool,
    oracle_max_deviation_bps: u64,
    dynamic_fee_enabled: bool,
    base_fee_bps: u64,
    ctx: &mut TxContext,
): ID {
    let uid = object::new(ctx);
    let id = object::uid_to_inner(&uid);

    let config = PolicyConfig {
        id: uid,
        pool_id,
        oracle_enabled,
        oracle_max_deviation_bps,
        dynamic_fee_enabled,
        base_fee_bps,
        volatility_bps: 0,
        imbalance_bps: 0,
    };

    transfer::share_object(config);
    id
}

/// Pre-swap hook: verifies oracle price feed (if enabled) and issues a Hot Potato SwapPermit
public fun before_swap(
    config: &PolicyConfig,
    min_output: u64,
    deadline: u64,
    pool_price: u128,
    oracle_price: u128,
    clock: &Clock,
    ctx: &mut TxContext,
): SwapPermit {
    let current_time = clock::timestamp_ms(clock);
    if (deadline > 0) {
        assert!(current_time <= deadline, types::e_expired());
    };

    if (config.oracle_enabled) {
        oracle_guard::check_price_deviation(
            pool_price,
            oracle_price,
            config.oracle_max_deviation_bps,
        );
    };

    let permit = receipts::create_permit(
        config.pool_id,
        tx_context::sender(ctx),
        min_output,
        deadline,
        sui::object::id_to_bytes(&object::id(config)),
    );

    events::emit_policy_executed(
        1, // Oracle Guard / Dynamic Fee
        config.pool_id,
        config.base_fee_bps,
        oracle_price,
    );

    permit
}

/// Post-swap hook: consumes the Hot Potato SwapReceipt and ensures atomic execution completion
public fun after_swap(
    config: &PolicyConfig,
    receipt: SwapReceipt,
): (u64, u64, u64) {
    let (_sender, amount_in, amount_out, fee_paid, proto_fee) = receipts::consume_receipt_with_policy(
        receipt,
        config.pool_id,
        object::id(config),
    );

    (amount_in, amount_out, fee_paid + proto_fee)
}

#[test_only]
public fun create_config_for_testing(
    pool_id: ID,
    oracle_enabled: bool,
    oracle_max_deviation_bps: u64,
    ctx: &mut TxContext,
): PolicyConfig {
    PolicyConfig {
        id: object::new(ctx),
        pool_id,
        oracle_enabled,
        oracle_max_deviation_bps,
        dynamic_fee_enabled: false,
        base_fee_bps: 30,
        volatility_bps: 0,
        imbalance_bps: 0,
    }
}

#[test_only]
public fun destroy_config_for_testing(config: PolicyConfig) {
    let PolicyConfig { id, pool_id: _, oracle_enabled: _, oracle_max_deviation_bps: _, dynamic_fee_enabled: _, base_fee_bps: _, volatility_bps: _, imbalance_bps: _ } = config;
    object::delete(id);
}
