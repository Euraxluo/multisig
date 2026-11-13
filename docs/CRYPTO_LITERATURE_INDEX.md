# 密码学算法 → 文献 → 攻击论文 索引

> 用途：把本项目**实际使用的每一个密码学原语**对应到它的规范文献，以及**针对该原语的破解/红队论文与真实事件**。红队按本索引逐条打。
> 维护：算法或参数变更时同步更新本文件。最后更新：2026-11-13，对应血统 `0x50739707…`。
> 标注：`[已打]` = 我方已红队验证有防线；`[待打]` = 尚未针对性攻击；`[N/A]` = 不适用。

---

## 0. 算法清单（按代码实际调用枚举）

| # | 原语 | 参数/形态 | 代码位置 | 用途 |
|---|---|---|---|---|
| A1 | Ed25519（RFC 8032） | 纯 Ed25519，64B sig，32B pk | 链上 `sui::ed25519::ed25519_verify`（4 处）；SDK `@noble/curves/ed25519.js` | 所有链上验签（转账/PoP/attest/轮换/质押取回/提案） |
| A2 | FROST 门限 Schnorr / Ed25519 | t-of-n，hiding+binding 双 nonce，逐参与者 ρ_i | `packages/multisig/src/dkg/threshold_signer.ts`；`lib/crypto/committee-signing.ts`、`lib/frost-exchange.ts`（均委托 FROST1） | 组织主钥的门限签名 |
| A3 | Pedersen/GJKR DKG（Feldman VSS） | 无可信 dealer，多项式承诺 + 信箱份额 | `packages/multisig/src/dkg/{vss,resharing}.ts`；链上 `dkg_committee.move` | 生成 FROST 组钥与分片 |
| A4 | 拉格朗日插值（Shamir 秘密分享） | 域 F_L 上 t-of-n | `math.ts::lagrangeCoefficient` | 门限签名份额聚合 |
| A5 | X25519 ECIES | X25519 ECDH + HKDF-SHA256 + AES-256-GCM（AAD 绑定） | `packages/multisig/src/dkg/mailbox.ts` | DKG 份额的密态信箱投递 |
| A6 | P-256 ECDH + HKDF + AES-GCM | WebCrypto `subtle`，namedCurve P-256 | `lib/dkg-mailbox.ts` | 前端仪式路径的份额加密封装 |
| A7 | AES-256-GCM | 96-bit IV，AAD | 同上 A5/A6 | 份额机密性+完整性 |
| A8 | HKDF-SHA256 | salt V2（`DKG_ASYNC_MAILBOX_SALT_V2`），info = 域‖会话‖双方地址 | 同上 | 会话密钥派生 |
| A9 | SHA-256 / SHA-512 | 域分隔哈希（7 个域常量） | 链上 `std::hash::sha2_256`；SDK `@noble/hashes/sha2.js` | 摘要/挑战/绑定因子 |
| A10 | BCS 序列化 | Sui 规范 | 链上 `bcs::to_bytes`；SDK `@mysten/bcs` | 摘要字节布局 |
| A11 | CSPRNG | `crypto.getRandomValues` / `randomScalar` | `math.ts`、`mailbox.ts`、UI attest key | nonce/密钥/IV 生成 |
| A12 | Lagrange + 承诺点运算 | noble `ed25519.Point`（含 torsion 校验） | `threshold_signer.ts::parseValidPoint` | 点验证、绑定因子、聚合 |

---

## 1. Ed25519（A1）

**规范**
- RFC 8032 — Edwards-Curve Digital Signature Algorithm (EdDSA) — https://www.rfc-editor.org/rfc/rfc8032
- FIPS 186-5（EdDSA 收录）— https://csrc.nist.gov/pubs/fips/186-5/final

