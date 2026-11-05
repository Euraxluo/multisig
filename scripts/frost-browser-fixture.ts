import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { verifyPersonalMessageSignature } from "@mysten/sui/verify"
import { ed25519, ed25519_FROST } from "@noble/curves/ed25519.js"
import { publicKeyPackageId } from "../lib/dkg-key-package"
import {
  aggregateFrostSession, createFrostRequest, createFrostTranscript, prepareFrostCommitment,
  produceFrostShare, type BoundDeviceKey, type FrostRound1, type FrostRound2,
  type FrostTranscript, type ProtocolAuth,
} from "../lib/frost-session"
import {
  createIndexedDbFrostSessionStore, type FrostNonceRecord, type FrostSessionRecord,
  type FrostSessionStore,
} from "../lib/frost-session-store"
import { defaultDeviceVault } from "../lib/crypto/device-vault"
import { planRosterChange, type LiveOrganization } from "../lib/group-roster"
import { createRosterFrostAction, submitFrostRosterChange } from "../lib/group-roster-transactions"
import { listRosterSessions, recoverRosterSessionReceipt, restoreRosterSession } from "../lib/group-roster-session"
import { createPendingTransaction, getPendingTransaction, updatePendingTransaction } from "../lib/pending-transactions"

// Local browser persistence acceptance only. No chain reads, transactions, or
// extension wallet APIs. Wallet secrets/shares stay in JS memory; only the
// production store persists its isolated fixture nonces and public progress.
type Counts = Record<string, number>
type PublicState = {
  prefix: string
  live: LiveOrganization
  record: FrostSessionRecord
  alternate?: FrostTranscript
}
type Peer = {
  publicState(): PublicState
  key(index: number): BoundDeviceKey
  sign(index: number, bytes: Uint8Array): Promise<{ signature: string }>
  signatures(): number
  round1(value: FrostRound1): void
  transcript(value: FrostTranscript, alternate?: boolean): void
  round2(value: FrostRound2): void
  raceGate(): Promise<void>
}
type Result = { ok: true; counts: Counts } | { ok: false; check: string; errorName: string }
type Input = { participant?: number }

declare global {
  interface Window {
    frostBrowser: { run(action: string, input?: Input): Promise<Result> }
    frostFixturePeer?: Peer
  }
}

class CheckError extends Error {}
function check(condition: unknown, name: string): asserts condition {
  if (!condition) throw new CheckError(name)
}
const hex = (bytes: Uint8Array) => Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("")
const randomId = () => `0x${hex(crypto.getRandomValues(new Uint8Array(32)))}`
const verify: ProtocolAuth["verify"] = async (bytes, signature, address) => {
  await verifyPersonalMessageSignature(bytes, signature, { address })
}
function peer(): Peer {
  const value = window.frostFixturePeer ?? (window.opener as Window | null)?.frostFixturePeer
  check(value, "keeper-tab-missing")
  return value
}
// structuredClone creates this tab's typed arrays instead of sharing objects
// across realms. Neither this method nor any secret is exposed to the runner.
const state = () => structuredClone(peer().publicState())
const device = (index: number) => structuredClone(peer().key(index))
const stores = new Map<string, FrostSessionStore>()
function databaseName(index: number) { return `${state().prefix}-signer-${index + 1}` }
function store(index: number): FrostSessionStore {
  const name = databaseName(index)
  if (!stores.has(name)) stores.set(name, createIndexedDbFrostSessionStore({ databaseName: name }))
  return stores.get(name)!
}
const auth = (index: number): ProtocolAuth => ({ sign: bytes => peer().sign(index, bytes), verify })
function noSigningAuth() {
  let attempts = 0
  return {
    auth: { verify, async sign() { attempts++; throw new CheckError("unexpected-signature-request") } } satisfies ProtocolAuth,
    attempts: () => attempts,
  }
}
function transcriptOf(record: FrostSessionRecord): FrostTranscript {
  check(record.transcript, "transcript-missing")
  return record.transcript
}
function nonceId(record: FrostSessionRecord, index = 0) {
  return `${record.request.keyPackage.keyPackageId}:${record.request.contextHash}:${index + 1}`
}
async function rejected(operation: () => Promise<unknown>, expected?: RegExp | string) {
  try { await operation() } catch (error) {
    check(!(error instanceof CheckError), "unexpected-fixture-check-in-rejection")
    check(error instanceof Error, "rejection-must-be-error")
    if (expected instanceof RegExp) check(expected.test(error.message), "unexpected-rejection-message")
    if (typeof expected === "string") check(error.name === expected, "unexpected-rejection-type")
    return
  }
  throw new CheckError("operation-unexpectedly-succeeded")
}
function publicOnly(value: unknown): void {
  if (!value || typeof value !== "object") return
  for (const [key, child] of Object.entries(value)) {
    check(!["nonces", "share", "secretKey", "privateKey", "signingShare", "secretShares"].includes(key), "private-field-in-public-recovery")
    publicOnly(child)
  }
}

