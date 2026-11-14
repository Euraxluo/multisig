/// Stake-gated SUI payments, isolated from legacy policies by new defining types.
/// This module authorizes only its own `pay` endpoint, never third-party package execution.
/// The admin fixes each app's channel, positive minimum stake, recipient and MIST limits.
/// Admin compromise can register or pause apps in its own registry, but cannot withdraw
/// membership deposits, alter registered payment terms, or redirect a submitted payment.
///
/// Conservation per payment: input Coin<SUI> value = value delivered to the stored recipient.
/// The registry holds no assets. Membership principal remains in onchain_chat; the borrowed
/// receipt stays usable for repeated payments and for leave/refund, including while paused.
/// Receipts are transferable, but only their embedded original member may use them here.
/// Budgets are shared across all payers of one app per Sui epoch, not per calendar day.
///
/// Registry entries are bounded and retained permanently; there is no deposit-custody or
/// cleanup obligation. Capability ownership is discoverable through native object effects.
/// This additive module cannot retire legacy registries or insecure old callable bytecode.
/// Clients must explicitly adopt the new API and type lineage. NOT DEPLOYED: publication,
/// compatibility/deployed-ABI verification and operational adoption remain release gaps.
module agent_vault::walrus_app_policy;

use std::string::String;
use sui::{coin::Coin, sui::SUI, table::{Self, Table}};
use agent_vault::onchain_chat::{Self, ChatChannel, MemberStakeReceipt};

// === Constants ===

/// At most 128 dynamic policy entries; no operation iterates over the registry.
const MAX_APPS: u64 = 128;
const MAX_BLOB_ID_BYTES: u64 = 128;

// === Errors ===

#[error(code = 1)]
const EWrongRegistry: vector<u8> = b"Admin capability must belong to this exact registry.";
#[error(code = 2)]
const EInvalidBlobId: vector<u8> = b"Blob ID must contain between one and 128 UTF-8 bytes.";
#[error(code = 3)]
const EAlreadyRegistered: vector<u8> = b"Payment app must not already be registered.";
#[error(code = 4)]
const ERegistryFull: vector<u8> = b"Registry must contain fewer than 128 apps before registration.";
#[error(code = 5)]
const EZeroStakeChannel: vector<u8> = b"Payment channel must require a positive member stake.";
#[error(code = 6)]
const EInvalidMinStake: vector<u8> = b"Minimum member stake must be positive.";
#[error(code = 7)]
const EMinStakeTooHigh: vector<u8> = b"Minimum member stake must not exceed the channel requirement.";
#[error(code = 8)]
const EInvalidRecipient: vector<u8> = b"Payment recipient must not be the zero address.";
#[error(code = 9)]
const EInvalidMaxPayment: vector<u8> = b"Maximum payment must be positive MIST.";
#[error(code = 10)]
const EInvalidEpochBudget: vector<u8> = b"Per-epoch payment budget must be positive MIST.";
#[error(code = 11)]
const EAppNotFound: vector<u8> = b"Payment app must be registered in this registry.";
#[error(code = 12)]
const EAppDisabled: vector<u8> = b"Payment app must be active.";
#[error(code = 13)]
const EUnchangedStatus: vector<u8> = b"New app status must differ from its current status.";
#[error(code = 14)]
const EWrongChannel: vector<u8> = b"Policy, channel and stake receipt must identify the same channel.";
#[error(code = 15)]
const ENotReceiptMember: vector<u8> = b"Sender must be the original member embedded in the receipt.";
#[error(code = 16)]
const EInvalidReceiptStake: vector<u8> = b"Receipt stake must equal the positive channel requirement and meet the policy minimum.";
#[error(code = 17)]
const ENotMember: vector<u8> = b"Receipt member must still belong to the channel.";
#[error(code = 18)]
const EZeroPayment: vector<u8> = b"Actual payment coin value must be positive MIST.";
#[error(code = 19)]
const EExceededTxLimit: vector<u8> = b"Actual payment coin value must not exceed the per-payment limit.";
#[error(code = 20)]
const EExceededEpochBudget: vector<u8> = b"Actual payment coin value must fit the app's remaining epoch budget.";

// === Public Types ===

/// Shared policy state with no coin or balance custody. Only this module can mutate entries.
public struct Registry has key {
    id: UID,
    policies: Table<String, PaymentPolicy>,
    total_apps: u64,
}

/// One transferable capability issued per registry; its target cannot be changed or forged.
public struct AdminCap has key, store {
    id: UID,
    registry_id: ID,
}

