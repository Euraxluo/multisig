#[test_only]
module agent_vault::organization_treasury_tests;

use sui::{
    clock::{Self, Clock},
    coin::{Self, Coin},
    event,
    sui::SUI,
    test_scenario::{Self as ts, Scenario},
};
use agent_vault::{
    asynchronous_proposal::{Self as proposal, Proposal, ProposalExecutedEvent},
    cryptographic_org::{Self as org, Organization},
    organization_treasury::{Self as treasury, OrganizationTreasury, TransferBinding, TreasuryCreated, TransferCreated},
    vault::{Self, AgentVault, MasterCap, OperatorCap, AgentCap},
};

use fun fixture_end as TreasuryFixture.end;
use fun fixture_next_tx as TreasuryFixture.next_tx;
use fun fixture_ctx as TreasuryFixture.ctx;

// === Constants ===

const ALICE: address = @0xA11CE;
const BOB: address = @0xB0B;
const ZERO_WEIGHT: address = @0xDA71D;
const RELAYER: address = @0xEE7E;
const RECIPIENT: address = @0x9999;
const GROUP_PK: vector<u8> = x"8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c";

// === Tests ===

#[test]
fun member_creates_shared_wrapper_with_discoverable_vault_and_sealed_cap() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(ALICE, |f| {
        assert_custody(f);
        assert_balance(f, 100);
    });
    f.end();
}

#[test, expected_failure(abort_code = treasury::ENotMember, location = agent_vault::organization_treasury)]
fun outsider_cannot_create_treasury() {
    let f = start_treasury(RELAYER);
    f.end();
}

#[test, expected_failure(abort_code = treasury::ENotMember, location = agent_vault::organization_treasury)]
fun zero_weight_roster_entry_cannot_create_treasury() {
    let f = start_treasury(ZERO_WEIGHT);
    f.end();
}

#[test]
fun another_positive_weight_member_can_create_treasury() {
    let mut f = start_treasury(BOB);
    f.next_tx!(BOB, |f| assert_custody(f));
    f.end();
}

#[test]
fun third_party_executes_approved_stored_recipient_and_conserves_sui() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(ALICE, |f| approve(f));
    f.next_tx!(BOB, |f| approve(f));
    f.next_tx!(RELAYER, |f| {
        execute(f);
        assert_executed_event(f, 30, RECIPIENT);
    });
    f.next_tx!(RELAYER, |f| {
        assert_state(f, 2, 3, 0);
        assert_balance(f, 70);
        assert!(ts::ids_for_address<Coin<SUI>>(RELAYER).is_empty());
        assert!(ts::ids_for_address<Coin<SUI>>(ALICE).is_empty());
    });
    f.end();
}

#[test]
fun entire_balance_can_exit_using_same_organization_approval() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(ALICE, |f| {
        create_transfer(f.treasury_id, f.org_id, 100, BOB, f);
    });
    f.next_tx!(ALICE, |f| approve(f));
    f.next_tx!(BOB, |f| approve(f));
    f.next_tx!(RELAYER, |f| {
        execute(f);
        assert_executed_event(f, 100, BOB);
    });
    f.next_tx!(RELAYER, |f| {
        assert_balance(f, 0);
    });
    f.end();
}

#[test]
fun separate_treasuries_share_governance_but_keep_distinct_funding_bindings() {
    let mut f = start_treasury(ALICE);
    let first_treasury = f.treasury_id;
    let first_vault = f.vault_id;
    f.next_tx!(BOB, |f| create_treasury(f.org_id, f));
    assert!(f.treasury_id != first_treasury && f.vault_id != first_vault);
    f.next_tx!(ALICE, |f| {
        deposit(f, 80);
        create_transfer(f.treasury_id, f.org_id, 30, RECIPIENT, f);
    });
    f.next_tx!(ALICE, |f| approve(f));
    f.next_tx!(BOB, |f| approve(f));
    f.next_tx!(RELAYER, |f| execute(f));
    f.next_tx!(RELAYER, |f| {
        assert_balance(f, 50);
        let first = ts::take_shared_by_id<AgentVault<SUI>>(&f.scenario, first_vault);
        assert!(vault::vault_balance(&first) == 100);
        ts::return_shared(first);
    });
    f.end();
}

