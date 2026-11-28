# Sui Multisig

Sui application for on-chain organizations without a shared multisig address. Each member holds a FROST threshold key share on their own device; a threshold of members jointly signs proposals, roster changes, and treasury transfers.

Three parts: Next.js frontend (`app/`, `components/`), TypeScript SDK (`packages/multisig/`), Move contracts (`contracts/`: `agent_vault` and `identity`).

What it does: organizations and vaults with weighted voting, proposals, and treasury transfers; FROST threshold signatures (RFC 9591) for roster changes and key rotation with shares sealed on-device; DKG with sealed-mailbox share delivery; agent vaults with per-day budgets and outflow caps; on-chain identity (`.id`, follows, encrypted direct messages) as the FROST round transport.

Testnet and development only. No mainnet deployment. Verification status is in `docs/PRELAUNCH_CHECKLIST.md` — if anything here conflicts with that file, the checklist wins.

    pnpm install
    pnpm dev

Environment variables: `.env.example`.

    pnpm sdk:typecheck
    pnpm test:sdk
    pnpm exec tsx --test lib/*.test.ts lib/crypto/*.test.ts
    pnpm exec tsc --noEmit
    pnpm exec eslint . --max-warnings 0
    pnpm build
    cd contracts/agent_vault && sui move test

    node scripts/golden-vectors-gen.mjs && git diff --exit-code -- packages/multisig/src/agent-vault/org/digest-vectors.json

    UI_BASE_URL=http://127.0.0.1:3005 node scripts/ui-regression.mjs
    UI_BASE_URL=http://127.0.0.1:3005 UI_VIEWPORT_WIDTH=1280 node scripts/ui-regression.mjs

More docs: `docs/README.md`.
