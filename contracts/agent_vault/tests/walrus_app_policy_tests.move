#[test_only]
module agent_vault::walrus_app_policy_tests;

use std::{bcs, string::String, unit_test::assert_eq};
use sui::{coin::{Self, Coin}, sui::SUI, test_scenario::{Self as ts, Scenario}};
use agent_vault::{
    onchain_chat::{Self as chat, ChatChannel, MemberStakeReceipt},
    walrus_app_policy::{Self as policy, Registry, AdminCap, PaymentSent, PaymentAppRegistered, AppStatusChanged},
};

use fun fixture_next_tx as PaymentFixture.next_tx;
use fun fixture_ctx as PaymentFixture.ctx;
use fun fixture_pay as PaymentFixture.pay;
use fun fixture_toggle as PaymentFixture.toggle;
use fun fixture_collect as PaymentFixture.collect;
use fun fixture_leave as PaymentFixture.leave;
use fun fixture_end as PaymentFixture.end;

// === Constants ===

const ALICE: address = @0xA11CE;
const BOB: address = @0xB0B;
const CAROL: address = @0xCA401;
const RECIPIENT: address = @0xD357;
const STAKE: u64 = 100;

// === Payment and Exit Tests ===

#[test]
fun repeated_payments_deliver_actual_coins_and_replay_every_event_field() {
    let mut f = start_payment_fixture(STAKE, 50, RECIPIENT, 7, 10, b"app".to_string());
    assert_registration(&f, 50, RECIPIENT, 7, 10);
    f.next_tx!(BOB, |f| { f.pay(b"app".to_string(), vector[1, 6], false, false); });
    f.next_tx!(RECIPIENT, |f| { assert_eq!(f.collect(), 7); });
    f.next_tx!(BOB, |f| { f.pay(b"app".to_string(), vector[3], false, false); });
    f.next_tx!(RECIPIENT, |f| { assert_eq!(f.collect(), 3); });
    assert_payments(&f, b"app".to_string(), vector[1, 6, 3], vector[0, 0, 0], vector[1, 7, 10]);
    assert_membership_principal(&f, true, STAKE);
    f.next_tx!(BOB, |f| { assert_eq!(f.leave(), STAKE); });
    f.next_tx!(BOB, |f| { assert_eq!(f.collect(), STAKE); });
    assert_membership_principal(&f, false, 0);
    f.end();
}

#[test]
fun pause_resume_preserves_accounting_and_leave_refund() {
    let mut f = default_fixture(10, 20);
    f.next_tx!(BOB, |f| { f.pay(b"app".to_string(), vector[10], false, false); });
    f.next_tx!(ALICE, |f| { f.toggle(vector[false, true, false], false, b"app".to_string()); });
    assert_statuses(&f, vector[false, true, false]);
    f.next_tx!(ALICE, |_f| {});
    assert_accounting(&f, 10, 0, false);
    f.next_tx!(BOB, |f| { assert_eq!(f.leave(), STAKE); });
    f.next_tx!(BOB, |f| { assert_eq!(f.collect(), STAKE); });
    f.next_tx!(RECIPIENT, |f| { assert_eq!(f.collect(), 10); });
    assert_membership_principal(&f, false, 0);
    f.end();
}

#[test]
fun epoch_rollover_resets_only_the_new_epoch_and_events_replay_totals() {
    let mut f = default_fixture(10, 10);
    f.next_tx!(BOB, |f| { f.pay(b"app".to_string(), vector[10], false, false); });
    advance_epoch(&mut f, BOB);
    // The getter names the epoch its lazy accounting belongs to, even before the next pay.
    assert_accounting(&f, 10, 0, true);
    f.next_tx!(BOB, |f| { f.pay(b"app".to_string(), vector[4, 6], false, false); });
    f.next_tx!(RECIPIENT, |f| { assert_eq!(f.collect(), 20); });
    assert_payments(&f, b"app".to_string(), vector[10, 4, 6], vector[0, 1, 1], vector[10, 4, 10]);
    f.end();
}

