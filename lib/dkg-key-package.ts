import { t } from "@/lib/i18n/t"
import { ed25519, ed25519_FROST } from "@noble/curves/ed25519.js"
import type { FrostPublic } from "@noble/curves/abstract/frost.js"
import { sha256 } from "@noble/hashes/sha2.js"
import { normalizeSuiAddress, toHex } from "@mysten/sui/utils"
import { CURVE_ORDER, mod, scalarToBytes32 } from "./crypto/math"

export const DEVICE_KEY_NETWORK = "sui:testnet" as const

/** Public transcript shared by every holder. Contains no signing share. */
export interface PublicKeyPackage {
  network: typeof DEVICE_KEY_NETWORK
  sessionId: string
  participantAddresses: string[]
  dealerAddresses: string[]
  threshold: bigint
  sessionEpoch: bigint
  commitments: Uint8Array[]
  groupPk: Uint8Array
  keyPackageId: string
}

export interface DeviceKeyPackage extends PublicKeyPackage {
  holder: string
  /** Position in the original participant roster, never in the qualified dealer set. */
  index: bigint
  share: bigint
}

export interface BoundDeviceKey extends DeviceKeyPackage {
  orgId: string
  epoch: bigint
  creationDigest: string
}

export interface DealerContribution {
  sessionId: string
  holder: string
  index: bigint
  commitments: Uint8Array[]
  /** Only f_i(i), never the dealer's polynomial. */
  share: bigint
}

type Point = ReturnType<typeof ed25519.Point.fromBytes>
const U64_MAX = (1n << 64n) - 1n
const hex = (bytes: Uint8Array): string => toHex(bytes)
const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((byte, i) => byte === b[i])

export function deviceKeyAddress(address: string): string {
  if (typeof address !== "string" || !/^0x[0-9a-f]{1,64}$/i.test(address)) throw new Error(t("dkg.invalidAddress"))
  return normalizeSuiAddress(address.toLowerCase())
}

export function validateKeyEpoch(epoch: bigint): void {
  if (typeof epoch !== "bigint" || epoch < 0n || epoch > U64_MAX) throw new Error(t("dkg.epochMustBeU64"))
}

function scalar(value: bigint): void {
  if (typeof value !== "bigint" || value < 0n || value >= CURVE_ORDER) throw new Error(t("dkg.shareMustBeScalar"))
}

function point(bytes: Uint8Array): Point {
  if (!(bytes instanceof Uint8Array) || bytes.length !== 32) throw new Error(t("dkg.commitmentBytes"))
  let parsed: Point
  try {
    parsed = ed25519.Point.fromBytes(bytes)
    parsed.assertValidity()
  } catch { throw new Error(t("dkg.commitmentNotCanonical")) }
  if (!sameBytes(parsed.toBytes(), bytes) || parsed.is0() || !parsed.isTorsionFree()) {
    throw new Error(t("dkg.commitmentInvalidPoint"))
  }
  return parsed
}

function evaluate(commitments: Point[], index: bigint): Point {
  let power = 1n
  let result = ed25519.Point.ZERO
  for (const commitment of commitments) {
    result = result.add(commitment.multiply(power))
    power = mod(power * index)
  }
  return result
}

function scalarPoint(share: bigint): Point {
  return share === 0n ? ed25519.Point.ZERO : ed25519.Point.BASE.multiply(share)
}

function roster(pkg: Omit<PublicKeyPackage, "keyPackageId" | "groupPk" | "commitments">): void {
  if (pkg.network !== DEVICE_KEY_NETWORK) throw new Error(t("dkg.networkUnsupported"))
  if (deviceKeyAddress(pkg.sessionId) !== pkg.sessionId) throw new Error(t("dkg.sessionNotCanonical"))
  validateKeyEpoch(pkg.sessionEpoch)
  if (!Array.isArray(pkg.participantAddresses) || pkg.participantAddresses.length === 0) throw new Error(t("dkg.emptyRoster"))
  const participants = pkg.participantAddresses
  if (participants.some(address => deviceKeyAddress(address) !== address) || new Set(participants).size !== participants.length) {
    throw new Error(t("dkg.duplicateParticipants"))
  }
  if (typeof pkg.threshold !== "bigint" || pkg.threshold < 1n || pkg.threshold > BigInt(participants.length)) throw new Error(t("dkg.invalidThreshold"))
  if (pkg.threshold === 1n && participants.length !== 1) throw new Error(t("dkg.oneOfOneOnly"))
  if (!Array.isArray(pkg.dealerAddresses) || BigInt(pkg.dealerAddresses.length) < pkg.threshold) throw new Error(t("dkg.dealersBelowThreshold"))
  let previous = -1
  for (const address of pkg.dealerAddresses) {
    const position = participants.indexOf(address)
    if (position <= previous) throw new Error(t("dkg.dealerOrderInvalid"))
    previous = position
  }
}

