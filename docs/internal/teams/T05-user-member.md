# T05 · 用户·普通成员组：多签/DAO 成员旅程信任审计

**视角**：被邀请加入群→装钱包→参加 DKG 仪式→投票→查看提案→用本机分片协作签名的"普通成员"（谨慎成员 / 懒成员 / 被拉来凑数的人三重人格）。
**方法**：全部结论来自当前工作区源码逐行核对（file:line 均为实测），无推测；测试网未做新交易（read-only 审计，无链上支出）。

---

## 一、成员完整旅程（6 段，每段标注代码入口）

### J1 被邀请加入群
- 入口是二维码/链接：`components/share-qr-dialog.tsx:29-31` 生成 `https://<origin>/?person=<address>` 或 `?group=<id>`；`app/page.tsx:56-62` 解析参数，`app/page.tsx:141-148` 弹出 IdentityPanel / 只读 GroupDetailsDialog。
- 群主建群默认每人权重 1：`components/create-group-dialog.tsx:56,112,159`（`weight: 1` 硬编码默认）。
- "我的组织"不是本机列表说了算：链上发现以 `OrganizationCreatedEvent` 扫描 + 逐组织读 `members_weight` 表为准（`lib/group-discovery.ts:33-44,125-153`），本机 `user_groups` 只是备注层（`lib/group-discovery.ts:19-22`）。
- ⚠️ 注意：**成员没有"加入群"事务**。群→DAO 转化（DKG）用的参与者名单是创建仪式那一刻 UI 里的 `initialMembers`（`components/dkg-ceremony-dialog.tsx:273`），链上 `create_dkg_session` 直接吃这个名单。也就是说：被链接邀请进"群"的人，只有在群主开仪式时把他的地址填进成员表，才会成为 DAO 参与者；两份名单之间没有任何链上同步契约。

### J2 装钱包 / 选身份
- `components/connect-wallet-dialog.tsx`：Slush 等扩展钱包（:34）、Google zkLogin（:235 "Google" tab）、Passkey（:12）、网页 keystore **已停用**（`lib/sui-wallet-signer.ts:167` 直接 throw `keystoreDisabled`，提示文案 `lib/i18n/dictionaries/misc.ts:307`）。
- 签名统一走 `lib/sui-wallet-signer.ts:164-275`：扩展钱包路径本地重建字节并验签（:226-245），提交前校验钱包未篡改交易（:240）。
- zkLogin：session 存 `sessionStorage`（`lib/zklogin.ts:13,179`），ephemeral key 过期即清（:211-214）；地址 salt 由服务端外部 salt 服务提供，注释明说"durable, recoverable per-(iss,aud,sub)"（`app/api/zklogin/server.ts:231-240`）——**但 salt 的持久备份是运营方承诺，UI 无任何用户可见的恢复说明**。

### J3 参与 DKG 仪式（升级为 DAO）
- 群详情页按钮触发：未升级群显示"升级为链上组织"（`components/group-details-view.tsx:1504-1517`），已升级群显示"换届/重共享"（:1483-1495）。
- 五步按钮：`components/dkg-ceremony-dialog.tsx:1133-1157`（1 提交承诺 → 2 登记信箱公钥 → 3 投递密封份额 → 4 验证份额并确认 → 5 重算/申报/固化）。
- 每步都是独立链上交易；Step1 还要随承诺原子托管 **0.05 SUI bond**（:339，`MIN_BOND_MIST = 50_000_000`，`packages/multisig/src/agent-vault/org/constants.ts:69`），会话创建费 0.005 SUI 销毁（:278，constants.ts:67）。
- deadline 钳制 [10min, 7d]，UI 固定 30 分钟（:276）。
- 份额是 LOCAL：`savePendingDeviceKey` 在链上 confirm **之前**先落 IndexedDB（:600-604，注释"Persist it before the irreversible on-chain confirmation"）；绑定用 `bindDeviceKey`（`lib/committee-share-store.ts:279-337`），record 以 device-vault 密封盒存储（:93-95）。
- dealer 多项式只活在**当前标签页内存**（:117 注释、`:400-402` 报错文案）；FROST 群签份额（resharing/roster 用）只活在 `committee-session` 模块内存 Map（`lib/committee-session.ts:15-16` 注释"deliberately never written to localStorage"）。
- attest 私钥却是 **localStorage 明文 base64**：`dkg-attest-sk:<sessionId>:<address>`（`components/dkg-ceremony-dialog.tsx:46-54`）。

