import "fake-indexeddb/auto"
import assert from "node:assert/strict"
import { test } from "node:test"
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { MultiSigPublicKey } from "@mysten/sui/multisig"
import { ed25519, ed25519_FROST } from "@noble/curves/ed25519.js"
import { verifyPersonalMessageSignature } from "@mysten/sui/verify"
import {
  encodeFrostPrivateRound, decodeFrostPrivateRound, FROST_PRIVATE_MESSAGE_MAX_BYTES,
  createFrostPrivateTransport, type FrostPrivateRound, type FrostPrivateTransportOptions,
  type FrostPeerHistory,
} from "./frost-private-transport"
import {
  createFrostRequest, prepareFrostCommitment, frostProtocolMessage, verifyFrostRound1,
  createFrostTranscript, verifyFrostTranscript, produceFrostShare, aggregateFrostSession,
  type BoundDeviceKey, type FrostRound1, type FrostRound2, type FrostTranscript, type ProtocolAuth,
} from "./frost-session"
import { createMemoryFrostSessionStore } from "./frost-session-store"
import { publicKeyPackageId } from "./dkg-key-package"
import type { IdentityProfile } from "./identity-client"
import type { PrivateMessage } from "./private-messages"
import { generateMessageKey, publicKeyBytes, sealMessage, openMessage, type SealedMessage } from "./message-crypto"

const address = () => Ed25519Keypair.generate().toSuiAddress()
const verify: ProtocolAuth["verify"] = async (bytes, signature, address) => {
  await verifyPersonalMessageSignature(bytes, signature, { address })
}

function signingIdentity(memberCount = 1) {
  const wallets = Array.from({ length: memberCount }, () => Ed25519Keypair.generate())
  const publicKey = memberCount === 1 ? wallets[0].getPublicKey() : MultiSigPublicKey.fromPublicKeys({
    threshold: memberCount,
    publicKeys: wallets.map(wallet => ({ publicKey: wallet.getPublicKey(), weight: 1 })),
  })
  const auth: ProtocolAuth = {
    verify,
    sign: async bytes => {
      const signatures = await Promise.all(wallets.map(async wallet => (await wallet.signPersonalMessage(bytes)).signature))
      return { signature: publicKey instanceof MultiSigPublicKey ? publicKey.combinePartialSignatures(signatures) : signatures[0] }
    },
  }
  return { address: publicKey.toSuiAddress(), auth }
}

