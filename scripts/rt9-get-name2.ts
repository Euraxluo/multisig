import { SuiGrpcClient } from "@mysten/sui/grpc"
import { normalizeSuiAddress } from "@mysten/sui/utils"
async function main() {
  const c = new SuiGrpcClient({ network: "testnet", baseUrl: "https://fullnode.testnet.sui.io:443" })
  const NAMES = normalizeSuiAddress("0x25193e4ee41b0927cf0624421b50ed97e85cade5c617cf51e38e7eaec58d8294")
  const obj: any = await c.getObject({ objectId: NAMES, include: { content: true } })
  const o2 = obj?.object ?? obj
  const content = o2?.content
  // BCS bytes array → find accounts Table id: it's a 32-byte sequence inside; brute-extract all 32B windows that look like object ids is unreliable — instead list dynamic fields of NAMES and print
  const dfs: any = await (c as any).listDynamicFields({ parentId: NAMES, limit: 10 })
  const items = dfs?.dynamicFields ?? dfs?.dynamicFieldPages ?? dfs?.objects ?? dfs?.data ?? []
  console.log("dynamic fields on Names:", Array.isArray(items) ? items.length : JSON.stringify(items).slice(0, 200))
  for (const it of (Array.isArray(items) ? items : []).slice(0, 10)) console.log("  ", JSON.stringify(it).slice(0, 220))
}
main().catch(e => console.error("ERR", String(e).slice(0, 200)))
