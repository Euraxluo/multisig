"use client"

import { t } from "@/lib/i18n/t"
import { getIdentity, identityConfigured, type IdentityProfile } from "./identity-client"
import { readPrivateMessageHistory, sendPrivateMessage } from "./private-messages"
import { verifyFrostRequest, verifyFrostRound1, verifyFrostRound2, verifyFrostTranscript, type FrostRequest, type FrostRound1, type FrostRound2, type FrostTranscript } from "./frost-session"
import { verifyProtocolMessage } from "./wallet-personal-signing"

const PREFIX = "sui-frost-round-v1:"
const encoder = new TextEncoder()
export const FROST_PRIVATE_MESSAGE_MAX_BYTES = 1000
export type FrostPrivateRound = FrostRound1 | FrostRound2
export interface CompactFrostRound { round: FrostPrivateRound; authenticatedAddress: string }
export interface FrostPeerHistory { peerId: string; rounds: CompactFrostRound[]; truncated: boolean; scannedEvents: number; unavailableReason?: string }
export interface FrostPrivateTransportOptions { resolveIdentity?: (id: string) => Promise<IdentityProfile>; sendMessage?: typeof sendPrivateMessage; readHistory?: typeof readPrivateMessageHistory; isConfigured?: () => boolean; verify?: (bytes: Uint8Array, signature: string, address: string) => Promise<void> }

function hex(value: unknown): value is string { return typeof value === "string" && /^(?:[0-9a-f]{2})+$/.test(value) }
function canonicalAddress(value: unknown): value is string { return typeof value === "string" && /^0x[0-9a-f]{64}$/.test(value) }

/**
 * The identity event authenticates the transport sender; the round signature is
 * retained as a second, standard FROST protocol-authentication boundary so a
 * received round can be fed back into the ordinary transcript/aggregate gates.
 */
export function encodeFrostPrivateRound(round: FrostPrivateRound): string {
  let tuple: unknown[]
  if (round.version !== 1 || !/^[0-9a-f]{64}$/.test(round.requestId) || !/^[0-9a-f]{64}$/.test(round.contextHash) || !/^(0|[1-9]\d*)$/.test(round.index) || !canonicalAddress(round.address) || typeof round.signature !== "string" || !round.signature) throw new Error("FROST compact DM requires a canonical signed round envelope.")
  if ("hiding" in round) {
    if (!hex(round.hiding) || !hex(round.binding) || round.hiding.length !== 64 || round.binding.length !== 64) throw new Error("Invalid compact FROST commitment points.")
    tuple = [1, round.requestId, round.contextHash, round.index, round.hiding, round.binding, round.signature]
  } else {
    if (!/^[0-9a-f]{64}$/.test(round.transcriptHash) || !hex(round.scalar)) throw new Error("Invalid compact FROST signature share.")
    tuple = [2, round.requestId, round.contextHash, round.transcriptHash, round.index, round.scalar, round.signature]
  }
  const text = PREFIX + JSON.stringify(tuple)
  if (encoder.encode(text).length > FROST_PRIVATE_MESSAGE_MAX_BYTES) throw new Error(t("dkg.dmTooLong"))
  return text
}

export function decodeFrostPrivateRound(text: string, authenticatedAddress: string): CompactFrostRound {
  if (typeof text !== "string" || encoder.encode(text).length > FROST_PRIVATE_MESSAGE_MAX_BYTES || !canonicalAddress(authenticatedAddress) || !text.startsWith(PREFIX)) throw new Error(t("dkg.dmInvalid"))
  let v: unknown
  try { v = JSON.parse(text.slice(PREFIX.length)) } catch { throw new Error(t("dkg.invalidRoundJson")) }
  if (!Array.isArray(v)) throw new Error(t("dkg.invalidRoundShape"))
  let round: FrostPrivateRound
  if (v.length === 7 && v[0] === 1 && v.slice(1).every(x => typeof x === "string")) {
    const [, requestId, contextHash, index, hiding, binding, signature] = v as string[]
    round = { version: 1, requestId, contextHash, address: authenticatedAddress, index, hiding, binding, signature }
    // Re-encoding rejects whitespace, extra JSON forms, and non-canonical data.
    if (encodeFrostPrivateRound(round) !== text) throw new Error("FROST compact round is not canonical.")
  } else if (v.length === 7 && v[0] === 2 && v.slice(1).every(x => typeof x === "string")) {
    const [, requestId, contextHash, transcriptHash, index, scalar, signature] = v as string[]
    round = { version: 1, requestId, contextHash, transcriptHash, address: authenticatedAddress, index, scalar, signature }
    if (encodeFrostPrivateRound(round) !== text) throw new Error("FROST compact round is not canonical.")
  } else throw new Error("Unsupported or malformed FROST compact round.")
  return { round, authenticatedAddress }
}

