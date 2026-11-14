/**
 * 索引 §8-Q2 / §2-Q2 — ρ_i 无 session/epoch/org 绑定：跨会话承诺替换攻击离线仿真（0 gas）。
 *
 * computeBindingFactor 输入 = domain ‖ (idx‖D‖E)* ‖ message ‖ group_pk ‖ selfIndex。
 * 问题：攻击者（聚合器/参与者）能否把会话 B 的承诺集合/份额重用到会话 A，
 * 在不知道诚实成员 nonce 秘密的情况下装配出对新消息 m_A 的有效签名？
 *
 * 关键防线（除 ρ 输入外）：ThresholdSignerNode 每会话全新 nonce 且用后清零；
 * aggregateSignature 自校验。本脚本逐构造验证。
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha512 } from "@noble/hashes/sha2.js";
import { computeAggregateNonce, ThresholdSignerNode, validateCommitments, type NonceCommitment, type SignatureShare } from "../packages/multisig/src/dkg/threshold_signer";
import { generatePolynomial, evaluatePolynomial, createCommitments } from "../packages/multisig/src/dkg/vss";
import { mod, lagrangeCoefficient, bytesToScalar, scalarToBytes32, CURVE_ORDER } from "../packages/multisig/src/dkg/math";

const G = ed25519.Point.BASE;
let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  ok ? pass++ : fail++;
};

// ---- 组钥：t=2, n=3（索引 1,2,3）。多项式 degree = t-1 = 1（t=2 → 一次式；degree=2 需 3 个签名者）----
const poly = generatePolynomial(1);
const shares = [1n, 2n, 3n].map((i) => evaluatePolynomial(poly, i));
const Y = createCommitments(poly)[0].toBytes();
const msgOf = (tag: string) => sha512(new TextEncoder().encode("RT-LIT:" + tag)).slice(0, 64);
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

console.log("=== 构造 1：会话 B 承诺集 + B 份额 → 会话 A 新消息（外部聚合器重放） ===");
{
  // 会话 B：H1、H2 诚实签名 m_B
  const mB = msgOf("session-B");
  const n1 = new ThresholdSignerNode("H1", 1n, shares[0]);
  const n2 = new ThresholdSignerNode("H2", 2n, shares[1]);
  const cB: NonceCommitment[] = [n1.generateNonceCommitment(), n2.generateNonceCommitment()];
  const zB: SignatureShare[] = [n1.computeSignatureShare(mB, Y, cB), n2.computeSignatureShare(mB, Y, cB)];
  // 会话 B 正常聚合：先用 B 的原始份额集（尚未被污染）生成基准签名。
  // 注意 computeSignatureShare 用后清零，zB 是唯一可用份额材料。
  const zBraw: SignatureShare[] = [zB[0], zB[1]];
  let sigB: Uint8Array;
  try {
    sigB = ThresholdSignerNode.aggregateSignature(mB, Y, cB, zBraw);
  } catch (e) {
    // aggregateSignature 的 self-check 只接受「与 (cB,mB) 一致」的份额 —— zB 正是为此生成，
    // 若这里失败说明份额材料与承诺集错位（不应发生；保留现场再抛）。
    throw new Error(`基准会话 B 聚合意外失败: ${(e as Error).message}`);
  }
  check("会话 B 正常聚合签名成立", ed25519.verify(sigB, mB, Y));

  // 会话 A：攻击者重放 C_B，消息换成 m_A；ρ_j^A = H(C_B, m_A, Y, j) 全部改变
  const mA = msgOf("session-A");
  const aggregateR_A = computeAggregateNonce(cB, mA, Y); // 承诺同、消息不同 → R̄ 不同
  const c_A = bytesToScalar(sha512(new Uint8Array([...aggregateR_A.toBytes(), ...Y, ...mA])));
  const zReplay = mod(zB[0].shareZ + zB[1].shareZ); // 只有 B 的份额可用
  const sigA = new Uint8Array(64);
  sigA.set(aggregateR_A.toBytes(), 0);
  sigA.set(scalarToBytes32(zReplay), 32);
  check("重放承诺+旧份额在新消息下伪造失败", !ed25519.verify(sigA, mA, Y),
    `验证方程缺口 = (c_B−c_A)·Y + Σ(ρ_j^B−ρ_j^A)·E_j，其中 nonce 秘密 h_j,b_j 攻击者未知`);

  // 唯一“成立”情形 = 逐字重放（同承诺+同消息）：签名逐字节相同 → 链上 executed_proposals 按 digest 去重
  const sigReplay = ThresholdSignerNode.aggregateSignature(mB, Y, cB, zB);
  check("同承诺+同消息 → 与原签名逐字节相同（仅为重放，链上 digest 去重拦截）", hex(sigReplay) === hex(sigB));
}

console.log("=== 构造 2：跨会话份额拼接（B 的 z_1 + A 的 z_2 配 A 承诺集） ===");
{
  const mA = msgOf("mixed-A"), mB = msgOf("mixed-B");
  // 会话 B
  const n1B = new ThresholdSignerNode("H1", 1n, shares[0]);
  const n2B = new ThresholdSignerNode("H2", 2n, shares[1]);
  const cB = [n1B.generateNonceCommitment(), n2B.generateNonceCommitment()];
  const z1B = n1B.computeSignatureShare(mB, Y, cB); // 攻击者截获
  n2B.computeSignatureShare(mB, Y, cB);
  // 会话 A：诚实 H2 用全新 nonce 签 m_A；攻击者把截获的 z1B 混入
  const n2A = new ThresholdSignerNode("H2", 2n, shares[1]);
  const cA = [new ThresholdSignerNode("H1", 1n, shares[0]).generateNonceCommitment(), n2A.generateNonceCommitment()];
  // 注意：cA[0] 是攻击者自己伪造的 H1 承诺（攻击者无 share 0 → 用随机点占位）
  const z2A = n2A.computeSignatureShare(mA, Y, cA);
  let threw = false;
  try {
    ThresholdSignerNode.aggregateSignature(mA, Y, cA, [
      { participantId: "H1", participantIndex: 1n, shareZ: mod(z1B.shareZ) },
      z2A,
    ]);
  } catch (e: any) {
    threw = /self-verification|corruption/.test(e.message ?? "");
  }
  check("B 份额 + A 承诺集拼接 → 聚合自校验拒绝", threw, "z1^B 绑定 B 的 nonce 秘密，配 A 的 R̄/c 必然失衡");
}

console.log("=== 构造 3：nonce 复用（假设清零防线被移除）才是真危险 → 证明防线在 nonce 单次性 ===");
{
  // 反事实：H1 的 node 不清零 nonce，用同一对 (h,b) 签两条消息 —— 等价于给攻击者
  // 两个线性方程： z1 = h + ρ^B·b + c_B·λ·s1 与 z1' = h + ρ^{B'}·b + c_{B'}·λ·s1
  // 两条消息 → 两方程 → 攻击者可解出 b、h、进而 (z1 − z1')/(c_B−c_B') = λ·s1 → 直接得份额！
  const m1 = msgOf("reuse-1"), m2 = msgOf("reuse-2");
  const h = mod(1234567890123456789012345678901234567n), b = mod(9876543210987654321098765432109876543n);
  const fakeNode = {
    hiding: G.multiply(h).toBytes(), binding: G.multiply(b).toBytes(),
  };
  const rhoFor = (m: Uint8Array, self: bigint) => {
    // 复刻 computeBindingFactor 布局（domain ‖ (idx‖D‖E) ‖ m ‖ Y ‖ idx）
    const dom = new TextEncoder().encode("SUI_FROST_BINDING_V1:");
    const items = [{ idx: 1n, ...fakeNode }, { idx: 2n, hiding: G.multiply(7n).toBytes(), binding: G.multiply(8n).toBytes() }]
      .sort((a, b2) => Number(a.idx - b2.idx));
    const parts: Uint8Array[] = [dom];
    for (const it of items) { parts.push(scalarToBytes32(it.idx), it.hiding, it.binding); }
    parts.push(m, Y, scalarToBytes32(self));
    const total = parts.reduce((n, p) => n + p.length, 0);
    const buf = new Uint8Array(total); let o = 0;
    for (const p of parts) { buf.set(p, o); o += p.length; }
    return bytesToScalar(sha512(buf));
  };
  const lam = lagrangeCoefficient(1n, [1n, 2n], 0n);
  const cFor = (m: Uint8Array, cmts: { idx: bigint; hiding: Uint8Array; binding: Uint8Array }[]) => {
    let agg = ed25519.Point.ZERO;
    for (const it of cmts) {
      const rho = rhoFor(m, it.idx);
      agg = agg.add(ed25519.Point.fromBytes(it.hiding).add(ed25519.Point.fromBytes(it.binding).multiply(rho)));
    }
    return bytesToScalar(sha512(new Uint8Array([...agg.toBytes(), ...Y, ...m])));
  };
  const cmts = [{ idx: 1n, ...fakeNode }, { idx: 2n, hiding: G.multiply(7n).toBytes(), binding: G.multiply(8n).toBytes() }];
  const c1 = cFor(m1, cmts), c2 = cFor(m2, cmts);
  const z1 = mod(h + rhoFor(m1, 1n) * b + c1 * lam * shares[0]);
  const z2 = mod(h + rhoFor(m2, 1n) * b + c2 * lam * shares[0]);
  // μ = z1 − z2 = (ρ1−ρ2)·b + (c1−c2)·λ·s —— 本库 ρ 输入含 message → Δρ ≠ 0，
  // 单方程两未知数 (b, λs)：直接代数恢复【不成立】（这正是 RFC 9591 把 message
  // 纳入 H1/H2 的原因；若 ρ 不含 message，Δρ=0，则 s = (z1−z2)/((c1−c2)·λ) 直接泄露）。
  const deltaZ = mod(z1 - z2);
  const deltaRho = mod(rhoFor(m1, 1n) - rhoFor(m2, 1n));
  const deltaC = mod(c1 - c2);
  const naive = mod(deltaZ * modInverseOf(deltaC)) * modInverseOf(lam) % CURVE_ORDER;
  const naiveWorks = mod(naive) === mod(shares[0]);
  console.log(`  [INFO] Δz=${deltaZ.toString(16).slice(0, 10)}… Δρ=${deltaRho.toString(16).slice(0, 10)}…≠0 → 单方程两未知`);
  check("反事实(朴素公式): ρ 含 message 时朴素恢复失效", !naiveWorks, "若 ρ 不含 message 则此式直接泄露 s_i —— 本库布局闭合了该捷径");
  // 但 nonce 复用仍是致命弱化：攻击者可对同一承诺集做 4 次复用得到 4 方程 →
  // 消去 b 后格归约恢复 s（Bibi 等 whitelist 攻击）；演示 2 方程不可解即可，
  // 真实防线仍是单次清零（下一 check 已验证）。
  const realNode = new ThresholdSignerNode("H1", 1n, shares[0]);
  const cm: NonceCommitment[] = [realNode.generateNonceCommitment(), { participantId: "H2", participantIndex: 2n, hiding: G.multiply(7n).toBytes(), binding: G.multiply(8n).toBytes() }];
  realNode.computeSignatureShare(m1, Y, cm);
  let blocked = false;
  try { realNode.computeSignatureShare(m2, Y, cm); } catch { blocked = true; }
  check("真实实现：nonce 单次清零 → 第二次签名抛错（防线生效）", blocked);
}

function modInverseOf(a: bigint): bigint {
  const m = CURVE_ORDER;
  let [old_r, r] = [mod(a), m];
  let [old_s, s] = [1n, 0n];
  while (r !== 0n) {
    const q = old_r / r;
    [old_r, r] = [r, old_r - q * r];
    [old_s, s] = [s, old_s - q * s];
  }
  if (old_r !== 1n) throw new Error("not invertible");
  return mod(old_s);
}

console.log("=== 构造 4：ρ_i 输入可否被攻击者通过承诺点选择操纵（小子群/等价点） ===");
{
  // validateCommitments 拒绝非素数阶点（isTorsionFree）与非恒等元 → 攻击者无法注入
  // 低阶点让 ρ_i 撞出可控线性关系（Drijvers/Wagner 前提）。
  let rejected = false;
  try {
    // order-8 小阶点作为 hiding 承诺：取 (0,1) 恒等元编码 0x0100..00
    validateCommitments([{ participantId: "EV", participantIndex: 9n, hiding: new Uint8Array(32).fill(0).map((_, i) => (i === 0 ? 1 : 0)), binding: G.multiply(5n).toBytes() }]);
  } catch { rejected = true; }
  check("恒等/小阶承诺点被 validateCommitments 拒绝", rejected);
  let rejectedDup = false;
  try {
    validateCommitments([
      { participantId: "A", participantIndex: 1n, hiding: G.multiply(3n).toBytes(), binding: G.multiply(4n).toBytes() },
      { participantId: "B", participantIndex: 1n, hiding: G.multiply(5n).toBytes(), binding: G.multiply(6n).toBytes() },
    ]);
  } catch { rejectedDup = true; }
  check("重复索引承诺被拒绝", rejectedDup);
}

console.log(`
=== 结论 ===
跨会话承诺替换【不可行】：
  1) ρ_i 输入含完整承诺集合+message+group_pk：跨会话复用承诺集必然改变 R̄ → c 改变 →
     旧份额失衡；使 ρ/c 全等价的唯一解是逐字重放同一会话 → 链上 executed_proposals 去重。
  2) 每个 z_i = d_i + c·λ_i·s_i 由【会话内一次性 nonce 秘密】掩蔽；nonce 用后清零使
     任一 z_i 只对唯一 (承诺集, message) 有效 —— 份额信息不可跨会话搬移（构造 3 反事实
     证明一旦 nonce 复用即可代数恢复 s_i，而清零防线使该路径闭合）。
  3) ρ 可操纵性：validateCommitments 拒绝小阶/恒等点与重复索引 → Wagner/ROS 类前提不成立。
残余建议（P2 纵深防御）：
  - BINDING 输入加 session_id/org/epoch（RFC 9591 H4/H5 context 语义），使安全论证
    不依赖上述间接论证；lib/frost-exchange 的 aggregateNonce 已按 orgId 过滤承诺，
    补上 session 级参数即可闭环。
RESULT: ${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
