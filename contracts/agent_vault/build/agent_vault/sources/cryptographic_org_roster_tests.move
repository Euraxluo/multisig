#[test_only]
module agent_vault::cryptographic_org_roster_tests;

use sui::event;
use sui::object::ID;
use sui::test_scenario::{Self as ts, Scenario};
use agent_vault::cryptographic_org::{Self as org, Organization, RosterUpdatedEvent};

// === Constants ===

const ALICE: address = @0xA11CE;
const BOB: address = @0xB0B;
const EVE: address = @0xEE7E;
const MALLORY: address = @0x9999;
const GROUP_PK: vector<u8> = x"fcf9b8e1ee313ce8ebe57b41d3d41caa0a66d6b316d5255b494b7d3f225ec67e";
// Signatures over compute_roster_update_digest, produced off-chain with the
// fixture secret key. Each digest binds org_id, epoch, nonce, next epoch,
// threshold, members and weights, so a signature is usable exactly once.
const SIG_ADD_EVE: vector<u8> = x"a0e4e39d9ccc68c1f70f2f257a44a0308e2c91b1ccfd4a6eff8d9669559528100742f6b9aba9a01a046fad0c0be367903a2c3c929b13e44b2ecfaa35dc8e9b0f";
const SIG_REMOVE_BOB: vector<u8> = x"aa66f780c2179a9b41a1b65c95d36e005f7a74f1b887b73ef1e10af266c86a29ffbe1e47678832ab15a8104e1fda603c5e1d2d67686e99b4066cd3916323fc05";

// === Public Types ===

public struct RosterFixture { scenario: Scenario, org_id: ID }

// === Tests ===

#[test]
fun threshold_signed_roster_change_adds_member_and_advances_epoch() {
    let mut f = start();
    f.scenario.next_tx(ALICE);
    {
        let mut organization = take(&f);
        let before = org::epoch_version(&organization);
        org::update_organization_roster(
            &mut organization, 1, vector[ALICE, BOB], vector[ALICE, BOB, EVE], vector[2, 1, 1], 3,
            SIG_ADD_EVE, ctx(&mut f),
        );
        assert!(org::epoch_version(&organization) == before + 1, 0);
        assert!(org::threshold_weight(&organization) == 3, 0);
        assert!(org::member_weight(&organization, EVE) == 1, 0);
        assert!(org::member_weight(&organization, ALICE) == 2, 0);
        assert!(!org::is_member(&organization, MALLORY), 0);
        return_org(organization);
    };
    let events = event::events_by_type<RosterUpdatedEvent>();
    assert!(events.length() == 1, 1);
    let (org_id, members, weights, threshold, epoch) = roster_fields(&events[0]);
    assert!(org_id == f.org_id, 2);
    assert!(members == vector[ALICE, BOB, EVE] && weights == vector[2, 1, 1], 3);
    assert!(threshold == 3 && epoch == 2, 4);
    end(f);
}

#[test]
fun removed_member_disappears_from_the_live_roster() {
    let mut f = start();
    f.scenario.next_tx(ALICE);
    {
        let mut organization = take(&f);
        // 新语义：BOB 是 key signer，先收窄 key_signers 到 [ALICE] 再移除普通成员。
        org::set_key_signers_for_testing(&mut organization, vector[ALICE]);
        org::update_organization_roster(
            &mut organization, 1, vector[ALICE, BOB], vector[ALICE, EVE], vector[2, 1], 2,
            SIG_REMOVE_BOB, ctx(&mut f),
        );
        assert!(org::is_member(&organization, EVE), 0);
        assert!(!org::is_member(&organization, BOB), 0);
        assert!(org::member_weight(&organization, BOB) == 0, 1);
        return_org(organization);
    };
    end(f);
}

#[test, expected_failure(abort_code = org::ENoRosterChange, location = agent_vault::cryptographic_org)]
fun identical_roster_is_rejected_before_consuming_the_nonce() {
    let mut f = start();
    f.scenario.next_tx(ALICE);
    let mut organization = take(&f);
    // Same addresses and weights in another order, same threshold.
    org::update_organization_roster(
        &mut organization, 1, vector[ALICE, BOB], vector[BOB, ALICE], vector[1, 2], 3,
        SIG_REMOVE_BOB, ctx(&mut f),
    );
    return_org(organization);
    end(f);
}

#[test, expected_failure(abort_code = org::EInvalidRoster, location = agent_vault::cryptographic_org)]
fun prior_members_must_cover_the_live_roster_exactly() {
    let mut f = start();
    f.scenario.next_tx(ALICE);
    let mut organization = take(&f);
    // Omitting BOB would leave a removed address in the table after the change.
    org::update_organization_roster(
        &mut organization, 1, vector[ALICE], vector[ALICE, EVE], vector[2, 1], 2,
        SIG_REMOVE_BOB, ctx(&mut f),
    );
    return_org(organization);
    end(f);
}