#[test, expected_failure(abort_code = treasury::EWrongOrganization, location = agent_vault::organization_treasury)]
fun foreign_organization_precedes_vault_binding_and_threshold_checks() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(ALICE, |f| f.other_org = create_organization(f));
    f.next_tx!(RELAYER, |f| {
        execute_using(f.treasury_id, f.binding_id, f.other_org, f.proposal_id, f.vault_id, f);
    });
    f.end();
}

#[test, expected_failure(abort_code = treasury::EWrongVault, location = agent_vault::organization_treasury)]
fun foreign_vault_precedes_unapproved_proposal() {
    let mut f = start_treasury(ALICE);
    let bound_treasury = f.treasury_id;
    f.next_tx!(ALICE, |f| create_treasury(f.org_id, f));
    f.next_tx!(RELAYER, |f| {
        execute_using(bound_treasury, f.binding_id, f.org_id, f.proposal_id, f.vault_id, f);
    });
    f.end();
}

#[test, expected_failure(abort_code = treasury::EWrongOrganization, location = agent_vault::organization_treasury)]
fun transfer_creation_rejects_foreign_organization_before_membership() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(ALICE, |f| f.other_org = create_organization(f));
    f.next_tx!(RELAYER, |f| create_transfer(f.treasury_id, f.other_org, 30, RECIPIENT, f));
    f.end();
}

#[test, expected_failure(abort_code = treasury::ENotMember, location = agent_vault::organization_treasury)]
fun outsider_cannot_create_a_bound_transfer() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(RELAYER, |f| create_transfer(f.treasury_id, f.org_id, 30, RECIPIENT, f));
    f.end();
}

#[test, expected_failure(abort_code = treasury::EWrongTreasuryBinding, location = agent_vault::organization_treasury)]
fun same_org_approved_transfer_cannot_spend_another_treasury() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(ALICE, |f| approve(f));
    f.next_tx!(BOB, |f| approve(f));
    f.next_tx!(ALICE, |f| create_treasury(f.org_id, f));
    f.next_tx!(RELAYER, |f| execute(f));
    f.end();
}

#[test, expected_failure(abort_code = treasury::EWrongProposalBinding, location = agent_vault::organization_treasury)]
fun approved_foreign_org_proposal_cannot_replace_the_bound_proposal() {
    let mut f = start_treasury(ALICE);
    let own_org = f.org_id;
    let own_binding = f.binding_id;
    let own_treasury = f.treasury_id;
    let own_vault = f.vault_id;
    f.next_tx!(ALICE, |f| f.other_org = create_organization(f));
    f.next_tx!(ALICE, |f| create_treasury(f.other_org, f));
    f.next_tx!(ALICE, |f| create_transfer(f.treasury_id, f.other_org, 30, RECIPIENT, f));
    f.org_id = f.other_org;
    f.next_tx!(ALICE, |f| approve(f));
    f.next_tx!(BOB, |f| approve(f));
    f.next_tx!(RELAYER, |f| {
        execute_using(own_treasury, own_binding, own_org, f.proposal_id, own_vault, f);
    });
    f.end();
}

#[test, expected_failure(abort_code = treasury::EWrongProposalBinding, location = agent_vault::organization_treasury)]
fun binding_cannot_authorize_a_different_same_org_proposal() {
    let mut f = start_treasury(ALICE);
    let original_binding = f.binding_id;
    f.next_tx!(ALICE, |f| create_transfer(f.treasury_id, f.org_id, 31, RECIPIENT, f));
    f.next_tx!(ALICE, |f| approve(f));
    f.next_tx!(BOB, |f| approve(f));
    f.binding_id = original_binding;
    f.next_tx!(RELAYER, |f| execute(f));
    f.end();
}

#[test, expected_failure(abort_code = 4004, location = agent_vault::asynchronous_proposal)]
fun creator_cannot_execute_without_threshold_approval() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(ALICE, |f| approve(f));
    f.next_tx!(ALICE, |f| execute(f));
    f.end();
}

