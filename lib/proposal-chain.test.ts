import assert from "node:assert/strict"
import { test } from "node:test"
import { bcs } from "@mysten/sui/bcs"
import { ObjectError, type SuiClientTypes } from "@mysten/sui/client"
import { RpcError } from "@mysten/sui/grpc"
import { normalizeSuiAddress } from "@mysten/sui/utils"
import { createProposalReader, ProposalContent, PROPOSAL_PACKAGE_ID, PROPOSAL_TYPE_ORIGIN, validateApproval, weightNumber, type ProposalChainClient, type ProposalSnapshot } from "./proposal-chain"

const address = (value: string) => normalizeSuiAddress(value)
const ids = {
  proposal: address("0x10"), organization: address("0x20"), members: address("0x30"),
  votes: address("0x40"), signatures: address("0x50"), executed: address("0x60"),
  alice: address("0xa"), bob: address("0xb"), carol: address("0xc"),
}
const proposalType = `${PROPOSAL_TYPE_ORIGIN}::asynchronous_proposal::Proposal`
const organizationType = `${PROPOSAL_TYPE_ORIGIN}::cryptographic_org::Organization`
// A later upgrade may have added these types before the currently configured package.
const rejectionTypeOrigin = address("0x999")
const keyType = (name: string) => `${rejectionTypeOrigin}::asynchronous_proposal::${name}`
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex")
const missingField = () => new ObjectError("NOT_FOUND", "Missing dynamic field", { reason: "notFound" })
const WeightField = bcs.struct("Field", { id: bcs.Address, name: bcs.Address, value: bcs.u64() })

// Fixed bytes assembled independently from the Move field layout, not serialized
// through the reader's schema. These pin UTF-8, u64 strings, UID/ID and Table layout.
const proposalFixture = Uint8Array.from(Buffer.from([
  "0000000000000000000000000000000000000000000000000000000000000010",
  "0000000000000000000000000000000000000000000000000000000000000020",
  "0100000000002000000000000000000000000000000000000000000000000000",
  "000000000000000a0ae9a284e7ae9720e29c9300000000000000000000000000",
  "0000000000000000000000000000000000000cffffffffffffffff0700000000",
  "0000000300000000000000000000000000000000000000000000000000000000",
  "0000000000000000000040020000000000000000000000000000000000000000",
  "00000000000000000000000000000000000050010000000000000000204aa9d1",
  "01000001",
].join(""), "hex"))
const organizationFixture = Uint8Array.from(Buffer.from("00000000000000000000000000000000000000000000000000000000000000200301020363000000000000000100000000002000ffffffffffffffff0b7375693a746573746e65740000000000000000000000000000000000000000000000000000000000000030030000000000000000000000000000000000000000000000000000000000000000000000000000600000000000000000", "hex"))

type WireObject = { objectId: string; type: string; content: Uint8Array; previousTransaction?: string | null }
type GetDatatype = ProposalChainClient["movePackageService"]["getDatatype"]
type DatatypeResponse = Awaited<ReturnType<GetDatatype>>["response"]

class FakeProposalClient implements ProposalChainClient {
  objects = new Map<string, WireObject | Error>([
    [ids.proposal, { objectId: ids.proposal, type: proposalType, content: proposalFixture, previousTransaction: "previous-digest" }],
    [ids.organization, { objectId: ids.organization, type: organizationType, content: organizationFixture }],
  ])
  pages = new Map<string, SuiClientTypes.ListDynamicFieldsResponse>()
  values = new Map<string, number | Error | SuiClientTypes.DynamicFieldValue>()
  objectRequests: SuiClientTypes.GetObjectOptions[] = []
  batchRequests: SuiClientTypes.GetObjectsOptions[] = []
  listRequests: SuiClientTypes.ListDynamicFieldsOptions[] = []
  dynamicRequests: SuiClientTypes.GetDynamicFieldOptions[] = []
  functionRequests: SuiClientTypes.GetMoveFunctionOptions[] = []
  datatypeRequests: Parameters<GetDatatype>[] = []
  capability: boolean | Error = true
  datatype: (name: string) => DatatypeResponse | Promise<DatatypeResponse> = name => ({ datatype: {
    typeName: keyType(name), definingId: rejectionTypeOrigin, module: "asynchronous_proposal", name,
    abilities: [], typeParameters: [], fields: [], variants: [],
  } })