### J4 投票
- 列表：`components/votes.tsx:27-48`，30 秒轮询 + 事件刷新。
- 详情：`components/vote-details-dialog.tsx:175` 提案面板显示 `payee: 收款方 {{recipient}} · amountLabel`；`lib/i18n/dictionaries/voting.ts:194`。
- 投票事务：`lib/onchain-store.ts:459-491` — 先 `validateApproval`（`lib/proposal-chain.ts:147-157`）校验成员/权重/重复投票，再 `buildSubmitAsyncVotePTB`（claimed_weight 必须等于链上名册权重，合约侧 `contracts/agent_vault/sources/asynchronous_proposal.move:311-345` 双重校验）。
- 拒绝票：`option-reject`（`lib/governance.ts:207`），提交走 `buildRejectAsyncVotePTB`（`lib/onchain-store.ts:476`）。
- 提案创建约束：标题 ≤256B、deadline ≤1 年、收款人≠0x0、金额>0（`asynchronous_proposal.move:63-65,183-186`）。

### J5 查看提案 / 执行
- 执行入口 `lib/onchain-store.ts:553-601`：状态 approved、未过期、epoch 一致才放行。
- **个人金库路径**：`buildExecuteTransferProposalPTB`（`packages/multisig/src/agent-vault/vault_client.ts:802-821`）——合约 `execute_transfer_proposal`（`asynchronous_proposal.move:462-506`）要求 FROST 门限签名（nonce 单调 + 对 recipient/amount/key_generation 的摘要验签）。
- **但 UI 传的签名是空气**：`lib/onchain-store.ts:575` 只传 `snapshot.id, snapshot.orgId, vaultId, masterCapId, SUI_TYPE`，PTB 里**根本没有 nonce 和 frost_signature 参数**（对比 vault_client.ts:809-820 的参数表——它只放 5 个 object，没有 `pure.u64(nonce)`、没有 `pure.vector('u8', sig)`；合约签名是 9 参）。旧版 PTB 与当前 Move 签名不匹配，这笔交易要么构建即错、要么链上必中止——见断点 T-12。
- **国库路径**：UI 明确承认未接线——`lib/onchain-store.ts:572-574` 注释"signing ceremony UI is owned by Main and not wired here yet"，`lib/group-vaults.ts:424` 无签名参数直接 throw"执行 treasury 转出需要门限签名（nonce + FROST 签名），请先完成签名会话"。

### J6 本机分片参与 FROST 协作
- 花名册变更走 `components/group-roster-dialog.tsx`：本机 `requireCurrentDeviceKey()`（:255-265）校验 holder/epoch/groupPk 后产出 Round1/Round2；跨设备用 `frostPrivateTransport` 私信交换（:44,463-520）。
- 换届（resharing）在 DKG 弹窗 `handleTriggerResharing`（`components/dkg-ceremony-dialog.tsx:887-985`）——**但签名用的是本标签页内存里的全体份额**（:899-902 `getCommitteeSession`，"noSharesInTab: 本标签页没有 DKG 分片（刷新后分片即丢失）"），不是各成员各拿各的份额；同一钱包刷新页面后该功能自废。

---

## 二、12 个信任断点（按严重度排序）

