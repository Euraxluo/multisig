// A versioned message envelope, separate from transport and browser key storage.
// ECDH P-256 + HKDF-SHA256 + AES-256-GCM. This is not an MLS ratchet.
import { t } from "./i18n/t"
export interface MessageContext { senderId: string; recipientId: string }
export interface MessageEnvelope { v: 1; senderKey: string; recipientKey: string; to: string; from: string }
export interface SealedMessage { ciphertext: Uint8Array; nonce: Uint8Array; ephemeralKey: Uint8Array }
export const MAX_MESSAGE_BYTES = 1000

export function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
}

export function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0))
}

export async function generateMessageKey(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"])
}

export async function publicKeyBytes(key: CryptoKey): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.exportKey("raw", key))
}

async function deriveKey(privateKey: CryptoKey, publicKey: Uint8Array, nonce: Uint8Array, context: MessageContext, envelope: Pick<MessageEnvelope, "senderKey" | "recipientKey">, direction: "to" | "from") {
  const remote = await crypto.subtle.importKey("raw", new Uint8Array(publicKey), { name: "ECDH", namedCurve: "P-256" }, false, [])
  const secret = await crypto.subtle.deriveBits({ name: "ECDH", public: remote }, privateKey, 256)
  const material = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"])
  const aad = new TextEncoder().encode(JSON.stringify(["sui-identity-dm-v1", context.senderId, context.recipientId, envelope.senderKey, envelope.recipientKey, direction]))
  const key = await crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(nonce), info: aad }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"])
  return { key, aad }
}

export async function sealMessage(text: string, senderKey: Uint8Array, recipientKey: Uint8Array, context: MessageContext): Promise<SealedMessage> {
  const plaintext = new TextEncoder().encode(text)
  if (!text.trim() || plaintext.byteLength > MAX_MESSAGE_BYTES) throw new Error(t("misc.msgCrypto.empty"))
  const ephemeral = await generateMessageKey()
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const header = { senderKey: toBase64(senderKey), recipientKey: toBase64(recipientKey) }
  const to = await deriveKey(ephemeral.privateKey, recipientKey, nonce, context, header, "to")
  const from = await deriveKey(ephemeral.privateKey, senderKey, nonce, context, header, "from")
  const envelope: MessageEnvelope = {
    v: 1, ...header,
    to: toBase64(new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: to.aad }, to.key, plaintext))),
    from: toBase64(new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: from.aad }, from.key, plaintext))),
  }
  return { ciphertext: new TextEncoder().encode(JSON.stringify(envelope)), nonce, ephemeralKey: await publicKeyBytes(ephemeral.publicKey) }
}

export function readEnvelope(ciphertext: Uint8Array): MessageEnvelope {
  if (ciphertext.length > 4112) throw new Error(t("misc.msgCrypto.tooLong"))
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(ciphertext))
  if (value.v !== 1 || ![value.senderKey, value.recipientKey, value.to, value.from].every((part) => typeof part === "string")) throw new Error(t("misc.msgCrypto.unsupported"))
  return value
}

export async function openMessage(message: SealedMessage, privateKey: CryptoKey, context: MessageContext, direction: "to" | "from"): Promise<string> {
  const envelope = readEnvelope(message.ciphertext)
  const { key, aad } = await deriveKey(privateKey, message.ephemeralKey, message.nonce, context, envelope, direction)
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(message.nonce), additionalData: aad }, key, fromBase64(envelope[direction]))
  if (plaintext.byteLength > MAX_MESSAGE_BYTES) throw new Error(t("misc.msgCrypto.tooLong"))
  return new TextDecoder("utf-8", { fatal: true }).decode(plaintext)
}
