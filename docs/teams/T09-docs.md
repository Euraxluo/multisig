# T09 技术文档组报告：现有文档地图 + 必写文档清单

> 审计标准：「新工程师入职第一天能跑起来吗」。盘点范围：`docs/*.md`（17 篇）+ `README.md` + `contracts/identity/README.md` + 12 个 Move 模块源内 doc-comment + `packages/multisig` SDK（8,642 行，11 个导出子路径）。
> 盘点日期：2026-11-14。当前血统：13（`0xcdc87b8e…`，SDK 默认常量 `packages/multisig/src/agent-vault/org/constants.ts:12` 已指向）。

---

## 一、总评（先说结论）

**现状是「安全/部署文档严重超配，入门/架构/API 文档严重缺失」。** 这个仓库有 5 篇高质量部署/安全文档和一份真正的第三方风格审计报告，但一个新工程师 clone 下来：

1. **跑不起来**：README.md（37 行）标题是 `# frontend`，快速开始只有 `pnpm install && pnpm dev` 两行（README.md:35-37），没有 Node 版本要求、没有 `pnpm --filter` 工作区说明、没有钱包连接指引、没有「必须配哪些 env」清单。`contracts/agent_vault` 没有任何 README。
2. **看不懂**：没有一篇文档回答「这个系统是什么」——12 个 Move 模块如何协作、SDK 三层结构（dkg/agent-vault/namespace）、前端如何串起来。唯一接近的是 INVESTMENT_MEMO，但它是给投资人看的。
3. **文档间互相矛盾/过期**：`.env.example:7` 注释说默认 testnet v7（`0xca0650d4…`），实际 SDK 默认已是血统 13（`0xcdc87b8e…`，constants.ts:12）；7 处文档引用已迁移走的 `/Users/echo/project/sui_project_a/...` 绝对路径（见 §三.3）。

---

## 二、现有文档地图

### 2.1 docs/ 目录（17 篇，按主题分组）

| 文件 | 行数 | 主题 | 覆盖 | 质量 | 缺失/问题 |
|---|---|---|---|---|---|
| AUDIT_REPORT.md | 29,306B | 安全审计 | 12 模块白盒审计，2H/2M/4L/4I，资产出口锚点法 | **A**（正式度最高） | 基于 418/418 测试基线，当前已 421/421；未覆盖血统 14 待发布内容 |
| DEPLOYMENT_RUNBOOK.md | 15,309B | 部署 | 血统 13 四道门禁 + 升级流程 + 回滚 | **A** | 当前唯一与血统 13 同步的部署文档 |
| DEPLOYMENT_CHECKLIST.md | 19,337B | 部署 | 血统 `0x75ae40d8…`（已废弃的前一代"新 lineage v1"）| **C**（过期） | 全文以 `0x75ae40d8…` 为现行，与 RUNBOOK 冲突；路径指向 sui_project_a |
| BOOTSTRAP_PRODUCTION_RUNBOOK.md | 7,578B | 部署 | 主网自举托管（Phase 0-4）| B+ | Phase 0 表 7 项中 4 项 GAP，文档自身诚实标注；与 DEPLOYMENT_RUNBOOK 有部分重叠 |
| PRELAUNCH_CHECKLIST.md | 44,339B | 部署/门禁 | A-F 全门禁 + 证据 | B+（内容厚）但 **C**（基线过期）| 核验时间停在 2026-10-27、血统 `0x75ae40d8…`；测试计数 273/696 均为旧值 |
| PRODUCTION_PROMPT.md | 24,750B | 流程 | 可复用生产化提示词、状态标签约定（REAL/LOCAL/UNVERIFIED/GAP/NOT-DEPLOYED）| B | 是给 AI 的提示词不是给人看的文档；但状态标签约定被全项目引用，有规范价值 |
| RESHARING_SECURITY.md | 12,376B | 安全规格 | key-preserving resharing 擦除极限 + rotate_group_key | **A** | 无（密码学规格标杆） |
| CRYPTO_LITERATURE_INDEX.md | 20,612B | 安全/文献 | A1-A12 原语→RFC→攻击论文映射 | **A** | 尾注「最后更新 2026-11-13，对应血统 0x50739707…」——该血统号既非 13 也非现行记录，需核实（见 §三.4） |
| THIRD_PARTY_AUDIT_SCOPE.md | 20,542B | 审计委托 | 审计范围/材料/复现命令 | B+ | 基线 `0x75ae40d8…` 已过时；AUDIT_REPORT.md 落地后此文件定位应降级为历史材料 |
| INVESTMENT_MEMO.md | 17,032B | 商业 | 投委会备忘录 | B+（对投资人）| 不承担技术文档职能；技术形态一节可抽出来复用为架构文档骨架 |
| FROST_LOCAL_ACCEPTANCE.md | 14,178B | 验收记录 | 名册换届会话恢复/回执 | B | 是 2026-10-25 的一次性验收快照，不是 evergreen 文档 |
| chat-cost.md | 6,975B | 成本分析 | onchain_chat 每条消息成本结构 | B+ | 单点深挖文档的范例；数字基于 testnet 协议 v139 |
| identity.md | 8,301B | 功能 | 身份/SuiNS/私聊/QR | B+ | 英文，与全仓中文文档语言不统一 |
| zklogin.md | 8,972B | 功能 | Google zkLogin 配置验收 | B | 同上英文 |
| ui-feature-parity.md | 55,908B | 功能清单 | 基线 a4433b9 的 UI 功能保留 | C（历史价值）| 55KB 一次性核对快照，新人无需读 |
| original-feature-review.md | 7,349B | 功能复核 | 2026-10-23 GAP 审计对照 | C（历史价值）| 同上 |
| ux-content-plan.md | 6,889B | UX 文案 | 内容规划 | C | 非技术文档 |
| **（docs/teams/ 目录）** | — | — | **T01-T10 团队报告区（本次创建）** | — | — |

