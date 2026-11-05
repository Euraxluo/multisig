# Identity protocol (testnet deployed 2026-10-29)

This separate Sui Move package implements free protocol names, bounded profiles, asset receiving/withdrawal, directed follows and authenticated encrypted message envelopes. Implementation itself sent no chain transactions. On 2026-10-29 the package was published to Sui testnet (tx `D2MkARf6xrhqH2bS77NvuTBZMUVATFDKkB2xeXpgW7Es`): package `0xba0780e7f08a0589c1f71c8b2eff10bfc6d498190c88d4d25292b502c7c9251e`, shared `Names` `0x25193e4ee41b0927cf0624421b50ed97e85cade5c617cf51e38e7eaec58d8294`, UpgradeCap `0x55f8dcf730a9e8632336576365ed86af28131f6cbcd5e86f06aad00a47ad59ce` (publisher address, evolution follows the same fresh-publish policy). Deployment smoke: `mint` executed by a test persona, Name object `0xfcd7dae35fe84ff694a9a86cfe0f824bea223389613a6bd70905ae2a1565aabe` (label `charlie`) verified with correct owner and registry fields (tx `jWbHCYBxbNpVVM6T9m5rrU9mPMgtf86oPjthj5djgjq`). The frontend's externally published vault package has no source in this repository and is not a dependency of this package. Its package ID, objects, authority and asset accounting must not be substituted for identity configuration.

## Local toolchain and gates

Validated with `sui 1.82.1-homebrew`, edition `2024`. Both Sui and MoveStdlib are locked to the existing clean local cache revision `ceaaff1cc84c1ba2f12c4e7928914ece81fbdd0f` of `https://github.com/MystenLabs/sui.git`. `Move.toml` pins the full SHA and the generated `Move.lock` is intended to be checked into version control with the package. No git commit was created. The lock records the local CLI's `testnet` build environment; this is not publication metadata or proof of network compatibility.

From this directory:

```sh
sui move build --warnings-are-errors
sui move lint --warnings-are-errors
sui move test --lint --warnings-are-errors
sui move test --lint --warnings-are-errors --coverage --statistics
sui move coverage summary --summarize-functions
```

All 48 tests pass. Production build and lint pass with warnings treated as errors. Bytecode coverage is 99.15%; `mint` is 93.02% because the deliberate billion-entry global ceiling is not materialized. All other production functions have 100% bytecode coverage; this metric does not establish exhaustive branch or transaction coverage. Full-follow-list tests create real 1000-entry tables via a test-only seeding seam, then exercise production duplicate/capacity/removal/re-addition behavior. These synthetic targets isolate capacity; normal target registration and cross-owner use are exercised separately through scenarios. The parent Name remains below 256 BCS bytes in the empty-profile capacity fixture; entries live in dynamic fields. Unit-test instruction costs are not network gas estimates.

`prettier-move` is not installed locally. An attempt to run pinned temporary formatter packages was rejected by automatic approval review for external code execution, so automatic formatting was not run. No installation or permission change was made. Build artifacts and coverage files are ignored. Live RPC custody discovery, finality, network gas, upgrade compatibility and deployment dry runs remain release checks; deployment and transactions were outside this task's authorization.

## Canonical state and authority

The one publication initializer creates a shared `Names` object and emits no event. There is no public registry constructor, admin cap, fee, pause, recovery override or application nonce. Names and Name have only `key`; external packages cannot transfer, freeze, share, nest or destroy them through public framework operations. The module exposes no Name ownership transfer or destruction path. Native ownership checks authorize every `&mut Name` input. There is no stored owner mirror.

Exactly one Name may ever be minted per address. This is an account policy, not Sybil resistance; a user can control multiple addresses. Ownership cannot currently rotate. Loss of the account's authority loses access to its Name and incoming assets. Minting costs normal gas/storage but no protocol fee. The registry has an explicit ceiling of 1,000,000,000 identities and never iterates its maps; at capacity new minting aborts while rename, profiles, withdrawals and social operations remain available.

Canonical object fields:

| Type | Fields |
| --- | --- |
| `Names` | `id: UID`, `labels: Table<String, ID>`, `accounts: Table<address, ID>`, `encryption_keys: Table<ID, vector<u8>>` |
| `Name` | `id: UID`, `label: String`, `display_name: String`, `avatar_url: String`, `following: Table<ID, bool>` |

Each minted identity has one account entry, one current label entry and one encryption-key entry (empty means disabled). The key table also provides canonical ID existence because identities cannot be deleted. Keys live only in the shared registry, so callers can read another user's key without submitting that user's address-owned Name as an input. All registry maps stay bounded together; rename removes the old label before adding the new one in the same atomic transaction.

