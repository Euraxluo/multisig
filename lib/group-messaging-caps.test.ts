import assert from "node:assert/strict"
import { test } from "node:test"
import { bcs } from "@mysten/sui/bcs"
import { ObjectError } from "@mysten/sui/client"
import { normalizeSuiAddress } from "@mysten/sui/utils"
import { ChannelContent, CHANNEL_TYPE } from "./group-chat"
import { PROPOSAL_TYPE_ORIGIN } from "./proposal-chain"
import { createMessagingCapReader, messagingCapBcs, messagingCapIssuedBcs, type MessagingCapClient } from "./group-messaging-caps"

const address = normalizeSuiAddress
const channelId = address("0x50"), membersTable = address("0x51")
const alice = address("0xa"), bob = address("0xb"), agentAlice = address("0xc1")
const shared = { $kind: "Shared", Shared: { initialSharedVersion: "1" } } as const
const owned = (owner: string) => ({ $kind: "AddressOwner", AddressOwner: owner }) as const
const NOW = 1_900_000_000_000

function channelBytes() {
  return ChannelContent.serialize({
    id: channelId, org_id: address("0x60"), name: Array.from(new TextEncoder().encode("UI 验收群组")), creator: alice,
    members: { id: membersTable, size: "2" }, message_sequence: "0", staked_principal: "0", gas_subsidy_pool: "0",
    total_subsidized_gas: "0", entry_fee: "0", required_member_stake: "0", creator_yield_share_bps: "0",
    gas_subsidy_share_bps: "0", member_rebate_share_bps: "0", members_staked_pool: "0", creator_revenue_pool: "0",
    member_yield_pool: "0", total_staked_members: "0",
  }).toBytes()
}

function capBytes(overrides: { id?: string; master?: string; agent?: string; expires?: string; revoked?: boolean } = {}) {
  return messagingCapBcs.serialize({
    id: overrides.id ?? address("0x70"), master_owner: overrides.master ?? alice, agent_address: overrides.agent ?? agentAlice,
    channel_id: channelId, expires_at_ms: overrides.expires ?? String(NOW + 3_600_000), rate_limit_per_minute: "20",
    messages_sent_in_window: "0", window_start_ms: "0", is_revoked: overrides.revoked ?? false,
  }).toBytes()
}

// Cap types follow the reader's current package origin; hardcoding a legacy
// root would only test that old fixtures are ignored.
function issuedEvent(capId: string, master: string, agent: string, channel = channelId) {
  return {
    eventType: `${PROPOSAL_TYPE_ORIGIN}::onchain_chat::SubagentMessagingCapIssuedEvent`,
    bcs: messagingCapIssuedBcs.serialize({ cap_id: capId, master_owner: master, agent_address: agent, channel_id: channel, expires_at_ms: String(NOW + 3_600_000), rate_limit_per_minute: "20" }).toBytes(),
    transactionDigest: "digest-1",
  }
}

function fixture(options: { members?: string[]; caps?: Array<{ id: string; master: string; agent: string; content?: Uint8Array; owner?: unknown; type?: string }>; events?: unknown[] } = {}) {
  const members = new Set((options.members ?? [alice, bob]).map(member => normalizeSuiAddress(member)))
  const caps = new Map((options.caps ?? []).map(cap => [cap.id, {
    objectId: cap.id, type: cap.type ?? `${PROPOSAL_TYPE_ORIGIN}::onchain_chat::SubagentMessagingCap`,
    owner: cap.owner ?? shared, content: cap.content ?? capBytes({ id: cap.id, master: cap.master, agent: cap.agent }),
  }]))
  const objects = new Map<string, { objectId: string; type: string; owner: unknown; content: Uint8Array }>([
    [channelId, { objectId: channelId, type: CHANNEL_TYPE, owner: shared, content: channelBytes() }],
    ...caps,
  ])
  const client = {
    getObject: async ({ objectId }: { objectId: string }) => {
      const object = objects.get(objectId)
      if (!object) throw new Error("Object not found")
      return { object }
    },
    listEvents: async () => ({ events: options.events ?? [], hasNextPage: false, endCursor: null, startCursor: null }),
    getDynamicField: async ({ name }: { name: { bcs: Uint8Array } }) => {
      const member = normalizeSuiAddress(bcs.Address.parse(name.bcs))
      // The reader only treats a transport-neutral `notFound` as "not a member".
      if (!members.has(member)) throw new ObjectError("not_found", `Dynamic field ${member} not found`, { reason: "notFound" })
      return { dynamicField: { value: { type: "bool", bcs: bcs.bool().serialize(true).toBytes() } } }
    },
  } as unknown as MessagingCapClient
  return createMessagingCapReader(client, CHANNEL_TYPE, () => NOW)
}

test("a shared messaging cap whose master is still a member is usable", async () => {
  const capId = address("0x70")
  const reader = fixture({ caps: [{ id: capId, master: alice, agent: agentAlice }], events: [issuedEvent(capId, alice, agentAlice)] })
  const list = await reader.listCapabilities(channelId)
  assert.deepEqual(list.errors, [])
  assert.equal(list.delegations.length, 1)
  const delegation = list.delegations[0]
  assert.equal(delegation.custody, "shared")
  assert.equal(delegation.masterIsMember, true)
  assert.equal(delegation.status, "ACTIVE")
  assert.equal(delegation.rateLimitPerMinute, 20n)
})

test("each contract refusal is a distinct status", async () => {
  const cases: Array<[string, Parameters<typeof capBytes>[0] | null, { members?: string[]; owner?: unknown } | undefined, string]> = [
    ["revoked", { revoked: true }, undefined, "REVOKED"],
    ["expired", { expires: String(NOW - 1) }, undefined, "EXPIRED"],
    ["master left", null, { members: [bob] }, "STALE"],
    ["owned by another address", null, { owner: owned(alice) }, "STALE"],
  ]
  for (const [name, overrides, options, expected] of cases) {
    const capId = address("0x71")
    const reader = fixture({
      caps: [{ id: capId, master: alice, agent: agentAlice, content: overrides ? capBytes({ id: capId, ...overrides }) : undefined, owner: options?.owner }],
      events: [issuedEvent(capId, alice, agentAlice)],
      members: options?.members,
    })
    const delegation = (await reader.listCapabilities(channelId)).delegations[0]
    assert.equal(delegation?.status, expected, name)
    assert.match(delegation.reason, /合约/, name)
  }
})

test("caps from another channel are not listed", async () => {
  const capId = address("0x72")
  const reader = fixture({
    caps: [{ id: capId, master: alice, agent: agentAlice }],
    events: [issuedEvent(capId, alice, agentAlice, address("0x99"))],
  })
  assert.deepEqual((await reader.listCapabilities(channelId)).delegations, [])
})

test("a value that disagrees with its issuance event is reported, never shown", async () => {
  const capId = address("0x73")
  const reader = fixture({
    caps: [{ id: capId, master: alice, agent: agentAlice, content: capBytes({ id: capId, agent: bob }) }],
    events: [issuedEvent(capId, alice, agentAlice)],
  })
  const list = await reader.listCapabilities(channelId)
  assert.deepEqual(list.delegations, [])
  assert.match(list.errors[0], /不一致/)
})

test("the channel itself must be the deployed chat channel type", async () => {
  const reader = fixture({
    caps: [{ id: address("0x74"), master: alice, agent: agentAlice }],
    events: [issuedEvent(address("0x74"), alice, agentAlice)],
  })
  await assert.rejects(reader.listCapabilities(address("0x77")), /Object not found/)
})
