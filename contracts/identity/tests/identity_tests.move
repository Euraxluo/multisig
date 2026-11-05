#[test_only]
module identity::identity_tests;

use std::string;
use sui::{test_scenario::{Self, Scenario}, transfer::Receiving};
use identity::identity::{Self, Name, Names, MessageSent};

// === Constants ===

const ALICE: address = @0xa;
const BOB: address = @0xb;
const CAROL: address = @0xc;

// === Test-Only Types ===

public struct IdentityFixture { scenario: Scenario, names: Names, name: Name }
public struct Parcel has key, store { id: UID, amount: u64 }

// === Public Aliases ===

use fun fixture_end as IdentityFixture.end;
use fun fixture_next_tx as IdentityFixture.next_tx;
use fun fixture_ctx as IdentityFixture.ctx;
use fun fixture_ticket as IdentityFixture.ticket;
use fun fixture_deposit as IdentityFixture.deposit;
use fun fixture_follow as IdentityFixture.follow;
use fun fixture_send as IdentityFixture.send;

// === Tests ===

#[test]
fun labels_normalize_and_accept_boundaries() {
    assert!(identity::normalize_for_testing(b"AbC-123") == string::utf8(b"abc-123"));
    assert!(identity::normalize_for_testing(b"a1b") == string::utf8(b"a1b"));
    assert!(identity::normalize_for_testing(bytes(32, 97)).length() == 32);
}

#[test]
#[expected_failure(abort_code = identity::EInvalidLabelLength, location = identity)]
fun labels_reject_empty() { identity::normalize_for_testing(b""); }
#[test]
#[expected_failure(abort_code = identity::EInvalidLabelLength, location = identity)]
fun labels_reject_two_bytes() { identity::normalize_for_testing(b"ab"); }
#[test]
#[expected_failure(abort_code = identity::EInvalidLabelLength, location = identity)]
fun labels_reject_thirty_three_bytes() { identity::normalize_for_testing(bytes(33, 97)); }
#[test]
#[expected_failure(abort_code = identity::EInvalidLabel, location = identity)]
fun labels_reject_leading_hyphen() { identity::normalize_for_testing(b"-abc"); }
#[test]
#[expected_failure(abort_code = identity::EInvalidLabel, location = identity)]
fun labels_reject_trailing_hyphen() { identity::normalize_for_testing(b"abc-"); }
#[test]
#[expected_failure(abort_code = identity::EInvalidLabel, location = identity)]
fun labels_reject_adjacent_hyphens() { identity::normalize_for_testing(b"ab--cd"); }
#[test]
#[expected_failure(abort_code = identity::EInvalidLabel, location = identity)]
fun labels_reject_space() { identity::normalize_for_testing(b"a b"); }
#[test]
#[expected_failure(abort_code = identity::EInvalidLabel, location = identity)]
fun labels_reject_underscore() { identity::normalize_for_testing(b"a_b"); }
#[test]
#[expected_failure(abort_code = identity::EInvalidLabel, location = identity)]
fun labels_reject_non_ascii() { identity::normalize_for_testing(vector[97, 128, 98]); }

#[test]
fun rename_releases_label_and_preserves_uid_and_registry() {
    let mut f = start_identity();
    let alice = object::id(&f.name);
    assert!(identity::name_for_address(&f.names, ALICE) == option::some(alice));
    assert!(identity::name_for_address(&f.names, CAROL).is_none());
    assert!(identity::resolve(&f.names, b"ALICE") == option::some(alice));
    identity::rename(&mut f.names, &mut f.name, b"New-Alice");
    assert!(object::id(&f.name) == alice);
    assert!(identity::resolve(&f.names, b"alice").is_none());
    assert!(identity::resolve(&f.names, b"new-alice") == option::some(alice));
    identity::assert_renamed_for_testing(alice, string::utf8(b"alice"), string::utf8(b"new-alice"));
    f = f.next_tx!(CAROL, |f| {
        identity::mint(&mut f.names, b"ALICE", f.ctx!());
    });
    f = f.next_tx!(ALICE, |f| {
        assert!(identity::resolve(&f.names, b"alice") != option::some(alice));
        assert!(object::id(&f.name) == alice);
    });
    f.end();
}

#[test]
#[expected_failure(abort_code = identity::ELabelTaken, location = identity)]
fun mint_rejects_normalized_duplicate() {
    let mut f = start_identity();
    f = f.next_tx!(CAROL, |f| { identity::mint(&mut f.names, b"ALICE", f.ctx!()); });
    f.end();
}

