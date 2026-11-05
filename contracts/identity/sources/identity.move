/// Permanent address-bound identities, unique mutable labels, asset exits and social facts.
/// Native owned-object access is the authority. No transfer, freeze, share or destroy sink
/// is exposed for Name: its UID remains a usable receiving parent for its lifetime.
module identity::identity;

use std::{ascii, string::{Self, String}};
use sui::{table::{Self, Table}, transfer::Receiving};

// === Constants ===

const MIN_LABEL_BYTES: u64 = 3;
const MAX_LABEL_BYTES: u64 = 32;
const MAX_DISPLAY_NAME_BYTES: u64 = 64;
const MAX_AVATAR_URL_BYTES: u64 = 512;
const MAX_FOLLOWING: u64 = 1000;
/// A practically unreachable explicit ceiling; table operations never enumerate this set.
const MAX_NAMES: u64 = 1_000_000_000;
const MIN_CIPHERTEXT_BYTES: u64 = 17;
const MAX_CIPHERTEXT_BYTES: u64 = 4112;

// === Errors ===

#[error(code = 1)]
const EInvalidLabelLength: vector<u8> = b"Label must contain 3 to 32 ASCII bytes.";
#[error(code = 2)]
const EInvalidLabel: vector<u8> = b"Label must use letters, digits and isolated internal hyphens.";
#[error(code = 3)]
const EAlreadyRegistered: vector<u8> = b"Address already has a permanent Name.";
#[error(code = 4)]
const ELabelTaken: vector<u8> = b"Normalized label is already registered.";
#[error(code = 5)]
const EUnchanged: vector<u8> = b"Requested value must differ from current value.";
#[error(code = 6)]
const EProfileTooLong: vector<u8> = b"Display name exceeds 64 bytes or avatar URL exceeds 512 bytes.";
#[error(code = 7)]
const EInvalidUtf8: vector<u8> = b"Profile text must be valid UTF-8.";
#[error(code = 8)]
const EInvalidRecipient: vector<u8> = b"Asset recipient must not be zero.";
#[error(code = 9)]
const EInvalidEncryptionKey: vector<u8> = b"Key must be empty or 65 bytes with uncompressed point prefix 4.";
#[error(code = 10)]
const EUnknownName: vector<u8> = b"Target Name must exist in this registry.";
#[error(code = 11)]
const ESelfTarget: vector<u8> = b"Social target must differ from sender Name.";
#[error(code = 12)]
const EAlreadyFollowing: vector<u8> = b"Name already follows target.";
#[error(code = 13)]
const EFollowingFull: vector<u8> = b"Name cannot follow more than 1000 identities.";
#[error(code = 14)]
const ENotFollowing: vector<u8> = b"Name does not follow target.";
#[error(code = 15)]
const EInvalidCiphertext: vector<u8> = b"Ciphertext must contain 17 to 4112 bytes.";
#[error(code = 16)]
const EInvalidNonce: vector<u8> = b"AES-GCM nonce must contain 12 bytes.";
#[error(code = 17)]
const EEncryptionDisabled: vector<u8> = b"Recipient has not enabled encrypted messages.";
#[error(code = 18)]
const ERegistryFull: vector<u8> = b"Registry has reached its one billion identity ceiling.";
#[error(code = 19)]
const ERecipientKeyChanged: vector<u8> = b"Recipient key changed since encryption; encrypt again with the current key.";

// === Public Types ===

/// Singleton shared registry, created only by publication. No administrator or fees.
/// Labels, accounts and keys each contain exactly one entry per live Name.
public struct Names has key {
    id: UID,
    labels: Table<String, ID>,
    accounts: Table<address, ID>,
    encryption_keys: Table<ID, vector<u8>>,
}

/// One permanent, address-owned identity. Empty profile strings mean absent.
/// Following is canonical outgoing membership; incoming and mutual lists are projections.
public struct Name has key {
    id: UID,
    label: String,
    display_name: String,
    avatar_url: String,
    following: Table<ID, bool>,
}