// Local integration only: real FROST, wallet signatures and encrypted message
// envelopes, with injected in-memory identity/history/send I/O. No network E2E,
// deployed identity objects, wallet UI, RPC requests, or transactions are exercised.
async function fixture(options: { threshold?: number; indices?: number[]; firstIdentityMembers?: number } = {}) {
  const threshold = options.threshold ?? 2
  const identities = [signingIdentity(options.firstIdentityMembers), signingIdentity(), signingIdentity()]
  const participantAddresses = identities.map(identity => identity.address)
  const identifiers = identities.map((_, i) => ed25519_FROST.Identifier.fromNumber(i + 1))
  // A trusted dealer supplies test key shares; this does not exercise DKG.
  const dealer = ed25519_FROST.trustedDealer({ min: threshold, max: identities.length }, identifiers)
  const metadata = {
    network: "sui:testnet" as const, sessionId: address(), participantAddresses,
    dealerAddresses: participantAddresses, threshold: BigInt(threshold), sessionEpoch: 7n,
    commitments: dealer.public.commitments,
  }
  const keyPackageId = publicKeyPackageId(metadata), orgId = address()
  const devices = await Promise.all(identities.map(async (identity, i) => {
    const messagingKey = await generateMessageKey()
    const profile: IdentityProfile = {
      id: address(), address: identity.address, label: `device-${i + 1}`, displayName: `Device ${i + 1}`,
      avatarUrl: "", encryptionKey: Array.from(await publicKeyBytes(messagingKey.publicKey)),
      followingTable: address(), followingCount: 0,
    }
    const key: BoundDeviceKey = {
      ...structuredClone(metadata), holder: identity.address, index: BigInt(i + 1),
      share: ed25519_FROST.utils.Fn.fromBytes(dealer.secretShares[identifiers[i]].signingShare),
      groupPk: metadata.commitments[0].slice(), keyPackageId, orgId, epoch: 7n, creationDigest: "00".repeat(32),
    }
    return { profile, key, auth: identity.auth, store: createMemoryFrostSessionStore(), messagingKey }
  }))
  const signers = (options.indices ?? [1, 3]).map(index => devices[index - 1])
  const coordinator = signers[0]
  const request = await createFrostRequest({
    action: { kind: "epoch", packageId: address(), orgId, epoch: "7", nonce: "2", chainIdHex: "33".repeat(32), newEpoch: "8", keyGeneration: "1" },
    key: coordinator.key, signerIndices: signers.map(device => device.key.index), coordinator: coordinator.profile.address,
    expiresAtMs: Date.now() + 300_000,
  }, coordinator.auth)
  const profiles = new Map(devices.map(device => [device.profile.id, device.profile]))
  const events: Array<Omit<PrivateMessage, "text" | "unavailableReason"> & { sealed: SealedMessage }> = []
  const io = { sends: 0, reads: 0, resolutions: 0 }
  const sendMessage: NonNullable<FrostPrivateTransportOptions["sendMessage"]> = async (sender, recipient, text) => {
    io.sends++
    const sealed = await sealMessage(text, new Uint8Array(sender.encryptionKey), new Uint8Array(recipient.encryptionKey), { senderId: sender.id, recipientId: recipient.id })
    events.push({ id: `local-${events.length}`, senderId: sender.id, recipientId: recipient.id, timestampMs: events.length + 1, sealed })
  }
  const readHistory: NonNullable<FrostPrivateTransportOptions["readHistory"]> = async (me, peer) => {
    io.reads++
    const device = devices.find(device => device.profile.id === me.id)
    if (!device) throw new Error("Unknown local device")
    const messages: PrivateMessage[] = []
    for (const event of events) {
      if (!((event.senderId === me.id && event.recipientId === peer.id) || (event.senderId === peer.id && event.recipientId === me.id))) continue
      const { sealed, ...fields } = event
      const message: PrivateMessage = { ...fields, text: null }
      try {
        message.text = await openMessage(sealed, device.messagingKey.privateKey, fields, event.senderId === me.id ? "from" : "to")
      } catch { message.unavailableReason = "Local encrypted history could not be decrypted" }
      messages.push(message)
    }
    return { messages, truncated: false, scannedEvents: events.length }
  }
  const transport = (overrides: FrostPrivateTransportOptions = {}) => createFrostPrivateTransport({
    isConfigured: () => true, verify, sendMessage, readHistory,
    resolveIdentity: async id => {
      io.resolutions++
      const profile = profiles.get(id)
      if (!profile) throw new Error("Unknown identity")
      return profile
    },
    ...overrides,
  })
  return { request, devices, signers, coordinator, profiles, events, io, sendMessage, readHistory, transport }
}
type Fixture = Awaited<ReturnType<typeof fixture>>

async function exchange(f: Fixture, rounds: FrostPrivateRound[], transcript?: FrostTranscript) {
  const transport = f.transport()
  for (const peer of f.signers.slice(1)) {
    const ownRound = rounds.find(round => round.index === f.coordinator.key.index.toString())!
    const peerRound = rounds.find(round => round.index === peer.key.index.toString())!
    await transport.send({ request: f.request, round: ownRound, transcript, sender: f.coordinator.profile, recipient: peer.profile, userClickConfirmed: true })
    await transport.send({ request: f.request, round: peerRound, transcript, sender: peer.profile, recipient: f.coordinator.profile, userClickConfirmed: true })
  }
}

function collect(histories: FrostPeerHistory[], round: 1): FrostRound1[]
function collect(histories: FrostPeerHistory[], round: 2): FrostRound2[]
function collect(histories: FrostPeerHistory[], round: 1 | 2): FrostPrivateRound[] {
  const byIndex = new Map<string, FrostPrivateRound>()
  for (const history of histories) {
    assert.equal(history.unavailableReason, undefined)
    for (const entry of history.rounds) {
      assert.equal(entry.authenticatedAddress, entry.round.address)
      if (("hiding" in entry.round) === (round === 1)) {
        const prior = byIndex.get(entry.round.index)
        if (prior) assert.deepEqual(prior, entry.round)
        byIndex.set(entry.round.index, entry.round)
      }
    }
  }
  return [...byIndex.values()]
}

async function listed(f: Fixture, transcript?: FrostTranscript) {
  return f.transport().list({ request: f.request, transcript, me: f.coordinator.profile, peers: f.signers.slice(1).map(device => device.profile) })
}

