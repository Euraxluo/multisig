/**
 * 索引 §1-Q1 / E1 / E5 — sui::ed25519::ed25519_verify 语义探针（测试网实弹）。
 *
 * 用 cryptographic_org 的 public 验签函数 compute_*_digest + 真实 PoP 验签路径做
 * dev-inspect 探测（0 gas），构造三类争议输入：
 *   T1: s+L malleated 签名（RFC 8032 要求拒绝非规范 s；dalek verify 拒绝、ZIP-215 接受）
 *   T2: 小阶点公钥（order 4/8 cofactor 点，fastcrypto verify_strict 拒绝、普通 verify 接受）
 *   T3: 非规范 R（R 与 R+cofactor 等价编码）
 * 每例回答：链上 ed25519_verify 接受 or 拒绝（E_ARRAY = 拒绝 | 通过 = 接受）。
 */
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { fromBase64, toBase64 } from "@mysten/sui/utils"
import { SuiGrpcClient } from "@mysten/sui/grpc"
import { Transaction } from "@mysten/sui/transactions"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { ed25519 } from "@noble/curves/ed25519.js"
import { sha256 } from "@noble/hashes/sha2.js"

const PKG = "0x768e3781fd774bdd010089ede1c66df344aee2047817a121aa6c602e73723501"
const A1 = "0x2c6539e5802d1476dae4a7aada30265dd2568f198ecf2f184861ea7deb3f6347"
const client = new SuiGrpcClient({ network: "testnet", baseUrl: "https://fullnode.testnet.sui.io:443" })

function keypairFor(address: string): Ed25519Keypair {
  const ks = JSON.parse(readFileSync(`${homedir()}/.sui/sui_config/sui.keystore`, "utf8")) as string[]
  for (const entry of ks) {
    const kp = Ed25519Keypair.fromSecretKey(fromBase64(entry).slice(1))
    if (kp.toSuiAddress() === address) return kp
  }
  throw new Error(`no keypair for ${address}`)
}

// PoP 摘要复刻（与链上 compute_create_pop_digest 逐字节一致，用随机 32B 占位参数，
// digest 值本身无所谓——我们只要链上执行到 ed25519_verify 并观察 abort 与否）。
const DOMAIN_POP_V2 = new TextEncoder().encode("SUI_ORG_POP_V2:")
const CHAIN = new TextEncoder().encode("sui-testnet:")
const u64le = (v: bigint) => { const o = new Uint8Array(8); let x = v; for (let i = 0; i < 8; i++) { o[i] = Number(x & 0xffn); x >>= 8n } return o }
const addrB = (a: string) => Buffer.from(a.replace(/^0x/, "").padStart(64, "0"), "hex")
const vecAddr = (as: string[]) => { const head = Uint8Array.of(as.length); return Buffer.concat([head, ...as.map(addrB)]) }
const vecU64 = (vs: bigint[]) => { const head = Uint8Array.of(vs.length); return Buffer.concat([head, ...vs.map(u64le)]) }
function popDigest(groupPk: Uint8Array, members: string[]): Uint8Array {
  return sha256(Buffer.concat([
    DOMAIN_POP_V2, CHAIN, groupPk, vecAddr(members), vecU64([1n]), u64le(1n), u64le(1n),
  ]))
}

/** dev-inspect 一个 create_organization_with_chain_id 的 PoP 验签调用，返回是否通过验签。 */
async function probe(sig: Uint8Array, groupPk: Uint8Array, label: string): Promise<{ onchainAccept: boolean; note: string }> {
  const members = [A1]
  const digest = popDigest(groupPk, members)
  const tx = new Transaction()
  tx.moveCall({
    target: `${PKG}::cryptographic_org::create_organization_with_chain_id`,
    arguments: [
      tx.pure.vector("u8", [...groupPk]),
      tx.pure.u64(1n), // key_threshold
      tx.pure.u64(1n), // threshold_weight
      tx.pure.vector("address", members as never),
      tx.pure.vector("u64", [1n]),
      tx.pure.vector("u8", [...CHAIN]),
      tx.pure.vector("u8", [...sig]),
    ],
  })
  tx.setSender(A1)
  tx.setGasBudget(50_000_000n)
  // gRPC simulateTransaction：checksEnabled=false 允许缺 gas 余额，仍执行 Move 语义与 abort 检查
  try {
    const res = await client.simulateTransaction({ transaction: tx, checksEnabled: false }) as {
      $kind?: string
      FailedTransaction?: { status?: { success?: boolean; error?: { $kind?: string; message?: string; MoveAbort?: { abortCode?: string; location?: { functionName?: string } } } } }
      SuccessTransaction?: { status?: { success?: boolean } }
    }
    const st = res.SuccessTransaction?.status ?? res.FailedTransaction?.status
      ?? (res as { Transaction?: { status?: { success?: boolean; error?: { $kind?: string; message?: string; MoveAbort?: { abortCode?: string } } } } }).Transaction?.status
    const success = st?.success === true
    const err = res.FailedTransaction?.status?.error
    const code = err?.MoveAbort?.abortCode
    const label = success ? "executed" : `${err?.$kind ?? "?"}${code ? " code=" + code : ""}: ${(err?.message ?? "").slice(0, 70)}`
    return { onchainAccept: success, note: label }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return { onchainAccept: false, note: ("exc: " + msg).slice(0, 120) }
  }
}

