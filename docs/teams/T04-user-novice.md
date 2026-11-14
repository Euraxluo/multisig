# T04 · 用户·小白群主组报告：从「我只想把群变成 DAO 存钱」走完全路径

- 角色：非技术群主（主视角）／社群运营／财务管理员
- 方法：零代码先验，只按 UI 文案与交互流走读。所有困惑点均给出 `文件:行号` 证据。
- 结论先行：从打开网站到「金库里的钱能按票数转出去」，**一名小白群主要跨越 4 大阶段、约 22 次交互、6 次以上钱包弹窗签名、准备 3 个以上钱包和约 1+ SUI 的 gas**；其中 DKG 仪式一段（阶段 C）术语密度和掉线风险最高，是最大流失点；其次是「本地草稿≠链上群」的心智错位（阶段 B 开头）和「执行提案还需另跑门限签名」的最后一公里（阶段 D 末尾）。

---

## 一、完整用户旅程图（每步截图式描述）

### 阶段 A：进入与连接（预计 3–8 分钟，含装钱包）

**A1. 首屏 + 三步引导弹窗**
打开 `/`，先弹出 3 步引导（`components/first-run-dialog.tsx:17-33`）：①「群组金库，多人共管」讲门限转账；②「连接钱包开始」明示"当前为测试网，无真实资金"；③「创建或加入群组」。底部有「测试网演示数据，操作不会动用真实资金」免责声明（`lib/i18n/dictionaries/shell.ts:33-43`）。
小白视角：前两步能看懂，第三步"用邀请链接加入已有群组"埋了一个后面会兑现不了的预期（见困惑点 #3）。

**A2. 默认落在「待办」Tab**
关掉引导后看到的是"待办"页而非群组页（`app/page.tsx:24,34` `TAB_IDS` 默认 `pending`）。顶部一张「连接钱包后开始使用」提示卡（`components/pending-work.tsx:59-80`），点「连接钱包」。

**A3. 连接钱包弹窗（4 种登录方式）**
弹窗里有三个 Tab：钱包 / Passkey / Google（`components/connect-wallet-dialog.tsx:231-278`）。
- 钱包 Tab：检测浏览器扩展，没装则列出 Slush、Suiet、OKX、Nightly、Martian 五个安装建议（`connect-wallet-dialog.tsx:33-39`）——小白需要先离开网站去装钱包再回来。
- Passkey / Google(zkLogin) 是无钱包选项，但 Google 依赖服务端配置，未启用时只显示一段说明文字（`connect-wallet-dialog.tsx:269-276`）。
小白视角：没有任何一条「我该选哪个？」的推荐线。

**A4. 领测试币（隐含步骤）**
界面**没有**领水龙头入口或指引（`grep faucet/领水` 全前端无命中）。小白需要自己去 sui 官方 discord/faucet 领 testnet SUI，否则后续每一步签名都会因 gas 不足失败。

### 阶段 B：建群（本地草稿）——最容易产生误解的一段

**B1. 找到「新建组」入口**
底部导航 5 个 Tab：待办/支付/群组/AI副卡/我的（`components/mobile-navbar.tsx:199-228`）。要进「群组」Tab（代码里叫 dashboard），再点右上「新建组」（`components/dashboard.tsx:175-182`）。

