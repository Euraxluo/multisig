/**
 * 索引 §11 — 侧信道/early-return 分析（浏览器威胁模型，理论+代码走查）。
 *
 * 威胁模型边界：浏览器 JS 环境下攻击者 = 同进程脚本（XSS）或旁路观测者（网络）。
 * 强侧信道（缓存/JIT 计时）在跨 origin 沙箱下基本不可达（Spectre 缓解、
 * 高精度计时器被 coarsened）；网络侧观测 = 消息长度/时序（流量分析）。
 *
 * 逐项检查（源码走查）：
 * 1) randomScalar (math.ts)：CSPRNG 直出 → 无侧信道面。✓
 * 2) parseValidPoint (threshold_signer.ts:35)：assertValidity → is0 → isTorsionFree
 *    顺序 early-return —— 点合法性以异常/返回值区分。谁观测？聚合器本地。
 *    远程攻击者只能通过「该成员是否签名成功」观测 → 与业务结果一致，无额外泄露。
 * 3) lagrangeCoefficient mod 归约：bigint 运算非恒时 —— 泄露 λ 的汉明重量？
 *    λ 是公开数据（索引集合公开可算）→ 无秘密。✓
 * 4) computeSignatureShare 的 nonce 乘法：s_i（秘密）× c × λ —— bigint 非恒时，
 *    理论可泄露 s_i 的位信息。攻击者位置 = 同进程（XSS）——但 XSS 下攻击者
 *    直接读 share/nonce 内存，无需侧信道。跨进程（其他 tab/页面）无 JS 级
 *    高精度共享计时面。浏览器威胁模型下 = 不可达。✓
 * 5) AES-GCM via WebCrypto subtle：浏览器实现常时性由 UA 保证（native）✓
 * 6) x25519.getSharedSecret：noble 实现 varint 扫描标量 → 非恒时标量扫描。
 *    秘密 = 接收方 sk_x25519（localStorage）。同上：XSS 直接读，侧信道冗余。✓
 * 结论：浏览器威胁模型下全部侧信道面【不可达或冗余】（有更强攻击前提时侧信道
 * 才有意义，而那前提本身即胜利条件）。服务端/原生部署若复用此 SDK 则需重审
 * （恒时库替换），当前仅浏览器形态 → P2 记录不行动。
 */
console.log(`侧信道分析（浏览器威胁模型）：
  随机数 CSPRNG ✓；parseValidPoint early-return 泄露面=公开数据 ✓；
  bigint 非恒时运算的秘密消费（s_i、sk_x25519）在「攻击者能计时」的同一前提下
  已可被直接读取（XSS 同进程）→ 侧信道冗余不可达 ✓；
  WebCrypto GCM 由 UA native 保证 ✓。
  若 SDK 未来用于 Node/原生服务端 → 须替换恒时库（升级为 P1 重审项）。
  当前浏览器形态：P2 记录，无行动。`);
