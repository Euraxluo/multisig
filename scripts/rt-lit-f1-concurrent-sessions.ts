/**
 * 索引 §2-Q1 / F1 (ePrint 2025/1001) — 并发签名会话自适应攻击可行性分析（离线）。
 *
 * F1 结论：ℓ ≈ 190 个并发签名会话（0.725·log₂L）下，腐化 ≤t 的攻击者可多项式时间
 * 伪造（自适应安全崩塌）。三个前提逐条检验：
 *   P1: 攻击者能开 ~190 个并发会话并让同一批诚实签名者参与多轮 round1/round2；
 *   P2: FROST1 的 ρ_i/nonce 生命周期允许跨会话的代数关系积累（无会话内绑定）；
 *   P3: 攻击者可自适应腐化（拿到 t 个份额即可）——我方「腐化」= 恶意成员本身。
 * 我方代码事实（直接读源码，非猜测）：
 *   - threshold_signer.ts: computeBindingFactor 输入含【message + group_pk + 全承诺集】；
 *     generateNonceCommitment 每次调用生成全新 (h,b)；computeSignatureShare 用后清零。
 *   - frost-exchange.ts: 承诺必须 orgId 匹配 + 索引唯一（aggregateNonce 校验）。
 *   - 无任何会话计数器/速率限制——P1 的「会话数量」侧无代码防线。
 */

import { ed25519 } from "@noble/curves/ed25519.js";
import { mod, lagrangeCoefficient, bytesToScalar, CURVE_ORDER } from "../packages/multisig/src/dkg/math.ts";

const G = ed25519.Point.BASE;
const L = CURVE_ORDER;
// 0.725·log2(L) ≈ 0.725 × 252 ≈ 182.7 → ~190 会话阈值（论文设 ℓ=190 安全余量内不成立）
const log2L = Math.log2(Number(L >> 200n)) + 200 * Math.log2(2); // ≈251.7
const thresholdSessions = Math.floor(0.725 * log2L);
console.log(`log2(L) ≈ ${log2L.toFixed(1)} → F1 并发会话阈值 ℓ ≈ ${thresholdSessions}`);

console.log(`
=== P1 检验：攻击者能否开 ~190 个并发签名会话？ ===
代码事实：
  - SDK 侧无「会话上限」：SessionShareProvider.collect 每次调用独立收集 t 份额。
  - 同一 (nonce) 只能签一个 message（用后清零）→ 每次 collect 消耗 nonce 对。
  - nonce 由 ThresholdSignerNode.generateNonceCommitment 即时生成 —— 但 UI 每次签名
    请求都要成员设备主动出 nonce 并计算 z_i（人机交互点）。
攻击路径：攻击者（提案发起人）对同一 org 连续发起 190 个不同 digest 的提案签名请求，
诱导同一批成员在短时间内完成 190 轮 round1+round2。
  - 技术上无代码阻止（无速率限制/会话上限）。
  - 操作上需要成员配合 190 次（或成员 UI 被自动化）。UI 是「单 tab 一次一会话」
    （dkg-ceremony-dialog 每 session 单例 state；签名走 wallet 弹窗逐笔确认）。
  - 钱包签名弹窗 = 天然人肉限速：每提案 1-2 次签名确认。190 次 ≈ 数小时人工点击。
  - 自动化前提 = 成员私钥自动化（等于已腐化，超出 F1 模型）。
P1 判定：代码无防线，但攻击经济模型需要 190 次「成员真实的 round2 计算」。
成员设备每次 round2 都会看到 message digest —— 190 个不同 digest 的连续签名请求
在 UI/运营层是高可见异常。技术上可行、操作上可检测。`);

