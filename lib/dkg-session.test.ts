import assert from "node:assert/strict"
import { test } from "node:test"
import { bcs } from "@mysten/sui/bcs"
import { ObjectError } from "@mysten/sui/client"
import {
  DkgSessionContent, DKG_STATUS, readCommitment, readConfirmation, readMailboxShare,
  readSession, SessionTypeError, type SessionClient,
} from "./dkg-session"

// The ceremony dialog used to compute every participant's output in one tab and
// then call `finalize_session_v2` without ever submitting a commitment, which
// aborts (3002). Reading the session back is what makes a real asynchronous DKG
// possible, so these tests pin the distinction that matters: "not submitted
// yet" is null, while a broken read is an error.

const PACKAGE = "0x" + "e5".repeat(32)
const SESSION = "0x" + "a1".repeat(32)
const ALICE = "0x" + "b2".repeat(32)
const BOB = "0x" + "c3".repeat(32)
const COMMITMENTS = "0x" + "11".repeat(32)
const MAILBOXES = "0x" + "22".repeat(32)
const CONFIRMATIONS = "0x" + "33".repeat(32)

function sessionBytes(overrides: Record<string, unknown> = {}) {
  return DkgSessionContent.serialize({
    id: SESSION, epoch: "1", threshold: "2", total_participants: "2",
    participants: [ALICE, BOB],
    commitments: { id: COMMITMENTS, size: "0" },
    encrypted_mailboxes: { id: MAILBOXES, size: "0" },
    confirmations: { id: CONFIRMATIONS, size: "0" },
    confirmations_count: "0", deadline_timestamp_ms: "1000", status: DKG_STATUS.ROUND_1_COMMITMENTS,
    final_public_key: [], ...overrides,
  }).toBytes()
}

function client(session: Uint8Array, dynamicField?: (args: any) => Promise<unknown>): SessionClient {
  return {
    getObject: async () => ({ object: { objectId: SESSION, type: `${PACKAGE}::dkg_committee::DkgSession`, content: session } }),
    getDynamicField: dynamicField ?? (async () => { throw new Error("not configured") }),
  } as unknown as SessionClient
}

const absent = async () => { throw new ObjectError("notFound", "missing", { objectId: SESSION, reason: "notFound" }) }

test("a session decodes with its participants and table ids", async () => {
  const snapshot = await readSession(client(sessionBytes()), SESSION)
  assert.equal(snapshot.status, DKG_STATUS.ROUND_1_COMMITMENTS)
  assert.deepEqual(snapshot.participants, [ALICE, BOB])
  assert.equal(snapshot.threshold, 2n)
  assert.equal(snapshot.commitmentsTableId, COMMITMENTS)
  assert.equal(snapshot.mailboxTableId, MAILBOXES)
  assert.equal(snapshot.confirmationsTableId, CONFIRMATIONS)
})

test("a finalized session reports its group public key and status", async () => {
  const pk = new Uint8Array(32).fill(7)
  const snapshot = await readSession(client(sessionBytes({ status: DKG_STATUS.FINALIZED, final_public_key: Array.from(pk) })), SESSION)
  assert.equal(snapshot.status, DKG_STATUS.FINALIZED)
  assert.deepEqual(snapshot.finalPublicKey, pk)
})

test("an object that is not a DkgSession is rejected, not decoded by shape", async () => {
  const notSession = {
    getObject: async () => ({ object: { objectId: SESSION, type: `${PACKAGE}::cryptographic_org::Organization`, content: sessionBytes() } }),
    getDynamicField: absent,
  } as unknown as SessionClient
  await assert.rejects(() => readSession(notSession, SESSION), SessionTypeError)
})

