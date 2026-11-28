# Documentation

This directory holds the project's documentation, organized by purpose rather than as a flat list. Most document bodies are written in Chinese; this guide and the top-level `README.md` are in English.

Every capability claim in the project carries one of these status labels:

- **REAL** — verified end-to-end on testnet, with evidence
- **LOCAL** — works locally or in tests only, not verified on-chain
- **UNVERIFIED** — written and expected to work, not end-to-end verified
- **GAP** — missing configuration or prerequisite
- **NOT-DEPLOYED** — code exists, not yet published on-chain

`docs/PRELAUNCH_CHECKLIST.md` is the authoritative claims ledger: what is verified, what is local-only, what must not be claimed yet, and the remaining release gates. If any document disagrees with it, that file wins.

## Product & features

What the application does, feature by feature, and the state of each feature.

- `identity.md` — On-chain identity and social features on testnet: SuiNS name resolution, follows, profiles, encrypted direct messages, QR sharing.
- `zklogin.md` — Google zkLogin: real OAuth and real zkLogin proofs, its server configuration, and the acceptance criteria it must meet.
- `ui-feature-parity.md` — Feature retention for the frontend rebuild against its baseline commit, with the offline-test acceptance record.
- `original-feature-review.md` — Re-review of the original frontend against an upstream audit, establishing what the rebuild had to preserve.
- `ux-content-plan.md` — Proposed information architecture for the UI; not yet an implemented navigation redesign.

## Protocol & cryptography

The cryptographic core: specifications, literature grounding, and formal models.

- `RESHARING_SECURITY.md` — Security specification for resharing, erasure assumptions, and key rotation over FROST (RFC 9591) and the Gennaro proactive VSS lineage.
- `CRYPTO_LITERATURE_INDEX.md` — Maps every cryptographic primitive the project actually uses to its specification and to the published attacks against it, records verified conclusions per attack class, and lists what remains open.
- `chat-cost.md` — Cost structure of on-chain messaging and the optimization paths available, with every figure sourced.
- `../formal/` — TLA+ and Alloy models of organization governance and epoch budgets, with their own model notes.

## Security review & audit

Evidence about the trustworthiness of the code, and honest limits of that evidence.

- `SECURITY_REVIEW.md` — Internal source-level security review of the agent vault contracts: asset flows, digest constructions, findings, residual risks, and conditions for mainnet.
- `THIRD_PARTY_AUDIT_SCOPE.md` — The package scope and materials prepared for an independent third-party audit; the audit itself is still an open gap.
- `FROST_LOCAL_ACCEPTANCE.md` — Local acceptance records for resharing session recovery, DM-transport verification, browser nonce persistence, and receipt binding.
- `PRELAUNCH_CHECKLIST.md` — The authoritative pre-launch claims ledger.

## Deployment & operations

How the contracts and app would be deployed — procedures only; nothing here has been executed for production.

- `DEPLOYMENT_CHECKLIST.md` — Testnet deployment procedures, gated behind explicit per-action authorization.
- `DEPLOYMENT_RUNBOOK.md` — The operational runbook covering the Move package, SDK, frontend, and hosting, tied to the current testnet lineage.
- `BOOTSTRAP_PRODUCTION_RUNBOOK.md` — Translates the dogfooded testnet bootstrap sequence into a mainnet-ready order of operations, with every currently-open item listed.

## Internal working records

Not release material. Kept for maintainers.

- `internal/` — Internal working notes: multi-perspective review records, working prompts, and memos produced during development.
