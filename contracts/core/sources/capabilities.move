module liquidity_core::capabilities;

public struct AdminCap has key, store {
    id: UID,
}

public struct RegistryCap has key, store {
    id: UID,
}

public struct PolicyCap has key, store {
    id: UID,
    pool_id: ID,
}

public struct PoolAdminCap has key, store {
    id: UID,
    pool_id: ID,
}

public(package) fun create_admin_cap(ctx: &mut TxContext): AdminCap {
    AdminCap { id: object::new(ctx) }
}

public(package) fun create_registry_cap(ctx: &mut TxContext): RegistryCap {
    RegistryCap { id: object::new(ctx) }
}

/// Create a PoolAdminCap bound to the unique pool UID.
/// Requiring &UID prevents attackers from forging a PoolAdminCap for an arbitrary pool ID.
public fun create_pool_admin_cap(pool_uid: &UID, ctx: &mut TxContext): PoolAdminCap {
    PoolAdminCap { id: object::new(ctx), pool_id: object::uid_to_inner(pool_uid) }
}

public(package) fun create_policy_cap(pool_uid: &UID, ctx: &mut TxContext): PolicyCap {
    PolicyCap { id: object::new(ctx), pool_id: object::uid_to_inner(pool_uid) }
}

public fun pool_admin_cap_pool_id(cap: &PoolAdminCap): ID { cap.pool_id }
public fun policy_cap_pool_id(cap: &PolicyCap): ID { cap.pool_id }

#[test_only]
public fun destroy_registry_cap_for_testing(cap: RegistryCap) {
    let RegistryCap { id } = cap;
    object::delete(id);
}

#[test_only]
public fun destroy_admin_cap_for_testing(cap: AdminCap) {
    let AdminCap { id } = cap;
    object::delete(id);
}

#[test_only]
public fun destroy_pool_admin_cap_for_testing(cap: PoolAdminCap) {
    let PoolAdminCap { id, pool_id: _ } = cap;
    object::delete(id);
}

#[test_only]
public fun destroy_policy_cap_for_testing(cap: PolicyCap) {
    let PolicyCap { id, pool_id: _ } = cap;
    object::delete(id);
}
