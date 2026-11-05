// The package that *defined* the `dkg_committee` types.
//
// Dynamic-field NAME types, object `type` strings and event types keep the
// defining package id forever; a compatible upgrade only moves the call target.
// Pointing a field lookup at the wrong package returns `notFound` even though
// the entry exists on chain — and `notFound` reads as "nobody submitted",
// which silently strands every DKG round.
//
// This project evolves by **fresh publish only** (no in-place upgrades), so a
// new publication defines every struct anew and becomes the one and only type
// origin for all of its types. Historical package ids are not supported: their
// objects cannot be consumed by the current package. Get an old id from git if
// you ever need to read a historical object again.
import { AGENT_VAULT_PACKAGE_ID } from "multisig/agent-vault/org"

/** All `dkg_committee` structs (DkgSession, MailboxKey, EncryptionKeySlot,
 *  GroupKeyAttestationSlot) share the current publication's origin. */
export const DKG_TYPE_ORIGIN = AGENT_VAULT_PACKAGE_ID
export const DKG_ENCRYPTION_KEY_TYPE_ORIGIN = AGENT_VAULT_PACKAGE_ID
export const DKG_ATTESTATION_TYPE_ORIGIN = AGENT_VAULT_PACKAGE_ID
