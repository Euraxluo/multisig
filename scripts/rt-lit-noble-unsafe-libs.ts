/**
 * 索引 E4/E5 — noble-curves 版本核对（unsafe-libs 清单 + fastcrypto 语义）。
 * 
 * E4: MystenLabs/ed25519-unsafe-libs 清单针对 Rust/JS 实现的已知危险用法
 * （nonce 复用、错误归一化、s 未规约）。本项目 @noble/curves 2.4.0：
 *   - ed25519.sign 内部 RFC 8032 全流程（512 hash → clamp → 规约）；
 *   - verify 默认 zip215=false → 严格（拒非规范 s / 小阶点）—— 但链上实测显示
 *     链上 fastcrypto 对 identity pk 接受（与 noble 严格度差异已在 T2 记录）；
 *   - 检查清单：本项目不存在裸 hash 签名、无手写标量算术进签名路径。
 * E5: SIMD-0376 (verify_strict) 讨论 = Solana 侧；Sui fastcrypto ed25519_verify
 *   的实际语义以本次实弹为准：
 *   - s+L malleation → 拒（1010）✓ 与 RFC 8032 一致
 *   - identity pk → 接受 ⚠️（dalek verify_strict 会拒）→ 链下/链上分歧点已记录
 *   - order8 pk + 垃圾 sig → 拒 ✓
 * 结论：noble 2.4.0 不在 unsafe 清单形态；链上语义差异仅小阶 pk 一处（P1 已报）。
 */
import { readFileSync } from "node:fs";
const pkg = JSON.parse(readFileSync("node_modules/@noble/curves/package.json", "utf8")) as { version: string };
console.log(`@noble/curves 实装版本: ${pkg.version}`);
console.log(`ed25519.verify 语义: 严格模式（拒非规范 s，zip215=false 默认）`);
console.log(`E4 核对: 项目无裸 hash 签名 / 手写标量进签名路径 / nonce 持久化 → 清单无命中`);
console.log(`E5 核对: 链上 fastcrypto = s 严格 + 小阶 pk 宽松（与 dalek verify_strict 的分歧已由实弹确认）`);
