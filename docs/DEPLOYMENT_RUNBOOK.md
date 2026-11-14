# 生产部署 Runbook（Agent Vault / Multisig）

> 适用范围：`contracts/agent_vault`（Move）、`packages/multisig`（SDK）、Web 前端、Vercel 托管。
> 当前血统：`0xcdc87b8ef5b071a293966f4329f1e9b4a443f49f1cf599cc188009cf7524ab44`（testnet，包对象链上 EXISTS，version = 1）
> 最后实测：Move 测试 421/421 全绿；SDK `tsc` 干净；`next build` 成功（9/9 静态页）；Vercel Production Ready（HTTP 200）。
> 本文中 `[已实测]` 表示本次发布流水线实测通过，`[需人工]` 表示必须由值班人手工确认。

---

## 1. 发布前置检查表

| # | 检查项 | 期望值 | 方法 | 状态 |
|---|--------|--------|------|------|
| 1 | `sui` CLI 版本 | 1.82.1（与 `Published.toml` 的 `toolchain-version` 对齐） | `sui --version` | [需人工] |
| 2 | Move 框架 pin | `rev = 8fc60f1fa966e90398c93beb67ad4f42992889c7`（对应 mainnet-v1.74.1，见 `contracts/agent_vault/Move.toml:7`） | `grep -n rev contracts/agent_vault/Move.toml` | [已实测] |
| 3 | Node.js 版本 | ≥ 20（Vercel 构建一致） | `node -v` | [需人工] |
| 4 | 依赖安装 | lockfile 无漂移 | `pnpm install --frozen-lockfile` | [需人工] |
| 5 | Move 单元测试 | **421/421 全绿** | `cd contracts/agent_vault && sui move test` | [已实测] |
| 6 | SDK 类型检查 | `tsc` 无错误 | `pnpm --filter @multisig/sdk tsc --noEmit` | [已实测] |
| 7 | 前端构建 | 成功，9/9 静态页 | `pnpm build`（next build） | [已实测] |
| 8 | Vercel 部署 | Production Ready，HTTP 200 | 平台面板 + `curl -I` | [已实测] |
| 9 | 链上包对象 | `EXISTS`，version 1 | `sui client object 0xcdc8...4ab44` | [已实测] |
| 10 | 发布 gas 余额 | **≥ 1.0 SUI**（安全边际） | `sui client gas` | [需人工] |
| 11 | 部署者地址 | 非共享/非多签地址，私钥在硬件钱包或 KMS | 人工核对 | [需人工] |
| 12 | UpgradeCap 持有者 | 见第 3 节（当前为单地址 EOA，审计 H-01） | `sui client object 0x6e73...72f8` | [需人工] |

### Gas 预算说明

实测历史：**0.39 SUI 余额发布失败**（gas 不足）；**0.7 SUI 余额发布成功**。综合建议：

- 发布（publish）总消耗约 **0.4 – 0.8 SUI**（含 storage rebate 波动）。
- 发布命令显式 `--gas-budget 800000000`（0.8 SUI），余额应 ≥ **1.0 SUI** 以防余额检查通过但执行期中断。
- 老包对象与历史数据**不会**因发布新包而释放，不可把 rebate 计入可用余额。

---

## 2. 发布步骤

### 2.1 环境变量清单

前端（Vercel Project → Settings → Environment Variables，**Production 与 Preview 都要配**）：

| 变量 | 说明 | 本次是否变更 |
|------|------|--------------|
| `NEXT_PUBLIC_AGENT_VAULT_PACKAGE_ID` | 本次发布的核心包 ID | **是（必须同步）** |
| `NEXT_PUBLIC_GOVERNANCE_PACKAGE_ID` | 治理包 | 否 |
| `NEXT_PUBLIC_ORGANIZATION_TREASURY_PACKAGE_ID` | 组织金库包 | 否 |
| `NEXT_PUBLIC_PROPOSAL_PACKAGE_ID` | 提案包 | 否 |
| `NEXT_PUBLIC_IDENTITY_PACKAGE_ID` / `NEXT_PUBLIC_IDENTITY_NAMES_ID` | 身份与命名 | 否 |
| `NEXT_PUBLIC_RED_PACKET_V2_PACKAGE_ID` | 红包 v2 | 否 |
| `NEXT_PUBLIC_SCHEDULED_PAYMENTS_PACKAGE_ID` | 定期支付 | 否 |
| `NEXT_PUBLIC_WALRUS_APP_POLICY_PACKAGE_ID` / `NEXT_PUBLIC_WALRUS_APP_REGISTRY_ID` | Walrus 策略 | 否 |
| `NEXT_PUBLIC_USDT_COIN_TYPE` | 计价币种 | 否 |
| `NEXT_PUBLIC_PRICE_FEED` / `NEXT_PUBLIC_PRICE_FEED_URL` | 价格源 | 否 |
| `NEXT_PUBLIC_SSM_RELAYER_URL` / `NEXT_PUBLIC_SSM_SEAL_KEY_SERVERS` | SSM / Seal 中继 | 否 |
| `NEXT_PUBLIC_ENABLE_DEV_KEYSTORE` | **生产必须为 `false`** | 否（确认） |

