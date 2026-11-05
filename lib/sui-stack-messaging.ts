"use client"

// Official Sui Stack Messaging (Beta) integration.
//
// This is an additional chat transport beside the existing `onchain_chat`
// channel. It is not a replacement: messages here are encrypted client-side
// with Seal, delivered through an off-chain relayer, and never written on
// chain. The only on-chain facts are the `PermissionedGroup<Messaging>` and
// its `EncryptionHistory` key versions.
//
// Consequences the UI must state plainly:
// - a relayer must be operated for this path to work; there is no public
//   canonical testnet relayer,
// - the reference relayer keeps messages in memory unless Walrus archival is
//   configured, so a restart loses undelivered history,
// - every send and every session-key refresh asks the wallet for a personal
//   message signature.
import { Transaction } from "@mysten/sui/transactions"
import { SuiGrpcClient } from "@mysten/sui/grpc"
import { Signer, SIGNATURE_FLAG_TO_SCHEME } from "@mysten/sui/cryptography"
import { isValidSuiAddress, normalizeSuiAddress, fromBase64 } from "@mysten/sui/utils"
import { publicKeyFromSuiBytes, verifyPersonalMessageSignature, verifyTransactionSignature } from "@mysten/sui/verify"
import type { DecryptedMessage } from "@mysten/sui-stack-messaging"
import { assertTransactionAccount, signAndExecuteWithWallet } from "./sui-wallet-signer"
import { transactionAccountKey } from "./pending-transactions"
import { getActiveAccount } from "./onchain-store"
import { clearLegacyDevKeys } from "./dev-keystore"
import { t } from "./i18n/t"
import type { SuiWalletFeatures } from "./wallet-discovery"
import type { WalletAccount } from "@mysten/wallet-standard"

export const SSM_FULLNODE_URL = "https://fullnode.testnet.sui.io:443"

/** Official testnet key servers used by the upstream e2e suite; 2-of-2 by default. */
export const DEFAULT_SSM_SEAL_SERVERS = [
  "0x73d05d62c18d9374e3ea529e8e0ed6161da1a141a94d3f76ae3fe4e99356db75",
  "0xf5d14a81a982144ae441cd7d64b09027f116a468bd36e7eca494f750591623c8",
] as const

/** Messaging package used for permission type names; testnet auto-detection uses the same values. */
export const SSM_TESTNET_PACKAGE_ID = "0x047696be0e98f1b47a99727fecf2955cadb23c56f67c6b872b74e3ad59d51b46"

export interface SsmEnv {
  NEXT_PUBLIC_SSM_RELAYER_URL?: string
  NEXT_PUBLIC_SSM_SEAL_KEY_SERVERS?: string
}

export interface SsmStatus {
  configured: boolean
  relayerUrl: string
  sealServers: string[]
  /** Where the relayer URL came from, so the UI never implies a hosted service. */
  relayerSource: "env" | "local" | "none"
  /** Present only when `configured` is false. */
  reason?: string
}

/** A browser-local relayer override; this app ships no relayer of its own. */
export const SSM_LOCAL_RELAYER_KEY = "sui_ssm_relayer_v1"

export function readLocalRelayer(storage: Pick<Storage, "getItem">): string {
  try { return storage.getItem(SSM_LOCAL_RELAYER_KEY) ?? "" } catch { return "" }
}

export function saveLocalRelayer(storage: Pick<Storage, "getItem" | "setItem" | "removeItem">, value: string): string {
  if (!value.trim()) {
    storage.removeItem(SSM_LOCAL_RELAYER_KEY)
    return ""
  }
  const normalized = normalizeRelayerUrl(value)
  storage.setItem(SSM_LOCAL_RELAYER_KEY, normalized)
  return normalized
}

