import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MAILBOX_AAD_VERSION,
  mailboxAad,
  generateIdentityKeypair,
  encryptMailboxShare,
  decryptMailboxShare,
  serializeEnvelopeToBytes,
  deserializeEnvelopeFromBytes,
  type ShareDeliveryPayload,
} from './mailbox';

// 这些测试钉住 #10 引入的 V2 密封契约：AAD =
//   utf8("SUI_DKG_MAILBOX_V1:") ‖ sessionId ‖ sender32 ‖ recipient32
// 同时绑入 HKDF info 与 AES-GCM additionalData。密封后的密文被挪到
// 别的会话或改寄别人时必须认证失败，而不是解出错误的分片。

const SESSION = '0x' + 'ab'.repeat(32);
const SENDER = '0x' + '11'.repeat(32);
const RECIPIENT = '0x' + '22'.repeat(32);
const OTHER_RECIPIENT = '0x' + '33'.repeat(32);

function samplePayload(): ShareDeliveryPayload {
  return {
    fromIndex: 1,
    toIndex: 2,
    round: 2,
    epoch: 1,
    secretShareHex: 'a1b2c3d4',
    commitmentsHex: ['deadbeef'],
    senderAddress: SENDER,
    recipientAddress: RECIPIENT,
  };
}

test('AAD 布局: domain ‖ sessionId ‖ sender32 ‖ recipient32', () => {
  const aad = mailboxAad({
    sessionId: SESSION,
    senderAddress: SENDER,
    recipientAddress: RECIPIENT,
  });
  const domain = new TextEncoder().encode('SUI_DKG_MAILBOX_V1:');
  const sessionId = new TextEncoder().encode(SESSION);
  assert.equal(aad.length, domain.length + sessionId.length + 64);
  assert.deepEqual(aad.subarray(0, domain.length), domain);
  assert.deepEqual(
    aad.subarray(domain.length, domain.length + sessionId.length),
    sessionId
  );
  assert.equal(
    Buffer.from(aad.subarray(-64, -32)).toString('hex'),
    '11'.repeat(32)
  );
  assert.equal(Buffer.from(aad.subarray(-32)).toString('hex'), '22'.repeat(32));
});

test('非 32 字节地址在 AAD 派生时被拒绝', () => {
  assert.throws(() =>
    mailboxAad({ sessionId: SESSION, senderAddress: '0xAlice', recipientAddress: RECIPIENT })
  );
});

test('密封 → 解开往返成功，信封带 V2 版本标记', async () => {
  const recipient = generateIdentityKeypair(RECIPIENT);
  const envelope = await encryptMailboxShare({
    sessionId: SESSION,
    senderAddress: SENDER,
    recipientAddress: RECIPIENT,
    recipientPublicKey: recipient.publicKey,
    payload: samplePayload(),
  });
  assert.equal(envelope.aadVersion, MAILBOX_AAD_VERSION);

  const payload = await decryptMailboxShare(envelope, recipient.secretKey, { sessionId: SESSION });
  assert.equal(payload.secretShareHex, 'a1b2c3d4');
  assert.equal(payload.senderAddress, SENDER);
});

test('错误收件人 AAD（密文改寄他人）认证失败', async () => {
  const recipient = generateIdentityKeypair(RECIPIENT);
  const envelope = await encryptMailboxShare({
    sessionId: SESSION,
    senderAddress: SENDER,
    recipientAddress: RECIPIENT,
    recipientPublicKey: recipient.publicKey,
    payload: samplePayload(),
  });
  // 篡改信封收件人后用同一私钥解开：AAD 派生自被篡改地址，必须失败
  const forged = { ...envelope, recipientAddress: OTHER_RECIPIENT };
  await assert.rejects(
    decryptMailboxShare(forged, recipient.secretKey, { sessionId: SESSION })
  );
});

test('错误会话 AAD（密文跨会话重放）认证失败', async () => {
  const recipient = generateIdentityKeypair(RECIPIENT);
  const envelope = await encryptMailboxShare({
    sessionId: SESSION,
    senderAddress: SENDER,
    recipientAddress: RECIPIENT,
    recipientPublicKey: recipient.publicKey,
    payload: samplePayload(),
  });
  const otherSession = '0x' + 'cd'.repeat(32);
  await assert.rejects(
    decryptMailboxShare(envelope, recipient.secretKey, { sessionId: otherSession })
  );
});

test('信封序列化往返保留 V2 字段', () => {
  const bytes = serializeEnvelopeToBytes({
    senderAddress: SENDER,
    recipientAddress: RECIPIENT,
    epoch: 1,
    timestamp: 123,
    ephemeralPublicKeyHex: 'ab'.repeat(32),
    ivHex: 'cd'.repeat(12),
    ciphertextHex: 'ef'.repeat(16),
    aadVersion: MAILBOX_AAD_VERSION,
  });
  const back = deserializeEnvelopeFromBytes(bytes);
  assert.equal(back.aadVersion, MAILBOX_AAD_VERSION);
  assert.equal(back.senderAddress, SENDER);
});
