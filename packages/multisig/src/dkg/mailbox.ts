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
  /** AAD 版本标记：密封算法将 domain/session/sender/recipient 绑入 HKDF info 与 AES-GCM AAD。 */
  aadVersion: number;
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

/**
 * 密态信箱密封版本。V2 起将
 * utf8("SUI_DKG_MAILBOX_V1:") ‖ sessionId ‖ sender32 ‖ recipient32
 * 同时绑入 HKDF info 与 AES-GCM additionalData，
 * 密文不可跨会话、跨发件人、跨收件人重放。
 */
export const MAILBOX_AAD_VERSION = 2;

const MAILBOX_AAD_DOMAIN = 'SUI_DKG_MAILBOX_V1:';
const HKDF_SALT = new TextEncoder().encode('DKG_ASYNC_MAILBOX_SALT_V2');

/** 地址字符串 (0x 十六进制) -> 32 字节小端地址（Sui address 即 32 字节）。 */
function addressBytes(address: string): Uint8Array {
  const clean = address.startsWith('0x') ? address.slice(2) : address;
  if (clean.length !== 64) {
    throw new Error(`地址必须是 32 字节 Sui 地址: ${address}`);
  }
  return fromHex(clean);
}

/** utf8 编码辅助（每次新建 TextEncoder 开销可忽略，保持无模块级状态）。 */
function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/**
 * AAD 字节布局（V2，绑入 HKDF info 与 AES-GCM additionalData 两层）：
 *   utf8("SUI_DKG_MAILBOX_V1:") ‖ sessionId 的 utf8 字节 ‖ sender 32B ‖ recipient 32B
 * sessionId 以 utf8 原文参与（链上会话 ID 是任意字符串，不强制 32B 地址格式）。
 */
export function mailboxAad(params: {
  sessionId: string;
  senderAddress: string;
  recipientAddress: string;
}): Uint8Array {
  const domain = utf8(MAILBOX_AAD_DOMAIN);
  const sessionId = utf8(params.sessionId);
  const sender = addressBytes(params.senderAddress);
  const recipient = addressBytes(params.recipientAddress);
  const aad = new Uint8Array(domain.length + sessionId.length + 32 + 32);
  aad.set(domain, 0);
  aad.set(sessionId, domain.length);
  aad.set(sender, domain.length + sessionId.length);
  aad.set(recipient, domain.length + sessionId.length + 32);
  return aad;
}

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
 * 低阶/全零共享秘密检测（round-7）：X25519 对低阶临时公钥（全零点等）
 * 会得到全零共享秘密。全零密钥会让任何密文都以确定的方式被"解密"，
 * 不能交给 AES-GCM。密封侧同样拒绝，保证两侧对称拒绝该类信封。
 */
export function assertNonZeroSharedSecret(sharedSecret: Uint8Array, side: 'encrypt' | 'decrypt'): void {
  const isZeroSecret = sharedSecret.length === 32 && sharedSecret.every(b => b === 0)
  if (sharedSecret.length !== 32 || isZeroSecret) {
    throw new Error(`[mailbox:${side}] low-order ephemeral detected: all-zero X25519 shared secret rejected`)
  }
}

/**
 * 使用接收方的公钥对 DKG 分片进行密态信箱投递加密 (HPKE / ECIES with AES-256-GCM)
 *
 * V2: AAD = utf8("SUI_DKG_MAILBOX_V1:") ‖ sessionId ‖ sender32 ‖ recipient32
 * 同时作为 HKDF info 与 AES-GCM additionalData；sessionId 必填。
 */
export async function encryptMailboxShare(params: {
  sessionId: string;
  senderAddress: string;
  recipientAddress: string;
  recipientPublicKey: Uint8Array;
  payload: ShareDeliveryPayload;
  epoch?: number;
}): Promise<MailboxEnvelope> {
  const ephemeral = x25519.keygen();
  const sharedSecret = x25519.getSharedSecret(ephemeral.secretKey, params.recipientPublicKey);
  assertNonZeroSharedSecret(sharedSecret, 'encrypt');

  // AAD 绑定会话与收发双方：HKDF info 与 AES-GCM additionalData 两层同时绑定
  const aad = mailboxAad({
    sessionId: params.sessionId,
    senderAddress: params.senderAddress,
    recipientAddress: params.recipientAddress,
  });

  // 通过 HKDF 派生 256 位对称密钥（info = AAD）
  const derivedKeyBytes = hkdf(sha256, sharedSecret, HKDF_SALT, aad, 32);

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
    { name: 'AES-GCM', iv: iv as BufferSource, additionalData: aad as BufferSource },
    rawKey,
    plaintext as BufferSource
  );

  return {
    senderAddress: params.senderAddress,
    recipientAddress: params.recipientAddress,
    epoch: params.epoch ?? params.payload.epoch ?? 1,
    timestamp: Date.now(),
    ephemeralPublicKeyHex: bytesToHex(ephemeral.publicKey),
    ivHex: bytesToHex(iv),
    ciphertextHex: bytesToHex(new Uint8Array(ciphertextBuffer)),
    aadVersion: MAILBOX_AAD_VERSION,
  };
}

/**
 * 离线成员上线后，使用自身私钥解开信箱中的密态分片
 *
 * V2: 调用方必须显式传入与密封时相同的 sessionId；AAD 不匹配（跨会话/
 * 跨收件人/跨发件人重放或 V1 旧信封）会因 GCM 认证失败而抛错。
 * round-7: 临时公钥为低阶点导致的全零 X25519 共享秘密在 AES-GCM 之前
 * 直接拒绝（低阶临时公钥攻击的封闭式防御）。
 */
export async function decryptMailboxShare(
  envelope: MailboxEnvelope,
  recipientSecretKey: Uint8Array,
  context: { sessionId: string }
): Promise<ShareDeliveryPayload> {
  const ephemeralPubKey = hexToBytes(envelope.ephemeralPublicKeyHex);
  const sharedSecret = x25519.getSharedSecret(recipientSecretKey, ephemeralPubKey);
  assertNonZeroSharedSecret(sharedSecret, 'decrypt');

  // 与密封侧对称：AAD 必须由同样的参数显式派生，绝不从信封隐式读取
  const aad = mailboxAad({
    sessionId: context.sessionId,
    senderAddress: envelope.senderAddress,
    recipientAddress: envelope.recipientAddress,
  });

  const derivedKeyBytes = hkdf(sha256, sharedSecret, HKDF_SALT, aad, 32);

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
    { name: 'AES-GCM', iv: iv as BufferSource, additionalData: aad as BufferSource },
    rawKey,
    ciphertext as BufferSource
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
