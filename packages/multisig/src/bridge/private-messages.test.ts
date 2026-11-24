import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { bcs } from '@mysten/sui/bcs';
import type { SuiClientTypes } from '@mysten/sui/client';
import type { IdentityProfile, IdentityRpc } from '../namespace/identity';
import { generateMessageKey, publicKeyBytes, sealMessage, toBase64 } from './message-crypto';
import { createPrivateMessaging, type PrivateMessaging, type StoredMessageKey } from './private-messages';

const address = (digit: string) => `0x${digit.repeat(64)}`;
const packageId = address('a');
const config = { packageId, namesId: address('b') };
const me: IdentityProfile = { id: address('1'), address: address('2'), label: 'alice', displayName: '', avatarUrl: '', encryptionKey: [], followingTable: address('3'), followingCount: 0 };
const peer = { ...me, id: address('4'), address: address('5'), label: 'bob' };
const MessageSent = bcs.struct('MessageSent', { sender: bcs.Address, recipient: bcs.Address, ciphertext: bcs.vector(bcs.u8()), nonce: bcs.vector(bcs.u8()), ephemeral_public_key: bcs.vector(bcs.u8()), recipient_key: bcs.vector(bcs.u8()) });
const eventType = `${packageId}::identity::MessageSent`;
const page = (events: SuiClientTypes.EventEntry[], hasNextPage = false, endCursor: string | null = null) => ({ events, hasNextPage, startCursor: endCursor, endCursor });
type TransactionOptions = { digest: string; signal?: AbortSignal };

const calls = {
  listEvents: async (_options: SuiClientTypes.ListEventsOptions) => page([]),
  getTransaction: async (_options: TransactionOptions) => ({ $kind: 'Transaction' as const, Transaction: { status: { success: true, error: null }, timestampMs: 1_700_000_000_000 as number | null } }),
};
const rpc = {
  listEvents: (options: SuiClientTypes.ListEventsOptions) => calls.listEvents(options),
  getTransaction: (options: TransactionOptions) => calls.getTransaction(options),
} as unknown as IdentityRpc;

/** 每个用例独立构造工厂；键存储只在内存，签名执行被记录但不广播。 */
function make(overrides: { getIdentity?: (id: string) => Promise<IdentityProfile>; records?: Map<string, StoredMessageKey> } = {}): PrivateMessaging {
  const records = overrides.records ?? new Map<string, StoredMessageKey>();
  return createPrivateMessaging({
    config,
    rpc,
    keys: { read: async id => records.get(id), save: async record => { records.set(record.id, record); } },
    execute: async () => {},
    getIdentity: overrides.getIdentity ?? (async id => {
      if (id === me.id) return me;
      if (id === peer.id) return peer;
      throw new Error('Unknown identity');
    }),
    isConfigured: () => true,
  });
}

async function encryptedEvent(sender = peer, recipient = me, digest = 'digest', index = 0) {
  const [senderPair, recipientPair] = await Promise.all([generateMessageKey(), generateMessageKey()]);
  const senderKey = await publicKeyBytes(senderPair.publicKey), recipientKey = await publicKeyBytes(recipientPair.publicKey);
  const sealed = await sealMessage('链上私信', senderKey, recipientKey, { senderId: sender.id, recipientId: recipient.id });
  const fields = { sender: sender.id, recipient: recipient.id, ciphertext: Array.from(sealed.ciphertext), nonce: Array.from(sealed.nonce), ephemeral_public_key: Array.from(sealed.ephemeralKey), recipient_key: Array.from(recipientKey) };
  const event: SuiClientTypes.EventEntry = { packageId, module: 'identity', sender: sender.address, eventType, bcs: MessageSent.serialize(fields).toBytes(), json: null, checkpoint: '42', transactionDigest: digest, eventIndex: index };
  return { event, fields, senderPair, recipientPair, senderKey, recipientKey };
}
function transactions(timestampMs: number | null = 1_700_000_000_000) {
  let count = 0;
  calls.getTransaction = async () => {
    count++;
    return { $kind: 'Transaction' as const, Transaction: { status: { success: true, error: null }, timestampMs } };
  };
  return { count: () => count };
}

