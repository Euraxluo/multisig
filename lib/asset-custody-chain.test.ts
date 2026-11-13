import assert from "node:assert/strict"
import { test } from "node:test"
import { bcs } from "@mysten/sui/bcs"
import { normalizeSuiAddress } from "@mysten/sui/utils"
import { AssetCustodyBcs, CustodyProposalBcs, AssetReleasedBcs } from "multisig/agent-vault/custody"
import { readCustodyVoters, readUpgradeCapObject, verifySlotChild, isCustodyProposalType } from "./asset-custody-chain"
import { PROPOSAL_PACKAGE_ID } from "./proposal-chain"
import { clearCustodyRecord, discoverCreatedCustody, loadCustodyRecord, saveCustodyRecord } from "./asset-custody-store"

const CUSTODY = normalizeSuiAddress("0x11")
const ORG = normalizeSuiAddress("0x22")
const PROPOSAL = normalizeSuiAddress("0x33")
const ASSET = normalizeSuiAddress("0x44")
const PKG = `0x${"9a".repeat(32)}`
const CAP_TYPE = "0x2::package::UpgradeCap"
const typeName = Array.from(new TextEncoder().encode(CAP_TYPE))

function memoryLocalStorage() {
  const store = new Map<string, string>()
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  } as Pick<Storage, "getItem" | "setItem" | "removeItem">
}

test("托管记录：空读 null、保存幂等、损坏回退", () => {
  ;(globalThis as { window?: unknown }).window = { localStorage: memoryLocalStorage() }
  assert.equal(loadCustodyRecord(ORG), null)
  saveCustodyRecord({ orgId: ORG, custodyId: CUSTODY, createdAtMs: 1 })
  assert.equal(loadCustodyRecord(ORG)?.custodyId, CUSTODY)
  saveCustodyRecord({ orgId: ORG, custodyId: CUSTODY, createdAtMs: 2 })
  assert.equal(loadCustodyRecord(ORG)?.createdAtMs, 1)
  window.localStorage.setItem("sui_asset_custody", "not-json")
  assert.equal(loadCustodyRecord(ORG), null)
  saveCustodyRecord({ orgId: ORG, custodyId: CUSTODY, createdAtMs: 1 })
  clearCustodyRecord(ORG)
  assert.equal(loadCustodyRecord(ORG), null)
  assert.throws(() => saveCustodyRecord({ orgId: "", custodyId: CUSTODY, createdAtMs: 1 }), /不能为空/)
})

test("discoverCreatedCustody：只认本包的 shared 新建对象", async () => {
  const client = {
    getTransaction: async () => ({ effects: { changedObjects: [
      { objectId: "0xaa", idOperation: "Created", outputOwner: { $kind: "AddressOwner" } },
      { objectId: "0xbb", idOperation: "Created", outputOwner: { $kind: "Shared" } },
      { objectId: "0xcc", idOperation: "Deleted", outputOwner: { $kind: "Shared" } },
    ] } }),
    getObject: async ({ objectId }: { objectId: string }) => ({ object: { type: objectId === "0xbb" ? `${PKG}::asset_custody::AssetCustody` : `${PKG}::vault::AgentVault` } }),
  }
  assert.equal(await discoverCreatedCustody(client as never, "digest", PKG, 1), "0xbb")
})

test("readCustodyVoters：分页 join 出 1/2 双用途编码", async () => {
  const VoterField = bcs.struct("VoterField", { id: bcs.Address, name: bcs.Address, value: bcs.u8() })
  const fieldA = VoterField.serialize({ id: "0xf1", name: ORG, value: 1 }).toBytes()
  const fieldB = VoterField.serialize({ id: "0xf2", name: PROPOSAL, value: 2 }).toBytes()
  let page = 0
  const client = {
    listDynamicFields: async () => {
      page += 1
      return page === 1
        ? { dynamicFields: [{ fieldId: "0xf1" }], hasNextPage: true, cursor: "c2" }
        : { dynamicFields: [{ fieldId: "0xf2" }], hasNextPage: false, cursor: null }
    },
    getObjects: async ({ objectIds }: { objectIds: string[] }) => ({
      objects: objectIds.map(id => ({
        type: "0x2::dynamic_field::Field<address,u8>",
        content: id === "0xf1" ? fieldA : fieldB,
      })),
    }),
  }
  const voters = await readCustodyVoters(client as never, "table")
  assert.equal(voters[ORG], 1)
  assert.equal(voters[PROPOSAL], 2)
})

test("readCustodyVoters：非法编码与类型不匹配拒绝", async () => {
  const VoterField = bcs.struct("VoterField", { id: bcs.Address, name: bcs.Address, value: bcs.u8() })
  const bad = VoterField.serialize({ id: "0xf1", name: ORG, value: 3 }).toBytes()
  const client = {
    listDynamicFields: async () => ({ dynamicFields: [{ fieldId: "0xf1" }], hasNextPage: false }),
    getObjects: async () => ({ objects: [{ type: "0x2::dynamic_field::Field<address,u8>", content: bad }] }),
  }
  await assert.rejects(readCustodyVoters(client as never, "table"), /编码不合法/)
  const wrongType = { ...client, getObjects: async () => ({ objects: [{ type: "0x2::dynamic_field::Field<address,u64>", content: bad }] }) }
  await assert.rejects(readCustodyVoters(wrongType as never, "table"), /类型不匹配/)
})

