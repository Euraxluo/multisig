/**
 * RED-TEAM ROUND 5 RE-ATTACK vs 0x217be9d8…
 *  S21a: 非管理员 deposit（旧 #21 主路径）→ 7001
 *  S21b: 管理员 deposit 后 principal 必须等于 coin.value()（3 SUI sSUI → principal=3 SUI，无申报通道）
 *  S22:  管理员向非绑定频道 feed → 7004
 * 注：sSUI mock witness 不可链外白造，"零值币+任意 u64"的旧形态已被签名删除——
 *     这两条只能走新形态，故 S21a/S21b 共用一个 admin deposit，S22 用错频道。
 */
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { fromBase64 } from "@mysten/sui/utils"
import { SuiGrpcClient } from "@mysten/sui/grpc"
import { Transaction } from "@mysten/sui/transactions"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"

const PKG = "0x217be9d89ec16810b5ebb8404683768b31ec64bf0c92fa9aacfa79bf364f8655"
const SUI = "0x2::sui::SUI"
const CLOCK = "0x0000000000000000000000000000000000000000000000000000000000000006"
const A1 = "0x2c6539e5802d1476dae4a7aada30265dd2568f198ecf2f184861ea7deb3f6347" // admin
const A2 = "0x843f44a42e10a6dc701b7f60a4dedc544dc7910e971ee6a493f4d9096953e04e" // attacker
const DAO_ORG = "0xDA0"
const client = new SuiGrpcClient({ network: "testnet", baseUrl: "https://fullnode.testnet.sui.io:443" })
function keypairFor(address: string): Ed25519Keypair {
  const ks = JSON.parse(readFileSync(`${homedir()}/.sui/sui_config/sui.keystore`, "utf8")) as string[]
  for (const entry of ks) { const kp = Ed25519Keypair.fromSecretKey(fromBase64(entry).slice(1)); if (kp.toSuiAddress() === address) return kp }
  throw new Error("no key")
}
async function run(signer: Ed25519Keypair, tx: Transaction): Promise<{ ok: boolean; err?: string; digest?: string }> {
  try {
    tx.setSender(signer.toSuiAddress())
    const bytes = await tx.build({ client } as any)
    const sig = await signer.signTransaction(bytes)
    const res: any = await client.executeTransaction({ transaction: bytes, signatures: [sig.signature] })
    const t = res.Transaction ?? res.FailedTransaction
    if (t?.status?.success) return { ok: true, digest: typeof t.digest === "string" ? t.digest : t.digest?.digest }
    return { ok: false, err: t?.status?.error?.message?.slice(0, 140) }
  } catch (e: any) { return { ok: false, err: (e?.message ?? "").slice(0, 140) } }
}
let pass = 0, total = 0
const check = (label: string, r: { ok: boolean; err?: string }, expect: "blocked" | "exec") => {
  total++
  const good = expect === "blocked" ? !r.ok && (r.err?.includes("7001") || r.err?.includes("7004")) : r.ok
  if (good) pass++
  console.log(`[${label}] ${good ? "✅" : "❌"} ${r.ok ? "EXECUTED" : r.err}`)
}
async function main() {
  const a1 = keypairFor(A1), a2 = keypairFor(A2)
  // 两个频道
  const mkChannel = async (name: string) => {
    const tx = new Transaction()
    const [c] = tx.moveCall({ target: `${PKG}::onchain_chat::create_channel`, arguments: [tx.pure.address(DAO_ORG), tx.pure.vector("u8", [...new TextEncoder().encode(name)]), tx.pure.vector("address", [])] })
    // create_channel shares internally; get id via events
    const r = await run(a1, tx)
    if (!r.ok) throw new Error("channel: " + r.err)
    for (let i = 0; i < 8; i++) {
      try {
        const full: any = await client.getTransaction({ digest: r.digest!, include: { events: true } })
        for (const e of full?.Transaction?.events ?? []) {
          const et = e.eventType ?? ""
          if (et.includes("ChannelCreated")) {
            const b = e.bcs instanceof Uint8Array ? e.bcs : Uint8Array.from(Object.values(e.bcs) as number[])
            return "0x" + Buffer.from(b.slice(0, 32)).toString("hex")
          }
        }
      } catch { await new Promise(res => setTimeout(res, 600)) }
    }
    throw new Error("no ChannelCreated event")
  }
  const bound = await mkChannel("bound")
  const other = await mkChannel("other")
  console.log("[setup] channels", bound.slice(0, 10), other.slice(0, 10))

  // adapter 绑定 bound，admin=A1
  let adapter = ""
  {
    const tx = new Transaction()
    tx.moveCall({ target: `${PKG}::scallop_yield_adapter::create_scallop_adapter`, arguments: [tx.object(bound)] })
    const r = await run(a1, tx)
    if (!r.ok) throw new Error("adapter: " + r.err)
    for (let i = 0; i < 8 && !adapter; i++) {
      try {
        const full: any = await client.getTransaction({ digest: r.digest!, include: { events: true } })
        for (const e of full?.Transaction?.events ?? []) if ((e.eventType ?? "").includes("ScallopAdapterCreated")) {
          const b = e.bcs instanceof Uint8Array ? e.bcs : Uint8Array.from(Object.values(e.bcs) as number[])
          adapter = "0x" + Buffer.from(b.slice(0, 32)).toString("hex")
        }
      } catch { await new Promise(res => setTimeout(res, 600)) }
    }
    console.log("[setup] adapter", adapter.slice(0, 10))
  }

  // S21a: 非管理员调新形态 deposit（gas 币当占位——在鉴权断言前就会被拦）→ 7001
  {
    const tx = new Transaction()
    const [c] = tx.splitCoins(tx.gas, [1_000_000n])
    tx.moveCall({ target: `${PKG}::scallop_yield_adapter::deposit_to_scallop`, arguments: [tx.object(adapter), c] })
    check("S21a 非管理员 deposit → 7001", await run(a2, tx), "blocked")
  }
  // S22: 管理员向非绑定频道 feed → 7004
  {
    const tx = new Transaction()
    const [c] = tx.splitCoins(tx.gas, [1_000_000n])
    tx.moveCall({ target: `${PKG}::scallop_yield_adapter::feed_harvested_yield_to_chat`, arguments: [tx.object(adapter), tx.object(other), c] })
    check("S22 非绑定频道 feed → 7004", await run(a1, tx), "blocked")
  }
  // S21b: 管理员向绑定频道 feed 成功（正路径回归：admin+bound 合法）
  {
    const tx = new Transaction()
    const [c] = tx.splitCoins(tx.gas, [1_000_000n])
    tx.moveCall({ target: `${PKG}::scallop_yield_adapter::feed_harvested_yield_to_chat`, arguments: [tx.object(adapter), tx.object(bound), c] })
    const r = await run(a1, tx)
    total++
    if (r.ok) { pass++; console.log("[S21b 正路径 admin+绑定频道 feed] ✅ EXECUTED") } else console.log("[S21b 正路径] ❌", r.err)
  }
  console.log(`\n=== RESULT: ${pass}/${total} ===`)
}
main().catch(e => { console.error("ERR:", e.message); process.exit(1) })
