#[test_only]
module agent_vault::asset_custody_tests;

use sui::{
    clock::{Self, Clock},
    event,
    object::{Self, ID},
    package,
    test_scenario::{Self as ts, Scenario},
    transfer,
};
use agent_vault::{
    asset_custody::{
        Self as custody, AssetCustody, AssetCustodyCreated, AssetDeposited, AssetReleased,
        AssetReturned, AssetTaken, CustodyProposal, CustodyProposalCreated, CustodyVoteRejected,
        CustodyVoteSubmitted,
    },
    cryptographic_org::{Self as org, Organization},
};

use fun fixture_end as CustodyFixture.end;
use fun fixture_next_tx as CustodyFixture.next_tx;
use fun fixture_ctx as CustodyFixture.ctx;

// === Constants ===

const ALICE: address = @0xA11CE;
const BOB: address = @0xB0B;
const CHARLIE: address = @0xCAFE;
const ZERO_WEIGHT: address = @0xDA71D;
const RELAYER: address = @0xEE7E;
const RECIPIENT: address = @0x9999;

const GROUP_PK: vector<u8> = x"8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c";
const UPGRADE_DIGEST: vector<u8> = x"1111111111111111111111111111111111111111111111111111111111111111";

// The epoch guard (proposal epoch must match the live organization epoch) is
// byte-identical to the asynchronous_proposal guard. Advancing an organization
// epoch requires a threshold-signed roster change with real signatures bound
// to deterministic ids (see cryptographic_org_roster_tests); the organization
// mismatch tests below cover the same binding structure, so the pure
// epoch-mismatch transition is exercised by the live story E2E instead.

// === Tests ===

// --- A. Custody creation ---

#[test]
fun member_creates_a_shared_custody_bound_to_the_organization() {
    let mut f = start_custody(ALICE);
    // Event and state assertions run in the emission transaction: the
    // scenario exposes only current-transaction events.
    f.next_tx!(ALICE, |f| {
        let self = ts::take_shared_by_id<AssetCustody>(&f.scenario, f.custody_id);
        assert!(custody::custody_org_id(&self) == f.org_id, 1);
        assert!(custody::type_count(&self) == 0, 2);
        ts::return_shared(self);
    });
    f.end();
}

#[test, expected_failure(abort_code = custody::ENotMember, location = agent_vault::asset_custody)]
fun outsider_cannot_create_custody() {
    let mut f = start_custody(RELAYER);
    f.end();
}

#[test, expected_failure(abort_code = custody::ENotMember, location = agent_vault::asset_custody)]
fun zero_weight_roster_entry_cannot_create_custody() {
    let mut f = start_custody(ZERO_WEIGHT);
    f.end();
}

#[test]
fun second_custody_for_the_same_organization_is_independent() {
    let mut f = start_custody(ALICE);
    f.next_tx!(BOB, |f| {
        create_second_custody(f);
        assert!(f.custody_id != f.other_custody, 1);
    });
    f.end();
}

// --- B. Deposit ---

#[test]
fun first_deposit_of_a_type_takes_slot_zero_and_records_the_row() {
    let mut f = start_custody(ALICE);
    f.next_tx!(ALICE, |f| {
        let organization = ts::take_shared_by_id<Organization>(&f.scenario, f.org_id);
        let mut self = ts::take_shared_by_id<AssetCustody>(&f.scenario, f.custody_id);
        let object_id = deposit_asset_inline(f, &organization, &mut self, 7);
        let (row_object, row_depositor, _) = custody::slot_record_for_testing<TestAsset>(&self, 0);
        assert!(row_object == object_id && row_depositor == ALICE, 1);
        assert!(custody::slot_child_exists_for_testing<TestAsset>(&self, 0), 2);
        assert!(custody::type_count(&self) == 1, 3);
        let events = event::events_by_type<AssetDeposited>();
        let (event_custody, event_slot, event_object) =
            custody::asset_deposited_fields(&events[events.length() - 1]);
        assert!(event_custody == f.custody_id && event_slot == 0 && event_object == object_id, 4);
        ts::return_shared(self);
        ts::return_shared(organization);
    });
    f.end();
}

#[test]
fun second_deposit_of_the_same_type_takes_the_next_slot() {
    let mut f = start_custody(ALICE);
    f.next_tx!(ALICE, |f| {
        let organization = ts::take_shared_by_id<Organization>(&f.scenario, f.org_id);
        let mut self = ts::take_shared_by_id<AssetCustody>(&f.scenario, f.custody_id);
        deposit_asset_inline(f, &organization, &mut self, 1);
        deposit_asset_inline(f, &organization, &mut self, 2);
        assert!(custody::slot_count_for_testing<TestAsset>(&self) == 2, 1);
        assert!(custody::next_slot_for_testing<TestAsset>(&self) == 2, 2);
        assert!(custody::slot_child_exists_for_testing<TestAsset>(&self, 1), 3);
        ts::return_shared(self);
        ts::return_shared(organization);
    });
    f.end();
}

#[test]
fun a_second_type_buckets_into_its_own_slot_family() {
    let mut f = start_custody(ALICE);
    f.next_tx!(ALICE, |f| {
        let organization = ts::take_shared_by_id<Organization>(&f.scenario, f.org_id);
        let mut self = ts::take_shared_by_id<AssetCustody>(&f.scenario, f.custody_id);
        deposit_asset_inline(f, &organization, &mut self, 1);
        deposit_cap_inline(f, &organization, &mut self);
        assert!(custody::type_count(&self) == 2, 1);
        assert!(custody::slot_count_for_testing<TestAsset>(&self) == 1, 2);
        assert!(custody::slot_count_for_testing<package::UpgradeCap>(&self) == 1, 3);
        assert!(custody::slot_child_exists_for_testing<package::UpgradeCap>(&self, 0), 4);
        ts::return_shared(self);
        ts::return_shared(organization);
    });
    f.end();
}

#[test, expected_failure(abort_code = custody::EWrongOrganization, location = agent_vault::asset_custody)]
fun foreign_organization_precedes_membership_on_deposit() {
    let mut f = start_custody(ALICE);
    f.next_tx!(RELAYER, |f| {
        let other = ts::take_shared_by_id<Organization>(&f.scenario, f.other_org);
        let mut self = ts::take_shared_by_id<AssetCustody>(&f.scenario, f.custody_id);
        let asset = TestAsset { id: object::new(f.ctx!()), value: 1 };
        custody::deposit<TestAsset>(&mut self, &other, asset, &f.clock, f.ctx!());
        ts::return_shared(self);
        ts::return_shared(other);
    });
    f.end();
}

#[test, expected_failure(abort_code = custody::ENotMember, location = agent_vault::asset_custody)]
fun outsider_cannot_deposit() {
    let mut f = start_custody(ALICE);
    f.next_tx!(RELAYER, |f| deposit_by_sender(f));
    f.end();
}

#[test, expected_failure(abort_code = custody::ENotMember, location = agent_vault::asset_custody)]
fun zero_weight_member_cannot_deposit() {
    let mut f = start_custody(ALICE);
    f.next_tx!(ZERO_WEIGHT, |f| deposit_by_sender(f));
    f.end();
}

#[test]
fun per_type_live_slot_capacity_is_supported_up_to_the_bound() {
    let mut f = start_custody(ALICE);
    f.next_tx!(ALICE, |f| {
        let organization = ts::take_shared_by_id<Organization>(&f.scenario, f.org_id);
        let mut self = ts::take_shared_by_id<AssetCustody>(&f.scenario, f.custody_id);
        let mut i = 0;
        while (i < 128) {
            deposit_asset_inline(f, &organization, &mut self, i);
            i = i + 1;
        };
        assert!(custody::slot_count_for_testing<TestAsset>(&self) == 128, 1);
        assert!(custody::next_slot_for_testing<TestAsset>(&self) == 128, 2);
        ts::return_shared(self);
        ts::return_shared(organization);
    });
    f.end();
}

#[test, expected_failure(abort_code = custody::ETooManySlots, location = agent_vault::asset_custody)]
fun first_deposit_over_the_per_type_slot_bound_is_rejected() {
    let mut f = start_custody(ALICE);
    f.next_tx!(ALICE, |f| {
        let organization = ts::take_shared_by_id<Organization>(&f.scenario, f.org_id);
        let mut self = ts::take_shared_by_id<AssetCustody>(&f.scenario, f.custody_id);
        let mut i = 0;
        while (i < 129) {
            deposit_asset_inline(f, &organization, &mut self, i);
            i = i + 1;
        };
        // Unreachable at runtime: the 129th deposit aborts. Statically required
        // so the taken shared objects are consumed on every path.
        ts::return_shared(self);
        ts::return_shared(organization);
    });
    f.end();
}

