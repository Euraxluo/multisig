# FROST 本地验收记录

日期：2026-10-25。范围：名册换届的会话恢复、账户失效、公开包重试、私信传输校验、浏览器 nonce 持久化，以及已确认名册换届后的 pending receipt 来源绑定、提交前请求认证与本机设备 key epoch CAS 迁移。本轮没有部署、真实交易、commit 或 push；未使用真实账户秘密。

## 本轮消除的缺口

- 请求创建或导入后即保存公开恢复记录，尚未生成 commitment 时刷新也能找到请求。
- 名册页增加「本机会话 · LOCAL」恢复入口。选择记录后重新读取 live organization，认证 request、Round 1、coordinator transcript 和 Round 2，并核对组织、部署、epoch、nonce、groupPk、链标识、固定 signer 资格与目标名册。恢复只载入公开进度；聚合需再次执行验证，nonce 不进入恢复记录。
- 地址、账户类型或钱包 provider 切换会清空旧预览、失效进行中的异步操作，并重新读取当前账户的密钥与会话。相同地址切换 provider 也会触发重新发现。
- 相同 Round 数组可幂等导入；完整数组包含本机 Round 时不再报重复。已有 transcript 下重新导入相同 Round 1 不清除后续公开进度；不同 commitment、share 或 transcript 拒绝覆盖。
- 私信读取先验证全部输入再一次保存两轮数据；任一 peer 不可读或历史截断则拒绝该次导入。传输端核对完整 senderId/recipientId 双方，发送 Round 2 前也验证 coordinator transcript。
- 已确认的 key-preserving roster update 会先重新读取并核对完整 post-state（同组织、同 chainId、同 groupPk、目标名册、threshold、`epoch+1`、`last_nonce`），再以 `fromEpoch → toEpoch` 的 IndexedDB CAS 推进当前设备 key，最后 acknowledge 原 pending receipt。账户/provider 切换、回读不一致、群公钥变化或存储失败都会保留恢复锁；恢复只查询原 digest，不重新构建或签名。该路径只表示本地状态迁移，不表示 DKG resharing 或密码学撤销已完成。

- FROST 新提交必须先通过生产 `verifyFrostRequest`，包括 coordinator 的 Sui personal-message signature。回执保持原账户/provider、网络、动作和 `orgId:epoch` 重试锁，另保存显式公开来源字段：request/context/transcript、keyPackageId、packageId、chainId、群公钥、roster digest、epoch/nonce/threshold、固定 signer indices 与有序 priorMembers/members/weights。两个 pending 查询入口均在 resume 前核对完整绑定，并验证 request/result 的关联、摘要与最终群签名；resume 返回后再核对原 digest、receipt ID 和成功状态。缺字段的旧回执、另一请求、错序名册或来源冲突会保留原锁并要求核对原交易，不自动归因。仅既有回执恢复可放宽请求过期时间，其他认证不放宽。
- 对话框增加独立「恢复原交易回执」入口：重新打开后从 IndexedDB 读取原 request/transcript/两轮公开进度，无需旧 live pre-state、fresh plan 或内存 aggregate。存在原回执后才允许恢复聚合忽略 TTL；request、transcript、每个 commitment/share 与最终 Ed25519 验证不放宽。该入口没有签名、nonce 消费或 execute fallback；普通会话恢复与各签名入口仍严格拒绝过期请求。记录不完整、来源不符、账户/provider/org 切换或原回执被替换均保锁。
- 旧版兼容提交在签名之前先查原回执；新增旧版回执保存版本化有序 action、groupPk、roster digest、固定 indices 和最终公开签名，恢复无需旧 epoch 内存分片。独立「恢复旧版原交易回执」入口在重开后仍可用；epoch 已迁移但 acknowledge 失败可幂等重试。旧版提交按钮自动恢复前还须核对当前有序预览与原 action 一致，避免把交易 A 的成功误报为编辑后的名册 B 已提交；不同预览必须走显式原回执入口。缺少该绑定的历史回执仍保锁，不能自动升级，也不能把 FROST 回执当成旧版回执。
- 成员数组顺序在来源绑定处保留。链上成员 Table 的读取结果会排序，最终 post-state 仍比较成员/权重集合，不把链上迭代顺序或已移除的 priorMembers 当作恢复条件。回执 metadata 是本机恢复关联记录，不是链上交易内容证明；它不提升当前链上 group signature 对 packageId、priorMembers、request TTL 或 transcript 的认证范围。

实现入口：`components/group-roster-dialog.tsx`、`lib/group-roster-session.ts`、`lib/group-roster-transactions.ts`、`lib/frost-private-transport.ts`。旧 `lib/frost-exchange.ts` 继续作为协议库和离线测试使用。

## 证据与适用范围

