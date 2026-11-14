module migration::migration_manager;

use sui::coin::Coin;
use sui::clock::{Self, Clock};
use sui::object::ID;
use liquidity_core::types;
use liquidity_core::capabilities::PoolAdminCap;
use engine_cpmm::pool::{Self, LPCoin};
use engine_custom::custom_pool::{Self, CustomPool};

public struct LPLockVault<phantom BaseAsset, phantom QuoteAsset> has key {
    id: UID,
    lp_coin: LPCoin<BaseAsset, QuoteAsset>,
    locked_until_ms: u64,
    creator: address,
}

/// Graduate Bonding Curve into mature Native CPMM pool and lock LP tokens
public fun migrate_bonding_to_cpmm<BaseAsset, QuoteAsset>(
    custom_pool: &mut CustomPool<BaseAsset, QuoteAsset>,
    custom_admin_cap: &PoolAdminCap,
    fee_bps: u64,
    lock_duration_ms: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): (ID, PoolAdminCap) {
    let (base_coin, quote_coin) = custom_pool::withdraw_for_graduation(
        custom_pool,
        custom_admin_cap,
        ctx,
    );

    let (lp_coin, cpmm_admin_cap) = pool::create_pool<BaseAsset, QuoteAsset>(
        base_coin,
        quote_coin,
        fee_bps,
        1000, // 10% protocol fee share
        false,
        ctx,
    );

    let current_time = clock::timestamp_ms(clock);
    let vault_uid = object::new(ctx);
    let vault_id = object::uid_to_inner(&vault_uid);

    let vault = LPLockVault<BaseAsset, QuoteAsset> {
        id: vault_uid,
        lp_coin,
        locked_until_ms: current_time + lock_duration_ms,
        creator: tx_context::sender(ctx),
    };

    transfer::share_object(vault);

    (vault_id, cpmm_admin_cap)
}

/// Claim and unlock LP tokens once lock_duration_ms has elapsed
public fun claim_unlocked_lp<BaseAsset, QuoteAsset>(
    vault: LPLockVault<BaseAsset, QuoteAsset>,
    clock: &Clock,
    ctx: &mut TxContext,
): LPCoin<BaseAsset, QuoteAsset> {
    assert!(tx_context::sender(ctx) == vault.creator, types::e_unauthorized());
    assert!(clock::timestamp_ms(clock) >= vault.locked_until_ms, types::e_expired());

    let LPLockVault { id, lp_coin, locked_until_ms: _, creator: _ } = vault;
    object::delete(id);
    lp_coin
}

#[test_only]
public fun destroy_vault_for_testing<BaseAsset, QuoteAsset>(vault: LPLockVault<BaseAsset, QuoteAsset>) {
    let LPLockVault { id, lp_coin, locked_until_ms: _, creator: _ } = vault;
    object::delete(id);
    pool::destroy_lp_for_testing(lp_coin);
}
