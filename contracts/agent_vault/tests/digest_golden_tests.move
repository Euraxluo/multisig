#[test_only]
module agent_vault::digest_golden_tests;

// Every digest an on-chain signature is verified against, recomputed here and
// compared byte for byte with the SDK's golden vector
// (packages/multisig/src/agent-vault/org/digest-vectors.json).
//
// The inputs are the generator's (scripts/golden-vectors-gen.mjs), and every
// field in a digest has a value of its own: dropping, repeating, swapping or
// re-encoding any one of them breaks the equality. No signature fixture is
// involved, so a layout change cannot be refit to keep these green.
//
// The two treasury delegation digests are pinned the same way in
// organization_treasury_tests.move. The DKG mailbox AAD never reaches the chain.

use std::vector;
use sui::object;
use agent_vault::asynchronous_proposal;
use agent_vault::cryptographic_org as org;
use agent_vault::dkg_committee;

// Bytes of digest-vectors.json, quoted verbatim.
// golden-vectors.test.ts checks that the two copies agree.
const PROPOSAL_V2: vector<u8> = x"e300117240602164dfbd3d0313f3a9fadda66d3333a807bca2652e9613fdf858";
const EPOCH_ADVANCE_V2: vector<u8> = x"adab5c1397e127cb2694462c75ba972334163ebd595f412a67668167e65770da";
const KEY_ROTATION_V3: vector<u8> = x"499689850f50b9ed3443b63cbd51f27e4d6dfa1c021c45403fb66bf756c2f0e5";
const CREATE_POP_V2: vector<u8> = x"15c15a09799ab28e9a6812a6c36f87ff43f95ff34bfceb764495c33232ae2c83";
const ROTATE_POP_V1: vector<u8> = x"bac3faea170089050bc4b8a3355f55401e5af5be3ec15a166eb6a14cc8b619e2";
const TREASURY_TRANSFER_V3: vector<u8> = x"cd3a5e2489681d8a5390422c8986d57513ab68c20c83d492a939d02e537b4e99";
const ROSTER_UPDATE_V1: vector<u8> = x"2dca429a7c1bdf4ab472cfabbb6cecd65cfaf5bc2c5651d5c6a4d6d178aeafbd";
const GENESIS_WITHDRAW_V1: vector<u8> = x"8a4fcc633e1186acb5be82136d1ede029fae2db4b6753ea458d61685e302ba66";
const DKG_ATTEST_V1: vector<u8> = x"b8914ccec3776b41fe3c3f7aabbe878e6e9720900dc72ab4fc94e9eca7024a4f";

// The generator's inputs.
const CHAIN: vector<u8> = b"sui-testnet:";
const M1: address = @0x2222222222222222222222222222222222222222222222222222222222222222;
const M2: address = @0x3333333333333333333333333333333333333333333333333333333333333333;
const GROUP_PK: vector<u8> = x"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NEW_GROUP_PK: vector<u8> = x"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

fun org_id(): object::ID {
    object::id_from_address(@0x1111111111111111111111111111111111111111111111111111111111111111)
}

#[test]
fun proposal_digest_matches_the_sdk_vector() {
    let payload = b"payload-bytes";
    assert!(
        org::compute_proposal_digest(&CHAIN, org_id(), 3, 7, &payload, 0x05) == PROPOSAL_V2,
        1,
    );
}

#[test]
fun epoch_advance_digest_matches_the_sdk_vector() {
    assert!(
        org::compute_threshold_approval_digest(&CHAIN, org_id(), 3, 9, 4, 2) == EPOCH_ADVANCE_V2,
        1,
    );
}

#[test]
fun key_rotation_digest_matches_the_sdk_vector() {
    assert!(
        org::compute_key_rotation_digest(
            &CHAIN, org_id(), 4, 11, &NEW_GROUP_PK, &vector[M1, M2], 2,
        ) == KEY_ROTATION_V3,
        1,
    );
}

#[test]
fun create_pop_digest_matches_the_sdk_vector() {
    assert!(
        org::compute_create_pop_digest(&CHAIN, &GROUP_PK, &vector[M1, M2], &vector[10, 20], 30, 2)
            == CREATE_POP_V2,
        1,
    );
}

#[test]
fun rotate_pop_digest_matches_the_sdk_vector() {
    assert!(
        org::compute_rotate_pop_digest(&CHAIN, org_id(), 9, &NEW_GROUP_PK) == ROTATE_POP_V1,
        1,
    );
}

#[test]
fun transfer_digest_matches_the_sdk_vector() {
    let proposal_id = object::id_from_address(@0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa);
    let recipient = @0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb;
    let vault_id = object::id_from_address(@0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc);
    assert!(
        asynchronous_proposal::compute_transfer_digest(
            &CHAIN, &org_id(), 6, 21, &proposal_id, &recipient, 1_000_000, &vault_id, 3,
        ) == TREASURY_TRANSFER_V3,
        1,
    );
}

#[test]
fun roster_update_digest_matches_the_sdk_vector() {
    assert!(
        org::compute_roster_update_digest(
            &CHAIN, org_id(), 5, 13, 6, 30, &vector[M1, M2], &vector[15, 15],
        ) == ROSTER_UPDATE_V1,
        1,
    );
}

#[test]
fun genesis_withdraw_digest_matches_the_sdk_vector() {
    let recipient = @0x9999999999999999999999999999999999999999999999999999999999999999;
    assert!(
        org::compute_genesis_withdraw_digest(&CHAIN, org_id(), 1, 8, 500, recipient)
            == GENESIS_WITHDRAW_V1,
        1,
    );
}

#[test]
fun attestation_digest_matches_the_sdk_vector() {
    let session_id = object::id_from_address(@0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd);
    assert!(dkg_committee::compute_attestation_digest(&session_id, &GROUP_PK) == DKG_ATTEST_V1, 1);
}
