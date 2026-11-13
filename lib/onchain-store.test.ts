import assert from "node:assert/strict"
import { afterEach, beforeEach, mock, test } from "node:test"
import { bcs } from "@mysten/sui/bcs"
import { SuiGrpcClient } from "@mysten/sui/grpc"
import { normalizeSuiAddress } from "@mysten/sui/utils"
import { approveProposal, executeProposal, findCreatedProtocolObject, getProposals, getUserGroups, persistGroupOrganization, proposalAmountMist, saveProposals, type ProposalItem } from "./onchain-store"
import { OrganizationContent, ProposalContent, PROPOSAL_TYPE_ORIGIN, proposalClient } from "./proposal-chain"
import { proposalVoteView } from "./governance"

const id = (n: number) => normalizeSuiAddress(`0x${n.toString(16)}`)
const storage = new Map<string, string>()
const orgId = id(10), proposalId = id(11), vaultId = id(12), capId = id(13), sender = id(14)
const table = (n: number) => ({ id: id(n), size: "0" })
const future = () => Date.now() + 60_000
let unregister: (() => void) | undefined

beforeEach(() => {
  storage.clear()
  Object.defineProperty(globalThis, "window", { configurable: true, value: Object.assign(new EventTarget(), { dispatchEvent: () => true }) })
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  } })
})
afterEach(() => {
  unregister?.(); unregister = undefined
  mock.restoreAll()
  Reflect.deleteProperty(globalThis, "window")
  Reflect.deleteProperty(globalThis, "localStorage")
})

function proposal(overrides: Partial<ProposalItem> = {}): ProposalItem {
  return { id: "saved-proposal", onChainId: proposalId, orgId, title: "Payment", description: "",
    amount: 1, amountMist: "1000000000", token: "SUI", groupId: "group-1", groupName: "My group",
    recipient: id(15), status: "approved", approvals: 1, requiredApprovals: 1,
    createdAt: "", expiresAt: "", deadlineMs: future(), type: "transfer", color: "", voters: [],
    vaultId, masterCapId: capId, ...overrides }
}

function canonicalProposal(approvedWeight = "1", afterRead?: () => void) {
  mock.method(proposalClient, "getMoveFunction", async () => {
    throw new Error("Function not found: reject_async_vote")
  })
  mock.method(proposalClient, "listDynamicFields", async () => ({ dynamicFields: [], hasNextPage: false, cursor: null }))
  mock.method(proposalClient, "getObject", async ({ objectId }: { objectId: string }) => {
    afterRead?.()
    const content = objectId === proposalId ? ProposalContent.serialize({
      id: proposalId, org_id: orgId, epoch: "1", proposer: sender, title: [...new TextEncoder().encode("Payment")],
      recipient: id(15), amount: "1000000000", threshold_weight: "1", accumulated_weight: approvedWeight,
      voters: table(20), partial_signatures: table(21), deadline_ms: String(future()), status: 1,
    }).toBytes() : OrganizationContent.serialize({
      id: orgId, group_pk: Array(32).fill(1), threshold_weight: "1", epoch_version: "1", last_nonce: "0",
      chain_id: [], members_weight: table(22), executed_proposals: table(23), key_signers: [], key_threshold: "2", genesis_stake: "0", genesis_bonded_total: "0", genesis_withdrawn: "0", genesis_unlock_at_ms: "0", key_generation: "1",
    }).toBytes()
    return { object: { objectId, type: `${PROPOSAL_TYPE_ORIGIN}::${objectId === proposalId ? "asynchronous_proposal::Proposal" : "cryptographic_org::Organization"}`, content, previousTransaction: "previous" } }
  })
}

function setupExecution() {
  storage.set("sui_proposals", JSON.stringify([proposal()]))
  storage.set("user_groups", JSON.stringify([{ id: "group-1", name: "My group", orgObjectId: orgId, vaultId, masterCapId: capId }]))
  storage.set("sui_active_account", JSON.stringify({ type: "wallet", address: sender, provider: "Test wallet" }))
}

