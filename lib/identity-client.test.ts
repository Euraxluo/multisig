import assert from "node:assert/strict"
import { afterEach, mock, test } from "node:test"
import { bcs } from "@mysten/sui/bcs"
import { ObjectError, type SuiClientTypes } from "@mysten/sui/client"

// Public deployment configuration for isolated BCS fixtures; no network/signing in this file.
const address = (digit: string) => `0x${digit.repeat(64)}`
const packageId = address("a"), namesId = address("b"), owner = address("c"), id = address("d")
const labels = address("1"), accounts = address("2"), keys = address("3"), following = address("4")
process.env.NEXT_PUBLIC_IDENTITY_PACKAGE_ID = packageId
process.env.NEXT_PUBLIC_IDENTITY_NAMES_ID = namesId
const { identityRpc, getIdentity, getIdentityByAddress, resolveRecipient, getFollowing, getFollowingIds, getFollowers, isFollowing, followRelationship, describeRecipientRoute, getReceivedObjects, waitForIdentityTransaction } = require("./identity-client") as typeof import("./identity-client")
const Table = bcs.struct("Table", { id: bcs.Address, size: bcs.u64() })
const Names = bcs.struct("Names", { id: bcs.Address, labels: Table, accounts: Table, encryption_keys: Table })
const Name = bcs.struct("Name", { id: bcs.Address, label: bcs.string(), display_name: bcs.string(), avatar_url: bcs.string(), following: Table })
const table = (id: string) => ({ id, size: "1" })
const profile: import("./identity-client").IdentityProfile = { id, address: owner, label: "alice", displayName: "Alice", avatarUrl: "https://example.com/alice.png", encryptionKey: [], followingTable: following, followingCount: 1 }
const publicKey = [4, ...Array.from({ length: 64 }, (_, i) => i)]
const noField = () => new ObjectError("notExists", "not found", { reason: "notFound" })
const object = (objectId: string, type: string, content: Uint8Array, extra: Record<string, unknown> = {}) => ({ objectId, type, content, owner: { $kind: "AddressOwner", AddressOwner: owner }, version: "1", digest: "digest", ...extra })
function fixtures() {
  mock.method(identityRpc, "getObject", async ({ objectId, include }: SuiClientTypes.GetObjectOptions) => {
    assert.deepEqual(include, { content: true })
    if (objectId === namesId) return { object: object(namesId, `${packageId}::identity::Names`, Names.serialize({ id: namesId, labels: table(labels), accounts: table(accounts), encryption_keys: table(keys) }).toBytes()) }
    return { object: object(objectId, `${packageId}::identity::Name`, Name.serialize({ id: objectId, label: "alice", display_name: "Alice", avatar_url: profile.avatarUrl, following: table(following) }).toBytes()) }
  })
}
function field(type: string, valueType: string, bytes: Uint8Array) {
  return { dynamicField: { $kind: "DynamicField", type: `0x2::dynamic_field::Field<${type},${valueType}>`, value: { type: valueType, bcs: bytes } } }
}
function keyFixture() {
  return mock.method(identityRpc, "getDynamicField", async ({ parentId, name }: SuiClientTypes.GetDynamicFieldOptions) => {
    assert.equal(parentId, keys)
    assert.equal(name.type, "0x2::object::ID")
    return field(name.type, "vector<u8>", bcs.vector(bcs.u8()).serialize(publicKey).toBytes())
  })
}
afterEach(() => mock.restoreAll())

test("decodes the exact Name/Names BCS layouts and canonical encryption-key field", async () => {
  fixtures()
  const key = keyFixture()
  assert.deepEqual(await getIdentity(id), { ...profile, encryptionKey: publicKey })
  assert.equal(bcs.Address.parse(key.mock.calls[0].arguments[0].name.bcs), id)
})

test("rejects objects with a different contract type or non-address ownership", async () => {
  for (const extra of [{ type: `${packageId}::identity::Names` }, { owner: { $kind: "ObjectOwner", ObjectOwner: owner } }, { owner: { $kind: "Shared", Shared: { initialSharedVersion: "1" } } }]) {
    mock.method(identityRpc, "getObject", async () => ({ object: object(id, `${packageId}::identity::Name`, new Uint8Array(), extra) }))
    await assert.rejects(getIdentity(id), /不是当前协议的身份|地址所有者/)
    mock.restoreAll()
  }
})

