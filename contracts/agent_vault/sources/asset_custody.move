/// Organization-governed custody of arbitrary owned objects: the DAO treasury
/// for project capabilities and other non-coin assets.
///
/// Any `key + store` object — an `UpgradeCap`, an `AdminCap`, a collectible —
/// rests here exactly like a coin rests in the SUI vault, and leaves only
/// through weighted organization approval. Deposits are dynamic object fields
/// keyed by `(TypeName, slot)`, so every custodied asset keeps its original
/// object ID and remains independently readable and indexer-visible; the
/// shared custody object carries an inline inventory that one object read can
/// return in full.
///
/// Two terminal uses exist, both gated by the same proposal mechanics as the
/// SUI transfer path (live-roster weights, snapshotted threshold, inclusive
/// deadline, organization and epoch binding, one decision per member):
/// - **Borrow** (`KIND_BORROW`): `take_asset` detaches the asset and returns it
///   as a plain transaction value together with an undroppable `CustodyReceipt`.
///   The PTB may use the asset freely — for example `authorize_upgrade` → the
///   native `Upgrade` command → `commit_upgrade` — and must hand it back with
///   `return_asset` in the same transaction. A receipt can never be dropped, so
///   an unreturned asset aborts the whole transaction: custody is a flash loan,
///   never a leak. Borrow approval is asset-level: the committee approves
///   "this cap, for one transaction", not a specific bytecode digest; the
///   digest-bound variant was the retired `governed_upgrade` module.
///   Additionally (#12) a borrow proposal records
///   `borrow_deadline_ms = min(deadline_ms, creation + 5 minutes)` and
///   `take_asset` refuses to fire after it: an approval cannot stay armed
///   for the proposal's full lifetime. The full #12 mitigation commits the
///   intended PTB digest into the proposal: `create_proposal` takes a 32-byte
///   `action_digest` for borrows (empty for releases), stores it on the
///   proposal, and `take_asset` emits it with `AssetTaken`. Enforcing that
///   the executed borrow PTB's committed PersonalMessage digest equals
///   `action_digest` is the product layer's job; on-chain custody anchors the
///   commitment.
/// - **Release** (`KIND_RELEASE`): `execute_release` transfers the asset to the
///   recipient frozen inside the approved proposal; a relayer cannot redirect it.
///
/// Proposals are single-use and per-slot: a second approved proposal on a slot
/// whose asset was already consumed stays pending forever and aborts with
/// `ESlotNotCustodied` if executed, the same liveness class as a treasury
/// transfer that exceeds the balance. Slot numbers are per-type monotonic while
/// the type is live and restart from zero only after the last live slot of that
/// type is released, at which point no child object remains under that key
/// family; an emptied type entry is deleted so `MAX_DISTINCT_TYPES` counts live
/// types, not tombstones. Only owned objects can enter (shared objects cannot
/// be passed by value); meltable `Coin` assets belong in the Balance-based
/// vault, not here.
///
/// Authority: deposit, proposal creation, and voting require a positive-weight
/// member of the bound organization; execution after threshold is permissionless.
/// Organization key rotation, epochs, thresholds, and terminal decisions remain
/// owned by `cryptographic_org`; an unreachable organization threshold can
/// strand custodied assets, and there is deliberately no personal recovery
/// authority. No init is needed.
module agent_vault::asset_custody;

use std::type_name::{Self, TypeName};
use sui::{
    clock::{Self, Clock},
    dynamic_object_field,
    event,
    object::{Self, ID, UID},
    table::{Self, Table},
    transfer,
    tx_context::{Self, TxContext},
    vec_map::{Self, VecMap},
};
use agent_vault::cryptographic_org::{Self, Organization};

// === Constants ===

const MAX_TITLE_BYTES: u64 = 256;
const MAX_DURATION_MS: u64 = 31_536_000_000;
const MAX_DISTINCT_TYPES: u64 = 64;
const MAX_SLOTS_PER_TYPE: u64 = 128;
/// #12 (bounded mitigation): a borrow may only be taken within this window of
/// proposal creation, so an approved "one transaction" borrow cannot sit armed
/// for the proposal's full lifetime. Real action binding — committing the PTB
/// digest into the proposal — remains the tracked follow-up in issue #12.
const BORROW_WINDOW_MS: u64 = 300_000;


const KIND_BORROW: u8 = 1;
const KIND_RELEASE: u8 = 2;