#[test]
fun execution_one_millisecond_before_deadline_succeeds() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(ALICE, |f| approve(f));
    f.next_tx!(BOB, |f| approve(f));
    f.clock.set_for_testing(99);
    f.next_tx!(RELAYER, |f| execute(f));
    f.next_tx!(RELAYER, |f| assert_balance(f, 70));
    f.end();
}

#[test]
fun execution_at_inclusive_deadline_succeeds() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(ALICE, |f| approve(f));
    f.next_tx!(BOB, |f| approve(f));
    f.clock.set_for_testing(100);
    f.next_tx!(RELAYER, |f| execute(f));
    f.next_tx!(RELAYER, |f| assert_balance(f, 70));
    f.end();
}

#[test, expected_failure(abort_code = 4001, location = agent_vault::asynchronous_proposal)]
fun first_millisecond_after_deadline_precedes_threshold_check() {
    let mut f = start_treasury(ALICE);
    f.clock.set_for_testing(101);
    f.next_tx!(RELAYER, |f| execute(f));
    f.end();
}

#[test, expected_failure(abort_code = 4011, location = agent_vault::asynchronous_proposal)]
fun authenticated_epoch_advance_invalidates_previously_approved_transfer() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(ALICE, |f| approve(f));
    f.next_tx!(BOB, |f| approve(f));
    f.next_tx!(ALICE, |f| advance_epoch(f));
    f.next_tx!(RELAYER, |f| execute(f));
    f.end();
}

#[test]
fun new_epoch_proposal_restores_governed_exit_after_rotation() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(ALICE, |f| advance_epoch(f));
    f.next_tx!(ALICE, |f| create_transfer(f.treasury_id, f.org_id, 100, RECIPIENT, f));
    f.next_tx!(ALICE, |f| approve(f));
    f.next_tx!(BOB, |f| approve(f));
    f.next_tx!(RELAYER, |f| execute(f));
    f.next_tx!(RELAYER, |f| {
        assert_balance(f, 0);
    });
    f.end();
}

#[test, expected_failure(abort_code = 4002, location = agent_vault::asynchronous_proposal)]
fun rejected_transfer_cannot_execute_even_before_deadline() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(ALICE, |f| reject(f));
    f.next_tx!(BOB, |f| reject(f));
    f.next_tx!(RELAYER, |f| execute(f));
    f.end();
}

#[test, expected_failure(abort_code = 4002, location = agent_vault::asynchronous_proposal)]
fun executed_transfer_cannot_replay_even_after_deadline() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(ALICE, |f| approve(f));
    f.next_tx!(BOB, |f| approve(f));
    f.next_tx!(RELAYER, |f| execute(f));
    f.clock.set_for_testing(101);
    f.next_tx!(RELAYER, |f| execute(f));
    f.end();
}

#[test, expected_failure(abort_code = 2004, location = agent_vault::vault)]
fun approved_transfer_cannot_exceed_canonical_vault_balance() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(ALICE, |f| create_transfer(f.treasury_id, f.org_id, 101, RECIPIENT, f));
    f.next_tx!(ALICE, |f| approve(f));
    f.next_tx!(BOB, |f| approve(f));
    f.next_tx!(RELAYER, |f| execute(f));
    f.end();
}

#[test, expected_failure(abort_code = treasury::ENotMember, location = agent_vault::organization_treasury)]
fun zero_weight_member_cannot_create_bound_transfer() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(ZERO_WEIGHT, |f| create_transfer(f.treasury_id, f.org_id, 30, RECIPIENT, f));
    f.end();
}

#[test, expected_failure(abort_code = treasury::EInvalidRecipient, location = agent_vault::organization_treasury)]
fun zero_recipient_precedes_zero_amount_and_empty_title() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(ALICE, |f| create_transfer_with(f.treasury_id, f.org_id, b"", @0x0, 0, 0, f));
    f.end();
}

#[test, expected_failure(abort_code = treasury::EZeroAmount, location = agent_vault::organization_treasury)]
fun zero_amount_precedes_empty_title_and_invalid_deadline() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(ALICE, |f| create_transfer_with(f.treasury_id, f.org_id, b"", RECIPIENT, 0, 0, f));
    f.end();
}

