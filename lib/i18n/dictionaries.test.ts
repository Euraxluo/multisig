import { test } from "node:test"
import assert from "node:assert/strict"
import { messages } from "./dictionaries"
import { translate } from "./translate"
import { detectLocale, getLocale } from "./locale-store"

test("every dictionary key exists in both locales", () => {
  const en = Object.keys(messages.en).sort()
  const zh = Object.keys(messages.zh).sort()
  assert.deepEqual(en, zh, "en and zh key sets must be identical")
})

test("no empty message values", () => {
  for (const [key, value] of Object.entries(messages.en)) {
    assert.ok(value.trim().length > 0, `empty en value: ${key}`)
  }
  for (const [key, value] of Object.entries(messages.zh)) {
    assert.ok(value.trim().length > 0, `empty zh value: ${key}`)
  }
})

test("translate interpolates params and falls back visibly", () => {
  assert.equal(translate("en", "shell.notificationsWithUnread", { count: 3 }), "Notifications, 3 unread")
  assert.equal(translate("en", "nonexistent.key"), "nonexistent.key")
})

test("node test runners default to zh so legacy Chinese assertions hold", () => {
  assert.equal(detectLocale(), "zh")
  assert.equal(getLocale(), "zh")
})
