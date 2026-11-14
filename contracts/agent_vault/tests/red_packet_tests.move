#[test_only]
module agent_vault::red_packet_tests;

use std::{bcs, string::{Self, String}, unit_test::{assert_eq, destroy}};
use sui::{
    clock::{Self, Clock},
    coin::{Self, Coin},
    random::{Self, Random},
    sui::SUI,
    test_scenario::{Self as ts, Scenario},
};
use agent_vault::{
    onchain_chat::{Self, ChatChannel},
    red_packet::{Self as packet, RedPacket, Created, Claimed, Refunded},
};

use fun fixture_next_tx as PacketFixture.next_tx;
use fun fixture_create as PacketFixture.create;
use fun fixture_claim as PacketFixture.claim;
use fun fixture_refund as PacketFixture.refund;
use fun fixture_time as PacketFixture.time;
use fun fixture_snapshot as PacketFixture.snapshot;
use fun fixture_collect as PacketFixture.collect;
use fun fixture_claimed_amount as PacketFixture.claimed_amount;
use fun fixture_seed as PacketFixture.seed;
use fun fixture_join as PacketFixture.join;
use fun fixture_leave as PacketFixture.leave;
use fun fixture_end as PacketFixture.end;

// === Constants ===

const ALICE: address = @0xA11CE;
const BOB: address = @0xB0B;
const CAROL: address = @0xCA401;
const EVE: address = @0xE7E;
const START: u64 = 1_000;
const EXPIRY: u64 = 2_000;

// === Lifecycle and Accounting Tests ===

#[test]
fun equal_claims_conserve_last_unit_and_replay_every_event_field() {
    let mut f = start_fixture<SUI>(10, 3, false, b"good luck".to_string(), 1_000);
    f.next_tx!(BOB, |f| { f.claim(false, false); });
    f.next_tx!(BOB, |f| { assert_eq!(f.collect(), 4); });
    f.next_tx!(CAROL, |f| { f.claim(false, false); });
    f.next_tx!(CAROL, |f| { assert_eq!(f.collect(), 3); });
    f.next_tx!(ALICE, |f| {
        f.time(EXPIRY);
        f.claim(false, false);
    });
    f.next_tx!(ALICE, |f| { assert_eq!(f.collect(), 3); });
    let s = f.snapshot();
    assert_eq!(packet::snapshot_creator(&s), ALICE);
    assert_eq!(packet::snapshot_greeting(&s), b"good luck".to_string());
    assert_eq!(packet::snapshot_initial_amount(&s), 10);
    assert_eq!(packet::snapshot_count(&s), 3);
    assert_eq!(packet::snapshot_is_random(&s), false);
    assert_eq!(packet::snapshot_expiry(&s), EXPIRY);
    assert_eq!(packet::snapshot_claimed_count(&s), 3);
    assert_eq!(packet::snapshot_remaining_balance(&s), 0);
    assert_eq!(packet::snapshot_refunded_amount(&s), 0);
    f.next_tx!(ALICE, |_f| {});
    assert_replay(&f, vector[BOB, CAROL, ALICE], vector[4, 3, 3], vector[START, START, EXPIRY], 0);
    f.end();
}

#[test]
fun generic_coin_random_claims_and_partial_refund_conserve_and_replay() {
    let mut f = start_fixture<TestCoin>(std::u64::max_value!(), 3, true, b"generic".to_string(), 1_000);
    f.next_tx!(@0x0, |f| { f.seed(7); });
    f.next_tx!(BOB, |f| { f.claim(true, false); });
    let first = f.claimed_amount(0);
    assert!(first > 0 && first <= std::u64::max_value!() - 2);
    f.next_tx!(BOB, |f| { assert_eq!(f.collect(), first); });
    f.next_tx!(CAROL, |f| { f.claim(true, false); });
    let second = f.claimed_amount(1);
    assert!(second > 0 && second < std::u64::max_value!() - first);
    f.next_tx!(CAROL, |f| { assert_eq!(f.collect(), second); });
    f.next_tx!(ALICE, |f| {
        f.time(EXPIRY + 1);
        f.refund();
    });
    let residual = std::u64::max_value!() - first - second;
    f.next_tx!(ALICE, |f| { assert_eq!(f.collect(), residual); });
    assert_eq!(first + second + residual, std::u64::max_value!());
    assert_replay(&f, vector[BOB, CAROL], vector[first, second], vector[START, START], residual);
    f.end();
}

