import "fake-indexeddb/auto"
import assert from "node:assert/strict"
import { test } from "node:test"
import { ed25519 } from "@noble/curves/ed25519.js"
import {
  advanceDeviceKeyEpoch,
  bindDeviceKey,
  clearStoredShare,
  readDealerContribution,
  readDeviceKey,
  readPendingDeviceKey,
  readStoredShare,
  saveDealerContribution,
  savePendingDeviceKey,
  shareMismatch,
  writeStoredShare,
} from "./committee-share-store"
import { assembleDeviceKey } from "./dkg-key-package"

const A = `0x${"41".repeat(32)}`
const B = `0x${"42".repeat(32)}`
const SESSION = `0x${"ab".repeat(32)}`
const ORG = `0x${"cd".repeat(32)}`
const GROUP = ed25519.Point.BASE.multiply(23n).toBytes()

function key(): ReturnType<typeof assembleDeviceKey> {
  const commitments = [ed25519.Point.BASE.multiply(23n).toBytes()]
  return assembleDeviceKey({
    sessionId: SESSION,
    holder: A,
    participantAddresses: [A],
    threshold: 1n,
    sessionEpoch: 4n,
    dealers: [{ address: A, commitments, share: 23n }],
  })
}

test("pending device keys are idempotent and reject a conflicting rewrite", async () => {
  const pending = key()
  await savePendingDeviceKey(pending)
  await savePendingDeviceKey({ ...pending, commitments: pending.commitments.map(bytes => bytes.slice()), groupPk: pending.groupPk.slice() })
  assert.deepEqual(await readPendingDeviceKey(SESSION, A), pending)
  await assert.rejects(() => savePendingDeviceKey(assembleDeviceKey({
    sessionId: SESSION,
    holder: A,
    participantAddresses: [A],
    threshold: 1n,
    sessionEpoch: 4n,
    dealers: [{ address: A, commitments: [ed25519.Point.BASE.multiply(24n).toBytes()], share: 24n }],
  })), /拒绝覆盖/)
})

test("binding scopes by organization and holder, consumes pending atomically", async () => {
  const pending = key()
  const bound = await bindDeviceKey({ sessionId: SESSION, holder: A, orgId: ORG, epoch: 4n, creationDigest: "digest-1", groupPk: GROUP })
  assert.deepEqual(bound, { ...pending, orgId: ORG, epoch: 4n, creationDigest: "digest-1" })
  assert.deepEqual(await readDeviceKey(ORG, A), bound)
  assert.equal(await readPendingDeviceKey(SESSION, A), null)
  await assert.deepEqual(await bindDeviceKey({ sessionId: SESSION, holder: A, orgId: ORG, epoch: 4n, creationDigest: "digest-1", groupPk: GROUP }), bound)
})

test("epoch advance is compare-and-set and exact replay is idempotent", async () => {
  const rotated = ed25519.Point.BASE.multiply(29n).toBytes()
  await advanceDeviceKeyEpoch(ORG, A, { fromEpoch: 4n, toEpoch: 5n, groupPk: rotated, creationDigest: "digest-2" })
  await advanceDeviceKeyEpoch(ORG, A, { fromEpoch: 4n, toEpoch: 5n, groupPk: rotated, creationDigest: "digest-2" })
  const result = await readDeviceKey(ORG, A)
  assert.equal(result?.epoch, 5n)
  assert.equal(result?.creationDigest, "digest-2")
  assert.deepEqual(result?.groupPk, rotated)
  await assert.rejects(() => advanceDeviceKeyEpoch(ORG, A, { fromEpoch: 4n, toEpoch: 6n, groupPk: GROUP }), /不是预期的 4/)
})

test("dealer contribution stores only the local polynomial evaluation and is idempotent", async () => {
  const commitments = [ed25519.Point.BASE.multiply(7n).toBytes(), ed25519.Point.BASE.multiply(3n).toBytes()]
  await saveDealerContribution({ sessionId: SESSION, holder: A, index: 2n, commitments, share: 13n })
  await saveDealerContribution({ sessionId: SESSION, holder: A, index: 2n, commitments: commitments.map(bytes => bytes.slice()), share: 13n })
  const result = await readDealerContribution(SESSION, A)
  assert.deepEqual(result, { sessionId: SESSION, holder: A, index: 2n, commitments, share: 13n })
  await assert.rejects(() => saveDealerContribution({ sessionId: SESSION, holder: A, index: 2n, commitments: [ed25519.Point.BASE.multiply(7n).toBytes(), ed25519.Point.BASE.multiply(4n).toBytes()], share: 15n, }), /拒绝覆盖/)
})

