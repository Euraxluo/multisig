/**
 * 私信信封加密的前端入口：实现位于 `multisig/bridge`（单一事实源）。
 */
export { fromBase64, generateMessageKey, MAX_MESSAGE_BYTES, openMessage, publicKeyBytes, readEnvelope, sealMessage, toBase64 } from "multisig/bridge"
export type { MessageContext, MessageEnvelope, SealedMessage } from "multisig/bridge"
