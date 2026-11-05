import assert from "node:assert/strict"
import { test } from "node:test"
import { createAccountLoadGuard, createSubmissionGuard } from "./wallet-creation-state"

const a = { address: `0x${"1".repeat(64)}`, type: "wallet", provider: "A" }
const b = { address: `0x${"2".repeat(64)}`, type: "wallet", provider: "B" }
test("slow A cannot commit after fast B account load", () => {
  let active = a
  const guard = createAccountLoadGuard()
  const first = guard.begin(a, () => active)
  active = b
  const second = guard.begin(b, () => active)
  assert.equal(second.current(), true)
  assert.equal(first.current(), false)
})
test("submission guard rejects duplicate clicks synchronously", () => {
  const guard = createSubmissionGuard()
  assert.equal(guard.enter(), true)
  assert.equal(guard.enter(), false)
  guard.leave()
  assert.equal(guard.enter(), true)
})
