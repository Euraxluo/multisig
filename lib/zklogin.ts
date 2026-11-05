"use client"

import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { SuiGrpcClient } from "@mysten/sui/grpc"
import { generateNonce, generateRandomness, ZkLoginSigner, type ZkLoginSignatureInputs } from "@mysten/sui/zklogin"
import { normalizeSuiAddress } from "@mysten/sui/utils"
import { clearLegacyDevKeys } from "./dev-keystore"
import { defaultDeviceVault, type SealedSecretBox } from "./crypto/device-vault"
import { t } from "./i18n/t"

const PENDING_KEY = "sui_zklogin_pending_v1"
const PENDING_URL_KEY = "sui_zklogin_pending_url_v1"
const SESSION_KEY = "sui_zklogin_session_v1"

export interface ZkLoginAccount {
  type: "zklogin"
  provider: string
  identifier: string
  address: string
  epochTtl: number
  authMethodLabel: string
}
export interface ZkLoginConfig { enabled: boolean; clientId?: string; redirectUri?: string; error?: string }
/**
 * The ephemeral signing key is sealed with the device vault before it reaches
 * sessionStorage; the AAD context binds the box to the key's own public key, so
 * a stored box cannot be replayed against another login. Sessions written
 * before sealing shipped carry the raw `suiprivkey` string and are still
 * accepted on read.
 */
type PersistedSecret = string | SealedSecretBox
interface PendingLogin {
  secretKey: PersistedSecret
  publicKey: string
  randomness: string
  state: string
  nonce: string
  maxEpoch: number
  expiresAt: number
}
interface ZkLoginSession {
  secretKey: PersistedSecret
  publicKey: string
  randomness: string
  nonce: string
  maxEpoch: number
  inputs: ZkLoginSignatureInputs
  account: ZkLoginAccount
}

const ephemeralContext = (publicKey: string): string => `zklogin-ephemeral-v1:${publicKey}`
const encoder = new TextEncoder()
const decoder = new TextDecoder()
async function sealEphemeralSecret(secretKey: string, publicKey: string): Promise<SealedSecretBox> {
  return defaultDeviceVault.seal(encoder.encode(secretKey), ephemeralContext(publicKey))
}
async function recoverEphemeralSecret(secret: PersistedSecret, publicKey: string): Promise<string> {
  if (typeof secret === "string") return secret
  return decoder.decode(await defaultDeviceVault.open(secret, ephemeralContext(publicKey)))
}

async function responseJson(response: Response) {
  const data = await response.json()
  if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : t("misc.zk.requestFailed"))
  return data
}

export async function getZkLoginConfig(): Promise<ZkLoginConfig> {
  try {
    return await responseJson(await fetch("/api/zklogin/config", { cache: "no-store", credentials: "same-origin" }))
  } catch (error) {
    return { enabled: false, error: error instanceof Error ? error.message : t("misc.zk.configUnavailable") }
  }
}

export function clearZkLoginSession() {
  try { sessionStorage.removeItem(PENDING_KEY); sessionStorage.removeItem(PENDING_URL_KEY); sessionStorage.removeItem(SESSION_KEY) } catch {}
  // Remove obsolete values from the previous address-only demonstration.
  try {
    for (const key of ["sui_ephemeral_key", "sui_zklogin_randomness", "sui_zklogin_max_epoch"]) sessionStorage.removeItem(key)
    localStorage.removeItem("sui_zklogin_user_salt")
  } catch {}
}