async function roundOne(f: Fixture) {
  const rounds = await Promise.all(f.signers.map(device => prepareFrostCommitment(f.request, device.key, device)))
  await exchange(f, rounds)
  const received = collect(await listed(f), 1)
  assert.equal(received.length, f.signers.length)
  const transcript = await createFrostTranscript(f.request, received.reverse(), f.coordinator.auth, f.coordinator.store)
  return { rounds, transcript }
}

function assertUnavailable(history: FrostPeerHistory, reason: RegExp) {
  assert.equal(history.rounds.length, 0)
  assert.match(history.unavailableReason ?? "", reason)
}

const unsignedRound = (who = address()): FrostRound1 => ({
  version: 1, requestId: "11".repeat(32), contextHash: "22".repeat(32), address: who,
  index: "1", hiding: "66".repeat(32), binding: "77".repeat(32), signature: "codec-only-signature",
})

test("codec encodes canonical compact tuples for both rounds without changing signed bytes", () => {
  const first = unsignedRound()
  const second: FrostRound2 = { version: 1, requestId: first.requestId, contextHash: first.contextHash, address: first.address, index: first.index, transcriptHash: "88".repeat(32), scalar: "99".repeat(32), signature: first.signature }
  for (const original of [first, second]) {
    const text = encodeFrostPrivateRound(original)
    const decoded = decodeFrostPrivateRound(text, original.address)
    assert.deepEqual(decoded.round, original)
    assert.deepEqual(frostProtocolMessage(decoded.round), frostProtocolMessage(original))
  }
  assert.equal(encodeFrostPrivateRound(first), `sui-frost-round-v1:[1,"${first.requestId}","${first.contextHash}","1","${first.hiding}","${first.binding}","${first.signature}"]`)
})

test("codec rejects noncanonical data, empty signatures, unauthenticated addresses and oversized UTF-8", () => {
  const original = unsignedRound(), text = encodeFrostPrivateRound(original)
  const variants = [text.replace("[1,", "[1, "), text.replace(/\]$/, ",null]"), text.replace(',"1",', ',"01",'), text + "x", "sui-frost-round-v1:not-json"]
  for (const input of variants) assert.throws(() => decodeFrostPrivateRound(input, original.address))
  assert.throws(() => encodeFrostPrivateRound({ ...original, signature: "" }))
  assert.throws(() => encodeFrostPrivateRound({ ...original, signature: "界".repeat(300) }), /1000/)
  assert.throws(() => decodeFrostPrivateRound(text, "0x1"))
  assert.throws(() => decodeFrostPrivateRound("x".repeat(FROST_PRIVATE_MESSAGE_MAX_BYTES + 1), original.address))
})

for (const { threshold, indices } of [{ threshold: 2, indices: [1, 3] }, { threshold: 3, indices: [1, 2, 3] }]) {
  test(`local integration (in-memory I/O, not network E2E): ${threshold}-of-3 exchanges both rounds and aggregates Ed25519`, async () => {
    const f = await fixture({ threshold, indices })
    const { transcript } = await roundOne(f)
    // A different device's store cannot supply this signer's secret nonce.
    await assert.rejects(produceFrostShare(f.request, transcript, f.coordinator.key, { auth: f.coordinator.auth, store: f.signers[1].store }), /Missing or conflicting local FROST commitment/)
    const shares = await Promise.all(f.signers.map(async device => {
      await verifyFrostTranscript(f.request, transcript, device.auth.verify)
      return produceFrostShare(f.request, structuredClone(transcript), device.key, device)
    }))
    await exchange(f, shares, transcript)
    const histories = await listed(f, transcript)
    assert.ok(histories.every(history => history.rounds.length === 4))
    const recoveredShares = collect(histories, 2)
    const result = await aggregateFrostSession(f.request, transcript, recoveredShares, verify)
    assert.equal(result.signature.length, 64)
    assert.deepEqual(result.groupPk, f.coordinator.key.groupPk)
    assert.deepEqual(result.signerIndices, indices.map(BigInt))
    assert.ok(ed25519.verify(result.signature, result.digest, result.groupPk))
    const wrongDigest = result.digest.slice(); wrongDigest[0] ^= 1
    assert.equal(ed25519.verify(result.signature, wrongDigest, result.groupPk), false)
    assert.equal(f.io.sends, (indices.length - 1) * 4)
    for (const device of f.signers) {
      const restored = await device.store.restore(f.request.requestId)
      assert.equal(restored?.transcript?.transcriptHash, transcript.transcriptHash)
      assert.deepEqual(restored?.round2.map(share => share.index), [device.key.index.toString()])
      assert.deepEqual(await produceFrostShare(f.request, transcript, device.key, device), shares.find(share => share.index === device.key.index.toString()))
    }
    for (const device of f.devices.filter(device => !f.signers.includes(device))) assert.deepEqual(await device.store.list(), [])
    // Both directions decrypt using separate, nonextractable per-device keys.
    const peer = f.signers[1]
    const peerView = await f.transport().list({ request: f.request, transcript, me: peer.profile, peers: [f.coordinator.profile] })
    assert.equal(peerView[0].rounds.length, 4)
    assert.equal(peerView[0].unavailableReason, undefined)
  })
}

