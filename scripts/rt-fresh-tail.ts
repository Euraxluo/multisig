/** Final tail: finish ATTACK C (C2 vote + dedup), B, S1, P1, P2 with A1 topped up. */
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
const A1 = "0x2c6539e5802d1476dae4a7aada30265dd2568f198ecf2f184861ea7deb3f6347"
const ATTACKER = "0x843f44a42e10a6dc701b7f60a4dedc544dc7910e971ee6a493f4d9096953e04e"
const CLOCK = "0x0000000000000000000000000000000000000000000000000000000000000006"
const ZERO = "0x0000000000000000000000000000000000000000000000000000000000000000"
const client = new SuiGrpcClient({ network: "testnet", baseUrl: "https://fullnode.testnet.sui.io:443" } as any)

function keypairFor(address: string): Ed25519Keypair {
  const ks = JSON.parse(readFileSync(`${homedir()}/.sui/sui_config/sui.keystore`, "utf8")) as string[]
  for (const entry of ks) {
    const kp = Ed25519Keypair.fromSecretKey(fromBase64(entry).slice(1))
    if (kp.toSuiAddress() === address) return kp
  }
  throw new Error(`no keypair for ${address}`)
}
const bcsOf = (ev: unknown): Uint8Array => {
  const e = ev as { bcs?: Uint8Array | Record<string, number> }
  if (e?.bcs instanceof Uint8Array) return e.bcs
  if (e?.bcs && Object.values(e.bcs).every((v) => typeof v === "number")) return Uint8Array.from(Object.values(e.bcs) as number[])
  return new Uint8Array()
}
const hex = (u: Uint8Array, s = 0, e = 32) => "0x" + Buffer.from(u.slice(s, e)).toString("hex")

async function exec(signer: Ed25519Keypair, tx: Transaction, label: string) {
  tx.setSender(signer.toSuiAddress())
  const bytes = await tx.build({ client } as any)
  const sig = await signer.signTransaction(bytes)
  const res: any = await client.executeTransaction({ transaction: bytes, signatures: [sig.signature], include: { effects: true, events: true, objectTypes: true } })
  const t = res.Transaction ?? res.FailedTransaction
  const ok = t?.status?.success === true
  const digest: string = typeof t?.digest === "string" ? t.digest : t?.digest?.digest
  console.log(`[${label}] ${ok ? "EXECUTED" : "ABORTED"} digest=${digest}${ok ? "" : " :: " + (t?.status?.error?.message ?? "").slice(0, 150)}`)
  return { ok, t, digest }
}
async function expectAbort(signer: Ed25519Keypair, tx: Transaction, label: string, code: number): Promise<boolean> {
  try {
    const r = await exec(signer, tx, label)
    if (r.ok) { console.log(`  ❌ ${label}: EXPECTED abort ${code}, EXECUTED — VULNERABLE`); return false }
    const err: string = r.t?.status?.error?.message ?? ""
    console.log(`  ⚠️ ${label}: submitted-but-aborted: ${err.slice(0, 130)}`)
    return err.includes(String(code))
  } catch (e) {
    const m = (e as Error)?.message ?? ""
    const hit = m.includes("MoveAbort") || m.includes(String(code))
    console.log(`  ${hit ? "✅" : "⚠️"} ${label}: blocked at simulation: ${m.slice(0, 150)}`)
    return hit
  }
}

// IDs from the consolidated run output
const ORG = "" // filled below from tx Ddiw5iqizcsP2sHD16XhBkqgG5SxrYwsJ98qpQXB7srq
const PROPOSAL2 = "" // from tx 4fcpzPhQi9y7auspAch5ztF6Q71ZQy2QPTxJxCUc5hqV
const CAP2 = "" // from tx 5gsaC3hmLmfYM285Y4JE2oH28UGi5itRsZLMYq6asL4J