/** Shared metadata-only identity: excludes holder, index, secret, organization and live epoch. */
export function publicKeyPackageId(pkg: Omit<PublicKeyPackage, "keyPackageId" | "groupPk">): string {
  return hex(sha256(new TextEncoder().encode(JSON.stringify([
    "SUI_DEVICE_KEY_PACKAGE_V1", pkg.network, pkg.sessionId, pkg.participantAddresses,
    pkg.dealerAddresses, pkg.threshold.toString(), pkg.sessionEpoch.toString(), pkg.commitments.map(hex),
  ]))))
}

function validatePublic(pkg: PublicKeyPackage): Point[] {
  roster(pkg)
  if (!Array.isArray(pkg.commitments) || BigInt(pkg.commitments.length) !== pkg.threshold) throw new Error(t("dkg.commitmentCountMismatch"))
  const points = pkg.commitments.map(point)
  point(pkg.groupPk)
  if (!sameBytes(pkg.groupPk, pkg.commitments[0])) throw new Error(t("dkg.packageGroupKeyMismatch"))
  if (pkg.keyPackageId !== publicKeyPackageId(pkg)) throw new Error(t("dkg.keyPackageIdMismatch"))
  // FROST verifying shares must also be encodable as non-identity prime-order points.
  for (let i = 1; i <= pkg.participantAddresses.length; i++) point(evaluate(points, BigInt(i)).toBytes())
  return points
}

export function validatePublicKeyPackage(pkg: PublicKeyPackage): void { validatePublic(pkg) }

function noblePublic(pkg: PublicKeyPackage, points: Point[]): FrostPublic {
  const verifyingShares: Record<string, Uint8Array> = {}
  for (let i = 1; i <= pkg.participantAddresses.length; i++) {
    verifyingShares[ed25519_FROST.Identifier.fromNumber(i)] = evaluate(points, BigInt(i)).toBytes()
  }
  return {
    signers: { min: Number(pkg.threshold), max: pkg.participantAddresses.length },
    commitments: pkg.commitments.map(bytes => bytes.slice()),
    verifyingShares,
  }
}

/** Noble's public package, with identifiers 1..n from the original roster. */
export function toNobleFrostPublic(pkg: PublicKeyPackage): FrostPublic {
  return noblePublic(pkg, validatePublic(pkg))
}

export function validateDeviceKeyPackage(key: DeviceKeyPackage): void {
  const points = validatePublic(key)
  if (deviceKeyAddress(key.holder) !== key.holder) throw new Error(t("dkg.holderNotCanonical"))
  const position = key.participantAddresses.indexOf(key.holder)
  if (position < 0 || key.index !== BigInt(position + 1)) throw new Error(t("dkg.indexRosterMismatch"))
  scalar(key.share)
  if (key.share === 0n) throw new Error(t("dkg.zeroShare"))
  if (key.threshold === 1n) {
    if (!scalarPoint(key.share).equals(points[0])) throw new Error(t("dkg.oneOfOneShareMismatch"))
  } else {
    try {
      ed25519_FROST.validateSecret({
        identifier: ed25519_FROST.Identifier.fromNumber(position + 1),
        signingShare: scalarToBytes32(key.share),
      }, noblePublic(key, points))
    } catch { throw new Error(t("dkg.finalizeVerifyFailed")) }
  }
}

export function validateDealerContribution(contribution: DealerContribution): void {
  deviceKeyAddress(contribution.sessionId)
  deviceKeyAddress(contribution.holder)
  if (typeof contribution.index !== "bigint" || contribution.index <= 0n || contribution.index >= CURVE_ORDER) throw new Error(t("dkg.invalidDealerIndex"))
  scalar(contribution.share)
  if (!Array.isArray(contribution.commitments) || contribution.commitments.length === 0) throw new Error(t("dkg.emptyDealerCommitments"))
  const points = contribution.commitments.map(point)
  if (!scalarPoint(contribution.share).equals(evaluate(points, contribution.index))) throw new Error(t("dkg.dealerShareVerifyFailed"))
}

