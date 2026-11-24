# T10 优化机会组报告：架构债 / 测试债 / 运维 / 死代码与依赖

> 执行人：T10OptTeam（架构师 / 测试工程师 / 运维三视角）· 2026-11-14
> 方法：全部结论来自本机实测——`sui move test` 实跑（421/421，4.19s）、`tsc --noEmit` 实跑（SDK 与根均 0 error）、`tsx --test` 实跑 lib+SDK 全部 TS 测试、`node scripts/rt9-fixtures-v2.mjs` 实跑比对 Move 常量、import 图全量扫描（413 文件）、错误码逐符号比对（sources ↔ tests ↔ SDK 常量表）。零链上开销。
> 排序原则：先"会咬人的"（正在坏 / 门禁盲区 / 密码学分叉），再"会腐烂的"（重复实现 / 漂移），最后"碍眼的"（死文件 / 死依赖）。

---

## TOP15 优化清单

### 1.【P0·测试债】proposal-chain.test.ts 32/61 失败——fixture 停在 11-05 的 Organization BCS 布局
- **现状**：`npx tsx --test lib/*.test.ts lib/crypto/*.test.ts` 实测 **695 pass / 32 fail**，全部 32 个失败集中在 `lib/proposal-chain.test.ts`（29 pass / 32 fail）。失败形态：`Error: ULEB decode error: buffer overflow`，栈顶 `lib/proposal-chain.ts:114`（`ProposalContent.parse`）。
- **根因（已实锤）**：测试文件最后一次改动是 commit `ab79371`（2026-11-05），fixture（`lib/proposal-chain.test.ts:37` `organizationFixture`，152 字节）按当时 8 字段 `OrganizationContent`（`git show ab79371:lib/proposal-chain.ts:16-20`：id/group_pk/threshold_weight/epoch_version/last_nonce/chain_id/members_weight/executed_proposals）编码——用旧 schema 解析实测通过。此后 `lib/proposal-chain.ts:16-26` 的本地 `OrganizationContent` 追加了 `key_signers`、`key_threshold`、`genesis_stake/genesis_bonded_total/genesis_withdrawn/genesis_unlock_at_ms`（2026-11-13 准入经济学）与 `key_generation`（round-9），Move 侧真实布局见 `contracts/agent_vault/sources/cryptographic_org.move:72-95`。fixture 落后 40 字节，全部 BCS 解析路径溢出。
- **为什么是债**：audit 声称的"Move 421/421 全绿"掩盖了 TS 侧一个已经红了一周以上的套件；`lib/proposal-chain.ts` 是提案审批（validateApproval/资金执行）的读路径，其测试实际上处于"假绿"状态——没人知道它红着。
- **改进方案**：按 `cryptographic_org.move:72-95` 重生成 152→192 字节级 org fixture（genesis_* 与 key_generation 各 8 字节 u64 尾追加，genesis_stake 是 Balance<SUI>=裸 u64）；同法修 `proposalFixture` 若受影响（实测 Proposal 自身布局未变，260B roundtrip 通过，只需修 org fixture）。根治：删掉 `lib/proposal-chain.ts:16-26` 的本地 `OrganizationContent` 重复定义，改 import SDK 的 org schema（SDK 已有 `multisig/agent-vault/org`）——重复定义正是这次漂移的根因。
- **工作量**：M（fixture 重生成 2h + 去重定义回归 4h）

### 2.【P0·测试债】TS 测试套件不在任何门禁里——32 个失败存在了 ≥9 天无人发现
- **现状**：四道门禁（`docs/DEPLOYMENT_RUNBOOK.md:96-101`）只有 G1 Move / G2 SDK tsc / G3 next build / G4 线上 curl。`lib/`+`lib/crypto/` 共 65 个 `*.test.ts`、SDK 5 个 `*.test.ts` 不属于任何门禁；无 CI（见 #3）、无 pre-commit hook（`.git/hooks` 仅 sample，`git config core.hooksPath` 为空）。
- **为什么是债**：#1 的 32 个失败自 11-05 起就存在，因为没有任何自动化会在 TS 测试红时拦截。测试写得越认真（lib 695 个用例质量很高），不被运行浪费得越彻底。
- **改进方案**：CI 或 pre-push hook 加一步 `pnpm exec tsx --test "lib/**/*.test.ts" "packages/multisig/src/**/*.test.ts"`（实测 dkg 21 pass、可跑通）；失败一票否决。
- **工作量**：S（CI 无 yeoman 成本：一个 workflow yml 或 husky + 一行命令）