**B2. 创建群组向导 3 步**
弹窗顶部有一行灰字：「创建本地群组草稿……完成 DKG 后再创建链上组织」（`lib/i18n/dictionaries/groups.ts:408`）。
- 第 1 步：填群名、描述；网络下拉框列出 Sui/Ethereum/Solana/Polygon 四项，但下面灰字写「草稿当前仅支持 Sui 网络；选择其他网络只会在本机记录该标注」（`create-group-dialog.tsx:330-342`，`groups.ts:419`）。
- 第 2 步：加成员。可以搜索链上关注列表（需先配置身份协议，否则静默为空 `create-group-dialog.tsx:74-75`）、扫码、或手输 `0x…` 地址/邮箱占位。每人有一个 1–10 的权重滑杆（`create-group-dialog.tsx:644-653`）。「审批门限」滑杆显示 `2 of N (xx%)`，提示语是「交易至少需要 {{threshold}} 权重单位才能通过」（`groups.ts:436`）。
- 第 3 步：确认页，底部再次提示「此草稿只保存在本机浏览器（localStorage），不会写入 Sui 链上，也不会向成员发送邀请」（`groups.ts:410`）。
- 点「创建群组草稿」→ 顶部绿色提示「已保存」→ 弹窗关闭（`create-group-dialog.tsx:202-232`，纯 localStorage 写入，不上链）。

**B3. 打开群组详情**
群组卡片列表出现新群，点击进入 `/groups/[id]` 独立页（`components/dashboard.tsx:213`；页面壳 `app/groups/[id]/page.tsx`）。顶部横幅显示群名 + 余额位置显示「暂无已核验 SUI 托管」之类的占位（`group-details-view.tsx:1049-1051`）。8 个 Tab：群聊/成员/AI/文件/Tx/收款/收益/托管（`group-details-view.tsx:1069-1118`）。默认落在「群聊」Tab，而群主要找的「固化为 DAO」按钮藏在**成员 Tab**里。

### 阶段 C：DKG 仪式（核心流失段）

**C1. 成员 Tab →「固化为 DAO」**
成员 Tab 顶部一张绿色卡片：「当前为多签群组 / 随时执行 DKG 仪式上链固化为 DAO」+ 按钮「固化为 DAO」（`group-details-view.tsx:1502-1517`；`groups.ts:184-186`）。点开 DKG 仪式弹窗。

**C2. 仪式弹窗首屏（INIT 态）**
弹窗标题「升级为链上组织 (DAO)」，副标题「成员确认即可完成升级，无需同时在线」（`dkg.ts:320,326`）。信息量极大的一屏：
- 蓝色「为什么必须 100% 全异步」卡片，4 条术语解释（真实世界痛点/单阶段投递/门限容错(3/4 Quorum)/全异步治理，`dkg-ceremony-dialog.tsx:1037-1056`）；
- 「导入链上 DKG 会话」输入框 + 「只读导入」按钮（给其他成员回填会话 ID 用，`dkg-ceremony-dialog.tsx:1058-1069`）；
- 成员卡片墙，每人一个「待确认/待签名」徽章（`dkg-ceremony-dialog.tsx:1077-1103`）。

**C3. 群主点「发起限时 DKG（10 分钟）」**
按钮文案写 10 分钟（`dkg.ts:314`），但代码实际设置 30 分钟（`dkg-ceremony-dialog.tsx:276` `Date.now() + 30*60*1000`）。点击后钱包弹窗 #1：创建会话交易，**创建费 0.005 SUI 直接销毁**（`packages/multisig/src/agent-vault/org/constants.ts:67`），代码对 deadline 只做了 [10min,7d] 钳制（`dkg-ceremony-dialog.tsx:275` 注释）。界面上**没有任何费用预告**。