> 注意：`NEXT_PUBLIC_*` 会被内联进客户端 bundle，改完必须**重新构建**，仅改 env 不生效。

### 2.2 执行发布

```bash
# 1) 确认网络与地址
sui client active-env          # 必须是 testnet
sui client active-address      # 与 Published.toml 的发布者一致

# 2) 发布（跳过依赖校验，使用 pin 的框架 rev 已在本机构建过全绿）
cd contracts/agent_vault
sui client publish --skip-dependency-verification --gas-budget 800000000
```

从输出中记录：`packageId`（本次新包）、`upgradeCap` 对象 ID、`transaction digest`。**把 digest 写进发布单**。

### 2.3 发布后四处同步（缺一不可）

```bash
# ① SDK 常量
packages/multisig/src/agent-vault/org/constants.ts
    export const AGENT_VAULT_PACKAGE_ID = '0x<新包ID>';

# ② Move 发布记录（sui client publish 会自动更新，需确认并提交）
contracts/agent_vault/Published.toml
    [published.testnet] published-at / version / original-id

# ③ 测试 fixture / 脚本
scripts/rt9-t2-silent-loss.ts（及各集成测试里内联的旧包 ID）

# ④ 前端环境变量（Vercel）
NEXT_PUBLIC_AGENT_VAULT_PACKAGE_ID = 0x<新包ID>
```

校验旧 ID 残留：`grep -rl "0xcdc87b8ef5b071a293966f4329f1e9b4a443f49f1cf599cc188009cf7524ab44" --exclude-dir=node_modules --exclude-dir=.next --exclude-dir=build .`，除 `Published.toml` 的 `original-id` 与历史文档外应无命中。

### 2.4 四道门禁验证（按顺序，一票否决）

| 门禁 | 命令 / 动作 | 通过标准 |
|------|-------------|----------|
| G1 合约 | `sui move test` | 421/421 全绿 |
| G2 SDK | `pnpm --filter @multisig/sdk tsc --noEmit` | 0 error |
| G3 构建 | `pnpm build` | 成功，9/9 静态页 |
| G4 线上 | `curl -I https://<生产域名>` + 页面实际发起一次只读 RPC（如 `getObject` 新包 ID） | HTTP 200 且返回 `EXISTS` |

G4 额外要求：在 UI 中打开一次 Agent Vault 页面，确认 SDK 读到的是新包（可对比页面展示的 package id 与 `NEXT_PUBLIC_AGENT_VAULT_PACKAGE_ID`）。

---

## 3. 升级策略

### 3.1 现状与风险（审计 H-01）

- 升级由 **`UpgradeCap` 单地址 EOA 持有**（`Published.toml` → `upgrade-capability = 0x6e737a652c7b660869768ad07c06309e62b4a50404a05562b91d7d1459f072f8`）。
- **风险**：一把私钥即可全量升级逻辑，绕过任何治理/多签流程；私钥泄露 = 协议被完全接管；私钥丢失 = 永不可升级（见第 6 节）。
- 这是已知的审计发现，属于可接受的**过渡态**，但不得长期保持。

### 3.2 建议：封入门限 wrapper

1. 部署一个治理控制的升级 wrapper：`UpgradeCap` 转入一个「提案 → 多签批准 → 执行 upgrade」的模块（Movable 模式）。
2. `make_immutable` 之前**不要**承诺不可升级；先完成 wrapper 迁移。
3. 迁移时将 `UpgradeCap` 作为共享/受控对象存入 wrapper，并把原 EOA 降级为「只能发起提案」的角色。
4. 每季度演练一次「wrapper 内升级 → 回滚」流程，保持 capacity。

### 3.3 policy 从 `compatible` 收紧的后果

当前 upgrade policy 为 **`compatible`**（默认）。若收紧：

- `compatible` → `additive` / `dependency`：**不可逆**。此后任何不满足收紧策略的升级（改函数签名、改结构体字段、删函数）会被链上直接拒绝，只能靠新包 + 数据迁移。
- 收紧前必须逐项审计下一次变更的字节码兼容性（`sui move build` 后对比 ABI）。
- 不要在紧急修复窗口内改 policy——收紧后你可能失去唯一的修复通道。
- 建议方向：先在 wrapper 中承载治理，再考虑 policy 收紧；如需最终冻结（`immutable`），须提前 30 天公告并完成全部数据迁移演练。

---