function readEnv(): SsmEnv {
  return {
    // Static member access is what Next replaces at build time.
    NEXT_PUBLIC_SSM_RELAYER_URL: process.env.NEXT_PUBLIC_SSM_RELAYER_URL,
    NEXT_PUBLIC_SSM_SEAL_KEY_SERVERS: process.env.NEXT_PUBLIC_SSM_SEAL_KEY_SERVERS,
  }
}

/**
 * A relayer is usable from a browser only over HTTPS, except on loopback where
 * plain HTTP is a local development address rather than a transport we can
 * promise anything about.
 */
export function normalizeRelayerUrl(input: string): string {
  const value = input.trim().replace(/\/+$/, "")
  if (!value) throw new Error(t("walrus.relayerUnconfigured"))
  let url: URL
  try { url = new URL(value) } catch { throw new Error(t("walrus.relayerInvalidUrl")) }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new Error(t("walrus.relayerHttpsRequired"))
  if (url.username || url.password) throw new Error(t("walrus.relayerNoCredentials"))
  return url.toString().replace(/\/+$/, "")
}

export function ssmStatus(env: SsmEnv = readEnv(), localRelayer = ""): SsmStatus {
  const sealServers = (env.NEXT_PUBLIC_SSM_SEAL_KEY_SERVERS ?? "")
    .split(",")
    .map(value => value.trim())
    .filter(Boolean)
  const servers = sealServers.length > 0 ? sealServers : [...DEFAULT_SSM_SEAL_SERVERS]
  for (const server of servers) if (!isValidSuiAddress(server)) return { configured: false, relayerUrl: "", sealServers: servers, relayerSource: "none", reason: t("walrus.sealServerInvalid") }
  const candidate = localRelayer.trim() || env.NEXT_PUBLIC_SSM_RELAYER_URL || ""
  const relayerSource: SsmStatus["relayerSource"] = localRelayer.trim() ? "local" : env.NEXT_PUBLIC_SSM_RELAYER_URL ? "env" : "none"
  try {
    const relayerUrl = normalizeRelayerUrl(candidate)
    return { configured: true, relayerUrl, sealServers: servers, relayerSource }
  } catch (error) {
    return { configured: false, relayerUrl: "", sealServers: servers, relayerSource, reason: error instanceof Error ? error.message : t("walrus.relayerUnconfigured") }
  }
}

/** Calls the reference relayer's unauthenticated liveness probe. */
export async function probeRelayer(relayerUrl: string, fetchImpl: typeof fetch = fetch): Promise<{ ok: boolean; detail: string }> {
  let base: string
  try { base = normalizeRelayerUrl(relayerUrl) } catch (error) { return { ok: false, detail: error instanceof Error ? error.message : t("walrus.relayerInvalid") } }
  try {
    const response = await fetchImpl(`${base}/health_check`, { signal: AbortSignal.timeout(8_000) })
    if (!response.ok) return { ok: false, detail: t("walrus.probeHttpError", { status: response.status }) }
    const body = await response.json().catch(() => null) as { status?: unknown } | null
    if (body?.status !== "ok") return { ok: false, detail: t("walrus.probeBadFormat") }
    return { ok: true, detail: base }
  } catch (error) {
    return { ok: false, detail: t("walrus.probeConnectFailed", { message: error instanceof Error ? error.message : t("walrus.networkError") }) }
  }
}

// ---------------------------------------------------------------------------
// Group registry
// ---------------------------------------------------------------------------

// The SDK has no "list my groups" call: membership is a per-group dynamic
// field, so there is no reverse index. The address→group mapping is kept in
// this browser and every entry is re-confirmed against on-chain metadata
// before it is shown as confirmed.
export interface SsmGroupRecord {
  groupId: string
  uuid: string
  name: string
  createdAt: number
}

export const SSM_GROUP_STORAGE_PREFIX = "sui_ssm_groups_v1:"
export const MAX_SSM_GROUPS = 20