  movePackageService: ProposalChainClient["movePackageService"] = {
    getDatatype: (...args) => {
      this.datatypeRequests.push(args)
      return Promise.resolve().then(async () => ({ response: await this.datatype(args[0].name!) }))
    },
  }

  private object<Include extends SuiClientTypes.ObjectInclude>(id: string, include?: Include): SuiClientTypes.Object<Include> {
    const body = this.objects.get(id)
    if (!body) throw new Error(`Unexpected object ${id}`)
    if (body instanceof Error) throw body
    // The SDK's conditional include fields require this generic assertion.
    return {
      objectId: id, type: body.type, version: "1", digest: "object-digest", owner: { $kind: "Immutable", Immutable: true },
      content: include?.content ? body.content : undefined,
      previousTransaction: include?.previousTransaction ? body.previousTransaction ?? null : undefined,
      objectBcs: undefined, json: undefined, display: undefined,
    } as SuiClientTypes.Object<Include>
  }

  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- mirrors the SDK signature exactly
  async getObject<Include extends SuiClientTypes.ObjectInclude = {}>(options: SuiClientTypes.GetObjectOptions<Include>): Promise<SuiClientTypes.GetObjectResponse<Include>> {
    this.objectRequests.push(options)
    return { object: this.object(options.objectId, options.include) }
  }

  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- mirrors the SDK signature exactly
  async getObjects<Include extends SuiClientTypes.ObjectInclude = {}>(options: SuiClientTypes.GetObjectsOptions<Include>): Promise<SuiClientTypes.GetObjectsResponse<Include>> {
    this.batchRequests.push(options)
    return { objects: options.objectIds.map(id => this.objects.get(id) instanceof Error ? this.objects.get(id) as Error : this.object(id, options.include)) }
  }

  async listDynamicFields(options: SuiClientTypes.ListDynamicFieldsOptions): Promise<SuiClientTypes.ListDynamicFieldsResponse> {
    this.listRequests.push(options)
    const key = `${options.parentId}:${options.cursor ?? ""}`
    const page = this.pages.get(key)
    if (!page) throw new Error(`Unexpected page ${key}`)
    return page
  }

  async getMoveFunction(options: SuiClientTypes.GetMoveFunctionOptions): Promise<SuiClientTypes.GetMoveFunctionResponse> {
    this.functionRequests.push(options)
    if (this.capability instanceof Error) throw this.capability
    if (!this.capability) throw new Error("Function not found: reject_async_vote")
    return { function: {
      packageId: PROPOSAL_PACKAGE_ID, moduleName: options.moduleName, name: options.name,
      visibility: "public", isEntry: false, typeParameters: [], parameters: [], returns: [],
    } }
  }

  async getDynamicField(options: SuiClientTypes.GetDynamicFieldOptions): Promise<SuiClientTypes.GetDynamicFieldResponse> {
    this.dynamicRequests.push(options)
    const value = this.values.get(`${options.name.type}:${hex(options.name.bcs)}`)
    if (value === undefined) throw missingField()
    if (value instanceof Error) throw value
    return { dynamicField: {
      $kind: "DynamicField", fieldId: address("0xabc"), type: "0x2::dynamic_field::Field", name: options.name,
      valueType: typeof value === "number" ? "u64" : value.type,
      value: typeof value === "number" ? { type: "u64", bcs: bcs.u64().serialize(value).toBytes() } : value,
      version: "1", digest: "field-digest", previousTransaction: null,
    } }
  }

