# T03 · 红队 UX 流程攻击报告（小白群主 / 半懂成员 / 恶意成员三视角）

审计对象：`components/dkg-ceremony-dialog.tsx`（1336 行）+ `lib/onchain-store.ts` + `lib/sui-wallet-signer.ts` + 关联库（`lib/dkg-local-session.ts`、`lib/dkg-mailbox-keys.ts`、`lib/committee-session.ts`、`lib/pending-transactions.ts`、`lib/i18n/dictionaries/dkg.ts`、`components/ui/dialog.tsx`、`components/group-details-view.tsx`、`components/connect-wallet-dialog.tsx`）与合约 `contracts/agent_vault/sources/dkg_committee.move` 的 deadline/错误码语义。纯代码走查，未发实弹交易。

结论摘要（共 10 项发现，4 中 6 低；无资金损失类，全部是"流程卡死/误导/脏状态"类 UX 攻击面）：

| # | 攻击面 | 角色 | 严重度 | 一句话 |
|---|--------|------|--------|--------|
| F-01 | 中途换账号留下幽灵恢复态 | 小白群主 | 中 | 切号后恢复 effect 读"新账号的 session link"，对话框静默变成空壳 |
| F-02 | 中途关弹窗丢失 Dealer 多项式 | 小白群主 | 中 | dealerRef 只在内存，Round1 后关闭弹窗再打开 → 303 步永久死锁 |
| F-03 | deadline 过后 UI 引导断头 | 半懂成员 | 中 | 4 个按钮全灰，无 timeout/claim_bond 入口，bond 被无限托管 |
| F-04 | 谁卡住了：UI 只有本地视角 | 半懂成员 | 中 | memberSigned 只记录"本机钱包确认"，其余成员永远显示"待签名" |
| F-05 | 恶意不 attest：无法点名 | 恶意成员 | 中 | 链上可查谁没申报，UI 只显示聚合数 x/y，无法定位拖延者 |
| F-06 | 手机 gas 不足错误不可操作 | 小白群主 | 低 | 原始 MoveAbort 字符串直出，无 gas 提示、无余额展示 |
| F-07 | 双 tab 并发：对话框级无锁 | 恶意成员 | 低 | 签名层有 Web Locks，但 DKG 步骤按钮无互斥，可烧两份 gas |
| F-08 | bond/创建费在 UI 不可见 | 小白群主 | 低 | 0.005+0.05 SUI 成本只在代码注释里，发起前无告知 |
| F-09 | 弹窗 X 按钮随时可关，无阶段拦截 | 小白群主 | 低 | 与 F-02 叠加；钱包弹窗叠加时误关概率高 |
| F-10 | memberSigned 永假导致成员列表误导 | 半懂成员 | 低 | 恢复路径不回读链上 confirmations，重开弹窗全员显示"待签名" |

---

## 攻击 ①：小白群主中途关弹窗 / 换账号

### F-01 换账号后的"幽灵恢复"（中）

**代码路径**：`components/dkg-ceremony-dialog.tsx:125-130` 的失效 effect：

```
const invalidate = () => { generation.current++; dealerRef.current = null; setDeviceKey(null); setDeviceKeyError(""); };
window.addEventListener("sui-account-switched", invalidate);
```

事件源是 `lib/zklogin.ts:196`（`publishAccount` → `window.dispatchEvent(new CustomEvent("sui-account-switched"))`）。攻击剧本：小白群主在 DKG Round1 提交承诺后，从移动端导航 `components/mobile-navbar.tsx:230-246` 的 ConnectWalletDialog 里点了"退出"或连了另一个钱包。

**问题 1 —— invalidate 清理不完整**。对比同类组件：`components/direct-messages-dialog.tsx:63` 在切号时直接 `close()`（关闭弹窗），`components/group-proposal-entry-dialog.tsx:35` 同样 `close()`。DKG 对话框只 bump generation + 清 dealerRef/deviceKey，却**不关闭弹窗、不清 `deadlineTs`、不清 `onChainSessionId`、不清 `memberSigned`、不清 `creationInput`**。小白看到的是：弹窗还开着、倒计时还在走、五个步骤按钮还在，但点任何一步都会因为 `assertTransactionAccount`（`lib/sui-wallet-signer.ts:32-34`，消息 `misc.signer.accountSwitched` "账户或钱包提供方已切换…"）而失败。

