/**
 * Golden vectors (issue #25): every digest domain consumed table-driven from
 * digest-vectors.json, produced by scripts/golden-vectors-gen.mjs with
 * node:crypto (zero shared code with the SDK). Any layout change in digest.ts
 * or mailbox.ts must regenerate the vectors intentionally — otherwise this
 * file fails and the CI `git diff --exit-code` gate blocks the merge.
 *
 * The contracts are held to the same bytes: the Move tests recompute each
 * on-chain digest and compare it with a constant copied from this file, and
 * the tests at the bottom check that both copies still agree.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from './vitest-shim';
import {
  computeCreatePopDigest,
  computeDkgAttestationDigest,
  computeGenesisWithdrawDigest,
  computeKeyRotationDigest,
  computeProposalDigest,
  computeRosterUpdateDigest,
  computeRotatePopDigest,
  computeThresholdApprovalDigest,
  computeTreasuryAgentDelegationDigest,
  computeTreasuryOutflowPolicyDigest,
  computeTreasuryTransferDigest,
} from './digest';
import { mailboxAad } from '../../dkg/mailbox';
import { createHash } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(here, 'digest-vectors.json'), 'utf8')) as {
  inputs: {
    chainId: string;
    orgId: string;
    members: string[];
    weights: number[];
    groupPk: string;
    newGroupPk: string;
    epochVersion: Record<string, number>;
  };
  vectors: Record<string, string>;
};

const I = fixture.inputs;
const hex = (s: string) => Buffer.from(s, 'hex');
const CHAIN = I.chainId;

type Case = { name: string; actual: Uint8Array; expected: string };

const cases: Case[] = [
  {
    name: 'proposal_v2 — SUI_ORG_THRESHOLD_PROPOSAL_V2',
    actual: computeProposalDigest({
      chainId: CHAIN, orgId: I.orgId, epochVersion: 3n, nonce: 7n,
      payload: Buffer.from('payload-bytes'), actionType: 0x05,
    }),
    expected: fixture.vectors.proposal_v2,
  },
  {
    name: 'epoch_advance_v2 — SUI_ORG_EPOCH_ADVANCE_V2',
    actual: computeThresholdApprovalDigest({
      chainId: CHAIN, orgId: I.orgId, epochVersion: 3n, nonce: 9n, newEpochVersion: 4n, keyGeneration: 2n,
    }),
    expected: fixture.vectors.epoch_advance_v2,
  },
  {
    name: 'key_rotation_v3 — SUI_ORG_KEY_ROTATION_V3',
    actual: computeKeyRotationDigest({
      chainId: CHAIN, orgId: I.orgId, epochVersion: 4n, nonce: 11n,
      newGroupPk: hex(I.newGroupPk), newSigners: I.members, keyThreshold: 2n,
    }),
    expected: fixture.vectors.key_rotation_v3,
  },
  {
    name: 'create_pop_v2 — SUI_ORG_POP_V2',
    actual: computeCreatePopDigest({
      chainId: CHAIN, groupPk: hex(I.groupPk), members: I.members,
      weights: I.weights.map(BigInt), thresholdWeight: 30n, keyThreshold: 2n,
    }),
    expected: fixture.vectors.create_pop_v2,
  },
  {
    name: 'rotate_pop_v1 — SUI_ORG_POP_V1',
    actual: computeRotatePopDigest({
      chainId: CHAIN, orgId: I.orgId, newEpochVersion: 9n, newGroupPk: hex(I.newGroupPk),
    }),
    expected: fixture.vectors.rotate_pop_v1,
  },
  {
    name: 'treasury_transfer_v3 — SUI_ORG_TREASURY_TRANSFER_V3 (vault-bound)',
    actual: computeTreasuryTransferDigest({
      chainId: CHAIN, orgId: I.orgId, epochVersion: 6n, nonce: 21n,
      proposalId: '0x' + 'aa'.repeat(32), recipient: '0x' + 'bb'.repeat(32),
      amount: 1_000_000n, keyGeneration: 3n, vaultId: '0x' + 'cc'.repeat(32),
    }),
    expected: fixture.vectors.treasury_transfer_v3,
  },
  {
    name: 'roster_update_v1 — SUI_ORG_ROSTER_V1',
    actual: computeRosterUpdateDigest({
      chainId: CHAIN, orgId: I.orgId, epochVersion: 5n, nonce: 13n,
      newEpochVersion: 6n, thresholdWeight: 30n,
      newMembers: I.members, newWeights: [15n, 15n],
    }),
    expected: fixture.vectors.roster_update_v1,
  },
  {
    name: 'genesis_withdraw_v1 — SUI_ORG_GENESIS_WITHDRAW_V1',
    actual: computeGenesisWithdrawDigest({
      chainId: CHAIN, orgId: I.orgId, epochVersion: 1n, nonce: 8n,
      amount: 500n, recipient: '0x' + '99'.repeat(32),
    }),
    expected: fixture.vectors.genesis_withdraw_v1,
  },
  {
    name: 'dkg_attest_v1 — SUI_DKG_ATTEST_V1',
    actual: computeDkgAttestationDigest({
      sessionId: '0x' + 'dd'.repeat(32), groupPublicKey: hex(I.groupPk),
    }),
    expected: fixture.vectors.dkg_attest_v1,
  },
  {
    name: 'dkg_mailbox_v1 — SUI_DKG_MAILBOX_V1 AAD (sha256 in fixture)',
    actual: createHash('sha256').update(Buffer.from(mailboxAad({
      sessionId: 'session-abc', senderAddress: I.members[0], recipientAddress: I.members[1],
    }))).digest(),
    expected: fixture.vectors.dkg_mailbox_v1,
  },
  {
    name: 'treasury_agent_v1 — SUI_ORG_TREASURY_AGENT_V1 (operator-bound delegation)',
    actual: computeTreasuryAgentDelegationDigest({
      chainId: CHAIN, orgId: I.orgId, epochVersion: 2n, nonce: 31n,
      treasuryId: '0x' + 'ee'.repeat(32), vaultId: '0x' + 'ff'.repeat(32), operator: '0x' + '99'.repeat(32),
      maxEpochOutflow: 700n, maxAgentBudget: 80n, keyGeneration: 4n,
    }),
    expected: fixture.vectors.treasury_agent_v1,
  },
  {
    name: 'treasury_outflow_v1 — SUI_ORG_TREASURY_OUTFLOW_V1 (all-distinct fields)',
    actual: computeTreasuryOutflowPolicyDigest({
      chainId: CHAIN, orgId: I.orgId, epochVersion: 2n, nonce: 32n,
      treasuryId: '0x' + 'ee'.repeat(32), vaultId: '0x' + 'ff'.repeat(32),
      maxEpochOutflow: 700n, maxAgentBudget: 80n, keyGeneration: 4n,
    }),
    expected: fixture.vectors.treasury_outflow_v1,
  },
];

describe('golden digest vectors (digest-vectors.json)', () => {
  it('covers all 12 digest domains', () => {
    expect(cases.length).toBe(12);
    expect(Object.keys(fixture.vectors).length).toBe(12);
  });

  for (const c of cases) {
    it(`${c.name} matches golden vector`, () => {
      expect(Buffer.from(c.actual).toString('hex')).toBe(c.expected);
    });
  }
});

// --- the same bytes on chain ---

const repo = join(here, '..', '..', '..', '..', '..');
const moveTests = join(repo, 'contracts', 'agent_vault', 'tests');
const moveSources = join(repo, 'contracts', 'agent_vault', 'sources');

// [vector id, test module, name of the constant that quotes the vector]
const ON_CHAIN: ReadonlyArray<readonly [string, string, string]> = [
  ['proposal_v2', 'digest_golden_tests.move', 'PROPOSAL_V2'],
  ['epoch_advance_v2', 'digest_golden_tests.move', 'EPOCH_ADVANCE_V2'],
  ['key_rotation_v3', 'digest_golden_tests.move', 'KEY_ROTATION_V3'],
  ['create_pop_v2', 'digest_golden_tests.move', 'CREATE_POP_V2'],
  ['rotate_pop_v1', 'digest_golden_tests.move', 'ROTATE_POP_V1'],
  ['treasury_transfer_v3', 'digest_golden_tests.move', 'TREASURY_TRANSFER_V3'],
  ['roster_update_v1', 'digest_golden_tests.move', 'ROSTER_UPDATE_V1'],
  ['genesis_withdraw_v1', 'digest_golden_tests.move', 'GENESIS_WITHDRAW_V1'],
  ['dkg_attest_v1', 'digest_golden_tests.move', 'DKG_ATTEST_V1'],
  ['treasury_agent_v1', 'organization_treasury_tests.move', 'SDK_GOLDEN_AGENT_DIGEST'],
  ['treasury_outflow_v1', 'organization_treasury_tests.move', 'SDK_GOLDEN_OUTFLOW_DIGEST'],
];

// Vectors with no on-chain counterpart: the mailbox AAD is used off chain only.
const OFF_CHAIN_ONLY = ['dkg_mailbox_v1'];

// Domain string -> the vector that pins the digest built under it.
const DOMAIN_OF: Readonly<Record<string, string>> = {
  'SUI_ORG_THRESHOLD_PROPOSAL_V2:': 'proposal_v2',
  'SUI_ORG_EPOCH_ADVANCE_V2:': 'epoch_advance_v2',
  'SUI_ORG_KEY_ROTATION_V3:': 'key_rotation_v3',
  'SUI_ORG_POP_V2:': 'create_pop_v2',
  'SUI_ORG_POP_V1:': 'rotate_pop_v1',
  'SUI_ORG_TREASURY_TRANSFER_V3:': 'treasury_transfer_v3',
  'SUI_ORG_ROSTER_V1:': 'roster_update_v1',
  'SUI_ORG_GENESIS_WITHDRAW_V1:': 'genesis_withdraw_v1',
  'SUI_DKG_ATTEST_V1:': 'dkg_attest_v1',
  'SUI_ORG_TREASURY_AGENT_V1:': 'treasury_agent_v1',
  'SUI_ORG_TREASURY_OUTFLOW_V1:': 'treasury_outflow_v1',
};

// Domains the contracts still declare and no longer build a digest under. Each
// may keep its declaration and, at most, an accessor that hands it back out.
const DECLARED_UNUSED: Readonly<Record<string, string>> = {
  'SUI_ORG_APPROVAL_V1:': 'DOMAIN_THRESHOLD_APPROVAL',
  'SUI_ORG_TREASURY_TRANSFER_V1:': 'DOMAIN_TREASURY_TRANSFER',
};

function sourceText(dir: string): string {
  return readdirSync(dir).filter((f) => f.endsWith('.move')).map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');
}

describe('the Move side is pinned to the same vectors', () => {
  it('every vector is either recomputed on chain or listed as off-chain only', () => {
    const pinned = [...ON_CHAIN, ...OFF_CHAIN_ONLY.map((id) => [id, '', ''] as const)].map(([id]) => id).sort();
    expect(Object.keys(fixture.vectors).sort()).toEqual(pinned);
  });

  it('the Move tests quote these bytes', () => {
    for (const [id, file, name] of ON_CHAIN) {
      const m = new RegExp(`const ${name}: vector<u8> = x"([0-9a-f]{64})";`).exec(readFileSync(join(moveTests, file), 'utf8'));
      if (!m) throw new Error(`${file} does not quote ${id} as const ${name}`);
      expect(m[1]).toBe(fixture.vectors[id]);
    }
  });

  it('every domain the contracts use is one of these vectors', () => {
    const sources = sourceText(moveSources);
    const used = [...new Set([...sources.matchAll(/b"(SUI_[A-Z0-9_]+:)"/g)].map((m) => m[1]))].sort();
    expect(used).toEqual([...Object.keys(DOMAIN_OF), ...Object.keys(DECLARED_UNUSED)].sort());
    for (const constName of Object.values(DECLARED_UNUSED)) {
      const mentions = sources.split('\n').filter((line) => new RegExp(`\\b${constName}\\b`).test(line));
      expect(mentions[0].trim().startsWith(`const ${constName}:`)).toBe(true);
      for (const line of mentions.slice(1)) expect(line.trim()).toBe(constName);
    }
  });
});