// Group ids in this app are local record ids, not always addresses, so the key
// is an encoded string rather than a normalized address.
export function ssmGroupStorageKey(groupId: string): string {
  if (!groupId.trim()) throw new Error(t("walrus.groupKeyRequired"))
  return `${SSM_GROUP_STORAGE_PREFIX}${encodeURIComponent(groupId)}`
}

export function readSsmGroups(storage: Pick<Storage, "getItem">, groupId: string): SsmGroupRecord[] {
  const raw = storage.getItem(ssmGroupStorageKey(groupId))
  if (!raw) return []
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { throw new Error(t("walrus.groupsParseFailed")) }
  if (!Array.isArray(parsed)) throw new Error(t("walrus.groupsUnknownFormat"))
  return parsed.map(entry => {
    const record = entry as Partial<SsmGroupRecord> | null
    if (!record || typeof record.groupId !== "string" || !isValidSuiAddress(record.groupId)
      || typeof record.uuid !== "string" || !record.uuid || typeof record.name !== "string"
      || typeof record.createdAt !== "number" || !Number.isFinite(record.createdAt)) {
      throw new Error(t("walrus.groupsInvalidEntry"))
    }
    return { groupId: normalizeSuiAddress(record.groupId), uuid: record.uuid, name: record.name, createdAt: record.createdAt }
  })
}

export function saveSsmGroup(storage: Pick<Storage, "getItem" | "setItem">, groupId: string, record: SsmGroupRecord): SsmGroupRecord[] {
  const existing = readSsmGroups(storage, groupId).filter(entry => entry.groupId !== record.groupId)
  const next = [record, ...existing].slice(0, MAX_SSM_GROUPS)
  storage.setItem(ssmGroupStorageKey(groupId), JSON.stringify(next))
  return next
}

// ---------------------------------------------------------------------------
// Message projection
// ---------------------------------------------------------------------------

export interface SsmChatRow {
  id: string
  order: number
  sender: string
  text: string
  createdAt: number
  edited: boolean
  deleted: boolean
  /** The SDK's per-message sender-signature verification result. */
  senderVerified: boolean
  syncStatus?: string
}

export function ssmChatRows(messages: readonly DecryptedMessage[]): SsmChatRow[] {
  return [...messages]
    .sort((left, right) => left.order - right.order)
    .map(message => ({
      id: message.messageId,
      order: message.order,
      sender: normalizeSuiAddress(message.senderAddress),
      text: message.isDeleted ? "" : message.text,
      createdAt: message.createdAt,
      edited: message.isEdited,
      deleted: message.isDeleted,
      senderVerified: message.senderVerified,
      syncStatus: message.syncStatus,
    }))
}

/** Relayer refusals are operational facts, not generic network errors. */
export function describeSsmError(error: unknown): string {
  const status = error && typeof error === "object" && "status" in error && typeof (error as { status: unknown }).status === "number"
    ? (error as { status: number }).status
    : undefined
  if (status === 401) return t("walrus.err401")
  if (status === 403) return t("walrus.err403")
  if (status === 404) return t("walrus.err404")
  if (status !== undefined && status >= 500) return t("walrus.err5xx", { status })
  const message = error instanceof Error ? error.message : String(error ?? "")
  if (/encryption|seal|decrypt|access/i.test(message)) return t("walrus.errSeal", { message })
  if (/fetch|network|ECONNREFUSED|Failed to fetch/i.test(message)) return t("walrus.errNetwork")
  return message || t("walrus.errGeneric")
}

// ---------------------------------------------------------------------------
// Signers
// ---------------------------------------------------------------------------

/** Serializes wallet prompts: the Seal certificate and relayer auth can overlap. */
let walletSignQueue: Promise<unknown> = Promise.resolve()
function serializeWalletSign<T>(run: () => Promise<T>): Promise<T> {
  const next = walletSignQueue.then(run, run)
  walletSignQueue = next.then(() => undefined, () => undefined)
  return next
}