**T-1 · 清缓存/换设备 = 无声失去签名权，且没有任何导出按钮（HIGH，断点②核心）**
分片密封在 IndexedDB `sui-committee-shares`（`lib/committee-share-store.ts:31-36`），密钥本身是不可导出的 non-extractable AES key（`lib/crypto/device-vault.ts:126` `generateKey(..., false, ...)`）。**全仓库搜索证实：`exportEncryptedDeviceKey` / `importEncryptedDeviceKey` / `exportSuiCliKeystore`（`lib/crypto/encrypted-keystore.ts:243-284`）没有任何组件调用**（仅 .claude worktree 副本同名文件自引用）——恢复能力写好了但没接 UI。丢失后果：
- 本人签名权消失（roster 对话框 `groups.noLocalKeyPackage`，`lib/i18n/dictionaries/groups.ts:290`）；
- 分片丢不丢门限取决于剩余成员：t-of-n 设计下其他 t 人仍可签（`lib/crypto/committee-signing.ts:60-66` 用"前 threshold 个份额"聚合），**但对小群（如 3 人 2/3）一人清缓存 = 组织永久瘫痪在"还差一票"状态**，且链上无"补发分片"流程（resharing 需要**旧分片在场**才能算新分片，`dkg-ceremony-dialog.tsx:900-902`，丢了分片的人自己无法参与 resharing 拿新份额）。
- 唯一安慰是文案：privacy.ts:24/50"清除站点数据后……无法补发"、dkg.ts:65/632"分片仅保存在本机 IndexedDB（LOCAL）"——**告知了风险，没给出口**。

**T-2 · 凑数成员在毫不知情时被写进链上参与者名单并锁 0.05 SUI bond（HIGH，断点①核心）**
流程上"被拉来凑数的人"只收到一个链接，点开后他甚至不在 DKG session 名单里，但群主创建会话时把他的地址写上链（`dkg-ceremony-dialog.tsx:273,282`）。他自己要"Step1 提交承诺"才会锁 bond——这点是好的（bond 随本人承诺原子托管）。真正的坑是：
- 他**不参与**则会话永远到不了门限，30 分钟 deadline 后 TIMED_OUT（`dkg_committee.move:877-908`），其他人 bond 退款要走 `claim_bond`——**而 claim_bond 只存在于 SDK（`packages/multisig/src/agent-vault/org/builders.ts:236-244`）和红队脚本（`scripts/rt-econ-verify.ts:114`），UI 无任何按钮**。凑数成员不点头，全组 0.05×N SUI 卡在链上直到有人手工写 PTB。
- 他点头参与后钱包会连签 3-4 笔交易（commit+0.05SUI、登记信箱钥、投递份额、confirm），每笔都要他自己付 gas——UI 没有提前告知"这场仪式我总共要签几笔、花多少"。文案 `why4Body`（"由 Relayer 一键执行"，dkg.ts:343）暗示后续有人代跑，但仪式本体的成本没有预告。

**T-3 · 投票时钱包弹窗里的信息 ≠ UI 里展示的信息，且 UI 摘要不含关键安全字段（HIGH，断点③核心）**
成员点"批准"时实际签的 PTB 是 `submit_async_vote(proposal, org, clock, claimed_weight, partial_signature)`（vault_client.ts:734-757）——**钱包里只看得到两个 object id 和一个数字，看不到收款人、金额、标题**。人能判断"该不该投"的全部信息只在 vote-details-dialog 渲染层：收款方+金额一行（:175）。链上事实是：title/recipient/amount 谁都不能改（proposal 对象不可变，create 后冻结，`asynchronous_proposal.move:168-210`），所以"显示的就是投的"在链上成立——**但成员无从验证**：UI 不展示 proposalId 与收款人/金额的对应校验、不展示 digest 供比链。谨慎成员的核心疑问"我签的这一票，绑定的到底是哪笔转账"只能靠信任 UI。改进成本 S：在投票按钮上方加"proposalId + recipient + amount + deadline"四行只读链上读数（数据全在 `readProposalSnapshot` 里，`lib/proposal-chain.ts:127-128`）。

