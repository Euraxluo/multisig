# Sui 上做聊天：成本结构与优化路径

本文回答“怎样让链上群聊更省”。所有数字标注来源；未部署的能力明确标为 local / not deployed。

## 1. 现在一条消息到底花在哪

一次 `onchain_chat::post_message` 的链上成本由三块组成：

| 组成 | 量级 | 说明 |
|---|---|---|
| 交易信封 | ≈1.0–1.9 MIST ×10⁶（0.001–0.002 SUI） | 签名校验、证书、gas coin、共享 `ChatChannel` 的读写访问。来自本项目历史交易的 `gasUsed.computationCost` 实测。 |
| 事件 | ≈0.007 MIST ×10⁶ / 条 | testnet 协议 v139：`event_emit_cost_base=52`、`event_emit_output_cost_per_byte=10`、tag/value 推导 5/2。一条 200 字节的 `ChatMessageEvent` 约 6–8 k MIST，占比 <1%。 |
| Gas 补贴转账 | 1.0 MIST ×10⁶ / 条 | `auto_subsidize_gas` 每个 `post_message` 从 `gas_subsidy_pool` 拆出 0.001 SUI，`transfer::public_transfer` 给发送者，并额外创建一个 coin 对象、发一条事件。这笔钱从补贴池出账、回流给发送者，不是发送者额外支付，但它让每行消息都必须触碰一次 `Balance` 与 coin 创建。 |

结论：**每行消息的成本几乎全部是“每笔交易”的固定开销 + 每行的补贴转账，而不是消息内容本身。** 把一条消息的文本从 200 字节压到 20 字节对总成本没有意义；减少交易笔数、减少逐行补贴出账才有意义。

1000 条/天、逐条发送时：发送者毛支出约 1–2 SUI/天，补贴池出账 1 SUI/天并回流给发送者；事件部分不到 0.007 SUI。

## 2. 已经落地的三档优化

### 档 0：逐条发送（v4 已部署，旧行为）

一条消息 = 一笔交易 = 一次 0.001 SUI 补贴转账。约 0.002 SUI/条。

### 档 1：突发合并 PTB（本地已接入，部署即可用）

输入框连续输入的消息进入本机 outbox（≤32 条、单条 ≤4096 字节、停止输入 900ms 后合并），一次钱包确认提交一个 PTB，内含 N 个 `post_message`。

- 省下：N−1 份交易信封（签名、证书、gas coin、共享对象访问）。
- 省不下：每个 `post_message` 仍各触发一次 0.001 SUI 补贴转账。
- 10 条突发：约 0.0115 SUI，对比逐条约 0.020 SUI，省约 43%。
- 失败时整批回队并排在新输入之前，不会丢消息；钱包只弹一次。

### 档 2：合约级批量入口 `post_message_batch`（**local，未部署**）

`onchain_chat.move` 新增 `post_message_batch`：一次校验整批（每条 ≤4096 字节、blob id ≤128 字节、最多 32 条、长度必须对齐），逐条推进 `message_sequence` 并发出事件，**整批只做一次 `auto_subsidize_gas`**。

- 省下：N−1 份信封 + N−1 次补贴转账及其实体对象创建。
- 10 条突发：约 0.0016 SUI，对比逐条约 0.020 SUI，省约 92%。
- 源码已通过 224 项 Move 测试与 lint（含空批、超长、长度不匹配、非成员、序号连续、单次补贴）；**未随 v4 发布**。
- 前端已按 `getMoveFunction` 探测已部署 ABI：存在且签名匹配才构建 `post_message_batch`，否则自动回退到档 1，并在回执 `metadata.batchEntry` 记录实际入口。探测失败只降级成本，不阻断发送。

## 3. 还没做的两档（按收益/代价排序）

### 档 3：历史消息进 Walrus quilt，链上只留锚点

Walrus 的存储计费里有**每个 blob 固定 64 MB 的 metadata 成本**，小 blob 单价被它吃掉；官方为此提供 quilt：一个 quilt 最多 666 个 blob，一次上传、按 `quiltPatchId` 单独取回（本项目已在 testnet 实测 `PUT /v1/quilts` 与 `GET /v1/blobs/by-quilt-patch-id/<id>`）。600 条 10 KiB 的消息打包成一个 quilt，相比 600 个独立 blob 约省 409 倍存储费。

落地方式：客户端把一批消息正文写成 quilt，链上事件只带 `quiltPatchId`（或每 N 条写一个 Merkle root）。顺序仍由 `ChatChannel.message_sequence` 保证，内容可用性由 Walrus 保证。代价是多一个“先写 Walrus、再上链”的两步流程，以及 Walrus 读失败时的历史回放缺口——界面必须如实区分「链上已定序」与「正文尚未取回」。

### 档 4：消息完全离链 + Seal 加密（黑客松主流架构）

参考 Sui Overflow 的 Chatiwal（Seal + Walrus 加密聊天，University Award）、Cable（钱包到钱包 E2E）、SuiMail（Programmable Storage 第三名），以及官方 Sui Stack Messaging SDK（beta，主网）：**链上只放群、成员、权限、DEK 历史；消息由 relayer 排序、Seal 管信封密钥、Walrus 归档，官方明确“每条消息不发交易”**。归档同样按 quilt 批量写。

- 每条消息的链上成本趋近 0，但需要运行 relayer，链上不再逐条提供定序与可用性承诺；隐私与成本都更好，可信假设也更多。
- 本项目已有真实加密私聊（Seal 风格的信封加密在本地实现），迁移路径是现成的。
- **档 4 已落地为可选通道（local）**：群聊页的同一个会话界面里新增“链上频道 / 端到端加密”切换，使用官方测试网 `PermissionedGroup<Messaging>`（`0x047696be…`）与 Seal 2-of-2 测试网密钥服务器；消息正文不进交易、不进事件，链上成本只剩建群和成员/密钥变更两笔。本地参考 relayer 已构建并跑通 `/health_check`，**未部署**；relayer 未启动时该通道只显示配置缺口并禁用输入框，不显示任何消息。存档要单独看：relayer 自身只存内存，Walrus 归档是单向的（只写不读回），读回需要外部索引器与链上权限，所以“离链”不等于“已有持久存档”。

## 4. 建议顺序

1. **等授权后随下一次升级发布 `post_message_batch`**（档 2）。这是当前性价比最高的一步：合约已写好、测试已通过、前端已能自动切换，升级即可把突发消息成本再降一个数量级。
2. 把 `post_message` 事件的 `content_preview` 限制在实际预览长度（例如 256 字节），正文一律走 Walrus quilt（档 3）。事件本身很便宜，但永久存储应当只为“可索引的最小事实”付费。
3. 群聊接 Seal（档 4）作为可选模式：公开群保持链上定序，私密群用离链 relayer + Seal，两条路径在 UI 上明确标注可用性差异。**已按此形态实现**：同一会话、顶部切换传输，链上频道默认且始终可用，加密通道在 relayer 就绪前只显示配置缺口。

## 5. 不要做的事

- 不要为了省 gas 把多条消息拼进一个 `vector<u8>` 再在链上拆——拆分逻辑本身要付费，且事件语义会退化成一条。
- 不要用链上事件做业务状态存储：事件是索引事实，不是可查询状态；历史回放应由 Walrus/索引器承担。
- 不要在未部署 `post_message_batch` 时直接构造该调用：会 abort 并浪费 gas。前端已按 ABI 探测规避。
