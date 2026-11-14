# T07 开发者·SDK/API 设计组评审报告（packages/multisig 当作公开 npm 包审）

> 多角色视角：外部 dApp 开发者 / SDK 维护者 / 类型系统专家。
> 所有关键结论均在本机 `/tmp/sdk-clean` 干净消费者项目实测（npm i file:link + tsc + tsx），非纯代码目检。
> 实测环境：Node v26.12.1、TypeScript ^5.6、`multisig@0.1.0`（file: 链接安装）。

---

## 一、安装到干净项目需要什么（①安装门槛）

**实测记录（全部可复跑）：**

| 探针 | 命令 | 结果 |
|---|---|---|
| file: 安装 | `npm install`（deps: multisig@file:... + @mysten/sui^2.33.1 + typescript） | ✅ 25 packages / 53s；@mysten 8.8M、@noble 3.8M |
| 类型检查 | `npx tsc --noEmit` | ❌ **13 条 TS2580 `Cannot find name 'Buffer'`**；补装 `@types/node` 后 ✅ exit 0 |
| 裸 Node ESM | `node -e "import('multisig')"` | ❌ `ERR_UNSUPPORTED_DIR_IMPORT`（`./src/account` 目录导入） |
| 裸 Node CJS | `node -e "require('multisig')"` | ❌ 同上 |
| tsx 运行 | `npx tsx check.ts` | ✅ `all-symbols-imported-ok` |

**结论：包以「源码态 TS」发布**——`package.json:5-6` `main/types` 直指 `./src/index.ts`，`exports` 11 个子路径全是 `.ts`（`packages/multisig/package.json:7-52`）。当前只有两条活路：① Next.js `transpilePackages:["multisig"]`（`next.config.mjs:34`）；② tsx/ts-node 类转译器。**外部 dApp 开发者拿 Vite/Rollup/CRA 接入会直接失败**（无 `type:"module"`、目录式导入、裸 .ts）。

**结构性缺口（package.json 实测逐项验证）：**
- `private: true`、无 `license`、无 `files`、无 `engines`、无 `type`、无 `peerDependencies`、无 `devDependencies`、无 `bin`（但 `bin/dkg-cli.ts` 存在且 tsconfig include 了它）。
- `@types/node` 缺失导致消费端 tsc 首跑即红（上面 13 条错误；Buffer 调用点：`src/dkg/ceremony.ts:145`、`src/dkg/resharing.ts:164,165,166,178,352,364,579`、`src/dkg/fully_async_dkg.ts:213`）。
- `@mysten/sui` 放 dependencies 而非 peerDependencies：dApp 自己也依赖 @mysten/sui 时 npm 可能装双实例，`Transaction`/`SuiGrpcClient` 类型与 dapp-kit 出现跨实例错位。
- **exports 深子路径不对称**：`./agent-vault/{org,finance,custody,committee,proposal,artifacts}` 在表内，但 `./agent-vault/{chat,polls,scallop,app-policy}` **不在**（`package.json:7-52`）。`export *` barrel 仍能兜底（本机 `import 'multisig/agent-vault/chat'` 经 tsx ✅），但一旦发布成 dist 产物，这 4 个域的深导入会在 Node16 解析下被 exports 表封死。

**文档漂移**：`docs/DEPLOYMENT_RUNBOOK.md:19,99` 写 `pnpm --filter @multisig/sdk`，而包名实为 `multisig`（`packages/multisig/package.json:2`）——照文档跑门禁直接 no matching project。

**【建议 P1｜M】发布化改造**：加 `type:"module"`；tsc 出 `dist/` + `d.ts`；exports 指 dist；`@mysten/sui` 移 peerDependencies（`^2.33.0`）+ devDependencies 锁版本；补 `engines.node >=20`（crypto.subtle/AbortSignal.timeout 实测 Node26 有，Node18 webcrypto 稳定线以下有坑）；补 license/files/bin（dkg-cli 单独入口）；`@types/node` 进 devDependencies。

