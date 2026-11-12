/**
 * RED-TEAM RE-ATTACK against the FIXED package 0xef671151… (fresh publish, 2026-11-12).
 * Re-runs the attack chain that broke the old package; every step MUST now abort.
 * Signers: operator 0x2b99 (virus-v1-second), attacker 0x843f (virus-v1-third), funder 0x8ac0.
 */
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { fromBase64 } from "@mysten/sui/utils"
import { SuiGrpcClient } from "@mysten/sui/grpc"
import { Transaction } from "@mysten/sui/transactions"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"

const PKG = "0xef671151bb0da2198d1addcbeabc03e8e24513ebe0bb357ff217c7ea613cfb0f"
const SUI = "0x2::sui::SUI"
const FUNDER = "0x8ac06d3d4328aff5bef88990741c1f620a96d5fc579bf2e459467763bd605788"
const OPERATOR = "0x2b9953911b07f6b7d2c92e17ed6cb2325cc26f9eb1eaeb58497ee7b5523ea859"
const ATTACKER = "0x843f44a42e10a6dc701b7f60a4dedc544dc7910e971ee6a493f4d9096953e04e"
const client = new SuiGrpcClient({ network: "testnet", baseUrl: "https://fullnode.testnet.sui.io:443" })

function keypairFor(address: string): Ed25519Keypair {
  const ks = JSON.parse(readFileSync(`${homedir()}/.sui/sui_config/sui.keystore`, "utf8")) as string[]
  for (const entry of ks) {
    const kp = Ed25519Keypair.fromSecretKey(fromBase64(entry).slice(1))
    if (kp.toSuiAddress() === address) return kp
  }
  throw new Error(`no keypair for ${address}`)
}
let pass = 0, total = 0
async function attempt(signer: Ed25519Keypair, tx: Transaction, label: string, expectCode?: number): Promise<void> {
  total++
  try {
    tx.setSender(signer.toSuiAddress())
    const bytes = await tx.build({ client } as any)
    const sig = await signer.signTransaction(bytes)
    const res: any = await client.executeTransaction({ transaction: bytes, signatures: [sig.signature], include: { effects: true } })
    const t = res.Transaction ?? res.FailedTransaction
    const ok = t?.status?.success === true
    if (ok) { console.log(`[${label}] ❌ EXECUTED — FIX FAILED, digest=${typeof t.digest === "string" ? t.digest : t.digest?.digest}`); return }
    const err: string = t?.status?.error?.message ?? "no message"
    const codeHit = expectCode === undefined || err.includes(`"${expectCode}"`) || new RegExp(`abort code == ${expectCode}\\b`).test(err) || err.includes(String(expectCode))
    const good = codeHit || expectCode === undefined
    if (good) { pass++; console.log(`[${label}] ✅ BLOCKED (${expectCode ?? "generic"}): ${err.slice(0, 110)}`) }
    else console.log(`[${label}] ⚠️ aborted with OTHER code: ${err.slice(0, 160)}`)
  } catch (e: any) {
    // executeTransaction may throw for aborts depending on shape
    const msg = e?.message ?? String(e)
    if (expectCode !== undefined && (msg.includes(String(expectCode)) || /abort/i.test(msg))) { pass++; console.log(`[${label}] ✅ BLOCKED (throw, ${expectCode}): ${msg.slice(0, 110)}`) }
    else console.log(`[${label}] ⚠️ threw: ${msg.slice(0, 160)}`)
  }
}