**问题 2 —— 恢复 effect 的 key 是 groupId 而非 groupId+account**。`components/dkg-ceremony-dialog.tsx:152-209`：`window.addEventListener("sui-groups-updated", restore)` 里 `restore()` 重新读 `getActiveAccount()?.address` 和 `readDkgSessionLink(groupId, holder)`（`lib/dkg-local-session.ts:28-33`，link 按 groupId+holder 存储）。切号后新账号没有 link，`sessionId` 为 null，于是跳过会话恢复；但旧账号留下的 `deadlineTs`、`memberSigned`、`onChainSessionId` 状态**在 invalidate 中根本不清除**（invalidate 不重跑恢复 effect，因为 `[groupId]` 依赖没变）。小白看到旧会话 ID + 旧倒计时 + 一串"待签名"名单，实际上当前账号已与该会话无关，点"提交承诺"直接报"当前钱包不在会话参与者中"（dkg.notParticipant，dkg.ts:221）—— 但小白无法分辨是自己切错了号。

**修补建议（S）**：
1. `components/dkg-ceremony-dialog.tsx:126` 的 `invalidate` 里追加与 203-205 行等价的清理：`setDeadlineTs(null); setOnChainSessionId(null); setMemberSigned({}); setCreationInput(""); setPendingDeviceKey(null)`，并调用 `onOpenChange(false)` 关闭弹窗（对齐 direct-messages-dialog.tsx:63 的先例）。
2. 或者在 125-130 的 effect 依赖数组 `[groupId]` 中加入当前账号地址，让切号触发整套 restore 重跑，用新账号视角重建或清空。

### F-02 关弹窗丢 Dealer 多项式 → 步骤 3 永久死锁（中）

**代码路径**：`components/dkg-ceremony-dialog.tsx:117-118` 注释已自知：「A reload clears this, which is reported instead of silently restarting」；`dealerRef` 是 `useRef`，存在 React 组件内存。弹窗关闭时 `group-details-view.tsx:1956-1967` 的 `<DkgCeremonyDialog open={isDkgOpen} …>` **并未卸载组件**（Radix Dialog 默认保留 children 挂载？否——Radix `Dialog.Root` controlled open=false 时 Content 卸载，本组件整个 return 都在 DialogContent 内，`components/ui/dialog.tsx:36-52` Portal 在 closed 时移除内容；但状态 hooks 挂在外层函数组件，组件本身仍挂载，所以 `dealerRef` 其实跨开关保留——除非整页刷新或路由跳转）。真正丢 dealerRef 的场景：**(a)** 刷新页面（F5）；**(b)** 从 DkgCeremonyDialog 打开时切到别的群再切回来（`[groupId]` effect 205 行清 storedShares 等，且 126 行 invalidate 置空 dealerRef）；**(c)** 换账号。

死锁链：Round1 已提交承诺（链上 `session.commitments` 已含 sender，`dkg_committee.move:484` `E_ALREADY_SUBMITTED` 拒绝重复）；随后 dealerRef 丢失。步骤 3「投递密封份额」进入 `sealAndDepositShares`（dialog:399-402）：

```
const held = dealerRef.current;
if (!held || held.sessionId !== session.sessionId || held.holder !== mine) {
  throw new Error(t("dkg.dealerPolynomialMissing"));
}
```

报错文案 dkg.ts:58：「本标签页没有本钱包、本会话的 Dealer 多项式（中途刷新仍会丢失）。不会复用其他账户的多项式。」——安全上正确（防复用他人多项式），但 UX 上这是**单边死**：链上承诺无法撤回（无 abort_commitment 入口，`dkg_committee.move:471-510` 只有 E_ALREADY_SUBMITTED 拦截），本机多项式无法重建（多项式是随机数，不可从承诺反推），该参与者此会话内**永远无法投递份额**。若门限恰好需要他的份额（t=⌈0.6n⌉，见 dialog:274），且其他人未补交，会话只能等 deadline 过后 timeout 作废，bond 通过 claim_bond 取回——但 UI 没有任何入口（见 F-03）。信息也只有那一行 `activeLog`，小白不知道该干什么（实际正确动作：等其他 t 个 dealer 凑齐即无害；若凑不齐，等超时后索回 bond——两步 UI 都不支持）。

