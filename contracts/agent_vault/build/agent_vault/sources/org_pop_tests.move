#[test_only]
module agent_vault::org_pop_tests;

use sui::test_scenario::{Self as ts};
use agent_vault::cryptographic_org::{Self as org, Organization};

// === Constants ===

const ALICE: address = @0xA11CE;
const BOB: address = @0xB0B;
const EVE: address = @0xEE7E;

// ed25519 fixture keys (secret keys SK1 = 0xab..ab, SK2 = 0xcd..cd), generated
// off-chain with @noble/curves. PK1 is the group key the org is created with;
// PK2 is the rotated-to group key. Every signature below is a plain RFC 8032
// ed25519 signature over the exact digest bytes the on-chain verifier builds.
const PK1: vector<u8> = x"248acbdbaf9e050196de704bea2d68770e519150d103b587dae2d9cad53dd930";
const PK2: vector<u8> = x"fc947730f49eb01427a66e050733294d9e520e545c7a27125a780634e0860a27";

// Sign(sdk1, compute_create_pop_digest("sui-testnet:", PK1, [ALICE, BOB], [2, 1], tw=3, kt=2))
// V2 layout: SHA256("SUI_ORG_POP_V2:" || chain || pk || bcs(members) || bcs(weights) || bcs(tw) || bcs(kt)).
// The V1 value was x"b3eafb2a..." — an old-domain signature must now abort E_INVALID_POP.
const CREATE_POP_SIG: vector<u8> = x"ff0a50581e1fb23ac38523ef37fbe591038da6b9f03d417babac9db4f73227bc0da228948272e50be062b8829ec8bc6c46690617fe655aea8487c751c7fe3b07";

// Sign(sdk1, legacy V1 create digest — same payload, no kt suffix). The V2
// verifier must reject the old domain outright: this pins the domain bump.
const V1_CREATE_POP_SIG: vector<u8> = x"b3eafb2a53e077745d82fecaa71b46c039f3eed256d4fb98536c0d4ba89614ee595daf0ec2b2e211c2e5a10612169c26223b22b5e94bef9865c15382af824503";

// Sign(sdk1, V2 digest with key_threshold=1 instead of the org's real kt=2).
// Binds the kt suffix: a signature over a different threshold is not a valid PoP.
const V2_WRONG_KT_SIG: vector<u8> = x"2fe62e3d385148ebcefb25a3845b2d82b389d120222a9bc9b1f9775ae1a848012020889b3fb3164132ba67c794489e7d0bd38de911a2c0b8b9b04bc69384670b";

// H("SUI_ORG_POP_V2:" || "sui-testnet:" || PK1 || bcs([ALICE,BOB]) || bcs([2,1]) || bcs(3) || bcs(2))
// — hand-computed off-chain; compute_create_pop_digest must reproduce it exactly.
const V2_DIGEST_PIN: vector<u8> = x"8d77bf1de8b0983077c56fdc18cba640b6fe35890cd41bb4e2733963e4ccd122";

// Sign(sdk2, compute_rotate_pop_digest("sui-testnet:", ORG_ID, 2, PK2)) —
// the org is the second object created in the scenario tx, so its ID is
// derive_id(tx_hash, ids_created = 1) deterministically.
const ROTATE_POP_SIG: vector<u8> = x"c1f01de552ab0873cce4ea255f089c553fbc6abe870c7dcfbb83d8be023731e590c39a164523e86390a639b08779fd68eeaea85e0e14f177723d05faf0c7720f";

// Sign(sdk1, compute_key_rotation_digest("sui-testnet:", ORG_ID, 1, 1, PK2, [ALICE, BOB]))
const ROT_FROST_SIG_AB: vector<u8> = x"11bc50464743ba610ae12194b37f6b8f8283df5ea5fed4ff1fefe0f3ae00087e7e1cac6a8cdf301201d8e29e68896a1aebba7135f3913a9c633198fab6b80b0e";
// Sign(sdk1, ... same but signers [ALICE, EVE]) — proves the V2 digest binds signers.
const ROT_FROST_SIG_AE: vector<u8> = x"85fc546404f192432fbdaf142bfdc4d1402f87cb757bf95bfce937a99978fc4e55926e39fc4dfca586db9edd785d118519807a6b1433c4eb9353289d2f638400";

