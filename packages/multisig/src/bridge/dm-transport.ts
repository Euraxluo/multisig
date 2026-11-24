/**
 * FROST-over-identity-DM 传输层。
 *
 * 链上身份事件认证发送方，round 自身的 FROST 签名作为第二道协议认证边界，
 * 收到的 round 可原样回灌 transcript/aggregate 门禁。编码格式与前端实现
 * 逐字节一致（前缀 `sui-frost-round-v1:` + 7 元 JSON 元组）。
 */
import type { IdentityProfile } from '../namespace/identity';
import type { PrivateMessageHistory } from './private-messages';
import {
  verifyFrostRequest,
  verifyFrostRound1,
  verifyFrostRound2,
  verifyFrostTranscript,
  type FrostRequest,
  type FrostRound1,
  type FrostRound2,
  type FrostTranscript,
  type ProtocolAuth,
} from './frost-session';
import { bridgeT, type BridgeTranslate } from './messages';

const PREFIX = 'sui-frost-round-v1:';
const encoder = new TextEncoder();
export const FROST_PRIVATE_MESSAGE_MAX_BYTES = 1000;
export type FrostPrivateRound = FrostRound1 | FrostRound2;
export interface CompactFrostRound {
  round: FrostPrivateRound;
  authenticatedAddress: string;
}
export interface FrostPeerHistory {
  peerId: string;
  rounds: CompactFrostRound[];
  truncated: boolean;
  scannedEvents: number;
  unavailableReason?: string;
}

/** 传输只依赖私信管线这两个入口；宿主可用任意 `PrivateMessaging` 实例满足。 */
export interface FrostDmMessaging {
  sendPrivateMessage(sender: IdentityProfile, recipient: IdentityProfile, text: string): Promise<void>;
  readPrivateMessageHistory(me: IdentityProfile, peer: IdentityProfile): Promise<PrivateMessageHistory>;
}

export interface FrostDmTransportOptions {
  messaging: FrostDmMessaging;
  /** 链上身份解析；用于认证每条消息的发送方地址。 */
  resolveIdentity: (id: string) => Promise<IdentityProfile>;
  verify: ProtocolAuth['verify'];
  /** 身份协议是否已配置；默认视为已配置。 */
  isConfigured?: () => boolean;
  translate?: BridgeTranslate;
}

function hex(value: unknown): value is string {
  return typeof value === 'string' && /^(?:[0-9a-f]{2})+$/.test(value);
}
function canonicalAddress(value: unknown): value is string {
  return typeof value === 'string' && /^0x[0-9a-f]{64}$/.test(value);
}

export function encodeFrostPrivateRound(round: FrostPrivateRound, translate: BridgeTranslate = bridgeT): string {
  let tuple: unknown[];
  if (round.version !== 1 || !/^[0-9a-f]{64}$/.test(round.requestId) || !/^[0-9a-f]{64}$/.test(round.contextHash) || !/^(0|[1-9]\d*)$/.test(round.index) || !canonicalAddress(round.address) || typeof round.signature !== 'string' || !round.signature) throw new Error('FROST compact DM requires a canonical signed round envelope.');
  if ('hiding' in round) {
    if (!hex(round.hiding) || !hex(round.binding) || round.hiding.length !== 64 || round.binding.length !== 64) throw new Error('Invalid compact FROST commitment points.');
    tuple = [1, round.requestId, round.contextHash, round.index, round.hiding, round.binding, round.signature];
  } else {
    if (!/^[0-9a-f]{64}$/.test(round.transcriptHash) || !hex(round.scalar)) throw new Error('Invalid compact FROST signature share.');
    tuple = [2, round.requestId, round.contextHash, round.transcriptHash, round.index, round.scalar, round.signature];
  }
  const text = PREFIX + JSON.stringify(tuple);
  if (encoder.encode(text).length > FROST_PRIVATE_MESSAGE_MAX_BYTES) throw new Error(translate('dkg.dmTooLong'));
  return text;
}

export function decodeFrostPrivateRound(text: string, authenticatedAddress: string, translate: BridgeTranslate = bridgeT): CompactFrostRound {
  if (typeof text !== 'string' || encoder.encode(text).length > FROST_PRIVATE_MESSAGE_MAX_BYTES || !canonicalAddress(authenticatedAddress) || !text.startsWith(PREFIX)) throw new Error(translate('dkg.dmInvalid'));
  let v: unknown;
  try {
    v = JSON.parse(text.slice(PREFIX.length));
  } catch {
    throw new Error(translate('dkg.invalidRoundJson'));
  }
  if (!Array.isArray(v)) throw new Error(translate('dkg.invalidRoundShape'));
  let round: FrostPrivateRound;
  if (v.length === 7 && v[0] === 1 && v.slice(1).every(x => typeof x === 'string')) {
    const [, requestId, contextHash, index, hiding, binding, signature] = v as string[];
    round = { version: 1, requestId, contextHash, address: authenticatedAddress, index, hiding, binding, signature };
    // 重新编码拒绝空白、额外 JSON 形式与非规范数据。
    if (encodeFrostPrivateRound(round, translate) !== text) throw new Error('FROST compact round is not canonical.');
  } else if (v.length === 7 && v[0] === 2 && v.slice(1).every(x => typeof x === 'string')) {
    const [, requestId, contextHash, transcriptHash, index, scalar, signature] = v as string[];
    round = { version: 1, requestId, contextHash, transcriptHash, address: authenticatedAddress, index, scalar, signature };
    if (encodeFrostPrivateRound(round, translate) !== text) throw new Error('FROST compact round is not canonical.');
  } else throw new Error('Unsupported or malformed FROST compact round.');
  return { round, authenticatedAddress };
}