#[test]
fun random_final_claim_takes_all_dust() {
    let mut f = start_fixture<SUI>(13, 3, true, b"".to_string(), 1_000);
    f.next_tx!(@0x0, |f| { f.seed(19); });
    f.next_tx!(BOB, |f| { f.claim(true, false); });
    let first = f.claimed_amount(0);
    f.next_tx!(BOB, |f| { assert_eq!(f.collect(), first); });
    f.next_tx!(CAROL, |f| { f.claim(true, false); });
    let second = f.claimed_amount(1);
    f.next_tx!(CAROL, |f| { assert_eq!(f.collect(), second); });
    f.next_tx!(ALICE, |f| { f.claim(true, false); });
    let third = f.claimed_amount(2);
    f.next_tx!(ALICE, |f| { assert_eq!(f.collect(), third); });
    assert!(first > 0 && second > 0 && third > 0);
    assert_eq!(first + second + third, 13);
    assert_replay(&f, vector[BOB, CAROL, ALICE], vector[first, second, third], vector[START, START, START], 0);
    f.end();
}

#[test]
fun random_one_unit_per_recipient_and_single_claim_are_total() {
    let mut f = start_fixture<SUI>(2, 2, true, b"".to_string(), 1_000);
    f.next_tx!(BOB, |f| { f.claim(true, false); });
    f.next_tx!(BOB, |f| { assert_eq!(f.collect(), 1); });
    f.next_tx!(ALICE, |f| { f.claim(true, false); });
    f.next_tx!(ALICE, |f| { assert_eq!(f.collect(), 1); });
    assert_replay(&f, vector[BOB, ALICE], vector[1, 1], vector[START, START], 0);
    f.end();
}

#[test]
fun one_claim_random_packet_transfers_u64_max_without_intermediate_overflow() {
    let mut f = start_fixture<SUI>(std::u64::max_value!(), 1, true, b"".to_string(), 1_000);
    f.next_tx!(BOB, |f| { f.claim(true, false); });
    f.next_tx!(BOB, |f| { assert_eq!(f.collect(), std::u64::max_value!()); });
    f.end();
}

#[test]
fun creator_can_refund_after_leaving_the_channel() {
    let mut f = start_fixture<SUI>(9, 2, true, b"".to_string(), 1_000);
    f.next_tx!(EVE, |f| { f.join(); });
    f.next_tx!(EVE, |f| {
        // A joined member funds a second packet; original fixture packet is harmless.
        f.create(9, 2, true, b"left".to_string(), 1_000);
    });
    f.next_tx!(EVE, |f| { f.leave(); });
    f.next_tx!(EVE, |f| {
        f.time(EXPIRY + 1);
        f.refund();
    });
    f.next_tx!(EVE, |f| { assert_eq!(f.collect(), 9); });
    f.end();
}

#[test]
fun late_joiner_is_eligible_using_live_membership() {
    let mut f = start_fixture<SUI>(9, 2, false, b"".to_string(), 1_000);
    f.next_tx!(EVE, |f| { f.join(); });
    f.next_tx!(EVE, |f| { f.claim(false, false); });
    f.next_tx!(EVE, |f| { assert_eq!(f.collect(), 5); });
    f.end();
}

