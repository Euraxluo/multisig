import assert from "node:assert/strict"
import { mock, test } from "node:test"
import { bcs } from "@mysten/sui/bcs"
import type { Transaction } from "@mysten/sui/transactions"
import { fromBase64 } from "@mysten/sui/utils"
import {
  POLICY_MODULE, createPolicyReader, findCreatedRegistry, initializeRegistry, listOwnStakeReceipts, payApp,
  parseRegistryId, policyPackageId, readSavedRegistryAdminCapId, readSavedRegistryId, registerPaymentApp,
  registryIdFromEnv, saveRegistryAdminCapId, saveRegistryId, toggleAppStatus, verifyChatChannel,
  verifyPolicyDeployment, type PolicyClient, type PolicyReaderClient,
} from "./walrus-app-policy"
import { PROPOSAL_PACKAGE_ID, PROPOSAL_TYPE_ORIGIN } from "./proposal-chain"

const address = (digit: string) => `0x${digit.repeat(64)}`
const registryId = address("a"), tableId = address("b"), fieldId = address("c"), otherField = address("d")
const channelId = address("1"), receiptId = address("2"), adminCapId = address("3"), sender = address("e")
const packageId = PROPOSAL_PACKAGE_ID
const registryType = `${packageId}::${POLICY_MODULE}::Registry`
const policyInnerType = `${PROPOSAL_TYPE_ORIGIN}::${POLICY_MODULE}::PaymentPolicy`
const policyFieldType = `0x2::dynamic_field::Field<0x1::string::String,${policyInnerType}>`

const Registry = bcs.struct("Registry", {
  id: bcs.Address,
  policies: bcs.struct("Table", { id: bcs.Address, size: bcs.u64() }),
  total_apps: bcs.u64(),
})
const Policy = bcs.struct("PaymentPolicy", {
  channel_id: bcs.Address, min_member_stake: bcs.u64(), recipient: bcs.Address, max_payment: bcs.u64(),
  epoch_budget: bcs.u64(), spent_in_epoch: bcs.u64(), last_payment_epoch: bcs.u64(), is_active: bcs.bool(),
})
const Field = bcs.struct("PolicyField", { id: bcs.Address, name: bcs.string(), value: Policy })

const shared = { $kind: "Shared", Shared: { initialSharedVersion: "1" } } as const
const owned = { $kind: "AddressOwner", AddressOwner: sender } as const

const registryObject = (size: string, extra: Record<string, unknown> = {}) => ({
  objectId: registryId, type: registryType, owner: shared,
  content: Registry.serialize({ id: registryId, policies: { id: tableId, size }, total_apps: size }).toBytes(),
  ...extra,
})

const policyBytes = (blobId: string, overrides: Partial<{ isActive: boolean }> = {}) => Field.serialize({
  id: fieldId, name: blobId,
  value: {
    channel_id: channelId, min_member_stake: "1000000000", recipient: sender, max_payment: "5000000000",
    epoch_budget: "20000000000", spent_in_epoch: "1500000000", last_payment_epoch: "42",
    is_active: overrides.isActive ?? true,
  },
}).toBytes()

// A MoveCall command carries package/module/function; its arguments reference
// transaction inputs by numeric index, and pure values arrive as BCS bytes.
interface CallInfo {
  function: string
  target: string
  args: Array<{ $kind: string; Input?: number; type?: string }>
  inputs: Array<{ $kind: string; Pure?: { bytes: string }; UnresolvedObject?: { objectId: string } }>
}

function moveCalls(tx: Transaction): CallInfo[] {
  const data = tx.getData()
  return data.commands.flatMap(command => {
    if (command.$kind !== "MoveCall") return []
    const { package: pkg, module, function: fn } = command.MoveCall
    return [{ target: `${pkg}::${module}::${fn}`, function: fn, args: command.MoveCall.arguments as CallInfo["args"], inputs: data.inputs as CallInfo["inputs"] }]
  })
}

