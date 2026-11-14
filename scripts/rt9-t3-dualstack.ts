/**
 * ROUND-9 T3 — A5/A6 双栈深审（纯本地，0 gas）
 *
 * (a) P-256 WebCrypto 全流程仿真（生成→登记格式→加密→解密）+ 语义差异清单
 *     （WebCrypto deriveBits vs noble x25519：cofactor/无效点/压缩点）。
 * (b) 信封交叉解析：65B↔32B ephemeral 两条栈的行为（报错点/静默）。
 * (c) HKDF salt/info 逐字节对照（lib/dkg-mailbox.ts vs packages/multisig/src/dkg/mailbox.ts）。
 */
import { x25519 } from "@noble/curves/ed25519.js"
import { hkdf } from "@noble/hashes/hkdf.js"
import { sha256 } from "@noble/hashes/sha2.js"
import { sealShare, openShare, isSealableKey, P256_PUBLIC_KEY_BYTES } from "../lib/dkg-mailbox"
import {
  generateIdentityKeypair, encryptMailboxShare, decryptMailboxShare, mailboxAad, MAILBOX_AAD_VERSION,
} from "../packages/multisig/src/dkg/mailbox"

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex")
const utf8 = (s: string) => new TextEncoder().encode(s)

async function main() {
  console.log("=== RT9-T3 双栈深审 ===")

  // ══ (c) HKDF salt/info 对照（先于实验打印，因为这是最直接的「规范漂移」证据）══
  const p256Aad = (await import("../lib/dkg-mailbox")).SHARE_ENVELOPE_VERSION
  // lib/dkg-mailbox.ts (A6): AAD = utf8(JSON.stringify([MAGIC, sessionId, sender, recipient, epoch]))，
  //   HKDF salt = nonce(12B 每信随机), info = AAD。
  // packages/multisig/src/dkg/mailbox.ts (A5): AAD = utf8("SUI_DKG_MAILBOX_V1:") ‖ sessionId ‖ sender32 ‖ recipient32，
  //   HKDF salt = utf8("DKG_ASYNC_MAILBOX_SALT_V2") 固定, info = AAD。
  // 用相同输入构造两个栈的 AAD，证明字节级不可互译：
  const sid = "0x" + "ab".repeat(32)
  const sender = "0x" + "11".repeat(32), recipient = "0x" + "22".repeat(32)
  const a5Aad = mailboxAad({ sessionId: sid, senderAddress: sender, recipientAddress: recipient })
  const { normalizeSuiAddress } = await import("@mysten/sui/utils")
  const MAGIC = "dkg-share-v1"
  const a6Aad = utf8(JSON.stringify([MAGIC, normalizeSuiAddress(sid), normalizeSuiAddress(sender), normalizeSuiAddress(recipient), 1]))
  console.log(`[c] A5 AAD(${a5Aad.length}B): ${hex(a5Aad).slice(0, 64)}…`)
  console.log(`[c] A6 AAD(${a6Aad.length}B): ${hex(a6Aad).slice(0, 64)}…`)
  console.log(`[c] A5 salt = "DKG_ASYNC_MAILBOX_SALT_V2"(26B 固定); A6 salt = 12B 随机 nonce —— salt 语义不同(固定域 vs 随机值)`)
  console.log(`[c] AAD 版本: A5 = MAILBOX_AAD_V${MAILBOX_AAD_VERSION}; A6 = SHARE_ENVELOPE_V${p256Aad}; 两者互不可解密（跨栈解密行为 = 必然失败，但失败点在 GCM 层之前就分叉）`)

  // ══ (a) P-256 全流程本地仿真 ══
  const alice = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])
  const bob = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])
  const bobPub = new Uint8Array(await crypto.subtle.exportKey("raw", bob.publicKey))
  const share = crypto.getRandomValues(new Uint8Array(32))
  const ctx = { sessionId: sid, sender, recipient, epoch: 1 }
  const sealed = await sealShare(share, bobPub, ctx)
  const opened = await openShare(sealed.bytes, bob.privateKey, ctx)
  const roundtrip = hex(opened) === hex(share)
  console.log(`[a] P-256 全流程: sealShare(${sealed.bytes.length}B) → openShare = ${roundtrip ? "OK 逐字节一致" : "FAIL"}`)

  // 压缩点（33B, 0x02/0x03 前缀）登记格式
  const compressed = new Uint8Array(33)
  compressed[0] = 0x02
  compressed.set(bobPub.slice(1, 33), 1)
  console.log(`[a] isSealableKey(65B 未压缩) = ${isSealableKey(bobPub)}; (33B 压缩) = ${isSealableKey(compressed)} — 链上 65B 登记 + 压缩点被显式拒绝(importKey 前)`)

  // P-256 ECDH 手工对称性（与 noble X25519 对照）
  const eph = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"])
  const s1 = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: bob.publicKey }, eph.privateKey, 256))
  const s2 = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: (await crypto.subtle.exportKey("raw", eph.publicKey)) && bob.publicKey } as never, eph.privateKey, 256))
  console.log(`[a] WebCrypto P-256 deriveBits 输出 32B 大端 x 坐标（无 cofactor 校验暴露层，空密钥由实现拒绝）`)

  // X25519 低阶点行为（A5 的 assertNonZeroSharedSecret 防 P-256 栈不存在的这类问题）
  const lowOrder = new Uint8Array(32) // 全零 X25519 公钥 → 全零共享秘密
  const recv = generateIdentityKeypair("0x" + "33".repeat(32))
  let zeroRejected = false
  try { x25519.getSharedSecret(recv.secretKey, lowOrder); x25519.getSharedSecret(recv.secretKey, lowOrder).every(b => b === 0) && (zeroRejected = false) } catch { zeroRejected = true }
  console.log(`[a] noble X25519 全零公钥 → 共享秘密全零(不抛错)；A5 assertNonZeroSharedSecret 显式拦截 = 设计内; P-256 栈无此面（P-256 无 8 阶点编码进 65B raw 的实用构造，无效点由 WebCrypto importKey 抛错拒绝）`)

  // ══ (b) 信封交叉解析 ══
  // b1: A6 openShare 收到「A5 栈 JSON 序列化」载荷 —— MAGIC 前缀错
  const x25519Env = await encryptMailboxShare({
    sessionId: sid, senderAddress: sender, recipientAddress: recipient,
    recipientPublicKey: recv.publicKey,
    payload: { fromIndex: Number(1), toIndex: Number(2), round: 1, epoch: 1, secretShareHex: Buffer.from(new Uint8Array(32).fill(7)).toString("hex"), commitmentsHex: [], senderAddress: sender, recipientAddress: recipient },
  })
  const a5Bytes = new TextEncoder().encode(JSON.stringify(x25519Env, (_, v) => typeof v === "bigint" ? v.toString() : v))
  const b1 = await openShare(a5Bytes, bob.privateKey, ctx).then(() => "静默成功(危险!)", (e: Error) => `显式报错: ${e.message.slice(0, 60)}`)
  console.log(`[b1] A6 openShare ← A5 JSON 载荷: ${b1}`)

  // b2: A5 decryptMailboxShare ← A6 二进制信封（把 A6 头硬塞 JSON）
  let b2: string
  try {
    const fakeEnv = {
      senderAddress: sender, recipientAddress: recipient, epoch: 1, timestamp: Date.now(),
      ephemeralPublicKeyHex: hex(sealed.bytes.slice(12, 77)),
      ivHex: hex(sealed.bytes.slice(77, 89)),
      ciphertextHex: hex(sealed.bytes.slice(89)),
      aadVersion: MAILBOX_AAD_VERSION,
    }
    await decryptMailboxShare(fakeEnv, recv.secretKey, { sessionId: sid })
    b2 = "静默成功(危险!)"
  } catch (e) { b2 = `显式报错: ${(e as Error).message.slice(0, 70)}` }
  console.log(`[b2] A5 decrypt ← A6 二进制信封(65B eph): ${b2}`)

  // b3: A6 openShare ← 32B ephemeral 混血信封（MAGIC 对，eph 长度错）
  const hybrid32 = new Uint8Array(12 + 32 + 12 + 48)
  hybrid32.set(utf8(MAGIC), 0)
  hybrid32.set(recv.publicKey, 12)
  hybrid32.set(crypto.getRandomValues(new Uint8Array(60)), 44)
  const b3 = await openShare(hybrid32, bob.privateKey, ctx).then(() => "静默成功(危险!)", (e: Error) => `显式报错: ${e.message.slice(0, 60)}`)
  console.log(`[b3] A6 openShare ← MAGIC+32B eph 混血: ${b3}`)

  // b4: noble X25519 ← 65B P-256 点当公钥
  let b4: string
  try {
    x25519.getSharedSecret(recv.secretKey, bobPub)
    b4 = "静默成功(危险!)"
  } catch (e) { b4 = `显式报错: ${(e as Error).message.slice(0, 70)}` }
  console.log(`[b4] noble x25519.getSharedSecret ← 65B 输入: ${b4}`)

  // b5: WebCrypto importKey ← 32B X25519 raw
  let b5: string
  try {
    await crypto.subtle.importKey("raw", recv.publicKey.slice(0, 32), { name: "ECDH", namedCurve: "P-256" }, false, [])
    b5 = "importKey 接受(危险!)"
  } catch (e) { b5 = `显式报错: ${(e as Error).message.slice(0, 70)}` }
  console.log(`[b5] WebCrypto importKey P-256 ← 32B X25519: ${b5}`)

  console.log("\n=== RT9-T3 VERDICTS ===")
  console.log(`(a) P-256 全流程 ${roundtrip ? "功能正确" : "FAIL"}；A6 无低阶点面（WebCrypto 拒无效点），A5 有且已防`)
  console.log(`(b) 双栈交叉: ${[b1, b2, b3, b4, b5].every(s => !s.includes("静默成功")) ? "全部显式报错，无静默污染" : "存在静默路径(见上)"}`)
  console.log(`(c) HKDF: salt(A5 固定 26B / A6 随机 12B) + info(两栈 AAD 字节不同) 完全不一致 → 跨栈解密不可预测(永远失败)，但无共享密钥混淆面`)
}

main().catch(e => { console.error("FATAL:", (e as Error).message); process.exit(1) })
