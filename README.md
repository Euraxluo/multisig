# Sui Multisig — Group Vaults, DAO Governance & Threshold Signatures

A Sui application consisting of a Next.js frontend, a TypeScript SDK (`packages/multisig`), and Move contracts. It turns a group chat into an on-chain organization: the organization is not a multisig address but a set of FROST threshold key shares held on members' own devices.

## Core capabilities

- **Organizations & vaults** — weighted member voting, proposals, treasury transfers
- **FROST threshold signatures (RFC 9591)** — roster updates and key rotation; shares are sealed on-device (non-extractable AES-GCM key in IndexedDB)
- **DKG** — sealed-mailbox share delivery; the group key is fixed on-chain by threshold member attestations
- **Agent vaults** — sub-accounts constrained by per-day budgets and per-epoch outflow caps
- **Identity & encrypted DMs** — on-chain identities (`.id`), follows, ECDH P-256 + HKDF + AES-256-GCM direct messages, used as the FROST round transport

## Repository layout

| Path | Contents |
|---|---|
| `app/`, `components/` | Next.js pages and UI |
| `lib/` | Frontend logic and offline tests |
| `packages/multisig/` | SDK: `agent-vault/*`, `namespace/*`, `dkg/*`, `account/*`, `bridge/*` |
| `contracts/agent_vault/` | Move contracts: organization, vault, proposals, DKG, custody, polls, payments |
| `contracts/identity/` | Move contracts: identity and private messages |
| `formal/` | TLA+ and Alloy formal models |
| `scripts/` | On-chain E2E, UI regression, digest-vector generation |
| `docs/` | Project documentation — see the [documentation guide](docs/README.md) |

## Status

Development and testnet verification only. There is no mainnet deployment and no production hosting. Which capabilities are verified, which are local-only, and which claims must not be made yet are tracked authoritatively in the [pre-launch checklist](docs/PRELAUNCH_CHECKLIST.md).

## Quick start

```sh
pnpm install
pnpm dev
```

Environment variables: see `.env.example`.

## Verification

```sh
# SDK
pnpm sdk:typecheck
pnpm test:sdk

# Frontend
pnpm exec tsx --test lib/*.test.ts lib/crypto/*.test.ts
pnpm exec tsc --noEmit
pnpm lint
pnpm build

# Digest vectors (must produce no diff)
node scripts/golden-vectors-gen.mjs && git diff --exit-code -- packages/multisig/src/agent-vault/org/digest-vectors.json

# Contracts
cd contracts/agent_vault && sui move test
```

Browser regression requires a locally running app (`pnpm dev`, or `pnpm build && pnpm start`) and a separate Playwright install:

```sh
UI_BASE_URL=http://127.0.0.1:3005 node scripts/ui-regression.mjs
UI_BASE_URL=http://127.0.0.1:3005 UI_VIEWPORT_WIDTH=1280 node scripts/ui-regression.mjs
```

## Documentation

The full documentation set is organized in [docs/README.md](docs/README.md): overview & product, protocol & cryptography, security review & audit materials, deployment & operations, and internal working records.