public struct NameMinted has copy, drop { name: ID, label: String }
public struct NameRenamed has copy, drop { name: ID, old_label: String, new_label: String }
public struct ProfileUpdated has copy, drop { name: ID, display_name: String, avatar_url: String }
public struct EncryptionKeyUpdated has copy, drop { name: ID, encryption_key: vector<u8> }
public struct Followed has copy, drop { sender: ID, target: ID }
public struct Unfollowed has copy, drop { sender: ID, target: ID }
/// Sender identity is authenticated by native Name ownership, not an extra signature.
/// The contract validates envelope shapes, not encryption correctness or curve membership.
public struct MessageSent has copy, drop {
    sender: ID,
    recipient: ID,
    ciphertext: vector<u8>,
    nonce: vector<u8>,
    ephemeral_public_key: vector<u8>,
    recipient_key: vector<u8>,
}

// === Private Initialization ===

fun init(ctx: &mut TxContext) {
    transfer::share_object(Names {
        id: object::new(ctx),
        labels: table::new(ctx),
        accounts: table::new(ctx),
        encryption_keys: table::new(ctx),
    });
}

// === Public Functions ===

/// Free except gas/storage. Uppercase ASCII is normalized; no whitespace trimming.
/// Exactly one Name may ever be minted per address; names cannot be transferred or burned.
public fun mint(names: &mut Names, label: vector<u8>, ctx: &mut TxContext) {
    let label = normalize_label(label);
    assert!(!names.accounts.contains(ctx.sender()), EAlreadyRegistered);
    assert!(!names.labels.contains(label), ELabelTaken);
    assert!(names.accounts.length() < MAX_NAMES, ERegistryFull);

    let name = Name {
        id: object::new(ctx),
        label,
        display_name: string::utf8(b""),
        avatar_url: string::utf8(b""),
        following: table::new(ctx),
    };
    let id = name.id.to_inner();
    names.labels.add(label, id);
    names.accounts.add(ctx.sender(), id);
    names.encryption_keys.add(id, vector[]);
    transfer::transfer(name, ctx.sender());

    sui::event::emit(NameMinted { name: id, label });
}

/// Atomically releases the old label and reserves the new one without changing custody.
public fun rename(names: &mut Names, self: &mut Name, label: vector<u8>) {
    let label = normalize_label(label);
    assert!(label != self.label, EUnchanged);
    assert!(!names.labels.contains(label), ELabelTaken);

    let old_label = self.label;
    names.labels.remove(old_label);
    names.labels.add(label, self.id.to_inner());
    self.label = label;

    sui::event::emit(NameRenamed { name: self.id.to_inner(), old_label, new_label: label });
}

/// Replaces both bounded UTF-8 profile fields. Empty bytes clear the corresponding field.
/// URL contents are untrusted presentation input; no scheme or remote resource is attested.
public fun set_profile(self: &mut Name, display_name: vector<u8>, avatar_url: vector<u8>) {
    assert!(display_name.length() <= MAX_DISPLAY_NAME_BYTES && avatar_url.length() <= MAX_AVATAR_URL_BYTES, EProfileTooLong);
    let display_name = string::try_utf8(display_name);
    let avatar_url = string::try_utf8(avatar_url);
    assert!(display_name.is_some() && avatar_url.is_some(), EInvalidUtf8);
    let display_name = display_name.destroy_some();
    let avatar_url = avatar_url.destroy_some();
    assert!(display_name != self.display_name || avatar_url != self.avatar_url, EUnchanged);

    self.display_name = display_name;
    self.avatar_url = avatar_url;

    sui::event::emit(ProfileUpdated { name: self.id.to_inner(), display_name, avatar_url });
}

/// Enables/rotates a structurally encoded uncompressed P-256 key; empty bytes disable.
/// Shared canonical key storage allows messages without borrowing another user's Name.
public fun set_encryption_key(self: &mut Name, names: &mut Names, key: vector<u8>) {
    assert!(key.is_empty() || is_public_key(&key), EInvalidEncryptionKey);
    let id = self.id.to_inner();
    assert!(names.encryption_keys[id] != key, EUnchanged);

    *&mut names.encryption_keys[id] = key;

    sui::event::emit(EncryptionKeyUpdated { name: id, encryption_key: key });
}