#[test, expected_failure(abort_code = org::EInvalidRoster, location = agent_vault::cryptographic_org)]
fun duplicate_new_member_is_rejected() {
    let mut f = start();
    f.scenario.next_tx(ALICE);
    let mut organization = take(&f);
    org::update_organization_roster(
        &mut organization, 1, vector[ALICE, BOB], vector[ALICE, ALICE], vector[2, 1], 2,
        SIG_REMOVE_BOB, ctx(&mut f),
    );
    return_org(organization);
    end(f);
}

#[test, expected_failure(abort_code = org::EInvalidRoster, location = agent_vault::cryptographic_org)]
fun zero_weight_member_is_rejected() {
    let mut f = start();
    f.scenario.next_tx(ALICE);
    let mut organization = take(&f);
    org::update_organization_roster(
        &mut organization, 1, vector[ALICE, BOB], vector[ALICE, EVE], vector[2, 0], 2,
        SIG_REMOVE_BOB, ctx(&mut f),
    );
    return_org(organization);
    end(f);
}

#[test, expected_failure(abort_code = org::EUnreachableThreshold, location = agent_vault::cryptographic_org)]
fun threshold_above_total_weight_is_rejected() {
    let mut f = start();
    f.scenario.next_tx(ALICE);
    let mut organization = take(&f);
    org::update_organization_roster(
        &mut organization, 1, vector[ALICE, BOB], vector[ALICE, EVE], vector[2, 1], 4,
        SIG_REMOVE_BOB, ctx(&mut f),
    );
    return_org(organization);
    end(f);
}

#[test, expected_failure(abort_code = org::E_INVALID_NONCE, location = agent_vault::cryptographic_org)]
fun stale_nonce_is_rejected() {
    let mut f = start();
    f.scenario.next_tx(ALICE);
    let mut organization = take(&f);
    org::set_key_signers_for_testing(&mut organization, vector[ALICE]);
    org::update_organization_roster(
        &mut organization, 0, vector[ALICE, BOB], vector[ALICE, EVE], vector[2, 1], 2,
        SIG_REMOVE_BOB, ctx(&mut f),
    );
    return_org(organization);
    end(f);
}

#[test, expected_failure(abort_code = org::E_INVALID_SIGNATURE, location = agent_vault::cryptographic_org)]
fun signature_for_a_different_roster_is_rejected() {
    let mut f = start();
    f.scenario.next_tx(ALICE);
    let mut organization = take(&f);
    org::set_key_signers_for_testing(&mut organization, vector[ALICE]);
    // The fixture signature commits EVE; MALLORY is a different next roster.
    org::update_organization_roster(
        &mut organization, 1, vector[ALICE, BOB], vector[ALICE, MALLORY], vector[2, 1], 2,
        SIG_REMOVE_BOB, ctx(&mut f),
    );
    return_org(organization);
    end(f);
}

#[test, expected_failure(abort_code = org::E_INVALID_SIGNATURE, location = agent_vault::cryptographic_org)]
fun signature_replayed_at_the_next_epoch_is_rejected() {
    let mut f = start();
    f.scenario.next_tx(ALICE);
    {
        let mut organization = take(&f);
        org::update_organization_roster(
            &mut organization, 1, vector[ALICE, BOB], vector[ALICE, BOB, EVE], vector[2, 1, 1], 3,
            SIG_ADD_EVE, ctx(&mut f),
        );
        return_org(organization);
    };
    f.scenario.next_tx(ALICE);
    let mut organization = take(&f);
    // A real change (ALICE's weight), but the only signature is the epoch-1 one
    // for [ALICE 2, BOB 1, EVE 1]; the bound epoch makes the digest differ.
    org::update_organization_roster(
        &mut organization, 2, vector[ALICE, BOB, EVE], vector[ALICE, BOB, EVE], vector[3, 1, 1], 3,
        SIG_ADD_EVE, ctx(&mut f),
    );
    return_org(organization);
    end(f);
}

// === Fixture Functions ===

fun start(): RosterFixture {
    let mut scenario = ts::begin(ALICE);
    let org_id = org::create_organization_for_testing(GROUP_PK, 2, 3, vector[ALICE, BOB], vector[2, 1], scenario.ctx());
    RosterFixture { scenario, org_id }
}

fun take(f: &RosterFixture): Organization {
    ts::take_shared<Organization>(&f.scenario)
}