test("validates the configured Names type and rejects missing key registrations", async () => {
  fixtures()
  mock.method(identityRpc, "getDynamicField", async () => { throw noField() })
  await assert.rejects(getIdentity(id), /未登记/)
  mock.restoreAll()
  mock.method(identityRpc, "getObject", async () => ({ object: object(namesId, `${address("e")}::identity::Names`, new Uint8Array()) }))
  await assert.rejects(getIdentityByAddress(owner), /Names 对象/)
})

test("treats only a typed missing dynamic field as no identity or no follow edge", async () => {
  fixtures()
  mock.method(identityRpc, "getDynamicField", async () => { throw noField() })
  assert.equal(await getIdentityByAddress(owner), null)
  assert.equal(await isFollowing(profile, id), false)
  mock.restoreAll()
  for (const error of [new Error("network unavailable"), new ObjectError("INTERNAL", "internal error", { reason: "unknown" })]) {
    fixtures()
    mock.method(identityRpc, "getDynamicField", async () => { throw error })
    await assert.rejects(getIdentityByAddress(owner), error)
    await assert.rejects(isFollowing(profile, id), error)
    mock.restoreAll()
  }
})

test("serializes address and protocol-label lookup keys and returns the stable receiving ID", async () => {
  fixtures()
  mock.method(identityRpc, "getDynamicField", async ({ parentId, name }: SuiClientTypes.GetDynamicFieldOptions) => {
    if (parentId === keys) return field(name.type, "vector<u8>", bcs.vector(bcs.u8()).serialize([]).toBytes())
    if (parentId === accounts) {
      assert.equal(name.type, "address")
      assert.equal(bcs.Address.parse(name.bcs), owner)
    } else {
      assert.equal(parentId, labels)
      assert.equal(name.type, "0x1::string::String")
      assert.equal(bcs.string().parse(name.bcs), "alice")
    }
    return field(name.type, "0x2::object::ID", bcs.Address.serialize(id).toBytes())
  })
  assert.equal((await getIdentityByAddress(owner))?.id, id)
  const resolved = await resolveRecipient(" ALICE.id ")
  assert.equal(resolved.address, id)
  assert.equal(resolved.identity?.address, owner)
  assert.equal(resolved.kind, "protocol")
})

test("the relationship label needs both directed edges and never reports self as mutual", () => {
  assert.equal(followRelationship(true, false, false), "self")
  assert.equal(followRelationship(true, true, true), "self")
  assert.equal(followRelationship(false, true, true), "mutual")
  assert.equal(followRelationship(false, true, false), "following")
  assert.equal(followRelationship(false, false, true), "followed-by")
  assert.equal(followRelationship(false, false, false), "none")
})

test("only an identity-object recipient is routed with a withdrawal caution", () => {
  assert.equal(describeRecipientRoute({ kind: "address" }), null)
  assert.equal(describeRecipientRoute({ kind: "suins" })?.tone, "plain")
  const protocol = describeRecipientRoute({ kind: "protocol" })
  assert.equal(protocol?.tone, "caution")
  assert.match(protocol!.message, /收件箱/)
  assert.match(protocol!.message, /不是钱包地址/)
})

test("reads follow membership as bool BCS and rejects a wrong table schema", async () => {
  mock.method(identityRpc, "getDynamicField", async ({ name }: SuiClientTypes.GetDynamicFieldOptions) => {
    assert.equal(bcs.Address.parse(name.bcs), id)
    return field(name.type, "bool", bcs.bool().serialize(true).toBytes())
  })
  assert.equal(await isFollowing(profile, id), true)
  mock.restoreAll()
  mock.method(identityRpc, "getDynamicField", async () => field("address", "bool", bcs.bool().serialize(true).toBytes()))
  await assert.rejects(isFollowing(profile, id), /字段类型/)
})

test("paginates following IDs from dynamic-field BCS names", async () => {
  fixtures()
  keyFixture()
  const cursors: unknown[] = []
  mock.method(identityRpc, "listDynamicFields", async ({ cursor, parentId }: SuiClientTypes.ListDynamicFieldsOptions) => {
    assert.equal(parentId, following)
    cursors.push(cursor)
    return { dynamicFields: [{ $kind: "DynamicField", type: "0x2::dynamic_field::Field<0x2::object::ID,bool>", name: { type: "0x2::object::ID", bcs: bcs.Address.serialize(cursor ? address("e") : id).toBytes() } }], hasNextPage: !cursor, cursor: cursor ? null : "next-page" }
  })
  assert.deepEqual((await getFollowing(profile)).map(item => item.id), [id, address("e")])
  assert.deepEqual(cursors, [null, "next-page"])
})

