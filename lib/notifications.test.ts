import assert from "node:assert/strict"
import { afterEach, beforeEach, test } from "node:test"
import { normalizeSuiAddress } from "@mysten/sui/utils"
import {
  NOTIFICATIONS_UPDATED_EVENT,
  buildProposalNotifications,
  markNotificationsRead,
  notificationReadKey,
  readNotificationKeys,
  unreadCount,
} from "./notifications"
import type { ProposalItem } from "./onchain-store"

const storage = new Map<string, string>()
beforeEach(() => {
  storage.clear()
  Object.defineProperty(globalThis, "window", { configurable: true, value: new EventTarget() })
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  } })
})
afterEach(() => {
  Reflect.deleteProperty(globalThis, "window")
  Reflect.deleteProperty(globalThis, "localStorage")
})

const address = "0x" + "a".repeat(64)
const normalized = normalizeSuiAddress(address)

function proposal(overrides: Partial<ProposalItem> = {}): ProposalItem {
  return {
    id: "p1", onChainId: "0x" + "1".repeat(64), orgId: "org", title: "Pay vendor", description: "",
    amount: 1, amountMist: "1000000000", token: "SUI", groupId: "g1", groupName: "Team", recipient: "0x2",
    status: "pending", approvals: 1, requiredApprovals: 2, createdAt: "", expiresAt: "",
    deadlineMs: Date.now() + 60_000, type: "transfer", color: "", voters: [],
    chainSyncedAt: new Date().toISOString(), memberWeights: { [normalized]: 1 },
    ...overrides,
  }
}

test("local drafts and proposals without a chain sync are excluded", () => {
  assert.deepEqual(buildProposalNotifications([proposal({ chainSyncedAt: undefined })], address), [])
  assert.deepEqual(buildProposalNotifications([proposal({ syncError: "refresh failed" })], address), [])
})

test("proposals where the account is not a voter are excluded", () => {
  assert.deepEqual(buildProposalNotifications([proposal({ memberWeights: { ["0x" + "b".repeat(64)]: 1 } })], address), [])
  assert.deepEqual(buildProposalNotifications([proposal()], ""), [])
})

test("a pending proposal awaiting this voter is unread and marked as needing a vote", () => {
  const [item] = buildProposalNotifications([proposal()], address)
  assert.equal(item.needsVote, true)
  assert.equal(item.title, "有提案等待你审批")
  assert.equal(unreadCount([item], []), 1)
})

test("an already voted proposal is not described as awaiting this voter", () => {
  const [item] = buildProposalNotifications([proposal({ voteWeights: { [normalized]: 1 } })], address)
  assert.equal(item.needsVote, false)
  assert.equal(item.title, "群组审批进度已更新")
})

test("terminal states map to their own titles", () => {
  assert.equal(buildProposalNotifications([proposal({ status: "approved" })], address)[0].title, "提案已达到执行门限")
  assert.equal(buildProposalNotifications([proposal({ status: "executed" })], address)[0].title, "群组提案已执行")
  assert.equal(buildProposalNotifications([proposal({ status: "rejected" })], address)[0].title, "群组提案已被否决")
  assert.equal(buildProposalNotifications([proposal({ deadlineMs: Date.now() - 1 })], address)[0].title, "群组提案已过期")
})

test("marking read persists per account and dispatches the shared event", () => {
  let fired = 0
  ;(window as unknown as EventTarget).addEventListener(NOTIFICATIONS_UPDATED_EVENT, () => { fired += 1 })
  const [item] = buildProposalNotifications([proposal()], address)
  markNotificationsRead(address, [item.key])
  assert.equal(fired, 1)
  assert.deepEqual(readNotificationKeys(address), [item.key])
  assert.equal(unreadCount([item], readNotificationKeys(address)), 0)
  assert.equal(storage.get(notificationReadKey(address)) !== undefined, true)
})

test("read keys from another account do not hide this account's notifications", () => {
  const [item] = buildProposalNotifications([proposal()], address)
  const other = "0x" + "c".repeat(64)
  markNotificationsRead(other, [item.key])
  assert.equal(unreadCount([item], readNotificationKeys(address)), 1)
})

test("malformed read storage falls back to no read keys and is not rewritten", () => {
  storage.set(notificationReadKey(address), "{not json")
  assert.deepEqual(readNotificationKeys(address), [])
  assert.equal(storage.get(notificationReadKey(address)), "{not json")
})

test("read keys are deduplicated and capped", () => {
  const keys = Array.from({ length: 520 }, (_, index) => `k${index}`)
  const saved = markNotificationsRead(address, keys)
  assert.equal(saved.length, 500)
  assert.equal(new Set(saved).size, 500)
})
