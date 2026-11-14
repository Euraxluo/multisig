#[test_only]
module agent_vault::scheduled_payments_tests;

use sui::{clock::{Self, Clock}, coin::{Self, Coin}, event, sui::SUI, test_scenario::{Self as ts, Scenario}};
use agent_vault::scheduled_payments::{Self as payments, Payment, PaymentCap, Status, Schedule, PaymentCreated, PaymentFunded, PaymentReleased, PaymentPaused, PaymentResumed, PaymentTerminated};

const ALICE: address = @0xA;
const BOB: address = @0xB;
const EVE: address = @0xE;

// === Tests ===

#[test]
fun stream_pause_claim_resume_terminate_conserves_and_replays() {
    let mut f = start_stream(101, 50);
    f.next_tx!(EVE, 600, |f| {
        f.claim();
        f.assert_accounting(101, 50, 0, 51, 0);
    });
    f.next_tx!(ALICE, 600, |f| f.pause());
    f.next_tx!(EVE, 1_600, |f| f.assert_accounting(101, 50, 0, 51, 0));
    f.next_tx!(ALICE, 1_600, |f| f.resume());
    f.next_tx!(ALICE, 1_850, |f| f.terminate());
    f.assert_accounting(101, 75, 26, 0, 0);
    f.next_tx!(ALICE, 1_851, |f| f.assert_delivered(75, 26));
    let (_, _, _, _, _, status) = payments::snapshot(&f.payment);
    assert!(payments::terminated_for_testing(status));
    let (id, recipient, scope, name, schedule, start, funded) = payments::created_fields(f.created);
    assert!(id == object::id(&f.payment) && recipient == BOB && scope == @0x0 && name == b"salary");
    let (duration_ms, curve) = payments::stream_fields_for_testing(schedule);
    assert!(duration_ms == 1_000 && curve == 50);
    assert!(start == 100 && funded == 101);
    let released = &f.released;
    assert!(released.length() == 2);
    let (event_id, amount, paid, count) = payments::released_fields(released[0]);
    assert!(event_id == id && amount == 50 && paid == 50 && count == 0);
    let (event_id, amount, paid, count) = payments::released_fields(released[1]);
    assert!(event_id == id && amount == 25 && paid == 75 && count == 0);
    let (event_id, at) = payments::paused_fields(f.paused[0]);
    assert!(event_id == id && at == 600);
    let (event_id, paused) = payments::resumed_fields(f.resumed[0]);
    assert!(event_id == id && paused == 1_000);
    let (event_id, refunded) = payments::terminated_fields(f.terminated[0]);
    assert!(event_id == id && refunded == 26);
    f.end();
}

#[test]
fun paused_stream_keeps_previously_vested_funds_claimable() {
    let mut f = start_stream(100, 0);
    f.next_tx!(ALICE, 600, |f| f.pause());
    f.next_tx!(EVE, 5_000, |f| f.claim());
    f.assert_accounting(100, 100, 0, 0, 0);
    f.next_tx!(ALICE, 5_000, |f| f.terminate());
    f.end();
}

#[test]
fun cancel_before_start_refunds_every_unit() {
    let mut f = start_stream(1, 100);
    f.next_tx!(ALICE, 99, |f| f.terminate());
    f.assert_accounting(1, 0, 1, 0, 0);
    f.end();
}

#[test]
fun final_stream_claim_includes_integer_dust() {
    let mut f = start_stream(101, 50);
    f.next_tx!(EVE, 599, |f| f.claim());
    f.assert_accounting(101, 50, 0, 51, 0);
    f.next_tx!(EVE, 1_100, |f| f.claim());
    f.assert_accounting(101, 101, 0, 0, 0);
    f.next_tx!(ALICE, 1_101, |f| f.terminate());
    f.end();
}

#[test]
fun recurring_exact_due_count_deadline_top_up_and_terminal_settlement() {
    let mut f = start_recurring(false, 3, 2_100, 20);
    f.next_tx!(EVE, 99, |f| assert!(payments::due_for_testing(&f.payment, &f.clock) == 0));
    f.next_tx!(EVE, 100, |f| f.claim());
    f.next_tx!(EVE, 1_099, |f| assert!(payments::due_for_testing(&f.payment, &f.clock) == 1));
    f.next_tx!(EVE, 1_100, |f| f.claim());
    f.assert_accounting(20, 20, 0, 0, 2);
    f.next_tx!(ALICE, 2_100, |f| f.fund(10));
    let id = object::id(&f.payment);
    let (event_id, amount, funded) = payments::funded_fields(event::events_by_type<PaymentFunded<SUI>>()[0]);
    assert!(event_id == id && amount == 10 && funded == 30);
    f.next_tx!(ALICE, 50_000, |f| {
        assert!(payments::due_for_testing(&f.payment, &f.clock) == 3);
        f.terminate();
    });
    f.assert_accounting(30, 30, 0, 0, 3);
    f.end();
}