/**
 * The wallet shape this adapter needs.
 *
 * `SuiWalletFeatures` names the feature keys the app calls and types each
 * against its SDK declaration, which is what lets the `signPersonalMessage`
 * call below be checked instead of cast. It keeps an index signature because a
 * real wallet registration carries features beyond the Sui ones.
 */
interface WalletLike {
  name: string
  features: SuiWalletFeatures
}

/**
 * The wallet account this adapter needs: an address, the public key used to
 * verify signatures, and the chains it is authorised on. The Wallet Standard
 * also requires `features` on every account, which this code never reads, so it
 * stays optional here rather than forcing callers to invent a value.
 */
interface WalletAccountLike {
  address: string
  publicKey?: Uint8Array
  chains?: readonly string[]
  /** Present on a real Wallet Standard account; carried through when the SDK needs it. */
  features?: readonly string[]
}
/**
 * Wallet Standard accounts do not implement `Signer`. This adapter maps the
 * three calls the SDK makes onto wallet features and verifies every signature
 * locally before it is used, so a wallet that signs different bytes or signs
 * with another key is rejected instead of silently sending a bad message.
 */
export class WalletSigner extends Signer {
  readonly #wallet: WalletLike
  readonly #account: WalletAccountLike
  readonly #publicKey: ReturnType<typeof publicKeyFromSuiBytes>

