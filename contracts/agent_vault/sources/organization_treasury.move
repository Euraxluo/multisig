/// Organization-governed custody of a freshly created SUI vault's MasterCap.
///
/// SUI is the only admitted asset: the existing Proposal stores an amount but no
/// asset identity. Each TransferBinding also commits that proposal to its funding
/// treasury. Multiple treasuries may belong to one organization; this module is
/// not an exclusive organization registry.
///
/// The MasterCap is intentionally wrapped inline and is not independently
/// addressable; no seam releases it. It is borrowed at exactly four controlled
/// points: executing an approved transfer, delegating agent authority (setting
/// the vault's outflow caps and issuing an OperatorCap), adjusting that outflow
/// policy, and revoking every issued card. The last three each require the
/// organization's threshold signature over a domain-separated digest carrying a
/// strictly monotonic nonce, so legacy vault and proposal bytecode still cannot
/// reach the sealed authority.
///
/// Delegating again issues a fresh OperatorCap and leaves earlier caps live.
/// There is no per-operator revocation: governance retires cards wholesale by
/// setting the outflow policy with either cap at zero. That stop raises the
/// vault version, so every OperatorCap and AgentCap issued so far is permanently
/// invalid; raising the caps afterwards revives nothing, and agent spending
/// resumes only through a new delegation. While both caps are positive, a card
/// spends at most the smaller of its own limit and the current per-agent cap
/// each epoch, so lowering that cap binds cards already issued.
///
/// While the epoch cap is positive the vault-wide ceiling applies to every
/// outflow, governance transfers included (see vault::withdraw). An approved
/// transfer larger than the epoch's remaining outflow aborts and stays pending
/// until a later epoch or until governance stops the agents with a zero epoch
/// cap. Deposits and balances remain canonical in vault.
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

use sui::{bcs, clock::Clock, ed25519, event, sui::SUI};
use std::hash;
use agent_vault::{
    asynchronous_proposal::{Self, Proposal},
    cryptographic_org::{Self, Organization},
    vault::{Self, AgentVault, MasterCap},
};

// === Constants ===

const MAX_TITLE_BYTES: u64 = 256;
const MAX_DURATION_MS: u64 = 31_536_000_000;

// === Digest domains ===

/// Agent delegation digest (V1). Distinct from SUI_ORG_TREASURY_OUTFLOW_V1 and
/// from the proposal transfer domain: a threshold signature authorizes exactly
/// one action kind. Both bind org/epoch/nonce/treasury/vault/key_generation, so
/// a signature cannot migrate to another organization, treasury, or vault.
const DOMAIN_TREASURY_AGENT_V1: vector<u8> = b"SUI_ORG_TREASURY_AGENT_V1:";

/// Outflow-policy digest (V1). Shares the binding set of the agent domain and
/// differs only in the domain prefix and the absent operator field.
const DOMAIN_TREASURY_OUTFLOW_V1: vector<u8> = b"SUI_ORG_TREASURY_OUTFLOW_V1:";

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

#[error(code = 10)]
const EInvalidOperator: vector<u8> = b"Delegated operator must be a signer address: not zero, and not the address of the organization, the treasury, or the vault.";

#[error(code = 11)]
const EZeroOutflowCap: vector<u8> = b"Delegation requires a positive per-epoch outflow cap.";

#[error(code = 12)]
const EZeroAgentBudget: vector<u8> = b"Delegation requires a positive per-agent budget cap.";

#[error(code = 13)]
const EInvalidNonce: vector<u8> = b"Authorization nonce must strictly exceed the organization's last nonce.";

#[error(code = 14)]
const EInvalidSignature: vector<u8> = b"Threshold signature must verify against the organization group key over the authorization digest.";

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

/// Threshold-authorized agent delegation: caps were set on the sealed vault and
/// an OperatorCap was freshly issued to `operator`. Re-delegation does not
/// revoke earlier caps; zeroing the policy is the governance stop path.
public struct AgentAuthorityDelegated has copy, drop {
    treasury_id: ID,
    vault_id: ID,
    operator: address,
    max_epoch_outflow: u64,
    max_agent_budget: u64,
    nonce: u64,
}