test("local integration requires explicit click, configured transport and matching sender before send", async () => {
  const f = await fixture(), device = f.coordinator, peer = f.signers[1]
  const round = await prepareFrostCommitment(f.request, device.key, device)
  const input = { request: f.request, round, sender: device.profile, recipient: peer.profile, userClickConfirmed: true as const }
  await assert.rejects(f.transport().send({ ...input, userClickConfirmed: false as true }), /明确点击/)
  await assert.rejects(f.transport({ isConfigured: () => false }).send(input), /GAP/)
  await assert.rejects(f.transport().send({ ...input, sender: peer.profile }), /round 与发送者/)
  await assert.rejects(f.transport().send({ ...input, round: { ...round, address: peer.profile.address } }), /identity\/index mismatch/)
  assert.equal(f.io.sends, 0)
  const unavailable = await f.transport({ isConfigured: () => false }).list({ request: f.request, me: device.profile, peers: [peer.profile] })
  assertUnavailable(unavailable[0], /GAP/)
  assert.equal(f.io.reads, 0)
})

test("local integration preserves valid rounds and an explicit truncated-history boundary", async () => {
  const f = await fixture()
  await roundOne(f)
  const transport = f.transport({ readHistory: async (me, peer) => ({ ...await f.readHistory(me, peer), truncated: true, scannedEvents: 50 }) })
  const [history] = await transport.list({ request: f.request, me: f.coordinator.profile, peers: [f.signers[1].profile] })
  assert.equal(history.rounds.length, 2)
  assert.equal(history.unavailableReason, undefined)
  assert.equal(history.truncated, true)
  assert.equal(history.scannedEvents, 50)
})

test("local integration reports an unknown identity and isolates failure to that peer", async () => {
  const f = await fixture({ indices: [1, 2, 3] })
  await roundOne(f)
  f.profiles.delete(f.signers[1].profile.id)
  const histories = await listed(f)
  assertUnavailable(histories[0], /Unknown identity/)
  assert.equal(histories[0].scannedEvents, 4)
  assert.equal(histories[1].rounds.length, 2)
  assert.equal(histories[1].unavailableReason, undefined)
})

for (const field of ["id", "address"] as const) {
  test(`local integration rejects a resolved identity with the wrong ${field}`, async () => {
    const f = await fixture()
    await roundOne(f)
    const peer = f.signers[1].profile
    f.profiles.set(peer.id, { ...peer, [field]: address() })
    assertUnavailable((await listed(f))[0], /身份与链上认证发送方/)
  })
}

for (const direction of ["foreign sender", "foreign recipient", "self conversation"] as const) {
  test(`local integration rejects ${direction} even with a valid signer and signature`, async () => {
    const f = await fixture()
    await roundOne(f)
    const me = f.coordinator.profile, peer = f.signers[1].profile
    const alias = { ...peer, id: address() }
    f.profiles.set(alias.id, alias)
    const transport = f.transport({ readHistory: async () => {
      const history = await f.readHistory(me, peer)
      const original = history.messages[direction === "self conversation" ? 0 : 1]
      const foreign = direction === "foreign sender" ? { ...original, senderId: alias.id }
        : { ...original, recipientId: direction === "foreign recipient" ? alias.id : me.id }
      return { ...history, messages: [...history.messages, foreign] }
    } })
    const [history] = await transport.list({ request: f.request, me, peers: [peer] })
    assertUnavailable(history, /conversation|会话/)
  })
}

