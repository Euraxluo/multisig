/// Organization-governed custody of a freshly created SUI vault's MasterCap.
///
/// SUI is the only admitted asset: the existing Proposal stores an amount but no
/// asset identity. Each TransferBinding also commits that proposal to its funding
/// treasury. Multiple treasuries may belong to one organization; this module is
/// not an exclusive organization registry.
///
/// The MasterCap is intentionally wrapped inline and is not independently
/// addressable. No callable seam releases or borrows it, so legacy vault and
/// proposal bytecode cannot obtain the authority needed to withdraw, issue an
/// operator, or purge this vault. Deposits and balances remain canonical in vault.
/// Exits use the same organization approval path and may pay any stored proposal
/// recipient; executing a payout needs no DKG transaction signature.
///
/// Organization authority, key rotation, epoch invalidation, approval thresholds,
/// deadlines, and terminal decisions remain owned by the existing modules. An
/// unavailable governance quorum or an unreachable organization threshold can
/// strand funds; there is deliberately no personal recovery authority. After an
/// epoch change, members must create and approve a new transfer. Share the returned
/// treasury in its creation PTB: initialize_vault already shares its vault and
/// returns only the cap, so that vault becomes a deposit input in a later PTB.
/// No init is needed, including when this additive module arrives by upgrade.
module agent_vault::organization_treasury;

use sui::{clock::Clock, event, sui::SUI};
use agent_vault::{
    asynchronous_proposal::{Self, Proposal},
    cryptographic_org::{Self, Organization},
    vault::{Self, AgentVault, MasterCap},
};

// === Constants ===

const MAX_TITLE_BYTES: u64 = 256;
const MAX_DURATION_MS: u64 = 31_536_000_000;

// === Errors ===

#[error(code = 1)]
const ENotMember: vector<u8> = b"Treasury creation and transfers require a current organization member with positive weight.";

#[error(code = 2)]
const EWrongOrganization: vector<u8> = b"Organization must match the treasury's stored organization.";

#[error(code = 3)]
const EWrongVault: vector<u8> = b"SUI vault must match the treasury's stored vault.";

#[error(code = 4)]
const EWrongTreasuryBinding: vector<u8> = b"Transfer binding must name this treasury.";

#[error(code = 5)]
const EWrongProposalBinding: vector<u8> = b"Proposal must match the transfer binding's stored proposal.";

#[error(code = 6)]
const EInvalidRecipient: vector<u8> = b"Transfer recipient must not be the zero address.";

#[error(code = 7)]
const EZeroAmount: vector<u8> = b"Transfer amount must be positive in MIST.";

#[error(code = 8)]
const EInvalidTitle: vector<u8> = b"Transfer title must contain between 1 and 256 bytes.";

#[error(code = 9)]
const EInvalidDeadline: vector<u8> = b"Transfer deadline must be in the future and no more than 365 days away in milliseconds.";

// === Public Types ===

/// Shared governance wrapper. Key-only custody prevents external transfer,
/// nesting, freezing, or extraction of the sealed, freshly issued MasterCap.
public struct OrganizationTreasury has key {
    id: UID,
    org_id: ID,
    vault_id: ID,
    master_cap: MasterCap,
}

/// Immutable association issued only alongside a newly created Proposal.
/// Shared and key-only; the proposal's canonical terminal status prevents replay.
public struct TransferBinding has key {
    id: UID,
    treasury_id: ID,
    proposal_id: ID,
}

/// Authoritative treasury discovery record. Creator is native sender metadata.
public struct TreasuryCreated has copy, drop {
    treasury_id: ID,
    org_id: ID,
    vault_id: ID,
}

/// Commits the funding treasury for an ordinary asynchronous proposal. Together
/// with ProposalExecutedEvent, this supplies the durable execution association.
public struct TransferCreated has copy, drop {
    binding_id: ID,
    treasury_id: ID,
    proposal_id: ID,
}

// === Public Functions ===

/// Create a fresh SUI vault and permanently seal its sole MasterCap. Call share
/// with the returned value in this PTB. No caller-supplied cap or coin type exists.
public fun new(org: &Organization, ctx: &mut TxContext): OrganizationTreasury {
    assert!(cryptographic_org::member_weight(org, ctx.sender()) > 0, ENotMember);

    let master_cap = vault::initialize_vault<SUI>(ctx);
    let self = OrganizationTreasury {
        id: object::new(ctx),
        org_id: object::id(org),
        vault_id: vault::master_vault_id(&master_cap),
        master_cap,
    };

    event::emit(TreasuryCreated {
        treasury_id: self.id.to_inner(),
        org_id: self.org_id,
        vault_id: self.vault_id,
    });

    self
}

