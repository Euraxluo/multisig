import "fake-indexeddb/auto"
import assert from "node:assert/strict"
import { test } from "node:test"
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { ed25519, ed25519_FROST } from "@noble/curves/ed25519.js"
import { publicKeyPackageId } from "./dkg-key-package"
import { createMemoryFrostSessionStore } from "./frost-session-store"
import { adoptLiveEpoch, clearCommitteeSession, getCommitteeSession, setCommitteeSession } from "./committee-session"
import { recoverRosterSessionReceipt } from "./group-roster-session"
import { aggregateFrostSession, createFrostRequest, createFrostTranscript, prepareFrostCommitment, produceFrostShare, verifyFrostRequest, type BoundDeviceKey, type ProtocolAuth } from "./frost-session"
import { planRosterChange, type LiveOrganization } from "./group-roster"
import { assertSameLiveRoster, assertRosterFrostRequest, createRosterFrostAction, recoverLegacyRosterReceipt, submitRosterChange, submitFrostRosterChange, type RosterFrostAction, type RosterSubmissionDependencies } from "./group-roster-transactions"
import { PROPOSAL_PACKAGE_ID } from "./proposal-chain"
import { transactionIntentKey, type PendingTransactionReceipt, type TransactionAccount } from "./pending-transactions"
import type { WalletTransactionResult } from "./sui-wallet-signer"
import { verifyProtocolMessage } from "./wallet-personal-signing"

// Ephemeral test identities; all protocol authentication uses real Sui personal
// signatures and the production verifier, with no wallet extension or network I/O.
const identities = Array.from({ length: 3 }, () => Ed25519Keypair.generate())
const participants = identities.map(identity => identity.toSuiAddress())
const orgId = "0x" + "aa".repeat(32)
const alice = participants[0]
const carol = participants[2]
const account = { type: "wallet", address: alice, provider: "test-wallet" }
function authFor(index: number): ProtocolAuth {
  return { sign: bytes => identities[index].signPersonalMessage(bytes), verify: verifyProtocolMessage }
}
const signingAuth = authFor(0)

function fixture() {
  const ids = participants.slice(0, 2).map((_, index) => ed25519_FROST.Identifier.fromNumber(index + 1))
  const dealer = ed25519_FROST.trustedDealer({ min: 2, max: 2 }, ids)
  const commitments = dealer.public.commitments
  const metadata = {
    network: "sui:testnet" as const, sessionId: "0x" + "bb".repeat(32), participantAddresses: participants,
    dealerAddresses: participants, threshold: 2n, sessionEpoch: 7n, commitments,
  }
  const keyPackageId = publicKeyPackageId(metadata)
  const keys = ids.map((id, index) => ({
    ...metadata, holder: participants[index], index: BigInt(index + 1),
    share: ed25519_FROST.utils.Fn.fromBytes(dealer.secretShares[id].signingShare),
    groupPk: commitments[0], keyPackageId, orgId, epoch: 7n, creationDigest: "00".repeat(32),
  })) as BoundDeviceKey[]
  const live: LiveOrganization = {
    orgId, groupPk: commitments[0], epoch: 7n, lastNonce: 9n,
    thresholdWeight: 2n, chainId: new TextEncoder().encode("sui-testnet:"),
    members: [{ address: participants[0], weight: 2n }, { address: participants[1], weight: 1n }],
    keyGeneration: 1n,
  }
  const draft = { members: [{ address: participants[0], weight: 2n }, { address: carol, weight: 1n }], thresholdWeight: 2n }
  return { keys, live, draft, plan: planRosterChange(live, draft) }
}

