# Documentation Guide

This directory holds the project's documentation, organized by purpose rather than as a flat list. Most document bodies are written in Chinese; this guide and the top-level `README.md` are in English.

Every capability claim in the project carries a status label:

| Label | Meaning |
|---|---|
| **REAL** | Verified end-to-end on testnet, with evidence |
| **LOCAL** | Works locally / in tests only, not verified on-chain |
| **UNVERIFIED** | Written and expected to work, not end-to-end verified |
| **GAP** | Missing configuration or prerequisite |
| **NOT-DEPLOYED** | Code exists, not yet published on-chain |

## Part I — Product & Features

What the application does, feature by feature, and what state each feature is in.

- [`identity.md`](identity.md) — On-chain identity and social features on testnet: SuiNS name resolution, follows, profiles, encrypted direct messages, QR sharing.
- [`zklogin.md`](zklogin.md) — Google zkLogin: real OAuth and real zkLogin proofs, its server configuration, and the acceptance criteria it must meet.
- [`ui-feature-parity.md`](ui-feature-parity.md) — Feature-retention checklist for the frontend rebuild against its baseline commit, with the offline-test acceptance record.
- [`original-feature-review.md`](original-feature-review.md) — Re-review of the original frontend against an upstream gap audit, establishing what the rebuild had to preserve.
- [`ux-content-plan.md`](ux-content-plan.md) — Proposed information architecture for the UI; not yet an implemented navigation redesign.

## Part II — Protocol & Cryptography

The cryptographic core: specifications, literature grounding, and formal models.

- [`RESHARING_SECURITY.md`](RESHARING_SECURITY.md) — The security specification for resharing, erasure assumptions, and key rotation over FROST (RFC 9591) and the Gennaro proactive VSS lineage.
- [`CRYPTO_LITERATURE_INDEX.md`](CRYPTO_LITERATURE_INDEX.md) — Maps every cryptographic primitive the project actually uses to its specification and to the published attacks against it, records the project's verified conclusions per attack class (with reproducible scripts), and lists what remains open.
- [`chat-cost.md`](chat-cost.md) — Cost structure of on-chain messaging and the optimization paths available, with every figure sourced.
- [`../formal/`](../formal/) — TLA+ and Alloy models of organization governance and epoch budgets, with their own model notes.

## Part III — Security Review & Audit

Evidence about the trustworthiness of the code, and honest limits of that evidence.

- [`SECURITY_REVIEW.md`](SECURITY_REVIEW.md) — Internal source-level security review of the agent vault contracts: asset flows, digest constructions, findings (with severities), residual risks, and conditions for mainnet.
- [`THIRD_PARTY_AUDIT_SCOPE.md`](THIRD_PARTY_AUDIT_SCOPE.md) — The package scope and materials prepared for an independent third-party audit; the audit itself is still an open GAP.
- [`FROST_LOCAL_ACCEPTANCE.md`](FROST_LOCAL_ACCEPTANCE.md) — Local acceptance records for resharing session recovery, DM-transport verification, browser nonce persistence, and receipt binding.
- [`PRELAUNCH_CHECKLIST.md`](PRELAUNCH_CHECKLIST.md) — The authoritative pre-launch claims ledger: what is verified, what is local-only, what must not be claimed yet, and the remaining release gates. If any document disagrees with this one, this one wins.

## Part IV — Deployment & Operations

How the contracts and app would be deployed — procedures only; nothing here has been executed for production.

- [`DEPLOYMENT_CHECKLIST.md`](DEPLOYMENT_CHECKLIST.md) — Testnet deployment procedures, gated behind explicit per-action authorization, with the status labels applied to each step.
- [`DEPLOYMENT_RUNBOOK.md`](DEPLOYMENT_RUNBOOK.md) — The operational runbook covering the Move package, SDK, frontend, and hosting, tied to the current testnet lineage.
- [`BOOTSTRAP_PRODUCTION_RUNBOOK.md`](BOOTSTRAP_PRODUCTION_RUNBOOK.md) — Translates the dogfooded testnet bootstrap sequence into a mainnet-ready order of operations, with every currently-open gap itemized.

## Part V — Internal Working Records

Not release material. Kept for maintainers.

- [`internal/`](internal/README.md) — Internal working notes: multi-perspective review records, working prompts, and memos produced during development.

## Suggested reading paths

- **External reviewer / auditor**: Part III, in the order given — start with `SECURITY_REVIEW.md`, then `PRELAUNCH_CHECKLIST.md` and `THIRD_PARTY_AUDIT_SCOPE.md`; dive into Part II as needed for the cryptographic claims.
- **New developer**: top-level `README.md` → `identity.md` and `ui-feature-parity.md` for product scope → `RESHARING_SECURITY.md` for the protocol → Part IV for how it runs.
- **Operator preparing deployment**: `PRELAUNCH_CHECKLIST.md` first (what gates remain), then the three runbooks in Part IV.