#[test]
fun u64_maximum_payment_and_epoch_budget_are_supported_exactly() {
    let mut f = default_fixture(std::u64::max_value!(), std::u64::max_value!());
    f.next_tx!(BOB, |f| { f.pay(b"app".to_string(), vector[std::u64::max_value!()], false, false); });
    f.next_tx!(RECIPIENT, |f| { assert_eq!(f.collect(), std::u64::max_value!()); });
    assert_payments(&f, b"app".to_string(), vector[std::u64::max_value!()], vector[0], vector[std::u64::max_value!()]);
    f.end();
}

#[test]
fun different_apps_keep_independent_recipients_and_budgets() {
    let mut f = default_fixture(1, 1);
    f.next_tx!(ALICE, |f| { register_another(f, b"other".to_string(), CAROL, 2, 2, false); });
    f.next_tx!(BOB, |f| { f.pay(b"app".to_string(), vector[1], false, false); });
    f.next_tx!(BOB, |f| { f.pay(b"other".to_string(), vector[2], false, false); });
    f.next_tx!(CAROL, |f| { assert_eq!(f.collect(), 2); });
    f.next_tx!(RECIPIENT, |f| { assert_eq!(f.collect(), 1); });
    assert_accounting(&f, 1, 0, true);
    f.end();
}

#[test]
fun returned_transferred_receipt_works_for_its_original_member_and_refunds() {
    let mut f = default_fixture(1, 1);
    f.next_tx!(BOB, |f| { transfer_receipt(f, CAROL); });
    f.next_tx!(CAROL, |f| { transfer_receipt(f, BOB); });
    f.next_tx!(BOB, |f| { f.pay(b"app".to_string(), vector[1], false, false); });
    f.next_tx!(BOB, |f| { assert_eq!(f.leave(), STAKE); });
    f.end();
}

// === Authority and Guard Precedence Tests ===

#[test]
#[expected_failure(abort_code = policy::EWrongRegistry, location = agent_vault::walrus_app_policy)]
fun foreign_registry_cap_precedes_duplicate_registration() {
    let mut f = default_fixture(10, 20);
    f.next_tx!(ALICE, |f| { register_another(f, b"app".to_string(), RECIPIENT, 10, 20, true); });
    f.end();
}

#[test]
#[expected_failure(abort_code = policy::EWrongRegistry, location = agent_vault::walrus_app_policy)]
fun foreign_registry_cap_precedes_missing_app_on_toggle() {
    let mut f = default_fixture(10, 20);
    f.next_tx!(ALICE, |f| { f.toggle(vector[false], true, b"missing".to_string()); });
    f.end();
}

#[test]
#[expected_failure(abort_code = policy::EUnchangedStatus, location = agent_vault::walrus_app_policy)]
fun toggle_rejects_the_same_active_status() {
    let mut f = default_fixture(10, 20);
    f.next_tx!(ALICE, |f| { f.toggle(vector[true], false, b"app".to_string()); });
    f.end();
}

#[test]
#[expected_failure(abort_code = policy::EUnchangedStatus, location = agent_vault::walrus_app_policy)]
fun toggle_rejects_the_same_disabled_status() {
    let mut f = default_fixture(10, 20);
    f.next_tx!(ALICE, |f| { f.toggle(vector[false, false], false, b"app".to_string()); });
    f.end();
}

#[test]
#[expected_failure(abort_code = policy::EAppNotFound, location = agent_vault::walrus_app_policy)]
fun toggle_rejects_a_missing_app_with_the_correct_cap() {
    let mut f = default_fixture(10, 20);
    f.next_tx!(ALICE, |f| { f.toggle(vector[false], false, b"missing".to_string()); });
    f.end();
}

#[test]
#[expected_failure(abort_code = policy::EWrongChannel, location = agent_vault::walrus_app_policy)]
fun payment_rejects_a_different_channel_before_zero_coin() {
    let mut f = default_fixture(10, 20);
    f.next_tx!(BOB, |f| { f.pay(b"app".to_string(), vector[0], true, false); });
    f.end();
}