**【建议 P2｜S】exports 表补齐** `./agent-vault/chat`、`./agent-vault/polls`、`./agent-vault/scallop`、`./agent-vault/app-policy` 四子路径。

**【建议 P3｜S】修正 RUNBOOK** 的 filter 名为 `multisig`（文档一行）。

---

## 二、类型导出面（②类型卫生）

**总量实测**：root barrel 运行时导出 **319 个名字（195 个函数）**（`Object.keys(import('multisig')).length`）；`agent-vault` 子路径 257 个。

**any 泄漏：全仓扫描 0 泄漏**。脚本正则 `:\s*any\b|<any>|as any|any\[\]` 扫 `src/**/*.ts`（排除 test/shim），唯一命中是 `src/agent-vault/custody/schemas.ts:13` 的泛型约束 `BcsType<any, any>`（合理用法，非泄漏）。类型级探针 `IsAny<Parameters<typeof explainAbort>[0]>` 等全部 false，tsc exit 0。**类型卫生是本 SDK 最强项**。

**真正的问题是「导出面过宽」而非泄漏**：
- 内部机械件全部随 barrel 暴露：`BcsReader/concat/uleb128/utf8/bcsVectorAddress/bcsVectorU64`（`src/agent-vault/org/index.ts:4`）、FROST 低层 `validateCommitments/computeBindingFactor/computeAggregateNonce/verifyShare`（`src/dkg/threshold_signer.ts:66,88,133,165`）、`bytesToHex/hexToBytes`（`src/dkg/mailbox.ts:83,87`）。
- 测试文件随包发布：`src/dkg/mailbox.test.ts`、`src/dkg/resharing.test.ts`、`src/dkg/threshold_signer.frost1.test.ts`、`src/agent-vault/org/{economics,redesign}.test.ts`、`src/agent-vault/org/vitest-shim.ts` 全在 src 树里。
- 同名工具双实现：`bytesToHex/hexToBytes` 在 `src/dkg/mailbox.ts:83,87` 与 `src/agent-vault/org/bcs.ts:15` 各一份，org barrel 靠**手写排除清单**避免 star 冲突（`org/index.ts:3-4` 注释自证）。本机验证 root barrel 无冲突（dkg∩org=[]、dkg∩finance=[]、org∩finance=[]），但这份安全靠人肉维护。

**【建议 P4｜S】v1.0 前清理**：test/shim 移出 src 或 files 白名单排除；org/bcs 的 hex 副本删除、统一引 dkg 版；bcs 机械件降级为非导出（子路径 `multisig/agent-vault/org/bcs` 保留给脚本）。

---

## 三、五个最常见操作 golden 示例（③，全部 ≤10 行且 tsc 编译通过）

> 以下代码在干净消费者项目实测 `npx tsc --noEmit` → **exit 0（FINAL-GOLDEN-TSC-OK）**。每例本体 ≤10 行。

**G1 建 DAO**（DKG 会话 finalize 后一行建组织；`vault_client.ts:863-871`）：
```ts
import { AgentVaultClient } from 'multisig';
// sessionId: 已 finalize 的 dkg_committee 会话对象 ID
export function createDao(sessionId: string, thresholdWeight: bigint | number) {
  return new AgentVaultClient().buildCreateOrganizationFromSessionPTB(sessionId, thresholdWeight);
  // → wallet.signAndExecuteTransaction({ transaction })
}
```

**G2 提案**（金库转账提案；`vault_client.ts:707-723`）：
```ts
import { AgentVaultClient } from 'multisig';
export function proposeTransfer(orgId: string, recipient: string, amountMist: bigint) {
  return new AgentVaultClient().buildCreateTransferProposalPTB(
    orgId, 'Q3 运营支出', recipient, amountMist, Date.now() + 86_400_000,
  );
}
```