const STATUS_PENDING: u8 = 1;
const STATUS_EXECUTED: u8 = 2;
const STATUS_REJECTED: u8 = 3;

const VOTE_APPROVE: u8 = 1;
const VOTE_REJECT: u8 = 2;

// === Errors ===

#[error(code = 1)]
const ENotMember: vector<u8> = b"Custody intake and proposals require a current organization member with positive weight.";

#[error(code = 2)]
const EWrongOrganization: vector<u8> = b"Organization must match the governing object stored by the custody or proposal.";

#[error(code = 3)]
const EWrongCustody: vector<u8> = b"Custody must match the proposal's stored custody, and a returned asset must re-enter the custody that lent it.";

#[error(code = 4)]
const EProposalNotPending: vector<u8> = b"Only a pending proposal accepts decisions or execution.";

#[error(code = 5)]
const EProposalExpired: vector<u8> = b"The inclusive proposal deadline has passed.";

#[error(code = 6)]
const EAlreadyVoted: vector<u8> = b"Each member may cast one approval or rejection per proposal.";

#[error(code = 7)]
const EApprovalThresholdMet: vector<u8> = b"Rejection voting closes once approvals reach the proposal threshold.";

#[error(code = 8)]
const EThresholdNotMet: vector<u8> = b"Execution requires the proposal's snapshotted approval threshold.";

#[error(code = 9)]
const EEpochMismatch: vector<u8> = b"Proposal epoch must match the organization's current epoch.";

#[error(code = 10)]
const EWrongProposalKind: vector<u8> = b"Proposal kind must be borrow for take, release for transfer-out, and known at creation.";

#[error(code = 11)]
const ESlotNotCustodied: vector<u8> = b"The slot must currently hold a custodied asset.";

#[error(code = 12)]
const ETooManyTypes: vector<u8> = b"Custody admits at most 64 live asset types.";

#[error(code = 13)]
const ETooManySlots: vector<u8> = b"Custody admits at most 128 live slots per asset type.";

#[error(code = 14)]
const EInvalidRecipient: vector<u8> = b"Release proposals must name a nonzero recipient; borrow proposals must name none.";

#[error(code = 15)]
const EInvalidTitle: vector<u8> = b"Proposal title must contain between 1 and 256 bytes.";

#[error(code = 16)]
const EInvalidDeadline: vector<u8> = b"Proposal deadline must be in the future and no more than 365 days away in milliseconds.";

#[error(code = 17)]
const EWeightMismatch: vector<u8> = b"Claimed weight must equal the live organization roster weight.";

#[error(code = 18)]
const EUnknownSlot: vector<u8> = b"Proposal creation requires a slot that currently holds a custodied asset.";

#[error(code = 19)]
const EWrongAsset: vector<u8> = b"A returned asset must be the exact object the receipt was issued for.";

#[error(code = 20)]
const ESlotReassigned: vector<u8> = b"The approved slot now holds a different asset than the proposal approved.";

#[error(code = 21)]
const EBorrowerMismatch: vector<u8> = b"Only the proposal's proposer may borrow; a release remains relayable because its recipient is frozen.";

#[error(code = 22)]
const EBorrowWindowExpired: vector<u8> = b"A borrow must be taken within the proposal's borrow window; create a fresh proposal instead.";

#[error(code = 23)]
const EInvalidActionDigest: vector<u8> = b"Borrow proposals must commit to an exact 32-byte action digest; release proposals store none.";

// === Public Types ===

/// Shared governance treasury. The inline inventory makes one object read
/// return every live type and slot; the assets themselves are dynamic object
/// field children under `CustodyKey` and keep their original IDs.
public struct AssetCustody has key {
    id: UID,
    org_id: ID,
    inventory: VecMap<TypeName, TypeIndex>,
}

/// Per-type live slot table with the monotonic slot counter.
public struct TypeIndex has copy, drop, store {
    next_slot: u64,
    slots: VecMap<u64, SlotRecord>,
}

/// Inventory row for one custodied asset.
public struct SlotRecord has copy, drop, store {
    object_id: ID,
    depositor: address,
    deposited_ms: u64,
}

/// Dynamic object field name separating type families and slots.
public struct CustodyKey has copy, drop, store {
    type_name: TypeName,
    slot: u64,
}

