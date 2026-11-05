# 原始前端功能复核（对照 2026-10-19 GAP_AUDIT）

复核日期：2026-10-23。基线：`a4433b9`（与 GAP_AUDIT 审计的 HEAD 一致）。
上游结论文档：`/Users/echo/project/sui_project_a/docs/GAP_AUDIT.md`（2026-10-19，审 `references/multisig/`）。

## 一、结论先说

1. **没有任何组件被删除。** 按完整路径对比 `a4433b9` 与当前前端的 `components/ app/ lib/`（排除 `components/ui/` shadcn 骨架）：基线 38 个组件文件在**当前全部仍存在**，全量文件层面只删除了 `lib/mock-data.ts`（本就该删的伪造数据源），另有 110 个新增文件。
2. GAP_AUDIT 点名的 **20 条伪造项已全部消除**：dashboard 写死金额、profile 写死资产、transactions 死按钮、vote setTimeout 假投票、votes 硬编码、agent-guard mock-data、create-agent `Math.random` 假私钥、假红包对象、净 Gas 补贴、Aptos/APT 残留 —— 逐项 grep 均为 0 命中。
3. 真正的缺口不是「被删」，而是 **GAP_AUDIT §2 全景表里判为「未接」的项，至今仍未接**。下面逐项列当前可验证状态。

## 二、GAP_AUDIT §2 矩阵的当前状态

| 模块 | 审计时判定 | 当前状态 | 证据 |
|---|---|---|---|
| 钱包连接 | 已接 | **已接** | Wallet Standard + zkLogin/Passkey/Keystore |
| 转 DAO 仪式 | 大体已接 | 已接 | `use-agent-vault` 链上核验，分片仅存标签页内存 |
| 群组列表 | 明确待接（localStorage only） | **已接** | `lib/group-discovery.ts` 按 `OrganizationCreatedEvent` + `members_weight` 点查发现；`dashboard.tsx` 与 `profile.tsx` 共用 `useGroupDiscovery`；本机记录降级为备注层 |
| 群治理提案 | 未接（大） | **已接** | `lib/vault-client.ts` 全套 PTB + `online-indexer` 事件同步（索引器也已改为按发现结果反查组织） |
| 链上门限执行 | 未接（中） | 部分 | `execute_threshold_proposal` 仅在 `vault-client.ts:289` 构造，前端无独立入口 |
| Agent Guard | 半接 | **已接** | 真实 `initialize_vault`/`spend_x402_budget`/`emergency_unilateral_purge` |
| 红包 | 未接 | **已接** | V2 已接前端与 v4 部署 |
| 群聊 | 未接 | **已接** | `onchain_chat` + SSM 双传输 |
| Walrus 附件 | 未接 | **已接** | 真实 Publisher/Aggregator |
| 资产看板 | 未接 | **已接** | 真实 RPC 余额 + 价格源 |
| **`walrus_app_policy`** | 未接 | **legacy 只读已接 · V2 已随 v8 部署并接线** | 前端读取旧 `WalrusAppRegistry` 与 `AppPolicy` 仅作链上展示；旧字节码的自报质押/计费入口仍可调用。`walrus_app_policy_v2` 独立类型与真实 SUI 付款已随 v8 发布（2026-10-26），V2 面板提供用户签名的初始化/登记/付款/暂停入口；legacy 管理写入停用，V2 链上生命周期与迁移保持 GAP / UNVERIFIED。 |
| **`lib/p2p/`（WebRTC + MLS）** | 0 组件 import | **已删除（2026-10-22）** | 全仓 0 import 的 390 行死代码。实测其密钥 = `SHA-256("MLS_EPOCH_SECRET_"+groupId+"_"+epoch+"_TREEKEM")`，三个输入全是消息明文头字段；未入群第三方可解出明文（已实证）。另：浏览器无 `Buffer` 会 `ReferenceError`、`PeerMessage.signature` 从不校验。可用 `git checkout 9609ab6 -- lib/p2p/` 恢复 |

## 三、本次新发现（GAP_AUDIT 未记录）