async function signedFixture(base = fixture(), action = createRosterFrostAction(base.live, base.plan)) {
  const { keys } = base
  const request = await createFrostRequest({ action, key: keys[0], signerIndices: [1n, 2n], coordinator: alice, expiresAtMs: Date.now() + 60_000 }, signingAuth)
  const store = createMemoryFrostSessionStore()
  const rounds = await Promise.all(keys.map((key, index) => prepareFrostCommitment(request, key, { store, auth: authFor(index) })))
  const transcript = await createFrostTranscript(request, rounds, signingAuth, store)
  const shares = await Promise.all(keys.map((key, index) => produceFrostShare(request, transcript, key, { store, auth: authFor(index) })))
  const result = await aggregateFrostSession(request, transcript, shares, signingAuth.verify)
  return { ...base, request, result, store, rounds, transcript, shares }
}

type SignedFixture = Awaited<ReturnType<typeof signedFixture>>

function receipt(metadata?: Record<string, string>, owner: TransactionAccount = account): PendingTransactionReceipt {
  const intent = { account: owner, network: "testnet" as const, action: "group-roster-update", scope: `${orgId}:7`, metadata }
  return {
    ...intent, version: 1, id: "receipt-1", key: transactionIntentKey(intent),
    digest: "roster-digest", status: "success", createdObjects: [], acknowledged: false,
    persistent: true, createdAt: 1, updatedAt: 1,
  }
}

function walletResult(pending: PendingTransactionReceipt): WalletTransactionResult {
  assert.ok(pending.digest)
  return { digest: pending.digest, createdObjects: [], receipt: { ...pending, status: "success" } }
}

function harness(f: SignedFixture, pending?: PendingTransactionReceipt) {
  const confirmed: LiveOrganization = {
    ...f.live, epoch: f.live.epoch + 1n, lastNonce: f.live.lastNonce + 1n,
    members: f.draft.members.map(member => ({ ...member })),
  }
  const calls: string[] = []
  let reads = 0
  let submitted: PendingTransactionReceipt | undefined
  const deps: RosterSubmissionDependencies = {
    ensureFunction: async () => {},
    readLive: async () => pending || ++reads > 1 ? confirmed : f.live,
    getAccount: () => account,
    getPending: () => pending,
    execute: async (_tx, options) => {
      calls.push("execute")
      assert.equal(options?.scope, `${orgId}:7`)
      assert.deepEqual(options.expectedAccount, account)
      submitted = receipt(options.metadata)
      return walletResult(submitted)
    },
    resume: async received => {
      calls.push("resume")
      assert.ok(pending)
      assert.deepEqual(received, pending)
      return walletResult(pending)
    },
    readDeviceKey: async () => f.keys[0],
    advanceDeviceKeyEpoch: async (org, holder, input) => {
      assert.equal(org, orgId)
      assert.equal(holder, alice)
      assert.equal(input.fromEpoch, 7n)
      assert.equal(input.toEpoch, 8n)
      assert.equal(input.creationDigest, f.keys[0].creationDigest)
      calls.push("migrate")
    },
    adoptEpoch: (org, next) => {
      assert.equal(org, orgId)
      assert.equal(next.epoch, 8n)
      calls.push("adopt")
      return true
    },
    acknowledge: () => { calls.push("acknowledge") },
  }
  return { deps, calls, confirmed, get submitted() { return submitted } }
}

function submit(f: SignedFixture, deps: RosterSubmissionDependencies) {
  return submitFrostRosterChange(f.live, f.draft, f.request, f.result, deps)
}

// Capture metadata through the actual submission boundary instead of duplicating
// its serializer in a receipt fixture. execute/resume/readLive remain local I/O.
async function submittedFixture() {
  const f = await signedFixture()
  const h = harness(f)
  await submit(f, h.deps)
  assert.ok(h.submitted)
  return { f, pending: structuredClone(h.submitted) }
}

test("roster FROST action binds deployment, live chain id, epoch, next nonce and exact ordered snapshot", () => {
  const { live, plan } = fixture()
  const action = createRosterFrostAction(live, plan)
  assert.equal(action.kind, "roster")
  assert.equal(action.packageId, PROPOSAL_PACKAGE_ID)
  assert.equal(action.chainIdHex, Buffer.from(live.chainId).toString("hex"))
  assert.equal(action.epoch, "7")
  assert.equal(action.nonce, "10")
  assert.deepEqual(action.priorMembers, live.members.map(member => member.address))
  assert.deepEqual(action.members, [alice, carol])
  assert.deepEqual(action.weights, ["2", "1"])
})