async function initialize(): Promise<Counts> {
  check(!window.opener, "initialize-must-use-keeper-tab")
  const wallets = [Ed25519Keypair.generate(), Ed25519Keypair.generate()]
  const participants = wallets.map(wallet => wallet.toSuiAddress())
  const identifiers = [1, 2].map(index => ed25519_FROST.Identifier.fromNumber(index))
  const dealer = ed25519_FROST.trustedDealer({ min: 2, max: 2 }, identifiers)
  const metadata = {
    network: "sui:testnet" as const, sessionId: randomId(), participantAddresses: participants,
    dealerAddresses: participants, threshold: 2n, sessionEpoch: 7n, commitments: dealer.public.commitments,
  }
  const orgId = randomId()
  const keys: BoundDeviceKey[] = participants.map((holder, index) => ({
    ...metadata, holder, index: BigInt(index + 1),
    share: ed25519_FROST.utils.Fn.fromBytes(dealer.secretShares[identifiers[index]].signingShare),
    groupPk: metadata.commitments[0], keyPackageId: publicKeyPackageId(metadata),
    orgId, epoch: 7n, creationDigest: hex(crypto.getRandomValues(new Uint8Array(32))),
  }))
  let signatures = 0
  const sign = async (index: number, bytes: Uint8Array) => {
    signatures++
    return { signature: (await wallets[index].signPersonalMessage(new Uint8Array(bytes))).signature }
  }
  const live: LiveOrganization = {
    orgId, epoch: 7n, lastNonce: 9n, groupPk: keys[0].groupPk, chainId: new TextEncoder().encode("sui-testnet:"),
    thresholdWeight: 2n, members: participants.map(address => ({ address, weight: 1n })),
  }
  const plan = planRosterChange(live, { members: live.members.map(member => ({ ...member, weight: 2n })), thresholdWeight: 3n })
  const request = await createFrostRequest({
    action: createRosterFrostAction(live, plan), key: keys[0], signerIndices: [1n, 2n],
    coordinator: participants[0], expiresAtMs: Date.now() + 600_000,
  }, { sign: bytes => sign(0, bytes), verify })
  const shared: PublicState = {
    prefix: `frost-browser-${crypto.randomUUID()}`, live,
    record: { request, round1: [], round2: [], updatedAtMs: Date.now() },
  }
  const waiters: Array<() => void> = []
  window.frostFixturePeer = {
    publicState: () => shared,
    key: index => keys[index],
    sign, signatures: () => signatures,
    round1(value) {
      shared.record.round1 = [...shared.record.round1.filter(round => round.index !== value.index), structuredClone(value)]
        .sort((a, b) => Number(a.index) - Number(b.index))
    },
    transcript(value, alternate = false) {
      if (alternate) shared.alternate = structuredClone(value)
      else shared.record.transcript = structuredClone(value)
    },
    round2(value) {
      shared.record.round2 = [...shared.record.round2.filter(round => round.index !== value.index), structuredClone(value)]
        .sort((a, b) => Number(a.index) - Number(b.index))
    },
    raceGate: () => new Promise<void>(resolve => {
      waiters.push(resolve)
      if (waiters.length === 2) for (const release of waiters) release()
    }),
  }
  return { participants: participants.length, threshold: 2, signatureCalls: signatures }
}

