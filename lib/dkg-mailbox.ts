// Seal DKG mailbox shares to the recipient's on-chain encryption key.
//
// `deposit_mailbox_share` stores the payload on a shared object, so anything
// written there is readable by anyone with an RPC connection. A share written
// in the clear is therefore a published private key. This module seals each
// payload with the same primitives as `lib/message-crypto.ts` — ephemeral ECDH
// P-256 + HKDF-SHA256 + AES-256-GCM — but binds the extra context a DKG share
// needs (session, sender, recipient, epoch) so a payload cannot be replayed into
// another session or re-addressed to another participant.
//
// The recipient's key is the 65-byte uncompressed point they registered on the
// session with `register_encryption_key`. There is no key discovery here: a
// recipient who has not registered cannot be sealed to, and that is reported as
// such rather than silently falling back to plaintext.
import { t } from "@/lib/i18n/t"
import { bcs } from "@mysten/sui/bcs"
import { ObjectError } from "@mysten/sui/client"
import { SuiGrpcClient } from "@mysten/sui/grpc"
import { normalizeSuiAddress } from "@mysten/sui/utils"

export const SHARE_ENVELOPE_VERSION = 1
export const P256_PUBLIC_KEY_BYTES = 65
export const MAX_SHARE_BYTES = 4096

/** Fixed prefix so a stray or unrelated payload fails to parse as a share. */
const MAGIC = "dkg-share-v1"

export interface SealedShare {
  /** `MAGIC || senderKey(65) || nonce(12) || ciphertext`, versioned by MAGIC. */
  bytes: Uint8Array
  ephemeralPublicKey: Uint8Array
}

export interface ShareContext {
  sessionId: string
  sender: string
  recipient: string
  epoch: number
}

const text = new TextEncoder()

function associatedData(context: ShareContext): Uint8Array {
  // Every field that must not be swappable is bound into the AAD. Re-using a
  // ciphertext under another session, pair, or epoch fails authentication
  // instead of decrypting to the wrong share.
  return text.encode(JSON.stringify([
    MAGIC,
    normalizeSuiAddress(context.sessionId),
    normalizeSuiAddress(context.sender),
    normalizeSuiAddress(context.recipient),
    context.epoch,
  ]))
}

async function importRecipientKey(raw: Uint8Array): Promise<CryptoKey> {
  // A compressed point (33 bytes) is rejected rather than guessed at: the
  // contract fixes the registration length at 65, so accepting another shape
  // here would let off-chain and on-chain disagree.
  if (raw.length !== P256_PUBLIC_KEY_BYTES || raw[0] !== 0x04) {
    throw new Error(t("dkg.mailboxKeyFormat"))
  }
  return crypto.subtle.importKey("raw", new Uint8Array(raw), { name: "ECDH", namedCurve: "P-256" }, false, [])
}

async function deriveShareKey(
  privateKey: CryptoKey,
  remoteRaw: Uint8Array,
  nonce: Uint8Array,
  context: ShareContext,
): Promise<{ key: CryptoKey; aad: Uint8Array }> {
  const remote = await importRecipientKey(remoteRaw)
  const secret = await crypto.subtle.deriveBits({ name: "ECDH", public: remote }, privateKey, 256)
  const material = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"])
  const aad = associatedData(context)
  const key = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(nonce), info: aad },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  )
  return { key, aad }
}

/**
 * Seal one share to `recipientPublicKey`. The caller keeps the ephemeral key out
 * of the payload: it travels in the envelope header, which is what lets the
 * recipient derive the same secret with their registered private key.
 */
export async function sealShare(
  share: Uint8Array,
  recipientPublicKey: Uint8Array,
  context: ShareContext,
): Promise<SealedShare> {
  if (share.length === 0 || share.length > MAX_SHARE_BYTES) throw new Error(t("dkg.shareLengthInvalid"))
  const ephemeral = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"])
  const ephemeralPublicKey = new Uint8Array(await crypto.subtle.exportKey("raw", ephemeral.publicKey))
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const { key, aad } = await deriveShareKey(ephemeral.privateKey, recipientPublicKey, nonce, context)
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: aad }, key, new Uint8Array(share)))

  const bytes = new Uint8Array(MAGIC.length + ephemeralPublicKey.length + nonce.length + ciphertext.length)
  bytes.set(text.encode(MAGIC), 0)
  bytes.set(ephemeralPublicKey, MAGIC.length)
  bytes.set(nonce, MAGIC.length + ephemeralPublicKey.length)
  bytes.set(ciphertext, MAGIC.length + ephemeralPublicKey.length + nonce.length)
  return { bytes, ephemeralPublicKey }
}

/**
 * Reverse `sealShare`. Throws when the envelope is malformed or when the AAD no
 * longer matches — a share moved to another session or sender is rejected rather
 * than decrypted into the wrong place.
 */