**语言不一致**：identity.md / zklogin.md / contracts/identity/README.md 为英文，其余为中文——对新中文团队是阅读摩擦，对国际贡献者是反向摩擦，需定一种主语言策略。

### 2.2 README 层

| 文件 | 覆盖 | 质量 | 缺失 |
|---|---|---|---|
| README.md（37 行）| 前端验证命令 + 文档链接列表 | **D** | ①标题 `# frontend` 与 monorepo 定位完全脱节；②无系统一句话介绍；③无环境要求（Node≥20 见 DEPLOYMENT_RUNBOOK 表#3，README 没有）；④无 monorepo 结构说明（contracts/packages/lib+components+app 四区）；⑤无钱包/网络配置步骤；⑥链接的 DEPLOYMENT_CHECKLIST.md 自身已过期 |
| contracts/identity/README.md | identity 包：custody/ABI/authority/tests/release | B+ | 无（是仓库里最好的包级 README 范本，agent_vault 应照此补） |
| contracts/agent_vault/README.md | — | **F（不存在）** | 421 行测试、7,230 行 Move、12 模块，零 README |
| packages/multisig/README.md | — | **F（不存在）** | 8,642 行 SDK、11 个导出子路径，零 README |

### 2.3 Move 模块 doc-comment 密度（逐模块）

统计口径：`///` 行数 / 模块行数；头部注释 = module 声明前的块注释。

| 模块 | 行数 | /// 行 | 密度 | 头部模块说明 | 评价 |
|---|---|---|---|---|---|
| dkg_committee | 1,126 | 237 | 21% | ❌ 无 | 函数级注释极厚（28 个错误码逐个有注释），但**模块开头无一段「这个模块是什么」** |
| cryptographic_org | 1,247 | 164 | 13% | ❌ 无 | 同上——核心模块反而无入口说明 |
| asset_custody | 905 | 156 | 17% | ✅ 8 行职责说明 | 范本级：讲清「任意 key+store 对象的 DAO 金库」+ 动态字段键设计 |
| asynchronous_proposal | 656 | 65 | 10% | ⚠️ 3 行 | 勉强及格 |
| onchain_chat | 985 | 56 | 5.7% | ❌ 无 | 14 个事件、20 个错误码，几乎裸奔 |
| red_packet | 489 | 50 | 10% | ✅ 含随机数证明引用 | 范本级 |
| walrus_app_policy | 306 | 48 | 16% | ✅ 5 行 | 良 |
| organization_treasury | 239 | 42 | 18% | ✅ | 范本级 |
| vault | 521 | 40 | 7.7% | ❌ 无 | 「vault」是全系统命名根（agent_vault::vault 是 Agent 热土豆金库），无头部说明极易与 organization_treasury/asset_custody 三个「金库」概念混淆 |
| scheduled_payments | 351 | 29 | 8.3% | ⚠️ 3 行 | 及格线 |
| governance_poll | 264 | 18 | 6.8% | ✅ 3 行 | 头部有但函数级薄 |
| scallop_yield_adapter | 200 | 16 | 8% | ❌ 无 | 薄 |