/// Immutable payment terms plus the active flag and lazy per-epoch payment accounting.
/// All amounts are MIST. `spent_in_epoch` belongs to `last_payment_epoch` until the next pay.
public struct PaymentPolicy has store {
    channel_id: ID,
    min_member_stake: u64,
    recipient: address,
    max_payment: u64,
    epoch_budget: u64,
    spent_in_epoch: u64,
    last_payment_epoch: u64,
    is_active: bool,
}

/// Full immutable terms allow independent reconstruction of the app's payment policy.
public struct PaymentAppRegistered has copy, drop {
    registry_id: ID,
    blob_id: String,
    channel_id: ID,
    min_member_stake: u64,
    recipient: address,
    max_payment: u64,
    epoch_budget: u64,
    epoch: u64,
}

/// Each occurrence records a real pause or resume transition.
public struct AppStatusChanged has copy, drop {
    registry_id: ID,
    blob_id: String,
    was_active: bool,
    is_active: bool,
}

/// A completed native SUI transfer, never an attestation of arbitrary app execution.
/// Payer is native transaction sender metadata; receipt identity records the proof used.
/// Delta and final epoch total deliberately support accounting reconciliation.
public struct PaymentSent has copy, drop {
    registry_id: ID,
    blob_id: String,
    channel_id: ID,
    receipt_id: ID,
    recipient: address,
    amount: u64,
    epoch: u64,
    spent_in_epoch: u64,
}

// === Public Functions ===

/// Construct an empty registry and its exact-instance admin capability without an initializer.
/// Share the registry with `share`; capability holders may publicly transfer their authority.
public fun new(ctx: &mut TxContext): (Registry, AdminCap) {
    let registry = Registry { id: object::new(ctx), policies: table::new(ctx), total_apps: 0 };
    let cap = AdminCap { id: object::new(ctx), registry_id: registry.id.to_inner() };
    (registry, cap)
}

/// Publish a newly constructed registry as permanent shared state.
public fun share(self: Registry) {
    transfer::share_object(self);
}

/// Register fixed payment terms. No recipient, channel, stake or limit setters exist.
/// A positive channel requirement at least as large as the minimum makes real receipts usable.
public fun register_payment_app(
    self: &mut Registry,
    cap: &AdminCap,
    blob_id: String,
    channel: &ChatChannel,
    min_member_stake: u64,
    recipient: address,
    max_payment: u64,
    epoch_budget: u64,
    ctx: &TxContext,
) {
    self.assert_admin(cap);
    assert_blob_id(&blob_id);
    assert!(!self.policies.contains(blob_id), EAlreadyRegistered);
    assert!(self.total_apps < MAX_APPS, ERegistryFull);
    assert!(min_member_stake > 0, EInvalidMinStake);
    assert!(recipient != @0x0, EInvalidRecipient);
    assert!(max_payment > 0, EInvalidMaxPayment);
    assert!(epoch_budget > 0, EInvalidEpochBudget);
    let required_stake = onchain_chat::required_member_stake(channel);
    assert!(required_stake > 0, EZeroStakeChannel);
    assert!(min_member_stake <= required_stake, EMinStakeTooHigh);

    let channel_id = object::id(channel);
    let epoch = ctx.epoch();
    let policy = PaymentPolicy {
        channel_id, min_member_stake, recipient, max_payment, epoch_budget,
        spent_in_epoch: 0, last_payment_epoch: epoch, is_active: true,
    };

    self.policies.add(blob_id, policy);
    self.total_apps = self.total_apps + 1;

    sui::event::emit(PaymentAppRegistered {
        registry_id: self.id.to_inner(), blob_id, channel_id, min_member_stake,
        recipient, max_payment, epoch_budget, epoch,
    });
}

/// Pause or resume new payments. This never touches membership or restricts leave/refund.
public fun toggle_app_status(self: &mut Registry, cap: &AdminCap, blob_id: String, is_active: bool) {
    self.assert_admin(cap);
    let policy = self.payment_app(blob_id);
    assert!(policy.is_active != is_active, EUnchangedStatus);
    let was_active = policy.is_active;

    self.policies[blob_id].is_active = is_active;

    sui::event::emit(AppStatusChanged { registry_id: self.id.to_inner(), blob_id, was_active, is_active });
}