#[test]
fun max_count_greeting_and_duration_bound_state_and_work() {
    let mut f = start_fixture<TestCoin>(128, 128, true, string::utf8(vector::tabulate!(256, |_| 65)), 604_800_000);
    let mut recipients = vector[];
    let mut amounts = vector[];
    let mut timestamps = vector[];
    let mut i = 0u64;
    while (i < 128) {
        let recipient = sui::address::from_u256((10_000 + i) as u256);
        f.next_tx!(recipient, |f| { f.claim(true, false); });
        f.next_tx!(recipient, |f| { assert_eq!(f.collect(), 1); });
        recipients.push_back(recipient);
        amounts.push_back(1);
        timestamps.push_back(START);
        i = i + 1;
    };
    assert_replay(&f, recipients, amounts, timestamps, 0);
    f.next_tx!(ALICE, |_f| {});
    let p = ts::take_shared_by_id<RedPacket<TestCoin>>(&f.scenario, f.packet_id);
    // Actual BCS size, including maximum inline records, is comfortably below 8 KiB.
    assert!(bcs::to_bytes(&p).length() < 8_192);
    ts::return_shared(p);
    f.end();
}

// === Exact Failure and Guard Precedence Tests ===

#[test]
#[expected_failure(abort_code = packet::EInvalidCount, location = agent_vault::red_packet)]
fun zero_count_precedes_empty_funding() {
    let f = start_fixture<SUI>(0, 0, false, b"".to_string(), 1_000);
    f.end();
}

#[test]
#[expected_failure(abort_code = packet::EInvalidCount, location = agent_vault::red_packet)]
fun count_first_above_capacity_is_rejected() {
    let f = start_fixture<SUI>(129, 129, false, b"".to_string(), 1_000);
    f.end();
}

#[test]
#[expected_failure(abort_code = packet::EGreetingTooLong, location = agent_vault::red_packet)]
fun greeting_first_byte_above_capacity_precedes_bad_duration() {
    let f = start_fixture<SUI>(1, 1, false, string::utf8(vector::tabulate!(257, |_| 65)), 0);
    f.end();
}

#[test]
#[expected_failure(abort_code = packet::EInvalidDuration, location = agent_vault::red_packet)]
fun zero_duration_precedes_insufficient_funding() {
    let f = start_fixture<SUI>(0, 1, false, b"".to_string(), 0);
    f.end();
}

#[test]
#[expected_failure(abort_code = packet::EInvalidDuration, location = agent_vault::red_packet)]
fun duration_first_above_seven_days_is_rejected() {
    let f = start_fixture<SUI>(1, 1, false, b"".to_string(), 604_800_001);
    f.end();
}

#[test]
#[expected_failure(abort_code = packet::EInsufficientAmount, location = agent_vault::red_packet)]
fun funding_must_reserve_one_unit_per_claim() {
    let f = start_fixture<SUI>(2, 3, true, b"".to_string(), 1_000);
    f.end();
}

#[test]
#[expected_failure(abort_code = packet::EExpiryOverflow, location = agent_vault::red_packet)]
fun expiry_overflow_is_a_domain_error_before_funding() {
    let mut f = start_fixture<SUI>(1, 1, false, b"".to_string(), 1_000);
    f.next_tx!(ALICE, |f| {
        f.time(std::u64::max_value!());
        f.create(0, 1, false, b"".to_string(), 1);
    });
    f.end();
}

#[test]
#[expected_failure(abort_code = packet::ENotMember, location = agent_vault::red_packet)]
fun creation_membership_precedes_invalid_count() {
    let mut f = start_fixture<SUI>(1, 1, false, b"".to_string(), 1_000);
    f.next_tx!(EVE, |f| { f.create(0, 0, false, b"".to_string(), 0); });
    f.end();
}

#[test]
#[expected_failure(abort_code = packet::EChannelMismatch, location = agent_vault::red_packet)]
fun attacker_owned_channel_cannot_authorize_claim_and_mismatch_precedes_membership() {
    let mut f = start_fixture<SUI>(9, 2, true, b"".to_string(), 1_000);
    f.next_tx!(EVE, |f| { f.claim(true, true); });
    f.end();
}

#[test]
#[expected_failure(abort_code = packet::EChannelMismatch, location = agent_vault::red_packet)]
fun membership_in_both_channels_cannot_substitute_channel() {
    let mut f = start_fixture<SUI>(9, 2, false, b"".to_string(), 1_000);
    f.next_tx!(BOB, |f| { f.claim(false, true); });
    f.end();
}

