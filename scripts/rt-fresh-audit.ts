/**
 * FRESH-EYES RED-TEAM vs package 0x827268c4… — final consolidated run (2026-11-13).
 *
 * Findings tested (static analysis of all 12 modules + SDK dkg/*):
 *  [A] asset_custody::take_asset proposer gate (EBorrowerMismatch @519) — non-proposer
 *      relayer take must abort (21). Proposer's own mid-borrow use of the borrowed
 *      object is accepted residual #12 (asset-level borrow) — demo only.
 *  [C] SubagentCoSignCap.voter_weight pinned to live roster weight → any weight
 *      change bricks outstanding caps (4010); a refreshed cap alone reaches the
 *      proposal's snapshotted threshold (single delegated vote, master never signs).
 *  [B] onchain_chat MemberStakeReceipt (key+store = transferable) can only be
 *      redeemed by receipt.member — creator probe must abort (6012).
 *  [S1] dead-key org install → 1010.  [S2] treasury execute, empty FROST sig → 2701.
 *  [P1] resharing epoch=1 → 3002.     [P2] creator not participant → 3001.
 *
 * Abort-expecting calls fail at dev-inspect (build) — no gas. Success txs are
 * funded by ATTACKER. Recovery step first: sweep vault deposits from earlier
 * iteration runs back out of A1's MasterCaps.
 */
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { fromBase64 } from "@mysten/sui/utils"
import { SuiGrpcClient } from "@mysten/sui/grpc"
import { Transaction } from "@mysten/sui/transactions"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { ed25519 } from "@noble/curves/ed25519.js"
import { sha256 } from "@noble/hashes/sha2.js"

const PKG = "0x827268c43588a928fc24ce48dee65ab2f89af54d0481e8060a83b54c1ea325e5"
const SUI = "0x2::sui::SUI"
const MASTERCAP_T = `${PKG}::vault::MasterCap`
const A1 = "0x2c6539e5802d1476dae4a7aada30265dd2568f198ecf2f184861ea7deb3f6347"
const ATTACKER = "0x843f44a42e10a6dc701b7f60a4dedc544dc7910e971ee6a493f4d9096953e04e"
const CLOCK = "0x0000000000000000000000000000000000000000000000000000000000000006"
const ZERO = "0x0000000000000000000000000000000000000000000000000000000000000000"
const CHAIN = Buffer.from("sui-testnet:")
const client = new SuiGrpcClient({ network: "testnet", baseUrl: "https://fullnode.testnet.sui.io:443" } as any)

function keypairFor(address: string): Ed25519Keypair {
  const ks = JSON.parse(readFileSync(`${homedir()}/.sui/sui_config/sui.keystore`, "utf8")) as string[]
  for (const entry of ks) {
    const kp = Ed25519Keypair.fromSecretKey(fromBase64(entry).slice(1))
    if (kp.toSuiAddress() === address) return kp
  }
  throw new Error(`no keypair for ${address}`)
}
const bcsBytes = (ev: unknown): Uint8Array => {
  const e = ev as { bcs?: Uint8Array | Record<string, number> }
  if (e?.bcs instanceof Uint8Array) return e.bcs
  if (e?.bcs && Object.values(e.bcs).every((v) => typeof v === "number")) return Uint8Array.from(Object.values(e.bcs) as number[])
  return new Uint8Array()
}
const hex = (u: Uint8Array, s = 0, e = 32) => "0x" + Buffer.from(u.slice(s, e)).toString("hex")
const le = (v: bigint): Uint8Array => { const o = new Uint8Array(8); let x = v; for (let i = 0; i < 8; i++) { o[i] = Number(x & 0xffn); x >>= 8n } return o }
const vecB = (items: Uint8Array[]): Uint8Array => { const total = 1 + items.reduce((a, x) => a + x.length, 0); const o = new Uint8Array(total); o[0] = items.length; let p = 1; for (const x of items) { o.set(x, p); p += x.length } return o }
const addrB = (a: string) => Buffer.from(a.replace(/^0x/, "").padStart(64, "0"), "hex")

