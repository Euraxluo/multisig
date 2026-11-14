module engine_stable::math;

use liquidity_core::types;

const MAX_ITERATIONS: u8 = 255;

/// Calculate the StableSwap invariant D using Newton's method
/// Invariant: 4A(x + y) + D = 4AD + D^3 / (4xy)
public fun get_D(x: u128, y: u128, a: u64): u128 {
    let x_256 = (x as u256);
    let y_256 = (y as u256);
    let s = x_256 + y_256;
    if (s == 0) {
        return 0
    };

    let ann = (a as u256) * 4;
    let mut d = s;
    let mut prev_d: u256;
    let mut i = 0;

    while (i < MAX_ITERATIONS) {
        let mut d_p = d;
        d_p = d_p * d / (x_256 * 2);
        d_p = d_p * d / (y_256 * 2);

        prev_d = d;
        let numerator = ((ann * s) + (d_p * 2)) * d;
        let denominator = ((ann - 1) * d) + (d_p * 3);
        d = numerator / denominator;

        let diff = if (d > prev_d) { d - prev_d } else { prev_d - d };
        if (diff <= 1) {
            return (d as u128)
        };
        i = i + 1;
    };

    (d as u128)
}

/// Calculate y given new x and invariant D using Newton's method
public fun get_y(x_new: u128, d: u128, a: u64): u128 {
    let x_256 = (x_new as u256);
    let d_256 = (d as u256);
    let ann = (a as u256) * 4;

    // c = D^3 / (4 * ann * x_new)
    let c = d_256 * d_256 * d_256 / (x_256 * ann * 4);
    // b = x_new + D / ann
    let b = x_256 + (d_256 / ann);

    let mut y = d_256;
    let mut prev_y: u256;
    let mut i = 0;

    while (i < MAX_ITERATIONS) {
        prev_y = y;
        let numerator = (y * y) + c;
        let denominator = (y * 2) + b - d_256;
        y = numerator / denominator;

        let diff = if (y > prev_y) { y - prev_y } else { prev_y - y };
        if (diff <= 1) {
            return (y as u128)
        };
        i = i + 1;
    };

    (y as u128)
}

/// Calculate amount out for StableSwap given input amount, scaled reserves, and fee BPS
public fun get_amount_out(
    amount_in: u64,
    reserve_in: u64,
    reserve_out: u64,
    scale_in: u64,
    scale_out: u64,
    a: u64,
    fee_bps: u64,
): (u64, u64) {
    assert!(amount_in > 0, types::e_zero_amount());
    assert!(reserve_in > 0 && reserve_out > 0, types::e_insufficient_liquidity());
    assert!(fee_bps <= types::max_fee_bps(), types::e_invalid_fee_bps());

    // Normalize reserves to 18 decimals using scaling factors
    let x_norm = (reserve_in as u128) * (scale_in as u128);
    let y_norm = (reserve_out as u128) * (scale_out as u128);

    let d = get_D(x_norm, y_norm, a);

    let dx_norm = (amount_in as u128) * (scale_in as u128);
    let x_new = x_norm + dx_norm;

    let y_new = get_y(x_new, d, a);
    assert!(y_norm > y_new, types::e_insufficient_output());

    let dy_norm = y_norm - y_new;

    // Convert back from 18 decimals to output token precision
    let dy = ((dy_norm / (scale_out as u128)) as u64);

    let bps_scale = types::bps_scale();
    let fee_amount = (((dy as u128) * (fee_bps as u128) / (bps_scale as u128)) as u64);
    let amount_out = dy - fee_amount;

    assert!(amount_out > 0, types::e_insufficient_output());
    (amount_out, fee_amount)
}

#[test]
fun test_stable_math_symmetry() {
    let x: u128 = 1_000_000_000_000_000_000; // 1.0 with 18 decimals
    let y: u128 = 1_000_000_000_000_000_000;
    let a: u64 = 100;

    let d = get_D(x, y, a);
    // When x == y, D should equal x + y = 2.0
    assert!(d == 2_000_000_000_000_000_000, 0);

    // If x doesn't change, get_y should return y
    let calculated_y = get_y(x, d, a);
    assert!(calculated_y >= y - 1 && calculated_y <= y + 1, 1);
}

#[test]
fun test_stable_swap_low_slippage() {
    // 1,000,000 USDC and 1,000,000 USDT (both 6 decimals, scale = 10^12 to reach 10^18)
    let reserve_x: u64 = 1_000_000_000_000; // 1M USDC
    let reserve_y: u64 = 1_000_000_000_000; // 1M USDT
    let scale: u64 = 1_000_000_000_000; // 10^12
    let a: u64 = 200; // Amplification
    let fee_bps: u64 = 4; // 0.04% stable fee (4 bps)

    let swap_in = 10_000_000_000; // 10,000 USDC (1% of pool)
    let (amount_out, fee_paid) = get_amount_out(
        swap_in,
        reserve_x,
        reserve_y,
        scale,
        scale,
        a,
        fee_bps,
    );

    // In StableSwap with A=200, 10,000 in should yield almost exactly 9,996 (10,000 minus 4 fee)
    assert!(amount_out > 9_990_000_000, 0);
    assert!(amount_out < 10_000_000_000, 1);
    assert!(fee_paid > 3_900_000 && fee_paid <= 4_100_000, 2);
}