#[test]
#[expected_failure(abort_code = policy::EWrongChannel, location = agent_vault::walrus_app_policy)]
fun payment_rejects_a_real_receipt_minted_for_another_channel() {
    let mut f = default_fixture(10, 20);
    f.next_tx!(BOB, |f| { f.pay(b"app".to_string(), vector[1], false, true); });
    f.end();
}

#[test]
#[expected_failure(abort_code = policy::ENotReceiptMember, location = agent_vault::walrus_app_policy)]
fun transferred_receipt_does_not_authorize_its_new_owner_even_when_a_live_member() {
    let mut f = default_fixture(10, 20);
    f.next_tx!(CAROL, |f| { let channel_id = f.channel_id; join_channel(f, channel_id); });
    f.next_tx!(BOB, |f| { transfer_receipt(f, CAROL); });
    f.next_tx!(CAROL, |f| { f.pay(b"app".to_string(), vector[1], false, false); });
    f.end();
}

#[test]
#[expected_failure(abort_code = policy::ENotReceiptMember, location = agent_vault::walrus_app_policy)]
fun wrong_sender_with_transferred_receipt_precedes_zero_payment() {
    let mut f = default_fixture(10, 20);
    f.next_tx!(BOB, |f| { transfer_receipt(f, CAROL); });
    f.next_tx!(CAROL, |f| { f.pay(b"app".to_string(), vector[0], false, false); });
    f.end();
}

#[test]
#[expected_failure(abort_code = policy::EAppDisabled, location = agent_vault::walrus_app_policy)]
fun disabled_app_precedes_wrong_channel_and_zero_payment() {
    let mut f = default_fixture(10, 20);
    f.next_tx!(ALICE, |f| { f.toggle(vector[false], false, b"app".to_string()); });
    f.next_tx!(BOB, |f| { f.pay(b"app".to_string(), vector[0], true, false); });
    f.end();
}

#[test]
#[expected_failure(abort_code = policy::EAppNotFound, location = agent_vault::walrus_app_policy)]
fun payment_rejects_a_missing_app_before_wrong_channel() {
    let mut f = default_fixture(10, 20);
    f.next_tx!(BOB, |f| { f.pay(b"missing".to_string(), vector[1], true, false); });
    f.end();
}

#[test]
#[expected_failure(abort_code = policy::EAppNotFound, location = agent_vault::walrus_app_policy)]
fun an_app_in_another_registry_does_not_authorize_payment() {
    let mut f = default_fixture(10, 20);
    f.next_tx!(BOB, |f| {
        let original = f.registry_id;
        f.registry_id = f.foreign_registry_id;
        f.pay(b"app".to_string(), vector[1], false, false);
        f.registry_id = original;
    });
    f.end();
}

// === Economic Boundary Tests ===

#[test]
#[expected_failure(abort_code = policy::EZeroPayment, location = agent_vault::walrus_app_policy)]
fun zero_coin_is_rejected_with_a_valid_real_receipt() {
    let mut f = default_fixture(10, 20);
    f.next_tx!(BOB, |f| { f.pay(b"app".to_string(), vector[0], false, false); });
    f.end();
}

#[test]
#[expected_failure(abort_code = policy::EExceededTxLimit, location = agent_vault::walrus_app_policy)]
fun first_amount_above_tx_limit_precedes_epoch_budget() {
    let mut f = default_fixture(10, 10);
    f.next_tx!(BOB, |f| { f.pay(b"app".to_string(), vector[11], false, false); });
    f.end();
}

#[test]
#[expected_failure(abort_code = policy::EExceededEpochBudget, location = agent_vault::walrus_app_policy)]
fun first_amount_above_epoch_budget_is_rejected() {
    let mut f = default_fixture(11, 10);
    f.next_tx!(BOB, |f| { f.pay(b"app".to_string(), vector[11], false, false); });
    f.end();
}

