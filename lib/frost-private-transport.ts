"use client"

/**
 * FROST 私信传输的前端薄壳。
 *
 * 编码/解码与 list/send 校验全部在 `multisig/bridge`；本文件只把前端默认
 * 依赖（链上身份读取、私信收发、钱包验签、env 配置）注入 SDK 工厂。
 */
import { createFrostDmTransport, decodeFrostPrivateRound, encodeFrostPrivateRound, FROST_PRIVATE_MESSAGE_MAX_BYTES } from "multisig/bridge"
import type { CompactFrostRound, FrostPeerHistory, FrostPrivateRound } from "multisig/bridge"
import { getIdentity, identityConfigured, type IdentityProfile } from "./identity-client"
import { readPrivateMessageHistory, sendPrivateMessage, type PrivateMessageHistory } from "./private-messages"
import { verifyProtocolMessage } from "./wallet-personal-signing"
import "./bridge-locale"

export { decodeFrostPrivateRound, encodeFrostPrivateRound, FROST_PRIVATE_MESSAGE_MAX_BYTES }
export type { CompactFrostRound, FrostPeerHistory, FrostPrivateRound }

export interface FrostPrivateTransportOptions {
  resolveIdentity?: (id: string) => Promise<IdentityProfile>
  sendMessage?: (sender: IdentityProfile, recipient: IdentityProfile, text: string) => Promise<void>
  readHistory?: (me: IdentityProfile, peer: IdentityProfile) => Promise<PrivateMessageHistory>
  isConfigured?: () => boolean
  verify?: (bytes: Uint8Array, signature: string, address: string) => Promise<void>
}

export function createFrostPrivateTransport(options: FrostPrivateTransportOptions = {}) {
  return createFrostDmTransport({
    messaging: {
      sendPrivateMessage: options.sendMessage ?? sendPrivateMessage,
      readPrivateMessageHistory: options.readHistory ?? readPrivateMessageHistory,
    },
    resolveIdentity: options.resolveIdentity ?? getIdentity,
    verify: options.verify ?? verifyProtocolMessage,
    isConfigured: options.isConfigured ?? identityConfigured,
  })
}

export const frostPrivateTransport = createFrostPrivateTransport()
