/**
 * 离线双节点 E2E：两个 SDK `PrivateMessaging` 实例经假链事件总线互发密封私信，
 * 用 `createFrostDmTransport` 跑完整 request → round1 → transcript → round2 →
 * aggregate，最终签名对 DKG 群公钥验签通过。
 *
 * 这把「identity 私信承载 FROST」从只能真机验证变成每次 CI 可验证：
 * 编码/解码、事件投影、发送方认证、轮次校验与聚合全部走真实 SDK 代码路径。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bcs } from '@mysten/sui/bcs';
import type { SuiClientTypes } from '@mysten/sui/client';
import type { Transaction } from '@mysten/sui/transactions';
import { ed25519, ed25519_FROST } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { normalizeStructTag, normalizeSuiAddress } from '@mysten/sui/utils';
import type { IdentityProfile, IdentityRpc } from '../namespace/identity';
import { createFrostDmTransport } from './dm-transport';
import {
  aggregateFrostSession,
  createFrostRequest,
  createFrostTranscript,
  prepareFrostCommitment,
  produceFrostShare,
  type BoundDeviceKey,
  type FrostRound1,
  type FrostRound2,
  type ProtocolAuth,
} from './frost-session';
import { publicKeyPackageId } from './key-package';
import { createPrivateMessaging, type StoredMessageKey } from './private-messages';
import { createMemoryFrostSessionStore } from './session-store';
import { createMemoryDeviceVault } from './test-support';

const address = (seed: string) => `0x${seed.repeat(64).slice(0, 64)}`;
const packageId = address('a');
const namesId = address('b');
const config = { packageId, namesId };
const orgId = address('aa');
const MessageSent = bcs.struct('MessageSent', {
  sender: bcs.Address,
  recipient: bcs.Address,
  ciphertext: bcs.vector(bcs.u8()),
  nonce: bcs.vector(bcs.u8()),
  ephemeral_public_key: bcs.vector(bcs.u8()),
  recipient_key: bcs.vector(bcs.u8()),
});

function profile(idSeed: string, addressSeed: string, label: string): IdentityProfile {
  return { id: address(idSeed), address: address(addressSeed), label, displayName: label, avatarUrl: '', encryptionKey: [], followingTable: address('f0'), followingCount: 0 };
}

const alice = profile('1', '2', 'alice');
const bob = profile('4', '5', 'bob');
const profiles = new Map([alice, bob].map(value => [value.id, value]));

interface ListEventsOptions {
  filter?: { sender?: string; eventType?: string };
  before?: string | null;
  limit?: number;
  order?: 'ascending' | 'descending';
  signal?: AbortSignal;
}

/** 假链：PTB 执行 → MessageSent 事件；事件扫描与交易时间与真实 RPC 同形。 */
function createChain() {
  const events: SuiClientTypes.EventEntry[] = [];
  const times = new Map<string, number>();
  let sequence = 0;
  const rpc = {
    listEvents: async (options: ListEventsOptions) => {
      if (options.before) return { events: [], hasNextPage: false, startCursor: null, endCursor: null };
      const filter = options.filter ?? {};
      const matched = events.filter(event => {
        if (filter.eventType && normalizeStructTag(event.eventType) !== normalizeStructTag(filter.eventType)) return false;
        if (filter.sender && normalizeSuiAddress(event.sender) !== normalizeSuiAddress(filter.sender)) return false;
        return true;
      });
      const ordered = options.order === 'descending' ? [...matched].reverse() : matched;
      return { events: ordered.slice(0, options.limit ?? 50), hasNextPage: false, startCursor: null, endCursor: null };
    },
    getTransaction: async ({ digest }: { digest: string; signal?: AbortSignal }) => ({
      $kind: 'Transaction' as const,
      Transaction: { status: { success: true, error: null }, timestampMs: times.get(digest) ?? 1_700_000_000_000 },
    }),
  } as unknown as IdentityRpc;

  async function execute(tx: Transaction, sender: IdentityProfile): Promise<void> {
    const data = tx.getData();
    const command = data.commands[0];
    if (!command || command.$kind !== 'MoveCall') throw new Error('unsupported PTB');
    const pure = (index: number): Uint8Array => {
      const argument = command.MoveCall.arguments[index];
      if (!argument || argument.$kind !== 'Input') throw new Error('expected pure input');
      const input = data.inputs[argument.Input];
      if (!input || input.$kind !== 'Pure') throw new Error('expected pure input');
      return new Uint8Array(Buffer.from(input.Pure.bytes, 'base64'));
    };
    // pure.vector(u8) 输入是带 ULEB128 长度前缀的 BCS 编码。
    const vector = (index: number): number[] => Array.from(bcs.vector(bcs.u8()).parse(pure(index)));
    if (command.MoveCall.function === 'set_encryption_key') {
      const key = vector(2);
      sender.encryptionKey = key;
      const live = profiles.get(sender.id);
      if (live) live.encryptionKey = key;
      return;
    }
    if (command.MoveCall.function !== 'send_message') throw new Error(`unsupported move function ${command.MoveCall.function}`);
    const recipientId = `0x${Buffer.from(pure(2)).toString('hex')}`;
    const digest = `digest-${sequence}`;
    times.set(digest, 1_700_000_000_000 + sequence);
    events.push({
      packageId,
      module: 'identity',
      sender: sender.address,
      eventType: `${packageId}::identity::MessageSent`,
      bcs: MessageSent.serialize({
        sender: sender.id,
        recipient: recipientId,
        ciphertext: vector(3),
        nonce: vector(4),
        ephemeral_public_key: vector(5),
        recipient_key: vector(6),
      }).toBytes(),
      json: null,
      checkpoint: String(sequence),
      transactionDigest: digest,
      eventIndex: 0,
    });
    sequence++;
  }
  return { events, rpc, execute };
}