#[test]
#[expected_failure(abort_code = policy::EExceededEpochBudget, location = agent_vault::walrus_app_policy)]
fun repeated_payments_cannot_exceed_the_same_epoch_budget() {
    let mut f = default_fixture(10, 10);
    f.next_tx!(BOB, |f| { f.pay(b"app".to_string(), vector[6], false, false); });
    f.next_tx!(BOB, |f| { f.pay(b"app".to_string(), vector[5], false, false); });
    f.end();
}

#[test]
#[expected_failure(abort_code = policy::EExceededEpochBudget, location = agent_vault::walrus_app_policy)]
fun u64_max_spent_plus_one_raises_budget_error_without_arithmetic_overflow() {
    let mut f = default_fixture(std::u64::max_value!(), std::u64::max_value!());
    f.next_tx!(BOB, |f| { f.pay(b"app".to_string(), vector[std::u64::max_value!()], false, false); });
    f.next_tx!(BOB, |f| { f.pay(b"app".to_string(), vector[1], false, false); });
    f.end();
}

#[test]
#[expected_failure(abort_code = policy::EExceededEpochBudget, location = agent_vault::walrus_app_policy)]
fun epoch_budget_is_shared_by_different_legitimate_members() {
    let mut f = default_fixture(10, 10);
    f.next_tx!(BOB, |f| { f.pay(b"app".to_string(), vector[10], false, false); });
    f.next_tx!(CAROL, |f| { let channel_id = f.channel_id; f.receipt_id = join_channel(f, channel_id); });
    f.next_tx!(CAROL, |f| { f.pay(b"app".to_string(), vector[1], false, false); });
    f.end();
}

// === Registration and Capacity Tests ===

#[test]
#[expected_failure(abort_code = policy::EZeroStakeChannel, location = agent_vault::walrus_app_policy)]
fun zero_stake_channel_cannot_register_a_payment_policy() {
    let f = start_payment_fixture(0, 1, RECIPIENT, 10, 20, b"app".to_string());
    f.end();
}

#[test]
#[expected_failure(abort_code = policy::EInvalidMinStake, location = agent_vault::walrus_app_policy)]
fun zero_minimum_stake_is_rejected_before_registration() {
    let f = start_payment_fixture(STAKE, 0, RECIPIENT, 10, 20, b"app".to_string());
    f.end();
}

#[test]
#[expected_failure(abort_code = policy::EMinStakeTooHigh, location = agent_vault::walrus_app_policy)]
fun minimum_stake_cannot_exceed_the_real_channel_requirement() {
    let f = start_payment_fixture(STAKE, STAKE + 1, RECIPIENT, 10, 20, b"app".to_string());
    f.end();
}

#[test]
#[expected_failure(abort_code = policy::EInvalidRecipient, location = agent_vault::walrus_app_policy)]
fun zero_recipient_is_rejected() {
    let f = start_payment_fixture(STAKE, STAKE, @0x0, 10, 20, b"app".to_string());
    f.end();
}

#[test]
#[expected_failure(abort_code = policy::EInvalidMaxPayment, location = agent_vault::walrus_app_policy)]
fun zero_maximum_payment_is_rejected() {
    let f = start_payment_fixture(STAKE, STAKE, RECIPIENT, 0, 20, b"app".to_string());
    f.end();
}

#[test]
#[expected_failure(abort_code = policy::EInvalidEpochBudget, location = agent_vault::walrus_app_policy)]
fun zero_epoch_budget_is_rejected() {
    let f = start_payment_fixture(STAKE, STAKE, RECIPIENT, 10, 0, b"app".to_string());
    f.end();
}

#[test]
#[expected_failure(abort_code = policy::EInvalidBlobId, location = agent_vault::walrus_app_policy)]
fun empty_app_name_is_rejected() {
    let f = start_payment_fixture(STAKE, STAKE, RECIPIENT, 10, 20, b"".to_string());
    f.end();
}

#[test]
#[expected_failure(abort_code = policy::EInvalidBlobId, location = agent_vault::walrus_app_policy)]
fun first_name_byte_above_capacity_is_rejected() {
    let f = start_payment_fixture(STAKE, STAKE, RECIPIENT, 10, 20, std::string::utf8(vector::tabulate!(129, |_| 65)));
    f.end();
}

