#!/usr/bin/env node
/**
 * Golden vectors for every digest domain in the multisig SDK (issue #25, T02).
 * Regenerates packages/multisig/src/agent-vault/org/digest-vectors.json.
 * Layouts are hand-mirrored with node:crypto — zero shared code with the SDK —
 * so a layout regression in digest.ts / mailbox.ts flips the vectors and the
 * table-driven test (golden-vectors.test.ts) fails.
 *
 * Run: node scripts/golden-vectors-gen.mjs
 * CI gate (wired by #26): regenerate + 'git diff --exit-code' on the vectors file.
 */
import { createHash } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const sha256 = (...parts) => createHash('sha256').update(Buffer.concat(parts)).digest();
const utf8 = (s) => Buffer.from(s, 'utf8');
const u64le = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const addr = (hex) => Buffer.from(hex.replace(/^0x/, '').padStart(64, '0'), 'hex');
// bcs vector<u64> = uleb128(len) || len × le-u64; bcs vector<address> = uleb(len) || len × 32B
const uleb = (n) => { const out = []; let v = Number(n); do { let b = v & 0x7f; v >>>= 7; if (v) b |= 0x80; out.push(b); } while (v); return Buffer.from(out); };
const vecU64 = (xs) => Buffer.concat([uleb(xs.length), ...xs.map((x) => u64le(x))]);
const vecAddr = (xs) => Buffer.concat([uleb(xs.length), ...xs.map((x) => addr(typeof x === 'string' ? x : '0x' + x.toString('hex')))]);

// ---- fixed, deterministic inputs (no keys, no randomness) ----
const CHAIN = utf8('sui-testnet:');
const ORG = addr('0x' + '11'.repeat(32));
const M1_HEX = '0x' + '22'.repeat(32);
const M2_HEX = '0x' + '33'.repeat(32);
const I_MEMBERS = [M1_HEX, M2_HEX];
const PK = Buffer.from('aa'.repeat(32), 'hex');
const PK2 = Buffer.from('bb'.repeat(32), 'hex');

const vectors = {};

// 1. SUI_ORG_THRESHOLD_PROPOSAL_V2: || chain || org || epoch || nonce || payload || action_type(u8)
vectors.proposal_v2 = sha256(
  utf8('SUI_ORG_THRESHOLD_PROPOSAL_V2:'), CHAIN, ORG, u64le(3n), u64le(7n), utf8('payload-bytes'), Buffer.of(0x05),
);

// 2. SUI_ORG_EPOCH_ADVANCE_V2: || chain || org || epoch || nonce || newEpoch || key_generation
vectors.epoch_advance_v2 = sha256(
  utf8('SUI_ORG_EPOCH_ADVANCE_V2:'), CHAIN, ORG, u64le(3n), u64le(9n), u64le(4n), u64le(2n),
);

// 3. SUI_ORG_KEY_ROTATION_V3: || chain || org || epoch || nonce || newGroupPk || bcs(newSigners) || keyThreshold
vectors.key_rotation_v3 = sha256(
  utf8('SUI_ORG_KEY_ROTATION_V3:'), CHAIN, ORG, u64le(4n), u64le(11n), PK2, vecAddr(I_MEMBERS), u64le(2n),
);

// 4. SUI_ORG_POP_V2: || chain || groupPk || bcs(members) || bcs(weights) || bcs(threshold) || bcs(key_threshold)
vectors.create_pop_v2 = sha256(
  utf8('SUI_ORG_POP_V2:'), CHAIN, PK, vecAddr(I_MEMBERS), vecU64([10n, 20n]), u64le(30n), u64le(2n),
);

// 5. SUI_ORG_POP_V1: || chain || bcs(org_id) || bcs(epoch) || new_pk
vectors.rotate_pop_v1 = sha256(utf8('SUI_ORG_POP_V1:'), CHAIN, ORG, u64le(9n), PK2);

// 6. SUI_ORG_TREASURY_TRANSFER_V3: || chain || org || epoch || nonce || proposal || recipient || amount || vault_id || key_generation
vectors.treasury_transfer_v3 = sha256(
  utf8('SUI_ORG_TREASURY_TRANSFER_V3:'), CHAIN, ORG, u64le(6n), u64le(21n),
  addr('0x' + 'aa'.repeat(32)), addr('0x' + 'bb'.repeat(32)), u64le(1000000n), addr('0x' + 'cc'.repeat(32)), u64le(3n),
);

// 7. SUI_ORG_ROSTER_V1: || chain || org || epoch || nonce || newEpoch || threshold || bcs(members) || bcs(weights)
vectors.roster_update_v1 = sha256(
  utf8('SUI_ORG_ROSTER_V1:'), CHAIN, ORG, u64le(5n), u64le(13n), u64le(6n), u64le(30n), vecAddr(I_MEMBERS), vecU64([15n, 15n]),
);

// 8. SUI_ORG_GENESIS_WITHDRAW_V1: || chain || org || epoch || nonce || amount || recipient
vectors.genesis_withdraw_v1 = sha256(
  utf8('SUI_ORG_GENESIS_WITHDRAW_V1:'), CHAIN, ORG, u64le(1n), u64le(1n), u64le(500n), addr('0x' + '99'.repeat(32)),
);

// 9. SUI_DKG_ATTEST_V1: || bcs(ID 32B) || group_pk
vectors.dkg_attest_v1 = sha256(utf8('SUI_DKG_ATTEST_V1:'), addr('0x' + 'dd'.repeat(32)), PK);

// 10. SUI_DKG_MAILBOX_V1: AAD = domain || utf8(sessionId) || sender32 || recipient32
//     (AAD, pre-hash — hashed once here so every vector is a 32B sha256 digest)
vectors.dkg_mailbox_v1 = sha256(
  utf8('SUI_DKG_MAILBOX_V1:'), utf8('session-abc'), addr(M1_HEX), addr(M2_HEX),
);

const out = {
  _meta: {
    generator: 'scripts/golden-vectors-gen.mjs',
    chainId: 'sui-testnet:',
    note: 'sha256 of each domain layout, byte-mirrored with node:crypto (no SDK imports). Regenerate + git diff --exit-code as CI gate.',
  },
  inputs: {
    chainId: 'sui-testnet:',
    orgId: '0x' + '11'.repeat(32),
    members: ['0x' + '22'.repeat(32), '0x' + '33'.repeat(32)],
    weights: [10, 20],
    groupPk: PK.toString('hex'),
    newGroupPk: PK2.toString('hex'),
    epochVersion: { proposal: 3, approval: 3, rotation: 4, pop: 9, treasury: 6, roster: 5, genesis: 1 },
  },
  vectors: Object.fromEntries(Object.entries(vectors).map(([k, v]) => [k, v.toString('hex')])),
};

const here = dirname(fileURLToPath(import.meta.url));
const dest = join(here, '..', 'packages', 'multisig', 'src', 'agent-vault', 'org', 'digest-vectors.json');
mkdirSync(dirname(dest), { recursive: true });
writeFileSync(dest, JSON.stringify(out, null, 2) + '\n');
console.log(`wrote ${dest} (${Object.keys(vectors).length} vectors)`);
for (const [k, v] of Object.entries(vectors)) console.log(`  ${k} = ${v.toString('hex')}`);