### 3.【P0·运维】完全没有 CI，且 runbook 的 G2 命令本身是错的
- **现状**：`.github/` 不存在（`ls .github` → No such file or directory），无 husky/lint-staged，四道门禁全部手工。更糟：runbook `docs/DEPLOYMENT_RUNBOOK.md:19,99` 写的 G2 命令 `pnpm --filter @multisig/sdk tsc --noEmit` **实跑失败**——`packages/multisig/package.json:2` 包名是 `multisig` 而非 `@multisig/sdk`，输出 `No projects matched the filters`。按 runbook 执行发版的人会在 G2 得到假失败（或跳过）。
- **为什么是债**：发版四道门禁是唯一的质量契约，文档命令与现实脱节 = 门禁形同虚设；同时无 CI 意味着每次发版靠人记得跑四条命令。
- **改进方案**：① 修 runbook 命令为 `pnpm --dir packages/multisig exec tsc --noEmit`（实测 1.4s 通过）；② 建 `.github/workflows/ci.yml`：G1 `sui move test`（实测 4.2s，可缓存 Sui 依赖）+ G2 tsc + G3 next build + `tsx --test` 全 TS 套件；③ G4 保留人工（涉及真实域名）。
- **工作量**：S（workflow yml 50 行内）

### 4.【P1·架构债】两套 FROST 实现并存于两条生产 UI 路径
- **现状**：SDK `packages/multisig/src/dkg/threshold_signer.ts`（318 行，手写 RFC 9591 §4.4 逐参与者绑定因子 ρ_i，round-7/9 加固过）服务 `dkg-ceremony-dialog` → `lib/crypto/committee-signing.ts:26`；而 `components/group-roster-dialog.tsx:40` 走 `lib/frost-session.ts`，后者 import 的是 `@noble/curves` 的 **`ed25519_FROST`**（`lib/frost-session.ts:2,54,190`）——noble 库自带的另一套 FROST。两条路径都活着、都在签真实组织操作。
- **为什么是债**：① 密码学面分叉：同一个"组织门限签名"语义由两套独立实现承担，审计面翻倍；② round-9 修的 resharing 窗口/绑定因子类问题，必须在两处同时验证不再犯；③ `lib/frost-session.ts`（326 行）与 SDK threshold_signer 的 nonce/承诺/Lagrange 逻辑平行演化，未来必然漂移。
- **改进方案**：统一到 SDK FROST1 单栈：`lib/frost-session.ts` 的签名核心改调 `multisig/dkg` 的 `ThresholdSignerNode`（`lib/crypto/committee-signing.ts:60-85` 已示范了完整封装模式），noble `ed25519_FROST` 仅留作交叉验证断言（签名互验一次后删除依赖路径）。合并前用 rt9 复跑脚本对两实现做等价性回归（同分片同消息同签名）。
- **工作量**：L（ frost-session 326 行重构 + group-roster-dialog 适配 + 等价性回归；但收益是删掉一整条密码学实现）

