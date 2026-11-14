# 自举托管生产 Runbook（mainnet）

状态：**准备材料**。本文把 testnet 已实测的自举流程（2026-10-29 asset_custody 狗粮存入 + 抛弃包 v1→v2 托管借出真升级 + 转出，E2E `run_live_user_story_e2e.ts` Step 4/16）转写为主网可执行顺序，并逐条标注当前缺口。执行前提是所有「必须先关闭」项全部完成；任何一项未关闭都不得开始 Phase 2 之后的步骤。

## 0. 核心概念（先纠正两个常见误解）

- **「把 cap 转给 DAO」不可行也不必要**：共享 Organization 对象不能发起交易。托管走 `asset_custody`：UpgradeCap 以 **dynamic object field 子对象**存入共享 `AssetCustody`（原 ID 仍可独立 getObject 读取），动用只剩两种提案：**BORROW**（`take_asset` 闪贷式借出一个 PTB，零 drop 收据强制同 PTB 归还；升级即六命令模板 take→policy→authorize→Upgrade→commit→return）与 **RELEASE**（`execute_release` 按提案冻结的收款人永久转出）。提案投票是**加权名册投票**（与异步转账提案同语义），不再是 FROST 门限签名专用路径。
- **cap 和一枚 coin 并没有区别**：托管金库接受任意 `key+store` owned 对象（UpgradeCap/AdminCap/…），前端只提供预制 PTB 模板把托管对象填进参数槽；可融化为 Balance 的 Coin 资产仍走 vault。放行（RELEASE）是普通治理提案，转出后可再存入——「封印即永久冻结」的旧语义已随 governed_upgrade 退役。

## 1. Phase 0 —— 托管存入前必须全部关闭（当前状态）

| # | 事项 | 状态（2026-10-27） |
|---|---|---|
| 1 | 委员会分片持久化：加密设备分片库（前端 `committee-share-store` + device-vault 密封）接入自举流程 | **GAP**：前端基建存在，自举脚本路径未接；testnet 演练用的是进程内存分片（已证不可持续） |
| 2 | 跨设备传输 E2E：`frost-private-transport` 真实多设备验收 | **GAP / UNVERIFIED**（无真实传输抽象前保持标注，不降级） |
| 3 | 同批成员/设备在 testnet 全流程彩排：DKG → 建组织 → 托管存入 → BORROW 升级 → RELEASE 放行演练 | **单机已跑**（E2E Step 4/16 实跑全绿：狗粮存入 + 抛弃包 v1→v2 + 转出）；「同批成员/设备」多机条件仍未满足 |
| 4 | 托管前离线验证签名能力：对测试 digest 聚合签名并用群公钥 Ed25519 验证（不烧 nonce；门限提案路径仍用于密钥轮换/名册） | 工具就绪（本地 FROST 烟测模式，见 §4） |
| 5 | `DEFAULT_CHAIN_ID` 主网就绪 | **走 PTB，不加合约行**（2026-10-27 决策）：会话固化后由链下编排读取 `final_public_key`/已确认名册，调用既有 `create_organization_with_chain_id` 传 `sui-mainnet:`。曾加入的会话路径变体已按审计行数决策回退 |
| 6 | 第三方审计（含 `asset_custody`/`cryptographic_org` 全量） | **GAP**（见 `THIRD_PARTY_AUDIT_SCOPE.md`） |
| 7 | 升级策略在首次发布时选定（COMPATIBLE 起步；只能收紧不能放松） | 已按 COMPATIBLE 执行（testnet 同款） |

## 2. Phase 1–4 —— 执行顺序

**Phase 1 单签发布（正常）**
发布必然单签，UpgradeCap 初始归发布地址。**发布→托管存入之间的窗口按小时计，不隔天**；窗口期内 cap 是单点。发布用 `sui move build --dump-bytecode-as-base64` 固化首次产物。

**Phase 2 建组织（委员会真实设备）**
`create_dkg_session(threshold, participants, deadline)` → 成员各自设备 `submit_commitment`/`confirm_participant`/`attest_group_key`（群公钥由 threshold 个已确认成员申报锚定）→ `finalize_session` → 链下编排读取已确认的群公钥/名册，调用现有 `create_organization_with_chain_id` 传 `b"sui-mainnet:"`（默认入口固化的是 `sui-testnet:`）。文档不假定不存在的 session 专用变体。
核验：成员/权重/threshold/群公钥与各成员本地计算一致；分片全部落入加密设备库。

