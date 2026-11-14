module liquidity_core::types;

/// Basis points scale factor: 10_000 bps = 100%
const BPS_SCALE: u64 = 10_000;

/// Maximum allowable fee: 20% (2_000 bps)
const MAX_FEE_BPS: u64 = 2_000;

/// Minimum liquidity locked permanently on initial pool mint to prevent inflation attacks
const MIN_INITIAL_LIQUIDITY: u64 = 1_000;

// === Error Codes ===
const EZERO_AMOUNT: u64 = 1001;
const EINVALID_FEE_BPS: u64 = 1002;
const EINSUFFICIENT_OUTPUT: u64 = 1003;
const EINSUFFICIENT_LIQUIDITY: u64 = 1004;
const EINVALID_PERMIT: u64 = 1005;
const EINVALID_RECEIPT: u64 = 1006;
const EPAUSED: u64 = 1007;
const EUNAUTHORIZED: u64 = 1008;
const EEXPIRED: u64 = 1009;
const EINVALID_RESERVES: u64 = 1010;
const EDEVIATION_TOO_HIGH: u64 = 1011;
const EINVALID_BOUNDS: u64 = 1012;

public fun bps_scale(): u64 { BPS_SCALE }
public fun max_fee_bps(): u64 { MAX_FEE_BPS }
public fun min_initial_liquidity(): u64 { MIN_INITIAL_LIQUIDITY }

public fun e_zero_amount(): u64 { EZERO_AMOUNT }
public fun e_invalid_fee_bps(): u64 { EINVALID_FEE_BPS }
public fun e_insufficient_output(): u64 { EINSUFFICIENT_OUTPUT }
public fun e_insufficient_liquidity(): u64 { EINSUFFICIENT_LIQUIDITY }
public fun e_invalid_permit(): u64 { EINVALID_PERMIT }
public fun e_invalid_receipt(): u64 { EINVALID_RECEIPT }
public fun e_paused(): u64 { EPAUSED }
public fun e_unauthorized(): u64 { EUNAUTHORIZED }
public fun e_expired(): u64 { EEXPIRED }
public fun e_invalid_reserves(): u64 { EINVALID_RESERVES }
public fun e_deviation_too_high(): u64 { EDEVIATION_TOO_HIGH }
public fun e_invalid_bounds(): u64 { EINVALID_BOUNDS }