function pureAt(call: CallInfo, index: number): Uint8Array {
  const argument = call.args[index]
  assert.equal(argument?.$kind, "Input", `argument ${index} must be an input`)
  const input = call.inputs[argument.Input!]
  assert.equal(input?.$kind, "Pure", `argument ${index} must be pure`)
  return fromBase64(input.Pure!.bytes)
}

function objectIdAt(call: CallInfo, index: number): string {
  const argument = call.args[index]
  assert.equal(argument?.$kind, "Input", `argument ${index} must be an input`)
  assert.equal(argument.type, "object", `argument ${index} must be an object`)
  const input = call.inputs[argument.Input!]
  assert.equal(input?.$kind, "UnresolvedObject", `argument ${index} must be an object input`)
  return input.UnresolvedObject!.objectId
}

test("the deployment gate resolves all five entries and fails closed on the first miss", async () => {
  const resolved = mock.fn(async (_request: { name: string }) => ({}))
  const found = await verifyPolicyDeployment({ getMoveFunction: resolved as unknown as PolicyClient["getMoveFunction"] }, packageId)
  assert.equal(found.moduleResolved, true)
  assert.equal(resolved.mock.callCount(), 5)
  assert.deepEqual(resolved.mock.calls.map(call => call.arguments[0]!.name), ["new", "share", "register_payment_app", "toggle_app_status", "pay"])

  // One missing entry stops the probe without building any transaction.
  const missing = mock.fn(async ({ name }: { name: string }) => {
    if (name === "pay") throw new Error(`Function not found: pay in module ${POLICY_MODULE}`)
    return {}
  })
  const rejected = await verifyPolicyDeployment({ getMoveFunction: missing as unknown as PolicyClient["getMoveFunction"] }, packageId)
  assert.equal(rejected.moduleResolved, false)
  assert.match(rejected.reason, /没有完整/)
  // A transport failure must not be reported as "not deployed".
  const offline = mock.fn(async () => { throw new Error("grpc transport disconnected") })
  await assert.rejects(verifyPolicyDeployment({ getMoveFunction: offline as unknown as PolicyClient["getMoveFunction"] }, packageId), /grpc/)
})

test("initialize shares the registry and delivers the AdminCap to the sender", () => {
  const tx = initializeRegistry(sender, packageId)
  const calls = moveCalls(tx)
  assert.deepEqual(calls.map(call => call.function), ["new", "share"])
  assert.equal(calls.every(call => call.target.startsWith(`${packageId}::${POLICY_MODULE}`)), true)
  // share() consumes the exact registry object returned by new().
  assert.equal(calls[1].args.length, 1)
  const transfer = tx.getData().commands.find(command => command.$kind === "TransferObjects")
  assert.ok(transfer, "the admin cap must be transferred to the sender")
  assert.throws(() => initializeRegistry("0x0", packageId), /发起地址/)
})