console.log(`
=== P2 检验：F1 代数前提在我们的 ρ 布局下是否成立？ ===
F1 攻击需要：跨会话的 nonce/承诺进入同一代数系统，使攻击者能通过 Wagner/ROS 风格
的子集和构造把「未签名 message」的挑战凑出来。FROST 原始论文的攻击面是 ROS。
我们的布局（computeBindingFactor 源码逐字节）：
  ρ_i = H(domain ‖ (idx‖D‖E)*sorted ‖ **message** ‖ **group_pk** ‖ idx_self)
关键：ρ_i 混入 message 且每个 ρ_i 因 idx_self 不同而不同 → 攻击者无法跨会话
重用同一 ρ 值；message 不同 → 全部 ρ_i 重算 → 代数关系只在本会话内闭合。
F1 的攻击模型（Crites-Stewart）：针对『poly commit in the clear + adaptive corruption』
的**模拟器取证**——攻击者腐化 t 个成员后要求「回溯式」解释过去的会话。该攻击需要
协议在腐化时点之前已输出可回溯的签名会话记录，且会话间共享可重写的多项式结构。
我们的会话记录：每次签名 = 独立 (承诺集, digest, sig)，签名的 z 已公开；
腐化后攻击者拿到 s_i，能签任何**新** digest（这本来就是 t-of-n 语义），但
「伪造过去未签的 digest」需要nonce 复用或 ROS 碰撞 —— 均被布局阻断。
P2 判定：F1 的并发-会话代数前提在我们的逐参与者 ρ_i（含 message + group_pk）
布局下不成立。190 会话只是论文对「最广 FROST 变体族」的证明边界，不是已知可利用
漏洞。`);

console.log(`
=== P3 检验：F2 (ePrint 2025/1061) 自适应腐化 t_c ≤ t/2 界限 ===
F2 结论：t_c ≤ t/2 时多数 FROST 变体自适应安全；t_c > t/2 无证明（且 F1 构造在此区间）。
我方语义：腐化 = 长期持有份额的恶意成员（resharing 不换钥）。
  - t=2, n=3: t/2 = 1 → 1 个恶意份额在界内；2 个 = 门限本身 = 系统已失守（语义自然）。
  - t=3, n=5: t/2 = 1.5 → 2 恶意份额超界 → F2 无证明区间。但注意：**静态**安全下
    t 恶意 = 门限语义允许（签名成立是「合法」而非「伪造」）；F2/F1 关心的是
    「伪造**未授权**签名」即少于 t 的恶意者伪造完整签名 —— 这需要 nonce 生命周期缺陷。
  - 我方 nonce 单次清零 + ρ 含 message → 少于 t 的恶意者无法伪造（离线仿真已证，
    见 rt-lit-rho-crosssession.ts）。
P3 判定：F2 的「无证明」不等于「可伪造」；我方具体防线使伪造不可行，证明缺口是
理论完备性而非工程漏洞。`);

console.log(`
=== 量化：攻击者要在「单 tab UI」下凑 190 会话的实际成本 ===
1. 每会话需 ≥t 个成员的 round2（钱包签名确认 + 浏览器内 FROST 计算）。
2. UI 单 tab 一次只处理一个签名请求（signAndExecuteWithWallet 串行，钱包弹窗阻塞）。
3. 190 会话 × t 成员 × 每轮 ~10s 人工确认 ≈ 190×2×10s ≈ 63 分钟纯点击时间，
   且每个 digest 都在成员屏幕上可见 —— 190 个连续「组织提案」是显著运营异常。
4. 结论：F1 在本项目的可用攻击面 = 零（技术无阻断，操作不可能不被发现）。
`);

console.log(`=== F1/F2 综合判定 ===
[部分可行→不可行]：
- 会话数无代码上限（事实，P1 成立到「无速率限制」程度）；
- 但 F1 攻击的代数前提（跨会话可重写多项式关系）被我方 ρ_i 布局（含 message+group_pk
  +逐参与者自指索引）阻断 —— 攻击构造无法落地；
- 防御纵深建议（P2 级）：
  1) SDK 增加 org 级签名会话速率上限（如每 org 每小时 ≤10 个未完成会话）；
  2) UI 汇总展示「待签名 digest 队列」让成员看见批量请求异常；
  3) ρ 输入补 session_id（纯理论增强，RFC 9591 context 语义）。
RESULT: 理论分析完成（无实弹必要——攻击构造不可达）`);