/// Threshold-authorized outflow-policy change on the sealed vault. A zero epoch
/// cap is the stop: it also retires every issued card, and the vault's
/// AgentCapsRevokedEvent carries the new version.
public struct TreasuryOutflowPolicyUpdated has copy, drop {
    treasury_id: ID,
    vault_id: ID,
    max_epoch_outflow: u64,
    max_agent_budget: u64,
    nonce: u64,
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

/// Delegate agent authority over the sealed vault with one threshold signature.
/// Identity guards precede parameter, replay, and signature checks; the vault is
/// then the sole mutable input of the borrowed-cap calls. Anyone may relay the
/// authorization, exactly as with transfer execution: consent comes solely from
/// the FROST signature over the domain-separated digest.
///
/// Repeated delegation issues an additional OperatorCap and does not invalidate
/// earlier ones. Governance retires every card at once through
/// `set_agent_outflow_policy` with either cap at zero; per-operator management is
/// out of scope for this module. The positive epoch cap this sets also bounds
/// approved governance transfers for as long as it is in force.
///
/// The operator has to be an address that can sign. The organization, treasury,
/// and vault object addresses are rejected here because no key controls them;
/// other object or package addresses cannot be told apart on-chain and leave the
/// issued card unusable.
public fun delegate_agent_authority(
    self: &OrganizationTreasury,
    org: &mut Organization,
    vault: &mut AgentVault<SUI>,
    operator: address,
    max_epoch_outflow: u64,
    max_agent_budget: u64,
    nonce: u64,
    frost_signature: vector<u8>,
    ctx: &mut TxContext,
) {
    assert!(self.org_id == object::id(org), EWrongOrganization);
    assert!(self.vault_id == object::id(vault), EWrongVault);
    assert!(
        operator != @0x0
            && operator != sui::object::id_to_address(&self.org_id)
            && operator != sui::object::uid_to_address(&self.id)
            && operator != sui::object::id_to_address(&self.vault_id),
        EInvalidOperator,
    );
    assert!(max_epoch_outflow > 0, EZeroOutflowCap);
    assert!(max_agent_budget > 0, EZeroAgentBudget);
    assert!(nonce > cryptographic_org::last_nonce(org), EInvalidNonce);

    let digest = compute_agent_delegation_digest(
        &cryptographic_org::chain_id(org),
        &cryptographic_org::org_id(org),
        cryptographic_org::epoch_version(org),
        nonce,
        &self.id.to_inner(),
        &self.vault_id,
        &operator,
        max_epoch_outflow,
        max_agent_budget,
        cryptographic_org::key_generation(org),
    );
    assert!(
        ed25519::ed25519_verify(&frost_signature, &cryptographic_org::group_pk(org), &digest),
        EInvalidSignature,
    );

    vault::set_outflow_policy<SUI>(&self.master_cap, vault, max_epoch_outflow, max_agent_budget);
    vault::issue_operator_cap<SUI>(&self.master_cap, vault, operator, ctx);
    cryptographic_org::set_last_nonce(org, nonce);

    event::emit(AgentAuthorityDelegated {
        treasury_id: self.id.to_inner(),
        vault_id: self.vault_id,
        operator,
        max_epoch_outflow,
        max_agent_budget,
        nonce,
    });
}

/// Adjust the sealed vault's outflow policy with one threshold signature.
///
/// - A zero in either cap is the governance stop. No agent can spend under it,
///   so every OperatorCap and AgentCap issued so far is retired outright: the
///   vault version is raised and the agent registry cleared. Raising the caps
///   later revives nothing; spending resumes only through a new
///   `delegate_agent_authority`.
/// - With both caps positive, existing cards stay and only the ceilings move.
///   Each card spends at most the smaller of its own limit and the new
///   `max_agent_budget` per epoch, so a lowered cap binds cards already issued.
///   No new card or new budget may exceed `max_agent_budget`, and total outflow
///   per epoch, governance transfers included, stays under `max_epoch_outflow`.
public fun set_agent_outflow_policy(
    self: &OrganizationTreasury,
    org: &mut Organization,
    vault: &mut AgentVault<SUI>,
    max_epoch_outflow: u64,
    max_agent_budget: u64,
    nonce: u64,
    frost_signature: vector<u8>,
) {
    assert!(self.org_id == object::id(org), EWrongOrganization);
    assert!(self.vault_id == object::id(vault), EWrongVault);
    assert!(nonce > cryptographic_org::last_nonce(org), EInvalidNonce);

    let digest = compute_outflow_policy_digest(
        &cryptographic_org::chain_id(org),
        &cryptographic_org::org_id(org),
        cryptographic_org::epoch_version(org),
        nonce,
        &self.id.to_inner(),
        &self.vault_id,
        max_epoch_outflow,
        max_agent_budget,
        cryptographic_org::key_generation(org),
    );
    assert!(
        ed25519::ed25519_verify(&frost_signature, &cryptographic_org::group_pk(org), &digest),
        EInvalidSignature,
    );

    vault::set_outflow_policy<SUI>(&self.master_cap, vault, max_epoch_outflow, max_agent_budget);
    // Either cap at zero is the stop. No agent can spend under it, so the cards
    // are retired outright instead of left dormant for a later raise.
    if (max_epoch_outflow == 0 || max_agent_budget == 0) {
        vault::revoke_agent_caps<SUI>(&self.master_cap, vault);
    };
    cryptographic_org::set_last_nonce(org, nonce);

    event::emit(TreasuryOutflowPolicyUpdated {
        treasury_id: self.id.to_inner(),
        vault_id: self.vault_id,
        max_epoch_outflow,
        max_agent_budget,
        nonce,
    });
}

// === Digests ===

/// Agent delegation digest (V1):
/// H(DOMAIN_TREASURY_AGENT_V1 || chain_id || bcs(org_id) || bcs(epoch) ||
///   bcs(nonce) || bcs(treasury_id) || bcs(vault_id) || bcs(operator) ||
///   bcs(max_epoch_outflow) || bcs(max_agent_budget) || bcs(key_generation))
/// The layout follows asynchronous_proposal's V3 transfer digest convention
/// (domain prefix, raw chain_id bytes, then BCS of each bound field). Both the
/// treasury and its vault are committed, so a signature cannot migrate across
/// same-organization treasuries; key_generation binding closes the resharing
/// window exactly as in the Round-9 transfer fix.
///
/// Public, like `cryptographic_org::compute_*_digest`: it takes no object and
/// changes nothing. Tests pin it to the SDK's golden vector so the two
/// implementations cannot drift apart field by field.
public fun compute_agent_delegation_digest(
    chain_id: &vector<u8>,
    org_id: &ID,
    epoch: u64,
    nonce: u64,
    treasury_id: &ID,
    vault_id: &ID,
    operator: &address,
    max_epoch_outflow: u64,
    max_agent_budget: u64,
    key_generation: u64,
): vector<u8> {
    let mut data = DOMAIN_TREASURY_AGENT_V1;
    vector::append(&mut data, *chain_id);
    vector::append(&mut data, bcs::to_bytes(org_id));
    vector::append(&mut data, bcs::to_bytes(&epoch));
    vector::append(&mut data, bcs::to_bytes(&nonce));
    vector::append(&mut data, bcs::to_bytes(treasury_id));
    vector::append(&mut data, bcs::to_bytes(vault_id));
    vector::append(&mut data, bcs::to_bytes(operator));
    vector::append(&mut data, bcs::to_bytes(&max_epoch_outflow));
    vector::append(&mut data, bcs::to_bytes(&max_agent_budget));
    vector::append(&mut data, bcs::to_bytes(&key_generation));
    hash::sha2_256(data)
}

/// Outflow-policy digest (V1):
/// H(DOMAIN_TREASURY_OUTFLOW_V1 || chain_id || bcs(org_id) || bcs(epoch) ||
///   bcs(nonce) || bcs(treasury_id) || bcs(vault_id) ||
///   bcs(max_epoch_outflow) || bcs(max_agent_budget) || bcs(key_generation))
/// Same binding set as the agent domain minus the operator field; the distinct
/// prefix keeps one signature from authorizing both action kinds.
/// Public for the same reason as `compute_agent_delegation_digest`.
public fun compute_outflow_policy_digest(
    chain_id: &vector<u8>,
    org_id: &ID,
    epoch: u64,
    nonce: u64,
    treasury_id: &ID,
    vault_id: &ID,
    max_epoch_outflow: u64,
    max_agent_budget: u64,
    key_generation: u64,
): vector<u8> {
    let mut data = DOMAIN_TREASURY_OUTFLOW_V1;
    vector::append(&mut data, *chain_id);
    vector::append(&mut data, bcs::to_bytes(org_id));
    vector::append(&mut data, bcs::to_bytes(&epoch));
    vector::append(&mut data, bcs::to_bytes(&nonce));
    vector::append(&mut data, bcs::to_bytes(treasury_id));
    vector::append(&mut data, bcs::to_bytes(vault_id));
    vector::append(&mut data, bcs::to_bytes(&max_epoch_outflow));
    vector::append(&mut data, bcs::to_bytes(&max_agent_budget));
    vector::append(&mut data, bcs::to_bytes(&key_generation));
    hash::sha2_256(data)
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
public fun agent_delegated_fields(event: &AgentAuthorityDelegated): (ID, ID, address, u64, u64, u64) {
    (
        event.treasury_id, event.vault_id, event.operator,
        event.max_epoch_outflow, event.max_agent_budget, event.nonce,
    )
}

#[test_only]
public fun outflow_policy_updated_fields(event: &TreasuryOutflowPolicyUpdated): (ID, ID, u64, u64, u64) {
    (event.treasury_id, event.vault_id, event.max_epoch_outflow, event.max_agent_budget, event.nonce)
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