#[test]
#[expected_failure(abort_code = identity::EAlreadyRegistered, location = identity)]
fun mint_checks_account_before_duplicate_label() {
    let mut f = start_identity();
    identity::mint(&mut f.names, b"alice", f.ctx!());
    f.end();
}

#[test]
#[expected_failure(abort_code = identity::EInvalidLabelLength, location = identity)]
fun mint_checks_length_before_account() {
    let mut f = start_identity();
    identity::mint(&mut f.names, b"", f.ctx!());
    f.end();
}

#[test]
#[expected_failure(abort_code = identity::ELabelTaken, location = identity)]
fun rename_rejects_conflict() {
    let mut f = start_identity();
    identity::rename(&mut f.names, &mut f.name, b"BOB");
    f.end();
}

#[test]
#[expected_failure(abort_code = identity::EUnchanged, location = identity)]
fun rename_rejects_normalized_noop() {
    let mut f = start_identity();
    identity::rename(&mut f.names, &mut f.name, b"ALICE");
    f.end();
}

#[test]
fun profiles_set_bounds_and_clear_with_complete_events() {
    let mut f = start_identity();
    let id = object::id(&f.name);
    let display = bytes(64, 97);
    let avatar = bytes(512, 98);
    identity::set_profile(&mut f.name, display, avatar);
    identity::assert_profile_for_testing(id, string::utf8(display), string::utf8(avatar));
    let (label, actual_display, actual_avatar) = identity::profile_for_testing(&f.name);
    assert!(label == string::utf8(b"alice"));
    assert!(actual_display == string::utf8(display));
    assert!(actual_avatar == string::utf8(avatar));
    identity::set_profile(&mut f.name, b"", b"");
    let (label, actual_display, actual_avatar) = identity::profile_for_testing(&f.name);
    assert!(label == string::utf8(b"alice"));
    assert!(actual_display == string::utf8(b""));
    assert!(actual_avatar == string::utf8(b""));
    f.end();
}

#[test]
#[expected_failure(abort_code = identity::EProfileTooLong, location = identity)]
fun profile_checks_bounds_before_utf8() {
    let mut f = start_identity();
    identity::set_profile(&mut f.name, bytes(65, 255), b"");
    f.end();
}
#[test]
#[expected_failure(abort_code = identity::EProfileTooLong, location = identity)]
fun profile_rejects_long_avatar() {
    let mut f = start_identity();
    identity::set_profile(&mut f.name, b"", bytes(513, 97));
    f.end();
}
#[test]
#[expected_failure(abort_code = identity::EInvalidUtf8, location = identity)]
fun profile_rejects_invalid_utf8() {
    let mut f = start_identity();
    identity::set_profile(&mut f.name, vector[255], b"");
    f.end();
}
#[test]
#[expected_failure(abort_code = identity::EUnchanged, location = identity)]
fun profile_rejects_noop() {
    let mut f = start_identity();
    identity::set_profile(&mut f.name, b"", b"");
    f.end();
}

#[test]
fun key_rotation_disable_and_events_use_shared_canonical_state() {
    let mut f = start_identity();
    let id = object::id(&f.name);
    identity::set_encryption_key(&mut f.name, &mut f.names, key(1));
    assert!(identity::encryption_key(&f.names, id) == key(1));
    identity::assert_key_event_for_testing(id, key(1));
    identity::set_encryption_key(&mut f.name, &mut f.names, key(2));
    assert!(identity::encryption_key(&f.names, id) == key(2));
    identity::set_encryption_key(&mut f.name, &mut f.names, b"");
    assert!(identity::encryption_key(&f.names, id).is_empty());
    f.end();
}
#[test]
#[expected_failure(abort_code = identity::EInvalidEncryptionKey, location = identity)]
fun key_rejects_wrong_length() {
    let mut f = start_identity();
    identity::set_encryption_key(&mut f.name, &mut f.names, vector[4]);
    f.end();
}
#[test]
#[expected_failure(abort_code = identity::EInvalidEncryptionKey, location = identity)]
fun key_rejects_wrong_prefix() {
    let mut f = start_identity();
    identity::set_encryption_key(&mut f.name, &mut f.names, bytes(65, 2));
    f.end();
}
#[test]
#[expected_failure(abort_code = identity::EUnchanged, location = identity)]
fun key_rejects_noop() {
    let mut f = start_identity();
    identity::set_encryption_key(&mut f.name, &mut f.names, b"");
    f.end();
}
#[test]
#[expected_failure(abort_code = identity::EUnknownName, location = identity)]
fun key_lookup_rejects_unknown_name() {
    let f = start_identity();
    identity::encryption_key(&f.names, object::id_from_address(CAROL));
    f.end();
}

