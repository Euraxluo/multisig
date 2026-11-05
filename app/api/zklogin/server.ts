import { createHmac, createPublicKey, randomBytes, timingSafeEqual, verify } from "node:crypto"
import { SuiGrpcClient } from "@mysten/sui/grpc"
import { Ed25519PublicKey } from "@mysten/sui/keypairs/ed25519"
import { generateNonce, genAddressSeed, jwtToAddress, ZkLoginSigner } from "@mysten/sui/zklogin"
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { z } from "zod"
import { t } from "@/lib/i18n/t"

export const FLOW_SECONDS = 600
const COOKIE = "sui_zklogin_flow"
const NO_STORE = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" }
const TESTNET_RPC = "https://fullnode.testnet.sui.io:443"

export class LoginError extends Error {
  constructor(message: string, public status = 400) { super(message) }
}

export function configuration() {
  const required = ["ZKLOGIN_ORIGIN", "ZKLOGIN_GOOGLE_CLIENT_ID", "ZKLOGIN_SESSION_SECRET", "ZKLOGIN_SALT_URL", "ZKLOGIN_PROVER_URL"] as const
  const missing = required.filter((key) => !process.env[key]?.trim())
  if (missing.length) throw new LoginError(t("misc.zkSrv.unconfigured", { vars: missing.join(t("misc.zkSrv.listSep")) }), 503)
  const origin = new URL(process.env.ZKLOGIN_ORIGIN!)
  const local = process.env.NODE_ENV !== "production" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)
  if ((origin.protocol !== "https:" && !(local && origin.protocol === "http:")) || origin.origin !== process.env.ZKLOGIN_ORIGIN || origin.username || origin.password) {
    throw new LoginError(t("misc.zkSrv.originInvalid"), 503)
  }
  if (process.env.ZKLOGIN_SESSION_SECRET!.length < 32) throw new LoginError(t("misc.zkSrv.secretShort"), 503)
  for (const key of ["ZKLOGIN_SALT_URL", "ZKLOGIN_PROVER_URL"] as const) {
    const url = new URL(process.env[key]!)
    if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new LoginError(t("misc.zkSrv.httpsOnly", { key }), 503)
  }
  if (!/^[a-zA-Z0-9._-]+\.apps\.googleusercontent\.com$/.test(process.env.ZKLOGIN_GOOGLE_CLIENT_ID!)) throw new LoginError(t("misc.zkSrv.clientIdInvalid"), 503)
  return {
    origin: origin.origin,
    clientId: process.env.ZKLOGIN_GOOGLE_CLIENT_ID!,
    secret: process.env.ZKLOGIN_SESSION_SECRET!,
    saltUrl: process.env.ZKLOGIN_SALT_URL!,
    proverUrl: process.env.ZKLOGIN_PROVER_URL!,
  }
}

// Per-process admission limits also cap memory. Deployments with multiple instances should
// additionally apply a shared gateway rate limit to /api/zklogin/*.
const buckets = new Map<string, { count: number; until: number }>()
function rateLimit(key: string, limit: number) {
  const now = Date.now()
  for (const [id, bucket] of buckets) if (bucket.until <= now) buckets.delete(id)
  const bucket = buckets.get(key) ?? { count: 0, until: now + 60_000 }
  if (bucket.count >= limit || buckets.size > 2000) throw new LoginError(t("misc.zkSrv.rateLimited"), 429)
  bucket.count++
  buckets.set(key, bucket)
}

export function protect(request: Request) {
  const config = configuration()
  if (request.headers.get("origin") !== config.origin || new URL(request.url).origin !== config.origin) throw new LoginError(t("misc.zkSrv.originMismatch"), 403)
  const site = request.headers.get("sec-fetch-site")
  if (site && site !== "same-origin") throw new LoginError(t("misc.zkSrv.crossSite"), 403)
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new LoginError(t("misc.zkSrv.jsonRequired"), 415)
  rateLimit("global", 100)
  // The global budget remains effective even if a deployment does not sanitize proxy IP headers.
  rateLimit(`ip:${request.headers.get("x-forwarded-for")?.split(",")[0]?.trim().slice(0, 64) ?? "local"}`, 15)
  return config
}