/// Shared, per-slot decision object. Weights and threshold are snapshotted at
/// creation from the bound organization; `recipient` is frozen for release
/// proposals and zero for borrows; `object_id` freezes the exact asset the
/// committee approved so a reprised slot number cannot re-arm an old approval
/// against a later deposit. Voters record approval (1) or rejection (2) in one
/// shared deduplication table.
public struct CustodyProposal has key {
    id: UID,
    custody_id: ID,
    org_id: ID,
    epoch: u64,
    kind: u8,
    type_name: TypeName,
    slot: u64,
    /// The custodied object this approval is bound to, snapshotted at creation.
    object_id: ID,
    recipient: address,
    proposer: address,
    title: vector<u8>,
    threshold_weight: u64,
    accumulated_weight: u64,
    rejected_weight: u64,
    voters: Table<address, u8>,
    deadline_ms: u64,
    /// #12 mitigation: a borrow must be exercised within this creation-anchored
    /// window; always at or before `deadline_ms`.
    borrow_deadline_ms: u64,
    /// #12 (full mitigation): the 32-byte action digest this borrow approval
    /// is committed to; empty for release proposals. On-chain custody anchors
    /// the commitment; enforcing that the executed borrow PTB's committed
    /// digest equals this value is the product layer's job — the dApp builds
    /// the PTB whose PersonalMessage digest is `action_digest`, and refuses to
    /// relay a borrow whose PTB digest differs.
    action_digest: vector<u8>,
    status: u8,
}
/// Undroppable proof that a borrowed asset must re-enter the exact custody,
/// type, slot, and object it left. Constructed only by `take_asset`, consumed
/// only by `return_asset`; a transaction that strands it aborts entirely.
public struct CustodyReceipt {
    custody_id: ID,
    type_name: TypeName,
    slot: u64,
    /// The exact object that left custody; a substitute cannot satisfy it.
    object_id: ID,
}

/// Authoritative custody discovery record. Creator is native sender metadata.
public struct AssetCustodyCreated has copy, drop {
    custody_id: ID,
    org_id: ID,
}

/// Commitment to one asset use. Creator and proposer are native event metadata.
public struct CustodyProposalCreated has copy, drop {
    proposal_id: ID,
    custody_id: ID,
    org_id: ID,
    epoch: u64,
    kind: u8,
    type_name: TypeName,
    slot: u64,
    recipient: address,
    deadline_ms: u64,
}

/// One member approval with the resynchronized approval total.
public struct CustodyVoteSubmitted has copy, drop {
    proposal_id: ID,
    voter: address,
    weight: u64,
    total_weight: u64,
}

/// One member rejection with the resynchronized rejection total.
public struct CustodyVoteRejected has copy, drop {
    proposal_id: ID,
    weight: u64,
    total_rejected_weight: u64,
}

/// One asset entered custody at a fresh slot. Depositor is native metadata.
public struct AssetDeposited has copy, drop {
    custody_id: ID,
    type_name: TypeName,
    slot: u64,
    object_id: ID,
}

/// One approved borrow began; the asset is a plain value until returned.
/// `action_digest` is the committed borrow PTB digest (#12).
public struct AssetTaken has copy, drop {
    proposal_id: ID,
    custody_id: ID,
    type_name: TypeName,
    slot: u64,
    object_id: ID,
    action_digest: vector<u8>,
}

/// One borrowed asset re-entered its exact custody slot.
public struct AssetReturned has copy, drop {
    custody_id: ID,
    type_name: TypeName,
    slot: u64,
    object_id: ID,
}

/// One approved release paid the proposal's frozen recipient.
public struct AssetReleased has copy, drop {
    proposal_id: ID,
    custody_id: ID,
    type_name: TypeName,
    slot: u64,
    object_id: ID,
    recipient: address,
}

// === Public Functions ===

/// Create a custody treasury for one organization. Call `share` with the
/// returned value in the same PTB. No caller-supplied asset exists.
public fun new(org: &Organization, ctx: &mut TxContext): AssetCustody {
    assert!(cryptographic_org::member_weight(org, ctx.sender()) > 0, ENotMember);

    let self = AssetCustody {
        id: object::new(ctx),
        org_id: object::id(org),
        inventory: vec_map::empty<TypeName, TypeIndex>(),
    };
    event::emit(AssetCustodyCreated {
        custody_id: self.id.to_inner(),
        org_id: self.org_id,
    });
    self
}

/// Publish the shared treasury without exposing any nested authority.
public fun share(self: AssetCustody) {
    transfer::share_object(self);
}