afterEach(() => {
  calls.listEvents = async () => page([]);
  calls.getTransaction = async () => ({ $kind: 'Transaction' as const, Transaction: { status: { success: true, error: null }, timestampMs: 1_700_000_000_000 } });
});

test('exposes scan completeness while keeping the legacy array API', async () => {
  const { event } = await encryptedEvent(peer, me, 'history');
  let callsCount = 0;
  calls.listEvents = async ({ filter, before }: SuiClientTypes.ListEventsOptions) => {
    callsCount++;
    if (filter?.sender === me.address) return page([]);
    return before ? page([], false, 'done') : page([event], true, 'frontier');
  };
  transactions();
  const messaging = make();
  const history = await messaging.readPrivateMessageHistory(me, peer, { maxPages: 1 });
  assert.deepEqual(history, { messages: [{ id: 'history:0', senderId: peer.id, recipientId: me.id, text: null, timestampMs: 1_700_000_000_000, unavailableReason: '此设备没有该消息的私钥，无法解密。' }], truncated: true, scannedEvents: 1 });
  assert.equal((await messaging.getPrivateMessages(me, peer)).length, 1);
  assert.equal(callsCount, 5);
});

test('paginates gRPC events including empty scan pages, deduplicates, and uses transaction time', async () => {
  const { event } = await encryptedEvent();
  const cursors: Array<string | null | undefined> = [];
  calls.listEvents = async ({ filter, before, order }: SuiClientTypes.ListEventsOptions) => {
    assert.equal(order, 'descending');
    if (filter?.sender === me.address) return page([]);
    assert.equal(filter?.sender, peer.address);
    cursors.push(before);
    return before ? page([event, event]) : page([], true, 'scan-frontier');
  };
  const time = transactions();
  const messages = await make().getPrivateMessages(me, peer);
  assert.deepEqual(cursors, [null, 'scan-frontier']);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].id, 'digest:0');
  assert.equal(messages[0].timestampMs, 1_700_000_000_000);
  assert.equal(messages[0].senderId, peer.id);
  assert.match(messages[0].unavailableReason!, /没有该消息的私钥/);
  assert.equal(time.count(), 1);
});

test('decrypts incoming and outgoing BCS envelopes with existing non-extractable device keys', async () => {
  const incoming = await encryptedEvent(peer, me, 'incoming');
  const outgoing = await encryptedEvent(me, peer, 'outgoing');
  calls.listEvents = async ({ filter }: SuiClientTypes.ListEventsOptions) => page([filter?.sender === me.address ? outgoing.event : incoming.event]);
  transactions();
  const records = new Map<string, StoredMessageKey>([
    [`${packageId}::identity:${me.id}:${toBase64(incoming.recipientKey)}`, { id: `${packageId}::identity:${me.id}:${toBase64(incoming.recipientKey)}`, pair: incoming.recipientPair }],
    [`${packageId}::identity:${me.id}:${toBase64(outgoing.senderKey)}`, { id: `${packageId}::identity:${me.id}:${toBase64(outgoing.senderKey)}`, pair: outgoing.senderPair }],
  ]);
  assert.equal(incoming.recipientPair.privateKey.extractable, false);
  const messages = await make({ records }).getPrivateMessages(me, peer);
  assert.equal(messages.length, 2);
  assert.ok(messages.every(message => message.text === '链上私信' && !message.unavailableReason));
});

test('keeps incoming recipient-key epoch binding when parsing BCS events', async () => {
  const { event, fields } = await encryptedEvent();
  fields.recipient_key[1] ^= 1;
  event.bcs = MessageSent.serialize(fields).toBytes();
  calls.listEvents = async ({ filter }: SuiClientTypes.ListEventsOptions) => page(filter?.sender === peer.address ? [event] : []);
  transactions();
  const [message] = await make().getPrivateMessages(me, peer);
  assert.equal(message.text, null);
  assert.match(message.unavailableReason!, /接收密钥与链上记录不匹配/);
});