**G3 FROST 门限签名**（读链取 nonce → 收集 t 份分片 → 聚合；`src/agent-vault/org/session.ts:157-257,258-281`）：
```ts
import { ThresholdProposalSession, LocalMemoryShareProvider, createMultisigClient } from 'multisig';
import type { SessionShareMaterial } from 'multisig';
export async function frostSign(orgId: string, payload: Uint8Array, shares: SessionShareMaterial[]) {
  const session = await ThresholdProposalSession.create({
    client: createMultisigClient('testnet'), orgId,
    action: { kind: 'execute', payload, actionType: 1 },
  });
  await session.sign(new LocalMemoryShareProvider(shares)); // 聚合 64B 签名并本地验签
  return session.buildPTB(); // nonce 漂移时 refresh() 会作废会话
}
```

**G4 读金库**（`src/agent-vault/finance/reader.ts:41-58`，校验类型来源包/托管方式/UID）：
```ts
import { createFinanceReader, createMultisigClient } from 'multisig';
export async function readVault(vaultId: string) {
  const finance = createFinanceReader(createMultisigClient('testnet'));
  return finance.readVault(vaultId); // VaultSnapshot（bigint 已从 BCS 无损还原）
}
```

**G5 加 Agent**（Operator 孵化 AI 打工卡；`vault_client.ts:119-134`）：
```ts
import { AgentVaultClient } from 'multisig';
export function addAgent(opCapId: string, vaultId: string, agent: string,
                         dailyBudgetMist: bigint, serviceHash: string) {
  return new AgentVaultClient().buildSpawnAgentCardPTB(opCapId, vaultId, agent, dailyBudgetMist, serviceHash);
}
```

**评测**：5 例全部成立且 ≤10 行 ✅。G2/G5 是「facade 一行流」，G3/G4 是「模块化两行流」——两条 API 风格并存是第五节的核心议题。G1 依赖链上 DKG 会话（准入 0.005 SUI creation fee + 0.05 SUI bond 默认注入，`vault_client.ts:436-446,505-531`），README 必须写明这些**默认花销**。

---

## 四、错误处理（④）

**explainAbort 覆盖度实测**（tsx 直跑 `explainAbort('MoveAbort(UserSubstatus(ModuleAddress(0xcdc87b8e…), MOD, CODE))')`）：

| 模块#code | 返回 | 判定 |
|---|---|---|
| cryptographic_org#1006 | `E_INVALID_NONCE (1006)` | ✅ |
| vault#2012 | `E_EXCEEDS_AGENT_BUDGET_CAP (2012)` | ✅ |
| dkg_committee#3029 | `E_RECIPIENT_KEY_MISSING (3029)` | ✅ |
| asynchronous_proposal#4017 | `E_INVALID_TITLE (4017)` | ✅ |
| onchain_chat#6018 / red_packet#10 / asset_custody#17 / governance_poll#11 / scallop#7002 / walrus#20 | 均正确还原 | ✅ |
| **identity#1** | `identity error 1 (未注册)` | ❌ 无注册表 |
| **organization_treasury#1 / scheduled_payments#1** | `…(未注册)` | ❌ 无注册表 |
| cryptographic_org#1004 / vault#2015 | `(未注册)` | ✅ 符合预期（码已删/超界） |

- 已注册 10 个模块（`org/constants.ts:295-323`）：org 双表（数字 1001-1012 缺 1004 + 命名 1-4，`constants.ts:109-132`）、vault 2001-2014、dkg 3001-3029（缺 3013/3014）、proposal 2701/4017/4018、chat 6001-6020、red_packet 1-14、custody **1-23**、poll 1-12、scallop 7001-7003、walrus 1-20。
- **缺口 1：identity 包（0xba0780e7 血统）0 覆盖**——合约侧有 19 个命名错误（`contracts/identity/sources/identity.move:23-61`），SDK 侧只有 `IDENTITY_LIMITS`（`namespace/identity.ts:18-27`）没有 `IDENTITY_ERRORS`。
- **缺口 2：`organization_treasury`/`scheduled_payments` 两模块不在表内**（`org/constants.ts:25-26` 仅作为 MODULES 名注册）。
- **缺口 3：非 `UserSubstatus(ModuleAddress…)` 形态返回 null**（实测 `abort in cryptographic_org: … (code 1006)` → null），调用方必须同时处理 null 与「未注册」两种输出，契约含糊。
- 注册表**两种表形并存**：`Record<number, string>`（6 表）vs `Record<number, {name,message}>`（5 表）——消费端要写两种分支。
- **无类型化错误对象**：全 SDK throw 裸 `Error`（中文文案），唯一异常类是 `DealerHonestyError`（`src/dkg/resharing.ts:58`）；前端也未消费 explainAbort（grep lib/components/app 0 命中，前端各处自带 MoveAbort 字符串匹配，如 `lib/identity-client.test.ts:260`）。
- 正面：所有表与合约逐码对齐且有注释锚点；org 命名/数字两套编号空间的歧义在 `constants.ts:123-126` 有显式警告——**文档意识好，缺的是统一 schema**。