#[test, expected_failure(abort_code = treasury::EInvalidTitle, location = agent_vault::organization_treasury)]
fun empty_title_precedes_invalid_deadline() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(ALICE, |f| create_transfer_with(f.treasury_id, f.org_id, b"", RECIPIENT, 1, 0, f));
    f.end();
}

#[test, expected_failure(abort_code = treasury::EInvalidTitle, location = agent_vault::organization_treasury)]
fun first_title_byte_over_bound_is_rejected() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(ALICE, |f| create_transfer_with(f.treasury_id, f.org_id, vector::tabulate!(257, |_| 1u8), RECIPIENT, 1, 100, f));
    f.end();
}

#[test, expected_failure(abort_code = treasury::EInvalidDeadline, location = agent_vault::organization_treasury)]
fun creation_at_deadline_is_rejected_without_unsigned_underflow() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(ALICE, |f| create_transfer_with(f.treasury_id, f.org_id, b"a", RECIPIENT, 1, 0, f));
    f.end();
}

#[test, expected_failure(abort_code = treasury::EInvalidDeadline, location = agent_vault::organization_treasury)]
fun creation_after_deadline_is_rejected_without_unsigned_underflow() {
    let mut f = start_treasury(ALICE);
    f.clock.set_for_testing(101);
    f.next_tx!(ALICE, |f| create_transfer(f.treasury_id, f.org_id, 1, RECIPIENT, f));
    f.end();
}

#[test, expected_failure(abort_code = treasury::EInvalidDeadline, location = agent_vault::organization_treasury)]
fun first_millisecond_over_maximum_duration_is_rejected() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(ALICE, |f| create_transfer_with(f.treasury_id, f.org_id, b"a", RECIPIENT, 1, 31_536_000_001, f));
    f.end();
}

#[test]
fun minimum_amount_and_maximum_title_and_duration_are_supported() {
    let mut f = start_treasury(ALICE);
    f.next_tx!(ALICE, |f| create_transfer_with(f.treasury_id, f.org_id, vector::tabulate!(256, |_| 1u8), RECIPIENT, 1, 31_536_000_000, f));
    f.next_tx!(ALICE, |f| approve(f));
    f.next_tx!(BOB, |f| approve(f));
    f.next_tx!(RELAYER, |f| execute(f));
    f.next_tx!(RELAYER, |f| {
        assert_balance(f, 99);
    });
    f.end();
}

// === Test-Only Types ===

public struct TreasuryFixture {
    scenario: Scenario,
    clock: Clock,
    org_id: ID,
    treasury_id: ID,
    vault_id: ID,
    proposal_id: ID,
    binding_id: ID,
    other_org: ID,
}

// === Test-Only Functions ===

fun start_treasury(creator: address): TreasuryFixture {
    let mut scenario = ts::begin(ALICE);
    let clock = clock::create_for_testing(scenario.ctx());
    let org_id = org::create_organization_for_testing(
        GROUP_PK, 2, 3, vector[ALICE, BOB, ZERO_WEIGHT], vector[2, 1, 0], scenario.ctx(),
    );
    scenario.next_tx(creator);
    let mut f = TreasuryFixture {
        scenario, clock, org_id,
        treasury_id: org_id, vault_id: org_id, proposal_id: org_id,
        binding_id: org_id, other_org: org_id,
    };
    create_treasury(org_id, &mut f);
    // The newly shared vault has no returned reference. Deposit uses the next
    // transaction's shared input; taking it earlier would misrepresent a PTB.
    f.scenario.next_tx(ALICE);
    deposit(&mut f, 100);
    create_transfer(f.treasury_id, org_id, 30, RECIPIENT, &mut f);
    f.scenario.next_tx(ALICE);
    f
}

macro fun fixture_next_tx($f: &mut TreasuryFixture, $sender: address, $action: |&mut TreasuryFixture|) {
    let f = $f;
    f.scenario.next_tx($sender);
    $action(f);
}

macro fun fixture_ctx($f: &mut TreasuryFixture): &mut TxContext {
    let f = $f;
    f.scenario.ctx()
}

fun create_organization(f: &mut TreasuryFixture): ID {
    org::create_organization_for_testing(GROUP_PK, 2, 3, vector[ALICE, BOB], vector[2, 1], f.ctx!())
}

