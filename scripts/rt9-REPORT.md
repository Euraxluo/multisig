# ROUND-9 红队报告：索引未覆盖三项（T1/T2/T3）

> 执行人：RedTeamNine · 2026-11-13 · 全程实弹/仿真验证
> 脚本：`scripts/rt9-t1-resharing-mix.ts`（纯本地仿真）、`scripts/rt9-t2-silent-loss.ts`（testnet 实弹 + simulate）、`scripts/rt9-t3-dualstack.ts`（纯本地）
> 血统：`0x768e3781…`（当前 testnet 部署）。gas 实耗：session fee 0.005 SUI × 3 = **0.015 SUI**（bond 0.05×3 可退，<0.3 SUI 红线 ✅）

---

## T1：resharing 窗口混合攻击 — **部分可行**（窗口风险实锤 + dealer 校验缺口实锤；跨 epoch 混合签名证伪）

### (a) 被踢成员旧分片窗口有效性 — 可行，P0

**链上机制**（源码核对，`cryptographic_org.move` / `asynchronous_proposal.move`）：
- `org.group_pk` 仅被 `rotate_group_key` 改写；`advance_organization_epoch`（819 行）与 `update_organization_roster` 均不换钥。
- `execute_threshold_proposal` / `organization_treasury::execute` / `execute_transfer_proposal` 的摘要绑定**调用时**的 `org.group_pk` + `org.epoch_version`——resharing 保公钥换届后，**旧 epoch 分片对新摘要仍然有效**，直到 `rotate_group_key`。

**仿真证据**（rt9-t1 输出）：
```
[setup] resharing 保公钥: OK (m1=0x47bdd5d6…, m2=0xa832f13a…, m4=0x691d2803…)
[a] 被踢成员 m3(旧分片)+m1 旧组合签名 ed25519.verify = true
```
2-of-3 → GJKR resharing 踢 m3 加 m4 → **m3 的旧分片 + m1 仍签出通过 `ed25519.verify` 的聚合签名**。窗口 = resharing 完成 → `rotate_group_key` 上链之间。链上实弹对照：`scripts/dao-live-transfer.ts`（round-8 已证重共享后组钥签名可花真实 SUI）。

**结论**：GJKR resharing 只保护**密钥连续性**，不撤销旧持有人权限。被踢者若拒绝擦除旧分片，窗口内与任何一名新委员会成员合谋即可签出对国库/治理全部有效的签名（等于 t_old 没有真正缩小）。这与索引 §4「[待打] resharing 窗口内的混合攻击构造」正面命中。

### (b) 跨 epoch Shamir 线性组合 — 不可行（P2，防线确认）

```
[b] 混合签名聚合 = 抛错: [FROST1] Aggregate signature failed self-verification …
[b] 混合标量重构点 == groupPk? 不相等 — 跨 epoch Shamir 组合失效
```
旧分片（旧多项式）与新委员会分片（新多项式之和）的 Lagrange 组合产生两个互不相干的多项式值，标量级与签名级双重失败。`ThresholdSignerNode.aggregateSignature` 的自验兜底确保垃圾份额**永远不会**变成可提交的签名。

### (c) dealer honesty context 缺失 — 可行，P1（两处缺口）

1. **自洽假证明无 `expectedVerificationShares` 时全通过**：`verifyDealerHonestyProof` 只验证 Schnorr PoK 自洽（s·G == R + c·C）与 C == λ·Y 的内部一致性。攻击者任选 z\*，令 Y\* = λ⁻¹·C\*，即造出完全自洽的假证明：
```
[c2] 自洽假证明: 无 expectedY = 接受(缺口); 带 expectedY = 拒绝
```
2. **join 缺口（更严重）**：proof 的 `constantCommitment` 与 resharing 多项式承诺 `commitments[0]` 之间**SDK 不做强制比对**。恶意 dealer 持诚实身份（证明诚实、Y_i 正确），但投递毒化多项式（常数 z\* ≠ λ·s_i）：
```
[c4] 诚实证明+毒化多项式(带expectedY): finalize = 静默成功; 重算群公钥 == 真群公钥 = false (被毒化—join缺口实证)
[c3] 被污染 m4 分片参与签名 verify = false (抛错…); 带原公钥 = 拦截: Recomputed group public key does not match orig
```
- 无 `originalGroupPublicKey` 时（`finalizeNewShare` 可选参数）：**静默产出错误群公钥**，新成员以被毒化密钥入网。
- 传了 `originalGroupPublicKey` 时：**唯一防线**——重算不匹配即抛错。毒化者造成的是 DoS（拒绝服务）而非权限提升：毒化分片无法与诚实分片聚合出可用签名。
- 上下文绑定有效：跨 epoch/session 证明复用被拒（`[c1] 跨 context 证明被拒 = true`）。

