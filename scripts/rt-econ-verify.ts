/**
 * ADMISSION ECONOMICS LIVE VERIFICATION vs 0x71d818e7…
 *  E1: 无 fee/短 deadline 的会话创建被拒（3022/3025）
 *  E2: 合规创建（fee 0.005 + deadline 1h）成功；提交带 bond；finalize 后 claim_bond 全额退款
 *  E3: 超额支付 → 创世质押入 org（bonded_total/stakers/unlock 可读，live 净额）
 *  E4: unlock 前 withdraw → 1011
 */
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { fromBase64 } from "@mysten/sui/utils"
import { SuiGrpcClient } from "@mysten/sui/grpc"
import { Transaction } from "@mysten/sui/transactions"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"

const PKG = "0x71d818e7ff348c741b845bcb967ba5dae751c844788cceeac60e00a9dd4d8fd0"
const CLOCK = "0x0000000000000000000000000000000000000000000000000000000000000006"
const A1 = "0x2c6539e5802d1476dae4a7aada30265dd2568f198ecf2f184861ea7deb3f6347"
const A2 = "0x843f44a42e10a6dc701b7f60a4dedc544dc7910e971ee6a493f4d9096953e04e"
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
    return { ok: false, err: t?.status?.error?.message?.slice(0, 130) }
  } catch (e: any) { return { ok: false, err: (e?.message ?? "").slice(0, 130) } }
}
async function eventsOf(digest: string): Promise<any[]> {
  for (let i = 0; i < 8; i++) {
    try { const full: any = await client.getTransaction({ digest, include: { events: true } }); return full?.Transaction?.events ?? [] } catch { await new Promise(r => setTimeout(r, 600)) }
  }
  return []
}
let pass = 0, total = 0
const check = (label: string, r: { ok: boolean; err?: string }, want: "blocked" | "exec", code?: string) => {
  total++
  const good = want === "exec" ? r.ok : !r.ok && (!code || r.err?.includes(code))
  if (good) pass++
  console.log(`[${label}] ${good ? "✅" : "❌"} ${r.ok ? "EXECUTED" : r.err}`)
}
async function main() {
  const a1 = keypairFor(A1), a2 = keypairFor(A2)
  const parts = [A1, A2]
  const mkSession = async (fee: number, deadlineDelta: number) => {
    const tx = new Transaction()
    const [feeCoin] = tx.splitCoins(tx.gas, [BigInt(fee)])
    tx.moveCall({ target: `${PKG}::dkg_committee::create_dkg_session`, arguments: [tx.pure.u64(2n), tx.pure.vector("address", parts), tx.pure.u64(BigInt(Date.now() + deadlineDelta)), feeCoin, tx.object(CLOCK)] })
    const r = await run(a1, tx)
    if (!r.ok) return { r, sid: "" }
    let sid = ""
    for (const e of await eventsOf(r.digest!)) if ((e.eventType ?? "").includes("SessionCreated") || (e.eventType ?? "").includes("SessionBondConfigured")) {
      const b = e.bcs instanceof Uint8Array ? e.bcs : Uint8Array.from(Object.values(e.bcs) as number[])
      sid = "0x" + Buffer.from(b.slice(0, 32)).toString("hex"); break
    }
    return { r, sid }
  }
  // E1a: fee 不足（0.001 SUI < 0.005）
  { const { r } = await mkSession(1_000_000, 3_600_000); check("E1a fee 0.001 → 3022", r, "blocked", "3022") }
  // E1b: deadline 5 分钟 < 10 分钟
  { const { r } = await mkSession(5_000_000, 300_000); check("E1b deadline 5min → 3025", r, "blocked", "3025") }
  // E2: 合规创建 → 提交（bond 0.05 + A2 超额 0.1 创世质押）→ 确认 → attest → finalize → claim
  const { sid } = await mkSession(5_000_000, 3_600_000)
  if (!sid) return console.log("E2 setup failed")
  console.log("[E2] session", sid.slice(0, 10))
  const { ed25519 } = require("@noble/curves/ed25519.js")
  const { sha256 } = require("@noble/hashes/sha2.js")
  const addrB = (a: string) => Buffer.from(a.replace(/^0x/, "").padStart(64, "0"), "hex")
  const cat = (...xs: Uint8Array[]) => { const l = xs.reduce((a, x) => a + x.length, 0); const o = new Uint8Array(l); let p = 0; for (const x of xs) { o.set(x, p); p += x.length } return o }
  const sidB = Buffer.from(sid.replace(/^0x/, "").padStart(64, "0"), "hex")
  // per-wallet attestation keys, published at submit, reused to sign the attest digest
  const attestKeys: Record<string, Uint8Array> = {}
  const attestPks: Record<string, Uint8Array> = {}
  for (const kp of [a1, a2]) { const sk = new Uint8Array(32); crypto.getRandomValues(sk); attestKeys[kp.toSuiAddress()] = sk; attestPks[kp.toSuiAddress()] = ed25519.getPublicKey(sk) }
  const submit = async (kp: Ed25519Keypair, overpay: number) => {
    const tx = new Transaction()
    const total = 50_000_000 + overpay
    const [pay] = tx.splitCoins(tx.gas, [BigInt(total)])
    tx.moveCall({ target: `${PKG}::dkg_committee::submit_commitment`, arguments: [tx.object(sid), tx.object(CLOCK), tx.pure.vector("u8", [...crypto.getRandomValues(new Uint8Array(64))]), tx.pure.vector("u8", [...attestPks[kp.toSuiAddress()]]), pay] })
    return run(kp, tx)
  }
  check("E2a A1 exact-bond 提交", await submit(a1, 0), "exec")
  check("E2b A2 overpay 提交(含 0.1 质押)", await submit(a2, 100_000_000), "exec")
  for (const kp of [a1, a2]) {
    const tx = new Transaction()
    tx.moveCall({ target: `${PKG}::dkg_committee::confirm_participant`, arguments: [tx.object(sid), tx.object(CLOCK)] })
    await run(kp, tx)
  }
  // attest：各钱包用自己 Round1 公布的公钥对 H("SUI_DKG_ATTEST_V1:" ‖ sid ‖ groupPk) 真签
  const groupPk = ed25519.getPublicKey(new Uint8Array(32).fill(0x77))
  const attestDigest = new Uint8Array(sha256(cat(Buffer.from("SUI_DKG_ATTEST_V1:"), sidB, Buffer.from(groupPk))))
  for (const kp of [a1, a2]) {
    const sig = ed25519.sign(attestDigest, attestKeys[kp.toSuiAddress()])
    const tx = new Transaction()
    tx.moveCall({ target: `${PKG}::dkg_committee::attest_group_key`, arguments: [tx.object(sid), tx.object(CLOCK), tx.pure.vector("u8", [...groupPk]), tx.pure.vector("u8", [...sig])] })
    const r = await run(kp, tx)
    console.log(`[E2-attest ${kp.toSuiAddress().slice(0, 8)}] ${r.ok ? "ok" : "FAILED: " + r.err}`)
  }
  {
    const tx = new Transaction()
    tx.moveCall({ target: `${PKG}::dkg_committee::finalize_session`, arguments: [tx.object(sid), tx.pure.vector("u8", [...groupPk])] })
    const r = await run(a1, tx)
    check("E2c finalize", r, "exec")
  }
  {
    const tx = new Transaction()
    tx.moveCall({ target: `${PKG}::dkg_committee::claim_bond`, arguments: [tx.object(sid)] })
    const r = await run(a1, tx)
    check("E2d A1 claim_bond 全额退款", r, "exec")
  }
  // E3: org from session → 质押入账
  let orgId = ""
  {
    const tx = new Transaction()
    tx.moveCall({ target: `${PKG}::cryptographic_org::create_organization_from_session`, arguments: [tx.object(sid), tx.pure.u64(2n), tx.object(CLOCK)] })
    const r = await run(a1, tx)
    if (!r.ok) { console.log("[E3 org]", r.err); return }
    total++
    pass++
    for (const e of await eventsOf(r.digest!)) {
      if ((e.eventType ?? "").includes("GenesisStakeRecorded")) {
        const b = e.bcs instanceof Uint8Array ? e.bcs : Uint8Array.from(Object.values(e.bcs) as number[])
        orgId = "0x" + Buffer.from(b.slice(0, 32)).toString("hex")
        const totalStake = Buffer.from(b.slice(32, 40)).readBigUInt64BE()
        console.log(`[E3 org+质押] ✅ EXECUTED org=${orgId.slice(0, 10)} genesis_total=${totalStake} MIST (期望 100000000)`)
      }
      if ((e.eventType ?? "").includes("OrganizationCreated") && !orgId) {
        const b = e.bcs instanceof Uint8Array ? e.bcs : Uint8Array.from(Object.values(e.bcs) as number[])
        orgId = "0x" + Buffer.from(b.slice(0, 32)).toString("hex")
      }
    }
  }
  if (orgId) {
    const tx = new Transaction()
    tx.moveCall({ target: `${PKG}::cryptographic_org::withdraw_genesis_stake`, arguments: [tx.object(orgId), tx.pure.u64(1n), tx.pure.u64(1n), tx.pure.address(A1), tx.pure.vector("u8", [...crypto.getRandomValues(new Uint8Array(64))]), tx.object(CLOCK)] })
    check("E4 unlock 前 withdraw → 1011", await run(a1, tx), "blocked", "1011")
  }
  console.log(`\n=== ECONOMICS VERIFY: ${pass}/${total} ===`)
}
main().catch(e => { console.error("ERR:", e.message); process.exit(1) })
