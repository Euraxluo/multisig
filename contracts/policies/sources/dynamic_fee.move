module policies::dynamic_fee;

use liquidity_core::types;

/// Calculate dynamic fee in basis points based on baseline fee, volatility metric, and inventory imbalance
/// Formula: f_t = f_0 + alpha * sigma + beta * imbalance
/// Clamped between fee_min and fee_max
public fun compute_dynamic_fee(
    base_fee_bps: u64,
    volatility_bps: u64,
    imbalance_bps: u64,
    fee_min_bps: u64,
    fee_max_bps: u64,
): u64 {
    let mut calculated_fee = base_fee_bps + (volatility_bps / 2) + (imbalance_bps / 4);

    if (calculated_fee < fee_min_bps) {
        calculated_fee = fee_min_bps;
    };

    if (calculated_fee > fee_max_bps) {
        calculated_fee = fee_max_bps;
    };

    if (calculated_fee > types::max_fee_bps()) {
        calculated_fee = types::max_fee_bps();
    };

    calculated_fee
}

#[test]
fun test_dynamic_fee_clamping() {
    // Normal case
    let fee = compute_dynamic_fee(30, 20, 40, 10, 100);
    // 30 + 10 + 10 = 50 bps
    assert!(fee == 50, 0);

    // Min clamp
    let fee_low = compute_dynamic_fee(5, 0, 0, 20, 100);
    assert!(fee_low == 20, 1);

    // Max clamp
    let fee_high = compute_dynamic_fee(90, 100, 100, 10, 100);
    assert!(fee_high == 100, 2);
}
