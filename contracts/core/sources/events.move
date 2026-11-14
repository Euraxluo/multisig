module liquidity_core::events;

use sui::event;
use sui::object::ID;
use std::ascii::String;

public struct PoolCreatedEvent has copy, drop {
    pool_id: ID,
    engine_type: u8,
    token_x: String,
    token_y: String,
    initial_reserve_x: u64,
    initial_reserve_y: u64,
    creator: address,
}

public struct SwapEvent has copy, drop {
    pool_id: ID,
    engine_type: u8,
    sender: address,
    token_in: String,
    token_out: String,
    amount_in: u64,
    amount_out: u64,
    fee_paid: u64,
    protocol_fee: u64,
}

public struct LiquidityAddedEvent has copy, drop {
    pool_id: ID,
    sender: address,
    amount_x: u64,
    amount_y: u64,
    lp_tokens_minted: u64,
}

public struct LiquidityRemovedEvent has copy, drop {
    pool_id: ID,
    sender: address,
    amount_x: u64,
    amount_y: u64,
    lp_tokens_burned: u64,
}

public struct EngineRegisteredEvent has copy, drop {
    engine_id: u8,
    name: String,
    package_id: address,
    verification_level: u8,
    capabilities: u32,
}

public struct MarketVenueAddedEvent has copy, drop {
    market_key: String,
    venue_id: ID,
    engine_type: u8,
}

public struct PolicyExecutedEvent has copy, drop {
    policy_type: u8,
    pool_id: ID,
    fee_bps: u64,
    oracle_price: u128,
}

public fun emit_pool_created(
    pool_id: ID,
    engine_type: u8,
    token_x: String,
    token_y: String,
    initial_reserve_x: u64,
    initial_reserve_y: u64,
    creator: address,
) {
    event::emit(PoolCreatedEvent {
        pool_id,
        engine_type,
        token_x,
        token_y,
        initial_reserve_x,
        initial_reserve_y,
        creator,
    });
}

public fun emit_swap(
    pool_id: ID,
    engine_type: u8,
    sender: address,
    token_in: String,
    token_out: String,
    amount_in: u64,
    amount_out: u64,
    fee_paid: u64,
    protocol_fee: u64,
) {
    event::emit(SwapEvent {
        pool_id,
        engine_type,
        sender,
        token_in,
        token_out,
        amount_in,
        amount_out,
        fee_paid,
        protocol_fee,
    });
}

public fun emit_liquidity_added(
    pool_id: ID,
    sender: address,
    amount_x: u64,
    amount_y: u64,
    lp_tokens_minted: u64,
) {
    event::emit(LiquidityAddedEvent {
        pool_id,
        sender,
        amount_x,
        amount_y,
        lp_tokens_minted,
    });
}

public fun emit_liquidity_removed(
    pool_id: ID,
    sender: address,
    amount_x: u64,
    amount_y: u64,
    lp_tokens_burned: u64,
) {
    event::emit(LiquidityRemovedEvent {
        pool_id,
        sender,
        amount_x,
        amount_y,
        lp_tokens_burned,
    });
}

public fun emit_engine_registered(
    engine_id: u8,
    name: String,
    package_id: address,
    verification_level: u8,
    capabilities: u32,
) {
    event::emit(EngineRegisteredEvent {
        engine_id,
        name,
        package_id,
        verification_level,
        capabilities,
    });
}

public fun emit_market_venue_added(
    market_key: String,
    venue_id: ID,
    engine_type: u8,
) {
    event::emit(MarketVenueAddedEvent {
        market_key,
        venue_id,
        engine_type,
    });
}

public fun emit_policy_executed(
    policy_type: u8,
    pool_id: ID,
    fee_bps: u64,
    oracle_price: u128,
) {
    event::emit(PolicyExecutedEvent {
        policy_type,
        pool_id,
        fee_bps,
        oracle_price,
    });
}