Labels accept ASCII letters, digits and single internal hyphens, 3–32 bytes inclusive. Uppercase is normalized to lowercase. Leading, trailing and consecutive hyphens, underscores, whitespace, non-ASCII and automatic trimming are rejected. Profile fields are valid UTF-8, with display name <=64 bytes and avatar URL <=512 bytes; empty strings clear a field. URLs are untrusted text, not validated resources. Frontends should allowlist safe schemes and handle remote image privacy/security themselves.

## Transaction and composition ABI

Module target is `<IDENTITY_PACKAGE_ID>::identity`. `ID` arguments serialize as Sui object-ID addresses. All byte inputs are `vector<u8>`. `TxContext` is supplied automatically by Sui. Order is significant.

```move
mint(names: &mut Names, label: vector<u8>, ctx: &mut TxContext)
rename(names: &mut Names, self: &mut Name, label: vector<u8>)
set_profile(self: &mut Name, display_name: vector<u8>, avatar_url: vector<u8>)
set_encryption_key(self: &mut Name, names: &mut Names, key: vector<u8>)
follow(self: &mut Name, names: &Names, target: ID)
unfollow(self: &mut Name, target: ID)
send_message(
    self: &mut Name, names: &Names, recipient: ID,
    ciphertext: vector<u8>, nonce: vector<u8>,
    ephemeral_public_key: vector<u8>, expected_recipient_key: vector<u8>,
)
withdraw<Asset: key + store>(self: &mut Name, asset: Receiving<Asset>, recipient: address)
resolve(names: &Names, label: vector<u8>): Option<ID>
name_for_address(names: &Names, account: address): Option<ID>
encryption_key(names: &Names, name: ID): vector<u8>
is_following(self: &Name, target: ID): bool
following_count(self: &Name): u64
```

`mint` delivers directly to the sender. `rename` preserves Name ID, owner, incoming assets and social edges, releases the old label immediately, and rejects conflicts and normalized no-ops. A renamed-away label may be claimed by any eligible account. Senders must resolve a label immediately before constructing payment transactions and show the receiving ID; labels do not promise historical payment routing.

To send assets, use the ordinary native transfer to the address equal to the Name's object ID. No deposit wrapper is required. To withdraw, submit the owner’s mutable Name plus the exact `Receiving<Asset>` object ID, version and digest through the SDK's receiving-reference argument. The contract calls `public_receive` against the Name UID and transfers the same asset unchanged to a nonzero address. Asset supply, object ID and contents are preserved. Native effects provide asset/type/parent/recipient reconstruction, so no redundant withdrawal event is emitted. Other modules may create assets without `store` or with native restrictions; this generic exit supports only `key + store` assets accepted by Sui public receiving. There is no claim that arbitrary restricted assets are recoverable. The Name has no destruction path that could strand unseen incoming objects.

Following is limited to 1000 outgoing IDs per Name. Self, unknown targets and duplicates abort; duplicate is checked before capacity. Unfollow releases capacity and re-follow is permitted. Query the `following` table's dynamic fields for outgoing lists. Reverse followers and mutual relationships are off-chain projections from `Followed`/`Unfollowed` events and canonical membership. No redundant reverse follower counter or unbounded inbox is stored.

Messages authenticate the sender through native possession of the mutable Name. Recipient need not follow sender. Ciphertext is 17–4112 bytes, nonce exactly 12 bytes, and ephemeral key exactly 65 bytes with prefix `0x04`. A registered recipient must have a nonempty enabled key. Key setters accept empty or structurally encoded 65-byte uncompressed points. Curve membership, ECDH correctness, AES-GCM validity and plaintext secrecy are client responsibilities; these are authenticated opaque envelopes, not on-chain decryption proofs. Clients must validate/import keys with WebCrypto and retain historical private keys needed for older messages. The expected recipient key must equal the canonical current key; rotation races abort with code 19 and require re-encryption. Duplicate sends are allowed. There is no delivery acknowledgement, rate limit, nonce-uniqueness guarantee, deletion, spam filter or confidential metadata. Events and transaction inputs are public permanently. Clients must encrypt before transaction construction and must never put plaintext or private keys into chain arguments.

## Events and reconstruction

Events use direct native Sui emission, no envelope. Mutable payloads are bounded and emitted after mutation/transfer. Sender account is supplied by native transaction metadata; a duplicate account field is not stored in events. Index from publication in native checkpoint/transaction/event order and partition by stable Name ID. Reconstruct current label by mint then rename, profile by the latest profile event (empty at mint), key by the latest key event (empty at mint), and directed following membership by edge addition/removal. Ownership and asset movement use native effects. Query current objects and table dynamic fields to resynchronize. Rename does not change social identities. Historical message availability requires an event/checkpoint archival or indexer provider; current object reads do not contain message history.

