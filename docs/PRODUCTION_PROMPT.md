# 生产化推进提示词（可直接复用）

> 用法：新会话/新一轮 `/loop` 时，把下面代码块整体作为提示词发给我。
> 作用：锁定当前产品判断不漂移，同时把项目沿可验证路径推向生产。

```text
继续推进 multisig 项目（/Users/echo/project/project/sui_project_c/multisig）走向生产。
先读 docs/original-feature-review.md、docs/ui-feature-parity.md、docs/identity.md 再动手。

一、不可违反的红线（默认生效，直到我对某一条明确解禁）
1. 不部署任何合约或服务；不发真实链上交易；不 commit；不 push。
   —— 需要我做这些时，我会单独说「解禁：<具体动作>」，只解禁当次，不累积。
2. 不输出秘密：API key、session secret、prover secret、私钥、助记词。
3. 不以隐藏入口、删除入口、统一置灰、mock success 代替真实功能。旧入口必须保留或提供等价可达迁移入口。
4. 未完成能力必须准确标注 local / unverified / not deployed / configuration gap 四者之一，不得含糊。
5. 共享链接默认只读；任何写操作必须由用户显式执行。
6. 没有真实链上依据时，不显示假金额、假审批、假已执行、假红包领取、假通知、假头像、假粉丝。
7. 数据缺失与读取失败必须区分：空列表 ≠ 加载失败，不能互相冒充。

二、能力状态标签（每次汇报必须用）
- REAL：链上/真实服务已读通且有代码证据
- LOCAL：仅本机状态（localStorage/IndexedDB/内存），刷新或换设备可能丢失
- UNVERIFIED：代码接好但未在真实钱包/真实网络端到端验证
- GAP：配置缺失或模块未部署
- NOT-DEPLOYED：合约已写但未上链
任何「完成」结论必须附文件:行号或命令输出，否则只能标 UNVERIFIED。

三、当前真实基线（以此为回归底线，不得倒退）
- tsc --noEmit 0 错误
- 离线测试 696 项全过（`pnpm exec tsx --test lib/*.test.ts lib/crypto/*.test.ts`）
- ESLint 已配置并跑通（2026-10-23）：`pnpm exec eslint . --quiet` 退出码 0；完整运行 `pnpm exec eslint .` 为 0 error / 28 warning（2026-10-24 复跑：27 条测试替身 `no-explicit-any` + 1 条 DKG 对话框可变 ref cleanup 提示），详见 `docs/PRELAUNCH_CHECKLIST.md` §A6
- 生产构建通过（2026-10-25：/ 491 kB，首屏 1.13 MB）
- 浏览器回归 16/16 通过，分别在 390px 与 1280px，pageerror 必须为空、无横向溢出
  UI_BASE_URL=http://127.0.0.1:3005 UI_VIEWPORT_WIDTH=390 PLAYWRIGHT_MODULE=/Users/echo/project/research-network/agent_research_asset_protocol_workflow/node_modules/playwright/index.mjs node scripts/ui-regression.mjs
  # 使用 UI_VIEWPORT_WIDTH=1280 再跑一次；不能用 VIEWPORT_WIDTH。
- FROST 本地恢复/账户失效及真实 Chromium IndexedDB 验收：9/9，名册提交/回执来源与认证/重开恢复测试 88 项、聚焦门禁 107/107；新提交严格验证 request，恢复绑定原 request/result/有序名册，旧无 binding 回执保锁。独立原回执恢复入口支持重开后已生效/过期的原请求，以及旧版 epoch 已推进但 acknowledge 失败重试，不重新签名或提交；普通签名过期门禁不放宽。复现与证据边界见 docs/FROST_LOCAL_ACCEPTANCE.md；真实网络/扩展钱包仍未验收。
- 身份合约 48/48 Move 测试通过但未部署；agent_vault 全包 291/291 Move 测试通过，**v8 已部署** `0x2bac5eb016e47c6808e7b781f3e8f9e70ac6978b09989e0558d5822f8061a174`（升级 tx `D2rwcf7YFuHXu2oHgzJC3Z6Lq2MNQm6LCmAAqAWzz5tB`，gas 453,205,763 MIST，2026-10-26，全部 13 模块含 `walrus_app_policy_v2`；`onchain_chat` 收益债务记账 + `remove_zero_stake_member` 已上线；v7 `0xca0650d4…` 及更早包字节码仍可被直接调用）
- 已知陷阱：pnpm build 会覆盖 .next 并打挂 dev server，构建后必须 pkill → rm -rf .next → 重启 3005

四、待办队列（按依赖顺序，做完一项再下一项）
P0 生产阻断
1. ✅ 群组列表接链上发现（2026-10-21 完成）：`lib/group-discovery.ts` 按
   `OrganizationCreatedEvent` 有界扫描（默认 10 页 × 50 条、候选上限 60），逐个读取
   `Organization` 对象并用 `members_weight` 的 `Field<address,u64>` 点查确认当前账户成员资格；
   本机 `user_groups` 降级为备注覆盖层。分页游标不前进、事件类型不符、组织读取失败均显式报错；
   `truncated` / `failures` 与「非成员」严格区分，绝不把「未扫到」当成「不存在」。
   证据：testnet 只读探测——真实成员地址发现 11/12 个组织，陌生地址 0 个且 `checked=12`；
   浏览器验收「链上发现卡片 → 保存为本机记录 → 刷新后仍为本机记录」全绿，pageerror 为空。
   单测 `lib/group-discovery.test.ts` 13 项。
   仍为 UNVERIFIED：真实钱包签名的加入/退群生命周期；发现只读，不写链。
2. ✅ 修复 layout.tsx 未挂载 ThemeProvider（2026-10-21 完成）：`app/layout.tsx` 现挂载
   `ThemeProvider attribute="class" defaultTheme="system" enableSystem`，个人页账户菜单提供
   「跟随系统 / 浅色 / 深色」控件（带 aria-pressed，选择存 localStorage 并在刷新后保持）。
   证据：浏览器验收 dark → body 背景 `rgb(10,10,10)`、正文 `rgb(250,250,250)`，回归场景
   `theme-switch-applies-and-persists` 覆盖切换、刷新持久化与暗色无溢出。
   这是基线即存在的缺陷（a4433b9 的 layout.tsx 同样没有挂载），不是本轮丢失。
3. 真实钱包签名生命周期的端到端验收（需我解禁后才能发交易）；
   在此之前所有链路一律标 UNVERIFIED，不得写「已验收」。
P1 功能补齐
4. ✅ Walrus legacy 只读已接；V2 已随 v8 部署并接线用户签名交易入口（testnet registry 未初始化，链上生命周期 UNVERIFIED）：`lib/walrus-app-policy.ts`
   解码旧共享 `WalrusAppRegistry`（`Table<String, AppPolicy>`），`listDynamicFields` + `getObjects` 分批读取；
   `policy_revision()` 的 ABI 存在只能证明接口存在，不能证明返回值、旧入口授权或旧字节码已隔离。
   legacy 前端固定只读并显示旧版自报质押/计费风险；`walrus_app_policy_v2`（真实质押收据 + Coin<SUI>）已随 v8 发布，V2 面板提供用户签名的初始化/登记/付款/暂停入口。
   有界分页、游标不前进、字段名与键不一致、动态对象字段、解码失败逐条上报，空注册表与读取失败严格区分。
   个人页 `components/walrus-policy-registry.tsx` 提供只读面板。
   **legacy 管理写入保持停用**：旧包的 `policy_revision()`/`assert_admin`/`E_WRONG_REGISTRY` 接口存在不能取代部署字节码与实际支付验证；
   页面显示「旧版策略仅供读取 · V2 交易已接线」；V2 模块已随 v8 部署（真实 ABI 探测通过），初始化/登记/付款/暂停为用户签名入口；旧 registry 迁移与真实钱包签名的链上生命周期仍是 GAP / UNVERIFIED。
   **注册/熔断仍无前端入口（前端 GAP，不是部署 GAP）**：合约已可安全管理，但本页未实现写入；
   既不显示灰按钮也不假成功。证据：`lib/walrus-app-policy.test.ts` 19 项；回归场景
   `walrus-policy-read-only-and-administration-status` 在 390/1280 双宽度通过（断言恰好一条判定、
   无任何写入按钮、空 ID 不发链上读取、非注册表对象报错而非显示空列表）。
   仍为 UNVERIFIED：链上目前 0 个注册表（`AppRegisteredEvent` 为 0 条），读路径未在真实数据上跑通。
5. ✅ 删除 lib/p2p/（2026-10-22 完成）：390 行、全仓 0 import 的死代码已移除。实测证明它不是
   「差一个随机数」而是设计缺陷不可修补——密钥 = `SHA-256("MLS_EPOCH_SECRET_"+groupId+"_"+epoch+
   "_TREEKEM")`，三个输入全部是消息明文头字段，未入群第三方仅凭消息头即可解出明文（已写脚本实证）；
   另浏览器无 `Buffer` 会 `ReferenceError`，`PeerMessage.signature` 从不校验。
   同时修掉它暴露的同类真缺陷：`lib/crypto/ceremony.ts` 与 `resharing.ts` 共 6 处 Node 专有 `Buffer`
   位于正在使用的 DKG 路径上（`dkg-ceremony-dialog.tsx:252` 创建组织的最后一步会崩），
   已用新增的 `lib/crypto/bytes.ts` 替换。真实浏览器验证：`bufferGlobal:"undefined"`、
   3-of-4 DKG 群公钥一致、`hexLen:66`、`pageerror` 为空。构建产物 `/` 从 459 kB 降到 452 kB。
   真实群加密不依赖它：`lib/message-crypto.ts`（ECDH P-256 + HKDF-SHA256 + AES-256-GCM，每次临时密钥）。
   补记（2026-10-22）：`sui_project_a/tests/p2p_mls.test.ts` 仍 import 已删除的 `@multisig/lib/p2p/mls-client`，
   使该仓库 `pnpm test:ts` 恒红（基线即存在）。测试对象已不存在，已随模块删除；`vitest.config.ts` 中只为它
   存在的 `@multisig` 别名同步移除。现 `npx vitest run` 16 文件 82 项全过。
6. ✅ DKG 密态信箱可用了（2026-10-22，v5 升级解锁）：此前 `deposit_mailbox_share` 的载荷对任何
   RPC 读者都是明文，而发件人拿不到收件人公钥，等于把私钥分片公开发布。v5 新增
   `register_encryption_key`（65 字节未压缩 P-256 点，写入 `EncryptionKeySlot` 动态字段，
   `DkgSession` 布局不变故兼容升级），并暴露 `dkg_revision()` / `encryption_key()` /
   `has_encryption_key()` / `encryption_key_length()`。前端 `lib/dkg-mailbox.ts` 提供
   `sealShare`/`openShare`（ECDH P-256 + HKDF-SHA256 + AES-256-GCM，AAD 绑定
   session/sender/recipient/epoch，防跨会话与跨参与者重放）与 `createEncryptionKeyReader`
   （探测包是否支持、读登记公钥；未登记返回 null 而非空密钥）。
   `lib/vault-client.ts` 新增 `buildRegisterEncryptionKeyPTB`。
   证据：`lib/dkg-mailbox.test.ts` 15 项；真实只读探测 v5 上 `supports=true`、未登记参与者返回
   `null`；Move 侧 `dkg_committee_encryption_key_tests` 6 项（65 字节校验 3009、二次登记拒绝 3010、
   非参与者 3001、独立槽位、revision）。
   **已接线（2026-10-22）**：`components/dkg-ceremony-dialog.tsx` 改为按链上 `status` 分五阶段的真实流程
   （提交承诺 → 登记信箱公钥 → 密封投递 → 确认份额 → 终局），每阶段读回链上状态而非假定本机内存；
   `lib/dkg-session.ts` 负责读 `DkgSession` 与其三张动态字段表，`lib/dkg-mailbox-keys.ts` 用 IndexedDB
   保存不可导出的 P-256 `CryptoKey`（换设备只能报「本设备无密钥」，不会静默重建一把解不开旧份额的钥匙）。
   证据：`scripts/dkg-mailbox-e2e.ts` 在 testnet 用 3 个真实账户跑通——status 1→2、`key=65B`、
   `commit=64B`、`mailbox[a0→a1]=137B`、密文中不含明文份额、收件人 `openShare` 还原成功、确认写入。
   （该脚本会发真实交易，运行前需单独解禁。）
   **当前终局路径（v7）**：成员分别从承诺重算群公钥并 `attest_group_key`，达到门限后
   `finalize_session_v3` → `create_organization_from_session`。UI 已接线，历史 testnet keystore
   流程已有真实证据；浏览器多设备钱包生命周期仍为 UNVERIFIED。v1/v2 已禁用，不能再把
   旧 `finalize_session_v2` 的 FROST 证书作为当前 DKG 终局依赖。
7. ✅ RPC 容错复查 + 错误边界（2026-10-22 完成）：逐一核对 35 个链上调用文件，补齐三处真实缺口——`lib/suins.ts` 的 `getNameRecord` 不接受 `signal`，改用 `AbortSignal.timeout` 竞速包装（超时按失败上报，绝不映射成「未注册」），另两个 `core.*` 调用与反向解析补上 signal；`lib/sui-wallet-signer.ts` 的 `executeTransaction` 补 60 秒超时，且超时走 `uncertain()` 保留摘要、拒绝重签，不会被误判为「失败」而诱发重复发送；`lib/sui-stack-messaging.ts` 的回读 `waitForTransaction` 补 30 秒。新增 `components/error-boundary.tsx` 并在 `app/page.tsx` 按标签页分别包裹：单个面板崩溃不再白屏，导航仍可用，重试只重渲染不重发交易，且只把 `error.message` 打到 console（不记栈、不记钱包数据、不外发）。证据：`lib/suins.test.ts` 新增超时用例；离线测试 452 项全过；390px/1280px 各 16/16。
8. **vote-execution-dialog / history-item 判断依据（2026-10-22，仅分析，未改代码，等你决定）**：

   **vote-execution-dialog（189 行）——建议删除，不补入口。** 依据：
   - 功能**已可达**：`executeProposal` 已有两个真实入口——`components/transactions.tsx:71`（列表内按钮）与
     `components/transaction-details-dialog.tsx:140`（详情弹窗）。红线要求"旧入口保留或提供等价可达迁移入口"，
     此处等价入口**已经存在**，不存在"删了就丢功能"。
   - 它**更弱**：`transaction-details-dialog.tsx:144` 在 catch 中处理了 `TransactionReceiptError` 并把
     `e.receipt` 写回待确认状态（`executionPending.setPending`），因此交易超时/未确认时可以按摘要恢复；
     `vote-execution-dialog.tsx:63` 只做 `console.warn` + 显示 message，**丢失摘要**，用户无从恢复。
   - 数据源过期：它用 `getProposals()`（本机 localStorage）找提案；`executeProposal` 内部虽会读链上快照，
     但弹窗展示的标题/金额/受款方全部来自本机记录，可能早已与链上不一致。而它展示的金额会被用户当作执行依据。
   - 若保留，需重写（接链上快照 + 恢复路径 + 与另外两个入口共用逻辑），成本高于收益，且会产生**第三个**执行入口。

   **history-item（65 行）——建议删除，不补入口。** 依据：
   - 数据结构**对不上**：它要 `{id, type, title, description, date, group}` 六字段，
     而真实活动数据是 `WalletActivity { digest, timestampMs, success, category, title, error? }`（`lib/wallet-data.ts:68`）。
     没有 `group`、没有 `description`、`date` 是 string 而真实是 `timestampMs: number | null`。
   - 也就是说：**接上去必然要么造假字段，要么大改**。`group` 字段在链上活动里没有可靠来源——
     同一 digest 可能涉及多个组织，硬填一个就是编造归属，直接触碰"不显示假数据"红线。
   - 现有 `components/profile.tsx:248` 的活动列表已用真实 `WalletActivity` 渲染，并区分
     "加载中 / 为空 / 失败"三态，还有 digest 外链与"等待区块时间"。功能已覆盖且更准确。

   **结论**：两者都不是"缺入口"，而是**被更正确的实现取代后遗留的死代码**。已按确认删除
   （2026-10-22）：`components/vote-execution-dialog.tsx` 与 `components/history-item.tsx` 移除，
   删除前确认零引用，且两个等价入口（`transactions.tsx:71`、`transaction-details-dialog.tsx:140`）
   与真实活动列表（`profile.tsx:248`）均在。tsc 0 错误、构建通过、回归 16/16×2 未变。
**跨设备 FROST 签名分片交换（2026-10-22 新增，核心能力补全）**

此前门限签名算法是真的（`lib/crypto/committee-signing.ts`），但所有参与者的分片都堆在**同一个标签页内存**
（`lib/committee-session.ts` 注释即写明"simulates every participant inside one page"），刷新即失，
因此"多成员各持一片"这件事从未成立。该旧协议库仍保留用于兼容和离线证据；当前生产接线状态见下方 2026-10-23 更新。

- `lib/committee-share-store.ts`：**每台设备只保存自己的那一片**，存 IndexedDB，按 `orgId` 索引。
  写入前校验标量/索引，且**拒绝用另一把群公钥覆盖已有分片**（那会毁掉用户唯一副本）。
  `shareMismatch()` 对组织、群公钥、epoch 三项逐项给出中文原因，调用方必须 fail closed，不得回退到别的签名路径。
- `lib/frost-exchange.ts`：**两轮签名协议**。第一轮各签名者发布 `R_i = r_i·G`；第二轮发布
  `z_i = r_i + c·λ_i·s_i`，其中 `c = SHA512(ΣR_i ‖ Y ‖ m) mod L`，合成 `R ‖ z`。
  两轮是必需的而非形式：若允许在看到他人承诺后才发布 `R_i`，最后一个签名者可以反解群私钥。
  因此 `createSignatureShare` 在 `verifyRoundOne` 为假时**直接拒绝**。
  `aggregateSignature` 在用群公钥验签失败时抛错，**不会构建交易**。
  `sessionCertificateMessage()` 按合约的字节布局拼 `SESSION_CERT_V1:` ‖ session_id ‖ group_pk。

证据：`lib/frost-exchange.test.ts` 14 项 + `lib/committee-share-store.test.ts` 6 项（共 20 项）。
其中关键一项是**用真实的 t-of-n Shamir 分片，跨"设备"跑完两轮，产出的 64 字节签名通过
`ed25519.verify`**——这正是合约 `finalize_session_v2` 所做的检查；
另覆盖：任意 t 子集均有效且互不相同、少于 t 无法通过、跳轮被拒、重复承诺被拒、跨组织承诺被拒、
错误群公钥在聚合阶段被拦、1-of-1 可签。
离线测试总数 452 → **472**。

**跨设备 FROST 签名协作（2026-10-23，代码边界已补齐，真实传输仍未验收）**：`lib/frost-session.ts` 提供 RFC 9591 会话请求、固定 signer set、transcript、逐片验证和聚合；`lib/frost-session-store.ts` 在 IndexedDB 原子消费 nonce 并保存公开恢复记录；`lib/frost-private-transport.ts` 提供有界、身份配置门禁的私信 round API。`components/group-roster-dialog.tsx` 与 `lib/group-roster-transactions.ts` 已接入名册换届的手动公开 JSON 与私信 transport 流程（请求、Round 1、transcript、Round 2、聚合、提交前链上刷新），并拒绝当前名册外 signer；`frost-session.ts` 也在各设备本机签名前绑定 action org/epoch 到 bound key；旧 `lib/frost-exchange.ts` 仍是纯协议库。当前 UI 已调用私信 transport，它仅承载 Round 1 / Round 2；request 与 coordinator transcript 仍通过 UI 的公开 JSON 创建/导入，未自动网络分发。identity 承载未部署，且尚无真实多设备/钱包 E2E 证据，因此名册操作的真实跨设备传输状态仍为 **GAP / UNVERIFIED**。proposal actionType 目前只进入应用层请求上下文，既有链上 `computeProposalDigest` 不覆盖该字段；若后续按 actionType 分派权限，必须先升级 ABI/域分离后再把它标为受签名保护。

**真实 testnet 转账已验证（2026-10-22，REAL）**：`scripts/dao-live-transfer.ts` 完成了完整闭环——
派生 DAO 地址 → 真实转入 0.05 SUI → 撤一名成员 → 加回一名（真实 Gennaro 重共享）→ 地址两次都未变、
余额仍为 50000000 MIST → 用重共享后的两片门限签名，以 DAO 地址为 sender 真实转出 0.01 SUI。

```
fund tx:  AfyutjVN8TSWjUZ4JgQJDwmmuYcxY5dErspLivr1ucJq
transfer: 5JVvB5CEvH9EUZwNcFjH3oKKtAmwdqUG31gKLujXyUzS   status=success
sender:   0xed5573c14292270a7328ce86e036106ebecbe56ef0e6775fa335a037b8e25f4b（= Ed25519PublicKey(group_pk).toSuiAddress()）
```

途中修掉一个真实缺陷：**Sui 签的是 `blake2b(messageWithIntent(...))` 的 32 字节摘要，不是 intent 字节本身**。
签未哈希字节能过裸 `ed25519.verify`，却被全节点以 `Invalid user signature` 拒收。
已加专门测试锁死该行为。

`lib/dao-key-lifecycle.test.ts` 12 项，其中一条记录了一个**必须如实告知用户的限制**：
重共享**不吊销**旧分片——同一代任意 t 份旧分片仍重构同一密钥，因此仍能签名；
真正撤销必须换钥（`rotate_group_key`），而那会改变 DAO 地址、进而改变资产归属。
这一点已写进测试注释，UI 不得声称"换届后旧成员立刻失效"。

P2 生产硬化（与功能并行）
9. 可访问性（2026-10-22 复查）：四个创建向导的步骤条原本是 `<div onClick>`，键盘完全够不到；已改为 `<button type="button">`，带 `aria-current="step"`、中文 `aria-label`、`focus-visible` 焦点环，未到达的步骤用 `disabled` 而非静默忽略点击。复查结果：组件内已无无 `role`/`aria` 的 `onClick` div/span；无可访问名称的纯图标按钮 0 个；无 `DialogTitle` 的 `DialogContent` 0 个。390px 与 1280px 均 16/16 且无横向溢出。对比度未做逐项量化，标 UNVERIFIED。
10. ✅ 隐私与合规文案（2026-10-22 完成）：新增 `components/privacy-notice.tsx`，挂在「我的」页，九条事实逐条标注「链上公开 / 加密后上链 / 仅本机」，每条写的是当前代码的真实行为，并在同一条里注明未完成部分（relayer 只存内存、密钥不可导出换设备即失、密码学未审计、链上数据不可删除）。证据：`scripts/ui-regression.mjs` 的 `profile-navigation` 增加断言——标题「数据去向说明」必须存在，「链上公开」「仅本机」两类标签必须各至少出现一次；390px/1280px 各 16/16。
P3 部署准备（仅产出材料，不执行）
11. ✅ 部署清单（2026-10-22 完成）：`docs/DEPLOYMENT_CHECKLIST.md`。含三条不可混淆的包 ID 规则
    （调用目标 / 类型归属 / 动态字段 name 类型）、12 个模块清单、首次发布与兼容升级命令、
    回滚路径的真实边界（兼容升级**不可回滚**，只能发新版改回行为）、环境变量必填/可选/禁止三档、
    六个步骤的初始化顺序与各自约束、构建陷阱、8 项部署后验证。
12. ✅ 上线前检查表（2026-10-22 完成）：`docs/PRELAUNCH_CHECKLIST.md`。A 构建门禁 / B 浏览器回归 /
    C 链上能力 / D 不可声称的内容（10 条）/ E 数据与错误区分 / F 可访问性与隐私 / G 上线判定。
    本轮用真实链上对象回填了 C1、C2、D10 的证据：
    - `sui client object 0xbe71f98b…` → `version: 6`、`owner: Immutable`、`prevTx: DnTQHB3N…`、12 个模块；
    - `dkg_revision` 在新包 dry-run `success`，在 v4 包报 `Could not resolve function`；
    - `UpgradeCap 0x165bc08f…` → `{"AddressOwner": "0x8ac06d3d…"}`，单一地址持有，未转多签（D10 仍是 GAP）。
    身份合约复跑 `sui move test` → **48/48**。

五、工作方法
1. 一切结论先验证再陈述：优先读已安装依赖源码、链上对象/事件、真实 ABI；
   记忆和猜测只能作为假设，必须用探测或测试证实。对 testnet 用只读探测（listEvents/getObject）是允许的。
2. 每完成一项：tsc → 离线测试 → build → 390px 回归 → 1280px 回归 → 同步文档。
3. 发现旧缺陷（非本轮引入）要显式说明「基线即存在」，不能算作本轮丢失。
4. 文档同步 docs/original-feature-review.md 与 docs/ui-feature-parity.md 的状态与测试计数。
5. 每轮结束用固定格式汇报：改了什么 / 证据（文件:行号、命令输出）/ 仍缺什么 / 下一步。

六、生产的完成定义（不满足就不许说 production ready）
- 所有 REAL 能力均有真实钱包 + testnet 端到端证据（digest 可查）
- 无 GAP / NOT-DEPLOYED / LOCAL 项被当作已完成对外呈现
- 部署、升级、回滚路径文档化并演练过一次（需我解禁）
- 回归门禁全绿且被记录
- **第三方审计**：当前为 **GAP / UNVERIFIED**，没有独立审计报告；委托范围见 `docs/THIRD_PARTY_AUDIT_SCOPE.md`。

现在从「四、待办队列」的 P1 第 5 项开始，不要跳步。
```

## 使用说明

- **解禁是单次的**：比如你要发交易验签，说「解禁：本轮允许发 testnet 交易」，我只在这一轮放开；下一轮自动恢复红线。
- **不想让我碰某块**：直接说「本轮只做 P0，不看 P2」，我会收敛范围。
- **想换目标**：改「四、待办队列」即可，其余各节是长期约束，不用改。
- **P0 第 1 项为什么排第一**：它是当前唯一还卡住主流程的真实缺口——链上已有组织但本机没记录时，前端永远发现不了，加轮询也解决不了。


## 历史阻断项（已于 v6/v7 升级修复）

历史 v5 包中 `dkg_committee::finalize_session` 无 sender 检查、无签名，`finalize_session_v2` 存在循环论证风险。该问题已于 2026-10-22 之后的 testnet v6/v7 升级（`0xca0650d4…`）中通过 `finalize_session_v3` 与 `attest_group_key` 严格门限证明彻底修复；旧 v1/v2 入口在新包已废弃；前端默认绑定 v7 调用目标并核验链上 `attest_group_key` 进度。历史记录留档供回溯。