test("registerPaymentApp pins the documented argument order and validates every term", () => {
  const tx = registerPaymentApp({
    registryId, adminCapId, channelId, blobId: "app-blob-001", minMemberStakeMist: 1_000_000_000n,
    recipient: sender, maxPaymentMist: 5_000_000_000n, epochBudgetMist: 20_000_000_000n,
  }, packageId)
  const [call] = moveCalls(tx)
  assert.equal(call.target, `${packageId}::${POLICY_MODULE}::register_payment_app`)
  assert.equal(call.args.length, 8)
  assert.deepEqual([objectIdAt(call, 0), objectIdAt(call, 1), objectIdAt(call, 3)], [registryId, adminCapId, channelId])
  assert.equal(bcs.string().parse(pureAt(call, 2)), "app-blob-001")
  assert.equal(bcs.u64().parse(pureAt(call, 4)), "1000000000")
  assert.equal(bcs.Address.parse(pureAt(call, 5)), sender)
  assert.equal(bcs.u64().parse(pureAt(call, 6)), "5000000000")
  assert.equal(bcs.u64().parse(pureAt(call, 7)), "20000000000")
  // Mirror the contract's guard matrix: every term is validated offline first.
  const invalid: Array<Parameters<typeof registerPaymentApp>[0]> = [
    { registryId: "0x0", adminCapId, channelId, blobId: "b", minMemberStakeMist: 1n, recipient: sender, maxPaymentMist: 1n, epochBudgetMist: 1n },
    { registryId, adminCapId, channelId, blobId: "x".repeat(129), minMemberStakeMist: 1n, recipient: sender, maxPaymentMist: 1n, epochBudgetMist: 1n },
    { registryId, adminCapId, channelId, blobId: "b", minMemberStakeMist: 0n, recipient: sender, maxPaymentMist: 1n, epochBudgetMist: 1n },
    { registryId, adminCapId, channelId, blobId: "b", minMemberStakeMist: 1n, recipient: "0x0", maxPaymentMist: 1n, epochBudgetMist: 1n },
    { registryId, adminCapId, channelId, blobId: "b", minMemberStakeMist: 1n, recipient: sender, maxPaymentMist: 0n, epochBudgetMist: 1n },
    { registryId, adminCapId, channelId, blobId: "b", minMemberStakeMist: 1n, recipient: sender, maxPaymentMist: 1n, epochBudgetMist: 0n },
  ]
  for (const input of invalid) assert.throws(() => registerPaymentApp(input, packageId), /无效|大于 0|1\.\.128/)
})

test("toggle and pay builders bind the exact policy and an exact-amount coin", () => {
  const toggle = toggleAppStatus({ registryId, adminCapId, blobId: "app-blob-001", isActive: false }, packageId)
  const [toggleCall] = moveCalls(toggle)
  assert.equal(toggleCall.function, "toggle_app_status")
  assert.equal(bcs.string().parse(pureAt(toggleCall, 2)), "app-blob-001")
  assert.equal(bcs.bool().parse(pureAt(toggleCall, 3)), false)

  const pay = payApp({ registryId, blobId: "app-blob-001", channelId, receiptId, amountMist: 1_234_567_890n }, packageId)
  const [payCall] = moveCalls(pay)
  assert.equal(payCall.function, "pay")
  assert.deepEqual([objectIdAt(payCall, 0), objectIdAt(payCall, 2), objectIdAt(payCall, 3)], [registryId, channelId, receiptId])
  // The payment coin is an exact split from the sender's SUI balance, never the gas coin.
  const json = JSON.stringify(pay.getData().commands, (_, value) => typeof value === "bigint" ? value.toString() : value)
  assert.equal(json.includes("1234567890"), true, "the exact MIST amount must be part of the coin intent")
  assert.throws(() => payApp({ registryId, blobId: "b", channelId, receiptId, amountMist: 0n }, packageId), /大于 0/)
  assert.throws(() => toggleAppStatus({ registryId, adminCapId, blobId: "", isActive: true }, packageId), /1\.\.128/)
})