## 4. 密钥瓷典（Capability 管理）

### 4.1 Capability 清单（源自 `contracts/agent_vault/sources/vault.move`）

| Cap | 定义位置 | 能力 | 持有者 |
|-----|----------|------|--------|
| `MasterCap` | `vault.move:66`（`has key, store`） | 最高权限：配置 Operator/Agent、改策略 | 组织多签或冷钱包 |
| `OperatorCap` | `vault.move:74`（`has key`，**不可 store**） | 运营操作，绑定地址 | 运维主体 |
| `AgentCap` | `vault.move:84`（`has key`，**不可 store**） | 代理执行，绑定地址 | 单 Agent |
| `SubagentCap` | 运行时签发（`SubagentCapIssuedEvent` / `SubagentCapRevokedEvent`） | 子代理临时权限，可撤销 | 按会话签发 |
| `UpgradeCap` | `0x6e73...72f8` | 包升级 | **单地址 EOA（H-01 风险）** |
| DKG 分片 | 链下生成，链上仅登记公钥（`EncryptionKeyRegisteredEvent`） | 门限解密 | 各委员独立持有 |

> `OperatorCap` / `AgentCap` 均 `has key` 而**无 `store`**，意味着不能放进容器/共享对象转移——只能由指定地址持有，丢失即需重新签发。

### 4.2 生成 · 存储 · 备份 · 丢失处置

| 阶段 | MasterCap | OperatorCap / AgentCap | DKG 分片 |
|------|-----------|------------------------|----------|
| 生成 | 发布后由 `MasterCap` mint；生成于离线机 | 由 MasterCap 按地址签发 | 委员本地 DKG 生成，**分片永不上链、永不出本机** |
| 存储 | 硬件钱包 / KMS / 多签地址；禁止明文落盘 | 运维机 HSM 或 KMS；每主体独立 | 每委员加密磁盘 + 口令；禁止跨机拷贝 |
| 备份 | 2 份地理隔离的加密备份（Shamir 3-of-5 更佳） | 1 份离线加密备份；登记签发记录 | 委员自备份；协调方只保存**公钥聚合结果** |
| 丢失处置 | 若为 wrapper 持有：走治理提案重签；若 EOA：**协议进入冻结态**，需紧急公告并评估重发新包 | 由 MasterCap 重新签发，旧 Cap 无链上残留风险（仅地址绑定） | 触发 `GroupKeyRotatedEvent`，该委员重新加入轮次；达到门限以下需整轮 DKG 重来 |

**红线**：
- DKG 分片丢失不得从他人处「找回」——只能轮换群组密钥（`GroupKeyRotatedEvent`）。
- 任何 Cap 的私钥/对象都不得进入 CI 变量、日志、前端 bundle。
- `MasterCap` 建议直接由门限多签地址持有（与 UpgradeCap 一并对齐），彻底消除单点。

---

## 5. 监控口径

### 5.1 应监听的关键事件（源码实证，`grep "event::emit" contracts/agent_vault/sources/*.move`）

| 事件 | 模块域 | 用途 | 告警建议 |
|------|--------|------|----------|
| `ProposalCreatedEvent` | vault | 提案生命周期 | 基线；单地址 5 分钟内 > 10 条 → 告警 |
| `ProposalExecutedEvent` | vault | 执行落地 | 每条都推送通知（含金额）；失败率 > 1% → 告警 |
| `SubagentCapIssuedEvent` / `SubagentCapRevokedEvent` | vault | 子代理授权 | 非工作时段签发 → 告警；撤销激增 → 告警 |
| `AsyncVoteSubmittedEvent` / `AsyncVoteRejectedEvent` | vault | 异步投票 | 拒绝率 > 5% → 告警 |
| `AssetCustodyCreated` / `AssetDeposited` / `AssetTaken` / `AssetReturned` / `AssetReleased` | custody | 资产托管全链路 | `AssetTaken` 单笔 > 阈值金额 → 立即 P1 |
| `CustodyVoteSubmitted` / `CustodyVoteRejected` | custody | 托管投票 | 拒绝率突增 → 告警 |
| `SessionCreatedEvent` / `SessionFinalizedEvent` / `SessionTimedOutEvent` | DKG | 门限会话 | `SessionTimedOutEvent` 任一 → 告警（说明委员离线） |
| `CommitmentSubmittedEvent` / `EncryptionKeyRegisteredEvent` | DKG | 承诺与密钥登记 | 密钥登记地址与委员名单不符 → 告警 |
| `GroupKeyAttestedEvent` / `GroupKeyRotatedEvent` | DKG | 群键证明与轮换 | 轮换非计划内发生 → 告警 |
| `ParticipantConfirmedEvent` | DKG | 参与确认 | 置信度不足（确认数 < 门限） → 告警 |
| `BondClaimedEvent` / `GenesisStakeRefundedEvent` / `GenesisStakeSweptEvent` / `GenesisStakeRecordedEvent` / `GenesisStakeWithdrawnEvent` | 经济 | 保证金与创世质押 | 任意 `Swept` → P1（通常意味着违约清算） |
| `OrganizationCreatedEvent` / `RosterUpdatedEvent` / `OrganizationEpochUpdatedEvent` | 组织 | 组织与名册 | `RosterUpdatedEvent` 必须人工复核 |
| `PollPublished` / `BallotCast` | 治理 | 投票 | 投票率异常低（< 10%） → 提醒 |