// Read real IDB records solely to assert the durable shape. No secret record is
// ever returned to Playwright or the Node process, including on failure.
async function inspect(index: number): Promise<Counts> {
  const name = databaseName(index)
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(name, 1)
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const db = open.result
      const tx = db.transaction(["nonces", "sessions"], "readonly")
      const nonces = tx.objectStore("nonces").getAll()
      const sessions = tx.objectStore("sessions").getAll()
      tx.onabort = () => { db.close(); reject(tx.error ?? new CheckError("inspection-aborted")) }
      tx.oncomplete = () => {
        db.close()
        const records = nonces.result as FrostNonceRecord[]
        resolve({
          nonceRecords: records.length,
          consumedRecords: records.filter(value => value.consumed).length,
          usableNonceRecords: records.filter(value => value.nonces !== undefined).length,
          cachedRound2Records: records.filter(value => value.round2 !== undefined).length,
          publicSessionRecords: sessions.result.length,
        })
      }
    }
  })
}
async function assertBurned(index: number, cached: boolean): Promise<Counts> {
  const counts = await inspect(index)
  check(counts.nonceRecords === 1 && counts.consumedRecords === 1 && counts.usableNonceRecords === 0, "nonce-burn-not-durable")
  check(counts.cachedRound2Records === Number(cached), "unexpected-round-two-cache-count")
  return counts
}

async function prepare(participant: number): Promise<Counts> {
  const { record } = state()
  const round = await prepareFrostCommitment(record.request, device(participant), { store: store(participant), auth: auth(participant) })
  peer().round1(round)
  return { publicRound1: 1 }
}
async function createTranscript(): Promise<Counts> {
  const { record } = state()
  peer().transcript(await createFrostTranscript(record.request, record.round1, auth(0), store(0)))
  return { publicRound1: record.round1.length }
}
async function produce(participant: number): Promise<Counts> {
  const { record } = state()
  peer().round2(await produceFrostShare(record.request, transcriptOf(record), device(participant), { store: store(participant), auth: auth(participant) }))
  return { publicRound2: 1 }
}
async function rememberComplete(): Promise<Counts> {
  const { record } = state()
  check(record.round1.length === 2 && record.round2.length === 2, "incomplete-public-session")
  publicOnly(record)
  await store(0).remember({ ...record, updatedAtMs: Date.now() })
  return { publicRound1: record.round1.length, publicRound2: record.round2.length, signatureCalls: peer().signatures() }
}
async function restoreAggregate(): Promise<Counts> {
  const { record, live } = state()
  const before = peer().signatures()
  const verified: Counts = { request: 0, round1: 0, transcript: 0, round2: 0 }
  const tracked: ProtocolAuth["verify"] = async (bytes, signature, address) => {
    await verify(bytes, signature, address)
    const message = JSON.parse(new TextDecoder().decode(bytes).slice("SUI_FROST_PROTOCOL_V1:".length))
    const kind = "keyPackage" in message ? "request" : "round1" in message ? "transcript" : "hiding" in message ? "round1" : "round2"
    verified[kind]++
  }
  const discovered = await listRosterSessions(live.orgId, record.request.coordinator, store(0))
  check(discovered.length === 1, "public-session-not-discovered")
  const restored = await restoreRosterSession({
    requestId: record.request.requestId, live, holder: record.request.coordinator, verify: tracked, store: store(0),
  })
  publicOnly(restored)
  check(verified.request > 0 && verified.round1 >= 2 && verified.transcript > 0 && verified.round2 === 2, "restore-did-not-reauthenticate-all-public-rounds")
  check(restored.round1.length === 2 && restored.round2.length === 2, "restored-round-count-mismatch")
  const result = await aggregateFrostSession(restored.request, transcriptOf(restored), restored.round2, verify)
  check(result.signature.length === 64 && ed25519.verify(result.signature, result.digest, live.groupPk), "restored-aggregate-ed25519-verification-failed")
  check(peer().signatures() === before, "restore-requested-another-signature")
  return {
    publicSessions: discovered.length, publicRound1: restored.round1.length, publicRound2: restored.round2.length,
    requestAuthentications: verified.request, round1Authentications: verified.round1,
    transcriptAuthentications: verified.transcript, round2Authentications: verified.round2,
    ed25519Verified: 1, signatureBytes: result.signature.length, additionalSignatures: 0,
  }
}
async function seedReceipt(): Promise<Counts> {
  await rememberComplete()
  const { live, record } = state()
  check(record.request.action.kind === "roster", "receipt-action-must-be-roster")
  const action = record.request.action
  const result = await aggregateFrostSession(record.request, transcriptOf(record), record.round2, verify)
  let acknowledgments = 0
  let executions = 0
  const confirmed: LiveOrganization = { ...live, epoch: BigInt(action.newEpoch), lastNonce: BigInt(action.nonce), thresholdWeight: BigInt(action.thresholdWeight), members: action.members.map((address, index) => ({ address, weight: BigInt(action.weights[index]) })) }
  let reads = 0
  await submitFrostRosterChange(live, { members: confirmed.members, thresholdWeight: confirmed.thresholdWeight }, record.request, result, {
    getAccount: () => ({ address: record.request.coordinator, type: "wallet", provider: "local-receipt-fixture" }),
    ensureFunction: async () => {}, readLive: async () => ++reads === 1 ? live : confirmed,
    readDeviceKey: async () => null, adoptEpoch: () => false,
    execute: async (_tx, options) => {
      executions++
      check(options?.expectedAccount, "receipt-options-missing")
      const receipt = createPendingTransaction({ account: options.expectedAccount, action: options.action, scope: options.scope, network: "testnet", metadata: options.metadata }, "local-receipt-fixture-digest")
      const success = updatePendingTransaction(receipt, { status: "success" })
      return { digest: success.digest!, createdObjects: [], receipt: success }
    },
    // Leave the successful receipt unacknowledged to model interruption before
    // local completion. The chain/wallet boundary is injected, never executed.
    acknowledge: () => { acknowledgments++ },
  })
  check(executions === 1 && acknowledgments === 1, "receipt-seed-did-not-pass-production-binding")
  return { injectedExecutions: executions, persistedReceipts: 1 }
}