#[test]
fun approval_mode_pays_one_installment_and_refunds_unapproved_amounts() {
    let mut f = start_recurring(true, 3, 0, 30);
    f.next_tx!(ALICE, 10_000, |f| f.execute());
    f.assert_accounting(30, 10, 0, 20, 1);
    f.next_tx!(ALICE, 10_000, |f| f.terminate());
    f.assert_accounting(30, 10, 20, 0, 1);
    f.end();
}

#[test]
fun no_end_date_requires_prepaid_funds_and_can_be_resumed_after_exhaustion() {
    let mut f = start_recurring(false, 0, 0, 10);
    f.next_tx!(EVE, 100, |f| f.claim());
    f.next_tx!(ALICE, 1_100, |f| f.pause());
    f.next_tx!(ALICE, 5_100, |f| f.resume());
    f.next_tx!(ALICE, 5_100, |f| f.fund(20));
    f.next_tx!(EVE, 5_100, |f| f.claim());
    f.assert_accounting(30, 20, 0, 10, 2);
    f.next_tx!(ALICE, 5_100, |f| f.terminate());
    f.assert_accounting(30, 20, 10, 0, 2);
    f.end();
}

#[test]
fun curve_boundaries_and_maximum_intermediates_are_exact_and_monotone() {
    let max = std::u64::max_value!();
    assert!(payments::vested_for_testing(max, max, max, 0) == max);
    assert!(payments::vested_for_testing(max, max, max, 100) == max);
    assert!(payments::vested_for_testing(101, 500, 1_000, 0) == 101);
    assert!(payments::vested_for_testing(101, 500, 1_000, 50) == 50);
    assert!(payments::vested_for_testing(101, 500, 1_000, 100) == 0);
    101u64.do!(|curve| {
        let mut previous = 0;
        102u64.do!(|elapsed| {
            let vested = payments::vested_for_testing(1_003, elapsed, 101, curve as u8);
            assert!(vested >= previous && vested <= 1_003);
            previous = vested;
        });
        assert!(previous == 1_003);
    });
}

#[test]
#[expected_failure(abort_code = payments::ENothingDue, location = agent_vault::scheduled_payments)]
fun recurring_rejects_before_start() {
    let mut f = start_recurring(false, 1, 0, 10);
    f.next_tx!(EVE, 99, |f| f.claim());
    f.end();
}

#[test]
#[expected_failure(abort_code = payments::ENothingDue, location = agent_vault::scheduled_payments)]
fun installment_cannot_be_claimed_twice() {
    let mut f = start_recurring(false, 2, 0, 20);
    f.next_tx!(EVE, 100, |f| f.claim());
    f.next_tx!(EVE, 100, |f| f.claim());
    f.end();
}

#[test]
#[expected_failure(abort_code = payments::EApprovalRequired, location = agent_vault::scheduled_payments)]
fun third_party_cannot_bypass_approval_even_before_due_time() {
    let mut f = start_recurring(true, 2, 0, 20);
    f.next_tx!(EVE, 99, |f| f.claim());
    f.end();
}

#[test]
#[expected_failure(abort_code = payments::EWrongCap, location = agent_vault::scheduled_payments)]
fun cap_for_another_payment_cannot_pause_or_approve() {
    let mut f = start_recurring(true, 2, 0, 20);
    f.next_tx!(ALICE, 0, |f| {
        let coin = coin::mint_for_testing<SUI>(1, ts::ctx(&mut f.scenario));
        let other_id = payments::create_stream(coin, BOB, @0x0, b"other", 100, 1_100, 50, &f.clock, ts::ctx(&mut f.scenario));
        ts::next_tx(&mut f.scenario, ALICE);
        let mut other = ts::take_shared_by_id<Payment<SUI>>(&f.scenario, other_id);
        payments::pause(&mut other, &f.cap, &f.clock);
        ts::return_shared(other);
    });
    f.end();
}

#[test]
#[expected_failure(abort_code = payments::EWrongState, location = agent_vault::scheduled_payments)]
fun duplicate_pause_is_rejected() {
    let mut f = start_stream(100, 50);
    f.next_tx!(ALICE, 600, |f| f.pause());
    f.next_tx!(ALICE, 600, |f| f.pause());
    f.end();
}