**结论**：12 模块中 5 个有范本级头部（asset_custody / organization_treasury / red_packet / walrus_app_policy / governance_poll 简版），**5 个完全无头部说明**（vault / cryptographic_org / dkg_committee / onchain_chat / scallop_yield_adapter）——偏偏包括最核心的三件套（org + dkg + vault）。**三个"金库"（vault vs organization_treasury vs asset_custody）的职责边界没有任何一处文档讲清**，这是新人第一困惑点。

### 2.4 SDK（packages/multisig）文档

- **零 README、零模块文档。** `packages/multisig/package.json` 导出 11 个子路径（`.`、`./account`、`./agent-vault`、`./agent-vault/{org,finance,custody,committee,proposal,artifacts}`、`./dkg`、`./namespace`），无一处有 README 或导出 API 说明。
- 源内注释抽查：dkg/ 11 个顶层文件中 8 个有 >2 行文档注释（resharing.ts / threshold_signer.ts 等核心文件质量尚可），agent-vault/ 顶层 3 个中 2 个有——**源内注释不算差，缺的是门面**：新人不知道 `multisig/agent-vault/org` 和 `multisig/dkg` 分别管什么、该 import 哪个。
- SDK 测试仅 3 个 `.test.ts` 文件（dkg 内），与 421 Move 测试 + 696 前端测试相比，SDK 层测试文档化最薄。

### 2.5 五问快答（对照任务书）

| # | 问题 | 答案 | 证据 |
|---|---|---|---|
| ① | README 快速开始是否存在且可执行？ | **存在但不可执行**。`pnpm install && pnpm dev` 两行之外全缺：Node 版本、SUI CLI 安装、工作区命令、env 配置顺序、钱包连接 | README.md:33-37 |
| ② | 12 个 Move 模块每个有没有入口级说明？ | **7/12 有（5 范本 + 2 简版），5 个核心模块无**：vault、cryptographic_org、dkg_committee、onchain_chat、scallop_yield_adapter | §2.3 表 |
| ③ | SDK 模块文档？ | **完全缺失**（零 README，11 个导出路径无门面说明） | §2.4 |
| ④ | 安全模型一页纸？ | **不存在**，但素材已齐：信任假设散在 RESHARING_SECURITY §1、残余风险在 AUDIT_REPORT §6、升级路线在 BOOTSTRAP §1/DEPLOYMENT_RUNBOOK。三合一即可成文 | — |
| ⑤ | 事件参考？ | **不存在**。全仓 49 个 `*Event` struct、81 处 `event::emit` 调用点，没有任何一处汇总文档（字段含义、触发交易、索引器消费方式） | grep 统计 |

---

## 三、发现的具体问题（新人会踩的坑）

### 3.1 README 是「frontend」 README，不是 monorepo README（严重）

37 行里有 25 行是历史验证叙述（README.md:25-27 大段 2026-10-26 状态快照）。新人第一天要的五个东西——是什么/装什么/配什么/跑什么/下一步看哪——一个都没有。**且它链接的 DEPLOYMENT_CHECKLIST.md 基线已废弃，等于入口页把人引向错误信息。**

### 3.2 三库概念无辨析文档（严重，架构理解第一障碍）