function messageKeys(): { store: { read(id: string): Promise<StoredMessageKey | undefined>; save(record: StoredMessageKey): Promise<void> } } {
  const records = new Map<string, StoredMessageKey>();
  return { store: { read: async id => records.get(id), save: async record => { records.set(record.id, record); } } };
}

const auth: ProtocolAuth = {
  async sign(bytes) {
    return { signature: Buffer.from(sha256(bytes)).toString('hex') };
  },
  async verify(bytes, signature, expected) {
    assert.equal(signature, Buffer.from(sha256(bytes)).toString('hex'));
    assert.ok([alice.address, bob.address].includes(expected));
  },
};

test('offline two-node identity-DM transport closes the FROST dependency chain end to end', async () => {
  const chain = createChain();
  const getIdentity = async (id: string) => {
    const found = profiles.get(id);
    if (!found) throw new Error('Unknown identity');
    return found;
  };
  const aliceKeys = messageKeys();
  const bobKeys = messageKeys();
  const messaging = (keys: { read: (id: string) => Promise<StoredMessageKey | undefined>; save: (record: StoredMessageKey) => Promise<void> }) =>
    createPrivateMessaging({ config, rpc: chain.rpc, keys, execute: chain.execute, getIdentity, isConfigured: () => true });

  // 1. 双方启用私聊：公钥经链上 set_encryption_key 发布。
  await messaging(aliceKeys.store).enablePrivateMessages(alice);
  await messaging(bobKeys.store).enablePrivateMessages(bob);
  assert.equal(alice.encryptionKey.length, 65);
  assert.equal(bob.encryptionKey.length, 65);

  const aliceTransport = createFrostDmTransport({ messaging: messaging(aliceKeys.store), resolveIdentity: getIdentity, verify: auth.verify });
  const bobTransport = createFrostDmTransport({ messaging: messaging(bobKeys.store), resolveIdentity: getIdentity, verify: auth.verify });

  // 2. 2-of-2 测试密钥包（trusted dealer；不覆盖 DKG 流程本身）。
  const identifiers = [1n, 2n].map(value => ed25519_FROST.Identifier.fromNumber(Number(value)));
  const dealer = ed25519_FROST.trustedDealer({ min: 2, max: 2 }, identifiers);
  const metadata = {
    network: 'sui:testnet' as const,
    sessionId: address('bb'),
    participantAddresses: [alice.address, bob.address],
    dealerAddresses: [alice.address, bob.address],
    threshold: 2n,
    sessionEpoch: 7n,
    commitments: dealer.public.commitments,
  };
  const keyPackageId = publicKeyPackageId(metadata);
  const keys = identifiers.map((identifier, index) => ({
    ...structuredClone(metadata),
    holder: index === 0 ? alice.address : bob.address,
    index: BigInt(index + 1),
    share: ed25519_FROST.utils.Fn.fromBytes(dealer.secretShares[identifier].signingShare),
    groupPk: metadata.commitments[0].slice(),
    keyPackageId,
    orgId,
    epoch: 7n,
    creationDigest: '00'.repeat(32),
  })) as BoundDeviceKey[];
  const request = await createFrostRequest({
    action: { kind: 'epoch', packageId: address('cc'), orgId, epoch: '7', nonce: '2', chainIdHex: '33'.repeat(32), newEpoch: '8', keyGeneration: '1' },
    key: keys[0],
    signerIndices: [1n, 2n],
    coordinator: alice.address,
    expiresAtMs: Date.now() + 300_000,
  }, auth);
  const aliceStore = createMemoryFrostSessionStore();
  const bobStore = createMemoryFrostSessionStore();
  const aliceVault = createMemoryDeviceVault();
  const bobVault = createMemoryDeviceVault();

  // 3. round 1：两个设备各自生成承诺，经加密私信互发。
  const [aliceRound1, bobRound1] = await Promise.all([
    prepareFrostCommitment(request, keys[0], { store: aliceStore, vault: aliceVault, auth }),
    prepareFrostCommitment(request, keys[1], { store: bobStore, vault: bobVault, auth }),
  ]);
  await aliceTransport.send({ request, round: aliceRound1, sender: alice, recipient: bob, userClickConfirmed: true });
  await bobTransport.send({ request, round: bobRound1, sender: bob, recipient: alice, userClickConfirmed: true });

  const aliceView = (await aliceTransport.list({ request, me: alice, peers: [bob] }))[0];
  const bobView = (await bobTransport.list({ request, me: bob, peers: [alice] }))[0];
  assert.equal(aliceView.unavailableReason, undefined);
  assert.equal(bobView.unavailableReason, undefined);
  assert.equal(aliceView.rounds.length, 2);
  assert.equal(bobView.rounds.length, 2);

  // 4. 协调者（alice）按名册顺序构造并认证 transcript。
  const ordered = aliceView.rounds
    .map(entry => entry.round)
    .sort((a, b) => Number(BigInt(a.index) - BigInt(b.index))) as FrostRound1[];
  const transcript = await createFrostTranscript(request, ordered, auth, aliceStore);

  // 5. round 2：各自消费 nonce 生成份额，经私信互发。
  const aliceShare = await produceFrostShare(request, transcript, keys[0], { store: aliceStore, vault: aliceVault, auth });
  const bobShare = await produceFrostShare(request, transcript, keys[1], { store: bobStore, vault: bobVault, auth });
  await aliceTransport.send({ request, round: aliceShare, transcript, sender: alice, recipient: bob, userClickConfirmed: true });
  await bobTransport.send({ request, round: bobShare, transcript, sender: bob, recipient: alice, userClickConfirmed: true });

  // 6. 从加密私信历史收集 round 2 并聚合；签名对群公钥验签通过。
  const finalView = (await aliceTransport.list({ request, transcript, me: alice, peers: [bob] }))[0];
  assert.equal(finalView.unavailableReason, undefined);
  assert.equal(finalView.rounds.length, 4);
  const shares = finalView.rounds.map(entry => entry.round).filter((round): round is FrostRound2 => 'scalar' in round);
  assert.equal(shares.length, 2);
  const result = await aggregateFrostSession(request, transcript, shares, auth.verify);
  assert.equal(result.signature.length, 64);
  assert.deepEqual(result.signerIndices, [1n, 2n]);
  assert.equal(ed25519.verify(result.signature, result.digest, result.groupPk), true);
  const tampered = result.digest.slice();
  tampered[0] ^= 1;
  assert.equal(ed25519.verify(result.signature, tampered, result.groupPk), false);
});