export function createFrostDmTransport(options: FrostDmTransportOptions) {
  const tr = options.translate ?? bridgeT;
  const isConfigured = options.isConfigured ?? (() => true);
  const { messaging, resolveIdentity, verify } = options;

  async function list(input: { request: FrostRequest; transcript?: FrostTranscript; me: IdentityProfile; peers: IdentityProfile[] }): Promise<FrostPeerHistory[]> {
    if (!isConfigured()) return input.peers.map(peer => ({ peerId: peer.id, rounds: [], truncated: false, scannedEvents: 0, unavailableReason: tr('dkg.identityNotConfigured') }));
    await verifyFrostRequest(input.request, verify);
    if (input.transcript) await verifyFrostTranscript(input.request, input.transcript, verify);
    return Promise.all(
      input.peers.map(async peer => {
        let history: PrivateMessageHistory | undefined;
        try {
          history = await messaging.readPrivateMessageHistory(input.me, peer);
          const rounds: CompactFrostRound[] = [];
          for (const message of history.messages) {
            if (message.unavailableReason) throw new Error(tr('dkg.dmReadFailed', { reason: message.unavailableReason }));
            if (!message.text?.startsWith(PREFIX)) continue;
            const outgoing = message.senderId === input.me.id && message.recipientId === peer.id;
            const incoming = message.senderId === peer.id && message.recipientId === input.me.id;
            if (!outgoing && !incoming) throw new Error(tr('dkg.notInConversation'));
            const authenticatedProfile = await resolveIdentity(message.senderId);
            const expectedAddress = outgoing ? input.me.address : peer.address;
            if (authenticatedProfile.id !== message.senderId || authenticatedProfile.address.toLowerCase() !== expectedAddress.toLowerCase()) throw new Error(tr('dkg.senderMismatch'));
            const decoded = decodeFrostPrivateRound(message.text, authenticatedProfile.address, tr);
            if (decoded.round.requestId !== input.request.requestId || decoded.round.contextHash !== input.request.contextHash) continue;
            const allowed = input.request.signers.find(s => s.index === decoded.round.index);
            if (!allowed || allowed.address.toLowerCase() !== decoded.authenticatedAddress.toLowerCase()) throw new Error(tr('dkg.roundIdentityMismatch'));
            if ('hiding' in decoded.round) await verifyFrostRound1(input.request, decoded.round, verify);
            else {
              if (!input.transcript) throw new Error(tr('dkg.transcriptMissingVerify'));
              await verifyFrostRound2(input.request, input.transcript, decoded.round, verify);
            }
            const prior = rounds.find(r => r.round.index === decoded.round.index && 'hiding' in r.round === 'hiding' in decoded.round);
            if (prior) {
              if (JSON.stringify(prior.round) !== JSON.stringify(decoded.round)) throw new Error(tr('dkg.roundConflict'));
              continue;
            }
            rounds.push(decoded);
          }
          return { peerId: peer.id, rounds, truncated: history.truncated, scannedEvents: history.scannedEvents };
        } catch (error) {
          return { peerId: peer.id, rounds: [], truncated: history?.truncated ?? false, scannedEvents: history?.scannedEvents ?? 0, unavailableReason: error instanceof Error ? error.message : tr('dkg.dmUnavailable') };
        }
      }),
    );
  }

  async function send(input: { request: FrostRequest; round: FrostPrivateRound; transcript?: FrostTranscript; sender: IdentityProfile; recipient: IdentityProfile; userClickConfirmed: true }): Promise<void> {
    if (input.userClickConfirmed !== true) throw new Error(tr('dkg.clickRequired'));
    if (!isConfigured()) throw new Error(tr('dkg.identityNotConfiguredSend'));
    await verifyFrostRequest(input.request, verify);
    const allowed = input.request.signers.find(s => s.index === input.round.index);
    if (!allowed || allowed.address.toLowerCase() !== input.sender.address.toLowerCase() || input.round.requestId !== input.request.requestId || input.round.contextHash !== input.request.contextHash) throw new Error(tr('dkg.roundRequestMismatch'));
    if ('hiding' in input.round) await verifyFrostRound1(input.request, input.round, verify);
    else {
      if (!input.transcript) throw new Error(tr('dkg.transcriptMissingSend'));
      await verifyFrostTranscript(input.request, input.transcript, verify);
      await verifyFrostRound2(input.request, input.transcript, input.round, verify);
    }
    const wireRound = { ...input.round } as FrostPrivateRound;
    const text = encodeFrostPrivateRound(wireRound, tr);
    await messaging.sendPrivateMessage(input.sender, input.recipient, text);
  }

  return { list, send };
}