#[test]
fun distinct_type_capacity_is_supported_up_to_the_bound() {
    let mut f = start_custody(ALICE);
    f.next_tx!(ALICE, |f| {
        let organization = ts::take_shared_by_id<Organization>(&f.scenario, f.org_id);
        let mut self = ts::take_shared_by_id<AssetCustody>(&f.scenario, f.custody_id);
        deposit_all_fillers(f, &organization, &mut self);
        assert!(custody::type_count(&self) == 64, 1);
        ts::return_shared(self);
        ts::return_shared(organization);
    });
    f.end();
}

#[test, expected_failure(abort_code = custody::ETooManyTypes, location = agent_vault::asset_custody)]
fun first_deposit_over_the_distinct_type_bound_is_rejected() {
    let mut f = start_custody(ALICE);
    f.next_tx!(ALICE, |f| {
        let organization = ts::take_shared_by_id<Organization>(&f.scenario, f.org_id);
        let mut self = ts::take_shared_by_id<AssetCustody>(&f.scenario, f.custody_id);
        deposit_all_fillers(f, &organization, &mut self);
        deposit_asset_inline(f, &organization, &mut self, 1);
        // Unreachable at runtime: the 65th distinct type aborts.
        ts::return_shared(self);
        ts::return_shared(organization);
    });
    f.end();
}

// --- C. Proposal creation ---

#[test]
fun member_creates_a_borrow_proposal_snapshotting_governance() {
    let mut f = start_custody(ALICE);
    f.next_tx!(ALICE, |f| bootstrap_asset_borrow(f));
    f.next_tx!(ALICE, |f| {
        let p = ts::take_shared_by_id<CustodyProposal>(&f.scenario, f.proposal_id);
        assert!(custody::proposal_custody_id(&p) == f.custody_id, 1);
        assert!(custody::proposal_org_id(&p) == f.org_id, 2);
        assert!(custody::proposal_epoch(&p) == 1, 3);
        assert!(custody::proposal_kind(&p) == custody::kind_borrow_for_testing(), 4);
        assert!(custody::proposal_slot(&p) == 0, 5);
        assert!(custody::proposal_recipient(&p) == @0x0, 6);
        assert!(custody::proposal_threshold_weight(&p) == 3, 7);
        assert!(custody::proposal_status(&p) == custody::status_pending_for_testing(), 8);
        assert!(!custody::has_voted(&p, ALICE), 9);
        ts::return_shared(p);
    });
    f.end();
}

#[test]
fun member_creates_a_release_proposal_with_a_frozen_recipient() {
    let mut f = start_custody(ALICE);
    f.next_tx!(ALICE, |f| bootstrap_asset_release(f, RECIPIENT));
    f.next_tx!(ALICE, |f| {
        let p = ts::take_shared_by_id<CustodyProposal>(&f.scenario, f.proposal_id);
        assert!(custody::proposal_kind(&p) == custody::kind_release_for_testing(), 1);
        assert!(custody::proposal_recipient(&p) == RECIPIENT, 2);
        ts::return_shared(p);
    });
    f.end();
}

#[test, expected_failure(abort_code = custody::EInvalidRecipient, location = agent_vault::asset_custody)]
fun borrow_proposal_with_a_recipient_is_rejected() {
    let mut f = start_custody(ALICE);
    f.next_tx!(ALICE, |f| {
        create_proposal_on_deposited_asset(
            f, custody::kind_borrow_for_testing(), b"title", 0, RECIPIENT, 100,
        );
    });
    f.end();
}

#[test, expected_failure(abort_code = custody::EInvalidRecipient, location = agent_vault::asset_custody)]
fun release_proposal_without_a_recipient_is_rejected() {
    let mut f = start_custody(ALICE);
    f.next_tx!(ALICE, |f| {
        create_proposal_on_deposited_asset(
            f, custody::kind_release_for_testing(), b"title", 0, @0x0, 100,
        );
    });
    f.end();
}

#[test, expected_failure(abort_code = custody::EWrongProposalKind, location = agent_vault::asset_custody)]
fun unknown_proposal_kind_is_rejected() {
    let mut f = start_custody(ALICE);
    f.next_tx!(ALICE, |f| {
        create_proposal_on_deposited_asset(f, 3, b"title", 0, @0x0, 100);
    });
    f.end();
}

#[test, expected_failure(abort_code = custody::EInvalidTitle, location = agent_vault::asset_custody)]
fun empty_title_precedes_invalid_deadline() {
    let mut f = start_custody(ALICE);
    f.next_tx!(ALICE, |f| {
        create_proposal_on_deposited_asset(
            f, custody::kind_borrow_for_testing(), b"", 0, @0x0, 0,
        );
    });
    f.end();
}

#[test, expected_failure(abort_code = custody::EInvalidTitle, location = agent_vault::asset_custody)]
fun first_title_byte_over_bound_is_rejected() {
    let mut f = start_custody(ALICE);
    f.next_tx!(ALICE, |f| {
        create_proposal_on_deposited_asset(
            f, custody::kind_borrow_for_testing(), vector::tabulate!(257, |_| 1u8), 0, @0x0, 100,
        );
    });
    f.end();
}

#[test, expected_failure(abort_code = custody::EInvalidDeadline, location = agent_vault::asset_custody)]
fun creation_at_a_past_deadline_is_rejected() {
    let mut f = start_custody(ALICE);
    f.clock.set_for_testing(101);
    f.next_tx!(ALICE, |f| {
        create_proposal_on_deposited_asset(
            f, custody::kind_borrow_for_testing(), b"title", 0, @0x0, 100,
        );
    });
    f.end();
}

#[test, expected_failure(abort_code = custody::EInvalidDeadline, location = agent_vault::asset_custody)]
fun first_millisecond_over_maximum_duration_is_rejected() {
    let mut f = start_custody(ALICE);
    f.next_tx!(ALICE, |f| {
        create_proposal_on_deposited_asset(
            f, custody::kind_borrow_for_testing(), b"title", 0, @0x0, 31_536_000_001,
        );
    });
    f.end();
}

#[test, expected_failure(abort_code = custody::EUnknownSlot, location = agent_vault::asset_custody)]
fun proposal_on_an_unknown_slot_is_rejected() {
    let mut f = start_custody(ALICE);
    f.next_tx!(ALICE, |f| {
        create_proposal_on_deposited_asset(
            f, custody::kind_borrow_for_testing(), b"title", 9, @0x0, 100,
        );
    });
    f.end();
}

#[test, expected_failure(abort_code = custody::ENotMember, location = agent_vault::asset_custody)]
fun outsider_cannot_create_a_proposal() {
    let mut f = start_custody(ALICE);
    f.next_tx!(ALICE, |f| deposit_by_sender(f));
    f.next_tx!(RELAYER, |f| {
        create_proposal_on_deposited_asset(
            f, custody::kind_borrow_for_testing(), b"title", 0, @0x0, 100,
        );
    });
    f.end();
}

#[test, expected_failure(abort_code = custody::EWrongOrganization, location = agent_vault::asset_custody)]
fun proposal_creation_on_a_foreign_organization_is_rejected() {
    let mut f = start_custody(ALICE);
    f.next_tx!(ALICE, |f| {
        let other = ts::take_shared_by_id<Organization>(&f.scenario, f.other_org);
        let mut self = ts::take_shared_by_id<AssetCustody>(&f.scenario, f.custody_id);
        let asset = TestAsset { id: object::new(f.ctx!()), value: 1 };
        custody::deposit<TestAsset>(&mut self, &other, asset, &f.clock, f.ctx!());
        custody::create_proposal<TestAsset>(
            &self, &other, custody::kind_borrow_for_testing(), b"title", 0, @0x0, 100, UPGRADE_DIGEST, &f.clock,
            f.ctx!(),
        );
        ts::return_shared(self);
        ts::return_shared(other);
    });
    f.end();
}

// --- D. Voting ---

#[test]
fun approval_accumulates_live_roster_weight_and_events() {
    let mut f = start_custody(ALICE);
    f.next_tx!(ALICE, |f| bootstrap_asset_borrow(f));
    f.next_tx!(ALICE, |f| approve_current(f));
    f.next_tx!(BOB, |f| approve_current(f));
    f.next_tx!(ALICE, |f| {
        let p = ts::take_shared_by_id<CustodyProposal>(&f.scenario, f.proposal_id);
        assert!(custody::proposal_accumulated_weight(&p) == 3, 1);
        assert!(custody::proposal_rejected_weight(&p) == 0, 2);
        assert!(custody::has_voted(&p, ALICE) && custody::has_voted(&p, BOB), 3);
        ts::return_shared(p);
    });
    f.end();
}

#[test]
fun rejection_is_terminal_at_the_snapshotted_threshold() {
    let mut f = start_custody(ALICE);
    f.next_tx!(ALICE, |f| bootstrap_asset_borrow(f));
    f.next_tx!(ALICE, |f| reject_current(f));
    f.next_tx!(BOB, |f| reject_current(f));
    f.next_tx!(ALICE, |f| {
        let p = ts::take_shared_by_id<CustodyProposal>(&f.scenario, f.proposal_id);
        assert!(custody::proposal_status(&p) == custody::status_rejected_for_testing(), 1);
        assert!(custody::proposal_rejected_weight(&p) == 3, 2);
        assert!(custody::proposal_accumulated_weight(&p) == 0, 3);
        ts::return_shared(p);
    });
    f.end();
}

