/// Coin escrow isolated from every legacy red_packet entry point by a new defining type.
/// No initializer or singleton is required: this module can be added by an additive upgrade.
/// Existing legacy packets and their old callable bytecode are not migrated or disabled.
///
/// Authority: current membership in the exact ChatChannel authorizes one claim per address;
/// only the funding transaction's sender can refund. Membership is not Sybil resistance.
/// Custody: one shared, key-only packet owns Balance<CoinType>; endpoints pay internally.
/// Conservation: initial amount = paid claims + escrow + refunded amount, in coin base units.
/// Claims include the expiry millisecond; refunds require a strictly later Clock timestamp.
/// Terminal packets remain queryable, including their bounded inline claim history.
///
/// Randomness proof (pinned Sui revision 8fc60f1fa966e90398c93beb67ad4f42992889c7):
/// - create never draws: creators cannot inspect and selectively publish an allocation schedule;
/// - claim_random is private entry, returns nothing, and constructs its generator internally;
/// - canonical Random and Clock are sealed framework types; production construction is system-only;
/// - all guards, state-dependent branches, and payout bounds precede the draw;
/// - the draw uses the framework's fixed 16-byte range sampler (statistical bias <= 2^-64);
/// - post-draw execution has no outcome-dependent branch, loop, index, or allocation size;
/// - positive payouts reserve one unit for each future claim, so split cannot fail by outcome;
/// - every outcome writes one fixed-size record, emits one fixed-size event, and creates and
///   transfers one Coin; integer operations have value-independent VM charges and BCS widths;
/// - Sui rejects any post-Random PTB command except TransferObjects/MergeCoins. No payout is
///   returned, and a transferred Coin cannot be recovered as a same-transaction command result.
/// Thus gas, object, UID, event, effects-size, and surrounding PTB limits either allow all
/// outcomes for a fixed pre-state or abort all. Failed transactions reveal no usable draw.
/// This assumes honest threshold randomness and the pinned VM/framework resource semantics;
/// framework/protocol changes require revalidation. Ordering, Sybils, censorship, and colluding
/// members can affect who participates, but cannot filter an honest claimant's unseen draw.
/// Future security fixes must use another defining type if old V2 bytecode cannot enforce them;
/// adding a new-bytecode-only version check cannot retire an already callable generation.
module agent_vault::red_packet;

use std::string::String;
use sui::{
    balance::Balance,
    clock::Clock,
    coin::{Self, Coin},
    random::{Self, Random},
};
use agent_vault::onchain_chat::{Self, ChatChannel};

// === Constants ===

/// At most 128 inline records (48 bytes each); no per-claim dynamic objects are retained.
const MAX_COUNT: u64 = 128;
const MAX_GREETING_BYTES: u64 = 256;
const MAX_DURATION_MS: u64 = 604_800_000;

// === Errors ===

#[error(code = 1)]
const EChannelMismatch: vector<u8> = b"Packet must belong to the supplied channel.";
#[error(code = 2)]
const ENotMember: vector<u8> = b"Sender must be a current member of the bound channel.";
#[error(code = 3)]
const EInvalidCount: vector<u8> = b"Count must be between one and 128.";
#[error(code = 4)]
const EGreetingTooLong: vector<u8> = b"Greeting must contain at most 256 UTF-8 bytes.";
#[error(code = 5)]
const EInvalidDuration: vector<u8> = b"Duration must be between one millisecond and seven days.";
#[error(code = 6)]
const EExpiryOverflow: vector<u8> = b"Expiry timestamp must fit in u64 milliseconds.";
#[error(code = 7)]
const EInsufficientAmount: vector<u8> = b"Escrow must fund at least one base unit per claim.";
#[error(code = 8)]
const ERefunded: vector<u8> = b"Packet has already been refunded.";
#[error(code = 9)]
const EWrongAllocation: vector<u8> = b"Claim endpoint must match the packet allocation mode.";
#[error(code = 10)]
const EExpired: vector<u8> = b"Claims must occur at or before the expiry millisecond.";
#[error(code = 11)]
const EExhausted: vector<u8> = b"Packet must have an unclaimed allocation.";
#[error(code = 12)]
const EAlreadyClaimed: vector<u8> = b"Sender may claim at most once per packet.";
#[error(code = 13)]
const ENotCreator: vector<u8> = b"Only the original funding sender may refund escrow.";
#[error(code = 14)]
const ENotExpired: vector<u8> = b"Refund must occur strictly after the expiry millisecond.";

