/// Fully funded streams and prepaid recurring payments. Clock units are milliseconds.
/// Pauses shift the complete schedule, including its inclusive end date. No keeper is
/// promised: callers explicitly submit claim/execute transactions and pay their gas.
module agent_vault::scheduled_payments;

use sui::{balance::Balance, clock::Clock, coin::{Self, Coin}, event};

// === Constants ===

const MAX_NAME_BYTES: u64 = 256;
const MIN_INTERVAL_MS: u64 = 1_000;

// === Errors ===

#[error(code = 1)]
const EInvalidRecipient: vector<u8> = b"Recipient must not be zero.";
#[error(code = 2)]
const EInvalidSchedule: vector<u8> = b"Schedule, interval, curve or start time is invalid.";
#[error(code = 3)]
const EInvalidFunding: vector<u8> = b"Funding must be positive, within u64 and within the schedule allocation.";
#[error(code = 4)]
const EWrongCap: vector<u8> = b"PaymentCap does not authorize this payment.";
#[error(code = 5)]
const ETerminated: vector<u8> = b"Payment has been terminated.";
#[error(code = 6)]
const EWrongState: vector<u8> = b"Operation requires a different lifecycle state.";
#[error(code = 7)]
const EApprovalRequired: vector<u8> = b"Each installment requires execution with its PaymentCap.";
#[error(code = 8)]
const ENothingDue: vector<u8> = b"No funded amount is currently claimable.";
#[error(code = 9)]
const ENotRecurring: vector<u8> = b"Only recurring payments support this operation.";
#[error(code = 10)]
const ENameTooLong: vector<u8> = b"Payment name exceeds 256 bytes.";

// === Public Types ===

/// Zero max_count/end_ms means no respective limit. First installment is due
/// at start_ms; subsequent installments at start_ms + n * interval_ms.
public enum Schedule has copy, drop, store {
    Recurring { amount: u64, interval_ms: u64, max_count: u64, end_ms: u64, requires_approval: bool },
    /// curve is 0..100: (100-curve)% vests in the first half, curve% in the
    /// second half. Exact rational arithmetic rounds down until the final unit.
    Stream { duration_ms: u64, curve: u8 },
}

public enum Status has copy, drop, store {
    Active,
    Paused { at_ms: u64 },
    Terminated,
}

/// Shared, independently discoverable custody. funded = paid + refunded + balance.
/// Recurring prepaid shortfalls never debit an external wallet or create debt.
public struct Payment<phantom Asset> has key {
    id: UID,
    recipient: address,
    refund_address: address,
    scope: address,
    name: vector<u8>,
    schedule: Schedule,
    start_ms: u64,
    paused_ms: u64,
    status: Status,
    balance: Balance<Asset>,
    funded: u64,
    paid: u64,
    refunded: u64,
    installments_paid: u64,
}

/// Transferable per-plan authority. Transfer changes management authority only;
/// it cannot change the recipient, allocation, schedule or refund address.
public struct PaymentCap has key, store { id: UID, payment_id: ID }

public struct PaymentCreated<phantom Asset> has copy, drop {
    payment_id: ID, recipient: address, scope: address, name: vector<u8>,
    schedule: Schedule, start_ms: u64, funded: u64,
}
public struct PaymentFunded<phantom Asset> has copy, drop { payment_id: ID, amount: u64, funded: u64 }
public struct PaymentReleased<phantom Asset> has copy, drop {
    payment_id: ID, amount: u64, paid: u64, installments_paid: u64,
}
public struct PaymentPaused has copy, drop { payment_id: ID, at_ms: u64 }
public struct PaymentResumed has copy, drop { payment_id: ID, paused_ms: u64 }
public struct PaymentTerminated<phantom Asset> has copy, drop { payment_id: ID, refunded: u64 }

// === Public Functions ===