fun create_treasury(org_id: ID, f: &mut TreasuryFixture) {
    let organization = ts::take_shared_by_id<Organization>(&f.scenario, org_id);
    let self = treasury::new(&organization, f.ctx!());
    let (stored_org, vault_id, cap_id) = treasury::custody_ids(&self);
    let id = object::id(&self);
    let events = event::events_by_type<TreasuryCreated>();
    let (event_id, event_org, event_vault) = treasury::treasury_created_fields(&events[events.length() - 1]);
    assert!(stored_org == org_id && event_id == id && event_org == org_id && event_vault == vault_id);
    assert!(cap_id != id && cap_id != vault_id);
    // 3 fixed-length IDs: no sender, asset selector, or arbitrary payload.
    assert!(sui::bcs::to_bytes(&events[events.length() - 1]).length() == 96);
    treasury::share(self);
    ts::return_shared(organization);
    f.treasury_id = id;
    f.vault_id = vault_id;
}

fun create_transfer(treasury_id: ID, org_id: ID, amount: u64, recipient: address, f: &mut TreasuryFixture) {
    create_transfer_with(treasury_id, org_id, b"Approved SUI payment", recipient, amount, 100, f);
}

fun create_transfer_with(
    treasury_id: ID, org_id: ID, title: vector<u8>, recipient: address, amount: u64, deadline: u64, f: &mut TreasuryFixture,
) {
    let self = ts::take_shared_by_id<OrganizationTreasury>(&f.scenario, treasury_id);
    let organization = ts::take_shared_by_id<Organization>(&f.scenario, org_id);
    let proposal_id = treasury::create_transfer(&self, &organization, title, recipient, amount, deadline, &f.clock, f.ctx!());
    let events = event::events_by_type<TransferCreated>();
    let (binding_id, event_treasury, event_proposal) = treasury::transfer_created_fields(&events[events.length() - 1]);
    assert!(event_treasury == treasury_id && event_proposal == proposal_id);
    assert!(sui::bcs::to_bytes(&events[events.length() - 1]).length() == 96);
    f.proposal_id = proposal_id;
    f.binding_id = binding_id;
    ts::return_shared(organization);
    ts::return_shared(self);
}

fun deposit(f: &mut TreasuryFixture, amount: u64) {
    let mut vault = ts::take_shared_by_id<AgentVault<SUI>>(&f.scenario, f.vault_id);
    let funds = coin::mint_for_testing<SUI>(amount, f.ctx!());
    vault::deposit(&mut vault, funds);
    ts::return_shared(vault);
}

fun approve(f: &mut TreasuryFixture) {
    let mut p = ts::take_shared_by_id<Proposal>(&f.scenario, f.proposal_id);
    let organization = ts::take_shared_by_id<Organization>(&f.scenario, f.org_id);
    let weight = org::member_weight(&organization, f.scenario.sender());
    proposal::submit_async_vote(&mut p, &organization, &f.clock, weight, vector[], f.ctx!());
    ts::return_shared(organization);
    ts::return_shared(p);
}

fun reject(f: &mut TreasuryFixture) {
    let mut p = ts::take_shared_by_id<Proposal>(&f.scenario, f.proposal_id);
    let organization = ts::take_shared_by_id<Organization>(&f.scenario, f.org_id);
    proposal::reject_async_vote(&mut p, &organization, &f.clock, f.ctx!());
    ts::return_shared(organization);
    ts::return_shared(p);
}

fun execute(f: &mut TreasuryFixture) {
    execute_using(f.treasury_id, f.binding_id, f.org_id, f.proposal_id, f.vault_id, f);
}

fun execute_using(treasury_id: ID, binding_id: ID, org_id: ID, proposal_id: ID, vault_id: ID, f: &mut TreasuryFixture) {
    let self = ts::take_shared_by_id<OrganizationTreasury>(&f.scenario, treasury_id);
    let binding = ts::take_shared_by_id<TransferBinding>(&f.scenario, binding_id);
    let mut organization = ts::take_shared_by_id<Organization>(&f.scenario, org_id);
    let mut p = ts::take_shared_by_id<Proposal>(&f.scenario, proposal_id);
    let mut vault = ts::take_shared_by_id<AgentVault<SUI>>(&f.scenario, vault_id);
    treasury::execute_for_testing(&self, &binding, &mut organization, &mut p, &mut vault, 3, &f.clock, f.ctx!());
    ts::return_shared(vault);
    ts::return_shared(p);
    ts::return_shared(organization);
    ts::return_shared(binding);
    ts::return_shared(self);
}