async function main() {
  const kp = keypairFor(A1)
  // 直接从 keystore 原始条目取 32B seed（flag||seed 的 flag 已剥）
  const ks = JSON.parse(readFileSync(`${homedir()}/.sui/sui_config/sui.keystore`, "utf8")) as string[]
  let seed = new Uint8Array(32)
  for (const entry of ks) {
    const cand = Ed25519Keypair.fromSecretKey(fromBase64(entry).slice(1))
    if (cand.toSuiAddress() === A1) { seed = fromBase64(entry).slice(1); break }
  }
  const noblePk = ed25519.getPublicKey(seed)
  const noblePkHex = Buffer.from(noblePk).toString("hex")

  console.log("A1 noble pk =", noblePkHex.slice(0, 16) + "…  (A1 地址:", kp.toSuiAddress().slice(0, 10) + "…)")
  const members = [A1]

  console.log("\n=== 基线：正常签名 PoP（应通过） ===")
  {
    const digest = popDigest(noblePk, members)
    const sig = ed25519.sign(digest, seed)
    const sdkOk = ed25519.verify(sig, digest, noblePk)
    const r = await probe(sig, noblePk, "baseline")
    console.log(`  SDK verify=${sdkOk} | 链上 ed25519_verify=${r.onchainAccept ? "ACCEPT" : "REJECT"} | ${r.note}`)
  }

  console.log("\n=== T1: s+L malleated 签名 ===")
  {
    const digest = popDigest(noblePk, members)
    const sig = ed25519.sign(digest, seed)
    const L = (1n << 252n) + 27742317777372353535851937790883648493n
    let s = 0n
    for (let i = 0; i < 32; i++) s += BigInt(sig[32 + i]) << BigInt(8 * i)
    const sPlus = s + L
    if (sPlus >> 256n === 0n) {
      const maul = new Uint8Array(sig)
      let carry = sPlus
      for (let i = 0; i < 32; i++) { maul[32 + i] = Number(carry & 0xffn); carry >>= 8n }
      const sdkOk = (() => { try { return ed25519.verify(maul, digest, noblePk) } catch { return false } })()
      const r = await probe(maul, noblePk, "s+L")
      console.log(`  s+L < 2^256 成立 | SDK(dalek 语义)=${sdkOk} | 链上=${r.onchainAccept ? "ACCEPT ⚠️" : "REJECT ✓"} | ${r.note}`)
    } else {
      console.log("  s+L ≥ 2^256 越界，s+L 形态对此签名不适用（S max < L 已含于编码）")
    }
  }

  console.log("\n=== T2: 小阶点公钥（order-4 点 (0,c) 与 order-8 点） ===")
  {
    // order-8 小阶点：y = 1 的编码 0x0100..00（(0,1) 是 order-1? 实际 (0,1) 逆元自身 = identity 编码）
    // dalek: identity 编码 [1,0,...] 解析为 identity 点；fastcrypto verify_strict 拒小阶。
    // 真正 order-8 点: y = -1 → 编码 0x ee ff ... = (0,-1) 是 8 阶点（cofactor 点）。
    const order8 = new Uint8Array(32); order8[0] = 0xec; order8[31] = 0xff // y = p-1 (小阶标准点)
    const order4 = new Uint8Array(32); order4[31] = 0x02 // 试 y=2 需解 x — 用已知小阶点表:
    // 已知 8 阶点编码（dalek 文档）：0x0100…00 (identity), 0xecffffffff…ff (y=-1)
    for (const [name, pkBytes] of [["identity(1,0)", new Uint8Array(32).map((_, i) => (i === 0 ? 1 : 0))], ["order8 (0,-1)", order8]] as const) {
      const digest = popDigest(pkBytes, members)
      // 签名本身无所谓——小阶 pk 下任何 sig 与 verify 方程的匹配需要特定 s；试 identity pk：
      // 方程 sB = R + h(pk,m)·pk → s 任意时 R = sB - h·pk。对小阶 pk，可以用任意 s 调 R？
      // 但 R 编码必须有效。用 s=0：R = -h·pk = 小阶点 → 编码合法（identity/8阶）。尝试直接复用基线 sig 结构：
      const h = BigInt("0x" + Buffer.from(sha256(Buffer.concat([sha256(digest), pkBytes]))).toString("hex")) // 近似挑战占位
      void h
      // 直接零签：s=0, R=identity → 方程 0·B ?= identity + h·pk。pk 小阶 → h·pk 小阶 ≠ identity（除非 h ≡ 0 mod 阶）
      // 概率 1/2^252 失败。改为真构造：让攻击者拥有该小阶 pk 的「签名权」——小阶点的离散对数可穷举（阶 ≤8）！
      // pk = k·B 小阶 → k = cofactor*8 的倍数解，k ∈ {0, L·q}... 其实小阶点 k 是已知小整数。
      // (0,-1) = 7·B mod 8 阶… kL 任意倍数都是解。ed25519 标量域里 s 取 s.t. s·B = R + h·pk。
      // pk=identity(0 阶 1): 方程 sB = R + h·0 = R → 取任意 s, R=sB: 签名 = (sB, s) 有效！
      const identity = new Uint8Array(32).map((_, i) => (i === 0 ? 1 : 0))
      const s = 5n
      const R = ed25519.Point.BASE.multiply(s).toBytes()
      const sigForIdentity = new Uint8Array([...R, ...(() => { const b = new Uint8Array(32); let x = s; for (let i = 0; i < 32; i++) { b[i] = Number(x & 0xffn); x >>= 8n } return b })()])
      if (name.startsWith("identity")) {
        // 第二重验证：identity pk 下换一个签名者（任何人）+ 自己的 s，都应被链上接受（若真 ACCEPT）
        const s2 = 99n
        const R2 = ed25519.Point.BASE.multiply(s2).toBytes()
        const sig2 = new Uint8Array([...R2, ...(() => { const b = new Uint8Array(32); let x = s2; for (let i = 0; i < 32; i++) { b[i] = Number(x & 0xffn); x >>= 8n } return b })()])
        const sdkOk = (() => { try { return ed25519.verify(sigForIdentity, digest, identity) } catch { return false } })()
        const r = await probe(sigForIdentity, identity, name)
        const r2 = await probe(sig2, identity, name + "/second-signer")
        const both = r.onchainAccept && r2.onchainAccept
        console.log(`  pk=${name}: 「任何人可签」SDK=${sdkOk ? "也接受 ⚠️" : "拒绝"} | 链上 sig1=${r.onchainAccept ? "ACCEPT ⚠️⚠️" : "REJECT ✓"} sig2(另签者)=${r2.onchainAccept ? "ACCEPT ⚠️⚠️" : "REJECT ✓"} | ${r.note}`)
        if (both) console.log("  ⚠️⚠️⚠️ 判定：链上接受 identity pk → PoP 门禁对小阶公钥不设防（见报告 P1）")
      } else {
        // order-8: sB = R + h·pk → R = sB − h·pk 可计算（pk 点已知）！h = SHA512(R̄‖Y‖m) 的前半 → 循环定 R 自洽：
        // 简化：不构造完整签名，只测链上对「小阶 pk + 垃圾 sig」的行为即可判 reject/accept 路径；
        // 验签失败与否的第二判据用 identity 案例已足够回答「ed25519_verify 是否拒小阶 pk」。
        const junk = new Uint8Array(64)
        const r = await probe(junk, pkBytes, name)
        console.log(`  pk=${name} + 垃圾 sig: 链上=${r.onchainAccept ? "ACCEPT ⚠️(不可能,观察)" : "REJECT"} | ${r.note}`)
      }
    }
  }

  console.log("\n=== T3: 非规范 R（同一 R 点的双编码 sig）——离线 SDK 对照即可 ===")
  {
    const digest = popDigest(noblePk, members)
    const sig = ed25519.sign(digest, seed)
    // noble 严格按 32B 编码比较 R；链上 fastcrypto 用压缩点重解码——非规范 R 需 y 同 x 符号翻转。
    // 构造 R 的另一编码成本高；此处结论并入报告理论分析（ZIP-215 vs canonical）。
    console.log("  [SKIPPED-LIVE] 非规范 R 需 y/x 符号位双编码搜索，离线理论覆盖（见报告）")
    void sig
  }

  console.log("\n结论提取见最终报告 §1。")
}

main().catch((e) => { console.error("FATAL:", e?.message ?? e); process.exit(1) })