#[test, expected_failure(abort_code = custody::EAlreadyVoted, location = agent_vault::asset_custody)]
fun second_approval_by_the_same_member_is_rejected() {
    let mut f = start_custody(ALICE);
    f.next_tx!(ALICE, |f| bootstrap_asset_borrow(f));
    f.next_tx!(ALICE, |f| approve_current(f));
    f.next_tx!(ALICE, |f| approve_current(f));
    f.end();
}

#[test, expected_failure(abort_code = custody::EAlreadyVoted, location = agent_vault::asset_custody)]
fun rejection_after_approval_reserves_the_shared_dedup_slot() {
    let mut f = start_custody(ALICE);
    f.next_tx!(ALICE, |f| bootstrap_asset_borrow(f));
    f.next_tx!(ALICE, |f| approve_current(f));
    f.next_tx!(ALICE, |f| reject_current(f));
    f.end();
}

#[test, expected_failure(abort_code = custody::EAlreadyVoted, location = agent_vault::asset_custody)]
fun approval_after_rejection_reserves_the_shared_dedup_slot() {
    let mut f = start_custody(ALICE);
    f.next_tx!(ALICE, |f| bootstrap_asset_borrow(f));
    f.next_tx!(ALICE, |f| reject_current(f));
    f.next_tx!(ALICE, |f| approve_current(f));
    f.end();
}

#[test, expected_failure(abort_code = custody::EApprovalThresholdMet, location = agent_vault::asset_custody)]
fun rejection_closes_once_approvals_reach_the_threshold() {
    let mut f = start_custody(ALICE);
    f.next_tx!(ALICE, |f| bootstrap_asset_borrow(f));
    f.next_tx!(ALICE, |f| approve_current(f));
    f.next_tx!(BOB, |f| approve_current(f));
    // CHARLIE is still an eligible non-voter, but ALICE+BOB already reached
    // the threshold, so a late rejection is refused outright.
    f.next_tx!(CHARLIE, |f| reject_current(f));
    f.end();
}

#[test, expected_failure(abort_code = custody::ENotMember, location = agent_vault::asset_custody)]
fun zero_weight_member_cannot_vote() {
    let mut f = start_custody(ALICE);
    f.next_tx!(ALICE, |f| bootstrap_asset_borrow(f));
    f.next_tx!(ZERO_WEIGHT, |f| approve_claiming_weight(f, 0));
    f.end();
}

#[test, expected_failure(abort_code = custody::ENotMember, location = agent_vault::asset_custody)]
fun outsider_cannot_vote() {
    let mut f = start_custody(ALICE);
    f.next_tx!(ALICE, |f| bootstrap_asset_borrow(f));
    f.next_tx!(RELAYER, |f| approve_claiming_weight(f, 1));
    f.end();
}

#[test, expected_failure(abort_code = custody::EWeightMismatch, location = agent_vault::asset_custody)]
fun vote_with_a_claimed_weight_above_the_roster_is_rejected() {
    let mut f = start_custody(ALICE);
    f.next_tx!(ALICE, |f| bootstrap_asset_borrow(f));
    f.next_tx!(ALICE, |f| approve_claiming_weight(f, 99));
    f.end();
}

#[test, expected_failure(abort_code = custody::EProposalExpired, location = agent_vault::asset_custody)]
fun vote_after_the_inclusive_deadline_is_rejected() {
    let mut f = start_custody(ALICE);
    f.next_tx!(ALICE, |f| bootstrap_asset_borrow(f));
    f.clock.set_for_testing(101);
    f.next_tx!(ALICE, |f| approve_current(f));
    f.end();
}

#[test]
fun vote_at_the_exact_deadline_is_still_inclusive() {
    let mut f = start_custody(ALICE);
    f.next_tx!(ALICE, |f| bootstrap_asset_borrow(f));
    f.clock.set_for_testing(100);
    f.next_tx!(ALICE, |f| approve_current(f));
    f.next_tx!(ALICE, |f| {
        let p = ts::take_shared_by_id<CustodyProposal>(&f.scenario, f.proposal_id);
        assert!(custody::proposal_accumulated_weight(&p) == 2, 1);
        ts::return_shared(p);
    });
    f.end();
}

#[test, expected_failure(abort_code = custody::EWrongOrganization, location = agent_vault::asset_custody)]
fun vote_against_a_foreign_organization_is_rejected() {
    let mut f = start_custody(ALICE);
    f.next_tx!(ALICE, |f| bootstrap_asset_borrow(f));
    f.next_tx!(ALICE, |f| {
        let other = ts::take_shared_by_id<Organization>(&f.scenario, f.other_org);
        let mut p = ts::take_shared_by_id<CustodyProposal>(&f.scenario, f.proposal_id);
        let weight = org::member_weight(&other, ALICE);
        custody::submit_vote(&mut p, &other, &f.clock, weight, f.ctx!());
        ts::return_shared(p);
        ts::return_shared(other);
    });
    f.end();
}

#[test, expected_failure(abort_code = custody::EProposalNotPending, location = agent_vault::asset_custody)]
fun vote_on_a_terminal_proposal_is_rejected() {
    let mut f = start_custody(ALICE);
    f.next_tx!(ALICE, |f| bootstrap_asset_borrow(f));
    f.next_tx!(ALICE, |f| reject_current(f));
    f.next_tx!(BOB, |f| reject_current(f));
    f.next_tx!(BOB, |f| approve_current(f));
    f.end();
}

// --- E. Borrow cycle ---

#[test]
fun approved_borrow_round_trips_a_test_asset_in_one_transaction() {
    let mut f = start_custody(ALICE);
    f.next_tx!(ALICE, |f| bootstrap_asset_borrow(f));
    f.next_tx!(ALICE, |f| approve_current(f));
    f.next_tx!(BOB, |f| approve_current(f));
    f.next_tx!(ALICE, |f| borrow_and_return_asset(f));
    f.next_tx!(RELAYER, |f| {
        let p = ts::take_shared_by_id<CustodyProposal>(&f.scenario, f.proposal_id);
        assert!(custody::proposal_status(&p) == custody::status_executed_for_testing(), 1);
        ts::return_shared(p);
        let self = ts::take_shared_by_id<AssetCustody>(&f.scenario, f.custody_id);
        assert!(custody::slot_count_for_testing<TestAsset>(&self) == 1, 2);
        assert!(custody::slot_child_exists_for_testing<TestAsset>(&self, 0), 3);
        ts::return_shared(self);
    });
    f.end();
}

#[test]
fun approved_borrow_upgrades_a_custodied_package_and_returns_the_cap() {
    let mut f = start_custody(ALICE);
    f.next_tx!(ALICE, |f| bootstrap_cap_borrow(f));
    f.next_tx!(ALICE, |f| approve_current(f));
    f.next_tx!(BOB, |f| approve_current(f));
    f.next_tx!(ALICE, |f| {
        let organization = ts::take_shared_by_id<Organization>(&f.scenario, f.org_id);
        let mut self = ts::take_shared_by_id<AssetCustody>(&f.scenario, f.custody_id);
        let mut p = ts::take_shared_by_id<CustodyProposal>(&f.scenario, f.proposal_id);
        let (mut cap, receipt) =
            custody::take_asset<package::UpgradeCap>(&mut self, &mut p, &organization, &f.clock, f.ctx!());
        let taken = event::events_by_type<AssetTaken>();
        assert!(taken.length() == 1, 4);
        let policy = package::upgrade_policy(&cap);
        let ticket = package::authorize_upgrade(&mut cap, policy, UPGRADE_DIGEST);
        let upgrade_receipt = package::test_upgrade(ticket);
        package::commit_upgrade(&mut cap, upgrade_receipt);
        assert!(package::version(&cap) == 2, 1);
        custody::return_asset<package::UpgradeCap>(&mut self, cap, receipt);
        let returned = event::events_by_type<AssetReturned>();
        assert!(returned.length() == 1, 5);
        assert!(custody::slot_child_exists_for_testing<package::UpgradeCap>(&self, 0), 2);
        assert!(custody::slot_count_for_testing<package::UpgradeCap>(&self) == 1, 3);
        ts::return_shared(p);
        ts::return_shared(self);
        ts::return_shared(organization);
    });
    f.end();
}

/// A borrow hands the asset out as an uncontrolled transaction value, so the
/// approval is bound to whoever created the proposal. A relayer that executes a
/// first approved borrow must not become the one holding the upgrade authority.
#[test, expected_failure(abort_code = custody::EBorrowerMismatch, location = agent_vault::asset_custody)]
fun a_non_proposer_cannot_take_the_approved_borrow() {
    let mut f = start_custody(ALICE);
    f.next_tx!(ALICE, |f| bootstrap_asset_borrow(f));
    f.next_tx!(ALICE, |f| approve_current(f));
    f.next_tx!(BOB, |f| approve_current(f));
    f.next_tx!(RELAYER, |f| borrow_and_return_asset(f));
    f.end();
}