/// Entrust one owned object to organization governance. The asset becomes a
/// dynamic object field child (still readable by its original ID) under a
/// fresh per-type slot; live capacity is bounded per type and across types.
public fun deposit<Asset: key + store>(
    custody: &mut AssetCustody,
    org: &Organization,
    asset: Asset,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(custody.org_id == object::id(org), EWrongOrganization);
    let depositor = ctx.sender();
    assert!(cryptographic_org::member_weight(org, depositor) > 0, ENotMember);

    let type_name = type_name::with_original_ids<Asset>();
    let object_id = object::id(&asset);
    let deposited_ms = clock.timestamp_ms();
    let slot = if (vec_map::contains(&custody.inventory, &type_name)) {
        let index = vec_map::get_mut(&mut custody.inventory, &type_name);
        assert!(vec_map::length(&index.slots) < MAX_SLOTS_PER_TYPE, ETooManySlots);
        let slot = index.next_slot;
        index.next_slot = slot + 1;
        vec_map::insert(
            &mut index.slots,
            slot,
            SlotRecord { object_id, depositor, deposited_ms },
        );
        slot
    } else {
        assert!(vec_map::length(&custody.inventory) < MAX_DISTINCT_TYPES, ETooManyTypes);
        let mut slots = vec_map::empty<u64, SlotRecord>();
        vec_map::insert(&mut slots, 0, SlotRecord { object_id, depositor, deposited_ms });
        vec_map::insert(
            &mut custody.inventory,
            type_name,
            TypeIndex { next_slot: 1, slots },
        );
        0
    };

    dynamic_object_field::add(&mut custody.id, CustodyKey { type_name, slot }, asset);
    event::emit(AssetDeposited {
        custody_id: object::id(custody),
        type_name,
        slot,
        object_id,
    });
}

/// Create and share a per-slot use proposal; returns the proposal ID. The
/// title is 1..256 bytes, the future deadline at most 365 days away, and the
/// slot must currently hold a custodied asset of the type argument. Release
/// proposals freeze their nonzero recipient; borrow proposals must name none.
/// Threshold and epoch are snapshotted from the live organization.
public fun create_proposal<Asset: key + store>(
    custody: &AssetCustody,
    org: &Organization,
    kind: u8,
    title: vector<u8>,
    slot: u64,
    recipient: address,
    deadline_ms: u64,
    action_digest: vector<u8>,
    clock: &Clock,
    ctx: &mut TxContext,
): ID {
    assert!(custody.org_id == object::id(org), EWrongOrganization);
    assert!(cryptographic_org::member_weight(org, ctx.sender()) > 0, ENotMember);
    assert!(kind == KIND_BORROW || kind == KIND_RELEASE, EWrongProposalKind);
    if (kind == KIND_RELEASE) {
        assert!(recipient != @0x0, EInvalidRecipient)
    } else {
        assert!(recipient == @0x0, EInvalidRecipient)
    };
    assert!(!title.is_empty() && title.length() <= MAX_TITLE_BYTES, EInvalidTitle);
    assert!(
        if (kind == KIND_BORROW) action_digest.length() == 32 else action_digest.length() == 0,
        EInvalidActionDigest,
    );
    let now = clock.timestamp_ms();
    assert!(deadline_ms > now && deadline_ms - now <= MAX_DURATION_MS, EInvalidDeadline);
    let type_name = type_name::with_original_ids<Asset>();
    let approved = slot_object(custody, &type_name, slot);
    assert!(approved.is_some(), EUnknownSlot);
    let object_id = approved.destroy_some();

    let uid = object::new(ctx);
    let proposal = CustodyProposal {
        id: uid,
        custody_id: object::id(custody),
        org_id: cryptographic_org::org_id(org),
        epoch: cryptographic_org::epoch_version(org),
        kind,
        type_name,
        slot,
        object_id,
        recipient,
        proposer: ctx.sender(),
        title,
        threshold_weight: cryptographic_org::threshold_weight(org),
        accumulated_weight: 0,
        rejected_weight: 0,
        voters: table::new<address, u8>(ctx),
        deadline_ms,
        // #12 mitigation: shrink the take window of a borrow approval to
        // creation + 5 minutes (still capped by the proposal deadline). A
        // borrow is meant to be used inside one transaction right after
        // approval; the window only removes the "armed for 365 days" state.
        borrow_deadline_ms: if (kind == KIND_BORROW && deadline_ms > now + BORROW_WINDOW_MS) {
            now + BORROW_WINDOW_MS
        } else {
            deadline_ms
        },
        action_digest,
        status: STATUS_PENDING,
    };
    event::emit(CustodyProposalCreated {
        proposal_id: proposal.id.to_inner(),
        custody_id: proposal.custody_id,
        org_id: proposal.org_id,
        epoch: proposal.epoch,
        kind: proposal.kind,
        type_name: proposal.type_name,
        slot: proposal.slot,
        recipient: proposal.recipient,
        deadline_ms: proposal.deadline_ms,
    });
    let proposal_id = proposal.id.to_inner();
    transfer::share_object(proposal);
    proposal_id
}

