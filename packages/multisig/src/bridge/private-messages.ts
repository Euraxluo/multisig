/**
 * identity 加密私信：键管理、发送、收件箱/历史投影（事件扫描 + 解密 + 冲突检测）。
 *
 * 与链交互唯一需要宿主能力的两处通过注入完成：
 * - `keys`：本机消息密钥存储（前端为 IndexedDB，非可导出 CryptoKey 不可外流）
 * - `execute`：PTB 钱包签名与提交（前端为 `submit(cross(tx), profile)`）
 *
 * 事件扫描条件、解密顺序、冲突判定与前端实现逐字节一致。
 */
import { bcs } from '@mysten/sui/bcs';
import type { SuiClientTypes } from '@mysten/sui/client';
import type { Transaction } from '@mysten/sui/transactions';
import { isValidSuiAddress, normalizeStructTag, normalizeSuiAddress } from '@mysten/sui/utils';
import {
  buildSendMessage,
  buildSetEncryptionKey,
  IdentityClient,
  isValidIdentityConfig,
  type IdentityNamespaceConfig,
  type IdentityProfile,
  type IdentityRpc,
} from '../namespace/identity';
import { generateMessageKey, openMessage, publicKeyBytes, readEnvelope, sealMessage, toBase64 } from './message-crypto';
import { bridgeT, type BridgeTranslate } from './messages';

export interface PrivateMessage {
  id: string;
  senderId: string;
  recipientId: string;
  text: string | null;
  timestampMs: number;
  unavailableReason?: string;
}
export interface PrivateConversation {
  peer: IdentityProfile;
  lastMessage: PrivateMessage | null;
  messageCount: number;
}
export interface PrivateConversationList {
  conversations: PrivateConversation[];
  scannedEvents: number;
  truncated: boolean;
  failures: Array<{ senderId: string; reason: string }>;
}
export interface PrivateMessageHistory {
  messages: PrivateMessage[];
  truncated: boolean;
  scannedEvents: number;
}
export interface PrivateMessageHistoryOptions {
  maxPages?: number;
  pageSize?: number;
}

/** 一条本机私信密钥：`id` 由 identity 模块、身份对象与公钥共同派生。 */
export interface StoredMessageKey {
  id: string;
  pair: CryptoKeyPair;
}

/** 本机消息密钥存储；IndexedDB 结构化克隆保留不可导出私钥。 */
export interface MessageKeyStore {
  read(id: string): Promise<StoredMessageKey | undefined>;
  save(record: StoredMessageKey): Promise<void>;
}

export interface PrivateMessagingOptions {
  config: IdentityNamespaceConfig;
  rpc: IdentityRpc;
  keys: MessageKeyStore;
  /** 签名并提交 PTB；成功后 resolve。 */
  execute: (tx: Transaction, profile: IdentityProfile) => Promise<void>;
  /** 读取链上身份；默认用 `IdentityClient(rpc, config).getIdentity`。 */
  getIdentity?: (id: string) => Promise<IdentityProfile>;
  /** 身份协议是否配置；默认 `isValidIdentityConfig(config)`。 */
  isConfigured?: () => boolean;
  translate?: BridgeTranslate;
}

export interface PrivateMessaging {
  hasMessagingKey(profile: IdentityProfile): Promise<boolean>;
  enablePrivateMessages(profile: IdentityProfile): Promise<void>;
  sendPrivateMessage(sender: IdentityProfile, recipient: IdentityProfile, text: string): Promise<void>;
  listPrivateConversations(me: IdentityProfile, options?: { maxPages?: number; pageSize?: number; resolveProfile?: (id: string) => Promise<IdentityProfile> }): Promise<PrivateConversationList>;
  readPrivateMessageHistory(me: IdentityProfile, peer: IdentityProfile, options?: PrivateMessageHistoryOptions): Promise<PrivateMessageHistory>;
  /** 既有消费者使用的数组接口；需要扫描完整性时用 `readPrivateMessageHistory`。 */
  getPrivateMessages(me: IdentityProfile, peer: IdentityProfile): Promise<PrivateMessage[]>;
}

const MessageSent = bcs.struct('MessageSent', {
  sender: bcs.Address,
  recipient: bcs.Address,
  ciphertext: bcs.vector(bcs.u8()),
  nonce: bcs.vector(bcs.u8()),
  ephemeral_public_key: bcs.vector(bcs.u8()),
  recipient_key: bcs.vector(bcs.u8()),
});
const requestSignal = () => AbortSignal.timeout(20_000);

