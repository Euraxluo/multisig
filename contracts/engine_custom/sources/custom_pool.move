module engine_custom::custom_pool;

use sui::{balance::{Self, Balance}, clock::Clock, coin::{Self, Coin}};
use std::type_name;
use liquidity_core::types;
use liquidity_core::capabilities::{Self, PoolAdminCap};
use liquidity_core::events;
use liquidity_core::receipts::{Self, SwapPermit, SwapReceipt};
use engine_custom::curve_math;

public struct CustomPool<phantom BaseAsset, phantom QuoteAsset> has key {
    id: UID,
    curve_type: u8,
    reserve_base: Balance<BaseAsset>,
    reserve_quote: Balance<QuoteAsset>,
    virt_base: u64,
    virt_quote: u64,
    fee_bps: u64,
    is_graduated: bool,
    graduation_threshold: u64,
}

public fun create_virtual_cpmm_pool<BaseAsset, QuoteAsset>(
    initial_tokens: Coin<QuoteAsset>,
    virt_base: u64,
    virt_quote: u64,
    fee_bps: u64,
    graduation_threshold: u64,
    ctx: &mut TxContext,
): PoolAdminCap {
    let amount_quote = coin::value(&initial_tokens);
    assert!(amount_quote > 0, types::e_zero_amount());
    assert!(virt_base > 0 && virt_quote > 0, types::e_invalid_bounds());
    assert!(fee_bps <= types::max_fee_bps(), types::e_invalid_fee_bps());

    let uid = object::new(ctx);
    let pool_id = object::uid_to_inner(&uid);
    let cap = capabilities::create_pool_admin_cap(&uid, ctx);

    let pool = CustomPool<BaseAsset, QuoteAsset> {
        id: uid,
        curve_type: curve_math::curve_virtual_cpmm(),
        reserve_base: balance::zero(),
        reserve_quote: coin::into_balance(initial_tokens),
        virt_base,
        virt_quote,
        fee_bps,
        is_graduated: false,
        graduation_threshold,
    };

    events::emit_pool_created(
        pool_id,
        5, // Custom
        type_name::with_original_ids<BaseAsset>().into_string(),
        type_name::with_original_ids<QuoteAsset>().into_string(),
        0,
        amount_quote,
        tx_context::sender(ctx),
    );

    transfer::share_object(pool);
    cap
}

public fun buy<BaseAsset, QuoteAsset>(
    pool: &mut CustomPool<BaseAsset, QuoteAsset>,
    base_in: Coin<BaseAsset>,
    min_quote_out: u64,
    ctx: &mut TxContext,
): Coin<QuoteAsset> {
    assert!(!pool.is_graduated, types::e_paused());

    let (quote_coin, _fee) = execute_buy_internal(pool, base_in, min_quote_out, ctx);
    quote_coin
}

public fun buy_with_permit<BaseAsset, QuoteAsset>(
    pool: &mut CustomPool<BaseAsset, QuoteAsset>,
    base_in: Coin<BaseAsset>,
    permit: SwapPermit,
    clock: &Clock,
    ctx: &mut TxContext,
): (Coin<QuoteAsset>, SwapReceipt) {
    assert!(!pool.is_graduated, types::e_paused());

    let pool_id = object::id(pool);
    let current_time = sui::clock::timestamp_ms(clock);
    let (sender, min_output, policy_data) = receipts::consume_permit(permit, pool_id, current_time);

    let amount_in = coin::value(&base_in);
    let (quote_coin, fee_paid) = execute_buy_internal(pool, base_in, min_output, ctx);
    let amount_out = coin::value(&quote_coin);

    let receipt = receipts::create_receipt(
        pool_id,
        sender,
        amount_in,
        amount_out,
        fee_paid,
        0,
        policy_data,
    );

    (quote_coin, receipt)
}

fun execute_buy_internal<BaseAsset, QuoteAsset>(
    pool: &mut CustomPool<BaseAsset, QuoteAsset>,
    base_in: Coin<BaseAsset>,
    min_quote_out: u64,
    ctx: &mut TxContext,
): (Coin<QuoteAsset>, u64) {
    let amount_in = coin::value(&base_in);
    let real_x = balance::value(&pool.reserve_base);
    let real_y = balance::value(&pool.reserve_quote);

    let (tokens_out, fee_paid) = curve_math::calc_virtual_cpmm_out(
        real_x,
        real_y,
        pool.virt_base,
        pool.virt_quote,
        amount_in,
        pool.fee_bps,
    );
    assert!(tokens_out >= min_quote_out, types::e_insufficient_output());

    balance::join(&mut pool.reserve_base, coin::into_balance(base_in));
    let quote_coin = coin::take(&mut pool.reserve_quote, tokens_out, ctx);

    let pool_id = object::id(pool);
    events::emit_swap(
        pool_id,
        5, // Custom
        tx_context::sender(ctx),
        type_name::with_original_ids<BaseAsset>().into_string(),
        type_name::with_original_ids<QuoteAsset>().into_string(),
        amount_in,
        tokens_out,
        fee_paid,
        0,
    );

    (quote_coin, fee_paid)
}

public fun is_ready_to_graduate<BaseAsset, QuoteAsset>(
    pool: &CustomPool<BaseAsset, QuoteAsset>,
): bool {
    balance::value(&pool.reserve_base) >= pool.graduation_threshold
}

public fun withdraw_for_graduation<BaseAsset, QuoteAsset>(
    pool: &mut CustomPool<BaseAsset, QuoteAsset>,
    cap: &PoolAdminCap,
    ctx: &mut TxContext,
): (Coin<BaseAsset>, Coin<QuoteAsset>) {
    assert!(capabilities::pool_admin_cap_pool_id(cap) == object::id(pool), types::e_unauthorized());
    assert!(!pool.is_graduated, types::e_paused());
    assert!(is_ready_to_graduate(pool), types::e_insufficient_output());

    pool.is_graduated = true;

    let base_val = balance::value(&pool.reserve_base);
    let quote_val = balance::value(&pool.reserve_quote);

    let coin_base = coin::take(&mut pool.reserve_base, base_val, ctx);
    let coin_quote = coin::take(&mut pool.reserve_quote, quote_val, ctx);

    (coin_base, coin_quote)
}

public fun reserves<BaseAsset, QuoteAsset>(
    pool: &CustomPool<BaseAsset, QuoteAsset>,
): (u64, u64) {
    (balance::value(&pool.reserve_base), balance::value(&pool.reserve_quote))
}

public fun is_graduated<BaseAsset, QuoteAsset>(
    pool: &CustomPool<BaseAsset, QuoteAsset>,
): bool {
    pool.is_graduated
}