test("local integration fails closed on undecryptable history and retains scan metadata", async () => {
  const f = await fixture()
  await roundOne(f)
  f.events[1].sealed.nonce[0] ^= 1
  const transport = f.transport({ readHistory: async (me, peer) => ({ ...await f.readHistory(me, peer), truncated: true, scannedEvents: 77 }) })
  const [history] = await transport.list({ request: f.request, me: f.coordinator.profile, peers: [f.signers[1].profile] })
  assertUnavailable(history, /无法读取.*could not be decrypted/)
  assert.equal(history.truncated, true)
  assert.equal(history.scannedEvents, 77)
})

test("local integration requires a transcript for sending and listing round two", async () => {
  const f = await fixture(), peer = f.signers[1]
  const { transcript } = await roundOne(f)
  const round = await produceFrostShare(f.request, transcript, peer.key, peer)
  const input = { request: f.request, round, sender: peer.profile, recipient: f.coordinator.profile, userClickConfirmed: true as const }
  const sent = f.io.sends
  await assert.rejects(f.transport().send(input), /缺少已认证.*transcript/)
  assert.equal(f.io.sends, sent)
  await f.transport().send({ ...input, transcript })
  assertUnavailable((await listed(f))[0], /缺少已认证.*transcript/)
  assert.equal((await listed(f, transcript))[0].rounds.length, 3)
})

test("local integration rejects an unauthenticated transcript before sending round two or reading history", async () => {
  const f = await fixture(), peer = f.signers[1]
  const { transcript } = await roundOne(f)
  const round = await produceFrostShare(f.request, transcript, peer.key, peer)
  // Same valid commitments and transcript hash, wrong coordinator signature.
  const unauthenticated = { ...transcript, signature: f.request.signature }
  const sent = f.io.sends, reads = f.io.reads
  await assert.rejects(f.transport().send({ request: f.request, transcript: unauthenticated, round, sender: peer.profile, recipient: f.coordinator.profile, userClickConfirmed: true }), /Signature is not valid/)
  await assert.rejects(listed(f, unauthenticated), /Signature is not valid/)
  assert.equal(f.io.sends, sent)
  assert.equal(f.io.reads, reads)
})

test("local integration rejects round two bound to another valid authenticated transcript", async () => {
  const f = await fixture(), peer = f.signers[1]
  const { transcript } = await roundOne(f)
  const round = await produceFrostShare(f.request, transcript, peer.key, peer)
  const alternateRounds = await Promise.all(f.signers.map(device => prepareFrostCommitment(f.request, device.key, { auth: device.auth, store: createMemoryFrostSessionStore() })))
  const alternate = await createFrostTranscript(f.request, alternateRounds, f.coordinator.auth, createMemoryFrostSessionStore())
  await verifyFrostTranscript(f.request, alternate, verify)
  const input = { request: f.request, round, sender: peer.profile, recipient: f.coordinator.profile, userClickConfirmed: true as const }
  const sent = f.io.sends
  await assert.rejects(f.transport().send({ ...input, transcript: alternate }), /wrong request or transcript context/)
  assert.equal(f.io.sends, sent)
  await f.transport().send({ ...input, transcript })
  assertUnavailable((await listed(f, alternate))[0], /wrong request or transcript context/)
})

test("local integration deduplicates identical deliveries independently for both rounds", async () => {
  const f = await fixture(), peer = f.signers[1]
  const { rounds, transcript } = await roundOne(f)
  const round2 = await produceFrostShare(f.request, transcript, peer.key, peer)
  const duplicateRounds = [rounds.find(round => round.index === peer.key.index.toString())!, round2, round2]
  for (const round of duplicateRounds) await f.transport().send({ request: f.request, round, transcript, sender: peer.profile, recipient: f.coordinator.profile, userClickConfirmed: true })
  const [history] = await listed(f, transcript)
  assert.equal(history.unavailableReason, undefined)
  assert.equal(history.rounds.length, 3)
  assert.equal(history.scannedEvents, 5)
  assert.deepEqual(collect([history], 1), rounds)
  assert.deepEqual(collect([history], 2), [round2])
})