**修补建议（M）**：`dealerPolynomialMissing` 文案处（dialog:401 抛错 → 367 行 logPhaseFailed 呈现）按链上状态分流引导：
- 若 `readQualifiedDealers`（`lib/dkg-local-session.ts:6-19`）返回的 dealer 数 ≥ threshold：提示「你的承诺已在冻结集合中但不影响门限，其余成员可继续；你可继续步骤 2/4 作为持有者接收份额并确认」（对话里 355 行 `logNotDealer` 已有类似语义，但只在步骤 3 主动点击时出现一次）。
- 若 dealers < threshold 且剩余时间不足以补救：提示等待超时 + 增加「作废会话并取回保证金」按钮（复用 SDK 已有的 `buildHandleSessionTimeoutPTB`/`buildClaimBondPTB`，`packages/multisig/src/agent-vault/vault_client.ts:623,677-683` 与 `org/builders.ts:237-246`，前端 facade `lib/vault-client.ts:178-181` 已导出——**全仓 grep 无任何 UI 调用**，纯死代码入口）。

### F-09 关闭按钮无阶段拦截（低）

`components/ui/dialog.tsx:47-50` 的 X 按钮与 Esc/点击遮罩（Radix 默认行为，DialogContent 未传 `onInteractOutside`/`onEscapeKeyDown`/`onPointerDownOutside` 拦截）随时可关。`step` 处于 `ROUND_1_COMMITMENTS`/`ROUND_2_SHARES`/`DEPLOYING_ONCHAIN`（dialog:83-90）时事务正在钱包里等签名，小白误关弹窗不会中断钱包弹窗，但回来后 step 已被 setState 复位，进度条丢失。风险低（交易本身有 pending-transactions 回执保护，`lib/pending-transactions.ts:109-116` 的 intent 锁 + `resumePendingTransaction` 只查原 digest），但和 F-02 组合时小白刷新率上升。

**修补建议（S）**：dialog.tsx:38-45 给 `DialogPrimitive.Content` 加 `onEscapeKeyDown`/`onInteractOutside`：当 `step` 属于进行中四态时 `event.preventDefault()` 并把 activeLog 置为「请先在钱包完成或拒绝本次签名」。

---

## 攻击 ②：成员迟到加入信箱轮次（deadline 过后 UI 引导到哪）

### F-03 deadline 过后：四按钮全灰 + 断头路（中）

UI 时间线（dialog:1106-1171）：
- `nowTs >= deadlineTs` 时 1108-1113 行切红色「限时已到期」，1116-1117 行文案 dkg.ts:49-50：「已过签名时限。达到会话门限即可固化；门限由链上会话的 threshold 决定」+ 1169-1171 行 afterDeadlineNote（dkg.ts:10）。
- 步骤 1-4 按钮 `disabled={nowTs >= deadlineTs}`（1133/1137/1141/1145 行），仅步骤 5「重算群公钥 / 申报 / 固化」保留可点（1149-1153 行注释明确说明 finalize 链上无时钟检查，任何已 attest 达门限的会话事后仍可固化——正确的设计权衡）。

**断头路 A —— 已确认但未达门限的迟到成员**。合约侧：`submit_commitment`（move:480）、`deposit_mailbox_share`（move:521）、`register_encryption_key`（move:567）、`confirm_participant`（move:619）、`attest_group_key`（move:694）全部 `E_SESSION_EXPIRED`(3004) 拦截。半懂成员第 31 分钟打开 App：步骤 4 点击被前端 disabled 挡住；他唯一能做的是等。UI 没有告诉他两件关键事：(1) 会话不会自动作废，需要**任何人**调 `handle_session_timeout`（move:877-906）才进入 TIMED_OUT；(2) TIMED_OUT 后他应调 `claim_bond`（move:915-939，纯退款无罚没）+ 若超额缴款还有 `claim_stake`（move:946-961，仅 TIMED_OUT 开放）。这两个动作在前端**零入口**（grep `buildHandleSessionTimeoutPTB|buildClaimBondPTB|claim_stake` 在 components/、app/ 无匹配；`lib/vault-client.ts:178-181` 的 facade 只有定义）。结果：小白的 0.05 SUI bond 无限期托管在会话对象上（gas 经济学上攻击者甚至可以让无数会话永远悬着）。deadlineExpiredBody（dkg.ts:49）只说"达到会话门限即可固化"，对"达不到门限"的情形（正是迟到者关心的）一个字没有。