test("a type from any publication in the lineage is accepted", async () => {
  // Objects keep the spelling of the package that minted them; the module and
  // name are what identify the type, not the prefix.
  for (const prefix of ["0x83fb785f1da119aea4e0faa19d1466b33899e14ea730af6425ec7d5557cb5a36", PACKAGE]) {
    const c = {
      getObject: async () => ({ object: { objectId: SESSION, type: `${prefix}::dkg_committee::DkgSession`, content: sessionBytes() } }),
      getDynamicField: absent,
    } as unknown as SessionClient
    assert.equal((await readSession(c, SESSION)).sessionId, SESSION)
  }
})

test("an id mismatch between the object and its content is an error", async () => {
  await assert.rejects(() => readSession(client(sessionBytes({ id: "0x" + "99".repeat(32) })), SESSION), SessionTypeError)
})

test("a commitment that was never submitted reads as null, not as empty bytes", async () => {
  const snapshot = await readSession(client(sessionBytes()), SESSION)
  assert.equal(await readCommitment(client(sessionBytes(), absent), snapshot, ALICE), null)
})

test("a submitted commitment is returned for the participant who submitted it", async () => {
  const commitment = new Uint8Array([1, 2, 3, 4])
  const field = {
    $kind: "DynamicField" as const,
    value: { bcs: bcs.vector(bcs.u8()).serialize(Array.from(commitment)).toBytes() },
  }
  const snapshot = await readSession(client(sessionBytes()), SESSION)
  assert.deepEqual(await readCommitment(client(sessionBytes(), async () => ({ dynamicField: field })), snapshot, ALICE), commitment)
})

test("the commitment read asks for the participant's own key, so it cannot return another slot", async () => {
  // `value.bcs` has no name to cross-check; the guarantee comes from the key the
  // request carries. Assert that key rather than trusting the payload.
  let sent: Uint8Array | null = null
  const field = { $kind: "DynamicField" as const, value: { bcs: bcs.vector(bcs.u8()).serialize([1]).toBytes() } }
  const snapshot = await readSession(client(sessionBytes()), SESSION)
  await readCommitment(
    client(sessionBytes(), async ({ name }: { name: { bcs: Uint8Array } }) => { sent = name.bcs; return { dynamicField: field } }),
    snapshot, ALICE,
  )
  assert.deepEqual(new Uint8Array(sent!), bcs.Address.serialize(ALICE).toBytes())
})

test("a non-notFound failure while reading a commitment surfaces", async () => {
  const snapshot = await readSession(client(sessionBytes()), SESSION)
  const broken = async () => { throw new ObjectError("internal", "boom", { objectId: SESSION, reason: "unknown" }) }
  await assert.rejects(() => readCommitment(client(sessionBytes(), broken), snapshot, ALICE))
})

test("an unconfirmed participant reads as null, a confirmed one as true", async () => {
  const snapshot = await readSession(client(sessionBytes()), SESSION)
  assert.equal(await readConfirmation(client(sessionBytes(), absent), snapshot, ALICE), null)
  const field = {
    $kind: "DynamicField" as const,
    value: { bcs: bcs.bool().serialize(true).toBytes() },
  }
  assert.equal(await readConfirmation(client(sessionBytes(), async () => ({ dynamicField: field })), snapshot, ALICE), true)
})

test("a mailbox slot that was never written reads as null", async () => {
  const snapshot = await readSession(client(sessionBytes()), SESSION)
  assert.equal(await readMailboxShare(client(sessionBytes(), absent), snapshot, PACKAGE, ALICE, BOB), null)
})

test("the mailbox key carries both addresses, so a share cannot be read out of another pair", async () => {
  let sent: Uint8Array | null = null
  const field = {
    $kind: "DynamicField" as const,
    value: { bcs: bcs.vector(bcs.u8()).serialize([9, 9, 9]).toBytes() },
  }
  const snapshot = await readSession(client(sessionBytes()), SESSION)
  const result = await readMailboxShare(
    client(sessionBytes(), async ({ name }: { name: { bcs: Uint8Array } }) => { sent = name.bcs; return { dynamicField: field } }),
    snapshot, PACKAGE, ALICE, BOB,
  )
  assert.deepEqual(result, new Uint8Array([9, 9, 9]))
  assert.ok(sent, "the composite key must be sent")
  const expected = bcs.struct("K", { sender: bcs.Address, recipient: bcs.Address }).serialize({ sender: ALICE, recipient: BOB }).toBytes()
  assert.deepEqual(new Uint8Array(sent!), expected)
})