**修复建议**：
1. `finalizeNewShare` 强制要求 `originalGroupPublicKey`（去可选化），并在 SDK 内部校验 `proof.constantCommitment == commitments[0]`（join 缺口闭合）。
2. 调用方（UI `dkg-ceremony-dialog` / 全链流程）必须传 `expectedVerificationShares`（从上一 epoch 链上记录读取每人的验证份额）。
3. **窗口问题（P0）**：resharing 完成后立即串联 `rotate_group_key`（V3 摘要已绑 new_signers/key_threshold，PoP 绑新钥），或链上在 resharing session finalize 时同步作废旧 epoch 分片的语义锚（把 `epoch_version` 与 group_pk 绑定进执行摘要）。

---

## T2：ECIES 份额静默丢失 — **可行**（P1：链上零校验投毒实锤；self-DoS 面，非污染面）

### 实弹证据（0x768e3781…，全部真实交易/simulate）

| 探测 | 结果 | digest |
|---|---|---|
| 毒信封 deposit（simulate） | **链上接受** | — |
| 10KB 纯随机 junk deposit（simulate） | **链上接受**（无长度/结构校验） | — |
| 向**未登记**加密钥的接收方投递（simulate） | **链上接受**（无登记检查） | — |
| A2 真承诺 + 毒信封实弹投递 | **EXECUTED** | `Dj2GX4ek1n8WsadGZgphKFyQtGEkhEsrxsSDGoRuLH5S`（本轮）；`BVCLCQqG…`、`57jRqHAj…`（复跑） |
| A1 登记 65B P-256 | EXECUTED | `HgDHtFYAu7BFt8TRaHFFqhwBqMti1EZ6X9HyWpAiLHYW` |
| A2 单方 confirm | EXECUTED | `CHHThuWWujtzY6fymCweJev5yycFbnaWS9ZXppZ9SgPC` |
| finalize（确认数 1 < 2） | **拒绝 abort 3002/3005** | — |

### (a) 结构合法垃圾信封 — 链上全收；后果是 self-DoS 而非份额污染

毒信封 = 攻击者用**受害者登记的 P-256 公钥**密封 32B 随机垃圾（AEAD 完全合法）。受害者本地：
```
[S1] 受害者解密: openShare 成功(AEAD 通过)，解出标量 0x5f88897f2d7b…，VSS 对照 A2 链上承诺 = false
```
关键分叉点：AEAD 解密**成功**（攻击者签名了密文但信封无发送方签名，X4 已知 DoS-only 面），垃圾份额被 VSS 承诺校验拦下 → 该 dealer 份额被丢弃（UI `broken` 列表，`dkg-ceremony-dialog.tsx:588`）。攻击者只毒化**自己的**那份投递，受害者收到的其余诚实份额不受影响 → **self-DoS/换届阻塞**：若 threshold 因这一份缺失而凑不齐，finalize 永久 3005，会话只能超时重开（bond 全退，攻击者成本≈0，受害者损失一轮时间）。**无法污染他人份额聚合**：`confirm_participant` 只确认「我对所有收到的份额验签过」，毒份额不进入受害者自己的聚合，其余成员各收各的信箱。

### (b) 双栈混合投递 — 链上全收，接收端显式报错（无静默失败）

```
[S2] A2 投递 X25519-JSON 信封(23B) 给 P-256 登记者: EXECUTED 8nUe5bYc2aKb7rY6F5WrzYbwwnUu7HPRt1zVu6T6P7H3
[S2] openShare 解析: 显式报错 — The share envelope is too short.
```
32/65 双栈在链上无差别接受；接收端解析全部 fail-closed（详证见 T3-b）。

