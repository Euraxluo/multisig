module engine_cpmm::pool;

use sui::{balance::{Self, Balance}, clock::Clock, coin::{Self, Coin}};
use std::type_name;
use liquidity_core::types;
use liquidity_core::capabilities::{Self, PoolAdminCap};
use liquidity_core::events;
use liquidity_core::receipts::{Self, SwapPermit, SwapReceipt};
use engine_cpmm::math;

public struct Pool<phantom X, phantom Y> has key {
    id: UID,
    reserve_x: Balance<X>,
    reserve_y: Balance<Y>,
    protocol_fee_x: Balance<X>,
    protocol_fee_y: Balance<Y>,
    fee_bps: u64,
    protocol_fee_share_bps: u64,
    total_lp_supply: u64,
    is_paused: bool,
    policy_required: bool,
}

public struct LPCoin<phantom X, phantom Y> has key, store {
    id: UID,
    value: u64,
}

public fun create_pool<X, Y>(
    coin_x: Coin<X>,
    coin_y: Coin<Y>,
    fee_bps: u64,
    protocol_fee_share_bps: u64,
    policy_required: bool,
    ctx: &mut TxContext,
): (LPCoin<X, Y>, PoolAdminCap) {
    let amount_x = coin::value(&coin_x);
    let amount_y = coin::value(&coin_y);

    assert!(amount_x > 0 && amount_y > 0, types::e_zero_amount());
    assert!(fee_bps <= types::max_fee_bps(), types::e_invalid_fee_bps());
    assert!(protocol_fee_share_bps <= types::bps_scale(), types::e_invalid_fee_bps());

    let lp_to_mint = math::calc_initial_lp(amount_x, amount_y);
    let total_lp = lp_to_mint + types::min_initial_liquidity();

    let pool_uid = object::new(ctx);
    let pool_id = object::uid_to_inner(&pool_uid);
    let admin_cap = capabilities::create_pool_admin_cap(&pool_uid, ctx);

    let pool = Pool<X, Y> {
        id: pool_uid,
        reserve_x: coin::into_balance(coin_x),
        reserve_y: coin::into_balance(coin_y),
        protocol_fee_x: balance::zero(),
        protocol_fee_y: balance::zero(),
        fee_bps,
        protocol_fee_share_bps,
        total_lp_supply: total_lp,
        is_paused: false,
        policy_required,
    };
    let lp_coin = LPCoin<X, Y> {
        id: object::new(ctx),
        value: lp_to_mint,
    };

    events::emit_pool_created(
        pool_id,
        3, // CPMM
        type_name::with_original_ids<X>().into_string(),
        type_name::with_original_ids<Y>().into_string(),
        amount_x,
        amount_y,
        tx_context::sender(ctx),
    );

    events::emit_liquidity_added(
        pool_id,
        tx_context::sender(ctx),
        amount_x,
        amount_y,
        lp_to_mint,
    );

    transfer::share_object(pool);

    (lp_coin, admin_cap)
}

public fun add_liquidity<X, Y>(
    pool: &mut Pool<X, Y>,
    coin_x: Coin<X>,
    coin_y: Coin<Y>,
    min_lp: u64,
    ctx: &mut TxContext,
): LPCoin<X, Y> {
    assert!(!pool.is_paused, types::e_paused());

    let amount_x = coin::value(&coin_x);
    let amount_y = coin::value(&coin_y);
    let (res_x, res_y) = reserves(pool);

    let lp_minted = math::calc_add_liquidity_lp(
        amount_x,
        amount_y,
        res_x,
        res_y,
        pool.total_lp_supply,
    );
    assert!(lp_minted >= min_lp, types::e_insufficient_output());

    balance::join(&mut pool.reserve_x, coin::into_balance(coin_x));
    balance::join(&mut pool.reserve_y, coin::into_balance(coin_y));
    pool.total_lp_supply = pool.total_lp_supply + lp_minted;

    let pool_id = object::id(pool);
    events::emit_liquidity_added(pool_id, tx_context::sender(ctx), amount_x, amount_y, lp_minted);

    LPCoin<X, Y> {
        id: object::new(ctx),
        value: lp_minted,
    }
}

public fun remove_liquidity<X, Y>(
    pool: &mut Pool<X, Y>,
    lp_coin: LPCoin<X, Y>,
    min_x: u64,
    min_y: u64,
    ctx: &mut TxContext,
): (Coin<X>, Coin<Y>) {
    assert!(!pool.is_paused, types::e_paused());

    let LPCoin { id, value: lp_amount } = lp_coin;
    object::delete(id);

    let (res_x, res_y) = reserves(pool);
    let (out_x, out_y) = math::calc_remove_liquidity(
        lp_amount,
        res_x,
        res_y,
        pool.total_lp_supply,
    );

    assert!(out_x >= min_x && out_y >= min_y, types::e_insufficient_output());

    pool.total_lp_supply = pool.total_lp_supply - lp_amount;

    let coin_x = coin::take(&mut pool.reserve_x, out_x, ctx);
    let coin_y = coin::take(&mut pool.reserve_y, out_y, ctx);

    let pool_id = object::id(pool);
    events::emit_liquidity_removed(pool_id, tx_context::sender(ctx), out_x, out_y, lp_amount);

    (coin_x, coin_y)
}