async function recoverReceipt(): Promise<Counts> {
  const { live, record } = state()
  check(record.request.action.kind === "roster", "receipt-action-must-be-roster")
  const action = record.request.action
  const account = { address: record.request.coordinator, type: "wallet", provider: "local-receipt-fixture" }
  const before = peer().signatures()
  const calls: string[] = []
  const originalNow = Date.now
  Date.now = () => record.request.expiresAtMs
  try {
    const recovered = await recoverRosterSessionReceipt({
      orgId: live.orgId, requestId: record.request.requestId, store: store(0), verify,
      dependencies: {
        getAccount: () => account,
        execute: async () => { throw new CheckError("receipt-recovery-executed-transaction") },
        ensureFunction: async () => { throw new CheckError("receipt-recovery-entered-fresh-submission") },
        resume: async input => {
          check(typeof input !== "string" && input.digest === "local-receipt-fixture-digest", "receipt-recovery-wrong-digest")
          calls.push("resume")
          return { digest: input.digest, createdObjects: [], receipt: input }
        },
        readLive: async () => ({ ...live, epoch: BigInt(action.newEpoch), lastNonce: BigInt(action.nonce), thresholdWeight: BigInt(action.thresholdWeight), members: action.members.map((address, index) => ({ address, weight: BigInt(action.weights[index]) })) }),
        readDeviceKey: async () => null,
        adoptEpoch: () => { calls.push("adopt"); return false },
      },
    })
    check(recovered.digest === "local-receipt-fixture-digest" && calls.join(",") === "resume,adopt", "receipt-recovery-order-or-digest-mismatch")
    check(!getPendingTransaction({ account, network: "testnet", action: "group-roster-update", scope: `${live.orgId}:${action.epoch}` }), "receipt-recovery-did-not-acknowledge")
    await rejected(() => restoreRosterSession({ requestId: record.request.requestId, live, holder: account.address, verify, store: store(0) }), /expired/)
    check(peer().signatures() === before, "receipt-recovery-requested-signature")
    return { expiredRequests: 1, originalDigestsResumed: 1, acknowledgedReceipts: 1, additionalSignatures: 0, ...(await assertBurned(0, true)) }
  } finally { Date.now = originalNow }
}