#[test]
#[expected_failure(abort_code = packet::EChannelMismatch, location = agent_vault::red_packet)]
fun channel_binding_precedes_expiry() {
    let mut f = start_fixture<SUI>(9, 2, true, b"".to_string(), 1_000);
    f.next_tx!(EVE, |f| { f.time(EXPIRY + 1); f.claim(true, true); });
    f.end();
}

#[test]
#[expected_failure(abort_code = packet::ENotMember, location = agent_vault::red_packet)]
fun nonmember_precedes_expiry() {
    let mut f = start_fixture<SUI>(9, 2, true, b"".to_string(), 1_000);
    f.next_tx!(EVE, |f| { f.time(EXPIRY + 1); f.claim(true, false); });
    f.end();
}

#[test]
#[expected_failure(abort_code = packet::ENotMember, location = agent_vault::red_packet)]
fun member_who_leaves_loses_claim_authority() {
    let mut f = start_fixture<SUI>(9, 2, true, b"".to_string(), 1_000);
    f.next_tx!(EVE, |f| { f.join(); });
    f.next_tx!(EVE, |f| { f.leave(); });
    f.next_tx!(EVE, |f| { f.claim(true, false); });
    f.end();
}

#[test]
#[expected_failure(abort_code = packet::EAlreadyClaimed, location = agent_vault::red_packet)]
fun random_duplicate_claim_is_rejected_with_balance_remaining() {
    let mut f = start_fixture<SUI>(9, 2, true, b"".to_string(), 1_000);
    f.next_tx!(BOB, |f| { f.claim(true, false); });
    f.next_tx!(BOB, |f| { f.claim(true, false); });
    f.end();
}

#[test]
#[expected_failure(abort_code = packet::EAlreadyClaimed, location = agent_vault::red_packet)]
fun equal_duplicate_claim_is_rejected_with_balance_remaining() {
    let mut f = start_fixture<SUI>(9, 2, false, b"".to_string(), 1_000);
    f.next_tx!(BOB, |f| { f.claim(false, false); });
    f.next_tx!(BOB, |f| { f.claim(false, false); });
    f.end();
}

#[test]
#[expected_failure(abort_code = packet::EExpired, location = agent_vault::red_packet)]
fun first_millisecond_after_expiry_rejects_claim_before_duplicate() {
    let mut f = start_fixture<SUI>(9, 2, true, b"".to_string(), 1_000);
    f.next_tx!(BOB, |f| { f.claim(true, false); });
    f.next_tx!(BOB, |f| { f.time(EXPIRY + 1); f.claim(true, false); });
    f.end();
}

#[test]
#[expected_failure(abort_code = packet::EExhausted, location = agent_vault::red_packet)]
fun exhaustion_precedes_duplicate() {
    let mut f = start_fixture<SUI>(1, 1, true, b"".to_string(), 1_000);
    f.next_tx!(BOB, |f| { f.claim(true, false); });
    f.next_tx!(BOB, |f| { f.claim(true, false); });
    f.end();
}

#[test]
#[expected_failure(abort_code = packet::EWrongAllocation, location = agent_vault::red_packet)]
fun equal_endpoint_cannot_predictably_withdraw_random_packet_and_mode_precedes_channel() {
    let mut f = start_fixture<SUI>(9, 2, true, b"".to_string(), 1_000);
    f.next_tx!(EVE, |f| { f.claim(false, true); });
    f.end();
}

#[test]
#[expected_failure(abort_code = packet::EWrongAllocation, location = agent_vault::red_packet)]
fun random_endpoint_cannot_reprice_equal_packet() {
    let mut f = start_fixture<SUI>(9, 2, false, b"".to_string(), 1_000);
    f.next_tx!(BOB, |f| { f.claim(true, false); });
    f.end();
}

#[test]
#[expected_failure(abort_code = packet::ENotCreator, location = agent_vault::red_packet)]
fun third_party_refund_rejected_before_time_check() {
    let mut f = start_fixture<SUI>(9, 2, false, b"".to_string(), 1_000);
    f.next_tx!(BOB, |f| { f.refund(); });
    f.end();
}