fun assert_custody(f: &TreasuryFixture) {
    let self = ts::take_shared_by_id<OrganizationTreasury>(&f.scenario, f.treasury_id);
    let (org_id, vault_id, _) = treasury::custody_ids(&self);
    assert!(org_id == f.org_id && vault_id == f.vault_id);
    let binding = ts::take_shared_by_id<TransferBinding>(&f.scenario, f.binding_id);
    let (binding_treasury, binding_proposal) = treasury::binding_ids(&binding);
    assert!(binding_treasury == f.treasury_id && binding_proposal == f.proposal_id);
    assert!(ts::ids_for_address<MasterCap>(ALICE).is_empty());
    assert!(ts::ids_for_address<MasterCap>(BOB).is_empty());
    assert!(ts::ids_for_address<MasterCap>(RELAYER).is_empty());
    assert!(!ts::has_most_recent_shared<MasterCap>());
    assert!(!ts::has_most_recent_shared<OperatorCap>());
    assert!(!ts::has_most_recent_shared<AgentCap>());
    assert!(ts::ids_for_address<OperatorCap>(ALICE).is_empty());
    assert!(ts::ids_for_address<AgentCap>(ALICE).is_empty());
    ts::return_shared(binding);
    ts::return_shared(self);
}

fun assert_balance(f: &TreasuryFixture, expected: u64) {
    let vault = ts::take_shared_by_id<AgentVault<SUI>>(&f.scenario, f.vault_id);
    assert!(vault::vault_balance(&vault) == expected);
    ts::return_shared(vault);
}

fun assert_state(f: &TreasuryFixture, status: u8, approved: u64, rejected: u64) {
    let p = ts::take_shared_by_id<Proposal>(&f.scenario, f.proposal_id);
    assert!(proposal::status(&p) == status);
    assert!(proposal::accumulated_weight(&p) == approved);
    assert!(proposal::rejected_weight(&p) == rejected);
    ts::return_shared(p);
}

fun assert_executed_event(f: &TreasuryFixture, amount: u64, recipient: address) {
    // Existing event has { proposal_id: ID, amount: u64, recipient: address }.
    // Decode in tests only; no production getter is added for event inspection.
    let events = event::events_by_type<ProposalExecutedEvent>();
    let mut fields = sui::bcs::new(sui::bcs::to_bytes(&events[events.length() - 1]));
    assert!(object::id_from_address(fields.peel_address()) == f.proposal_id);
    assert!(fields.peel_u64() == amount && fields.peel_address() == recipient);
    assert!(fields.into_remainder_bytes().is_empty());
}

fun advance_epoch(f: &mut TreasuryFixture) {
    let mut organization = ts::take_shared_by_id<Organization>(&f.scenario, f.org_id);
    // V2 epoch-advance fixture (SUI_ORG_EPOCH_ADVANCE_V2: || chain || org || epoch 1 ||
    // nonce 2 || next 2 || key_generation 1), signed by the sk=0x01*32 fixture key.
    // Org UID = derive_id(txn0, ids=2) — runtime-verified in Round-9 fixture migration.
    let signature = x"0dfd086e1d1686cb032f4a8aa3b46f56dd221314c0c3ffe503a89d1bf0d1fa8336d7840835eb9876d7fa94277477cc90794a9ee438fd73f7df90cdb8fb7a9a02";
    org::advance_organization_epoch(&mut organization, 2, signature, f.ctx!());
    assert!(org::epoch_version(&organization) == 2);
    ts::return_shared(organization);
}

fun fixture_end(f: TreasuryFixture) {
    let TreasuryFixture { scenario, clock, org_id: _, treasury_id: _, vault_id: _, proposal_id: _, binding_id: _, other_org: _ } = f;
    clock.destroy_for_testing();
    scenario.end();
}