// --- commitment vectors -----------------------------------------------------

test("a commitment vector round-trips point by point", async () => {
  const { encodeCommitments, decodeCommitments } = await import("./dkg-session")
  const points = [new Uint8Array(32).fill(1), new Uint8Array(32).fill(2), new Uint8Array(32).fill(3)]
  const blob = encodeCommitments(points)
  assert.equal(blob.length, 96)
  assert.deepEqual(decodeCommitments(blob), points)
})

test("a truncated commitment blob is rejected instead of silently dropping a coefficient", async () => {
  const { decodeCommitments } = await import("./dkg-session")
  for (const length of [0, 31, 33, 100]) assert.throws(() => decodeCommitments(new Uint8Array(length)), /32 字节/)
})

test("encoding rejects a point of the wrong width", async () => {
  const { encodeCommitments } = await import("./dkg-session")
  assert.throws(() => encodeCommitments([]), /不能为空/)
  assert.throws(() => encodeCommitments([new Uint8Array(33)]), /32 字节/)
})

// --- group-key attestations -------------------------------------------------

// v6 replaced the caller-supplied group key with per-member attestation. The
// reader must distinguish "never attested" (null) from a read failure, and the
// field name must be addressed to the package that first defined the struct —
// not to the current call target.

const ATTESTATION_ORIGIN = "0x" + "d4".repeat(32)

test("an unattested participant reads as null, never as an empty key", async () => {
  const snapshot = await readSession(client(sessionBytes()), SESSION)
  const { readGroupKeyAttestation } = await import("./dkg-session")
  assert.equal(await readGroupKeyAttestation(client(sessionBytes(), absent), snapshot, ATTESTATION_ORIGIN, ALICE), null)
})

test("a read failure is not swallowed into 'never attested'", async () => {
  const snapshot = await readSession(client(sessionBytes()), SESSION)
  const { readGroupKeyAttestation } = await import("./dkg-session")
  await assert.rejects(
    readGroupKeyAttestation(client(sessionBytes(), async () => { throw new Error("rpc down") }), snapshot, ATTESTATION_ORIGIN, ALICE),
    /rpc down/,
  )
})

test("the attestation lookup is addressed to the defining package and keyed by participant", async () => {
  const pk = Array.from({ length: 32 }, (_, index) => index + 1)
  let sentType = ""
  let sentName: Uint8Array | null = null
  const field = {
    $kind: "DynamicField" as const,
    value: { bcs: bcs.vector(bcs.u8()).serialize(pk).toBytes() },
  }
  const snapshot = await readSession(client(sessionBytes()), SESSION)
  const { readGroupKeyAttestation } = await import("./dkg-session")
  const result = await readGroupKeyAttestation(
    client(sessionBytes(), async ({ parentId, name }: { parentId: string; name: { type: string; bcs: Uint8Array } }) => {
      assert.equal(parentId, SESSION, "attestations live on the session object, not a table")
      sentType = name.type
      sentName = name.bcs
      return { dynamicField: field }
    }),
    snapshot, ATTESTATION_ORIGIN, ALICE,
  )
  assert.deepEqual(result, new Uint8Array(pk))
  assert.equal(sentType, `${ATTESTATION_ORIGIN}::dkg_committee::GroupKeyAttestationSlot`)
  assert.deepEqual(new Uint8Array(sentName!), bcs.struct("S", { participant: bcs.Address }).serialize({ participant: ALICE }).toBytes())
})