test("a request for another roster snapshot is rejected before share collection", async () => {
  const { live, plan, request } = await signedFixture()
  assert.throws(() => assertRosterFrostRequest(live, { ...plan, thresholdWeight: 1n }, request), /不一致/)
})

test("a signer removed from the live roster cannot be counted for a roster transition", async () => {
  const { live, plan, request } = await signedFixture()
  const reduced = { ...live, members: [{ address: alice, weight: 2n }] }
  assert.throws(() => assertRosterFrostRequest(reduced, plan, request), /不在当前链上名册中/)
})

test("signers whose combined weight is below thresholdWeight are rejected", async () => {
  const { live, plan, request } = await signedFixture()
  const highThresholdLive = { ...live, thresholdWeight: 4n }
  assert.throws(() => assertRosterFrostRequest(highThresholdLive, plan, request), /未达到当前链上要求的换届门限权重/)
})

test("a fresh-chain nonce change blocks wallet transaction submission", async () => {
  const f = await signedFixture()
  const h = harness(f)
  h.deps.readLive = async () => ({ ...f.live, lastNonce: f.live.lastNonce + 1n })
  await assert.rejects(submit(f, h.deps), /链上名册、Epoch、群公钥或 nonce 已变化/)
  assert.deepEqual(h.calls, [])
})

test("a confirmed key-preserving roster update migrates the bound device key before acknowledging", async () => {
  const f = await signedFixture()
  const h = harness(f)
  await submit(f, h.deps)
  assert.deepEqual(h.calls, ["execute", "migrate", "adopt", "acknowledge"])
  const metadata = h.submitted?.metadata
  assert.ok(metadata)
  assert.equal(metadata.frostRequestId, f.request.requestId)
  assert.equal(metadata.frostContextHash, f.request.contextHash)
  assert.equal(metadata.frostTranscriptHash, f.result.transcriptHash)
  assert.equal(metadata.frostKeyPackageId, f.request.keyPackage.keyPackageId)
  assert.equal(metadata.packageId, f.request.action.packageId)
  assert.equal(metadata.rosterDigest, Buffer.from(f.result.digest).toString("hex"))
  assert.deepEqual(JSON.parse(metadata.priorMembers), f.plan.priorMembers)
  assert.deepEqual(JSON.parse(metadata.members), f.plan.members)
  assert.deepEqual(JSON.parse(metadata.weights), f.plan.weights.map(String))
  assert.deepEqual(Object.keys(metadata).sort(), [
    "orgId", "packageId", "chainIdHex", "epoch", "newEpoch", "nonce", "thresholdWeight", "memberCount",
    "priorMembers", "members", "weights", "signerIndices", "frostBindingVersion", "frostRequestId",
    "frostContextHash", "frostTranscriptHash", "frostKeyPackageId", "groupPk", "rosterDigest",
  ].sort())
})

test("a successful receipt with an unexpected post-state keeps the local transaction lock", async () => {
  const f = await signedFixture()
  const h = harness(f)
  let reads = 0
  h.deps.readLive = async () => ++reads === 1 ? f.live : { ...h.confirmed, members: [{ address: alice, weight: 2n }, { address: carol, weight: 99n }] }
  await assert.rejects(submit(f, h.deps), /待确认锁保留/)
  assert.deepEqual(h.calls, ["execute"])
})

test("a matching pending roster receipt resumes only its original digest before migrating and acknowledging", async () => {
  const { f, pending } = await submittedFixture()
  const h = harness(f, pending)
  const recovered = await submit(f, h.deps)
  assert.equal(recovered.digest, pending.digest)
  assert.deepEqual(recovered.signerIndices, f.result.signerIndices)
  assert.deepEqual(h.calls, ["resume", "migrate", "adopt", "acknowledge"])
})