test("a shared registry snapshot decodes every policy and refuses unknown shapes", async () => {
  const client = {
    getObject: async () => ({ object: registryObject("2") }),
    listDynamicFields: async () => ({
      dynamicFields: [
        { $kind: "DynamicField", fieldId, name: { $kind: "String", bcs: bcs.string().serialize("app-blob-001").toBytes() } },
        { $kind: "DynamicField", fieldId: otherField, name: { $kind: "String", bcs: bcs.string().serialize("app-blob-002").toBytes() } },
      ],
      hasNextPage: false, cursor: null,
    }),
    getObjects: async () => ({ objects: [
      { objectId: fieldId, type: policyFieldType, owner: owned, content: policyBytes("app-blob-001") },
      { objectId: otherField, type: policyFieldType, owner: owned, content: policyBytes("app-blob-002", { isActive: false }) },
    ] }),
  } as unknown as PolicyReaderClient
  const snapshot = await createPolicyReader(client).readRegistry(registryId)
  assert.equal(snapshot.totalApps, "2")
  assert.equal(snapshot.policies.length, 2)
  assert.deepEqual(snapshot.failures, [])
  const first = snapshot.policies[0]
  assert.equal(first.blobId, "app-blob-001")
  assert.equal(first.channelId, channelId)
  assert.equal(first.minMemberStakeMist, "1000000000")
  assert.equal(first.maxPaymentMist, "5000000000")
  assert.equal(first.spentInEpochMist, "1500000000")
  assert.equal(first.lastPaymentEpoch, "42")
  assert.equal(first.isActive, true)
  assert.equal(snapshot.policies[1].isActive, false)

  const wrongType = { ...client, getObject: async () => ({ object: registryObject("2", { type: `${packageId}::${POLICY_MODULE}::Other` }) }) }
  await assert.rejects(createPolicyReader(wrongType as unknown as PolicyReaderClient).readRegistry(registryId), /不是当前包定义/)

  const legacyType = { ...client, getObject: async () => ({ object: registryObject("2", { type: `${packageId}::${POLICY_MODULE}::WalrusAppRegistry` }) }) }
  await assert.rejects(createPolicyReader(legacyType as unknown as PolicyReaderClient).readRegistry(registryId), /不是当前包定义/)

  const privateRegistry = { ...client, getObject: async () => ({ object: registryObject("2", { owner: owned }) }) }
  await assert.rejects(createPolicyReader(privateRegistry as unknown as PolicyReaderClient).readRegistry(registryId), /共享对象/)

  const incomplete = { ...client, listDynamicFields: async () => ({ dynamicFields: [], hasNextPage: false, cursor: null }) }
  await assert.rejects(createPolicyReader(incomplete as unknown as PolicyReaderClient).readRegistry(registryId), /不完整/)
})

test("initialize resolves the created registry and cap only when the pair is coherent", async () => {
  const AdminCap = bcs.struct("AdminCap", { id: bcs.Address, registry_id: bcs.Address })
  const capType = `${PROPOSAL_TYPE_ORIGIN}::${POLICY_MODULE}::AdminCap`
  const capBytes = () => AdminCap.serialize({ id: address("5"), registry_id: registryId }).toBytes()
  const store = new Map<string, { type: string; owner: unknown; content: Uint8Array }>([
    [registryId, { type: registryType, owner: shared, content: Registry.serialize({ id: registryId, policies: { id: tableId, size: "0" }, total_apps: "0" }).toBytes() }],
    [address("5"), { type: capType, owner: owned, content: capBytes() }],
  ])
  const client = {
    getObjects: async ({ objectIds }: { objectIds: string[] }) => ({
      objects: objectIds.map(id => store.has(id) ? { objectId: id, ...store.get(id)! } : new Error("not found")),
    }),
  } as unknown as Pick<import("./walrus-app-policy").PolicyReaderClient, "getObjects">
  const found = await findCreatedRegistry(client, [registryId, address("5")], { expectedOwner: sender })
  assert.deepEqual(found, { registryId, adminCapId: address("5") })

  // The cap must belong to the signer, the registry must be shared, and the
  // cap must name the registry it manages — anything else refuses to save.
  const wrongOwner = { ...client, getObjects: async () => ({ objects: [
    { objectId: registryId, type: registryType, owner: shared, content: store.get(registryId)!.content },
    { objectId: address("5"), type: capType, owner: { $kind: "AddressOwner", AddressOwner: address("f") }, content: capBytes() },
  ] }) }
  await assert.rejects(findCreatedRegistry(wrongOwner as never, [registryId, address("5")], { expectedOwner: sender }), /未归属当前账户/)

  const privateRegistry = { ...client, getObjects: async () => ({ objects: [
    { objectId: registryId, type: registryType, owner: owned, content: store.get(registryId)!.content },
    { objectId: address("5"), type: capType, owner: owned, content: capBytes() },
  ] }) }
  await assert.rejects(findCreatedRegistry(privateRegistry as never, [registryId, address("5")], { expectedOwner: sender }), /共享对象/)

  const orphanCap = { ...client, getObjects: async () => ({ objects: [
    { objectId: registryId, type: registryType, owner: shared, content: store.get(registryId)!.content },
    { objectId: address("5"), type: capType, owner: owned, content: AdminCap.serialize({ id: address("5"), registry_id: address("d") }).toBytes() },
  ] }) }
  await assert.rejects(findCreatedRegistry(orphanCap as never, [registryId, address("5")], { expectedOwner: sender }), /不匹配/)

  const ambiguous = { ...client, getObjects: async () => ({ objects: [
    { objectId: registryId, type: registryType, owner: shared, content: store.get(registryId)!.content },
    { objectId: address("5"), type: capType, owner: owned, content: capBytes() },
    { objectId: address("6"), type: capType, owner: owned, content: capBytes() },
  ] }) }
  await assert.rejects(findCreatedRegistry(ambiguous as never, [registryId, address("5"), address("6")], { expectedOwner: sender }), /唯一确认/)

  await assert.rejects(findCreatedRegistry(client, [], { expectedOwner: sender }), /未创建/)
})