test("rejects a dynamic-field pagination cursor that does not advance", async () => {
  mock.method(identityRpc, "listDynamicFields", async () => ({ dynamicFields: [], hasNextPage: true, cursor: null }))
  await assert.rejects(getFollowing(profile), /分页未前进/)
})

// Followed/Unfollowed share the payload { sender: ID, target: ID }.
const FollowEdge = bcs.struct("FollowEdge", { sender: bcs.Address, target: bcs.Address })
const follower = (value: string) => ({ ...profile, id: value, address: value, label: `user-${value.slice(2, 6)}` })
const followType = `${packageId}::identity::Followed`
const unfollowType = `${packageId}::identity::Unfollowed`
function followEvent(sender: string, target: string, checkpoint: string, eventIndex = 0, transactionDigest = "digest") {
  return { eventType: followType, sender, checkpoint, eventIndex, transactionDigest, bcs: FollowEdge.serialize({ sender, target }).toBytes() }
}
function unfollowEvent(sender: string, target: string, checkpoint: string, eventIndex = 0) {
  return { ...followEvent(sender, target, checkpoint, eventIndex), eventType: unfollowType }
}
// Both event types now come from one emitModule stream, so every query returns
// the same newest-first list and pagination is asserted per page index.
function stream(pages: unknown[][]) { let index = 0
  return mock.method(identityRpc, "listEvents", async ({ filter }: SuiClientTypes.ListEventsOptions) => {
    assert.deepEqual(filter, { emitModule: `${packageId}::identity` })
    const events = pages[index++] ?? []
    return { events, hasNextPage: index < pages.length, startCursor: null, endCursor: index < pages.length ? `cursor-${index}` : null }
  })
}

test("rebuilds followers from the newest edge per sender and keeps unfollows out", async () => {
  const bob = address("e"), carol = address("f")
  stream([[
    followEvent(bob, id, "30"),
    unfollowEvent(carol, id, "20"),
    followEvent(carol, id, "10"),
    followEvent(carol, address("9"), "40"),
  ]])
  const resolved: string[] = []
  const result = await getFollowers(profile, {
    followingIds: new Set([bob]),
    resolveProfile: async value => { resolved.push(value); return follower(value) },
  })
  assert.deepEqual(result.followers.map(row => [row.profile.id, row.mutual]), [[bob, true]])
  assert.equal(result.historicalUnfollows, 1)
  assert.equal(result.truncated, false)
  assert.equal(result.scannedEvents, 4)
  // Stream order decides: carol's unfollow is newer than her follow, so only bob resolves.
  assert.deepEqual(resolved, [bob])
})

test("keeps ledger order instead of comparing per-transaction event indexes", async () => {
  const bob = address("e"), carol = address("f")
  // Same checkpoint, two transactions, both event_index 0. (checkpoint,eventIndex)
  // cannot order these; the descending stream already did.
  stream([[
    { ...unfollowEvent(bob, id, "500"), eventIndex: 0, transactionDigest: "tx-a" },
    { ...followEvent(bob, id, "500"), eventIndex: 0, transactionDigest: "tx-b" },
    { ...followEvent(carol, id, "500"), eventIndex: 0, transactionDigest: "tx-c" },
  ]])
  const result = await getFollowers(profile, { followingIds: new Set(), resolveProfile: async value => follower(value) })
  assert.deepEqual(result.followers.map(row => row.profile.id), [carol])
  assert.equal(result.historicalUnfollows, 1)
})

test("ignores message events from the same module stream", async () => {
  const bob = address("e")
  stream([[{ eventType: `${packageId}::identity::MessageSent`, sender: bob, checkpoint: "1", eventIndex: 0, transactionDigest: "m", bcs: new Uint8Array() }, followEvent(bob, id, "2")]])
  const result = await getFollowers(profile, { followingIds: new Set(), resolveProfile: async value => follower(value) })
  assert.deepEqual(result.followers.map(row => row.profile.id), [bob])
  assert.equal(result.scannedEvents, 2)
})

test("flags a truncated follower scan instead of presenting a complete list", async () => {
  stream([[followEvent(address("e"), id, "1")], [], []])
  const result = await getFollowers(profile, { maxPages: 2, followingIds: new Set(), resolveProfile: async value => follower(value) })
  assert.equal(result.truncated, true)
  assert.equal(result.followers.length, 1)
})