test("fresh live roster comparison covers member weights and group key", () => {
  const { live } = fixture()
  assert.throws(() => assertSameLiveRoster(live, { ...live, members: [{ ...live.members[0], weight: 3n }, live.members[1]] }), /链上名册/)
  assert.throws(() => assertSameLiveRoster(live, { ...live, groupPk: ed25519.Point.BASE.toBytes() }), /链上名册/)
})

test("a forged coordinator signature with a valid group signature fails the production fresh-request gate", async () => {
  const f = await signedFixture()
  f.request.signature = (await identities[1].signPersonalMessage(new Uint8Array([1]))).signature
  const h = harness(f)
  await assert.rejects(submit(f, h.deps))
  assert.deepEqual(h.calls, [])
})

test("fresh submission invokes the strict request verifier before deployment checks or wallet I/O", async () => {
  const f = await signedFixture()
  const h = harness(f)
  h.deps.verifyRequest = async () => { throw new Error("request authentication denied") }
  h.deps.ensureFunction = async () => { h.calls.push("ensure") }
  await assert.rejects(submit(f, h.deps), /request authentication denied/)
  assert.deepEqual(h.calls, [])
})

test("an expired authenticated request may recover an existing receipt but cannot start a fresh submission", async t => {
  const { f, pending } = await submittedFixture()
  t.mock.method(Date, "now", () => f.request.expiresAtMs)
  const fresh = harness(f)
  await assert.rejects(submit(f, fresh.deps), /expired FROST request/)
  assert.deepEqual(fresh.calls, [])
  const recovery = harness(f, pending)
  await submit(f, recovery.deps)
  assert.deepEqual(recovery.calls, ["resume", "migrate", "adopt", "acknowledge"])
})

test("a pending receipt without FROST provenance remains locked before resume", async () => {
  const f = await signedFixture()
  const pending = receipt()
  const h = harness(f, pending)
  await assert.rejects(submit(f, h.deps), /缺少来源绑定/)
  assert.deepEqual(h.calls, [])
  assert.equal(pending.acknowledged, false)
})

const actionVariants: { name: string; change: (action: RosterFrostAction) => RosterFrostAction }[] = [
  { name: "a new request for the same exact action", change: action => action },
  { name: "another deployment", change: action => ({ ...action, packageId: "0x" + "cc".repeat(32) }) },
  { name: "another prior-member ordering", change: action => ({ ...action, priorMembers: [...action.priorMembers].reverse() }) },
  { name: "another prior-member snapshot", change: action => ({ ...action, priorMembers: [alice] }) },
  { name: "the same member/weight set in another order", change: action => ({ ...action, members: [...action.members].reverse(), weights: [...action.weights].reverse() }) },
  { name: "another weight ordering", change: action => ({ ...action, weights: [...action.weights].reverse() }) },
]
for (const { name, change } of actionVariants) {
  test(`a valid signed request for ${name} cannot recover another request's receipt`, async () => {
    const { f, pending } = await submittedFixture()
    assert.equal(f.request.action.kind, "roster")
    const alternate = await signedFixture(f, change(f.request.action as RosterFrostAction))
    await verifyFrostRequest(alternate.request, verifyProtocolMessage)
    assert.notEqual(alternate.request.requestId, f.request.requestId)
    assert.notEqual(alternate.request.contextHash, f.request.contextHash)
    const h = harness(alternate, pending)
    await assert.rejects(submit(alternate, h.deps), /缺少来源绑定/)
    assert.deepEqual(h.calls, [])
    assert.equal(pending.acknowledged, false)
  })
}

