module policies::buyback;

use sui::balance::{Self, Balance};
use sui::coin::{Self, Coin};
use liquidity_core::types;

public struct BuybackReserve<phantom CoinType> has key {
    id: UID,
    pool_id: ID,
    reserve: Balance<CoinType>,
    total_collected: u64,
    burn_share_bps: u64,
}

public fun create_reserve<CoinType>(
    pool_id: ID,
    burn_share_bps: u64,
    ctx: &mut TxContext,
): ID {
    assert!(burn_share_bps <= types::bps_scale(), types::e_invalid_bounds());
    let uid = object::new(ctx);
    let id = object::uid_to_inner(&uid);

    let reserve = BuybackReserve<CoinType> {
        id: uid,
        pool_id,
        reserve: balance::zero(),
        total_collected: 0,
        burn_share_bps,
    };

    transfer::share_object(reserve);
    id
}

public fun deposit_fee<CoinType>(
    reserve: &mut BuybackReserve<CoinType>,
    fee_coin: Coin<CoinType>,
) {
    let val = coin::value(&fee_coin);
    if (val > 0) {
        reserve.total_collected = reserve.total_collected + val;
        balance::join(&mut reserve.reserve, coin::into_balance(fee_coin));
    } else {
        coin::destroy_zero(fee_coin);
    };
}

public fun total_collected<CoinType>(reserve: &BuybackReserve<CoinType>): u64 {
    reserve.total_collected
}

public fun reserve_balance<CoinType>(reserve: &BuybackReserve<CoinType>): u64 {
    balance::value(&reserve.reserve)
}
