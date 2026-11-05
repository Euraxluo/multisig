import assert from "node:assert/strict"
import { test, beforeEach } from "node:test"
import { clearAdapterRecord, discoverCreatedAdapter, loadAdapterRecord, saveAdapterRecord } from "./scallop-adapter-store"

const CHANNEL = `0x${"11".repeat(32)}`
const CHANNEL2 = `0x${"22".repeat(32)}`
const ADAPTER = `0x${"33".repeat(32)}`
const PKG = `0x${"9a".repeat(32)}`

function memoryLocalStorage() {
  const store = new Map<string, string>()
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  } as Pick<Storage, "getItem" | "setItem" | "removeItem">
}

function installMemoryLocalStorage() {
  // node:test 无 window：store 在调用期取 window.localStorage，测试侧注入内存实现
  ;(globalThis as { window?: unknown }).window = { localStorage: memoryLocalStorage() }
}

beforeEach(installMemoryLocalStorage)

test("无记录时读取返回 null，不抛错", () => {
  assert.equal(loadAdapterRecord(CHANNEL), null)
})

test("保存后可按频道读回；同频道同 ID 幂等", () => {
  saveAdapterRecord({ channelId: CHANNEL, adapterId: ADAPTER, createdAtMs: 1 })
  const record = loadAdapterRecord(CHANNEL)
  assert.equal(record?.adapterId, ADAPTER)
  saveAdapterRecord({ channelId: CHANNEL, adapterId: ADAPTER, createdAtMs: 2 })
  assert.equal(loadAdapterRecord(CHANNEL)?.createdAtMs, 1)
})

test("多频道互不干扰；清除只影响目标频道", () => {
  saveAdapterRecord({ channelId: CHANNEL, adapterId: ADAPTER, createdAtMs: 1 })
  saveAdapterRecord({ channelId: CHANNEL2, adapterId: `0x${"44".repeat(32)}`, createdAtMs: 2 })
  clearAdapterRecord(CHANNEL)
  assert.equal(loadAdapterRecord(CHANNEL), null)
  assert.notEqual(loadAdapterRecord(CHANNEL2), null)
})

test("损坏的 localStorage 内容回退为空记录", () => {
  window.localStorage.setItem("sui_scallop_adapters", "not-json")
  assert.equal(loadAdapterRecord(CHANNEL), null)
  window.localStorage.setItem("sui_scallop_adapters", "[1,2,3]")
  assert.equal(loadAdapterRecord(CHANNEL), null)
})

test("缺关键字段拒绝保存", () => {
  assert.throws(() => saveAdapterRecord({ channelId: "", adapterId: ADAPTER, createdAtMs: 1 }), /不能为空/)
  assert.throws(() => saveAdapterRecord({ channelId: CHANNEL, adapterId: "", createdAtMs: 1 }), /不能为空/)
})

test("discoverCreatedAdapter 只认 Created+Shared 且类型匹配的对象", async () => {
  const good = `0x${"55".repeat(32)}`
  const client = {
    getTransaction: async () => ({
      effects: {
        changedObjects: [
          { objectId: `0x${"66".repeat(32)}`, idOperation: "Created", outputOwner: { $kind: "AddressOwner" } },
          { objectId: `0x${"77".repeat(32)}`, idOperation: "None", outputOwner: { $kind: "Shared" } },
          { objectId: good, idOperation: "Created", outputOwner: { $kind: "Shared" } },
        ],
      },
    }),
    getObject: async ({ objectId }: { objectId: string }) =>
      objectId === good
        ? { object: { type: `${PKG}::scallop_yield_adapter::ScallopVaultAdapter` } }
        : { object: { type: `${PKG}::onchain_chat::ChatChannel` } },
  }
  assert.equal(await discoverCreatedAdapter(client as never as Parameters<typeof discoverCreatedAdapter>[0], "DIGEST", PKG, 1), good)
})

test("无匹配对象时按尝试次数耗尽后抛错", async () => {
  const client = {
    getTransaction: async () => ({ effects: { changedObjects: [] } }),
    getObject: async () => ({ object: { type: "" } }),
  }
  await assert.rejects(discoverCreatedAdapter(client as never as Parameters<typeof discoverCreatedAdapter>[0], "DIGEST", PKG, 1), /手工补录/)
})