/// Approve with the transaction sender's live membership weight. Identity,
/// weight, and deduplication mirror the SUI transfer proposal path exactly:
/// status, inclusive deadline, organization and epoch binding, roster-decided
/// weight that must equal the claim, and one decision slot per member.
public fun submit_vote(
    proposal: &mut CustodyProposal,
    org: &Organization,
    clock: &Clock,
    claimed_weight: u64,
    ctx: &mut TxContext,
) {
    assert!(proposal.status == STATUS_PENDING, EProposalNotPending);
    assert!(clock.timestamp_ms() <= proposal.deadline_ms, EProposalExpired);
    assert!(proposal.org_id == cryptographic_org::org_id(org), EWrongOrganization);
    assert!(proposal.epoch == cryptographic_org::epoch_version(org), EEpochMismatch);

    let voter = ctx.sender();
    let actual_weight = cryptographic_org::member_weight(org, voter);
    assert!(actual_weight > 0, ENotMember);
    assert!(claimed_weight == actual_weight, EWeightMismatch);
    assert!(!table::contains(&proposal.voters, voter), EAlreadyVoted);

    table::add(&mut proposal.voters, voter, VOTE_APPROVE);
    proposal.accumulated_weight = proposal.accumulated_weight + actual_weight;

    event::emit(CustodyVoteSubmitted {
        proposal_id: object::uid_to_inner(&proposal.id),
        voter,
        weight: actual_weight,
        total_weight: proposal.accumulated_weight,
    });
}

/// Reject with the transaction sender's live membership weight. Rejection is
/// terminal at the same snapshotted threshold and cannot race an already
/// satisfied approval threshold. The shared deduplication slot is reserved for
/// both decision directions.
public fun reject_vote(
    proposal: &mut CustodyProposal,
    org: &Organization,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(proposal.status == STATUS_PENDING, EProposalNotPending);
    assert!(clock.timestamp_ms() <= proposal.deadline_ms, EProposalExpired);
    assert!(proposal.org_id == cryptographic_org::org_id(org), EWrongOrganization);
    assert!(proposal.epoch == cryptographic_org::epoch_version(org), EEpochMismatch);

    let voter = ctx.sender();
    let actual_weight = cryptographic_org::member_weight(org, voter);
    assert!(actual_weight > 0, ENotMember);
    assert!(!table::contains(&proposal.voters, voter), EAlreadyVoted);
    assert!(proposal.accumulated_weight < proposal.threshold_weight, EApprovalThresholdMet);
    let total_rejected_weight = proposal.rejected_weight + actual_weight;

    table::add(&mut proposal.voters, voter, VOTE_REJECT);
    proposal.rejected_weight = total_rejected_weight;
    if (total_rejected_weight >= proposal.threshold_weight) {
        proposal.status = STATUS_REJECTED;
    };

    event::emit(CustodyVoteRejected {
        proposal_id: object::uid_to_inner(&proposal.id),
        weight: actual_weight,
        total_rejected_weight,
    });
}