**T-4 · dealer 多项式标签页内存保存：Round1 提交后刷新页面 = 自己卡死自己（HIGH）**
`dealerRef` 是 useRef（`dkg-ceremony-dialog.tsx:117`）；Round2 时 `dealerPolynomialMissing` 直接 throw（:400-402）。也就是说：成员在 Step1（提交承诺+0.05SUI bond）之后、Step3（投递份额）之前关掉标签页/手机息屏被杀 = 承诺已上链、份额永远投不出去。链上等待方：其他成员的 `handleConfirmWithShares` 会报 `missing`（:586）并拒绝 confirm；dealer 本人重进后无法重生成多项式（"不会生成另一套多项式覆盖它"，dkg.ts: dealerContributionExists）。出口只有等 deadline 超时再 claim_bond——又回到 T-2 的"UI 没有 claim_bond 按钮"。移动端用户（产品明显主打移动端，onboarding 文案、mobile-navbar）是最大受害者。

**T-5 · 仪式按钮的"5 步"顺序语义与链上状态机不一致，懒成员会按错（MEDIUM）**
五个按钮并非严格线性：Step3（投递份额）实际要求先做 Step1 的承诺存在（`handleStartDkg` 按 `session.status` 分支，:318/:353）；Step2（登记信箱钥）与 Step1 可乱序但必须在 Round2 冻结前（`readEncryptionKey` 缺失会被 skip 并打印"skipped"清单，:417-418,432）；Step5（固化）不看 deadline（:1149-1153 注释）。UI 只有一行小字"每个按钮驱动一个链上阶段"，没有"当前该点哪个"的引导（按钮全部同时可点，:1133-1157）。被拉来凑数的人最常见的操作是"全按一遍"，结果是重复交易、gas 浪费、日志盒里刷 `alreadyCommitted` 类错误——信息能读懂但体验是"我搞坏了什么吗"。

**T-6 · "我在这个 DAO 里有多少权力"只在 Dashboard 一行小字，且需组织被链上发现（MEDIUM，断点④核心）**
`dash.myWeight: "我的链上权重 {{value}}"`（`lib/i18n/dictionaries/dash.ts:56`）渲染在群卡片一行 11px 灰字（`components/dashboard.tsx:243`）。数据源 `membershipWeight`（`lib/group-discovery.ts:104-122`）真实可靠。但：
- 群详情页成员表显示所有人的 `Weight: {n}`（group-details-view.tsx:1552）+ 门限比例"门限: X/Y"（:1057，groups.ts:105）——**没有"你"的标记**（成员行不 compare 当前钱包地址高亮）。
- 投票界面完全不显示"我这一票值多少权重"：voters 表里自己那行有 weight（governance.ts:210 `weight: memberWeights[who]`），但投票前成员看不到"我的批准将贡献 N / 门限 M"。懒成员不知道自己是不是关键一票，谨慎成员不知道自己的一票会不会直接触发执行。
- 权重 ≠ 分片：FROST key threshold 与加权门限是两个数（roster-dialog 明确提示"固定签名者（FROST 门限 {{threshold}}，与加权名册门限不同）"，groups.ts:367）——普通成员基本不可能理解"我权重 3 但只持有 1 片分片"意味着什么。

**T-7 · 投票结果行直接把"批准权重/门限"当主信息，但拒绝票权重没有任何等价展示（MEDIUM）**
`proposalStatsDialog: "批准权重 {{approved}} / 门限 {{required}} · 已参与 N 人"`（voting.ts:195）只显示批准侧；`rejectedWeight`/`rejectionSupported` 在链上快照里有（onchain-store.ts:444），但 UI 详情面板不渲染"反对权重 X / 是否支持否决"。对一个 rejection-supported 的组织，成员看不到"反对已经积累到多少"就投反对票，判断依据不完整。