export async function beginGoogleZkLogin() {
  const config = await getZkLoginConfig()
  if (!config.enabled || !config.clientId || !config.redirectUri) throw new Error(config.error ?? t("misc.zk.notConfigured"))
  if (new URL(config.redirectUri).origin !== window.location.origin) throw new Error(t("misc.zk.originMismatch"))
  const keypair = Ed25519Keypair.generate()
  const randomness = generateRandomness()
  const flow = await responseJson(await fetch("/api/zklogin/start", {
    method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ publicKey: keypair.getPublicKey().toBase64(), randomness }),
    signal: AbortSignal.timeout(20_000),
  }))
  if (!Number.isSafeInteger(flow.maxEpoch) || flow.nonce !== generateNonce(keypair.getPublicKey(), flow.maxEpoch, randomness) || !/^[a-f0-9]{64}$/.test(flow.state) || !Number.isFinite(flow.expiresAt) || flow.expiresAt <= Date.now()) throw new Error(t("misc.zk.invalidFlow"))
  const pending: PendingLogin = {
    secretKey: await sealEphemeralSecret(keypair.getSecretKey(), keypair.getPublicKey().toBase64()), publicKey: keypair.getPublicKey().toBase64(), randomness,
    state: flow.state, nonce: flow.nonce, maxEpoch: flow.maxEpoch, expiresAt: flow.expiresAt,
  }
  clearZkLoginSession()
  try { sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending)) } catch { throw new Error(t("misc.zk.storageDisabled")) }
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth")
  url.search = new URLSearchParams({
    client_id: config.clientId, redirect_uri: config.redirectUri, response_type: "id_token",
    scope: "openid email", nonce: pending.nonce, state: pending.state, prompt: "select_account",
  }).toString()
  try { sessionStorage.setItem(PENDING_URL_KEY, url.toString()) } catch {}
  window.location.assign(url.toString())
}

function pendingLogin(): PendingLogin {
  let pending: PendingLogin | null = null
  try { pending = JSON.parse(sessionStorage.getItem(PENDING_KEY) ?? "null") } catch {}
  if (!pending || !Number.isFinite(pending.expiresAt) || pending.expiresAt <= Date.now()) throw new Error(t("misc.zk.pendingExpired"))
  return pending
}

// Keep StrictMode's second effect from consuming the one-use server flow twice.
let completion: Promise<ZkLoginAccount> | undefined
export function completeGoogleZkLogin(fragment: string): Promise<ZkLoginAccount> {
  return completion ??= completeGoogleCallback(fragment).finally(() => { completion = undefined })
}
async function completeGoogleCallback(fragment: string): Promise<ZkLoginAccount> {
  try {
    const params = new URLSearchParams(fragment.replace(/^#/, ""))
    const pending = pendingLogin()
    if (params.getAll("state").length !== 1 || params.get("state") !== pending.state) throw new Error(t("misc.zk.stateFailed"))
    if (params.has("error")) throw new Error(t("misc.zk.googleCancelled"))
    if (params.getAll("id_token").length !== 1) throw new Error(t("misc.zk.idTokenMissing"))
    return await finishZkLogin(params.get("id_token")!, pending)
  } catch (error) {
    clearZkLoginSession()
    throw error
  }
}

/**
 * Complete a login this tab already started, using a Google ID Token obtained
 * elsewhere (for example when the OAuth redirect could not reach the callback
 * route). The token must belong to the flow pending in this tab: the server
 * still verifies issuer, audience, nonce, expiry and signature, and the client
 * still verifies the Groth16 proof against the derived address.
 */
export function completeManualZkLogin(jwt: string): Promise<ZkLoginAccount> {
  return completion ??= completeManual(jwt).finally(() => { completion = undefined })
}
async function completeManual(jwt: string): Promise<ZkLoginAccount> {
  try {
    const token = jwt.trim()
    if (!token) throw new Error(t("misc.zk.pasteToken"))
    if (token.length > 16_000) throw new Error(t("misc.zk.tokenSize"))
    if (token.split(".").length !== 3) throw new Error(t("misc.zk.tokenFormat"))
    const pending = pendingLogin()
    return await finishZkLogin(token, pending)
  } catch (error) {
    clearZkLoginSession()
    throw error
  }
}

async function finishZkLogin(jwt: string, pending: PendingLogin): Promise<ZkLoginAccount> {
  const secretKey = await recoverEphemeralSecret(pending.secretKey, pending.publicKey)
  const keypair = Ed25519Keypair.fromSecretKey(secretKey)
  if (keypair.getPublicKey().toBase64() !== pending.publicKey || generateNonce(keypair.getPublicKey(), pending.maxEpoch, pending.randomness) !== pending.nonce) throw new Error(t("misc.zk.ephemeralMismatch"))
  const result = await responseJson(await fetch("/api/zklogin/complete", {
    method: "POST", credentials: "same-origin", cache: "no-store", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jwt, state: pending.state }), signal: AbortSignal.timeout(115_000),
  }))
  if (result.maxEpoch !== pending.maxEpoch || result.account?.type !== "zklogin") throw new Error(t("misc.zk.sessionMismatch"))
  const session: ZkLoginSession = { ...pending, inputs: result.inputs, account: result.account }
  const signer = await makeSigner(session, result.account.address)
  // Verify the actual Groth16 proof and ephemeral-key binding before showing a connected account.
  const challenge = crypto.getRandomValues(new Uint8Array(32))
  const signed = await signer.signPersonalMessage(challenge)
  const client = new SuiGrpcClient({ network: "testnet", baseUrl: "https://fullnode.testnet.sui.io:443" })
  const verification = await client.verifyZkLoginSignature({ bytes: signed.bytes, signature: signed.signature, address: result.account.address, intentScope: "PersonalMessage", signal: AbortSignal.timeout(15_000) })
  if (!verification.success || verification.errors.length) throw new Error(t("misc.zk.proofFailed"))
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session))
  sessionStorage.removeItem(PENDING_KEY)
  publishAccount(result.account)
  return result.account
}

