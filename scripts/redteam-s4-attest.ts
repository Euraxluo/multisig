/**
 * RED-TEAM S4 — 攻击 S 的 attestation 腿 vs 新包（attestation 绑定修复）。
 * 女巫双钱包走到 attest：伪签名/移植签名必须 3018 拦截；
 * 用自持 attest 密钥签出正确摘要仍可 attest（预期内——一人双钱包残余），
 * 但「捡别人会话的空子移植 attestation」从此不可能。
 */
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { fromBase64 } from "@mysten/sui/utils"
import { SuiGrpcClient } from "@mysten/sui/grpc"
import { Transaction } from "@mysten/sui/transactions"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { ed25519 } from "@noble/curves/ed25519.js"
import { sha256 } from "@noble/hashes/sha2.js"

const PKG = process.argv[2] ?? "0x827268c43588a928fc24ce48dee65ab2f89af54d0481e8060a83b54c1ea325e5"
const CLOCK = "0x0000000000000000000000000000000000000000000000000000000000000006"
const A1 = "0x2c6539e5802d1476dae4a7aada30265dd2568f198ecf2f184861ea7deb3f6347"
const A2 = "0x843f44a42e10a6dc701b7f60a4dedc544dc7910e971ee6a493f4d9096953e04e"
const client = new SuiGrpcClient({ network: "testnet", baseUrl: "https://fullnode.testnet.sui.io:443" })
function keypairFor(address: string): Ed25519Keypair {
  const ks = JSON.parse(readFileSync(`${homedir()}/.sui/sui_config/sui.keystore`, "utf8")) as string[]
  for (const entry of ks) { const kp = Ed25519Keypair.fromSecretKey(fromBase64(entry).slice(1)); if (kp.toSuiAddress() === address) return kp }
  throw new Error("no key")
}
const cat = (...xs: Uint8Array[]) => { const l = xs.reduce((a, x) => a + x.length, 0); const o = new Uint8Array(l); let p = 0; for (const x of xs) { o.set(x, p); p += x.length } return o }
const attestDigest = (sid: Uint8Array, pk: Uint8Array) => sha256(cat(Buffer.from("SUI_DKG_ATTEST_V1:"), sid, pk))
async function run(signer: Ed25519Keypair, tx: Transaction): Promise<{ ok: boolean; digest?: string; err?: string }> {
  try {
    tx.setSender(signer.toSuiAddress())
    const bytes = await tx.build({ client } as any)
    const sig = await signer.signTransaction(bytes)
    const res: any = await client.executeTransaction({ transaction: bytes, signatures: [sig.signature], include: { effects: true, events: true } })
    const t = res.Transaction ?? res.FailedTransaction
    if (t?.status?.success) return { ok: true, digest: typeof t.digest === "string" ? t.digest : t.digest?.digest }
    return { ok: false, err: t?.status?.error?.message?.slice(0, 140) }
  } catch (e: any) { return { ok: false, err: (e?.message ?? "").slice(0, 140) } }
}
async function eventsOf(digest: string): Promise<any[]> {
  const full: any = await client.getTransaction({ digest, include: { events: true } })
  return full?.Transaction?.events ?? []
}
async function main() {
  const a1 = keypairFor(A1), a2 = keypairFor(A2)
  // 攻击者自持 attest 密钥（伪装正常参与者）+ 自持组钥
  const attestSk = new Uint8Array(32); crypto.getRandomValues(attestSk)
  const attestPk = ed25519.getPublicKey(attestSk)
  const sybilSk = new Uint8Array(32); crypto.getRandomValues(sybilSk)
  const sybilPk = ed25519.getPublicKey(sybilSk)
  const commitment = crypto.getRandomValues(new Uint8Array(64))

  // 会话
  let sid = ""
  {
    const tx = new Transaction()
    tx.moveCall({ target: `${PKG}::dkg_committee::create_dkg_session`, arguments: [tx.pure.u64(2n), tx.pure.vector("address", [A1, A2]), tx.pure.u64(BigInt(Date.now() + 3_600_000))] })
    const r = await run(a1, tx)
    if (!r.ok) return console.log("[setup create] failed:", r.err)
    for (const e of await eventsOf(r.digest!)) if ((e.eventType ?? "").includes("SessionCreated")) {
      const b = e.bcs instanceof Uint8Array ? e.bcs : Uint8Array.from(Object.values(e.bcs) as number[])
      sid = "0x" + Buffer.from(b.slice(0, 32)).toString("hex")
    }
    console.log("[setup] session", sid)
  }
  const sidB = Buffer.from(sid.slice(2), "hex")

  // 承诺 ×2（带合法公布公钥）
  for (const kp of [a1, a2]) {
    const tx = new Transaction()
    tx.moveCall({ target: `${PKG}::dkg_committee::submit_commitment`, arguments: [tx.object(sid), tx.object(CLOCK), tx.pure.vector("u8", [...commitment]), tx.pure.vector("u8", [...attestPk])] })
    const r = await run(kp, tx)
    if (!r.ok) return console.log("[setup commitment]", r.err)
  }
  // 确认 ×2
  for (const kp of [a1, a2]) {
    const tx = new Transaction()
    tx.moveCall({ target: `${PKG}::dkg_committee::confirm_participant`, arguments: [tx.object(sid), tx.object(CLOCK)] })
    const r = await run(kp, tx)
    if (!r.ok) return console.log("[setup confirm]", r.err)
  }

  let pass = 0, total = 0
  const check = (label: string, r: { ok: boolean; err?: string }, expect: "blocked" | "exec") => {
    total++
    const good = expect === "blocked" ? !r.ok && (r.err?.includes("3018") ?? false) : r.ok
    if (good) pass++
    console.log(`[${label}] ${good ? "✅" : "❌"} ${r.ok ? "EXECUTED" : r.err}`)
  }

  // S4a: 伪造签名（全零垃圾）→ 3018
  {
    const tx = new Transaction()
    tx.moveCall({ target: `${PKG}::dkg_committee::attest_group_key`, arguments: [tx.object(sid), tx.object(CLOCK), tx.pure.vector("u8", [...sybilPk]), tx.pure.vector("u8", new Array(64).fill(0))] })
    check("S4a 伪造签名", await run(a1, tx), "blocked")
  }
  // S4b: 移植签名——对「别的 group_pk」摘要签的正确签名 → 3018（摘要绑定）
  {
    const otherPk = ed25519.getPublicKey((() => { const s = new Uint8Array(32); crypto.getRandomValues(s); return s })())
    const sig = ed25519.sign(attestDigest(sidB, otherPk), attestSk)
    const tx = new Transaction()
    tx.moveCall({ target: `${PKG}::dkg_committee::attest_group_key`, arguments: [tx.object(sid), tx.object(CLOCK), tx.pure.vector("u8", [...sybilPk]), tx.pure.vector("u8", [...sig])] })
    check("S4b 摘要不匹配的移植签名", await run(a1, tx), "blocked")
  }
  // S4c: 跨会话移植——另一个 session id 的正确签名 → 3018
  {
    const fakeSid = crypto.getRandomValues(new Uint8Array(32))
    const sig = ed25519.sign(attestDigest(fakeSid, sybilPk), attestSk)
    const tx = new Transaction()
    tx.moveCall({ target: `${PKG}::dkg_committee::attest_group_key`, arguments: [tx.object(sid), tx.object(CLOCK), tx.pure.vector("u8", [...sybilPk]), tx.pure.vector("u8", [...sig])] })
    check("S4c 跨会话移植签名", await run(a1, tx), "blocked")
  }
  // S4d: 正确签名（公布公钥持有者对 (sid‖sybilPk) 签）→ 放行（一人双钱包残余，预期内）
  {
    const sig = ed25519.sign(attestDigest(sidB, sybilPk), attestSk)
    const tx = new Transaction()
    tx.moveCall({ target: `${PKG}::dkg_committee::attest_group_key`, arguments: [tx.object(sid), tx.object(CLOCK), tx.pure.vector("u8", [...sybilPk]), tx.pure.vector("u8", [...sig])] })
    const r = await run(a1, tx)
    total++
    if (r.ok) { pass++; console.log("[S4d 正确签名] ⚠️ EXECUTED — 已知残余（一人多钱包，链上不可区分，需产品层准入）") }
    else console.log("[S4d 正确签名] ❌ 意外拦截:", r.err)
  }
  console.log(`\n=== RESULT: ${pass}/${total} ===`)
}
main().catch(e => { console.error("ERR:", e.message); process.exit(1) })