/// Adds a directed edge to a registered stable ID. Duplicate check precedes capacity.
public fun follow(self: &mut Name, names: &Names, target: ID) {
    assert!(target != self.id.to_inner(), ESelfTarget);
    assert!(names.encryption_keys.contains(target), EUnknownName);
    assert!(!self.following.contains(target), EAlreadyFollowing);
    assert!(self.following.length() < MAX_FOLLOWING, EFollowingFull);

    self.following.add(target, true);

    sui::event::emit(Followed { sender: self.id.to_inner(), target });
}

/// Removes an existing edge and releases capacity. No recipient-owned input is required.
public fun unfollow(self: &mut Name, target: ID) {
    assert!(target != self.id.to_inner(), ESelfTarget);
    assert!(self.following.contains(target), ENotFollowing);

    self.following.remove(target);

    sui::event::emit(Unfollowed { sender: self.id.to_inner(), target });
}

/// Emits a bounded encrypted envelope authenticated by the sender's owned Name.
/// No plaintext, inbox storage, delivery guarantee, spam prevention or cipher verification.
/// Recipient key is read atomically and included to bind the exact encryption epoch.
public fun send_message(
    self: &mut Name,
    names: &Names,
    recipient: ID,
    ciphertext: vector<u8>,
    nonce: vector<u8>,
    ephemeral_public_key: vector<u8>,
    expected_recipient_key: vector<u8>,
) {
    assert!(recipient != self.id.to_inner(), ESelfTarget);
    assert!(names.encryption_keys.contains(recipient), EUnknownName);
    assert!(ciphertext.length() >= MIN_CIPHERTEXT_BYTES && ciphertext.length() <= MAX_CIPHERTEXT_BYTES, EInvalidCiphertext);
    assert!(nonce.length() == 12, EInvalidNonce);
    assert!(is_public_key(&ephemeral_public_key), EInvalidEncryptionKey);
    let recipient_key = names.encryption_keys[recipient];
    assert!(!recipient_key.is_empty(), EEncryptionDisabled);
    assert!(expected_recipient_key == recipient_key, ERecipientKeyChanged);

    sui::event::emit(MessageSent {
        sender: self.id.to_inner(), recipient, ciphertext, nonce, ephemeral_public_key, recipient_key,
    });
}

/// Receives one native incoming object using the Name UID and transfers it unchanged.
/// Only publicly receivable assets (key + store) are supported; reject zero before receiving.
/// Native transfer effects identify the asset, type, parent and final recipient.
public fun withdraw<Asset: key + store>(self: &mut Name, asset: Receiving<Asset>, recipient: address) {
    assert!(recipient != @0x0, EInvalidRecipient);

    transfer::public_transfer(transfer::public_receive(&mut self.id, asset), recipient);
}

/// Resolves a validated/normalized label to the stable receiving object ID.
public fun resolve(names: &Names, label: vector<u8>): Option<ID> {
    let label = normalize_label(label);
    if (names.labels.contains(label)) option::some(names.labels[label]) else option::none()
}

/// Returns the account's permanent Name ID, if it has minted.
public fun name_for_address(names: &Names, account: address): Option<ID> {
    if (names.accounts.contains(account)) option::some(names.accounts[account]) else option::none()
}

/// Returns the canonical current key; aborts for an unknown ID. Empty means disabled.
public fun encryption_key(names: &Names, name: ID): vector<u8> {
    assert!(names.encryption_keys.contains(name), EUnknownName);
    names.encryption_keys[name]
}

/// Trustless composition read of an outgoing edge.
public fun is_following(self: &Name, target: ID): bool { self.following.contains(target) }

/// Current outgoing cardinality, bounded by 1000.
public fun following_count(self: &Name): u64 { self.following.length() }

// === Private Functions ===