test("verifySlotChild：直接 owner / wrapper 跳一跳 / 越权 owner", async () => {
  const CUST = "0x" + "11".repeat(32)
  const WRAP = "0x" + "22".repeat(32)
  // 直接 owner == custody
  const direct = { getObject: async () => ({ object: { owner: { $kind: "ObjectOwner", ObjectOwner: CUST } } }) }
  assert.equal(await verifySlotChild(direct as never, ASSET, CUST), true)
  // dynamic_object_field：直接 owner 是 Field wrapper，wrapper 的 owner 才是 custody（跳一跳）
  for (const ObjectOwner of [WRAP, { objectId: WRAP }, { inner: WRAP }]) {
    const client = {
      getObject: async ({ objectId }: { objectId: string }) => ({
        object: {
          owner: objectId === ASSET
            ? { $kind: "ObjectOwner", ObjectOwner }
            : { $kind: "Object", Object: CUST },
        },
      }),
    }
    assert.equal(await verifySlotChild(client as never, ASSET, CUST), true, JSON.stringify(ObjectOwner))
  }
  // wrapper 的 owner 指向别的对象——不是本 custody 的子对象
  const foreign = {
    getObject: async ({ objectId }: { objectId: string }) => ({
      object: { owner: objectId === ASSET ? { $kind: "ObjectOwner", ObjectOwner: WRAP } : { $kind: "Object", Object: "0x" + "99".repeat(32) } },
    }),
  }
  assert.equal(await verifySlotChild(foreign as never, ASSET, CUST), false)
  const addressOwner = { getObject: async () => ({ object: { owner: { $kind: "AddressOwner", AddressOwner: ORG } } }) }
  assert.equal(await verifySlotChild(addressOwner as never, ASSET, ORG), false)
  const shared = { getObject: async () => ({ object: { owner: { $kind: "Shared" } } }) }
  assert.equal(await verifySlotChild(shared as never, ASSET, ORG), false)
  const unreachable = { getObject: async () => { throw new Error("404") } }
  assert.equal(await verifySlotChild(unreachable as never, ASSET, ORG), false)
})

test("readUpgradeCapObject：73B 三形状 content 解析与 UID 绑定", async () => {
  const bytes = Uint8Array.from([
    ...Array.from({ length: 32 }, (_, i) => 0x10 + i), // uid
    ...Array.from({ length: 32 }, (_, i) => (parseInt(PKG.slice(2 + i * 2, 4 + i * 2), 16))), // package
    2, 0, 0, 0, 0, 0, 0, 0, // version LE = 2
    1, // policy
  ])
  assert.equal(bytes.length, 73)
  const uid = "0x" + Array.from({ length: 32 }, (_, i) => (0x10 + i).toString(16).padStart(2, "0")).join("")
  const cases: unknown[] = [bytes, Array.from(bytes), Buffer.from(bytes).toString("base64"), Array.from(bytes).join(",")]
  for (const content of cases) {
    const client = { getObject: async () => ({ object: { objectId: uid, content } }) }
    const cap = await readUpgradeCapObject(client as never, uid)
    assert.equal(cap.packageId, PKG)
    assert.equal(cap.version, 2n)
    assert.equal(cap.policy, 1)
  }
  const mismatch = { getObject: async () => ({ object: { objectId: ASSET, content: bytes } }) }
  await assert.rejects(readUpgradeCapObject(mismatch as never, ASSET), /UID/)
  const short = { getObject: async () => ({ object: { objectId: uid, content: bytes.slice(0, 72) } }) }
  await assert.rejects(readUpgradeCapObject(short as never, uid), /73 字节/)
})

test("isCustodyProposalType：只认现行包的提案类型", () => {
  assert.equal(isCustodyProposalType(`${PROPOSAL_PACKAGE_ID}::asset_custody::CustodyProposal`), true)
  assert.equal(isCustodyProposalType(`${PKG}::asset_custody::CustodyProposal`), false)
  assert.equal(isCustodyProposalType(`${PROPOSAL_PACKAGE_ID}::asset_custody::AssetCustody`), false)
  assert.equal(isCustodyProposalType(`${PROPOSAL_PACKAGE_ID}::asset_custody::CustodyProposal<address>`), false)
})

test("SDK BCS 快照（前端 reader 的底座）：清单/提案/事件 roundtrip", () => {
  const custody = {
    id: CUSTODY, org_id: ORG,
    inventory: { contents: [{ key: typeName, value: { next_slot: 1, slots: { contents: [{ key: 0, value: { object_id: ASSET, depositor: ORG, deposited_ms: "1" } }] } } }] },
  }
  const wire = AssetCustodyBcs.serialize(custody).toBytes()
  assert.equal(AssetCustodyBcs.serialize(AssetCustodyBcs.parse(wire)).toBytes().length, wire.length)
  const proposal = {
    id: PROPOSAL, custody_id: CUSTODY, org_id: ORG, epoch: "1", kind: 1,
    type_name: typeName, slot: "0", object_id: ASSET, recipient: normalizeSuiAddress("0x0"), proposer: ORG,
    title: Array.from(new TextEncoder().encode("借出")), threshold_weight: "3", accumulated_weight: "0", rejected_weight: "0",
    voters: { id: ASSET, size: "0" }, deadline_ms: "1", borrow_deadline_ms: "1", action_digest: Array.from({length:32},(_,i)=>i+1), status: 1,
  }
  const parsed = CustodyProposalBcs.parse(CustodyProposalBcs.serialize(proposal).toBytes())
  assert.equal(parsed.kind, 1)
  const released = AssetReleasedBcs.parse(AssetReleasedBcs.serialize({ proposal_id: PROPOSAL, custody_id: CUSTODY, type_name: typeName, slot: "0", object_id: ASSET, recipient: ORG }).toBytes())
  assert.equal(released.recipient, ORG)
})
