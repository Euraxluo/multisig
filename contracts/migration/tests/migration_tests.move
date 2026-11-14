#[test_only]
module migration::migration_tests;

use sui::test_scenario::{Self as ts, Scenario};
use sui::coin::{Self, Coin};
use sui::clock::{Self, Clock};
use liquidity_core::capabilities::{Self, PoolAdminCap};
use engine_cpmm::pool::Pool;
use engine_custom::custom_pool::{Self, CustomPool};
use migration::migration_manager::{Self, LPLockVault};

public struct SUI_COIN has drop {}
public struct MEME has drop {}

fun setup_test(scenario: &mut Scenario) {
    let ctx = ts::ctx(scenario);
    let clock = clock::create_for_testing(ctx);
    clock::share_for_testing(clock);
}

#[test]
fun test_complete_bonding_to_cpmm_migration() {
    let creator = @0x10;
    let buyer = @0x20;
    let mut scenario = ts::begin(creator);

    setup_test(&mut scenario);

    // 1. Creator creates custom bonding pool
    ts::next_tx(&mut scenario, creator);
    {
        let ctx = ts::ctx(&mut scenario);
        let meme_tokens: Coin<MEME> = coin::mint_for_testing(1_000_000_000_000_000, ctx);

        let admin_cap = custom_pool::create_virtual_cpmm_pool<SUI_COIN, MEME>(
            meme_tokens,
            30_000_000_000_000,
            1_073_000_000_000_000,
            100,
            2_000_000_000_000, // 2,000 SUI graduation threshold
            ctx,
        );

        transfer::public_transfer(admin_cap, creator);
    };

    // 2. Buyer deposits 2,500 SUI to graduate
    ts::next_tx(&mut scenario, buyer);
    {
        let mut pool = ts::take_shared<CustomPool<SUI_COIN, MEME>>(&scenario);
        let ctx = ts::ctx(&mut scenario);

        let sui_in = coin::mint_for_testing(2_500_000_000_000, ctx);
        let meme_bought = custom_pool::buy<SUI_COIN, MEME>(
            &mut pool,
            sui_in,
            1,
            ctx,
        );

        assert!(custom_pool::is_ready_to_graduate(&pool), 0);

        coin::burn_for_testing(meme_bought);
        ts::return_shared(pool);
    };

    // 3. Creator migrates bonding pool to CPMM pool
    ts::next_tx(&mut scenario, creator);
    {
        let mut custom_pool = ts::take_shared<CustomPool<SUI_COIN, MEME>>(&scenario);
        let cap = ts::take_from_sender<PoolAdminCap>(&scenario);
        let clock = ts::take_shared<Clock>(&scenario);
        let ctx = ts::ctx(&mut scenario);

        let (_vault_id, cpmm_admin_cap) = migration_manager::migrate_bonding_to_cpmm<SUI_COIN, MEME>(
            &mut custom_pool,
            &cap,
            30, // 30 bps (0.3%) CPMM fee
            31_536_000_000, // 1 year lock
            &clock,
            ctx,
        );

        transfer::public_transfer(cpmm_admin_cap, creator);
        capabilities::destroy_pool_admin_cap_for_testing(cap);
        ts::return_shared(clock);
        ts::return_shared(custom_pool);
    };

    // 4. Verify CPMM pool is now live and accepting swaps!
    ts::next_tx(&mut scenario, buyer);
    {
        let mut cpmm_pool = ts::take_shared<Pool<SUI_COIN, MEME>>(&scenario);
        let ctx = ts::ctx(&mut scenario);

        let (rx, ry) = engine_cpmm::pool::reserves(&cpmm_pool);
        assert!(rx >= 2_500_000_000_000, 1);
        assert!(ry > 0, 2);

        // Perform swap on new CPMM pool
        let test_swap_in = coin::mint_for_testing(10_000_000_000, ctx); // 10 SUI
        let meme_out = engine_cpmm::pool::swap_exact_x_to_y<SUI_COIN, MEME>(
            &mut cpmm_pool,
            test_swap_in,
            1,
            ctx,
        );

        assert!(coin::value(&meme_out) > 0, 3);

        coin::burn_for_testing(meme_out);
        ts::return_shared(cpmm_pool);
    };

    // 5. Test claiming unlocked LP after lock duration elapses
    ts::next_tx(&mut scenario, creator);
    {
        let mut clock = ts::take_shared<Clock>(&scenario);
        clock::increment_for_testing(&mut clock, 32_000_000_000); // advance past 1 year

        let vault = ts::take_shared<LPLockVault<SUI_COIN, MEME>>(&scenario);
        let ctx = ts::ctx(&mut scenario);
        let claimed_lp = migration_manager::claim_unlocked_lp(vault, &clock, ctx);

        let cpmm_cap = ts::take_from_sender<PoolAdminCap>(&scenario);
        capabilities::destroy_pool_admin_cap_for_testing(cpmm_cap);
        engine_cpmm::pool::destroy_lp_for_testing(claimed_lp);
        ts::return_shared(clock);
    };

    ts::end(scenario);
}
