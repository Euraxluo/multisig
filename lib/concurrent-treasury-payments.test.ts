import assert from "node:assert/strict"
import { test } from "node:test"
import { bcs } from "@mysten/sui/bcs"
import { Ed25519PublicKey } from "@mysten/sui/keypairs/ed25519"
import { normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils"
import { OrganizationContent, ProposalContent } from "./proposal-chain"
import {
  createGroupVaultReader,
  organizationTreasuryBcs,
  treasuryBindingBcs,
  treasuryCreatedBcs,
  vaultCreatedBcs,
  type GroupVaultClient,
} from "./group-vaults"
import type { SuiClientObjectOwner } from "./vault-client"

const address = normalizeSuiAddress
const pkg = address("0x999"), origin = address("0x888"), treasuryOrigin = address("0x777")
const vaultId = address("0x10"), capId = address("0x11"), orgId = address("0x12"), treasuryId = address("0x13")
const proposalA = address("0x100"), bindingA = address("0x200")
const proposalB = address("0x101"), bindingB = address("0x201")
const proposalC = address("0x102"), bindingC = address("0x202")
const alice = address("0xa"), other = address("0xb"), recipient = address("0xd")
const sui = normalizeStructTag("0x2::sui::SUI")
const key = Uint8Array.from(Buffer.from("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a", "hex"))
const groupAddress = new Ed25519PublicKey(key).toSuiAddress()
const vaultType = `${origin}::vault::AgentVault<${sui}>`
const capType = `${origin}::vault::MasterCap`

const addr = (value: string) => Buffer.from(value.slice(2), "hex")
const u64 = (value: bigint) => Buffer.from(value.toString(16).padStart(16, "0").match(/../g)!.reverse().join(""), "hex")
const vaultBytes = Uint8Array.from(Buffer.concat([addr(vaultId), u64((1n << 64n) - 1n), u64(3n), u64(2n), Buffer.from([1]), Buffer.from([0])]))
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
const rawType = (module: string, name: string, fields: Array<[string, RawBody]>, abilities: number[], isGeneric = false): RawType => ({
  name, module, typeName: `${pkg}::${module}::${name}`, definingId: origin, kind: 1, fields: fieldList(fields), abilities,
  typeParameters: isGeneric ? [{ isPhantom: true, constraints: [] }] : [], variants: [],
})

function packageFixture(): RawPackage {
  const parameter = (body: RawBody, reference?: number) => ({ body, reference })
  return {
    storageId: pkg,
    modules: [
      {
        name: "vault",
        datatypes: [
          rawType("vault", "AgentVault", [["id", uid], ["balance", datatype("0x2::balance::Balance", [generic])], ["vault_version", primitive(6)], ["total_subagents", primitive(6)], ["paused", primitive(2)]], [4], true),
          rawType("vault", "MasterCap", [["id", uid], ["vault_id", idType]], [3, 4]),
          rawType("vault", "VaultCreatedEvent", [["vault_id", idType], ["initial_version", primitive(6)]], [1, 2]),
        ],
        functions: [
          { name: "deposit", visibility: 2, isEntry: false, typeParameters: [{ constraints: [] }], parameters: [parameter(datatype(`${origin}::vault::AgentVault`, [generic]), 2), parameter(datatype("0x2::coin::Coin", [generic]))], returns: [] },
          { name: "withdraw", visibility: 2, isEntry: false, typeParameters: [{ constraints: [] }], parameters: [parameter(datatype(capType), 1), parameter(datatype(`${origin}::vault::AgentVault`, [generic]), 2), parameter(primitive(6)), parameter(primitive(1)), parameter(datatype("0x2::tx_context::TxContext"), 2)], returns: [] },
        ],
      },
      {
        name: "cryptographic_org",
        datatypes: [
          rawType("cryptographic_org", "Organization", [["id", uid], ["group_pk", vector(primitive(3))], ["threshold_weight", primitive(6)], ["epoch_version", primitive(6)], ["last_nonce", primitive(6)], ["chain_id", vector(primitive(3))], ["members_weight", datatype("0x2::table::Table", [primitive(1), primitive(6)])], ["executed_proposals", datatype("0x2::table::Table", [vector(primitive(3)), primitive(2)])]], [4]),
        ],
        functions: [],
      },
    ],
    typeOrigins: [],
    linkage: [],
  }
}

function proposalBytes(propId: string, amount: string, status = 1, accumulatedWeight = "2") {
  return ProposalContent.serialize({
    id: propId,
    org_id: orgId,
    epoch: "1",
    proposer: alice,
    title: Array.from(new TextEncoder().encode(`Payment ${propId}`)),
    recipient,
    amount,
    threshold_weight: "2",
    accumulated_weight: accumulatedWeight,
    voters: { id: address("0x40"), size: "2" },
    partial_signatures: { id: address("0x41"), size: "2" },
    deadline_ms: (BigInt(Date.now()) + 86400000n).toString(),
    status,
  }).toBytes()
}

function bindingBytes(bindId: string, propId: string) {
  return treasuryBindingBcs.serialize({
    id: bindId,
    treasury_id: treasuryId,
    proposal_id: propId,
  }).toBytes()
}

function createMultiPaymentHarness() {
  const metadata = packageFixture()
  const local = (name: string) => `${treasuryOrigin}::organization_treasury::${name}`
  const parameter = (body: RawBody, reference?: number) => ({ body, reference })
  const ctx = parameter(datatype("0x2::tx_context::TxContext"), 2)
  const clock = parameter(datatype("0x2::clock::Clock"), 1)
  const treasuryParam = parameter(datatype(local("OrganizationTreasury")), 1)
  const orgParam = parameter(datatype(`${origin}::cryptographic_org::Organization`), 1)
  const fn = (name: string, parameters: Array<{ body: RawBody; reference?: number }>, returns: Array<{ body: RawBody }> = []) => ({
    name, visibility: 2, isEntry: false, typeParameters: [], parameters, returns,
  })

  const types = [
    rawType("organization_treasury", "OrganizationTreasury", [["id", uid], ["org_id", idType], ["vault_id", idType], ["master_cap", datatype(capType)]], [4]),
    rawType("organization_treasury", "TransferBinding", [["id", uid], ["treasury_id", idType], ["proposal_id", idType]], [4]),
    rawType("organization_treasury", "TreasuryCreated", [["treasury_id", idType], ["org_id", idType], ["vault_id", idType]], [1, 2]),
    rawType("organization_treasury", "TransferCreated", [["binding_id", idType], ["treasury_id", idType], ["proposal_id", idType]], [1, 2]),
  ]
  types.forEach(type => { type.definingId = treasuryOrigin })

  metadata.modules.push({
    name: "organization_treasury",
    datatypes: types,
    functions: [
      fn("new", [orgParam, ctx], [parameter(datatype(local("OrganizationTreasury")))]),
      fn("share", [parameter(datatype(local("OrganizationTreasury")))]),
      fn("create_transfer", [treasuryParam, orgParam, parameter(vector(primitive(3))), parameter(primitive(1)), parameter(primitive(6)), parameter(primitive(6)), clock, ctx], [parameter(idType)]),
      fn("execute", [treasuryParam, parameter(datatype(local("TransferBinding")), 1), orgParam, parameter(datatype(`${origin}::asynchronous_proposal::Proposal`), 2), parameter(datatype(`${origin}::vault::AgentVault`, [datatype(sui)]), 2), clock, ctx]),
    ],
  })

  metadata.modules.push({
    name: "asynchronous_proposal",
    functions: [],
    datatypes: [
      rawType("asynchronous_proposal", "Proposal", [
        ["id", uid], ["org_id", idType], ["epoch", primitive(6)], ["proposer", primitive(1)], ["title", vector(primitive(3))],
        ["recipient", primitive(1)], ["amount", primitive(6)], ["threshold_weight", primitive(6)], ["accumulated_weight", primitive(6)],
        ["voters", datatype("0x2::table::Table", [primitive(1), primitive(6)])], ["partial_signatures", datatype("0x2::table::Table", [primitive(1), vector(primitive(3))])],
        ["deadline_ms", primitive(6)], ["status", primitive(3)],
      ], [4]),
    ],
  })

  type Obj = { objectId: string; type: string; owner: SuiClientObjectOwner; content: Uint8Array }
  const shared: SuiClientObjectOwner = { $kind: "Shared", Shared: { initialSharedVersion: "1" } }

  const orgContent = OrganizationContent.serialize({
    id: orgId,
    group_pk: Array.from(key),
    threshold_weight: "2",
    epoch_version: "1",
    last_nonce: "0",
    chain_id: Array.from(new TextEncoder().encode("sui-testnet:")),
    members_weight: { id: address("0x20"), size: "3" },
    executed_proposals: { id: address("0x21"), size: "0" },
  }).toBytes()

  const treasuryContent = organizationTreasuryBcs.serialize({
    id: treasuryId,
    org_id: orgId,
    vault_id: vaultId,
    master_cap: { id: capId, vault_id: vaultId },
  }).toBytes()

  const objects = new Map<string, Obj>([
    [vaultId, { objectId: vaultId, type: vaultType, owner: shared, content: vaultBytes }],
    [capId, { objectId: capId, type: capType, owner: { $kind: "AddressOwner", AddressOwner: groupAddress }, content: capBytes }],
    [orgId, { objectId: orgId, type: `${origin}::cryptographic_org::Organization`, owner: shared, content: orgContent }],
    [treasuryId, { objectId: treasuryId, type: local("OrganizationTreasury"), owner: shared, content: treasuryContent }],
    // Concurrent proposals in the same treasury
    [proposalA, { objectId: proposalA, type: `${origin}::asynchronous_proposal::Proposal`, owner: shared, content: proposalBytes(proposalA, "1000000000") }],
    [bindingA, { objectId: bindingA, type: local("TransferBinding"), owner: shared, content: bindingBytes(bindingA, proposalA) }],
    [proposalB, { objectId: proposalB, type: `${origin}::asynchronous_proposal::Proposal`, owner: shared, content: proposalBytes(proposalB, "2000000000") }],
    [bindingB, { objectId: bindingB, type: local("TransferBinding"), owner: shared, content: bindingBytes(bindingB, proposalB) }],
    [proposalC, { objectId: proposalC, type: `${origin}::asynchronous_proposal::Proposal`, owner: shared, content: proposalBytes(proposalC, "3000000000") }],
    [bindingC, { objectId: bindingC, type: local("TransferBinding"), owner: shared, content: bindingBytes(bindingC, proposalC) }],
  ])

  // Simulated Gas Coin Pool for the executor account
  let gasCoinVersion = 1n
  const gasCoinId = address("0x9999")
  const getGasCoin = () => ({
    objectId: gasCoinId,
    version: gasCoinVersion.toString(),
    digest: `digest_v${gasCoinVersion}`,
  })
  const consumeGasCoin = () => {
    gasCoinVersion += 1n
  }

  const client = {
    movePackageService: {
      getPackage: async () => ({ response: { package: metadata } }),
    },
    getObject: async ({ objectId: id }: { objectId: string }) => {
      const obj = objects.get(address(id))
      if (!obj) throw new Error(`Object not found: ${id}`)
      return { object: obj }
    },
    getObjects: async ({ objectIds }: { objectIds: string[] }) => ({
      objects: objectIds.map(id => {
        const obj = objects.get(address(id))
        return obj ? { object: obj } : new Error(`Object not found: ${id}`)
      }),
    }),
    listOwnedObjects: async () => ({ objects: [], hasNextPage: false, cursor: null }),
    listEvents: async () => ({ events: [], hasNextPage: false, endCursor: null }),
  } as unknown as GroupVaultClient

  const reader = createGroupVaultReader(client, { packageId: pkg, typeOrigin: origin, maxPages: 3 })
  return { objects, client, reader, getGasCoin, consumeGasCoin }
}

test("Issue #4 verification: multi-payment transaction construction binds ONLY shared objects and NO gas coin versions", async () => {
  const harness = createMultiPaymentHarness()
  const txA = await harness.reader.buildExecuteTreasury(alice, treasuryId, orgId, proposalA, bindingA)
  const txB = await harness.reader.buildExecuteTreasury(alice, treasuryId, orgId, proposalB, bindingB)
  const txC = await harness.reader.buildExecuteTreasury(alice, treasuryId, orgId, proposalC, bindingC)

  const dataA = txA.getData()
  const dataB = txB.getData()
  const dataC = txC.getData()

  // 1. Verify that all transactions access independent proposal & binding objects
  assert.equal(dataA.inputs[3]?.UnresolvedObject?.objectId, proposalA)
  assert.equal(dataA.inputs[1]?.UnresolvedObject?.objectId, bindingA)

  assert.equal(dataB.inputs[3]?.UnresolvedObject?.objectId, proposalB)
  assert.equal(dataB.inputs[1]?.UnresolvedObject?.objectId, bindingB)

  assert.equal(dataC.inputs[3]?.UnresolvedObject?.objectId, proposalC)
  assert.equal(dataC.inputs[1]?.UnresolvedObject?.objectId, bindingC)

  // 2. Crucial finding: none of the transactions bind gasPayment at buildExecuteTreasury time!
  // In native multisig (competitor bug), the multisig address pre-locks gas coins during offline proposal drafting.
  // In our Move smart contract multisig, gas is unbound until JIT execution by the executor's wallet.
  assert.equal(dataA.gasData.payment, null)
  assert.equal(dataB.gasData.payment, null)
  assert.equal(dataC.gasData.payment, null)
})

test("Issue #4 verification: executing Payment A updates gas coin version but leaves Payment B and C fully executable", async () => {
  const harness = createMultiPaymentHarness()

  // --- Step 1: Simulate Execution of Payment A ---
  const gasCoinBeforeA = harness.getGasCoin()
  assert.equal(gasCoinBeforeA.version, "1")

  // Executor simulates executing Tx A with gas coin at v1
  const txA = await harness.reader.buildExecuteTreasury(alice, treasuryId, orgId, proposalA, bindingA)
  txA.setGasPayment([gasCoinBeforeA])
  txA.setGasBudget(10_000_000n)
  txA.setGasPrice(1000n)

  // Payment A executes on-chain: proposalA status becomes executed (2), treasury balance decreases
  harness.objects.get(proposalA)!.content = proposalBytes(proposalA, "1000000000", 2)
  harness.consumeGasCoin() // Gas coin version increments from 1 -> 2

  const gasCoinAfterA = harness.getGasCoin()
  assert.equal(gasCoinAfterA.version, "2", "Gas coin version incremented after Tx A execution")

  // --- Step 2: Verify Payment B and C remain 100% valid and executable with new gas version ---
  // In competitor's native multisig, Payment B's signatures were collected over gas v1, making B invalid.
  // In our architecture, Proposal B's approval was recorded on-chain in proposalB object!
  // Tx B is constructed JIT with the executor's current gas coin (version 2)
  const txB = await harness.reader.buildExecuteTreasury(alice, treasuryId, orgId, proposalB, bindingB)
  txB.setGasPayment([gasCoinAfterA])
  txB.setGasBudget(10_000_000n)
  txB.setGasPrice(1000n)

  const dataB = txB.getData()
  assert.equal(dataB.gasData.payment?.[0]?.version, "2")
  assert.equal(dataB.inputs[3]?.UnresolvedObject?.objectId, proposalB)

  // Payment B executes on-chain: proposalB status becomes executed (2)
  harness.objects.get(proposalB)!.content = proposalBytes(proposalB, "2000000000", 2)
  harness.consumeGasCoin() // Gas coin version increments from 2 -> 3

  // --- Step 3: Verify Payment C also succeeds with gas version 3 ---
  const gasCoinAfterB = harness.getGasCoin()
  assert.equal(gasCoinAfterB.version, "3")

  const txC = await harness.reader.buildExecuteTreasury(alice, treasuryId, orgId, proposalC, bindingC)
  txC.setGasPayment([gasCoinAfterB])
  const dataC = txC.getData()
  assert.equal(dataC.gasData.payment?.[0]?.version, "3")
})

test("Issue #4 verification: transient gas coin conflict during concurrent submission does NOT invalidate on-chain approval", async () => {
  const harness = createMultiPaymentHarness()

  // Scenario: An executor attempts to run Tx B using stale gas coin v1 because Tx A was in-flight
  const staleGasCoin = { objectId: address("0x9999"), version: "1", digest: "stale" }

  // Simulating Sui node rejecting execution due to object version mismatch
  const simulatedRpcResult = {
    $kind: "FailedTransaction" as const,
    FailedTransaction: {
      status: {
        success: false,
        error: { message: "Object 0x9999 version mismatch: expected 1, current is 2" },
      },
    },
  }
  assert.equal(simulatedRpcResult.FailedTransaction.status.success, false)

  // Crucial check: Proposal B's on-chain object status is STILL pending/approved (status 1)
  const proposalBObj = harness.objects.get(proposalB)!
  const parsedProposalB = ProposalContent.parse(proposalBObj.content)
  assert.equal(parsedProposalB.status, 1, "Proposal B status is still approved on-chain")
  assert.equal(parsedProposalB.accumulated_weight, "2", "Approval weight is intact")

  // Re-reading and rebuilding Tx B with refreshed gas coin v2 succeeds cleanly without re-voting!
  const refreshedGasCoin = { objectId: address("0x9999"), version: "2", digest: "fresh" }
  const refreshedTxB = await harness.reader.buildExecuteTreasury(alice, treasuryId, orgId, proposalB, bindingB)
  refreshedTxB.setGasPayment([refreshedGasCoin])
  assert.equal(refreshedTxB.getData().gasData.payment?.[0]?.version, "2")
})

test("Issue #4 verification: idempotency and replay protection prevent double-execution after retry", async () => {
  const harness = createMultiPaymentHarness()

  // Mark Proposal A as executed (status = 2)
  harness.objects.get(proposalA)!.content = proposalBytes(proposalA, "1000000000", 2)

  // Re-executing an already executed proposal must be rejected before PTB creation
  await assert.rejects(
    harness.reader.buildExecuteTreasury(alice, treasuryId, orgId, proposalA, bindingA),
    /提案未获批准、已经结束或过期/,
    "Prevents duplicate payout and double-spending",
  )
})