/// Deposits prepaid installments, shares the payment and delivers its cap to the
/// signer. A finite limit is enforced even for direct, non-UI callers.
public fun create_recurring<Asset>(
    funding: Coin<Asset>, recipient: address, scope: address, name: vector<u8>,
    amount: u64, interval_ms: u64, max_count: u64, start_ms: u64, end_ms: u64,
    requires_approval: bool, clock: &Clock, ctx: &mut TxContext,
): ID {
    assert!(recipient != @0x0, EInvalidRecipient);
    assert!(name.length() <= MAX_NAME_BYTES, ENameTooLong);
    assert!(start_ms >= clock.timestamp_ms() && interval_ms >= MIN_INTERVAL_MS && amount > 0, EInvalidSchedule);
    assert!(end_ms == 0 || end_ms >= start_ms, EInvalidSchedule);
    let schedule = Schedule::Recurring { amount, interval_ms, max_count, end_ms, requires_approval };
    let value = funding.value();
    assert!(value > 0 && value % amount == 0, EInvalidFunding);
    assert!((value as u128) <= allocation_limit(&schedule, start_ms), EInvalidFunding);

    publish(funding, recipient, scope, name, schedule, start_ms, ctx)
}

/// Entire stream allocation is deposited up front; no future wallet allowance.
public fun create_stream<Asset>(
    funding: Coin<Asset>, recipient: address, scope: address, name: vector<u8>,
    start_ms: u64, end_ms: u64, curve: u8, clock: &Clock, ctx: &mut TxContext,
): ID {
    assert!(recipient != @0x0, EInvalidRecipient);
    assert!(name.length() <= MAX_NAME_BYTES, ENameTooLong);
    assert!(start_ms >= clock.timestamp_ms() && end_ms > start_ms && curve <= 100, EInvalidSchedule);
    assert!(funding.value() > 0, EInvalidFunding);

    publish(funding, recipient, scope, name, Schedule::Stream { duration_ms: end_ms - start_ms, curve }, start_ms, ctx)
}

/// Only the plan authority may add prepaid whole installments. Total lifetime
/// deposits are bounded by u64 and by any finite schedule allocation.
public fun fund<Asset>(self: &mut Payment<Asset>, cap: &PaymentCap, funding: Coin<Asset>) {
    assert_live(self);
    assert_cap(self, cap);
    let amount = match (&self.schedule) {
        Schedule::Recurring { amount, .. } => *amount,
        _ => abort ENotRecurring,
    };
    let value = funding.value();
    assert!(value > 0 && value % amount == 0, EInvalidFunding);
    let funded = (self.funded as u128) + (value as u128);
    assert!(funded <= (std::u64::max_value!() as u128), EInvalidFunding);
    assert!(funded <= allocation_limit(&self.schedule, self.start_ms), EInvalidFunding);

    self.funded = funded as u64;
    self.balance.join(funding.into_balance());

    event::emit(PaymentFunded<Asset> { payment_id: self.id.to_inner(), amount: value, funded: self.funded });
}

/// Permissionless delivery to the immutable recipient. Recurring plans release
/// exactly one due installment per call; streams release all vested dust-inclusive
/// units. Accrued funds remain claimable while paused.
public fun claim<Asset>(self: &mut Payment<Asset>, clock: &Clock, ctx: &mut TxContext) {
    assert_live(self);
    let requires_approval = match (&self.schedule) {
        Schedule::Recurring { requires_approval, .. } => *requires_approval,
        _ => false,
    };
    assert!(!requires_approval, EApprovalRequired);
    let (amount, installments) = claimable(self, clock);
    assert!(amount > 0, ENothingDue);

    release(self, amount, installments, ctx);
}

/// Each approved recurring installment is explicitly executed with its cap.
/// A cap for another payment can never approve or redirect it.
public fun execute_installment<Asset>(self: &mut Payment<Asset>, cap: &PaymentCap, clock: &Clock, ctx: &mut TxContext) {
    assert_live(self);
    assert_cap(self, cap);
    assert!(match (&self.schedule) { Schedule::Recurring { .. } => true, _ => false }, ENotRecurring);
    let (amount, installments) = claimable(self, clock);
    assert!(amount > 0, ENothingDue);

    release(self, amount, installments, ctx);
}

/// Freeze schedule time. This does not revoke already vested recipient funds.
public fun pause<Asset>(self: &mut Payment<Asset>, cap: &PaymentCap, clock: &Clock) {
    assert_live(self);
    assert_cap(self, cap);
    assert!(self.status == Status::Active, EWrongState);
    let at_ms = clock.timestamp_ms();

    self.status = Status::Paused { at_ms };

    event::emit(PaymentPaused { payment_id: self.id.to_inner(), at_ms });
}