test("stake receipts are listed from owned objects and refuse anything off-account", async () => {
  const Receipt = bcs.struct("MemberStakeReceipt", { id: bcs.Address, channel_id: bcs.Address, member: bcs.Address, staked_amount: bcs.u64() })
  const receiptType = `${PROPOSAL_TYPE_ORIGIN}::onchain_chat::MemberStakeReceipt`
  const entry = (id: string, channelId: string, member: string, staked: string) => ({
    objectId: id, type: receiptType, content: Receipt.serialize({ id, channel_id: channelId, member, staked_amount: staked }).toBytes(),
  })
  const pages: Array<{ objects: ReturnType<typeof entry>[]; hasNextPage: boolean; cursor: string | null }> = [
    { objects: [entry(address("7"), address("1"), sender, "3000000000"), entry(address("6"), address("1"), sender, "1000000000")], hasNextPage: true, cursor: "c1" },
    { objects: [entry(address("8"), address("2"), sender, "2000000000")], hasNextPage: false, cursor: null },
  ]
  const paged = mock.fn(async (request: { cursor?: string | null }) => pages[request.cursor ? 1 : 0])
  const found = await listOwnStakeReceipts({ listOwnedObjects: paged as never }, sender)
  assert.deepEqual(found, [
    { receiptId: address("6"), channelId: address("1"), member: sender, stakedAmountMist: "1000000000" },
    { receiptId: address("7"), channelId: address("1"), member: sender, stakedAmountMist: "3000000000" },
    { receiptId: address("8"), channelId: address("2"), member: sender, stakedAmountMist: "2000000000" },
  ])
  // A receipt the account does not own must stop the whole listing, not be skipped.
  const foreign = mock.fn(async () => ({ objects: [entry(address("9"), address("1"), address("f"), "1000000000")], hasNextPage: false, cursor: null }))
  await assert.rejects(listOwnStakeReceipts({ listOwnedObjects: foreign as never }, sender), /持有人与查询账户不匹配/)
  const wrongType = mock.fn(async () => ({ objects: [{ ...entry(address("9"), address("1"), sender, "1000000000"), type: `${PROPOSAL_TYPE_ORIGIN}::onchain_chat::ChatChannel` }], hasNextPage: false, cursor: null }))
  await assert.rejects(listOwnStakeReceipts({ listOwnedObjects: wrongType as never }, sender), /类型不匹配/)
  const stuck = mock.fn(async () => ({ objects: [], hasNextPage: true, cursor: null }))
  await assert.rejects(listOwnStakeReceipts({ listOwnedObjects: stuck as never }, sender), /分页未前进/)
  const looping = mock.fn(async () => ({ objects: [], hasNextPage: true, cursor: "c1" }))
  await assert.rejects(listOwnStakeReceipts({ listOwnedObjects: looping as never }, sender), /分页未前进/)
  await assert.rejects(listOwnStakeReceipts({ listOwnedObjects: paged as never }, "0x0"), /账户地址无效/)
})