test("legacy share APIs continue to use the old shares object store", async () => {
  await writeStoredShare({ orgId: ORG, groupPk: GROUP, index: 1n, epoch: 4n, share: 23n, threshold: 1n, participants: 1 })
  assert.deepEqual(await readStoredShare(ORG), { orgId: ORG, groupPk: GROUP, index: 1n, epoch: 4n, share: 23n, threshold: 1n, participants: 1 })
  assert.equal(shareMismatch((await readStoredShare(ORG))!, { orgId: ORG, groupPk: GROUP, epoch: 4n }), null)
  await clearStoredShare(ORG)
  assert.equal(await readStoredShare(ORG), null)
})

async function readRawRecord(store: string, id: string): Promise<Record<string, unknown>> {
  const record = await new Promise<unknown>((resolve, reject) => {
    const request = indexedDB.open("sui-committee-shares", 2)
    request.onsuccess = () => {
      const tx = request.result.transaction(store, "readonly")
      const get = tx.objectStore(store).get(id)
      get.onsuccess = () => resolve(get.result)
      get.onerror = () => reject(get.error)
    }
    request.onerror = () => reject(request.error)
  })
  assert.ok(record, `expected a raw record in ${store}`)
  return record as Record<string, unknown>
}

test("secret scalars are sealed at rest in every store, never plaintext", async () => {
  // Fresh identifiers: earlier tests already bound and epoch-advanced (ORG, A).
  const SESSION2 = `0x${"ac".repeat(32)}`
  const ORG2 = `0x${"ce".repeat(32)}`
  const pendingId = JSON.stringify(["sui:testnet", "session", SESSION2, B])
  const commitments = [ed25519.Point.BASE.multiply(23n).toBytes()]
  const deviceKey = assembleDeviceKey({ sessionId: SESSION2, holder: B, participantAddresses: [B], threshold: 1n, sessionEpoch: 4n, dealers: [{ address: B, commitments, share: 23n }] })
  await savePendingDeviceKey(deviceKey)
  const pendingRaw = await readRawRecord("pending-device-keys", pendingId)
  assert.ok("sealed" in pendingRaw && typeof (pendingRaw as { sealed: unknown }).sealed === "object", "pending record stores a sealed box")
  assert.equal("share" in pendingRaw, false, "pending record must not carry plaintext share")
  const plaintextHex = "17" + "00".repeat(31) // little-endian 23n
  assert.equal(JSON.stringify(pendingRaw).includes(plaintextHex), false, "sealed record must not contain the plaintext scalar")

  await bindDeviceKey({ sessionId: SESSION2, holder: B, orgId: ORG2, epoch: 4n, creationDigest: "digest-1", groupPk: GROUP })
  const boundId = JSON.stringify(["sui:testnet", "org", ORG2, B])
  const boundRaw = await readRawRecord("device-keys", boundId)
  assert.ok("sealed" in boundRaw, "bound record stores a sealed box")
  assert.equal("share" in boundRaw, false, "bound record must not carry plaintext share")
  assert.equal(JSON.stringify(boundRaw).includes(plaintextHex), false, "bound record must not contain the plaintext scalar")

  await saveDealerContribution({ sessionId: SESSION2, holder: B, index: 2n, commitments: [ed25519.Point.BASE.multiply(7n).toBytes(), ed25519.Point.BASE.multiply(3n).toBytes()], share: 13n })
  const dealerRaw = await readRawRecord("dealer-contributions", pendingId)
  assert.ok("sealed" in dealerRaw, "dealer record stores a sealed box")
  assert.equal(JSON.stringify(dealerRaw).includes("0d" + "00".repeat(31)), false, "dealer record must not contain the plaintext scalar")

  await writeStoredShare({ orgId: ORG2, groupPk: GROUP, index: 1n, epoch: 4n, share: 23n, threshold: 1n, participants: 1 })
  const legacyRaw = await readRawRecord("shares", ORG2)
  assert.ok("sealed" in legacyRaw, "legacy record stores a sealed box")
  assert.equal(JSON.stringify(legacyRaw).includes(plaintextHex), false, "legacy record must not contain the plaintext scalar")
})

void B