### 5.【P1·测试债】52/97（54%）的链上错误码没有任何 expected_failure 测试
- **现状**：逐符号扫描 `abort_code = agent_vault::<module>::<E_*>`（fixed-string，防数字巧合），12 模块 97 个数字错误码中 52 个零引用。重点缺口：
  - `dkg_committee` 17/28 未覆盖，含安全最关键的 `E_SMALL_ORDER_PUBLIC_KEY`(3027, `dkg_committee.move:30`)、`E_PAYLOAD_MISMATCH`(3008)、`E_ATTEST_SIGNATURE_INVALID`(3018)、`E_INVALID_COMMITMENT`(3015)、`E_ENCRYPTION_KEY_CONFLICT`(3010)、`E_SESSION_EXPIRED`(3004)、`E_ALREADY_SUBMITTED`(3003)、`E_BOND_ABOVE_MAX/BELOW_MIN`(3021/3020)；
  - `asynchronous_proposal` 14/19 未覆盖，含 `E_THRESHOLD_SIGNATURE_INVALID`(2701)、`E_SUBAGENT_CAP_EXPIRED`(4006)、`E_INVALID_NONCE`(4016)；
  - `scallop_yield_adapter` 5 个错误全部无 expected_failure（`scallop_yield_adapter.move:12-16`；7004/7005 还是 11-13 新增接口）；
  - `onchain_chat` 8/20（`E_CAP_EXPIRED`、`E_INSUFFICIENT_STAKE`、`E_INVALID_BPS_SUM` 等资金相关）；
  - `vault` 3/14（`E_AGENT_PAUSED`、`E_CAP_VERSION_MISMATCH`、`E_INSUFFICIENT_VAULT_BALANCE`）。
- **为什么是债**：这些分支是攻击面本体（红队第 9 轮打的就是 resharing 窗口/payload mismatch 一类），但防回归的断言不在；重构时这些分支被改坏不会有任何测试变红。421 个测试的"全绿"给了超出实际的信心。
- **改进方案**：按模块补齐优先级排序的 expected_failure：dkg(17) → async_proposal(14) → chat(8) → scallop(5) → vault(3) → org(6, 多为创世参数校验)。多数是"构状态→错误调用→断言码"模板，`dkg_committee_tests.move` 现有 107 个测试即模板库。
- **工作量**：M（52 个用例 × 平均 20 分钟 ≈ 每模块半天，共 3 人日）

### 6.【P1·架构债】SDK 内 5 个零消费者模块共 1241 行挂在安全关键包 barrel 里
- **现状**：`packages/multisig/src/dkg/` 的 `async_coordinator.ts`(346L)、`fully_async_dkg.ts`(223L)、`ai_sentinel.ts`(281L)、`mailbox.ts`(236L)、`ceremony.ts`(155L) 仅被 `src/dkg/index.ts:6-10` 的 `export *` 引用；全仓 import 图扫描零外部消费者。尤其 `dkg/mailbox.ts` 是 x25519+HKDF 实现，而生产实际用的信箱是 `lib/dkg-mailbox.ts`（214L，P-256 ECDH+HKDF+AES-GCM，`components/dkg-ceremony-dialog.tsx` 在用）——**同名不同密码学**，是未来的实现选错风险点。
- **为什么是债**：SDK 是 8.6k 行的密码学包，14% 的代码没有任何测试外消费者；`tsc --noEmit` 只查类型不查语义，这些文件坏了（或被误用）没有信号。mailbox 同名撞车尤其危险。
- **改进方案**：三选一：① 删（git 里永远在）；② 挪 `packages/multisig/src/dkg/_experimental/` 并从 barrel 摘除；③ 若 async_coordinator/fully_async_dkg 是路线图功能，补最小测试并标注实验状态。mailbox 必须改名或删除。
- **工作量**：S（删/摘 barrel 半小时；选③才需要 M）

