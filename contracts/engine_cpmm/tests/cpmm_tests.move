#[test_only]
module engine_cpmm::cpmm_tests;

use sui::test_scenario::{Self as ts, Scenario};
use sui::coin::{Self, Coin};
use sui::clock::{Self, Clock};
use liquidity_core::receipts;
use liquidity_core::capabilities::{Self, PoolAdminCap};
use engine_cpmm::pool::{Self, Pool, LPCoin};

public struct USDC has drop {}
public struct SUI_COIN has drop {}

fun setup_test(scenario: &mut Scenario) {
    let ctx = ts::ctx(scenario);
    let clock = clock::create_for_testing(ctx);
    clock::share_for_testing(clock);
}

#[test]
fun test_cpmm_full_lifecycle() {
    let user = @0x42;
    let mut scenario = ts::begin(user);

    setup_test(&mut scenario);

    ts::next_tx(&mut scenario, user);
    {
        let ctx = ts::ctx(&mut scenario);
        let coin_x: Coin<USDC> = coin::mint_for_testing(10_000_000_000, ctx); // 10,000 USDC
        let coin_y: Coin<SUI_COIN> = coin::mint_for_testing(20_000_000_000, ctx); // 20,000 SUI

        // 30 bps fee (0.3%), 1000 bps protocol fee share (10%)
        let (lp_coin, admin_cap) = pool::create_pool<USDC, SUI_COIN>(
            coin_x,
            coin_y,
            30,
            1000,
            false,
            ctx,
        );

        transfer::public_transfer(lp_coin, user);
        transfer::public_transfer(admin_cap, user);
    };

    // Swap USDC to SUI
    ts::next_tx(&mut scenario, user);
    {
        let mut pool = ts::take_shared<Pool<USDC, SUI_COIN>>(&scenario);
        let (rx, ry) = pool::reserves(&pool);
        assert!(rx == 10_000_000_000, 0);
        assert!(ry == 20_000_000_000, 1);

        let ctx = ts::ctx(&mut scenario);
        let swap_in: Coin<USDC> = coin::mint_for_testing(1_000_000_000, ctx); // 1,000 USDC

        let coin_out = pool::swap_exact_x_to_y<USDC, SUI_COIN>(
            &mut pool,
            swap_in,
            1_800_000_000, // min 1,800 SUI
            ctx,
        );

        let out_val = coin::value(&coin_out);
        // Expected ~ 1,813,221,780 SUI
        assert!(out_val > 1_810_000_000, 2);

        coin::burn_for_testing(coin_out);
        ts::return_shared(pool);
    };

    // Add Liquidity
    ts::next_tx(&mut scenario, user);
    {
        let mut pool = ts::take_shared<Pool<USDC, SUI_COIN>>(&scenario);
        let ctx = ts::ctx(&mut scenario);

        let (rx, ry) = pool::reserves(&pool);
        let add_x = 1_000_000_000;
        let add_y = (((add_x as u128) * (ry as u128) / (rx as u128)) as u64);

        let cx = coin::mint_for_testing(add_x, ctx);
        let cy = coin::mint_for_testing(add_y, ctx);

        let lp_more = pool::add_liquidity<USDC, SUI_COIN>(
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

    // Remove Liquidity
    ts::next_tx(&mut scenario, user);
    {
        let mut pool = ts::take_shared<Pool<USDC, SUI_COIN>>(&scenario);
        let lp_coin = ts::take_from_sender<LPCoin<USDC, SUI_COIN>>(&scenario);
        let ctx = ts::ctx(&mut scenario);

        let (out_x, out_y) = pool::remove_liquidity<USDC, SUI_COIN>(
            &mut pool,
            lp_coin,
            1,
            1,
            ctx,
        );

        assert!(coin::value(&out_x) > 0, 4);
        assert!(coin::value(&out_y) > 0, 5);

        coin::burn_for_testing(out_x);
        coin::burn_for_testing(out_y);
        ts::return_shared(pool);
    };

    // Test Hot Potato Swap with SwapPermit and SwapReceipt
    ts::next_tx(&mut scenario, user);
    {
        let mut pool = ts::take_shared<Pool<USDC, SUI_COIN>>(&scenario);
        let clock = ts::take_shared<Clock>(&scenario);
        let pool_id = object::id(&pool);

        let permit = receipts::create_permit(pool_id, user, 1_000_000, 10_000_000, vector[]);

        let ctx = ts::ctx(&mut scenario);
        let swap_in = coin::mint_for_testing(100_000_000, ctx);

        let (out_coin, receipt) = pool::swap_x_to_y_with_permit<USDC, SUI_COIN>(
            &mut pool,
            swap_in,
            permit,
            &clock,
            ctx,
        );

        assert!(coin::value(&out_coin) > 0, 6);
        assert!(receipts::receipt_amount_in(&receipt) == 100_000_000, 7);
        assert!(receipts::receipt_pool_id(&receipt) == pool_id, 8);

        // Consume receipt
        let (_sender, _, _, _, _) = receipts::consume_receipt(receipt, pool_id);

        coin::burn_for_testing(out_coin);
        ts::return_shared(clock);
        ts::return_shared(pool);
    };

    // Clean up admin cap and remaining LP coin
    ts::next_tx(&mut scenario, user);
    {
        let admin_cap = ts::take_from_sender<PoolAdminCap>(&scenario);
        let remaining_lp = ts::take_from_sender<LPCoin<USDC, SUI_COIN>>(&scenario);
        capabilities::destroy_pool_admin_cap_for_testing(admin_cap);
        pool::destroy_lp_for_testing(remaining_lp);
    };

    ts::end(scenario);
}