**修复建议**：
1. `deposit_mailbox_share` 增加 payload 长度上限 + `recipient` 必须已 `register_encryption_key`（拦 junk 与盲投）。
2. 信封加发送方签名（或复用 commitBytes 摘要自证），把「解密成功」升级为「来源可归责」；或者至少在 UI 把 broken 份额的 sender 标红并允许投杆（slash 方案需经济模块）。
3. 受害者补救路径：垃圾份额只阻塞**该 dealer** 的确认；UI 已把 broken 降级为继续流程，配合超时重开会话即可恢复（成本 = 一轮时间，无资金损失）。

---

## T3：A5/A6 双栈深审 — **不可行（防线确认）**，一处规范漂移记 P2

### (a) P-256 WebCrypto 全流程

- sealShare→openShare 逐字节往返一致（137B 信封 = MAGIC 12 ‖ eph 65 ‖ nonce 12 ‖ ct 48）。
- 语义差异清单：
  - **cofactor**：WebCrypto P-256 `deriveBits` 输出 32B 大端 x 坐标，无效点在 `importKey` 即抛错（`Invalid keyData`），无小阶点退化路径；noble X25519 对全零/低阶公钥**不抛错**返回全零共享秘密——A5 已有 `assertNonZeroSharedSecret` 双侧拦截，A6 无此面。
  - **压缩点**：33B 压缩点被 `isSealableKey`/`importRecipientKey` 显式拒绝（链上登记长度 65B 与之对齐）。
  - **信封格式**：A6 原始字节定长头；A5 JSON 结构（`serializeEnvelopeToBytes`）。

### (b) 交叉解析（5 例全显式报错，无静默污染）

| 用例 | 结果 |
|---|---|
| A6 openShare ← A5 JSON 载荷 | 显式报错 `Not a share envelope of this protocol.`（MAGIC 检查） |
| A5 decrypt ← A6 二进制信封（65B eph 硬塞） | 显式报错 `"uCoordinate" expected Uint8Array of length 32, got length=65`（noble 解析层） |
| A6 openShare ← MAGIC+32B eph 混血 | 显式报错 `mailbox public key is not a 65-byte uncompressed P-256 point`（长度守卫） |
| noble x25519 ← 65B 输入 | 显式报错（同上，库层拒绝） |
| WebCrypto importKey P-256 ← 32B X25519 | 显式报错 `Invalid keyData` |

### (c) HKDF salt/info 对照 — **两栈完全不一致（设计事实，非漏洞）**

| | A5（packages/multisig mailbox） | A6（lib/dkg-mailbox） |
|---|---|---|
| salt | `"DKG_ASYNC_MAILBOX_SALT_V2"` 固定 26B | 每信随机 12B nonce |
| info/AAD | `utf8("SUI_DKG_MAILBOX_V1:") ‖ sessionId ‖ sender32 ‖ recipient32`（149B） | `JSON.stringify([MAGIC, sid, sender, recipient, epoch])`（225B） |
| 版本常量 | MAILBOX_AAD_V2 | SHARE_ENVELOPE_V1 |

后果：同一密文在两栈下解密结果**不可预测但永远失败**（派生钥不同 → GCM 认证失败），无共享密钥混淆面（cross-stack key confusion 不成立）。P2 记录：双栈并存期间同一会话必须全员同一栈，跨栈投递 = 定向份额丢失（已在 T2-b 验证链上无校验、端上 fail-closed）。

---

## P0 / P1 / P2 汇总