**断头路 B —— 恢复路径读不到 deadline 时**。挂载恢复（dialog:158-165）从 `readSession` 拿 `deadlineTimestampMs`；若 `readDkgSessionLink` 抛 corruptSessionIndex（dkg.ts:44，本地索引损坏）则只剩 setActiveLog 一行「本机会话恢复读取失败」，用户没有任何"手动导入会话 ID"的引导词（虽然 1059-1063 行输入框就在那里，但小白不知道要把 0x… 粘进去）。

**修补建议（M）**：
1. dialog 1106-1123 的到期分支改为三段式状态卡：(a) `confirmations_count >= threshold` → 「仍可固化，点击步骤 5」；(b) 已达标 attest → 同上；(c) 未达标 → 显示「作废会话」按钮（`vaultClient.buildHandleSessionTimeoutPTB(sessionId)` + `signAndExecuteWithWallet`）和随后出现的「取回保证金 0.05 SUI」（`buildClaimBondPTB`）。状态判定用现有 `readSession` 快照即可（dialog:309 已在读）。
2. `deadlineExpiredBody`（dkg.ts:49）文案补一句未达标分支：「若确认数不足门限，可作废会话并取回保证金」。
3. `restoreReadFailed`（dkg.ts:267）文案补「请在下方'导入链上 DKG 会话'输入会话对象 ID 后点'只读导入'」。

### F-10 重开弹窗后 memberSigned 全员归零误导（低）

`memberSigned` 只在两处置 true：本机 confirm 成功（dialog:607/621）。挂载恢复（dialog:203-206）重置为 `{}`，之后**从不回读链上 `session.confirmations`**。于是：小白提交承诺+确认后关弹窗，5 分钟后重开——自己头像上的徽章又变回「待签名」（dialog:1092-1093），小白以为自己没确认过，重复点步骤 4，被 `E_ALREADY_SUBMITTED`(3003) 打回，报错显示为 `logConfirmFailed`（dkg.ts:145）内嵌 SDK 错误串。惊吓但无损。i18n 里其实已有 `logAlreadyConfirmed`（dkg.ts:138）覆盖此路径，但只有点了按钮才触发，徽章状态不反映。

**修补建议（S）**：恢复 effect（dialog:159-165）在读到 session 后，用 `readSession` 返回的 confirmations（`lib/dkg-session.ts` 的 SessionSnapshot 若含 confirmations 列表）回填 `setMemberSigned`；若快照只含 count，则至少把本机地址的徽章按 `readConfirmation(client, session, mine)` 置位（dialog:605 已有该调用模式）。

---

## 攻击 ③：恶意成员故意不 attest（UI 有没有显示谁卡住了）

### F-05 无法定位不申报的拖延者（中）

**合约面**（这部分是好的）：`finalize_session`（move:653-677）要求 `attestation_count_for(session, group_pk) >= threshold`（E_KEY_NOT_ATTESTED 3012）；`attest_group_key`（move:684-733）要求 Round1 公布的 32B attest 公钥对 `H(SUI_DKG_ATTEST_V1‖sid‖groupPk)` 的 ed25519 签名（E_ATTEST_SIGNATURE_INVALID 3018），防移植代签；只有已 confirm 的成员能申报（E_NOT_CONFIRMED 3011）。恶意成员的策略空间：完成 confirm（拿回 bond 的前提）但永远不 attest → 若诚实成员数 = threshold 恰好，差他一个就永不固化；或 attest 一个**错误的 key**（合约允许覆盖自己的槽位，move:722-726），诚实用 UI 读到的 `attested` 计数不包含错 key 者（dialog:790-796 sameKey 过滤，正确）。