#[test, expected_failure(abort_code = custody::EProposalNotPending, location = agent_vault::asset_custody)]
fun an_executed_borrow_cannot_be_taken_twice() {
    let mut f = start_custody(ALICE);
    f.next_tx!(ALICE, |f| bootstrap_asset_borrow(f));
    f.next_tx!(ALICE, |f| approve_current(f));
    f.next_tx!(BOB, |f| approve_current(f));
    f.next_tx!(ALICE, |f| borrow_and_return_asset(f));
    f.next_tx!(ALICE, |f| borrow_and_return_asset(f));
    f.end();
}

#[test, expected_failure(abort_code = custody::EProposalNotPending, location = agent_vault::asset_custody)]
fun a_rejected_proposal_cannot_borrow() {
    let mut f = start_custody(ALICE);
    f.next_tx!(ALICE, |f| bootstrap_asset_borrow(f));
    f.next_tx!(ALICE, |f| reject_current(f));
    f.next_tx!(BOB, |f| reject_current(f));
    f.next_tx!(ALICE, |f| borrow_and_return_asset(f));
    f.end();
}

// --- F. Borrow guards ---

#[test, expected_failure(abort_code = custody::EThresholdNotMet, location = agent_vault::asset_custody)]
fun take_below_the_approval_threshold_is_rejected() {
    let mut f = start_custody(ALICE);
    f.next_tx!(ALICE, |f| bootstrap_asset_borrow(f));
    f.next_tx!(ALICE, |f| approve_current(f));
    f.next_tx!(ALICE, |f| borrow_and_return_asset(f));
    f.end();
}

#[test, expected_failure(abort_code = custody::EWrongProposalKind, location = agent_vault::asset_custody)]
fun take_on_a_release_proposal_is_rejected() {
    let mut f = start_custody(ALICE);
    f.next_tx!(ALICE, |f| bootstrap_asset_release(f, RECIPIENT));
    f.next_tx!(ALICE, |f| approve_current(f));
    f.next_tx!(BOB, |f| {
        approve_current(f);
    });
    f.next_tx!(ALICE, |f| borrow_and_return_asset(f));
    f.end();
}

#[test, expected_failure(abort_code = custody::EProposalExpired, location = agent_vault::asset_custody)]
fun take_after_the_inclusive_deadline_is_rejected() {
    let mut f = start_custody(ALICE);
    f.next_tx!(ALICE, |f| bootstrap_asset_borrow(f));
    f.next_tx!(ALICE, |f| approve_current(f));
    f.next_tx!(BOB, |f| approve_current(f));
    f.clock.set_for_testing(101);
    f.next_tx!(ALICE, |f| borrow_and_return_asset(f));
    f.end();
}

/// #12 mitigation: a borrow approval is windowed to creation + 5 minutes, so a
/// long-lived proposal (deadline 400_000ms) cannot stay armed beyond 300_000ms
/// even while the ordinary proposal deadline is still in the future.
#[test, expected_failure(abort_code = custody::EBorrowWindowExpired, location = agent_vault::asset_custody)]
fun take_after_the_borrow_window_is_rejected() {
    let mut f = start_custody(ALICE);
    f.next_tx!(ALICE, |f| borrow_with_long_deadline(f));
    f.next_tx!(ALICE, |f| approve_current(f));
    f.next_tx!(BOB, |f| approve_current(f));
    // Past the 5-minute borrow window but still inside the proposal deadline.
    f.clock.set_for_testing(300_001);
    f.next_tx!(ALICE, |f| borrow_and_return_asset(f));
    f.end();
}

/// #12 mitigation: the take succeeds at the inclusive edge of the borrow
/// window, and the window is recorded as creation + 5 minutes (not the full
/// deadline) for borrow proposals.
#[test]
fun borrow_within_the_window_succeeds_and_records_the_window() {
    let mut f = start_custody(ALICE);
    f.next_tx!(ALICE, |f| borrow_with_long_deadline(f));
    f.next_tx!(ALICE, |f| approve_current(f));
    f.next_tx!(BOB, |f| approve_current(f));
    f.clock.set_for_testing(300_000);
    f.next_tx!(ALICE, |f| borrow_and_return_asset(f));
    f.next_tx!(RELAYER, |f| {
        let p = ts::take_shared_by_id<CustodyProposal>(&f.scenario, f.proposal_id);
        assert!(custody::proposal_borrow_deadline_ms(&p) == 300_000, 6);
        assert!(custody::proposal_status(&p) == custody::status_executed_for_testing(), 7);
        ts::return_shared(p);
    });
    f.end();
}

#[test, expected_failure(abort_code = custody::EWrongCustody, location = agent_vault::asset_custody)]
fun take_through_a_foreign_custody_is_rejected() {
    let mut f = start_custody(ALICE);
    f.next_tx!(BOB, |f| bootstrap_borrow_on_second_custody(f));
    f.next_tx!(ALICE, |f| approve_current(f));
    f.next_tx!(BOB, |f| approve_current(f));
    f.next_tx!(BOB, |f| {
        // The proposal is bound to the second custody; the first is a valid
        // same-organization treasury but not the bound one.
        let organization = ts::take_shared_by_id<Organization>(&f.scenario, f.org_id);
        let mut foreign = ts::take_shared_by_id<AssetCustody>(&f.scenario, f.other_custody);
        let mut p = ts::take_shared_by_id<CustodyProposal>(&f.scenario, f.proposal_id);
        let (asset, receipt) =
            custody::take_asset<TestAsset>(&mut foreign, &mut p, &organization, &f.clock, f.ctx!());
        custody::return_asset<TestAsset>(&mut foreign, asset, receipt);
        ts::return_shared(p);
        ts::return_shared(foreign);
        ts::return_shared(organization);
    });
    f.end();
}

#[test, expected_failure(abort_code = 2, location = sui::dynamic_field)]
fun take_with_a_wrong_type_argument_fails_in_the_dynamic_field() {
    let mut f = start_custody(ALICE);
    f.next_tx!(ALICE, |f| bootstrap_cap_borrow(f));
    f.next_tx!(ALICE, |f| approve_current(f));
    f.next_tx!(BOB, |f| approve_current(f));
    f.next_tx!(ALICE, |f| {
        let organization = ts::take_shared_by_id<Organization>(&f.scenario, f.org_id);
        let mut self = ts::take_shared_by_id<AssetCustody>(&f.scenario, f.custody_id);
        let mut p = ts::take_shared_by_id<CustodyProposal>(&f.scenario, f.proposal_id);
        let (asset, receipt) =
            custody::take_asset<TestAsset>(&mut self, &mut p, &organization, &f.clock, f.ctx!());
        custody::return_asset<TestAsset>(&mut self, asset, receipt);
        ts::return_shared(p);
        ts::return_shared(self);
        ts::return_shared(organization);
    });
    f.end();
}

#[test, expected_failure(abort_code = custody::EWrongCustody, location = agent_vault::asset_custody)]
fun return_into_a_foreign_custody_is_rejected() {
    let mut f = start_custody(ALICE);
    f.next_tx!(BOB, |f| bootstrap_borrow_on_second_custody(f));
    f.next_tx!(ALICE, |f| approve_current(f));
    f.next_tx!(BOB, |f| approve_current(f));
    f.next_tx!(BOB, |f| {
        let organization = ts::take_shared_by_id<Organization>(&f.scenario, f.org_id);
        let mut lender = ts::take_shared_by_id<AssetCustody>(&f.scenario, f.custody_id);
        let mut foreign = ts::take_shared_by_id<AssetCustody>(&f.scenario, f.other_custody);
        let mut p = ts::take_shared_by_id<CustodyProposal>(&f.scenario, f.proposal_id);
        let (asset, receipt) =
            custody::take_asset<TestAsset>(&mut lender, &mut p, &organization, &f.clock, f.ctx!());
        // The asset must re-enter the custody recorded by the receipt, not any
        // other treasury of the same organization.
        custody::return_asset<TestAsset>(&mut foreign, asset, receipt);
        ts::return_shared(p);
        ts::return_shared(foreign);
        ts::return_shared(lender);
        ts::return_shared(organization);
    });
    f.end();
}

