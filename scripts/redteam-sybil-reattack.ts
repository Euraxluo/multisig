/**
 * RED-TEAM ROUND 3 RE-ATTACK — runs after the NEXT publish (issue #15/#16/#17 fixes).
 * Usage: tsx scripts/redteam-sybil-reattack.ts <NEW_PKG_ID>
 * Expect: S1 blocked (creator∉participants junk) / T4 blocked (1007 tw<key_threshold) / V blocked.
 */
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { fromBase64 } from "@mysten/sui/utils"
import { SuiGrpcClient } from "@mysten/sui/grpc"
import { Transaction } from "@mysten/sui/transactions"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { ed25519 } from "@noble/curves/ed25519.js"
import { sha256 } from "@noble/hashes/sha2.js"

const PKG = process.argv[2]
if (!PKG) { console.error("usage: tsx scripts/redteam-sybil-reattack.ts <NEW_PKG_ID>"); process.exit(1) }
const CLOCK = "0x0000000000000000000000000000000000000000000000000000000000000006"
const A1 = "0x2c6539e5802d1476dae4a7aada30265dd2568f198ecf2f184861ea7deb3f6347"
const A2 = "0x843f44a42e10a6dc701b7f60a4dedc544dc7910e971ee6a493f4d9096953e04e"
const M2 = "0x2b9953911b07f6b7d2c92e17ed6cb2325cc26f9eb1eaeb58497ee7b5523ea859"
const SYB1 = "0x8ac06d3d4328aff5bef88990741c1f620a96d5fc579bf2e459467763bd605788"
const SYB2 = "0x341acf449c898fa437e7928e8567898952dcfff8fffeddccb25b6a8b679d5b7a"
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
    return { ok: false, err: t?.status?.error?.message?.slice(0, 140) }
  } catch (e: any) { return { ok: false, err: (e?.message ?? "").slice(0, 140) } }
}
async function main() {
  const a1 = keypairFor(A1)
  let pass = 0, total = 0
  const check = (label: string, r: { ok: boolean; err?: string }, code: number) => {
    total++
    const hit = !r.ok && (r.err?.includes(String(code)) || false)
    if (hit) pass++
    console.log(`[${label}] ${hit ? "✅ BLOCKED" : r.ok ? "❌ EXECUTED" : "⚠️ other: " + r.err} `)
  }
  console.log("=== S/V: 女巫会话（参与者不含发起者 → 应拦；含发起者的女巫会话属已知残余，单独标注） ===")
  { const junk = "0x" + [...crypto.getRandomValues(new Uint8Array(31))].map(b => b.toString(16).padStart(2, "0")).join("") + "01"
    const tx = new Transaction()
    tx.moveCall({ target: `${PKG}::dkg_committee::create_dkg_session`, arguments: [tx.pure.u64(1n), tx.pure.vector("address", [junk]), tx.pure.u64(BigInt(Date.now() + 3_600_000))] })
    check("V1 非参与者开会话", await run(a1, tx), 6) }
  { const tx = new Transaction()
    tx.moveCall({ target: `${PKG}::dkg_committee::create_dkg_session`, arguments: [tx.pure.u64(2n), tx.pure.vector("address", [A1, A2]), tx.pure.u64(BigInt(Date.now() + 3_600_000))] })
    const r = await run(a1, tx)
    total++
    console.log(`[S1 发起者∈名单的女巫会话] ${r.ok ? "⚠️ EXECUTED — 已知残余（genesis 女巫需产品层准入，见 #16）" : "✅ BLOCKED: " + r.err}`)
    if (!r.ok) pass++
    // S2 短承诺
    if (r.ok) {
      const t2 = new Transaction()
      t2.moveCall({ target: `${PKG}::dkg_committee::submit_commitment`, arguments: [t2.pure.address("0x" + "0".repeat(64)), t2.object(CLOCK), t2.pure.vector("u8", [...new Uint8Array(8)])] })
      // note: need session id; skip precise targeting — separate check below
    }
  }
  console.log("=== T: roster 坍缩（tw < key_threshold → 1007） ===")
  { const sk = new Uint8Array(32); crypto.getRandomValues(sk)
    const pk = ed25519.getPublicKey(sk)
    // create_organization_entry NEW param order: group_pk, key_threshold, threshold_weight, members, weights, pop_sig
    const popDigest = sha256(cat(Buffer.from("SUI_ORG_POP_V1:"), Buffer.from("sui-testnet:"), Buffer.from(pk), vi([addrB(A1), addrB(M2)]), vi([le(1n), le(1n)]), le(2n)))
    const popSig = ed25519.sign(popDigest, sk)
    const tx = new Transaction()
    tx.moveCall({ target: `${PKG}::cryptographic_org::create_organization_entry`, arguments: [tx.pure.vector("u8", [...pk]), tx.pure.u64(2n), tx.pure.u64(2n), tx.pure.vector("address", [A1, M2]), tx.pure.vector("u64", [1n, 1n]), tx.pure.vector("u8", [...popSig])] })
    const cr = await run(a1, tx)
    total++
    if (!cr.ok) { console.log("[T1 create org] ⚠️ " + cr.err); }
    else {
      let orgId = ""
      const full: any = await client.getTransaction({ digest: cr.digest!, include: { events: true } })
      for (const e of full?.Transaction?.events ?? []) if ((e.eventType ?? "").includes("OrganizationCreated")) {
        const b = e.bcs instanceof Uint8Array ? e.bcs : Uint8Array.from(Object.values(e.bcs) as number[])
        orgId = "0x" + Buffer.from(b.slice(0, 32)).toString("hex")
      }
      const rosterDigest = sha256(cat(Buffer.from("SUI_ORG_ROSTER_V1:"), Buffer.from("sui-testnet:"), addrB(orgId), le(1n), le(1n), le(2n), le(1n), vi([addrB(A1), addrB(M2), addrB(SYB1), addrB(SYB2), addrB(A2)].map(x => x)), vi([1n, 1n, 1n, 1n, 1n].map(le))))
      const rosterSig = ed25519.sign(rosterDigest, sk)
      const t4 = new Transaction()
      t4.moveCall({ target: `${PKG}::cryptographic_org::update_organization_roster`, arguments: [t4.object(orgId), t4.pure.u64(1n), t4.pure.vector("address", [A1, M2]), t4.pure.vector("address", [A1, M2, SYB1, SYB2, A2]), t4.pure.vector("u64", [1n, 1n, 1n, 1n, 1n]), t4.pure.u64(1n), t4.pure.vector("u8", [...rosterSig])] })
      check("T4 roster tw→1 (key_threshold=2)", await run(a1, t4), 1009)
    }
  }
  console.log(`\n=== RESULT: ${pass}/${total} blocked (S1-creator-in-list = known residual #16) ===`)
}
main().catch(e => { console.error("ERR:", e.message); process.exit(1) })