  table(tableId: string, entries: [string, number][], cursor: string | null = null, next: string | null = null) {
    const dynamicFields = entries.map(([name, value], index): SuiClientTypes.DynamicFieldEntry => {
      const fieldId = address(`0x${(0x1000 + this.objects.size + index).toString(16)}`)
      this.objects.set(fieldId, { objectId: fieldId, type: "0x2::dynamic_field::Field<address, u64>", content: WeightField.serialize({ id: fieldId, name, value }).toBytes() })
      return { $kind: "DynamicField", fieldId, type: "0x2::dynamic_field::Field<address, u64>", name: { type: "address", bcs: bcs.Address.serialize(name).toBytes() }, valueType: "u64" }
    })
    this.pages.set(`${tableId}:${cursor ?? ""}`, { dynamicFields, hasNextPage: next !== null, cursor: next })
  }

  proposal(patch: Partial<ReturnType<typeof ProposalContent.parse>>) {
    const body = this.objects.get(ids.proposal) as WireObject
    body.content = ProposalContent.serialize({ ...ProposalContent.parse(body.content), ...patch }).toBytes()
  }

  rejection(name: string, nameBytes: Uint8Array, value: number | Error | SuiClientTypes.DynamicFieldValue) {
    this.values.set(`${keyType(name)}:${hex(nameBytes)}`, value)
  }
}

function fixture() {
  const client = new FakeProposalClient()
  client.table(ids.members, [[ids.alice, 3], [ids.bob, 4], [ids.carol, 2]])
  client.table(ids.votes, [[ids.alice, 3], [ids.bob, 4]])
  client.rejection("RejectedWeightKey", new Uint8Array([0]), 4)
  client.rejection("RejectingVoterKey", bcs.Address.serialize(ids.bob).toBytes(), 4)
  return { client, reader: createProposalReader(client) }
}

function approvalSnapshot(patch: Partial<ProposalSnapshot> = {}): ProposalSnapshot {
  return {
    id: ids.proposal, orgId: ids.organization, epoch: "9007199254740993", organizationEpoch: "9007199254740993",
    proposer: ids.bob, title: "预算 ✓", recipient: ids.carol, amountMist: "18446744073709551615",
    threshold: 7, approvedWeight: 3, deadlineMs: 2_000_000_000_000, status: "pending",
    members: { [ids.alice]: 3, [ids.bob]: 4, [ids.carol]: 2 }, votes: {}, rejectionWeight: 0,
    rejectingVoters: [], rejectionSupported: true, previousTransaction: null, ...patch,
  }
}

test("decodes a fixed Move BCS snapshot and keeps integer precision and the original object types", async () => {
  const { client, reader } = fixture()
  const snapshot = await reader.readProposalSnapshot(ids.proposal, "0x20")
  assert.deepEqual(snapshot, {
    id: ids.proposal, orgId: ids.organization, epoch: "9007199254740993", organizationEpoch: "9007199254740993",
    proposer: ids.alice, title: "预算 ✓", recipient: ids.carol, amountMist: "18446744073709551615",
    threshold: 7, approvedWeight: 3, deadlineMs: 2_000_000_000_000, status: "pending",
    members: { [ids.alice]: 3, [ids.bob]: 4, [ids.carol]: 2 }, votes: { [ids.alice]: 3, [ids.bob]: 4 },
    rejectionWeight: 4, rejectingVoters: [ids.bob], rejectionSupported: true, previousTransaction: "previous-digest",
  })
  assert.deepEqual(client.objectRequests.map(({ objectId, include }) => ({ objectId, include })), [
    { objectId: ids.proposal, include: { content: true, previousTransaction: true } },
    { objectId: ids.organization, include: { content: true } },
  ])
  assert.ok(client.objectRequests.every(request => request.signal instanceof AbortSignal))
  assert.equal(snapshot.threshold, 7) // The organization's current threshold is 99.
  assert.equal(validateApproval(snapshot, "0xc", snapshot.deadlineMs), 2)
})

