/**
 * 前端薄壳：FROST 会话协议本体位于 `multisig/bridge`。
 *
 * 本文件只做两件事：
 * 1. 把应用 i18n（`t`，按调用时 locale 求值）注入桥接层；
 * 2. 为缺省调用注入 IndexedDB 会话存储与设备密钥库。
 */
import {
  aggregateFrostSession,
  aggregateFrostSessionForReceiptRecovery,
  configureBridgeLocale,
  createFrostRequest,
  createFrostTranscript as sdkCreateFrostTranscript,
  frostProtocolMessage,
  FrostSessionError,
  parseFrostRequest,
  prepareFrostCommitment as sdkPrepareFrostCommitment,
  produceFrostShare as sdkProduceFrostShare,
  verifyFrostRequest,
  verifyFrostRound1,
  verifyFrostRound2,
  verifyFrostTranscript,
  type BoundDeviceKey,
  type DeviceKeyPackage,
  type FrostAction,
  type FrostPublicKeyPackage,
  type FrostRequest,
  type FrostRound1,
  type FrostRound2,
  type FrostSigner,
  type FrostSigningResult,
  type FrostSessionStore,
  type FrostTranscript,
  type ProtocolAuth,
} from "multisig/bridge"
import { t } from "@/lib/i18n/t"
import { defaultDeviceVault, type DeviceVault } from "./crypto/device-vault"
import { defaultFrostSessionStore } from "./frost-session-store"

configureBridgeLocale(t)

export {
  aggregateFrostSession,
  aggregateFrostSessionForReceiptRecovery,
  createFrostRequest,
  frostProtocolMessage,
  FrostSessionError,
  parseFrostRequest,
  verifyFrostRequest,
  verifyFrostRound1,
  verifyFrostRound2,
  verifyFrostTranscript,
}
export type {
  BoundDeviceKey,
  DeviceKeyPackage,
  FrostAction,
  FrostPublicKeyPackage,
  FrostRequest,
  FrostRound1,
  FrostRound2,
  FrostSigner,
  FrostSigningResult,
  FrostSessionStore,
  FrostTranscript,
  ProtocolAuth,
}

export async function prepareFrostCommitment(
  request: FrostRequest,
  key: BoundDeviceKey,
  options: { store?: FrostSessionStore; vault?: DeviceVault; auth: ProtocolAuth },
): Promise<FrostRound1> {
  return sdkPrepareFrostCommitment(request, key, {
    store: options.store ?? defaultFrostSessionStore,
    vault: options.vault ?? defaultDeviceVault,
    auth: options.auth,
  })
}

export async function createFrostTranscript(
  request: FrostRequest,
  round1: FrostRound1[],
  auth: ProtocolAuth,
  store: FrostSessionStore = defaultFrostSessionStore,
): Promise<FrostTranscript> {
  return sdkCreateFrostTranscript(request, round1, auth, store)
}

export async function produceFrostShare(
  request: FrostRequest,
  transcript: FrostTranscript,
  key: BoundDeviceKey,
  options: { store?: FrostSessionStore; vault?: DeviceVault; auth: ProtocolAuth },
): Promise<FrostRound2> {
  return sdkProduceFrostShare(request, transcript, key, {
    store: options.store ?? defaultFrostSessionStore,
    vault: options.vault ?? defaultDeviceVault,
    auth: options.auth,
  })
}
