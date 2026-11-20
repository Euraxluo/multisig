# 形式化验证报告 · cryptographic_org 治理状态机

范围：origin/main `a4396c1` 上 `contracts/agent_vault/sources/cryptographic_org.move`
的五条治理入口。复跑入口 `formal/org_governance/run.sh`，记录见 `VERIFICATION.md`。

## 1. 覆盖表

| 对象 | 已有手段 | 缺口 | 本次补的层 |
|---|---|---|---|
| 摘要字节布局（9 个域） | `golden-vectors.test.ts` + CI `git diff --exit-code` | 无 | 复用，不重复建 |
| 单条入口的拒绝路径（nonce、PoP、名册形状） | 317 个 `#[test]`，分布在 16 个测试文件 | 只覆盖单笔交易，不覆盖交易交错 | 不动，TLA+ 不重测这些 |
| 换届 / 轮换 / 名册 / 质押提取的交错 | 无 | 状态机层面没有任何检查 | TLA+，七条不变量，4968 个可达状态 |
| 摘要绑定的字段集、谁有权驱动入口 | 只散落在注释里 | 没有结构断言 | Alloy，8 条 check + 4 条 run |
| dealer 诚实性（resharing 多项式常数项） | 链下 Schnorr PoK，`RESHARING_SECURITY.md` §6 | 链上无法校验，Sui Move 没有曲线运算 | Alloy `GapDealerHonestyOffChain` 把它记成排除，不当成已证 |
| 设计文档自身的完备性 | 无 | 文档没被拷问过 | 拷问-观察，见第 3 节 |

文字规则只剩一条：接受"保钥匙换届后旧分片仍然有效"这个残余。它不是没检查，
`AdvanceSurvivesResharing` 把它验证为一条**成立的**性质，防止以后有人误改 `advance`
去换钥匙。

## 2. 模型结论

### TLA+（`Model.tla`，TLC 2.19）

`current.cfg` 无违反。两条破坏配置按预期打红，反例都是最短路径：

- `isolation.cfg` 去掉 `update_organization_roster` 的两道守卫（`:908` `key_signers_retained`、
  `:899` 门限下限）。第一步 `RosterUnguarded(1, "roster_drop_signer")` 就让一把仍在生效的钥匙
  的持有者被移出名册，`NoSignerOutsideGovernance` 失败。单独再跑一次，
  `RosterUnguarded(1, "roster_low_threshold")` 一步让 `GovernanceCoversKeyThreshold` 失败。
  两道守卫各自承重。
- `broken.cfg` 让轮换摘要不再绑定新钥匙（issue #23 修复前的形状）。`RotateUnbound`
  把常量 `"unbound"` 写进摘要，状态里的钥匙却任选，`RotationBindsNewKey` 失败。

| 不变量 | 条款锚点 | 在 current 上 |
|---|---|---|
| `NoSignerOutsideGovernance` | `RESHARING_SECURITY.md` §4；`:997` | 成立 |
| `GovernanceCoversKeyThreshold` | `:892-899`，issue #15 | 成立 |
| `RotationBindsNewKey` | `:510-528`，issue #23 | 成立 |
| `AdvanceBindsKeyGeneration` | `:562-578`，round 9 `:833` | 成立 |
| `GenesisStakeHardLock` | `:687-706`，错误码 1011 | 成立 |
| `NonceMonotonic` | `:620` 及五处同源检查 | 成立 |
| `AdvanceSurvivesResharing` | `RESHARING_SECURITY.md` §3.2 | 成立（这是被接受的残余，不是缺陷） |

`repro_probe.mjs` 把三条反例序列搬回实现：对 SDK 的 `compute*Digest` 断言"改绑定字段摘要必变"，
6/6 通过，外加一条确定性对照防止断言因为函数不纯而空过。

### Alloy（`Governance.als`，Alloy 6）

8 条 check 无反例，4 条 run 都找到实例，所以量化前提不是空的。

| 断言 | 保证的事 |
|---|---|
| `CommonBinding` | 五条入口的摘要都含 chain、org、epoch、nonce |
| `RotationBindsItsKey` | 轮换摘要含新钥匙 |
| `AdvanceBindsGeneration` | 换届摘要含 `key_generation` |
| `RosterBindsComposition` | 名册摘要含成员、权重、门限 |
| `DomainSeparation` | 五条入口绑定的字段集两两不同，签名不能跨入口重放 |
| `OnlyTheGroupKeyAuthorizes` | 五条入口只认 `org.group_pk` 下的签名 |
| `NoMemberBackdoor` | 普通成员和局外人一样驱动不了任何入口 |
| `GapDealerHonestyOffChain` | 模型**不**声称证明了 dealer 诚实性 |

