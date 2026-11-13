import assert from "node:assert/strict"
import { test } from "node:test"
import { normalizeSuiAddress } from "@mysten/sui/utils"
import { describeRosterChange, planRosterChange, type LiveOrganization, MAX_ROSTER_MEMBERS } from "./group-roster"

const address = normalizeSuiAddress
const alice = address("0xa"), bob = address("0xb"), carol = address("0xc")

function live(overrides: Partial<LiveOrganization> = {}): LiveOrganization {
  return {
    orgId: address("0x20"), groupPk: new Uint8Array(32).fill(1), epoch: 1n, lastNonce: 0n,
    thresholdWeight: 2n, chainId: new TextEncoder().encode("sui-testnet:"),
    members: [{ address: alice, weight: 2n }, { address: bob, weight: 1n }],
    keyGeneration: 1n,
    ...overrides,
  }
}

test("an added member produces a plan the contract will accept", () => {
  const plan = planRosterChange(live(), { members: [{ address: alice, weight: 2n }, { address: bob, weight: 1n }, { address: carol, weight: 1n }], thresholdWeight: 3n })
  assert.deepEqual(plan.priorMembers, [alice, bob])
  assert.deepEqual(plan.members, [alice, bob, carol])
  assert.deepEqual(plan.weights, [2n, 1n, 1n])
  assert.equal(plan.thresholdWeight, 3n)
  const changes = describeRosterChange(live(), plan)
  assert.deepEqual(changes, [`新增 ${carol} · 权重 1`, "门限：2 → 3"])
})

test("a removed member leaves the prior list but not the new roster", () => {
  const plan = planRosterChange(live(), { members: [{ address: alice, weight: 2n }, { address: carol, weight: 1n }], thresholdWeight: 2n })
  assert.deepEqual(plan.priorMembers, [alice, bob])
  assert.deepEqual(plan.members, [alice, carol])
  assert.deepEqual(describeRosterChange(live(), plan), [`移除 ${bob}`, `新增 ${carol} · 权重 1`])
})

test("weight changes are reported with old and new values", () => {
  const plan = planRosterChange(live(), { members: [{ address: alice, weight: 3n }, { address: bob, weight: 1n }], thresholdWeight: 2n })
  assert.deepEqual(describeRosterChange(live(), plan), [`权重 ${alice}：2 → 3`])
})

test("an unchanged roster and threshold is rejected like the contract's ENoRosterChange", () => {
  assert.throws(
    () => planRosterChange(live(), { members: [{ address: alice, weight: 2n }, { address: bob, weight: 1n }], thresholdWeight: 2n }),
    /未变化/,
  )
  // Reordering alone is still the same roster; the contract compares by address.
  assert.throws(
    () => planRosterChange(live(), { members: [{ address: bob, weight: 1n }, { address: alice, weight: 2n }], thresholdWeight: 2n }),
    /未变化/,
  )
  // A threshold-only change is a real transition.
  assert.equal(planRosterChange(live(), { members: [{ address: alice, weight: 2n }, { address: bob, weight: 1n }], thresholdWeight: 3n }).thresholdWeight, 3n)
})

test("invalid drafts are rejected before any wallet prompt", () => {
  const base = [{ address: alice, weight: 2n }, { address: bob, weight: 1n }]
  assert.throws(() => planRosterChange(live(), { members: [], thresholdWeight: 1n }), /至少需要 1 名成员/)
  assert.throws(() => planRosterChange(live(), { members: [...base, { address: alice, weight: 1n }], thresholdWeight: 2n }), /重复/)
  assert.throws(() => planRosterChange(live(), { members: [{ address: alice, weight: 2n }, { address: "not-an-address", weight: 1n }], thresholdWeight: 2n }), /地址无效/)
  assert.throws(() => planRosterChange(live(), { members: [{ address: alice, weight: 2n }, { address: bob, weight: 0n }], thresholdWeight: 1n }), /权重必须为正整数/)
  assert.throws(() => planRosterChange(live(), { members: [{ address: alice, weight: 2n }, { address: bob, weight: 1n }], thresholdWeight: 4n }), /超过名册权重总和/)
  assert.throws(() => planRosterChange(live(), { members: base, thresholdWeight: 0n }), /门限必须大于零/)
  assert.throws(
    () => planRosterChange(live(), { members: [...base, { address: "0x" + "0".repeat(64), weight: 1n }], thresholdWeight: 2n }),
    /零地址/,
  )
  const full = Array.from({ length: MAX_ROSTER_MEMBERS + 1 }, (_, index) => ({ address: address(`0x${(index + 1).toString(16)}`), weight: 1n }))
  assert.throws(() => planRosterChange(live(), { members: full, thresholdWeight: 1n }), /最多 128 名成员/)
})

test("a plan without a live roster cannot claim a prior list", () => {
  // The contract rejects an empty prior list because covers_current_roster fails.
  assert.throws(() => planRosterChange(live({ members: [] }), { members: [{ address: alice, weight: 1n }], thresholdWeight: 1n }), /链上名册为空/)
})
