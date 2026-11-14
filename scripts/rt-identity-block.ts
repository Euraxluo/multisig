import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { fromBase64 } from "@mysten/sui/utils"
import { SuiGrpcClient } from "@mysten/sui/grpc"
import { Transaction } from "@mysten/sui/transactions"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { ed25519 } from "@noble/curves/ed25519.js"
import { sha256 } from "@noble/hashes/sha2.js"
const L = 2n ** 252n + 27742317777372353535851937790883648493n
const PKG = "0x768e3781fd774bdd010089ede1c66df344aee2047817a121aa6c602e73723501"
const A1 = "0x2c6539e5802d1476dae4a7aada30265dd2568f198ecf2f184861ea7deb3f6347"
const A2 = "0x843f44a42e10a6dc701b7f60a4dedc544dc7910e971ee6a493f4d9096953e04e"
const client = new SuiGrpcClient({ network: "testnet", baseUrl: "https://fullnode.testnet.sui.io:443" })
function keypairFor(a: string) { const ks = JSON.parse(readFileSync(`${homedir()}/.sui/sui_config/sui.keystore`, "utf8")) as string[]; for (const e of ks) { const kp = Ed25519Keypair.fromSecretKey(fromBase64(e).slice(1)); if (kp.toSuiAddress() === a) return kp } throw new Error("nokey") }
const le = (v: bigint) => { const o = new Uint8Array(8); let x = v; for (let i = 0; i < 8; i++) { o[i] = Number(x & 0xffn); x >>= 8n } return o }
const vi = (xs: Uint8Array[]) => { const t = 1 + xs.reduce((a, x) => a + x.length, 0); const o = new Uint8Array(t); o[0] = xs.length; let p = 1; for (const x of xs) { o.set(x, p); p += x.length } return o }
const aB = (a: string) => Buffer.from(a.replace(/^0x/, "").padStart(64, "0"), "hex")
const cat = (...xs: Uint8Array[]) => { const l = xs.reduce((a, x) => a + x.length, 0); const o = new Uint8Array(l); let p = 0; for (const x of xs) { o.set(x, p); p += x.length } return o }
async function run(kp: any, tx: any) {
  try { tx.setSender(kp.toSuiAddress()); const bytes = await tx.build({ client } as any); const sig = await kp.signTransaction(bytes); const res: any = await client.executeTransaction({ transaction: bytes, signatures: [sig.signature] }); const t = res.Transaction ?? res.FailedTransaction; return t?.status?.success ? { ok: true } : { ok: false, err: t?.status?.error?.message?.slice(0, 100) } } catch (e: any) { return { ok: false, err: (e?.message ?? "").slice(0, 100) } }
}
async function main() {
  const a1 = keypairFor(A1)
  const identityPk = new Uint8Array(32); identityPk[0] = 0x01 // 0x0100…00 identity
  const members = [A1, A2], weights = [1n, 1n]
  const d = sha256(cat(Buffer.from("SUI_ORG_POP_V2:"), Buffer.from("sui-testnet:"), Buffer.from(identityPk), vi(members.map(aB)), vi(weights.map(le)), le(2n), le(2n)))
  // identity 点在 ed25519 标量乘下恒为 identity → 任何 sk 都给出同一点；签名语义上 noble 会拒绝 sign(identity)？直接用 raw sig 构造：s = c·0 + r ⇒ sig = (rG, r) 但链上 verify 检查 s·B = R + c·A，A=identity ⇒ s·B = R ⇒ R=s·G 成立 ✓
  const sk = new Uint8Array(32).fill(0x77)
  const cBytes = d; const c = BigInt("0x" + Buffer.from(cBytes.slice(0, 32)).toString("hex")) % L
  const r = new Uint8Array(32); crypto.getRandomValues(r); const R = ed25519.Point.BASE.multiply(BigInt("0x" + Buffer.from(r).toString("hex")) % L)
  const s = (BigInt("0x" + Buffer.from(r).toString("hex")) + c) % L
  const sBuf = Buffer.alloc(32); let x = s; for (let i = 0; i < 32; i++) { sBuf[i] = Number(x & 0xffn); x >>= 8n }
  const sig = new Uint8Array(64); const Rb = Buffer.from(typeof (R as any).toRawBytes === "function" ? (R as any).toRawBytes() : R.toBytes()); sig.set(Rb, 0); sig.set(sBuf, 32)
  // sanity: noble verify（用 identity pk 可能被 noble 拒——链上才是事实源）
  const tx = new Transaction()
  tx.moveCall({ target: `${PKG}::cryptographic_org::create_organization_entry`, arguments: [tx.pure.vector("u8", [...identityPk]), tx.pure.u64(2n), tx.pure.u64(2n), tx.pure.vector("address", members), tx.pure.vector("u64", weights), tx.pure.vector("u8", [...sig])] })
  const r1 = await run(a1, tx)
  console.log(`[identity pk 建组] ${r1.ok ? "❌ EXECUTED — 拉黑未生效" : "✅ BLOCKED: " + r1.err}`)
  // 正常 pk 对照
  const goodPk = ed25519.getPublicKey(new Uint8Array(32).fill(0x99))
  const d2 = sha256(cat(Buffer.from("SUI_ORG_POP_V2:"), Buffer.from("sui-testnet:"), Buffer.from(goodPk), vi(members.map(aB)), vi(weights.map(le)), le(2n), le(2n)))
  const sig2 = ed25519.sign(d2, new Uint8Array(32).fill(0x99))
  const tx2 = new Transaction()
  tx2.moveCall({ target: `${PKG}::cryptographic_org::create_organization_entry`, arguments: [tx2.pure.vector("u8", [...goodPk]), tx2.pure.u64(2n), tx2.pure.u64(2n), tx2.pure.vector("address", members), tx2.pure.vector("u64", weights), tx2.pure.vector("u8", [...sig2])] })
  const r2 = await run(a1, tx2)
  console.log(`[正常 pk 建组对照] ${r2.ok ? "✅ EXECUTED" : "❌ " + r2.err}`)
}
main().catch(e => console.error("ERR", e.message))
