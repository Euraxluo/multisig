module engine_cpmm::math;

use liquidity_core::types;

/// Calculate amount out given exact amount in, reserves, and fee in BPS
public fun get_amount_out(
    amount_in: u64,
    reserve_in: u64,
    reserve_out: u64,
    fee_bps: u64,
): (u64, u64) {
    assert!(amount_in > 0, types::e_zero_amount());
    assert!(reserve_in > 0 && reserve_out > 0, types::e_insufficient_liquidity());
    assert!(fee_bps <= types::max_fee_bps(), types::e_invalid_fee_bps());

    let bps_scale = (types::bps_scale() as u256);
    let fee_factor = bps_scale - (fee_bps as u256);
    let amount_in_with_fee = (amount_in as u256) * fee_factor;
    let numerator = amount_in_with_fee * (reserve_out as u256);
    let denominator = ((reserve_in as u256) * bps_scale) + amount_in_with_fee;

    let amount_out = ((numerator / denominator) as u64);
    assert!(amount_out > 0, types::e_insufficient_output());
    assert!(amount_out < reserve_out, types::e_insufficient_liquidity());

    let fee_amount = ((((amount_in as u256) * (fee_bps as u256)) / bps_scale) as u64);

    (amount_out, fee_amount)
}

/// Calculate required amount in given target amount out, reserves, and fee in BPS
public fun get_amount_in(
    amount_out: u64,
    reserve_in: u64,
    reserve_out: u64,
    fee_bps: u64,
): (u64, u64) {
    assert!(amount_out > 0, types::e_zero_amount());
    assert!(amount_out < reserve_out, types::e_insufficient_liquidity());
    assert!(reserve_in > 0 && reserve_out > 0, types::e_insufficient_liquidity());
    assert!(fee_bps <= types::max_fee_bps(), types::e_invalid_fee_bps());

    let bps_scale = (types::bps_scale() as u256);
    let fee_factor = bps_scale - (fee_bps as u256);
    let numerator = (reserve_in as u256) * (amount_out as u256) * bps_scale;
    let denominator = (((reserve_out - amount_out) as u256)) * fee_factor;

    // Ceiling division so the pool is always protected: (numerator + denominator - 1) / denominator
    let amount_in = (((numerator + denominator - 1) / denominator) as u64);
    let fee_amount = ((((amount_in as u256) * (fee_bps as u256)) / bps_scale) as u64);

    (amount_in, fee_amount)
}

/// Integer square root using Babylonian algorithm
public fun sqrt(y: u128): u64 {
    if (y > 3) {
        let mut z = y;
        let mut x = y / 2 + 1;
        while (x < z) {
            z = x;
            x = (y / x + x) / 2;
        };
        (z as u64)
    } else if (y != 0) {
        1
    } else {
        0
    }
}

/// Calculate LP tokens minted for initial liquidity deposit
public fun calc_initial_lp(amount_x: u64, amount_y: u64): u64 {
    assert!(amount_x > 0 && amount_y > 0, types::e_zero_amount());
    let product = (amount_x as u128) * (amount_y as u128);
    let root = sqrt(product);
    let min_initial = types::min_initial_liquidity();
    assert!(root > min_initial, types::e_insufficient_liquidity());
    root - min_initial
}

/// Calculate LP tokens minted for subsequent deposits
public fun calc_add_liquidity_lp(
    amount_x: u64,
    amount_y: u64,
    reserve_x: u64,
    reserve_y: u64,
    total_lp: u64,
): u64 {
    assert!(amount_x > 0 && amount_y > 0, types::e_zero_amount());
    assert!(reserve_x > 0 && reserve_y > 0 && total_lp > 0, types::e_insufficient_liquidity());

    let lp_x = (((amount_x as u128) * (total_lp as u128) / (reserve_x as u128)) as u64);
    let lp_y = (((amount_y as u128) * (total_lp as u128) / (reserve_y as u128)) as u64);

    let lp_minted = if (lp_x < lp_y) { lp_x } else { lp_y };
    assert!(lp_minted > 0, types::e_insufficient_liquidity());
    lp_minted
}

