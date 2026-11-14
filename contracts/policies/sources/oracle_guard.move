module policies::oracle_guard;

use liquidity_core::types;

/// Check that the execution pool price does not deviate from the oracle reference price by more than max_deviation_bps
public fun check_price_deviation(
    pool_price: u128,
    oracle_price: u128,
    max_deviation_bps: u64,
) {
    assert!(pool_price > 0 && oracle_price > 0, types::e_zero_amount());
    assert!(max_deviation_bps <= types::bps_scale(), types::e_invalid_bounds());

    let diff = if (pool_price > oracle_price) {
        ((pool_price - oracle_price) as u256)
    } else {
        ((oracle_price - pool_price) as u256)
    };

    let bps_scale = (types::bps_scale() as u256);
    let oracle_256 = (oracle_price as u256);
    let deviation_bps = (((diff * bps_scale) / oracle_256) as u64);
    assert!(deviation_bps <= max_deviation_bps, types::e_deviation_too_high());
}

/// Check both price deviation and oracle feed freshness
public fun check_price_deviation_and_freshness(
    pool_price: u128,
    oracle_price: u128,
    publish_time_ms: u64,
    current_time_ms: u64,
    max_age_ms: u64,
    max_deviation_bps: u64,
) {
    if (max_age_ms > 0) {
        assert!(current_time_ms >= publish_time_ms, types::e_invalid_bounds());
        assert!(current_time_ms - publish_time_ms <= max_age_ms, types::e_expired());
    };
    check_price_deviation(pool_price, oracle_price, max_deviation_bps);
}

#[test]
fun test_oracle_guard_valid_and_invalid() {
    let oracle = 2_000_000_000; // $2.00
    let pool_close = 2_010_000_000; // $2.01 (0.5% = 50 bps deviation)
    check_price_deviation(pool_close, oracle, 100); // 100 bps max -> OK
}

#[test]
#[expected_failure(abort_code = 1011, location = Self)]
fun test_oracle_guard_deviation_exceeded() {
    let oracle = 2_000_000_000; // $2.00
    let pool_deviant = 2_150_000_000; // $2.15 (7.5% = 750 bps deviation)
    check_price_deviation(pool_deviant, oracle, 200); // 200 bps max -> abort!
}