/// A borrow is not an asset swap: the receipt pins the exact object that left,
/// so a freshly minted substitute of the same type and slot cannot satisfy it.
/// Without this, an approved "one transaction" borrow would drain the custody.
#[test, expected_failure(abort_code = custody::EWrongAsset, location = agent_vault::asset_custody)]
fun returning_a_substitute_object_of_the_same_type_is_rejected() {
    let mut f = start_custody(ALICE);
    f.next_tx!(ALICE, |f| bootstrap_asset_borrow(f));
    f.next_tx!(ALICE, |f| approve_current(f));
    f.next_tx!(BOB, |f| approve_current(f));
    f.next_tx!(ALICE, |f| {
        let organization = ts::take_shared_by_id<Organization>(&f.scenario, f.org_id);
        let mut self = ts::take_shared_by_id<AssetCustody>(&f.scenario, f.custody_id);
        let mut p = ts::take_shared_by_id<CustodyProposal>(&f.scenario, f.proposal_id);
        let (borrowed, receipt) =
            custody::take_asset<TestAsset>(&mut self, &mut p, &organization, &f.clock, f.ctx!());
        // Same type, same slot, wrong object: the real asset is worth something,
        // the substitute costs nothing to mint. The receipt must refuse it.
        let substitute = TestAsset { id: object::new(f.ctx!()), value: 0 };
        custody::return_asset<TestAsset>(&mut self, substitute, receipt);
        transfer::public_transfer(borrowed, ALICE);
        ts::return_shared(p);
        ts::return_shared(self);
        ts::return_shared(organization);
    });
    f.end();
}

// --- G. Release ---

#[test]
fun approved_release_pays_the_frozen_recipient_and_frees_the_type_entry() {
    let mut f = start_custody(ALICE);
    f.next_tx!(ALICE, |f| bootstrap_asset_release(f, RECIPIENT));
    f.next_tx!(ALICE, |f| approve_current(f));
    f.next_tx!(BOB, |f| approve_current(f));
    f.next_tx!(ALICE, |f| {
        execute_release_current(f);
        let events = event::events_by_type<AssetReleased>();
        let (event_proposal, _, event_slot, _, event_recipient) =
            custody::asset_released_fields(&events[events.length() - 1]);
        assert!(event_proposal == f.proposal_id && event_slot == 0 && event_recipient == RECIPIENT, 5);
    });
    f.next_tx!(RELAYER, |f| {
        // The scenario's address index reflects the next transaction's state,
        // so recipient ownership is asserted after the transfer settles.
        assert!(ts::ids_for_address<TestAsset>(RECIPIENT).length() == 1, 1);
        assert!(ts::ids_for_address<TestAsset>(RELAYER).is_empty(), 2);
        let self = ts::take_shared_by_id<AssetCustody>(&f.scenario, f.custody_id);
        assert!(custody::type_count(&self) == 0, 3);
        ts::return_shared(self);
        let p = ts::take_shared_by_id<CustodyProposal>(&f.scenario, f.proposal_id);
        assert!(custody::proposal_status(&p) == custody::status_executed_for_testing(), 4);
        ts::return_shared(p);
    });
    f.end();
}

#[test]
fun release_keeps_the_type_entry_while_other_slots_stay_live() {    let mut f = start_custody(ALICE);
    f.next_tx!(ALICE, |f| {
        let organization = ts::take_shared_by_id<Organization>(&f.scenario, f.org_id);
        let mut self = ts::take_shared_by_id<AssetCustody>(&f.scenario, f.custody_id);
        deposit_asset_inline(f, &organization, &mut self, 1);
        deposit_asset_inline(f, &organization, &mut self, 2);
        f.proposal_id = custody::create_proposal<TestAsset>(
            &self, &organization, custody::kind_release_for_testing(), b"Release", 0, RECIPIENT,
            100, b"", &f.clock, f.ctx!(),
        );
        ts::return_shared(self);
        ts::return_shared(organization);
    });
    f.next_tx!(ALICE, |f| approve_current(f));
    f.next_tx!(BOB, |f| approve_current(f));
    f.next_tx!(RELAYER, |f| execute_release_current(f));
    f.next_tx!(RELAYER, |f| {
        let self = ts::take_shared_by_id<AssetCustody>(&f.scenario, f.custody_id);
        assert!(custody::type_count(&self) == 1, 1);
        assert!(custody::slot_count_for_testing<TestAsset>(&self) == 1, 2);
        assert!(custody::next_slot_for_testing<TestAsset>(&self) == 2, 3);
        assert!(custody::slot_child_exists_for_testing<TestAsset>(&self, 1), 4);
        ts::return_shared(self);
    });
    f.end();
}

#[test]
fun a_re_emptied_type_restarts_slot_numbering_from_zero() {
    let mut f = start_custody(ALICE);
    f.next_tx!(ALICE, |f| bootstrap_asset_release(f, RECIPIENT));
    f.next_tx!(ALICE, |f| approve_current(f));
    f.next_tx!(BOB, |f| approve_current(f));
    f.next_tx!(RELAYER, |f| execute_release_current(f));
    f.next_tx!(ALICE, |f| deposit_by_sender(f));
    f.next_tx!(ALICE, |f| {
        // The type family is empty, so the entry was deleted; a new deposit
        // starts a fresh family at slot zero with no key collision.
        let self = ts::take_shared_by_id<AssetCustody>(&f.scenario, f.custody_id);
        assert!(custody::type_count(&self) == 1, 1);
        assert!(custody::slot_count_for_testing<TestAsset>(&self) == 1, 2);
        assert!(custody::next_slot_for_testing<TestAsset>(&self) == 1, 3);
        assert!(custody::slot_child_exists_for_testing<TestAsset>(&self, 0), 4);
        ts::return_shared(self);
    });
    f.end();
}

/// The emptied type entry resets `next_slot`, so a later deposit reuses slot
/// zero. An approval that survived that cycle is bound to the object it was
/// created for, not to the slot number: otherwise a reprised slot would let a
/// stale approval hand a brand-new deposit to its old recipient.
#[test, expected_failure(abort_code = custody::ESlotReassigned, location = agent_vault::asset_custody)]
fun a_reused_slot_number_cannot_rearm_an_old_approval() {
    let mut f = start_custody(ALICE);
    // Slot 0 holds one asset with two approved proposals: a release that will
    // drain it and a borrow that stays pending until after the slot is reused.
    f.next_tx!(ALICE, |f| {
        let organization = ts::take_shared_by_id<Organization>(&f.scenario, f.org_id);
        let mut self = ts::take_shared_by_id<AssetCustody>(&f.scenario, f.custody_id);
        deposit_asset_inline(f, &organization, &mut self, 1);
        f.release_proposal_id = custody::create_proposal<TestAsset>(
            &self, &organization, custody::kind_release_for_testing(), b"Drain slot zero", 0,
            RECIPIENT, 100, b"", &f.clock, f.ctx!(),
        );
        f.proposal_id = custody::create_proposal<TestAsset>(
            &self, &organization, custody::kind_borrow_for_testing(), b"Stale borrow", 0,
            @0x0, 100, UPGRADE_DIGEST, &f.clock, f.ctx!(),
        );
        ts::return_shared(self);
        ts::return_shared(organization);
    });
    f.next_tx!(ALICE, |f| approve_two(f));
    f.next_tx!(BOB, |f| approve_two(f));
    // The release drains slot 0 and deletes the type entry with it.
    let drain = f.release_proposal_id;
    f.next_tx!(ALICE, |f| {
        let proposal_id = drain;
        execute_release_on(f, proposal_id);
    });
    // A fresh deposit of the same type lands on the recycled slot 0.
    f.next_tx!(ALICE, |f| deposit_by_sender(f));
    // The stale approval is still pending and approved; executing it must not
    // reach the new asset that now answers to the same slot number.
    f.next_tx!(ALICE, |f| borrow_and_return_asset(f));
    f.end();
}

#[test, expected_failure(abort_code = custody::EThresholdNotMet, location = agent_vault::asset_custody)]
fun release_below_the_approval_threshold_is_rejected() {    let mut f = start_custody(ALICE);
    f.next_tx!(ALICE, |f| bootstrap_asset_release(f, RECIPIENT));
    f.next_tx!(ALICE, |f| approve_current(f));
    f.next_tx!(RELAYER, |f| execute_release_current(f));
    f.end();
}

#[test, expected_failure(abort_code = custody::EWrongProposalKind, location = agent_vault::asset_custody)]
fun release_on_a_borrow_proposal_is_rejected() {
    let mut f = start_custody(ALICE);
    f.next_tx!(ALICE, |f| bootstrap_asset_borrow(f));
    f.next_tx!(ALICE, |f| approve_current(f));
    f.next_tx!(BOB, |f| approve_current(f));
    f.next_tx!(RELAYER, |f| execute_release_current(f));
    f.end();
}

#[test, expected_failure(abort_code = custody::ESlotNotCustodied, location = agent_vault::asset_custody)]
fun a_second_approved_release_on_a_spent_slot_dies_pending() {
    let mut f = start_custody(ALICE);
    f.next_tx!(ALICE, |f| {
        let organization = ts::take_shared_by_id<Organization>(&f.scenario, f.org_id);
        let mut self = ts::take_shared_by_id<AssetCustody>(&f.scenario, f.custody_id);
        let asset = TestAsset { id: object::new(f.ctx!()), value: 1 };
        custody::deposit<TestAsset>(&mut self, &organization, asset, &f.clock, f.ctx!());
        f.release_proposal_id = custody::create_proposal<TestAsset>(
            &self, &organization, custody::kind_release_for_testing(), b"First", 0, RECIPIENT,
            100, b"", &f.clock, f.ctx!(),
        );
        f.proposal_id = custody::create_proposal<TestAsset>(
            &self, &organization, custody::kind_release_for_testing(), b"Second", 0, BOB,
            100, b"", &f.clock, f.ctx!(),
        );
        ts::return_shared(self);
        ts::return_shared(organization);
    });
    f.next_tx!(ALICE, |f| approve_two(f));
    f.next_tx!(BOB, |f| approve_two(f));
    // The first release spends the only live slot of the type.
    let first_release = f.release_proposal_id;
    f.next_tx!(RELAYER, |f| {
        let proposal_id = first_release;
        execute_release_on(f, proposal_id);
    });
    // The second is fully approved but the slot is gone; it stays dead-pending.
    f.next_tx!(RELAYER, |f| execute_release_current(f));
    f.end();
}

