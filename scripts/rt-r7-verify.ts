/**
 * ROUND-7 LIVE VERIFY vs 0x50739707…
 *  A: create_organization_from_session 一次性锁（第二次 → 3026）
 *  B: 非参与者建组 → 3001
 *  C: PoP V1 旧签名（无 key_threshold 绑定）→ 1010；V2 正确签名 → 通过
 *  D: register_encryption_key 32B (X25519) 接受
 */
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { fromBase64 } from "@mysten/sui/utils"
import { SuiGrpcClient } from "@mysten/sui/grpc"
import { Transaction } from "@mysten/sui/transactions"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { ed25519 } from "@noble/curves/ed25519.js"
import { sha256 } from "@noble/hashes/sha2.js"

const PKG = "0x50739707bbb612bdfe320ef7f1d2653541f8bc7eeb2867dd7814fade5e5a6325"
const CLOCK = "0x0000000000000000000000000000000000000000000000000000000000000006"
const A1 = "0x2c6539e5802d1476dae4a7aada30265dd2568f198ecf2f184861ea7deb3f6347"
const A2 = "0x843f44a42e10a6dc701b7f60a4dedc544dc7910e971ee6a493f4d9096953e04e"
const SYB2 = "0x341acf449c898fa437e7928e8567898952dcfff8fffeddccb25b6a8b679d5b7a"
const client = new SuiGrpcClient({ network: "testnet", baseUrl: "https://fullnode.testnet.sui.io:443" })
function keypairFor(a: string): Ed25519Keypair {
  const ks = JSON.parse(readFileSync(`${homedir()}/.sui/sui_config/sui.keystore`, "utf8")) as string[]
  for (const e of ks) { const kp = Ed25519Keypair.fromSecretKey(fromBase64(e).slice(1)); if (kp.toSuiAddress() === a) return kp }
  throw new Error("no key " + a)
}
const le = (v: bigint) => { const o = new Uint8Array(8); let x = v; for (let i = 0; i < 8; i++) { o[i] = Number(x & 0xffn); x >>= 8n } return o }
const vi = (xs: Uint8Array[]) => { const t = 1 + xs.reduce((a, x) => a + x.length, 0); const o = new Uint8Array(t); o[0] = xs.length; let p = 1; for (const x of xs) { o.set(x, p); p += x.length } return o }
const aB = (a: string) => Buffer.from(a.replace(/^0x/, "").padStart(64, "0"), "hex")
const cat = (...xs: Uint8Array[]) => { const l = xs.reduce((a, x) => a + x.length, 0); const o = new Uint8Array(l); let p = 0; for (const x of xs) { o.set(x, p); p += x.length } return o }
async function run(kp: Ed25519Keypair, tx: Transaction) {
  try {
    tx.setSender(kp.toSuiAddress())
    const bytes = await tx.build({ client } as any)
    const sig = await kp.signTransaction(bytes)
    const res: any = await client.executeTransaction({ transaction: bytes, signatures: [sig.signature] })
    const t = res.Transaction ?? res.FailedTransaction
    if (t?.status?.success) return { ok: true, digest: typeof t.digest === "string" ? t.digest : t.digest?.digest }
    return { ok: false, err: t?.status?.error?.message?.slice(0, 120) }
  } catch (e: any) { return { ok: false, err: (e?.message ?? "").slice(0, 120) } }
}
async function eventsOf(d: string): Promise<any[]> {
  for (let i = 0; i < 8; i++) { try { const f: any = await client.getTransaction({ digest: d, include: { events: true } }); return f?.Transaction?.events ?? [] } catch { await new Promise(r => setTimeout(r, 600)) } }
  return []
}
let pass = 0, total = 0
const check = (l: string, r: any, want: "exec" | "block", code?: string) => {
  total++
  const good = want === "exec" ? r.ok : !r.ok && (!code || r.err?.includes(code))
  if (good) pass++
  console.log(`[${l}] ${good ? "✅" : "❌"} ${r.ok ? "EXECUTED" : r.err}`)
}
async function main() {
  const a1 = keypairFor(A1), a2 = keypairFor(A2), syb = keypairFor(SYB2)
  // === C: PoP V2 正路径 + V1 旧签名拒绝（直接 create_organization_entry）===
  const sk = new Uint8Array(32).fill(0x66)
  const pk = ed25519.getPublicKey(sk)
  const members = [A1, A2], weights = [1n, 1n]
  const kt = 2n, tw = 2n
  const v2Digest = sha256(cat(Buffer.from("SUI_ORG_POP_V2:"), Buffer.from("sui-testnet:"), Buffer.from(pk), vi(members.map(aB)), vi(weights.map(le)), le(tw), le(kt)))
  const v1Digest = sha256(cat(Buffer.from("SUI_ORG_POP_V1:"), Buffer.from("sui-testnet:"), Buffer.from(pk), vi(members.map(aB)), vi(weights.map(le)), le(tw)))
  const v1Sig = ed25519.sign(v1Digest, sk), v2Sig = ed25519.sign(v2Digest, sk)
  {
    const tx = new Transaction()
    tx.moveCall({ target: `${PKG}::cryptographic_org::create_organization_entry`, arguments: [tx.pure.vector("u8", [...pk]), tx.pure.u64(kt), tx.pure.u64(tw), tx.pure.vector("address", members), tx.pure.vector("u64", weights), tx.pure.vector("u8", [...v1Sig])] })
    check("C1 PoP V1 旧签名 → 1010", await run(a1, tx), "block", "1010")
  }
  {
    const tx = new Transaction()
    tx.moveCall({ target: `${PKG}::cryptographic_org::create_organization_entry`, arguments: [tx.pure.vector("u8", [...pk]), tx.pure.u64(kt), tx.pure.u64(tw), tx.pure.vector("address", members), tx.pure.vector("u64", weights), tx.pure.vector("u8", [...v2Sig])] })
    check("C2 PoP V2 正确签名", await run(a1, tx), "exec")
  }
  // === 建一个完整 session（economics 参数齐备）用于 A/B/D ===
  const parts = [A1, A2]
  let sid = ""
  {
    const tx = new Transaction()
    const [fee] = tx.splitCoins(tx.gas, [5_000_000n])
    tx.moveCall({ target: `${PKG}::dkg_committee::create_dkg_session`, arguments: [tx.pure.u64(2n), tx.pure.vector("address", parts), tx.pure.u64(BigInt(Date.now() + 3_600_000)), fee, tx.object(CLOCK)] })
    const r = await run(a1, tx)
    if (!r.ok) console.log("[setup] create failed:", r.err)
    if (r.ok) for (const e of await eventsOf(r.digest!)) if ((e.eventType ?? "").toLowerCase().includes("sessioncreated") || (e.eventType ?? "").toLowerCase().includes("bondconfigured")) {
      const b = e.bcs instanceof Uint8Array ? e.bcs : Uint8Array.from(Object.values(e.bcs) as number[])
      sid = "0x" + Buffer.from(b.slice(0, 32)).toString("hex")
    }
    console.log(`[setup] session ${sid.slice(0, 10)}`)
  }
  if (!sid) return console.log("setup failed")
  // === D: 32B X25519 密钥注册接受 ===
  {
    const tx = new Transaction()
    tx.moveCall({ target: `${PKG}::dkg_committee::register_encryption_key`, arguments: [tx.object(sid), tx.object(CLOCK), tx.pure.vector("u8", [...crypto.getRandomValues(new Uint8Array(32))])] })
    check("D1 32B X25519 密钥注册", await run(a1, tx), "exec")
  }
  // 补流程：承诺+确认+attest+finalize
  const { sha256: sh } = { sha256 }
  const attestKeys: Record<string, Uint8Array> = {}, attestPks: Record<string, Uint8Array> = {}
  for (const kp of [a1, a2]) { const k = new Uint8Array(32); crypto.getRandomValues(k); attestKeys[kp.toSuiAddress()] = k; attestPks[kp.toSuiAddress()] = ed25519.getPublicKey(k) }
  for (const kp of [a1, a2]) {
    const tx = new Transaction()
    const [pay] = tx.splitCoins(tx.gas, [50_000_000n])
    tx.moveCall({ target: `${PKG}::dkg_committee::submit_commitment`, arguments: [tx.object(sid), tx.object(CLOCK), tx.pure.vector("u8", [...crypto.getRandomValues(new Uint8Array(64))]), tx.pure.vector("u8", [...attestPks[kp.toSuiAddress()]]), pay] })
    await run(kp, tx)
  }
  for (const kp of [a1, a2]) {
    const tx = new Transaction(); tx.moveCall({ target: `${PKG}::dkg_committee::confirm_participant`, arguments: [tx.object(sid), tx.object(CLOCK)] }); await run(kp, tx)
  }
  const groupPk = ed25519.getPublicKey(new Uint8Array(32).fill(0x88))
  const ad = new Uint8Array(sha256(cat(Buffer.from("SUI_DKG_ATTEST_V1:"), aB(sid), Buffer.from(groupPk))))
  for (const kp of [a1, a2]) {
    const tx = new Transaction()
    tx.moveCall({ target: `${PKG}::dkg_committee::attest_group_key`, arguments: [tx.object(sid), tx.object(CLOCK), tx.pure.vector("u8", [...groupPk]), tx.pure.vector("u8", [...ed25519.sign(ad, attestKeys[kp.toSuiAddress()])])] })
    await run(kp, tx)
  }
  {
    const tx = new Transaction(); tx.moveCall({ target: `${PKG}::dkg_committee::finalize_session`, arguments: [tx.object(sid), tx.pure.vector("u8", [...groupPk])] })
    check("setup finalize", await run(a1, tx), "exec")
  }
  // === B: 非参与者建组 → 3001 ===
  {
    const tx = new Transaction()
    tx.moveCall({ target: `${PKG}::cryptographic_org::create_organization_from_session`, arguments: [tx.object(sid), tx.pure.u64(2n), tx.object(CLOCK)] })
    check("B1 非参与者(0x341a…)建组 → 3001", await run(syb, tx), "block", "3001")
  }
  // === A: 参与者建组成功，然后第二次 → 3026 ===
  {
    const tx = new Transaction()
    tx.moveCall({ target: `${PKG}::cryptographic_org::create_organization_from_session`, arguments: [tx.object(sid), tx.pure.u64(2n), tx.object(CLOCK)] })
    check("A1 参与者建组", await run(a1, tx), "exec")
  }
  {
    const tx = new Transaction()
    tx.moveCall({ target: `${PKG}::cryptographic_org::create_organization_from_session`, arguments: [tx.object(sid), tx.pure.u64(2n), tx.object(CLOCK)] })
    check("A2 同会话二次建组 → 3026", await run(a1, tx), "block", "3026")
  }
  console.log(`\n=== ROUND-7 VERIFY: ${pass}/${total} ===`)
}
main().catch(e => { console.error("ERR:", e.message); process.exit(1) })
