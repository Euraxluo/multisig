// Final E-gate verification on the FIXED package: weight-approved transfer + EMPTY frost sig → expect 2701.
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
const ATTACKER = "0x843f44a42e10a6dc701b7f60a4dedc544dc7910e971ee6a493f4d9096953e04e"
const client = new SuiGrpcClient({ network: "testnet", baseUrl: "https://fullnode.testnet.sui.io:443" })
const clock = "0x0000000000000000000000000000000000000000000000000000000000000006"
function keypairFor(address: string): Ed25519Keypair {
  const ks = JSON.parse(readFileSync(`${homedir()}/.sui/sui_config/sui.keystore`, "utf8")) as string[]
  for (const entry of ks) {
    const kp = Ed25519Keypair.fromSecretKey(fromBase64(entry).slice(1))
    if (kp.toSuiAddress() === address) return kp
  }
  throw new Error("no key")
}
const le = (v: bigint) => { const o = new Uint8Array(8); let x = v; for (let i = 0; i < 8; i++) { o[i] = Number(x & 0xffn); x >>= 8n } return o }
const vi = (xs: Uint8Array[]) => { const total = 1 + xs.reduce((a, x) => a + x.length, 0); const o = new Uint8Array(total); o[0] = xs.length; let p = 1; for (const x of xs) { o.set(x, p); p += x.length } return o }
const addrB = (a: string) => Buffer.from(a.replace(/^0x/, "").padStart(64, "0"), "hex")