| 门禁 | 结果 | 证明范围 |
|---|---|---|
| 全库离线测试 | 696/696 | 包括 23 项私信 transport、7 项名册会话 recovery、88 项名册提交/回执来源/认证/重开恢复测试；回执加固累计增加 81 项 |
| 聚焦门禁 | 107/107 | `group-roster-transactions`、`group-roster-session`、`frost-session`、`committee-device-store`；真实临时 Sui personal signatures 与 RFC 9591 运算，链上与钱包 I/O 注入 |
| TypeScript | 0 错误 | 应用与新增浏览器 fixture |
| 完整 ESLint | 0 error / 28 warning | 27 条既有测试 `no-explicit-any`，1 条 DKG ref cleanup 提示；本轮文件 scoped lint 无诊断 |
| 生产构建 | 成功 | `pnpm build` 完成 lint/type/static generation；首页 491 kB，First Load JS 1.13 MB |
| Chromium IndexedDB | 9/9 | 真实浏览器存储、独立标签页、刷新及重建页面；新增过期原回执持久化恢复，钱包/链上 I/O 注入 |
| 应用浏览器回归 | 390px、1280px 各 16/16 | 无 pageerror、无页面或名册对话框横向溢出；含恢复拒绝与账户/provider 切换 |

私信 transport 的生产默认实现会调用 `private-messages.ts` 的 identity `send_message` 交易提交与 `MessageSent` 事件/交易时间读取；本地集成测试则显式注入 identity resolver、send 和 history I/O，使用真实 RFC 9591 运算、Sui personal-message signatures 和 ECDH/HKDF/AES-GCM 信封，分别以 2-of-3、3-of-3 完成两轮并最终 Ed25519 验签。测试注入未证明 identity 部署后的事件索引、链上投递、真实钱包提示或真实多设备网络可用。另有真实 8-of-8 Sui multisig 签名超出 1000 UTF-8 字节时在发送 I/O 前拒绝的覆盖。

真实 IndexedDB 的九项验收：

1. 刷新及关闭/新开 signer 页面后，公开进度可恢复；request、两轮和 transcript 重新认证，最终 64 字节 Ed25519 签名有效，新增签名请求为 0。
2. 两个 signer 的已缓存 Round 2 在刷新后可重用，不再请求签名，usable nonce 数为 0。
3. 两个独立标签页/数据库连接同时消费同一 nonce，fresh consumer 恰好 1 个，另 1 个拒绝；恢复后不能复活已消费 nonce。
4. 已消费 nonce 拒绝另一份已认证 transcript。
5. IndexedDB 中篡改 request、Round 1、transcript、Round 2 或删除 transcript 均拒绝恢复。
6. 显式注入 IDBFactory SecurityError 时，在签名前失败。
7. 关闭真实 IDB connection 后，InvalidStateError 在签名前可见。
8. 对真实 IDB transaction 注入 abort，证明消费没有提交、没有触发签名；正常重试只消费一次并成功缓存公开 Round 2。
9. 使用生产提交层构造来源 metadata 并持久化成功但未 acknowledge 的本机回执，关闭 signer 页面后在新页面恢复已过期的原请求，仅 resume 原 digest 并 acknowledge；additionalSignatures=0、usableNonceRecords=0。真实存储与密码学，execute/resume/live read 是注入的本地 I/O，不是链上验收。

测试钱包与 threshold shares 仅为 keeper 页面内新生成的临时 fixture。signer 标签页通过同源 keeper 取得其测试材料，独立使用生产 store；这不模拟实际设备隔离。Node runner 只接收测试名称和公开计数，不接收密钥、nonce 或 secret share。故障注入仅包裹真实浏览器 IDBFactory/事务，不重写存储实现。

应用的恢复 UI 场景以实际只读 testnet Organization 加本地无效公开记录，验证记录可发现，普通恢复和独立原回执恢复按钮均可点击并拒绝篡改；缺绑定的旧版回执在无本机分片、无新 draft 时仍可进入独立恢复入口，拒绝后保锁。没有加载 Round/请求签名，并验证同地址 provider 切换清空输入后重新发现、换账户后清空列表。本轮 UI 回归使用本次 `pnpm build` 产物的本地 production server（仅监听 `127.0.0.1:3005`），两尺寸均为 16/16。正向过期原回执的页面重建恢复由上述 browser helper 验收覆盖；UI 按钮的正向真实钱包/链上生命周期尚未验收。

## 复现

在项目目录执行：

```bash
pnpm exec tsc --noEmit
pnpm exec eslint .
pnpm exec tsx --test lib/group-roster-transactions.test.ts lib/group-roster-session.test.ts lib/frost-session.test.ts lib/committee-device-store.test.ts
pnpm exec tsx --test lib/*.test.ts lib/crypto/*.test.ts

PLAYWRIGHT_MODULE=/Users/echo/project/research-network/agent_research_asset_protocol_workflow/node_modules/playwright/index.mjs \
node scripts/frost-browser-regression.mjs
```

持久化脚本自行启动仅绑定 127.0.0.1 的临时 HTTP origin，退出时关闭浏览器和 server；不依赖 app、真实钱包、链上写入或服务部署。也可以把 `PLAYWRIGHT_MODULE` 指向其他已安装的 Playwright 模块。