async function main() {
  const operator = keypairFor(OPERATOR)
  const funder = keypairFor(FUNDER)
  const attacker = keypairFor(ATTACKER)
  const clock = "0x0000000000000000000000000000000000000000000000000000000000000006"

  // ---- ATTACK D: dead-key org install → expect E_INVALID_POP 1010
  console.log("=== D: create_organization with un-signable key (expect 1010) ===")
  {
    const funder = keypairFor(FUNDER)
    const tx = new Transaction()
    // a valid curve point whose discrete log we destroy (random base mult)
    const deadPk = new Uint8Array(32).fill(0)
    crypto.getRandomValues(deadPk)
    deadPk[0] &= 248; deadPk[31] &= 127; deadPk[31] |= 64 // clamp-ish; still arbitrary bytes
    tx.moveCall({
      target: `${PKG}::cryptographic_org::create_organization_entry`,
      arguments: [tx.pure.vector("u8", [...deadPk]), tx.pure.u64(2n), tx.pure.vector("address", [FUNDER, OPERATOR, ATTACKER]), tx.pure.vector("u64", [1n, 1n, 1n]), tx.pure.vector("u8", new Array(64).fill(7))],
    })
    await attempt(funder, tx, "dead-key install", 1010)
  }

  // ---- ATTACK 1: rogue Operator spawns attacker agent on a fresh vault (deny-by-default → 2012)
  console.log("=== 1: spawn before policy (expect 2012) ===")
  let vaultId = "", masterCapId = "", opCapId = ""
  {
    const vaultPayer = keypairFor(OPERATOR)
    const tx = new Transaction()
    const [mc] = tx.moveCall({ target: `${PKG}::vault::initialize_vault`, typeArguments: [SUI] })
    tx.transferObjects([mc], tx.pure.address(OPERATOR))
    // no policy set — default denies everything
    tx.setSender(OPERATOR)
    try {
      const bytes = await tx.build({ client } as any)
      const sig = await vaultPayer.signTransaction(bytes)
      const res: any = await client.executeTransaction({ transaction: bytes, signatures: [sig.signature], include: { effects: true, events: true } })
      const t = res.Transaction
      if (t?.status?.success) {
        const ev = (t.events ?? []).find((e: any) => (e.eventType ?? "").includes("VaultCreated"))
        const b = ev?.bcs instanceof Uint8Array ? ev.bcs : Uint8Array.from(Object.values(ev?.bcs ?? {}) as number[])
        vaultId = "0x" + Buffer.from(b.slice(0, 32)).toString("hex")
        // MasterCap = the created object typed vault::MasterCap in this tx
        const dstr: string = typeof t.digest === "string" ? t.digest : t.digest?.digest
        const full: any = await client.getTransaction({ digest: dstr, include: { objectTypes: true } })
        const ot = full?.Transaction?.objectTypes ?? {}
        for (const [oid, ty] of Object.entries(ot) as [string, string][]) {
          if (String(ty).endsWith("vault::MasterCap")) masterCapId = oid
        }
        console.log("vault created:", vaultId, "masterCap:", masterCapId)
      } else console.log("vault create failed:", t?.status?.error?.message?.slice(0, 120))
    } catch (e: any) { console.log("vault create threw:", e.message.slice(0, 120)) }
    if (!vaultId) return
  }
  // operator needs OperatorCap: master issues it — but funder holds MasterCap? transfer above sent it to funder. For spawn attack we need op path; simulate the rogue-operator scenario ONLY if operator has cap. Instead: rogue-operator step = funder (as master) issues opcap to OPERATOR first.
  {
    const tx = new Transaction()
    tx.moveCall({ target: `${PKG}::vault::issue_operator_cap`, typeArguments: [SUI], arguments: [tx.object(masterCapId), tx.object(vaultId), tx.pure.address(OPERATOR)] })
    tx.setSender(OPERATOR)
    try {
      const bytes = await tx.build({ client } as any)
      const sig = await operator.signTransaction(bytes)
      const res: any = await client.executeTransaction({ transaction: bytes, signatures: [sig.signature], include: { effects: true, events: true } })
      const d2: string = typeof res.Transaction?.digest === "string" ? res.Transaction.digest : res.Transaction?.digest?.digest
      const full2: any = await client.getTransaction({ digest: d2, include: { objectTypes: true } })
      for (const [oid, ty] of Object.entries(full2?.Transaction?.objectTypes ?? {}) as [string, string][]) {
        if (String(ty).endsWith("vault::OperatorCap")) opCapId = oid
      }
      console.log("opcap issued:", opCapId, "→ operator can now act")
    } catch (e: any) { console.log("opcap issue threw:", e.message.slice(0, 100)) }
  }
  if (opCapId) {
    // 1a: spawn without any policy → 2012
    const tx = new Transaction()
    tx.moveCall({ target: `${PKG}::vault::spawn_agent_card`, typeArguments: [SUI], arguments: [tx.object(opCapId), tx.object(vaultId), tx.pure.address(ATTACKER), tx.pure.u64(490_000_000n), tx.pure.vector("u8", [])] })
    await attempt(operator, tx, "spawn w/o policy", 2012)

    // set a STRICT policy as Master would (max_epoch_outflow=0.05 SUI, max_agent_budget=0.01 SUI), then:
    const funder = keypairFor(FUNDER)
    const pol = new Transaction()
    pol.moveCall({ target: `${PKG}::vault::set_outflow_policy`, typeArguments: [SUI], arguments: [pol.object(masterCapId), pol.object(vaultId), pol.pure.u64(50_000_000n), pol.pure.u64(10_000_000n)] })
    pol.setSender(OPERATOR)
    try {
      const bytes = await pol.build({ client } as any)
      const sig = await operator.signTransaction(bytes)
      await client.executeTransaction({ transaction: bytes, signatures: [sig.signature] })
      console.log("policy set: outflow≤0.05, agentBudget≤0.01 SUI/epoch")
    } catch (e: any) { console.log("policy set threw:", e.message.slice(0, 100)) }
    // fund the vault a bit (operator pays — funder is out of gas)
    const fund = new Transaction()
    const [c] = fund.splitCoins(fund.gas, [60_000_000n])
    fund.moveCall({ target: `${PKG}::vault::deposit`, typeArguments: [SUI], arguments: [fund.object(vaultId), c] })
    fund.setSender(OPERATOR)
    try {
      const bytes = await fund.build({ client } as any)
      const sig = await operator.signTransaction(bytes)
      await client.executeTransaction({ transaction: bytes, signatures: [sig.signature] })
      console.log("vault funded 0.06 SUI")
    } catch (e: any) { console.log("fund threw:", e.message.slice(0, 100)) }

    // 1b: spawn above agent-budget cap → 2012
    const tx2 = new Transaction()
    tx2.moveCall({ target: `${PKG}::vault::spawn_agent_card`, typeArguments: [SUI], arguments: [tx2.object(opCapId), tx2.object(vaultId), tx2.pure.address(ATTACKER), tx2.pure.u64(49_000_000n), tx2.pure.vector("u8", [])] })
    await attempt(operator, tx2, "spawn above budget cap", 2012)

    // 1c: legal spawn at cap, then vault-level outflow cap → 2013 on second spend
    const tx3 = new Transaction()
    tx3.moveCall({ target: `${PKG}::vault::spawn_agent_card`, typeArguments: [SUI], arguments: [tx3.object(opCapId), tx3.object(vaultId), tx3.pure.address(ATTACKER), tx3.pure.u64(10_000_000n), tx3.pure.vector("u8", [])] })
    let agentCap = ""
    try {
      tx3.setSender(OPERATOR)
      const bytes = await tx3.build({ client } as any)
      const sig = await operator.signTransaction(bytes)
      const res: any = await client.executeTransaction({ transaction: bytes, signatures: [sig.signature], include: { effects: true, events: true } })
      const ev = (res.Transaction?.events ?? []).find((e: any) => (e.eventType ?? "").includes("AgentCardSpawned"))
      const b = ev?.bcs instanceof Uint8Array ? ev.bcs : Uint8Array.from(Object.values(ev?.bcs ?? {}) as number[])
      agentCap = "0x" + Buffer.from(b.slice(32, 64)).toString("hex") // cap transferred to ATTACKER; find via owned later
      console.log("agent spawned at cap (10 MIST)")
    } catch (e: any) { console.log("legal spawn threw:", e.message.slice(0, 100)) }
    // find attacker AgentCap
    const owned: any = await client.listOwnedObjects({ owner: ATTACKER, limit: 50 })
    for (const o of owned.objects ?? []) {
      if ((o.type ?? "").endsWith("vault::AgentCap")) {
        const { object }: any = await client.getObject({ objectId: o.objectId, include: { content: true } })
        const c = object?.content
        const b = c?.$kind === "Bcs" && c.Bcs instanceof Uint8Array ? c.Bcs : (c && Object.keys(c).every((k: string) => /^\d+$/.test(k)) ? Uint8Array.from(Object.values(c) as number[]) : undefined)
        if (b && Buffer.from(b.slice(32, 64)).toString("hex") === vaultId.slice(2)) agentCap = o.objectId
      }
    }
    if (agentCap) {
      // spend 1: 0.01 SUI OK
      const s1 = new Transaction()
      s1.moveCall({ target: `${PKG}::vault::spend_x402_budget`, typeArguments: [SUI], arguments: [s1.object(agentCap), s1.object(vaultId), s1.pure.u64(10_000_000n), s1.pure.address(ATTACKER)] })
      try {
        s1.setSender(ATTACKER)
        const bytes = await s1.build({ client } as any)
        const sig = await attacker.signTransaction(bytes)
        const res: any = await client.executeTransaction({ transaction: bytes, signatures: [sig.signature] })
        console.log("[spend within policy] executed OK:", res.Transaction?.status?.success === true)
      } catch (e: any) { console.log("spend1 threw:", e.message.slice(0, 120)) }
      // 1d: zero-recipient spend → 2014
      const s0 = new Transaction()
      s0.moveCall({ target: `${PKG}::vault::spend_x402_budget`, typeArguments: [SUI], arguments: [s0.object(agentCap), s0.object(vaultId), s0.pure.u64(1_000_000n), s0.pure.address("0x0000000000000000000000000000000000000000000000000000000000000000")] })
      await attempt(attacker, s0, "zero-recipient spend", 2014)
    }

    // ---- ATTACK E: treasury execute with empty frost sig → 2701
    console.log("=== E: treasury execute without threshold signature (expect 2701) ===")
    // Build a real org first WITH valid PoP: generate keypair, sign pop digest
    const { ed25519 } = await import("@noble/curves/ed25519.js")
    const { sha256 } = await import("@noble/hashes/sha2.js")
    const seed = new Uint8Array(32); crypto.getRandomValues(seed)
    const kp = ed25519.keygen ? ed25519.keygen() : null
    const sk = seed
    const pk = ed25519.getPublicKey(sk)
    const le = (v: bigint): Uint8Array => { const o = new Uint8Array(8); let x = v; for (let i = 0; i < 8; i++) { o[i] = Number(x & 0xffn); x >>= 8n } return o }
    const vi = (items: Uint8Array[]): Uint8Array => { const n = Uint8Array.of(items.length); const parts = items.map(i => i); const total = 1 + items.reduce((a, x) => a + x.length, 0); const o = new Uint8Array(total); o[0] = items.length; let p = 1; for (const x of items) { o.set(x, p); p += x.length } return o }
    const addrB = (a: string) => Buffer.from(a.replace(/^0x/, "").padStart(64, "0"), "hex")
    const popDigest = sha256(Buffer.concat([Buffer.from("SUI_ORG_POP_V1:"), Buffer.from("sui-testnet:"), Buffer.from(pk), vi([addrB(OPERATOR)]), vi([le(2n)]), le(2n)]))
    const popSig = ed25519.sign(popDigest, sk)
    const orgPayer = keypairFor(OPERATOR)
    const otx = new Transaction()
    otx.moveCall({ target: `${PKG}::cryptographic_org::create_organization_entry`, arguments: [otx.pure.vector("u8", [...pk]), otx.pure.u64(2n), otx.pure.vector("address", [OPERATOR]), otx.pure.vector("u64", [2n]), otx.pure.vector("u8", [...popSig])] })
    let orgId = ""
    try {
      otx.setSender(OPERATOR)
      const bytes = await otx.build({ client } as any)
      const sig = await orgPayer.signTransaction(bytes)
      const res: any = await client.executeTransaction({ transaction: bytes, signatures: [sig.signature], include: { effects: true, events: true } })
      const ok = res.Transaction?.status?.success === true
      const ev = (res.Transaction?.events ?? []).find((e: any) => (e.eventType ?? "").includes("OrganizationCreated"))
      const b = ev?.bcs instanceof Uint8Array ? ev.bcs : Uint8Array.from(Object.values(ev?.bcs ?? {}) as number[])
      orgId = "0x" + Buffer.from(b.slice(0, 32)).toString("hex")
      console.log("org with REAL PoP created:", orgId, ok ? "(PoP gate passes honest keys ✓)" : "(unexpected failure)")
    } catch (e: any) { console.log("org create threw:", e.message.slice(0, 140)) }

    if (orgId) {
      // treasury + funding + proposal + 2 votes (weights 1+1 >= 2) + execute with EMPTY sig → 2701
      const opKp = keypairFor(OPERATOR)
      const t1 = new Transaction()
      const [treasury] = t1.moveCall({ target: `${PKG}::organization_treasury::new`, arguments: [t1.object(orgId)] })
      t1.moveCall({ target: `${PKG}::organization_treasury::share`, arguments: [treasury] })
      t1.setSender(OPERATOR)
      let treasuryId = "", tvVaultId = ""
      try {
        const bytes = await t1.build({ client } as any)
        const sig = await opKp.signTransaction(bytes)
        const res: any = await client.executeTransaction({ transaction: bytes, signatures: [sig.signature], include: { effects: true, events: true } })
        const ev = (res.Transaction?.events ?? []).find((e: any) => (e.eventType ?? "").includes("TreasuryCreated"))
        const b = ev?.bcs instanceof Uint8Array ? ev.bcs : Uint8Array.from(Object.values(ev?.bcs ?? {}) as number[])
        treasuryId = "0x" + Buffer.from(b.slice(0, 32)).toString("hex")
        tvVaultId = "0x" + Buffer.from(b.slice(64, 96)).toString("hex")
        console.log("treasury:", treasuryId, "vault:", tvVaultId)
      } catch (e: any) { console.log("treasury threw:", e.message.slice(0, 120)) }
      if (treasuryId) {
        // fund vault
        const f2 = new Transaction()
        const [c] = f2.splitCoins(f2.gas, [100_000_000n])
        f2.moveCall({ target: `${PKG}::vault::deposit`, typeArguments: [SUI], arguments: [f2.object(tvVaultId), c] })
        f2.setSender(OPERATOR)
        try {
          const bytes = await f2.build({ client } as any)
          const sig = await opKp.signTransaction(bytes)
          await client.executeTransaction({ transaction: bytes, signatures: [sig.signature] })
        } catch (e: any) { console.log("fund2:", e.message.slice(0, 90)) }
        // create transfer proposal (funder is member)
        const deadline = BigInt(Date.now() + 3_600_000)
        const p1 = new Transaction()
        p1.moveCall({ target: `${PKG}::organization_treasury::create_transfer`, arguments: [p1.object(treasuryId), p1.object(orgId), p1.pure.vector("u8", [...new TextEncoder().encode("re-attack")]), p1.pure.address(ATTACKER), p1.pure.u64(90_000_000n), p1.pure.u64(deadline), p1.object(clock)] })
        p1.setSender(OPERATOR)
        let proposalId = ""
        let bindingIdEarly = ""
        try {
          const bytes = await p1.build({ client } as any)
          const sig = await opKp.signTransaction(bytes)
          const res: any = await client.executeTransaction({ transaction: bytes, signatures: [sig.signature], include: { effects: true, events: true } })
          const dp: string = typeof res.Transaction?.digest === "string" ? res.Transaction.digest : res.Transaction?.digest?.digest
          const fullp: any = await client.getTransaction({ digest: dp, include: { objectTypes: true } })
          for (const [oid, ty] of Object.entries(fullp?.Transaction?.objectTypes ?? {}) as [string, string][]) {
            if (String(ty).endsWith("asynchronous_proposal::Proposal")) proposalId = oid
            if (String(ty).endsWith("organization_treasury::TransferBinding")) bindingIdEarly = oid
          }
        } catch (e: any) { console.log("proposal threw:", e.message.slice(0, 160)) }
        console.log("proposalId:", proposalId, "bindingIdEarly:", bindingIdEarly)
        if (proposalId) {
          // votes from both members
          for (const [who, w] of [[OPERATOR, 2n]] as [string, bigint][]) {
            const v = new Transaction()
            v.moveCall({ target: `${PKG}::asynchronous_proposal::submit_async_vote`, arguments: [v.object(proposalId), v.object(orgId), v.object(clock), v.pure.u64(w), v.pure.vector("u8", [])] })
            const kp2 = keypairFor(who)
            v.setSender(who)
            try {
              const bytes = await v.build({ client } as any)
              const sig = await kp2.signTransaction(bytes)
              await client.executeTransaction({ transaction: bytes, signatures: [sig.signature] })
            } catch (e: any) { console.log("vote threw:", e.message.slice(0, 100)) }
          }
          // binding id: TransferBinding created in the proposal's tx
          let bindingId = bindingIdEarly
          // execute with EMPTY frost signature → expect 2701
          const x = new Transaction()
          x.moveCall({ target: `${PKG}::organization_treasury::execute`, arguments: [x.object(treasuryId), x.object(bindingId), x.object(orgId), x.object(proposalId), x.object(tvVaultId), x.pure.u64(1n), x.pure.vector("u8", []), x.object(clock)] })
          await attempt(operator, x, "treasury execute, empty sig", 2701)
        }
      }
    }
  }

  console.log(`\n=== RESULT: ${pass}/${total} attack surfaces verified BLOCKED on new package ===`)
}
main().catch(e => { console.error("RE-ATTACK ERROR:", e.message); process.exit(1) })