/// Begin the approved borrow: detach the asset, mark the proposal executed
/// (single use), and return the asset as a plain transaction value together
/// with the undroppable return proof. Only the proposer may borrow: a borrow
/// hands the asset out as an uncontrolled value, so a relayer must not be able
/// to claim it. The asset can leave this transaction only through
/// `return_asset`.
public fun take_asset<Asset: key + store>(
    custody: &mut AssetCustody,
    proposal: &mut CustodyProposal,
    org: &Organization,
    clock: &Clock,
    ctx: &TxContext,
): (Asset, CustodyReceipt) {
    assert!(proposal.kind == KIND_BORROW, EWrongProposalKind);
    assert!(proposal.custody_id == object::id(custody), EWrongCustody);
    assert!(proposal.status == STATUS_PENDING, EProposalNotPending);
    assert!(clock.timestamp_ms() <= proposal.deadline_ms, EProposalExpired);
    // #12 mitigation: borrows are creation-windowed, so an approved borrow
    // cannot stay armed long after the committee's approval context is gone.
    assert!(clock.timestamp_ms() <= proposal.borrow_deadline_ms, EBorrowWindowExpired);
    assert!(proposal.org_id == cryptographic_org::org_id(org), EWrongOrganization);
    assert!(proposal.epoch == cryptographic_org::epoch_version(org), EEpochMismatch);
    assert!(proposal.accumulated_weight >= proposal.threshold_weight, EThresholdNotMet);
    assert!(
        slot_is_custodied(custody, &proposal.type_name, proposal.slot),
        ESlotNotCustodied,
    );
    // Same binding as `execute_release`: the approval names one exact asset, so
    // a released-and-refilled slot cannot redirect it to a substitute.
    assert!(
        slot_object(custody, &proposal.type_name, proposal.slot) == option::some(proposal.object_id),
        ESlotReassigned,
    );
    // Last: the borrower must be the proposer. Placed after every lifecycle and
    // threshold guard so those keep their precedence, and before any mutation.
    assert!(ctx.sender() == proposal.proposer, EBorrowerMismatch);

    proposal.status = STATUS_EXECUTED;
    let asset = dynamic_object_field::remove<CustodyKey, Asset>(
        &mut custody.id,
        CustodyKey { type_name: proposal.type_name, slot: proposal.slot },
    );
    let receipt = CustodyReceipt {
        custody_id: object::id(custody),
        type_name: proposal.type_name,
        slot: proposal.slot,
        object_id: object::id(&asset),
    };
    event::emit(AssetTaken {
        proposal_id: object::uid_to_inner(&proposal.id),
        custody_id: receipt.custody_id,
        type_name: proposal.type_name,
        slot: proposal.slot,
        object_id: receipt.object_id,
        action_digest: proposal.action_digest,
    });
    (asset, receipt)
}

/// End a borrow in the same transaction: reattach the asset under the exact
/// custody, type, slot, and object identity recorded by its receipt. The
/// inventory row was kept during the atomic borrow window, so the slot is still
/// indexed live and the re-add can never collide with a parallel deposit. A
/// substituted object — same type, same slot — cannot satisfy the receipt, so
/// an approved borrow can never be turned into a permanent custody escape.
///
/// The `Asset` type argument needs no separate check against `receipt.type_name`:
/// `take_asset` removed the dynamic field as `Field<CustodyKey, Asset>` under the
/// key built from the proposal's own type name, so a receipt can only exist for
/// the type it names; and the id equality below already rejects every other
/// object, since one id belongs to exactly one runtime type.
public fun return_asset<Asset: key + store>(
    custody: &mut AssetCustody,
    asset: Asset,
    receipt: CustodyReceipt,
) {
    assert!(receipt.custody_id == object::id(custody), EWrongCustody);
    let CustodyReceipt { custody_id: _, type_name, slot, object_id } = receipt;
    assert!(object::id(&asset) == object_id, EWrongAsset);

    dynamic_object_field::add(&mut custody.id, CustodyKey { type_name, slot }, asset);
    event::emit(AssetReturned {
        custody_id: object::id(custody),
        type_name,
        slot,
        object_id,
    });
}