#[test]
#[expected_failure(abort_code = payments::EWrongState, location = agent_vault::scheduled_payments)]
fun active_payment_cannot_resume() {
    let mut f = start_stream(100, 50);
    f.next_tx!(ALICE, 600, |f| f.resume());
    f.end();
}

#[test]
#[expected_failure(abort_code = payments::ETerminated, location = agent_vault::scheduled_payments)]
fun termination_precedes_claim_and_approval_guards() {
    let mut f = start_recurring(true, 2, 0, 20);
    f.next_tx!(ALICE, 0, |f| f.terminate());
    f.next_tx!(EVE, 100, |f| f.claim());
    f.end();
}

#[test]
#[expected_failure(abort_code = payments::EInvalidFunding, location = agent_vault::scheduled_payments)]
fun topup_cannot_exceed_final_schedule_allocation() {
    let mut f = start_recurring(false, 2, 0, 20);
    f.next_tx!(ALICE, 100, |f| f.fund(10));
    f.end();
}

#[test]
#[expected_failure(abort_code = payments::EInvalidFunding, location = agent_vault::scheduled_payments)]
fun topup_requires_whole_installments() {
    let mut f = start_recurring(false, 0, 0, 20);
    f.next_tx!(ALICE, 100, |f| f.fund(1));
    f.end();
}

#[test]
#[expected_failure(abort_code = payments::EInvalidRecipient, location = agent_vault::scheduled_payments)]
fun zero_recipient_precedes_invalid_schedule_and_funding() {
    let mut scenario = ts::begin(ALICE);
    let clock = clock::create_for_testing(ts::ctx(&mut scenario));
    let coin = coin::mint_for_testing<SUI>(0, ts::ctx(&mut scenario));
    payments::create_stream(coin, @0x0, @0x0, b"bad", 0, 0, 101, &clock, ts::ctx(&mut scenario));
    abort 999
}

#[test]
fun deadline_without_count_limit_and_pauses_remains_inclusive() {
    let mut f = start_recurring(false, 0, 1_100, 20);
    f.next_tx!(ALICE, 100, |f| f.pause());
    f.next_tx!(ALICE, 5_100, |f| f.resume());
    f.next_tx!(EVE, 6_099, |f| assert!(payments::due_for_testing(&f.payment, &f.clock) == 1));
    f.next_tx!(EVE, 6_100, |f| assert!(payments::due_for_testing(&f.payment, &f.clock) == 2));
    f.next_tx!(ALICE, 6_101, |f| f.terminate());
    f.assert_accounting(20, 20, 0, 0, 2);
    f.end();
}

#[test]
#[expected_failure(abort_code = payments::EInvalidSchedule, location = agent_vault::scheduled_payments)]
fun stream_rejects_curve_above_one_hundred() {
    let f = start_stream(100, 101);
    f.end();
}

#[test]
#[expected_failure(abort_code = payments::EInvalidFunding, location = agent_vault::scheduled_payments)]
fun zero_stream_funding_is_rejected() {
    let f = start_stream(0, 50);
    f.end();
}

#[test]
#[expected_failure(abort_code = payments::EInvalidFunding, location = agent_vault::scheduled_payments)]
fun upfront_funding_cannot_exceed_inclusive_deadline_allocation() {
    let f = start_recurring(false, 0, 1_099, 20);
    f.end();
}

#[test]
#[expected_failure(abort_code = payments::ENothingDue, location = agent_vault::scheduled_payments)]
fun exhausted_no_end_payment_cannot_debit_external_wallet() {
    let mut f = start_recurring(false, 0, 0, 10);
    f.next_tx!(EVE, 100, |f| f.claim());
    f.next_tx!(EVE, 1_100, |f| f.claim());
    f.end();
}

// === Stateful Fixtures ===

public struct PaymentFixture {
    scenario: Scenario, clock: Clock, payment: Payment<SUI>, cap: PaymentCap,
    created: PaymentCreated<SUI>, released: vector<PaymentReleased<SUI>>,
    paused: vector<PaymentPaused>, resumed: vector<PaymentResumed>, terminated: vector<PaymentTerminated<SUI>>,
}

use fun fixture_end as PaymentFixture.end;