| Event | Exact payload |
| --- | --- |
| `NameMinted` | `name: ID, label: String` |
| `NameRenamed` | `name: ID, old_label: String, new_label: String` |
| `ProfileUpdated` | `name: ID, display_name: String, avatar_url: String` |
| `EncryptionKeyUpdated` | `name: ID, encryption_key: vector<u8>` |
| `Followed` | `sender: ID, target: ID` |
| `Unfollowed` | `sender: ID, target: ID` |
| `MessageSent` | `sender: ID, recipient: ID, ciphertext: vector<u8>, nonce: vector<u8>, ephemeral_public_key: vector<u8>, recipient_key: vector<u8>` |

Events are authenticated by package/module emission and native ownership, and are not emitted through the framework's separate `emit_authenticated` accumulator API. Every event payload field is asserted in tests. Scenarios cover multiple identities, multi-transaction rename/reuse, mutual edges, profile/key replacement, and messaging. Negative tests pin exact clever-error identity and raising module. Transaction rollback is a native Sui guarantee; the Move harness aborts a negative test and cannot inspect post-abort effects in that same test. Live effects rollback and complete indexer reducer tests remain integration checks.

## Errors and guard order

All errors belong to `identity::identity` and use explicit clever-error codes/messages. Consumers should decode Sui's Move clever-error representation rather than assume the full encoded abort value equals its small diagnostic code.

| Code | Error | Meaning |
| --- | --- | --- |
| 1 | `EInvalidLabelLength` | Outside 3–32 bytes |
| 2 | `EInvalidLabel` | Invalid ASCII/characters/hyphen boundaries |
| 3 | `EAlreadyRegistered` | Account has already minted |
| 4 | `ELabelTaken` | Canonical label already reserved |
| 5 | `EUnchanged` | No-op rename/profile/key setter |
| 6 | `EProfileTooLong` | Display/avatar exceeds byte bound |
| 7 | `EInvalidUtf8` | Invalid profile encoding |
| 8 | `EInvalidRecipient` | Zero withdrawal recipient |
| 9 | `EInvalidEncryptionKey` | Invalid key structural encoding |
| 10 | `EUnknownName` | Target absent from registry |
| 11 | `ESelfTarget` | Follow/unfollow/message targets self |
| 12 | `EAlreadyFollowing` | Duplicate edge |
| 13 | `EFollowingFull` | 1000 outgoing edges already present |
| 14 | `ENotFollowing` | Missing edge removal |
| 15 | `EInvalidCiphertext` | Outside 17–4112 bytes |
| 16 | `EInvalidNonce` | Nonce length differs from 12 |
| 17 | `EEncryptionDisabled` | Empty recipient key |
| 18 | `ERegistryFull` | Billion-identity ceiling reached |
| 19 | `ERecipientKeyChanged` | Expected and current recipient keys differ |

Observable guard ordering: mint normalizes before account/label/capacity; rename validates then rejects no-op before duplicate; profile bounds precede UTF-8 and no-op; follows check self, existence, duplicate then capacity; message checks self, existence, ciphertext, nonce, ephemeral key, enabled recipient key, expected recipient key; withdrawal checks nonzero before receive. Wrong receiving parents abort in `sui::transfer` (code 3). Native transaction ownership rejects unauthorized Name inputs before these functions run.

## Frontend configuration and release boundary

Configure the target network, identity package ID and the singleton shared `Names` object ID from an explicitly authorized future deployment. Do not use `0x0`, hardcoded fake IDs, or the external vault package ID as deployed identity configuration. The frontend needs an RPC/indexer supporting owned object discovery, table dynamic-field lookup, receiving object references, transaction effects and event history. An inactive/missing deployment must remain an explicit frontend state. This package alone cannot make an unpublished frontend flow transact successfully.

The account table is keyed by address, labels by `0x1::string::String`, keys by `0x2::object::ID`, and following by ID with Boolean true values. Use canonical BCS key types for dynamic-field queries. Profile data is on Name objects; encryption keys are on `Names.encryption_keys`, not on Name. Follow and message calls require recipient ID, not another address-owned Name object. For WebCrypto keys, store private material locally using the application's intended IndexedDB/security policy; no wallet signing key is a substitute for a messaging key.

There are no published ABI promises yet. Any future publishing decision must separately review network/toolchain compatibility, authority custody, upgrade policy and the immutable stored/event layouts. No speculative migration/version flags were added to this initial package.