#[test]
fun follow_unfollow_readd_and_mutual_edges_replay() {
    let mut f = start_identity();
    let alice = object::id(&f.name);
    let bob = identity::name_for_address(&f.names, BOB).destroy_some();
    assert!(identity::following_count(&f.name) == 0);
    f.follow(bob);
    identity::assert_followed_for_testing(alice, bob);
    assert!(identity::is_following(&f.name, bob));
    identity::unfollow(&mut f.name, bob);
    identity::assert_unfollowed_for_testing(alice, bob);
    assert!(!identity::is_following(&f.name, bob));
    f.follow(bob);
    f = f.next_tx!(BOB, |f| {
        f.follow(alice);
        assert!(identity::following_count(&f.name) == 1);
    });
    f = f.next_tx!(ALICE, |f| { assert!(identity::is_following(&f.name, bob)); });
    f.end();
}
#[test]
#[expected_failure(abort_code = identity::ESelfTarget, location = identity)]
fun follow_rejects_self() {
    let mut f = start_identity();
    let id = object::id(&f.name);
    f.follow(id);
    f.end();
}
#[test]
#[expected_failure(abort_code = identity::EUnknownName, location = identity)]
fun follow_rejects_unknown_target() {
    let mut f = start_identity();
    f.follow(object::id_from_address(CAROL));
    f.end();
}
#[test]
#[expected_failure(abort_code = identity::EAlreadyFollowing, location = identity)]
fun follow_rejects_duplicate() {
    let mut f = start_identity();
    let bob = identity::name_for_address(&f.names, BOB).destroy_some();
    f.follow(bob);
    f.follow(bob);
    f.end();
}
#[test]
#[expected_failure(abort_code = identity::ENotFollowing, location = identity)]
fun unfollow_rejects_missing_edge() {
    let mut f = start_identity();
    identity::unfollow(&mut f.name, object::id_from_address(CAROL));
    f.end();
}

#[test]
fun messages_emit_all_fields_at_both_ciphertext_bounds() {
    let mut f = start_identity();
    let alice = object::id(&f.name);
    let bob = identity::name_for_address(&f.names, BOB).destroy_some();
    f = f.next_tx!(BOB, |f| { identity::set_encryption_key(&mut f.name, &mut f.names, key(2)); });
    f = f.next_tx!(ALICE, |f| {
        f.send(bob, bytes(17, 8), bytes(12, 9), key(3), key(2));
        identity::assert_message_for_testing(alice, bob, bytes(17, 8), bytes(12, 9), key(3), key(2));
        f.send(bob, bytes(4112, 8), bytes(12, 9), key(3), key(2));
        assert!(sui::event::events_by_type<MessageSent>().length() == 2);
    });
    f.end();
}
#[test]
#[expected_failure(abort_code = identity::EInvalidCiphertext, location = identity)]
fun message_checks_ciphertext_before_nonce_and_key() {
    let mut f = start_identity();
    let bob = identity::name_for_address(&f.names, BOB).destroy_some();
    f.send(bob, bytes(16, 8), b"", b"", b"");
    f.end();
}
#[test]
#[expected_failure(abort_code = identity::EInvalidCiphertext, location = identity)]
fun message_rejects_first_oversize_ciphertext() {
    let mut f = start_identity();
    let bob = identity::name_for_address(&f.names, BOB).destroy_some();
    f.send(bob, bytes(4113, 8), bytes(12, 9), key(3), b"");
    f.end();
}
#[test]
#[expected_failure(abort_code = identity::EInvalidNonce, location = identity)]
fun message_checks_nonce_before_ephemeral_key() {
    let mut f = start_identity();
    let bob = identity::name_for_address(&f.names, BOB).destroy_some();
    f.send(bob, bytes(17, 8), bytes(11, 9), b"", b"");
    f.end();
}
#[test]
#[expected_failure(abort_code = identity::EInvalidEncryptionKey, location = identity)]
fun message_rejects_empty_ephemeral_key() {
    let mut f = start_identity();
    let bob = identity::name_for_address(&f.names, BOB).destroy_some();
    f.send(bob, bytes(17, 8), bytes(12, 9), b"", b"");
    f.end();
}
#[test]
#[expected_failure(abort_code = identity::EEncryptionDisabled, location = identity)]
fun message_rejects_disabled_recipient() {
    let mut f = start_identity();
    let bob = identity::name_for_address(&f.names, BOB).destroy_some();
    f.send(bob, bytes(17, 8), bytes(12, 9), key(3), b"");
    f.end();
}
#[test]
#[expected_failure(abort_code = identity::ERecipientKeyChanged, location = identity)]
fun message_rejects_stale_recipient_key_after_rotation() {
    let mut f = start_identity();
    let bob = identity::name_for_address(&f.names, BOB).destroy_some();
    f = f.next_tx!(BOB, |f| { identity::set_encryption_key(&mut f.name, &mut f.names, key(2)); });
    f = f.next_tx!(ALICE, |f| {
        f.send(bob, bytes(17, 8), bytes(12, 9), key(3), key(1));
    });
    f.end();
}
#[test]
#[expected_failure(abort_code = identity::EUnknownName, location = identity)]
fun message_checks_unknown_id_before_envelope() {
    let mut f = start_identity();
    f.send(object::id_from_address(CAROL), b"", b"", b"", b"");
    f.end();
}
#[test]
#[expected_failure(abort_code = identity::ESelfTarget, location = identity)]
fun message_checks_self_before_envelope() {
    let mut f = start_identity();
    let id = object::id(&f.name);
    f.send(id, b"", b"", b"", b"");
    f.end();
}