async function main() {
  const a1 = keypairFor(A1)
  const att = keypairFor(ATTACKER)
  const deadline = BigInt(Date.now() + 7_200_000)

  // top up A1
  const tf = new Transaction()
  const [gc] = tf.splitCoins(tf.gas, [15_000_000n])
  tf.transferObjects([gc], tf.pure.address(A1))
  await exec(att, tf, "top-up A1")

  // discover org id + proposal P2 + cap C2 from prior digests
  async function objFromTx(digest: string, suffix: string): Promise<string> {
    const full: any = await client.getTransaction({ digest, include: { objectTypes: true } })
    for (const [oid, ty] of Object.entries(full?.Transaction?.objectTypes ?? {}) as [string, string][]) if (String(ty).endsWith(suffix)) return oid
    return ""
  }
  const org = await objFromTx("Ddiw5iqizcsP2sHD16XhBkqgG5SxrYwsJ98qpQXB7srq", "cryptographic_org::Organization")
  const proposal2 = await objFromTx("4fcpzPhQi9y7auspAch5ztF6Q71ZQy2QPTxJxCUc5hqV", "asynchronous_proposal::Proposal")
  const cap2 = await objFromTx("5gsaC3hmLmfYM285Y4JE2oH28UGi5itRsZLMYq6asL4J", "asynchronous_proposal::SubagentCoSignCap")
  console.log("org:", org, "proposal2:", proposal2, "cap2:", cap2)
  if (!org || !proposal2 || !cap2) return

  // === re-verify the single-use take abort (get the true error) ===
  console.log("\n=== re-check: re-take after executed borrow proposal (expect 4) ===")
  {
    const full: any = await client.getTransaction({ digest: "EyRg9RwhEaHRmGmYDK1z1Du5Ksex5JcJnGkag7wgvEP7", include: { events: true } })
    const capProposalId = hex(bcsOf((full.Transaction?.events ?? []).find((e: any) => (e.eventType ?? "").endsWith("CustodyProposalCreated"))))
    const full2: any = await client.getTransaction({ digest: "2nesJGCjCWKxiaTbrAgBbPBYGhD1v9sC39kT4cnwgaUg", include: { events: true } })
    const custodyId = hex(bcsOf((full2.Transaction?.events ?? []).find((e: any) => (e.eventType ?? "").endsWith("AssetCustodyCreated"))))
    const t = new Transaction()
    const [capVal, receipt] = t.moveCall({ target: `${PKG}::asset_custody::take_asset`, typeArguments: [`${PKG}::vault::MasterCap`], arguments: [t.object(custodyId), t.object(capProposalId), t.object(org), t.object(CLOCK)] })
    t.moveCall({ target: `${PKG}::asset_custody::return_asset`, typeArguments: [`${PKG}::vault::MasterCap`], arguments: [t.object(custodyId), capVal, receipt] })
    await expectAbort(att, t, "re-take after execution", 4)
  }

  // === C tail: delegated vote reaching snapshot threshold + dedup ===
  console.log("\n=== ATTACK C tail: delegated vote reaches threshold; master dedup ===")
  {
    const vote = new Transaction()
    vote.moveCall({ target: `${PKG}::asynchronous_proposal::submit_async_vote_by_subagent`, arguments: [vote.object(proposal2), vote.object(org), vote.object(cap2), vote.object(CLOCK), vote.pure.vector("u8", [])] })
    // Prior run (FYhFBfBz…) already executed this delegated vote reaching the
    // snapshot threshold; a replay must hit the shared dedup slot (4003).
    await expectAbort(a1, vote, "replayed delegated vote (dedup)", 4003)
    const dbl = new Transaction()
    dbl.moveCall({ target: `${PKG}::asynchronous_proposal::submit_async_vote`, arguments: [dbl.object(proposal2), dbl.object(org), dbl.object(CLOCK), dbl.pure.u64(3n), dbl.pure.vector("u8", [])] })
    await expectAbort(att, dbl, "master vote after subagent (dedup)", 4003)
  }

  // === ATTACK B ===
  console.log("\n=== ATTACK B: chat receipt ownership gate ===")
  {
    const t1 = new Transaction()
    const [stake] = t1.splitCoins(t1.gas, [1_000_000n])
    t1.moveCall({
      target: `${PKG}::onchain_chat::create_creator_monetized_channel`,
      arguments: [t1.pure.address(ZERO), t1.pure.vector("u8", [...new TextEncoder().encode("rt")]), stake, t1.pure.u64(300_000n), t1.pure.u64(800_000n), t1.pure.u64(7000n), t1.pure.u64(2000n), t1.pure.u64(1000n)],
    })
    const r1 = await exec(att, t1, "channel")
    if (!r1.ok) return
    const channelId = hex(bcsOf((r1.t?.events ?? []).find((e: any) => (e.eventType ?? "").endsWith("ChannelCreatedWithStakeEvent"))))
    const t2 = new Transaction()
    const [pay] = t2.splitCoins(t2.gas, [1_100_000n])
    const [receipt] = t2.moveCall({ target: `${PKG}::onchain_chat::join_channel_with_stake_and_fee`, arguments: [t2.object(channelId), pay] })
    t2.transferObjects([receipt, pay], t2.pure.address(A1))
    const r2 = await exec(a1, t2, "A1 joins")
    if (!r2.ok) return
    let receiptId = ""
    const full: any = await client.getTransaction({ digest: r2.digest, include: { objectTypes: true } })
    for (const [oid, ty] of Object.entries(full?.Transaction?.objectTypes ?? {}) as [string, string][]) if (String(ty).endsWith("MemberStakeReceipt")) receiptId = oid
    console.log("channel:", channelId, "receipt:", receiptId)

    const t3 = new Transaction()
    const [rev] = t3.moveCall({ target: `${PKG}::onchain_chat::claim_creator_revenue`, arguments: [t3.object(channelId)] })
    t3.transferObjects([rev], t3.pure.address(ATTACKER))
    await exec(att, t3, "creator claims fee (legit)")

    const t4 = new Transaction()
    const [refund] = t4.moveCall({ target: `${PKG}::onchain_chat::member_unstake_and_leave`, arguments: [t4.object(channelId), t4.object(receiptId)] })
    t4.transferObjects([refund], t4.pure.address(ATTACKER))
    await expectAbort(att, t4, "creator redeems member receipt", 6012)

    const t5 = new Transaction()
    const [refund2] = t5.moveCall({ target: `${PKG}::onchain_chat::member_unstake_and_leave`, arguments: [t5.object(channelId), t5.object(receiptId)] })
    t5.transferObjects([refund2], t5.pure.address(A1))
    await exec(a1, t5, "member leaves (recovers stake)")
  }

  // === S1 + P1 + P2 ===
  console.log("\n=== SANITY S1 + DKG probes ===")
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
    await expectAbort(att, tx, "dead-key install", 1010)

    const p1 = new Transaction()
    p1.moveCall({ target: `${PKG}::dkg_committee::create_resharing_session`, arguments: [p1.pure.u64(1n), p1.pure.u64(1n), p1.pure.vector("address", [ATTACKER]), p1.pure.u64(BigInt(Date.now() + 600_000))] })
    await expectAbort(att, p1, "resharing epoch=1", 3002)

    const p2 = new Transaction()
    p2.moveCall({ target: `${PKG}::dkg_committee::create_dkg_session`, arguments: [p2.pure.u64(1n), p2.pure.vector("address", [A1]), p2.pure.u64(BigInt(Date.now() + 600_000))] })
    await expectAbort(att, p2, "creator not participant", 3001)
  }

  const { balance }: any = await client.getBalance({ owner: ATTACKER, coinType: SUI })
  const { balance: b2 }: any = await client.getBalance({ owner: A1, coinType: SUI })
  console.log("\nATTACKER:", (Number(balance.balance) / 1e9).toFixed(5), "SUI · A1:", (Number(b2.balance) / 1e9).toFixed(5), "SUI")
  console.log("ORG=" + org)
}
main().catch(e => { console.error("RT ERROR:", (e as Error).message?.slice(0, 300)); process.exit(1) })