test("uses the defining package for new rejection keys with [0] and address BCS names", async () => {
  const { client, reader } = fixture()
  await reader.readProposalSnapshot(ids.proposal)
  assert.notEqual(rejectionTypeOrigin, PROPOSAL_TYPE_ORIGIN)
  assert.notEqual(rejectionTypeOrigin, PROPOSAL_PACKAGE_ID)
  assert.deepEqual(client.dynamicRequests.map(({ parentId, name }) => ({ parentId, type: name.type, bytes: Array.from(name.bcs) })), [
    { parentId: ids.proposal, type: keyType("RejectedWeightKey"), bytes: [0] },
    { parentId: ids.proposal, type: keyType("RejectingVoterKey"), bytes: Array.from(bcs.Address.serialize(ids.alice).toBytes()) },
    { parentId: ids.proposal, type: keyType("RejectingVoterKey"), bytes: Array.from(bcs.Address.serialize(ids.bob).toBytes()) },
  ])
  assert.deepEqual(client.datatypeRequests.map(([request]) => request), [
    { packageId: PROPOSAL_PACKAGE_ID, moduleName: "asynchronous_proposal", name: "RejectedWeightKey" },
    { packageId: PROPOSAL_PACKAGE_ID, moduleName: "asynchronous_proposal", name: "RejectingVoterKey" },
  ])
  assert.ok(client.datatypeRequests.every(([, options]) => options?.abort instanceof AbortSignal))
  await reader.readProposalSnapshot(ids.proposal)
  assert.equal(client.datatypeRequests.length, 2)
})

test("reads old proposals with no rejection fields as zero", async () => {
  const { client, reader } = fixture()
  client.values.clear()
  const snapshot = await reader.readProposalSnapshot(ids.proposal)
  assert.equal(snapshot.rejectionSupported, true)
  assert.equal(snapshot.rejectionWeight, 0)
  assert.deepEqual(snapshot.rejectingVoters, [])
})

test("only missing ObjectError fields map to zero; all other lookup failures propagate", async t => {
  const errors = [
    new ObjectError("DELETED", "Deleted field", { reason: "deleted" }),
    new ObjectError("NOT_FOUND", "Unknown reason"),
    new Error("not found"),
    Object.assign(new Error("Not an ObjectError"), { reason: "notFound" }),
    new RpcError("Request unavailable", "UNAVAILABLE"),
  ]
  for (const error of errors) {
    await t.test(`${error.constructor.name}: ${error.message}`, async () => {
      for (const voter of [false, true]) {
        const { client, reader } = fixture()
        client.rejection(voter ? "RejectingVoterKey" : "RejectedWeightKey", voter ? bcs.Address.serialize(ids.alice).toBytes() : new Uint8Array([0]), error)
        await assert.rejects(reader.readProposalSnapshot(ids.proposal), thrown => thrown === error)
      }
    })
  }
})

test("rejects a rejection field with the wrong value type, malformed bytes, or unsafe weight", async t => {
  for (const [name, value, pattern] of [
    ["wrong type", { type: "bool", bcs: new Uint8Array([1]) }, /字段类型不匹配/],
    ["truncated BCS", { type: "u64", bcs: new Uint8Array([1]) }, undefined],
    ["unsafe integer", { type: "u64", bcs: bcs.u64().serialize("9007199254740992").toBytes() }, /精度范围/],
  ] as const) {
    await t.test(name, async () => {
      const { client, reader } = fixture()
      client.rejection("RejectedWeightKey", new Uint8Array([0]), value)
      if (pattern) await assert.rejects(reader.readProposalSnapshot(ids.proposal), pattern)
      else await assert.rejects(reader.readProposalSnapshot(ids.proposal), RangeError)
    })
  }
})