fun start_stream(amount: u64, curve: u8): PaymentFixture {
    let mut scenario = ts::begin(ALICE);
    let clock = clock::create_for_testing(ts::ctx(&mut scenario));
    let coin = coin::mint_for_testing<SUI>(amount, ts::ctx(&mut scenario));
    payments::create_stream(coin, BOB, @0x0, b"salary", 100, 1_100, curve, &clock, ts::ctx(&mut scenario));
    take_fixture(scenario, clock)
}
fun start_recurring(approval: bool, count: u64, end: u64, funding: u64): PaymentFixture {
    let mut scenario = ts::begin(ALICE);
    let clock = clock::create_for_testing(ts::ctx(&mut scenario));
    let coin = coin::mint_for_testing<SUI>(funding, ts::ctx(&mut scenario));
    payments::create_recurring(coin, BOB, @0x0, b"salary", 10, 1_000, count, 100, end, approval, &clock, ts::ctx(&mut scenario));
    take_fixture(scenario, clock)
}
fun take_fixture(mut scenario: Scenario, clock: Clock): PaymentFixture {
    let created = event::events_by_type<PaymentCreated<SUI>>()[0];
    ts::next_tx(&mut scenario, ALICE);
    let payment = ts::take_shared<Payment<SUI>>(&scenario);
    let cap = ts::take_from_sender<PaymentCap>(&scenario);
    PaymentFixture { scenario, clock, payment, cap, created, released: vector[], paused: vector[], resumed: vector[], terminated: vector[] }
}
macro fun next_tx($f: &mut PaymentFixture, $sender: address, $time: u64, $action: |&mut PaymentFixture|) {
    let f = $f;
    ts::next_tx(&mut f.scenario, $sender);
    clock::set_for_testing(&mut f.clock, $time);
    $action(f);
    f.released.append(event::events_by_type<PaymentReleased<SUI>>());
    f.paused.append(event::events_by_type<PaymentPaused>());
    f.resumed.append(event::events_by_type<PaymentResumed>());
    f.terminated.append(event::events_by_type<PaymentTerminated<SUI>>());
}
fun claim(f: &mut PaymentFixture) { payments::claim(&mut f.payment, &f.clock, ts::ctx(&mut f.scenario)); }
fun execute(f: &mut PaymentFixture) { payments::execute_installment(&mut f.payment, &f.cap, &f.clock, ts::ctx(&mut f.scenario)); }
fun fund(f: &mut PaymentFixture, amount: u64) {
    let coin = coin::mint_for_testing<SUI>(amount, ts::ctx(&mut f.scenario));
    payments::fund(&mut f.payment, &f.cap, coin);
}
fun pause(f: &mut PaymentFixture) { payments::pause(&mut f.payment, &f.cap, &f.clock); }
fun resume(f: &mut PaymentFixture) { payments::resume(&mut f.payment, &f.cap, &f.clock); }
fun terminate(f: &mut PaymentFixture) { payments::terminate(&mut f.payment, &f.cap, &f.clock, ts::ctx(&mut f.scenario)); }
fun assert_accounting(f: &PaymentFixture, funded: u64, paid: u64, refunded: u64, balance: u64, installments: u64) {
    let (actual_funded, actual_paid, actual_refunded, actual_balance, actual_installments, _) = payments::snapshot(&f.payment);
    assert!(actual_funded == funded && actual_paid == paid && actual_refunded == refunded && actual_balance == balance && actual_installments == installments);
    assert!(funded == paid + refunded + balance);
}
fun assert_delivered(f: &PaymentFixture, recipient_total: u64, refund_total: u64) {
    let mut paid = 0;
    ts::ids_for_address<Coin<SUI>>(BOB).do!(|id| {
        let coin = ts::take_from_address_by_id<Coin<SUI>>(&f.scenario, BOB, id);
        paid = paid + coin.value();
        ts::return_to_address(BOB, coin);
    });
    let mut refunded = 0;
    ts::ids_for_address<Coin<SUI>>(ALICE).do!(|id| {
        let coin = ts::take_from_address_by_id<Coin<SUI>>(&f.scenario, ALICE, id);
        refunded = refunded + coin.value();
        ts::return_to_address(ALICE, coin);
    });
    assert!(paid == recipient_total && refunded == refund_total);
    assert!(ts::ids_for_address<Coin<SUI>>(EVE).is_empty());
}
fun fixture_end(f: PaymentFixture) {
    let PaymentFixture { scenario, clock, payment, cap, created: _, released: _, paused: _, resumed: _, terminated: _ } = f;
    let (_, _, _, _, _, status) = payments::snapshot(&payment);
    if (payments::terminated_for_testing(status)) payments::destroy_cap(&payment, cap)
    else transfer::public_transfer(cap, ALICE);
    ts::return_shared(payment);
    clock::destroy_for_testing(clock);
    ts::end(scenario);
}