**通用阈值建议**：所有事件按 `package_id + module + event_type` 聚合；每 5 分钟窗口内出现 **3 倍于 7 日基线** 或任意 `P1` 事件立即告警。链上事件可能有重组，消费端需按 `tx digest` 去重。

---

## 6. 回滚方案

> 前提：Sui 上**包对象不可删除**，旧包永远 `EXISTS`。回滚 = 让流量回到旧包，而不是「撤销新包」。

### 6.1 判定条件

- G4 门禁失败、线上出现 P1 级资产事件异常、或 SDK/前端与新包 ABI 不匹配且无法在前向修复。

### 6.2 血统废弃流程

1. **冻结**：立即停止向新包发起写操作（前端功能开关 / 维护页）。
2. **公告**：说明新包 ID、受影响时间段；若已有数据写入新包，明确「新包数据不迁移」。
3. **常量回滚**：
   - `packages/multisig/src/agent-vault/org/constants.ts` → `AGENT_VAULT_PACKAGE_ID` 改回旧 ID；
   - Vercel `NEXT_PUBLIC_AGENT_VAULT_PACKAGE_ID` 改回旧 ID 并**重新构建**（`NEXT_PUBLIC_*` 已内联，改 env 不重建无效）；
   - 测试 fixture / 脚本中的包 ID 一并回滚。
4. **UI 提示**：在历史数据入口加 Banner —— 「本次版本切换前的数据在新包中不可见，旧包数据仍可在链上查询但不再由本应用展示」。避免用户误以为资产丢失。
5. **记录**：把新包 ID 标记为 `DEPRECATED` 写入 `Published.toml` 注释或发布单，禁止再被引用。
6. **复盘**：定位是合约、SDK 还是部署配置问题；若是 UpgradeCap 单点导致（如私钥问题），同步启动第 3.2 节 wrapper 迁移。

### 6.3 回滚验证

- 页面展示 `getObject(旧包ID)` 返回 `EXISTS`；
- 关键读路径（Vault 列表、持仓、提案）正常；
- 旧包上的写操作若已随 policy 停用，UI 必须禁用写入按钮而非报错。

---

## 7. Go / No-Go Checklist

| # | 项 | 结论 | 依据 |
|---|----|------|------|
| 1 | Move 测试 421/421 | ✅ Go | [已实测] |
| 2 | SDK `tsc` 干净 | ✅ Go | [已实测] |
| 3 | `next build` 成功（9/9 静态页） | ✅ Go | [已实测] |
| 4 | Vercel Production Ready（HTTP 200） | ✅ Go | [已实测] |
| 5 | 包对象链上 `EXISTS`（version 1） | ✅ Go | [已实测] |
| 6 | 框架 pin `8fc60f1f...` | ✅ Go | [已实测] |
| 7 | 发布 gas ≥ 1.0 SUI | ⏳ 待确认 | [需人工] |
| 8 | `sui` CLI 1.82.1 / Node ≥ 20 | ⏳ 待确认 | [需人工] |
| 9 | `NEXT_PUBLIC_ENABLE_DEV_KEYSTORE=false`（生产） | ⏳ 待确认 | [需人工] |
| 10 | 发布后四处同步已完成（constants / Published.toml / fixture / env） | ⏳ 待确认 | [需人工] |
| 11 | UpgradeCap 持有者已评估（H-01，单 EOA 风险已接受或已迁 wrapper） | ⏳ 待确认 | [需人工] |
| 12 | 监控已接上第 5 节关键事件与告警 | ⏳ 待确认 | [需人工] |
| 13 | 回滚常量与流程已由值班人预演 | ⏳ 待确认 | [需人工] |

**放行规则**：第 1–6 项为硬性 Go；第 7–10 项任一未确认则 **No-Go**；第 11–13 项未确认可降级为「带条件 Go」，但必须在 24 小时内补齐并记录在发布单。

---

## 8. 发布记录模板

```
发布时间（UTC）：
操作人：
git commit：
新包 ID：
UpgradeCap ID：
tx digest：
发布前余额 / 发布后余额：
G1 / G2 / G3 / G4 结果：
四处同步核对人：
监控接入确认：
回滚预案确认：
```