/// Calculate tokens returned when burning LP tokens
public fun calc_remove_liquidity(
    lp_amount: u64,
    reserve_x: u64,
    reserve_y: u64,
    total_lp: u64,
): (u64, u64) {
    assert!(lp_amount > 0, types::e_zero_amount());
    assert!(lp_amount <= total_lp, types::e_insufficient_liquidity());
    assert!(reserve_x > 0 && reserve_y > 0 && total_lp > 0, types::e_insufficient_liquidity());

    let out_x = (((lp_amount as u128) * (reserve_x as u128) / (total_lp as u128)) as u64);
    let out_y = (((lp_amount as u128) * (reserve_y as u128) / (total_lp as u128)) as u64);

    assert!(out_x > 0 && out_y > 0, types::e_insufficient_output());
    (out_x, out_y)
}

/// Verify that invariant k does not decrease after swap
public fun assert_k_non_decreasing(
    new_reserve_x: u64,
    new_reserve_y: u64,
    old_reserve_x: u64,
    old_reserve_y: u64,
) {
    let k_new = (new_reserve_x as u256) * (new_reserve_y as u256);
    let k_old = (old_reserve_x as u256) * (old_reserve_y as u256);
    assert!(k_new >= k_old, types::e_invalid_reserves());
}

#[test]
fun test_get_amount_out_reference_example() {
    // Matches the exact example in 参考文档.md (lines 463-495):
    // x = 1000, y = 2000, dx = 100, f = 0.003 (30 bps) -> dy ~ 181
    let (amount_out, fee_amount) = get_amount_out(100, 1000, 2000, 30);
    assert!(amount_out == 181, 0);
    // fee amount: 100 * 30 / 10000 = 0 (integer division) or 0.3
    assert!(fee_amount == 0, 1);

    // With larger scale numbers (e.g. 6 decimals: 1000 USDC -> 100_000_000)
    let (out_scaled, fee_scaled) = get_amount_out(
        100_000_000, // 100 USDC
        1_000_000_000, // 1,000 USDC reserve
        2_000_000_000, // 2,000 SUI reserve
        30, // 0.3% fee
    );
    // dy should be ~ 181_322_178
    assert!(out_scaled == 181_322_178, 2);
    assert!(fee_scaled == 300_000, 3); // 100 * 0.003 = 0.3 USDC = 300_000 units
}

#[test]
fun test_get_amount_in_and_roundtrip() {
    let (amount_out, _) = get_amount_out(10_000, 100_000, 100_000, 30);
    let (amount_in_needed, _) = get_amount_in(amount_out, 100_000, 100_000, 30);
    // Due to round-up, amount_in_needed should be equal to or slightly greater than 10_000
    assert!(amount_in_needed >= 10_000, 0);
    assert!(amount_in_needed <= 10_002, 1);
}

#[test]
fun test_sqrt() {
    assert!(sqrt(0) == 0, 0);
    assert!(sqrt(1) == 1, 1);
    assert!(sqrt(4) == 2, 2);
    assert!(sqrt(9) == 3, 3);
    assert!(sqrt(16) == 4, 4);
    assert!(sqrt(100) == 10, 5);
    assert!(sqrt(10_000_000_000_000_000_000_000_000_000_000_000) == 100_000_000_000_000_000, 6);
}

#[test]
fun test_lp_mint_and_burn() {
    let initial_lp = calc_initial_lp(1_000_000, 1_000_000);
    // sqrt(10^12) = 1_000_000. 1_000_000 - 1_000 = 999_000
    assert!(initial_lp == 999_000, 0);

    // Add 50% liquidity
    let total_lp = initial_lp + types::min_initial_liquidity(); // 1_000_000
    let added_lp = calc_add_liquidity_lp(500_000, 500_000, 1_000_000, 1_000_000, total_lp);
    assert!(added_lp == 500_000, 1);

    // Remove liquidity
    let new_total_lp = total_lp + added_lp; // 1_500_000
    let (out_x, out_y) = calc_remove_liquidity(500_000, 1_500_000, 1_500_000, new_total_lp);
    assert!(out_x == 500_000, 2);
    assert!(out_y == 500_000, 3);
}

#[test]
fun test_k_invariant_property() {
    let res_in = 1_000_000_000;
    let res_out = 2_000_000_000;
    let dx = 50_000_000;
    let fee_bps = 30;

    let (dy, _) = get_amount_out(dx, res_in, res_out, fee_bps);
    let new_res_in = res_in + dx;
    let new_res_out = res_out - dy;

    assert_k_non_decreasing(new_res_in, new_res_out, res_in, res_out);
}
