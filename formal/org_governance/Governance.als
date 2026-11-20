// Structural model of the authorization surface in
// contracts/agent_vault/sources/cryptographic_org.move (origin/main, a4396c1).
//
// Where the TLA+ model checks transition interleavings, this one checks the
// shape that those transitions rely on: which fields each digest binds, and
// which principal is allowed to drive each entry. Both are read straight off
// the code rather than re-derived.
//
// Scope boundary (alloy-structural.md, step 2):
//   Include      the five governed entries and the fields their digests bind.
//   ExcludeSafe  ed25519 itself, BCS layout, nonce monotonicity — all exercised
//                by the TLA+ model and by golden-vectors.test.ts.
//   ExcludeRisky dealer honesty during resharing. Move has no curve arithmetic,
//                so the contract cannot check it; docs/RESHARING_SECURITY.md §6
//                puts it off-chain. GapAssertion below states that exclusion.
//   Stub         none.

// --- the governed entries, one atom each -----------------------------------
abstract sig Action {}
one sig Advance, Rotate, RosterUpdate, Withdraw, Proposal extends Action {}

// --- fields a digest can bind ------------------------------------------------
abstract sig Field {}
one sig FChain, FOrg, FEpoch, FNonce, FKeyGen, FNewPk, FSigners,
        FThreshold, FMembers, FWeights, FAmount, FRecipient,
        FPayload, FActionType extends Field {}

// What compute_*_digest actually appends. Each row cites the function.
//   Advance      compute_threshold_approval_digest :562
//   Rotate       compute_key_rotation_digest       :510
//   RosterUpdate compute_roster_update_digest      :587
//   Withdraw     compute_genesis_withdraw_digest   :740
//   Proposal     compute_proposal_digest           :535
fun binds: Action -> Field {
    Advance      -> FChain + Advance      -> FOrg + Advance      -> FEpoch +
    Advance      -> FNonce + Advance      -> FKeyGen +
    Rotate       -> FChain + Rotate       -> FOrg + Rotate       -> FEpoch +
    Rotate       -> FNonce + Rotate       -> FNewPk + Rotate     -> FSigners +
    Rotate       -> FThreshold +
    RosterUpdate -> FChain + RosterUpdate -> FOrg + RosterUpdate -> FEpoch +
    RosterUpdate -> FNonce + RosterUpdate -> FThreshold +
    RosterUpdate -> FMembers + RosterUpdate -> FWeights +
    Withdraw     -> FChain + Withdraw     -> FOrg + Withdraw     -> FEpoch +
    Withdraw     -> FNonce + Withdraw     -> FAmount + Withdraw  -> FRecipient +
    Proposal     -> FChain + Proposal     -> FOrg + Proposal     -> FEpoch +
    Proposal     -> FNonce + Proposal     -> FPayload + Proposal -> FActionType
}

// Every governed action shares the four anti-replay fields.
assert CommonBinding {
    all a: Action | FChain + FOrg + FEpoch + FNonce in binds[a]
}

// rotate_group_key binds the key it installs. Drop FNewPk from `binds` and
// this fails — that is the broken.cfg sabotage, restated structurally.
assert RotationBindsItsKey {
    FNewPk in binds[Rotate]
}

// advance binds the key generation, which is what makes a rotation invalidate
// a resharing signed under the previous generation (round 9, :833).
assert AdvanceBindsGeneration {
    FKeyGen in binds[Advance]
}

// A roster change binds both the membership and the weight that decides
// whether the threshold is still reachable (issue #15).
assert RosterBindsComposition {
    FMembers + FWeights + FThreshold in binds[RosterUpdate]
}

// No two actions bind the same set of fields. Combined with the distinct
// domain constants (cryptographic_org.move:18-31) this is why a signature for
// one action can never be replayed as another.
assert DomainSeparation {
    all a, b: Action | a != b implies binds[a] != binds[b]
}

// --- who may drive an action -------------------------------------------------
// Read off the signature check: every one of these five entries calls
// ed25519_verify against org.group_pk and nothing else. There is no
// sender() == member branch anywhere in them.
abstract sig Principal {}
one sig GroupKey, Member, Outsider extends Principal {}

fun authorized: Principal -> Action {
    GroupKey -> Action
}

assert OnlyTheGroupKeyAuthorizes {
    all p: Principal, a: Action |
        (p -> a in authorized) iff p = GroupKey
}

// A member who is not part of the signing threshold, and a complete outsider,
// are the same from the contract's point of view.
assert NoMemberBackdoor {
    no Member.authorized and no Outsider.authorized
}

// --- the deliberate exclusion ------------------------------------------------
// Dealer honesty (RESHARING_SECURITY.md §6) is NOT checked on-chain: Sui Move
// exposes ed25519_verify and not curve arithmetic. This assertion records that
// the model claims nothing about it. It is a gap, and it is meant to stay one
// until the chain grows the opcodes.
abstract sig Claim {}
one sig DealerHonestyOnChain extends Claim {}
fun proven: set Claim { none }

assert GapDealerHonestyOffChain {
    DealerHonestyOnChain not in proven
}

// --- witnesses that the premises are satisfiable (pattern #46) ---------------
// Each `run` shows the quantified assertions above are not vacuously true.
run CommonBindingHolds {
    some a: Action | FNonce in binds[a]
} for 5

run KeyBindsItsRotation {
    FNewPk in binds[Rotate]
} for 5

run DomainsActuallyDiffer {
    some disj a, b: Action | binds[a] != binds[b]
} for 5

run OutsiderIsRefused {
    no Outsider.authorized
} for 5

check CommonBinding for 5
check RotationBindsItsKey for 5
check AdvanceBindsGeneration for 5
check RosterBindsComposition for 5
check DomainSeparation for 5
check OnlyTheGroupKeyAuthorizes for 5
check NoMemberBackdoor for 5
check GapDealerHonestyOffChain for 5
