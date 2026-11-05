import assert from "node:assert/strict"
import { test, beforeEach } from "node:test"
import { GOVERNANCE_KEYS, getGovernanceVotes, normalizeGovernanceVote, readLegacyVoteRecords, saveGovernanceDraft, proposalVoteView, governanceVoteUrl, readShadowPolicy, saveShadowPolicy } from "./governance"

const values = new Map<string, string>()
const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } }
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage })
Object.defineProperty(globalThis, "window", { configurable: true, value: { dispatchEvent() {} } })
beforeEach(() => values.clear())
const put = (key: string, value: unknown) => values.set(key, JSON.stringify(value))

test("restores historical votes, drafts and old receipts without promoting a receipt to a verified ballot", () => {
  put(GOVERNANCE_KEYS.votes, [{ id: "old", title: "旧投票", status: "active", options: [{ id: "a", text: "A", votes: 4 }] }, { id: "ended", status: "completed" }])
  put(GOVERNANCE_KEYS.drafts, [{ id: "draft", source: "local-draft", status: "draft", title: "新草稿", isAnonymous: true, isTimeLockedSeal: true, targetNftType: "0x2::nft::Badge", options: [{ id: "a", text: "A", votes: 99 }] }])
  put(GOVERNANCE_KEYS.records, { old: { address: "0xb", optionIds: ["a"], digest: "legacy-digest" } })
  const rows = getGovernanceVotes("0xa")
  assert.deepEqual(rows.map(row => row.status), ["active", "completed", "draft"])
  assert.equal(rows[0].record?.digest, "legacy-digest")
  assert.equal(rows[0].record?.address, "0xb")
  assert.equal(rows[0].hasVoted, false)
  assert.deepEqual(rows[0].myVoteOptionIds, [])
  assert.equal(rows[0].options[0].votes, 4)
  assert.equal(rows[2].options[0].votes, null)
  assert.equal(rows[2].isAnonymous, true)
  assert.equal(rows[2].isTimeLockedSeal, true)
  assert.equal(rows[2].targetNftType, "0x2::nft::Badge")
})

test("invalid browser data cannot hide a valid independent store or invent fallback options", () => {
  values.set(GOVERNANCE_KEYS.votes, "broken JSON")
  put(GOVERNANCE_KEYS.drafts, [{ id: "valid" }, null, {}, "bad"])
  put(GOVERNANCE_KEYS.records, ["wrong shape"])
  const rows = getGovernanceVotes()
  assert.equal(rows.length, 1)
  assert.deepEqual(rows[0].options, [])
  assert.deepEqual(readLegacyVoteRecords(), {})
  assert.equal(normalizeGovernanceVote(null, false), null)
})

test("draft resave replaces its own ID and preserves all voting strategy fields without mutating historical votes", () => {
  const settings = { id: "draft", title: "预算", voteType: "ranked", voterSource: "hybrid", selectedGroup: "g", createTransaction: true, selectedTransaction: "template-2", isAnonymous: true, isTimeLockedSeal: true, weightType: "token", weightCalculation: "sqrt", tokenAddress: "0x2::coin::Coin", tokenSymbol: "ABC", snapshotBlock: "specific", specificBlock: "123", targetNftType: "badge", allowLinkAccess: false, voters: [{ id: "alice", address: "0xa", weight: 9 }], options: [{ id: "one", text: "One" }] }
  put(GOVERNANCE_KEYS.votes, [{ id: "old", title: "历史" }])
  put(GOVERNANCE_KEYS.drafts, [{ id: "other", title: "其他" }])
  saveGovernanceDraft(settings)
  saveGovernanceDraft({ ...settings, title: "更新预算" })
  const rows = JSON.parse(values.get(GOVERNANCE_KEYS.drafts)!)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].id, "draft")
  assert.equal(rows[0].title, "更新预算")
  assert.equal(rows[0].source, "local-draft")
  for (const key of Object.keys(settings).filter(key => key !== "title")) assert.deepEqual(rows[0][key], settings[key as keyof typeof settings])
  assert.equal(JSON.parse(values.get(GOVERNANCE_KEYS.votes)!)[0].title, "历史")
})

test("malformed drafts fail save without overwriting original data", () => {
  values.set(GOVERNANCE_KEYS.drafts, '{"original":true}')
  assert.throws(() => saveGovernanceDraft({ id: "d" }), /原始数据已保留/)
  assert.equal(values.get(GOVERNANCE_KEYS.drafts), '{"original":true}')
})