1. **~~`layout.tsx` 从未挂载 `ThemeProvider`~~（2026-10-21 已修复）**：`next-themes` 已安装、`components/theme-provider.tsx` 存在，但 `app/layout.tsx` 从基线到现在都没有引用它，**暗色模式实际不生效**。现在 `app/layout.tsx` 挂载 Provider（`attribute="class"`、默认跟随系统），个人页账户菜单提供三态主题控件；浏览器回归 `theme-switch-applies-and-persists` 验证深色下 body 背景为 `rgb(10,10,10)`、刷新后保持、无横向溢出。这不是本轮丢失，是原始缺陷。
2. **~~`online-indexer` 无法发现未知组织~~（2026-10-21 已修复）**：原先 discovery 用 `groups.find(g => g.orgObjectId === fields.org_id)` 只在本机已保存的群组里匹配，链上存在但本机无记录的 Organization 永远发现不了。现在 `lib/online-indexer.ts:visibleGroups()` 先经 `discoverGroupsCached(account)` 取得当前账户确认成员的组织，再合并本机备注记录；本机记录仍然全部保留，链上发现的组织也能同步其提案。
3. **两个组件无挂载**：`vote-execution-dialog.tsx`、`history-item.tsx` 无任何 import。注意 GAP_AUDIT 已写明「Vote Execution Dialog 在 HEAD 和初审均无挂载引用」，**不是本轮删除**，不能算作丢失入口。
4. **Walrus legacy / V2 状态（2026-10-26）**：旧 `walrus_app_policy` 的 registry 绑定源码修复与 `policy_revision()` 接口存在，不能证明已部署字节码的返回值、旧入口隔离或真实计费。旧布尔质押/计费入口仍保留，因此前端只读并明确风险。新增 `walrus_app_policy_v2` 用独立类型绑定真实 `MemberStakeReceipt`、权威 `ChatChannel` 和实际 `Coin<SUI>`，已随 v8 部署（2026-10-26，`walrus_app_policy_v2` 在 `objectChanges.published` 模块清单中，只读 dry-run 确认入口解析）；前端面板提供用户签名的初始化/登记/付款/暂停入口；旧 registry 迁移与真实钱包签名的 V2 链上生命周期保持 GAP / UNVERIFIED。
5. **~~`lib/crypto` 在浏览器里会抛 `ReferenceError: Buffer is not defined`~~（2026-10-22 已修复）**：`ceremony.ts:145`（DKG finalize 生成群公钥十六进制）与 `resharing.ts` 五处使用了 Node 专有的 `Buffer`，而 Next.js 不会为客户端打包 polyfill。这条路径由 `components/dkg-ceremony-dialog.tsx:252` 直接调用，即创建组织的最后一步会崩。已新增 `lib/crypto/bytes.ts`（`bytesToHex`/`hexToBytes`/`bytesEqual`）替换全部六处，并在真实浏览器中跑通 3-of-4 DKG：`bufferGlobal: "undefined"`、四个参与方群公钥一致、`hexLen: 66`、`pageerror` 为空。

## 四、按「捡回丢失功能」目标的优先级

| 优先级 | 事项 | 性质 | 说明 |
|---|---|---|---|
| P1 | ~~群组列表接链上发现~~ | 已完成 | 按 `OrganizationCreatedEvent` + `members_weight` 点查反查，零依赖本机记录；2026-10-21 完成，见 `lib/group-discovery.ts` |
| P1 | ~~挂载 `ThemeProvider`~~ | 已完成 | 一行修复 + 三态主题控件；暗色模式现已真实生效，2026-10-21 |
| P2 | ~~`walrus_app_policy` 前端接线~~ | legacy 只读已完成 | 读取旧 registry 供展示；旧入口风险和 V2 未部署状态已明确，真实写入与迁移仍为 GAP |
| P2 | ~~`lib/p2p/` 接线或删除~~ | 已删除 | 不是「差一个随机数」：密钥可由公开头字段推导，属设计缺陷不可修补。真实加密走 `lib/message-crypto.ts`（ECDH P-256 + HKDF + AES-GCM，每次临时密钥） |
| P3 | `vote-execution-dialog` / `history-item` | 需判断 | 基线即无挂载，属「从未可达」而非「被删」；是否补入口由产品决定 |

## 五、边界声明

本文件只记录**代码级可达性与接线状态**，不代表链上验收通过。合约已部署到 testnet v5（`0x0b49cb61…`，升级 tx `uKaav4uf…`），真实钱包签名生命周期仍未在真实浏览器+真实钱包下端到端验证。p2p 通道已删除。
