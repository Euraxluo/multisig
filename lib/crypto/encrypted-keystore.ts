"use client"

import { t } from "@/lib/i18n/t"
import { decodeSuiPrivateKey, encodeSuiPrivateKey, type SignatureScheme } from "@mysten/sui/cryptography"
import { validateDeviceKeyPackage, type DeviceKeyPackage } from "../dkg-key-package"
import { bytesToHex, hexToBytes } from "./bytes"

/** Standard Web3 Encrypted Keystore Envelope (PBKDF2-SHA256 + AES-256-GCM) */
export interface EncryptedKeystoreEnvelope {
  version: 1
  cipher: "aes-256-gcm"
  kdf: "pbkdf2"
  kdfParams: {
    salt: string
    iterations: number
    hash: "SHA-256"
  }
  iv: string
  ciphertext: string
  createdAt: number
}

const DEFAULT_ITERATIONS = 100_000
const MIN_ITERATIONS = 50_000
const SALT_BYTES = 16
const IV_BYTES = 12

/**
 * Derives a 256-bit AES-GCM key from a user password and cryptographic salt using PBKDF2-SHA256.
 */
export async function deriveEncryptionKey(
  password: string,
  salt: Uint8Array,
  iterations = DEFAULT_ITERATIONS
): Promise<CryptoKey> {
  if (typeof password !== "string" || password.length === 0) {
    throw new Error(t("dkg.passwordRequired"))
  }
  if (iterations < MIN_ITERATIONS) {
    throw new Error(t("dkg.kdfIterationsTooLow", { min: MIN_ITERATIONS }))
  }
  if (salt.byteLength < SALT_BYTES) {
    throw new Error(t("dkg.saltTooShort", { min: SALT_BYTES }))
  }

  const enc = new TextEncoder()
  const passwordKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveKey"]
  )

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: new Uint8Array(salt),
      iterations,
      hash: "SHA-256",
    },
    passwordKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  )
}

/**
 * Encrypts arbitrary bytes or text into an authenticated AES-256-GCM envelope.
 */
export async function encryptWithPassword(
  payload: Uint8Array | string,
  password: string,
  options: { iterations?: number; aad?: Uint8Array } = {}
): Promise<EncryptedKeystoreEnvelope> {
  const data = typeof payload === "string" ? new TextEncoder().encode(payload) : payload
  if (!data || data.length === 0) {
    throw new Error(t("dkg.encryptEmptyPayload"))
  }

  const iterations = options.iterations ?? DEFAULT_ITERATIONS
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES))
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const key = await deriveEncryptionKey(password, salt, iterations)

  const aad = options.aad ?? new TextEncoder().encode("sui-encrypted-keystore-v1")
  const encryptedBuffer = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: aad,
    },
    key,
    data
  )

  return {
    version: 1,
    cipher: "aes-256-gcm",
    kdf: "pbkdf2",
    kdfParams: {
      salt: bytesToHex(salt),
      iterations,
      hash: "SHA-256",
    },
    iv: bytesToHex(iv),
    ciphertext: bytesToHex(new Uint8Array(encryptedBuffer)),
    createdAt: Date.now(),
  }
}

/**
 * Decrypts an authenticated AES-256-GCM envelope using the user password.
 * Throws a descriptive error if the password is wrong or ciphertext is tampered.
 */
export async function decryptWithPassword(
  envelope: EncryptedKeystoreEnvelope,
  password: string,
  options: { aad?: Uint8Array } = {}
): Promise<Uint8Array> {
  if (!envelope || envelope.version !== 1 || envelope.cipher !== "aes-256-gcm" || envelope.kdf !== "pbkdf2") {
    throw new Error(t("dkg.unsupportedFormat"))
  }
  if (!envelope.kdfParams?.salt || !envelope.iv || !envelope.ciphertext) {
    throw new Error(t("dkg.missingEnvelope"))
  }

  const salt = hexToBytes(envelope.kdfParams.salt)
  const iv = hexToBytes(envelope.iv)
  const ciphertext = hexToBytes(envelope.ciphertext)
  const iterations = envelope.kdfParams.iterations ?? DEFAULT_ITERATIONS

  const key = await deriveEncryptionKey(password, salt, iterations)
  const aad = options.aad ?? new TextEncoder().encode("sui-encrypted-keystore-v1")

  try {
    const decryptedBuffer = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: aad,
      },
      key,
      ciphertext
    )
    return new Uint8Array(decryptedBuffer)
  } catch (cause) {
    throw new Error(t("dkg.wrongPassword"), { cause })
  }
}

/**
 * Decrypts a JSON payload from an authenticated keystore envelope.
 */
export async function decryptJsonWithPassword<T = unknown>(
  envelope: EncryptedKeystoreEnvelope,
  password: string,
  options: { aad?: Uint8Array } = {}
): Promise<T> {
  const bytes = await decryptWithPassword(envelope, password, options)
  const text = new TextDecoder("utf-8").decode(bytes)
  try {
    return JSON.parse(text) as T
  } catch (cause) {
    throw new Error(t("dkg.invalidJson"), { cause })
  }
}

