import assert from "node:assert/strict"
import { test } from "node:test"
import { normalizeSuiAddress } from "@mysten/sui/utils"
import { buildAgentVaultViews } from "./agent-vault-view"
import type { AgentVaultSnapshot } from "./agent-vault-chain"

const address = normalizeSuiAddress
const vaultId = address("0x10"), otherVault = address("0x20"), capId = address("0x13"), masterId = address("0x11"), operatorId = address("0x12"), agent = address("0xc")
const emptyTable = new Map()
const vault = (id: string, balance = 5_000_000_000n, paused = false) => ({ vaultId: id, coinType: "0x2::sui::SUI", balance, vaultVersion: 1n, totalSubagents: 1n, paused, agents: emptyTable })

function snapshot(overrides: Partial<AgentVaultSnapshot> = {}): AgentVaultSnapshot {
  return {
    vaults: [vault(vaultId)],
    masterCaps: [{ capId: masterId, vaultId }],
    operatorCaps: [{ capId: operatorId, vaultId, vaultVersion: 1n, operatorAddress: address("0xa") }],
    cards: [{
      capId, vaultId, vault: vault(vaultId), effectiveSpent: 250_000_000n, epochKnown: true, status: "active", reason: "ok", spentEventsTruncated: false, spentEventsError: "",
      cap: { capId, vaultId, vaultVersion: 1n, agentId: agent, capOwner: agent },
      record: { dailyBudget: 1_000_000_000n, spentInEpoch: 250_000_000n, lastSpentEpoch: 10n, isActive: true, serviceHash: new Uint8Array([1, 2]) },
      spentEvents: [{ digest: "d", amount: 250_000_000n, epoch: 10n, recipient: address("0xb"), timestampMs: 1_700_000_000_000 }],
    }],
    errors: [],
    ...overrides,
  }
}

test("a verified capability projects only chain values plus an explicit local label", () => {
  const { vaults, unverified } = buildAgentVaultViews(snapshot(), {
    [capId]: { capId, name: "Qwen", purpose: "推理", category: "LLM_INFERENCE" },
  })
  assert.deepEqual(unverified, [])
  assert.equal(vaults.length, 1)
  const view = vaults[0]
  assert.equal(view.balanceUnits, 5_000_000_000n)
  assert.deepEqual(view.masterCapIds, [masterId])
  assert.deepEqual(view.operatorCaps, [{ capId: operatorId, vaultVersion: 1n }])
  const cap = view.caps[0]
  assert.equal(cap.status, "ACTIVE")
  assert.equal(cap.effectiveSpentUnits, 250_000_000n)
  assert.equal(cap.spentInEpochUnits, 250_000_000n)
  assert.equal(cap.capOwner, agent)
  assert.deepEqual(cap.label, { name: "Qwen", purpose: "推理", category: "LLM_INFERENCE" })
  assert.deepEqual(cap.spends.map(row => [row.digest, row.amountUnits]), [["d", 250_000_000n]])
})

test("a capability without a local label has no invented name", () => {
  const cap = buildAgentVaultViews(snapshot(), {}).vaults[0].caps[0]
  assert.equal(cap.label, null)
})

test("a capability whose vault is unverified is listed separately, never attached to another vault", () => {
  const broken = {
    capId: address("0x99"), vaultId: "", effectiveSpent: 0n, epochKnown: true, status: "unverified" as const, reason: "vault missing",
    vault: vault("", 0n), cap: null, record: null, spentEvents: [], spentEventsTruncated: false, spentEventsError: "",
  }
  const { vaults, unverified } = buildAgentVaultViews(snapshot({ cards: [broken, ...snapshot().cards] }), {})
  assert.deepEqual(unverified, [{ capId: address("0x99"), reason: "vault missing" }])
  assert.deepEqual(vaults[0].caps.map(cap => cap.capId), [capId])
  assert.equal(vaults.length, 1)
})

test("statuses map one-to-one and quotas are not reported as a pause", () => {
  const base = snapshot()
  const statuses = (["active", "quota", "paused", "stale"] as const).map(status => {
    const card = { ...base.cards[0], status }
    return buildAgentVaultViews({ ...base, cards: [card] }, {}).vaults[0].caps[0].status
  })
  assert.deepEqual(statuses, ["ACTIVE", "QUOTA_REACHED", "PAUSED", "STALE"])
})

test("an unrecognised local category degrades to CUSTOM instead of leaking into the UI", () => {
  const cap = buildAgentVaultViews(snapshot(), { [capId]: { capId, name: "", purpose: "", category: "HACK" } }).vaults[0].caps[0]
  assert.deepEqual(cap.label, { name: "未命名副卡", purpose: "", category: "CUSTOM" })
})

test("two vaults keep their own balances, capabilities and caps", () => {
  const base = snapshot()
  const secondVault = vault(otherVault, 1n)
  const { vaults } = buildAgentVaultViews({
    ...base,
    vaults: [...base.vaults, secondVault],
    masterCaps: [...base.masterCaps, { capId: address("0x21"), vaultId: otherVault }],
  }, {})
  assert.deepEqual(vaults.map(v => [v.vaultId, v.balanceUnits, v.masterCapIds.length, v.caps.length]), [[vaultId, 5_000_000_000n, 1, 1], [otherVault, 1n, 1, 0]])
})
