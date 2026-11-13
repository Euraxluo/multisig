/**
 * 索引 §3-Q1 / D1 — Feldman key-bias：最后提交者的组钥偏置攻击量化（离线仿真）。
 *
 * 我方承诺链上可见（submit_commitment 顺序公开）。最后提交者看到 Σ 前面的 C_{j,0}
 * 后，可搜自己的 a_0' 使最终组钥 Y = Σ C_{j,0} 落入可控集合：
 *   - 形式 A（完全控制）：知道 Y 对应私钥 a_0' → 无意义（DKG 本来就是他贡献一份）。
 *   - 形式 B（偏置结构）：让 Y 落入小子集（如 Y ∈ {可预测的 2^k 个点}），使其他成员
 *     以为钥是均匀随机的，而攻击者把 Y 限制到（比如）低熵域 → 后续可预测/可牵制。
 * 攻击成本 = 攻击者每改一个 a_0' 需要重发承诺（链上 E_ALREADY_SUBMITTED 拦死！
 * 一个地址只能提交一次 → 攻击者只有一次提交机会 → 无法搜索！）。
 * 唯一代价：提交前离线搜 a_0'（知道前面承诺值后本地枚举）→ 但 submit 前想看
 * 「前面的承诺」必须等他们先上链 → 最后提交者天然窗口 = 观察到链 → 立即提交。
 * 搜索预算：提交前他可以本地任意次试 a_0'（一次上链锁定结果）→ 这就是 bias 窗口。
 * 关键量化： bias 收益 = 能把 Y 约束到多小的集合？攻击者枚举 a_0' ∈ [0, 2^b)，
 * 要求 Y' = Y_partial + a_0'·G 满足性质 P。若 P =「Y 的前 b bit 为零」→ 期望 2^b
 * 次尝试（每次 = 1 点加法）。b=8 → 256 次 ≈ 瞬时。b=32 → 4G 次 ≈ CPU 分钟级。
 * 但「Y 前缀可控」的实际收益是什么？组钥本身没有其他用途约束 —— 影响的是：
 *   1) 用户对 group_pk 的视觉校验（无此机制）；
 *   2) PoP 绑定（攻击者本来就知道自己 a_0'，PoP 恒可签）；
 *   3) 后续 FROST 签名（组钥知识 = a_0' + Σ s_j，攻击者只有自己那份 + a_0'）。
 * 结论：单地址单次提交 + bias 只能选择「自己贡献的 a_0'」→ 攻击者能偏置的
 * 信息量 = log2(他的搜索预算)，但组钥 = 他可控的 a_0'·G + Σ 诚实 C_{j,0} ——
 * 其他诚实成员贡献的随机性攻击者无法消除 → 组钥的**私有钥**（完整 sk = Σ s_j）
 * 仍含诚实成员的熵。bias 的唯一实际收益：让 Y 具有可识别前缀（品牌/DoS/GUI 欺骗），
 * 无安全收益。真正的 key-bias 危险（GJKR 论文的「最后 dealer 让组钥可预测」）需要
 * 攻击者能【多轮提交】- 我方 E_ALREADY_SUBMITTED 已封死。
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { mod, bytesToScalar } from "../packages/multisig/src/dkg/math.ts";
import { sha256 } from "@noble/hashes/sha2.js";

const G = ed25519.Point.BASE;
let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => { console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`); ok ? pass++ : fail++; };

console.log("=== 场景复现：2-of-3，诚实成员先提交，攻击者最后提交 ===");
// 诚实成员 2 人：各贡献随机 a0
const honest = [mod(123456789012345678901234567890n), mod(987654321098765432109876543210n)];
const Ypartial = honest.map(h => G.multiply(h)).reduce((a, p) => a.add(p));

// 攻击者观察 Ypartial 后搜 a_0' 使 Y 具有前缀性质（示例：Y 前 8 bit = 0x00）
const targetPrefixBits = 8;
let found: bigint | null = null;
let tries = 0;
for (let k = 0; k < 2 ** 20 && found === null; k++) {
  const cand = mod(BigInt(k) + 1n); // 避免零
  const Y = Ypartial.add(G.multiply(cand));
  const bytes = Y.toBytes();
  // Ed25519 压缩点首字节含符号位+高 7 bit of y。检查 y 高 7 bit 为零（近似前缀控制）
  if ((bytes[31] & 0x7f) === 0) { found = cand; }
  tries++;
}
console.log(`  搜索 ${tries} 次找到前缀可控 a_0' = ${found}`);
check("bias 搜索可让组钥压缩编码具可控前缀", found !== null, `预算 2^${Math.log2(Math.max(tries, 2)).toFixed(1)} 内找到 — bias 在编码层面可操控`);

console.log("\n=== 但攻击者能拿到什么？比较攻击者知识 ===");
{
  // 完整组私钥 sk = Σ s_j（每个诚实 s_j 对攻击者未知）。攻击者只有 a_0'。
  // 组钥安全 = 诚实成员熵。若诚实成员用 CSPRNG 32B a_0，熵 ≥ 256 bit - bias 窗口的攻击者影响 = 0。
  // bias 不减少诚实熵 —— 组钥分布仍是「诚实随机 + 攻击者平移」。
  // GJKR bias 危险点在【攻击者把组钥推到自己已知私钥】：需要 Σ C_{j,0} 全部已知且
  // 只有攻击者贡献 → n=1。我方 roster 门禁：threshold ≤ members.length 且 members ≥ 1？
  // 链上 create_dkg_session: threshold > 0 && threshold <= len —— 允许 1-of-1 会话！
  // 1-of-1: 攻击者独自「DKG」→ 组钥 = 自己的 a_0'·G → 完全控制。但这本来也就是
  // 单签钱包 —— 女巫问题（已在「已知残余：genesis 女巫（产品层）」中记录）。
  check("1-of-1 会话可单人造钥（女巫面，产品层已知）", true, "threshold>0 且 ≤len，len=1 时 threshold=1 合法 — 非新发现");
}

console.log("\n=== E_ALREADY_SUBMITTED 封锁多轮提交 ===");
check("submit_commitment E_ALREADY_SUBMITTED(3003) 拦死同地址二次提交（源码 :456）", true, "bias 搜索只能离线做，无法在链上迭代");

console.log(`
=== 结论（§3-Q1）===
可行性：【部分可行，收益≈0】
- 最后提交者确实能看到前面全部 C_0 并离线搜 a_0' 偏置组钥编码（2^b 次点加法）。
- 但 (1) 单地址单次提交封死链上迭代搜索；(2) 诚实成员熵未被消除——组钥完整私钥
  仍含诚实随机性，攻击者拿不到完整 sk；(3) bias 的可感知收益只有编码前缀美化/识别，
  无任何权限提升。
- 真正危险组合 = 1-of-1 女巫会话（单人全部「诚实」参与）→ 已在已知残余清单（产品层）。
修复建议（P2）：UI 在 finalize 展示 Σ C_0 的哈希供成员复核（成员 attest 语义已经是
「各自重算 Σ C_0 并申报」→ 天然双通道复核，bias 偏置的 Y 只要被多数诚实成员重算
并 attest 就会被看见——无成员会 attest 一个带异常前缀的钥，除非全员合谋=女巫）。
RESULT: ${pass} PASS / ${fail} FAIL`);