**C4. 五个步骤按钮逐一点**
会话创建后弹窗出现 5 个纵向按钮（`dkg-ceremony-dialog.tsx:1129-1157`）：
1. 「1. 提交本轮承诺」——钱包签名 #2，同时**原子托管 0.05 SUI bond**（`dkg-ceremony-dialog.tsx:335-344`）。同样没有费用预告；这笔押金要等会话终态后自己调 `claim_bond` 取回，而**前端全库没有任何 claim_bond 按钮**（`grep claim_bond components/ lib/` 仅命中文案注释）。
2. 「2. 登记信箱公钥」——钱包签名 #3。
3. 「3. 投递密封份额」——钱包签名 #4，一笔 PTB 给每个成员投一份加密份额。
4. 「4. 验证份额并上链确认」——钱包签名 #5，本机分片先写 IndexedDB 再确认。
5. 「5. 重算群公钥 / 申报 / 固化」——钱包签名 #6（申报）+ 可能 #7（finalize）+ #8（创建组织）。
每步之间靠底部一行小字状态日志（`dkg-ceremony-dialog.tsx:1026-1032`）反馈，进度条只在单步内部闪现。
**注意门限覆盖**：代码把仪式门限强制为 `ceil(人数×0.6)`（`dkg-ceremony-dialog.tsx:274`），**忽略建群时设的权重/门限**；组织名册里每人权重一律为 1（`contracts/agent_vault/sources/cryptographic_org.move:344`），而 UI 从未告知这两点。

**C5. 协调其他成员**
群主要把 66 位的会话 ID（`0x…`）发给每个成员，成员各自打开网站→进群（或导入会话 ID）→重复 C4 的 5 步。会话 ID 输入框在弹窗中间（`dkg-ceremony-dialog.tsx:1061`），**没有复制/分享按钮，也没有邀请链接**（`grep Share components/dkg-ceremony-dialog.tsx` 无 UI 命中）。30 分钟倒计时红色警示条常驻（`dkg-ceremony-dialog.tsx:1106-1123`），到期后按钮变灰但第 5 步仍可点（finalize 不受时限，`dkg-ceremony-dialog.tsx:1149-1157` 注释）。

**C6. 完成态（COMPLETE）**
绿色卡片显示：链上核验状态徽章、Epoch N、群公钥（Ed25519 Group PK）、组织对象 ID（Suiscan 链接）、部署交易摘要；下面「本设备门限分片」卡片（显示 t-of-n）；再下面「动态换届重分片 (Gennaro Resharing)」卡片和「重分片」按钮（`dkg-ceremony-dialog.tsx:1196-1330`）。成员 Tab 的卡片变成紫色「已固化为 DAO · Epoch 1」。

### 阶段 D：开金库存钱 → 花钱（财务管理员视角）

**D1. 收款 Tab → 创建国库**
收款 Tab 顶部是「群组金库」面板：无国库时显示虚线框「暂无国库」+「+ 创建国库」按钮（`components/group-treasury.tsx:103,118`）。钱包签名 #N：`organization_treasury::new + share`（`packages/multisig/src/agent-vault/finance/treasury.ts:13-18`）。

**D2. 充值**
点「注资或分享」打开「组织金库与充值码」弹窗：大二维码 + 只读链接 + 输入金额后另签一笔充值交易（`components/group-treasury.tsx:125-223`；`groups.ts:481-482`「链接默认只读取金库。充值需输入金额并由当前钱包另行确认」）。管理员也可直接把二维码/链接发给群友扫码入金。

**D3. 发起转账提案**
Tx Tab →「新建转账提案」（`group-details-view.tsx:1800-1807`）→ 填标题/收款地址/金额（仅 SUI）→ 钱包签名创建链上提案（`lib/onchain-store.ts:382-434`），默认 7 天截止（`onchain-store.ts:397` `Date.now()+86400000*7`）。

**D4. 成员投票**
每个成员在待办/Tx 详情里点「批准并签名」（`components/transaction-details-dialog.tsx:472`），每次批准是一笔链上投票交易（`onchain-store.ts:478-479` `submit_async_vote`）。票重达到门限后状态变 approved。

**D5. 执行转出（最后一公里，也是暗坑）**
状态 approved ≠ 钱到账。执行走「permissionless relay」，但合约要求 **nonce + FROST 门限签名**（`packages/multisig/src/agent-vault/finance/treasury.ts:29-33`；`lib/group-vaults.ts:411` 明确抛错「执行 treasury 转出需要门限签名（nonce + FROST 签名），请先完成签名会话」）。也就是说持有分片的成员还得再跑一轮跨设备 FROST 签名会话（成员 Tab → 名册换届/跨设备 FROST 入口，`groups.ts:360-367`）。小白群主在 D4 完成后会以为「批准了就该自动到账」，在 UI 里找不到「执行」主入口或不知道为什么不能点。

