// locate upgrade caps belonging to sui_project_a lineages (0x088870 current, 0x976800 used by UI tests, others)
import { SuiGrpcClient } from "@mysten/sui/grpc"
const client = new SuiGrpcClient({ network: "testnet", baseUrl: "https://fullnode.testnet.sui.io:443" })
function bytesOf(o: any): Uint8Array | undefined {
  const c = o?.content
  if (c?.$kind === "Bcs" && c.Bcs instanceof Uint8Array) return c.Bcs
  if (c && typeof c === "object" && Object.keys(c).length && Object.keys(c).every(k => /^\d+$/.test(k))) return Uint8Array.from(Object.values(c) as number[])
  return undefined
}
async function main() {
  const cap = "0xba60404a509da99a1a37dc5ebc1e7df6755821ed74bf37a8c7bfbaf4163abf90"
  const { object }: any = await client.getObject({ objectId: cap, include: { type: true, owner: true, content: true } })
  console.log("upgrade cap:", object?.objectType ?? object?.type, "owner:", JSON.stringify(object?.owner))
  const b = bytesOf(object)
  if (b) console.log("cap bcs:", Buffer.from(b).toString("hex"))
}
main().catch(e => console.error("ERR", e.message))
