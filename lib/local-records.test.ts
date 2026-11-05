import assert from "node:assert/strict"
import { afterEach, beforeEach, test } from "node:test"
import { getPaymentTemplates, IMMUTABLE_TEMPLATE_SEEDS, isImmutableTemplateSeed, savePaymentTemplates } from "./local-records"

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

test("only full immutable seed templates are excluded; every edited or unknown variant is retained", () => {
  const seed = IMMUTABLE_TEMPLATE_SEEDS[0]
  const variants = [
    { ...seed, amount: "51" }, { ...seed, name: "My payroll" }, { ...seed, recipient: "0x1" },
    { ...seed, lastUsed: "2026-01-01" }, { ...seed, custom: "legacy metadata" },
    { id: "template-1", name: "Runtime-dated legacy template", lastUsed: "2026-01-01" },
    { id: "unknown", type: "batch", batchItems: [{ amount: "2", recipient: "0x2", token: "SUI" }] },
  ]
  const original = JSON.stringify([...IMMUTABLE_TEMPLATE_SEEDS, ...variants, null, 42])
  storage.set("sui_payment_templates", original)
  assert.equal(getPaymentTemplates().length, variants.length)
  assert.equal(getPaymentTemplates()[0].sourceStatus, "unverified")
  assert.deepEqual(getPaymentTemplates().map(({ sourceStatus, ...template }) => template), variants)
  assert.equal(storage.get("sui_payment_templates"), original)
  assert.equal(isImmutableTemplateSeed({ ...seed, amount: "51" }), false)
})

test("saving and explicitly deleting a user template preserves seed and unknown stored entries", () => {
  const seed = IMMUTABLE_TEMPLATE_SEEDS[0]
  storage.set("sui_payment_templates", JSON.stringify([seed, { ...seed, amount: "51" }, null, "unknown"]))
  savePaymentTemplates(getPaymentTemplates().map(template => ({ ...template, amount: "52" })))
  let saved = JSON.parse(storage.get("sui_payment_templates")!)
  assert.equal(saved.find((value: any) => value?.amount === "52").id, "template-1")
  assert.ok(saved.some((value: any) => isImmutableTemplateSeed(value)))
  assert.ok(saved.includes(null))
  assert.ok(saved.includes("unknown"))
  savePaymentTemplates([], "template-1")
  saved = JSON.parse(storage.get("sui_payment_templates")!)
  assert.deepEqual(saved, [seed, null, "unknown"])
})

test("malformed storage is not rewritten by reads", () => {
  storage.set("sui_payment_templates", "not JSON")
  assert.deepEqual(getPaymentTemplates(), [])
  assert.equal(storage.get("sui_payment_templates"), "not JSON")
})