for (const field of [
  "frostBindingVersion", "frostRequestId", "frostContextHash", "frostTranscriptHash", "frostKeyPackageId",
  "packageId", "priorMembers", "members", "weights", "nonce", "epoch", "newEpoch", "thresholdWeight",
  "chainIdHex", "groupPk", "rosterDigest", "signerIndices",
]) {
  test(`receipt provenance rejects a mismatched ${field} before resume`, async () => {
    const { f, pending } = await submittedFixture()
    pending.metadata = { ...pending.metadata, [field]: "mismatched" }
    const h = harness(f, pending)
    await assert.rejects(submit(f, h.deps), /缺少来源绑定/)
    assert.deepEqual(h.calls, [])
    assert.equal(pending.acknowledged, false)
  })
}

test("unknown receipt metadata is rejected instead of imported into the FROST binding", async () => {
  const { f, pending } = await submittedFixture()
  pending.metadata = { ...pending.metadata, unknownField: "unexpected" }
  const h = harness(f, pending)
  await assert.rejects(submit(f, h.deps), /缺少来源绑定/)
  assert.deepEqual(h.calls, [])
})

for (const field of ["requestId", "contextHash", "transcriptHash", "action", "signature", "groupPk", "digest", "signerIndices"] as const) {
  test(`recovery rejects a mismatched aggregate ${field} before resume`, async () => {
    const { f, pending } = await submittedFixture()
    if (field === "action") f.result.action = { ...f.result.action, packageId: "0x" + "dd".repeat(32) }
    else if (field === "signature" || field === "groupPk" || field === "digest") f.result[field] = new Uint8Array(f.result[field].length)
    else if (field === "signerIndices") f.result.signerIndices = [2n, 1n]
    else f.result[field] = "ee".repeat(32)
    const h = harness(f, pending)
    await assert.rejects(submit(f, h.deps))
    assert.deepEqual(h.calls, [])
    assert.equal(pending.acknowledged, false)
  })
}

test("recovery still authenticates the coordinator signature when receipt provenance matches", async () => {
  const { f, pending } = await submittedFixture()
  f.request.signature = (await identities[1].signPersonalMessage(new Uint8Array([1]))).signature
  const h = harness(f, pending)
  await assert.rejects(submit(f, h.deps))
  assert.deepEqual(h.calls, [])
})

test("receipt recovery rejects provider changes during request authentication before resume", async () => {
  const { f, pending } = await submittedFixture()
  const h = harness(f, pending)
  let active = account
  h.deps.getAccount = () => active
  h.deps.verifyExpiredRequest = async request => {
    await verifyFrostRequest(request, verifyProtocolMessage, { allowExpired: true })
    active = { ...account, provider: "another-wallet" }
  }
  await assert.rejects(submit(f, h.deps), /账户或钱包提供方已切换/)
  assert.deepEqual(h.calls, [])
})

for (const change of ["account", "scope", "network", "action", "key", "digest", "acknowledged", "status"] as const) {
  test(`receipt recovery rejects an incorrect ${change} before resume`, async () => {
    const { f, pending } = await submittedFixture()
    if (change === "account") pending.account = { ...account, provider: "other-wallet" }
    else if (change === "scope") pending.scope = `${orgId}:6`
    else if (change === "network") Object.assign(pending, { network: "mainnet" })
    else if (change === "action") pending.action = "another-action"
    else if (change === "key") pending.key = "another-key"
    else if (change === "digest") pending.digest = undefined
    else if (change === "acknowledged") pending.acknowledged = true
    else pending.status = "failed"
    const h = harness(f, pending)
    await assert.rejects(submit(f, h.deps), /缺少来源绑定/)
    assert.deepEqual(h.calls, [])
  })
}

test("the second pending lookup rejects a different request instead of resuming it", async () => {
  const { f, pending } = await submittedFixture()
  const h = harness(f)
  pending.metadata = { ...pending.metadata, frostRequestId: "ff".repeat(32) }
  let lookups = 0
  h.deps.getPending = () => ++lookups === 1 ? undefined : pending
  await assert.rejects(submit(f, h.deps), /缺少来源绑定/)
  assert.equal(lookups, 2)
  assert.deepEqual(h.calls, [])
})

