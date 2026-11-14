module engine_custom::curve_math;

use liquidity_core::types;

const CURVE_LINEAR: u8 = 1;
const CURVE_SIGMOID: u8 = 2;
const CURVE_VIRTUAL_CPMM: u8 = 3;

public fun curve_linear(): u8 { CURVE_LINEAR }
public fun curve_sigmoid(): u8 { CURVE_SIGMOID }
public fun curve_virtual_cpmm(): u8 { CURVE_VIRTUAL_CPMM }

/// Virtual Constant Product AMM buy calculation: (x + vx)(y + vy) = k
public fun calc_virtual_cpmm_out(
    real_x: u64,
    real_y: u64,
    virt_x: u64,
    virt_y: u64,
    amount_in: u64,
    fee_bps: u64,
): (u64, u64) {
    assert!(amount_in > 0, types::e_zero_amount());
    assert!(fee_bps <= types::max_fee_bps(), types::e_invalid_fee_bps());

    let eff_x = ((real_x as u128) + (virt_x as u128));
    let eff_y = ((real_y as u128) + (virt_y as u128));
    assert!(eff_x > 0 && eff_y > 0, types::e_insufficient_liquidity());

    let bps_scale = (types::bps_scale() as u128);
    let fee_factor = bps_scale - (fee_bps as u128);
    let amount_in_with_fee = (amount_in as u128) * fee_factor / bps_scale;

    let numerator = amount_in_with_fee * eff_y;
    let denominator = eff_x + amount_in_with_fee;

    let amount_out = ((numerator / denominator) as u64);
    assert!(amount_out > 0, types::e_insufficient_output());
    assert!(amount_out <= real_y, types::e_insufficient_liquidity());

    let fee_amount = (((amount_in as u128) * (fee_bps as u128) / bps_scale) as u64);

    (amount_out, fee_amount)
}

/// Linear bonding curve buy calculation: cost P(S) = P0 + m * S
public fun calc_linear_out(
    current_supply: u64,
    amount_in: u64,
    p0: u64,
    slope: u64,
): u64 {
    assert!(amount_in > 0, types::e_zero_amount());
    assert!(p0 > 0, types::e_invalid_bounds());

    // Approximate token out for a small increment: dy ~ amount_in / (P0 + slope * S)
    let current_price = (p0 as u128) + ((slope as u128) * (current_supply as u128) / 1_000_000);
    let amount_out = (((amount_in as u128) * 1_000_000 / current_price) as u64);
    assert!(amount_out > 0, types::e_insufficient_output());
    amount_out
}

#[test]
fun test_virtual_cpmm_math() {
    // 30,000 SUI virtual base, 1,000,000,000 MEME tokens real supply
    let real_x = 0; // 0 SUI initially deposited
    let real_y = 1_000_000_000; // 1B tokens
    let virt_x = 30_000_000_000; // 30,000 SUI virtual reserve
    let virt_y = 1_073_000_000; // virtual tokens

    let (tokens_out, fee) = calc_virtual_cpmm_out(
        real_x,
        real_y,
        virt_x,
        virt_y,
        1_000_000_000, // 1 SUI
        100, // 1% fee (100 bps)
    );

    assert!(tokens_out > 0, 0);
    assert!(fee == 10_000_000, 1);
}
