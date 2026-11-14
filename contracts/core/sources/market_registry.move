module liquidity_core::market_registry;

use sui::table::{Self, Table};
use sui::object::ID;
use std::ascii::String;
use liquidity_core::capabilities::{Self, RegistryCap};
use liquidity_core::events;

public struct VenueRecord has copy, drop, store {
    venue_id: ID,
    engine_type: u8,
    is_active: bool,
}

public struct MarketRegistry has key {
    id: UID,
    markets: Table<String, vector<VenueRecord>>,
}

fun init(ctx: &mut TxContext) {
    let registry = MarketRegistry {
        id: object::new(ctx),
        markets: table::new(ctx),
    };
    transfer::share_object(registry);
}

public fun register_venue(
    registry: &mut MarketRegistry,
    _cap: &RegistryCap,
    market_key: String,
    venue_id: ID,
    engine_type: u8,
) {
    let record = VenueRecord {
        venue_id,
        engine_type,
        is_active: true,
    };

    if (table::contains(&registry.markets, market_key)) {
        let venues = table::borrow_mut(&mut registry.markets, market_key);
        venues.push_back(record);
    } else {
        let mut venues = vector[];
        venues.push_back(record);
        table::add(&mut registry.markets, market_key, venues);
    };

    events::emit_market_venue_added(market_key, venue_id, engine_type);
}

public fun get_venues(registry: &MarketRegistry, market_key: String): vector<VenueRecord> {
    if (table::contains(&registry.markets, market_key)) {
        *table::borrow(&registry.markets, market_key)
    } else {
        vector[]
    }
}

public fun venue_id(v: &VenueRecord): ID { v.venue_id }
public fun venue_engine_type(v: &VenueRecord): u8 { v.engine_type }
public fun venue_is_active(v: &VenueRecord): bool { v.is_active }

#[test_only]
public fun create_market_registry_for_testing(ctx: &mut TxContext): (MarketRegistry, RegistryCap) {
    let registry = MarketRegistry {
        id: object::new(ctx),
        markets: table::new(ctx),
    };
    let cap = capabilities::create_registry_cap(ctx);
    (registry, cap)
}

#[test_only]
public fun destroy_market_registry_for_testing(registry: MarketRegistry, cap: RegistryCap) {
    let MarketRegistry { id, markets } = registry;
    table::drop(markets);
    object::delete(id);
    capabilities::destroy_registry_cap_for_testing(cap);
}

#[test]
fun test_market_venue_registration() {
    let mut scenario = sui::test_scenario::begin(@0x42);
    let (mut registry, cap) = create_market_registry_for_testing(sui::test_scenario::ctx(&mut scenario));

    let dummy_venue_id_1 = object::id_from_address(@0x111);
    let dummy_venue_id_2 = object::id_from_address(@0x222);

    let market_key = std::ascii::string(b"SUI_USDC");

    register_venue(&mut registry, &cap, market_key, dummy_venue_id_1, 1);
    register_venue(&mut registry, &cap, market_key, dummy_venue_id_2, 3);

    let venues = get_venues(&registry, market_key);
    assert!(venues.length() == 2, 0);

    assert!(venues[0].venue_id == dummy_venue_id_1, 1);
    assert!(venues[0].engine_type == 1, 2);

    assert!(venues[1].venue_id == dummy_venue_id_2, 3);
    assert!(venues[1].engine_type == 3, 4);

    destroy_market_registry_for_testing(registry, cap);
    sui::test_scenario::end(scenario);
}