- `vault.move`（Agent 热土豆预算金库，AgentCap 消费）
- `organization_treasury.move`（MasterCap 封装的金库，SUI 专属出金通道）
- `asset_custody.move`（任意 key+store 对象托管）

三者名字都含「金库/treasury/custody/vault」，AUDIT_REPORT §1.1 只是列表，BOOTSTRAP §0 讲了托管误解但没有系统对比表。**建议一篇三列对比表 + 资金流图解决。**

### 3.3 过期路径与血统漂移（中，批量修复项）

1. **7 处 `sui_project_a` 绝对路径**：DEPLOYMENT_CHECKLIST.md:55、PRELAUNCH_CHECKLIST.md:15、THIRD_PARTY_AUDIT_SCOPE.md:101/133、original-feature-review.md:4、PRODUCTION_PROMPT.md:82、DEPLOYMENT_CHECKLIST.md:291 —— monorepo 迁移后全部失效，应指向 `contracts/agent_vault`。
2. **`.env.example:7`** 注释「Call target defaults to testnet v7 `0xca0650d4…`」——实际默认已由 SDK 常量 `AGENT_VAULT_PACKAGE_ID`（constants.ts:12，血统 13）接管，注释误导。
3. **CRYPTO_LITERATURE_INDEX.md:4**「对应血统 `0x50739707…`」——查无此血统记录（既非 13 也非 `0x75ae40d8…`/`0xd4ce6022…`），疑似笔误或中间未记录血统，需作者核实修正。
4. **DEPLOYMENT_CHECKLIST.md 全文 + PRELAUNCH_CHECKLIST.md 头部**仍以 `0x75ae40d8…` 为现行（该血统在 2026-11 之后的多次 fresh publish 中已废弃）——与 DEPLOYMENT_RUNBOOK.md（血统 13）直接冲突，两文档并存会让人不知道信谁。

### 3.4 测试计数漂移（低）

AUDIT_REPORT 基线 418/418，PRELAUNCH 记 273/273 + 696，RUNBOOK 记 421/421。文档各自记录当时事实没错，但**没有任何一处「当前门禁数字」的单一权威源**，每篇都自说自话。建议 RUNBOOK 头部数字即权威，其他文档引用它而不是写死。

### 3.5 事件参考缺失的实锤（中）

`onchain_chat` 一个模块 14 个事件（含 ChatMessageEvent、GasSubsidizedEvent 等），`dkg_committee` 14 个——**dkg 委员会事件流是 resharing 恢复、索引器、红队 fixture 再生器（scripts/rt9-fixtures-v2.mjs）共同依赖的协议接口**，却只存在于源码 struct 定义里。SDK reader（agent-vault/committee/reader.ts）消费它们的方式没有任何文档。新人改一个事件字段就要靠 grep 全库找消费方——这正是 memory #180 说的「摘要字段变更必须同步四处」之第五处隐患。

---

## 四、必写文档清单（按优先级）

> 工作量口径：S = 半天内，M = 1-2 天，L = 3 天以上。每篇给大纲。全部建议中文（与主仓文档一致），代码标识符保留英文。

### P0（第一周必做——直接决定「新人第一天」成败）

**D1. monorepo 根 README 重写** — `README.md`（M）
1. 一句话定位（从 INVESTMENT_MEMO §1 抽取：群聊→DAO，FROST 门限分片即组织身份）
2. 系统鸟瞰图（一张图：12 Move 模块 / SDK 三层 / Next.js 前端的关系，标注资金流与签名流）
3. 快速开始：环境要求（Node≥20、pnpm、SUI CLI 1.82.1、Sui testnet 钱包）→ `pnpm install --frozen-lockfile` → 必配 env（引用 .env.example，说明默认值跟随 SDK 常量）→ `pnpm dev` → 钱包连接 → 「Hello World」最小路径（创建群→跑 DKG→发起一笔提案，或指向文档 D6）
4. Monorepo 结构表：`contracts/{agent_vault,identity}` / `packages/multisig` / `lib+components+app` 各自职责一句话
5. 四道发布门禁（Move 全绿 + SDK tsc + next build + Vercel Ready）与「当前权威数字」指向 DEPLOYMENT_RUNBOOK
6. 文档导航表（按读者角色分流：新人→D6，运维→RUNBOOK，审计→AUDIT_REPORT，密码学→RESHARING/CRYPTO_INDEX）
7. 删除第 25-27 行历史快照叙述（移入 docs/history/ 或直接删）