// === Public Types ===

/// Refund is the only explicit terminal transition; exhaustion is derived from claim count.
public enum Lifecycle has drop, store {
    Open,
    Refunded { amount: u64 },
}

/// Bounded history is also the canonical duplicate-claim guard; no parallel address table.
public struct ClaimRecord has copy, drop, store {
    recipient: address,
    amount: u64,
    claimed_at_ms: u64,
}

/// A fresh type origin: old RedPacket<CoinType> bytecode cannot borrow this escrow.
/// CoinType is any ordinary Coin asset, including SUI. External token deny/pause policy can
/// prevent delivery and is an asset-issuer risk; this module has no fee or seizure authority.
public struct RedPacket<phantom CoinType> has key {
    id: UID,
    channel_id: ID,
    creator: address,
    greeting: String,
    escrow: Balance<CoinType>,
    initial_amount: u64,
    count: u64,
    is_random: bool,
    expires_at_ms: u64,
    claims: vector<ClaimRecord>,
    lifecycle: Lifecycle,
}

/// Asset identity is the event's phantom type. Creator comes from native event sender metadata.
public struct Created<phantom CoinType> has copy, drop {
    packet_id: ID,
    channel_id: ID,
    amount: u64,
    count: u64,
    is_random: bool,
    greeting: String,
    expires_at_ms: u64,
}

/// Recipient comes from native event sender metadata. Totals permit replay reconciliation.
public struct Claimed<phantom CoinType> has copy, drop {
    packet_id: ID,
    channel_id: ID,
    amount: u64,
    claimed_at_ms: u64,
    remaining_count: u64,
    remaining_balance: u64,
}

/// The native event sender is necessarily the original funding creator.
public struct Refunded<phantom CoinType> has copy, drop {
    packet_id: ID,
    channel_id: ID,
    amount: u64,
    refunded_at_ms: u64,
    unclaimed_count: u64,
}

// === Public Functions ===

/// Escrow and share one packet. UTF-8 validity is owned by String; bounds use bytes.
/// Equal claims differ by at most one unit: the earliest amount%count claims receive dust.
/// Random claims draw uniformly (up to the framework's <=2^-64 bias) from 1 through the
/// smaller of floor(2*remaining/count) and remaining-(count-1); the last takes all escrow.
public fun create<CoinType>(
    channel: &ChatChannel,
    funding: Coin<CoinType>,
    count: u64,
    is_random: bool,
    greeting: String,
    duration_ms: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): ID {
    assert!(onchain_chat::is_member(channel, ctx.sender()), ENotMember);
    assert!(count > 0 && count <= MAX_COUNT, EInvalidCount);
    assert!(greeting.length() <= MAX_GREETING_BYTES, EGreetingTooLong);
    assert!(duration_ms > 0 && duration_ms <= MAX_DURATION_MS, EInvalidDuration);
    assert!(clock.timestamp_ms() <= std::u64::max_value!() - duration_ms, EExpiryOverflow);
    let amount = funding.value();
    assert!(amount >= count, EInsufficientAmount);

    let packet = RedPacket {
        id: object::new(ctx),
        channel_id: object::id(channel),
        creator: ctx.sender(),
        greeting,
        escrow: funding.into_balance(),
        initial_amount: amount,
        count,
        is_random,
        expires_at_ms: clock.timestamp_ms() + duration_ms,
        claims: vector[],
        lifecycle: Lifecycle::Open,
    };
    let packet_id = packet.id.to_inner();
    let created = Created<CoinType> {
        packet_id,
        channel_id: packet.channel_id,
        amount,
        count,
        is_random,
        greeting: packet.greeting,
        expires_at_ms: packet.expires_at_ms,
    };
    transfer::share_object(packet);

    sui::event::emit(created);
    packet_id
}

