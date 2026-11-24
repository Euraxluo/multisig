/**
 * `multisig/bridge`：agent_vault（FROST 会话）与 identity（加密私信）之间的桥。
 *
 * 宿主应用负责注入三类环境能力：设备密钥库（`DeviceVault`）、会话存储
 * （`FrostSessionStore`，生产环境须满足事务语义）、以及钱包签名执行函数
 * （`PrivateMessagingOptions.execute` / `FrostDmTransportOptions.verify`）。
 */
export { BRIDGE_DEFAULT_MESSAGES, bridgeT, configureBridgeLocale } from './messages';
export type { BridgeTranslate, BridgeTranslateParams } from './messages';

export type { DeviceVault, SealedSecretBox } from './device-vault';

export {
  consumeNonceRecord,
  createMemoryFrostSessionStore,
  mergeSessionRecord,
  prepareNonceRecord,
  publishRound1Record,
  withRound2Share,
} from './session-store';
export type {
  BurnedFrostNonce,
  FrostNonceConsumption,
  FrostNonceMaterial,
  FrostNonceRecord,
  FrostSessionRecord,
  FrostSessionStore,
} from './session-store';

export {
  assembleDeviceKey,
  DEVICE_KEY_NETWORK,
  deviceKeyAddress,
  parsePublicKeyPackage,
  publicKeyPackageId,
  serializePublicKeyPackage,
  toNobleFrostPublic,
  toPublicKeyPackage,
  validateDealerContribution,
  validateDeviceKeyPackage,
  validateKeyEpoch,
  validatePublicKeyPackage,
} from './key-package';
export type { BoundDeviceKey, DealerContribution, DeviceKeyPackage, PublicKeyPackage } from './key-package';

export { fromBase64, generateMessageKey, MAX_MESSAGE_BYTES, openMessage, publicKeyBytes, readEnvelope, sealMessage, toBase64 } from './message-crypto';
export type { MessageContext, MessageEnvelope, SealedMessage } from './message-crypto';

export {
  aggregateFrostSession,
  aggregateFrostSessionForReceiptRecovery,
  createFrostRequest,
  createFrostTranscript,
  frostProtocolMessage,
  FrostSessionError,
  parseFrostRequest,
  prepareFrostCommitment,
  produceFrostShare,
  verifyFrostRequest,
  verifyFrostRound1,
  verifyFrostRound2,
  verifyFrostTranscript,
} from './frost-session';
export type {
  FrostAction,
  FrostPublicKeyPackage,
  FrostRequest,
  FrostRound1,
  FrostRound2,
  FrostSigningResult,
  FrostSigner,
  FrostTranscript,
  ProtocolAuth,
} from './frost-session';

export { createPrivateMessaging } from './private-messages';
export type {
  MessageKeyStore,
  PrivateConversation,
  PrivateConversationList,
  PrivateMessage,
  PrivateMessageHistory,
  PrivateMessageHistoryOptions,
  PrivateMessaging,
  PrivateMessagingOptions,
  StoredMessageKey,
} from './private-messages';

export { createFrostDmTransport, decodeFrostPrivateRound, encodeFrostPrivateRound, FROST_PRIVATE_MESSAGE_MAX_BYTES } from './dm-transport';
export type { CompactFrostRound, FrostDmMessaging, FrostDmTransportOptions, FrostPeerHistory, FrostPrivateRound } from './dm-transport';
