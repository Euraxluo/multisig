module engine_stable::pool;

use sui::{balance::{Self, Balance}, clock::Clock, coin::{Self, Coin}};
use std::type_name;
use liquidity_core::types;
use liquidity_core::capabilities::{Self, PoolAdminCap};
use liquidity_core::events;
use liquidity_core::receipts::{Self, SwapPermit, SwapReceipt};
use engine_stable::math;

public struct StablePool<phantom X, phantom Y> has key {
    id: UID,
    reserve_x: Balance<X>,
    reserve_y: Balance<Y>,
    scale_x: u64,
    scale_y: u64,
    a: u64,
    fee_bps: u64,
    protocol_fee_share_bps: u64,
    total_lp_supply: u64,
    is_paused: bool,
    policy_required: bool,
}

public struct StableLPCoin<phantom X, phantom Y> has key, store {
    id: UID,
    value: u64,
}

public fun create_pool<X, Y>(
    coin_x: Coin<X>,
    coin_y: Coin<Y>,
    scale_x: u64,
    scale_y: u64,
    a: u64,
    fee_bps: u64,
    protocol_fee_share_bps: u64,
    policy_required: bool,
    ctx: &mut TxContext,
): (StableLPCoin<X, Y>, PoolAdminCap) {
    let amount_x = coin::value(&coin_x);
    let amount_y = coin::value(&coin_y);

    assert!(amount_x > 0 && amount_y > 0, types::e_zero_amount());
    assert!(scale_x > 0 && scale_y > 0, types::e_invalid_bounds());
    assert!(a > 0 && a <= 100_000, types::e_invalid_bounds());
    assert!(fee_bps <= types::max_fee_bps(), types::e_invalid_fee_bps());

    let norm_x = (amount_x as u128) * (scale_x as u128);
    let norm_y = (amount_y as u128) * (scale_y as u128);
    let d = math::get_D(norm_x, norm_y, a);
    let initial_lp = ((d / 1_000_000_000_000) as u64); // Scale LP to 6 decimal precision

    let pool_uid = object::new(ctx);
    let pool_id = object::uid_to_inner(&pool_uid);
    let admin_cap = capabilities::create_pool_admin_cap(&pool_uid, ctx);

    let pool = StablePool<X, Y> {
        id: pool_uid,
        reserve_x: coin::into_balance(coin_x),
        reserve_y: coin::into_balance(coin_y),
        scale_x,
        scale_y,
        a,
        fee_bps,
        protocol_fee_share_bps,
        total_lp_supply: initial_lp,
        is_paused: false,
        policy_required,
    };
    let lp_coin = StableLPCoin<X, Y> {
        id: object::new(ctx),
        value: initial_lp,
    };

    events::emit_pool_created(
        pool_id,
        4, // StableSwap
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
        initial_lp,
    );

    transfer::share_object(pool);

    (lp_coin, admin_cap)
}

public fun add_liquidity<X, Y>(
    pool: &mut StablePool<X, Y>,
    coin_x: Coin<X>,
    coin_y: Coin<Y>,
    min_lp: u64,
    ctx: &mut TxContext,
): StableLPCoin<X, Y> {
    assert!(!pool.is_paused, types::e_paused());

    let amount_x = coin::value(&coin_x);
    let amount_y = coin::value(&coin_y);
    let (res_x, res_y) = reserves(pool);

    let norm_old_x = (res_x as u128) * (pool.scale_x as u128);
    let norm_old_y = (res_y as u128) * (pool.scale_y as u128);
    let d0 = math::get_D(norm_old_x, norm_old_y, pool.a);

    let norm_new_x = ((res_x + amount_x) as u128) * (pool.scale_x as u128);
    let norm_new_y = ((res_y + amount_y) as u128) * (pool.scale_y as u128);
    let d1 = math::get_D(norm_new_x, norm_new_y, pool.a);
    assert!(d1 > d0, types::e_insufficient_output());

    let lp_minted = (((((d1 - d0) as u128) * (pool.total_lp_supply as u128)) / d0) as u64);
    assert!(lp_minted >= min_lp, types::e_insufficient_output());

    balance::join(&mut pool.reserve_x, coin::into_balance(coin_x));
    balance::join(&mut pool.reserve_y, coin::into_balance(coin_y));
    pool.total_lp_supply = pool.total_lp_supply + lp_minted;

    let pool_id = object::id(pool);
    events::emit_liquidity_added(pool_id, tx_context::sender(ctx), amount_x, amount_y, lp_minted);

    StableLPCoin<X, Y> {
        id: object::new(ctx),
        value: lp_minted,
    }
}

public fun remove_liquidity<X, Y>(
    pool: &mut StablePool<X, Y>,
    lp_coin: StableLPCoin<X, Y>,
    min_x: u64,
    min_y: u64,
    ctx: &mut TxContext,
): (Coin<X>, Coin<Y>) {
    assert!(!pool.is_paused, types::e_paused());

    let StableLPCoin { id, value: lp_amount } = lp_coin;
    object::delete(id);

    let (res_x, res_y) = reserves(pool);
    let out_x = (((lp_amount as u128) * (res_x as u128) / (pool.total_lp_supply as u128)) as u64);
    let out_y = (((lp_amount as u128) * (res_y as u128) / (pool.total_lp_supply as u128)) as u64);

    assert!(out_x >= min_x && out_y >= min_y, types::e_insufficient_output());

    pool.total_lp_supply = pool.total_lp_supply - lp_amount;

    let coin_x = coin::take(&mut pool.reserve_x, out_x, ctx);
    let coin_y = coin::take(&mut pool.reserve_y, out_y, ctx);

    let pool_id = object::id(pool);
    events::emit_liquidity_removed(pool_id, tx_context::sender(ctx), out_x, out_y, lp_amount);

    (coin_x, coin_y)
}

