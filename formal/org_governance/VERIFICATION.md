# org_governance 验证记录

对象：`contracts/agent_vault/sources/cryptographic_org.move` 的五条治理入口
（`advance_organization_epoch`、`rotate_group_key`、`update_organization_roster`、
`withdraw_genesis_stake`、`execute_threshold_proposal`），以 origin/main `a4396c1` 为准。

复跑：`formal/org_governance/run.sh`（TLC 三配置 + 探针），Alloy 用
`scripts/alloy_run.sh formal/org_governance/Governance.als`。

## 模型假设与代码依据

1. **签名 = 摘要绑定的字段元组。** 真实验签是 `sui::ed25519::ed25519_verify`，模型不重算曲线。
   忠实性由 `repro_probe.mjs` 兜底：对 SDK 的 `compute*Digest`（与 Move 逐字节同布局，
   由 `golden-vectors.test.ts` 钉住）断言"改一个绑定字段，摘要必变"。探针 6/6 通过。
2. **旧分片永不过期，除非换钥匙。** `docs/RESHARING_SECURITY.md` §3.2：保钥匙的 resharing
   不改变秘密，因此旧分片签出的签名在换届后仍然验得过。模型里 `VerifiesNow` 直接编码这一点，
   `AdvanceSurvivesResharing` 把它变成一条被检查的性质，而不是一句注释。
3. **nonce 单调使 `executed_proposals` 表在重放上是冗余的。** 五条入口都先查
   `nonce > org.last_nonce`（`:620`、`:660`、`:704`、`:797`、`:913`），通过后写 `last_nonce`。
   表只在"两条不同入口撞同一个摘要"时多一层保护；入口之间域常量不同
   （`cryptographic_org.move:18-31`），Alloy 的 `DomainSeparation` 证明五条入口绑定的字段集两两不同。
4. **权重算术收成一个布尔。** `thresholdBelowKey` 对应 `:899` 的 `E_THRESHOLD_BELOW_KEY`，
   `excludesSigner` 对应 `:908` 的 `EKeySignerRemoved`。精确的权重求和在
   `cryptographic_org_roster_tests.move` 里测，不在这里重复。

## 期望表

| 配置 | 期望 | 含义 |
|---|---|---|
| `current.cfg` | ok | 代码现状，七条不变量全部成立 |
| `isolation.cfg` | fail | 去掉名册的两道守卫后，`NoSignerOutsideGovernance` 被打破 |
| `broken.cfg` | fail | 轮换摘要不再绑定新钥匙后，`RotationBindsNewKey` 被打破 |

`GovernanceCoversKeyThreshold` 在 isolation 上同样被打破，单独用一版配置确认过
（`RosterUnguarded` 一步即达 `thresholdBelowKey = TRUE`）。两条守卫各自承重，不是同一条的两种写法。

破坏演练在 Alloy 上重复了一次：从 `binds` 删掉 `Rotate -> FNewPk`，`RotationBindsItsKey`
立即给出反例。没见过红的检查不作数。

## 不变量与条款

| 不变量 | 钉住的条款 | 反例形态（在破坏变体上） |
|---|---|---|
| `NoSignerOutsideGovernance` | `RESHARING_SECURITY.md` §4 模式表；`:997` `key_signers_retained` | 一步 `RosterUnguarded(1, "roster_drop_signer")`：钥匙没换，签名者已被移出名册 |
| `GovernanceCoversKeyThreshold` | `:892-899`，issue #15 | 一步 `RosterUnguarded(1, "roster_low_threshold")` |
| `RotationBindsNewKey` | `:510-528` `compute_key_rotation_digest`，issue #23 | `RotateUnbound` 把 `"unbound"` 写进摘要，状态里的钥匙却任选 |
| `AdvanceBindsKeyGeneration` | `:562-578`，round 9 `:833-837` | 绑定在签发时的 `key_generation`，轮换后旧摘要对不上 |
| `GenesisStakeHardLock` | `:687-706`，`E_GENESIS_LOCKED = 1011` | `stake = taken` 只在 `now >= unlockAt` 之后出现 |
| `NonceMonotonic` | `:620` 及五处同源检查 | 签名序列的 nonce 严格递增 |
| `AdvanceSurvivesResharing` | `RESHARING_SECURITY.md` §3.2，接受的残余 | 换届后、换钥匙前，旧 advance 签名仍然验得过 |

## 已知局限

- **dealer 诚实性不在链上。** Sui Move 只暴露 `ed25519_verify`，没有曲线点乘，所以
  resharing 时 dealer 的多项式常数项是否等于其分片，合约无法校验。`RESHARING_SECURITY.md` §6
  把它放在链下 Schnorr PoK。Alloy 的 `GapDealerHonestyOffChain` 把这个排除明确记成一条断言，
  防止以后有人把"模型通过"说成"dealer 诚实性已证明"。
- **创世质押金额收成一笔。** 模型只证明"锁定期前取不出、只能取一次"，不证明部分提取的金额守恒。
  金额守恒由 Move 的 `balance::split` 类型保证，不需要模型。
- **DKG 会话最终化、PoP 字节长度、名册形状**（`:782-795`、`:876-893`）是准入过滤，
  模型里不满足这些的转换根本不启用。它们由 `org_pop_tests.move` 覆盖。
- **TLC 是有界的。** `Keys` 2 把、`Nonces` 3 个、时钟 0..2。结论是"在这个范围内没有反例"，
  不是"对任意规模成立"。nonce 单调和摘要绑定这两条的论证不依赖界的大小。