test("rejects follower events without a checkpoint or from a different owner", async () => {
  stream([[{ ...followEvent(address("e"), id, "1"), checkpoint: null }]])
  await assert.rejects(getFollowers(profile, { followingIds: new Set() }), /checkpoint/)
  mock.restoreAll()

  stream([[followEvent(address("e"), id, "1")]])
  await assert.rejects(getFollowers(profile, { followingIds: new Set(), resolveProfile: async value => ({ ...follower(value), address: address("8") }) }), /发送方与身份所有者不匹配/)
  mock.restoreAll()

  // A cursor that never advances must fail loudly rather than loop.
  mock.method(identityRpc, "listEvents", async () => ({ events: [], hasNextPage: true, startCursor: null, endCursor: "same" }))
  await assert.rejects(getFollowers(profile, { followingIds: new Set() }), /分页未前进/)
})

test("collects outgoing follower IDs for mutual checks and rejects foreign tables", async () => {
  mock.method(identityRpc, "listDynamicFields", async () => ({ dynamicFields: [{ $kind: "DynamicField", type: "0x2::dynamic_field::Field<0x2::object::ID,bool>", name: { type: "0x2::object::ID", bcs: bcs.Address.serialize(id).toBytes() } }], hasNextPage: false, cursor: null }))
  assert.deepEqual([...(await getFollowingIds(profile))], [id])
  mock.restoreAll()
  mock.method(identityRpc, "listDynamicFields", async () => ({ dynamicFields: [{ $kind: "DynamicField", type: "0x2::dynamic_field::Field<address,bool>", name: { type: "address", bcs: bcs.Address.serialize(id).toBytes() } }], hasNextPage: false, cursor: null }))
  await assert.rejects(getFollowingIds(profile), /字段类型/)
})

test("preserves receiving object versions/digests and paginates AddressOwner(Name ID) objects", async () => {
  const version = "18446744073709551614"
  const cursors: unknown[] = []
  mock.method(identityRpc, "listOwnedObjects", async ({ owner: expectedOwner, cursor }: SuiClientTypes.ListOwnedObjectsOptions) => {
    assert.equal(expectedOwner, id)
    cursors.push(cursor)
    return { objects: [object(cursor ? address("f") : address("e"), "0x2::coin::Coin<0x2::sui::SUI>", new Uint8Array(), { owner: { $kind: "AddressOwner", AddressOwner: id }, version, digest: "unchanged-digest" })], hasNextPage: !cursor, cursor: cursor ? null : "next-owned" }
  })
  const received = await getReceivedObjects(profile)
  assert.equal(received.length, 2)
  assert.equal(received[0].version, version)
  assert.equal(received[0].digest, "unchanged-digest")
  assert.deepEqual(cursors, [null, "next-owned"])
})

test("confirms gRPC transaction effects and surfaces failed or unavailable status", async () => {
  const wait = mock.method(identityRpc, "waitForTransaction", async () => ({ $kind: "Transaction", Transaction: { status: { success: true, error: null }, effects: { status: { success: true, error: null } } } }))
  await waitForIdentityTransaction("transaction-digest")
  assert.deepEqual(wait.mock.calls[0].arguments[0], { digest: "transaction-digest", include: { effects: true }, timeout: 30_000 })
  mock.restoreAll()
  mock.method(identityRpc, "waitForTransaction", async () => ({ $kind: "FailedTransaction", FailedTransaction: { status: { success: false, error: { message: "MoveAbort 19" } } } }))
  await assert.rejects(waitForIdentityTransaction("failed"), /MoveAbort 19/)
  mock.restoreAll()
  mock.method(identityRpc, "waitForTransaction", async () => ({ $kind: "Transaction", Transaction: { status: { success: true, error: null } } }))
  await assert.rejects(waitForIdentityTransaction("unknown"), /无法确认/)
  mock.restoreAll()
  mock.method(identityRpc, "waitForTransaction", async () => { throw new Error("fullnode unavailable") })
  await assert.rejects(waitForIdentityTransaction("unavailable"), /fullnode unavailable/)
})

test("rejects dynamic-object ownership and failed owned-object reads", async () => {
  for (const badOwner of [{ $kind: "ObjectOwner", ObjectOwner: id }, { $kind: "AddressOwner", AddressOwner: owner }]) {
    mock.method(identityRpc, "listOwnedObjects", async () => ({ objects: [object(address("e"), "0x2::coin::Coin<0x2::sui::SUI>", new Uint8Array(), { owner: badOwner })], hasNextPage: false, cursor: null }))
    await assert.rejects(getReceivedObjects(profile), /不属于/)
    mock.restoreAll()
  }
  mock.method(identityRpc, "listOwnedObjects", async () => { throw new Error("unavailable") })
  await assert.rejects(getReceivedObjects(profile), /unavailable/)
})
