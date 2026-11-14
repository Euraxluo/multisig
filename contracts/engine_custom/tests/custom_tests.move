#[test_only]
module engine_custom::custom_tests;

use sui::test_scenario::{Self as ts, Scenario};
use sui::coin::{Self, Coin};
use sui::clock::{Self, Clock};
use liquidity_core::capabilities::{Self, PoolAdminCap};
use engine_custom::custom_pool::{Self, CustomPool};

public struct SUI_COIN has drop {}
public struct MEME has drop {}

fun setup_test(scenario: &mut Scenario) {
    let ctx = ts::ctx(scenario);
    let clock = clock::create_for_testing(ctx);
    clock::share_for_testing(clock);
}

#[test]
fun test_custom_bonding_and_graduation() {
    let creator = @0x10;
    let buyer = @0x20;
    let mut scenario = ts::begin(creator);

    setup_test(&mut scenario);

    // 1. Creator launches MEME pool with 1,000,000,000 MEME tokens
    // Virtual SUI: 30,000 SUI, Virtual MEME: 1,073,000,000
    // Graduation threshold: 5,000 SUI
    ts::next_tx(&mut scenario, creator);
    {
        let ctx = ts::ctx(&mut scenario);
        let meme_tokens: Coin<MEME> = coin::mint_for_testing(1_000_000_000_000_000, ctx); // 1B with 6 decimals

        let admin_cap = custom_pool::create_virtual_cpmm_pool<SUI_COIN, MEME>(
            meme_tokens,
            30_000_000_000_000, // 30,000 SUI virtual base
            1_073_000_000_000_000,
            100, // 1% fee (100 bps)
            5_000_000_000_000,  // 5,000 SUI graduation threshold
            ctx,
        );

        transfer::public_transfer(admin_cap, creator);
    };

    // 2. Buyer buys MEME tokens with 1,000 SUI
    ts::next_tx(&mut scenario, buyer);
    {
        let mut pool = ts::take_shared<CustomPool<SUI_COIN, MEME>>(&scenario);
        let ctx = ts::ctx(&mut scenario);

        let sui_in = coin::mint_for_testing(1_000_000_000_000, ctx); // 1,000 SUI
        let meme_bought = custom_pool::buy<SUI_COIN, MEME>(
            &mut pool,
            sui_in,
            1, // min 1 token
            ctx,
        );

        assert!(coin::value(&meme_bought) > 0, 0);
        assert!(!custom_pool::is_ready_to_graduate(&pool), 1);

        coin::burn_for_testing(meme_bought);
        ts::return_shared(pool);
    };

    // 3. Buyer buys enough to cross 5,000 SUI graduation threshold
    ts::next_tx(&mut scenario, buyer);
    {
        let mut pool = ts::take_shared<CustomPool<SUI_COIN, MEME>>(&scenario);
        let ctx = ts::ctx(&mut scenario);

        let sui_in = coin::mint_for_testing(4_500_000_000_000, ctx); // 4,500 SUI (total > 5,000)
        let meme_bought = custom_pool::buy<SUI_COIN, MEME>(
            &mut pool,
            sui_in,
            1,
            ctx,
        );

        assert!(custom_pool::is_ready_to_graduate(&pool), 2);

        coin::burn_for_testing(meme_bought);
        ts::return_shared(pool);
    };

    // 4. Creator graduates pool and withdraws liquidity for migration
    ts::next_tx(&mut scenario, creator);
    {
        let mut pool = ts::take_shared<CustomPool<SUI_COIN, MEME>>(&scenario);
        let cap = ts::take_from_sender<PoolAdminCap>(&scenario);
        let ctx = ts::ctx(&mut scenario);

        let (grad_sui, grad_meme) = custom_pool::withdraw_for_graduation<SUI_COIN, MEME>(
            &mut pool,
            &cap,
            ctx,
        );

        assert!(coin::value(&grad_sui) >= 5_000_000_000_000, 3);
        assert!(coin::value(&grad_meme) > 0, 4);
        assert!(custom_pool::is_graduated(&pool), 5);

        coin::burn_for_testing(grad_sui);
        coin::burn_for_testing(grad_meme);
        capabilities::destroy_pool_admin_cap_for_testing(cap);
        ts::return_shared(pool);
    };

    ts::end(scenario);
}