| 级别 | 发现 | 一句话 | 证据 | 修复 |
|---|---|---|---|---|
| **P0** | T1-a resharing 窗口旧分片有效 | 被踢成员旧分片在「resharing 完成→rotate_group_key」窗口内仍可签出对国库/治理全部有效的门限签名（与任一新成员合谋即可） | rt9-t1 `[a] ed25519.verify = true` + `dao-live-transfer.ts` 实弹先例 | resharing finalize 后立即强制 rotate_group_key；或执行摘要绑 group_pk+epoch 的生成代 |
| **P1** | T1-c dealer 校验 join 缺口 | `finalizeNewShare` 不比对 proof.C 与 commitments[0]；无 expectedY 假证明通过、无原公钥时静默毒化群公钥（传原公钥则降级为 DoS） | rt9-t1 `[c2][c3][c4]` | SDK 强制 join + originalGroupPublicKey 去可选化 + 调用方传 expectedVerificationShares |
| **P1** | T2-a 链上信箱零校验 | deposit_mailbox_share 不查长度/登记/结构，毒信封与 10KB junk 链上全收；受害者份额静默作废 → self-DoS（非污染），finalize 永久 3005 阻塞换届，攻击成本≈0 | rt9-t2 simulate×3 + 实弹 `Dj2GX4ek…`、`CHHThuWW…`、finalize 3002 | 链上加长度上限 + 收件人登记门禁；信封加发送方签名可归责 |
| **P2** | T3-c HKDF 双栈规范漂移 | salt/info/AAD 两栈完全不同（固定 26B vs 随机 12B；149B vs 225B），跨栈解密必然失败但无混淆面 | rt9-t3 `[c]` 字节级对照 | 双栈过渡期结束即裁撤 A5（或 A6），统一单栈 |
| **P2（证伪记录）** | T1-b / T3-a/b | 跨 epoch 混合签名不可行（标量级+签名级双失败）；双栈交叉解析 5/5 显式报错无静默；P-256 全流程正确 | rt9-t1 `[b]`、rt9-t3 `[a][b]` | 无需动作 |

**gas 实耗对账**：0.005 SUI × 3 sessions（fee 销毁）= 0.015 SUI；bond 0.05 × 3 = 0.15 SUI 已托管、10 分钟超时后 `claim_bond` 全额可退。实弹 tx digest 全部上文列出，均可于 testnet 复查。

---

## 修复回填（2026-11-14，第十一血统 0x4916084e93ee0323e1eff031b45ff83e70f7e19e7ad3d307ad498a20ed72b931）

| 发现 | 修复 | 验证 |
|---|---|---|
| **P0 T1-a** resharing 窗口旧分片有效 | `Organization.key_generation`（创建=1，rotate+1）；epoch-advance 摘要升 `SUI_ORG_EPOCH_ADVANCE_V2:`（+bcs(key_generation)）；treasury transfer 摘要升 `SUI_ORG_TREASURY_TRANSFER_V2:`（+bcs(key_generation)）→ rotate 一键封死窗口：旧分片对新 V2 digest 无效 | Move 413/413（含 `old_key_cannot_sign_post_rotate_transfer_digest` 2701、`old_advance_digest_cannot_replay_after_rotation`、`new_key_signs_post_rotate_advance_digest` 正控）；rt9-t1 复跑 join 缺口未复现 |
| **P1 T1-c** dealer join 缺口 | `finalizeNewShare` originalGroupPublicKey 去可选化（必传 32B）+ `proof.constantCommitment == commitments[0]` 内部强校验（DealerHonestyError）+ 重算-对照原公钥守卫转无条件 | rt9-t1 复跑：`[c3] 带原公钥 = 拦截`、`[c4] finalize = 拦截(originalGroupPublicKey is required)`；resharing.test.ts 毒化多项式用例抛 `constant commitment mismatch` |
| **P1 T2-a** 链上信箱零校验 | 未在本轮修复（需 Move 侧 deposit_mailbox_share 加长度上限+登记门禁，涉及信箱结构变更）→ 保持 open，作为下一轮 P1 | T2 实弹证据链已完整存档 |
| **P2 T3-c** HKDF 双栈漂移 | 规范性记录，UI 已加「重共享不吊销旧分片，必须立即 rotate」提示（i18n zh+en） | — |

SDK：digest V2 ×2（含 keyGeneration 必传）、reader 尾字段 keyGeneration、session drift 检查扩展、GroupKeyRotatedEvent 第 5 字段断言、frost-session FrostAction epoch 变体绑 keyGeneration；tsc 双域干净，295+ 测试绿。