### 7.【P1·死代码】lib/crypto/threshold_signer.ts：130 行旧单 nonce Schnorr 签名器，零引用
- **现状**：`lib/crypto/threshold_signer.ts:19` `ThresholdSignerNode`（旧 `R = Σr_i` 单 nonce 方案，**无承诺绑定**——正是 round-9 报告确认可被抵消攻击利用、随后在 SDK 侧用 RFC 9591 ρ_i 修掉的弱点形态）。全仓 import 扫描：零消费者（`lib/crypto/committee-signing.ts:26` 用的是 `multisig/dkg` 的同名类）。文件停留在 2026-10-20（`git log`：vendor 重构）。
- **为什么是债**：一个"知道怎么写出不安全门限签名"的活样板躺在 `lib/crypto/` 里；任何后续开发者 grep 到它可能复用——同名类加剧风险。它还是 #9 重复三件套的第三件。
- **改进方案**：直接删除该文件（无消费者，删除零风险）；顺带在 `lib/crypto/` 留一个指路注释已无必要——`committee-signing.ts` 头注释已写明委托关系（`lib/crypto/committee-signing.ts:5-9`）。
- **工作量**：S

### 8.【P1·架构债】错误注册表漂移：SDK 常量表缺 20 个码；explainAbort 零消费者
- **现状**：逐码比对 `packages/multisig/src/agent-vault/org/constants.ts` 的注册表 vs `contracts/agent_vault/sources/*.move`：
  - `VAULT_ERRORS` 止于 2014，缺 `vault.move:26` `E_INVALID_SERVICE_HASH = 2015`；
  - `DKG_ERRORS` 缺 `dkg_committee.move:42` `E_INVALID_PARTICIPANT_SET = 3014`；
  - `ASYNC_PROPOSAL_ERRORS`（`constants.ts:153-157`）只有 2701/4017/4018，缺 `asynchronous_proposal.move` 的 4001–4016 共 16 个码；
  - `SCALLOP_ERRORS` 只有 7001–7003，缺 `scallop_yield_adapter.move:15-16` 的 7004/7005。
  - 另外 `explainAbort`（`constants.ts:300`）把 MoveAbort 子状态翻译成可读文本，但全仓（lib/components/app/scripts）**零调用**；前端真正的错误渲染是 `lib/error-message.ts:10` 的 `errorMessage()`——它只透出 `error.message`，从不解析 abort 数字码。也就是说 3 个 UI 组件（`components/dkg-ceremony-dialog.tsx`、`create-transaction-dialog.tsx`、`transaction-details-dialog.tsx`）show 给用户的失败信息里没有链上错误码语义。
- **为什么是债**：#180 记忆里"摘要字段变更必须四处同步"的同类问题在错误码上已经发生：Move 加码 → SDK 表不跟 → `explainAbort` 返回 "未注册"。而写表的人不知道表没人读（explainAbort 零消费者说明 UI 集成本身烂尾）。
- **改进方案**：① 把缺的 20 个码补进常量表（S）；② 决定 explainAbort 的命运：要么接入 `errorMessage` 的 Error 分支（解析 `MoveAbort(...)` 子状态），要么删表只留 explainAbort 用到的那部分（S）；③ 加一个注册表完备性测试：解析 `sources/*.move` 的 `const E_*: u64 = N` 与表逐码比对（S，一次性防再漂移）。
- **工作量**：S（三步合计 <1 天）

### 9.【P2·架构债】lib/crypto/math.ts、vss.ts 与 SDK 字节级重复，7 个文件引私有副本
- **现状**：`md5 lib/crypto/math.ts` == `md5 packages/multisig/src/dkg/math.ts`（795d891f…），vss 同（427fe4fa…）。消费私有副本的文件：`lib/committee-share-store.ts:17`、`lib/dkg-key-package.ts:6`、`lib/frost-exchange.ts:33`、`lib/frost-session.ts:5`、`components/dkg-ceremony-dialog.tsx:69`、`scripts/dao-live-transfer.ts` 等。`lib/crypto/resharing.ts:1-11` 已示范了正确形态（纯 re-export shim 指向 `multisig/dkg`，还有 3 个消费者走 shim）。
- **为什么是债**：字节级相同是暂态——任何一边先改（比如 SDK 侧又修一个边界）就会变成 #1 式静默漂移；#180 的"四处同步"成本正是这种重复制造的。
- **改进方案**：把 `lib/crypto/math.ts`、`lib/crypto/vss.ts`、`lib/crypto/bytes.ts`(部分) 改成 resharing 式 re-export shim（或直接 sed 全部 import 到 `multisig/dkg`），删原件；一个 `pnpm exec tsc` + 测试套件确认。
- **工作量**：S（改 import 路径 + 全量回归 2h）