test("the second pending lookup resumes a matching receipt without executing again", async () => {
  const { f, pending } = await submittedFixture()
  const h = harness(f, pending)
  let lookups = 0
  let reads = 0
  h.deps.getPending = () => ++lookups === 1 ? undefined : pending
  h.deps.readLive = async () => ++reads === 1 ? f.live : h.confirmed
  await submit(f, h.deps)
  assert.equal(lookups, 2)
  assert.deepEqual(h.calls, ["resume", "migrate", "adopt", "acknowledge"])
})

for (const change of ["digest", "receiptId", "metadata", "status"] as const) {
  test(`a resumed ${change} mismatch cannot migrate or acknowledge`, async () => {
    const { f, pending } = await submittedFixture()
    const h = harness(f, pending)
    h.deps.resume = async () => {
      h.calls.push("resume")
      const response = walletResult(structuredClone(pending))
      if (change === "digest") { response.digest = "different-digest"; response.receipt.digest = response.digest }
      else if (change === "receiptId") response.receipt.id = "different-receipt"
      else if (change === "status") response.receipt.status = "pending"
      else response.receipt.metadata = undefined
      return response
    }
    await assert.rejects(submit(f, h.deps), /待确认锁保留/)
    assert.deepEqual(h.calls, ["resume"])
    assert.equal(pending.acknowledged, false)
  })
}

test("post-state membership order does not need to match the signed array after provenance verification", async () => {
  const { f, pending } = await submittedFixture()
  const h = harness(f, pending)
  h.deps.readLive = async () => ({ ...h.confirmed, members: [...h.confirmed.members].reverse() })
  await submit(f, h.deps)
  assert.deepEqual(h.calls, ["resume", "migrate", "adopt", "acknowledge"])
})

test("a recovered receipt with an incorrect post-state retains the lock before device migration", async () => {
  const { f, pending } = await submittedFixture()
  const h = harness(f, pending)
  h.deps.readLive = async () => ({ ...h.confirmed, thresholdWeight: 1n })
  await assert.rejects(submit(f, h.deps), /待确认锁保留/)
  assert.deepEqual(h.calls, ["resume"])
})

test("a failed device-key CAS retains a recovered receipt without adopting or acknowledging", async () => {
  const { f, pending } = await submittedFixture()
  const h = harness(f, pending)
  h.deps.advanceDeviceKeyEpoch = async () => { h.calls.push("migrate"); throw new Error("device CAS failed") }
  await assert.rejects(submit(f, h.deps), /device CAS failed/)
  assert.deepEqual(h.calls, ["resume", "migrate"])
  assert.equal(pending.acknowledged, false)
})

async function reopenedStore(f: SignedFixture) {
  const store = createMemoryFrostSessionStore()
  await store.remember(structuredClone({ request: f.request, round1: f.rounds, transcript: f.transcript, round2: f.shares, updatedAtMs: Date.now() }))
  store.prepare = async () => { assert.fail("receipt recovery requested a nonce") }
  store.consume = async () => { assert.fail("receipt recovery consumed a nonce") }
  return store
}

function recoverSaved(f: SignedFixture, deps: RosterSubmissionDependencies, store: Awaited<ReturnType<typeof reopenedStore>>) {
  return recoverRosterSessionReceipt({ requestId: f.request.requestId, orgId, verify: verifyProtocolMessage, dependencies: deps, store })
}

test("reopened public progress recovers an already-applied roster without a live pre-state or UI aggregate", async () => {
  const { f, pending } = await submittedFixture()
  const h = harness(f, pending)
  h.deps.ensureFunction = async () => { assert.fail("recovery checked a fresh deployment") }
  h.deps.execute = async () => { assert.fail("recovery executed a transaction") }
  const result = await recoverSaved(f, h.deps, await reopenedStore(f))
  assert.equal(result.digest, pending.digest)
  assert.deepEqual(h.calls, ["resume", "migrate", "adopt", "acknowledge"])
})

