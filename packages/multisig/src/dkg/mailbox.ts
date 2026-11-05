import { x25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { fromHex, toHex } from '@mysten/sui/utils';

export interface IdentityKeypair {
  address: string;
  secretKey: Uint8Array;
  publicKey: Uint8Array;
  publicKeyHex: string;
}

export interface MailboxEnvelope {
  senderAddress: string;
  recipientAddress: string;
  epoch: number;
  timestamp: number;
  ephemeralPublicKeyHex: string;
  ivHex: string;
  ciphertextHex: string;
}

export interface ShareDeliveryPayload {
  fromIndex: number;
  toIndex: number;
  round: number;
  epoch: number;
  secretShareHex: string;
  commitmentsHex: string[];
  senderAddress: string;
  recipientAddress: string;
}

const HKDF_SALT = new TextEncoder().encode('DKG_ASYNC_MAILBOX_SALT_V1');
const HKDF_INFO = new TextEncoder().encode('DKG_SHARE_DELIVERY_V1');

export function bytesToHex(bytes: Uint8Array): string {
  return toHex(bytes);
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) {
    throw new Error(`hex 长度必须为偶数: ${hex}`);
  }
  return fromHex(clean);
}

/**
 * 为组织成员生成 X25519 预置身份公私钥 (Pre-key)
 */
export function generateIdentityKeypair(address: string): IdentityKeypair {
  const kp = x25519.keygen();
  return {
    address,
    secretKey: kp.secretKey,
    publicKey: kp.publicKey,
    publicKeyHex: bytesToHex(kp.publicKey),
  };
}

/**
 * 使用接收方的公钥对 DKG 分片进行密态信箱投递加密 (HPKE / ECIES with AES-256-GCM)
 */
export async function encryptMailboxShare(params: {
  senderAddress: string;
  recipientAddress: string;
  recipientPublicKey: Uint8Array;
  payload: ShareDeliveryPayload;
  epoch?: number;
}): Promise<MailboxEnvelope> {
  const ephemeral = x25519.keygen();
  const sharedSecret = x25519.getSharedSecret(ephemeral.secretKey, params.recipientPublicKey);

  // 通过 HKDF 派生 256 位对称密钥
  const derivedKeyBytes = hkdf(sha256, sharedSecret, HKDF_SALT, HKDF_INFO, 32);

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const rawKey = await crypto.subtle.importKey(
    'raw',
    derivedKeyBytes,
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt']
  );

  const plaintext = new TextEncoder().encode(JSON.stringify(params.payload));
  const ciphertextBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as any },
    rawKey,
    plaintext as any
  );

  return {
    senderAddress: params.senderAddress,
    recipientAddress: params.recipientAddress,
    epoch: params.epoch ?? params.payload.epoch ?? 1,
    timestamp: Date.now(),
    ephemeralPublicKeyHex: bytesToHex(ephemeral.publicKey),
    ivHex: bytesToHex(iv),
    ciphertextHex: bytesToHex(new Uint8Array(ciphertextBuffer)),
  };
}

/**
 * 离线成员上线后，使用自身私钥解开信箱中的密态分片
 */
export async function decryptMailboxShare(
  envelope: MailboxEnvelope,
  recipientSecretKey: Uint8Array
): Promise<ShareDeliveryPayload> {
  const ephemeralPubKey = hexToBytes(envelope.ephemeralPublicKeyHex);
  const sharedSecret = x25519.getSharedSecret(recipientSecretKey, ephemeralPubKey);

  const derivedKeyBytes = hkdf(sha256, sharedSecret, HKDF_SALT, HKDF_INFO, 32);

  const iv = hexToBytes(envelope.ivHex);
  const rawKey = await crypto.subtle.importKey(
    'raw',
    derivedKeyBytes,
    { name: 'AES-GCM' },
    false,
    ['decrypt']
  );

  const ciphertext = hexToBytes(envelope.ciphertextHex);
  const decryptedBuffer = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv as any },
    rawKey,
    ciphertext as any
  );

  const decryptedText = new TextDecoder().decode(decryptedBuffer);
  return JSON.parse(decryptedText) as ShareDeliveryPayload;
}

/**
 * 将信箱信封编码为可存储于 Sui 链上 Table<address, vector<u8>> 的二进制格式
 */
export function serializeEnvelopeToBytes(envelope: MailboxEnvelope): Uint8Array {
  const jsonStr = JSON.stringify(envelope);
  return new TextEncoder().encode(jsonStr);
}

/**
 * 从链上返回的 vector<u8> 二进制反序列化为 MailboxEnvelope
 */
export function deserializeEnvelopeFromBytes(rawBytes: Uint8Array): MailboxEnvelope {
  const jsonStr = new TextDecoder().decode(rawBytes);
  return JSON.parse(jsonStr) as MailboxEnvelope;
}
