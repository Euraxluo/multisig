import assert from "node:assert/strict"
import { test } from "node:test"
import type { Transaction } from "@mysten/sui/transactions"
import { normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils"
import { AgentVaultBcs as SharedAgentVaultBcs } from "multisig/agent-vault/finance"
import { AGENT_VAULT_PACKAGE_ID as SharedAgentVaultPackageId } from "multisig/agent-vault/org"
import {
  AGENT_VAULT_PACKAGE_ID, agentBudgetSpentBcs, agentCapBcs, agentSuiUnits, agentVaultBcs, addAgentCapIndex,
  createAgentVaultReader, createAgentVaultWriters,
  findCreatedAgentCap, findCreatedVaultObjects, formatSuiUnits, masterCapBcs, operatorCapBcs, parseAgentCapIndex, parseAgentLabels,
  parseLegacyAgentRecords, readAgentEpoch, removeAgentCapIndex, writeAgentLabel, type AgentVaultClient,
} from "./agent-vault-chain"

// Fixtures encode only what the deployed vault module stores. Everything the UI
// shows is derived from these objects and events, never from a local card list.
const address = normalizeSuiAddress
const pkg = address("0x999"), origin = address("0x888")
const vaultId = address("0x10"), masterId = address("0x11"), operatorId = address("0x12"), agentCapId = address("0x13")
const alice = address("0xa"), bob = address("0xb"), agent = address("0xc")
const sui = normalizeStructTag("0x2::sui::SUI")
const shared = { $kind: "Shared", Shared: { initialSharedVersion: "1" } } as const
const owned = (owner: string) => ({ $kind: "AddressOwner", AddressOwner: owner }) as const

function fixture(overrides: { vaultVersion?: bigint; paused?: boolean; capVersion?: bigint; capActive?: boolean; spent?: bigint; budget?: bigint; capOwner?: string; lastSpentEpoch?: string; epoch?: string; eventsError?: string; eventsTruncated?: boolean; epochError?: string } = {}) {
  // 2026-10-29 起：额度/启停在金库内联 agents 表（VecMap），AgentCap 只是身份凭证。
  const vault = agentVaultBcs.serialize({
    id: vaultId, balance: "5000000000", vault_version: (overrides.vaultVersion ?? 1n).toString(), total_subagents: "1", paused: overrides.paused ?? false,
    agents: { contents: [{
      key: agent,
      value: {
        daily_budget_limit: (overrides.budget ?? 1_000_000_000n).toString(), spent_in_current_epoch: (overrides.spent ?? 0n).toString(),
        last_spent_epoch: overrides.lastSpentEpoch ?? "10", service_target_hash: Array.from(new TextEncoder().encode("api.example::infer")), is_active: overrides.capActive ?? true,
      },
    }] },
    max_epoch_outflow: "1000000000000", epoch_outflow: "0", outflow_epoch: "10", max_agent_budget: "500000000000",
  }).toBytes()
  const master = masterCapBcs.serialize({ id: masterId, vault_id: vaultId }).toBytes()
  const operator = operatorCapBcs.serialize({ id: operatorId, vault_id: vaultId, vault_version: "1", operator_address: alice }).toBytes()
  const cap = agentCapBcs.serialize({
    id: agentCapId, vault_id: vaultId, vault_version: (overrides.capVersion ?? 1n).toString(), agent_id: agent,
  }).toBytes()
  const objects = new Map<string, { objectId: string; type: string; owner: unknown; content: Uint8Array }>([
    [vaultId, { objectId: vaultId, type: `${origin}::vault::AgentVault<${sui}>`, owner: shared, content: vault }],
    [masterId, { objectId: masterId, type: `${origin}::vault::MasterCap`, owner: owned(alice), content: master }],
    [operatorId, { objectId: operatorId, type: `${origin}::vault::OperatorCap`, owner: owned(alice), content: operator }],
    [agentCapId, { objectId: agentCapId, type: `${origin}::vault::AgentCap`, owner: owned(overrides.capOwner ?? alice), content: cap }],
  ])
  const state = { events: [] as Array<{ eventType: string; bcs: Uint8Array; transactionDigest: string }>, transactionError: false, duplicatePages: false, eventPages: 0 }
  const client = {
    getObject: async ({ objectId }: { objectId: string }) => {
      const object = objects.get(objectId)
      if (!object) throw new Error("Object not found")
      return { object }
    },
    getObjects: async () => assert.fail("reader must not batch objects"),
    listOwnedObjects: async ({ owner, type }: { owner: string; type: string }) => ({
      objects: [...objects.values()].filter(object => object.type === type && (object.owner as { $kind: string; AddressOwner?: string }).$kind === "AddressOwner" && (object.owner as { AddressOwner: string }).AddressOwner === owner),
      hasNextPage: state.duplicatePages, cursor: state.duplicatePages ? "same" : null,
    }),
    listEvents: async () => {
      if (overrides.eventsError) throw new Error(overrides.eventsError)
      state.eventPages++
      // An endless feed: every page reports another one, which exercises the
      // page budget and the truncation flag rather than a clean end.
      const more = !!overrides.eventsTruncated
      return { events: state.events, hasNextPage: more, endCursor: more ? `cursor-${state.eventPages}` : null, startCursor: null }
    },
    getTransaction: async ({ digest }: { digest: string }) => {
      if (state.transactionError) throw new Error("Transaction not found")
      return { $kind: "Transaction", Transaction: { digest, status: { success: true }, timestampMs: 1_700_000_000_000 } }
    },
    getCurrentSystemState: async () => {
      if (overrides.epochError) throw new Error(overrides.epochError)
      return { systemState: { epoch: overrides.epoch ?? "10", epochStartTimestampMs: "1699999000000", parameters: { epochDurationMs: "86400000" } } }
    },
  } as unknown as AgentVaultClient
  const reader = createAgentVaultReader(client, pkg, origin)
  return { objects, state, reader }
}

function spentEvent(amount: bigint, epoch = 10n, digest = "digest-1") {
  return { eventType: `${origin}::vault::AgentBudgetSpentEvent`, bcs: agentBudgetSpentBcs.serialize({ vault_id: vaultId, agent_id: agent, amount: amount.toString(), current_epoch: epoch.toString(), recipient: bob }).toBytes(), transactionDigest: digest }
}

test("vault schemas and the default package are the shared SDK's, not a fork", () => {
  assert.equal(agentVaultBcs, SharedAgentVaultBcs)
  assert.equal(AGENT_VAULT_PACKAGE_ID, SharedAgentVaultPackageId)
})

test("a live capability reports the vault balance, version and remaining budget", async () => {
  const { reader } = fixture()
  const snapshot = await reader.snapshot(alice)
  assert.deepEqual(snapshot.masterCaps, [{ capId: masterId, vaultId }])
  assert.deepEqual(snapshot.operatorCaps.map(cap => [cap.capId, cap.vaultId, cap.operatorAddress]), [[operatorId, vaultId, alice]])
  assert.deepEqual(snapshot.vaults.map(vault => vault.balance), [5_000_000_000n])
  assert.equal(snapshot.cards.length, 1)
  const card = snapshot.cards[0]
  assert.equal(card.capId, agentCapId)
  assert.equal(card.status, "active")
  assert.equal(card.vault.balance, 5_000_000_000n)
  assert.equal(card.record?.dailyBudget, 1_000_000_000n)
  assert.equal(card.cap?.agentId, agent)
  assert.equal(new TextDecoder().decode(card.record?.serviceHash), "api.example::infer")
  assert.deepEqual(snapshot.errors, [])
})

test("capability states distinguish pause, exhaustion, purge and mismatched versions", async () => {
  assert.equal((await fixture({ capActive: false }).reader.snapshot(alice)).cards[0].status, "paused")
  assert.equal((await fixture({ spent: 1_000_000_000n }).reader.snapshot(alice)).cards[0].status, "quota")
  const purged = await fixture({ vaultVersion: 2n }).reader.snapshot(alice)
  assert.equal(purged.cards[0].status, "stale")
  assert.match(purged.cards[0].reason, /版本/)
  const pausedVault = await fixture({ paused: true }).reader.snapshot(alice)
  assert.equal(pausedVault.cards[0].status, "paused")
  assert.match(pausedVault.cards[0].reason, /暂停/)
})

test("only capabilities owned by the account are discovered", async () => {
  const { reader } = fixture({ capOwner: bob })
  const snapshot = await reader.snapshot(alice)
  assert.deepEqual(snapshot.cards, [])
})

test("a capability whose vault is missing is reported unverified instead of invented", async () => {
  const { objects, reader } = fixture()
  objects.delete(vaultId)
  const snapshot = await reader.snapshot(alice)
  assert.equal(snapshot.cards[0].status, "unverified")
  assert.equal(snapshot.cards[0].cap, null)
  assert.match(snapshot.errors[0], /Object not found/)
})

test("a stored counter from a previous epoch is projected as reset, without claiming it was written", async () => {
  // Last spend was epoch 9; the chain is now epoch 10. The next spend would reset
  // the counter, so remaining budget is full even though the stored value is not 0.
  const stale = await fixture({ spent: 1_000_000_000n, lastSpentEpoch: "9", epoch: "10", budget: 1_000_000_000n })
  const card = (await stale.reader.snapshot(alice)).cards[0]
  assert.equal(card.status, "active")
  assert.equal(card.record?.spentInEpoch, 1_000_000_000n)
  assert.equal(card.effectiveSpent, 0n)
  // Same epoch: the stored counter is the real one.
  const same = await fixture({ spent: 1_000_000_000n, lastSpentEpoch: "10", epoch: "10" })
  assert.equal((await same.reader.snapshot(alice)).cards[0].status, "quota")
})

test("spend history comes from real events and keeps an unconfirmed timestamp empty", async () => {
  const { state, reader } = fixture()
  state.events = [spentEvent(120_000_000n, 10n, "digest-a"), spentEvent(80_000_000n, 9n, "digest-b")]
  let snapshot = await reader.snapshot(alice)
  assert.deepEqual(snapshot.cards[0].spentEvents.map(row => [row.amount, row.epoch, row.timestampMs]), [[120_000_000n, 10n, 1_700_000_000_000], [80_000_000n, 9n, 1_700_000_000_000]])
  state.transactionError = true
  snapshot = await reader.snapshot(alice)
  assert.deepEqual(snapshot.cards[0].spentEvents.map(row => row.timestampMs), [null, null])
})

test("a vault of an unrelated type is rejected", async () => {
  const { objects, reader } = fixture()
  const vault = objects.get(vaultId)!
  objects.set(vaultId, { ...vault, type: `${origin}::vault::AgentVault<0x2::coin::COIN>` })
  await assert.rejects(reader.readVault(vaultId), /共享 AgentVault/)
})

test("amount parsing is exact and rejects unsupported precision", () => {
  assert.equal(agentSuiUnits("1.25"), 1_250_000_000n)
  assert.equal(agentSuiUnits("0.000000001"), 1n)
  assert.equal(agentSuiUnits("3"), 3_000_000_000n)
  assert.throws(() => agentSuiUnits("1.0000000001"), /精度/)
  assert.throws(() => agentSuiUnits("-1"), /十进制/)
  assert.throws(() => agentSuiUnits("1e3"), /十进制/)
  assert.equal(formatSuiUnits(1_250_000_000n), "1.25")
  assert.equal(formatSuiUnits(0n), "0")
  assert.equal(formatSuiUnits(1n), "0.000000001")
})

test("the epoch window comes from the chain and a malformed one is rejected", async () => {
  const { reader } = fixture()
  assert.deepEqual(await readAgentEpoch(agentVaultClientStub("10", "1699999000000", "86400000")), { epoch: 10n, startedAtMs: 1_699_999_000_000, durationMs: 86_400_000 })
  await assert.rejects(readAgentEpoch(agentVaultClientStub("10", "1699999000000", "0")), /epoch 时间窗口/)
  await assert.rejects(readAgentEpoch(agentVaultClientStub("10", "not-a-number", "86400000")), /epoch 时间窗口/)
  // The fixture reader exposes the same state the UI reads.
  assert.deepEqual(await reader.readEpoch(), { epoch: 10n, startedAtMs: 1_699_999_000_000, durationMs: 86_400_000 })
})

function agentVaultClientStub(epoch: string, startedAtMs: string, durationMs: string) {
  return { getCurrentSystemState: async () => ({ systemState: { epoch, epochStartTimestampMs: startedAtMs, parameters: { epochDurationMs: durationMs } } }) } as unknown as Pick<AgentVaultClient, "getCurrentSystemState">
}

test("builders call the deployed module with the documented argument order", () => {
  const writers = createAgentVaultWriters(pkg, sui)
  // `deposit`/`spend` prepend a coin-intent command, so select the MoveCall rather
  // than assuming it is first.
  const move = (tx: Transaction) => {
    const call = tx.getData().commands.find(command => command.$kind === "MoveCall") as { MoveCall: { package: string; module: string; function: string; typeArguments: string[]; arguments: unknown[] } } | undefined
    assert.ok(call, "transaction must contain a MoveCall")
    return call.MoveCall
  }

  // initialize_vault returns a linear MasterCap: the PTB must deliver it, and a
  // builder without a recipient is refused instead of stranding the cap.
  assert.throws(() => writers.initializeVault(), /MasterCap 收件人/)
  const init = writers.initializeVault(bob)
  assert.equal(move(init).function, "initialize_vault")
  assert.deepEqual(move(init).typeArguments, [sui])
  assert.equal(init.getData().commands.some(command => command.$kind === "TransferObjects"), true)

  const deposit = writers.deposit(vaultId, 1_000_000_000n)
  assert.equal(move(deposit).function, "deposit")
  assert.deepEqual(move(deposit).typeArguments, [sui])

  const withdraw = writers.withdraw(masterId, vaultId, 500n, bob)
  assert.equal(move(withdraw).function, "withdraw")
  assert.equal(move(withdraw).arguments.length, 4)

  const issue = writers.issueOperator(masterId, vaultId, bob)
  assert.equal(move(issue).function, "issue_operator_cap")

  const spawn = writers.spawnAgent(operatorId, vaultId, agent, 2_000_000_000n, new TextEncoder().encode("svc"))
  assert.equal(move(spawn).function, "spawn_agent_card")
  assert.equal(move(spawn).arguments.length, 5)

  const budget = writers.setBudget(operatorId, vaultId, agentCapId, 3_000_000_000n)
  assert.equal(move(budget).function, "set_agent_budget")
  assert.equal(move(writers.setPaused(operatorId, vaultId, agentCapId, true)).function, "pause_agent")
  assert.equal(move(writers.setPaused(operatorId, vaultId, agentCapId, false)).function, "resume_agent")

  const spend = writers.spend(agentCapId, vaultId, 42n, bob)
  assert.equal(move(spend).function, "spend_x402_budget")
  assert.equal(move(writers.purge(masterId, vaultId, bob)).function, "emergency_unilateral_purge")
  assert.equal(move(writers.unpause(masterId, vaultId)).function, "unpause_vault")
  assert.throws(() => writers.spend(agentCapId, vaultId, 0n, bob), /大于零/)
  assert.throws(() => writers.spawnAgent(operatorId, vaultId, agent, 1n, new Uint8Array(257)), /256/)
  // A builder must never claim a target outside the configured package.
  for (const tx of [init, deposit, withdraw, issue, spawn, budget, spend]) assert.equal(move(tx).package, pkg)
})

test("deposit resolves an exact coin value for the configured type", () => {
  const writers = createAgentVaultWriters(pkg, sui)
  const tx = writers.deposit(vaultId, 1_500_000_000n)
  const commands = tx.getData().commands
  // The coin value is requested from the sender's balance, not split from gas.
  const intent = commands.find(command => command.$kind !== "MoveCall")
  assert.ok(intent, "deposit must include a coin-intent command")
  assert.equal(JSON.stringify(intent, (_, value) => typeof value === "bigint" ? value.toString() : value).includes("1500000000"), true, "the exact units must be part of the coin intent")
  assert.equal(commands.some(command => command.$kind === "MoveCall"), true)
})

test("a created vault and MasterCap are resolved from the confirmed object set, never guessed", async () => {
  const vaultBytes = agentVaultBcs.serialize({ id: vaultId, balance: "0", vault_version: "1", total_subagents: "0", paused: false, agents: { contents: [] }, max_epoch_outflow: "0", epoch_outflow: "0", outflow_epoch: "0", max_agent_budget: "0" }).toBytes()
  const capBytes = masterCapBcs.serialize({ id: masterId, vault_id: vaultId }).toBytes()
  const client = (objects: Array<unknown>, content = true) => ({
    getObjects: async () => ({ objects: objects.map((object, index) => object instanceof Error ? object : {
      objectId: [vaultId, masterId][index], type: index === 0 ? `${origin}::vault::AgentVault<${sui}>` : `${origin}::vault::MasterCap`,
      owner: index === 0 ? shared : owned(alice), content: content ? (index === 0 ? vaultBytes : capBytes) : undefined,
    }) }),
  }) as unknown as Pick<AgentVaultClient, "getObjects">
  assert.deepEqual(await findCreatedVaultObjects(client([{}, {}]), [vaultId, masterId], { typeOrigin: origin, expectedOwner: alice }), { vaultId, masterCapId: masterId })
  await assert.rejects(findCreatedVaultObjects(client([{}]), [vaultId], { typeOrigin: origin }), /无法唯一确认/)
  await assert.rejects(findCreatedVaultObjects(client([], false), [], { typeOrigin: origin }), /未创建/)
  // A MasterCap pointing at another vault must not be accepted.
  const mismatched = masterCapBcs.serialize({ id: masterId, vault_id: address("0x77") }).toBytes()
  const badClient = { getObjects: async () => ({ objects: [
    { objectId: vaultId, type: `${origin}::vault::AgentVault<${sui}>`, owner: shared, content: vaultBytes },
    { objectId: masterId, type: `${origin}::vault::MasterCap`, owner: owned(alice), content: mismatched },
  ] }) } as unknown as Pick<AgentVaultClient, "getObjects">
  await assert.rejects(findCreatedVaultObjects(badClient, [vaultId, masterId], { typeOrigin: origin }), /关联不匹配/)
  // With an expected owner, a cap delivered to anyone else fails closed...
  await assert.rejects(findCreatedVaultObjects(client([{}, {}]), [vaultId, masterId], { typeOrigin: origin, expectedOwner: bob }), /未归属当前账户/)
  // ...and so does a cap that is not address-owned at all.
  const strangerCap = { getObjects: async () => ({ objects: [
    { objectId: vaultId, type: `${origin}::vault::AgentVault<${sui}>`, owner: shared, content: vaultBytes },
    { objectId: masterId, type: `${origin}::vault::MasterCap`, owner: owned(address("0xd")), content: capBytes },
  ] }) } as unknown as Pick<AgentVaultClient, "getObjects">
  await assert.rejects(findCreatedVaultObjects(strangerCap, [vaultId, masterId], { typeOrigin: origin, expectedOwner: alice }), /未归属当前账户/)
  const sharedCap = { getObjects: async () => ({ objects: [
    { objectId: vaultId, type: `${origin}::vault::AgentVault<${sui}>`, owner: shared, content: vaultBytes },
    { objectId: masterId, type: `${origin}::vault::MasterCap`, owner: shared, content: capBytes },
  ] }) } as unknown as Pick<AgentVaultClient, "getObjects">
  await assert.rejects(findCreatedVaultObjects(sharedCap, [vaultId, masterId], { typeOrigin: origin, expectedOwner: alice }), /未归属当前账户/)
})

test("a created AgentCap is resolved from its creation set and reports its real owner", async () => {
  const capBytes = agentCapBcs.serialize({ id: agentCapId, vault_id: vaultId, vault_version: "1", agent_id: bob }).toBytes()
  const client = { getObjects: async () => ({ objects: [{ objectId: agentCapId, type: `${origin}::vault::AgentCap`, owner: owned(bob), content: capBytes }] }) } as unknown as Pick<AgentVaultClient, "getObjects">
  const cap = await findCreatedAgentCap(client, [agentCapId], { typeOrigin: origin, expectedOwner: bob })
  assert.equal(cap.capId, agentCapId)
  assert.equal(cap.agentId, bob)
  assert.equal(cap.capOwner, bob)
  await assert.rejects(findCreatedAgentCap(client, [], { typeOrigin: origin }), /未创建/)
  // A card that never reached its intended agent address is reported, not recorded.
  await assert.rejects(findCreatedAgentCap(client, [agentCapId], { typeOrigin: origin, expectedOwner: alice }), /未归属预期地址/)
})

test("the local cap index only accepts well-formed unique IDs and never duplicates", () => {
  assert.deepEqual(parseAgentCapIndex(null), [])
  assert.deepEqual(parseAgentCapIndex("not json"), [])
  assert.deepEqual(parseAgentCapIndex(JSON.stringify([agentCapId, "bad", 5, agentCapId, address("0x14")])), [agentCapId, address("0x14")])
  assert.deepEqual(addAgentCapIndex([agentCapId], address("0x14")), [address("0x14"), agentCapId])
  assert.deepEqual(addAgentCapIndex([agentCapId, address("0x14")], agentCapId), [agentCapId, address("0x14")])
  assert.deepEqual(removeAgentCapIndex([agentCapId, address("0x14")], agentCapId), [address("0x14")])
})

test("local labels are bounded, merged and never trusted for chain facts", () => {
  const first = writeAgentLabel([], { capId: agentCapId, name: "  Qwen  ", purpose: "infer", category: "LLM_INFERENCE" })
  assert.deepEqual(first, [{ capId: agentCapId, name: "Qwen", purpose: "infer", category: "LLM_INFERENCE" }])
  const second = writeAgentLabel(first, { capId: agentCapId, name: "New", purpose: "", category: "NOT_A_CATEGORY" })
  assert.deepEqual(second, [{ capId: agentCapId, name: "New", purpose: "", category: "CUSTOM" }])
  assert.deepEqual(parseAgentLabels(JSON.stringify(second)), { [agentCapId]: second[0] })
  // A label is only ever addressed by a real object id; anything else is refused.
  assert.throws(() => writeAgentLabel([], { capId: "not-an-id", name: "x", purpose: "", category: "CUSTOM" }))
})

test("legacy browser records are counted and shown as unverified history only", () => {
  const parsed = parseLegacyAgentRecords(
    [{ name: "Old card", address: "0xabc", dailyBudget: 5, purpose: "p" }, "garbage", { dailyBudget: "NaN" }],
    [{ any: "log" }, 7],
  )
  assert.deepEqual(parsed.cards, [
    { name: "Old card", address: "0xabc", dailyBudget: "5", purpose: "p" },
    { name: "未命名本机记录", address: "", dailyBudget: "未知", purpose: "" },
  ])
  assert.equal(parsed.logs, 1)
})

// --- failure is not absence -------------------------------------------------
//
// These pin the difference the UI depends on: an unreadable feed, a bounded
// scan, and a verified-with-no-history cap are three different states, and only
// the last one may read as "nothing happened".

test("a failed spend feed leaves the card verified and reports the error separately", async () => {
  const { reader } = fixture({ eventsError: "listEvents unavailable" })
  const card = (await reader.snapshot(alice)).cards[0]
  assert.equal(card.status, "active", "the cap and vault read fine; only history failed")
  assert.equal(card.spentEventsError, "listEvents unavailable")
  assert.deepEqual(card.spentEvents, [])
})

test("a spend feed that hits its page budget is flagged truncated, not silently short", async () => {
  const { reader } = fixture({ eventsTruncated: true })
  const card = (await reader.snapshot(alice)).cards[0]
  assert.equal(card.spentEventsTruncated, true)
  assert.equal(card.spentEventsError, "")
})

test("an unreadable epoch does not assert that the budget is exhausted", async () => {
  // Counter is at the limit, but the epoch is unknown, so the counter may be
  // last epoch's. The card must say so instead of claiming QUOTA_REACHED.
  const { reader } = fixture({ spent: 1_000_000_000n, epochError: "system state unavailable" })
  const card = (await reader.snapshot(alice)).cards[0]
  assert.equal(card.epochKnown, false)
  assert.equal(card.status, "quota")
  assert.match(card.reason, /纪元读取失败/)
  assert.doesNotMatch(card.reason, /已用尽；下一个/)
})

test("a known epoch still projects a stale counter to zero", async () => {
  const { reader } = fixture({ spent: 1_000_000_000n, lastSpentEpoch: "9", epoch: "10" })
  const card = (await reader.snapshot(alice)).cards[0]
  assert.equal(card.epochKnown, true)
  assert.equal(card.effectiveSpent, 0n)
  assert.equal(card.status, "active")
})

test("a corrupt local cap index is an error, not an empty index", async () => {
  const { readAgentCapIndex } = await import("./agent-vault-chain")
  assert.deepEqual(readAgentCapIndex(null), { ids: [], error: "" })
  assert.deepEqual(readAgentCapIndex(JSON.stringify([agentCapId])), { ids: [agentCapId], error: "" })
  const corrupt = readAgentCapIndex("{not json")
  assert.deepEqual(corrupt.ids, [])
  assert.match(corrupt.error, /不是有效 JSON/)
  // A valid-JSON-but-wrong-shape value is the same class of failure.
  assert.match(readAgentCapIndex('{"a":1}').error, /格式异常/)
})