/**
 * Sui CLI Keystore compatibility: Formats a 32-byte private key into canonical Bech32 `suiprivkey1...` string.
 */
export function encodeSuiKeystoreKey(
  secretKey: Uint8Array,
  scheme: SignatureScheme = "ED25519"
): string {
  if (secretKey.length !== 32) {
    throw new Error(t("dkg.privateKeyLength"))
  }
  return encodeSuiPrivateKey(secretKey, scheme)
}

/**
 * Sui CLI Keystore compatibility: Decodes a canonical Bech32 `suiprivkey1...` string into schema and secret bytes.
 */
export function decodeSuiKeystoreKey(
  bech32Key: string
): { schema: SignatureScheme; secretKey: Uint8Array } {
  const decoded = decodeSuiPrivateKey(bech32Key)
  return {
    schema: decoded.scheme as SignatureScheme,
    secretKey: decoded.secretKey,
  }
}

/**
 * Serializes a DeviceKeyPackage (including bigints and byte arrays) into a JSON string.
 */
export function serializeDeviceKeyPackage(key: DeviceKeyPackage): string {
  validateDeviceKeyPackage(key)
  return JSON.stringify({
    network: key.network,
    sessionId: key.sessionId,
    holder: key.holder,
    participantAddresses: [...key.participantAddresses],
    dealerAddresses: [...key.dealerAddresses],
    threshold: key.threshold.toString(),
    sessionEpoch: key.sessionEpoch.toString(),
    index: key.index.toString(),
    share: key.share.toString(),
    commitments: key.commitments.map(bytesToHex),
    groupPk: bytesToHex(key.groupPk),
    keyPackageId: key.keyPackageId,
  })
}

/**
 * Deserializes a JSON string into a validated DeviceKeyPackage.
 */
export function parseDeviceKeyPackage(serialized: string): DeviceKeyPackage {
  const wire = JSON.parse(serialized) as Record<string, unknown>
  const pkg: DeviceKeyPackage = {
    network: wire.network as DeviceKeyPackage["network"],
    sessionId: wire.sessionId as string,
    holder: wire.holder as string,
    participantAddresses: wire.participantAddresses as string[],
    dealerAddresses: wire.dealerAddresses as string[],
    threshold: BigInt(wire.threshold as string),
    sessionEpoch: BigInt(wire.sessionEpoch as string),
    index: BigInt(wire.index as string),
    share: BigInt(wire.share as string),
    commitments: (wire.commitments as string[]).map(hexToBytes),
    groupPk: hexToBytes(wire.groupPk as string),
    keyPackageId: wire.keyPackageId as string,
  }
  validateDeviceKeyPackage(pkg)
  return pkg
}

/**
 * Seals a DKG DeviceKeyPackage into an encrypted keystore envelope with password protection.
 */
export async function exportEncryptedDeviceKey(
  key: DeviceKeyPackage,
  password: string,
  options: { iterations?: number } = {}
): Promise<EncryptedKeystoreEnvelope> {
  const serialized = serializeDeviceKeyPackage(key)
  const aad = new TextEncoder().encode(`sui-device-key-v1:${key.sessionId}:${key.holder}`)
  return encryptWithPassword(serialized, password, { ...options, aad })
}

/**
 * Unseals an encrypted keystore envelope back into a validated DeviceKeyPackage.
 */
export async function importEncryptedDeviceKey(
  envelope: EncryptedKeystoreEnvelope,
  password: string,
  sessionId: string,
  holder: string
): Promise<DeviceKeyPackage> {
  const aad = new TextEncoder().encode(`sui-device-key-v1:${sessionId}:${holder}`)
  const decrypted = await decryptWithPassword(envelope, password, { aad })
  const text = new TextDecoder("utf-8").decode(decrypted)
  return parseDeviceKeyPackage(text)
}

/**
 * Exports multiple private keys into standard Sui CLI Keystore format (`sui.keystore` JSON array).
 */
export function exportSuiCliKeystore(
  keys: Array<{ secretKey: Uint8Array; scheme?: SignatureScheme }>
): string {
  const entries = keys.map(k => encodeSuiKeystoreKey(k.secretKey, k.scheme ?? "ED25519"))
  return JSON.stringify(entries, null, 2)
}

/**
 * Imports a standard Sui CLI Keystore JSON array and returns parsed keys.
 */
export function importSuiCliKeystore(
  jsonContent: string
): Array<{ schema: SignatureScheme; secretKey: Uint8Array }> {
  const entries = JSON.parse(jsonContent)
  if (!Array.isArray(entries)) {
    throw new Error(t("dkg.cliKeystoreFormat"))
  }
  return entries.map(entry => {
    if (typeof entry !== "string") throw new Error(t("dkg.invalidKeystoreEntry"))
    return decodeSuiKeystoreKey(entry)
  })
}
