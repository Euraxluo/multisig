# Sui Multisig

A Sui application that turns a group of people into an on-chain organization without a single shared multisig address. Instead, each member holds a FROST threshold key share on their own device, and a threshold of members jointly signs proposals, roster changes, and treasury transfers.

The repository has three parts:

- `app/` and `components/` — the Next.js frontend
- `packages/multisig/` — the TypeScript SDK
- `contracts/` — the Move contracts (`agent_vault` and `identity`)

What it does:

- **Organizations and vaults** — weighted member voting, proposals, treasury transfers
- **FROST threshold signatures (RFC 9591)** — roster updates and key rotation; shares are sealed on-device in a non-extractable AES-GCM key in IndexedDB
- **DKG** — sealed-mailbox share delivery; the group key is fixed on-chain by threshold member attestations
- **Agent vaults** — sub-accounts with per-day budgets and per-epoch outflow caps
- **Identity and encrypted DMs** — on-chain identities (`.id`), follows, and ECDH P-256 + HKDF + AES-256-GCM direct messages used as the FROST round transport

Status:

This is development and testnet verification only. There is no mainnet deployment and no production hosting. Some capabilities are verified end-to-end on testnet; others are local-only or not yet deployed. The authoritative list of what is verified, what is local-only, and what must not be claimed yet is in `docs/PRELAUNCH_CHECKLIST.md`. If any document conflicts with that file, this one wins.

Quick start:

```sh
pnpm install
pnpm dev
```

Environment variables: see `.env.example`.

Verification:

```sh
# SDK
pnpm sdk:typecheck
pnpm test:sdk

# Frontend
pnpm exec tsx --test lib/*.test.ts lib/crypto/*.test.ts
pnpm exec tsc --noEmit
pnpm exec eslint . --max-warnings 0
pnpm build

# Digest vectors (must produce no diff)
node scripts/golden-vectors-gen.mjs && git diff --exit-code -- packages/multisig/src/agent-vault/org/digest-vectors.json

# Contracts
cd contracts/agent_vault && sui move test
```

Browser regression needs a locally running app and a separate Playwright install:

```sh
UI_BASE_URL=http://127.0.0.1:3005 node scripts/ui-regression.mjs
UI_BASE_URL=http://127.0.0.1:3005 UI_VIEWPORT_WIDTH=1280 node scripts/ui-regression.mjs
```

Documentation:

`docs/README.md` is the documentation guide — product, protocol and cryptography, security review and audit, deployment and operations, and internal working records. It is written to be read, not checked off.
