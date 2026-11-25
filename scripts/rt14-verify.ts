import { SuiGrpcClient } from "@mysten/sui/grpc"
const c = new SuiGrpcClient({ network: "testnet", baseUrl: "https://fullnode.testnet.sui.io:443" })
const PKG = "0x73afe159f7b017efdfc7a013a6e444d54317b0147ae7fb182a182c3dc5ba57b5"
const OLD = "0xcdc87b8ef5b071a293966f4329f1e9b4a443f49f1cf599cc188009cf7524ab44"
interface ObjectInfo { type?: string; status?: string; objectType?: string }
async function main() {
for (const [name, id] of [["lineage-14", PKG], ["lineage-13", OLD]] as [string, string][]) {
  try {
    const { object }: { object?: ObjectInfo } = await c.getObject({ objectId: id, include: {} })
    console.log(name, "→", object?.status ?? "EXISTS", String(object?.objectType ?? "").includes("package") ? "(package)" : "")
  } catch (e) { console.log(name, "→ ERR", ((e as Error)?.message ?? "").slice(0, 80)) }
}
}
main().catch(e => { console.error(e.message); process.exit(1) })