test("deduplicates a draft present in both legacy and new stores", () => {
  put(GOVERNANCE_KEYS.votes, [{ id: "same", title: "Old", status: "draft" }])
  put(GOVERNANCE_KEYS.drafts, [{ id: "same", title: "Resumed", status: "draft" }])
  assert.deepEqual(getGovernanceVotes().map(row => row.title), ["Resumed"])
})

const proposal = { id: "p", onChainId: "0x11", orgId: "0x22", title: "链上预算", description: "预算审批", groupName: "Council", status: "pending", approvals: 3, requiredApprovals: 6, voters: ["0xa"], rejectedWeight: 2, rejectingVoters: ["0xb"], voteWeights: { "0xa": 3, "0xb": 2 }, memberWeights: { "0xa": 3, "0xb": 2, "0xc": 4 }, deadlineMs: 2_000_000_000_000, rejectionSupported: true }

test("proposal view uses actual member/vote weights and both decisions without forged timestamps", () => {
  const view = proposalVoteView({ ...proposal, chainSyncedAt: "2026-10-20T00:00:00Z" }, "0xB")
  assert.equal(view.weights.total, 9)
  assert.equal(view.weights.voted, 5)
  assert.equal(view.weights.required, 6)
  assert.equal(view.totalVotes, 2)
  assert.equal(view.options[0].votes, 3)
  assert.equal(view.options[1].votes, 2)
  assert.equal(view.options[0].percentage, 60)
  assert.equal(view.hasVoted, true)
  assert.deepEqual(view.myVoteOptionIds, ["option-reject"])
  assert.equal(view.voters[1].weight, 2)
  assert.equal(view.voters[1].timestamp, undefined)
  assert.equal(view.voters[2].voted, false)
})

test("unsynced proposal cache never fabricates approvals or completed voting", () => {
  const view = proposalVoteView(proposal, "0xa")
  assert.equal(view.hasVoted, false)
  assert.equal(view.options[0].votes, null)
  assert.equal(view.options[1].votes, null)
  assert.equal(view.weights.total, null)
  assert.equal(view.totalVotes, null)
  assert.equal(view.options[0].percentage, null)
  // The outcome banner is the claim a reader trusts most, and it comes from the
  // same stored `status` as the numbers above — so it is gated identically.
  assert.equal(view.result, undefined)
})

test("an executed outcome is only shown once the row was read from chain", () => {
  const synced = proposalVoteView({ ...proposal, status: "executed", chainSyncedAt: "2026-10-20T00:00:00Z" }, "0xa")
  assert.equal(synced.result, "已执行")
  const rejectedSynced = proposalVoteView({ ...proposal, status: "rejected", chainSyncedAt: "2026-10-20T00:00:00Z" }, "0xa")
  assert.equal(rejectedSynced.result, "已拒绝")

  // Same stored status, no chain confirmation: the label must not appear.
  assert.equal(proposalVoteView({ ...proposal, status: "executed" }, "0xa").result, undefined)
  assert.equal(proposalVoteView({ ...proposal, status: "rejected" }, "0xa").result, undefined)
})

test("missing rejection deployment remains unknown instead of inferred zero", () => {
  const view = proposalVoteView({ ...proposal, rejectionSupported: false, chainSyncedAt: "now" })
  assert.equal(view.options[1].votes, null)
})

test("vote share links are specific and remove unrelated identity/group query context", () => {
  assert.equal(governanceVoteUrl("https://example.com/?person=Alice&group=g#old", "vote-1 /好"), "https://example.com/?vote=vote-1+%2F%E5%A5%BD")
})

test("saved follow strategies retain all controls and have no fabricated default addresses", () => {
  const empty = readShadowPolicy("vote")
  assert.equal(empty.leaderAddress, "")
  assert.equal(empty.subagentCapId, "")
  assert.equal(empty.enabled, false)
  const policy = { ...empty, enabled: true, leaderAddress: "0xa", subagentCapId: "0xb", strategyMode: "AI_SENTINEL" as const, minAiScore: 88, dailyQuota: 0 }
  saveShadowPolicy("vote", policy)
  assert.deepEqual(readShadowPolicy("vote"), policy)
})
