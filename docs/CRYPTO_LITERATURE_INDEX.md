# 密码学原语、文献与已验证性质索引

> 用途：把本项目实际使用的每一个密码学原语对应到其规范文献与已发表的攻击研究，并记录本项目对每类攻击的验证结论。已验证条目均可用仓库内脚本复现（见「验证记录」）。
> 维护：算法或参数变更时同步更新本文件。基准血统 `0x50739707…`（2026-11-13）。

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

**攻击文献与本项目结论**

| 文献 | 攻击点 | 本项目结论 |
|---|---|---|
| *Taming the Many EdDSAs* (ePrint 2020/1244) — https://eprint.iacr.org/2020/1244 | 各实现验证语义不一致（s 范围、cofactor、非规范编码）；跨实现共识分歧 | 授权一律基于内容摘要 + 单调 nonce，签名延展性不可二次消费；延展签名（s+L）链上直接拒绝（E_CODE 1010），链上/SDK 语义无分歧路径 |
| *The Provable Security of Ed25519* (IEEE S&P 2021) — https://zisc.ethz.ch/wp-content/uploads/2020/11/ed25519-SP.pdf | 非 SUF-CMA；Mt. Gox 式签名 mauling | 同上：不使用签名字节做标识 |
| *Ed25519 Quirks: Malleability* — https://quirks.ed25519.info/malleability | s+L 延展、R 点非规范 | 同上，链上拒绝 |
| *MystenLabs/ed25519-unsafe-libs* — https://github.com/MystenLabs/ed25519-unsafe-libs | 库级 nonce 复用/签名错误实现清单 | 项目所用 noble-curves 2.4.0 默认严格模式（zip215=false），不在该清单命中范围 |
| SIMD-0376 verify_strict 讨论 — https://simd.mixy.one/simd/0376-verify-strict | Sui 生态是否放宽 torsion 校验 | 链上 `ed25519_verify` 接受任意有效 Ed25519 公钥的签名（含 identity 公钥）；防线在应用层：PoP 验签天然拒绝异钥签名，attest/finalize 拉黑小阶公钥（E_CODE 3027），组织创建设门 |

---

## 2. FROST 门限签名（A2）

**规范**
- RFC 9591 (June 2024) — https://www.rfc-editor.org/rfc/rfc9591
- *FROST: Flexible Round-Optimized Schnorr Threshold Signatures* (SAC 2020) — https://eprint.iacr.org/2020/852

**攻击文献与本项目结论**

| 文献 | 攻击点 | 本项目结论 |
|---|---|---|
| *A Plausible Attack on the Adaptive Security of Threshold Schnorr* (ePrint 2025/1001) | ℓ > 0.725·log p 并发会话（≈190）下多项式时间伪造 | 不可达：ρ_i 哈希输入含 message + group_pk + 参与者自索引，跨会话多项式重写被阻断；UI 单 tab 串行会话，190×2×10s 量级的人工操作不可隐匿 |
| *On the Adaptive Security of FROST* (ePrint 2025/1061) | 自适应腐化 t_c ≤ t/2 的安全界限 | 少于 t 个参与者伪造不可行：nonce 单次使用后清零，ρ 绑定 message |
| *Dynamic-FROST* (ePrint 2024/896) | 动态委员会下 FROST 的安全前提 | 本项目 resharing 采用保公钥模式（换分片不换钥），与动态 FROST 前提的差异未逐条对照（见开放问题） |
| *Re-Randomized FROST* (ePrint 2024/1604) | 主动重随机化抵抗长期腐化 | 本项目无主动刷新；等价手段是 `rotate_group_key` 手动换钥 + `key_generation` 代际封窗（旧分片签不出新摘要） |
| *Pedersen DKG DoS in FROST* (Zcash Foundation 2024-02) — https://zfnd.org/pedersen-dkg-vulnerability-in-frost-distributed-key-generation-successfully-remediated | 恶意 dealer 的 DKG 拒绝服务 | DKG 会话有 bond + deadline + timeout 三重约束；grief 的经济成本未量化（bond 超时全退、无罚没，见开放问题） |
| *Attacks on Threshold Schemes: Part 1* (Hexens) — https://hexens.io/blog/mpc-attacks-p1 | 真实实现 bug：缺检查、缺证明、参数错误 | 实现级缺陷清单未逐条对照（见开放问题） |
| *Unidentifiability in Decentralized FROST* (CertiK) | 去中心化 FROST 的归责失效 | 申报（attest）要求 Round-1 公布钥的真签名，可归责到密钥持有者；mailbox 层无发送方签名（见开放问题） |
| *CGGMP21 Vulnerabilities Patched* (DFNS 2025-11) — https://dfns.co/article/cggmp21-vulnerabilities-patched-and-explained | 门限签名预签名/nonce 生命周期攻击 | nonce 单次清零 + 自校验，无跨签名 nonce 残留 |
| *Drijvers et al., On the Security of Two-Round Multi-Signatures* (S&P 2019) | ROS/Wagner 并发伪造 | 已从全局 ρ 改为逐参与者 ρ_i，配合会话不可达结论（上文 2025/1001 行） |
| GHSA-wgq8-vr6r-mqxm — https://vulnerability.circl.lu/vuln/ghsa-wgq8-vr6r-mqxm | 门限参数在刷新后不一致 | roster 与 key_threshold 联动校验，换届时门限与名册同步迁移 |