export async function limitedJson(response: Response | Request, limit: number): Promise<unknown> {
  const size = Number(response.headers.get("content-length"))
  if (size > limit) throw new LoginError(t("misc.zkSrv.tooLarge"), 413)
  if (!response.body) throw new LoginError(t("misc.zkSrv.missingBody"))
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.length
      if (length > limit) throw new LoginError(t("misc.zkSrv.tooLarge"), 413)
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) } catch { throw new LoginError(t("misc.zkSrv.invalidJson")) }
}

export interface Flow {
  state: string
  nonce: string
  publicKey: string
  randomness: string
  maxEpoch: number
  createdAt: number
  expiresAt: number
}

function mac(payload: string, secret: string) { return createHmac("sha256", secret).update(payload).digest("base64url") }
export function sealFlow(flow: Flow, secret: string) {
  const payload = Buffer.from(JSON.stringify(flow)).toString("base64url")
  return `${payload}.${mac(payload, secret)}`
}
export function openFlow(value: string, secret: string): Flow {
  const [payload, signature, extra] = value.split(".")
  if (!payload || !signature || extra || value.length > 4096) throw new LoginError(t("misc.zkSrv.flowInvalid"))
  const expected = Buffer.from(mac(payload, secret))
  const actual = Buffer.from(signature)
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new LoginError(t("misc.zkSrv.flowTampered"))
  let flow: Flow
  try { flow = JSON.parse(Buffer.from(payload, "base64url").toString()) } catch { throw new LoginError(t("misc.zkSrv.flowCorrupt")) }
  if (!Number.isFinite(flow.expiresAt) || flow.expiresAt <= Date.now() || flow.createdAt > Date.now() || flow.expiresAt - flow.createdAt !== FLOW_SECONDS * 1000) throw new LoginError(t("misc.zkSrv.flowTimeout"))
  return flow
}
export function flowCookie(value: string, origin: string, clear = false) {
  return `${COOKIE}=${value}; Path=/api/zklogin; HttpOnly; SameSite=Lax; Max-Age=${clear ? 0 : FLOW_SECONDS}${origin.startsWith("https:") ? "; Secure" : ""}`
}
export function readFlow(request: Request, secret: string) {
  const value = request.headers.get("cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1)
  if (!value) throw new LoginError(t("misc.zkSrv.flowMissing"))
  return openFlow(value, secret)
}

export function json(data: unknown, status = 200, cookie?: string) {
  return new Response(JSON.stringify(data), { status, headers: { ...NO_STORE, "Content-Type": "application/json; charset=utf-8", ...(cookie ? { "Set-Cookie": cookie } : {}) } })
}
export function errorResponse(error: unknown) {
  // Never return provider bodies, JWTs, keys, stack traces or credential-bearing URLs.
  return json({ error: error instanceof LoginError ? error.message : t("misc.zkSrv.unavailable") }, error instanceof LoginError ? error.status : 502)
}

export async function currentEpoch() {
  const client = new SuiGrpcClient({ network: "testnet", baseUrl: TESTNET_RPC })
  const { systemState } = await client.getCurrentSystemState({ signal: AbortSignal.timeout(12_000) })
  const epoch = Number(systemState.epoch)
  if (!Number.isSafeInteger(epoch) || epoch < 0) throw new LoginError(t("misc.zkSrv.epochFailed"), 502)
  return epoch
}

const decimal128 = z.string().regex(/^(0|[1-9][0-9]{0,38})$/).refine((s) => BigInt(s) < 2n ** 128n)
export const startSchema = z.object({ publicKey: z.string().max(64), randomness: decimal128 }).strict()
export const completeSchema = z.object({ jwt: z.string().min(100).max(16_000), state: z.string().regex(/^[a-f0-9]{64}$/) }).strict()

export async function startFlow(body: z.infer<typeof startSchema>) {
  let key: Ed25519PublicKey
  try {
    key = new Ed25519PublicKey(body.publicKey)
    if (key.toBase64() !== body.publicKey) throw new Error()
  } catch { throw new LoginError(t("misc.zkSrv.publicKeyInvalid")) }
  const maxEpoch = await currentEpoch() + 2
  const createdAt = Date.now()
  return {
    state: randomBytes(32).toString("hex"),
    nonce: generateNonce(key, maxEpoch, body.randomness),
    publicKey: body.publicKey,
    randomness: body.randomness,
    maxEpoch,
    createdAt,
    expiresAt: createdAt + FLOW_SECONDS * 1000,
  } satisfies Flow
}

export interface GoogleClaims {
  iss: string; aud: string; sub: string; nonce: string; exp: number; iat: number
  azp?: string; nbf?: number; email?: string; email_verified?: boolean
}
export function validateClaims(claims: GoogleClaims, flow: Flow, clientId: string, now = Date.now()) {
  const seconds = now / 1000
  if (claims.iss !== "https://accounts.google.com" && claims.iss !== "accounts.google.com") throw new LoginError(t("misc.zkSrv.issuerInvalid"))
  if (claims.aud !== clientId || (claims.azp !== undefined && claims.azp !== clientId)) throw new LoginError(t("misc.zkSrv.audienceMismatch"))
  if (typeof claims.sub !== "string" || !claims.sub || claims.sub.length > 255) throw new LoginError(t("misc.zkSrv.subjectInvalid"))
  if (claims.nonce !== flow.nonce) throw new LoginError(t("misc.zkSrv.nonceMismatch"))
  if (!Number.isFinite(claims.exp) || !Number.isFinite(claims.iat) || claims.exp <= seconds || claims.iat > seconds + 60 || claims.iat < flow.createdAt / 1000 - 60 || claims.exp <= claims.iat || (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > seconds))) throw new LoginError(t("misc.zkSrv.jwtExpired"))
  if (flow.expiresAt <= now) throw new LoginError(t("misc.zkSrv.oauthExpired"))
}