/// Equal endpoint pays the sender internally and exposes no payout-return path.
entry fun claim_equal<CoinType>(
    self: &mut RedPacket<CoinType>,
    channel: &ChatChannel,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    self.assert_claimable(channel, false, clock, ctx.sender());
    let amount = self.initial_amount / self.count +
        if (self.claims.length() < self.initial_amount % self.count) { 1 } else { 0 };

    self.pay_claim(amount, clock.timestamp_ms(), ctx);
}

/// Non-public entry is mandatory. No public/package endpoint accepts Random or returns payout.
/// All branches below depend only on the pre-draw state; pay_claim has fixed resource use.
entry fun claim_random<CoinType>(
    self: &mut RedPacket<CoinType>,
    channel: &ChatChannel,
    clock: &Clock,
    random: &Random,
    ctx: &mut TxContext,
) {
    self.assert_claimable(channel, true, clock, ctx.sender());
    let remaining = self.count - self.claims.length();
    let balance = self.escrow.value();
    let (minimum, maximum) = if (remaining == 1) {
        (balance, balance)
    } else {
        // Widen before doubling: even a u64::MAX deposit cannot overflow intermediates.
        let twice_mean = (2 * (balance as u128) / (remaining as u128)) as u64;
        (1, std::u64::min(twice_mean, balance - (remaining - 1)))
    };
    let claimed_at_ms = clock.timestamp_ms();

    let mut generator = random::new_generator(random, ctx);
    let amount = generator.generate_u64_in_range(minimum, maximum);
    self.pay_claim(amount, claimed_at_ms, ctx);
}

/// Exit needs no channel object or membership: creator can recover after leaving or closure.
/// Exhausted/refunded packets reject; successful refund leaves a queryable zero-balance object.
entry fun refund<CoinType>(
    self: &mut RedPacket<CoinType>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    self.assert_open();
    assert!(ctx.sender() == self.creator, ENotCreator);
    assert!(clock.timestamp_ms() > self.expires_at_ms, ENotExpired);
    assert!(self.claims.length() < self.count, EExhausted);
    let amount = self.escrow.value();
    let unclaimed_count = self.count - self.claims.length();

    self.lifecycle = Lifecycle::Refunded { amount };
    let payment = coin::from_balance(self.escrow.withdraw_all(), ctx);
    transfer::public_transfer(payment, self.creator);

    sui::event::emit(Refunded<CoinType> {
        packet_id: self.id.to_inner(),
        channel_id: self.channel_id,
        amount,
        refunded_at_ms: clock.timestamp_ms(),
        unclaimed_count,
    });
}

// === Private Functions ===

fun assert_open<CoinType>(self: &RedPacket<CoinType>) {
    let is_open = match (&self.lifecycle) {
        Lifecycle::Open => true,
        Lifecycle::Refunded { .. } => false,
    };
    assert!(is_open, ERefunded);
}

fun assert_claimable<CoinType>(
    self: &RedPacket<CoinType>,
    channel: &ChatChannel,
    is_random: bool,
    clock: &Clock,
    sender: address,
) {
    self.assert_open();
    assert!(self.is_random == is_random, EWrongAllocation);
    assert!(self.channel_id == object::id(channel), EChannelMismatch);
    assert!(onchain_chat::is_member(channel, sender), ENotMember);
    assert!(clock.timestamp_ms() <= self.expires_at_ms, EExpired);
    assert!(self.claims.length() < self.count, EExhausted);
    assert!(!self.claims.any!(|record| record.recipient == sender), EAlreadyClaimed);
}