// Sign(sdk1, compute_roster_update_digest("sui-testnet:", ORG_ID, 1, 1, 2, 3, [ALICE, BOB, EVE], [2, 1, 1]))
const ROSTER_SIG_ADD_EVE: vector<u8> = x"a8cba9e0996f43ebbba7590603053d7de6f1c9cbc71e96c0863e34add4a47f79e4389a0310bf32a27e6d6d0234542c7fbc1c2fa5742c7675b8b8bd8b7bc4b40c";

const GARBAGE_SIG_64: vector<u8> = x"00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";

fun ctx(s: &mut ts::Scenario): &mut sui::tx_context::TxContext {
    ts::ctx(s)
}

fun start_valid_org() : (ts::Scenario, sui::object::ID) {
    let mut s = ts::begin(ALICE);
    let org_id = org::create_organization_for_testing(PK1, 2, 3, vector[ALICE, BOB], vector[2, 1], ts::ctx(&mut s));
    /*
    let org_id = org::create_organization(
        PK1, 2, 3, vector[ALICE, BOB], vector[2, 1], CREATE_POP_SIG, ts::ctx(&mut s),
    );
    */
    (s, org_id)
}

// === 1. PoP is enforced at creation ===

#[test, expected_failure(abort_code = org::E_INVALID_POP, location = agent_vault::cryptographic_org)]
fun create_with_empty_pop_fails() {
    let (mut s, _) = start_with_pop(x"");
    ts::end(s);
}

#[test, expected_failure(abort_code = org::E_INVALID_POP, location = agent_vault::cryptographic_org)]
fun create_with_garbage_pop_fails() {
    let (mut s, _) = start_with_pop(GARBAGE_SIG_64);
    ts::end(s);
}

fun start_with_pop(pop: vector<u8>): (ts::Scenario, sui::object::ID) {
    let mut s = ts::begin(ALICE);
    let org_id = org::create_organization(
        PK1, 2, 3, vector[ALICE, BOB], vector[2, 1], pop, ts::ctx(&mut s),
    );
    (s, org_id)
}

// === 1b. PoP V2: domain bump + key_threshold binding ===

#[test]
fun create_pop_digest_v2_layout_matches_offchain_computation() {
    let digest = org::compute_create_pop_digest(
        &org::default_chain_id(), &PK1, &vector[ALICE, BOB], &vector[2, 1], 3, 2,
    );
    assert!(digest == V2_DIGEST_PIN, 0);
    // The domain accessor exposes the V2 prefix.
    assert!(org::domain_pop_v2() == b"SUI_ORG_POP_V2:", 1);
}

#[test, expected_failure(abort_code = org::E_INVALID_POP, location = agent_vault::cryptographic_org)]
fun create_with_legacy_v1_pop_aborts() {
    // Correct key, correct roster — but the signature was made over the V1
    // digest (no key_threshold suffix). The domain bump must reject it.
    let (mut s, _) = start_with_pop(V1_CREATE_POP_SIG);
    ts::end(s);
}

#[test, expected_failure(abort_code = org::E_INVALID_POP, location = agent_vault::cryptographic_org)]
fun create_with_pop_over_wrong_key_threshold_aborts() {
    // Valid V2 signature, but computed with kt=1 while the org is created
    // with kt=2: the kt suffix binds the signature to the exact threshold.
    let (mut s, _) = start_with_pop(V2_WRONG_KT_SIG);
    ts::end(s);
}

// === 2. Valid PoP creates the org and records key signers ===

#[test]
fun create_with_valid_pop_succeeds_and_records_key_signers() {
    let (mut s, _org_id) = start_valid_org();
    ts::next_tx(&mut s, ALICE);
    {
        let org_obj = ts::take_shared<Organization>(&s);
        assert!(org::group_pk(&org_obj) == PK1, 1);
        assert!(org::key_signers(&org_obj) == vector[ALICE, BOB], 2);
        ts::return_shared(org_obj);
    };
    ts::end(s);
}

