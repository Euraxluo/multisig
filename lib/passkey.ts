"use client"

// SIP-9 passkey identity: a WebAuthn P-256 credential whose public key is the
// Sui account. Nothing leaves the device — registration stores the credential
// id, public key and derived address, and every login or signature is a fresh
// WebAuthn assertion verified against that public key.
import {
  BrowserPasskeyProvider,
  PasskeyKeypair,
  PasskeyPublicKey,
  findCommonPublicKey,
  type BrowserPasswordProviderOptions,
  type PasskeyProvider,
} from "@mysten/sui/keypairs/passkey"
import { fromBase64, isValidSuiAddress, normalizeSuiAddress, toBase64 } from "@mysten/sui/utils"
import { verifyPersonalMessageSignature } from "@mysten/sui/verify"
import { t } from "./i18n/t"

/** Browser-local passkey records. The legacy single-record key is still read so
 *  accounts created by the earlier build keep working; it lacks a public key and
 *  is upgraded on first use. */
export const PASSKEY_STORE_KEY = "sui_passkey_credentials_v1"
export const LEGACY_PASSKEY_KEY = "sui_passkey_credential"

export interface StoredPasskey {
  credentialIdBase64: string
  /** `null` only for a legacy record; recovered from the authenticator on first use. */
  publicKeyBase64: string | null
  suiAddress: string
  identifier: string
  createdAt: number
}

export interface PasskeyAccount {
  type: "passkey"
  provider: string
  identifier: string
  address: string
  authMethodLabel: string
}

export function passkeySupported(): boolean {
  return typeof window !== "undefined"
    && typeof window.PublicKeyCredential === "function"
    && window.isSecureContext !== false
}

export function createPasskeyProvider(): PasskeyProvider {
  return new BrowserPasskeyProvider("Sui MultiSig", {
    rp: { name: "Sui MultiSig" },
    user: { name: "Sui MultiSig account", displayName: "Sui MultiSig" },
    authenticatorSelection: {
      // Platform authenticator = Touch ID / Windows Hello / Android biometrics.
      authenticatorAttachment: "platform",
      // A discoverable credential is required for recovery from the device.
      residentKey: "required",
      requireResidentKey: true,
      userVerification: "required",
    },
  } satisfies BrowserPasswordProviderOptions)
}

function normalizeRecord(value: unknown): StoredPasskey | null {
  if (!value || typeof value !== "object") return null
  const raw = value as Record<string, unknown>
  if (typeof raw.suiAddress !== "string" || !isValidSuiAddress(raw.suiAddress)) return null
  if (typeof raw.credentialIdBase64 !== "string" || !raw.credentialIdBase64) return null
  try {
    if (!fromBase64(raw.credentialIdBase64).length) return null
  } catch { return null }
  let publicKeyBase64: string | null = null
  if (typeof raw.publicKeyBase64 === "string" && raw.publicKeyBase64) {
    try { new PasskeyPublicKey(fromBase64(raw.publicKeyBase64)) } catch { return null }
    publicKeyBase64 = raw.publicKeyBase64
  }
  return {
    credentialIdBase64: raw.credentialIdBase64,
    publicKeyBase64,
    suiAddress: normalizeSuiAddress(raw.suiAddress),
    identifier: typeof raw.identifier === "string" && raw.identifier ? raw.identifier : t("misc.passkey.localLabel"),
    createdAt: typeof raw.createdAt === "number" && Number.isFinite(raw.createdAt) ? raw.createdAt : 0,
  }
}

function readStore(): StoredPasskey[] {
  if (typeof localStorage === "undefined") return []
  const records: StoredPasskey[] = []
  try {
    const parsed = JSON.parse(localStorage.getItem(PASSKEY_STORE_KEY) ?? "[]")
    if (Array.isArray(parsed)) {
      for (const value of parsed) {
        const record = normalizeRecord(value)
        if (record && !records.some(existing => existing.suiAddress === record.suiAddress)) records.push(record)
      }
    }
  } catch {}
  try {
    const legacy = localStorage.getItem(LEGACY_PASSKEY_KEY)
    if (legacy) {
      const record = normalizeRecord({ ...(JSON.parse(legacy) as object), publicKeyBase64: null })
      if (record && !records.some(existing => existing.suiAddress === record.suiAddress)) records.push(record)
    }
  } catch {}
  return records
}