/// Execute an approved release: transfer the asset to the recipient frozen
/// inside the proposal, drop the inventory row, and delete an emptied type
/// entry so the live-type bound counts live types. Anyone may relay.
public fun execute_release<Asset: key + store>(
    custody: &mut AssetCustody,
    proposal: &mut CustodyProposal,
    org: &Organization,
    clock: &Clock,
) {
    assert!(proposal.kind == KIND_RELEASE, EWrongProposalKind);
    assert!(proposal.custody_id == object::id(custody), EWrongCustody);
    assert!(proposal.status == STATUS_PENDING, EProposalNotPending);
    assert!(clock.timestamp_ms() <= proposal.deadline_ms, EProposalExpired);
    assert!(proposal.org_id == cryptographic_org::org_id(org), EWrongOrganization);
    assert!(proposal.epoch == cryptographic_org::epoch_version(org), EEpochMismatch);
    assert!(proposal.accumulated_weight >= proposal.threshold_weight, EThresholdNotMet);
    assert!(
        slot_is_custodied(custody, &proposal.type_name, proposal.slot),
        ESlotNotCustodied,
    );
    // Same binding as `take_asset`: the approval names one exact asset, so a
    // released-and-refilled slot cannot redirect it to a substitute.
    assert!(
        slot_object(custody, &proposal.type_name, proposal.slot) == option::some(proposal.object_id),
        ESlotReassigned,
    );

    let type_name = proposal.type_name;
    let slot = proposal.slot;
    let recipient = proposal.recipient;
    proposal.status = STATUS_EXECUTED;

    let (object_id, type_now_empty) = {
        let index = vec_map::get_mut(&mut custody.inventory, &type_name);
        let (_, SlotRecord { object_id, depositor: _, deposited_ms: _ }) =
            vec_map::remove(&mut index.slots, &slot);
        (object_id, vec_map::is_empty(&index.slots))
    };
    if (type_now_empty) {
        let (_, removed_index) = vec_map::remove(&mut custody.inventory, &type_name);
        let TypeIndex { next_slot: _, slots } = removed_index;
        vec_map::destroy_empty(slots);
    };
    let asset = dynamic_object_field::remove<CustodyKey, Asset>(
        &mut custody.id,
        CustodyKey { type_name, slot },
    );
    transfer::public_transfer(asset, recipient);
    event::emit(AssetReleased {
        proposal_id: object::uid_to_inner(&proposal.id),
        custody_id: object::id(custody),
        type_name,
        slot,
        object_id,
        recipient,
    });
}

// === Public Aliases ===

/// Governing organization of this custody treasury.
public fun custody_org_id(custody: &AssetCustody): ID {
    custody.org_id
}

/// Number of live asset types currently indexed.
public fun type_count(custody: &AssetCustody): u64 {
    vec_map::length(&custody.inventory)
}

/// Custody this proposal is bound to.
public fun proposal_custody_id(proposal: &CustodyProposal): ID {
    proposal.custody_id
}

/// Organization this proposal is bound to.
public fun proposal_org_id(proposal: &CustodyProposal): ID {
    proposal.org_id
}

/// Epoch snapshotted at proposal creation.
public fun proposal_epoch(proposal: &CustodyProposal): u64 {
    proposal.epoch
}

/// Borrow (1) or release (2).
public fun proposal_kind(proposal: &CustodyProposal): u8 {
    proposal.kind
}

/// Slot the proposal governs.
public fun proposal_slot(proposal: &CustodyProposal): u64 {
    proposal.slot
}

/// Frozen release recipient; zero for borrows.
public fun proposal_recipient(proposal: &CustodyProposal): address {
    proposal.recipient
}

/// Snapshotted approval threshold in organization weight.
public fun proposal_threshold_weight(proposal: &CustodyProposal): u64 {
    proposal.threshold_weight
}

/// Accumulated approval weight.
public fun proposal_accumulated_weight(proposal: &CustodyProposal): u64 {
    proposal.accumulated_weight
}

/// Accumulated rejection weight.
public fun proposal_rejected_weight(proposal: &CustodyProposal): u64 {
    proposal.rejected_weight
}

/// Inclusive deadline in milliseconds.
public fun proposal_deadline_ms(proposal: &CustodyProposal): u64 {
    proposal.deadline_ms
}

/// #12 mitigation: inclusive deadline by which an approved borrow must be
/// taken; equals `deadline_ms` for release proposals.
public fun proposal_borrow_deadline_ms(proposal: &CustodyProposal): u64 {
    proposal.borrow_deadline_ms
}

/// Pending (1), executed (2), or rejected (3).
public fun proposal_status(proposal: &CustodyProposal): u8 {
    proposal.status
}

/// Whether this member cast either decision.
public fun has_voted(proposal: &CustodyProposal, voter: address): bool {
    table::contains(&proposal.voters, voter)
}

// === Private Functions ===

/// The object ID currently indexed for this exact type and slot, if the slot is
/// live. This is the single authority for "which asset does this slot hold":
/// releases, borrows, and proposal creation all compare against it.
fun slot_object(custody: &AssetCustody, type_name: &TypeName, slot: u64): Option<ID> {
    if (!vec_map::contains(&custody.inventory, type_name)) return option::none();
    let index = vec_map::get(&custody.inventory, type_name);
    if (!vec_map::contains(&index.slots, &slot)) return option::none();
    option::some(vec_map::get(&index.slots, &slot).object_id)
}