**攻击 / 红队文献**
| # | 文献 | 攻击点 | 对本项目相关性 | 状态 |
|---|---|---|---|---|
| E1 | *Taming the Many EdDSAs* (ePrint 2020/1244) — https://eprint.iacr.org/2020/1244 | 各实现验证语义不一致（s 范围、cofactor、非规范编码）；跨实现共识分歧 | 链上验签 vs SDK 验签语义差异 → 链下通过链上拒绝（DoS）或反之 | `[已打]` 摘要+nonce 防重放，malleability 不可二次消费 |
| E2 | *The Provable Security of Ed25519: Theory and Practice* (IEEE S&P 2021) — https://zisc.ethz.ch/wp-content/uploads/2020/11/ed25519-SP.pdf | 非 SUF-CMA；Mt. Gox 式签名 mauling | 同 E1，本项目全部依赖内容摘要而非签名字节 | `[已打]` 见 E1 |
| E3 | *Ed25519 Quirks: Malleability* — https://quirks.ed25519.info/malleability | s+L 延展、R 点非规范 | 同上 | `[已打]` |
| E4 | *MystenLabs/ed25519-unsafe-libs* — https://github.com/MystenLabs/ed25519-unsafe-libs | 库级 nonce 复用/签名错误实现清单 | noble-curves 是否在列；SDK 是否误用 | `[待打]` 需核对项目所用 noble 版本 |
| E5 | SIMD-0376 verify_strict 讨论 — https://simd.mixy.one/simd/0376-verify-strict | Sui 生态是否放宽 torsion 校验 | 直接影响链上验签语义 | `[待打]` 需确认 fastcrypto 版本行为 |

**本项目需红队回答的问题**
1. `sui::ed25519::ed25519_verify` 是否等价 `verify_strict`（拒绝非规范 s、小阶 A/R）？若否，什么输入能让链上接受而 SDK 拒绝（或反之），是否造成状态分歧？
2. 组公钥 `group_pk` 由 DKG 生成、可能含 torsion 分量吗？若含，链上验签行为如何？
3. 同一 ed25519 密钥被复用于 Sui 账户 / FROST 分片 / attest / PoP 时，跨协议攻击面（见 §9）。

---

## 2. FROST 门限签名（A2）

**规范**
- RFC 9591 (June 2024) — https://www.rfc-editor.org/rfc/rfc9591
- *FROST: Flexible Round-Optimized Schnorr Threshold Signatures* (SAC 2020) — https://eprint.iacr.org/2020/852

**攻击 / 红队文献**
| # | 文献 | 攻击点 | 对本项目相关性 | 状态 |
|---|---|---|---|---|
| F1 | *A Plausible Attack on the Adaptive Security of Threshold Schnorr* (ePrint 2025/1001) — https://eprint.iacr.org/2025/1001 | ℓ > 0.725·log p 并发会话（≈190）下多项式时间伪造；pk_i = g^{sk_i} 形态的所有 FROST 变体 | 我方 FROST1 是两轮 + 无并发会话上限；**并发会话数量是否可被攻击者无限开**（UI 每 tab 一会话）？ | `[待打]` 关键 |
| F2 | *On the Adaptive Security of FROST* (ePrint 2025/1061) — https://eprint.iacr.org/2025/1061 | 自适应腐化 t_c ≤ t/2 的安全界限；超出即无证明 | 我方允许任意 t 成员在任意时刻离线/腐化 | `[待打]` |
| F3 | *Dynamic-FROST* (ePrint 2024/896) — https://eprint.iacr.org/2024/896 | 动态委员会下 FROST 的安全性前提 | 我方 resharing 保公钥模式 vs 动态 FROST | `[待打]` |
| F4 | *Re-Randomized FROST* (ePrint 2024/1604, Gouvêa–Komlo) | 主动重随机化抵抗长期腐化 | 我方无主动刷新（resharing 不换钥），成员长期持有分片 | `[待打]` 对应「旧分片残留」 |
| F5 | *Pedersen DKG DoS in FROST* — Zcash Foundation 2024-02 — https://zfnd.org/pedersen-dkg-vulnerability-in-frost-distributed-key-generation-successfully-remediated | 恶意 dealer 的 DKG 拒绝服务（非盗窃） | 我方 DKG 会话有 bond + deadline + timeout，但 grief 成本=？ | `[待打]` |
| F6 | *Attacks on Threshold Schemes: Part 1* (Hexens) — https://hexens.io/blog/mpc-attacks-p1 | 真实实现 bug：缺检查、缺证明、参数错误 | 逐项核对 | `[待打]` |
| F7 | *Unidentifiability in Decentralized FROST* (CertiK) — https://www.certik.com/blog/threshold-cryptography-ii-unidentifiability-in-decentralized-frost | 去中心化 FROST 的身份不可识别性导致的归责失效 | 我方 attest/confirm 是否可归责 | `[待打]` |
| F8 | *CGGMP21 Vulnerabilities Patched* (DFNS 2025-11) — https://dfns.co/article/cggmp21-vulnerabilities-patched-and-explained | ECDSA 门限实现的预签名/nonce 攻击（同类结构） | 我方 FROST1 nonce 生命周期 | `[已打]` nonce 单次清零 + 自校验 |
| F9 | Kudelski *Secure Code Review of FROST* — https://docs.rs/crate/lit-frost/latest/source/audit/ | 实现级缺陷清单 | 逐条核对 FROST1 | `[待打]` |
| F10 | *Drijvers et al., On the Security of Two-Round Multi-Signatures* (S&P 2019) | ROS/Wagner 并发伪造 | 全局 ρ 已修 → 逐参与者 ρ_i；但并发会话仍无上限 | `[已打]` 见 §2 修复记录 |
| F11 | *Ben-Sasson et al., On the Security of ROS* | ROS 假设下界 | 同上 | `[待打]` |
| F12 | GHSA-wgq8-vr6r-mqxm（min_signers 参数 + refresh share 交互漏洞）— https://vulnerability.circl.lu/vuln/ghsa-wgq8-vr6r-mqxm | 门限参数在刷新后不一致 | 我方 roster/key_threshold 联动（1009/1012） | `[已打]` #15/#16 修复 |

