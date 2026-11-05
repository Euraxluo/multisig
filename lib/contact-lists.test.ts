import assert from "node:assert/strict"
import { test } from "node:test"
import { followersNotFollowed } from "./contact-lists"
import type { IdentityProfile } from "./identity-client"

const person = (id: string, label: string): IdentityProfile => ({
  id, address: id, label, displayName: "", avatarUrl: "", encryptionKey: [],
  followingTable: `${id}-table`, followingCount: 0,
})
const own = person(`0x${"1".repeat(64)}`, "me")
const alice = person(`0x${"2".repeat(64)}`, "alice")
const bob = person(`0x${"3".repeat(64)}`, "bob")

test("lists one-way followers only, never the owner or a mutual follow", () => {
  assert.deepEqual(
    followersNotFollowed(own, [alice], [alice, bob, own]).map(item => item.label),
    ["bob"],
  )
})

test("keeps the outgoing group authoritative when an identity appears in both", () => {
  // Mutual follows are rendered once, from the following list.
  assert.deepEqual(followersNotFollowed(own, [alice, bob], [bob, alice]).map(item => item.label), [])
})

test("collapses duplicate follower rows from a repeated event scan", () => {
  const duplicates = followersNotFollowed(own, [], [alice, alice, bob])
  assert.deepEqual(duplicates.map(item => item.label), ["alice", "bob"])
})

test("returns nothing when there are no incoming edges", () => {
  assert.deepEqual(followersNotFollowed(own, [alice, bob], []), [])
})