/// After a draw: no random-dependent branch, loop, index, object count, or serialized size.
/// Record capacity, positivity, solvency, and all arithmetic bounds were established pre-draw.
fun pay_claim<CoinType>(self: &mut RedPacket<CoinType>, amount: u64, now: u64, ctx: &mut TxContext) {
    let payment = coin::from_balance(self.escrow.split(amount), ctx);
    self.claims.push_back(ClaimRecord { recipient: ctx.sender(), amount, claimed_at_ms: now });
    transfer::public_transfer(payment, ctx.sender());

    sui::event::emit(Claimed<CoinType> {
        packet_id: self.id.to_inner(),
        channel_id: self.channel_id,
        amount,
        claimed_at_ms: now,
        remaining_count: self.count - self.claims.length(),
        remaining_balance: self.escrow.value(),
    });
}

// === Test-Only Types ===

#[test_only]
public struct Snapshot has drop {
    channel_id: ID,
    creator: address,
    greeting: String,
    initial_amount: u64,
    count: u64,
    is_random: bool,
    expires_at_ms: u64,
    claimed_count: u64,
    remaining_balance: u64,
    refunded_amount: u64,
}

#[test_only]
public struct RecordFields has drop {
    recipient: address,
    amount: u64,
    claimed_at_ms: u64,
}

#[test_only]
public struct CreatedFields has drop {
    packet_id: ID,
    channel_id: ID,
    amount: u64,
    count: u64,
    is_random: bool,
    greeting: String,
    expires_at_ms: u64,
}

#[test_only]
public struct ClaimedFields has drop {
    packet_id: ID,
    channel_id: ID,
    amount: u64,
    claimed_at_ms: u64,
    remaining_count: u64,
    remaining_balance: u64,
}

#[test_only]
public struct RefundedFields has drop {
    packet_id: ID,
    channel_id: ID,
    amount: u64,
    refunded_at_ms: u64,
    unclaimed_count: u64,
}

// === Test-Only Functions ===

#[test_only]
public fun claim_equal_for_testing<CoinType>(
    self: &mut RedPacket<CoinType>, channel: &ChatChannel, clock: &Clock, ctx: &mut TxContext,
) {
    self.claim_equal(channel, clock, ctx);
}

#[test_only]
public fun claim_random_for_testing<CoinType>(
    self: &mut RedPacket<CoinType>, channel: &ChatChannel, clock: &Clock,
    random: &Random, ctx: &mut TxContext,
) {
    self.claim_random(channel, clock, random, ctx);
}

#[test_only]
public fun refund_for_testing<CoinType>(self: &mut RedPacket<CoinType>, clock: &Clock, ctx: &mut TxContext) {
    self.refund(clock, ctx);
}

#[test_only]
public fun snapshot_for_testing<CoinType>(self: &RedPacket<CoinType>): Snapshot {
    let refunded = match (&self.lifecycle) {
        Lifecycle::Open => 0,
        Lifecycle::Refunded { amount } => *amount,
    };
    Snapshot {
        channel_id: self.channel_id,
        creator: self.creator,
        greeting: self.greeting,
        initial_amount: self.initial_amount,
        count: self.count,
        is_random: self.is_random,
        expires_at_ms: self.expires_at_ms,
        claimed_count: self.claims.length(),
        remaining_balance: self.escrow.value(),
        refunded_amount: refunded,
    }
}

#[test_only]
public fun record_for_testing<CoinType>(self: &RedPacket<CoinType>, index: u64): RecordFields {
    let record = &self.claims[index];
    RecordFields { recipient: record.recipient, amount: record.amount, claimed_at_ms: record.claimed_at_ms }
}

#[test_only]
public fun created_fields<CoinType>(event: Created<CoinType>): CreatedFields {
    let Created { packet_id, channel_id, amount, count, is_random, greeting, expires_at_ms } = event;
    CreatedFields { packet_id, channel_id, amount, count, is_random, greeting, expires_at_ms }
}