/// Whether the inventory currently indexes a live slot of this type. Inventory
/// rows exist exactly while their child object rests in this custody: deposits
/// add both, releases remove both, and borrows keep the row for the atomic
/// window of one transaction.
fun slot_is_custodied(custody: &AssetCustody, type_name: &TypeName, slot: u64): bool {
    slot_object(custody, type_name, slot).is_some()
}

// === Test-Only Functions ===

#[test_only]
public fun kind_borrow_for_testing(): u8 {
    KIND_BORROW
}

#[test_only]
public fun kind_release_for_testing(): u8 {
    KIND_RELEASE
}

#[test_only]
public fun status_pending_for_testing(): u8 {
    STATUS_PENDING
}

#[test_only]
public fun status_executed_for_testing(): u8 {
    STATUS_EXECUTED
}

#[test_only]
public fun status_rejected_for_testing(): u8 {
    STATUS_REJECTED
}

#[test_only]
public fun max_distinct_types_for_testing(): u64 {
    MAX_DISTINCT_TYPES
}

#[test_only]
public fun max_slots_per_type_for_testing(): u64 {
    MAX_SLOTS_PER_TYPE
}

#[test_only]
public fun slot_count_for_testing<Asset: key + store>(custody: &AssetCustody): u64 {
    let type_name = type_name::with_original_ids<Asset>();
    if (vec_map::contains(&custody.inventory, &type_name)) {
        vec_map::length(&vec_map::get(&custody.inventory, &type_name).slots)
    } else {
        0
    }
}

#[test_only]
public fun next_slot_for_testing<Asset: key + store>(custody: &AssetCustody): u64 {
    vec_map::get(&custody.inventory, &type_name::with_original_ids<Asset>()).next_slot
}

#[test_only]
public fun slot_record_for_testing<Asset: key + store>(
    custody: &AssetCustody,
    slot: u64,
): (ID, address, u64) {
    let index = vec_map::get(&custody.inventory, &type_name::with_original_ids<Asset>());
    let record = vec_map::get(&index.slots, &slot);
    (record.object_id, record.depositor, record.deposited_ms)
}

/// Conservation seam: whether the dynamic object child of this live-indexed
/// slot is really resting in this custody under the module's key family.
#[test_only]
public fun slot_child_exists_for_testing<Asset: key + store>(
    custody: &AssetCustody,
    slot: u64,
): bool {
    dynamic_object_field::exists_with_type<CustodyKey, Asset>(
        &custody.id,
        CustodyKey { type_name: type_name::with_original_ids<Asset>(), slot },
    )
}

#[test_only]
public fun custody_created_fields(event: &AssetCustodyCreated): (ID, ID) {
    (event.custody_id, event.org_id)
}

#[test_only]
public fun proposal_created_fields(
    event: &CustodyProposalCreated,
): (ID, ID, ID, u64, u8, u64, address, u64) {
    (
        event.proposal_id,
        event.custody_id,
        event.org_id,
        event.epoch,
        event.kind,
        event.slot,
        event.recipient,
        event.deadline_ms,
    )
}

#[test_only]
public fun vote_submitted_fields(event: &CustodyVoteSubmitted): (ID, address, u64, u64) {
    (event.proposal_id, event.voter, event.weight, event.total_weight)
}

#[test_only]
public fun vote_rejected_fields(event: &CustodyVoteRejected): (ID, u64, u64) {
    (event.proposal_id, event.weight, event.total_rejected_weight)
}

#[test_only]
public fun asset_deposited_fields(event: &AssetDeposited): (ID, u64, ID) {
    (event.custody_id, event.slot, event.object_id)
}

#[test_only]
public fun asset_taken_fields(event: &AssetTaken): (ID, ID, u64, ID, vector<u8>) {
    (event.proposal_id, event.custody_id, event.slot, event.object_id, event.action_digest)
}

#[test_only]
public fun asset_returned_fields(event: &AssetReturned): (ID, u64, ID) {
    (event.custody_id, event.slot, event.object_id)
}

#[test_only]
public fun asset_released_fields(event: &AssetReleased): (ID, ID, u64, ID, address) {
    (event.proposal_id, event.custody_id, event.slot, event.object_id, event.recipient)
}