test("datatype resolution fails closed and retries failed or malformed metadata", async t => {
  for (const failure of [new RpcError("metadata unavailable", "UNAVAILABLE"), missingField(), {}, { datatype: { abilities: [], typeParameters: [], fields: [], variants: [] } }]) {
    await t.test(failure instanceof Error ? failure.message : "missing type name", async () => {
      const { client, reader } = fixture()
      const resolve = client.datatype
      client.datatype = () => {
        if (failure instanceof Error) throw failure
        return failure
      }
      await assert.rejects(reader.readProposalSnapshot(ids.proposal), error => failure instanceof Error ? error === failure : error instanceof Error && /链上类型/.test(error.message))
      assert.equal(client.dynamicRequests.length, 0)
      client.datatype = resolve
      assert.equal((await reader.readProposalSnapshot(ids.proposal)).rejectionWeight, 4)
      assert.equal(client.datatypeRequests.filter(([request]) => request.name === "RejectedWeightKey").length, 2)
    })
  }
})

test("weight table pagination batches field objects and accepts normalized struct tags", async () => {
  const client = new FakeProposalClient()
  client.table(ids.members, [["0xa", 3]], null, "page-2")
  client.table(ids.members, [["0xb", 4]], "page-2")
  assert.deepEqual(await createProposalReader(client).readWeightTable(ids.members), { [ids.alice]: 3, [ids.bob]: 4 })
  assert.deepEqual(client.listRequests.map(({ parentId, cursor, limit }) => ({ parentId, cursor, limit })), [
    { parentId: ids.members, cursor: null, limit: 50 }, { parentId: ids.members, cursor: "page-2", limit: 50 },
  ])
  assert.ok(client.batchRequests.every(request => request.include?.content && request.signal instanceof AbortSignal))
  assert.equal(client.batchRequests.length, 2)
})

test("empty tables do not fetch objects", async () => {
  const client = new FakeProposalClient()
  client.table(ids.members, [])
  assert.deepEqual(await createProposalReader(client).readWeightTable(ids.members), {})
  assert.equal(client.batchRequests.length, 0)
})

test("weight tables propagate per-object, transport, type and BCS errors", async t => {
  const objectFailure = new ObjectError("DELETED", "deleted table row", { reason: "deleted" })
  const transportFailure = new RpcError("list failed", "UNAVAILABLE")
  for (const mode of ["object", "transport", "type", "bcs", "unsafe"] as const) {
    await t.test(mode, async () => {
      const client = new FakeProposalClient()
      client.table(ids.members, [[ids.alice, 3]])
      const field = client.pages.get(`${ids.members}:`)!.dynamicFields[0]
      const body = client.objects.get(field.fieldId) as WireObject
      if (mode === "object") client.objects.set(field.fieldId, objectFailure)
      if (mode === "transport") client.listDynamicFields = async () => { throw transportFailure }
      if (mode === "type") body.type = "0x2::dynamic_field::Field<address,bool>"
      if (mode === "bcs") body.content = new Uint8Array([0])
      if (mode === "unsafe") body.content = WeightField.serialize({ id: field.fieldId, name: ids.alice, value: "9007199254740992" }).toBytes()
      await assert.rejects(createProposalReader(client).readWeightTable(ids.members), error => {
        if (mode === "object") return error === objectFailure
        if (mode === "transport") return error === transportFailure
        if (mode === "type") return error instanceof Error && /类型不匹配/.test(error.message)
        if (mode === "unsafe") return error instanceof Error && /精度范围/.test(error.message)
        return error instanceof RangeError
      })
    })
  }
})

test("weight table pagination rejects absent, repeated and cyclic cursors even on empty pages", async t => {
  for (const cursors of [[null], ["a", "a"], ["a", "b", "a"]]) {
    await t.test(JSON.stringify(cursors), async () => {
      const client = new FakeProposalClient()
      let calls = 0
      client.listDynamicFields = async () => {
        if (calls >= cursors.length) throw new Error("Unexpected extra request")
        return { dynamicFields: [], hasNextPage: true, cursor: cursors[calls++] }
      }
      await assert.rejects(createProposalReader(client).readWeightTable(ids.members), /分页未前进/)
      assert.equal(calls, cursors.length)
    })
  }
})

