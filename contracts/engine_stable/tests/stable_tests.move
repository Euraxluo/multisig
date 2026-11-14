#[test_only]
module engine_stable::stable_tests;

use sui::test_scenario::{Self as ts, Scenario};
use sui::coin::{Self, Coin};
use sui::clock::{Self, Clock};
use liquidity_core::receipts;
use liquidity_core::capabilities::{Self, PoolAdminCap};
use engine_stable::pool::{Self, StablePool, StableLPCoin};

public struct USDC has drop {}
public struct USDT has drop {}

fun setup_test(scenario: &mut Scenario) {
    let ctx = ts::ctx(scenario);
    let clock = clock::create_for_testing(ctx);
    clock::share_for_testing(clock);
}

#[test]
fun test_stable_pool_lifecycle() {
    let user = @0x42;
    let mut scenario = ts::begin(user);

    setup_test(&mut scenario);

    ts::next_tx(&mut scenario, user);
    {
        let ctx = ts::ctx(&mut scenario);
        let coin_x: Coin<USDC> = coin::mint_for_testing(1_000_000_000_000, ctx); // 1,000,000 USDC
        let coin_y: Coin<USDT> = coin::mint_for_testing(1_000_000_000_000, ctx); // 1,000,000 USDT

        let (lp_coin, admin_cap) = pool::create_pool<USDC, USDT>(
            coin_x,
            coin_y,
            1_000_000_000_000, // 10^12 scale factor (6 decimals to 18 decimals)
            1_000_000_000_000,
            200, // A = 200
            4,   // 0.04% fee (4 bps)
            0,
            false,
            ctx,
        );

        assert!(pool::lp_value(&lp_coin) > 0, 0);
        transfer::public_transfer(lp_coin, user);
        transfer::public_transfer(admin_cap, user);
    };

    // Swap 10,000 USDC to USDT
    ts::next_tx(&mut scenario, user);
    {
        let mut pool = ts::take_shared<StablePool<USDC, USDT>>(&scenario);
        let ctx = ts::ctx(&mut scenario);
        let swap_in = coin::mint_for_testing(10_000_000_000, ctx); // 10,000 USDC

        let coin_out = pool::swap_exact_x_to_y<USDC, USDT>(
            &mut pool,
            swap_in,
            9_990_000_000, // min 9,990 USDT
            ctx,
        );

        let out_val = coin::value(&coin_out);
        assert!(out_val > 9_990_000_000, 1);
        assert!(out_val < 10_000_000_000, 2);

        coin::burn_for_testing(coin_out);
        ts::return_shared(pool);
    };

    // Add liquidity
    ts::next_tx(&mut scenario, user);
    {
        let mut pool = ts::take_shared<StablePool<USDC, USDT>>(&scenario);
        let ctx = ts::ctx(&mut scenario);

        let cx = coin::mint_for_testing(100_000_000_000, ctx); // 100,000 USDC
        let cy = coin::mint_for_testing(100_000_000_000, ctx); // 100,000 USDT

        let lp_more = pool::add_liquidity<USDC, USDT>(
            &mut pool,
            cx,
            cy,
            1,
            ctx,
        );

        assert!(pool::lp_value(&lp_more) > 0, 3);
        transfer::public_transfer(lp_more, user);
        ts::return_shared(pool);
    };

    // Clean up
    ts::next_tx(&mut scenario, user);
    {
        let admin_cap = ts::take_from_sender<PoolAdminCap>(&scenario);
        let lp1 = ts::take_from_sender<StableLPCoin<USDC, USDT>>(&scenario);
        let lp2 = ts::take_from_sender<StableLPCoin<USDC, USDT>>(&scenario);
        capabilities::destroy_pool_admin_cap_for_testing(admin_cap);
        pool::destroy_lp_for_testing(lp1);
        pool::destroy_lp_for_testing(lp2);
    };

    ts::end(scenario);
}