**D2. `contracts/agent_vault/README.md` 新建** —（M）
照抄 contracts/identity/README.md 的结构（它是仓内最佳范本）：
1. 包定位一句话 + 12 模块一览表（模块/一句话职责/共享对象类型/关键入口函数）
2. 三库辨析表（vault vs organization_treasury vs asset_custody：资产类型/授权路径/Cap 形态/典型用途）——解决 §3.2
3. 本地开发：`sui move test`（421/421）、`sui move build`、错误码分段约定（org 1001-1012 / vault 2012-2014+22 / dkg 3001-3028 / proposal 4010-4018 / custody/chat/poll 等其余段位按源码 `const E_*` 归纳，共 98 个错误常量）
4. 当前血统与 Published.toml 说明（引用 DEPLOYMENT_RUNBOOK，不复制数字）
5. 测试哲学一段：严格模式、红队脚本目录（scripts/rt-*）如何复跑

**D3. `packages/multisig/README.md` 新建** —（M）
1. SDK 定位：纯 TS、零 React 依赖、前端与脚本共用
2. 11 个导出子路径对照表：`./dkg`（FROST1/GJKR/resharing/ECIES 信箱）、`./agent-vault/org`（builders+reader+digest V2/V3 布局+常量）、`./agent-vault/{finance,custody,committee,proposal,artifacts}`、`./account`、`./namespace`——每个一行职责 + 主入口文件
3. 最小用例代码块（两段：① 构造一笔 org 转账 PTB；② 跑一个 3-of-3 本地 DKG + 签名）
4. digest 布局契约警示框：改摘要字段必须同步 SDK digest.ts + reader + 常量表 + 测试 fixture 四处（引 memory #180 与 scripts/rt9-fixtures-v2.mjs）
5. 测试现状与运行命令

### P1（第二周——安全与协议接口的门面）

**D4. 安全模型一页纸 `docs/SECURITY_MODEL.md`** —（M）
1. 信任假设清单：哪些参与方被信任到什么程度（成员设备端分片不落链、协调者不可信、索引器只读、部署者单签窗口期）
2. 威胁模型速览：每类攻击者（外部攻击者/恶意成员 t 合谋/恶意协调者/失窃设备）对应防线与文档指针
3. 残余风险表（从 AUDIT_REPORT §6 抄录并保持同步）：H-01 UpgradeCap 单 EOA（open）、M-02 子代理不可撤销投票（open）、毒信封、genesis sybil
4. 密钥生命周期：DKG 生成→resharing（key-preserving 界限）→rotate_group_key（真撤销）→nonce 单调性，一张状态机图
5. 升级安全路线：COMPATIBLE-only 起步、GovernedUpgrader 封印教训（分片未持久化→lineage 冻结 v11 的教训必须写成案例）、asset_custody BORROW/RELEASE 模式
6. 「什么这条链不能防」诚实清单（resharing 不能密码学撤销旧分片等，直接引 RESHARING_SECURITY §1）

**D5. 事件参考 `docs/EVENTS_REFERENCE.md`** —（L）
1. 编写约定：每模块一节，每事件一小条——struct 定义行号、触发入口函数、字段逐个含义（类型/单位/谁读它）
2. 12 模块 × 49 事件全量表格，先做高价值三模块：dkg_committee（14 事件，resharing 恢复+索引器+fixture 依赖）、onchain_chat（14 事件，chat-cost 分析的消费对象）、cryptographic_org（8 事件，群发现 group-discovery 的数据源 OrganizationCreatedEvent）
3. 每个事件标注「消费方」：SDK reader 文件、前端 lib 文件、scripts 红队脚本——给改动者一张影响面地图（这是防止 memory #180 第五处隐患的关键）
4. 生成方式建议：初期手工 + 用 `sui client events --move-event` 实测样例填充；长期可用脚本从 struct 定义半自动生成（存疑，事件 struct 上的注释密度不够，先手工高质量三模块）