async function cached(participant: number): Promise<Counts> {
  const saved = await store(participant).restore(state().record.request.requestId)
  check(saved, "cached-public-session-missing")
  const before = peer().signatures()
  const forbidden = noSigningAuth()
  const round = await produceFrostShare(saved.request, transcriptOf(saved), device(participant), { store: store(participant), auth: forbidden.auth })
  const expected = state().record.round2.find(value => value.index === String(participant + 1))
  check(JSON.stringify(round) === JSON.stringify(expected), "cached-round-two-changed")
  check(forbidden.attempts() === 0 && peer().signatures() === before, "cached-round-two-requested-signature")
  return { ...(await assertBurned(participant, true)), additionalSignatures: 0 }
}
async function alternate(): Promise<Counts> {
  const { prefix, record } = state()
  const other = createIndexedDbFrostSessionStore({ databaseName: `${prefix}-alternate` })
  const changed = await prepareFrostCommitment(record.request, device(1), { store: other, auth: auth(1) })
  const original = record.round1.find(round => round.index === "1")
  check(original, "original-signer-commitment-missing")
  const transcript = await createFrostTranscript(record.request, [original, changed], auth(0), other)
  check(transcript.transcriptHash !== transcriptOf(record).transcriptHash, "alternate-transcript-not-distinct")
  peer().transcript(transcript, true)
  return { authenticatedAlternateTranscripts: 1 }
}
async function rejectAlternate(): Promise<Counts> {
  const { record, alternate } = state()
  check(alternate, "alternate-transcript-missing")
  const forbidden = noSigningAuth()
  await rejected(() => produceFrostShare(record.request, alternate, device(0), { store: store(0), auth: forbidden.auth }), /already consumed for another transcript/)
  check(forbidden.attempts() === 0, "alternate-transcript-requested-signature")
  return { ...(await assertBurned(0, true)), rejectedAlternateTranscripts: 1, additionalSignatures: 0 }
}
async function tamperRecovery(): Promise<Counts> {
  const { record, live, prefix } = state()
  const cases = ["request", "round1", "transcript", "round2", "missing-transcript"] as const
  for (const kind of cases) {
    const modified = structuredClone(record)
    if (kind === "request") modified.request.signature = "invalid"
    if (kind === "round1") modified.round1[0].signature = "invalid"
    if (kind === "transcript") transcriptOf(modified).signature = "invalid"
    if (kind === "round2") modified.round2[0].signature = "invalid"
    if (kind === "missing-transcript") delete modified.transcript
    const target = createIndexedDbFrostSessionStore({ databaseName: `${prefix}-tampered-${kind}` })
    await target.remember(modified)
    await rejected(() => restoreRosterSession({ requestId: record.request.requestId, live, holder: record.request.coordinator, verify, store: target }))
  }
  return { rejectedTamperedPublicSessions: cases.length }
}
async function raceConsume(): Promise<Counts> {
  const { record } = state()
  const target = store(0) // Both tabs deliberately target the same nonce DB.
  await target.list() // Open independent connections before the in-browser barrier.
  await peer().raceGate()
  let fresh = 0
  try {
    const consumed = await target.consume(nonceId(record), transcriptOf(record).round1[0], transcriptOf(record).transcriptHash)
    check(consumed.kind === "fresh", "race-returned-cached-result")
    // The burn returns the sealed box; open it with the same context the
    // signer uses, then scrub the plaintext scalars from memory as before.
    check("sealed" in consumed.nonces, "race-nonce-not-sealed")
    const material = await defaultDeviceVault.open(consumed.nonces.sealed, nonceId(record))
    check(material.length === 64, "fresh-nonce-byte-length-mismatch")
    material.fill(0)
    fresh = 1
  } catch (error) {
    check(error instanceof Error && /permanently consumed/.test(error.message), "race-loser-did-not-reject-permanent-burn")
  }
  return { ...(await assertBurned(0, false)), freshConsumers: fresh, rejectedConsumers: 1 - fresh }
}
async function recoverBurned(): Promise<Counts> {
  const { live, record } = state()
  const restored = await restoreRosterSession({ requestId: record.request.requestId, live, holder: record.request.coordinator, verify, store: store(0) })
  check(restored.round2.length === 0, "burned-session-invented-round-two")
  const forbidden = noSigningAuth()
  // Re-preparing after recovery must preserve the tombstone, even though the
  // production helper generates a new candidate nonce in memory.
  await prepareFrostCommitment(restored.request, device(0), { store: store(0), auth: forbidden.auth })
  await rejected(() => produceFrostShare(restored.request, transcriptOf(restored), device(0), { store: store(0), auth: forbidden.auth }), /permanently consumed/)
  check(forbidden.attempts() === 0, "burned-recovery-requested-signature")
  return { ...(await assertBurned(0, false)), rejectedNonceRevivals: 1, additionalSignatures: 0 }
}