#[test_only]
public fun claimed_fields<CoinType>(event: Claimed<CoinType>): ClaimedFields {
    let Claimed { packet_id, channel_id, amount, claimed_at_ms, remaining_count, remaining_balance } = event;
    ClaimedFields { packet_id, channel_id, amount, claimed_at_ms, remaining_count, remaining_balance }
}

#[test_only]
public fun refunded_fields_for_testing<CoinType>(event: Refunded<CoinType>): RefundedFields {
    let Refunded { packet_id, channel_id, amount, refunded_at_ms, unclaimed_count } = event;
    RefundedFields { packet_id, channel_id, amount, refunded_at_ms, unclaimed_count }
}

#[test_only]
public fun snapshot_channel(snapshot: &Snapshot): ID { snapshot.channel_id }
#[test_only]
public fun snapshot_creator(snapshot: &Snapshot): address { snapshot.creator }
#[test_only]
public fun snapshot_greeting(snapshot: &Snapshot): String { snapshot.greeting }
#[test_only]
public fun snapshot_initial_amount(snapshot: &Snapshot): u64 { snapshot.initial_amount }
#[test_only]
public fun snapshot_count(snapshot: &Snapshot): u64 { snapshot.count }
#[test_only]
public fun snapshot_is_random(snapshot: &Snapshot): bool { snapshot.is_random }
#[test_only]
public fun snapshot_expiry(snapshot: &Snapshot): u64 { snapshot.expires_at_ms }
#[test_only]
public fun snapshot_claimed_count(snapshot: &Snapshot): u64 { snapshot.claimed_count }
#[test_only]
public fun snapshot_remaining_balance(snapshot: &Snapshot): u64 { snapshot.remaining_balance }
#[test_only]
public fun snapshot_refunded_amount(snapshot: &Snapshot): u64 { snapshot.refunded_amount }

#[test_only]
public fun record_recipient(record: &RecordFields): address { record.recipient }
#[test_only]
public fun record_amount(record: &RecordFields): u64 { record.amount }
#[test_only]
public fun record_claimed_at(record: &RecordFields): u64 { record.claimed_at_ms }

#[test_only]
public fun created_packet(event: &CreatedFields): ID { event.packet_id }
#[test_only]
public fun created_channel(event: &CreatedFields): ID { event.channel_id }
#[test_only]
public fun created_amount(event: &CreatedFields): u64 { event.amount }
#[test_only]
public fun created_count(event: &CreatedFields): u64 { event.count }
#[test_only]
public fun created_is_random(event: &CreatedFields): bool { event.is_random }
#[test_only]
public fun created_greeting(event: &CreatedFields): String { event.greeting }
#[test_only]
public fun created_expiry(event: &CreatedFields): u64 { event.expires_at_ms }

#[test_only]
public fun claimed_packet(event: &ClaimedFields): ID { event.packet_id }
#[test_only]
public fun claimed_channel(event: &ClaimedFields): ID { event.channel_id }
#[test_only]
public fun claimed_amount(event: &ClaimedFields): u64 { event.amount }
#[test_only]
public fun claimed_at(event: &ClaimedFields): u64 { event.claimed_at_ms }
#[test_only]
public fun claimed_remaining_count(event: &ClaimedFields): u64 { event.remaining_count }
#[test_only]
public fun claimed_remaining_balance(event: &ClaimedFields): u64 { event.remaining_balance }

#[test_only]
public fun refunded_packet(event: &RefundedFields): ID { event.packet_id }
#[test_only]
public fun refunded_channel(event: &RefundedFields): ID { event.channel_id }
#[test_only]
public fun refunded_amount(event: &RefundedFields): u64 { event.amount }
#[test_only]
public fun refunded_at(event: &RefundedFields): u64 { event.refunded_at_ms }
#[test_only]
public fun refunded_unclaimed_count(event: &RefundedFields): u64 { event.unclaimed_count }