public fun swap_exact_x_to_y<X, Y>(
    pool: &mut StablePool<X, Y>,
    coin_x: Coin<X>,
    min_y_out: u64,
    ctx: &mut TxContext,
): Coin<Y> {
    assert!(!pool.is_paused, types::e_paused());
    assert!(!pool.policy_required, types::e_unauthorized());

    let (coin_y, _fee) = execute_swap_x_to_y_internal(pool, coin_x, min_y_out, ctx);
    coin_y
}

public fun swap_exact_y_to_x<X, Y>(
    pool: &mut StablePool<X, Y>,
    coin_y: Coin<Y>,
    min_x_out: u64,
    ctx: &mut TxContext,
): Coin<X> {
    assert!(!pool.is_paused, types::e_paused());
    assert!(!pool.policy_required, types::e_unauthorized());

    let (coin_x, _fee) = execute_swap_y_to_x_internal(pool, coin_y, min_x_out, ctx);
    coin_x
}

public fun swap_x_to_y_with_permit<X, Y>(
    pool: &mut StablePool<X, Y>,
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
    let (coin_y, fee_paid) = execute_swap_x_to_y_internal(pool, coin_x, min_output, ctx);
    let amount_out = coin::value(&coin_y);

    let receipt = receipts::create_receipt(
        pool_id,
        sender,
        amount_in,
        amount_out,
        fee_paid,
        0,
        policy_data,
    );

    (coin_y, receipt)
}

public fun swap_y_to_x_with_permit<X, Y>(
    pool: &mut StablePool<X, Y>,
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
    let (coin_x, fee_paid) = execute_swap_y_to_x_internal(pool, coin_y, min_output, ctx);
    let amount_out = coin::value(&coin_x);

    let receipt = receipts::create_receipt(
        pool_id,
        sender,
        amount_in,
        amount_out,
        fee_paid,
        0,
        policy_data,
    );

    (coin_x, receipt)
}

// === Internal Helpers ===

fun execute_swap_x_to_y_internal<X, Y>(
    pool: &mut StablePool<X, Y>,
    coin_x: Coin<X>,
    min_y_out: u64,
    ctx: &mut TxContext,
): (Coin<Y>, u64) {
    let amount_in = coin::value(&coin_x);
    let (res_x, res_y) = reserves(pool);

    let (amount_out, fee_paid) = math::get_amount_out(
        amount_in,
        res_x,
        res_y,
        pool.scale_x,
        pool.scale_y,
        pool.a,
        pool.fee_bps,
    );
    assert!(amount_out >= min_y_out, types::e_insufficient_output());

    balance::join(&mut pool.reserve_x, coin::into_balance(coin_x));
    let coin_y = coin::take(&mut pool.reserve_y, amount_out, ctx);

    let pool_id = object::id(pool);
    events::emit_swap(
        pool_id,
        4, // Stable
        tx_context::sender(ctx),
        type_name::with_original_ids<X>().into_string(),
        type_name::with_original_ids<Y>().into_string(),
        amount_in,
        amount_out,
        fee_paid,
        0,
    );

    (coin_y, fee_paid)
}

fun execute_swap_y_to_x_internal<X, Y>(
    pool: &mut StablePool<X, Y>,
    coin_y: Coin<Y>,
    min_x_out: u64,
    ctx: &mut TxContext,
): (Coin<X>, u64) {
    let amount_in = coin::value(&coin_y);
    let (res_x, res_y) = reserves(pool);

    let (amount_out, fee_paid) = math::get_amount_out(
        amount_in,
        res_y,
        res_x,
        pool.scale_y,
        pool.scale_x,
        pool.a,
        pool.fee_bps,
    );
    assert!(amount_out >= min_x_out, types::e_insufficient_output());

    balance::join(&mut pool.reserve_y, coin::into_balance(coin_y));
    let coin_x = coin::take(&mut pool.reserve_x, amount_out, ctx);

    let pool_id = object::id(pool);
    events::emit_swap(
        pool_id,
        4,
        tx_context::sender(ctx),
        type_name::with_original_ids<Y>().into_string(),
        type_name::with_original_ids<X>().into_string(),
        amount_in,
        amount_out,
        fee_paid,
        0,
    );

    (coin_x, fee_paid)
}

// === LPCoin Helpers ===

public fun lp_value<X, Y>(lp: &StableLPCoin<X, Y>): u64 { lp.value }

#[test_only]
public fun destroy_lp_for_testing<X, Y>(lp: StableLPCoin<X, Y>) {
    let StableLPCoin { id, value: _ } = lp;
    object::delete(id);
}

// === Getters & Admin ===

public fun reserves<X, Y>(pool: &StablePool<X, Y>): (u64, u64) {
    (balance::value(&pool.reserve_x), balance::value(&pool.reserve_y))
}

public fun a<X, Y>(pool: &StablePool<X, Y>): u64 { pool.a }
public fun fee_bps<X, Y>(pool: &StablePool<X, Y>): u64 { pool.fee_bps }
public fun is_paused<X, Y>(pool: &StablePool<X, Y>): bool { pool.is_paused }