**T-8 · 投票是"批准后任何人可执行"，执行人可以不是任何成员——UI 无提示（MEDIUM）**
`execute_transfer_proposal` 是 `public fun`，无 `assert!(is_member(ctx.sender()))`（`asynchronous_proposal.move:462-471`）：门限签名是唯一授权，谁来递交易都行。这在设计上没错（Relayer 模式，`why4Body` 也写了），但投票成员的直觉是"过了门限钱就会动"，UI 从不解释"还需要有人拿 FROST 签名再点一次执行"。结合 T-12（执行路径未接线），成员看到的是"门限达标了，钱却一直不动，也没人说为什么"。

**T-9 · zkLogin 成员的身份寿命 = ephemeral key 寿命 + salt 服务存活（MEDIUM，断点①延伸）**
zkLogin session 在 sessionStorage（`lib/zklogin.ts:179`），标签页关闭即失效；maxEpoch 只允许 epoch+2（server.ts:229）。Google 登录的成员每次回来都要重新 OAuth + 出证明（115s 超时，zklogin.ts:166）。地址本身依赖 salt 服务"durable, recoverable"（server.ts:231-232 注释）——运营方丢 salt = 该成员地址永久作废（链上资产与权重跟着作废）。UI 侧没有任何"你的 Google 账号地址依赖我们的 salt 备份"提示。给普通成员选 zkLogin 入口时，这不啻为一个未告知的单点依赖。

**T-10 · attest 私钥 localStorage 明文 + 钱包身份绑定，无安全分级说明（LOW）**
`ensureAttestationSecretKey`（dkg-ceremony-dialog.tsx:46-54）把 ed25519 私钥 base64 明文存 localStorage。设计上它是一次性会话钥（注释"不与钱包钥复用"），泄露后果限于"可伪造该成员对 (sid, groupPk) 的 attest"——而 attest 要求先 confirm（合约 `dkg_committee.move:723-725` E_NOT_CONFIRMED 门禁），所以实际风险面小。但一个"谨慎成员"用 devtools 看到明文私钥时的合理反应是"这产品把私钥存明文"，信任损伤与实际风险不成比例；一行"这是会话级一次性签名钥"的解释文案成本 S。

**T-11 · 邀请链接与 DKG 名单脱节，"我到底进没进"无确认页（LOW-MEDIUM）**
`?person=` 链接打开的是 IdentityPanel（app/page.tsx:141-144），`?group=` 打开只读群详情（:148）——都不产生任何"加入"动作，也没有"你已被加入 X 组织，权重 N，DKG 参与者名单里有/没有你"的确认界面。成员唯一确认自己身份的方式是 Dashboard 的链上发现（T-6）；如果群主建 DKG 时没把他填进 initialMembers，他会在仪式里收到 `notOriginalParticipant`（dkg.ts:220）——一个技术报错，而不是"你不在名单里，请联系群主"的引导。

**T-12 · 个人金库提案执行路径疑似与当前合约 ABI 脱节（HIGH——但这属于"执行断头"，成员视角是"钱卡住"）**
`buildExecuteTransferProposalPTB`（vault_client.ts:802-821）发出的 moveCall 参数是 5 个 object（proposalId/orgId/vaultId/masterCapId/clock），**没有 nonce 和 frost_signature**；而当前合约 `execute_transfer_proposal` 签名要求 `(proposal, org, vault, master_cap, nonce: u64, frost_signature: vector<u8>, clock, ctx)`（asynchronous_proposal.move:462-469），nonce 是必填参数。UI 调用点（onchain-store.ts:575）原样透传该 builder。两种可能：(a) PTB 构建期类型校验直接失败（签名不匹配）；(b) 链上 E_INVALID_NONCE/E_MISSING 参数中止。**无论哪种，"门限达标→执行"这条成员最能感知的资金链路在 UI 上是断的**（国库路径另有明确 throw，group-vaults.ts:424）。普通成员看到的现象：提案 approved、执行按钮点了报错、没有人解释。报告为 HIGH 是因为它是成员旅程里唯一"功能性死路"，且与 M-02（审计报告 open 项）同样处于"UI 已画、链路未通"状态。修复归属 SDK/Main（四道门禁的 tsc 应该会抓——建议 Main 核对 `packages/multisig` tsc 是否真的覆盖该文件，或该 builder 是否有独立测试保护）。