### P2（第三周起——体验与债务清理）

**D6. 新工程师入职指南 `docs/ONBOARDING.md`** —（S）
1. Day 1 路径：clone→env→dev→连钱包→浏览五个页面（dashboard/groups/trust/walrus/auth callback）各自看什么
2. Day 2-3 路径：跑通 421 Move 测试→读 D2→跑一个本地 DKG（FROST_LOCAL_ACCEPTANCE 的复跑版）
3. 常见坑列表：`.env.local` 需手工建、identity 包 env 为空时功能静默禁用、testnet 水龙头、旧血统对象 404 是正常现象（lineage 冻结）
4. 术语表：epoch/nonce/key_generation/roster/attest/PTB/热土豆 Cap/毒信封/GovernedUpgrader 各一句话

**D7. 过期内容批量修复** —（S）
1. 修 7 处 `sui_project_a` 路径 → `contracts/agent_vault`（§3.3.1 清单）
2. `.env.example:7` 注释改为「默认跟随 SDK 常量 `AGENT_VAULT_PACKAGE_ID`（现血统 13），显式覆盖才需要设置本变量」
3. 核实并修正 CRYPTO_LITERATURE_INDEX.md:4 的 `0x50739707…` 血统号
4. DEPLOYMENT_CHECKLIST.md 头部加「⚠️ 历史快照（基线 0x75ae40d8…），现行流程见 DEPLOYMENT_RUNBOOK.md」横幅；PRELAUNCH_CHECKLIST.md 同理或直接归档进 docs/history/
5. ui-feature-parity.md / original-feature-review.md / FROST_LOCAL_ACCEPTANCE.md 移入 `docs/history/` 子目录（保留价值、移出入口视野）

**D8. 前端架构一页纸 `docs/FRONTEND_ARCHITECTURE.md`** —（M）
1. 数据流分层图：钱包 → use-agent-vault/hooks → lib/*-chain.ts（事件同步）→ SDK reader → 链上共享对象；标注哪层可离线测试
2. 关键对话框组件地图：dkg-ceremony-dialog（群→DAO 仪式）等十大入口组件各自负责什么流程
3. 本地存储清单：IndexedDB 库表（committee-share-store、dao-key 等）与 localStorage 键的职责和失效条件
4. 与 SDK 的边界约定：哪些逻辑必须进 SDK（可复用/可测）、哪些留在 lib（UI 绑定）

**D9. 身份包文档语言统一** —（S）
identity.md / zklogin.md / contracts/identity/README.md 三篇英文文档：或翻译为中文对齐主仓，或在 README 导航中明确「英文区」；二选一，结束双语混杂。

**D10. `docs/history/` 归档制度** —（S）
新建子目录 + 一段 README 说明归档标准（一次性验收快照/过期基线核对表在失去现行性后 30 天内移入），防再发生 CHECKLIST vs RUNBOOK 双现行文档打架。

---

## 五、优先级矩阵总结

| 优先级 | 文档 | 工作量 | 解决的痛点 |
|---|---|---|---|
| P0 | D1 根 README 重写 | M | 新人第一天跑起来 |
| P0 | D2 agent_vault 包 README | M | 12 模块入口 + 三库辨析 |
| P0 | D3 SDK README | M | 11 导出路径门面 |
| P1 | D4 安全模型一页纸 | M | 信任假设/残余风险/升级路线集中 |
| P1 | D5 事件参考 | L | 49 事件字段含义 + 消费方地图 |
| P2 | D6 入职指南 | S | Day1-3 路径 |
| P2 | D7 过期修复批 | S | 7 路径 + 血统注释 + 双现行冲突 |
| P2 | D8 前端架构 | M | 数据流分层 + 存储清单 |
| P2 | D9 语言统一 | S | 双语混杂 |
| P2 | D10 归档制度 | S | 防复发 |

总计：P0 三篇（3M）是「第一天能跑起来」的最小集；P1 两篇（1M+1L）是安全门面；P2 五篇全是 S/M 债务清理。全部落地约 3 人周。
