import "fake-indexeddb/auto"
import assert from "node:assert/strict"
import { test } from "node:test"
import { createFrostRequest, prepareFrostCommitment, type BoundDeviceKey, type ProtocolAuth } from "./frost-session"
import { createIndexedDbFrostSessionStore, createMemoryFrostSessionStore } from "./frost-session-store"
import { defaultDeviceVault } from "./crypto/device-vault"
import { ed25519 } from "@noble/curves/ed25519.js"
import { publicKeyPackageId } from "./dkg-key-package"
import { sha256 } from "@noble/hashes/sha2.js"

const address = "0x" + "11".repeat(32)
const orgId = "0x" + "aa".repeat(32)
const auth: ProtocolAuth = { async sign(bytes) { return { signature: Buffer.from(sha256(bytes)).toString("hex") } }, async verify(bytes, signature) { assert.equal(signature, Buffer.from(sha256(bytes)).toString("hex")) } }
function fixture(): BoundDeviceKey {
  const commitments = [ed25519.Point.BASE.multiply(7n).toBytes()]
  const metadata = { network: "sui:testnet" as const, sessionId: "0x" + "bb".repeat(32), participantAddresses: [address], dealerAddresses: [address], threshold: 1n, sessionEpoch: 1n, commitments }
  return { ...metadata, groupPk: commitments[0], keyPackageId: publicKeyPackageId(metadata), holder: address, index: 1n, share: 7n, orgId, epoch: 1n, creationDigest: "00".repeat(32) }
}
const action = { kind: "epoch" as const, packageId: "0x" + "cc".repeat(32), orgId, epoch: "1", nonce: "2", chainIdHex: "00".repeat(32), newEpoch: "2" }

test("IndexedDB nonce consumption commits before return and refuses a second transcript", async () => {
  const databaseName = `frost-test-${crypto.randomUUID()}`
  const store = createIndexedDbFrostSessionStore({ databaseName })
  const key = fixture()
  const request = await createFrostRequest({ action, key, signerIndices: [1n], coordinator: address, expiresAtMs: Date.now() + 30_000 }, auth)
  const round = await prepareFrostCommitment(request, key, { store, auth })
  const id = `${key.keyPackageId}:${request.contextHash}:1`
  // At rest: the prepared record carries only the sealed box, never plaintext scalars.
  const raw = await new Promise<unknown>((resolve, reject) => {
    const request2 = indexedDB.open(databaseName, 1)
    request2.onsuccess = () => {
      const tx = request2.result.transaction("nonces", "readonly")
      const get = tx.objectStore("nonces").get(id)
      get.onsuccess = () => resolve(get.result)
      get.onerror = () => reject(get.error)
    }
    request2.onerror = () => reject(request2.error)
  })
  const prepared = raw as { nonces: { sealed: unknown } | { hiding: unknown } }
  assert.ok(prepared.nonces && "sealed" in prepared.nonces, "Stored nonce record must contain a sealed box")
  const result = await store.consume(id, round, "11".repeat(32))
  assert.equal(result.kind, "fresh")
  if (result.kind !== "fresh") throw new Error("Expected newly consumed nonce")
  // The burned material is a sealed box, and opening it with the bound context
  // yields the two 32-byte scalars the signer needs.
  assert.ok("sealed" in result.nonces, "Nonce material must be sealed at rest")
  const nonces = await defaultDeviceVault.open(result.nonces.sealed, id)
  assert.equal(nonces.length, 64)
  assert.equal(nonces.slice(0, 32).length, 32)
  await assert.rejects(() => store.consume(id, round, "22".repeat(32)), /already consumed/)
  await assert.rejects(() => store.consume(id, round, "11".repeat(32)), /permanently consumed/)
})

test("public recovery record merges identical rounds and rejects conflicting signer replay", async () => {
  const store = createMemoryFrostSessionStore()
  const key = fixture()
  const request = await createFrostRequest({ action, key, signerIndices: [1n], coordinator: address, expiresAtMs: Date.now() + 30_000 }, auth)
  const round = await prepareFrostCommitment(request, key, { store, auth })
  const record = await store.restore(request.requestId)
  assert.ok(record)
  await store.remember({ ...record, round1: [round], updatedAtMs: Date.now() })
  assert.equal((await store.list()).length, 1)
  await assert.rejects(() => store.remember({ ...record, round1: [{ ...round, hiding: "00".repeat(32) }], updatedAtMs: Date.now() }), /Conflicting FROST round/)
})