#[test]
#[expected_failure(abort_code = packet::ENotExpired, location = agent_vault::red_packet)]
fun refund_is_rejected_at_exact_expiry() {
    let mut f = start_fixture<SUI>(9, 2, false, b"".to_string(), 1_000);
    f.next_tx!(ALICE, |f| { f.time(EXPIRY); f.refund(); });
    f.end();
}

#[test]
#[expected_failure(abort_code = packet::ERefunded, location = agent_vault::red_packet)]
fun refunded_lifecycle_precedes_mode_channel_membership_and_time() {
    let mut f = start_fixture<SUI>(9, 2, true, b"".to_string(), 1_000);
    f.next_tx!(ALICE, |f| { f.time(EXPIRY + 1); f.refund(); });
    f.next_tx!(EVE, |f| { f.claim(false, true); });
    f.end();
}

#[test]
#[expected_failure(abort_code = packet::ERefunded, location = agent_vault::red_packet)]
fun refunded_lifecycle_precedes_refund_authority() {
    let mut f = start_fixture<SUI>(9, 2, true, b"".to_string(), 1_000);
    f.next_tx!(ALICE, |f| { f.time(EXPIRY + 1); f.refund(); });
    f.next_tx!(EVE, |f| { f.refund(); });
    f.end();
}

#[test]
#[expected_failure(abort_code = packet::EExhausted, location = agent_vault::red_packet)]
fun creator_cannot_refund_exhausted_escrow() {
    let mut f = start_fixture<SUI>(1, 1, false, b"".to_string(), 1_000);
    f.next_tx!(BOB, |f| { f.claim(false, false); });
    f.next_tx!(ALICE, |f| { f.time(EXPIRY + 1); f.refund(); });
    f.end();
}

// === Boundary and Selection Tests ===

#[test]
fun first_millisecond_duration_and_equal_one_unit_packet_are_supported() {
    let mut f = start_fixture<SUI>(1, 1, false, b"".to_string(), 1);
    f.next_tx!(BOB, |f| { f.time(START + 1); f.claim(false, false); });
    f.next_tx!(BOB, |f| { assert_eq!(f.collect(), 1); });
    f.end();
}

#[test]
#[expected_failure(abort_code = packet::ENotExpired, location = agent_vault::red_packet)]
fun refund_before_expiry_is_rejected() {
    let mut f = start_fixture<SUI>(1, 1, false, b"".to_string(), 1_000);
    f.next_tx!(ALICE, |f| { f.time(EXPIRY - 1); f.refund(); });
    f.end();
}

#[test]
#[expected_failure(abort_code = packet::ERefunded, location = agent_vault::red_packet)]
fun creator_cannot_refund_twice() {
    let mut f = start_fixture<SUI>(1, 1, false, b"".to_string(), 1_000);
    f.next_tx!(ALICE, |f| { f.time(EXPIRY + 1); f.refund(); });
    f.next_tx!(ALICE, |f| { f.refund(); });
    f.end();
}

#[test]
fun full_packet_can_refund_all_unclaimed_funds() {
    let mut f = start_fixture<SUI>(128, 128, true, b"".to_string(), 1_000);
    f.next_tx!(ALICE, |f| { f.time(EXPIRY + 1); f.refund(); });
    f.next_tx!(ALICE, |f| { assert_eq!(f.collect(), 128); });
    assert_replay(&f, vector[], vector[], vector[], 128);
    f.end();
}

#[test]
fun entropy_changes_payouts_without_creator_presampling() {
    let mut f = start_fixture<SUI>(std::u64::max_value!(), 3, true, b"".to_string(), 1_000);
    f.next_tx!(@0x0, |f| { f.seed(0); });
    f.next_tx!(BOB, |f| { f.claim(true, false); });
    let first = f.claimed_amount(0);
    f.next_tx!(BOB, |f| { assert_eq!(f.collect(), first); });
    f.next_tx!(ALICE, |f| { f.create(std::u64::max_value!(), 3, true, b"".to_string(), 1_000); });
    f.next_tx!(@0x0, |f| { f.seed(255); });
    f.next_tx!(BOB, |f| { f.claim(true, false); });
    let second = f.claimed_amount(1);
    f.next_tx!(BOB, |f| { assert_eq!(f.collect(), second); });
    assert!(first != second);
    f.end();
}