function writeStore(records: StoredPasskey[]) {
  try {
    localStorage.setItem(PASSKEY_STORE_KEY, JSON.stringify(records))
  } catch {
    throw new Error(t("misc.passkey.storageUnavailable"))
  }
  try {
    // Drop the legacy single-record key once its address has a full record in
    // the new store, so the account is never listed twice.
    const legacy = localStorage.getItem(LEGACY_PASSKEY_KEY)
    if (!legacy) return
    const parsed = JSON.parse(legacy) as { suiAddress?: unknown }
    const address = typeof parsed?.suiAddress === "string" ? normalizeSuiAddress(parsed.suiAddress) : ""
    if (address && records.some(record => record.suiAddress === address && record.publicKeyBase64)) localStorage.removeItem(LEGACY_PASSKEY_KEY)
  } catch {}
}

/** All passkey records on this browser, newest first. Never prompts the device. */
export function listStoredPasskeys(): StoredPasskey[] {
  return readStore().sort((left, right) => right.createdAt - left.createdAt)
}

export function findStoredPasskey(address: string): StoredPasskey | undefined {
  const normalized = normalizeSuiAddress(address)
  return readStore().find(record => record.suiAddress === normalized)
}

function saveRecord(record: StoredPasskey) {
  const records = readStore().filter(existing => existing.suiAddress !== record.suiAddress)
  records.push(record)
  writeStore(records)
}

export function removeStoredPasskey(address: string) {
  const normalized = normalizeSuiAddress(address)
  writeStore(readStore().filter(record => record.suiAddress !== normalized))
  try {
    const legacy = localStorage.getItem(LEGACY_PASSKEY_KEY)
    if (legacy && normalizeSuiAddress(String((JSON.parse(legacy) as { suiAddress?: unknown })?.suiAddress ?? "")) === normalized) localStorage.removeItem(LEGACY_PASSKEY_KEY)
  } catch {}
}

function accountFromRecord(record: StoredPasskey): PasskeyAccount {
  return {
    type: "passkey",
    provider: t("misc.passkey.localLabel"),
    identifier: record.identifier,
    address: record.suiAddress,
    authMethodLabel: "Passkey P-256 · Sui testnet",
  }
}

function randomChallenge(bytes = 32): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(bytes))
}

/** One assertion gives up to four candidate public keys; the address picks the right one. */
async function recoverPublicKey(address: string, provider: PasskeyProvider): Promise<PasskeyPublicKey> {
  const candidates = await PasskeyKeypair.signAndRecover(provider, randomChallenge(32))
  const match = candidates.find(candidate => normalizeSuiAddress(candidate.toSuiAddress()) === normalizeSuiAddress(address))
  if (!match) throw new Error(t("misc.passkey.mismatch"))
  return match as PasskeyPublicKey
}

async function authorizedKeypair(record: StoredPasskey, provider: PasskeyProvider): Promise<PasskeyKeypair> {
  let publicKeyBase64 = record.publicKeyBase64
  if (!publicKeyBase64) {
    // Legacy record: recover the public key from one real assertion and persist it.
    const recovered = await recoverPublicKey(record.suiAddress, provider)
    publicKeyBase64 = toBase64(recovered.toRawBytes())
    saveRecord({ ...record, publicKeyBase64 })
  }
  const publicKeyBytes = fromBase64(publicKeyBase64)
  const publicKey = new PasskeyPublicKey(publicKeyBytes)
  if (normalizeSuiAddress(publicKey.toSuiAddress()) !== record.suiAddress) throw new Error(t("misc.passkey.keyAddressMismatch"))
  let credentialId: Uint8Array
  try { credentialId = fromBase64(record.credentialIdBase64) } catch { throw new Error(t("misc.passkey.credentialInvalid")) }
  return new PasskeyKeypair(publicKeyBytes, provider, credentialId)
}

