module liquidity_core::engine_registry;

use sui::table::{Self, Table};
use std::ascii::String;
use liquidity_core::capabilities::{Self, RegistryCap};
use liquidity_core::events;

// === Verification Levels ===
const LEVEL_OFFICIAL: u8 = 1;
const LEVEL_VERIFIED: u8 = 2;
const LEVEL_COMMUNITY: u8 = 3;
const LEVEL_UNVERIFIED: u8 = 4;
const LEVEL_BLOCKED: u8 = 5;

// === Engine Types ===
const TYPE_CLMM: u8 = 1;
const TYPE_CLOB: u8 = 2;
const TYPE_CPMM: u8 = 3;
const TYPE_STABLE: u8 = 4;
const TYPE_CUSTOM: u8 = 5;

// === Engine Capabilities Bitmask ===
const CAP_SWAP_EXACT_IN: u32 = 1;
const CAP_SWAP_EXACT_OUT: u32 = 2;
const CAP_ADD_LIQUIDITY: u32 = 4;
const CAP_REMOVE_LIQUIDITY: u32 = 8;
const CAP_DYNAMIC_FEE: u32 = 16;
const CAP_CUSTOM_CURVE: u32 = 32;

public struct EngineInfo has copy, drop, store {
    engine_id: u8,
    name: String,
    package_id: address,
    module_name: String,
    engine_type: u8,
    verification_level: u8,
    capabilities: u32,
    is_active: bool,
}

public struct EngineRegistry has key {
    id: UID,
    engines: Table<u8, EngineInfo>,
    total_engines: u8,
}

fun init(ctx: &mut TxContext) {
    let registry = EngineRegistry {
        id: object::new(ctx),
        engines: table::new(ctx),
        total_engines: 0,
    };
    transfer::share_object(registry);

    let reg_cap = capabilities::create_registry_cap(ctx);
    transfer::public_transfer(reg_cap, tx_context::sender(ctx));
}

public fun register_engine(
    registry: &mut EngineRegistry,
    _cap: &RegistryCap,
    engine_id: u8,
    name: String,
    package_id: address,
    module_name: String,
    engine_type: u8,
    verification_level: u8,
    capabilities: u32,
) {
    let info = EngineInfo {
        engine_id,
        name,
        package_id,
        module_name,
        engine_type,
        verification_level,
        capabilities,
        is_active: true,
    };

    if (table::contains(&registry.engines, engine_id)) {
        let entry = table::borrow_mut(&mut registry.engines, engine_id);
        *entry = info;
    } else {
        table::add(&mut registry.engines, engine_id, info);
        registry.total_engines = registry.total_engines + 1;
    };

    events::emit_engine_registered(
        engine_id,
        name,
        package_id,
        verification_level,
        capabilities,
    );
}

public fun update_verification_level(
    registry: &mut EngineRegistry,
    _cap: &RegistryCap,
    engine_id: u8,
    new_level: u8,
) {
    let entry = table::borrow_mut(&mut registry.engines, engine_id);
    entry.verification_level = new_level;
}

public fun set_engine_active(
    registry: &mut EngineRegistry,
    _cap: &RegistryCap,
    engine_id: u8,
    is_active: bool,
) {
    let entry = table::borrow_mut(&mut registry.engines, engine_id);
    entry.is_active = is_active;
}

// === Getters & Constants ===

public fun get_engine_info(registry: &EngineRegistry, engine_id: u8): EngineInfo {
    *table::borrow(&registry.engines, engine_id)
}

public fun is_engine_active(registry: &EngineRegistry, engine_id: u8): bool {
    if (!table::contains(&registry.engines, engine_id)) {
        return false
    };
    table::borrow(&registry.engines, engine_id).is_active
}

public fun level_official(): u8 { LEVEL_OFFICIAL }
public fun level_verified(): u8 { LEVEL_VERIFIED }
public fun level_community(): u8 { LEVEL_COMMUNITY }
public fun level_unverified(): u8 { LEVEL_UNVERIFIED }
public fun level_blocked(): u8 { LEVEL_BLOCKED }

public fun type_clmm(): u8 { TYPE_CLMM }
public fun type_clob(): u8 { TYPE_CLOB }
public fun type_cpmm(): u8 { TYPE_CPMM }
public fun type_stable(): u8 { TYPE_STABLE }
public fun type_custom(): u8 { TYPE_CUSTOM }

public fun cap_swap_exact_in(): u32 { CAP_SWAP_EXACT_IN }
public fun cap_swap_exact_out(): u32 { CAP_SWAP_EXACT_OUT }
public fun cap_add_liquidity(): u32 { CAP_ADD_LIQUIDITY }
public fun cap_remove_liquidity(): u32 { CAP_REMOVE_LIQUIDITY }
public fun cap_dynamic_fee(): u32 { CAP_DYNAMIC_FEE }
public fun cap_custom_curve(): u32 { CAP_CUSTOM_CURVE }

#[test_only]
public fun create_registry_for_testing(ctx: &mut TxContext): (EngineRegistry, RegistryCap) {
    let registry = EngineRegistry {
        id: object::new(ctx),
        engines: table::new(ctx),
        total_engines: 0,
    };
    let cap = capabilities::create_registry_cap(ctx);
    (registry, cap)
}

#[test_only]
public fun destroy_registry_for_testing(registry: EngineRegistry, cap: RegistryCap) {
    let EngineRegistry { id, engines, total_engines: _ } = registry;
    table::drop(engines);
    object::delete(id);
    capabilities::destroy_registry_cap_for_testing(cap);
}

#[test]
fun test_register_and_query_engine() {
    let mut scenario = sui::test_scenario::begin(@0x42);
    let (mut registry, cap) = create_registry_for_testing(sui::test_scenario::ctx(&mut scenario));

    register_engine(
        &mut registry,
        &cap,
        1,
        std::ascii::string(b"DeepBook"),
        @0xdee9,
        std::ascii::string(b"pool"),
        TYPE_CLOB,
        LEVEL_OFFICIAL,
        CAP_SWAP_EXACT_IN | CAP_SWAP_EXACT_OUT,
    );

    assert!(is_engine_active(&registry, 1), 0);
    let info = get_engine_info(&registry, 1);
    assert!(info.engine_type == TYPE_CLOB, 1);
    assert!(info.verification_level == LEVEL_OFFICIAL, 2);

    update_verification_level(&mut registry, &cap, 1, LEVEL_VERIFIED);
    let updated = get_engine_info(&registry, 1);
    assert!(updated.verification_level == LEVEL_VERIFIED, 3);

    set_engine_active(&mut registry, &cap, 1, false);
    assert!(!is_engine_active(&registry, 1), 4);

    destroy_registry_for_testing(registry, cap);
    sui::test_scenario::end(scenario);
}