应用回归需先启动本地 app：

```bash
pnpm dev --hostname 127.0.0.1 --port 3005
```

另一个终端执行：

```bash
UI_BASE_URL=http://127.0.0.1:3005 UI_VIEWPORT_WIDTH=390 \
PLAYWRIGHT_MODULE=/Users/echo/project/research-network/agent_research_asset_protocol_workflow/node_modules/playwright/index.mjs \
node scripts/ui-regression.mjs

UI_BASE_URL=http://127.0.0.1:3005 UI_VIEWPORT_WIDTH=1280 \
PLAYWRIGHT_MODULE=/Users/echo/project/research-network/agent_research_asset_protocol_workflow/node_modules/playwright/index.mjs \
node scripts/ui-regression.mjs
```

此前记录用过 `VIEWPORT_WIDTH`，脚本实际只读取 `UI_VIEWPORT_WIDTH`，因此此前那次所谓 1280px 输出不能证明桌面尺寸。本次使用正确变量分别复跑通过，并修正清单命令。

生产构建：停止本地 dev 后执行 `pnpm build`，避免同时改写 `.next`。Move / SDK 门禁沿用既有记录，本轮未修改或重跑 Move 合约、未发送链上交易。

## 仍需保留的状态

- **LOCAL**：会话、设备分片与 nonce 都是本浏览器存储；已确认 key-preserving roster update 的回执恢复与设备 key epoch CAS 迁移有本地测试覆盖，但这不等于真实钱包/网络回执恢复或 DKG resharing。刷新恢复证据也不代表浏览器数据清除、设备丢失或跨设备备份可恢复。
- **NOT-DEPLOYED / GAP**：identity 包及 Names 配置仍未部署；当前私信投递不能作为已上线功能。
- **UNVERIFIED**：真实独立设备、浏览器扩展钱包、多设备 FROST/最终交易生命周期、真实链上 pending receipt 恢复；跨浏览器存储行为。
- **GAP / UNVERIFIED**：第三方密码学/合约审计和 UpgradeCap 多签托管。

DKG v7 终局走成员分别 `attest_group_key` → `finalize_session_v3` → `create_organization_from_session`，已有历史 testnet keystore 证据；名册 FROST 恢复不是该 DKG 终局的替代验收。当前 proposal 的链上 digest 不包含 actionType，请求上下文绑定不能被说成链上 group signature 已认证该字段。移除成员或推进 epoch 也不从密码学上撤销旧分片。

## 2026-10-26 发布说明与传输边界复核

- 私信默认路径仍是 `frost-private-transport.ts` → `private-messages.ts` → identity `send_message` / `MessageSent`，UI 调用 `list` 与 `send`。transport 目前只编码/投递 Round 1 与 Round 2；request 和 coordinator transcript 仍在 UI 创建/导入公开 JSON，没有自动网络分发。这是已接线的 round 传输代码边界，不是已运行的完整跨设备协议。
- 本轮仅发现 `.env.example` 这一环境文件，进程的两个 identity 公共变量未设置；未访问服务器部署配置，也未检查用户浏览器运行时。identity/Names 仍按既有未部署记录保留 **NOT-DEPLOYED / GAP**，未执行消息交易。
- 只读 testnet v7 包查询确认 12 个模块，包含 `governance_poll`、`scheduled_payments`、`red_packet_v2`、`organization_treasury`，不含 `walrus_app_policy_v2`。修正 `.env.example`、README 和部署清单的 v5/v6 默认值及未发布模块误述；模块存在不证明源码等同字节码、授权安全或钱包生命周期通过。审计范围补列本地第 13 个 Walrus V2 模块并明确未部署。
- `Move.toml` 的 Sui 引用由 tag 固定为 `8fc60f1fa966e90398c93beb67ad4f42992889c7`。只读远端 tag 解析与既有本机 `Move.lock` 的 Sui/MoveStdlib SHA 一致，没有更新依赖源码。发现该锁文件原被 `.gitignore` 排除，现仅对 agent_vault 增加例外，使生成锁文件可审阅、可随将来的授权提交归档；本轮未暂存或提交。
- 本轮门禁：FROST 私信 transport / private messages / roster transactions **121/121**（23 + 10 + 88）；独立 TypeScript 与 `eslint . --quiet` 退出 0；Move build 成功、全包测试 **287/287**、`sui move lint --warnings-are-errors` 退出 0。未修改前端运行代码，未重跑全前端测试、production build 或浏览器交互；上表对应此前记录。本轮两仓库 `git diff --check` 通过。
- 模型审核任务因 HTTP 429 提前终止，失败通知显示请求路由为 `group/gpt-6.1-sol`。局部消息和测试输出不能称为已完成且模型身份已核验的 Opus 5.5 审计，更不能替代独立第三方审计。已返回的配置错配发现经本轮独立只读核对后修正。

本轮没有部署、发送交易、commit 或 push。真实独立设备、扩展钱包、链上投递/索引与 pending receipt 生命周期继续为 **GAP / UNVERIFIED**。