---

## 三、份额丢失灾难场景与恢复方案建议（断点②展开）

### 3.1 灾难矩阵（成员视角，按发生概率×损害排序）

| # | 场景 | 触发 | 丢什么 | 组织层面后果 | 现有缓解 | 缺口 |
|---|------|------|--------|--------------|----------|------|
| D1 | 清浏览器缓存/隐私模式关闭 | 用户常规操作 | bound device key（DEVICE_STORE）+ dealer contribution | 该成员签名权消失；t-of-n 下剩余 t 人可继续签 | 纯 LOCAL 设计 + 文案警告（privacy.ts:24） | 无导出/恢复 UI（T-1） |
| D2 | DKG 中途刷新（Round1 后 Round2 前） | 手机切后台被杀 | dealer 多项式（内存） | 承诺已上链、份额永缺，会话滑向 timeout | 保存了 dealer contribution 的承诺+自份额（IndexedDB），多项式不可再生成 | 无"作废重开"引导；bond 退款无 UI |
| D3 | resharing 前刷新 | 成员点换届时刷新 | committee-session 内存份额 | 换届按钮失效（noSharesInTab） | IndexedDB 的 bound key 仍在 | resharing 不读 IndexedDB key，两条存储通路未打通 |
| D4 | zkLogin 成员 salt 丢失 | 运营事故 | 地址本身 | 链上权重/资产永久失联 | salt 服务注释承诺 durable（server.ts:231） | 无用户侧冗余说明、无替代 salt 导出 |
| D5 | 单人小群（n=t）一人丢分片 | 常见 | 1/n 分片 | 组织永久瘫痪（差一票） | 无 | 无"降级重开组织"流程；genesis stake 90 天锁（cryptographic_org.move:695-733）期间资金也取不出 |
| D6 | 设备丢失且无第二设备 | 手机丢失 | 同 D1 | 同 D1 | 无 | 同 T-1 |

### 3.2 根因
系统把"分片持久化"做对了（密封、绑定、原子先存后签），把"分片可移植性"完全留白：加密信封导出/导入函数在 `lib/crypto/encrypted-keystore.ts:243-284` 完整实现（口令 PBKDF2 + AAD 绑定 sessionId:holder），**零调用方**。同时 resharing 只认内存份额（committee-session）而 roster 流程认 IndexedDB bound key——同一份"我的分片"被两条互不相通的通路管理。

### 3.3 恢复方案建议（按成本估算，均不动合约）
1. **[S] 分片导出入口**：在 DKG COMPLETE 面板（deviceKeyHeld 徽章旁，dkg-ceremony-dialog.tsx:1260-1275）加"导出加密分片"按钮，调现成的 `exportEncryptedDeviceKey`，产出 `.json` 信封下载；roster 对话框 `needDeviceKeyNotice`（groups.ts:366）旁加"导入"。这是把已写好的能力接上 UI，纯接线。
2. **[S] 组织恢复入口显性化**：现有的"导入会话 ID + 创建摘要"恢复路径（dkg-ceremony-dialog.tsx:1059-1068,1158-1168，`digestVerifyBtn: 只读核验并恢复绑定`）已能跨设备重建绑定——但它要求用户同时拿到 sessionId 和 creation digest 两个裸哈希。建议：群详情页"我是成员？"面板一键展示/复制这两个值（或打成 `?org=…&session=…&digest=…` 深链），把"请用 DKG 会话和创建交易摘要显式恢复"（shareMissing 文案，dkg.ts:297）从一句技术指令变成一个可点击动作。
3. **[M] resharing 改读 IndexedDB bound key**：`handleTriggerResharing` 在 `noSharesInTab` 时回退 `readDeviceKey(orgId, holder)`（数据在，`lib/committee-share-store.ts:339-343`），把"刷新即失能"变成"刷新无感"。需要处理 epoch 校验（advanceDeviceKeyEpoch 已有完整校验链，group-roster-transactions.ts:243-262 可复用）。
4. **[M] claim_bond / handle_session_timeout 运维按钮**：终态会话详情里给参与者两个按钮（合约函数已公开，SDK builder 已存在 builders.ts:236-244 与 vault_client.ts:623,680），消灭"0.05 SUI 卡链上"类工单。
5. **[L] 社交恢复（不推荐本期做）**：guardian-based 分片托管需要新合约+新信任模型，当前 t-of-n + 导出信封已覆盖 90% 场景，不建议为此扩攻击面（与既有决策"结构合法毒信封靠接收端 VSS"同理由）。

