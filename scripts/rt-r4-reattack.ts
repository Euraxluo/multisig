/**
 * RED-TEAM ROUND 4 RE-ATTACK vs package 0xce550b77…
 * 验证四处修复实弹生效：
 *  R1 (#19): 直接路径 257B title / 366d deadline → 4017/4018
 *  R2 (#18): 跨 epoch 陈旧 cap 投票 → 以 min() 降级权重成功（不再是 4010）
 *  R3 (#20): quorum 达成但零 attest 的过期会话 → handle_session_timeout 成功
 *  R4 (#12): 借用窗口过期后 take_asset → abort 22
 */
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { fromBase64 } from "@mysten/sui/utils"
import { SuiGrpcClient } from "@mysten/sui/grpc"
import { Transaction } from "@mysten/sui/transactions"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { ed25519 } from "@noble/curves/ed25519.js"
import { sha256 } from "@noble/hashes/sha2.js"

const PKG = "0xce550b77f97866cb922834e4185585c61396ba953bacd27ee92f352b93cf9fc5"
const SUI = "0x2::sui::SUI"
const CLOCK = "0x0000000000000000000000000000000000000000000000000000000000000006"
const A1 = "0x2c6539e5802d1476dae4a7aada30265dd2568f198ecf2f184861ea7deb3f6347"
const A2 = "0x843f44a42e10a6dc701b7f60a4dedc544dc7910e971ee6a493f4d9096953e04e"
const M2 = "0x2b9953911b07f6b7d2c92e17ed6cb2325cc26f9eb1eaeb58497ee7b5523ea859"
const client = new SuiGrpcClient({ network: "testnet", baseUrl: "https://fullnode.testnet.sui.io:443" })
function keypairFor(address: string): Ed25519Keypair {
  const ks = JSON.parse(readFileSync(`${homedir()}/.sui/sui_config/sui.keystore`, "utf8")) as string[]
  for (const entry of ks) { const kp = Ed25519Keypair.fromSecretKey(fromBase64(entry).slice(1)); if (kp.toSuiAddress() === address) return kp }
  throw new Error("no key")
}
const le = (v: bigint) => { const o = new Uint8Array(8); let x = v; for (let i = 0; i < 8; i++) { o[i] = Number(x & 0xffn); x >>= 8n } return o }
const vi = (xs: Uint8Array[]) => { const t = 1 + xs.reduce((a, x) => a + x.length, 0); const o = new Uint8Array(t); o[0] = xs.length; let p = 1; for (const x of xs) { o.set(x, p); p += x.length } return o }
const addrB = (a: string) => Buffer.from(a.replace(/^0x/, "").padStart(64, "0"), "hex")
const cat = (...xs: Uint8Array[]) => { const l = xs.reduce((a, x) => a + x.length, 0); const o = new Uint8Array(l); let p = 0; for (const x of xs) { o.set(x, p); p += x.length } return o }
async function run(signer: Ed25519Keypair, tx: Transaction): Promise<{ ok: boolean; digest?: string; err?: string }> {
  try {
    tx.setSender(signer.toSuiAddress())
    const bytes = await tx.build({ client } as any)
    const sig = await signer.signTransaction(bytes)
    const res: any = await client.executeTransaction({ transaction: bytes, signatures: [sig.signature], include: { effects: true, events: true } })
    const t = res.Transaction ?? res.FailedTransaction
    if (t?.status?.success) return { ok: true, digest: typeof t.digest === "string" ? t.digest : t.digest?.digest }
    return { ok: false, err: t?.status?.error?.message?.slice(0, 150) }
  } catch (e: any) { return { ok: false, err: (e?.message ?? "").slice(0, 150) } }
}
async function fetchTx(digest: string, tries = 8): Promise<any | null> {
  for (let i = 0; i < tries; i++) {
    try {
      const full: any = await client.getTransaction({ digest, include: { events: true, objectTypes: true } })
      if (full?.Transaction) return full.Transaction
    } catch { /* not indexed yet */ }
    await new Promise(res => setTimeout(res, 700))
  }
  return null
}
async function eventsOf(digest: string): Promise<any[]> {
  const t = await fetchTx(digest)
  return t?.events ?? []
}
async function typesOf(digest: string): Promise<Record<string, string>> {
  const t = await fetchTx(digest)
  return t?.objectTypes ?? {}
}
async function main() {
  const a1 = keypairFor(A1)
  const sk = new Uint8Array(32); crypto.getRandomValues(sk)
  const pk = ed25519.getPublicKey(sk)
  const DAY = 86_400_000n

  // org: 2 members [A1 w2, M2 w1], kt=2, tw=2 — 小巧覆盖 R1/R2
  const popDigest = sha256(cat(Buffer.from("SUI_ORG_POP_V1:"), Buffer.from("sui-testnet:"), Buffer.from(pk), vi([addrB(A1), addrB(M2)]), vi([le(2n), le(1n)]), le(2n)))
  const popSig = ed25519.sign(popDigest, sk)
  let orgId = ""
  {
    const tx = new Transaction()
    tx.moveCall({ target: `${PKG}::cryptographic_org::create_organization_entry`, arguments: [tx.pure.vector("u8", [...pk]), tx.pure.u64(2n), tx.pure.u64(2n), tx.pure.vector("address", [A1, M2]), tx.pure.vector("u64", [2n, 1n]), tx.pure.vector("u8", [...popSig])] })
    const r = await run(a1, tx)
    if (!r.ok) return console.log("[setup org] FAILED", r.err)
    for (const e of await eventsOf(r.digest!)) if ((e.eventType ?? "").includes("OrganizationCreated")) {
      const b = e.bcs instanceof Uint8Array ? e.bcs : Uint8Array.from(Object.values(e.bcs) as number[])
      orgId = "0x" + Buffer.from(b.slice(0, 32)).toString("hex")
    }
    console.log("[setup] org", orgId)
  }

  // ---------- R1: 直接路径上界 ----------
  console.log("=== R1: #19 直接路径提案上界 ===")
  {
    // 需要 org shared 对象作参数 — create_transfer_proposal(org, title, recipient, amount, deadline, clock)
    const mk = async (title: Uint8Array, deadlineDelta: bigint, label: string, want: "blocked" | "exec") => {
      const tx = new Transaction()
      tx.moveCall({ target: `${PKG}::asynchronous_proposal::create_transfer_proposal`, arguments: [tx.object(orgId), tx.pure.vector("u8", [...title]), tx.pure.address(A2), tx.pure.u64(10n), tx.pure.u64(BigInt(Date.now()) + deadlineDelta), tx.object(CLOCK)] })
      const r = await run(a1, tx)
      const hit = want === "blocked" ? !r.ok && (r.err?.includes("4017") || r.err?.includes("4018")) : r.ok
      console.log(`[${label}] ${hit ? "✅" : "❌"} ${r.ok ? "EXECUTED" : r.err}`)
      return hit
    }
    let pass = 0
    if (await mk(new Uint8Array(257).fill(0x61), 7n * DAY, "R1a title 257B → 4017", "blocked")) pass++
    if (await mk(new Uint8Array(256).fill(0x61), 366n * DAY, "R1b deadline 366d → 4018", "blocked")) pass++
    console.log(`R1: ${pass}/2`)
  }

  // ---------- R2: #18 陈旧 cap 跨 epoch 降级 ----------
  console.log("=== R2: #18 跨 epoch cap 降级 ===")
  {
    // 签发 cap（新签名: org 第一个参数）—— voter_weight=2 (A1 的权重)
    let capId = ""
    {
      const tx = new Transaction()
      tx.moveCall({ target: `${PKG}::asynchronous_proposal::create_shared_subagent_cap`, arguments: [tx.object(orgId), tx.pure.address(A2), tx.pure.u64(2n), tx.pure.u64(1000n), tx.pure.u64(1000n), tx.pure.u64(BigInt(Date.now() + 3_600_000))] })
      const r = await run(a1, tx)
      if (!r.ok) return console.log("[R2 cap issue] FAILED", r.err)
      for (const [oid, ty] of Object.entries(await typesOf(r.digest!))) if ((ty as string).includes("SubagentCoSignCap")) capId = oid
      console.log("[R2] cap issued:", capId)
    }
    if (!capId) return console.log("❌ cap id not found")
    // 名册变更 → epoch 2, A1 权重 2→1
    {
      const rosterDigest = sha256(cat(Buffer.from("SUI_ORG_ROSTER_V1:"), Buffer.from("sui-testnet:"), addrB(orgId), le(1n), le(1n), le(2n), le(2n), vi([addrB(A1), addrB(M2)]), vi([le(1n), le(1n)])))
      const rosterSig = ed25519.sign(rosterDigest, sk)
      const tx = new Transaction()
      tx.moveCall({ target: `${PKG}::cryptographic_org::update_organization_roster`, arguments: [tx.object(orgId), tx.pure.u64(1n), tx.pure.vector("address", [A1, M2]), tx.pure.vector("address", [A1, M2]), tx.pure.vector("u64", [1n, 1n]), tx.pure.u64(2n), tx.pure.vector("u8", [...rosterSig])] })
      const r = await run(a1, tx)
      console.log(`[R2 roster w2→1 (epoch2)] ${r.ok ? "EXECUTED" : "BLOCKED: " + r.err}`)
      if (!r.ok) return
    }
    // 提案 + 陈旧 cap 投票（cap.voter_weight=2, live=1 → 降级 1，成功不再 4010）
    let proposalId = ""
    {
      const tx = new Transaction()
      tx.moveCall({ target: `${PKG}::asynchronous_proposal::create_transfer_proposal`, arguments: [tx.object(orgId), tx.pure.vector("u8", [...new TextEncoder().encode("r2")]), tx.pure.address(A2), tx.pure.u64(5n), tx.pure.u64(BigInt(Date.now() + 3_600_000)), tx.object(CLOCK)] })
      const r = await run(a1, tx)
      if (!r.ok) return console.log("[R2 proposal] FAILED", r.err)
      for (const [oid, ty] of Object.entries(await typesOf(r.digest!))) if ((ty as string).includes("asynchronous_proposal::Proposal")) proposalId = oid
      console.log("[R2] proposal", proposalId)
    }
    if (proposalId) {
      const a2 = keypairFor(A2)
      const tx = new Transaction()
      tx.moveCall({ target: `${PKG}::asynchronous_proposal::submit_async_vote_by_subagent`, arguments: [tx.object(proposalId), tx.object(orgId), tx.object(capId), tx.object(CLOCK), tx.pure.vector("u8", [])] })
      const r = await run(a2, tx)
      const ok = r.ok
      console.log(`[R2c 陈旧 cap 跨 epoch 投票] ${ok ? "✅ EXECUTED — 降级 min(2,1)=1 生效，不再砖化" : "❌ " + r.err}`)
    }
  }

  // ---------- R3: #20 僵尸会话超时 ----------
  console.log("=== R3: #20 quorum-无-attest 过期会话超时 ===")
  {
    // 会话 1-of-1 [A1]，deadline 已设为过去 → 直接 create 时 deadline 必须未来… 但 create 无 deadline>now 断言? 读源码时未见——直接用过去时间戳试
    let sid = ""
    {
      const tx = new Transaction()
      tx.moveCall({ target: `${PKG}::dkg_committee::create_dkg_session`, arguments: [tx.pure.u64(1n), tx.pure.vector("address", [A1]), tx.pure.u64(BigInt(Date.now() + 40_000))] })
      const r = await run(a1, tx)
      if (!r.ok) return console.log("[R3 create session] FAILED", r.err)
      for (const e of await eventsOf(r.digest!)) if ((e.eventType ?? "").includes("SessionCreated")) {
        const b = e.bcs instanceof Uint8Array ? e.bcs : Uint8Array.from(Object.values(e.bcs) as number[])
        sid = "0x" + Buffer.from(b.slice(0, 32)).toString("hex")
      }
      console.log("[R3] short-deadline session", sid)
    }
    if (sid) {
      // 提交承诺 + 确认（quorum 1/1 达成）→ 无 attest → 超时
      {
        const tx = new Transaction()
        tx.moveCall({ target: `${PKG}::dkg_committee::submit_commitment`, arguments: [tx.object(sid), tx.object(CLOCK), tx.pure.vector("u8", [...crypto.getRandomValues(new Uint8Array(64))]), tx.pure.vector("u8", [...ed25519.getPublicKey(new Uint8Array(32).fill(7))])] })
        const r = await run(a1, tx)
        if (!r.ok) return console.log("[R3 commitment] FAILED", r.err)
      }
      {
        const tx = new Transaction()
        tx.moveCall({ target: `${PKG}::dkg_committee::confirm_participant`, arguments: [tx.object(sid), tx.object(CLOCK)] })
        const r = await run(a1, tx)
        if (!r.ok) return console.log("[R3 confirm] FAILED", r.err)
      }
      console.log("[R3] quorum 1/1 reached, zero attestations — waiting out the deadline…")
      await new Promise(res => setTimeout(res, 45_000))
      const tx = new Transaction()
      tx.moveCall({ target: `${PKG}::dkg_committee::handle_session_timeout`, arguments: [tx.object(sid), tx.object(CLOCK)] })
      const r = await run(a1, tx)
      console.log(`[R3d quorum 达成零 attest 过期会话超时] ${r.ok ? "✅ EXECUTED — 僵尸会话可清退" : "❌ " + r.err}`)
    }
  }

  console.log("\n(R4 借用窗口过期路径需要完整 custody 提案流 —— Move 侧 375/375 已含 take_after_the_borrow_window_is_rejected 用例，链上实弹复打省略 gas)")
}
main().catch(e => { console.error("ERR:", e.message); process.exit(1) })
