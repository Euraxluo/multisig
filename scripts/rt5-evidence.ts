/** RT5: capture event evidence for P1/P2 txs + gas accounting. */
import { SuiGrpcClient } from "@mysten/sui/grpc"

const grpc = new SuiGrpcClient({ network: "testnet", baseUrl: "https://fullnode.testnet.sui.io:443" })

interface RpcRecord { [k: string]: unknown }
const asRecord = (v: unknown): RpcRecord => { if (v && typeof v === "object") return v as RpcRecord; throw new Error("bad shape") }
const fld = (v: unknown, k: string): unknown => asRecord(v)[k]

const delay = (ms: number) => { const { promise, resolve } = Promise.withResolvers<void>(); setTimeout(resolve, ms); return promise }

function hex2(e: unknown): Uint8Array {
  const b = fld(e, "bcs")
  return b instanceof Uint8Array ? b : Uint8Array.from(Object.values(asRecord(b)) as number[])
}

function hex(b: unknown): string {
  const u = b instanceof Uint8Array ? b : Uint8Array.from(Object.values(asRecord(b)) as number[])
  return "0x" + Buffer.from(u).toString("hex")
}

async function dump(digest: string): Promise<void> {
  for (let i = 0; i < 10; i++) {
    try {
      const full = asRecord(await grpc.getTransaction({ digest, include: { events: true, effects: true, balanceChanges: true } }))
      const t = asRecord(full.Transaction ?? full)
      const events = fld(t, "events")
      console.log(`\n=== tx ${digest} ===`)
      for (const e of Array.isArray(events) ? events : []) {
        const ty = String(fld(e, "eventType") ?? "")
        if (ty.includes("agent_vault")) console.log("event:", ty.split("::").slice(1).join("::"), "bcs:", Buffer.from(hex2(e)).toString("hex"))
      }
      const effects = fld(t, "effects")
      const gas = effects == null ? undefined : fld(effects, "gasEffects" as never) ?? fld(effects, "gas")
      const bc = fld(t, "balanceChanges")
      if (Array.isArray(bc)) for (const c of bc) {
        const owner = fld(c, "owner")
        const addr = owner == null ? "?" : fld(fld(owner, "AddressOwner") as unknown ?? owner, "address" as never) ?? "?"
        console.log("bal:", String(fld(c, "amount")), String(addr).slice(0, 12))
      }
      return
    } catch { /* retry */ }
    await delay(700)
  }
  console.log(digest, "NOT FOUND")
}

async function go(): Promise<void> {
  await dump("EBjtf9xkZSBCuCusVHo5VJ6wTFYAaF6PNKngdHWR4Aer") // P2 unauth deposit
  await dump("7fZPczAj6qb3xDorjbWnivVGJYNsWo47zPxtTMoZZH78") // P1 cross-channel feed
  await dump("8CP61VJRGGMBfW87KHVRK7Ya2zawn3ifjhJDn3MxjtQm") // setup c1
  await dump("BGqEPHdM6uaEWvHzWms5sfLv8QbxVJn3TNDkVnQjeMVJ") // setup c2
  await dump("6VgoEreYTvBYzKSH8DR8t22B2jdx5VTfR4UtGKRUVzhK") // setup adA
  await dump("FJM3NF4THQuYLrh2nEHymvHdvhNLminwrikuodNr8cTq") // setup adB
  for (const [label, addr] of [["A1", "0x2c6539e5802d1476dae4a7aada30265dd2568f198ecf2f184861ea7deb3f6347"], ["A2", "0x843f44a42e10a6dc701b7f60a4dedc544dc7910e971ee6a493f4d9096953e04e"]]) {
    const b = asRecord(await grpc.getBalance({ owner: addr }))
    console.log(label, "balance:", JSON.stringify(b).slice(0, 200))
  }
}
void go()