type GoogleJwk = { kty: "RSA"; kid: string; alg: "RS256"; use: "sig"; n: string; e: string }
let jwksCache: { keys: GoogleJwk[]; expires: number } | undefined
async function googleKeys(): Promise<GoogleJwk[]> {
  if (jwksCache && jwksCache.expires > Date.now()) return jwksCache.keys
  const res = await fetch("https://www.googleapis.com/oauth2/v3/certs", { signal: AbortSignal.timeout(10_000), redirect: "error", cache: "no-store" })
  if (!res.ok) throw new LoginError(t("misc.zkSrv.jwksUnavailable"), 502)
  const data = z.object({ keys: z.array(z.object({ kty: z.literal("RSA"), kid: z.string(), alg: z.literal("RS256"), use: z.literal("sig"), n: z.string(), e: z.string() })).min(1).max(10) }).parse(await limitedJson(res, 32_000))
  jwksCache = { keys: data.keys, expires: Date.now() + 5 * 60_000 }
  return data.keys
}
export async function verifyGoogleJwt(jwt: string, flow: Flow, clientId: string) {
  const parts = jwt.split(".")
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) throw new LoginError(t("misc.zkSrv.jwtFormat"))
  let header: { alg: string; kid: string }
  let claims: GoogleClaims
  try {
    header = JSON.parse(Buffer.from(parts[0], "base64url").toString())
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString())
  } catch { throw new LoginError(t("misc.zkSrv.jwtFormat")) }
  if (!header || header.alg !== "RS256" || typeof header.kid !== "string" || !claims) throw new LoginError(t("misc.zkSrv.algInvalid"))
  validateClaims(claims, flow, clientId)
  const key = (await googleKeys()).find((candidate) => candidate.kid === header.kid)
  if (!key) throw new LoginError(t("misc.zkSrv.kidUnknown"))
  if (!verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key, format: "jwk" }), Buffer.from(parts[2], "base64url"))) throw new LoginError(t("misc.zkSrv.signatureFailed"))
  return claims
}