fun return_org(organization: Organization) {
    ts::return_shared(organization);
}

fun ctx(f: &mut RosterFixture): &mut sui::tx_context::TxContext {
    ts::ctx(&mut f.scenario)
}

fun end(f: RosterFixture) {
    let RosterFixture { scenario, org_id: _ } = f;
    scenario.end();
}

fun roster_fields(event: &RosterUpdatedEvent): (ID, vector<address>, vector<u64>, u64, u64) {
    org::roster_updated_fields(event)
}

// === Creation-time roster validation ===
//
// `create_organization` used to accept any vector: a duplicate address would
// collapse into one table row while `member_count` still reported two, and
// `@0x0` could be stored as a member. `update_organization_roster` always
// rejected both, so creation and update disagreed about what a roster is.
// These tests pin the created boundary to the same rules.

#[test]
#[expected_failure(abort_code = org::EInvalidRoster, location = agent_vault::cryptographic_org)]
fun creation_rejects_a_duplicated_member() {
    let mut s = ts::begin(ALICE);
    let _ = org::create_organization_for_testing(
        GROUP_PK, 2, 2, vector[ALICE, ALICE], vector[1, 1], ts::ctx(&mut s),
    );
    ts::end(s);
}

#[test]
#[expected_failure(abort_code = org::EInvalidRoster, location = agent_vault::cryptographic_org)]
fun creation_rejects_the_zero_address() {
    let mut s = ts::begin(ALICE);
    let _ = org::create_organization_for_testing(
        GROUP_PK, 2, 1, vector[@0x0], vector[1], ts::ctx(&mut s),
    );
    ts::end(s);
}

#[test]
#[expected_failure(abort_code = org::EInvalidRoster, location = agent_vault::cryptographic_org)]
fun creation_rejects_a_length_mismatch() {
    let mut s = ts::begin(ALICE);
    let _ = org::create_organization_for_testing(
        GROUP_PK, 2, 1, vector[ALICE, BOB], vector[1], ts::ctx(&mut s),
    );
    ts::end(s);
}

#[test]
#[expected_failure(abort_code = org::EUnreachableThreshold, location = agent_vault::cryptographic_org)]
fun creation_rejects_a_zero_threshold() {
    // A zero snapshot threshold makes every proposal executable with no
    // approval at all, and simultaneously unrejectable (rejection closes once
    // approvals reach the threshold). Creation is the last place to refuse it.
    let mut s = ts::begin(ALICE);
    let _ = org::create_organization_for_testing(
        GROUP_PK, 2, 0, vector[ALICE, BOB], vector[2, 1], ts::ctx(&mut s),
    );
    ts::end(s);
}

#[test]
#[expected_failure(abort_code = org::EUnreachableThreshold, location = agent_vault::cryptographic_org)]
fun creation_rejects_a_threshold_above_the_roster_weight() {
    // An unreachable threshold would leave the organization permanently unable
    // to execute anything, including its own recovery.
    let mut s = ts::begin(ALICE);
    let _ = org::create_organization_for_testing(
        GROUP_PK, 2, 4, vector[ALICE, BOB], vector[2, 1], ts::ctx(&mut s),
    );
    ts::end(s);
}

#[test]
fun creation_accepts_a_threshold_equal_to_the_roster_weight() {
    let mut s = ts::begin(ALICE);
    let _ = org::create_organization_for_testing(
        GROUP_PK, 2, 3, vector[ALICE, BOB], vector[2, 1], ts::ctx(&mut s),
    );
    ts::end(s);
}

#[test]
fun creation_accepts_a_zero_weight_observer() {    // Zero weight is a deliberate observer role: the member is readable in the
    // roster and in `is_member`, but carries no voting power. Rejecting it here
    // would break `organization_treasury`, which tests exactly that boundary.
    let mut s = ts::begin(ALICE);
    let org_id = org::create_organization_for_testing(
        GROUP_PK, 2, 2, vector[ALICE, BOB, EVE], vector[2, 1, 0], ts::ctx(&mut s),
    );
    ts::next_tx(&mut s, ALICE);
    let organization = ts::take_shared<Organization>(&s);
    assert!(org::member_weight(&organization, EVE) == 0, 0);
    // `is_member` is defined as weight > 0, so a zero-weight entry is listed in
    // the roster but is NOT a member. That is the exact boundary
    // `organization_treasury` exercises; assert it rather than assume.
    assert!(!org::is_member(&organization, EVE), 1);
    assert!(org::threshold_weight(&organization) == 2, 2);
    let _ = org_id;
    ts::return_shared(organization);
    ts::end(s);
}