// --- H. Conservation across a full lifecycle ---

#[test]
fun inventory_rows_and_live_children_stay_paired_through_the_lifecycle() {
    let mut f = start_custody(ALICE);
    f.next_tx!(ALICE, |f| {
        let organization = ts::take_shared_by_id<Organization>(&f.scenario, f.org_id);
        let mut self = ts::take_shared_by_id<AssetCustody>(&f.scenario, f.custody_id);
        deposit_asset_inline(f, &organization, &mut self, 1);
        deposit_cap_inline(f, &organization, &mut self);
        assert_conservation(&self, 1, 1);
        ts::return_shared(self);
        ts::return_shared(organization);
    });
    f.next_tx!(ALICE, |f| bootstrap_cap_borrow_on_deposited(f));
    f.next_tx!(ALICE, |f| approve_current(f));
    f.next_tx!(BOB, |f| approve_current(f));
    f.next_tx!(ALICE, |f| {
        // Borrow and return: the row was kept for the atomic window and the
        // child re-enters the exact key.
        borrow_and_return_cap(f);
    });
    f.next_tx!(RELAYER, |f| {
        let self = ts::take_shared_by_id<AssetCustody>(&f.scenario, f.custody_id);
        assert_conservation(&self, 1, 1);
        ts::return_shared(self);
    });
    f.next_tx!(ALICE, |f| {
        create_release_on_deposited_asset(
            f, custody::kind_release_for_testing(), b"Release", 0, RECIPIENT, 100,
        );
    });
    f.next_tx!(ALICE, |f| approve_current(f));
    f.next_tx!(BOB, |f| approve_current(f));
    f.next_tx!(RELAYER, |f| {
        execute_release_current(f);
    });
    f.next_tx!(RELAYER, |f| {
        assert!(ts::ids_for_address<TestAsset>(RECIPIENT).length() == 1, 2);
        let self = ts::take_shared_by_id<AssetCustody>(&f.scenario, f.custody_id);
        assert_conservation(&self, 0, 1);
        ts::return_shared(self);
    });
    f.end();
}

// === Test-Only Types ===

public struct CustodyFixture {
    scenario: Scenario,
    clock: Clock,
    org_id: ID,
    custody_id: ID,
    other_custody: ID,
    proposal_id: ID,
    other_org: ID,
    release_proposal_id: ID,
}

public struct TestAsset has key, store {
    id: object::UID,
    value: u64,
}

/// One shared shape, sixty-four phantom markers: each `Filler<MNN>` is a
/// distinct on-chain type for the distinct-type capacity bound.
public struct Filler<phantom M> has key, store { id: object::UID }

public struct M01 has drop {}
public struct M02 has drop {}
public struct M03 has drop {}
public struct M04 has drop {}
public struct M05 has drop {}
public struct M06 has drop {}
public struct M07 has drop {}
public struct M08 has drop {}
public struct M09 has drop {}
public struct M10 has drop {}
public struct M11 has drop {}
public struct M12 has drop {}
public struct M13 has drop {}
public struct M14 has drop {}
public struct M15 has drop {}
public struct M16 has drop {}
public struct M17 has drop {}
public struct M18 has drop {}
public struct M19 has drop {}
public struct M20 has drop {}
public struct M21 has drop {}
public struct M22 has drop {}
public struct M23 has drop {}
public struct M24 has drop {}
public struct M25 has drop {}
public struct M26 has drop {}
public struct M27 has drop {}
public struct M28 has drop {}
public struct M29 has drop {}
public struct M30 has drop {}
public struct M31 has drop {}
public struct M32 has drop {}
public struct M33 has drop {}
public struct M34 has drop {}
public struct M35 has drop {}
public struct M36 has drop {}
public struct M37 has drop {}
public struct M38 has drop {}
public struct M39 has drop {}
public struct M40 has drop {}
public struct M41 has drop {}
public struct M42 has drop {}
public struct M43 has drop {}
public struct M44 has drop {}
public struct M45 has drop {}
public struct M46 has drop {}
public struct M47 has drop {}
public struct M48 has drop {}
public struct M49 has drop {}
public struct M50 has drop {}
public struct M51 has drop {}
public struct M52 has drop {}
public struct M53 has drop {}
public struct M54 has drop {}
public struct M55 has drop {}
public struct M56 has drop {}
public struct M57 has drop {}
public struct M58 has drop {}
public struct M59 has drop {}
public struct M60 has drop {}
public struct M61 has drop {}
public struct M62 has drop {}
public struct M63 has drop {}
public struct M64 has drop {}

// === Test-Only Functions ===

// The scenario allows each shared object to be an input at most once per
// transaction, so every helper below takes each object exactly once and every
// test transaction calls at most one scenario-touching helper per object.

fun start_custody(creator: address): CustodyFixture {
    let mut scenario = ts::begin(ALICE);
    let clock = clock::create_for_testing(scenario.ctx());
    // ALICE(2) + BOB(1) reach the threshold alone; CHARLIE(1) stays a
    // non-voting member so a third member can still act after approvals hit
    // the threshold (EApprovalThresholdMet needs an eligible late rejecter).
    let org_id = org::create_organization_for_testing(
        GROUP_PK, 2, 3, vector[ALICE, BOB, CHARLIE, ZERO_WEIGHT], vector[2, 1, 1, 0],
        scenario.ctx(),
    );
    let other_org = org::create_organization_for_testing(
        GROUP_PK, 2, 3, vector[ALICE, BOB, CHARLIE, ZERO_WEIGHT], vector[2, 1, 1, 0],
        scenario.ctx(),
    );
    scenario.next_tx(creator);
    let mut f = CustodyFixture {
        scenario, clock, org_id,
        custody_id: org_id, other_custody: org_id, proposal_id: org_id, other_org,
        release_proposal_id: org_id,
    };
    {
        let organization = ts::take_shared_by_id<Organization>(&f.scenario, f.org_id);
        let self = custody::new(&organization, f.ctx!());
        f.custody_id = object::id(&self);
        let events = event::events_by_type<AssetCustodyCreated>();
        assert!(events.length() == 1, 80);
        let (event_custody, event_org) = custody::custody_created_fields(&events[0]);
        assert!(event_custody == f.custody_id && event_org == f.org_id, 81);
        // Two fixed-length IDs: no sender, asset selector, or arbitrary payload.
        assert!(sui::bcs::to_bytes(&events[0]).length() == 64, 82);
        custody::share(self);
        ts::return_shared(organization);
    };
    f
}

macro fun fixture_next_tx($f: &mut CustodyFixture, $sender: address, $action: |&mut CustodyFixture|) {
    let f = $f;
    f.scenario.next_tx($sender);
    $action(f);
}

macro fun fixture_ctx($f: &mut CustodyFixture): &mut sui::tx_context::TxContext {
    let f = $f;
    f.scenario.ctx()
}

fun create_second_custody(f: &mut CustodyFixture) {
    let organization = ts::take_shared_by_id<Organization>(&f.scenario, f.org_id);
    let self = custody::new(&organization, f.ctx!());
    f.other_custody = f.custody_id;
    f.custody_id = object::id(&self);
    custody::share(self);
    ts::return_shared(organization);
}

/// Deposit one test asset through already-taken references.
fun deposit_asset_inline(
    f: &mut CustodyFixture,
    organization: &Organization,
    custody_ref: &mut AssetCustody,
    value: u64,
): ID {
    let asset = TestAsset { id: object::new(f.ctx!()), value };
    let object_id = object::id(&asset);
    custody::deposit<TestAsset>(custody_ref, organization, asset, &f.clock, f.ctx!());
    object_id
}

/// Deposit a freshly test-published upgrade cap through already-taken references.
fun deposit_cap_inline(
    f: &mut CustodyFixture,
    organization: &Organization,
    custody_ref: &mut AssetCustody,
): ID {
    let cap = package::test_publish(f.org_id, f.ctx!());
    let object_id = object::id(&cap);
    custody::deposit<package::UpgradeCap>(custody_ref, organization, cap, &f.clock, f.ctx!());
    object_id
}

