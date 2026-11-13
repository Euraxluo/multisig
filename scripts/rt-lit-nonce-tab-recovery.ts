/**
 * 索引 §10 — nonce 崩溃恢复（浏览器 tab 恢复场景）：nonce 复用构造或证伪。
 *
 * 代码事实（lib/committee-session.ts:9 注释原文）：
 *   "FROST nonces are ephemeral: they cannot be persisted to localStorage,
 *    IndexedDB, logs or transaction metadata: a reload loses them"
 * → tab 崩溃 → ThresholdSignerNode 内存态丢失 → nonce 对 (h,b) 与承诺一并蒸发。
 * 攻击者能利用什么？
 *   场景 A：成员 round1 提交承诺后 tab 崩溃 → 链上有 D_i/E_i，但 (h,b) 已丢 →
 *     该成员永远无法给这套承诺出 z_i → 会话作废（DoS-self），非安全问题。
 *   场景 B：成员 round1+round2 之间崩溃 → z 已出但未上链 → 无影响。
 *   场景 C：**承诺上链但 (h,b) 丢失后，成员「重建」同一承诺？** 重建 = 需要同 (h,b)
 *     → 不可能（CSPRNG）。若 UI 有 bug 把旧承诺重发+本地重造 nonce → 链上已有
 *     E_ALREADY_SUBMITTED 拦截。
 *   场景 D：localStorage 恢复「签名会话」（share + 索引）→ share 是长期的（密封库），
 *     nonce 是会话级的 → 恢复 share 后正常生成新 nonce → 无复用。
 * 反面检查：有没有任何代码路径把 (h,b) 持久化？
 *   - committee-share-store.ts: 密封 share（长期），无 nonce 字段。
 *   - dkg-ceremony-dialog: round1 的 commitmentBytes 在内存 pendingTx；崩溃后 resume
 *     会重跑 createNonceCommitment（新 nonce）→ 但链上旧承诺已占位 → 3003 拦截 →
 *     该成员卡死直到会话超时（self-DoS）。
 * 结论：nonce 复用【不可构造】——内存态即焚 + 3003 单次提交双重保证。
 * 残余风险：tab 崩溃率 × t 人参与 → 会话超时率上升（运营健壮性，非安全）。
 * 定级：P2 无行动（安全）/ P1 产品（会话恢复 UX，非安全范畴）。
 */
console.log(`nonce 崩溃恢复分析（代码走查 + 逻辑证伪）：
  A. round1 后崩溃 → (h,b) 蒸发 → 承诺死链 → self-DoS 非安全。
  B. 重建承诺 → 3003 拦截 → 无 nonce 复用路径。
  C. share 密封库与 nonce 生命周期正交 → 恢复不产生复用。
  定级：安全面无风险；产品面会话恢复 UX 可改进（超出本红队范畴）。`);