---

## 二、20 个困惑点（按流失风险从高到低排序）

| # | 困惑点 | 证据 | 流失风险 | 建议（工时 S/M/L） |
|---|--------|------|----------|--------------------|
| 1 | **DKG 五步按钮像考试**：群主不知道 1–5 步谁先谁后、自己点完还要等谁；每步只有一个钱包弹窗 + 一行日志，没有"现在轮到谁"的可视化 | dkg-ceremony-dialog.tsx:1129-1157 | 极高：仪式卡住=群建不成 | 向导化：按链上 session.status 自动只亮当前可点的 1 个按钮，其余折叠（M） |
| 2 | **成员如何加入仪式没有通路**：要手动转发 66 位会话 ID，弹窗无复制/分享按钮、无邀请链接；onboarding 第 3 步却承诺"用邀请链接加入" | dkg-ceremony-dialog.tsx:1061；shell.ts:38；groups.ts:410「不会向成员发送邀请」 | 极高 | 加「复制会话 ID / 生成邀请链接（含 ?dkg=session）」按钮 + 成员侧一键导入（S） |
| 3 | **权重和门限在建群时白设了**：建群滑杆精心设置权重 1-10 与门限，DKG 却强制 `ceil(n×0.6)` 且链上每人权重=1 | create-group-dialog.tsx:644-674；dkg-ceremony-dialog.tsx:274；cryptographic_org.move:344 | 高：事后发现"说好的 2/3 权重制呢" | 仪式发起前弹确认「链上门限将为 X/Y（每人 1 票），与你草稿设置不同」（S）；或透传草稿门限（M） |
| 4 | **费用零预告**：0.005 SUI 创建费销毁 + 0.05 SUI bond 托管 + 每步 gas，发起前一个数字都没有 | constants.ts:67,69；dkg-ceremony-dialog.tsx:278,339 无费用 UI | 高 | 发起按钮旁列出「创建费 0.005 SUI（销毁）· 保证金 0.05 SUI（可退）」（S） |
| 5 | **bond 押金没有取回入口**：`claim_bond` 只有合约入口，前端零 UI，0.05 SUI 对小白是"钱没了" | contracts dkg_committee.move:222「会话进入终态后由本人 claim_bond 全额取回」；grep claim_bond 前端仅注释 | 高 | COMPLETE/超时态加「取回保证金」按钮（S） |
| 6 | **本地草稿≠链上群的心智错位**：创建按钮叫「创建群组草稿」，但新手预期是"群已建立、成员已被邀请"；网络下拉给 4 个选项但只有 Sui 有效 | create-group-dialog.tsx:202-232,330-342；groups.ts:410,419 | 高 | 网络选择只留 Sui + 删除误导选项；草稿完成页直接给「下一步：发起 DKG」引导（S） |
| 7 | **执行提案需要再跑一轮 FROST 签名会话，UI 无主入口**：approved 后执行按钮弱、且必须门限签名，错误文案才解释 | group-vaults.ts:411；treasury.ts:29-33；transaction-details-dialog.tsx:83 | 高 | approved 态加醒目「执行转出（需 t 份分片签名）」向导，串起签名会话（M） |
| 8 | **倒计时文案自相矛盾**：按钮写「10 分钟」，实际 30 分钟；到期提示又说"门限由链上 threshold 决定，不是固定数字"，三处口径不一 | dkg.ts:314 vs dkg-ceremony-dialog.tsx:276 vs dkg.ts:deadlineExpiredBody | 中高 | 统一为实际毫秒数并显示"剩余 mm:ss"（已有秒数，补文案）（S） |
| 9 | **术语无词典**：threshold/epoch/attest/bond/mailbox/dealer/DKG/FROST/reslicing 全靠蓝色卡片一次带过；epoch 只显示 "Epoch 1" 徽章无解释 | dkg.ts:91 只输出 "Epoch {{epoch}}"；grep 术语/glossary 全无 | 中高 | 加可点 ❓ 弹层：threshold=几个人点头才放行；epoch=密钥第几代；attest=成员背书同一把钥匙；bond=可退押金（S） |
| 10 | **「固化为 DAO」入口藏在成员 Tab**：群主找的是"金库/资金"，默认 Tab 却是群聊 | group-details-view.tsx:128 默认 "chat"；1502-1517 在 members | 中 | 草稿态在群聊/收款 Tab 顶部放转化横幅（S） |
| 11 | **登录方式选择困难**：钱包/Passkey/Google 三 Tab 无推荐；没装钱包要跳出去装；Google 可能未启用 | connect-wallet-dialog.tsx:231-278,33-39 | 中 | 首选项检测：有扩展默认钱包 Tab，否则推荐 Passkey 并一句话说明（S） |
| 12 | **没有领水指引**：testnet SUI 从哪来界面只字未提 | grep faucet 全前端 0 命中 | 中 | 连接成功后若 gas 余额=0，提示卡给 faucet 链接（S） |
| 13 | **成员不在名册也能点仪式**：非参与者点「提交承诺」要到链上报错才知道自己不行；群主无法从 UI 看谁已完成哪步 | dkg-ceremony-dialog.tsx:311 `notParticipant` 抛错路径；1092-1094 徽章仅本机状态 | 中 | 仪式弹窗拉链上 confirmations 实时点亮成员徽章（M） |
| 14 | **刷新=Dealer 多项式丢失**：中途刷新页面，Round2 会报「本标签页没有 Dealer 多项式」这种工程师文案 | dkg-ceremony-dialog.tsx:113-117,400-402；dkg.ts dealerPolynomialMissing | 中 | 文案改写为「页面刷新过，请回到第 1 步重查原承诺交易」+ 恢复按钮（S） |
| 15 | **群聊频道要另建且要质押参数**：默认 Tab 是群聊，但发消息需先创建 onchain channel，表单冒出创建者质押/门票/成员质押/BPS 四个金融参数 | group-details-view.tsx:1424-1432；groups.ts:166-168 | 中 | 预填 0/0/0 一键免费建；高级参数折叠（S） |
| 16 | **提案默认 7 天截止但不可见**：创建时不显示截止时间字段，列表里才有小字 | onchain-store.ts:397；create-transaction-dialog.tsx 无 deadline 输入 | 中低 | 创建表单露出截止时间可调（S） |
| 17 | **错误信息是原始 MoveAbort**：链上 abort（如 3003/3011）直接透传给用户，无码表翻译 | dkg.ts 错误文案虽全但按异常路径分支；lib/error-message.ts 仅取 message 无码表 | 中低 | 建 abort code→中文表（org 1001-1012 / dkg 3001-3028 已有登记）（M） |
| 18 | **两个「多签」概念并存**：草稿里是权重多签（threshold of totalWeight），链上是 FROST 门限（t-of-n 设备分片），文案交替使用不加区分 | create-group-dialog.tsx:664 vs dkg-ceremony-dialog.tsx:914 注释「on-chain weighted threshold is a different number」 | 中低 | 全局改称「审批票数」与「密钥签名份数」两个词（S） |
| 19 | **Google 登录隐含 epoch 过期**：zkLogin 会话带 epochTtl，长期群主可能某天突然要重登，无预告 | connect-wallet-dialog.tsx:20-21 epochTtl 字段 | 低 | 登录卡注明「Google 登录会定期过期，群主建议用钱包/Passkey」（S） |
| 20 | **首页落在「待办」而非「群组」**：新手最想要的入口在第二个 Tab | app/page.tsx:34 默认 "pending" | 低 | 无群组且未连接时默认 dashboard（S） |

