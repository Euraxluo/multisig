import { t } from "@/lib/i18n/t"
import { ed25519, ed25519_FROST } from "@noble/curves/ed25519.js"
import { sha256, sha512 } from "@noble/hashes/sha2.js"
import { fromHex, isValidSuiAddress, normalizeSuiAddress, toHex } from "@mysten/sui/utils"
import { bytesToScalar, mod, randomScalar, scalarToBytes32 } from "./crypto/math"
import { toNobleFrostPublic, toPublicKeyPackage, validateDeviceKeyPackage, validatePublicKeyPackage, type BoundDeviceKey } from "./dkg-key-package"
import { computeProposalDigest, computeRosterUpdateDigest, computeThresholdApprovalDigest } from "./vault-client"
import { defaultFrostSessionStore, rememberFrostSession, type FrostNonceMaterial, type FrostSessionStore } from "./frost-session-store"
import { defaultDeviceVault, type DeviceVault } from "./crypto/device-vault"

export type { BoundDeviceKey, DeviceKeyPackage } from "./dkg-key-package"
import type { DeviceKeyPackage } from "./dkg-key-package"
export interface FrostSigner { address: string; index: string }
export type FrostAction =
  | { kind: "roster"; packageId: string; orgId: string; epoch: string; nonce: string; chainIdHex: string; newEpoch: string; thresholdWeight: string; priorMembers: string[]; members: string[]; weights: string[] }
  | { kind: "epoch"; packageId: string; orgId: string; epoch: string; nonce: string; chainIdHex: string; newEpoch: string; keyGeneration: string }
  | { kind: "proposal"; packageId: string; orgId: string; epoch: string; nonce: string; chainIdHex: string; actionType: number; payloadHex: string }
export interface FrostPublicKeyPackage {
  network: "sui:testnet"; sessionId: string; participantAddresses: string[]; dealerAddresses: string[]; threshold: string; sessionEpoch: string
  commitments: string[]; groupPk: string; keyPackageId: string
}
export interface FrostRequest { version: 1; requestId: string; contextHash: string; action: FrostAction; keyPackage: FrostPublicKeyPackage; signers: FrostSigner[]; coordinator: string; expiresAtMs: number; signature: string }
export interface FrostRound1 { version: 1; requestId: string; contextHash: string; address: string; index: string; hiding: string; binding: string; signature: string }
export interface FrostTranscript { version: 1; requestId: string; contextHash: string; round1: FrostRound1[]; transcriptHash: string; coordinator: string; signature: string }
export interface FrostRound2 { version: 1; requestId: string; contextHash: string; transcriptHash: string; address: string; index: string; scalar: string; signature: string }
export interface FrostSigningResult { requestId: string; contextHash: string; transcriptHash: string; action: FrostAction; signature: Uint8Array; groupPk: Uint8Array; digest: Uint8Array; signerIndices: bigint[] }
export interface ProtocolAuth { sign(bytes: Uint8Array): Promise<{ signature: string }>; verify(bytes: Uint8Array, signature: string, address: string): Promise<void> }