**【建议 P5｜M】错误面 v1.0**：统一 `{ module, code, name?, message? }` 注册表 + `explainAbort(): SdkMoveAbortError | null` 类型化返回；补 identity 19 码与 treasury/payments 模块；正则加「abort in <module> (code N)」降级匹配。

**【建议 P6｜S】语言策略**：对外错误文案统一英文（dkg 域已是英文），中文移注释/README；或提供 `explainAbort(code, locale)`。

---

## 五、命名一致性（⑤，org/finance/custody/chat/polls 五域横评）

**实测统计**（tsx 反射 + grep）：
- `AgentVaultClient` 54 方法：52 个 `*PTB` 后缀；**org 域 builders 带 PTB 后缀（8 个，`org/builders.ts:32-237`），finance/custody/polls/chat/scallop/app-policy builders 全不带（40+ 个）**。
- 参数风格三分天下：位置参数（`buildCreateTransferProposalPTB(orgId,title,recipient,amount,deadlineMs)` `vault_client.ts:707`；`buildSpawnAgentCardPTB` 5 位置参 `:119`）、对象参数（`buildCreateCustodyProposalPTB(input)` `:298`、`buildWithdrawGenesisStakePTB(input)` `:692`）、以及**双位置参嗅探重载**（`buildInitializeVaultPTB(recipientOrCoinType, secondArg)` 靠 `includes('::')` 猜语义，`vault_client.ts:53-70`）。
- 同一操作双入口：spawnAgent 有 facade 位置参版（`vault_client.ts:119`，serviceHash 默认空串）与 builder 对象参版（`finance/vault.ts:34`，serviceHash 必填）——语义/校验强度不同。
- Reader 三种风格：org 裸函数位置参 `readOrganization(client, orgId, packageId?)`（`org/reader.ts:120-124`）；chat/polls/scallop/app-policy/custody 裸函数 `(client, {packageId, id}, options)` 配置对象（如 `chat/reader.ts:67`）；finance 独有工厂 `createFinanceReader`（`finance/reader.ts:41`）+ org 域前端另建 `createAgentVaultReader`（`lib/agent-vault-chain.ts:141`，**不在 SDK 内**）。
- 常量前缀：POLL_/CHAT_/SCALLOP_/APP_POLICY_/CUSTODY_ 各域自洽，但模块名常量来源不一：多数引 `MODULES.*`（`org/constants.ts:19-32`），`DKG_MODULE` 却硬编码字符串（`committee/constants.ts:3`）。
- `finance/validation.ts` 的 `financeAddress/financeCoinType/financeU64/financeCoin` 被 custody/chat/scallop/app-policy 四域跨用（grep 证实）——实为「共享地址/币校验层」却挂 finance 前缀。
- 错误文案语言分裂：agent-vault 域中文（`vault_client.ts:24-29`）、dkg 域英文（`threshold_signer.ts:44` `[FROST1]…`）、identity 中英混合。