---

## 三、冷启动 checklist 草案（群主版）

> 用途：发给想"把群变成 DAO 存钱"的群主，照单备齐再开工，中途不掉链子。

**① 人与钱包（提前 1 天）**
- [ ] 确定创始成员名单（建议 3–5 人起步；人数越多仪式越难凑齐）
- [ ] 每位成员各自装好 Sui 钱包（Slush / Suiet / OKX 任一）并完成助记词备份
- [ ] 每人领 ≥ 0.3 SUI testnet 币（界面无水龙头，去 Sui Discord #testnet-faucet；预算参考：发起者另需 0.005 创建费 + 0.05 bond + gas，全员每人约 5–8 笔交易 gas）
- [ ] 互相收集钱包地址（0x 开头 66 位），最好当面扫码核验

**② 建草稿（群主 5 分钟）**
- [ ] 群组 Tab → 新建组 → 只选 Sui 网络 → 录入成员地址
- [ ] 注意：建群时设的权重/门限只是草稿备注，**上链后每人 1 票**、门限自动取 ⌈人数×0.6⌉（3 人→2，5 人→3）
- [ ] 草稿只存你的浏览器，成员此时什么都看不到——需要你把网站和后续会话 ID 发给他们

**③ DKG 仪式（全员 30 分钟窗口，重点盯第 1–20 分钟）**
- [ ] 群主：成员 Tab →「固化为 DAO」→「发起限时 DKG」→ 钱包确认（烧 0.005 + 押 0.05，押金可退但记得取）
- [ ] 立即把会话 ID（弹窗当前会话 0x…）原样发到群里的每位成员
- [ ] 每位成员（含群主自己）：打开网站 → 连接钱包 → 进群 → 固化为 DAO → 粘贴会话 ID → 依次点 1→2→3→4→5 五个按钮，每个都过一次钱包签名；**中途不要刷新页面**
- [ ] 群主观察成员徽章/状态日志，凑够门限后点第 5 步完成固化
- [ ] 完成态核对：绿色「链上已核验」徽章 + Epoch 1 + 组织 ID 能在 Suiscan 打开
- [ ] 会话结束后回弹窗找「取回保证金」（若 UI 暂无此按钮，记录这笔 0.05 SUI 待后续版本取回）