### 10.【P2·运维】rt9-fixtures-v2.mjs 可复现但未接金样校验
- **现状**：实跑 `node scripts/rt9-fixtures-v2.mjs`，输出的 8 个签名与 `contracts/agent_vault/tests/rt9_key_generation_tests.move:45,55` 的 `SIG_OLDKEY_ADVANCE`/`SIG_OLDKEY_ADVANCE_N1` 逐字节一致——确定性再生器是好的。但没有任何自动化比对：regenerator 输出 ≠ Move 常量时，只有人工 diff 能发现（而 round-9 的摘要布局恰恰是最容易碰的：#180 列了四处同步点）。
- **为什么是债**：V2/V3 摘要是 resharing 窗口封条（rotate_group_key/key_generation 绑定），这条防线的回归防护目前是"记得手动跑脚本对比"。
- **改进方案**：CI 或 hook 加 `node scripts/rt9-fixtures-v2.mjs | grep -f <golden>`，golden 文件提交进仓（或直接 grep Move 测试文件里的 `x"…"` 常量比对输出）。脚本已零依赖随机性，秒级完成。
- **工作量**：S

### 11.【P2·测试债】SDK 8.6k 行只有 5 个测试文件，且没有运行入口
- **现状**：`packages/multisig/src` 下仅 5 个 `*.test.ts`（dkg 3 + mailbox + resharing；threshold_signer.frost1.test.ts 是重点）。`packages/multisig/package.json` scripts 只有 `"build": "tsc --noEmit"`——**没有 test script**；根 package.json 同样没有。实测 `npx tsx --test packages/multisig/src/dkg/*.test.ts` 可跑（21 pass），但没人跑。反差：lib/ 有 65 个测试文件。
- **为什么是债**：SDK 是被 lib 和 10+ 脚本共同依赖的密码学底座（threshold_signer 9 个直接消费者），其测试覆盖与地位倒挂；`frost-browser-regression.mjs`、`scripts/frost-browser-fixture.ts`(494L) 存在但同样是手动流程。
- **改进方案**：① `packages/multisig/package.json` 加 `"test": "tsx --test src/**/*.test.ts"`；② 把 #2 的 CI 步骤指向它；③ 优先给 org/digest.ts（V2/V3 摘要）与 agent-vault 各 reader 补 round-trip 测试——digest 布局是 #180 点名的四处同步之一。
- **工作量**：M（入口 S；digest/reader 补测试 M）

### 12.【P2·运维】58 个 lint warning 长期滞留
- **现状**：`npx next lint`：**0 error / 58 warnings**。分布：react-hooks/exhaustive-deps 缺 `t`（i18n 函数，20 个组件文件，如 `components/dashboard.tsx:24,124`）、测试文件 no-explicit-any（`lib/onchain-store.test.ts:227,233` 等）。`4cf6fac` 提交信息自述"5 pre-existing lint errors + 15 stale-script type errors"被修掉，说明团队在意 lint——但 warnings 从未清零。
- **为什么是债**：warning 常驻 = 信号噪音；真正新的 warning 会淹没在 58 条旧账里。exhaustive-deps 缺 `t` 在语言切换时是真实的 stale-render bug 温床。
- **改进方案**：一次性清账：`t` 依赖加进数组（i18n 的 `t` 引用稳定，加进 deps 无性能成本）约 20 处；测试文件 no-explicit-any 用 `unknown`+收窄或局部 eslint-disable。清零后在 CI 设 `--max-warnings 0`。
- **工作量**：S（机械修改半天）