/// Publish the key-only wrapper without exposing its nested authority.
public fun share(self: OrganizationTreasury) {
    transfer::share_object(self);
}

/// Create and share a proposal plus its sealed funding association. Returns the
/// proposal ID; discover the binding ID through TransferCreated. Membership must
/// have positive current weight. Title is 1..256 bytes, amount is positive MIST,
/// recipient is nonzero, and the future deadline is at most 365 days away in
/// milliseconds. The existing proposal constructor snapshots governance.
public fun create_transfer(
    self: &OrganizationTreasury,
    org: &Organization,
    title: vector<u8>,
    recipient: address,
    amount: u64,
    deadline_ms: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): ID {
    assert!(self.org_id == object::id(org), EWrongOrganization);
    assert!(cryptographic_org::member_weight(org, ctx.sender()) > 0, ENotMember);
    assert!(recipient != @0x0, EInvalidRecipient);
    assert!(amount > 0, EZeroAmount);
    assert!(!title.is_empty() && title.length() <= MAX_TITLE_BYTES, EInvalidTitle);
    let now = clock.timestamp_ms();
    assert!(deadline_ms > now && deadline_ms - now <= MAX_DURATION_MS, EInvalidDeadline);

    let proposal_id = asynchronous_proposal::create_transfer_proposal(
        org, title, recipient, amount, deadline_ms, clock, ctx,
    );
    let binding = TransferBinding {
        id: object::new(ctx),
        treasury_id: self.id.to_inner(),
        proposal_id,
    };
    let binding_id = binding.id.to_inner();
    transfer::share_object(binding);

    event::emit(TransferCreated {
        binding_id,
        treasury_id: self.id.to_inner(),
        proposal_id,
    });

    proposal_id
}

/// Anyone may relay exactly the approved transfer from its committed SUI vault.
/// Identity guards precede the existing status, inclusive deadline, organization,
/// epoch, threshold, amount, and balance checks. Recipient and amount come solely
/// from the stored Proposal. The existing executor emits ProposalExecutedEvent.
public fun execute(
    self: &OrganizationTreasury,
    binding: &TransferBinding,
    org: &mut Organization,
    proposal: &mut Proposal,
    vault: &mut AgentVault<SUI>,
    nonce: u64,
    frost_signature: vector<u8>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(self.org_id == object::id(org), EWrongOrganization);
    assert!(self.vault_id == object::id(vault), EWrongVault);
    assert!(binding.treasury_id == self.id.to_inner(), EWrongTreasuryBinding);
    assert!(binding.proposal_id == object::id(proposal), EWrongProposalBinding);

    asynchronous_proposal::execute_transfer_proposal(
        proposal, org, vault, &self.master_cap, nonce, frost_signature, clock, ctx,
    );
}

// === Test-Only Functions ===

#[test_only]
public fun custody_ids(self: &OrganizationTreasury): (ID, ID, ID) {
    (self.org_id, self.vault_id, object::id(&self.master_cap))
}

#[test_only]
public fun treasury_created_fields(event: &TreasuryCreated): (ID, ID, ID) {
    (event.treasury_id, event.org_id, event.vault_id)
}

#[test_only]
public fun transfer_created_fields(event: &TransferCreated): (ID, ID, ID) {
    (event.binding_id, event.treasury_id, event.proposal_id)
}

#[test_only]
public fun binding_ids(self: &TransferBinding): (ID, ID) {
    (self.treasury_id, self.proposal_id)
}

/// 单测专用：跳过门限签名门的执行入口；生产入口 execute 强制验签。
#[test_only]
public fun execute_for_testing(
    self: &OrganizationTreasury,
    binding: &TransferBinding,
    org: &mut Organization,
    proposal: &mut Proposal,
    vault: &mut AgentVault<SUI>,
    nonce: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(self.org_id == object::id(org), EWrongOrganization);
    assert!(self.vault_id == object::id(vault), EWrongVault);
    assert!(binding.treasury_id == self.id.to_inner(), EWrongTreasuryBinding);
    assert!(binding.proposal_id == object::id(proposal), EWrongProposalBinding);
    asynchronous_proposal::execute_transfer_proposal_for_testing<SUI>(
        proposal, org, vault, &self.master_cap, nonce, clock, ctx,
    );
}
}