test("reopened expired public progress recovers only an existing original receipt", async t => {
  const { f, pending } = await submittedFixture()
  const store = await reopenedStore(f)
  t.mock.method(Date, "now", () => f.request.expiresAtMs)
  const h = harness(f, pending)
  await recoverSaved(f, h.deps, store)
  assert.deepEqual(h.calls, ["resume", "migrate", "adopt", "acknowledge"])
  const fresh = harness(f)
  await assert.rejects(recoverSaved(f, fresh.deps, store), /没有匹配的原名册交易回执/)
  await assert.rejects(submit(f, fresh.deps), /expired/)
  assert.deepEqual(fresh.calls, [])
})

for (const field of ["request", "round1", "transcript", "round2", "missingTranscript", "missingShare"] as const) {
  test(`reopened receipt recovery rejects ${field} tampering or incomplete progress without unlocking`, async () => {
    const { f, pending } = await submittedFixture()
    const store = await reopenedStore(f)
    const saved = (await store.restore(f.request.requestId))!
    if (field === "request") saved.request.signature = "invalid"
    else if (field === "round1") saved.round1[0].signature = "invalid"
    else if (field === "transcript") saved.transcript!.signature = "invalid"
    else if (field === "round2") saved.round2[0].signature = "invalid"
    else if (field === "missingTranscript") delete saved.transcript
    else saved.round2.pop()
    const h = harness(f, pending)
    await assert.rejects(recoverSaved(f, h.deps, { ...store, restore: async () => saved }))
    assert.deepEqual(h.calls, [])
    assert.equal(pending.acknowledged, false)
  })
}

test("reopened recovery cannot absorb another valid request's original receipt", async () => {
  const { f, pending } = await submittedFixture()
  const alternate = await signedFixture(f)
  const h = harness(alternate, pending)
  await assert.rejects(recoverSaved(alternate, h.deps, await reopenedStore(alternate)), /缺少来源绑定/)
  assert.deepEqual(h.calls, [])
})

test("reopened recovery rejects an organization or provider switch before querying the digest", async () => {
  const { f, pending } = await submittedFixture()
  const store = await reopenedStore(f)
  const h = harness(f, pending)
  await assert.rejects(recoverRosterSessionReceipt({ requestId: f.request.requestId, orgId: "0x" + "ee".repeat(32), verify: verifyProtocolMessage, dependencies: h.deps, store }), /不是所选组织/)
  let active = account
  h.deps.getAccount = () => active
  await assert.rejects(recoverRosterSessionReceipt({ requestId: f.request.requestId, orgId, dependencies: h.deps, store, verify: async (...args) => {
    await verifyProtocolMessage(...args)
    active = { ...account, provider: "switched-wallet" }
  } }), /账户或钱包提供方已切换/)
  assert.deepEqual(h.calls, [])
})

test("reopened recovery rejects replacement of the original receipt during public verification", async () => {
  const { f, pending } = await submittedFixture()
  const h = harness(f, pending)
  let lookups = 0
  h.deps.getPending = () => ++lookups === 1 ? pending : { ...pending, id: "replacement" }
  await assert.rejects(recoverSaved(f, h.deps, await reopenedStore(f)), /原名册回执已变化/)
  assert.deepEqual(h.calls, [])
})

async function legacyFixture() {
  const f = await signedFixture()
  setCommitteeSession({ orgId, epoch: f.live.epoch, groupPk: f.live.groupPk, threshold: 2n, indices: f.keys.map(key => key.index), shares: f.keys.map(key => key.share) })
  const h = harness(f)
  await submitRosterChange(f.live, f.draft, h.deps)
  assert.ok(h.submitted)
  return { f, pending: structuredClone(h.submitted) }
}

test("legacy committed receipt resumes before signing even after its in-memory shares are gone", async () => {
  const { f, pending } = await legacyFixture()
  clearCommitteeSession(orgId)
  const h = harness(f, pending)
  await submitRosterChange(f.live, f.draft, h.deps)
  assert.deepEqual(h.calls, ["resume", "migrate", "adopt", "acknowledge"])
})