### 13.【P3·依赖】6 个未使用的 npm 依赖
- **现状**：全仓 413 个源文件 import 扫描（含 config 文件），以下依赖零引用：
  - `@mysten/seal`、`@mysten/sui-groups`、`@mysten/bcs`（真实 BCS 调用全部走 `@mysten/sui/bcs` 子路径，如 `lib/dkg-mailbox.ts:16`）、`@hookform/resolvers`（仓库无 react-hook-form 表单）、`@emotion/is-prop-valid`（framer-motion 的可选 peer，未配 motion 组件树则不需要显式装）、`autoprefixer`（`postcss.config.mjs` 只有 tailwindcss 插件）。
  - 注意：`react-dom` 扫描同样零直接 import，但它是 Next.js 的必需 peer，**保留**。27 个 @radix-ui 包逐一核实全部在用（components/ui/*）。
- **为什么是债**：`@mysten/seal`、`@mysten/sui-groups` 是带原生/网络面的重依赖，白占安装面与供应链审计面；"latest" pinned 的包（@emotion/is-prop-valid 等）尤其不该留。
- **改进方案**：`pnpm remove` 六件套 → `pnpm build` + 测试套件回归 → 提交。附带建议：把 `@emotion/is-prop-valid`、`@hello-pangea/dnd`、`date-fns`、`framer-motion`、`next-themes` 等一批 `"latest"` pin 到确定版本（latest 在 lockfile 存在时其实已被锁定，但 manifest 语义仍危险）。
- **工作量**：S

### 14.【P3·死代码】scripts/ 目录清理（legacy .bak、空目录、未跟踪残留、双 import 风格）
- **现状**：
  - `scripts/legacy/`：6 个 `.bak` 文件 + README 自述"引用旧 monorepo 布局编译会失败"——纯死重，git 历史里有原件；
  - `scripts/rt9/` 空目录（2026-11-13 建立，无内容）；
  - 14 个未跟踪 `scripts/.t01-*.mts`（T01 团队临时产物）滞留工作区；
  - 10 个脚本仍用深路径 `from "../packages/multisig/src/dkg/math"`（如 `scripts/redteam-attack2.ts:24-27`、`scripts/rt-lit-*.ts`）绕过 barrel，另 6 个用 `from "../lib/..."`——两种风格与 `multisig/dkg` 包路径并存三种；
  - `scripts/rt9-REPORT.md` 报告文件混在脚本目录（docs/ 才是报告的家）。
- **为什么是债**：深路径 import 使 barrel 的公共 API 形同虚设（内部文件重命名会静默断掉 10 个红队脚本的可复跑性——而 #180 说这些脚本"可复跑"是安全资产的属性）。
- **改进方案**：删 legacy/ 与空 rt9/；`.t01-*` 交 T01 或删；深路径 sed 成 `multisig/dkg` 包路径（`pnpm exec tsc` + 逐脚本 `--help` 级冒烟）；rt9-REPORT.md 挪 docs/。
- **工作量**：S（半天，含 10 个脚本的 import 改写与冒烟）

### 15.【P3·架构债】过期 worktree 与构建残留
- **现状**：`git worktree list` 显示 `~/sui_project_c/multisig-frost-cross-device`（detached HEAD a4433b9）与 `.claude/worktrees/issue-4-gas-coin-concurrency`（locked，a4aa4db）两个陈旧 worktree；仓库根有 `tsconfig.tsbuildinfo`（408KB，增量构建缓存，`ls` 显示 11-14 12:01）混在源码目录；`.next/` 同理。worktree 里还藏着一套旧版 `lib/frost-exchange.ts`，检索时是噪音源。
- **为什么是债**：双 worktree 的旧代码会被全仓 grep 误命中（本次调查中就命中过）；tsbuildinfo 应在 gitignore（核实 `.gitignore` 未含，但 git status 未跟踪它——是本地垃圾而非仓库垃圾，风险低但碍事）。
- **改进方案**：确认 issue-4 与 frost-cross-device 分支内容已合入后 `git worktree remove`；`.gitignore` 加 `tsconfig.tsbuildinfo`、`.next/`（若缺）。
- **工作量**：S

---

## 四个专题的直接回答（对照任务书）

**① 架构债——三个签名实现是否该合一？**
应合一，但准确说是"两个半"：SDK FROST1（唯一正确实现）、`lib/frost-session.ts` 的 noble ed25519_FROST（生产路径 #4，必须合并）、`lib/crypto/committee-signing.ts`（已是正确的薄委托层，保留）。`lib/crypto/threshold_signer.ts` 是纯死代码（#7，直接删）。`lib/wallet-personal-signing.ts` 是 EOA 个人消息签名，语义不同，不算重复。lib/ 与 SDK 边界总体清晰（lib = UI 编排 + 链读封装，SDK = 密码学与 BCS），但三处破例：`lib/proposal-chain.ts` 私定义 Organization BCS（#1 根因）、`lib/crypto/math|vss` 私副本（#9）、`lib/dkg-mailbox.ts` 与 SDK `dkg/mailbox.ts` 同名不同实现（#6）。constants 双份维护问题真实存在但方向是"SDK 表落后于 Move"（#8），不是两份平行表——修齐 + 加完备性测试即可，不需要新机制。

**② 测试债——421 个 Move 测试的盲区**
按符号检索（fixed-string `abort_code = agent_vault::module::E_*`）：97 个数字错误码中 52 个（54%）零 expected_failure（明细见 #5）。SDK 对 Move 的镜像度：digest 布局有 fixture 级镜像（rt9 测试 + frost-browser-fixture），但错误码注册表镜像已漂移 20 码（#8），Organization BCS schema 是 lib 私有副本而非 SDK 单源（#1）。SDK 自身仅 5 个测试文件（#11）。

**③ 运维**
CI 不存在（#3）；四道门禁手工且 G2 命令文档错误（#3）；fixture 再生器已验证可复现、未接自动校验（#10）；58 条 lint warning（#12）。Vercel 侧 `.vercel/project.json` 在位、`.next/BUILD_ID` 有产物，G4 依赖人工 curl，无自动 preview 检查（纳入 #3 的 CI 可加 Vercel deploy status 轮询，留人工兜底）。

**④ 死代码与依赖**
未用 npm 包 6 个（#13，@mysten/seal 与 @mysten/sui-groups 优先删）；`scripts/legacy` 应整体删除（#14，README 自己承认不可用）；另删 `lib/crypto/threshold_signer.ts`（#7）与 SDK 5 个零消费者模块（#6，mailbox 必须处理同名撞车）。

## 建议执行顺序（工作量合计 ≈ 5-6 人日，S 项全是半天级）
1. #3 修 runbook G2 命令 + 建 CI（半天，之后一切有护栏）
2. #1+#2 修 proposal-chain fixture + 去重 BCS 定义 + TS 套件进门禁（1 天）
3. #8+#9+#10 错误注册表补齐/math|vss 去重/fixture 金样校验（1 天）
4. #5 Move 错误码 expected_failure 补齐（3 人日，可与 3 并行）
5. #7+#13+#14+#15 纯删除类（半天）
6. #4 frost-session 合并到 SDK FROST1（L，单独排期，前置等价性回归）
7. #6+#11+#12 收尾（1 天）

## 附：本次验证的原始记录
- `sui move test`（contracts/agent_vault）：`Total tests: 421; passed: 421; failed: 0`
- `npx tsc --noEmit`（packages/multisig 与根）：EXIT=0
- `npx tsx --test lib/*.test.ts lib/crypto/*.test.ts`：pass 695 / fail 32（全在 proposal-chain.test.ts）
- `npx tsx --test packages/multisig/src/dkg/*.test.ts`：pass 21 / fail 0
- `pnpm --filter @multisig/sdk tsc --noEmit`：`No projects matched the filters`（runbook 命令失效实证）
- `node scripts/rt9-fixtures-v2.mjs`：8 签名与 `rt9_key_generation_tests.move:45,55` 一致
- import 扫描：413 文件；依赖清点 63 deps；`ls .github` 不存在；`git worktree list` 两个陈旧 worktree