**【建议 P7｜L】v1.0 命名收敛（破坏性，需 0.2 过渡）**：① 全 builder 去 `PTB` 后缀（后缀零信息量）；② facade 方法全量改对象参数，废除 `buildInitializeVaultPTB` 的 `'::'` 嗅探；③ reader 统一 `(client, {packageId, id}, options?)` + 每域 `create<Domain>Reader` 工厂；④ `finance/validation` 更名 `common/validation`（导出 `suiAddress/coinType/u64/coin` 中性名）；⑤ `DKG_MODULE` 改引 `MODULES.dkgCommittee`。

**【建议 P8｜M】产物治理**：`lib/crypto/{math,vss}.ts` 与 SDK `dkg/{math,vss}.ts` 逐行 diff 为 0、`lib/crypto/ceremony.ts` diff 11 行、`lib/crypto/threshold_signer.ts` 是**旧版单 nonce 实现**（130 行 vs SDK 318 行，无 BINDING_DOMAIN）——仓库内已有 `lib/crypto/resharing.ts` 纯 re-export shim 的先例（`lib/crypto/resharing.ts:1-12`），但 threshold_signer 旧 fork 无人 import（grep 0 消费者）应删除，防止第三方照抄旧 FROST。

---

## 六、对外 API v1.0 草案（应导出的最小面）

**保留（稳定、合约对齐、示例覆盖）：**
```
multisig                     → createMultisigClient, MULTISIG_NETWORK_URLS, MULTISIG_SUI_COIN_TYPE,
                               AccountBalance, fetchAccountBalances, fetchSuiBalance, findSuiBalance
multisig/agent-vault         → AgentVaultClient（收敛后 ≤25 方法：vault 生命周期 9 + org 治理 6 +
                               proposal 4 + custody 6）、ADMISSION_ECONOMICS, LIMITS, CHAIN_IDS,
                               GOVERNANCE_EVENTS, 全部 *_ERRORS 表 + explainAbort,
                               readOrganization, createFinanceReader, readAssetCustody/readCustodyProposal,
                               readPoll/readChannel/readScallopAdapter/readPolicyRegistry/readDkgSession,
                               AgentVaultBcs/AssetCustodyBcs/… 各域 Bcs schema（索引器刚需）,
                               FinanceCoinSource, createAgentVaultWriters
multisig/dkg                 → DKGParticipant, ResharingNode, GennaroResharingParticipant,
                               FullyAsyncParticipant, AsyncDkgCoordinator, ThresholdSignerNode,
                               aggregateSignature, verifyFrostSignature, computeProposalDigest 等 8 个
                               digest 函数, IdentityKeypair, encryptMailboxShare/decryptMailboxShare,
                               SessionProposal 三件套（ThresholdProposalSession/SessionShareProvider/
                               LocalMemoryShareProvider 标注 @experimental）
multisig/namespace           → IdentityClient, resolveSuiNsAddress, reverseResolveSuiNsName,
                               IDENTITY_LIMITS（+ v1.1: IDENTITY_ERRORS）
multisig/agent-vault/artifacts → 维持现状（node-only 子路径已是正确设计，artifacts.ts:1-13 头注自证）
```

**降级/移出公开面（仍可经子路径或 internal 使用）：**
`BcsReader/concat/uleb128/utf8/bcsVector*`、`bytesToHex/hexToBytes`、`validateCommitments/computeBindingFactor/computeAggregateNonce/verifyShare`、`test.*`、`vitest-shim`、`bin/dkg-cli.ts`（改 `"bin": {"dkg-cli": "./dist/bin/dkg-cli.js"}`）。
**理由**：319 个名字里约 40 个是内部机械件/低层密码学原语，公开后即成兼容负担；低层 FROST 原语误用（如自拼 nonce 流程）会绕开 `aggregateSignature` 内建的最终验签（`threshold_signer.ts:294-298`）。

---

## 七、Footgun 清单（10 条，按伤害排序）

