/**
 * 索引 §7-G3 — GCM 验证失败预言机：重放信封（同 ephemeral）多次失败验证是否泄露 GHASH？
 * 纯理论分析（GCM 认证失败无任何定时/内容侧信道可提取，128-bit tag 下 Ferguson 攻击不适用）。
 *
 * 结构回顾（packages/multisig/src/dkg/mailbox.ts）：
 *   key  = HKDF(sha256, x25519(sk_rec, eph_pub), SALT_V2, info=AAD, 32)
 *   ct   = AES-256-GCM(key, iv12, plaintext, AAD)
 *   AAD  = "SUI_DKG_MAILBOX_V1:" ‖ sessionId ‖ sender32 ‖ recipient32
 * 重放场景：攻击者把同一信封（同 ephemeral、同 iv、同 ct）投递 N 次给同一接收者：
 *   - decrypt 的共享秘密 = x25519(sk, eph) — 恒定；key 恒定；AAD 恒定（同 session/sender/recipient）
 *   - 每次验证结果完全相同（成功或失败）→ 无逐位 oracle（不像 padding oracle 的变量时序）
 *   - AES-GCM 的 GHASH 验证 = O(1) 常数时间比较（WebCrypto 内部实现，tag 全比较）
 * 信息泄露量：验证失败只给 1 bit（该信封有效/无效），且重复投递该 bit 恒定 →
 *   N 次重放的信息量 = 1 bit（恒同）— 零信息增益。
 * Ferguson (短 tag / 长消息) 与 Joux (nonce 重用) 的前提：
 *   - Ferguson: tag < 128 bit 或消息超长时，多次【伪造尝试】统计泄露 H·2^k 组合信息。
 *     我方 tag = 128 bit 满长 → Ferguson 攻击复杂度 > 2^128，不可用。
 *   - Joux: 需要同一 key 下【两个不同 (iv, ct)】→ 我方重放是同一 (iv, ct) → Joux 前提不成立。
 * 变体攻击：攻击者能否【改 ct】再投递（不同 ct 同 iv）→ GCM 认证失败；但每次失败给攻击者
 *   1 bit（这个改法成功吗）→ 逐 ct 篡改 = 2^(len·8) 次尝试暴力 → 128-bit tag 下每次成功
 *   概率 2^-128 → 无效。无「接近成功」的梯度（GCM 无 oracle 梯度，不像 CBC padding）。
 * 结论：验证失败预言机【不可利用】。唯一运营面 = 重放信封造成成员 UI 重复解密提示
 *   （DoS 骚扰层），产品层可加信封去重（session+sender+ephemeral hex 去重缓存）。
 * 定级：P2（无行动要求）。
 */
console.log(`GCM 验证失败预言机分析（纯理论，无实弹必要）：
  重放同信封 → 验证结果恒同 → 零信息增益；
  篡改 ct 暴力 → 每次 2^-128 成功率，无梯度 → 不可行；
  Ferguson/Joux 前提（短 tag / nonce 重用双样本）均不满足。
  定级 P2：建议产品层加信封去重缓存（防骚扰，非安全）。`);
