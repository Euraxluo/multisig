# Sui Multisig

把群聊变成链上组织，但不共享一个多签地址。每个成员自己持有 FROST 阈值密钥份额，阈值成员共同签署提案、名册变更和金库转账。没有任何一个人的设备里存着组织的完整私钥。

适合：社区金库、社团共管资产、需要按人头投票才能花钱的 DAO、以及受预算约束的软件代理支付。

## 核心思路

普通多签地址是公钥集合派生的，成员一变地址就变，资金要迁移，集成也要断。这里不同：组织地址由群公钥派生，成员进出只做密钥份额重分享（resharing）或轮换（rotation），地址不变，资金不动，历史不断。

链上只存群公钥、加权名册和治理状态。签名在成员设备本地完成，用 FROST 阈值签名（RFC 9591），链上只验证一个普通 Ed25519 签名。

## 仓库三块

- `app/`、`components/` — Next.js 前端
- `packages/multisig/` — TypeScript SDK，构造 PTB 和摘要，供前端和第三方代理调用
- `contracts/` — Move 合约：`agent_vault`（组织、金库、提案、托管、代理预算等）和 `identity`（链上身份、关注、加密私信）

## 快速开始

```sh
pnpm install
pnpm dev
```

环境变量见 `.env.example`。

## 验证

```sh
# SDK
pnpm sdk:typecheck
pnpm test:sdk

# 前端
pnpm exec tsx --test lib/*.test.ts lib/crypto/*.test.ts
pnpm exec tsc --noEmit
pnpm exec eslint . --max-warnings 0
pnpm build

# 摘要向量（必须无 diff）
node scripts/golden-vectors-gen.mjs && git diff --exit-code -- packages/multisig/src/agent-vault/org/digest-vectors.json

# 合约
cd contracts/agent_vault && sui move test
```

## 状态

开发和测试网验证阶段，没有主网部署，没有生产托管。部分能力已在测试网端到端验证，部分仅在本地或测试中跑通。哪些可用、哪些不可用、哪些不得对外宣称，以 `docs/PRELAUNCH_CHECKLIST.md` 为准；有冲突时以该文件为准。

更多文档：`docs/README.md`。
