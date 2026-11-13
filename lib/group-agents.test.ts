import assert from "node:assert/strict"
import { test } from "node:test"
import { normalizeSuiAddress } from "@mysten/sui/utils"
import { createGroupAgentReader, subagentCapBcs, subagentCapIssuedBcs, type GroupAgentClient } from "./group-agents"
import { OrganizationContent, PROPOSAL_TYPE_ORIGIN } from "./proposal-chain"

const address = normalizeSuiAddress
const orgId = address("0x20"), tableId = address("0x21")
const alice = address("0xa"), bob = address("0xb"), agentAlice = address("0xd1"), agentBob = address("0xd2")
const shared = { $kind: "Shared", Shared: { initialSharedVersion: "1" } } as const
const owned = (owner: string) => ({ $kind: "AddressOwner", AddressOwner: owner }) as const
const NOW = 1_900_000_000_000

function organization() {
  return OrganizationContent.serialize({
    id: orgId, group_pk: Array.from({ length: 32 }).fill(1) as number[], threshold_weight: "2", epoch_version: "1",
    last_nonce: "0", chain_id: Array.from(new TextEncoder().encode("sui-testnet:")),
    members_weight: { id: tableId, size: "2" }, executed_proposals: { id: address("0x22"), size: "0" }, key_signers: [], key_threshold: "2",
  }).toBytes()
}

function capBytes(overrides: Partial<{ id: string; master: string; agent: string; weight: string; perTx: string; daily: string; spent: string; expires: string; revoked: boolean }> = {}) {
  return subagentCapBcs.serialize({
    id: overrides.id ?? address("0x30"), master_owner: overrides.master ?? alice, agent_address: overrides.agent ?? agentAlice,
    voter_weight: overrides.weight ?? "1", max_budget_per_tx: overrides.perTx ?? "5000000000", daily_budget_limit: overrides.daily ?? "20000000000",
    spent_today: overrides.spent ?? "0", expires_at_ms: overrides.expires ?? String(NOW + 86_400_000), is_revoked: overrides.revoked ?? false,
  }).toBytes()
}

function issuedEvent(capId: string, master: string, agent: string) {
  return {
    eventType: `${PROPOSAL_TYPE_ORIGIN}::asynchronous_proposal::SubagentCapIssuedEvent`,
    bcs: subagentCapIssuedBcs.serialize({ cap_id: capId, master_owner: master, agent_address: agent, voter_weight: "1", max_budget_per_tx: "5000000000", expires_at_ms: String(NOW + 86_400_000) }).toBytes(),
    transactionDigest: "digest-1",
  }
}

function fixture(options: {
  weights?: Record<string, number>
  caps?: Array<{ id: string; master: string; agent: string; content?: Uint8Array; owner?: unknown; type?: string }>
  events?: unknown[]
} = {}) {
  const weights = options.weights ?? { [alice]: 1, [bob]: 2 }
  const caps = new Map((options.caps ?? []).map(cap => [cap.id, {
    objectId: cap.id, type: cap.type ?? `${PROPOSAL_TYPE_ORIGIN}::asynchronous_proposal::SubagentCoSignCap`,
    owner: cap.owner ?? owned(cap.agent), content: cap.content ?? capBytes({ id: cap.id, master: cap.master, agent: cap.agent }),
  }]))
  const objects = new Map<string, { objectId: string; type: string; owner: unknown; content: Uint8Array }>([
    [orgId, { objectId: orgId, type: `${PROPOSAL_TYPE_ORIGIN}::cryptographic_org::Organization`, owner: shared, content: organization() }],
    ...caps,
  ])
  const state = { events: options.events ?? [] as unknown[] }
  const client = {
    getObject: async ({ objectId }: { objectId: string }) => {
      const object = objects.get(objectId)
      if (!object) throw new Error("Object not found")
      return { object }
    },
    listEvents: async () => ({ events: state.events, hasNextPage: false, endCursor: null, startCursor: null }),
  } as unknown as GroupAgentClient
  return { reader: createGroupAgentReader(client, async () => weights, () => NOW), state }
}

test("a delegation from a current member is active only when every contract guard holds", async () => {
  const capId = address("0x30")
  const { reader } = fixture({
    caps: [{ id: capId, master: alice, agent: agentAlice }],
    events: [issuedEvent(capId, alice, agentAlice)],
  })
  const list = await reader.listDelegations(orgId)
  assert.deepEqual(list.errors, [])
  assert.equal(list.delegations.length, 1)
  const delegation = list.delegations[0]
  assert.equal(delegation.capId, capId)
  assert.equal(delegation.masterOwner, alice)
  assert.equal(delegation.agentAddress, agentAlice)
  assert.equal(delegation.voterWeight, 1n)
  assert.equal(delegation.rosterWeight, 1n)
  assert.equal(delegation.capOwner, agentAlice)
  assert.equal(delegation.status, "ACTIVE")
})