**本项目需红队回答的问题**
1. 攻击者能否让同一批签名者**并发**开 ~190 个签名会话（F1 阈值）？UI 是否限制？FROST1 是否有会话 ID 绑定（防跨会话 nonce 复用）？
2. 逐参与者 ρ_i 已修，但 ρ_i 的哈希输入**没有绑 session/epoch/org**——跨会话承诺替换是否仍可行？
3. 我方 t 固定不随 n 上调（F2 的界限失效），有没有具体的伪造构造？
4. 无主动刷新（F4）下，长期持有分片的攻击者最坏能做什么？

---

## 3. DKG / Feldman VSS（A3）

**规范**
- *Secure Distributed Key Generation for Discrete-Log Based Cryptosystems* (GJKR, EUROCRYPT'99 / J.Cryptology 2006) — https://link.springer.com/content/pdf/10.1007/s00145-006-0347-3.pdf
- *Feldman's Verifiable Secret Sharing for a Dishonest Majority* (ePrint 2024/031) — https://eprint.iacr.org/2024/031

**攻击 / 红队文献**
| # | 文献 | 攻击点 | 相关性 | 状态 |
|---|---|---|---|---|
| D1 | GJKR 原文 §"bias the output distribution" | 最后一个 dealer 可 biased 公钥分布 | 我方 `submit_commitment` 顺序上链可见（先提交者承诺暴露） | `[待打]` |
| D2 | *Rogue Key Attack on Gennaro DKG* (Sigma Prime) — https://blog.sigmaprime.io/dkg-rogue-key.html | 承诺未定死时的 rogue-key | 我方承诺不可改（E_ALREADY_SUBMITTED） | `[已打]` |
| D3 | *Fully Secure DKG for Discrete Log Revisited* (ePrint 2026/042) — https://eprint.iacr.org/2026/042 | GJKR 的强安全变体；指出标准 GJKR 的缺口 | 我方是 GJKR 形态 | `[待打]` |
| D4 | DKG Gate 演示（key biasing）— https://systemslibrarian.github.io/crypto-lab-dkg-gate/ | 可交互的 key bias 攻击 | 教学级复现 | `[待打]` |
| D5 | fedimint DKG 文档（h_i 先广播防 bias）— https://docs.fedimint.org/crypto/dkg.html | 先广播承诺再揭示的必要性 | 我方是否满足 | `[待打]` |

**本项目需红队回答的问题**
1. 我方是 **Feldman 承诺（无 Pedersen blinding）**——最后提交者看到前面所有 C_0 后，能否 biased 选自己的多项式使组公钥可预测/可控？收益多大？
2. 我方承诺只断言 `length >= 32`（不验结构），恶意 dealer 交垃圾 → 接收方 VSS 校验失败 → 该份额作废。是否可系统性让某成员无法获得有效份额（定向 DoS）？
3. `take_genesis_stakes` 的 `stakers` 计数按非零 stake 计——是否与 confirm/attest 计数语义冲突（影响 1012 判定的边界）？

---

## 4. Shamir / 拉格朗日（A4）

- 规范：Shamir 1979；Lagrange 插值标准结论。
- 攻击文献：*Proactive Secret Sharing without Erasures* (ePrint 2026/1072) — https://eprint.iacr.org/2026/1072（长期腐化下分片累积）
- 相关：CHURP (CCS'19) — https://par.nsf.gov/servlets/purl/10153196
- 攻击点：同一 epoch 内收集 ≥ t 分片即可重构；跨 epoch 分片混合是否失效（我方 resharing 保公钥 → **旧分片对新摘要仍有效**，直到 rotate）。
- 状态：`[已打]`（rotate 换钥 + nonce 单调隔离），`[待打]`（resharing 窗口内的混合攻击构造）

---

## 5. X25519 ECIES（A5）

**规范**
- RFC 7748 (X25519) — https://www.rfc-editor.org/rfc/rfc7748
- *Implementing Curve25519/X25519* (Kleppmann) — https://martin.kleppmann.com/papers/curve25519.pdf

**攻击 / 红队文献**
| # | 文献 | 攻击点 | 相关性 | 状态 |
|---|---|---|---|---|
| X1 | *Small subgroup attacks* (PKC 2003) — https://iacr.org/archive/pkc2003/25670211/25670211.pdf | 低阶点使 DH 共享密钥退化 | 我方 `assertNonZeroSharedSecret` 双侧 | `[已打]` |
| X2 | SafeCurves: Twist security — https://safecurves.cr.yp.to/twist.html | twist 攻击与小子群 | 同上 | `[已打]` |
| X3 | *SCA-secure ECC in software* (ePrint 2021/1003) — https://eprint.iacr.org/2021/1003 | 侧信道/故障攻击 X25519 | 浏览器环境（JIT/缓存）侧信道 | `[待打]` |
| X4 | Crypto.SE: ECIES without sender auth — https://crypto.stackexchange.com/questions/83587/ecies-for-encrypting-ecdh-key-exchange | 无发送方认证 → 临时钥替换 MITM | 我方 AAD 绑定元数据但**无签名** | `[已打]`（结论：DoS-only，VSS 校验 fail-closed），`[待打]`（是否可致份额静默丢失） |
| X5 | I2P ECIES-X25519-AEAD-Ratchet — https://www.i2p.net/en/docs/specs/ecies | 工程化 ECIES 的完整绑定（含发送方静态钥与签名） | 对照我方缺失项 | `[待打]` |

---

## 6. P-256 ECDH（A6）

- 规范：NIST SP 800-56A / FIPS 186-5。
- 攻击文献：*Invalid curve attacks* (ePrint 2015/1233 等)；WebCrypto 实现差异（CVE 类）。
- 关键：我方 A5/A6 **两套并行**（32B vs 65B 公钥），链上现双栈接受。攻击点：跨栈密钥混淆（把 P-256 点当 X25519 用 / 反之）。
- 状态：`[待打]` —— **本项是本索引里最未被审的两套实现并存面**。

---

## 7. AES-256-GCM（A7）

**攻击文献**
| # | 文献 | 攻击点 | 相关性 | 状态 |
|---|---|---|---|---|
| G1 | *Authentication Failures in NIST version of GCM* (Joux 2006) — https://csrc.nist.gov/csrc/media/projects/block-cipher-techniques/documents/bcm/joux_comments.pdf | nonce 重用 → 认证密钥恢复 → 通用伪造 | 我方 IV 每次 `getRandomValues(12)`，同 key 下 96-bit 随机 IV | `[已打]`（碰撞概率可忽略；但 key 复用范围需核） |
| G2 | *Nonce-Disrespecting Adversaries* (WOOT'16, ePrint 2016/475) — https://eprint.iacr.org/2016/475 | 实现级 nonce 重用 | 同上 | `[已打]` |
| G3 | GHASH 上的多次伪造攻击（Ferguson） | 短 tag / 多次验证 | 我方 128-bit tag | `[N/A]` |

**需红队回答**：同一接收方 X25519 静态钥 + 多个发送方 → 每封信独立 ephemeral。若攻击者能让接收方用同一 ephemeral（重放信封），IV 是否重用？我方 AAD 绑 session/双方地址 —— 重放在 GCM 层失败，但**同一 key+IV 组合被验证失败是否泄露 GHASH 信息**（验证失败预言机）？

---

## 8. HKDF / 域分隔 / BCS（A8–A10）

**文献**
| # | 文献 | 攻击点 | 状态 |
|---|---|---|---|
| H1 | Trail of Bits *Best practices for key derivation* (2025-01) — https://blog.trailofbits.com/2025/01/28/best-practices-for-key-derivation/ | salt/info 误用、跨上下文密钥复用 | `[已打]`（V2 salt + info 绑域） |
| H2 | *Comparse: Provably Secure Formats for Cryptographic Protocols* (2023) — https://www.twal.org/pdf/slides/2023_11_comparse.pdf | 字节格式歧义 → 跨类型混淆 | `[待打]` **BCS 编码歧义**：`vector<u8>` vs `vector<address>` 长度前缀同为 uleb，摘要拼接时是否可混淆？ |
| H3 | FOKS *Signing data structures the right way* — https://blog.foks.pub/posts/domain-separation-in-idl/ | 结构体字段对齐导致的签名混淆 | `[待打]` 同上 |
| H4 | *Per-user encryption keys: length-extension trap and HKDF fix* — https://www.kirkabbott.com/writing/2026-08-07-per-user-encryption-keys-length-extension-and-hkdf | 直接哈希拼接的 length-extension | `[已打]`（我方用 HKDF，非裸 hash） |

**需红队回答**
1. 7 个域常量 + BCS 拼接：是否存在**两段不同语义字节流哈希碰撞**（长度前缀歧义）？特别是 `bcs(vector<u8>)` 与 `bcs(vector<address>)` 在长度相同时的字节布局。
2. `SUI_FROST_BINDING_V1` 的 ρ_i 输入**不含 session/epoch/org**——同一承诺集合被跨会话复用时是否可利用？（RFC 9591 的 H4/H5 含 context。）

---

## 9. 密钥复用图谱（跨原语，本项目特有）

| 密钥 | 兼任角色 | 风险 |
|---|---|---|
| 钱包 ed25519 | Sui 账户签名 + 可能被用作 attest key（若 UI 复用） | 账户钥泄露 = attest 也失守；我已改为**会话级独立 attest key**（localStorage），但需核实所有路径 |
| DKG 分片 s_i | FROST 签名 + resharing dealer + genesis stake 取回签名（经组钥） | 分片泄露面 |
| 组公钥 group_pk | FROST 验证 + PoP 主体 + 链上 org 身份 | 一次泄露全失 |
| ECIES X25519 静态钥 | 仅信箱解密 | 与 ed25519 分离 ✓ |
| P-256 前端钥 | 前端信箱 | 与 A5 并存 → 混淆面 |

**文献**：*Taming the many EdDSAs* §key substitution；*Cryptographic domain separation*（跨协议密钥复用通用风险）。

**需红队回答**：给出**每一条复用边**的具体攻击前提与后果，特别是「分片泄露 → 能否直接推出组钥或伪造 PoP」。

---

## 10. 随机数（A11）

- 规范：NIST SP 800-90A/B；浏览器 `crypto.getRandomValues`。
- 攻击文献：*Mining your Ps and Qs* (USENIX 2012，弱 RNG 共模)；*Ron was wrong, Whit is right*（共享素数）。
- 我方：nonce 用 `randomScalar()`（32B CSPRNG），IV 12B CSPRNG。**风险点：进程崩溃重启后 nonce 状态不持久**（FROST1 内存态）——若浏览器 tab 恢复且未清 nonce，理论复用面。状态 `[待打]`。

---

## 11. 侧信道 / 实现层

- 文献：*SoK: SCA-secure ECC in software*（ePrint 2021/1003）；noble-curves 的常量时间声明与已知 issue。
- 我方：`@noble/curves` 标量运算是否常量时间？`lagrangeCoefficient` 的 `mod` 归约是否分支泄露？`parseValidPoint` 的 early-return 是否泄露点合法性？
- 状态 `[待打]`。

---

## 12. 真实世界事件（对标教训）

| 事件 | 教训 | 我方对应 |
|---|---|---|
| Mt. Gox（Ed25519 malleability） | 用签名字节做唯一标识 | 用内容摘要 + nonce ✓ |
| Typus Finance 2025-10（Sui 共享对象，$3.44M） | 共享对象缺单例门禁 | `assert_org_not_created`（3026）✓ |
| Zcash FROST DKG DoS（2024-01） | DKG 可被 grief | bond + deadline + timeout + claim ✓ |
| CGGMP21 漏洞（2025-11 披露） | 门限签名的预签名/份额生命周期 | nonce 单次清零 ✓ |
| Wormhole / Ronin（多签密钥泄露） | 门限/多签的运营安全 | 待产品层 |

---

## 红队攻坚结果（2026-11-13，LitRedTeam，0 gas 全 simulate）

| 索引项 | 判定 | 证据 |
|---|---|---|
| F1 并发 190 会话（ePrint 2025/1001） | **构造不可达**：ρ_i 含 message+group_pk+自索引，跨会话多项式重写被阻断；单 tab UI 串行 + 190×2×10s 人工点击不可隐匿 | rt-lit-f1-concurrent-sessions.ts |
| F2 自适应腐化界限 | 少于 t 伪造不可行（nonce 单次清零 + ρ 含 message） | 同上 |
| E1/E3/E4/E5 malleability + noble 版本 | s+L 链上 REJECT（1010）；noble 2.4.0 默认严格（zip215=false）；unsafe-libs 清单无命中 | rt-lit-ed25519-verify.ts / rt-lit-noble-unsafe-libs.ts |
| **[新发现 P1] identity pk 链上 ACCEPT** | ed25519_verify 接受 identity 公钥（任何人可签）→ 已加 3027 小阶黑名单三层防线（PoP 验签天然拒 + attest/finalize 拉黑 + org 创建门） | rt-lit-ed25519-verify.ts / rt-identity-block.ts（新血统实弹 BLOCKED） |
| D1 Feldman key-bias | 可行但收益≈0：2^7.9 次点加法只能偏置编码前缀，E_ALREADY_SUBMITTED 封死链上迭代，无权限提升 | rt-lit-feldman-keybias.ts |
| H2 BCS 歧义 | 碰撞存在（δ=8 移位）但不可利用（PoP 异钥验签失败 + digest 去重封死）；vector<u8> vs vector<address> uleb 互斥无歧义 | rt-lit-bcs-collision.ts |
| §8-Q2 ρ_i 跨会话 | 不可行：Δρ≠0 使份额单方程两未知数；nonce 清零闭合路径；validateCommitments 拒小阶/重复 | rt-lit-rho-crosssession.ts |
| G3 GCM 失败预言机 | 不可利用：重放零信息增益，篡改无梯度 | rt-lit-gcm-replay.ts |
| §9 密钥复用逐边 | 全部证伪或降级（attest key 独立、Shamir 隔离、PoP 绑 org/epoch、双栈自描述长度+前缀） | rt-lit-keyreuse-map.ts |
| §10 nonce 崩溃恢复 | 不可构造：内存态即焚，tab 崩溃 = self-DoS（3003 拦重建） | rt-lit-nonce-tab-recovery.ts |
| §11 侧信道 | 浏览器威胁模型不可达（bigint 非恒时但其消费的秘密在攻击者可计时时已可直接读取）；**若未来上 Node/原生服务端需升级 P1** | rt-lit-sidechannel-earlyreturn.ts |
| [新发现 P0] UI attest 死路径 | round7 链上加固后 UI 未同步（ArityMismatch）→ 已修（dkg-ceremony-dialog 接 computeDkgAttestationDigest） | UI tsc 0 错 |

脚本：scripts/rt-lit-*.ts ×11，全部可复跑（simulateTransaction，0 gas）。

## 红队执行清单（按优先级）

1. **F1/F2**：并发签名会话数 → 能否达到 ~190 触发自适应伪造？
2. **H2/§8.1**：BCS 长度前缀歧义 → 构造两段不同语义同哈希。
3. **D1**：Feldman 最后提交者的 key-bias 收益量化。
4. **§8.2**：ρ_i 不绑 session → 跨会话承诺替换。
5. **A6 vs A5**：P-256/X25519 双栈混淆。
6. **E1/E5**：链上 `ed25519_verify` 与 SDK 语义差异（构造链下通过/链上拒绝）。
7. **§9**：密钥复用逐边攻击。
8. **§11**：侧信道/early-return。
