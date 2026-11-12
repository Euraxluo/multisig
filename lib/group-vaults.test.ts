import assert from "node:assert/strict"
import { test } from "node:test"
import { bcs } from "@mysten/sui/bcs"
import { Ed25519PublicKey } from "@mysten/sui/keypairs/ed25519"
import { normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils"
import { OrganizationContent, ProposalContent } from "./proposal-chain"
import { createGroupVaultReader, groupVaultBcs, masterCapBcs, organizationTreasuryBcs, treasuryBindingBcs, treasuryCreatedBcs, vaultCreatedBcs, type GroupVaultClient } from "./group-vaults"

const address = normalizeSuiAddress
const pkg = address("0x999"), origin = address("0x888")
const vaultId = address("0x10"), capId = address("0x11"), orgId = address("0x12")
const alice = address("0xa"), other = address("0xb")
const sui = normalizeStructTag("0x2::sui::SUI"), token = normalizeStructTag("0x42::test::TOKEN")
const key = Uint8Array.from(Buffer.from("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a", "hex"))
const groupAddress = new Ed25519PublicKey(key).toSuiAddress()
const vaultType = `${origin}::vault::AgentVault<${sui}>`
const capType = `${origin}::vault::MasterCap`
const addr = (value: string) => Buffer.from(value.slice(2), "hex")
const u64 = (value: bigint) => Buffer.from(value.toString(16).padStart(16, "0").match(/../g)!.reverse().join(""), "hex")
// Independent Move serialization: UID, Balance<T>.value, version, subagent count, bool.
// 末字节 0x00 = agents VecMap 空表（2026-10-29 起 vault 内联卡片表），
// 其后 4 个 u64 = max_epoch_outflow / epoch_outflow / outflow_epoch / max_agent_budget（2026-11-12 流出策略）。
const vaultBytes = Uint8Array.from(Buffer.concat([addr(vaultId), u64((1n << 64n) - 1n), u64(3n), u64(2n), Buffer.from([1]), Buffer.from([0]), u64(1000n), u64(0n), u64(10n), u64(500n)]))
const capBytes = Uint8Array.from(Buffer.concat([addr(capId), addr(vaultId)]))

type RawPackage = NonNullable<Awaited<ReturnType<GroupVaultClient["movePackageService"]["getPackage"]>>["response"]["package"]>
type RawType = RawPackage["modules"][number]["datatypes"][number]
type RawBody = NonNullable<RawType["fields"][number]["type"]>
const primitive = (type: number): RawBody => ({ type, typeParameterInstantiation: [] })
const generic: RawBody = { type: 11, typeParameter: 0, typeParameterInstantiation: [] }
const datatype = (typeName: string, args: RawBody[] = []): RawBody => ({ type: 10, typeName: normalizeStructTag(typeName), typeParameterInstantiation: args })
const vector = (body: RawBody): RawBody => ({ type: 9, typeParameterInstantiation: [body] })
const fieldList = (values: Array<[string, RawBody]>) => values.map(([name, type], position) => ({ name, position, type }))
const uid = datatype("0x2::object::UID"), idType = datatype("0x2::object::ID")
const rawType = (module: string, name: string, fields: Array<[string, RawBody]>, abilities: number[], isGeneric = false): RawType => ({ name, module, typeName: `${pkg}::${module}::${name}`, definingId: origin, kind: 1, fields: fieldList(fields), abilities, typeParameters: isGeneric ? [{ isPhantom: true, constraints: [] }] : [], variants: [] })
function packageFixture(): RawPackage {
  const parameter = (body: RawBody, reference?: number) => ({ body, reference })
  return {
    storageId: pkg, modules: [
      { name: "vault", datatypes: [
        rawType("vault", "AgentVault", [["id", uid], ["balance", datatype("0x2::balance::Balance", [generic])], ["vault_version", primitive(6)], ["total_subagents", primitive(6)], ["paused", primitive(2)], ["agents", datatype("0x2::vec_map::VecMap", [primitive(1), datatype(`${origin}::vault::AgentRecord`)])], ["max_epoch_outflow", primitive(6)], ["epoch_outflow", primitive(6)], ["outflow_epoch", primitive(6)], ["max_agent_budget", primitive(6)]], [4], true),
        rawType("vault", "AgentRecord", [["daily_budget_limit", primitive(6)], ["spent_in_current_epoch", primitive(6)], ["last_spent_epoch", primitive(6)], ["service_target_hash", vector(primitive(3))], ["is_active", primitive(2)]], [5]),
        rawType("vault", "MasterCap", [["id", uid], ["vault_id", idType]], [3, 4]),
        rawType("vault", "VaultCreatedEvent", [["vault_id", idType], ["initial_version", primitive(6)]], [1, 2]),
      ], functions: [
        { name: "deposit", visibility: 2, isEntry: false, typeParameters: [{ constraints: [] }], parameters: [parameter(datatype(`${origin}::vault::AgentVault`, [generic]), 2), parameter(datatype("0x2::coin::Coin", [generic]))], returns: [] },
        { name: "withdraw", visibility: 2, isEntry: false, typeParameters: [{ constraints: [] }], parameters: [parameter(datatype(capType), 1), parameter(datatype(`${origin}::vault::AgentVault`, [generic]), 2), parameter(primitive(6)), parameter(primitive(1)), parameter(datatype("0x2::tx_context::TxContext"), 2)], returns: [] },
      ] },
      { name: "cryptographic_org", datatypes: [rawType("cryptographic_org", "Organization", [["id", uid], ["group_pk", vector(primitive(3))], ["threshold_weight", primitive(6)], ["epoch_version", primitive(6)], ["last_nonce", primitive(6)], ["chain_id", vector(primitive(3))], ["members_weight", datatype("0x2::table::Table", [primitive(1), primitive(6)])], ["executed_proposals", datatype("0x2::table::Table", [vector(primitive(3)), primitive(2)])], ["key_signers", vector(primitive(1))]], [4])], functions: [] },
    ], typeOrigins: [], linkage: [],
  }
}
const organizationBytes = (pk = key) => OrganizationContent.serialize({ id: orgId, group_pk: Array.from(pk), threshold_weight: "2", epoch_version: "1", last_nonce: "0", chain_id: Array.from(new TextEncoder().encode("sui-testnet:")), members_weight: { id: address("0x20"), size: "3" }, executed_proposals: { id: address("0x21"), size: "0" }, key_signers: [] }).toBytes()
function fakeClient() {
  const metadata = packageFixture()
  type Obj = { objectId: string; type: string; owner: SuiClientObjectOwner; content: Uint8Array }
  const shared: SuiClientObjectOwner = { $kind: "Shared", Shared: { initialSharedVersion: "1" } }
  const objects = new Map<string, Obj>([
    [vaultId, { objectId: vaultId, type: vaultType, owner: shared, content: vaultBytes }],
    [capId, { objectId: capId, type: capType, owner: { $kind: "AddressOwner", AddressOwner: groupAddress }, content: capBytes }],
    [orgId, { objectId: orgId, type: `${origin}::cryptographic_org::Organization`, owner: shared, content: organizationBytes() }],
  ])
  const state = { objectError: "", capError: "", metadataError: "", eventError: "", eventRepeat: false, capRepeat: false, metadataCalls: 0, eventCalls: [] as Array<string | null>, capCalls: [] as Array<string | null>,
    events: [{ eventType: `${origin}::vault::VaultCreatedEvent`, bcs: vaultCreatedBcs.serialize({ vault_id: vaultId, initial_version: "1" }).toBytes(), sender: alice }],
  }
  const client = {
    movePackageService: { getPackage: async () => { state.metadataCalls++; if (state.metadataError) throw new Error(state.metadataError); return { response: { package: metadata } } } },
    getObject: async ({ objectId }: { objectId: string }) => { if (state.objectError) throw new Error(state.objectError); const object = objects.get(objectId); if (!object) throw new Error("Object not found"); return { object } },
    listOwnedObjects: async ({ owner, type, cursor }: { owner: string; type: string; cursor: string | null }) => {
      state.capCalls.push(cursor)
      if (state.capError) throw new Error(state.capError)
      assert.equal(owner, groupAddress); assert.equal(type, capType)
      return { objects: [...objects.values()].filter(object => object.type === capType && object.owner.$kind === "AddressOwner" && object.owner.AddressOwner === owner), hasNextPage: state.capRepeat, cursor: state.capRepeat ? "cap-cursor" : null }
    },
    listEvents: async ({ before }: { before: string | null }) => {
      state.eventCalls.push(before)
      if (state.eventError) throw new Error(state.eventError)
      return { events: state.events, hasNextPage: state.eventRepeat, endCursor: state.eventRepeat ? "event-cursor" : null }
    },
  } as unknown as GroupVaultClient
  const reader = () => createGroupVaultReader(client, { packageId: pkg, typeOrigin: origin, maxPages: 3 })
  return { metadata, objects, state, client, reader }
}
type SuiClientObjectOwner = import("@mysten/sui/client").SuiClientTypes.ObjectOwner

test("reads independent BCS balances as bigint and verifies current group-key MasterCap custody", async () => {
  const fake = fakeClient(), reader = fake.reader()
  assert.deepEqual(await reader.requireDeployment(), { packageId: pkg, typeOrigin: origin, organizationTypeOrigin: origin })
  const org = await reader.readOrganization(orgId)
  assert.equal(org.groupAddress, groupAddress)
  const row = await reader.readVault(vaultId, orgId)
  assert.equal(row.balance, (1n << 64n) - 1n)
  assert.equal(row.vaultVersion, 3n)
  assert.equal(row.paused, true)
  assert.equal(row.coinType, sui)
  assert.equal(row.masterCapId, capId)
  assert.equal(row.authority.status, "org-key-owned")
  const list = await reader.listVaults(orgId, [vaultId])
  assert.deepEqual(list.vaults.map(row => row.id), [vaultId])
  assert.equal(list.groupAddress, groupAddress)
  assert.deepEqual(list.errors, [])
  assert.equal(list.truncated, false)
})

test("local org ID hints and creator events never establish authority", async () => {
  const fake = fakeClient()
  fake.objects.get(capId)!.owner = { $kind: "AddressOwner", AddressOwner: alice }
  const row = await fake.reader().readVault(vaultId, orgId)
  assert.equal(row.balance, (1n << 64n) - 1n)
  assert.equal(row.masterCapId, null)
  assert.equal(row.authority.verified, false)
  const list = await fake.reader().listVaults(orgId, [vaultId])
  assert.deepEqual(list.vaults, [])
  assert.equal(list.errors[0].id, vaultId)
  fake.objects.get(capId)!.owner = { $kind: "AddressOwner", AddressOwner: orgId }
  assert.equal((await fake.reader().readVault(vaultId, orgId)).authority.verified, false)
})

type TestObject = ReturnType<typeof fakeClient>["objects"] extends Map<string, infer O> ? O : never
const mutationList = (mutations: Array<(object: TestObject) => void>) => mutations

test("original type, returned object ID, BCS UID and shared/owned custody are independently checked", async () => {
  for (const mutate of mutationList([
    (object: ReturnType<typeof fakeClient>["objects"] extends Map<string, infer O> ? O : never) => { object.type = `${pkg}::vault::AgentVault<${sui}>` },
    object => { object.objectId = other },
    object => { object.content = groupVaultBcs.serialize({ ...groupVaultBcs.parse(vaultBytes), id: other }).toBytes() },
    object => { object.owner = { $kind: "ObjectOwner", ObjectOwner: orgId } },
    object => { object.content = Uint8Array.from([...vaultBytes, 0]) },
    object => { object.content = vaultBytes.slice(0, -1) },
    object => { object.type = `${origin}::vault::AgentVault<${sui},${token}>` },
  ])) {
    const fake = fakeClient(); mutate(fake.objects.get(vaultId)!)
    await assert.rejects(fake.reader().readVault(vaultId, orgId))
  }
  const fake = fakeClient()
  fake.objects.get(vaultId)!.owner = { $kind: "AddressOwner", AddressOwner: groupAddress }
  assert.equal((await fake.reader().readVault(vaultId, orgId)).authority.verified, true)
  fake.objects.get(vaultId)!.owner = { $kind: "AddressOwner", AddressOwner: alice }
  assert.equal((await fake.reader().readVault(vaultId, orgId)).authority.verified, false)
})

test("organization original type, UID, ownership and canonical full BCS are required", async () => {
  for (const mutate of mutationList([
    (object: ReturnType<typeof fakeClient>["objects"] extends Map<string, infer O> ? O : never) => { object.type = `${pkg}::cryptographic_org::Organization` },
    object => { object.objectId = other },
    object => { object.owner = { $kind: "AddressOwner", AddressOwner: alice } },
    object => { object.content = Uint8Array.from([...organizationBytes(), 0]) },
    object => { object.content = organizationBytes(new Uint8Array(31)) },
  ])) {
    const fake = fakeClient(); mutate(fake.objects.get(orgId)!)
    await assert.rejects(fake.reader().readOrganization(orgId))
  }
})

test("cap BCS, exact ID and present ownership must verify even if index claims ownership", async () => {
  for (const content of [Uint8Array.from([...capBytes, 0]), masterCapBcs.serialize({ id: other, vault_id: vaultId }).toBytes()]) {
    const fake = fakeClient(); fake.objects.get(capId)!.content = content
    await assert.rejects(fake.reader().readVault(vaultId, orgId))
    const list = await fake.reader().listVaults(orgId)
    assert.deepEqual(list.vaults, [])
    assert.ok(list.errors.length)
  }
  const fake = fakeClient(), indexed = structuredClone(fake.objects.get(capId)!)
  fake.client.listOwnedObjects = (async () => ({ objects: [indexed], hasNextPage: false, cursor: null })) as unknown as GroupVaultClient["listOwnedObjects"]
  fake.objects.get(capId)!.owner = { $kind: "AddressOwner", AddressOwner: alice }
  assert.deepEqual((await fake.reader().listVaults(orgId)).vaults, [])
})

test("metadata checks original origin, storage identity, exact fields and deposit ABI", async () => {
  const mutations: Array<(pkg: RawPackage) => void> = [
    pkg => { pkg.storageId = other },
    pkg => { pkg.modules[0].datatypes[0].definingId = other },
    pkg => { pkg.modules[0].datatypes[2].abilities = [4] },
    pkg => { pkg.modules[0].datatypes[0].typeParameters[0].constraints = [3] },
    pkg => { pkg.modules[0].datatypes[0].fields.push({ name: "extra", position: 10, type: primitive(6) }) },
    pkg => { pkg.modules[0].functions[0].parameters[0].reference = 1 },
    pkg => { pkg.modules[0].functions[0].returns = [{ body: primitive(6) }] },
    pkg => { pkg.modules[0].functions[0].typeParameters[0].constraints = [3] },
    pkg => { pkg.modules[0].functions[0].parameters.reverse() },
    pkg => { pkg.typeOrigins = [{ moduleName: "vault", datatypeName: "AgentVault", packageId: other }] },
    pkg => { pkg.modules[1].datatypes[0].fields.at(-1)!.type = vector(primitive(3)) },
  ]
  for (const [index, mutate] of mutations.entries()) {
    const fake = fakeClient(); mutate(fake.metadata)
    await assert.rejects(fake.reader().requireDeployment(), /ABI/)
  }
})

test("metadata transport failure remains explicit and successful retry is possible", async () => {
  const fake = fakeClient(), reader = fake.reader()
  fake.state.metadataError = "metadata offline"
  await assert.rejects(reader.requireDeployment(), /metadata offline/)
  fake.state.metadataError = ""
  await reader.requireDeployment()
  assert.equal(fake.state.metadataCalls, 2)
})

test("network failure never turns into a successful zero balance", async () => {
  const fake = fakeClient(), reader = fake.reader()
  fake.state.objectError = "RPC unavailable"
  await assert.rejects(reader.readVault(vaultId, orgId), /RPC unavailable/)
  fake.state.objectError = ""; fake.state.capError = "caps offline"
  await assert.rejects(reader.readVault(vaultId, orgId), /caps offline/)
  const list = await reader.listVaults(orgId)
  assert.deepEqual(list.vaults, [])
  assert.equal(list.truncated, true)
  assert.match(list.errors[0].error, /caps offline/)
})

test("unrelated creation events cannot inflate candidates, errors or RPC reads", async () => {
  const fake = fakeClient()
  fake.state.events[0].bcs = vaultCreatedBcs.serialize({ vault_id: other, initial_version: "1" }).toBytes()
  const list = await fake.reader().listVaults(orgId)
  assert.deepEqual(fake.state.eventCalls, [])
  assert.deepEqual(list.vaults.map(row => row.id), [vaultId])
  assert.deepEqual(list.errors, [])
})

test("bounded cap discovery retains verified rows and reports cursor failure", async () => {
  const fake = fakeClient(); fake.state.capRepeat = true
  const list = await fake.reader().listVaults(orgId)
  assert.deepEqual(fake.state.capCalls, [null, "cap-cursor"])
  assert.equal(list.truncated, true)
  assert.equal(list.vaults.length, 1)
  assert.match(list.errors[0].error, /分页未前进/)
})

test("deposit composes an exact tx.coin amount, matching original vault type and sender", async () => {
  const fake = fakeClient(), reader = fake.reader()
  for (const coinType of [sui, token]) {
    fake.objects.get(vaultId)!.type = `${origin}::vault::AgentVault<${coinType}>`
    const tx = (await reader.buildDepositVault(alice, vaultId, coinType, (1n << 64n) - 1n)).getData()
    assert.equal(tx.sender, alice)
    const call = tx.commands.at(-1)!.MoveCall!
    assert.equal(call.package, pkg)
    assert.equal(call.module, "vault")
    assert.equal(call.function, "deposit")
    assert.deepEqual(call.typeArguments, [coinType])
    assert.equal(call.arguments.length, 2)
    assert.equal(tx.inputs[0].UnresolvedObject?.objectId, vaultId)
    assert.equal(tx.commands[0].$kind, "$Intent")
    assert.equal(tx.commands[0].$Intent?.name, "CoinWithBalance")
  }
})

test("deposit rejects zero/overflow/rounded units, wrong token, wrong owner and spoofed ABI", async () => {
  const fake = fakeClient(), reader = fake.reader()
  for (const value of [0n, -1n, 1n << 64n, 1 as unknown as bigint]) await assert.rejects(reader.buildDepositVault(alice, vaultId, sui, value))
  await assert.rejects(reader.buildDepositVault(alice, vaultId, token, 1n), /代币/)
  fake.objects.get(vaultId)!.owner = { $kind: "AddressOwner", AddressOwner: other }
  await assert.rejects(reader.buildDepositVault(alice, vaultId, sui, 1n), /发送者/)
  const wrong = fakeClient(); wrong.metadata.modules[0].functions[0].parameters[1].body = datatype("0x2::balance::Balance", [generic])
  await assert.rejects(wrong.reader().buildDepositVault(alice, vaultId, sui, 1n), /ABI/)
})

test("primitive tags and malformed/nonzero IDs fail before RPC", async () => {
  const fake = fakeClient(), reader = fake.reader()
  for (const id of ["0x0", "0x", "0x1;foo", "local-vault", "0x" + "1".repeat(65)]) await assert.rejects(reader.readVault(id, orgId))
  await assert.rejects(reader.buildDepositVault(alice, vaultId, "u64", 1n))
  assert.equal(fake.state.metadataCalls, 0)
  assert.throws(() => createGroupVaultReader(fake.client, { maxPages: 10000 }))
})

const treasuryId = address("0x30"), proposalId = address("0x31"), bindingId = address("0x32")
const treasuryOrigin = address("0x777")
function treasuryFake() {
  const fake = fakeClient()
  const local = (name: string) => `${treasuryOrigin}::organization_treasury::${name}`
  const parameter = (body: RawBody, reference?: number) => ({ body, reference })
  const ctx = parameter(datatype("0x2::tx_context::TxContext"), 2)
  const clock = parameter(datatype("0x2::clock::Clock"), 1)
  const treasury = parameter(datatype(local("OrganizationTreasury")), 1)
  const org = parameter(datatype(`${origin}::cryptographic_org::Organization`), 1)
  const fn = (name: string, parameters: Array<{ body: RawBody; reference?: number }>, returns: Array<{ body: RawBody }> = []) => ({ name, visibility: 2, isEntry: false, typeParameters: [], parameters, returns })
  const types = [
    rawType("organization_treasury", "OrganizationTreasury", [["id", uid], ["org_id", idType], ["vault_id", idType], ["master_cap", datatype(capType)]], [4]),
    rawType("organization_treasury", "TransferBinding", [["id", uid], ["treasury_id", idType], ["proposal_id", idType]], [4]),
    rawType("organization_treasury", "TreasuryCreated", [["treasury_id", idType], ["org_id", idType], ["vault_id", idType]], [1, 2]),
    rawType("organization_treasury", "TransferCreated", [["binding_id", idType], ["treasury_id", idType], ["proposal_id", idType]], [1, 2]),
  ]
  types.forEach(type => { type.definingId = treasuryOrigin })
  fake.metadata.modules.push({ name: "organization_treasury", datatypes: types, functions: [
    fn("new", [org, ctx], [parameter(datatype(local("OrganizationTreasury")))]),
    fn("share", [parameter(datatype(local("OrganizationTreasury")))]),
    fn("create_transfer", [treasury, org, parameter(vector(primitive(3))), parameter(primitive(1)), parameter(primitive(6)), parameter(primitive(6)), clock, ctx], [parameter(idType)]),
    fn("execute", [treasury, parameter(datatype(local("TransferBinding")), 1), org, parameter(datatype(`${origin}::asynchronous_proposal::Proposal`), 2), parameter(datatype(`${origin}::vault::AgentVault`, [datatype(sui)]), 2), clock, ctx]),
  ] })
  fake.metadata.modules.push({ name: "asynchronous_proposal", functions: [], datatypes: [rawType("asynchronous_proposal", "Proposal", [["id", uid], ["org_id", idType], ["epoch", primitive(6)], ["proposer", primitive(1)], ["title", vector(primitive(3))], ["recipient", primitive(1)], ["amount", primitive(6)], ["threshold_weight", primitive(6)], ["accumulated_weight", primitive(6)], ["voters", datatype("0x2::table::Table", [primitive(1), primitive(6)])], ["partial_signatures", datatype("0x2::table::Table", [primitive(1), vector(primitive(3))])], ["deadline_ms", primitive(6)], ["status", primitive(3)]], [4])] })
  const shared: SuiClientObjectOwner = { $kind: "Shared", Shared: { initialSharedVersion: "1" } }
  fake.objects.delete(capId)
  fake.objects.set(treasuryId, { objectId: treasuryId, type: local("OrganizationTreasury"), owner: shared, content: organizationTreasuryBcs.serialize({ id: treasuryId, org_id: orgId, vault_id: vaultId, master_cap: { id: capId, vault_id: vaultId } }).toBytes() })
  fake.objects.set(bindingId, { objectId: bindingId, type: local("TransferBinding"), owner: shared, content: treasuryBindingBcs.serialize({ id: bindingId, treasury_id: treasuryId, proposal_id: proposalId }).toBytes() })
  fake.objects.set(proposalId, { objectId: proposalId, type: `${origin}::asynchronous_proposal::Proposal`, owner: shared, content: ProposalContent.serialize({ id: proposalId, org_id: orgId, epoch: "1", proposer: alice, title: [112, 97, 121], recipient: other, amount: "100", threshold_weight: "2", accumulated_weight: "2", voters: { id: address("0x40"), size: "2" }, partial_signatures: { id: address("0x41"), size: "2" }, deadline_ms: (BigInt(Date.now()) + 86400000n).toString(), status: 1 }).toBytes() })
  const creation = { eventType: local("TreasuryCreated"), sender: alice, bcs: treasuryCreatedBcs.serialize({ treasury_id: treasuryId, org_id: orgId, vault_id: vaultId }).toBytes() }
  const transferCodec = bcs.struct("TransferCreated", { binding_id: bcs.Address, treasury_id: bcs.Address, proposal_id: bcs.Address })
  const transfer = { eventType: local("TransferCreated"), sender: alice, bcs: transferCodec.serialize({ binding_id: bindingId, treasury_id: treasuryId, proposal_id: proposalId }).toBytes() }
  fake.client.listEvents = (async ({ filter, before }: { filter: { eventType: string }; before?: string }) => {
    fake.state.eventCalls.push(before || null)
    return { events: filter.eventType === creation.eventType ? [creation] : filter.eventType === transfer.eventType ? [transfer] : fake.state.events, hasNextPage: false, endCursor: null }
  }) as unknown as GroupVaultClient["listEvents"]
  return { ...fake, creation, transfer, types }
}

test("missing organization treasury is explicit while verified legacy rows remain available", async () => {
  const fake = fakeClient(), reader = fake.reader()
  const list = await reader.listVaults(orgId)
  assert.equal(list.vaults.length, 1)
  assert.match(list.treasuryDeploymentError!, /NEXT_PUBLIC_ORGANIZATION_TREASURY_PACKAGE_ID/)
  await assert.rejects(reader.buildCreateTreasury(alice, orgId), /organization_treasury/)
})

test("sealed treasury verifies exact nested cap, shared SUI vault and org association without top-level cap", async () => {
  const fake = treasuryFake(), reader = fake.reader()
  const row = await reader.readTreasury(treasuryId, orgId)
  assert.equal(row.id, vaultId)
  assert.equal(row.treasuryId, treasuryId)
  assert.equal(row.masterCapId, capId)
  assert.equal(row.authority.status, "organization-treasury")
  assert.equal(row.authority.verified, true)
  assert.equal(row.authority.ownerAddress, null)
  assert.equal((await reader.readVault(vaultId, orgId)).treasuryId, treasuryId)
  const list = await reader.listVaults(orgId)
  assert.equal(list.vaults.length, 1)
  assert.equal(list.treasuryDeploymentError, undefined)
  assert.deepEqual(list.errors, [])
})

test("treasury rejects mismatched org/cap/vault, trailing BCS, wrong original type or nonshared custody", async () => {
  for (const mutate of mutationList([
    object => { object.type = `${pkg}::organization_treasury::OrganizationTreasury` },
    object => { object.owner = { $kind: "AddressOwner", AddressOwner: alice } },
    object => { object.objectId = other },
    object => { object.content = Uint8Array.from([...object.content, 0]) },
    object => { object.content = organizationTreasuryBcs.serialize({ ...organizationTreasuryBcs.parse(object.content), org_id: other }).toBytes() },
    object => { object.content = organizationTreasuryBcs.serialize({ ...organizationTreasuryBcs.parse(object.content), master_cap: { id: capId, vault_id: other } }).toBytes() },
  ])) {
    const fake = treasuryFake(); mutate(fake.objects.get(treasuryId)!)
    await assert.rejects(fake.reader().readTreasury(treasuryId, orgId))
  }
  const fake = treasuryFake()
  fake.objects.get(vaultId)!.type = `${origin}::vault::AgentVault<${token}>`
  await assert.rejects(fake.reader().readTreasury(treasuryId, orgId), /SUI/)
})

test("treasury metadata rejects authority escapes, wrong field origins and changed ABI before building", async () => {
  const mutations: Array<(fake: ReturnType<typeof treasuryFake>) => void> = [
    fake => { fake.types[0].abilities = [3, 4] },
    fake => { fake.types[0].fields.at(-1)!.type = datatype(`${other}::vault::MasterCap`) },
    fake => { fake.types[1].typeParameters = [{ constraints: [], isPhantom: false }] },
    fake => { fake.metadata.modules[2].functions[2].parameters.splice(6, 1) },
    fake => { fake.metadata.modules[2].functions.push({ name: "borrow_cap", visibility: 2, parameters: [], returns: [], typeParameters: [] }) },
    fake => { fake.metadata.modules[3].datatypes[0].fields.reverse() },
  ]
  for (const mutate of mutations) {
    const fake = treasuryFake(); mutate(fake)
    await assert.rejects(fake.reader().buildCreateTreasury(alice, orgId), /ABI/)
  }
})

test("treasury creation consumes returned cap wrapper by share in the same PTB", async () => {
  const tx = (await treasuryFake().reader().buildCreateTreasury(alice, orgId)).getData()
  assert.equal(tx.sender, alice)
  assert.equal(tx.commands.length, 2)
  assert.equal(tx.commands[0].MoveCall?.function, "new")
  assert.equal(tx.commands[1].MoveCall?.function, "share")
  assert.deepEqual(tx.commands[1].MoveCall?.arguments, [{ $kind: "Result", Result: 0 }])
})

test("treasury transfer creation includes canonical org, exact amount and Clock", async () => {
  const fake = treasuryFake(), reader = fake.reader()
  const input = { title: "pay", recipient: other, amount: 100n, deadlineMs: BigInt(Date.now()) + 86400000n }
  const tx = (await reader.buildCreateTreasuryTransfer(alice, treasuryId, orgId, input)).getData()
  assert.equal(tx.commands[0].MoveCall?.function, "create_transfer")
  assert.equal(tx.commands[0].MoveCall?.arguments.length, 7)
  assert.equal(tx.inputs.at(-1)?.UnresolvedObject?.objectId, address("0x6"))
  for (const invalid of [{ ...input, amount: 0n }, { ...input, title: "界".repeat(86) }, { ...input, deadlineMs: 1n }, { ...input, deadlineMs: BigInt(Date.now()) + 31_536_001_000n }]) await assert.rejects(reader.buildCreateTreasuryTransfer(alice, treasuryId, orgId, invalid))
})

test("transfer recovery reads actual proposal and binding and supports terminal refresh", async () => {
  const fake = treasuryFake(), reader = fake.reader()
  assert.equal((await reader.findCreatedTreasury([vaultId, treasuryId], orgId)).id, vaultId)
  const expected = { proposalId, bindingId, treasuryId, vaultId }
  assert.deepEqual(await reader.findCreatedTransfer([proposalId, bindingId], treasuryId, orgId), expected)
  assert.deepEqual(await reader.discoverTreasuryTransfer(proposalId, orgId), expected)
  fake.objects.get(proposalId)!.content = ProposalContent.serialize({ ...ProposalContent.parse(fake.objects.get(proposalId)!.content), status: 2 }).toBytes()
  assert.deepEqual(await reader.findCreatedTransfer([proposalId, bindingId], treasuryId, orgId), expected)
  await assert.rejects(reader.findCreatedTransfer([bindingId], treasuryId, orgId), /真实提案/)
})

test("execution validates treasury binding, proposal org, approval, epoch and amount before PTB", async () => {
  const fake = treasuryFake(), reader = fake.reader()
  const threshold = { nonce: 5n, frostSignature: new Uint8Array(64).fill(1) }
  const tx = (await reader.buildExecuteTreasury(alice, treasuryId, orgId, proposalId, bindingId, threshold)).getData()
  assert.equal(tx.commands[0].MoveCall?.function, "execute")
  assert.equal(tx.commands[0].MoveCall?.arguments.length, 8)
  assert.deepEqual(tx.inputs.map(input => input.UnresolvedObject?.objectId), [treasuryId, bindingId, orgId, proposalId, vaultId, undefined, undefined, address("0x6")])
  await assert.rejects(reader.buildExecuteTreasury(alice, treasuryId, orgId, proposalId, bindingId), /门限签名/)
  await assert.rejects(reader.buildExecuteTreasury(alice, treasuryId, orgId, other, bindingId, threshold), /提案不匹配/)
  for (const patch of [{ status: 2 }, { accumulated_weight: "1" }, { epoch: "0" }, { deadline_ms: "1" }]) {
    const testFake = treasuryFake()
    testFake.objects.get(proposalId)!.content = ProposalContent.serialize({ ...ProposalContent.parse(testFake.objects.get(proposalId)!.content), ...patch }).toBytes()
    await assert.rejects(testFake.reader().buildExecuteTreasury(alice, treasuryId, orgId, proposalId, bindingId, threshold))
  }
  fake.objects.get(bindingId)!.content = treasuryBindingBcs.serialize({ id: bindingId, treasury_id: other, proposal_id: proposalId }).toBytes()
  await assert.rejects(reader.buildExecuteTreasury(alice, treasuryId, orgId, proposalId, bindingId, threshold), /转账绑定/)
})