/// Consume and deliver the entire actual coin to the admin-fixed recipient after all checks.
/// The receipt is borrowed, never consumed or modified. Only its original, live member may pay.
/// No caller-supplied amount, package identity or stake Boolean participates in authorization.
public fun pay(
    self: &mut Registry,
    blob_id: String,
    channel: &ChatChannel,
    receipt: &MemberStakeReceipt,
    payment: Coin<SUI>,
    ctx: &TxContext,
) {
    let policy = self.payment_app(blob_id);
    assert!(policy.is_active, EAppDisabled);
    let channel_id = object::id(channel);
    assert!(policy.channel_id == channel_id, EWrongChannel);
    assert!(onchain_chat::receipt_channel_id(receipt) == channel_id, EWrongChannel);
    assert!(onchain_chat::receipt_member(receipt) == ctx.sender(), ENotReceiptMember);
    let amount = payment.value();
    assert!(amount > 0, EZeroPayment);
    assert!(amount <= policy.max_payment, EExceededTxLimit);
    let required_stake = onchain_chat::required_member_stake(channel);
    let receipt_stake = onchain_chat::receipt_staked_amount(receipt);
    assert!(required_stake > 0 && receipt_stake == required_stake && receipt_stake >= policy.min_member_stake, EInvalidReceiptStake);
    assert!(onchain_chat::is_member(channel, ctx.sender()), ENotMember);

    let epoch = ctx.epoch();
    let spent = if (epoch == policy.last_payment_epoch) { policy.spent_in_epoch } else { 0 };
    // Stored spent never exceeds budget. Subtraction rejects even u64::MAX + 1 with our error.
    assert!(amount <= policy.epoch_budget - spent, EExceededEpochBudget);
    let spent_in_epoch = spent + amount;
    let recipient = policy.recipient;

    transfer::public_transfer(payment, recipient);
    let policy = &mut self.policies[blob_id];
    policy.spent_in_epoch = spent_in_epoch;
    policy.last_payment_epoch = epoch;

    sui::event::emit(PaymentSent {
        registry_id: self.id.to_inner(), blob_id, channel_id, receipt_id: object::id(receipt),
        recipient, amount, epoch, spent_in_epoch,
    });
}

/// Whether a bounded blob ID has an app in this registry.
public fun has_payment_app(self: &Registry, blob_id: String): bool {
    blob_id.length() > 0 && blob_id.length() <= MAX_BLOB_ID_BYTES && self.policies.contains(blob_id)
}

/// Borrow the authoritative policy; unknown or invalid blob IDs abort before table lookup.
public fun payment_app(self: &Registry, blob_id: String): &PaymentPolicy {
    assert_blob_id(&blob_id);
    assert!(self.policies.contains(blob_id), EAppNotFound);
    &self.policies[blob_id]
}

/// Registered entries are permanent and cannot exceed MAX_APPS.
public fun total_apps(self: &Registry): u64 { self.total_apps }
/// Exact registry administered by this capability; native effects track its current owner.
public fun registry_id(self: &AdminCap): ID { self.registry_id }
/// Required authoritative channel object.
public fun channel_id(self: &PaymentPolicy): ID { self.channel_id }
/// Positive minimum stake, in MIST.
public fun min_member_stake(self: &PaymentPolicy): u64 { self.min_member_stake }
/// Fixed native SUI delivery address.
public fun recipient(self: &PaymentPolicy): address { self.recipient }
/// Inclusive maximum payment, in MIST.
public fun max_payment(self: &PaymentPolicy): u64 { self.max_payment }
/// Inclusive total payment budget per Sui epoch, in MIST, across all app payers.
public fun epoch_budget(self: &PaymentPolicy): u64 { self.epoch_budget }
/// Accounted MIST for last_payment_epoch; a later epoch lazily starts at zero on payment.
public fun spent_in_epoch(self: &PaymentPolicy): u64 { self.spent_in_epoch }
/// Epoch to which spent_in_epoch belongs.
public fun last_payment_epoch(self: &PaymentPolicy): u64 { self.last_payment_epoch }
/// Whether new payments are permitted.
public fun is_active(self: &PaymentPolicy): bool { self.is_active }

// === Private Functions ===

fun assert_admin(self: &Registry, cap: &AdminCap) {
    assert!(cap.registry_id == self.id.to_inner(), EWrongRegistry);
}

fun assert_blob_id(blob_id: &String) {
    assert!(blob_id.length() > 0 && blob_id.length() <= MAX_BLOB_ID_BYTES, EInvalidBlobId);
}

// === Test-Only Functions ===

#[test_only]
public fun registered_fields(event: &PaymentAppRegistered): (ID, String, ID, u64, address, u64, u64, u64) {
    (event.registry_id, event.blob_id, event.channel_id, event.min_member_stake,
        event.recipient, event.max_payment, event.epoch_budget, event.epoch)
}

#[test_only]
public fun status_fields(event: &AppStatusChanged): (ID, String, bool, bool) {
    (event.registry_id, event.blob_id, event.was_active, event.is_active)
}

#[test_only]
public fun payment_fields(event: &PaymentSent): (ID, String, ID, ID, address, u64, u64, u64) {
    (event.registry_id, event.blob_id, event.channel_id, event.receipt_id,
        event.recipient, event.amount, event.epoch, event.spent_in_epoch)
}