fun deposit_by_sender(f: &mut CustodyFixture) {
    let organization = ts::take_shared_by_id<Organization>(&f.scenario, f.org_id);
    let mut self = ts::take_shared_by_id<AssetCustody>(&f.scenario, f.custody_id);
    let asset = TestAsset { id: object::new(f.ctx!()), value: 1 };
    custody::deposit<TestAsset>(&mut self, &organization, asset, &f.clock, f.ctx!());
    ts::return_shared(self);
    ts::return_shared(organization);
}

/// One transaction: deposit a test asset and open a borrow proposal on slot 0.
fun bootstrap_asset_borrow(f: &mut CustodyFixture) {
    let organization = ts::take_shared_by_id<Organization>(&f.scenario, f.org_id);
    let mut self = ts::take_shared_by_id<AssetCustody>(&f.scenario, f.custody_id);
    deposit_asset_inline(f, &organization, &mut self, 1);
    f.proposal_id = custody::create_proposal<TestAsset>(
        &self, &organization, custody::kind_borrow_for_testing(), b"Borrow for one PTB", 0,
        @0x0, 100, UPGRADE_DIGEST, &f.clock, f.ctx!(),
    );
    assert_proposal_created_event(f, custody::kind_borrow_for_testing(), @0x0);
    ts::return_shared(self);
    ts::return_shared(organization);
}

/// One transaction: deposit a test asset and open a release proposal on slot 0.
fun bootstrap_asset_release(f: &mut CustodyFixture, recipient: address) {
    let organization = ts::take_shared_by_id<Organization>(&f.scenario, f.org_id);
    let mut self = ts::take_shared_by_id<AssetCustody>(&f.scenario, f.custody_id);
    deposit_asset_inline(f, &organization, &mut self, 1);
    f.proposal_id = custody::create_proposal<TestAsset>(
        &self, &organization, custody::kind_release_for_testing(), b"Release to recipient", 0,
        recipient, 100, b"", &f.clock, f.ctx!(),
    );
    assert_proposal_created_event(f, custody::kind_release_for_testing(), recipient);
    ts::return_shared(self);
    ts::return_shared(organization);
}

/// #12: deposit and open a borrow whose ordinary deadline (400_000ms) far
/// outlives the 5-minute borrow window, so the two bounds diverge.
fun borrow_with_long_deadline(f: &mut CustodyFixture) {
    let organization = ts::take_shared_by_id<Organization>(&f.scenario, f.org_id);
    let mut self = ts::take_shared_by_id<AssetCustody>(&f.scenario, f.custody_id);
    deposit_asset_inline(f, &organization, &mut self, 1);
    f.proposal_id = custody::create_proposal<TestAsset>(
        &self, &organization, custody::kind_borrow_for_testing(), b"Borrow with a long deadline", 0,
        @0x0, 400_000, UPGRADE_DIGEST, &f.clock, f.ctx!(),
    );
    ts::return_shared(self);
    ts::return_shared(organization);
}


/// One transaction: deposit a published upgrade cap and open a borrow proposal.
fun bootstrap_cap_borrow(f: &mut CustodyFixture) {
    let organization = ts::take_shared_by_id<Organization>(&f.scenario, f.org_id);
    let mut self = ts::take_shared_by_id<AssetCustody>(&f.scenario, f.custody_id);
    deposit_cap_inline(f, &organization, &mut self);
    f.proposal_id = custody::create_proposal<package::UpgradeCap>(
        &self, &organization, custody::kind_borrow_for_testing(), b"Borrow the upgrade cap", 0,
        @0x0, 100, UPGRADE_DIGEST, &f.clock, f.ctx!(),
    );
    assert_proposal_created_event(f, custody::kind_borrow_for_testing(), @0x0);
    ts::return_shared(self);
    ts::return_shared(organization);
}

/// Must run in the transaction that emitted the proposal event: the scenario
/// exposes only current-transaction events.
fun assert_proposal_created_event(f: &mut CustodyFixture, kind: u8, recipient: address) {
    let events = event::events_by_type<CustodyProposalCreated>();
    let (event_proposal, event_custody, event_org, event_epoch, event_kind, event_slot, event_recipient, event_deadline) =
        custody::proposal_created_fields(&events[events.length() - 1]);
    assert!(event_proposal == f.proposal_id, 70);
    assert!(event_custody == f.custody_id && event_org == f.org_id, 71);
    assert!(event_epoch == 1 && event_kind == kind && event_slot == 0, 72);
    assert!(event_recipient == recipient && event_deadline == 100, 73);
}

/// A second custody of the same organization holds the borrowed slot; used to
/// prove proposal binding and receipt routing across same-org treasuries.
fun bootstrap_borrow_on_second_custody(f: &mut CustodyFixture) {
    let organization = ts::take_shared_by_id<Organization>(&f.scenario, f.org_id);
    let mut second = custody::new(&organization, f.ctx!());
    let asset = TestAsset { id: object::new(f.ctx!()), value: 1 };
    custody::deposit<TestAsset>(&mut second, &organization, asset, &f.clock, f.ctx!());
    f.proposal_id = custody::create_proposal<TestAsset>(
        &second, &organization, custody::kind_borrow_for_testing(), b"Borrow for one PTB", 0,
        @0x0, 100, UPGRADE_DIGEST, &f.clock, f.ctx!(),
    );
    let second_id = object::id(&second);
    custody::share(second);
    f.other_custody = f.custody_id;
    f.custody_id = second_id;
    ts::return_shared(organization);
}

/// Create a proposal on an asset deposited in an earlier transaction.
fun create_proposal_on_deposited_asset(
    f: &mut CustodyFixture,
    kind: u8,
    title: vector<u8>,
    slot: u64,
    recipient: address,
    deadline: u64,
) {
    let organization = ts::take_shared_by_id<Organization>(&f.scenario, f.org_id);
    let mut self = ts::take_shared_by_id<AssetCustody>(&f.scenario, f.custody_id);
    deposit_asset_inline(f, &organization, &mut self, 1);
    f.proposal_id = custody::create_proposal<TestAsset>(
        &self, &organization, kind, title, slot, recipient, deadline, kind_digest(kind), &f.clock, f.ctx!(),
    );
    ts::return_shared(self);
    ts::return_shared(organization);
}

/// #12: borrows commit the 32-byte action digest; releases pass empty.
fun kind_digest(kind: u8): vector<u8> {
    if (kind == custody::kind_borrow_for_testing()) { UPGRADE_DIGEST } else { b"" }
}

/// Open a cap borrow on the cap deposited in an earlier transaction.
fun bootstrap_cap_borrow_on_deposited(f: &mut CustodyFixture) {
    let organization = ts::take_shared_by_id<Organization>(&f.scenario, f.org_id);
    let self = ts::take_shared_by_id<AssetCustody>(&f.scenario, f.custody_id);
    f.proposal_id = custody::create_proposal<package::UpgradeCap>(
        &self, &organization, custody::kind_borrow_for_testing(), b"Borrow the upgrade cap", 0,
        @0x0, 100, UPGRADE_DIGEST, &f.clock, f.ctx!(),
    );
    ts::return_shared(self);
    ts::return_shared(organization);
}

/// Create a release on the test asset deposited in an earlier transaction.
fun create_release_on_deposited_asset(
    f: &mut CustodyFixture,
    kind: u8,
    title: vector<u8>,
    slot: u64,
    recipient: address,
    deadline: u64,
) {
    let organization = ts::take_shared_by_id<Organization>(&f.scenario, f.org_id);
    let self = ts::take_shared_by_id<AssetCustody>(&f.scenario, f.custody_id);
    f.proposal_id = custody::create_proposal<TestAsset>(
        &self, &organization, kind, title, slot, recipient, deadline, kind_digest(kind), &f.clock, f.ctx!(),
    );
    ts::return_shared(self);
    ts::return_shared(organization);
}

fun approve_current(f: &mut CustodyFixture) {
    let organization = ts::take_shared_by_id<Organization>(&f.scenario, f.org_id);
    let weight = org::member_weight(&organization, f.scenario.sender());
    let mut p = ts::take_shared_by_id<CustodyProposal>(&f.scenario, f.proposal_id);
    custody::submit_vote(&mut p, &organization, &f.clock, weight, f.ctx!());
    let events = event::events_by_type<CustodyVoteSubmitted>();
    let (event_proposal, event_voter, event_weight, _) =
        custody::vote_submitted_fields(&events[events.length() - 1]);
    assert!(event_proposal == f.proposal_id && event_voter == f.scenario.sender(), 74);
    assert!(event_weight == weight, 75);
    ts::return_shared(p);
    ts::return_shared(organization);
}

/// Submit with an explicitly claimed roster weight; aborts with
/// EWeightMismatch unless the claim matches the live roster. The event
/// assertion lives in approve_current: negative claims abort before emission.
fun approve_claiming_weight(f: &mut CustodyFixture, claimed: u64) {
    let organization = ts::take_shared_by_id<Organization>(&f.scenario, f.org_id);
    let mut p = ts::take_shared_by_id<CustodyProposal>(&f.scenario, f.proposal_id);
    custody::submit_vote(&mut p, &organization, &f.clock, claimed, f.ctx!());
    ts::return_shared(p);
    ts::return_shared(organization);
}