  /**
   * The account in the shape the SDK's feature methods declare.
   *
   * The constructor rejects an account without a public key, so by the time this
   * method exists the one field `WalletAccountLike` leaves optional is known to
   * be present. Building it here states that once instead of re-asserting it at
   * every signing call.
   */
  #assertActive() {
    assertTransactionAccount({ address: this.#account.address, type: "wallet", provider: this.#wallet.name })
  }

  #walletAccount(): WalletAccount {
    return { address: this.#account.address, publicKey: this.#publicKey.toRawBytes(), features: this.#account.features ?? [] } as WalletAccount
  }

  constructor(wallet: WalletLike, account: WalletAccountLike) {
    super()
    const raw = account.publicKey
    if (!raw || raw.length < 2) throw new Error(t("walrus.walletNoPublicKey", { name: wallet.name }))
    this.#wallet = wallet
    this.#account = account
    this.#publicKey = publicKeyFromSuiBytes(new Uint8Array(raw))
    if (this.#publicKey.toSuiAddress() !== normalizeSuiAddress(account.address)) throw new Error(t("walrus.walletKeyAddressMismatch"))
  }

  override getKeyScheme() {
    const scheme = (SIGNATURE_FLAG_TO_SCHEME as Record<number, Signer["getKeyScheme"] extends () => infer S ? S : never>)[this.#publicKey.flag()]
    if (!scheme) throw new Error(t("walrus.walletSchemeUnsupported"))
    return scheme
  }

  override getPublicKey() {
    return this.#publicKey
  }

  override async sign(): Promise<Uint8Array> {
    throw new Error(t("walrus.walletNoDigestSign"))
  }

  override async signPersonalMessage(bytes: Uint8Array): Promise<{ bytes: string; signature: string }> {
    const feature = this.#wallet.features["sui:signPersonalMessage"]
    if (typeof feature?.signPersonalMessage !== "function") throw new Error(t("walrus.walletNoPersonalMessage", { name: this.#wallet.name }))
    // Bound after the check so the call below is on a value the compiler already
    // narrowed, and so `this` stays the feature object the wallet expects.
    const signPersonalMessage = feature.signPersonalMessage.bind(feature)
    return serializeWalletSign(async () => {
      this.#assertActive()
      const signed = await signPersonalMessage({ message: bytes, account: this.#walletAccount(), chain: "sui:testnet" })
      const echoed: Uint8Array | null = typeof signed?.bytes === "string" ? fromBase64(signed.bytes) : null
      if (!echoed || echoed.length !== bytes.length || echoed.some((value: number, index: number) => value !== bytes[index])) throw new Error(t("walrus.walletAlteredMessage"))
      if (typeof signed?.signature !== "string") throw new Error(t("walrus.walletNoSignature"))
      await verifyPersonalMessageSignature(bytes, signed.signature, { address: this.#account.address })
      this.#assertActive()
      return { bytes: signed.bytes, signature: signed.signature }
    })
  }

  override async signTransaction(bytes: Uint8Array): Promise<{ bytes: string; signature: string }> {
    const feature = this.#wallet.features["sui:signTransaction"]
    if (typeof feature?.signTransaction !== "function") throw new Error(t("walrus.walletNoTransaction", { name: this.#wallet.name }))
    const signTransaction = feature.signTransaction.bind(feature)
    return serializeWalletSign(async () => {
      this.#assertActive()
      const signed = await signTransaction({ transaction: Transaction.from(bytes), account: this.#walletAccount(), chain: "sui:testnet" })
      const echoed: Uint8Array | null = typeof signed?.bytes === "string" ? fromBase64(signed.bytes) : null
      if (!echoed || echoed.length !== bytes.length || echoed.some((value: number, index: number) => value !== bytes[index])) throw new Error(t("walrus.walletAlteredTransaction"))
      await verifyTransactionSignature(bytes, signed.signature, { address: this.#account.address })
      this.#assertActive()
      return { bytes: signed.bytes, signature: signed.signature }
    })
  }

  /**
   * Route execution through the app's receipt tracking instead of the wallet's
   * own submit path.
   *
   * The parameter type is derived from the base class rather than restated: the
   * SDK does not export its `SignAndExecuteOptions`, and a hand-written copy
   * would drift the moment the client gains a method.
   */
  override async signAndExecuteTransaction(...args: Parameters<Signer["signAndExecuteTransaction"]>): ReturnType<Signer["signAndExecuteTransaction"]> {
    const [{ transaction, client }] = args
    const result = await signAndExecuteWithWallet(transaction, {
      action: "ssm-wallet-transaction",
      scope: JSON.stringify(transaction.getData().commands),
      expectedAccount: { address: this.#account.address, type: "wallet", provider: this.#wallet.name },
      metadata: { transport: "sui-stack-messaging" },
    })
    // The transaction already executed through the app's receipt tracking;
    // this only reads it back, so a bounded wait is safe and cannot resubmit.
    return client.core.waitForTransaction({ digest: result.digest, include: { effects: true, transaction: true }, timeout: 30_000 })
  }
}

export async function getSsmSigner(): Promise<Signer> {
  const account = getActiveAccount()
  if (!account?.address) throw new Error(t("walrus.connectWalletFirst"))
  const address = normalizeSuiAddress(account.address)
  clearLegacyDevKeys()
  if (account.type === "keystore") throw new Error(t("walrus.keystoreRetiredFull"))
  if (account.type === "zklogin") {
    const { getZkLoginSigner } = await import("./zklogin")
    const { systemState } = await new SuiGrpcClient({ network: "testnet", baseUrl: SSM_FULLNODE_URL }).getCurrentSystemState({ signal: AbortSignal.timeout(15_000) })
    const signer = await getZkLoginSigner(address, Number(systemState.epoch))
    if (signer.toSuiAddress() !== address) throw new Error(t("walrus.zkloginSignerMismatch"))
    return signer
  }
  if (account.type === "passkey") {
    const { getPasskeySigner } = await import("./passkey")
    const signer = await getPasskeySigner(address)
    if (signer.toSuiAddress() !== address) throw new Error(t("walrus.passkeySignerMismatch"))
    return signer
  }
  if (account.type !== "wallet") throw new Error(t("walrus.signerUnsupported"))
  const { getWallets } = await import("@mysten/wallet-standard")
  for (const wallet of getWallets().get() as readonly WalletLike[]) {
    if (account.provider && wallet.name !== account.provider) continue
    if (typeof wallet.features?.["sui:signPersonalMessage"]?.signPersonalMessage !== "function") continue
    const match = (wallet as unknown as { accounts?: WalletAccountLike[] }).accounts?.find(candidate => {
      try { return normalizeSuiAddress(candidate.address) === address && (!candidate.chains || candidate.chains.includes("sui:testnet")) } catch { return false }
    })
    if (match) return new WalletSigner(wallet, match)
  }
  throw new Error(t("walrus.walletAccountNotFound"))
}

// ---------------------------------------------------------------------------
// Client session
// ---------------------------------------------------------------------------

// Session keys are cached inside the client, so the client must outlive a
// single render or every message would open a new wallet prompt.
type SsmClient = Awaited<ReturnType<typeof createClient>>
let cached: { key: string; client: SsmClient; signer: Signer } | null = null
let sessionGeneration = 0
let accountEventTarget: Window | null = null

function watchSsmAccount() {
  if (typeof window === "undefined" || accountEventTarget === window) return
  accountEventTarget = window
  window.addEventListener("sui-account-switched", resetSsmSession)
  window.addEventListener("storage", event => {
    if (typeof StorageEvent === "undefined" || !(event instanceof StorageEvent) || event.key === null || event.key === "sui_active_account") resetSsmSession()
  })
}

async function createClient(relayerUrl: string, signer: Signer, sealServers: string[]) {
  const { createSuiStackMessagingClient } = await import("@mysten/sui-stack-messaging")
  const base = new SuiGrpcClient({ network: "testnet", baseUrl: SSM_FULLNODE_URL })
  return createSuiStackMessagingClient(base, {
    seal: { serverConfigs: sealServers.map(objectId => ({ objectId, weight: 1 })) },
    encryption: { sessionKey: { signer, ttlMin: 10 } },
    relayer: { relayerUrl },
  })
}

export interface SsmSession {
  client: SsmClient
  signer: Signer
  address: string
  relayerUrl: string
}

export interface SsmSessionDependencies {
  getSigner?: typeof getSsmSigner
  createClient?: typeof createClient
}

export async function ssmSession(relayerUrl?: string, dependencies: SsmSessionDependencies = {}): Promise<SsmSession> {
  const local = typeof window === "undefined" ? "" : readLocalRelayer(localStorage)
  const status = ssmStatus(readEnv(), local)
  const target = relayerUrl ? normalizeRelayerUrl(relayerUrl) : status.relayerUrl
  if (!target) throw new Error(status.reason ?? t("walrus.relayerUnconfigured"))
  const account = getActiveAccount()
  if (!account?.address) throw new Error(t("walrus.connectWalletFirst"))
  const address = normalizeSuiAddress(account.address)
  clearLegacyDevKeys()
  if (account.type === "keystore") { resetSsmSession(); throw new Error(t("walrus.keystoreRetiredShort")) }
  watchSsmAccount()
  const key = `${transactionAccountKey(account)}|${target}|${status.sealServers.join(",")}`
  if (cached?.key === key) return { client: cached.client, signer: cached.signer, address, relayerUrl: target }
  resetSsmSession()
  const generation = sessionGeneration
  const signer = await (dependencies.getSigner ?? getSsmSigner)()
  assertTransactionAccount(account)
  if (generation !== sessionGeneration) throw new Error(t("walrus.accountSwitchedRetry"))
  const client = await (dependencies.createClient ?? createClient)(target, signer, status.sealServers)
  try {
    assertTransactionAccount(account)
    if (generation !== sessionGeneration) throw new Error(t("walrus.accountSwitchedRetry"))
  } catch (error) { client.messaging.disconnect(); throw error }
  cached = { key, client, signer }
  return { client, signer, address, relayerUrl: target }
}

export function resetSsmSession() {
  sessionGeneration++
  const previous = cached
  cached = null
  previous?.client.messaging.disconnect()
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export async function confirmSsmGroup(client: SsmClient, groupId: string, expectedName?: string): Promise<string> {
  const metadata = await client.messaging.view.groupsMetadata({ groupIds: [groupId], refresh: true })
  const found = metadata[groupId]
  if (!found) throw new Error(t("walrus.groupNotFoundOnChain"))
  if (expectedName !== undefined && found.name !== expectedName) throw new Error(t("walrus.groupNameMismatch"))
  return found.name
}

export async function createSsmGroup(appGroupId: string, name: string): Promise<{ record: SsmGroupRecord; digest: string; warning?: string }> {
  const trimmed = name.trim()
  if (!trimmed) throw new Error(t("walrus.groupNameRequired"))
  if (new TextEncoder().encode(trimmed).length > 128) throw new Error(t("walrus.groupNameTooLong"))
  const session = await ssmSession()
  const uuid = crypto.randomUUID()
  const groupId = session.client.messaging.derive.groupId({ uuid })
  const tx = session.client.messaging.tx.createAndShareGroup({ name: trimmed, uuid })
  const result = await signAndExecuteWithWallet(tx, {
    action: "ssm-group-create",
    scope: `${appGroupId}:${uuid}`,
    expectedAccount: { address: session.address },
    metadata: { groupId: appGroupId, ssmGroupId: groupId, ssmUuid: uuid },
  })
  const record: SsmGroupRecord = { groupId, uuid, name: trimmed, createdAt: Date.now() }
  try {
    await confirmSsmGroup(session.client, groupId, trimmed)
    saveSsmGroup(localStorage, appGroupId, record)
    return { record, digest: result.digest }
  } catch (error) {
    return {
      record,
      digest: result.digest,
      warning: t("walrus.createGroupWarning", { digest: result.digest, message: error instanceof Error ? error.message : t("walrus.readFailed") }),
    }
  }
}

export async function inviteToSsmGroup(groupId: string, member: string): Promise<string> {
  if (!isValidSuiAddress(member)) throw new Error(t("walrus.invalidSuiAddress"))
  const session = await ssmSession()
  const { defaultMemberPermissionTypes } = await import("@mysten/sui-stack-messaging")
  const permissionTypes = Object.values(defaultMemberPermissionTypes(SSM_TESTNET_PACKAGE_ID))
  const tx = session.client.groups.tx.grantPermissions({ groupId, member: normalizeSuiAddress(member), permissionTypes })
  const result = await signAndExecuteWithWallet(tx, {
    action: "ssm-group-invite",
    scope: `${normalizeSuiAddress(groupId)}:${normalizeSuiAddress(member)}`,
    expectedAccount: { address: session.address },
    metadata: { ssmGroupId: normalizeSuiAddress(groupId), member: normalizeSuiAddress(member) },
  })
  return result.digest
}

export async function sendSsmMessage(uuid: string, text: string): Promise<string> {
  const trimmed = text.trim()
  if (!trimmed) throw new Error(t("walrus.messageEmpty"))
  if (new TextEncoder().encode(trimmed).length > 8 * 1024) throw new Error(t("walrus.messageTooLong"))
  const session = await ssmSession()
  const { messageId } = await session.client.messaging.sendMessage({ signer: session.signer, groupRef: { uuid }, text: trimmed })
  return messageId
}

export async function readSsmMessages(uuid: string, limit = 50): Promise<SsmChatRow[]> {
  const session = await ssmSession()
  const result = await session.client.messaging.getMessages({ signer: session.signer, groupRef: { uuid }, limit })
  return ssmChatRows(result.messages)
}

export async function subscribeSsmMessages(uuid: string, signal: AbortSignal, onRows: (rows: SsmChatRow[]) => void, afterOrder?: number): Promise<void> {
  const session = await ssmSession()
  const buffer: DecryptedMessage[] = []
  for await (const message of session.client.messaging.subscribe({ signer: session.signer, groupRef: { uuid }, signal, afterOrder })) {
    buffer.push(message)
    if (buffer.length > 200) buffer.splice(0, buffer.length - 200)
    onRows(ssmChatRows(buffer))
  }
}