function authority(capOwner = sender, capVault = vaultId) {
  mock.method(proposalClient, "getObjects", async () => ({ objects: [
    { objectId: vaultId, type: `${PROPOSAL_TYPE_ORIGIN}::vault::AgentVault<0x2::sui::SUI>`, content: new Uint8Array() },
    { objectId: capId, type: `${PROPOSAL_TYPE_ORIGIN}::vault::MasterCap`, owner: { $kind: "AddressOwner", AddressOwner: capOwner },
      content: bcs.struct("MasterCap", { id: bcs.Address, vault_id: bcs.Address }).serialize({ id: capId, vault_id: capVault }).toBytes() },
  ] }))
}

test("edited seed IDs, matching titles, known organizations and legacy records all remain visible without storage writes", () => {
  const records = [proposal({ id: "tx-init-1", title: "Eco Grants #1: Developer Tooling" }),
    proposal({ id: "tx-init-2", orgId: "0xaf0806fadf61ceeb76c21b40af4393e244a5d8ca91ba208d4f58537421eff2e4", txDigest: undefined }),
    { id: "unknown", custom: "retained" }]
  storage.set("sui_proposals", JSON.stringify(records))
  const groups = [{ id: "group-1", name: "Team Treasury (Sui MultiSig)", members: [{ address: (records[1] as ProposalItem).orgId }] },
    { id: "group-2", custom: "legacy" }]
  storage.set("user_groups", JSON.stringify(groups))
  assert.equal(getProposals().length, records.length)
  assert.ok(getProposals().every(value => value.sourceStatus === "unverified"))
  assert.equal(getUserGroups().length, groups.length)
  assert.equal(storage.get("sui_proposals"), JSON.stringify(records))
  assert.equal(storage.get("user_groups"), JSON.stringify(groups))
})

test("malformed legacy proposals remain visible and render through proposalVoteView without changing raw storage", () => {
  const records = [{ id: "unknown", custom: "retained" },
    { title: { invalid: true }, voters: [null, 42, "0x1"], rejectingVoters: "bad", memberWeights: [], voteWeights: { "0x1": "bad" }, chainSyncedAt: "old", sourceStatus: "chain-confirmed" }]
  const raw = JSON.stringify(records)
  storage.set("sui_proposals", raw)
  const rows = getProposals()
  assert.equal(rows.length, 2)
  for (const [index, row] of rows.entries()) {
    assert.equal(row.sourceStatus, "unverified")
    assert.equal(row.chainSyncedAt, undefined)
    assert.equal(row.amountLabel, "未知金额")
    assert.ok(row.recordIssues?.length)
    assert.deepEqual(row.rawRecord, records[index])
    assert.doesNotThrow(() => proposalVoteView(row, sender))
    const vote = proposalVoteView(row, sender)
    assert.equal(vote.totalVotes, null)
    assert.equal(vote.weights.voted, null)
    assert.equal(vote.options[0].votes, null)
  }
  assert.deepEqual(rows[0].voters, [])
  assert.deepEqual(rows[1].voters, ["0x1"])
  assert.equal(storage.get("sui_proposals"), raw)
  saveProposals([...rows, proposal({ id: "new" })])
  assert.deepEqual(JSON.parse(storage.get("sui_proposals")!).slice(0, 2), records)
})

test("malformed legacy groups and members have safe visible projections and untouched original storage", () => {
  const records = [{ id: 12, name: { invalid: true }, members: [null, 42, { address: 99, name: 12 }, { address: "0x1", name: "Known" }] }, { custom: "unknown" }]
  const raw = JSON.stringify(records)
  storage.set("user_groups", raw)
  const rows = getUserGroups()
  assert.equal(rows.length, records.length)
  for (const [index, row] of rows.entries()) {
    assert.equal(typeof row.id, "string")
    assert.equal(typeof row.name, "string")
    assert.equal(row.sourceStatus, "unverified")
    assert.ok(Array.isArray(row.members))
    assert.deepEqual(row.rawRecord, records[index])
    for (const member of row.members) {
      assert.equal(typeof member.address, "string")
      assert.equal(typeof member.name, "string")
      assert.doesNotThrow(() => member.address.toLowerCase())
    }
  }
  assert.equal(rows[0].members.length, 4)
  assert.equal(storage.get("user_groups"), raw)
})