**UI 面（缺陷）**：申报进度只有一处 —— 877 行 `logAttested`「当前 {{attested}}/{{needed}} 位成员申报」和 857 行 `logAlreadyAttested`，均为**聚合计数**。哪些人没申报：`handleFinalize` 在 793-796 行循环 `readGroupKeyAttestation` 逐人读了，但只把匹配者 push 进 `attested` 数组，**未申报者名单被丢弃**。半懂群主想知道"艾特谁"，UI 给不出名字；恶意成员因此享受完全的匿名拖延（链上数据公开，但用户得自己去 suiscan 翻动态字段）。同理 F-04：步骤 4 的确认进度 `confirmationsCount` 只在 778 行 `logConfirmationsBelow` 出数字，人名列表无。成员列表徽章（dialog:1078-1103）显示的 `memberSigned` 是**本机 localStorage 级别**的信息（见 F-10），与链上 confirmations 无任何同步——对恶意不 attest 者毫无威慑。

**修补建议（S-M）**：
1. dialog:792-796 循环里顺手收集 `pending = session.participants.filter(p => !attestedSet.has(p) && confirmedSet.has(p))`，在 `logConfirmationsBelow`/`logAlreadyAttested` 文案后追加「待申报：名单」（shortAddr 列表，样式复用 367 行 `logSkippedNoKey` 的 join("、") 模式）。
2. 成员列表徽章升级为三态数据源：链上 confirmations（已确认）/ 链上 attestation 匹配（已申报）/ 其余（未确认），在恢复 effect 与每次 handleFinalize 读取后刷新。这同时修复 F-04/F-10。
3. 长效：会话页加 5-10s 轮询 `readSession`+`readGroupKeyAttestation`，把「谁卡住」实时化（当前全部状态只在点击按钮时刷新，小白以为界面是死的）。

---

## 攻击 ④：手机端 gas 不足时的错误呈现

### F-06 MoveAbort 原文直出 + 成本不可见（低）

**链路**：`signAndExecuteWithWallet`（`lib/sui-wallet-signer.ts:164-275`）→ 钱包端 `signAndExecuteTransaction` 或本地 `executeSigned`。gas 不足有两种呈现：
1. **钱包构造/模拟阶段拒绝**（最常见，Slush/Suiet 在 build 时 dry-run）：钱包抛错 → `isWalletRejection`（signer:77-86）不匹配 → 原样 throw → 对话框 `describeError`（dialog 各 catch，如 292/379/627 行）只做 `errorMessage`（`lib/error-message.ts:11-15`：Error.message 直出）。手机上看到的是钱包的英文原文，如 "Failure to satisfy gas budget constraints" 或 base64 编码的 abort 串。
2. **交易上链后 MoveAbort**：`recordResult`（signer:118-134）把 `transaction.status.error?.message` 塞进 `misc.signer.execConfirmedFailed`（misc.ts:106）「Sui 交易已确认执行失败：{{reason}}」——reason 是形如 "MoveAbort(UserSubstatus(ModuleAddress(0xcdc8…), dkg_committee, 3004)) in ..." 的原始串。SDK 里现成的 `explainAbort`（`packages/multisig/src/agent-vault/org/constants.ts:295-323`，DKG_ERRORS 表 160-188 行含全部 3001-3029）**在 lib/、components/、app/ 全仓零调用**（grep 无匹配）——错误码翻译器造好了没接线。3004=E_SESSION_EXPIRED 明明可以翻成 dkg.ts:50 的 deadlinePassed 语义，小白却看到一串十六进制模块地址。

**gas 预算的第二重问题**：DKG 的三笔交易（创建会话 dialog:277-283 拆 0.005 SUI fee；提交承诺 dialog:338-343 拆 0.05 SUI bond；投递份额 dialog:439-449 n 笔 moveCall）gas 由钱包默认预算决定，前端从不 `setGasBudget`（grep 无匹配）。n=20 人的群投递 19 个 moveCall，钱包默认 budget 若不够，整笔 PTB abort，报错同样是原始串——而此时 bond 已在上一笔托管，小白分不清"哪笔成了哪笔没成"（回执机制 pending-transactions 能恢复，但 UI 只有一行 activeLog，无从区分三笔）。