interface ExecResult { ok: boolean; t: Record<string, any>; digest: string }
async function exec(signer: Ed25519Keypair, tx: Transaction, label: string): Promise<ExecResult> {
  tx.setSender(signer.toSuiAddress())
  const bytes = await tx.build({ client } as any)
  const sig = await signer.signTransaction(bytes)
  const res: any = await client.executeTransaction({ transaction: bytes, signatures: [sig.signature], include: { effects: true, events: true, objectTypes: true } })
  const t = res.Transaction ?? res.FailedTransaction
  const ok = t?.status?.success === true
  const digest: string = typeof t?.digest === "string" ? t.digest : t?.digest?.digest
  console.log(`[${label}] ${ok ? "EXECUTED" : "ABORTED"} digest=${digest}${ok ? "" : " :: " + (t?.status?.error?.message ?? "").slice(0, 130)}`)
  return { ok, t, digest }
}
// Abort-expecting: dev-inspect fails during build() → throws → FREE (no submission).
async function expectAbort(signer: Ed25519Keypair, tx: Transaction, label: string, code: number): Promise<boolean> {
  try {
    const r = await exec(signer, tx, label)
    if (r.ok) { console.log(`  ❌ ${label}: EXPECTED abort ${code}, but EXECUTED — VULNERABLE`); return false }
    const err: string = r.t?.status?.error?.message ?? ""
    console.log(`  ⚠️ ${label}: submitted but aborted: ${err.slice(0, 110)}`)
    return err.includes(String(code))
  } catch (e) {
    const m = (e as Error)?.message ?? ""
    const hit = m.includes(`'`) && m.includes("MoveAbort") ? true : m.includes(String(code))
    console.log(`  ${hit ? "✅" : "⚠️"} ${label}: blocked at simulation (${code}): ${m.slice(0, 130)}`)
    return hit
  }
}
async function vaultBalanceOf(id: string): Promise<string> {
  const { object }: any = await client.getObject({ objectId: id, include: { content: true } })
  const raw = object?.content?.Bcs ?? object?.content
  const bytes = raw instanceof Uint8Array ? raw : (raw && Object.values(raw).every((v: unknown) => typeof v === "number") ? Uint8Array.from(Object.values(raw) as number[]) : undefined)
  return bytes ? String(bytes.length) : "?" // AgentVault BCS layout varies; report raw len only on demand
}
async function masterCapsOf(owner: string): Promise<{ capId: string; vaultId: string }[]> {
  const owned: any = await client.listOwnedObjects({ owner, limit: 50 })
  const out: { capId: string; vaultId: string }[] = []
  for (const o of owned.objects ?? []) {
    if (!String(o.type ?? "").endsWith("vault::MasterCap")) continue
    const { object }: any = await client.getObject({ objectId: o.objectId, include: { content: true } })
    const raw = object?.content?.Bcs ?? object?.content
    const bytes = raw instanceof Uint8Array ? raw : (raw && Object.values(raw).every((v: unknown) => typeof v === "number") ? Uint8Array.from(Object.values(raw) as number[]) : undefined)
    if (bytes && bytes.length >= 64) out.push({ capId: o.objectId, vaultId: hex(bytes, 32, 64) })
  }
  return out
}
const rosterDigest = (orgId: string, epoch: bigint, nonce: bigint, newEpoch: bigint, thr: bigint, members: string[], weights: bigint[]) =>
  sha256(Buffer.concat([Buffer.from("SUI_ORG_ROSTER_V1:"), CHAIN, addrB(orgId), le(epoch), le(nonce), le(newEpoch), le(thr), vecB(members.map(addrB)), vecB(weights.map(le))]))

let blocked = 0, ran = 0
const mark = (label: string, ok: boolean) => { ran++; if (ok) blocked++; console.log(`  ==> ${label}: ${ok ? "BLOCKED ✓" : "NOT BLOCKED ✗"}`) }