test("proposal updates retain unknown non-record legacy entries", () => {
  storage.set("sui_proposals", JSON.stringify([proposal(), null, "unknown"]))
  saveProposals(getProposals())
  assert.deepEqual(JSON.parse(storage.get("sui_proposals")!).slice(-2), [null, "unknown"])
})

test("matching DAO records migrate missing canonical group link and preserve all unrelated fields and records", () => {
  const group = { id: "group-1", name: "My group", members: [{ address: sender, weight: 3 }], notes: "keep" }
  storage.set("user_groups", JSON.stringify([group, null, { id: "other" }]))
  const legacy = { groupId: "group-1", orgObjectId: orgId, groupPk: "pk", epoch: 2, txDigest: "confirmed", custom: "keep" }
  storage.set("dao_org_group-1", JSON.stringify(legacy))
  assert.equal(getUserGroups()[0].orgObjectId, orgId)
  const saved = JSON.parse(storage.get("user_groups")!)
  assert.deepEqual(saved[0].members, group.members)
  assert.equal(saved[0].notes, "keep")
  assert.deepEqual(saved.slice(1), [null, { id: "other" }])
  assert.equal(storage.get("dao_org_group-1"), JSON.stringify(legacy))
  assert.equal(getUserGroups()[0].sourceStatus, "unverified")
})

test("DAO migration never overwrites conflicting canonical link or accepts another group's legacy record", () => {
  for (const legacy of [{ groupId: "group-1", orgObjectId: id(99) }, { groupId: "other", orgObjectId: orgId }]) {
    const raw = JSON.stringify([{ id: "group-1", orgObjectId: orgId }])
    storage.set("user_groups", raw)
    storage.set("dao_org_group-1", JSON.stringify(legacy))
    assert.equal(getUserGroups()[0].orgObjectId, orgId)
    assert.equal(storage.get("user_groups"), raw)
  }
})

test("confirmed DKG persistence updates original group, recovery copy and listeners without inventing defaults", () => {
  storage.set("user_groups", JSON.stringify([{ id: "group-1", name: "My group", members: [], custom: "keep" }, null]))
  storage.set("dao_org_group-1", JSON.stringify({ custom: "legacy" }))
  const record = { orgObjectId: orgId, groupPk: "pk", epoch: 1, txDigest: "confirmed" }
  persistGroupOrganization("group-1", record)
  assert.equal(getUserGroups()[0].orgObjectId, orgId)
  assert.equal(getUserGroups()[0].custom, "keep")
  assert.equal(getUserGroups()[0].sourceStatus, "chain-confirmed")
  assert.equal(JSON.parse(storage.get("dao_org_group-1")!).custom, "legacy")
  assert.equal(JSON.parse(storage.get("user_groups")!)[1], null)
  assert.throws(() => persistGroupOrganization("missing", record), /原始群组/)
  assert.throws(() => persistGroupOrganization("group-1", { ...record, orgObjectId: id(99) }), /另一个链上组织/)
})

test("creation selects canonical Proposal type among unrelated created objects and rejects ambiguity", async () => {
  mock.method(proposalClient, "getObjects", async () => ({ objects: [
    { objectId: id(20), type: "0x2::table::Table<address,u64>" },
    { objectId: proposalId, type: `${PROPOSAL_TYPE_ORIGIN}::asynchronous_proposal::Proposal` },
    { objectId: id(21), type: `${PROPOSAL_TYPE_ORIGIN}::cryptographic_org::Organization` },
  ] }))
  assert.equal(await findCreatedProtocolObject([id(20), proposalId, id(21)], "asynchronous_proposal", "Proposal"), proposalId)
  mock.restoreAll()
  mock.method(proposalClient, "getObjects", async () => ({ objects: [{ objectId: id(20), type: "0x2::table::Table<address,u64>" }] }))
  await assert.rejects(findCreatedProtocolObject([id(20)], "asynchronous_proposal", "Proposal"), /无法唯一确认/)
})