// === Random Resource Profiles ===

// Identical pre-state, fixed-size different entropy, identical instructions and resource counts.
// Compare these named tests' instruction gas under `sui move test ... --statistics`.
#[test]
fun random_resource_profile_seed_zero() { random_resource_profile(0); }

#[test]
fun random_resource_profile_seed_ff() { random_resource_profile(255); }

// === Fixture Types ===

public struct TestCoin has drop {}

public struct PacketFixture<phantom CoinType> {
    scenario: Scenario,
    clock: Clock,
    channel_id: ID,
    foreign_channel_id: ID,
    packet_id: ID,
    receipt: Option<onchain_chat::MemberStakeReceipt>,
    random_round: u64,
    created_count: u64,
    transferred_count: u64,
    event_count: u64,
    created_events: vector<Created<CoinType>>,
    claimed_events: vector<Claimed<CoinType>>,
    refunded_events: vector<Refunded<CoinType>>,
}

// === Fixture Functions ===

macro fun fixture_next_tx<$CoinType>(
    $self: &mut PacketFixture<$CoinType>, $sender: address, $body: |&mut PacketFixture<$CoinType>|,
) {
    let self = $self;
    let effects = ts::next_tx(&mut self.scenario, $sender);
    self.created_count = effects.created().length();
    self.transferred_count = effects.transferred_to_account().length();
    self.event_count = effects.num_user_events();
    $body(self);
    self.created_events.append(sui::event::events_by_type<Created<$CoinType>>());
    self.claimed_events.append(sui::event::events_by_type<Claimed<$CoinType>>());
    self.refunded_events.append(sui::event::events_by_type<Refunded<$CoinType>>());
}

macro fun fixture_ctx<$CoinType>($self: &mut PacketFixture<$CoinType>): &mut TxContext {
    let self = $self;
    ts::ctx(&mut self.scenario)
}

fun start_fixture<CoinType>(amount: u64, count: u64, is_random: bool, greeting: String, duration: u64): PacketFixture<CoinType> {
    let mut scenario = ts::begin(@0x0);
    random::create_for_testing(ts::ctx(&mut scenario));
    let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));
    clock::set_for_testing(&mut clock, START);
    ts::next_tx(&mut scenario, ALICE);
    let mut members = vector[BOB, CAROL];
    let mut i = 0u64;
    while (count == 128 && i < 128) {
        members.push_back(sui::address::from_u256((10_000 + i) as u256));
        i = i + 1;
    };
    let channel_id = onchain_chat::create_channel(@0xDA0, b"bound", members, ts::ctx(&mut scenario));
    ts::next_tx(&mut scenario, EVE);
    let foreign_channel_id = onchain_chat::create_channel(@0xDA0, b"attacker", vector[BOB], ts::ctx(&mut scenario));
    ts::next_tx(&mut scenario, ALICE);
    let mut self = PacketFixture {
        scenario, clock, channel_id, foreign_channel_id, packet_id: object::id_from_address(@0x0),
        receipt: option::none(), random_round: 0,
        created_count: 0, transferred_count: 0, event_count: 0,
        created_events: vector[], claimed_events: vector[], refunded_events: vector[],
    };
    self.create(amount, count, is_random, greeting, duration);
    self.created_events.append(sui::event::events_by_type<Created<CoinType>>());
    self.next_tx!(ALICE, |_f| {});
    self
}

fun fixture_create<CoinType>(self: &mut PacketFixture<CoinType>, amount: u64, count: u64, is_random: bool, greeting: String, duration: u64) {
    let channel = ts::take_shared_by_id<ChatChannel>(&self.scenario, self.channel_id);
    let funding = coin::mint_for_testing<CoinType>(amount, fixture_ctx!(self));
    self.packet_id = packet::create(&channel, funding, count, is_random, greeting, duration, &self.clock, ts::ctx(&mut self.scenario));
    ts::return_shared(channel);
}