#[test]
fun maximum_name_and_app_count_remain_usable_and_bounded() {
    let mut f = default_fixture(10, 20);
    f.next_tx!(ALICE, |f| { fill_registry(f); });
    f.next_tx!(ALICE, |_f| {});
    assert_registry_capacity(&f);
    let name = std::string::utf8(vector::tabulate!(128, |_| 65));
    f.next_tx!(BOB, |f| { f.pay(name, vector[1], false, false); });
    f.next_tx!(RECIPIENT, |f| { assert_eq!(f.collect(), 1); });
    f.end();
}

#[test]
#[expected_failure(abort_code = policy::ERegistryFull, location = agent_vault::walrus_app_policy)]
fun first_app_above_capacity_is_rejected() {
    let mut f = default_fixture(10, 20);
    f.next_tx!(ALICE, |f| { fill_registry(f); });
    f.next_tx!(ALICE, |f| { register_another(f, b"overflow".to_string(), RECIPIENT, 1, 1, false); });
    f.end();
}

#[test]
#[expected_failure(abort_code = policy::EAlreadyRegistered, location = agent_vault::walrus_app_policy)]
fun duplicate_app_precedes_full_registry_error() {
    let mut f = default_fixture(10, 20);
    f.next_tx!(ALICE, |f| { fill_registry(f); });
    f.next_tx!(ALICE, |f| { register_another(f, b"app".to_string(), RECIPIENT, 1, 1, false); });
    f.end();
}

// === Fixture Types ===

public struct PaymentFixture {
    scenario: Scenario,
    registry_id: ID,
    foreign_registry_id: ID,
    cap_id: ID,
    foreign_cap_id: ID,
    channel_id: ID,
    foreign_channel_id: ID,
    receipt_id: ID,
    foreign_receipt_id: ID,
    registered: vector<PaymentAppRegistered>,
    statuses: vector<AppStatusChanged>,
    payments: vector<PaymentSent>,
}

// === Fixture Functions ===

macro fun fixture_ctx($self: &mut PaymentFixture): &mut TxContext {
    let self = $self;
    ts::ctx(&mut self.scenario)
}

macro fun fixture_next_tx($self: &mut PaymentFixture, $sender: address, $body: |&mut PaymentFixture|) {
    let self = $self;
    ts::next_tx(&mut self.scenario, $sender);
    $body(self);
    self.registered.append(sui::event::events_by_type<PaymentAppRegistered>());
    self.statuses.append(sui::event::events_by_type<AppStatusChanged>());
    self.payments.append(sui::event::events_by_type<PaymentSent>());
}

fun default_fixture(max_payment: u64, epoch_budget: u64): PaymentFixture {
    start_payment_fixture(STAKE, STAKE, RECIPIENT, max_payment, epoch_budget, b"app".to_string())
}

fun start_payment_fixture(required: u64, minimum: u64, recipient: address, max_payment: u64, epoch_budget: u64, blob_id: String): PaymentFixture {
    let mut scenario = ts::begin(ALICE);
    let channel_id = create_channel(&mut scenario, required, b"bound");
    let foreign_channel_id = create_channel(&mut scenario, STAKE, b"foreign");
    ts::next_tx(&mut scenario, ALICE);
    let (mut registry, cap) = policy::new(ts::ctx(&mut scenario));
    let registry_id = object::id(&registry);
    let cap_id = object::id(&cap);
    assert_eq!(cap.registry_id(), registry_id);
    assert_eq!(registry.total_apps(), 0);
    assert!(!registry.has_payment_app(blob_id));
    let (foreign_registry, foreign_cap) = policy::new(ts::ctx(&mut scenario));
    let foreign_registry_id = object::id(&foreign_registry);
    let foreign_cap_id = object::id(&foreign_cap);
    policy::share(foreign_registry);
    transfer::public_transfer(foreign_cap, ALICE);
    let channel = ts::take_shared_by_id<ChatChannel>(&scenario, channel_id);
    registry.register_payment_app(&cap, blob_id, &channel, minimum, recipient, max_payment, epoch_budget, ts::ctx(&mut scenario));
    let registered = sui::event::events_by_type<PaymentAppRegistered>();
    ts::return_shared(channel);
    policy::share(registry);
    transfer::public_transfer(cap, ALICE);
    ts::next_tx(&mut scenario, BOB);
    let mut f = PaymentFixture {
        scenario, registry_id, foreign_registry_id, cap_id, foreign_cap_id,
        channel_id, foreign_channel_id,
        receipt_id: object::id_from_address(@0x0), foreign_receipt_id: object::id_from_address(@0x0),
        registered, statuses: vector[], payments: vector[],
    };
    f.receipt_id = join_channel(&mut f, channel_id);
    f.foreign_receipt_id = join_channel(&mut f, foreign_channel_id);
    f.next_tx!(BOB, |_f| {});
    f
}

