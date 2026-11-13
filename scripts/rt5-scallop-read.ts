/** RT5: decode ScallopVaultAdapter BCS to prove inflated accounting post-attack. */
import { SuiGrpcClient } from "@mysten/sui/grpc"

const grpc = new SuiGrpcClient({ network: "testnet", baseUrl: "https://fullnode.testnet.sui.io:443" })

interface RpcRecord { [k: string]: unknown }
const asRecord = (v: unknown): RpcRecord => {
  if (v && typeof v === "object") return v as RpcRecord
  throw new Error("unexpected RPC shape")
}

async function go(): Promise<void> {
  const adA = "0x9947926aad22c62db4dbb6eeffb181f8d97e1476a1cb915d59125d6ef4dc698b"
  const res = asRecord(await grpc.getObject({ objectId: adA, include: { content: true } }))
  const object = asRecord(res.object)
  const content = object.content
  const b = content instanceof Uint8Array ? content : Uint8Array.from(Object.values(asRecord(content)) as number[])
  // Layout: uid(32) channel_id(32) admin(32) principal u64 ssui u64 harvested u64 = 120 bytes
  let p = 32 + 32 + 32
  const u64 = (off: number): bigint => { let x = 0n; for (let i = 7; i >= 0; i--) x = (x << 8n) | BigInt(b[off + i]); return x }
  console.log("type:", String(object.type))
  console.log("channel_id:", "0x" + Buffer.from(b.slice(32, 64)).toString("hex"))
  console.log("admin:", "0x" + Buffer.from(b.slice(64, 96)).toString("hex"))
  console.log("total_staked_sui_principal:", u64(p).toString(), "MIST =", Number(u64(p)) / 1e9, "SUI")
  console.log("ssui_balance:", u64(p + 8).toString())
  console.log("total_harvested_yield_sui:", u64(p + 16).toString(), "MIST =", Number(u64(p + 16)) / 1e9, "SUI")
}
void go()