test("a cap issued by a non-member is never listed for the group", async () => {
  const stranger = address("0xee")
  const { reader } = fixture({
    caps: [{ id: address("0x31"), master: stranger, agent: agentAlice }],
    events: [issuedEvent(address("0x31"), stranger, agentAlice)],
  })
  assert.deepEqual((await reader.listDelegations(orgId)).delegations, [])
})

test("each refusal the contract enforces is surfaced as its own status", async () => {
  const cases: Array<[string, Parameters<typeof capBytes>[0], { owner?: unknown }, string]> = [
    ["revoked", { revoked: true }, {}, "REVOKED"],
    ["expired", { expires: String(NOW - 1) }, {}, "EXPIRED"],
    ["roster weight changed", { weight: "2" }, {}, "STALE"],
    ["daily budget exhausted", { spent: "20000000000" }, {}, "EXHAUSTED"],
    ["cap not held by the agent", {}, { owner: owned(alice) }, "STALE"],
  ]
  for (const [name, overrides, options, expected] of cases) {
    const capId = address("0x32")
    const { reader } = fixture({
      caps: [{ id: capId, master: alice, agent: agentAlice, content: capBytes({ id: capId, ...overrides }), owner: options.owner }],
      events: [issuedEvent(capId, alice, agentAlice)],
    })
    const delegation = (await reader.listDelegations(orgId)).delegations[0]
    assert.equal(delegation?.status, expected, name)
    assert.match(delegation.reason, /合约/, name)
  }
})

test("a delegation whose issuer left the roster stops being group-scoped", async () => {
  const capId = address("0x35")
  const { reader } = fixture({
    weights: { [bob]: 2 },
    caps: [{ id: capId, master: alice, agent: agentAlice }],
    events: [issuedEvent(capId, alice, agentAlice)],
  })
  assert.deepEqual((await reader.listDelegations(orgId)).delegations, [])
})

test("a value that disagrees with its issuance event is reported, never shown", async () => {
  const capId = address("0x33")
  const { reader } = fixture({
    caps: [{ id: capId, master: alice, agent: agentAlice, content: capBytes({ id: capId, master: bob }) }],
    events: [issuedEvent(capId, alice, agentAlice)],
  })
  const list = await reader.listDelegations(orgId)
  assert.deepEqual(list.delegations, [])
  assert.match(list.errors[0], /不一致/)
})

test("an object that is not a co-sign cap is rejected by type", async () => {
  const capId = address("0x34")
  const { reader } = fixture({
    caps: [{ id: capId, master: alice, agent: agentAlice, type: `${PROPOSAL_TYPE_ORIGIN}::asynchronous_proposal::Proposal` }],
    events: [issuedEvent(capId, alice, agentAlice)],
  })
  const list = await reader.listDelegations(orgId)
  assert.deepEqual(list.delegations, [])
  assert.match(list.errors[0], /SubagentCoSignCap/)
})

test("a shared cap issued by create_shared_subagent_cap is active without transfer", async () => {
  const capId = address("0x36")
  const { reader } = fixture({
    caps: [{ id: capId, master: alice, agent: agentAlice, owner: shared }],
    events: [issuedEvent(capId, alice, agentAlice)],
  })
  const delegation = (await reader.listDelegations(orgId)).delegations[0]
  assert.equal(delegation.custody, "shared")
  assert.equal(delegation.capOwner, null)
  assert.equal(delegation.status, "ACTIVE")
})

test("the roster is exposed with the delegations so the UI can attribute each cap", async () => {
  const { reader } = fixture({ weights: { [alice]: 1, [bob]: 3 } })
  const list = await reader.listDelegations(orgId)
  assert.deepEqual(list.roster, [{ address: alice, weight: 1n }, { address: bob, weight: 3n }])
})

test("active delegations sort before inactive ones", async () => {
  const active = address("0x40"), revoked = address("0x41")
  const { reader } = fixture({
    caps: [
      { id: active, master: alice, agent: agentAlice },
      { id: revoked, master: bob, agent: agentBob, content: capBytes({ id: revoked, master: bob, agent: agentBob, revoked: true }) },
    ],
    events: [issuedEvent(revoked, bob, agentBob), issuedEvent(active, alice, agentAlice)],
  })
  const list = await reader.listDelegations(orgId)
  assert.deepEqual(list.delegations.map(row => row.status), ["ACTIVE", "REVOKED"])
})

test("the organization reader refuses a non-shared or non-organization object", async () => {
  const { reader } = fixture()
  await assert.rejects(reader.readOrganization(address("0x99")), /Object not found/)
  const wrongType = fixture()
  // The reader parses OrganizationContent only after checking the type tag.
  await assert.rejects((async () => {
    const fake = { getObject: async () => ({ object: { objectId: orgId, type: `${PROPOSAL_TYPE_ORIGIN}::vault::MasterCap`, owner: shared, content: organization() } }) } as unknown as GroupAgentClient
    return createGroupAgentReader(fake, async () => ({})).readOrganization(orgId)
  })(), /共享链上组织/)
  assert.ok(wrongType)
})