**Phase 3 建托管 + 存入 UpgradeCap（两笔 PTB）**
正权重成员：`asset_custody::new(org)` + `share`（SDK `buildCreateAssetCustody`）→ `deposit<UpgradeCap>`（`buildDepositAsset`）。立即核验 `AssetCustodyCreated`/`AssetDeposited` 事件（object_id/slot=0/存入人谱系）、清单 reader 单类型单槽、cap 仍以原 ID 独立可读（owner 转为对象托管）。

**Phase 4 立即借出升级一次（证明可操作性）**
准备最小兼容改动（如版本标记函数），当场走完整链：BORROW 提案 → 加权投票过门限 → **由提案人本人签发** `buildCustodyUpgradeTemplate` 六命令 PTB（借出→授权→升级→提交→归还）→ 核验 `AssetTaken`/`AssetReturned` 同 digest、cap version 递增、托管清单不变。**在宣布完成前证明可操作性**；失败说明提案/投票/产物复算流程有缺陷——所以 Phase 0-3/4 的顺序不可颠倒。
借出只能由提案人签发（合约 `EBorrowerMismatch`）：若计划由另一个运维账户执行升级，**必须让该账户自己发起 BORROW 提案**，而不是让它在他人提案上代签。RELEASE 不受此限——收款人在提案创建时已冻结，任何人都能代发执行交易。

## 3. 运维纪律（托管后长期）

- **digest 独立复算**：每个成员从同一 commit、同一 pinned 工具链独立构建并比对 digest 一致后才签名——`scripts/verify_upgrade_artifacts.ts <digest|产物json>`（MISMATCH 退出码 1）。
- **nonce 台账**：每次提案前读链上 `last_nonce`，next = +1——`scripts/read_org_state.ts <org-id>`。
- **换届**：名册更新/epoch 推进只换群密钥不换 org_id，托管绑 org_id 不动（提案在创建时快照 epoch/门限，跨纪元的未决提案按合约语义作废）；resharing 仪式见 `docs/RESHARING_SECURITY.md`。
- **分片备份**：丢 t 份 = 永久冻结。dealer 保管 / social recovery 需在 Phase 0 定案。
- **自指风险**：委员会能（兼容地）升级治理代码自身；审计范围必须明示。

## 4. 本次（2026-10-27）已闭环的缺口

1. ~~chain-id 会话变体~~：已按「审计按行计费、编排走 PTB」决策**回退**（含 2 项测试与版本标记测试，Move 回到 303/303）；mainnet 方案改为 §1 第 5 条的 PTB 编排。
2. `scripts/verify_upgrade_artifacts.ts`：digest 独立复算工具（自一致 MATCH / 对冻结 v11 产物 MISMATCH / 退出码均已实测）。
3. `scripts/read_org_state.ts`：组织状态与 nonce 台账读取（对自举组织实测：threshold 3、epoch 1、last_nonce 1→next 2、sui-testnet:、3 成员、重放表 1 条）。
4. 本 runbook。

## 5. 仍未关闭（诚实清单）

- 真实多设备传输 E2E（需 ≥2 台真实设备，无法单机闭环）→ 保持 GAP / UNVERIFIED。
- 加密设备分片库接入自举/委员会签名路径（前端基建在，CLI 路径未接）。
- 同批成员/设备 testnet 彩排（单机全链已绿——狗粮存入/借出升级/转出；多设备条件未满足）与 RELEASE 放行的多设备验收。
- 第三方审计。
- ~~下次封印前把 `bootstrap_self_governance.ts` 参数化~~ 自举路径改走 E2E Step 4（`run_live_user_story_e2e.ts`，断电续跑按 AssetDeposited 事件恢复 custody）。**现行包**：`0xb5b7c3f4…7a5165`（12 模块，2026-10-29 二轮加固 fresh publish），UpgradeCap `0x92299c11…7a1ae`。历史包不再登记、不再支持。合约演进维持一律 fresh publish。