破坏演练：从 `binds` 删掉 `Rotate -> FNewPk` 后，`RotationBindsItsKey` 立即给出反例。

边界标注：ed25519 曲线运算、BCS 布局、nonce 单调性是 ExcludeSafe（分别由 TLA+ 和 golden vector 覆盖）；dealer 诚实性是 ExcludeRisky，由 GapDealerHonestyOffChain 明示；没有 Stub。
## 3. 拷问缺口

出题按 design-tree 只取前沿：前置已落定、现在就能问的十题，覆盖失败模式、并发乱序、
权限边界、状态机角落、数据一致性。核对交给 `judge`（独立于本会话的小模型，逐题给
handled / mentioned / absent），本会话用回源文抽查了两个 handled 判定，都站得住：
q4 对应 §1 第 15 行与 §3.2，q5 对应 §6 第 194 行与第 207 行。

| 题 | 判定 | 文档位置 | 回流 |
|---|---|---|---|
| q1 相同 nonce 的两笔 advance 并发提交会怎样 | mentioned | §5.1 只说 nonce 单调，没说并发时一笔落地另一笔 abort | 补文档。结论已由 TLA+ `NonceMonotonic` 覆盖：共享对象串行化下第二笔读到已更新的 `last_nonce`，必然 abort |
| q2 轮换与换届同时在途，换届签名先于轮换产出 | absent | 无 | 已有模型。`AdvanceBindsKeyGeneration` 证明轮换抬高 `key_generation` 后，旧换届摘要失效。文档应补一句指向该机制 |
| q3 谁能调用 advance / rotate，非成员可否 | mentioned | §4 表说"当前纪元门限签名"，没说非成员被拒 | 补文档。Alloy `NoMemberBackdoor` 已证非成员与局外人等价 |
| q4 被移除的成员拒绝删除分片再串谋 | handled | §1 第 15 行、§3.2、§4：resharing 做不到敌意撤销，出路是 `rotate_group_key` | 无需回流 |
| q5 dealer 提交常数项不等于真分片的多项式 | handled | §6 第 194 行说明动机，第 207 行给出后果：验不过的 dealer 被排除出合格集 | 无需回流。注意这是链下检查，见第 4 节 |
| q6 换届签名能否在其纪元过去后重放 | mentioned | §5.1 列了摘要字段，没直说"过期纪元的签名失败" | 补文档。TLA+ `NonceMonotonic` 加摘要绑定 epoch 已覆盖 |
| q7 换届仪式做到一半被放弃，部分成员已持新分片 | mentioned | §2.3 说钥匙不变，但没说半途而废时旧分片仍是权威 | 补文档。链上钥匙只在 advance 落地时变化，放弃等于没发生 |
| q8 纪元 e 下签的提案在进入 e+1 后怎样 | mentioned | 纪元递增写了，对在途提案的影响没写 | 补文档。提案摘要绑定 epoch（`compute_proposal_digest` `:535`），过期纪元的提案验不过 |
| q9 纪元能否无限递增，溢出怎么办 | mentioned | `epoch_version` 出现多次，没有任何上界说明 | 登记为接受的残余。u64 溢出需要 2^64 次换届，gas 成本使它不可达；不建模型 |
| q10 创世质押的硬锁能否被门限签名或换届绕过 | absent | 全文未提创世质押 | 补文档。代码在 `:705` 用 `E_GENESIS_LOCKED` 强制，TLA+ `GenesisStakeHardLock` 已证锁定期前取不出。文档应把这条写出来 |

十题里没有需要新模型的缺口：两处 absent 都已有现成的不变量，缺的是文档句子。
q9 是唯一留在文字层的，理由是它在物理上不可达。


## 4. 未验证声明

- **dealer 诚实性**。链上无曲线运算，合约无法校验 resharing dealer 的多项式常数项。
  现靠链下 PoK 和"诚实多数"假设。这是已知缺口，不是被验证为安全。
- **创世质押的金额守恒**。模型把质押收成一笔，只证"锁定期前取不出、只能取一次"。
  部分提取的金额由 `balance::split` 的类型保证，没有单独证明。
- **有界性**。TLC 用 2 把钥匙、3 个 nonce、时钟 0..2。结论是这个范围内无反例，不是任意规模。
  nonce 单调和摘要绑定两条的论证不依赖界的大小。
- **DKG 会话的准入与最终化**（`dkg_committee.move`，1145 行）不在本次范围内。
- **国库转账摘要 V3**（`organization_treasury.move`）绑定 `vault_id` 与 `key_generation`，
  本次只验证了 `key_generation` 在组织侧的递增，没有重跑国库那一侧的重放论证。