**成本不可见（F-08，低）**：`SESSION_CREATION_FEE_MIST`/`MIN_BOND_MIST`（dialog:41-42，注释 275 行写着"创建费 0.005 SUI 销毁，bond 地板 0.05 SUI"）在发起按钮（dialog:1125-1128「发起限时 DKG（10 分钟）」——**连时限文案都是错的**，代码 276 行是 30 分钟，i18n key startBtn 写 10 分钟，dkg.ts:314）周围没有任何金额提示。小白不知道发起要烧 0.005 + 每人托管 0.05。

**修补建议（S-M）**：
1. 接线 explainAbort：dialog 的 `describeError` 处（或 lib/error-message.ts 内）对含 "MoveAbort" 的 message 先过 `explainAbort`（SDK 已导出），把 3004 翻成「会话已过期」，3003 翻成「已提交过」，3022 翻成「保证金不足（需 0.05 SUI + gas）」。改 `lib/error-message.ts:11-15` 一处即可全局受益。
2. startBtn 文案改为「发起限时 DKG（30 分钟，创建费 0.005 SUI）」，发起确认前用 `fetchRealBalances`（onchain-store.ts:100-103，已存在）校验余额 ≥ 0.055+gas，不足时给可操作文案（对齐 payments.ts:17 errInsufficientBalanceWithGas 的先例「当前钱包代币余额不足；另需 SUI 支付 gas」）。
3. 步骤 1 按钮 label 追加「（托管 0.05 SUI，可退）」；弹窗 INIT 面板 1037-1056 的 why-async 卡下加一行成本合计。

---

## 攻击 ⑤：两个 tab 同时操作

### F-07 签名层有锁、步骤层无锁（低）

**防线盘点**（这部分设计是认真的）：
- `withSigningLock`（signer:105-116）：Web Locks API `navigator.locks.request('sui-signing:<intent-key>', {ifAvailable:true})` 跨 tab 互斥，同 intent 二次进入抛 `misc.signer.signingLocked`「此操作正在等待签名，请勿重复点击」。锁粒度 = `transactionIntentKey`（`lib/pending-transactions.ts:32-34`）= account+action+scope。DKG 各步骤的 action：创建会话/固化带 options（dialog:660/811 显式 action+scope=sessionId），**其余步骤（承诺 345、投递 450、登记 487、确认 619、申报 876）都没传 options** → action 落到默认 "transaction"、scope = `JSON.stringify(tx.getData().commands)`（signer:169）——同一成员双 tab 同时点"提交承诺"，两笔 PTB 字节级相同 → scope 相同 → 锁住第二个，✓。
- 链上幂等：`E_ALREADY_SUBMITTED`(3003) 双保险（move:484/623）；mailbox `E_MAILBOX_ALREADY_DEPOSITED`(3019)（move:541-544）；`E_ENCRYPTION_KEY_CONFLICT`(3010)（move:578）。双 tab 竞态最终只有一笔成功，另一笔 abort 后被 recordResult 标 failed——**但 gas 双烧**（两笔都上链，败者 gas 照付）。
- 回执锁：`getPendingTransaction` 先查（signer:170-171），intent 相同且未 acknowledge → 抛 `recoveryPending` 引导查原 digest 而非重签，✓。

