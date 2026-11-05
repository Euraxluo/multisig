"use client"

import { SuiGrpcClient } from "@mysten/sui/grpc"
import type { Transaction } from "@mysten/sui/transactions"
import { isValidSuiAddress, normalizeSuiAddress } from "@mysten/sui/utils"
import {
  IdentityClient,
  buildFollowName,
  buildMintName,
  buildRenameName,
  buildSendMessage,
  buildSetEncryptionKey,
  buildSetProfile,
  buildUnfollowName,
  buildWithdrawToAddress,
  type IdentityProfile,
  type IdentityRpc,
  type ReceivedObject,
} from "multisig/namespace"
import { resolveSuiNSName, suiNamesClient, suinsClient } from "./suins"
import { getActiveAccount } from "./onchain-store"
import { signAndExecuteWithWallet } from "./sui-wallet-signer"
import { t } from "./i18n/t"

// 读取、投影与 PTB 构造全部住在 multisig/namespace；本文件只保留前端
// 耦合：env 配置、gRPC 单例（测试通过 mock.method 拦截它）、钱包签名
// 与身份更新事件。
export type { FollowerList, FollowRelationship, IdentityProfile, ReceivedObject, ResolvedRecipient, ResolvedRecipientKind } from "multisig/namespace"
export { describeRecipientRoute, followRelationship, normalizeProtocolName } from "multisig/namespace"

export const identityRpc = new SuiGrpcClient({ baseUrl: "https://fullnode.testnet.sui.io:443", network: "testnet" })
const packageId = process.env.NEXT_PUBLIC_IDENTITY_PACKAGE_ID ?? ""
const namesId = process.env.NEXT_PUBLIC_IDENTITY_NAMES_ID ?? ""
export const identityModule = `${isValidSuiAddress(packageId) ? normalizeSuiAddress(packageId) : packageId}::identity`

export function identityConfigured(): boolean {
  return isValidSuiAddress(packageId) && isValidSuiAddress(namesId)
}

function requireConfig() {
  if (!identityConfigured()) throw new Error(t("misc.identity.notConfigured"))
}

function namespaceConfig() {
  requireConfig()
  return { packageId: normalizeSuiAddress(packageId), namesId: normalizeSuiAddress(namesId) }
}

let cachedNamespace: IdentityClient | null = null
function namespace(): IdentityClient {
  const config = namespaceConfig()
  cachedNamespace ??= new IdentityClient(identityRpc as unknown as IdentityRpc, {
    ...config,
    suins: suiNamesClient.core,
    suinsRecordSource: { getNameRecord: (name: string) => suinsClient.getNameRecord(name) },
  })
  return cachedNamespace
}

export async function getIdentity(id: string): Promise<IdentityProfile> { return namespace().getIdentity(id) }
export async function getIdentityByAddress(address: string): Promise<IdentityProfile | null> { return namespace().getIdentityByAddress(address) }
export async function resolveRecipient(input: string) { return namespace().resolveRecipient(input) }
export async function getFollowing(profile: IdentityProfile) { return namespace().getFollowing(profile) }
export async function getFollowingIds(profile: IdentityProfile) { return namespace().getFollowingIds(profile) }
export async function isFollowing(profile: IdentityProfile, targetId: string) { return namespace().isFollowing(profile, targetId) }
export async function getFollowers(profile: IdentityProfile, options: Parameters<IdentityClient["getFollowers"]>[1] = {}) {
  return namespace().getFollowers(profile, options)
}
export async function getReceivedObjects(profile: IdentityProfile) { return namespace().getReceivedObjects(profile) }
export async function waitForIdentityTransaction(digest: string): Promise<void> { return namespace().waitForTransaction(digest) }

function requireActive(profile?: IdentityProfile) {
  const active = getActiveAccount()
  if (!active || !isValidSuiAddress(active.address)) throw new Error(t("misc.identity.connectFirst"))
  if (profile && normalizeSuiAddress(active.address) !== profile.address) throw new Error(t("misc.identity.accountSwitched"))
  return normalizeSuiAddress(active.address)
}

async function submit(tx: Transaction, profile?: IdentityProfile): Promise<void> {
  requireConfig()
  tx.setSender(requireActive(profile))
  const { digest } = await signAndExecuteWithWallet(tx)
  await waitForIdentityTransaction(digest)
  window.dispatchEvent(new Event("sui-identity-updated"))
}

/** SDK 构造器返回其自身 @mysten/sui 版本的 Transaction；跨界后由前端签名。 */
const cross = (tx: unknown): Transaction => tx as Transaction

export async function mintIdentity(label: string): Promise<void> {
  await submit(cross(buildMintName(namespaceConfig(), label)))
}

export async function renameIdentity(profile: IdentityProfile, label: string): Promise<void> {
  await submit(cross(buildRenameName(namespaceConfig(), profile.id, label)), profile)
}

export async function updateProfile(profile: IdentityProfile, displayName: string, avatarUrl: string): Promise<void> {
  await submit(cross(buildSetProfile(namespaceConfig(), profile.id, { displayName, avatarUrl })), profile)
}

export async function setEncryptionKey(profile: IdentityProfile, key: Uint8Array): Promise<void> {
  await submit(cross(buildSetEncryptionKey(namespaceConfig(), profile.id, key)), profile)
}

export async function followIdentity(profile: IdentityProfile, target: IdentityProfile): Promise<void> {
  await submit(cross(buildFollowName(namespaceConfig(), profile.id, target.id)), profile)
}

export async function unfollowIdentity(profile: IdentityProfile, target: IdentityProfile): Promise<void> {
  await submit(cross(buildUnfollowName(namespaceConfig(), profile.id, target.id)), profile)
}

export async function withdrawObject(profile: IdentityProfile, object: ReceivedObject, recipient: string): Promise<void> {
  const resolved = await resolveRecipient(recipient)
  if (resolved.kind === "protocol") throw new Error(t("misc.identity.protocolTargetInvalid"))
  await submit(cross(buildWithdrawToAddress(namespaceConfig(), profile.id, object, resolved.address)), profile)
}

export async function submitPrivateMessage(profile: IdentityProfile, recipient: IdentityProfile, ciphertext: Uint8Array, nonce: Uint8Array, ephemeralKey: Uint8Array): Promise<void> {
  await submit(cross(buildSendMessage(namespaceConfig(), profile.id, {
    recipientId: recipient.id, ciphertext, nonce, ephemeralPublicKey: ephemeralKey, expectedRecipientKey: Uint8Array.from(recipient.encryptionKey),
  })), profile)
}

export { resolveSuiNSName }