test("local integration rejects conflicting independently signed commitments from one participant", async () => {
  const f = await fixture(), peer = f.signers[1]
  await roundOne(f)
  const conflicting = await prepareFrostCommitment(f.request, peer.key, { auth: peer.auth, store: createMemoryFrostSessionStore() })
  await verifyFrostRound1(f.request, conflicting, verify)
  await f.transport().send({ request: f.request, round: conflicting, sender: peer.profile, recipient: f.coordinator.profile, userClickConfirmed: true })
  assertUnavailable((await listed(f))[0], /round 出现冲突/)
})

test("local integration rejects an invalid request signature before any send or history I/O", async () => {
  const f = await fixture(), device = f.coordinator
  const round = await prepareFrostCommitment(f.request, device.key, device)
  const request = { ...f.request, signature: round.signature }
  await assert.rejects(f.transport().send({ request, round, sender: device.profile, recipient: f.signers[1].profile, userClickConfirmed: true }), /Signature is not valid/)
  await assert.rejects(f.transport().list({ request, me: device.profile, peers: [f.signers[1].profile] }), /Signature is not valid/)
  assert.deepEqual(f.io, { sends: 0, reads: 0, resolutions: 0 })
})

test("local integration rejects an invalid round signature on both send and encrypted history import", async () => {
  const f = await fixture(), peer = f.signers[1]
  const { rounds } = await roundOne(f)
  const invalid = { ...rounds.find(round => round.index === peer.key.index.toString())!, signature: (await peer.auth.sign(new TextEncoder().encode("unrelated signed message"))).signature }
  const sent = f.io.sends
  await assert.rejects(f.transport().send({ request: f.request, round: invalid, sender: peer.profile, recipient: f.coordinator.profile, userClickConfirmed: true }), /Signature is not valid/)
  assert.equal(f.io.sends, sent)
  await f.sendMessage(peer.profile, f.coordinator.profile, encodeFrostPrivateRound(invalid))
  assertUnavailable((await listed(f))[0], /Signature is not valid/)
})

test("local integration rejects a mathematically invalid share despite its valid wallet signature", async () => {
  const f = await fixture(), peer = f.signers[1]
  const { transcript } = await roundOne(f)
  const round = await produceFrostShare(f.request, transcript, peer.key, peer)
  const invalid = { ...round, scalar: "00".repeat(32), signature: "" }
  invalid.signature = (await peer.auth.sign(frostProtocolMessage(invalid))).signature
  await verify(frostProtocolMessage(invalid), invalid.signature, peer.profile.address)
  const sent = f.io.sends
  await assert.rejects(f.transport().send({ request: f.request, round: invalid, transcript, sender: peer.profile, recipient: f.coordinator.profile, userClickConfirmed: true }), /share verification failed/)
  assert.equal(f.io.sends, sent)
  await f.sendMessage(peer.profile, f.coordinator.profile, encodeFrostPrivateRound(invalid))
  assertUnavailable((await listed(f, transcript))[0], /share verification failed/)
})

test("local integration filters unrelated requests and rejects a forged signer index with real verification", async () => {
  const f = await fixture(), peer = f.signers[1]
  const round = await prepareFrostCommitment(f.request, peer.key, peer)
  await f.sendMessage(peer.profile, f.coordinator.profile, "ordinary private message")
  await f.sendMessage(peer.profile, f.coordinator.profile, encodeFrostPrivateRound({ ...round, requestId: "99".repeat(32) }))
  await f.transport().send({ request: f.request, round, sender: peer.profile, recipient: f.coordinator.profile, userClickConfirmed: true })
  assert.deepEqual(collect(await listed(f), 1), [round])
  await f.sendMessage(peer.profile, f.coordinator.profile, encodeFrostPrivateRound({ ...round, index: f.coordinator.key.index.toString() }))
  assertUnavailable((await listed(f))[0], /index 与链上认证身份/)
})

test("local integration rejects an authenticated oversized multisig payload before calling send I/O", async () => {
  const f = await fixture({ firstIdentityMembers: 8 }), device = f.coordinator
  const round = await prepareFrostCommitment(f.request, device.key, device)
  // A real 8-of-8 Sui multisig produces a valid protocol signature too large for DM.
  await verifyFrostRound1(f.request, round, verify)
  assert.throws(() => encodeFrostPrivateRound(round), /1000 字节/)
  await assert.rejects(f.transport().send({ request: f.request, round, sender: device.profile, recipient: f.signers[1].profile, userClickConfirmed: true }), /1000 字节/)
  assert.equal(f.io.sends, 0)
  assert.equal(f.events.length, 0)
})