---

## 3. DKG / Feldman VSS（A3）

**规范**
- *Secure Distributed Key Generation for Discrete-Log Based Cryptosystems* (GJKR, EUROCRYPT'99 / J.Cryptology 2006) — https://link.springer.com/content/pdf/10.1007/s00145-006-0347-3.pdf
- *Feldman's Verifiable Secret Sharing for a Dishonest Majority* (ePrint 2024/031) — https://eprint.iacr.org/2024/031

**攻击文献与本项目结论**

| 文献 | 攻击点 | 本项目结论 |
|---|---|---|
| GJKR 原文 §"bias the output distribution" | 最后一个 dealer 可 biased 公钥分布 | 构造可行但收益≈0：2^7.9 次点加法只能偏置编码前缀，无权限提升；承诺一经提交不可改（E_ALREADY_SUBMITTED），链上迭代被封死 |
| *Rogue Key Attack on Gennaro DKG* (Sigma Prime) — https://blog.sigmaprime.io/dkg-rogue-key.html | 承诺未定死时的 rogue-key | 承诺不可改，rogue-key 不可行 |
| *Fully Secure DKG for Discrete Log Revisited* (ePrint 2026/042) | 标准 GJKR 的强安全缺口 | 本项目为 GJKR 形态，与强安全变体的差距未逐条对照（见开放问题） |
| fedimint DKG 文档（h_i 先广播防 bias）— https://docs.fedimint.org/crypto/dkg.html | 先广播承诺再揭示的必要性 | 满足：承诺先上链锁定，份额经加密信箱后置投递 |

**已知性质**： Feldman 承诺（无 Pedersen blinding）下，最后提交者理论上可偏置组公钥分布（上行已量化收益）；承诺只断言 `length >= 32`（不验结构），恶意 dealer 交垃圾会使接收方 VSS 校验失败、该份额作废——属定向可用性损失，不产生错误密钥。

---

## 4. Shamir / 拉格朗日（A4）

- 规范：Shamir 1979；Lagrange 插值标准结论。
- 相关文献：*Proactive Secret Sharing without Erasures* (ePrint 2026/1072) — https://eprint.iacr.org/2026/1072（长期腐化下分片累积）；CHURP (CCS'19) — https://par.nsf.gov/servlets/purl/10153196。
- 本项目结论：同一 epoch 内收集 ≥ t 分片即可重构（Shamir 固有性质）；跨 epoch 混合无效——`rotate_group_key` 递增 `key_generation` 后旧分片签不出新摘要，且 nonce 单调隔离重放。resharing 保公钥期间旧分片对新摘要仍有效，这是"换分片不换钥"模式的已知代价，由换钥（rotate）关闭窗口；密钥复用图谱逐边验证（§9）未发现可利用的混合构造。

---

## 5. X25519 ECIES（A5）

**规范**
- RFC 7748 (X25519) — https://www.rfc-editor.org/rfc/rfc7748
- *Implementing Curve25519/X25519* (Kleppmann) — https://martin.kleppmann.com/papers/curve25519.pdf

**攻击文献与本项目结论**

| 文献 | 攻击点 | 本项目结论 |
|---|---|---|
| *Small subgroup attacks* (PKC 2003) — https://iacr.org/archive/pkc2003/25670211/25670211.pdf | 低阶点使 DH 共享密钥退化 | `assertNonZeroSharedSecret` 双侧校验，小阶点被拒 |
| SafeCurves: Twist security — https://safecurves.cr.yp.to/twist.html | twist 攻击与小子群 | 同上 |
| *SCA-secure ECC in software* (ePrint 2021/1003) | 侧信道/故障攻击 | 浏览器威胁模型下不可达（见 §11）；服务端化需重评 |
| Crypto.SE: ECIES without sender auth — https://crypto.stackexchange.com/questions/83587/ecies-for-encrypting-ecdh-key-exchange | 无发送方认证 → 临时钥替换 | AAD 绑定会话与双方地址但无签名；结论为 DoS-only——接收端 VSS 校验 fail-closed，垃圾信封作废份额但不产生错误密钥。发送方归责缺失是已知边界（见开放问题） |

---

## 6. P-256 ECDH（A6）

- 规范：NIST SP 800-56A / FIPS 186-5；WebCrypto `subtle`。
- 已知状态：A5（X25519，32B 公钥）与 A6（P-256，65B 公钥）两套封装并存，链上双栈接受。公钥格式自描述（长度 + 前缀），未见自动混淆路径，但跨栈混淆面未做专项验证——这是本索引覆盖最薄弱的部分（见开放问题）。

---

## 7. AES-256-GCM（A7）

| 文献 | 攻击点 | 本项目结论 |
|---|---|---|
| *Authentication Failures in NIST version of GCM* (Joux 2006) — https://csrc.nist.gov/csrc/media/projects/block-cipher-technologies/documents/bcm/joux_comments.pdf | nonce 重用 → 认证密钥恢复 → 通用伪造 | IV 每次 `getRandomValues(12)` 独立抽取，96-bit 随机 IV 同 key 碰撞概率可忽略 |
| *Nonce-Disrespecting Adversaries* (WOOT'16, ePrint 2016/475) — https://eprint.iacr.org/2016/475 | 实现级 nonce 重用 | 同上 |
| GHASH 多次伪造（Ferguson） | 短 tag / 多次验证 | 128-bit tag，不适用 |

**验证失败预言机**：重放信封在 GCM 层验证失败，零信息增益；篡改无梯度。AAD 绑定 session 与双方地址，重放不可构造同 key+IV 组合。

---

## 8. HKDF / 域分隔 / BCS（A8–A10）

| 文献 | 攻击点 | 本项目结论 |
|---|---|---|
| Trail of Bits *Best practices for key derivation* (2025-01) — https://blog.trailofbits.com/2025/01/28/best-practices-for-key-derivation/ | salt/info 误用、跨上下文密钥复用 | V2 salt + info 绑定域‖会话‖双方地址 |
| *Comparse: Provably Secure Formats for Cryptographic Protocols* (2023) — https://www.twal.org/pdf/slides/2023_11_comparse.pdf | 字节格式歧义 → 跨类型混淆 | BCS 拼接存在 δ=8 移位意义上的碰撞，但不可利用：异钥 PoP 验签失败 + 摘要去重封死利用路径；`vector<u8>` 与 `vector<address>` 的 uleb 长度域互斥，无歧义 |
| FOKS *Signing data structures the right way* — https://blog.foks.pub/posts/domain-separation-in-idl/ | 结构体字段对齐导致的签名混淆 | 同上；7 个域常量前缀隔离跨域碰撞 |
| *Per-user encryption keys: length-extension trap and HKDF fix* — https://www.kirkabbott.com/writing/2026-08-07-per-user-encryption-keys-length-extension-and-hkdf | 直接哈希拼接的 length-extension | 密钥派生全部走 HKDF，无裸 hash 拼接 |

**ρ_i 输入域**：`SUI_FROST_BINDING_V1` 的 ρ_i 不含 session/epoch/org（与 RFC 9591 的 H4/H5 含 context 不同）。跨会话承诺替换不可行：Δρ≠0 使份额成为单方程两未知数，nonce 使用后清零，`validateCommitments` 拒绝小阶/重复点。

---

## 9. 密钥复用图谱（跨原语）

| 密钥 | 兼任角色 | 风险与结论 |
|---|---|---|
| 钱包 ed25519 | Sui 账户签名 + 可能被用作 attest key（若 UI 复用） | attest key 已改为会话级独立密钥（localStorage），与账户钥分离 |
| DKG 分片 s_i | FROST 签名 + resharing dealer + genesis stake 取回签名（经组钥） | 分片泄露不推导组钥（Shamir 隔离），伪造 PoP 需门限签名 |
| 组公钥 group_pk | FROST 验证 + PoP 主体 + 链上 org 身份 | 单点身份，泄露即组织身份失守——由设备侧密封存储防护 |
| ECIES X25519 静态钥 | 仅信箱解密 | 与 ed25519 分离 |
| P-256 前端钥 | 前端信箱 | 与 A5 并存，混淆面见 §6 |

逐边验证结论：全部证伪或降级（attest key 独立、Shamir 隔离、PoP 绑 org/epoch、双栈公钥自描述长度+前缀）。文献：*Taming the many EdDSAs* §key substitution。

---

## 10. 随机数（A11）

- 规范：NIST SP 800-90A/B；浏览器 `crypto.getRandomValues`。
- 攻击文献：*Mining your Ps and Qs* (USENIX 2012，弱 RNG 共模)；*Ron was wrong, Whit is right*（共享素数）。
- 本项目结论：nonce 用 `randomScalar()`（32B CSPRNG），IV 12B CSPRNG。nonce 为内存态、使用后即焚，tab 崩溃后无法恢复（3003 拦截重建）——崩溃恢复场景下的 nonce 复用不可构造，代价是 self-DoS。

---

## 11. 侧信道 / 实现层

- 文献：*SoK: SCA-secure ECC in software*（ePrint 2021/1003）；noble-curves 的常量时间声明与已知 issue。
- 本项目结论：浏览器威胁模型下侧信道不可达——bigint 运算非常量时间，但其消费的秘密在攻击者可计时的场景中已可直接读取（同源脚本）。**边界**：若未来将签名/派生迁移到 Node 或原生服务端，此结论失效，需按常量时间实现重评（`lagrangeCoefficient` 的 `mod` 归约、`parseValidPoint` 的 early-return）。

---

## 12. 真实世界事件对标

| 事件 | 教训 | 本项目对应 |
|---|---|---|
| Mt. Gox（Ed25519 malleability） | 用签名字节做唯一标识 | 用内容摘要 + 单调 nonce |
| Typus Finance 2025-10（Sui 共享对象，$3.44M） | 共享对象缺单例门禁 | `assert_org_not_created`（3026） |
| Zcash FROST DKG DoS（2024-01） | DKG 可被 grief | bond + deadline + timeout + claim |
| CGGMP21 漏洞（2025-11 披露） | 门限签名的预签名/份额生命周期 | nonce 单次清零 |
| Wormhole / Ronin（多签密钥泄露） | 门限/多签的运营安全 | 运维面防护属部署问题（见 `SECURITY_REVIEW.md` H-01） |

---

## 开放问题

以下攻击面/文献尚未完成针对性验证，为当前已知的未覆盖范围：

- **P-256 / X25519 双栈并存**的跨栈混淆面（§6）——索引中覆盖最薄弱项。
- **DKG grief 经济成本量化**（§2 Zcash 行）：bond 超时全额退还、无罚没，恶意拖延的成本仅为 gas。
- **文献逐条对照未完成**：Dynamic-FROST 前提差异（§2）、GJKR 强安全变体差距（§3）、Hexens 实现缺陷清单（§2）、Kudelski FROST 审计清单（https://docs.rs/crate/lit-frost/latest/source/audit/）。
- **服务端化重评**：签名/派生迁移到 Node 或原生环境时，常量时间与侧信道结论需按 §11 边界重做。
- **mailbox 发送方签名归责**：链上只存密文，无发送方签名（对应 `SECURITY_REVIEW.md` R-02）。

## 验证记录

上述"本项目结论"中标注可复现的条目，验证脚本为 `scripts/rt-lit-*.ts`（×11，`simulateTransaction`，0 gas，2026-11-13 执行）：

| 结论 | 脚本 |
|---|---|
| F1/F2 并发会话与自适应伪造不可达 | `rt-lit-f1-concurrent-sessions.ts` |
| Ed25519 延展/identity 公钥/小阶黑名单（3027） | `rt-lit-ed25519-verify.ts`、`rt-identity-block.ts` |
| noble-curves 2.4.0 不在 unsafe-libs 清单 | `rt-lit-noble-unsafe-libs.ts` |
| Feldman key-bias 收益≈0 | `rt-lit-feldman-keybias.ts` |
| BCS δ=8 碰撞不可利用、uleb 互斥 | `rt-lit-bcs-collision.ts` |
| ρ_i 跨会话替换不可行 | `rt-lit-rho-crosssession.ts` |
| GCM 验证失败预言机不可利用 | `rt-lit-gcm-replay.ts` |
| 密钥复用图谱逐边 | `rt-lit-keyreuse-map.ts` |
| nonce 崩溃恢复不可构造（3003 拦截） | `rt-lit-nonce-tab-recovery.ts` |
| 浏览器侧信道不可达 | `rt-lit-sidechannel-earlyreturn.ts` |