export async function openShare(
  sealed: Uint8Array,
  privateKey: CryptoKey,
  context: ShareContext,
): Promise<Uint8Array> {
  const headerLength = MAGIC.length + P256_PUBLIC_KEY_BYTES
  if (sealed.length <= headerLength + 12) throw new Error(t("dkg.envelopeTooShort"))
  if (new TextDecoder().decode(sealed.subarray(0, MAGIC.length)) !== MAGIC) throw new Error(t("dkg.wrongMagic"))
  const ephemeralPublicKey = sealed.subarray(MAGIC.length, headerLength)
  const nonce = sealed.subarray(headerLength, headerLength + 12)
  const ciphertext = sealed.subarray(headerLength + 12)
  const { key, aad } = await deriveShareKey(privateKey, ephemeralPublicKey, nonce, context)
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(nonce), additionalData: aad }, key, new Uint8Array(ciphertext))
  if (plaintext.byteLength === 0 || plaintext.byteLength > MAX_SHARE_BYTES) throw new Error(t("dkg.shareLengthInvalid"))
  return new Uint8Array(plaintext)
}

/** Exported so callers can tell "not registered yet" from "registered badly". */
export function isSealableKey(raw: Uint8Array): boolean {
  return raw.length === P256_PUBLIC_KEY_BYTES && raw[0] === 0x04
}

// ---------------------------------------------------------------------------
// On-chain reads for the registered keys.
// ---------------------------------------------------------------------------

export const DKG_MODULE = "dkg_committee"

/** `EncryptionKeySlot { participant }` — the dynamic-field key used on chain. */
const EncryptionKeySlot = bcs.struct("EncryptionKeySlot", { participant: bcs.Address })

export type EncryptionKeyClient = Pick<SuiGrpcClient, "getDynamicField" | "getMoveFunction">

export interface EncryptionKeyReader {
  /** Registers the feature on the deployed package (revision >= 2). */
  supportsEncryptionKeys(): Promise<boolean>
  /** Registered key for `participant`, or null when they have not registered. */
  readKey(sessionId: string, participant: string): Promise<Uint8Array | null>
}

const requestSignal = () => AbortSignal.timeout(20_000)

export function createEncryptionKeyReader(
  client: EncryptionKeyClient,
  packageId: string,
  /**
   * The package that *defined* `EncryptionKeySlot`. This is not necessarily the
   * package being called: a compatible upgrade mints a new package id while the
   * dynamic-field NAME type keeps the original one, so deriving it from
   * `packageId` returns `notFound` on every field after the next upgrade — which
   * reads as "nobody registered a key" and silently skips share delivery.
   * Defaults to `packageId` for the current deployment, where they coincide.
   */
  typeOrigin: string = packageId,
): EncryptionKeyReader {
  const signal = () => requestSignal()
  const slotType = `${normalizeSuiAddress(typeOrigin)}::${DKG_MODULE}::EncryptionKeySlot`
  return {
    async supportsEncryptionKeys() {
      try {
        await client.getMoveFunction({ packageId, moduleName: DKG_MODULE, name: "register_encryption_key", signal: signal() })
        return true
      } catch (error) {
        // Only the exact "no such function" answer means "older package"; a
        // network or decoding failure must surface instead of reading as a gap.
        if (error instanceof Error && /^Function not found:/i.test(error.message)) return false
        throw error
      }
    },

    async readKey(sessionId: string, participant: string) {
      const id = normalizeSuiAddress(sessionId)
      const who = normalizeSuiAddress(participant)
      const name = EncryptionKeySlot.serialize({ participant: who }).toBytes()
      let field
      try {
        const result = await client.getDynamicField({ parentId: id, name: { type: slotType, bcs: name }, signal: signal() })
        field = result.dynamicField
      } catch (error) {
        // A missing field is "not registered"; any other failure is a real error.
        if (error instanceof ObjectError && error.reason === "notFound") return null
        throw error
      }
      if (field.$kind !== "DynamicField") throw new Error(t("dkg.notDynamicField"))
      // `value.bcs` carries only the stored value, not the field struct: the
      // name is what was queried, so re-reading it from the payload is neither
      // possible nor needed.
      // `parse` yields a plain array; normalize so callers always get bytes.
      const value = Uint8Array.from(bcs.vector(bcs.u8()).parse(field.value.bcs))
      if (!isSealableKey(value)) throw new Error(t("dkg.invalidOnchainKey"))
      return value
    },
  }
}

export const encryptionKeyClient: EncryptionKeyClient = new SuiGrpcClient({
  network: "testnet",
  baseUrl: "https://fullnode.testnet.sui.io:443",
}) as unknown as EncryptionKeyClient