export function createPrivateMessaging(options: PrivateMessagingOptions): PrivateMessaging {
  const tr = options.translate ?? bridgeT;
  const identityModule = `${isValidSuiAddress(options.config.packageId) ? normalizeSuiAddress(options.config.packageId) : options.config.packageId}::identity`;
  const configured = options.isConfigured ?? (() => isValidIdentityConfig(options.config));
  let client: IdentityClient | null = null;
  const getIdentity = async (id: string): Promise<IdentityProfile> => {
    if (options.getIdentity) return options.getIdentity(id);
    client ??= new IdentityClient(options.rpc, options.config);
    return client.getIdentity(id);
  };

  const keyId = (profile: IdentityProfile, key: Uint8Array): string => `${identityModule}:${profile.id}:${toBase64(key)}`;

  async function hasMessagingKey(profile: IdentityProfile): Promise<boolean> {
    if (!profile.encryptionKey.length) return false;
    return !!(await options.keys.read(keyId(profile, new Uint8Array(profile.encryptionKey))));
  }

  async function enablePrivateMessages(profile: IdentityProfile): Promise<void> {
    if (await hasMessagingKey(profile)) return;
    // 被拒绝/重试后复用未发布的 pending 密钥；保留历史已发布密钥以解密旧消息。
    const pendingId = `${identityModule}:${profile.id}:pending`;
    const pending = await options.keys.read(pendingId);
    const pair = pending?.pair ?? (await generateMessageKey());
    if (!pending) await options.keys.save({ id: pendingId, pair });
    const key = await publicKeyBytes(pair.publicKey);
    await options.keys.save({ id: keyId(profile, key), pair });
    await options.execute(buildSetEncryptionKey(options.config, profile.id, key), profile);
  }

  async function sendPrivateMessage(sender: IdentityProfile, recipient: IdentityProfile, text: string): Promise<void> {
    const [liveSender, liveRecipient] = await Promise.all([getIdentity(sender.id), getIdentity(recipient.id)]);
    if (!(await hasMessagingKey(liveSender))) throw new Error(tr('misc.dmLib.enableFirst'));
    if (!liveRecipient.encryptionKey.length) throw new Error(tr('misc.dmLib.peerNotEnabled'));
    if (liveSender.id === liveRecipient.id) throw new Error(tr('misc.dmLib.pickOther'));
    const encrypted = await sealMessage(text, new Uint8Array(liveSender.encryptionKey), new Uint8Array(liveRecipient.encryptionKey), { senderId: liveSender.id, recipientId: liveRecipient.id });
    await options.execute(
      buildSendMessage(options.config, liveSender.id, {
        recipientId: liveRecipient.id,
        ciphertext: encrypted.ciphertext,
        nonce: encrypted.nonce,
        ephemeralPublicKey: encrypted.ephemeralKey,
        expectedRecipientKey: Uint8Array.from(liveRecipient.encryptionKey),
      }),
      liveSender,
    );
  }

  async function listPrivateConversations(
    me: IdentityProfile,
    scan: { maxPages?: number; pageSize?: number; resolveProfile?: (id: string) => Promise<IdentityProfile> } = {},
  ): Promise<PrivateConversationList> {
    if (!configured()) throw new Error(tr('misc.dmLib.identityNotConfiguredInbox'));
    const maxPages = scan.maxPages ?? 10;
    const pageSize = scan.pageSize ?? 50;
    if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 20 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50) throw new Error(tr('misc.dmLib.inboxRangeInvalid'));

    const eventType = `${identityModule}::MessageSent`;
    const events: SuiClientTypes.EventEntry[] = [];
    const cursors = new Set<string>();
    let before: string | null = null;
    let truncated = false;
    for (let pageIndex = 0; pageIndex < maxPages; pageIndex++) {
      const page = await options.rpc.listEvents({ filter: { eventType }, before, limit: pageSize, order: 'descending', signal: requestSignal() });
      for (const event of page.events) if (normalizeStructTag(event.eventType) === normalizeStructTag(eventType)) events.push(event);
      if (!page.hasNextPage) break;
      if (!page.endCursor || cursors.has(page.endCursor) || page.endCursor === before) throw new Error(tr('misc.dmLib.inboxPageStuck'));
      if (pageIndex === maxPages - 1) {
        truncated = true;
        break;
      }
      cursors.add(page.endCursor);
      before = page.endCursor;
    }

    const profileCache = new Map<string, IdentityProfile>();
    const resolveProfile = scan.resolveProfile ?? getIdentity;
    const timestampCache = new Map<string, number>();
    const conversations = new Map<string, PrivateConversation>();
    const failures: Array<{ senderId: string; reason: string }> = [];
    const seen = new Set<string>();
    for (const event of events) {
      const raw = MessageSent.parse(event.bcs);
      if (raw.recipient !== me.id) continue;
      const id = `${event.transactionDigest}:${event.eventIndex}`;
      if (seen.has(id)) continue;
      seen.add(id);

      let peer = profileCache.get(raw.sender);
      if (!peer) {
        try {
          peer = await resolveProfile(raw.sender);
          if (peer.id !== raw.sender || normalizeSuiAddress(event.sender) !== normalizeSuiAddress(peer.address)) throw new Error(tr('misc.dmLib.senderMismatch'));
          profileCache.set(raw.sender, peer);
        } catch (error) {
          // 按文案分类（zh SDK 文案 + en 孪生）：发送方不匹配必须上抛，其余降级为失败行。
          const message = error instanceof Error ? error.message : '';
          if (message.includes('发送方与身份所有者') || message.includes('identity owner')) throw error;
          failures.push({ senderId: raw.sender, reason: error instanceof Error ? error.message : tr('misc.dmLib.senderUnreadable') });
          continue;
        }
      } else if (normalizeSuiAddress(event.sender) !== normalizeSuiAddress(peer.address)) {
        throw new Error(tr('misc.dmLib.senderMismatch'));
      }

      if (!timestampCache.has(event.transactionDigest)) {
        const transaction = await options.rpc.getTransaction({ digest: event.transactionDigest, signal: requestSignal() });
        if (transaction.$kind === 'FailedTransaction' || !transaction.Transaction.status.success) throw new Error(tr('misc.dmLib.txInvalid'));
        const timestamp = transaction.Transaction.timestampMs;
        if (timestamp === null || !Number.isSafeInteger(timestamp) || timestamp < 0) throw new Error(tr('misc.dmLib.txTimeMissing'));
        timestampCache.set(event.transactionDigest, timestamp);
      }

      const message: PrivateMessage = { id, senderId: raw.sender, recipientId: raw.recipient, text: null, timestampMs: timestampCache.get(event.transactionDigest)! };
      try {
        const ciphertext = new Uint8Array(raw.ciphertext);
        const envelope = readEnvelope(ciphertext);
        if (envelope.recipientKey !== toBase64(new Uint8Array(raw.recipient_key))) throw new Error(tr('misc.dmLib.recipientKeyMismatch'));
        const key = await options.keys.read(`${identityModule}:${me.id}:${envelope.recipientKey}`);
        if (!key) throw new Error(tr('misc.dmLib.noKey'));
        message.text = await openMessage({ ciphertext, nonce: new Uint8Array(raw.nonce), ephemeralKey: new Uint8Array(raw.ephemeral_public_key) }, key.pair.privateKey, { senderId: message.senderId, recipientId: message.recipientId }, 'to');
      } catch (error) {
        message.unavailableReason = error instanceof Error ? error.message : tr('misc.dmLib.undecryptable');
      }

      const current = conversations.get(peer.id);
      if (!current || current.lastMessage === null || message.timestampMs > current.lastMessage.timestampMs || (message.timestampMs === current.lastMessage.timestampMs && message.id > current.lastMessage.id)) {
        conversations.set(peer.id, { peer, lastMessage: message, messageCount: (current?.messageCount ?? 0) + 1 });
      } else {
        conversations.set(peer.id, { ...current, messageCount: current.messageCount + 1 });
      }
    }

    return {
      conversations: [...conversations.values()].sort((a, b) => {
        const aTime = a.lastMessage?.timestampMs ?? -1;
        const bTime = b.lastMessage?.timestampMs ?? -1;
        return bTime - aTime || a.peer.id.localeCompare(b.peer.id);
      }),
      scannedEvents: events.length,
      truncated,
      failures,
    };
  }

  async function readPrivateMessageHistory(me: IdentityProfile, peer: IdentityProfile, scan: PrivateMessageHistoryOptions = {}): Promise<PrivateMessageHistory> {
    if (!configured()) throw new Error(tr('misc.dmLib.identityNotConfiguredHistory'));
    const maxPages = scan.maxPages ?? 10;
    const pageSize = scan.pageSize ?? 50;
    if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 20 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50) throw new Error(tr('misc.dmLib.historyRangeInvalid'));
    // 查询已认证发送方的流；合约保证每个 Name 地址绑定。
    const senderAddresses = [me.address, peer.address].filter((value, index, all) => all.findIndex(other => normalizeSuiAddress(other) === normalizeSuiAddress(value)) === index);
    const streams = await Promise.all(senderAddresses.map(async sender => {
      const events: SuiClientTypes.EventEntry[] = [];
      const cursors = new Set<string>();
      let before: string | null = null;
      let truncated = false;
      for (let pageIndex = 0; pageIndex < maxPages; pageIndex++) {
        const page = await options.rpc.listEvents({ filter: { sender }, before, limit: pageSize, order: 'descending', signal: requestSignal() });
        events.push(...page.events);
        if (!page.hasNextPage) break;
        if (!page.endCursor || cursors.has(page.endCursor) || page.endCursor === before) throw new Error(tr('misc.dmLib.historyPageStuck'));
        if (pageIndex === maxPages - 1) {
          truncated = true;
          break;
        }
        cursors.add(page.endCursor);
        before = page.endCursor;
      }
      return { events, truncated };
    }));
    const result: PrivateMessage[] = [];
    const seen = new Map<string, SuiClientTypes.EventEntry>();
    const timestamps = new Map<string, number>();
    for (const event of streams.flatMap(stream => stream.events)) {
      if (normalizeStructTag(event.eventType) !== normalizeStructTag(`${identityModule}::MessageSent`)) continue;
      const raw = MessageSent.parse(event.bcs);
      if (!((normalizeSuiAddress(raw.sender) === normalizeSuiAddress(me.id) && normalizeSuiAddress(raw.recipient) === normalizeSuiAddress(peer.id)) || (normalizeSuiAddress(raw.sender) === normalizeSuiAddress(peer.id) && normalizeSuiAddress(raw.recipient) === normalizeSuiAddress(me.id)))) continue;
      const isOutgoing = raw.sender === me.id;
      if (normalizeSuiAddress(event.sender) !== normalizeSuiAddress(isOutgoing ? me.address : peer.address)) throw new Error(tr('misc.dmLib.senderMismatch'));
      const id = `${event.transactionDigest}:${event.eventIndex}`;
      const previous = seen.get(id);
      if (previous) {
        if (previous.bcs.length !== event.bcs.length || previous.bcs.some((value, index) => value !== event.bcs[index]) || normalizeSuiAddress(previous.sender) !== normalizeSuiAddress(event.sender)) throw new Error(tr('misc.dmLib.conflict'));
        continue;
      }
      seen.set(id, event);
      if (!timestamps.has(event.transactionDigest)) {
        const transaction = await options.rpc.getTransaction({ digest: event.transactionDigest, signal: requestSignal() });
        if (transaction.$kind === 'FailedTransaction' || !transaction.Transaction.status.success) throw new Error(tr('misc.dmLib.txInvalid'));
        const timestamp = transaction.Transaction.timestampMs;
        if (timestamp === null || !Number.isSafeInteger(timestamp) || timestamp < 0) throw new Error(tr('misc.dmLib.txTimeMissing'));
        timestamps.set(event.transactionDigest, timestamp);
      }
      const message: PrivateMessage = { id, senderId: raw.sender, recipientId: raw.recipient, text: null, timestampMs: timestamps.get(event.transactionDigest)! };
      try {
        const ciphertext = new Uint8Array(raw.ciphertext);
        const envelope = readEnvelope(ciphertext);
        const publicKey = isOutgoing ? envelope.senderKey : envelope.recipientKey;
        if (!isOutgoing && publicKey !== toBase64(new Uint8Array(raw.recipient_key))) throw new Error(tr('misc.dmLib.recipientKeyMismatch'));
        const key = await options.keys.read(`${identityModule}:${me.id}:${publicKey}`);
        if (!key) throw new Error(tr('misc.dmLib.noKey'));
        message.text = await openMessage({ ciphertext, nonce: new Uint8Array(raw.nonce), ephemeralKey: new Uint8Array(raw.ephemeral_public_key) }, key.pair.privateKey, { senderId: message.senderId, recipientId: message.recipientId }, isOutgoing ? 'from' : 'to');
      } catch (error) {
        message.unavailableReason = error instanceof Error ? error.message : tr('misc.dmLib.undecryptable');
      }
      result.push(message);
    }
    return {
      messages: result.sort((a, b) => a.timestampMs - b.timestampMs || a.id.localeCompare(b.id)),
      truncated: streams.some(stream => stream.truncated),
      scannedEvents: streams.reduce((total, stream) => total + stream.events.length, 0),
    };
  }

  async function getPrivateMessages(me: IdentityProfile, peer: IdentityProfile): Promise<PrivateMessage[]> {
    return (await readPrivateMessageHistory(me, peer)).messages;
  }

  return { hasMessagingKey, enablePrivateMessages, sendPrivateMessage, listPrivateConversations, readPrivateMessageHistory, getPrivateMessages };
}