fun create_channel(scenario: &mut Scenario, stake: u64, name: vector<u8>): ID {
    let funding = coin::zero<SUI>(ts::ctx(scenario));
    chat::create_creator_monetized_channel(@0xDA0, name, funding, 0, stake, 0, 10_000, 0, ts::ctx(scenario))
}

fun join_channel(f: &mut PaymentFixture, channel_id: ID): ID {
    let mut channel = ts::take_shared_by_id<ChatChannel>(&f.scenario, channel_id);
    let mut funding = coin::mint_for_testing<SUI>(chat::required_member_stake(&channel), f.ctx!());
    let receipt = chat::join_channel_with_stake_and_fee(&mut channel, &mut funding, f.ctx!());
    coin::destroy_zero(funding);
    let id = object::id(&receipt);
    transfer::public_transfer(receipt, ts::sender(&f.scenario));
    ts::return_shared(channel);
    id
}

fun fixture_pay(f: &mut PaymentFixture, blob_id: String, amounts: vector<u64>, wrong_channel: bool, wrong_receipt: bool) {
    let mut registry = ts::take_shared_by_id<Registry>(&f.scenario, f.registry_id);
    let channel_id = if (wrong_channel) { f.foreign_channel_id } else { f.channel_id };
    let channel = ts::take_shared_by_id<ChatChannel>(&f.scenario, channel_id);
    let receipt_id = if (wrong_receipt) { f.foreign_receipt_id } else { f.receipt_id };
    let receipt = ts::take_from_sender_by_id<MemberStakeReceipt>(&f.scenario, receipt_id);
    let mut i = 0;
    while (i < amounts.length()) {
        let payment = coin::mint_for_testing<SUI>(amounts[i], f.ctx!());
        registry.pay(blob_id, &channel, &receipt, payment, f.ctx!());
        i = i + 1;
    };
    assert_eq!(object::id(&receipt), receipt_id);
    assert_eq!(chat::receipt_member(&receipt), ts::sender(&f.scenario));
    assert_eq!(chat::receipt_staked_amount(&receipt), chat::required_member_stake(&channel));
    ts::return_to_sender(&f.scenario, receipt);
    ts::return_shared(channel);
    ts::return_shared(registry);
}

fun fixture_toggle(f: &mut PaymentFixture, statuses: vector<bool>, foreign_cap: bool, blob_id: String) {
    let mut registry = ts::take_shared_by_id<Registry>(&f.scenario, f.registry_id);
    let cap_id = if (foreign_cap) { f.foreign_cap_id } else { f.cap_id };
    let cap = ts::take_from_sender_by_id<AdminCap>(&f.scenario, cap_id);
    statuses.do!(|active| registry.toggle_app_status(&cap, blob_id, active));
    ts::return_to_sender(&f.scenario, cap);
    ts::return_shared(registry);
}