/** `dealers` is exactly the chain's frozen qualified set Q, which may omit participants. */
export function assembleDeviceKey(input: {
  sessionId: string
  holder: string
  participantAddresses: string[]
  threshold: bigint
  sessionEpoch: bigint
  dealers: Array<{ address: string; commitments: Uint8Array[]; share: bigint }>
}): DeviceKeyPackage {
  const participantAddresses = input.participantAddresses.map(deviceKeyAddress)
  const holder = deviceKeyAddress(input.holder)
  const position = participantAddresses.indexOf(holder)
  if (position < 0) throw new Error(t("dkg.holderNotInRoster"))
  const dealers = input.dealers.map(dealer => ({ ...dealer, address: deviceKeyAddress(dealer.address) }))
    .sort((a, b) => participantAddresses.indexOf(a.address) - participantAddresses.indexOf(b.address))
  const metadata = {
    network: DEVICE_KEY_NETWORK, sessionId: deviceKeyAddress(input.sessionId), participantAddresses,
    dealerAddresses: dealers.map(dealer => dealer.address), threshold: input.threshold, sessionEpoch: input.sessionEpoch,
  }
  roster(metadata)
  const index = BigInt(position + 1)
  const aggregate = Array.from({ length: Number(input.threshold) }, () => ed25519.Point.ZERO)
  let share = 0n
  for (const dealer of dealers) {
    if (BigInt(dealer.commitments.length) !== input.threshold) throw new Error(t("dkg.dealerCoeffMismatch"))
    validateDealerContribution({ sessionId: metadata.sessionId, holder, index, commitments: dealer.commitments, share: dealer.share })
    dealer.commitments.forEach((bytes, i) => { aggregate[i] = aggregate[i].add(point(bytes)) })
    share = mod(share + dealer.share)
  }
  const commitments = aggregate.map(commitment => commitment.toBytes())
  const key: DeviceKeyPackage = {
    ...metadata, holder, index, share, commitments, groupPk: commitments[0].slice(),
    keyPackageId: publicKeyPackageId({ ...metadata, commitments }),
  }
  validateDeviceKeyPackage(key)
  return key
}

/** Copies an explicit public allowlist, so accidentally passing a bound key never exports its secret. */
export function toPublicKeyPackage(key: PublicKeyPackage): PublicKeyPackage {
  validatePublicKeyPackage(key)
  return {
    network: key.network, sessionId: key.sessionId, participantAddresses: [...key.participantAddresses],
    dealerAddresses: [...key.dealerAddresses], threshold: key.threshold, sessionEpoch: key.sessionEpoch,
    commitments: key.commitments.map(bytes => bytes.slice()), groupPk: key.groupPk.slice(), keyPackageId: key.keyPackageId,
  }
}

export function serializePublicKeyPackage(key: PublicKeyPackage): string {
  const pkg = toPublicKeyPackage(key)
  return JSON.stringify({ ...pkg, threshold: pkg.threshold.toString(), sessionEpoch: pkg.sessionEpoch.toString(), commitments: pkg.commitments.map(hex), groupPk: hex(pkg.groupPk) })
}

export function parsePublicKeyPackage(serialized: string): PublicKeyPackage {
  const value: unknown = JSON.parse(serialized)
  const fields = ["network", "sessionId", "participantAddresses", "dealerAddresses", "threshold", "sessionEpoch", "commitments", "groupPk", "keyPackageId"]
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== fields.length || fields.some(field => !Object.hasOwn(value, field))) throw new Error(t("dkg.invalidPackageFields"))
  const wire = value as Record<string, unknown>
  const decimal = (item: unknown): bigint => {
    if (typeof item !== "string" || !/^(0|[1-9][0-9]*)$/.test(item)) throw new Error(t("dkg.nonCanonicalInteger"))
    return BigInt(item)
  }
  const bytes = (item: unknown): Uint8Array => {
    if (typeof item !== "string" || !/^[0-9a-f]{64}$/.test(item)) throw new Error(t("dkg.nonCanonicalPoint"))
    return Uint8Array.from(item.match(/../g)!, byte => Number.parseInt(byte, 16))
  }
  if (!Array.isArray(wire.commitments)) throw new Error(t("dkg.missingCommitments"))
  const pkg = {
    ...wire, threshold: decimal(wire.threshold), sessionEpoch: decimal(wire.sessionEpoch),
    commitments: wire.commitments.map(bytes), groupPk: bytes(wire.groupPk),
  } as unknown as PublicKeyPackage
  validatePublicKeyPackage(pkg)
  return pkg
}