export function createFrostPrivateTransport(options: FrostPrivateTransportOptions = {}) {
  const resolveIdentity = options.resolveIdentity ?? getIdentity
  const sendMessage = options.sendMessage ?? sendPrivateMessage
  const readHistory = options.readHistory ?? readPrivateMessageHistory
  const isConfigured = options.isConfigured ?? identityConfigured
  const verifyMessage = options.verify ?? verifyProtocolMessage

  async function list(input: { request: FrostRequest; transcript?: FrostTranscript; me: IdentityProfile; peers: IdentityProfile[] }): Promise<FrostPeerHistory[]> {
    if (!isConfigured()) return input.peers.map(peer => ({ peerId: peer.id, rounds: [], truncated: false, scannedEvents: 0, unavailableReason: t("dkg.identityNotConfigured") }))
    await verifyFrostRequest(input.request, verifyMessage)
    if (input.transcript) await verifyFrostTranscript(input.request, input.transcript, verifyMessage)
    return Promise.all(input.peers.map(async peer => {
      let history: Awaited<ReturnType<typeof readPrivateMessageHistory>> | undefined
      try {
        history = await readHistory(input.me, peer)
        const rounds: CompactFrostRound[] = []
        for (const message of history.messages) {
          if (message.unavailableReason) throw new Error(t("dkg.dmReadFailed", { reason: message.unavailableReason }))
          if (!message.text?.startsWith(PREFIX)) continue
          const outgoing = message.senderId === input.me.id && message.recipientId === peer.id
          const incoming = message.senderId === peer.id && message.recipientId === input.me.id
          if (!outgoing && !incoming) throw new Error(t("dkg.notInConversation"))
          const authenticatedProfile = await resolveIdentity(message.senderId)
          const expectedAddress = outgoing ? input.me.address : peer.address
          if (authenticatedProfile.id !== message.senderId || authenticatedProfile.address.toLowerCase() !== expectedAddress.toLowerCase()) throw new Error(t("dkg.senderMismatch"))
          const decoded = decodeFrostPrivateRound(message.text, authenticatedProfile.address)
          if (decoded.round.requestId !== input.request.requestId || decoded.round.contextHash !== input.request.contextHash) continue
          const allowed = input.request.signers.find(s => s.index === decoded.round.index)
          if (!allowed || allowed.address.toLowerCase() !== decoded.authenticatedAddress.toLowerCase()) throw new Error(t("dkg.roundIdentityMismatch"))
          if ("hiding" in decoded.round) await verifyFrostRound1(input.request, decoded.round, verifyMessage)
          else {
            if (!input.transcript) throw new Error(t("dkg.transcriptMissingVerify"))
            await verifyFrostRound2(input.request, input.transcript, decoded.round, verifyMessage)
          }
          const prior = rounds.find(r => r.round.index === decoded.round.index && ("hiding" in r.round) === ("hiding" in decoded.round))
          if (prior) {
            if (JSON.stringify(prior.round) !== JSON.stringify(decoded.round)) throw new Error(t("dkg.roundConflict"))
            continue
          }
          rounds.push(decoded)
        }
        return { peerId: peer.id, rounds, truncated: history.truncated, scannedEvents: history.scannedEvents }
      } catch (error) {
        return { peerId: peer.id, rounds: [], truncated: history?.truncated ?? false, scannedEvents: history?.scannedEvents ?? 0, unavailableReason: error instanceof Error ? error.message : t("dkg.dmUnavailable") }
      }
    }))
  }

  async function send(input: { request: FrostRequest; round: FrostPrivateRound; transcript?: FrostTranscript; sender: IdentityProfile; recipient: IdentityProfile; userClickConfirmed: true }): Promise<void> {
    if (input.userClickConfirmed !== true) throw new Error(t("dkg.clickRequired"))
    if (!isConfigured()) throw new Error(t("dkg.identityNotConfiguredSend"))
    await verifyFrostRequest(input.request, verifyMessage)
    const allowed = input.request.signers.find(s => s.index === input.round.index)
    if (!allowed || allowed.address.toLowerCase() !== input.sender.address.toLowerCase() || input.round.requestId !== input.request.requestId || input.round.contextHash !== input.request.contextHash) throw new Error(t("dkg.roundRequestMismatch"))
    if ("hiding" in input.round) await verifyFrostRound1(input.request, input.round, verifyMessage)
    else {
      if (!input.transcript) throw new Error(t("dkg.transcriptMissingSend"))
      await verifyFrostTranscript(input.request, input.transcript, verifyMessage)
      await verifyFrostRound2(input.request, input.transcript, input.round, verifyMessage)
    }
    const wireRound = { ...input.round } as FrostPrivateRound
    const text = encodeFrostPrivateRound(wireRound)
    await sendMessage(input.sender, input.recipient, text)
  }

  return { list, send }
}

export const frostPrivateTransport = createFrostPrivateTransport()