fun normalize_label(bytes: vector<u8>): String {
    assert!(bytes.length() >= MIN_LABEL_BYTES && bytes.length() <= MAX_LABEL_BYTES, EInvalidLabelLength);
    let ascii = ascii::try_string(bytes);
    assert!(ascii.is_some(), EInvalidLabel);
    let label = ascii.destroy_some().to_lowercase();
    let bytes = label.as_bytes();
    let mut previous_hyphen = true;
    let mut i = 0;
    while (i < bytes.length()) {
        let byte = bytes[i];
        let hyphen = byte == 45;
        assert!((byte >= 97 && byte <= 122) || (byte >= 48 && byte <= 57) || (hyphen && !previous_hyphen), EInvalidLabel);
        previous_hyphen = hyphen;
        i = i + 1;
    };
    assert!(!previous_hyphen, EInvalidLabel);
    string::from_ascii(label)
}

fun is_public_key(key: &vector<u8>): bool { key.length() == 65 && key[0] == 4 }

// === Test-Only Functions ===

#[test_only]
public(package) fun init_for_testing(ctx: &mut TxContext) { init(ctx); }

#[test_only]
public(package) fun normalize_for_testing(bytes: vector<u8>): String { normalize_label(bytes) }

/// Isolates the capacity guard from the cost of minting 999 independent identities.
/// Inserts actual table entries, rather than forging the table's length counter.
#[test_only]
public(package) fun fill_following_for_testing(self: &mut Name) {
    let mut n = 1u256;
    while (self.following.length() < MAX_FOLLOWING) {
        let id = sui::address::from_u256(n + 100_000).to_id();
        self.following.add(id, true);
        n = n + 1;
    };
}

#[test_only]
public(package) fun profile_for_testing(self: &Name): (String, String, String) {
    (self.label, self.display_name, self.avatar_url)
}

#[test_only]
public(package) fun assert_minted_for_testing(id: ID, label: String) {
    let events = sui::event::events_by_type<NameMinted>();
    assert!(events.length() == 1);
    assert!(events[0].name == id && events[0].label == label);
}

#[test_only]
public(package) fun assert_renamed_for_testing(id: ID, old_label: String, new_label: String) {
    let events = sui::event::events_by_type<NameRenamed>();
    assert!(events.length() == 1);
    assert!(events[0].name == id && events[0].old_label == old_label && events[0].new_label == new_label);
}

#[test_only]
public(package) fun assert_profile_for_testing(id: ID, display_name: String, avatar_url: String) {
    let events = sui::event::events_by_type<ProfileUpdated>();
    assert!(events.length() == 1);
    assert!(events[0].name == id && events[0].display_name == display_name && events[0].avatar_url == avatar_url);
}

#[test_only]
public(package) fun assert_key_event_for_testing(id: ID, key: vector<u8>) {
    let events = sui::event::events_by_type<EncryptionKeyUpdated>();
    assert!(events.length() == 1);
    assert!(events[0].name == id && events[0].encryption_key == key);
}

#[test_only]
public(package) fun assert_followed_for_testing(sender: ID, target: ID) {
    let events = sui::event::events_by_type<Followed>();
    assert!(events.length() == 1);
    assert!(events[0].sender == sender && events[0].target == target);
}

#[test_only]
public(package) fun assert_unfollowed_for_testing(sender: ID, target: ID) {
    let events = sui::event::events_by_type<Unfollowed>();
    assert!(events.length() == 1);
    assert!(events[0].sender == sender && events[0].target == target);
}

#[test_only]
public(package) fun assert_message_for_testing(
    sender: ID, recipient: ID, ciphertext: vector<u8>, nonce: vector<u8>,
    ephemeral_public_key: vector<u8>, recipient_key: vector<u8>,
) {
    let events = sui::event::events_by_type<MessageSent>();
    assert!(events.length() == 1);
    assert!(events[0].sender == sender && events[0].recipient == recipient);
    assert!(events[0].ciphertext == ciphertext && events[0].nonce == nonce);
    assert!(events[0].ephemeral_public_key == ephemeral_public_key && events[0].recipient_key == recipient_key);
}