fun register_another(f: &mut PaymentFixture, name: String, recipient: address, max_payment: u64, budget: u64, foreign_cap: bool) {
    let mut registry = ts::take_shared_by_id<Registry>(&f.scenario, f.registry_id);
    let cap_id = if (foreign_cap) { f.foreign_cap_id } else { f.cap_id };
    let cap = ts::take_from_sender_by_id<AdminCap>(&f.scenario, cap_id);
    let channel = ts::take_shared_by_id<ChatChannel>(&f.scenario, f.channel_id);
    registry.register_payment_app(&cap, name, &channel, STAKE, recipient, max_payment, budget, f.ctx!());
    ts::return_shared(channel);
    ts::return_to_sender(&f.scenario, cap);
    ts::return_shared(registry);
}

fun fill_registry(f: &mut PaymentFixture) {
    let mut registry = ts::take_shared_by_id<Registry>(&f.scenario, f.registry_id);
    let cap = ts::take_from_sender_by_id<AdminCap>(&f.scenario, f.cap_id);
    let channel = ts::take_shared_by_id<ChatChannel>(&f.scenario, f.channel_id);
    let mut i = 1u64;
    while (i < 128) {
        // Unique 128-byte UTF-8 keys exercise the full persistent input bound.
        let name = std::string::utf8(vector::tabulate!(128, |_| (i as u8)));
        registry.register_payment_app(&cap, name, &channel, STAKE, RECIPIENT, 1, 1, f.ctx!());
        i = i + 1;
    };
    ts::return_shared(channel);
    ts::return_to_sender(&f.scenario, cap);
    ts::return_shared(registry);
}

fun transfer_receipt(f: &mut PaymentFixture, to: address) {
    let receipt = ts::take_from_sender_by_id<MemberStakeReceipt>(&f.scenario, f.receipt_id);
    transfer::public_transfer(receipt, to);
}

fun fixture_leave(f: &mut PaymentFixture): u64 {
    let mut channel = ts::take_shared_by_id<ChatChannel>(&f.scenario, f.channel_id);
    let receipt = ts::take_from_sender_by_id<MemberStakeReceipt>(&f.scenario, f.receipt_id);
    // Consumption is the VM proof: no receipt value remains that could be borrowed for pay.
    let refund = chat::member_unstake_and_leave(&mut channel, receipt, f.ctx!());
    let amount = refund.value();
    transfer::public_transfer(refund, ts::sender(&f.scenario));
    ts::return_shared(channel);
    amount
}

fun fixture_collect(f: &PaymentFixture): u64 {
    let mut total = 0;
    while (ts::has_most_recent_for_sender<Coin<SUI>>(&f.scenario)) {
        total = total + coin::burn_for_testing(ts::take_from_sender<Coin<SUI>>(&f.scenario));
    };
    total
}

fun advance_epoch(f: &mut PaymentFixture, sender: address) {
    ts::next_epoch(&mut f.scenario, sender);
}

fun fixture_end(f: PaymentFixture) {
    let PaymentFixture { scenario, registry_id: _, foreign_registry_id: _, cap_id: _, foreign_cap_id: _,
        channel_id: _, foreign_channel_id: _, receipt_id: _, foreign_receipt_id: _,
        registered: _, statuses: _, payments: _ } = f;
    ts::end(scenario);
}

// === State and Event Assertions ===

fun assert_accounting(f: &PaymentFixture, spent: u64, epoch: u64, active: bool) {
    let registry = ts::take_shared_by_id<Registry>(&f.scenario, f.registry_id);
    let app = registry.payment_app(b"app".to_string());
    assert_eq!(app.channel_id(), f.channel_id);
    assert!(app.min_member_stake() > 0 && app.min_member_stake() <= STAKE);
    assert_eq!(app.recipient(), RECIPIENT);
    assert_eq!(app.spent_in_epoch(), spent);
    assert_eq!(app.last_payment_epoch(), epoch);
    assert_eq!(app.is_active(), active);
    ts::return_shared(registry);
}