async function main() {
  const a1 = keypairFor(A1)
  const att = keypairFor(ATTACKER)
  const deadline = BigInt(Date.now() + 7_200_000)

  // ============ RECOVERY: sweep locked vault deposits from iteration runs ============
  console.log("=== RECOVERY: sweep earlier iteration vaults via A1-held MasterCaps ===")
  const caps = await masterCapsOf(A1)
  console.log("A1 MasterCaps:", caps.map((c) => c.capId.slice(0, 10) + "→" + c.vaultId.slice(0, 10)).join(", ") || "none")
  if (caps.length) {
    // transfer all caps to ATTACKER in one tx (A1's remaining gas), purge from ATTACKER
    const t0 = new Transaction()
    t0.transferObjects(caps.map((c) => t0.object(c.capId)), t0.pure.address(ATTACKER))
    const r0 = await exec(a1, t0, "A1 transfers MasterCaps → ATTACKER")
    if (r0.ok) {
      for (const c of caps) {
        const p = new Transaction()
        p.moveCall({ target: `${PKG}::vault::emergency_unilateral_purge`, typeArguments: [SUI], arguments: [p.object(c.capId), p.object(c.vaultId), p.pure.address(ATTACKER)] })
        await exec(att, p, `purge ${c.vaultId.slice(0, 8)}`)
      }
    }
  }

  // ============ SETUP: single-member org, ATTACKER w2, threshold 2 ============
  console.log("\n=== SETUP: org (ATTACKER w2, threshold 2, key_threshold 1, real PoP) ===")
  const sk = new Uint8Array(32); crypto.getRandomValues(sk)
  const pk = ed25519.getPublicKey(sk)
  const popDigest = sha256(Buffer.concat([Buffer.from("SUI_ORG_POP_V1:"), CHAIN, Buffer.from(pk), vecB([addrB(ATTACKER)]), vecB([le(2n)]), le(2n)]))
  const popSig = ed25519.sign(popDigest, sk)
  {
    const tx = new Transaction()
    tx.moveCall({
      target: `${PKG}::cryptographic_org::create_organization_entry`,
      arguments: [tx.pure.vector("u8", [...pk]), tx.pure.u64(1n), tx.pure.u64(2n), tx.pure.vector("address", [ATTACKER]), tx.pure.vector("u64", [2n]), tx.pure.vector("u8", [...popSig])],
    })
    const r = await exec(att, tx, "create org")
    if (!r.ok) return
    const ev = (r.t?.events ?? []).find((e: any) => (e.eventType ?? "").endsWith("OrganizationCreatedEvent"))
    const org = hex(bcsBytes(ev))
    await runAttacks(org, sk)
  }

  async function runAttacks(org: string, groupSk: Uint8Array) {
    // ============ ATTACK A ============
    console.log("\n=== ATTACK A: custody take_asset proposer gate + residual #12 demo ===")
    let custodyId = "", capProposalId = "", vaultId = "", capId = ""
    {
      const tx = new Transaction()
      const [mc] = tx.moveCall({ target: `${PKG}::vault::initialize_vault`, typeArguments: [SUI] })
      tx.transferObjects([mc], tx.pure.address(ATTACKER))
      const r = await exec(att, tx, "vault")
      if (!r.ok) return
      const full: any = await client.getTransaction({ digest: r.digest, include: { events: true, objectTypes: true } })
      vaultId = hex(bcsBytes((full.Transaction?.events ?? []).find((e: any) => (e.eventType ?? "").endsWith("VaultCreatedEvent"))))
      for (const [oid, ty] of Object.entries(full?.Transaction?.objectTypes ?? {}) as [string, string][]) {
        if (!String(ty).endsWith("vault::MasterCap")) continue
        const { object }: any = await client.getObject({ objectId: oid, include: { content: true } })
        const raw = object?.content?.Bcs ?? object?.content
        const bytes = raw instanceof Uint8Array ? raw : (raw && Object.values(raw).every((v: unknown) => typeof v === "number") ? Uint8Array.from(Object.values(raw) as number[]) : undefined)
        if (bytes && hex(bytes, 32, 64) === vaultId) capId = oid
      }
      console.log("vault:", vaultId, "cap:", capId)
      const t3 = new Transaction()
      const [c] = t3.splitCoins(t3.gas, [2_000_000n])
      t3.moveCall({ target: `${PKG}::vault::deposit`, typeArguments: [SUI], arguments: [t3.object(vaultId), c] })
      await exec(att, t3, "fund vault 0.002 SUI")

      const t4 = new Transaction()
      const [cust] = t4.moveCall({ target: `${PKG}::asset_custody::new`, arguments: [t4.object(org)] })
      t4.moveCall({ target: `${PKG}::asset_custody::deposit`, typeArguments: [MASTERCAP_T], arguments: [cust, t4.object(org), t4.object(capId), t4.object(CLOCK)] })
      t4.moveCall({ target: `${PKG}::asset_custody::share`, arguments: [cust] })
      const r4 = await exec(att, t4, "custody + deposit MasterCap")
      if (!r4.ok) return
      custodyId = hex(bcsBytes((r4.t?.events ?? []).find((e: any) => (e.eventType ?? "").endsWith("AssetCustodyCreated"))))

      const t5 = new Transaction()
      t5.moveCall({
        target: `${PKG}::asset_custody::create_proposal`, typeArguments: [MASTERCAP_T],
        arguments: [t5.object(custodyId), t5.object(org), t5.pure.u8(1), t5.pure.vector("u8", [...new TextEncoder().encode("borrow")]), t5.pure.u64(0n), t5.pure.address(ZERO), t5.pure.u64(deadline), t5.object(CLOCK)],
      })
      const r5 = await exec(att, t5, "borrow proposal (proposer=ATTACKER)")
      if (!r5.ok) return
      capProposalId = hex(bcsBytes((r5.t?.events ?? []).find((e: any) => (e.eventType ?? "").endsWith("CustodyProposalCreated"))))

      const v = new Transaction()
      v.moveCall({ target: `${PKG}::asset_custody::submit_vote`, arguments: [v.object(capProposalId), v.object(org), v.object(CLOCK), v.pure.u64(2n)] })
      await exec(att, v, "vote (w2 = threshold)")

      // A1 (non-proposer) relays take → purge → return: MUST abort 21
      const dr = new Transaction()
      const [capVal, receipt] = dr.moveCall({
        target: `${PKG}::asset_custody::take_asset`, typeArguments: [MASTERCAP_T],
        arguments: [dr.object(custodyId), dr.object(capProposalId), dr.object(org), dr.object(CLOCK)],
      })
      dr.moveCall({ target: `${PKG}::vault::emergency_unilateral_purge`, typeArguments: [SUI], arguments: [capVal, dr.object(vaultId), dr.pure.address(A1)] })
      dr.moveCall({ target: `${PKG}::asset_custody::return_asset`, typeArguments: [MASTERCAP_T], arguments: [dr.object(custodyId), capVal, receipt] })
      mark("A1 relayer take_asset", await expectAbort(a1, dr, "relayer take (non-proposer)", 21))

      // proposer path — residual #12 demo: mid-borrow purge spends the vault
      const dp = new Transaction()
      const [capVal2, receipt2] = dp.moveCall({
        target: `${PKG}::asset_custody::take_asset`, typeArguments: [MASTERCAP_T],
        arguments: [dp.object(custodyId), dp.object(capProposalId), dp.object(org), dp.object(CLOCK)],
      })
      dp.moveCall({ target: `${PKG}::vault::emergency_unilateral_purge`, typeArguments: [SUI], arguments: [capVal2, dp.object(vaultId), dp.pure.address(ATTACKER)] })
      dp.moveCall({ target: `${PKG}::asset_custody::return_asset`, typeArguments: [MASTERCAP_T], arguments: [dp.object(custodyId), capVal2, receipt2] })
      const rDrain = await exec(att, dp, "proposer take→purge(0.002)→return [residual #12]")
      if (rDrain.ok) console.log("  → residual #12 live: borrowed cap spent vault mid-PTB; custody slot restored")

      const t6 = new Transaction()
      t6.moveCall({ target: `${PKG}::asset_custody::take_asset`, typeArguments: [MASTERCAP_T], arguments: [t6.object(custodyId), t6.object(capProposalId), t6.object(org), t6.object(CLOCK)] })
      mark("single-use re-take", await expectAbort(att, t6, "re-take after execution", 4))
    }

    // ============ SANITY S2 ============
    console.log("\n=== SANITY S2: treasury execute, empty FROST sig (expect 2701) ===")
    {
      const t1 = new Transaction()
      const [treasury] = t1.moveCall({ target: `${PKG}::organization_treasury::new`, arguments: [t1.object(org)] })
      t1.moveCall({ target: `${PKG}::organization_treasury::share`, arguments: [treasury] })
      const r1 = await exec(att, t1, "treasury")
      if (!r1.ok) return
      const ev = bcsBytes((r1.t?.events ?? []).find((e: any) => (e.eventType ?? "").endsWith("TreasuryCreated")))
      const treasuryId = hex(ev), tVault = hex(ev, 64, 96)
      const t2 = new Transaction()
      const [c] = t2.splitCoins(t2.gas, [1_000_000n])
      t2.moveCall({ target: `${PKG}::vault::deposit`, typeArguments: [SUI], arguments: [t2.object(tVault), c] })
      await exec(att, t2, "fund treasury vault 0.001")
      const t3 = new Transaction()
      t3.moveCall({
        target: `${PKG}::organization_treasury::create_transfer`,
        arguments: [t3.object(treasuryId), t3.object(org), t3.pure.vector("u8", [...new TextEncoder().encode("s2")]), t3.pure.address(A1), t3.pure.u64(500_000n), t3.pure.u64(deadline), t3.object(CLOCK)],
      })
      const r3 = await exec(att, t3, "create_transfer")
      if (!r3.ok) return
      const bev = bcsBytes((r3.t?.events ?? []).find((e: any) => (e.eventType ?? "").endsWith("TransferCreated")))
      const bindingId = hex(bev), proposalId = hex(bev, 64, 96)
      const v = new Transaction()
      v.moveCall({ target: `${PKG}::asynchronous_proposal::submit_async_vote`, arguments: [v.object(proposalId), v.object(org), v.object(CLOCK), v.pure.u64(2n), v.pure.vector("u8", [])] })
      await exec(att, v, "vote (w2)")
      const x = new Transaction()
      x.moveCall({ target: `${PKG}::organization_treasury::execute`, arguments: [x.object(treasuryId), x.object(bindingId), x.object(org), x.object(proposalId), x.object(tVault), x.pure.u64(1n), x.pure.vector("u8", []), x.object(CLOCK)] })
      mark("S2 empty-sig execute", await expectAbort(att, x, "execute w/ empty sig", 2701))
    }

    // ============ ATTACK C ============
    console.log("\n=== ATTACK C: subagent cap weight drift (4010) + single-vote threshold ===")
    {
      const t1 = new Transaction()
      t1.moveCall({ target: `${PKG}::asynchronous_proposal::create_shared_subagent_cap`, arguments: [t1.pure.address(A1), t1.pure.u64(2n), t1.pure.u64(500_000_000n), t1.pure.u64(500_000_000n), t1.pure.u64(BigInt(Date.now() + 3_600_000))] })
      const r1 = await exec(att, t1, "cap C1 (voter_weight=2, agent=A1)")
      if (!r1.ok) return
      const cap1 = hex(bcsBytes((r1.t?.events ?? []).find((e: any) => (e.eventType ?? "").endsWith("SubagentCapIssuedEvent"))))

      // roster: ATTACKER w2→3, threshold 2→3 (nonce 1, epoch 1→2)
      const rd = rosterDigest(org, 1n, 1n, 2n, 3n, [ATTACKER], [3n])
      const frostSig = ed25519.sign(rd, groupSk)
      const t2 = new Transaction()
      t2.moveCall({
        target: `${PKG}::cryptographic_org::update_organization_roster`,
        arguments: [t2.object(org), t2.pure.u64(1n), t2.pure.vector("address", [ATTACKER]), t2.pure.vector("address", [ATTACKER]), t2.pure.vector("u64", [3n]), t2.pure.u64(3n), t2.pure.vector("u8", [...frostSig])],
      })
      const r2 = await exec(att, t2, "roster w2→3 (epoch 2)")
      if (!r2.ok) return

      const p2 = new Transaction()
      p2.moveCall({ target: `${PKG}::asynchronous_proposal::create_transfer_proposal`, arguments: [p2.object(org), p2.pure.vector("u8", [...new TextEncoder().encode("drift")]), p2.pure.address(ATTACKER), p2.pure.u64(100_000n), p2.pure.u64(deadline), p2.object(CLOCK)] })
      const rp = await exec(att, p2, "proposal P2 (threshold 3)")
      if (!rp.ok) return
      const proposal2 = hex(bcsBytes((rp.t?.events ?? []).find((e: any) => (e.eventType ?? "").endsWith("ProposalCreatedEvent"))))

      // stale cap: voter_weight 2 ≠ live 3 → 4010 (agent A1 relays)
      const stale = new Transaction()
      stale.moveCall({ target: `${PKG}::asynchronous_proposal::submit_async_vote_by_subagent`, arguments: [stale.object(proposal2), stale.object(org), stale.object(cap1), stale.object(CLOCK), stale.pure.vector("u8", [])] })
      mark("C stale cap (drift)", await expectAbort(a1, stale, "stale cap C1 vote", 4010))

      // fresh cap with new weight 3: one delegated vote ≥ snapshot threshold 3
      const t3 = new Transaction()
      t3.moveCall({ target: `${PKG}::asynchronous_proposal::create_shared_subagent_cap`, arguments: [t3.pure.address(A1), t3.pure.u64(3n), t3.pure.u64(500_000_000n), t3.pure.u64(500_000_000n), t3.pure.u64(BigInt(Date.now() + 3_600_000))] })
      const r3 = await exec(att, t3, "cap C2 (voter_weight=3)")
      if (!r3.ok) return
      const cap2 = hex(bcsBytes((r3.t?.events ?? []).find((e: any) => (e.eventType ?? "").endsWith("SubagentCapIssuedEvent"))))
      const vote = new Transaction()
      vote.moveCall({ target: `${PKG}::asynchronous_proposal::submit_async_vote_by_subagent`, arguments: [vote.object(proposal2), vote.object(org), vote.object(cap2), vote.object(CLOCK), vote.pure.vector("u8", [])] })
      const rv = await exec(a1, vote, "C2 delegated vote (threshold reached by agent alone)")
      if (rv.ok) console.log("  → FINDING C confirmed: delegated cap alone reached the snapshot threshold; master never signed P2 (execution still behind FROST gate)")

      const dbl = new Transaction()
      dbl.moveCall({ target: `${PKG}::asynchronous_proposal::submit_async_vote`, arguments: [dbl.object(proposal2), dbl.object(org), dbl.object(CLOCK), dbl.pure.u64(3n), dbl.pure.vector("u8", [])] })
      mark("C master-after-agent dedup", await expectAbort(att, dbl, "master vote after subagent", 4003))
    }

    // ============ ATTACK B ============
    console.log("\n=== ATTACK B: chat receipt ownership gate ===")
    {
      const t1 = new Transaction()
      const [stake] = t1.splitCoins(t1.gas, [1_000_000n])
      t1.moveCall({
        target: `${PKG}::onchain_chat::create_creator_monetized_channel`,
        arguments: [t1.pure.address(ZERO), t1.pure.vector("u8", [...new TextEncoder().encode("rt")]), stake, t1.pure.u64(300_000n), t1.pure.u64(800_000n), t1.pure.u64(7000n), t1.pure.u64(2000n), t1.pure.u64(1000n)],
      })
      const r1 = await exec(att, t1, "channel (fee 0.0003, stake 0.0008)")
      if (!r1.ok) return
      const channelId = hex(bcsBytes((r1.t?.events ?? []).find((e: any) => (e.eventType ?? "").endsWith("ChannelCreatedWithStakeEvent"))))
      // fund A1 so it can join
      const tf = new Transaction()
      const [gc] = tf.splitCoins(tf.gas, [5_000_000n])
      tf.transferObjects([gc], tf.pure.address(A1))
      await exec(att, tf, "gas top-up → A1")
      const t2 = new Transaction()
      const [pay] = t2.splitCoins(t2.gas, [1_100_000n])
      const [receipt] = t2.moveCall({ target: `${PKG}::onchain_chat::join_channel_with_stake_and_fee`, arguments: [t2.object(channelId), pay] })
      t2.transferObjects([receipt], t2.pure.address(A1))
      const r2 = await exec(a1, t2, "A1 joins (fee+stake)")
      if (!r2.ok) return
      let receiptId = ""
      const full: any = await client.getTransaction({ digest: r2.digest, include: { objectTypes: true } })
      for (const [oid, ty] of Object.entries(full?.Transaction?.objectTypes ?? {}) as [string, string][]) if (String(ty).endsWith("MemberStakeReceipt")) receiptId = oid
      console.log("channel:", channelId, "receipt:", receiptId)

      const t3 = new Transaction()
      const [rev] = t3.moveCall({ target: `${PKG}::onchain_chat::claim_creator_revenue`, arguments: [t3.object(channelId)] })
      t3.transferObjects([rev], t3.pure.address(ATTACKER))
      await exec(att, t3, "creator claims entry fee (legit)")

      // creator redeems the MEMBER's receipt → must abort 6012
      const t4 = new Transaction()
      const [refund] = t4.moveCall({ target: `${PKG}::onchain_chat::member_unstake_and_leave`, arguments: [t4.object(channelId), t4.object(receiptId)] })
      t4.transferObjects([refund], t4.pure.address(ATTACKER))
      mark("B creator-redeems-member-receipt", await expectAbort(att, t4, "creator redeems member receipt", 6012))

      const t5 = new Transaction()
      const [refund2] = t5.moveCall({ target: `${PKG}::onchain_chat::member_unstake_and_leave`, arguments: [t5.object(channelId), t5.object(receiptId)] })
      t5.transferObjects([refund2], t5.pure.address(A1))
      await exec(a1, t5, "member leaves (recovers stake)")
    }

    // ============ SANITY S1 + PROBES ============
    console.log("\n=== SANITY S1: dead-key install (1010) + DKG probes ===")
    {
      const L = 7237005577332262213973186563042994240857116359379907606001950938285454250989n
      const s = new Uint8Array(32); crypto.getRandomValues(s)
      let v = 0n; for (let i = 31; i >= 0; i--) v = (v << 8n) | BigInt(s[i])
      const deadPk = ed25519.Point.BASE.multiply(v % L).toBytes()
      const tx = new Transaction()
      tx.moveCall({
        target: `${PKG}::cryptographic_org::create_organization_entry`,
        arguments: [tx.pure.vector("u8", [...deadPk]), tx.pure.u64(1n), tx.pure.u64(1n), tx.pure.vector("address", [ATTACKER]), tx.pure.vector("u64", [1n]), tx.pure.vector("u8", new Array(64).fill(7))],
      })
      mark("S1 dead-key install", await expectAbort(att, tx, "dead-key install", 1010))

      const p1 = new Transaction()
      p1.moveCall({ target: `${PKG}::dkg_committee::create_resharing_session`, arguments: [p1.pure.u64(1n), p1.pure.u64(1n), p1.pure.vector("address", [ATTACKER]), p1.pure.u64(BigInt(Date.now() + 600_000))] })
      mark("P1 resharing epoch=1", await expectAbort(att, p1, "resharing epoch=1", 3002))

      const p2 = new Transaction()
      p2.moveCall({ target: `${PKG}::dkg_committee::create_dkg_session`, arguments: [p2.pure.u64(1n), p2.pure.vector("address", [A1]), p2.pure.u64(BigInt(Date.now() + 600_000))] })
      mark("P2 creator not participant", await expectAbort(att, p2, "creator not participant", 3001))
    }

    console.log(`\n=== GATES BLOCKED: ${blocked}/${ran} ===`)
    const { balance }: any = await client.getBalance({ owner: ATTACKER, coinType: SUI })
    console.log("ATTACKER balance:", (Number(balance.balance) / 1e9).toFixed(5), "SUI")
  }
}
main().catch(e => { console.error("RT ERROR:", (e as Error).message?.slice(0, 300)); process.exit(1) })
