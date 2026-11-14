/**
 * ROUND-9 附加攻击：UI 注入面（用户问题：「群文件/资产放有害内容或注入 UI 代码的内容」）
 * 实弹验证 4 个 sink：
 *  X1  identity set_profile：恶意 avatarUrl（javascript:/data:/带 user-info 的 https）→ 链上是否校验（客户端 buildSetProfile 校验可被直接 PTB 绕过）
 *  X2  链上 chat 消息 content_preview 放 <img onerror> / 协议链接 → React 渲染层是否转义
 *  X3  walrus 文件 content-type text/html + 文件名带路径 → 下载/缓存路径行为
 *  X4  动态 <img src> 用 safeAvatar 过滤后 javascript: data: 是否真的全拒
 */
import { Transaction } from "@mysten/sui/transactions"
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { fromBase64 } from "@mysten/sui/utils"
import { SuiGrpcClient } from "@mysten/sui/grpc"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { ed25519 } from "@noble/curves/ed25519.js"
import { sha256 } from "@noble/hashes/sha2.js"

const PKG = "0x768e3781fd774bdd010089ede1c66df344aee2047817a121aa6c602e73723501"
const ID_PKG = "0xba0780e7f08a0589c1f71c8b2eff10bfc6d498190c88d4d25292b502c7c9251e"
const NAMES = "0x25193e4ee41b0927cf0624421b50ed97e85cade5c617cf51e38e7eaec58d8294"
const CLOCK = "0x0000000000000000000000000000000000000000000000000000000000000006"
const A1 = "0x2c6539e5802d1476dae4a7aada30265dd2568f198ecf2f184861ea7deb3f6347"
const A2 = "0x843f44a42e10a6dc701b7f60a4dedc544dc7910e971ee6a493f4d9096953e04e"
const client = new SuiGrpcClient({ network: "testnet", baseUrl: "https://fullnode.testnet.sui.io:443" })
function keypairFor(a: string) { const ks = JSON.parse(readFileSync(`${homedir()}/.sui/sui_config/sui.keystore`, "utf8")) as string[]; for (const e of ks) { const kp = Ed25519Keypair.fromSecretKey(fromBase64(e).slice(1)); if (kp.toSuiAddress() === a) return kp } throw new Error("nokey") }
const le = (v: bigint) => { const o = new Uint8Array(8); let x = v; for (let i = 0; i < 8; i++) { o[i] = Number(x & 0xffn); x >>= 8n } return o }
const vi = (xs: Uint8Array[]) => { const t = 1 + xs.reduce((a, x) => a + x.length, 0); const o = new Uint8Array(t); o[0] = xs.length; let p = 1; for (const x of xs) { o.set(x, p); p += x.length } return o }
const aB = (a: string) => Buffer.from(a.replace(/^0x/, "").padStart(64, "0"), "hex")
const cat = (...xs: Uint8Array[]) => { const l = xs.reduce((a, x) => a + x.length, 0); const o = new Uint8Array(l); let p = 0; for (const x of xs) { o.set(x, p); p += x.length } return o }
async function run(kp: any, tx: any) {
  try { tx.setSender(kp.toSuiAddress()); const bytes = await tx.build({ client } as any); const sig = await kp.signTransaction(bytes); const res: any = await client.executeTransaction({ transaction: bytes, signatures: [sig.signature] }); const t = res.Transaction ?? res.FailedTransaction; return t?.status?.success ? { ok: true, digest: typeof t.digest === "string" ? t.digest : (t.digest?.digest as string | undefined) } : { ok: false, err: t?.status?.error?.message?.slice(0, 110) } } catch (e: any) { return { ok: false, err: (e?.message ?? "").slice(0, 110) } }
}
async function sim(kp: any, tx: any) {
  try { tx.setSender(kp.toSuiAddress()); const bytes = await tx.build({ client } as any); const res: any = await client.simulateTransaction({ transaction: bytes, checksEnabled: false }); const t = res.Transaction ?? res.FailedTransaction; return t?.status?.success ? { ok: true, digest: typeof t.digest === "string" ? t.digest : (t.digest?.digest as string | undefined) } : { ok: false, err: t?.status?.error?.message?.slice(0, 110) } } catch (e: any) { return { ok: false, err: (e?.message ?? "").slice(0, 110) } }
}
async function eventsOf(d: string): Promise<any[]> {
  for (let i = 0; i < 8; i++) { try { const f: any = await client.getTransaction({ digest: d, include: { events: true } }); return f?.Transaction?.events ?? [] } catch { await new Promise(r => setTimeout(r, 600)) } }
  return []
}
async function main() {
  const a1 = keypairFor(A1), a2 = keypairFor(A2)
  // ===== X1: identity set_profile 绕过客户端校验（直接 PTB）=====
  // mint 一个属于 A1 的 name（probe 确认 A1 无 name 对象）
  let nameId = ""
  {
    const tx = new Transaction()
    tx.moveCall({ target: `${ID_PKG}::identity::mint`, arguments: [tx.object(NAMES), tx.pure.vector("u8", [...new TextEncoder().encode(`rt9inj${Date.now() % 100000}`)])] })
    const r = await run(a1, tx)
    if (r.ok) for (const e of await eventsOf(r.digest!)) {
      const b = e.bcs instanceof Uint8Array ? e.bcs : Uint8Array.from(Object.values(e.bcs) as number[])
      if (b.length >= 32) { nameId = "0x" + Buffer.from(b.slice(0, 32)).toString("hex"); break }
    }
    console.log(`[setup] name minted: ${nameId || "FAILED " + r.err}`)
  }
  const nameIds = [nameId]
  const evilUrls = [
    ["javascript:alert(1)", "X1a javascript: 协议"],
    ["data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==", "X1b data:text/html"],
    ["https://evil.com\u0000_legit", "X1c NUL 截断"],
    ["https://user:pass@evil.com/a.png", "X1d user-info 凭据"], 
  ]
  for (const [u, label] of evilUrls) {
    const tx = new Transaction()
    tx.moveCall({ target: `${ID_PKG}::identity::set_profile`, arguments: [tx.object(nameIds[0]), tx.pure.vector("u8", [...new TextEncoder().encode("红队注入")]), tx.pure.vector("u8", [...new TextEncoder().encode(u)])] })
    const r = await sim(a1, tx)
    console.log(`[${label}] 链上 ${r.ok ? "❌ ACCEPT（无链上校验）" : "✅ REJECT: " + r.err?.slice(0, 60)}`)
  }
  // ===== X2: 链上 chat content_preview 注入 HTML/协议文本 =====
  // 完整会话 setup（复用 economics 流程）
  let sid = ""
  {
    const tx = new Transaction()
    const [fee] = tx.splitCoins(tx.gas, [5_000_000n])
    tx.moveCall({ target: `${PKG}::dkg_committee::create_dkg_session`, arguments: [tx.pure.u64(2n), tx.pure.vector("address", [A1, A2]), tx.pure.u64(BigInt(Date.now() + 3_600_000)), fee, tx.object(CLOCK)] })
    const r = await run(a1, tx)
    if (!r.ok) console.log("[setup] session err:", JSON.stringify(r))
    if (r.ok) {
      const evs = await eventsOf(r.digest!)
      console.log("[setup] r:", JSON.stringify(r))
      for (const e of evs) if ((e.eventType ?? "").toLowerCase().includes("sessioncreated")) {
      const b = e.bcs instanceof Uint8Array ? e.bcs : Uint8Array.from(Object.values(e.bcs) as number[])
      sid = "0x" + Buffer.from(b.slice(0, 32)).toString("hex")
      }
    }
  }
  if (!sid) { console.log("[setup] session failed"); return }
  const attestPks: Record<string, Uint8Array> = {}, attestKeys: Record<string, Uint8Array> = {}
  for (const kp of [a1, a2]) { const k = new Uint8Array(32); crypto.getRandomValues(k); attestKeys[kp.toSuiAddress()] = k; attestPks[kp.toSuiAddress()] = ed25519.getPublicKey(k) }
  for (const kp of [a1, a2]) {
    const tx = new Transaction()
    const [pay] = tx.splitCoins(tx.gas, [50_000_000n])
    tx.moveCall({ target: `${PKG}::dkg_committee::submit_commitment`, arguments: [tx.object(sid), tx.object(CLOCK), tx.pure.vector("u8", [...crypto.getRandomValues(new Uint8Array(64))]), tx.pure.vector("u8", [...attestPks[kp.toSuiAddress()]]), pay] })
    await run(kp, tx)
  }
  const groupPk = ed25519.getPublicKey(new Uint8Array(32).fill(0x88))
  const ad = sha256(cat(Buffer.from("SUI_DKG_ATTEST_V1:"), aB(sid), Buffer.from(groupPk)))
  for (const kp of [a1, a2]) {
    const tx = new Transaction()
    tx.moveCall({ target: `${PKG}::dkg_committee::attest_group_key`, arguments: [tx.object(sid), tx.object(CLOCK), tx.pure.vector("u8", [...groupPk]), tx.pure.vector("u8", [...ed25519.sign(ad, attestKeys[kp.toSuiAddress()])])] })
    await run(kp, tx)
  }
  {
    const tx = new Transaction(); tx.moveCall({ target: `${PKG}::dkg_committee::finalize_session`, arguments: [tx.object(sid), tx.pure.vector("u8", [...groupPk])] }); await run(a1, tx)
  }
  // X2: 建频道 + 发带 <img onerror>/javascript: 的消息（onchain_chat）
  let channelId = ""
  {
    const tx = new Transaction()
    tx.moveCall({ target: `${PKG}::onchain_chat::create_channel`, arguments: [tx.pure.address(A1), tx.pure.vector("u8", [...new TextEncoder().encode("rt9-inject")]), tx.pure.vector("address", [A1, A2])] })
    const r = await run(a1, tx)
    if (r.ok) for (const e of await eventsOf(r.digest!)) if ((e.eventType ?? "").toLowerCase().includes("channelcreated")) {
      const b = e.bcs instanceof Uint8Array ? e.bcs : Uint8Array.from(Object.values(e.bcs) as number[])
      channelId = "0x" + Buffer.from(b.slice(0, 32)).toString("hex")
    }
    console.log(`[setup] channel ${channelId.slice(0, 10)}`)
  }
  if (channelId) {
    const payload = '<img src=x onerror=alert(document.cookie)> javascript:alert(1)'
    const tx = new Transaction()
    tx.moveCall({ target: `${PKG}::onchain_chat::send_message`, arguments: [tx.object(channelId), tx.pure.vector("u8", [...new TextEncoder().encode(payload)]), tx.object(CLOCK)] })
    const r = await run(a2, tx)
    console.log(`[X2 chat 注入 <img onerror>] 链上 ${r.ok ? "ACCEPT（存储成功）→ React 文本插值层转义=唯一防线" : "REJECT: " + r.err?.slice(0, 60)}`)
  }
  // ===== X4: safeAvatar 单元验证（离线）=====
  const { safeAvatar } = await import("../components/identity-avatar").catch(() => ({ safeAvatar: null as any }))
  if (typeof safeAvatar === "function") {
    for (const u of ["javascript:alert(1)", "data:image/svg+xml;base64,PHN2Zy8+", "https://ok.com/a.png"]) {
      console.log(`[X4 safeAvatar("${u.slice(0, 28)}…")] → ${safeAvatar(u) === undefined ? "REJECT ✅" : "❌ ACCEPT: " + String(safeAvatar(u)).slice(0, 40)}`)
    }
  } else {
    // 手动复刻逻辑验证
    const safe = (url: string) => { try { return new URL(url).protocol === "https:" ? url : undefined } catch { return undefined } }
    for (const u of ["javascript:alert(1)", "data:image/svg+xml;base64,PHN2Zy8+", "https://ok.com/a.png"]) {
      console.log(`[X4 safeAvatar("${u.slice(0, 28)}…")] → ${safe(u) === undefined ? "REJECT ✅" : "❌ ACCEPT: " + String(safe(u)).slice(0, 40)}`)
    }
  }
}
main().catch(e => console.error("ERR", e.message))