test("weight table limits count fetched rows even when pages repeat an address", async () => {
  const client = new FakeProposalClient()
  client.table(ids.members, [[ids.alice, 3]])
  const field = client.pages.get(`${ids.members}:`)!.dynamicFields[0]
  let pages = 0
  client.listDynamicFields = async () => ({ dynamicFields: Array.from({ length: 50 }, () => field), hasNextPage: true, cursor: String(++pages) })
  await assert.rejects(createProposalReader(client).readWeightTable(ids.members), /读取上限/)
  assert.equal(pages, 21)
  assert.equal(client.batchRequests.length, 20)
})

test("weightNumber accepts safe unsigned decimal weights and rejects precision loss", () => {
  assert.equal(weightNumber("0"), 0)
  assert.equal(weightNumber("9007199254740991"), Number.MAX_SAFE_INTEGER)
  for (const invalid of ["9007199254740992", "18446744073709551615", "-1", "1.5", "1e3", "", " 3", "NaN", "Infinity"]) {
    assert.throws(() => weightNumber(invalid), /精度范围/)
  }
})

test("supportsRejection coalesces and caches successful and missing-function checks per reader", async t => {
  for (const supported of [true, false]) {
    await t.test(String(supported), async () => {
      const client = new FakeProposalClient()
      client.capability = supported
      const reader = createProposalReader(client)
      const first = reader.supportsRejection()
      assert.equal(first, reader.supportsRejection())
      assert.equal(await first, supported)
      assert.equal(await reader.supportsRejection(), supported)
      assert.equal(client.functionRequests.length, 1)
      assert.deepEqual({ ...client.functionRequests[0], signal: undefined }, { packageId: PROPOSAL_PACKAGE_ID, moduleName: "asynchronous_proposal", name: "reject_async_vote", signal: undefined })
      assert.equal(await createProposalReader(client).supportsRejection(), supported)
      assert.equal(client.functionRequests.length, 2)
    })
  }
})

test("supportsRejection propagates capability errors and allows a later retry", async t => {
  for (const error of [new RpcError("offline", "UNAVAILABLE"), new RpcError("denied", "PERMISSION_DENIED"), new RpcError("Package not found", "NOT_FOUND"), new Error("Function not found: another_function"), new Error("request timed out")]) {
    await t.test(error.message, async () => {
      const client = new FakeProposalClient()
      const reader = createProposalReader(client)
      client.capability = error
      await assert.rejects(reader.supportsRejection(), thrown => thrown === error)
      client.capability = true
      assert.equal(await reader.supportsRejection(), true)
      assert.equal(client.functionRequests.length, 2)
    })
  }
})

test("missing rejection capability skips extension reads, while capability errors fail snapshot reads", async () => {
  const { client, reader } = fixture()
  client.capability = false
  const snapshot = await reader.readProposalSnapshot(ids.proposal)
  assert.equal(snapshot.rejectionSupported, false)
  assert.equal(snapshot.rejectionWeight, 0)
  assert.deepEqual(snapshot.rejectingVoters, [])
  assert.equal(client.datatypeRequests.length, 0)
  assert.equal(client.dynamicRequests.length, 0)
  const broken = fixture()
  const error = new RpcError("capability lookup unavailable", "UNAVAILABLE")
  broken.client.capability = error
  await assert.rejects(broken.reader.readProposalSnapshot(ids.proposal), thrown => thrown === error)
})