/** Create a new passkey for this browser and persist its public identity. */
export async function registerPasskey(provider: PasskeyProvider = createPasskeyProvider()): Promise<{ account: PasskeyAccount; record: StoredPasskey }> {
  if (typeof navigator === "undefined" || typeof navigator.credentials === "undefined") throw new Error(t("misc.passkey.unsupported"))
  const keypair = await PasskeyKeypair.getPasskeyInstance(provider)
  const publicKey = keypair.getPublicKey()
  const credentialId = keypair.getCredentialId()
  if (!credentialId?.length) throw new Error(t("misc.passkey.noCredentialId"))
  const record: StoredPasskey = {
    credentialIdBase64: toBase64(credentialId),
    publicKeyBase64: toBase64(publicKey.toRawBytes()),
    suiAddress: normalizeSuiAddress(publicKey.toSuiAddress()),
    identifier: t("misc.passkey.createLabel"),
    createdAt: Date.now(),
  }
  saveRecord(record)
  return { account: accountFromRecord(record), record }
}

/**
 * Prove possession of the stored passkey by signing a fresh challenge and
 * verifying it locally before reporting the account as logged in.
 */
export async function loginWithPasskey(address: string, provider: PasskeyProvider = createPasskeyProvider()): Promise<PasskeyAccount> {
  const record = findStoredPasskey(address)
  if (!record) throw new Error(t("misc.passkey.notFound"))
  const keypair = await authorizedKeypair(record, provider)
  const challenge = randomChallenge()
  const signed = await keypair.signPersonalMessage(challenge)
  try { await verifyPersonalMessageSignature(challenge, signed.signature, { address: record.suiAddress }) }
  catch { throw new Error(t("misc.passkey.verificationFailed")) }
  return accountFromRecord(findStoredPasskey(address) ?? record)
}

/** Rebuild the SIP-9 signer for transaction signing; checks key/address binding. */
export async function getPasskeySigner(address: string, provider: PasskeyProvider = createPasskeyProvider()): Promise<PasskeyKeypair> {
  const record = findStoredPasskey(address)
  if (!record) throw new Error(t("misc.passkey.noRecord"))
  return authorizedKeypair(record, provider)
}

/**
 * Recover a passkey account this browser can no longer address from its stored
 * record (for example after clearing site data). Two assertions over different
 * challenges identify the unique credential behind the passkey.
 */
export async function recoverPasskeyAccount(provider: PasskeyProvider = createPasskeyProvider()): Promise<StoredPasskey> {
  // `signAndRecover` returns only the candidate keys, so capture the credential
  // id from the same assertion instead of prompting the device a third time.
  let credentialId: Uint8Array | undefined
  const recording: PasskeyProvider = {
    create: () => provider.create(),
    get: async (challenge, requested) => {
      const credential = await provider.get(challenge, requested)
      if (credential?.rawId) credentialId = new Uint8Array(credential.rawId)
      return credential
    },
  }
  const first = await PasskeyKeypair.signAndRecover(recording, randomChallenge(32))
  const second = await PasskeyKeypair.signAndRecover(recording, randomChallenge(32))
  let common: ReturnType<typeof findCommonPublicKey>
  try { common = findCommonPublicKey(first, second) } catch {
    throw new Error(t("misc.passkey.differentCredential"))
  }
  const publicKey = common as PasskeyPublicKey
  if (!credentialId?.length) throw new Error(t("misc.passkey.readFailed"))
  const record: StoredPasskey = {
    credentialIdBase64: toBase64(credentialId),
    publicKeyBase64: toBase64(publicKey.toRawBytes()),
    suiAddress: normalizeSuiAddress(publicKey.toSuiAddress()),
    identifier: t("misc.passkey.recoveredLabel"),
    createdAt: Date.now(),
  }
  saveRecord(record)
  return record
}

export function passkeyErrorMessage(error: unknown): string {
  const name = error && typeof error === "object" && "name" in error ? String((error as { name: unknown }).name) : ""
  if (name === "NotAllowedError") return t("misc.passkey.errCancelled")
  if (name === "InvalidStateError") return t("misc.passkey.errBound")
  if (name === "SecurityError") return t("misc.passkey.errInsecure")
  if (name === "NotSupportedError") return t("misc.passkey.errUnsupported")
  return error instanceof Error ? error.message : t("misc.passkey.errGeneric")
}