fun reject_current(f: &mut CustodyFixture) {
    let organization = ts::take_shared_by_id<Organization>(&f.scenario, f.org_id);
    let mut p = ts::take_shared_by_id<CustodyProposal>(&f.scenario, f.proposal_id);
    custody::reject_vote(&mut p, &organization, &f.clock, f.ctx!());
    let events = event::events_by_type<CustodyVoteRejected>();
    let (event_proposal, _, _) = custody::vote_rejected_fields(&events[events.length() - 1]);
    assert!(event_proposal == f.proposal_id, 76);
    ts::return_shared(p);
    ts::return_shared(organization);
}

/// Approve both release proposals of the dead-pending-slot test in one tx.
fun approve_two(f: &mut CustodyFixture) {
    let organization = ts::take_shared_by_id<Organization>(&f.scenario, f.org_id);
    let weight = org::member_weight(&organization, f.scenario.sender());
    let mut first = ts::take_shared_by_id<CustodyProposal>(&f.scenario, f.release_proposal_id);
    custody::submit_vote(&mut first, &organization, &f.clock, weight, f.ctx!());
    let mut second = ts::take_shared_by_id<CustodyProposal>(&f.scenario, f.proposal_id);
    custody::submit_vote(&mut second, &organization, &f.clock, weight, f.ctx!());
    ts::return_shared(second);
    ts::return_shared(first);
    ts::return_shared(organization);
}

fun borrow_and_return_asset(f: &mut CustodyFixture) {
    let organization = ts::take_shared_by_id<Organization>(&f.scenario, f.org_id);
    let mut self = ts::take_shared_by_id<AssetCustody>(&f.scenario, f.custody_id);
    let mut p = ts::take_shared_by_id<CustodyProposal>(&f.scenario, f.proposal_id);
    let (asset, receipt) = custody::take_asset<TestAsset>(&mut self, &mut p, &organization, &f.clock, f.ctx!());
    custody::return_asset<TestAsset>(&mut self, asset, receipt);
    ts::return_shared(p);
    ts::return_shared(self);
    ts::return_shared(organization);
}

fun borrow_and_return_cap(f: &mut CustodyFixture) {
    let organization = ts::take_shared_by_id<Organization>(&f.scenario, f.org_id);
    let mut self = ts::take_shared_by_id<AssetCustody>(&f.scenario, f.custody_id);
    let mut p = ts::take_shared_by_id<CustodyProposal>(&f.scenario, f.proposal_id);
    let (cap, receipt) =
        custody::take_asset<package::UpgradeCap>(&mut self, &mut p, &organization, &f.clock, f.ctx!());
    custody::return_asset<package::UpgradeCap>(&mut self, cap, receipt);
    ts::return_shared(p);
    ts::return_shared(self);
    ts::return_shared(organization);
}

fun execute_release_current(f: &mut CustodyFixture) {
    let proposal_id = f.proposal_id;
    execute_release_on(f, proposal_id);
}

fun execute_release_on(f: &mut CustodyFixture, proposal_id: ID) {
    let organization = ts::take_shared_by_id<Organization>(&f.scenario, f.org_id);
    let mut self = ts::take_shared_by_id<AssetCustody>(&f.scenario, f.custody_id);
    let mut p = ts::take_shared_by_id<CustodyProposal>(&f.scenario, proposal_id);
    custody::execute_release<TestAsset>(&mut self, &mut p, &organization, &f.clock);
    ts::return_shared(p);
    ts::return_shared(self);
    ts::return_shared(organization);
}

/// Conservation identity: every indexed slot of an expected-live type holds a
/// dynamic object child in this custody. Called after each lifecycle phase.
fun assert_conservation(self: &AssetCustody, expect_asset_slots: u64, expect_cap_slots: u64) {
    let mut expected_types = 0;
    if (expect_asset_slots > 0) {
        expected_types = expected_types + 1;
        assert!(custody::slot_count_for_testing<TestAsset>(self) == expect_asset_slots, 90);
        let mut slot = 0;
        while (slot < expect_asset_slots) {
            assert!(custody::slot_child_exists_for_testing<TestAsset>(self, slot), 91);
            slot = slot + 1;
        };
    };
    if (expect_cap_slots > 0) {
        expected_types = expected_types + 1;
        assert!(custody::slot_count_for_testing<package::UpgradeCap>(self) == expect_cap_slots, 92);
        assert!(custody::slot_child_exists_for_testing<package::UpgradeCap>(self, 0), 93);
    };
    assert!(custody::type_count(self) == expected_types, 94);
}

fun deposit_all_fillers(
    f: &mut CustodyFixture,
    organization: &Organization,
    custody_ref: &mut AssetCustody,
) {
    deposit_filler<M01>(f, organization, custody_ref); deposit_filler<M02>(f, organization, custody_ref);
    deposit_filler<M03>(f, organization, custody_ref); deposit_filler<M04>(f, organization, custody_ref);
    deposit_filler<M05>(f, organization, custody_ref); deposit_filler<M06>(f, organization, custody_ref);
    deposit_filler<M07>(f, organization, custody_ref); deposit_filler<M08>(f, organization, custody_ref);
    deposit_filler<M09>(f, organization, custody_ref); deposit_filler<M10>(f, organization, custody_ref);
    deposit_filler<M11>(f, organization, custody_ref); deposit_filler<M12>(f, organization, custody_ref);
    deposit_filler<M13>(f, organization, custody_ref); deposit_filler<M14>(f, organization, custody_ref);
    deposit_filler<M15>(f, organization, custody_ref); deposit_filler<M16>(f, organization, custody_ref);
    deposit_filler<M17>(f, organization, custody_ref); deposit_filler<M18>(f, organization, custody_ref);
    deposit_filler<M19>(f, organization, custody_ref); deposit_filler<M20>(f, organization, custody_ref);
    deposit_filler<M21>(f, organization, custody_ref); deposit_filler<M22>(f, organization, custody_ref);
    deposit_filler<M23>(f, organization, custody_ref); deposit_filler<M24>(f, organization, custody_ref);
    deposit_filler<M25>(f, organization, custody_ref); deposit_filler<M26>(f, organization, custody_ref);
    deposit_filler<M27>(f, organization, custody_ref); deposit_filler<M28>(f, organization, custody_ref);
    deposit_filler<M29>(f, organization, custody_ref); deposit_filler<M30>(f, organization, custody_ref);
    deposit_filler<M31>(f, organization, custody_ref); deposit_filler<M32>(f, organization, custody_ref);
    deposit_filler<M33>(f, organization, custody_ref); deposit_filler<M34>(f, organization, custody_ref);
    deposit_filler<M35>(f, organization, custody_ref); deposit_filler<M36>(f, organization, custody_ref);
    deposit_filler<M37>(f, organization, custody_ref); deposit_filler<M38>(f, organization, custody_ref);
    deposit_filler<M39>(f, organization, custody_ref); deposit_filler<M40>(f, organization, custody_ref);
    deposit_filler<M41>(f, organization, custody_ref); deposit_filler<M42>(f, organization, custody_ref);
    deposit_filler<M43>(f, organization, custody_ref); deposit_filler<M44>(f, organization, custody_ref);
    deposit_filler<M45>(f, organization, custody_ref); deposit_filler<M46>(f, organization, custody_ref);
    deposit_filler<M47>(f, organization, custody_ref); deposit_filler<M48>(f, organization, custody_ref);
    deposit_filler<M49>(f, organization, custody_ref); deposit_filler<M50>(f, organization, custody_ref);
    deposit_filler<M51>(f, organization, custody_ref); deposit_filler<M52>(f, organization, custody_ref);
    deposit_filler<M53>(f, organization, custody_ref); deposit_filler<M54>(f, organization, custody_ref);
    deposit_filler<M55>(f, organization, custody_ref); deposit_filler<M56>(f, organization, custody_ref);
    deposit_filler<M57>(f, organization, custody_ref); deposit_filler<M58>(f, organization, custody_ref);
    deposit_filler<M59>(f, organization, custody_ref); deposit_filler<M60>(f, organization, custody_ref);
    deposit_filler<M61>(f, organization, custody_ref); deposit_filler<M62>(f, organization, custody_ref);
    deposit_filler<M63>(f, organization, custody_ref); deposit_filler<M64>(f, organization, custody_ref);
}

fun deposit_filler<M: drop>(
    f: &mut CustodyFixture,
    organization: &Organization,
    custody_ref: &mut AssetCustody,
) {
    let filler = Filler<M> { id: object::new(f.ctx!()) };
    custody::deposit<Filler<M>>(custody_ref, organization, filler, &f.clock, f.ctx!());
}

fun fixture_end(f: CustodyFixture) {
    let CustodyFixture {
        scenario, clock, org_id: _, custody_id: _, other_custody: _, proposal_id: _,
        other_org: _, release_proposal_id: _,
    } = f;
    clock.destroy_for_testing();
    scenario.end();
}