test("proposal amount parsing uses exact decimal SUI units and rejects unsafe forms", () => {
  assert.equal(proposalAmountMist("1.000000001"), 1000000001n)
  assert.equal(proposalAmountMist("0.000000001"), 1n)
  assert.throws(() => proposalAmountMist("1.0000000001"), /最多支持/)
  assert.throws(() => proposalAmountMist("1e-3"), /普通十进制/)
  assert.throws(() => proposalAmountMist("0"), /大于零/)
})


test("execution ignores a locally approved status when the canonical Proposal lacks quorum", async () => {
  setupExecution(); canonicalProposal("0")
  await assert.rejects(executeProposal("saved-proposal"), /链上提案尚未通过/)
  assert.equal(getProposals()[0].status, "approved")
  assert.equal(getProposals()[0].executionDigest, undefined)
})

test("execution rejects a cap held by another account and a cap for another vault", async () => {
  for (const [owner, vault, message] of [[id(99), vaultId, /未持有/], [sender, id(99), /不属于/]] as const) {
    setupExecution(); canonicalProposal(); authority(owner, vault)
    await assert.rejects(executeProposal("saved-proposal"), message)
    mock.restoreAll()
  }
})

test("execution rejects account switches during canonical preflight", async () => {
  setupExecution(); canonicalProposal("1", () => storage.set("sui_active_account", JSON.stringify({ type: "wallet", address: id(99) }))); authority()
  await assert.rejects(executeProposal("saved-proposal"), /账户已切换/)
})

test("confirmed execution receipt survives refresh failure without fabricating executed status or erasing concurrent records", async () => {
  setupExecution(); canonicalProposal(); authority()
  const { getWallets } = await import("@mysten/wallet-standard")
  unregister = getWallets().register({ version: "1.0.0", name: "Test wallet", icon: "data:image/png;base64,", chains: ["sui:testnet"],
    accounts: [{ address: sender, publicKey: new Uint8Array(32), chains: ["sui:testnet"], features: [] }],
    features: { "standard:connect": { version: "1.0.0", connect: async () => ({ accounts: [] }) },
      "sui:signAndExecuteTransaction": { version: "2.0.0", signAndExecuteTransaction: async ({ transaction }: any) => {
        assert.equal(transaction.getData().sender, sender)
        saveProposals([...getProposals(), proposal({ id: "concurrent", onChainId: id(99) })])
        mock.method(proposalClient, "getObject", async () => { throw new Error("read unavailable") })
        return { digest: "confirmed-execution" }
      } } },
  } as any)
  mock.method(SuiGrpcClient.prototype, "waitForTransaction", async () => ({ $kind: "Transaction", Transaction: {
    digest: "confirmed-execution", status: { success: true }, effects: { status: { success: true }, changedObjects: [] }, transaction: { sender },
  } }))
  const receipt = await executeProposal("saved-proposal")
  assert.equal(receipt.digest, "confirmed-execution")
  assert.equal(getProposals()[0].executionDigest, "confirmed-execution")
  assert.equal(getProposals()[0].status, "approved")
  assert.match(getProposals()[0].syncError || "", /状态刷新失败/)
  assert.ok(getProposals().some(value => value.id === "concurrent"))
})

test("raw shared Proposal approval validates real membership and does not invent a saved group", async () => {
  storage.set("sui_active_account", JSON.stringify({ type: "wallet", address: sender }))
  canonicalProposal()
  await assert.rejects(approveProposal(proposalId), /不是此链上组织的有效成员/)
  assert.equal(storage.has("user_groups"), false)
  assert.equal(storage.has("sui_proposals"), false)
})