public fun swap_exact_x_to_y<X, Y>(
    pool: &mut Pool<X, Y>,
    coin_x: Coin<X>,
    min_y_out: u64,
    ctx: &mut TxContext,
): Coin<Y> {
    assert!(!pool.is_paused, types::e_paused());
    assert!(!pool.policy_required, types::e_unauthorized());

    let (coin_y, _fee, _proto) = execute_swap_x_to_y_internal(pool, coin_x, min_y_out, ctx);
    coin_y
}

public fun swap_exact_y_to_x<X, Y>(
    pool: &mut Pool<X, Y>,
    coin_y: Coin<Y>,
    min_x_out: u64,
    ctx: &mut TxContext,
): Coin<X> {
    assert!(!pool.is_paused, types::e_paused());
    assert!(!pool.policy_required, types::e_unauthorized());

    let (coin_x, _fee, _proto) = execute_swap_y_to_x_internal(pool, coin_y, min_x_out, ctx);
    coin_x
}

/// Swap X to Y using Hot Potato SwapPermit and producing SwapReceipt for atomic policy enforcement
public fun swap_x_to_y_with_permit<X, Y>(
    pool: &mut Pool<X, Y>,
    coin_x: Coin<X>,
    permit: SwapPermit,
    clock: &Clock,
    ctx: &mut TxContext,
): (Coin<Y>, SwapReceipt) {
    assert!(!pool.is_paused, types::e_paused());

    let pool_id = object::id(pool);
    let current_time = sui::clock::timestamp_ms(clock);
    let (sender, min_output, policy_data) = receipts::consume_permit(permit, pool_id, current_time);
    if (pool.policy_required) {
        assert!(!policy_data.is_empty(), types::e_unauthorized());
    };

    let amount_in = coin::value(&coin_x);
    let (coin_y, fee_paid, proto_fee) = execute_swap_x_to_y_internal(pool, coin_x, min_output, ctx);
    let amount_out = coin::value(&coin_y);

    let receipt = receipts::create_receipt(
        pool_id,
        sender,
        amount_in,
        amount_out,
        fee_paid,
        proto_fee,
        policy_data,
    );

    (coin_y, receipt)
}

/// Swap Y to X using Hot Potato SwapPermit and producing SwapReceipt
public fun swap_y_to_x_with_permit<X, Y>(
    pool: &mut Pool<X, Y>,
    coin_y: Coin<Y>,
    permit: SwapPermit,
    clock: &Clock,
    ctx: &mut TxContext,
): (Coin<X>, SwapReceipt) {
    assert!(!pool.is_paused, types::e_paused());

    let pool_id = object::id(pool);
    let current_time = sui::clock::timestamp_ms(clock);
    let (sender, min_output, policy_data) = receipts::consume_permit(permit, pool_id, current_time);
    if (pool.policy_required) {
        assert!(!policy_data.is_empty(), types::e_unauthorized());
    };

    let amount_in = coin::value(&coin_y);
    let (coin_x, fee_paid, proto_fee) = execute_swap_y_to_x_internal(pool, coin_y, min_output, ctx);
    let amount_out = coin::value(&coin_x);

    let receipt = receipts::create_receipt(
        pool_id,
        sender,
        amount_in,
        amount_out,
        fee_paid,
        proto_fee,
        policy_data,
    );

    (coin_x, receipt)
}

// === Internal Swap Helpers ===

fun execute_swap_x_to_y_internal<X, Y>(
    pool: &mut Pool<X, Y>,
    coin_x: Coin<X>,
    min_y_out: u64,
    ctx: &mut TxContext,
): (Coin<Y>, u64, u64) {
    let amount_in = coin::value(&coin_x);
    let (res_x, res_y) = reserves(pool);

    let (amount_out, total_fee) = math::get_amount_out(amount_in, res_x, res_y, pool.fee_bps);
    assert!(amount_out >= min_y_out, types::e_insufficient_output());

    // Protocol fee split
    let protocol_fee = (((total_fee as u128) * (pool.protocol_fee_share_bps as u128) / (types::bps_scale() as u128)) as u64);

    let mut balance_x = coin::into_balance(coin_x);
    if (protocol_fee > 0) {
        let proto_bal = balance::split(&mut balance_x, protocol_fee);
        balance::join(&mut pool.protocol_fee_x, proto_bal);
    };
    balance::join(&mut pool.reserve_x, balance_x);

    let coin_y = coin::take(&mut pool.reserve_y, amount_out, ctx);

    // Verify invariant k did not decrease
    let (new_res_x, new_res_y) = reserves(pool);
    math::assert_k_non_decreasing(new_res_x, new_res_y, res_x, res_y);

    let pool_id = object::id(pool);
    events::emit_swap(
        pool_id,
        3,
        tx_context::sender(ctx),
        type_name::with_original_ids<X>().into_string(),
        type_name::with_original_ids<Y>().into_string(),
        amount_in,
        amount_out,
        total_fee,
        protocol_fee,
    );

    (coin_y, total_fee, protocol_fee)
}