fun fixture_claim<CoinType>(self: &mut PacketFixture<CoinType>, is_random: bool, foreign: bool) {
    let mut p = ts::take_shared_by_id<RedPacket<CoinType>>(&self.scenario, self.packet_id);
    let channel_id = if (foreign) { self.foreign_channel_id } else { self.channel_id };
    let channel = ts::take_shared_by_id<ChatChannel>(&self.scenario, channel_id);
    if (is_random) {
        let random = ts::take_shared<Random>(&self.scenario);
        packet::claim_random_for_testing(&mut p, &channel, &self.clock, &random, ts::ctx(&mut self.scenario));
        ts::return_shared(random);
    } else {
        packet::claim_equal_for_testing(&mut p, &channel, &self.clock, ts::ctx(&mut self.scenario));
    };
    ts::return_shared(channel);
    ts::return_shared(p);
}

fun fixture_refund<CoinType>(self: &mut PacketFixture<CoinType>) {
    let mut p = ts::take_shared_by_id<RedPacket<CoinType>>(&self.scenario, self.packet_id);
    packet::refund_for_testing(&mut p, &self.clock, ts::ctx(&mut self.scenario));
    ts::return_shared(p);
}

fun fixture_time<CoinType>(self: &mut PacketFixture<CoinType>, now: u64) {
    clock::set_for_testing(&mut self.clock, now);
}

fun fixture_snapshot<CoinType>(self: &PacketFixture<CoinType>): packet::Snapshot {
    let p = ts::take_shared_by_id<RedPacket<CoinType>>(&self.scenario, self.packet_id);
    let snapshot = packet::snapshot_for_testing(&p);
    ts::return_shared(p);
    snapshot
}

fun fixture_collect<CoinType>(self: &PacketFixture<CoinType>): u64 {
    let payment = ts::take_from_sender<Coin<CoinType>>(&self.scenario);
    coin::burn_for_testing(payment)
}

fun fixture_seed<CoinType>(self: &mut PacketFixture<CoinType>, seed: u8) {
    let mut random = ts::take_shared<Random>(&self.scenario);
    random::update_randomness_state_for_testing(&mut random, self.random_round, vector::tabulate!(32, |_| seed), fixture_ctx!(self));
    self.random_round = self.random_round + 1;
    ts::return_shared(random);
}

fun fixture_join<CoinType>(self: &mut PacketFixture<CoinType>) {
    let mut channel = ts::take_shared_by_id<ChatChannel>(&self.scenario, self.channel_id);
    let mut funding = coin::zero<SUI>(fixture_ctx!(self));
    let receipt = onchain_chat::join_channel_with_stake_and_fee(&mut channel, &mut funding, fixture_ctx!(self));
    self.receipt.fill(receipt);
    coin::destroy_zero(funding);
    ts::return_shared(channel);
}

fun fixture_leave<CoinType>(self: &mut PacketFixture<CoinType>) {
    let mut channel = ts::take_shared_by_id<ChatChannel>(&self.scenario, self.channel_id);
    let receipt = self.receipt.extract();
    let residual = onchain_chat::member_unstake_and_leave(&mut channel, receipt, fixture_ctx!(self));
    coin::destroy_zero(residual);
    ts::return_shared(channel);
}

fun fixture_end<CoinType>(self: PacketFixture<CoinType>) {
    let PacketFixture { scenario, clock, receipt, .. } = self;
    if (receipt.is_some()) { destroy(receipt.destroy_some()); } else { receipt.destroy_none(); };
    clock::destroy_for_testing(clock);
    ts::end(scenario);
}

fun fixture_claimed_amount<CoinType>(self: &PacketFixture<CoinType>, index: u64): u64 {
    let fields = packet::claimed_fields(self.claimed_events[index]);
    packet::claimed_amount(&fields)
}