async function servicePost(url: string, data: unknown, apiKey: string | undefined, name: string) {
  const res = await fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
    body: JSON.stringify(data), signal: AbortSignal.timeout(45_000), redirect: "error", cache: "no-store",
  })
  if (!res.ok) { await res.body?.cancel(); throw new LoginError(t("misc.zkSrv.serviceFailed", { name }), 502) }
  return limitedJson(res, 32_000)
}
const field = z.string().regex(/^[0-9]{1,78}$/)
const point = z.tuple([field, field, field])
const proofSchema = z.object({
  proofPoints: z.object({ a: point, b: z.tuple([z.tuple([field, field]), z.tuple([field, field]), z.tuple([field, field])]), c: point }),
  issBase64Details: z.object({ value: z.string().min(1).max(2048), indexMod4: z.number().int().min(0).max(2) }),
  headerBase64: z.string().min(1).max(2048),
})
const consumed = new Map<string, number>()
export function consumeFlow(flow: Flow, state: string) {
  if (state !== flow.state) throw new LoginError(t("misc.zkSrv.stateMismatch"))
  for (const [key, expires] of consumed) if (expires <= Date.now()) consumed.delete(key)
  if (consumed.has(state)) throw new LoginError(t("misc.zkSrv.flowUsed"))
  if (consumed.size >= 2000) throw new LoginError(t("misc.zkSrv.busy"), 429)
  consumed.set(state, flow.expiresAt)
}

export async function completeFlow(jwt: string, flow: Flow, config: ReturnType<typeof configuration>) {
  const claims = await verifyGoogleJwt(jwt, flow, config.clientId)
  const epoch = await currentEpoch()
  if (epoch > flow.maxEpoch || flow.maxEpoch > epoch + 2) throw new LoginError(t("misc.zkSrv.ephemeralExpired"))
  // The provider is responsible for durable, recoverable per-(iss,aud,sub) salts.
  // No generated or shared fallback salt is allowed here.
  const { salt } = z.object({ salt: decimal128 }).parse(await servicePost(config.saltUrl, { jwt }, process.env.ZKLOGIN_SALT_API_KEY, t("misc.zkSrv.saltService")))
  const extendedEphemeralPublicKey = new Ed25519PublicKey(flow.publicKey).toSuiPublicKey()
  const proof = proofSchema.parse(await servicePost(config.proverUrl, {
    jwt, extendedEphemeralPublicKey, maxEpoch: String(flow.maxEpoch), jwtRandomness: flow.randomness, salt, keyClaimName: "sub",
  }, process.env.ZKLOGIN_PROVER_API_KEY, t("misc.zkSrv.proverService")))
  if (proof.headerBase64 !== jwt.split(".")[0]) throw new LoginError(t("misc.zkSrv.headerMismatch"), 502)
  const inputs = { ...proof, addressSeed: genAddressSeed(BigInt(salt), "sub", claims.sub, claims.aud).toString() }
  const address = jwtToAddress(jwt, salt, false)
  // Constructor checks issuer/addressSeed and the non-legacy address against the JWT address.
  new ZkLoginSigner({ ephemeralSigner: Ed25519Keypair.generate(), inputs, maxEpoch: flow.maxEpoch, legacyAddress: false, address })
  if (Date.now() >= flow.expiresAt) throw new LoginError(t("misc.zkSrv.flowTimeout"))
  return {
    account: { type: "zklogin", provider: "Google", identifier: claims.email_verified === true && typeof claims.email === "string" ? claims.email : "Google User", address, epochTtl: flow.maxEpoch - epoch, authMethodLabel: "Google zkLogin · Testnet" },
    inputs, maxEpoch: flow.maxEpoch,
  }
}