#[test]
fun native_transfer_receive_withdraw_preserves_asset_and_name_ids_after_rename() {
    let mut f = start_identity();
    let name_id = object::id(&f.name);
    let asset_id = f.deposit(name_id.to_address());
    f = f.next_tx!(ALICE, |f| {
        identity::rename(&mut f.names, &mut f.name, b"new-alice");
        let ticket = f.ticket<Parcel>(asset_id);
        identity::withdraw(&mut f.name, ticket, BOB);
        assert!(object::id(&f.name) == name_id);
    });
    f = f.next_tx!(BOB, |f| { f.assert_parcel(asset_id, 77); });
    f.end();
}
#[test]
#[expected_failure(abort_code = identity::EInvalidRecipient, location = identity)]
fun withdraw_rejects_zero_before_receiving() {
    let mut f = start_identity();
    let recipient = object::id(&f.name).to_address();
    let id = f.deposit(recipient);
    f = f.next_tx!(ALICE, |f| {
        let ticket = f.ticket<Parcel>(id);
        identity::withdraw(&mut f.name, ticket, @0x0);
    });
    f.end();
}
#[test]
#[expected_failure(abort_code = 3, location = sui::transfer)]
fun withdraw_rejects_asset_for_a_different_parent() {
    let mut f = start_identity();
    let bob = identity::name_for_address(&f.names, BOB).destroy_some();
    let id = f.deposit(bob.to_address());
    f = f.next_tx!(ALICE, |f| {
        let ticket = f.ticket<Parcel>(id);
        identity::withdraw(&mut f.name, ticket, ALICE);
    });
    f.end();
}
#[test]
#[expected_failure(abort_code = 4, location = sui::test_scenario)]
fun unauthorized_sender_cannot_take_alice_name() {
    let mut f = start_identity();
    let alice = object::id(&f.name);
    f = f.next_tx!(BOB, |f| { f.take_unauthorized(alice); });
    f.end();
}

#[test]
fun full_follow_list_allows_removal_and_readdition() {
    let mut f = start_full_following();
    let bob = identity::name_for_address(&f.names, BOB).destroy_some();
    assert!(identity::following_count(&f.name) == 1000);
    identity::unfollow(&mut f.name, bob);
    assert!(identity::following_count(&f.name) == 999);
    f.follow(bob);
    assert!(identity::following_count(&f.name) == 1000);
    // The parent stores only a table handle, never a 1000-entry inline vector.
    assert!(std::bcs::to_bytes(&f.name).length() < 256);
    f.end();
}

#[test]
#[expected_failure(abort_code = identity::EAlreadyFollowing, location = identity)]
fun full_follow_list_checks_duplicate_before_capacity() {
    let mut f = start_full_following();
    let bob = identity::name_for_address(&f.names, BOB).destroy_some();
    f.follow(bob);
    f.end();
}

#[test]
#[expected_failure(abort_code = identity::EFollowingFull, location = identity)]
fun full_follow_list_rejects_first_new_edge() {
    let mut f = start_full_following();
    let target = f.mint_target(2000);
    f.follow(target);
    f.end();
}

#[test]
#[expected_failure(abort_code = identity::ESelfTarget, location = identity)]
fun unfollow_rejects_self_before_missing_edge() {
    let mut f = start_identity();
    let id = object::id(&f.name);
    identity::unfollow(&mut f.name, id);
    f.end();
}

// === Test-Only Functions ===

