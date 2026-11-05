import assert from "node:assert/strict"
import { test } from "node:test"
import { shareMismatch, type StoredShare } from "./committee-share-store"

// The IndexedDB paths need a browser, so what is pinned here is the pure predicate
// that decides whether a stored share may be used at all. Everything that calls it
// must fail closed on a non-null result rather than fall back to another signer.

const ORG = "0x" + "aa".repeat(32)
const OTHER_ORG = "0x" + "bb".repeat(32)
const GROUP_PK = new Uint8Array(32).fill(1)
const OTHER_PK = new Uint8Array(32).fill(2)

const share = (overrides: Partial<StoredShare> = {}): StoredShare => ({
  orgId: ORG, groupPk: GROUP_PK, index: 1n, epoch: 3n, share: 12345n, threshold: 2n, participants: 3,
  ...overrides,
})

test("a share matches the exact organization, key and epoch it was created for", () => {
  assert.equal(shareMismatch(share(), { orgId: ORG, groupPk: GROUP_PK, epoch: 3n }), null)
})

test("organization ids compare case-insensitively", () => {
  assert.equal(shareMismatch(share({ orgId: ORG.toUpperCase().replace("0X", "0x") }), { orgId: ORG, groupPk: GROUP_PK, epoch: 3n }), null)
})

test("a share for another organization is refused", () => {
  assert.match(shareMismatch(share(), { orgId: OTHER_ORG, groupPk: GROUP_PK, epoch: 3n }) ?? "", /另一个组织/)
})

test("a share for another group key is refused, not used with the live key", () => {
  assert.match(shareMismatch(share(), { orgId: ORG, groupPk: OTHER_PK, epoch: 3n }) ?? "", /群公钥与链上不一致/)
})

test("a share from another epoch is refused with the reason, so the UI can say why", () => {
  const reason = shareMismatch(share({ epoch: 2n }), { orgId: ORG, groupPk: GROUP_PK, epoch: 3n })
  assert.match(reason ?? "", /Epoch 2/)
  assert.match(reason ?? "", /Epoch 3/)
})

test("a byte-level difference in the group key is a mismatch, not a tolerance", () => {
  const almost = new Uint8Array(GROUP_PK)
  almost[31] ^= 0xff
  assert.notEqual(shareMismatch(share(), { orgId: ORG, groupPk: almost, epoch: 3n }), null)
})
