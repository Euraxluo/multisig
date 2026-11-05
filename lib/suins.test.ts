import assert from "node:assert/strict"
import { afterEach, mock, test } from "node:test"
import { ObjectError, type SuiClientTypes } from "@mysten/sui/client"
import { bcs } from "@mysten/sui/bcs"
import { resolveSuiNSName, reverseResolveSuiNSName, suiNamesClient, suinsClient } from "./suins"

const address = `0x${"1".repeat(64)}`
const record = { name: "alice.sui", nftId: address, targetAddress: address, expirationTimestampMs: 0, data: {} }
afterEach(() => mock.restoreAll())

test("normalizes @names and uses the official SuiNS record and active resolution", async () => {
  const names: string[] = []
  mock.method(suinsClient, "getNameRecord", async (name: string) => { names.push(name); return record })
  mock.method(suiNamesClient.core, "resolveNameServiceAddress", async ({ name }: { name: string }) => { names.push(name); return { address } })
  assert.equal(await resolveSuiNSName(" @ALICE "), address)
  assert.deepEqual(names, ["alice.sui", "alice.sui"])
})

test("rejects unregistered names and records without a receiving address", async () => {
  for (const value of [null, { ...record, targetAddress: "" }, { ...record, targetAddress: `0x${"0".repeat(64)}` }]) {
    mock.method(suinsClient, "getNameRecord", async () => value)
    await assert.rejects(resolveSuiNSName("alice.sui"), /没有配置收款地址/)
    mock.restoreAll()
  }
})

test("maps the SDK missing dynamic-field error without hiding transport failures", async () => {
  mock.method(suinsClient, "getNameRecord", async () => { throw new ObjectError("notExists", "not found", { reason: "notFound" }) })
  await assert.rejects(resolveSuiNSName("alice.sui"), /没有配置收款地址/)
  mock.restoreAll()
  mock.method(suinsClient, "getNameRecord", async () => { throw new Error("network unavailable") })
  await assert.rejects(resolveSuiNSName("alice.sui"), /network unavailable/)
})

test("rejects expired or invalid parent registrations even when a record remains", async () => {
  mock.method(suinsClient, "getNameRecord", async () => record)
  mock.method(suiNamesClient.core, "resolveNameServiceAddress", async () => ({ address: null }))
  await assert.rejects(resolveSuiNSName("alice.sui"), /已过期/)
})

test("rejects a target that changes between record and active resolution", async () => {
  mock.method(suinsClient, "getNameRecord", async () => record)
  mock.method(suiNamesClient.core, "resolveNameServiceAddress", async () => ({ address: `0x${"2".repeat(64)}` }))
  await assert.rejects(resolveSuiNSName("alice.sui"), /解析记录发生变化/)
})

test("uses the installed official SDK to serialize domains and decode name-record BCS", async () => {
  const Domain = bcs.struct("Domain", { labels: bcs.vector(bcs.string()) })
  const Entry = bcs.struct("Entry", { key: bcs.string(), value: bcs.string() })
  const NameRecord = bcs.struct("NameRecord", {
    nft_id: bcs.Address, expiration_timestamp_ms: bcs.u64(), target_address: bcs.option(bcs.Address),
    data: bcs.struct("VecMap", { contents: bcs.vector(Entry) }),
  })
  const lookup = mock.method(suiNamesClient.core, "getDynamicField", async ({ parentId, name }: SuiClientTypes.GetDynamicFieldOptions) => {
    assert.equal(parentId, suinsClient.config.registryTableId)
    assert.equal(name.type, `${suinsClient.config.packageIdV1}::domain::Domain`)
    assert.deepEqual(Domain.parse(name.bcs), { labels: ["sui", "alice", "pay"] })
    return { dynamicField: { value: { bcs: NameRecord.serialize({ nft_id: address, expiration_timestamp_ms: "1900000000000", target_address: address, data: { contents: [{ key: "avatar", value: "https://example.com/avatar.png" }] } }).toBytes() } } }
  })
  mock.method(suiNamesClient.core, "resolveNameServiceAddress", async () => ({ address }))
  assert.equal(await resolveSuiNSName("PAY.ALICE.SUI"), address)
  assert.equal(lookup.mock.callCount(), 1)
})

test("propagates active name-service transport failures", async () => {
  mock.method(suinsClient, "getNameRecord", async () => record)
  mock.method(suiNamesClient.core, "resolveNameServiceAddress", async () => { throw new Error("name service unavailable") })
  await assert.rejects(resolveSuiNSName("alice.sui"), /name service unavailable/)
})

test("rejects protocol names before querying SuiNS", async () => {
  const lookup = mock.method(suinsClient, "getNameRecord", async () => record)
  await assert.rejects(resolveSuiNSName("alice.id"), /有效的 SuiNS/)
  assert.equal(lookup.mock.callCount(), 0)
})

test("reverse lookup only returns a default name that still resolves to the same wallet", async () => {
  const other = `0x${"2".repeat(64)}`
  mock.method(suiNamesClient.core, "defaultNameServiceName", async ({ address: asked }: { address: string }) => {
    assert.equal(asked, address)
    return { data: { name: "alice.sui" } }
  })
  mock.method(suiNamesClient.core, "resolveNameServiceAddress", async () => ({ address }))
  assert.equal(await reverseResolveSuiNSName(address), "alice.sui")

  // A stale default that now points elsewhere must not label this wallet.
  mock.restoreAll()
  mock.method(suiNamesClient.core, "defaultNameServiceName", async () => ({ data: { name: "stale.sui" } }))
  mock.method(suiNamesClient.core, "resolveNameServiceAddress", async () => ({ address: other }))
  assert.equal(await reverseResolveSuiNSName(address), null)

  // Expired or unset names come back as null, not as an exception.
  mock.restoreAll()
  mock.method(suiNamesClient.core, "defaultNameServiceName", async () => ({ data: { name: null } }))
  assert.equal(await reverseResolveSuiNSName(address), null)

  // A lookup that FAILED is not a name that does not exist. Reporting null here
  // would render the raw address as "this wallet has no name", which is a false
  // claim about a registered name the node merely failed to answer for.
  mock.restoreAll()
  mock.method(suiNamesClient.core, "defaultNameServiceName", async () => ({ data: { name: "gone.sui" } }))
  mock.method(suiNamesClient.core, "resolveNameServiceAddress", async () => { throw new Error("not registered") })
  await assert.rejects(reverseResolveSuiNSName(address), /not registered/)

  await assert.rejects(reverseResolveSuiNSName("not-an-address"), /有效的 Sui 地址/)
  await assert.rejects(reverseResolveSuiNSName(`0x${"0".repeat(64)}`), /有效的 Sui 地址/)
})

test("a stalled name lookup fails with a timeout instead of hanging the caller", async () => {
  // `getNameRecord` has no signal of its own, so without the race a dead full
  // node would leave the login path waiting forever.
  mock.method(suinsClient, "getNameRecord", () => new Promise(() => {}))
  const started = Date.now()
  await assert.rejects(
    resolveSuiNSName("alice.sui", { timeoutMs: 50 }),
    /查询 SuiNS 记录超时/,
  )
  assert.ok(Date.now() - started < 5_000, "the race must settle well before the underlying promise does")
})