test("the channel pre-check accepts only a shared ChatChannel of this package", async () => {
  const channelType = `${PROPOSAL_TYPE_ORIGIN}::onchain_chat::ChatChannel`
  const client = {
    getObject: async ({ objectId }: { objectId: string }) => ({
      object: objectId === channelId ? { objectId, type: channelType, owner: shared } : { objectId, type: `${packageId}::${POLICY_MODULE}::Registry`, owner: shared },
    }),
  } as unknown as PolicyReaderClient
  const verified = await verifyChatChannel(client, ` ${channelId} `)
  assert.equal(verified.channelId, channelId)

  await assert.rejects(verifyChatChannel(client, registryId), /不是当前包定义的聊天频道/)
  const privateChannel = { ...client, getObject: async () => ({ object: { objectId: channelId, type: channelType, owner: owned } }) }
  await assert.rejects(verifyChatChannel(privateChannel as unknown as PolicyReaderClient, channelId), /共享对象/)
  await assert.rejects(verifyChatChannel(client, "0x0"), /频道 ID无效/)
})

test("policy configuration uses the current package and registry variables", () => {
  const keys = ["NEXT_PUBLIC_WALRUS_APP_POLICY_PACKAGE_ID", "NEXT_PUBLIC_WALRUS_APP_REGISTRY_ID"] as const
  const original = keys.map(key => process.env[key])
  try {
    for (const key of keys) delete process.env[key]
    assert.equal(policyPackageId(), PROPOSAL_PACKAGE_ID)
    assert.equal(registryIdFromEnv(), "")
    process.env.NEXT_PUBLIC_WALRUS_APP_POLICY_PACKAGE_ID = sender
    process.env.NEXT_PUBLIC_WALRUS_APP_REGISTRY_ID = registryId
    assert.equal(policyPackageId(), sender)
    assert.equal(registryIdFromEnv(), registryId)
    process.env.NEXT_PUBLIC_WALRUS_APP_REGISTRY_ID = "0x0"
    assert.equal(registryIdFromEnv(), "")
  } finally {
    keys.forEach((key, index) => {
      if (original[index] === undefined) delete process.env[key]
      else process.env[key] = original[index]
    })
  }
})

test("registry ids are stored locally only when well-formed", () => {
  const memory = new Map<string, string>()
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage")
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
  Object.defineProperty(globalThis, "window", { configurable: true, value: new EventTarget() })
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => { memory.set(key, value) },
    removeItem: (key: string) => { memory.delete(key) },
  } })
  try {
    assert.throws(() => saveRegistryId("not-an-id"), /注册表 ID/)
    assert.equal(saveRegistryId(registryId), registryId)
    assert.equal(readSavedRegistryId(), registryId)
    assert.equal(memory.get("sui_walrus_policy_registry"), registryId)
    // The admin-cap pointer is a separate key and validates its own ids.
    assert.throws(() => saveRegistryAdminCapId("not-an-id"), /管理凭证 ID/)
    assert.equal(saveRegistryAdminCapId(address("5")), address("5"))
    assert.equal(readSavedRegistryAdminCapId(), address("5"))
    assert.equal(memory.get("sui_walrus_policy_registry_admin_cap"), address("5"))
  } finally {
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage)
    else Reflect.deleteProperty(globalThis, "localStorage")
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow)
    else Reflect.deleteProperty(globalThis, "window")
  }
  assert.equal(parseRegistryId(` ${registryId} `), registryId)
  assert.throws(() => parseRegistryId(""), /注册表 ID/)
})