test("snapshot rejects another package's proposal, organization or selected group", async t => {
  for (const mode of ["proposal", "organization", "group"] as const) {
    await t.test(mode, async () => {
      const { client, reader } = fixture()
      if (mode !== "group") {
        const id = mode === "proposal" ? ids.proposal : ids.organization
        const body = client.objects.get(id) as WireObject
        body.type = body.type.replace(PROPOSAL_TYPE_ORIGIN, address("0x999"))
      }
      await assert.rejects(reader.readProposalSnapshot(ids.proposal, mode === "group" ? "0x21" : undefined), /不是当前协议|组织对象类型|不属于同一链上组织/)
      if (mode === "group" || mode === "proposal") assert.equal(client.objectRequests.length, 1)
    })
  }
})

test("snapshot derives approval status from its threshold and respects terminal on-chain status", async t => {
  for (const [status, approved, expected] of [[1, 6, "pending"], [1, 7, "approved"], [1, 8, "approved"], [2, 0, "executed"], [3, 9, "rejected"]] as const) {
    await t.test(`${status}/${approved}: ${expected}`, async () => {
      const { client, reader } = fixture()
      client.proposal({ status, accumulated_weight: String(approved) })
      assert.equal((await reader.readProposalSnapshot(ids.proposal)).status, expected)
    })
  }
})

test("snapshot rejects zero thresholds, unknown states, and unsafe deadline or aggregate weights", async t => {
  for (const patch of [{ threshold_weight: "0" }, { status: 0 }, { status: 4 }, { deadline_ms: "9007199254740992" }, { accumulated_weight: "9007199254740992" }]) {
    await t.test(JSON.stringify(patch), async () => {
      const { client, reader } = fixture()
      client.proposal(patch)
      await assert.rejects(reader.readProposalSnapshot(ids.proposal), /门限或状态无效|精度范围/)
    })
  }
})

test("approval uses actual current member weight, normalizes sender and includes the deadline", () => {
  const snapshot = approvalSnapshot()
  assert.equal(validateApproval(snapshot, "0xa", snapshot.deadlineMs - 1), 3)
  assert.equal(validateApproval(snapshot, "0xa", snapshot.deadlineMs), 3)
  assert.equal(validateApproval(snapshot, "0xb", snapshot.deadlineMs), 4)
  assert.throws(() => validateApproval(snapshot, "0xa", snapshot.deadlineMs + 1), /过期/)
  assert.throws(() => validateApproval(snapshot, "0xd", snapshot.deadlineMs), /有效成员/)
  assert.throws(() => validateApproval(approvalSnapshot({ members: { [ids.alice]: 0 } }), "0xa", snapshot.deadlineMs), /有效成员/)
})

test("approval checks exact epoch strings and terminal states", () => {
  const snapshot = approvalSnapshot()
  // Adjacent epoch values above Number.MAX_SAFE_INTEGER must remain distinct.
  assert.throws(() => validateApproval({ ...snapshot, organizationEpoch: "9007199254740992" }, "0xa", snapshot.deadlineMs), /Epoch 已失效/)
  for (const status of ["executed", "rejected"] as const) {
    assert.throws(() => validateApproval({ ...snapshot, status }, "0xa", snapshot.deadlineMs), /已经结束/)
  }
  // Move status stays pending when approval reaches threshold, so another member
  // can still approve. The rejection-specific threshold guard is in the caller.
  assert.equal(validateApproval({ ...snapshot, status: "approved", approvedWeight: 7 }, "0xa", snapshot.deadlineMs), 3)
})

test("both prior approvals and rejections reserve the shared vote slot", async () => {
  const { reader } = fixture()
  const snapshot = await reader.readProposalSnapshot(ids.proposal)
  assert.throws(() => validateApproval(snapshot, "0xa", snapshot.deadlineMs), /已经.*投票/)
  assert.throws(() => validateApproval(snapshot, "0xb", snapshot.deadlineMs), /已经.*投票/)
  assert.equal(validateApproval(snapshot, "0xc", snapshot.deadlineMs), 2)
  assert.throws(() => validateApproval(approvalSnapshot({ votes: { [ids.alice]: 0 } }), "0xa", snapshot.deadlineMs), /已经.*投票/)
})
