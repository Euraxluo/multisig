# Identity and social features on Sui testnet

The application currently uses Sui testnet. Native SuiNS names (`alice.sui`, `@alice`, and subnames supported by SuiNS) use the official `@mysten/suins` SDK. Version 2.0.16 matches the installed `@mysten/sui` 2.36.0. Name records are read through `SuinsClient.getNameRecord`, and the Sui core name service confirms the currently usable target, including parent registration validity. An expired record is never accepted solely because it remains in the registry. Missing records are reported explicitly; transport failures are not treated as unregistered names.

Payments, transfer proposals, identity lookup and contact lookup share `resolveRecipient` in `lib/identity-client.ts`:

| Input | Payment destination | Contact identity |
| --- | --- | --- |
| Sui address | That address | Its registered protocol identity, when configured |
| Native SuiNS | Current configured SuiNS recipient address | Protocol identity of that address, when configured |
| Protocol `alice.id` or bare `alice` | Stable protocol Name object ID | The Name object and its owning address |

## Protocol configuration

The package is deployed on Sui testnet (2026-10-29): package `0xba0780e7f08a0589c1f71c8b2eff10bfc6d498190c88d4d25292b502c7c9251e`, shared `Names` `0x25193e4ee41b0927cf0624421b50ed97e85cade5c617cf51e38e7eaec58d8294` (publish tx `D2MkARf6…W7Es`; smoke mint tx `jWbHCYBx…gjq`, Name `charlie` → `0xfcd7dae3…5aabe`). These are set in `.env.local` as `NEXT_PUBLIC_IDENTITY_PACKAGE_ID` / `NEXT_PUBLIC_IDENTITY_NAMES_ID`. The source stays in `contracts/identity`. Its [README](../contracts/identity/README.md) documents custody, ABI, authority, tests and release checks. After a separately authorized deployment, set `NEXT_PUBLIC_IDENTITY_PACKAGE_ID` and `NEXT_PUBLIC_IDENTITY_NAMES_ID` from that deployment. Restart Next.js after changing them. Do not substitute the existing vault package ID. Without these variables, native address/SuiNS lookup remains available and protocol operations show a setup state.

Free mint means no protocol fee; gas and storage costs still apply. Each address gets one permanent, non-transferable identity. Labels are unique, 3–32 ASCII characters, lowercase letters/digits/single internal hyphens; the UI trims and normalizes input. Rename releases the old label while preserving the object ID, received assets and social relationships. Always resolve the current label before payment; a released old label can belong to another person.

Send a publicly transferable object to the address equal to a Name object ID. The owner uses `Receiving<Asset>` and the Name UID to extract it to a nonzero address or an active SuiNS target. Generic extraction supports `key + store` assets; restricted asset types may require their defining module. The inbox is discovered from RPC ownership queries. Live network discovery and extraction still require deployment acceptance testing.

Profiles save bounded display names and avatar HTTPS URLs on chain. Group member lists resolve each member address to a protocol identity and use its on-chain avatar when present; local note names stay authoritative, and members without an identity keep the local initial avatar. Group chat rows resolve sender addresses separately from the member notes, and the direct-message contact picker lists one-way followers under 关注了你 so an incoming follow can be answered without typing an address. A failed follower projection leaves the following list and inbox untouched instead of rendering an empty list. Avatar retrieval omits a referrer and falls back when loading fails. Following is an outgoing chain table, bounded to 1000; the mutual badge reads the opposite identity's canonical membership. Incoming followers are reconstructed in `getFollowers()` from the newest `Followed`/`Unfollowed` event per sender, and the emitting transaction must be signed by the identity owner. Both edge types are read from one descending `emitModule` stream so the API's ledger order decides which edge is current; `(checkpoint, eventIndex)` is deliberately not used as the ordering key because two transactions in the same checkpoint each number their events from zero, so that pair is not a total order. The event API cannot filter by `target`, so this is a bounded projection of the module's most recent events (20 pages, 1,000 events per stream, which also contains `MessageSent`): the UI labels a truncated scan as partial instead of claiming a complete follower index, and reports senders whose latest edge was `Unfollowed` separately as history. Testnet gRPC was probed directly to confirm `EventEntry.checkpoint` is a populated decimal string, so a missing checkpoint is treated as an integration error rather than guessed around. A true reverse index needs an off-chain indexer.

## Private messages and sharing

Private messages use WebCrypto P-256 ECDH, HKDF-SHA256 and AES-256-GCM. Each message has a fresh ephemeral key and nonce and separate sender/recipient ciphertexts. Context includes both identity IDs and public keys. The on-chain transaction authenticates the sending identity and rejects a recipient key that changed during encryption. Plaintext is limited to 1000 UTF-8 bytes; each send requires a signature and gas.

Messaging private keys are non-exportable CryptoKeys in IndexedDB, separate from wallet signing keys. Clearing browser data or losing the device loses access to historical messages. There is no key backup/recovery or forward-secret ratchet. This implementation has not undergone a cryptographic audit. Sender, recipient, timing and transaction inputs remain public. Events contain ciphertext permanently; the contract does not prove encryption correctness or prevent spam.

The browser reads at most 500 recent sender events for each party per refresh and filters the exact message event type and identity pair. This is a bounded recent-history view, not an archival indexer. Refresh reloads current messaging-key readiness. A production archival service is needed for complete history.

The private-message inbox scans at most 500 recent `MessageSent` events globally per refresh, discovers inbound senders from the recipient identity ID, verifies each event sender against the sender Name owner, deduplicates transaction/event IDs, and keeps undecryptable previews visible with an explicit reason. A truncated scan or sender-resolution failure is surfaced in the UI; it is not presented as complete conversation history.

Personal and group QR codes encode `?person=<address>` and `?group=<organization-object-ID>` application links. Personal codes remain valid when a label changes. Group codes use the chain organization ID, never a member wallet. Opening a link only displays data; it does not join a group, sign a transaction or transfer assets. Codes can be copied as links and downloaded as SVG. The group and bill member forms use a shared address scanner: browsers with `BarcodeDetector` can scan a camera stream or QR image, while every browser can paste a Sui address or a personal QR link; invalid or non-Sui QR content is rejected before it enters the form.

The roster-change dialog can exchange FROST Round 1 commitments and Round 2
shares through the existing encrypted identity messages. Each imported compact
round is checked against the authenticated `MessageSent` sender and the exact
roster request/signer index; a conflicting duplicate is rejected rather than
silently overwritten. The manual public-JSON exchange remains available, and a
missing identity deployment disables only the transport buttons with an
explicit GAP notice. Neither path submits a roster transaction until the full
signature is aggregated and the fresh chain descriptor matches.

## Local checks

```sh
pnpm exec tsx --test lib/suins.test.ts lib/message-crypto.test.ts lib/zklogin.test.ts
pnpm exec tsc --noEmit
pnpm build
```

Stop the Next development server before `pnpm build`: both use `.next`, so a concurrent build can invalidate development assets. `pnpm build` executes full lint and TypeScript validation. For Google login configuration and external acceptance testing see [zklogin.md](zklogin.md). Existing group-chat/demo payment flows outside these changes have not been replaced by this identity protocol.