async function main() {
  const attacker = keypairFor(ATTACKER)
  // 1. org: single member ATTACKER, weight 2, threshold 2, real PoP
  const sk = new Uint8Array(32); crypto.getRandomValues(sk)
  const pk = ed25519.getPublicKey(sk)
  const popDigest = sha256(Buffer.concat([Buffer.from("SUI_ORG_POP_V1:"), Buffer.from("sui-testnet:"), Buffer.from(pk), vi([addrB(ATTACKER)]), vi([le(2n)]), le(2n)]))
  const popSig = ed25519.sign(popDigest, sk)
  const otx = new Transaction()
  otx.moveCall({ target: `${PKG}::cryptographic_org::create_organization_entry`, arguments: [otx.pure.vector("u8", [...pk]), otx.pure.u64(2n), otx.pure.vector("address", [ATTACKER]), otx.pure.vector("u64", [2n]), otx.pure.vector("u8", [...popSig])] })
  otx.setSender(ATTACKER)
  let orgId = ""
  {
    const bytes = await otx.build({ client } as any)
    const sig = await attacker.signTransaction(bytes)
    const res: any = await client.executeTransaction({ transaction: bytes, signatures: [sig.signature], include: { effects: true, events: true } })
    const ev = (res.Transaction?.events ?? []).find((e: any) => (e.eventType ?? "").includes("OrganizationCreated"))
    const b = ev?.bcs instanceof Uint8Array ? ev.bcs : Uint8Array.from(Object.values(ev?.bcs ?? {}) as number[])
    orgId = "0x" + Buffer.from(b.slice(0, 32)).toString("hex")
    console.log("org:", orgId)
  }
  // 2. treasury + fund
  const t1 = new Transaction()
  const [treasury] = t1.moveCall({ target: `${PKG}::organization_treasury::new`, arguments: [t1.object(orgId)] })
  t1.moveCall({ target: `${PKG}::organization_treasury::share`, arguments: [treasury] })
  t1.setSender(ATTACKER)
  let treasuryId = "", tvVaultId = ""
  {
    const bytes = await t1.build({ client } as any)
    const sig = await attacker.signTransaction(bytes)
    const res: any = await client.executeTransaction({ transaction: bytes, signatures: [sig.signature], include: { effects: true, events: true } })
    const ev = (res.Transaction?.events ?? []).find((e: any) => (e.eventType ?? "").includes("TreasuryCreated"))
    const b = ev?.bcs instanceof Uint8Array ? ev.bcs : Uint8Array.from(Object.values(ev?.bcs ?? {}) as number[])
    treasuryId = "0x" + Buffer.from(b.slice(0, 32)).toString("hex")
    tvVaultId = "0x" + Buffer.from(b.slice(64, 96)).toString("hex")
    console.log("treasury:", treasuryId, "vault:", tvVaultId)
  }
  const f2 = new Transaction()
  const [c2] = f2.splitCoins(f2.gas, [60_000_000n])
  f2.moveCall({ target: `${PKG}::vault::deposit`, typeArguments: [SUI], arguments: [f2.object(tvVaultId), c2] })
  f2.setSender(ATTACKER)
  {
    const bytes = await f2.build({ client } as any)
    const sig = await attacker.signTransaction(bytes)
    await client.executeTransaction({ transaction: bytes, signatures: [sig.signature] })
  }
  // 3. bound transfer proposal
  const deadline = BigInt(Date.now() + 3_600_000)
  const p1 = new Transaction()
  p1.moveCall({ target: `${PKG}::organization_treasury::create_transfer`, arguments: [p1.object(treasuryId), p1.object(orgId), p1.pure.vector("u8", [...new TextEncoder().encode("E-gate")]), p1.pure.address(ATTACKER), p1.pure.u64(50_000_000n), p1.pure.u64(deadline), p1.object(clock)] })
  p1.setSender(ATTACKER)
  let proposalId = "", bindingId = ""
  {
    const bytes = await p1.build({ client } as any)
    const sig = await attacker.signTransaction(bytes)
    const res: any = await client.executeTransaction({ transaction: bytes, signatures: [sig.signature] })
    const d = typeof res.Transaction?.digest === "string" ? res.Transaction.digest : res.Transaction?.digest?.digest
    const full: any = await client.getTransaction({ digest: d, include: { objectTypes: true } })
    for (const [oid, ty] of Object.entries(full?.Transaction?.objectTypes ?? {}) as [string, string][]) {
      if (ty.endsWith("asynchronous_proposal::Proposal")) proposalId = oid
      if (ty.endsWith("organization_treasury::TransferBinding")) bindingId = oid
    }
    console.log("proposal:", proposalId, "binding:", bindingId)
  }
  // 4. vote weight 2 (meets threshold 2)
  const v = new Transaction()
  v.moveCall({ target: `${PKG}::asynchronous_proposal::submit_async_vote`, arguments: [v.object(proposalId), v.object(orgId), v.object(clock), v.pure.u64(2n), v.pure.vector("u8", [])] })
  v.setSender(ATTACKER)
  {
    const bytes = await v.build({ client } as any)
    const sig = await attacker.signTransaction(bytes)
    const res: any = await client.executeTransaction({ transaction: bytes, signatures: [sig.signature] })
    console.log("vote ok:", res.Transaction?.status?.success)
  }
  // 5. execute with EMPTY frost signature → EXPECT 2701
  const x = new Transaction()
  x.moveCall({ target: `${PKG}::organization_treasury::execute`, arguments: [x.object(treasuryId), x.object(bindingId), x.object(orgId), x.object(proposalId), x.object(tvVaultId), x.pure.u64(1n), x.pure.vector("u8", []), x.object(clock)] })
  x.setSender(ATTACKER)
  try {
    const bytes = await x.build({ client } as any)
    const sig = await attacker.signTransaction(bytes)
    await client.executeTransaction({ transaction: bytes, signatures: [sig.signature] })
    console.log("❌ EXECUTED — GATE FAILED")
  } catch (e: any) {
    const msg = e?.message ?? ""
    if (msg.includes("2701")) console.log("✅ E-GATE BLOCKED (2701):", msg.slice(0, 140))
    else console.log("⚠️ other abort:", msg.slice(0, 160))
  }
}
main().catch(e => { console.error("ERR:", e.message); process.exit(1) })