/// Resume the frozen timeline, shifting all remaining dates by the pause length.
public fun resume<Asset>(self: &mut Payment<Asset>, cap: &PaymentCap, clock: &Clock) {
    assert_live(self);
    assert_cap(self, cap);
    let at_ms = match (&self.status) { Status::Paused { at_ms } => *at_ms, _ => abort EWrongState };
    let paused_ms = self.paused_ms + (clock.timestamp_ms() - at_ms);

    self.paused_ms = paused_ms;
    self.status = Status::Active;

    event::emit(PaymentResumed { payment_id: self.id.to_inner(), paused_ms });
}

/// Terminal settlement: vested stream funds and all due prepaid permissionless
/// installments go to recipient; the remainder returns to the original signer.
/// For approval plans, unexecuted installments have not been authorized and refund.
/// Works during pause, before start, after exhaustion and after the final due date.
public fun terminate<Asset>(self: &mut Payment<Asset>, cap: &PaymentCap, clock: &Clock, ctx: &mut TxContext) {
    assert_live(self);
    assert_cap(self, cap);
    let (amount, installments) = match (&self.schedule) {
        Schedule::Recurring { requires_approval: true, .. } => (0, 0),
        Schedule::Recurring { amount, .. } => {
            let count = due_installments(self, clock) - self.installments_paid;
            let payable = count.min(self.balance.value() / *amount);
            (payable * *amount, payable)
        },
        Schedule::Stream { .. } => claimable(self, clock),
    };
    if (amount > 0) release(self, amount, installments, ctx);
    let refunded = self.balance.value();

    self.refunded = refunded;
    self.status = Status::Terminated;
    if (refunded > 0) transfer::public_transfer(self.balance.withdraw_all().into_coin(ctx), self.refund_address);

    event::emit(PaymentTerminated<Asset> { payment_id: self.id.to_inner(), refunded });
}

/// Releases the authority object's storage after all obligations are settled.
public fun destroy_cap<Asset>(self: &Payment<Asset>, cap: PaymentCap) {
    assert!(self.status == Status::Terminated, EWrongState);
    assert_cap(self, &cap);
    let PaymentCap { id, payment_id: _ } = cap;
    id.delete();
}

// === Private Functions ===

fun publish<Asset>(funding: Coin<Asset>, recipient: address, scope: address, name: vector<u8>, schedule: Schedule, start_ms: u64, ctx: &mut TxContext): ID {
    let id = object::new(ctx);
    let payment_id = id.to_inner();
    let funded = funding.value();
    let payment = Payment {
        id, recipient, refund_address: ctx.sender(), scope, name, schedule, start_ms,
        paused_ms: 0, status: Status::Active, balance: funding.into_balance(),
        funded, paid: 0, refunded: 0, installments_paid: 0,
    };
    transfer::share_object(payment);
    transfer::public_transfer(PaymentCap { id: object::new(ctx), payment_id }, ctx.sender());

    event::emit(PaymentCreated<Asset> { payment_id, recipient, scope, name, schedule, start_ms, funded });
    payment_id
}

fun assert_live<Asset>(self: &Payment<Asset>) {
    assert!(self.status != Status::Terminated, ETerminated);
}

fun assert_cap<Asset>(self: &Payment<Asset>, cap: &PaymentCap) {
    assert!(cap.payment_id == self.id.to_inner(), EWrongCap);
}

fun allocation_limit(schedule: &Schedule, start_ms: u64): u128 {
    let (amount, interval_ms, max_count, end_ms) = match (schedule) {
        Schedule::Recurring { amount, interval_ms, max_count, end_ms, .. } => (amount, interval_ms, max_count, end_ms),
        _ => abort ENotRecurring,
    };
    let mut count = std::u64::max_value!();
    if (*max_count > 0) count = *max_count;
    if (*end_ms > 0) count = count.min((*end_ms - start_ms) / *interval_ms + 1);
    (count as u128) * (*amount as u128)
}

fun schedule_time<Asset>(self: &Payment<Asset>, clock: &Clock): u64 {
    let now = match (&self.status) { Status::Paused { at_ms } => *at_ms, _ => clock.timestamp_ms() };
    now - self.paused_ms
}