export class FrostSessionError extends Error {}
const encoder = new TextEncoder()
const hex = (bytes: Uint8Array) => toHex(bytes)
function unhex(value: string, length?: number): Uint8Array {
  if (!/^(?:[0-9a-f]{2})*$/.test(value) || (length !== undefined && value.length !== length * 2)) throw new FrostSessionError("Invalid canonical lowercase hex")
  return fromHex(value)
}
function json(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(json).join(",")}]`
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${json(v)}`).join(",")}}`
  return JSON.stringify(value)
}
const unsigned = <T extends { signature: string }>(value: T) => ({ ...value, signature: "" })
const normalized = (address: string) => {
  if (!/^0x[\da-fA-F]{1,64}$/.test(address)) throw new FrostSessionError("Invalid Sui address")
  const norm = normalizeSuiAddress(address)
  if (!isValidSuiAddress(norm)) throw new FrostSessionError("Invalid Sui address")
  return norm
}
const addressAt = (key: DeviceKeyPackage, index: bigint) => {
  if (index < 1n || index > BigInt(key.participantAddresses.length)) throw new FrostSessionError("FROST index outside participant roster")
  return normalized(key.participantAddresses[Number(index - 1n)])
}
const identifier = (index: bigint) => {
  if (index < 1n || index > BigInt(Number.MAX_SAFE_INTEGER)) throw new FrostSessionError("Invalid FROST participant index")
  return ed25519_FROST.Identifier.fromNumber(Number(index))
}
function publicPackage(key: DeviceKeyPackage): FrostPublicKeyPackage {
  validateDeviceKeyPackage(key)
  const pkg = toPublicKeyPackage(key)
  return { network: pkg.network, sessionId: pkg.sessionId, participantAddresses: pkg.participantAddresses, dealerAddresses: pkg.dealerAddresses, threshold: pkg.threshold.toString(), sessionEpoch: pkg.sessionEpoch.toString(), commitments: pkg.commitments.map(hex), groupPk: hex(pkg.groupPk), keyPackageId: pkg.keyPackageId }
}
function actionDigest(action: FrostAction): Uint8Array {
  if (action.kind === "proposal") {
    if (!Number.isInteger(action.actionType) || action.actionType < 0 || action.actionType > 255) throw new FrostSessionError("Proposal actionType must be a u8")
    return computeProposalDigest(unhex(action.chainIdHex), action.orgId, BigInt(action.epoch), BigInt(action.nonce), unhex(action.payloadHex), action.actionType)
  }
  if (action.kind === "epoch") return computeThresholdApprovalDigest(unhex(action.chainIdHex), action.orgId, BigInt(action.epoch), BigInt(action.nonce), BigInt(action.newEpoch), BigInt(action.keyGeneration))
  return computeRosterUpdateDigest(unhex(action.chainIdHex), action.orgId, BigInt(action.epoch), BigInt(action.nonce), BigInt(action.newEpoch), BigInt(action.thresholdWeight), action.members, action.weights.map(BigInt))
}
function validateAction(action: FrostAction): void {
  normalized(action.orgId)
  normalized(action.packageId)
  if (!/^(?:[\da-f]{2})*$/.test(action.chainIdHex)) throw new FrostSessionError("chainIdHex must be lowercase even-length hex")
  for (const value of [action.epoch, action.nonce, ...(action.kind === "roster" ? [action.newEpoch, action.thresholdWeight, ...action.weights] : action.kind === "epoch" ? [action.newEpoch, action.keyGeneration] : [])]) {
    if (!/^(0|[1-9]\d*)$/.test(value) || BigInt(value) > (1n << 64n) - 1n) throw new FrostSessionError("Action integer fields must be canonical u64 decimal strings")
  }
  if (action.kind !== "proposal" && BigInt(action.newEpoch) !== BigInt(action.epoch) + 1n) throw new FrostSessionError("Organization epoch transition must increment exactly once")
  if (action.kind === "proposal") { if (!Number.isInteger(action.actionType) || action.actionType < 0 || action.actionType > 255) throw new FrostSessionError("proposal actionType must be a u8"); unhex(action.payloadHex) }
  if (action.kind === "roster") {
    if (action.members.length !== action.weights.length || action.members.length === 0 || action.members.length > 1000) throw new FrostSessionError("Roster member and weight lengths are invalid")
    action.members.forEach(normalized); action.priorMembers.forEach(normalized)
    if (new Set(action.members).size !== action.members.length || new Set(action.priorMembers).size !== action.priorMembers.length) throw new FrostSessionError("Roster members must be unique")
    if (action.weights.some(weight => BigInt(weight) === 0n)) throw new FrostSessionError("Roster weights must be positive")
    if (BigInt(action.thresholdWeight) === 0n) throw new FrostSessionError("Roster threshold must be positive")
  }
}
function contextFor(input: Omit<FrostRequest, "contextHash" | "signature">): string { return hex(sha256(encoder.encode(json(input)))) }
export function frostProtocolMessage(value: { signature: string }): Uint8Array { return encoder.encode(`SUI_FROST_PROTOCOL_V1:${json(unsigned(value))}`) }
function signable(value: { signature: string }) { return frostProtocolMessage(value) }
async function authenticate(value: { signature: string }, signature: string, address: string, verify: ProtocolAuth["verify"], options: { allowEmptySignature?: boolean } = {}): Promise<void> {
  if (!signature && options.allowEmptySignature !== true) throw new FrostSessionError("Wallet returned an empty FROST signature")
  await verify(signable(value), signature, address)
}
async function signMessage(value: { signature: string }, address: string, auth: ProtocolAuth): Promise<string> {
  const signature = (await auth.sign(signable(value))).signature
  await authenticate(value, signature, address, auth.verify)
  return signature
}

export async function createFrostRequest(input: { action: FrostAction; key: BoundDeviceKey; signerIndices: bigint[]; coordinator: string; expiresAtMs: number }, auth: ProtocolAuth): Promise<FrostRequest> {
  const pkg = publicPackage(input.key)
  validateAction(input.action)
  if (normalized(input.action.orgId) !== normalized(input.key.orgId) || BigInt(input.action.epoch) !== input.key.epoch) throw new FrostSessionError("Action organization or epoch does not match bound key")
  if (input.action.packageId !== input.key.orgId && input.action.packageId.length !== 66) throw new FrostSessionError("Invalid action package ID")
  if (!/^[0-9a-f]{64}$/.test(input.key.creationDigest)) throw new FrostSessionError("Bound key creation digest must be canonical 32-byte hex")
  const indices = input.signerIndices
  if (indices.length < Number(input.key.threshold) || indices.length > input.key.participantAddresses.length || new Set(indices.map(String)).size !== indices.length) throw new FrostSessionError("Signer set below threshold or contains duplicates")
  if (indices.some(i => i < 1n || i > BigInt(input.key.participantAddresses.length))) throw new FrostSessionError("Signer index outside roster")
  const signers = indices.map(index => ({ address: addressAt(input.key, index), index: index.toString() })).sort((a, b) => BigInt(a.index) < BigInt(b.index) ? -1 : 1)
  const coordinator = normalized(input.coordinator)
  if (!Number.isSafeInteger(input.expiresAtMs) || input.expiresAtMs <= Date.now()) throw new FrostSessionError("Request expiry must be in the future")
  actionDigest(input.action)
  const requestId = hex(crypto.getRandomValues(new Uint8Array(32)))
  const base = { version: 1 as const, requestId, action: input.action, keyPackage: pkg, signers, coordinator, expiresAtMs: input.expiresAtMs }
  const contextHash = contextFor(base)
  const unsignedRequest = { ...base, contextHash, signature: "" }
  const signature = await signMessage(unsignedRequest, coordinator, auth)
  return { ...unsignedRequest, signature }
}

export function parseFrostRequest(jsonText: string): FrostRequest {
  const value: unknown = JSON.parse(jsonText)
  if (!value || typeof value !== "object") throw new FrostSessionError("Invalid FROST request")
  const r = value as FrostRequest
  if (r.version !== 1 || typeof r.signature !== "string" || !/^[0-9a-f]{64}$/.test(r.requestId) || !/^[0-9a-f]{64}$/.test(r.contextHash) || !Array.isArray(r.signers) || !r.keyPackage) throw new FrostSessionError("Invalid FROST request shape")
  validateAction(r.action)
  if (contextFor({ version: r.version, requestId: r.requestId, action: r.action, keyPackage: r.keyPackage, signers: r.signers, coordinator: r.coordinator, expiresAtMs: r.expiresAtMs }) !== r.contextHash) throw new FrostSessionError("FROST request context hash mismatch")
  return r
}
export async function verifyFrostRequest(request: FrostRequest, verify: ProtocolAuth["verify"], options: { allowExpired?: boolean } = {}): Promise<void> {
  if (request.version !== 1 || !/^[0-9a-f]{64}$/.test(request.requestId) || !/^[0-9a-f]{64}$/.test(request.contextHash) || !Number.isSafeInteger(request.expiresAtMs) || (!options.allowExpired && Date.now() >= request.expiresAtMs)) throw new FrostSessionError("Invalid or expired FROST request")
  validateAction(request.action)
  const { signature: _signature, contextHash: _contextHash, ...base } = request
  if (contextFor(base) !== request.contextHash) throw new FrostSessionError("FROST request context hash mismatch")
  normalized(request.action.packageId)
  const keyPackage = request.keyPackage
  validatePublicKeyPackage({ network: keyPackage.network, sessionId: keyPackage.sessionId, participantAddresses: keyPackage.participantAddresses, dealerAddresses: keyPackage.dealerAddresses, threshold: BigInt(keyPackage.threshold), sessionEpoch: BigInt(keyPackage.sessionEpoch), commitments: keyPackage.commitments.map(c => unhex(c, 32)), groupPk: unhex(keyPackage.groupPk, 32), keyPackageId: keyPackage.keyPackageId })
  if (!Array.isArray(request.signers) || request.signers.length < Number(keyPackage.threshold) || request.signers.length > keyPackage.participantAddresses.length) throw new FrostSessionError("FROST signer set below threshold or exceeds roster")
  let previous = 0n
  for (const entry of request.signers) {
    if (!/^[1-9][0-9]*$/.test(entry.index)) throw new FrostSessionError("Non-canonical signer index")
    const index = BigInt(entry.index)
    if (index <= previous || index > BigInt(keyPackage.participantAddresses.length) || normalized(entry.address) !== normalized(keyPackage.participantAddresses[Number(index - 1n)])) throw new FrostSessionError("Invalid, unsorted or misbound signer address/index")
    previous = index
  }
  if (normalized(request.coordinator) !== request.coordinator) throw new FrostSessionError("Coordinator address must be canonical")
  await authenticate(unsigned(request), request.signature, request.coordinator, verify)
}

function validateRequestKey(request: FrostRequest, key: DeviceKeyPackage): void {
  if ("orgId" in key && typeof key.orgId === "string" && "epoch" in key && typeof key.epoch === "bigint" && (normalized(request.action.orgId) !== normalized(key.orgId) || BigInt(request.action.epoch) !== key.epoch)) throw new FrostSessionError("FROST request action does not match the bound organization or epoch")
  if (request.keyPackage.keyPackageId !== key.keyPackageId || request.keyPackage.network !== key.network || request.keyPackage.sessionId !== key.sessionId || request.keyPackage.groupPk !== hex(key.groupPk) || request.keyPackage.threshold !== key.threshold.toString() || request.keyPackage.sessionEpoch !== key.sessionEpoch.toString() || JSON.stringify(request.keyPackage.participantAddresses) !== JSON.stringify(key.participantAddresses.map(normalized)) || JSON.stringify(request.keyPackage.dealerAddresses) !== JSON.stringify(key.dealerAddresses.map(normalized))) throw new FrostSessionError("FROST request key package mismatch")
  publicPackage(key)
}
function signer(request: FrostRequest, key: DeviceKeyPackage): FrostSigner {
  validateRequestKey(request, key)
  const address = addressAt(key, key.index)
  const found = request.signers.find(s => s.index === key.index.toString())
  if (!found || normalized(found.address) !== address || normalized(key.holder) !== address) throw new FrostSessionError("Local device is not the bound signer at this index")
  return found
}
function nonceId(request: FrostRequest, index: string) { return `${request.keyPackage.keyPackageId}:${request.contextHash}:${index}` }
const storeFrom = (options?: { store?: FrostSessionStore }) => options?.store ?? defaultFrostSessionStore
const vaultFrom = (options?: { vault?: DeviceVault }) => options?.vault ?? defaultDeviceVault

/**
 * Sealing happens at the caller boundary so the store's read-modify-write
 * transaction stays synchronous and atomic: the nonce burn is committed before
 * any signing, and only the sealed box ever reaches IndexedDB. The AAD context
 * is the nonce record id, which already binds key package, request context and
 * signer index, so a sealed box cannot be replayed against another request.
 */
async function sealNonceMaterial(hiding: Uint8Array, binding: Uint8Array, context: string, vault: DeviceVault): Promise<FrostNonceMaterial> {
  if (hiding.length !== 32 || binding.length !== 32) throw new FrostSessionError("FROST nonce material must be two 32-byte scalars")
  const plaintext = new Uint8Array(64)
  plaintext.set(hiding, 0)
  plaintext.set(binding, 32)
  return { sealed: await vault.seal(plaintext, context) }
}

async function openNonceMaterial(material: FrostNonceMaterial, context: string, vault: DeviceVault): Promise<{ hiding: Uint8Array; binding: Uint8Array }> {
  if (!("sealed" in material)) return material
  const plaintext = await vault.open(material.sealed, context)
  if (plaintext.length !== 64) throw new FrostSessionError(t("dkg.nonceLengthInvalid"))
  return { hiding: plaintext.slice(0, 32), binding: plaintext.slice(32) }
}

export async function prepareFrostCommitment(request: FrostRequest, key: BoundDeviceKey, options: { store?: FrostSessionStore; vault?: DeviceVault; auth: ProtocolAuth }): Promise<FrostRound1> {
  await verifyFrostRequest(request, options.auth.verify)
  const s = signer(request, key)
  const shareBytes = ed25519_FROST.utils.Fn.toBytes(key.share)
  const secret = { identifier: identifier(key.index), signingShare: shareBytes }
  let commitment: FrostRound1
  if (key.threshold === 1n) {
    const hiding = scalarToBytes32(randomScalar()); const binding = scalarToBytes32(randomScalar())
    commitment = { version: 1, requestId: request.requestId, contextHash: request.contextHash, address: s.address, index: s.index, hiding: hex(ed25519.Point.BASE.multiply(bytesToScalar(hiding)).toBytes()), binding: hex(ed25519.Point.BASE.multiply(bytesToScalar(binding)).toBytes()), signature: "" }
    const store = storeFrom(options); const id = nonceId(request, s.index)
    const prepared = await store.prepare({ id, round1: commitment, nonces: await sealNonceMaterial(hiding, binding, id, vaultFrom(options)), consumed: false })
    const signed = prepared.signature ? prepared : await store.publishRound1(id, { ...prepared, signature: await signMessage(prepared, s.address, options.auth) })
    await rememberFrostSession({ request, round1: [signed], round2: [], updatedAtMs: Date.now() }, { store })
    return signed
  }
  const generated = ed25519_FROST.commit(secret)
  commitment = { version: 1, requestId: request.requestId, contextHash: request.contextHash, address: s.address, index: s.index, hiding: hex(generated.commitments.hiding), binding: hex(generated.commitments.binding), signature: "" }
  const store = storeFrom(options); const id = nonceId(request, s.index)
  const prepared = await store.prepare({ id, round1: commitment, nonces: await sealNonceMaterial(generated.nonces.hiding, generated.nonces.binding, id, vaultFrom(options)), consumed: false })
  const signed = prepared.signature ? prepared : await store.publishRound1(id, { ...prepared, signature: (await options.auth.sign(signable(prepared))).signature })
  await rememberFrostSession({ request, round1: [signed], round2: [], updatedAtMs: Date.now() }, { store })
  return signed
}

export async function verifyFrostRound1(request: FrostRequest, round: FrostRound1, verify: ProtocolAuth["verify"], options: { allowEmptySignature?: boolean } = {}): Promise<void> {
  if (round.version !== 1 || round.requestId !== request.requestId || round.contextHash !== request.contextHash) throw new FrostSessionError("Round 1 has wrong request context")
  if (!/^[1-9][0-9]*$/.test(round.index)) throw new FrostSessionError("Round 1 index is not canonical")
  const allowed = request.signers.find(s => s.index === round.index)
  if (!allowed || normalized(allowed.address) !== normalized(round.address) || normalized(round.address) !== round.address) throw new FrostSessionError("Round 1 identity/index mismatch")
  unhex(round.hiding, 32); unhex(round.binding, 32)
  const hiding = ed25519.Point.fromBytes(unhex(round.hiding, 32)); const binding = ed25519.Point.fromBytes(unhex(round.binding, 32))
  hiding.assertValidity(); binding.assertValidity()
  if (hiding.is0() || binding.is0() || !hiding.isTorsionFree() || !binding.isTorsionFree()) throw new FrostSessionError("Round 1 point is not a valid prime-order point")
  await authenticate(unsigned(round), round.signature, allowed.address, verify, options)
}
export async function createFrostTranscript(request: FrostRequest, round1: FrostRound1[], auth: ProtocolAuth, store: FrostSessionStore = defaultFrostSessionStore): Promise<FrostTranscript> {
  await verifyFrostRequest(request, auth.verify)
  if (round1.length !== request.signers.length) throw new FrostSessionError("Transcript requires exactly one commitment from every fixed signer")
  const byIndex = new Map<string, FrostRound1>()
  for (const r of round1) { await verifyFrostRound1(request, r, auth.verify); if (byIndex.has(r.index)) throw new FrostSessionError("Duplicate FROST round-1 signer"); byIndex.set(r.index, r) }
  const ordered = request.signers.map(s => byIndex.get(s.index))
  if (ordered.some(x => !x)) throw new FrostSessionError("Missing fixed signer commitment")
  const base = { version: 1 as const, requestId: request.requestId, contextHash: request.contextHash, round1: ordered as FrostRound1[], coordinator: request.coordinator }
  const transcriptHash = hex(sha256(encoder.encode(json(base))))
  const message = { ...base, transcriptHash, signature: "" }
  const transcript = { ...message, signature: await signMessage(message, request.coordinator, auth) }
  await rememberFrostSession({ request, round1: transcript.round1, transcript, round2: [], updatedAtMs: Date.now() }, { store })
  return transcript
}
export async function verifyFrostTranscript(request: FrostRequest, transcript: FrostTranscript, verify: ProtocolAuth["verify"]): Promise<void> {
  return verifyTranscript(request, transcript, verify)
}
async function verifyTranscript(request: FrostRequest, transcript: FrostTranscript, verify: ProtocolAuth["verify"], options: { allowExpired?: boolean } = {}): Promise<void> {
  if (transcript.requestId !== request.requestId || transcript.contextHash !== request.contextHash || transcript.coordinator !== request.coordinator) throw new FrostSessionError("Transcript request context mismatch")
  const base = { version: transcript.version, requestId: transcript.requestId, contextHash: transcript.contextHash, round1: transcript.round1, coordinator: transcript.coordinator }
  if (hex(sha256(encoder.encode(json(base)))) !== transcript.transcriptHash) throw new FrostSessionError("Transcript hash mismatch")
  await verifyFrostRequest(request, verify, options)
  if (transcript.round1.length !== request.signers.length || transcript.version !== 1) throw new FrostSessionError("Transcript signer set incomplete")
  for (let i = 0; i < transcript.round1.length; i++) { if (transcript.round1[i].index !== request.signers[i].index) throw new FrostSessionError("Transcript signer set/order mismatch"); await verifyFrostRound1(request, transcript.round1[i], verify) }
  await authenticate(unsigned(transcript), transcript.signature, request.coordinator, verify)
}
export async function produceFrostShare(request: FrostRequest, transcript: FrostTranscript, key: BoundDeviceKey, options: { store?: FrostSessionStore; vault?: DeviceVault; auth: ProtocolAuth }): Promise<FrostRound2> {
  await verifyFrostTranscript(request, transcript, options.auth.verify)
  const s = signer(request, key)
  const own = transcript.round1.find(r => r.index === s.index)
  if (!own) throw new FrostSessionError("No local round-1 commitment in transcript")
  const nonceContext = nonceId(request, s.index)
  const consumed = await storeFrom(options).consume(nonceContext, own, transcript.transcriptHash)
  if (consumed.kind === "cached") return consumed.round2
  // The burn above has already committed; opening the sealed box afterwards keeps
  // the store transaction free of async gaps and cannot re-spend a burned nonce.
  const nonces = await openNonceMaterial(consumed.nonces, nonceContext, vaultFrom(options))
  const digest = actionDigest(request.action)
  let scalar: Uint8Array
  if (key.threshold === 1n) {
    if (transcript.round1.length !== 1 || hex(ed25519.Point.BASE.multiply(key.share).toBytes()) !== hex(key.groupPk)) throw new FrostSessionError("Single-share scalar does not directly produce group public key")
    // RFC 8032 verification is an equation over the raw Ed25519 scalar. Noble's
    // ed25519.sign accepts a 32-byte seed (and hashes/clamps it), not a scalar,
    // so implement the deterministic Schnorr equation directly for this 1-of-1 path.
    const nonce = bytesToScalar(nonces.hiding)
    const R = ed25519.Point.BASE.multiply(nonce)
    if (hex(R.toBytes()) !== own.hiding || hex(ed25519.Point.BASE.multiply(bytesToScalar(nonces.binding)).toBytes()) !== own.binding) throw new FrostSessionError("1-of-1 nonce pair does not match published commitments")
    const challenge = mod(bytesToScalar(sha512(new Uint8Array([...R.toBytes(), ...key.groupPk, ...digest]))))
    const signature = new Uint8Array(64)
    signature.set(R.toBytes())
    signature.set(scalarToBytes32(mod(nonce + challenge * key.share)), 32)
    scalar = signature
  } else {
    const commitments = transcript.round1.map(r => ({ identifier: identifier(BigInt(r.index)), hiding: unhex(r.hiding, 32), binding: unhex(r.binding, 32) }))
    const pub = toNobleFrostPublic(key)
    scalar = ed25519_FROST.signShare({ identifier: identifier(key.index), signingShare: ed25519_FROST.utils.Fn.toBytes(key.share) }, pub, nonces, commitments, digest)
  }
  const message = { version: 1 as const, requestId: request.requestId, contextHash: request.contextHash, transcriptHash: transcript.transcriptHash, address: s.address, index: s.index, scalar: hex(scalar), signature: "" }
  const result = { ...message, signature: await signMessage(message, s.address, options.auth) }
  await storeFrom(options).saveRound2(nonceId(request, s.index), result)
  await rememberFrostSession({ request, round1: transcript.round1, transcript, round2: [result], updatedAtMs: Date.now() }, { store: storeFrom(options) })
  return result
}
export async function verifyFrostRound2(request: FrostRequest, transcript: FrostTranscript, round: FrostRound2, verify: ProtocolAuth["verify"], options: { allowEmptySignature?: boolean } = {}): Promise<void> {
  if (round.version !== 1 || round.requestId !== request.requestId || round.contextHash !== request.contextHash || round.transcriptHash !== transcript.transcriptHash) throw new FrostSessionError("Round 2 has wrong request or transcript context")
  if (!/^[1-9][0-9]*$/.test(round.index)) throw new FrostSessionError("Round 2 index is not canonical")
  const allowed = request.signers.find(s => s.index === round.index)
  if (!allowed || normalized(allowed.address) !== normalized(round.address) || normalized(round.address) !== round.address) throw new FrostSessionError("Round 2 identity/index mismatch")
  const scalar = unhex(round.scalar)
  if (request.keyPackage.threshold === "1" ? scalar.length !== 64 : scalar.length !== 32) throw new FrostSessionError("Invalid FROST signature-share length")
  if (request.keyPackage.threshold !== "1") {
    const fn = ed25519_FROST.utils.Fn
    if (scalar.length !== fn.BYTES || fn.fromBytes(scalar).toString() === fn.ORDER.toString()) throw new FrostSessionError("Invalid signature share scalar")
    const pub = toNobleFrostPublic({ network: request.keyPackage.network, sessionId: request.keyPackage.sessionId, participantAddresses: request.keyPackage.participantAddresses, dealerAddresses: request.keyPackage.dealerAddresses, threshold: BigInt(request.keyPackage.threshold), sessionEpoch: BigInt(request.keyPackage.sessionEpoch), commitments: request.keyPackage.commitments.map(c => unhex(c, 32)), groupPk: unhex(request.keyPackage.groupPk, 32), keyPackageId: request.keyPackage.keyPackageId })
    const commitments = transcript.round1.map(r => ({ identifier: identifier(BigInt(r.index)), hiding: unhex(r.hiding, 32), binding: unhex(r.binding, 32) }))
    if (!ed25519_FROST.verifyShare(pub, commitments, actionDigest(request.action), identifier(BigInt(round.index)), scalar)) throw new FrostSessionError("FROST share verification failed")
  }
  await authenticate(unsigned(round), round.signature, allowed.address, verify, options)
}
export async function aggregateFrostSession(request: FrostRequest, transcript: FrostTranscript, shares: FrostRound2[], verify: ProtocolAuth["verify"]): Promise<FrostSigningResult> {
  return aggregateSession(request, transcript, shares, verify)
}
/** Verification only for an existing receipt: never accesses a nonce or signs. */
export async function aggregateFrostSessionForReceiptRecovery(request: FrostRequest, transcript: FrostTranscript, shares: FrostRound2[], verify: ProtocolAuth["verify"]): Promise<FrostSigningResult> {
  return aggregateSession(request, transcript, shares, verify, { allowExpired: true })
}
async function aggregateSession(request: FrostRequest, transcript: FrostTranscript, shares: FrostRound2[], verify: ProtocolAuth["verify"], options: { allowExpired?: boolean } = {}): Promise<FrostSigningResult> {
  await verifyTranscript(request, transcript, verify, options)
  if (shares.length !== request.signers.length) throw new FrostSessionError("Aggregate requires exactly one share from each fixed signer")
  const byIndex = new Map<string, FrostRound2>()
  for (const share of shares) { await verifyFrostRound2(request, transcript, share, verify); if (byIndex.has(share.index)) throw new FrostSessionError("Duplicate FROST round-2 share"); byIndex.set(share.index, share) }
  const ordered = request.signers.map(s => byIndex.get(s.index))
  if (ordered.some(x => !x)) throw new FrostSessionError("Missing fixed signer share")
  const digest = actionDigest(request.action)
  let signature: Uint8Array
  if (request.keyPackage.threshold === "1") signature = unhex(ordered[0]!.scalar, 64)
  else {
    const commitments = transcript.round1.map(r => ({ identifier: identifier(BigInt(r.index)), hiding: unhex(r.hiding, 32), binding: unhex(r.binding, 32) }))
    const pub = toNobleFrostPublic({ network: request.keyPackage.network, sessionId: request.keyPackage.sessionId, participantAddresses: request.keyPackage.participantAddresses, dealerAddresses: request.keyPackage.dealerAddresses, threshold: BigInt(request.keyPackage.threshold), sessionEpoch: BigInt(request.keyPackage.sessionEpoch), commitments: request.keyPackage.commitments.map(c => unhex(c, 32)), groupPk: unhex(request.keyPackage.groupPk, 32), keyPackageId: request.keyPackage.keyPackageId })
    const sharesById: Record<string, Uint8Array> = Object.fromEntries(ordered.map(s => [identifier(BigInt(s!.index)), unhex(s!.scalar, 32)]))
    signature = ed25519_FROST.aggregate(pub, commitments, digest, sharesById)
  }
  if (!ed25519.verify(signature, digest, unhex(request.keyPackage.groupPk, 32))) throw new FrostSessionError("Final Ed25519 signature verification failed")
  return { requestId: request.requestId, contextHash: request.contextHash, transcriptHash: transcript.transcriptHash, action: request.action, signature, groupPk: unhex(request.keyPackage.groupPk, 32), digest, signerIndices: ordered.map(s => BigInt(s!.index)) }
}