test('filters exact contract type and both identities before reading timestamps', async () => {
  const { event, fields } = await encryptedEvent();
  const unrelated = { ...event, bcs: MessageSent.serialize({ ...fields, recipient: address('f') }).toBytes() };
  calls.listEvents = async () => page([{ ...event, eventType: `${address('b')}::identity::MessageSent` }, unrelated]);
  const time = transactions();
  assert.deepEqual(await make().getPrivateMessages(me, peer), []);
  assert.equal(time.count(), 0);
});

test('rejects event senders that do not own the claimed protocol identity', async () => {
  const { event } = await encryptedEvent();
  calls.listEvents = async () => page([{ ...event, sender: me.address }]);
  await assert.rejects(make().getPrivateMessages(me, peer), /发送方与身份所有者/);
});

test('does not turn event-query or transaction-time failures into an empty history', async () => {
  calls.listEvents = async () => {
    throw new Error('event service unavailable');
  };
  await assert.rejects(make().getPrivateMessages(me, peer), /event service unavailable/);
  const { event } = await encryptedEvent();
  calls.listEvents = async ({ filter }: SuiClientTypes.ListEventsOptions) => page(filter?.sender === peer.address ? [event] : []);
  calls.getTransaction = async () => {
    throw new Error('transaction service unavailable');
  };
  await assert.rejects(make().getPrivateMessages(me, peer), /transaction service unavailable/);
  transactions(null);
  await assert.rejects(make().getPrivateMessages(me, peer), /有效的链上时间/);
});

test('discovers inbound conversations without requiring a follow edge and keeps undecryptable previews', async () => {
  const incoming = await encryptedEvent(peer, me, 'inbox');
  calls.listEvents = async ({ filter }: SuiClientTypes.ListEventsOptions) => {
    assert.equal(filter?.eventType, eventType);
    return page([incoming.event, incoming.event]);
  };
  transactions();
  const result = await make().listPrivateConversations(me, {
    resolveProfile: async (id: string) => {
      assert.equal(id, peer.id);
      return peer;
    },
  });
  assert.equal(result.conversations.length, 1);
  assert.equal(result.conversations[0].peer.id, peer.id);
  assert.equal(result.conversations[0].messageCount, 1);
  const last = result.conversations[0].lastMessage;
  assert.ok(last && last.unavailableReason, 'the last message should carry an unavailability reason');
  assert.match(last.unavailableReason, /没有该消息的私钥/);
  assert.equal(result.truncated, false);
  assert.equal(result.scannedEvents, 2);
});

test('deduplicates inbox events, marks scan truncation, and rejects a stuck cursor', async () => {
  const incoming = await encryptedEvent(peer, me, 'cursor');
  let callsCount = 0;
  calls.listEvents = async () => {
    callsCount++;
    return callsCount === 1 ? page([incoming.event], true, 'frontier') : page([incoming.event], true, 'frontier-2');
  };
  transactions();
  const result = await make().listPrivateConversations(me, { maxPages: 2, resolveProfile: async () => peer });
  assert.equal(result.conversations[0].messageCount, 1);
  assert.equal(result.truncated, true);
  calls.listEvents = async () => page([], true, 'same-frontier');
  await assert.rejects(make().listPrivateConversations(me, { resolveProfile: async () => peer }), /分页未前进/);
});

test('rejects an inbox event whose transaction sender does not own the claimed identity', async () => {
  const incoming = await encryptedEvent(peer, me, 'ownership');
  calls.listEvents = async () => page([{ ...incoming.event, sender: address('9') }]);
  await assert.rejects(make().listPrivateConversations(me, { resolveProfile: async () => peer }), /发送方与身份所有者/);
});