fun due_installments<Asset>(self: &Payment<Asset>, clock: &Clock): u64 {
    let (interval_ms, max_count, end_ms) = match (&self.schedule) {
        Schedule::Recurring { interval_ms, max_count, end_ms, .. } => (interval_ms, max_count, end_ms),
        _ => abort ENotRecurring,
    };
    let now = schedule_time(self, clock);
    if (now < self.start_ms) return 0;
    let until = if (*end_ms > 0) now.min(*end_ms) else now;
    let due = (until - self.start_ms) / *interval_ms + 1;
    if (*max_count > 0) due.min(*max_count) else due
}

fun claimable<Asset>(self: &Payment<Asset>, clock: &Clock): (u64, u64) {
    match (&self.schedule) {
        Schedule::Recurring { amount, .. } => {
            if (due_installments(self, clock) > self.installments_paid && self.balance.value() >= *amount) (*amount, 1) else (0, 0)
        },
        Schedule::Stream { duration_ms, curve } => {
            let now = schedule_time(self, clock);
            let elapsed = if (now > self.start_ms) (now - self.start_ms).min(*duration_ms) else 0;
            (vested_down(self.funded, elapsed, *duration_ms, *curve) - self.paid, 0)
        },
    }
}

/// u256 intermediates cover u64 allocation * u64 duration * 100, including MAX.
fun vested_down(total: u64, elapsed: u64, duration: u64, curve: u8): u64 {
    let twice_elapsed = (elapsed as u256) * 2;
    let duration = duration as u256;
    let first = twice_elapsed.min(duration);
    let second = twice_elapsed - first;
    let weight = first * ((100 - curve) as u256) + second * (curve as u256);
    (((total as u256) * weight) / (duration * 100)) as u64
}

fun release<Asset>(self: &mut Payment<Asset>, amount: u64, installments: u64, ctx: &mut TxContext) {
    self.paid = self.paid + amount;
    self.installments_paid = self.installments_paid + installments;
    transfer::public_transfer(self.balance.split(amount).into_coin(ctx), self.recipient);

    event::emit(PaymentReleased<Asset> { payment_id: self.id.to_inner(), amount, paid: self.paid, installments_paid: self.installments_paid });
}

// === Test-Only Functions ===

#[test_only]
public fun snapshot<Asset>(self: &Payment<Asset>): (u64, u64, u64, u64, u64, Status) {
    (self.funded, self.paid, self.refunded, self.balance.value(), self.installments_paid, self.status)
}
#[test_only]
public fun vested_for_testing(total: u64, elapsed: u64, duration: u64, curve: u8): u64 { vested_down(total, elapsed, duration, curve) }
#[test_only]
public fun due_for_testing<Asset>(self: &Payment<Asset>, clock: &Clock): u64 { due_installments(self, clock) }
#[test_only]
public fun terminated_for_testing(status: Status): bool { status == Status::Terminated }
#[test_only]
public fun stream_fields_for_testing(schedule: Schedule): (u64, u8) {
    match (schedule) { Schedule::Stream { duration_ms, curve } => (duration_ms, curve), _ => abort ENotRecurring }
}
#[test_only]
public fun created_fields<Asset>(event: PaymentCreated<Asset>): (ID, address, address, vector<u8>, Schedule, u64, u64) {
    let PaymentCreated { payment_id, recipient, scope, name, schedule, start_ms, funded } = event;
    (payment_id, recipient, scope, name, schedule, start_ms, funded)
}
#[test_only]
public fun released_fields<Asset>(event: PaymentReleased<Asset>): (ID, u64, u64, u64) {
    let PaymentReleased { payment_id, amount, paid, installments_paid } = event;
    (payment_id, amount, paid, installments_paid)
}
#[test_only]
public fun funded_fields<Asset>(event: PaymentFunded<Asset>): (ID, u64, u64) {
    let PaymentFunded { payment_id, amount, funded } = event;
    (payment_id, amount, funded)
}
#[test_only]
public fun paused_fields(event: PaymentPaused): (ID, u64) { let PaymentPaused { payment_id, at_ms } = event; (payment_id, at_ms) }
#[test_only]
public fun resumed_fields(event: PaymentResumed): (ID, u64) { let PaymentResumed { payment_id, paused_ms } = event; (payment_id, paused_ms) }
#[test_only]
public fun terminated_fields<Asset>(event: PaymentTerminated<Asset>): (ID, u64) { let PaymentTerminated { payment_id, refunded } = event; (payment_id, refunded) }