/** The OAuth URL this tab is waiting for, or null when no flow is pending. */
export function pendingZkLoginUrl(): string | null {
  try { pendingLogin() } catch { return null }
  try { return new URL(sessionStorage.getItem(PENDING_URL_KEY) ?? "").toString() } catch { return null }
}

export function publishAccount(account: { type: string; address: string; [key: string]: unknown } | null) {
  clearLegacyDevKeys()
  if (account?.type === "keystore") throw new Error(t("misc.zk.keystoreDisabled"))
  if (account) localStorage.setItem("sui_active_account", JSON.stringify(account))
  else localStorage.removeItem("sui_active_account")
  window.dispatchEvent(new CustomEvent("sui-account-switched", { detail: account }))
  window.dispatchEvent(new Event("storage"))
}

async function makeSigner(session: ZkLoginSession, expectedAddress: string) {
  if (session.account.type !== "zklogin" || normalizeSuiAddress(session.account.address) !== normalizeSuiAddress(expectedAddress) || !Number.isSafeInteger(session.maxEpoch) || session.maxEpoch < 0) throw new Error(t("misc.zk.accountMismatch"))
  const keypair = Ed25519Keypair.fromSecretKey(await recoverEphemeralSecret(session.secretKey, session.publicKey))
  if (keypair.getPublicKey().toBase64() !== session.publicKey || generateNonce(keypair.getPublicKey(), session.maxEpoch, session.randomness) !== session.nonce) throw new Error(t("misc.zk.ephemeralKeyMismatch"))
  return new ZkLoginSigner({ ephemeralSigner: keypair, inputs: session.inputs, maxEpoch: session.maxEpoch, legacyAddress: false, address: normalizeSuiAddress(expectedAddress) })
}

export async function getZkLoginSigner(address: string, currentEpoch: number) {
  let session: ZkLoginSession | null = null
  try { session = JSON.parse(sessionStorage.getItem(SESSION_KEY) ?? "null") } catch {}
  if (!session) throw new Error(t("misc.zk.noSession"))
  if (!Number.isSafeInteger(currentEpoch) || currentEpoch < 0 || currentEpoch > session.maxEpoch) {
    clearZkLoginSession()
    throw new Error(t("misc.zk.ephemeralExpired"))
  }
  return makeSigner(session, address)
}