**残余缺口**：
1. **不同步骤的并发不互斥**：tab A 在步骤 1（承诺），tab B 直接点步骤 2（登记信箱）。两个 intent 的 scope 不同（commands 不同）→ 两把不同的锁 → 钱包连环弹两个签名窗。流程本身无害（两步骤顺序无关），但小白面对双弹窗会懵；若 tab B 因为 tab A 尚未提交承诺而 `readEncryptionKey` 读到 null 走 `createMailboxKey`（dialog:480，本机无 key + 链上无 key → 新建），是安全的（登记先写优先，move:578 拒后写）。真正麻烦的是**对话框层零互斥**：`initialMembers`/`sessionInput` 是各 tab 独立的 useState，一个 tab 切了群另一个不知道。
2. **dealerRef 各 tab 独立**：tab A 做了 Round1（dealerRef 在 A），tab B 想投递份额 → B 的 dealerRef 为 null → `dealerPolynomialMissing`（dialog:400-402）。这是**特性**（防跨设备复用多项式）但文案没说"请回到发起承诺的那个标签页"，小白在 B 里干瞪眼（dkg.ts:58 只说"本标签页没有"）。
3. **storage 事件同步**：`sui-account-switched` 是 window 内 CustomEvent，**跨 tab 只靠 storage 事件**（zklogin.ts:197 dispatch Event("storage") 是 fake 的——同 tab 才收得到；真正的跨 tab 同步靠 localStorage 写入触发的 StorageEvent）。tab A 切号写 `sui_active_account`，tab B 的 DKG 对话框**没有监听 storage**（dialog:125-130 只听 sui-account-switched）→ tab B 继续用旧 generation 跑完整个 confirm，最终在 `assertTransactionAccount` 处炸出 accountSwitched。防线存在（signer:168 expectedAccount / 各 check()），但呈现又是一条裸错误。

**修补建议（S）**：
1. dialog:125-130 的 effect 同时监听 `storage`（过滤 `event.key === "sui_active_account"`，对齐 `components/asset-custody.tsx:92` 的先例），把跨 tab 切号纳入同一 invalidate。
2. `dealerPolynomialMissing` 文案（dkg.ts:58）追加「若你在另一标签页提交了承诺，请回到该标签页继续投递」。
3. 每个步骤 handler 入口加组件级 `busy` state（对齐 887-890 行 isResharingBusy 的先例）禁用全部步骤按钮，防同 tab 双击 + 双 tab 同时点同一步的钱包双弹窗（锁只在 intent 级，PTB 字节不同时——例如 tab A 用旧 participants 快照——会放行两把锁）。

---

## 补充观察（不计入严重度）

- **onchain-store.ts**：`getProposals` 的 projection（onchain-store.ts:120-168）注释明确「original incomplete record is never rewritten by a read」，`resumeTransferProposalCreation`（373-380）「never sign again」——UX 攻击面（本地缓存投毒误导）在此文件无新增发现；`assertProposalContext`（311）+ `submitProposalVote` 的 membership 校验把切号/跨组投票挡住了。
- **sui-wallet-signer.ts** 的不确定态处理（`uncertain`，135-138）与「查原 digest 不重签」纪律是全仓最强的一块，本报告无发现；唯一建议是 F-06-1 的 explainAbort 接线（它同时改善所有流程而不止 DKG）。
- **成员迟到还有一条好路**：迟到者若在 deadline 前赶到，`loadSession`（dialog:211-225）+「只读导入」支持他凭会话 ID 加入任意轮次，且 `readDkgSessionLink` 按 holder 隔离（dkg-local-session.ts:22），跨账号不串——这块设计合格。
- **步骤 5 按钮故意不做 deadline disable**（dialog:1149-1153 注释）：链上 finalize 无时钟检查，quorum 已足的会话事后仍可固化。与合约 move:653-677 一致，是正确取舍，非漏洞。

## 修补优先级汇总

| 优先 | 项 | 工作量 | 改动点 |
|------|----|--------|--------|
| P0 | F-01 切号清理+关弹窗 | S | dkg-ceremony-dialog.tsx:126 |
| P0 | F-06-1 explainAbort 接线 | S | lib/error-message.ts:11 |
| P1 | F-03 超时/退保证金入口 | M | dialog:1106-1123 + vault-client.ts:178-181 已有 facade |
| P1 | F-04/F-05 谁卡住名单 | S-M | dialog:792-796 循环 + 1078-1103 徽章数据源 |
| P2 | F-02 分流引导文案 | M | dialog:401 抛错处按 readQualifiedDealers 分支 |
| P2 | F-07 storage 监听 + busy 态 | S | dialog:125-130, 1133-1148 |
| P3 | F-08/F-06-2 成本与 30 分钟文案 | S | dkg.ts:314 startBtn + dialog:1125 |
| P3 | F-09 进行中拦截关闭 | S | components/ui/dialog.tsx:38 |
| P3 | F-10 恢复时回填确认态 | S | dialog:159-165 |