### 3.4 与"清缓存=丢 DAO 控制权"的一句话结论
**不清全部，只清站点数据，就丢签名权（份额）；丢不掉"成员身份"（链上名册权重不受影响）**。控制权在 t-of-n 下是集体的：只要剩余成员 ≥t 且健康，组织还能动；少于 t 则资金链路全停（且执行路径本来就没接线，T-12）。所以准确表述是："清缓存丢的是**我这一片**，群体控制权看剩下几个人"——而 UI 目前没有任何地方向成员解释这个区分。

---

## 四、对四个重点问题的直接回答

1. **①装钱包→点链接→签名的疑虑点**：最大断点是 T-2（不知道会被写进链上名单/不知道仪式要签几笔）与 T-9（zkLogin 的隐性 salt 依赖）；链接本身无恶意可能（只读展示），但"点完之后发生什么"没有任何预告页。
2. **②localStorage 丢分片**：份额实际在 IndexedDB（非 localStorage），localStorage 里只有 attest 会话钥（低风险，T-10）和群备注。清缓存后果见 §3.1 矩阵；恢复路径存在但未接线（§3.3-1/2 是最高性价比修复）。
3. **③投票信息够不够**：收款人/金额/门限都有（vote-details-dialog.tsx:175，voting.ts:194-195），但反对权重缺失（T-7）、"我这一票值多少"缺失（T-6）、签名内容与所见内容不可对照（T-3）。判断"该不该投"勉强够，判断"我签了什么"不够。
4. **④权力可见性**：dashboard 一行小字（dash.ts:56）+ 群成员表无"你"标记 + FROST 分片数与加权权重双轨不解释（T-6）。可见但远不足以让普通成员建立"我有多少权力"的心理模型。

---

## 五、修复优先级清单（供 Main 汇总）

| 项 | 断点 | 建议 | 成本 |
|----|------|------|------|
| P1 | T-12 | 核对并修复 buildExecuteTransferProposalPTB 与当前合约签名不匹配；或把执行入口先下线避免死按钮 | S-M |
| P1 | T-1 | 接通 exportEncryptedDeviceKey/importEncryptedDeviceKey 到 UI（§3.3-1） | S |
| P2 | T-2/D2 | 会话终态 claim_bond/timeout 按钮（§3.3-4）+ 仪式开始前"我将签 N 笔、锁 0.05 SUI"预告 | S |
| P2 | T-3 | 投票确认区展示 proposalId/recipient/amount/deadline 链上读数 | S |
| P3 | T-6 | 成员表高亮自己 + 投票面板显示"我的权重将贡献 N/M" | S |
| P3 | T-5 | 仪式按钮按链上状态启用/禁用（一次只亮一步） | S-M |
| P3 | T-4 | dealer 阶段加"刷新将卡死本轮，请完成步骤 3"的 beforeunload/可见性警告 | S |
| P4 | T-7/T-8/T-10/T-11 | 反对权重展示、执行人模型说明、attest 钥说明、加入确认页 | S×4 |

**团队口径**：以上未重复 T04（新手）与 T03（UX）已覆盖的表层问题；T-12 建议与 T07（Dev API）核对 SDK 测试覆盖，T-2 的 bond 经济性与 T10（Opt）的 admission economics 分析交叉验证。