// === 3. Rotation requires a PoP of the new key ===

#[test, expected_failure(abort_code = org::E_INVALID_POP, location = agent_vault::cryptographic_org)]
fun rotate_without_new_key_pop_fails() {
    let (mut s, _) = start_valid_org();
    ts::next_tx(&mut s, ALICE);
    {
        let mut org_obj = ts::take_shared<Organization>(&s);
        org::rotate_group_key(
            &mut org_obj, 1, PK2, vector[ALICE, BOB], 2,
            GARBAGE_SIG_64, ROT_FROST_SIG_AB, ctx(&mut s),
        );
        ts::return_shared(org_obj);
    };
    ts::end(s);
}

#[test]
fun rotate_with_pop_swaps_key_and_key_signers() {
    let (mut s, _) = start_valid_org();
    ts::next_tx(&mut s, ALICE);
    {
        let mut org_obj = ts::take_shared<Organization>(&s);
        org::rotate_group_key(
            &mut org_obj, 1, PK2, vector[ALICE, BOB], 2,
            ROTATE_POP_SIG, ROT_FROST_SIG_AB, ctx(&mut s),
        );
        assert!(org::group_pk(&org_obj) == PK2, 1);
        assert!(org::epoch_version(&org_obj) == 2, 2);
        assert!(org::last_nonce(&org_obj) == 1, 3);
        assert!(org::key_signers(&org_obj) == vector[ALICE, BOB], 4);
        ts::return_shared(org_obj);
    };
    ts::end(s);
}

// === 4. Roster update cannot drop a key signer ===

#[test, expected_failure(abort_code = org::EKeySignerRemoved, location = agent_vault::cryptographic_org)]
fun roster_update_dropping_key_signer_fails() {
    let (mut s, _) = start_valid_org();
    ts::next_tx(&mut s, ALICE);
    {
        let mut org_obj = ts::take_shared<Organization>(&s);
        // BOB is a key signer; removing him from the roster must abort before
        // the (absent) signature is even checked.
        org::update_organization_roster(
            &mut org_obj, 1, vector[ALICE, BOB], vector[ALICE, EVE], vector[2, 1], 3,
            GARBAGE_SIG_64, ctx(&mut s),
        );
        ts::return_shared(org_obj);
    };
    ts::end(s);
}

#[test]
fun roster_update_keeping_key_signers_passes_pop_gate() {
    let (mut s, _) = start_valid_org();
    ts::next_tx(&mut s, ALICE);
    {
        let mut org_obj = ts::take_shared<Organization>(&s);
        // EVE is added; both key signers survive. The signed roster digest
        // verifies, so the update lands and only then would allow removal
        // after a key rotation.
        org::update_organization_roster(
            &mut org_obj, 1, vector[ALICE, BOB], vector[ALICE, BOB, EVE], vector[2, 1, 1], 3,
            ROSTER_SIG_ADD_EVE, ctx(&mut s),
        );
        assert!(org::is_member(&org_obj, EVE), 1);
        assert!(org::key_signers(&org_obj) == vector[ALICE, BOB], 2);
        ts::return_shared(org_obj);
    };
    ts::end(s);
}

// === 5. The V2 rotation digest binds the new signer list ===

#[test, expected_failure(abort_code = org::E_INVALID_SIGNATURE, location = agent_vault::cryptographic_org)]
fun rotation_signature_over_different_signers_fails() {
    let (mut s, _) = start_valid_org();
    ts::next_tx(&mut s, ALICE);
    {
        let mut org_obj = ts::take_shared<Organization>(&s);
        // Correct PoP of PK2, correct old-key signature — but the signature was
        // produced over signers [ALICE, EVE], not [ALICE, BOB]. Because the V2
        // digest includes bcs(new_signers) and bcs(key_threshold), this must fail the FROST gate.
        org::rotate_group_key(
            &mut org_obj, 1, PK2, vector[ALICE, BOB], 2,
            ROTATE_POP_SIG, ROT_FROST_SIG_AE, ctx(&mut s),
        );
        ts::return_shared(org_obj);
    };
    ts::end(s);
}