**④ 开金库存钱（财务管理员 10 分钟）**
- [ ] 收款 Tab → 创建国库 → 钱包确认
- [ ] 点「注资或分享」获得充值二维码/链接，发给群友或自己充值
- [ ] 核对余额出现在群组头部「已核验 SUI 托管余额」

**⑤ 第一笔支出演练（全员，趁热）**
- [ ] Tx Tab → 新建转账提案（小额！如 0.1 SUI，收款地址用群主自己的另一个钱包）
- [ ] 各成员在待办/Tx 详情中「批准并签名」，直到状态变 approved
- [ ] 持分片成员完成跨设备 FROST 签名会话后执行转出（注意：**批准满票不会自动到账，必须再签名+执行**）
- [ ] 收款钱包到账 → 截图发群里庆祝，冷启动完成

**避坑三句话**：仪式中别刷新页面；approved ≠ 到账，还要签名执行；所有"待核验/本机记录"字样都表示还没上链，认准绿色「链上已核验」徽章。

---

## 四、给主代理的优先级摘要

1. 一等修复（直接决定小白能不能走通）：困惑点 #1 仪式向导化、#2 会话分享通路、#7 执行最后一公里、#5 bond 取回入口。
2. 二等修复（决定敢不敢走）：#4 费用预告、#3 权重门限口径、#9 术语词典、#8 倒计时文案。
3. 文案级快速修（半天内可全部落地）：#6 网络选项误导、#10 入口位置、#12 领水指引、#20 默认 Tab。