fun bytes(n: u64, byte: u8): vector<u8> { vector::tabulate!(n, |_| byte) }
fun key(byte: u8): vector<u8> {
    let mut result = bytes(65, byte);
    *&mut result[0] = 4;
    result
}

fun start_identity(): IdentityFixture {
    let mut scenario = test_scenario::begin(ALICE);
    identity::init_for_testing(scenario.ctx());
    assert!(sui::event::num_events() == 0);
    scenario.next_tx(ALICE);
    let mut names = scenario.take_shared<Names>();
    identity::mint(&mut names, b"Alice", scenario.ctx());
    let id = identity::name_for_address(&names, ALICE).destroy_some();
    identity::assert_minted_for_testing(id, string::utf8(b"alice"));
    test_scenario::return_shared(names);
    scenario.next_tx(BOB);
    let mut names = scenario.take_shared<Names>();
    identity::mint(&mut names, b"bob", scenario.ctx());
    test_scenario::return_shared(names);
    scenario.next_tx(ALICE);
    let names = scenario.take_shared<Names>();
    let name = scenario.take_from_sender<Name>();
    IdentityFixture { scenario, names, name }
}

macro fun fixture_ctx($f: &mut IdentityFixture): &mut TxContext { let f = $f; f.scenario.ctx() }

macro fun fixture_next_tx($f: IdentityFixture, $sender: address, $body: |&mut IdentityFixture|): IdentityFixture {
    let IdentityFixture { mut scenario, names, name } = $f;
    test_scenario::return_shared(names);
    let owner = if (test_scenario::was_taken_from_address(ALICE, object::id(&name))) ALICE else BOB;
    test_scenario::return_to_address(owner, name);
    let sender = $sender;
    scenario.next_tx(sender);
    let names = scenario.take_shared<Names>();
    // A fresh account only mints in the closure; Alice's stored Name is never used there.
    let name = if (test_scenario::has_most_recent_for_address<Name>(sender)) {
        scenario.take_from_sender<Name>()
    } else {
        test_scenario::take_from_address<Name>(&scenario, ALICE)
    };
    let mut f = IdentityFixture { scenario, names, name };
    $body(&mut f);
    f
}

fun fixture_end(f: IdentityFixture) {
    let IdentityFixture { scenario, names, name } = f;
    test_scenario::return_shared(names);
    let owner = if (test_scenario::was_taken_from_address(ALICE, object::id(&name))) ALICE else BOB;
    test_scenario::return_to_address(owner, name);
    scenario.end();
}

fun fixture_ticket<Asset: key>(_: &IdentityFixture, id: ID): Receiving<Asset> {
    test_scenario::receiving_ticket_by_id(id)
}
fun fixture_deposit(f: &mut IdentityFixture, recipient: address): ID {
    let parcel = Parcel { id: object::new(f.scenario.ctx()), amount: 77 };
    let id = parcel.id.to_inner();
    transfer::public_transfer(parcel, recipient);
    id
}
fun assert_parcel(f: &IdentityFixture, expected_id: ID, amount: u64) {
    let parcel = f.scenario.take_from_sender<Parcel>();
    assert!(object::id(&parcel) == expected_id && parcel.amount == amount);
    f.scenario.return_to_sender(parcel);
}
fun start_full_following(): IdentityFixture {
    let mut f = start_identity();
    let bob = identity::name_for_address(&f.names, BOB).destroy_some();
    f.follow(bob);
    identity::fill_following_for_testing(&mut f.name);
    f
}
fun mint_target(f: &mut IdentityFixture, n: u64): ID {
    let account = sui::address::from_u256((n as u256) + 10_000);
    f.scenario.next_tx(account);
    identity::mint(&mut f.names, account.to_string().substring(32, 64).into_bytes(), f.scenario.ctx());
    let id = identity::name_for_address(&f.names, account).destroy_some();
    f.scenario.next_tx(ALICE);
    id
}
fun fixture_follow(f: &mut IdentityFixture, target: ID) {
    let IdentityFixture { name, names, scenario: _ } = f;
    identity::follow(name, names, target);
}
fun fixture_send(f: &mut IdentityFixture, recipient: ID, ciphertext: vector<u8>, nonce: vector<u8>, ephemeral_key: vector<u8>, recipient_key: vector<u8>) {
    let IdentityFixture { name, names, scenario: _ } = f;
    identity::send_message(name, names, recipient, ciphertext, nonce, ephemeral_key, recipient_key);
}
fun take_unauthorized(f: &IdentityFixture, id: ID) {
    let name = f.scenario.take_from_sender_by_id<Name>(id);
    f.scenario.return_to_sender(name);
}