test("legacy receipt recovers after epoch adoption succeeded but acknowledgment failed", async () => {
  const { f, pending } = await legacyFixture()
  const first = harness(f, pending)
  first.deps.adoptEpoch = adoptLiveEpoch
  first.deps.acknowledge = () => { throw new Error("storage unavailable") }
  await assert.rejects(submitRosterChange(f.live, f.draft, first.deps), /本地待确认锁未能释放/)
  assert.equal(getCommitteeSession(orgId)?.epoch, 8n)
  const retry = harness(f, pending)
  retry.deps.readDeviceKey = async () => ({ ...f.keys[0], epoch: 8n })
  await submitRosterChange(f.live, f.draft, retry.deps)
  assert.deepEqual(retry.calls, ["resume", "adopt", "acknowledge"])
  clearCommitteeSession(orgId)
})

test("legacy receipt recovers directly after reopening without a new draft", async () => {
  const { f, pending } = await legacyFixture()
  clearCommitteeSession(orgId)
  const h = harness(f, pending)
  await recoverLegacyRosterReceipt(pending, h.deps)
  assert.deepEqual(h.calls, ["resume", "migrate", "adopt", "acknowledge"])
})

for (const field of ["missingBinding", "rosterSignature", "members", "groupPk", "signerIndices", "unknown"] as const) {
  test(`legacy recovery rejects ${field} before querying or unlocking`, async () => {
    const { f, pending } = await legacyFixture()
    clearCommitteeSession(orgId)
    if (field === "missingBinding") delete pending.metadata!.legacyBindingVersion
    else if (field === "members") pending.metadata!.members = JSON.stringify([...f.plan.members].reverse())
    else if (field === "signerIndices") pending.metadata!.signerIndices = "1,1"
    else pending.metadata = { ...pending.metadata, [field]: "00" }
    const h = harness(f, pending)
    await assert.rejects(recoverLegacyRosterReceipt(pending, h.deps))
    assert.deepEqual(h.calls, [])
    assert.equal(pending.acknowledged, false)
  })
}

test("legacy submit cannot report the original receipt as success for a different edited draft", async () => {
  const { f, pending } = await legacyFixture()
  clearCommitteeSession(orgId)
  const h = harness(f, pending)
  await assert.rejects(submitRosterChange(f.live, { ...f.draft, thresholdWeight: 1n }, h.deps), /当前预览与原名册交易不一致/)
  assert.deepEqual(h.calls, [])
  assert.equal(pending.acknowledged, false)
  await recoverLegacyRosterReceipt(pending, h.deps)
  assert.deepEqual(h.calls, ["resume", "migrate", "adopt", "acknowledge"])
})

test("a legacy retry cannot recover a FROST receipt under the same coarse intent", async () => {
  const { f, pending } = await submittedFixture()
  const h = harness(f, pending)
  await assert.rejects(submitRosterChange(f.live, f.draft, h.deps), /旧版名册回执缺少来源绑定/)
  assert.deepEqual(h.calls, [])
})

for (const failure of ["postState", "CAS", "provider"] as const) {
  test(`legacy receipt keeps its lock on ${failure} failure`, async () => {
    const { f, pending } = await legacyFixture()
    clearCommitteeSession(orgId)
    const h = harness(f, pending)
    if (failure === "postState") h.deps.readLive = async () => ({ ...h.confirmed, lastNonce: 99n })
    else if (failure === "CAS") h.deps.advanceDeviceKeyEpoch = async () => { throw new Error("CAS unavailable") }
    else {
      let active = account
      h.deps.getAccount = () => active
      h.deps.readDeviceKey = async () => { active = { ...account, provider: "switched" }; return f.keys[0] }
    }
    await assert.rejects(recoverLegacyRosterReceipt(pending, h.deps))
    assert.equal(h.calls.includes("acknowledge"), false)
    assert.equal(h.calls.includes("adopt"), false)
    assert.equal(pending.acknowledged, false)
  })
}