// Factory wrappers are explicit fault injection around real Chromium IDB. They
// do not implement storage, nonce consumption, or any production store method.
function injectedFactory(mode: "failed-open" | "closed-connection" | "abort-write", counts: Counts): IDBFactory {
  return new Proxy(indexedDB, {
    get(target, property) {
      if (property === "open") return (name: string, version?: number) => {
        if (mode === "failed-open") {
          counts.injectedOpenFailures++
          throw new DOMException("Injected IDBFactory denial for local browser acceptance", "SecurityError")
        }
        const request = target.open(name, version)
        request.addEventListener("success", () => {
          const db = request.result
          if (mode === "closed-connection") { counts.closedConnections++; db.close(); return }
          const transaction = db.transaction.bind(db)
          Object.defineProperty(db, "transaction", { value: (...args: Parameters<IDBDatabase["transaction"]>) => {
            const tx = transaction(...args)
            if (args[1] === "readwrite") {
              const objectStore = tx.objectStore.bind(tx)
              Object.defineProperty(tx, "objectStore", { value: (name: string) => {
                const object = objectStore(name)
                const put = object.put.bind(object)
                Object.defineProperty(object, "put", { configurable: true, value: (...values: Parameters<IDBObjectStore["put"]>) => {
                  const write = put(...values)
                  counts.abortedWrites++
                  tx.abort() // Abort a real transaction after its write was queued.
                  return write
                } })
                return object
              } })
            }
            return tx
          } })
        }, { once: true })
        return request
      }
      const value = Reflect.get(target, property, target)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
}
async function failedOpen(): Promise<Counts> {
  const counts = { injectedOpenFailures: 0 }
  const target = createIndexedDbFrostSessionStore({ databaseName: `${state().prefix}-denied`, indexedDB: injectedFactory("failed-open", counts) })
  await rejected(() => target.list(), "SecurityError")
  const forbidden = noSigningAuth()
  await rejected(() => prepareFrostCommitment(state().record.request, device(0), { store: target, auth: forbidden.auth }), "SecurityError")
  check(counts.injectedOpenFailures > 0 && forbidden.attempts() === 0, "failed-open-did-not-surface-before-signing")
  return { ...counts, rejectedOperations: 2, additionalSignatures: 0 }
}
async function closedConnection(): Promise<Counts> {
  const counts = { closedConnections: 0 }
  const target = createIndexedDbFrostSessionStore({ databaseName: `${state().prefix}-closed`, indexedDB: injectedFactory("closed-connection", counts) })
  await rejected(() => target.list(), "InvalidStateError")
  const forbidden = noSigningAuth()
  await rejected(() => prepareFrostCommitment(state().record.request, device(0), { store: target, auth: forbidden.auth }), "InvalidStateError")
  check(counts.closedConnections === 1 && forbidden.attempts() === 0, "closed-idb-connection-did-not-surface-before-signing")
  return { ...counts, rejectedOperations: 2, additionalSignatures: 0 }
}
async function abortWrite(): Promise<Counts> {
  const counts = { abortedWrites: 0 }
  const target = createIndexedDbFrostSessionStore({ databaseName: databaseName(0), indexedDB: injectedFactory("abort-write", counts) })
  const { record } = state()
  const forbidden = noSigningAuth()
  await rejected(() => produceFrostShare(record.request, transcriptOf(record), device(0), { store: target, auth: forbidden.auth }), /transaction aborted/)
  check(counts.abortedWrites === 1 && forbidden.attempts() === 0, "aborted-consume-returned-or-requested-signature")
  const afterAbort = await inspect(0)
  check(afterAbort.usableNonceRecords === 1 && afterAbort.consumedRecords === 0 && afterAbort.cachedRound2Records === 0, "aborted-burn-was-not-rolled-back")
  // A failed transaction must not be mistaken for a completed burn. A normal
  // production call may still consume this nonce once and finish the signature.
  await produce(0)
  return { ...counts, ...(await assertBurned(0, true)), rejectedOperations: 1, signatureRequestsBeforeAbort: 0 }
}

const actions: Record<string, (input: Input) => Promise<Counts>> = {
  initialize,
  prepare: input => prepare(input.participant ?? 0),
  transcript: createTranscript,
  produce: input => produce(input.participant ?? 0),
  rememberComplete, restoreAggregate, seedReceipt, recoverReceipt,
  cached: input => cached(input.participant ?? 0),
  alternate, rejectAlternate, tamperRecovery, raceConsume, recoverBurned,
  failedOpen, closedConnection, abortWrite,
}
window.frostBrowser = {
  async run(action, input = {}) {
    try {
      check(Object.hasOwn(actions, action), "unknown-fixture-action")
      return { ok: true, counts: await actions[action](input) }
    } catch (error) {
      // Do not serialize library errors or assertion operands: secrets must not
      // escape through failed-test diagnostics, console output, or artifacts.
      return {
        ok: false, check: error instanceof CheckError ? error.message : "fixture-operation-rejected",
        errorName: error instanceof Error ? error.name : "UnknownError",
      }
    }
  },
}
