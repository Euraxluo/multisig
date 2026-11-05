import assert from "node:assert/strict"
import { test } from "node:test"
import { normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils"
import {
  buildCreatePayment, buildPaymentAction, claimableUnits, createScheduledPaymentsReader,
  FREQUENCY_MS, PaymentBcs, PaymentCapBcs, PaymentCreatedBcs, paymentUnits,
  recurringCount, vestedUnits, ZERO_SCOPE, type NewRecurringPayment, type PaymentSnapshot,
} from "./scheduled-payments-chain"

const address = normalizeSuiAddress
const pkg = address("0x999")
const origin = address("0x888")
const id = address("0x10")
const capId = address("0x11")
const alice = address("0xa")
const bob = address("0xb")
const sui = normalizeStructTag("0x2::sui::SUI")
const type = (name: string) => `${origin}::scheduled_payments::${name}`
const u64 = (value: bigint) => Buffer.from(value.toString(16).padStart(16, "0").match(/../g)!.reverse().join(""), "hex")
const addr = (value: string) => Buffer.from(value.slice(2), "hex")

// Independent BCS bytes: uleb enum tags, little-endian u64s and byte-vector length.
const streamFixture = Uint8Array.from(Buffer.concat([
  addr(id), addr(bob), addr(alice), addr(ZERO_SCOPE), Buffer.from([3, 112, 97, 121]),
  Buffer.from([1]), u64(1_000n), Buffer.from([50]), u64(100n), u64(0n), Buffer.from([0]),
  u64(101n), u64(101n), u64(0n), u64(0n), u64(0n),
]))
const payment = (): PaymentSnapshot => ({ ...PaymentBcs.parse(streamFixture), coinType: sui, capId })
const recurring = (approval = false): PaymentSnapshot => ({ ...payment(), funded: "30", balance: "30", schedule: { $kind: "Recurring", Recurring: { amount: "10", interval_ms: "1000", max_count: "3", end_ms: "2100", requires_approval: approval } } })
const newRecurring = (): NewRecurringPayment => ({ recipient: bob, name: "salary", coinType: sui, funding: 30n, startMs: 100n, amount: 10n, intervalMs: 1000n, maxCount: 3n, endMs: 2100n, requiresApproval: true })

test("decimal input preserves u64 amounts and rejects rounding, exponents and excess precision", () => {
  assert.equal(paymentUnits("18446744073.709551615", 9), (1n << 64n) - 1n)
  assert.equal(paymentUnits("0.000000001", 9), 1n)
  for (const value of ["0", "-1", "1e3", "0.0000000001", "18446744073.709551616", "NaN", "Infinity"]) assert.throws(() => paymentUnits(value, 9))
})

test("inclusive end date and occurrences resolve deterministic fixed-millisecond schedules", () => {
  assert.equal(FREQUENCY_MS.monthly, 30n * FREQUENCY_MS.daily)
  assert.equal(FREQUENCY_MS.yearly, 365n * FREQUENCY_MS.daily)
  assert.equal(recurringCount(100n, 1000n, "date", "", 1099n), 1n)
  assert.equal(recurringCount(100n, 1000n, "date", "", 1100n), 2n)
  assert.equal(recurringCount(100n, 1000n, "occurrences", "3"), 3n)
  assert.equal(recurringCount(100n, 1000n, "never", ""), 0n)
  assert.throws(() => recurringCount(100n, 1000n, "date", "", 99n))
  assert.throws(() => recurringCount(100n, 1000n, "occurrences", "1.5"))
})

test("BCS stream fixture decodes exact fields and enum discriminants", () => {
  const snapshot = payment()
  assert.equal(snapshot.id, id)
  assert.equal(snapshot.recipient, bob)
  assert.equal(snapshot.refund_address, alice)
  assert.equal(snapshot.scope, ZERO_SCOPE)
  assert.equal(new TextDecoder().decode(Uint8Array.from(snapshot.name)), "pay")
  assert.deepEqual(snapshot.schedule, { $kind: "Stream", Stream: { duration_ms: "1000", curve: 50 } })
  assert.equal(snapshot.status.$kind, "Active")
  assert.equal(snapshot.funded, "101")
  assert.equal(snapshot.balance, "101")
  assert.equal(snapshot.paid, "0")
  assert.equal(snapshot.refunded, "0")
})

test("projection matches exact vesting, pause, due, exhaustion and terminal boundaries", () => {
  assert.equal(claimableUnits(payment(), 99n), 0n)
  assert.equal(claimableUnits(payment(), 600n), 50n)
  assert.equal(claimableUnits(payment(), 1100n), 101n)
  assert.equal(claimableUnits({ ...payment(), paid: "50", funded: "100", balance: "50" }, 599n), 0n)
  assert.equal(claimableUnits({ ...payment(), paid: "500000001", funded: "1000000000", balance: "499999999", schedule: { $kind: "Stream", Stream: { duration_ms: "86400000", curve: 50 } }, start_ms: "0" }, 43200000n - 1n), 0n)
  assert.equal(claimableUnits({ ...payment(), paid: "50", balance: "51", status: { $kind: "Paused", Paused: { at_ms: "600" } } }, 5000n), 0n)
  assert.equal(claimableUnits({ ...payment(), paid: "50", balance: "51", paused_ms: "1000" }, 1850n), 25n)
  assert.equal(claimableUnits({ ...payment(), status: { $kind: "Terminated", Terminated: true } }, 5000n), 0n)
  assert.equal(claimableUnits(recurring(), 99n), 0n)
  assert.equal(claimableUnits(recurring(), 100n), 10n)
  assert.equal(claimableUnits({ ...recurring(), installments_paid: "1", paid: "10", balance: "20" }, 1099n), 0n)
  assert.equal(claimableUnits({ ...recurring(), installments_paid: "3", paid: "30", balance: "0" }, 99999n), 0n)
  assert.equal(vestedUnits(101n, 500n, 1000n, 0), 101n)
  assert.equal(vestedUnits(101n, 500n, 1000n, 100), 0n)
  const max = (1n << 64n) - 1n
  assert.equal(vestedUnits(max, max, max, 50), max)
})

test("creation PTB binds exact allocation, immutable recipient, scope, count and approval", () => {
  const tx = buildCreatePayment(newRecurring(), pkg).getData()
  const call = tx.commands.find(command => command.$kind === "MoveCall")?.MoveCall
  assert.equal(call?.package, pkg)
  assert.equal(call?.module, "scheduled_payments")
  assert.equal(call?.function, "create_recurring")
  assert.deepEqual(call?.typeArguments, [sui])
  assert.equal(call?.arguments.length, 11) // TxContext injected by Sui
  const serialized = tx.inputs.filter(input => input.$kind === "Pure").map(input => input.Pure?.bytes)
  assert.ok(serialized.includes(Buffer.from(u64(10n)).toString("base64")))
  assert.ok(serialized.includes(Buffer.from(u64(3n)).toString("base64")))
  assert.ok(serialized.includes(Buffer.from(addr(bob)).toString("base64")))
  assert.throws(() => buildCreatePayment({ ...newRecurring(), funding: 40n }, pkg), /超过计划/)
  assert.throws(() => buildCreatePayment({ ...newRecurring(), funding: 11n }, pkg), /参数/)
  const stream = buildCreatePayment({ recipient: bob, name: "stream", coinType: sui, funding: 101n, startMs: 100n, endMs: 1100n, curve: 25 }, pkg).getData()
  assert.equal(stream.commands.find(command => command.$kind === "MoveCall")?.MoveCall?.function, "create_stream")
})

test("action PTBs never accept caller-selected recipient or payout and enforce cap semantics", () => {
  const claim = buildPaymentAction(payment(), "claim", undefined, pkg).getData().commands.at(-1)?.MoveCall
  assert.equal(claim?.function, "claim")
  assert.equal(claim?.arguments.length, 2)
  assert.equal(buildPaymentAction(recurring(true), "execute_installment", undefined, pkg).getData().commands.at(-1)?.MoveCall?.arguments.length, 3)
  assert.throws(() => buildPaymentAction(recurring(true), "claim"), /逐期审批/)
  assert.throws(() => buildPaymentAction({ ...payment(), capId: undefined }, "pause"), /管理权限/)
  assert.throws(() => buildPaymentAction(recurring(), "fund", 1n), /完整期款/)
  assert.throws(() => buildPaymentAction(recurring(), "fund", 10n), /计划总额/)
  for (const action of ["pause", "resume", "terminate"] as const) assert.equal(buildPaymentAction(payment(), action, undefined, pkg).getData().commands.at(-1)?.MoveCall?.arguments.length, 3)
})

type ReaderClient = Parameters<typeof createScheduledPaymentsReader>[0]
type RawType = Awaited<ReturnType<ReaderClient["movePackageService"]["getDatatype"]>>["response"]["datatype"]
function rawType(name: string): NonNullable<RawType> {
  const primitive = (type: number) => ({ type, typeParameterInstantiation: [] })
  const datatype = (typeName: string, generic = false) => ({ type: 10, typeName, typeParameterInstantiation: generic ? [{ type: 11, typeParameter: 0, typeParameterInstantiation: [] }] : [] })
  type RawBody = NonNullable<NonNullable<RawType>["fields"][number]["type"]>
  const field = (name: string, type: RawBody, position: number) => ({ name, position, type })
  const fields = (values: Array<[string, RawBody]>) => values.map(([name, body], index) => field(name, body, index))
  const common: NonNullable<RawType> = { name, typeName: type(name), definingId: origin, module: "scheduled_payments", kind: 1, abilities: name === "Payment" ? [4] : name === "PaymentCap" ? [4, 3] : name === "PaymentCreated" ? [1, 2] : [1, 2, 3], typeParameters: ["Payment", "PaymentCreated"].includes(name) ? [{ isPhantom: true, constraints: [] }] : [], fields: [], variants: [] }
  const uid = datatype(normalizeStructTag("0x2::object::UID"))
  const objectId = datatype(normalizeStructTag("0x2::object::ID"))
  const addrType = primitive(1), numberType = primitive(6), bytes = { type: 9, typeParameterInstantiation: [primitive(3)] }
  if (name === "Payment") common.fields = fields([["id", uid], ["recipient", addrType], ["refund_address", addrType], ["scope", addrType], ["name", bytes], ["schedule", datatype(type("Schedule"))], ["start_ms", numberType], ["paused_ms", numberType], ["status", datatype(type("Status"))], ["balance", datatype(normalizeStructTag("0x2::balance::Balance"), true)], ["funded", numberType], ["paid", numberType], ["refunded", numberType], ["installments_paid", numberType]])
  if (name === "PaymentCap") common.fields = fields([["id", uid], ["payment_id", objectId]])
  if (name === "PaymentCreated") common.fields = fields([["payment_id", objectId], ["recipient", addrType], ["scope", addrType], ["name", bytes], ["schedule", datatype(type("Schedule"))], ["start_ms", numberType], ["funded", numberType]])
  if (name === "Schedule") {
    common.kind = 2
    common.variants = [{ name: "Recurring", position: 0, fields: fields([["amount", numberType], ["interval_ms", numberType], ["max_count", numberType], ["end_ms", numberType], ["requires_approval", primitive(2)]]) }, { name: "Stream", position: 1, fields: fields([["duration_ms", numberType], ["curve", primitive(3)]]) }]
  }
  if (name === "Status") {
    common.kind = 2
    common.variants = [{ name: "Active", position: 0, fields: [] }, { name: "Paused", position: 1, fields: fields([["at_ms", numberType]]) }, { name: "Terminated", position: 2, fields: [] }]
  }
  return common
}

function fakeClient() {
  let mutate: (type: NonNullable<RawType>) => void = () => {}
  let fail = false
  const dt = (name: string, generic = false) => ({ $kind: "datatype", datatype: { typeName: normalizeStructTag(name), typeParameters: generic ? [{ $kind: "typeParameter", index: 0 }] : [] } })
  const param = (body: object, reference: string | null = null) => ({ body, reference })
  const u64param = param({ $kind: "u64" }), addressParam = param({ $kind: "address" }), bytesParam = param({ $kind: "vector", vector: { $kind: "u8" } })
  const funding = param(dt("0x2::coin::Coin", true)), clock = param(dt("0x2::clock::Clock"), "immutable"), ctx = param(dt("0x2::tx_context::TxContext"), "mutable")
  const pay = param(dt(type("Payment"), true), "mutable"), cap = param(dt(type("PaymentCap")), "immutable")
  const functions: Record<string, object[]> = {
    create_recurring: [funding, addressParam, addressParam, bytesParam, u64param, u64param, u64param, u64param, u64param, param({ $kind: "bool" }), clock, ctx],
    create_stream: [funding, addressParam, addressParam, bytesParam, u64param, u64param, param({ $kind: "u8" }), clock, ctx],
    fund: [pay, cap, funding], claim: [pay, clock, ctx], execute_installment: [pay, cap, clock, ctx], pause: [pay, cap, clock], resume: [pay, cap, clock], terminate: [pay, cap, clock, ctx],
  }
  const objects = new Map([[id, { objectId: id, type: `${type("Payment")}<${sui}>`, owner: { $kind: "Shared", Shared: { initialSharedVersion: "1" } }, content: streamFixture }]])
  const client = {
    movePackageService: { getDatatype: async ({ name }: { name: string }) => {
      if (fail) throw new Error("Datatype not found")
      const datatype = rawType(name); mutate(datatype)
      return { response: { datatype } }
    } },
    getMoveFunction: async ({ name }: { name: string }) => ({ function: { visibility: "public", typeParameters: [{ constraints: [], isPhantom: false }], parameters: functions[name], returns: name.startsWith("create_") ? [param(dt("0x2::object::ID"))] : [] } }),
    getObject: async ({ objectId }: { objectId: string }) => ({ object: objects.get(objectId) }),
    listOwnedObjects: async () => ({ objects: [{ objectId: capId, type: type("PaymentCap"), content: PaymentCapBcs.serialize({ id: capId, payment_id: id }).toBytes() }], hasNextPage: false, cursor: null }),
    listEvents: async () => ({ events: [{ eventType: `${type("PaymentCreated")}<${sui}>`, sender: alice, bcs: PaymentCreatedBcs.serialize({ payment_id: id, recipient: bob, scope: ZERO_SCOPE, name: [112, 97, 121], schedule: payment().schedule, start_ms: "100", funded: "101" }).toBytes() }], hasNextPage: false, endCursor: null }),
  } as unknown as ReaderClient
  return { client, objects, mutate: (callback: typeof mutate) => { mutate = callback }, fail: (value: boolean) => { fail = value } }
}

test("deployment checks defining type origin, exact field and enum ABI then reads shared custody", async () => {
  const fake = fakeClient()
  const reader = createScheduledPaymentsReader(fake.client, pkg)
  assert.deepEqual(await reader.requireDeployment(), { origin })
  const row = await reader.readPayment(id)
  assert.equal(row.coinType, sui)
  const list = await reader.listPayments(alice)
  assert.equal(list.payments.length, 1)
  assert.equal(list.payments[0].capId, capId)
  assert.deepEqual(list.errors, [])
})

test("compatible upgrade descriptors use defining IDs even when type names contain storage package IDs", async () => {
  const fake = fakeClient()
  fake.mutate(raw => { raw.typeName = `${pkg}::scheduled_payments::${raw.name}` })
  const reader = createScheduledPaymentsReader(fake.client, pkg)
  assert.deepEqual(await reader.requireDeployment(), { origin })
  assert.equal((await reader.readPayment(id)).coinType, sui)
  for (const mutate of [
    (raw: NonNullable<RawType>) => { if (raw.name === "PaymentCap") raw.definingId = address("0x777") },
    (raw: NonNullable<RawType>) => { if (raw.name === "Payment") raw.typeName = `${address("0x777")}::scheduled_payments::Payment` },
  ]) {
    const wrong = fakeClient(); wrong.mutate(mutate)
    await assert.rejects(createScheduledPaymentsReader(wrong.client, pkg).requireDeployment(), /来源不一致/)
  }
})

test("missing deployment is explicit, retryable, and never replaced by local payment status", async () => {
  const fake = fakeClient()
  fake.fail(true)
  const reader = createScheduledPaymentsReader(fake.client, pkg)
  await assert.rejects(reader.requireDeployment(), /NEXT_PUBLIC_SCHEDULED_PAYMENTS_PACKAGE_ID/)
  fake.fail(false)
  assert.deepEqual(await reader.requireDeployment(), { origin })
})

test("ABI rejects extra fields, reordered variants and hidden generic constraints", async () => {
  for (const mutation of [
    (raw: NonNullable<RawType>) => { if (raw.name === "Payment") raw.fields.push({ name: "extra", position: 14, type: { type: 6, typeParameterInstantiation: [] } }) },
    (raw: NonNullable<RawType>) => { if (raw.name === "Status") raw.variants.reverse() },
    (raw: NonNullable<RawType>) => { if (raw.name === "Payment") raw.typeParameters[0].constraints = [3] },
    (raw: NonNullable<RawType>) => { if (raw.name === "PaymentCap") raw.abilities = [4] },
  ]) {
    const fake = fakeClient(); fake.mutate(mutation)
    await assert.rejects(createScheduledPaymentsReader(fake.client, pkg).requireDeployment(), /ABI/)
  }
})

test("reader rejects wrong type, non-shared custody and inconsistent balances", async () => {
  const fake = fakeClient()
  const row = fake.objects.get(id)!
  const reader = createScheduledPaymentsReader(fake.client, pkg)
  row.type = `${address("0x777")}::scheduled_payments::Payment<${sui}>`
  await assert.rejects(reader.readPayment(id), /共享托管付款/)
  row.type = `${type("Payment")}<${sui}>`
  row.owner.$kind = "AddressOwner"
  await assert.rejects(reader.readPayment(id), /共享托管付款/)
  row.owner.$kind = "Shared"
  row.content = PaymentBcs.serialize({ ...payment(), balance: "100" }).toBytes()
  await assert.rejects(reader.readPayment(id), /不守恒/)
})
