/** RT5: pull agent_vault events for the two attack txs. */
import { SuiGrpcClient } from "@mysten/sui/grpc"

const grpc = new SuiGrpcClient({ network: "testnet", baseUrl: "https://fullnode.testnet.sui.io:443" })
interface RpcRecord { [k: string]: unknown }
const asRecord = (v: unknown): RpcRecord => { if (v && typeof v === "object") return v as RpcRecord; throw new Error("bad shape") }
const fld = (v: unknown, k: string): unknown => asRecord(v)[k]

async function dumpTx(digest: string): Promise<void> {
  const res = asRecord(await grpc.getTransaction({ digest, include: { events: true } }))
  const t = asRecord(res.Transaction ?? res)
  const events = fld(t, "events")
  console.log(`\n=== ${digest} ===`)
  for (const e of Array.isArray(events) ? events : []) {
    console.log("event:", String(fld(e, "eventType") ?? "").split("::").slice(1).join("::"))
  }
  if (!Array.isArray(events) || events.length === 0) console.log("(no events returned; keys:", Object.keys(t).join(","), ")")
}

async function go(): Promise<void> {
  await dumpTx("EBjtf9xkZSBCuCusVHo5VJ6wTFYAaF6PNKngdHWR4Aer")
  await dumpTx("7fZPczAj6qb3xDorjbWnivVGJYNsWo47zPxtTMoZZH78")
}
void go().catch(e => console.log("ERR", String((e as Error).message).slice(0, 200)))