fun assert_membership_principal(f: &PaymentFixture, member: bool, principal: u64) {
    let channel = ts::take_shared_by_id<ChatChannel>(&f.scenario, f.channel_id);
    assert_eq!(chat::is_member(&channel, BOB), member);
    assert_eq!(chat::members_staked_pool(&channel), principal);
    if (!member) {
        assert!(!ts::ids_for_address<MemberStakeReceipt>(BOB).contains(&f.receipt_id));
    };
    ts::return_shared(channel);
}

fun assert_registration(f: &PaymentFixture, minimum: u64, recipient: address, maximum: u64, budget: u64) {
    assert_eq!(f.registered.length(), 1);
    let (registry, name, channel, min_stake, to, max_payment, epoch_budget, epoch) = policy::registered_fields(&f.registered[0]);
    assert_eq!(registry, f.registry_id);
    assert_eq!(name, b"app".to_string());
    assert_eq!(channel, f.channel_id);
    assert_eq!(min_stake, minimum);
    assert_eq!(to, recipient);
    assert_eq!(max_payment, maximum);
    assert_eq!(epoch_budget, budget);
    assert_eq!(epoch, 0);
    let registry = ts::take_shared_by_id<Registry>(&f.scenario, f.registry_id);
    let app = registry.payment_app(name);
    assert_eq!(registry.total_apps(), 1);
    assert!(registry.has_payment_app(name));
    assert!(!registry.has_payment_app(b"missing".to_string()));
    assert!(!registry.has_payment_app(b"".to_string()));
    assert_eq!(app.min_member_stake(), minimum);
    assert_eq!(app.max_payment(), maximum);
    assert_eq!(app.epoch_budget(), budget);
    ts::return_shared(registry);
}

fun assert_statuses(f: &PaymentFixture, expected: vector<bool>) {
    assert_eq!(f.statuses.length(), expected.length());
    let mut previous = true;
    let mut i = 0;
    while (i < expected.length()) {
        let (registry, name, old, active) = policy::status_fields(&f.statuses[i]);
        assert_eq!(registry, f.registry_id);
        assert_eq!(name, b"app".to_string());
        assert_eq!(old, previous);
        assert_eq!(active, expected[i]);
        previous = active;
        i = i + 1;
    };
}

fun assert_payments(f: &PaymentFixture, blob_id: String, amounts: vector<u64>, epochs: vector<u64>, totals: vector<u64>) {
    assert_eq!(f.payments.length(), amounts.length());
    let mut running = 0;
    let mut previous_epoch = 0;
    let mut i = 0;
    while (i < amounts.length()) {
        let (registry, name, channel, receipt, recipient, amount, epoch, spent) = policy::payment_fields(&f.payments[i]);
        assert_eq!(registry, f.registry_id);
        assert_eq!(name, blob_id);
        assert_eq!(channel, f.channel_id);
        assert_eq!(receipt, f.receipt_id);
        assert_eq!(recipient, RECIPIENT);
        assert_eq!(amount, amounts[i]);
        assert_eq!(epoch, epochs[i]);
        if (epoch != previous_epoch) { running = 0; };
        running = running + amount;
        assert_eq!(spent, totals[i]);
        assert_eq!(spent, running);
        previous_epoch = epoch;
        i = i + 1;
    };
    assert_accounting(f, running, previous_epoch, true);
}

fun assert_registry_capacity(f: &PaymentFixture) {
    let registry = ts::take_shared_by_id<Registry>(&f.scenario, f.registry_id);
    assert_eq!(registry.total_apps(), 128);
    let mut i = 1u64;
    while (i < 128) {
        let name = std::string::utf8(vector::tabulate!(128, |_| (i as u8)));
        let app = registry.payment_app(name);
        assert_eq!(app.channel_id(), f.channel_id);
        assert_eq!(app.recipient(), RECIPIENT);
        assert_eq!(app.max_payment(), 1);
        assert_eq!(app.epoch_budget(), 1);
        assert_eq!(app.spent_in_epoch(), 0);
        assert!(app.is_active());
        i = i + 1;
    };
    // The parent stays small; each bounded policy is a dynamic child of its table.
    assert!(bcs::to_bytes(&registry).length() < 256);
    ts::return_shared(registry);
}