1. **裸 Node 不可用却无告警**：`main: src/index.ts` 裸 .ts + 目录导入，`import('multisig')`/`require('multisig')` 实测双双 `ERR_UNSUPPORTED_DIR_IMPORT`；包内 README 缺失（`ls packages/multisig/*.md` 0 文件），开发者唯一信息源是源码。
2. **消费端 tsc 首跑 13 条 Buffer 报错**：`@types/node` 不在任何 deps；dkg 三文件 7 处 `Buffer.from`（见第一节清单）。讽刺点：`mailbox.ts:83` 自带 `bytesToHex`，同文件树仍用 Buffer。
3. **浏览器双端声明不成立**：`crypto.subtle`（mailbox.ts:149-212）+ `Buffer`（dkg 路径）+ `node:child_process`（artifacts 子路径，已隔离 ✅）。Next.js 靠 webpack Buffer shim 活着；Vite 直连浏览器会在 DKG/resharing 执行时炸（import 期安全、执行期炸——实测 Buffer=undefined 时模块顶层无引用，但 `finalize()`/`verifyDealerHonestyProof()` 一调即崩）。
4. **默认花销隐式注入**：`buildCreateDkgSessionPTB` 默认 `SESSION_CREATION_FEE_MIST`（0.005 SUI，`vault_client.ts:444`）、`buildSubmitCommitmentPTB` 默认 `MIN_BOND_MIST`（0.05 SUI，`:521`）——钱包弹窗前 SDK 已替用户决定花多少钱，README 不写就是投诉源。
5. **`buildInitializeVaultPTB` 参数嗅探重载**（`vault_client.ts:53-70`）：先传 recipient 还是 coinType 靠 `includes('::')` 猜——传错顺序不报错、静默错位。
6. **测试专用签名传输在公开面**：`LocalMemoryShareProvider`（`session.ts:64-78`）与生产 provider（设备密封库 + E2E 传输）同层导出，且 session.ts:9 自注「frost-private-transport E2E 仍是 GAP」——生产用户没有正确选项可用，最顺手的是错的。
7. **摘要三重表示 + 手搓诱惑**：`computeProposalDigest`（`org/digest.ts:30`）、`session.proposalDigest`、`session.proposalDigestHex` 并存，scripts 红队全走手拼路径（`scripts/rt-lit-bcs-collision.ts:9,57`）；一旦 V2/V3 布局再演进（仓库既定约束：digest 变更须同步 SDK digest.ts + reader + 常量 + fixture 四处），手搓方第一批断。
8. **包 ID 血统硬编码 + 版本脱钩**：`AGENT_VAULT_PACKAGE_ID` 指血统 13（`org/constants.ts:12`）；audit 修复在血统 14（pending publish）——SDK 0.1.0 版本号不编码血统，npm 侧将出现「SDK 装了、链上包还是旧码」的错位窗口；README 需强制「SDK version ↔ lineage」对照表。
9. **explainAbort 双态契约**：非 abort 串返 null、未知码返「未注册」字符串（第四节实测），调用方拿 string 做分支必然漏 case；identity/treasury/payments 三模块盲区。
10. **仓库卫生**：doc 写 `@multisig/sdk` 包名不存在（RUNBOOK:19,99）；`bin/dkg-cli.ts` 无 bin 入口；`src/**` 携带 5 个 test 文件 + vitest-shim 发布；`lib/crypto/threshold_signer.ts` 旧单 nonce FROST 死代码未删（P8）——对外包最忌「repo 里有第二个真相」。

---

## 八、结论

- **强项**：类型卫生（0 any 泄漏实测）、错误码-合约逐码对齐文化、digest 单一实现（org/digest.ts）、artifacts 的 node-only 子路径隔离、`FinanceCoinSource` 支付统一约定（`finance/validation.ts:61`）。
- **弱项**：包工程化（发布形态/module/peer/engines 全缺）、命名三制并存、错误面两盲区、Buffer/浏览器、默认花销隐式。
- **v1.0 判定**：现状态是「优秀的内部 SDK、不合格的公开 npm 包」。按 P1-P8 顺序推进（P1/P4/P7 为发布前置，合计约 1-2 周工程量；P5/P6 可与血统 14 发布同窗），即可满足「干净项目 `npm i && import` 一把过」的公开标准。