fun assert_replay<CoinType>(self: &PacketFixture<CoinType>, recipients: vector<address>, amounts: vector<u64>, timestamps: vector<u64>, refunded: u64) {
    let created = &self.created_events;
    assert_eq!(created.length(), 1);
    let created_fields = packet::created_fields(created[0]);
    let id = packet::created_packet(&created_fields);
    let channel = packet::created_channel(&created_fields);
    let initial = packet::created_amount(&created_fields);
    let count = packet::created_count(&created_fields);
    let random_mode = packet::created_is_random(&created_fields);
    let greeting = packet::created_greeting(&created_fields);
    let expiry = packet::created_expiry(&created_fields);
    assert_eq!(id, self.packet_id);
    assert_eq!(channel, self.channel_id);
    let p = ts::take_shared_by_id<RedPacket<CoinType>>(&self.scenario, self.packet_id);
    let s = packet::snapshot_for_testing(&p);
    assert_eq!(packet::snapshot_channel(&s), channel);
    assert_eq!(packet::snapshot_creator(&s), ALICE);
    assert_eq!(packet::snapshot_greeting(&s), greeting);
    assert_eq!(packet::snapshot_initial_amount(&s), initial);
    assert_eq!(packet::snapshot_count(&s), count);
    assert_eq!(packet::snapshot_is_random(&s), random_mode);
    assert_eq!(packet::snapshot_expiry(&s), expiry);
    let events = &self.claimed_events;
    assert_eq!(events.length(), amounts.length());
    assert_eq!(recipients.length(), amounts.length());
    assert_eq!(timestamps.length(), amounts.length());
    assert_eq!(packet::snapshot_claimed_count(&s), amounts.length());
    let mut remaining = initial;
    let mut i = 0u64;
    while (i < events.length()) {
        let event_fields = packet::claimed_fields(events[i]);
        remaining = remaining - amounts[i];
        assert_eq!(packet::claimed_packet(&event_fields), id);
        assert_eq!(packet::claimed_channel(&event_fields), channel);
        assert_eq!(packet::claimed_amount(&event_fields), amounts[i]);
        assert_eq!(packet::claimed_at(&event_fields), timestamps[i]);
        assert_eq!(packet::claimed_remaining_count(&event_fields), count - i - 1);
        assert_eq!(packet::claimed_remaining_balance(&event_fields), remaining);
        let record = packet::record_for_testing(&p, i);
        assert_eq!(packet::record_recipient(&record), recipients[i]);
        assert_eq!(packet::record_amount(&record), amounts[i]);
        assert_eq!(packet::record_claimed_at(&record), timestamps[i]);
        i = i + 1;
    };
    ts::return_shared(p);
    let refunds = &self.refunded_events;
    if (refunded > 0) {
        assert_eq!(refunds.length(), 1);
        let refund_fields = packet::refunded_fields_for_testing(refunds[0]);
        assert_eq!(packet::refunded_packet(&refund_fields), id);
        assert_eq!(packet::refunded_channel(&refund_fields), channel);
        assert_eq!(packet::refunded_amount(&refund_fields), refunded);
        assert_eq!(packet::refunded_at(&refund_fields), EXPIRY + 1);
        assert_eq!(packet::refunded_unclaimed_count(&refund_fields), count - packet::snapshot_claimed_count(&s));
    } else {
        assert_eq!(refunds.length(), 0);
    };
    assert_eq!(remaining, packet::snapshot_remaining_balance(&s) + refunded);
    assert_eq!(packet::snapshot_refunded_amount(&s), refunded);
}

fun random_resource_profile(seed: u8) {
    let mut f = start_fixture<SUI>(std::u64::max_value!(), 3, true, b"profile".to_string(), 1_000);
    f.next_tx!(@0x0, |f| { f.seed(seed); });
    f.next_tx!(BOB, |f| { f.claim(true, false); });
    f.next_tx!(BOB, |f| {
        assert_eq!(f.created_count, 1);
        assert_eq!(f.transferred_count, 1);
        assert_eq!(f.event_count, 1);
        assert!(f.collect() > 0);
    });
    f.end();
}