fun execute_swap_y_to_x_internal<X, Y>(
    pool: &mut Pool<X, Y>,
    coin_y: Coin<Y>,
    min_x_out: u64,
    ctx: &mut TxContext,
): (Coin<X>, u64, u64) {
    let amount_in = coin::value(&coin_y);
    let (res_x, res_y) = reserves(pool);

    let (amount_out, total_fee) = math::get_amount_out(amount_in, res_y, res_x, pool.fee_bps);
    assert!(amount_out >= min_x_out, types::e_insufficient_output());

    let protocol_fee = (((total_fee as u128) * (pool.protocol_fee_share_bps as u128) / (types::bps_scale() as u128)) as u64);

    let mut balance_y = coin::into_balance(coin_y);
    if (protocol_fee > 0) {
        let proto_bal = balance::split(&mut balance_y, protocol_fee);
        balance::join(&mut pool.protocol_fee_y, proto_bal);
    };
    balance::join(&mut pool.reserve_y, balance_y);

    let coin_x = coin::take(&mut pool.reserve_x, amount_out, ctx);

    let (new_res_x, new_res_y) = reserves(pool);
    math::assert_k_non_decreasing(new_res_x, new_res_y, res_x, res_y);

    let pool_id = object::id(pool);
    events::emit_swap(
        pool_id,
        3,
        tx_context::sender(ctx),
        type_name::with_original_ids<Y>().into_string(),
        type_name::with_original_ids<X>().into_string(),
        amount_in,
        amount_out,
        total_fee,
        protocol_fee,
    );

    (coin_x, total_fee, protocol_fee)
}

// === LPCoin Helpers ===

public fun lp_value<X, Y>(lp: &LPCoin<X, Y>): u64 { lp.value }

#[test_only]
public fun destroy_lp_for_testing<X, Y>(lp: LPCoin<X, Y>) {
    let LPCoin { id, value: _ } = lp;
    object::delete(id);
}

public fun join_lp<X, Y>(lp: &mut LPCoin<X, Y>, other: LPCoin<X, Y>) {
    let LPCoin { id, value } = other;
    object::delete(id);
    lp.value = lp.value + value;
}

public fun split_lp<X, Y>(lp: &mut LPCoin<X, Y>, split_amount: u64, ctx: &mut TxContext): LPCoin<X, Y> {
    assert!(lp.value >= split_amount, types::e_insufficient_liquidity());
    lp.value = lp.value - split_amount;
    LPCoin<X, Y> {
        id: object::new(ctx),
        value: split_amount,
    }
}

// === Admin & Config ===

public fun set_paused<X, Y>(
    pool: &mut Pool<X, Y>,
    cap: &PoolAdminCap,
    is_paused: bool,
) {
    assert!(capabilities::pool_admin_cap_pool_id(cap) == object::id(pool), types::e_unauthorized());
    pool.is_paused = is_paused;
}

public fun set_fee_bps<X, Y>(
    pool: &mut Pool<X, Y>,
    cap: &PoolAdminCap,
    fee_bps: u64,
) {
    assert!(capabilities::pool_admin_cap_pool_id(cap) == object::id(pool), types::e_unauthorized());
    assert!(fee_bps <= types::max_fee_bps(), types::e_invalid_fee_bps());
    pool.fee_bps = fee_bps;
}

public fun claim_protocol_fees<X, Y>(
    pool: &mut Pool<X, Y>,
    cap: &PoolAdminCap,
    ctx: &mut TxContext,
): (Coin<X>, Coin<Y>) {
    assert!(capabilities::pool_admin_cap_pool_id(cap) == object::id(pool), types::e_unauthorized());
    let x_val = balance::value(&pool.protocol_fee_x);
    let y_val = balance::value(&pool.protocol_fee_y);

    let cx = if (x_val > 0) {
        coin::take(&mut pool.protocol_fee_x, x_val, ctx)
    } else {
        coin::zero(ctx)
    };

    let cy = if (y_val > 0) {
        coin::take(&mut pool.protocol_fee_y, y_val, ctx)
    } else {
        coin::zero(ctx)
    };

    (cx, cy)
}

// === Getters ===

public fun reserves<X, Y>(pool: &Pool<X, Y>): (u64, u64) {
    (balance::value(&pool.reserve_x), balance::value(&pool.reserve_y))
}

public fun fee_bps<X, Y>(pool: &Pool<X, Y>): u64 { pool.fee_bps }
public fun total_lp_supply<X, Y>(pool: &Pool<X, Y>): u64 { pool.total_lp_supply }
public fun is_paused<X, Y>(pool: &Pool<X, Y>): bool { pool.is_paused }
public fun is_policy_required<X, Y>(pool: &Pool<X, Y>): bool { pool.policy_required }
