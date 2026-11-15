/**
 * Golden vectors (issue #25): every digest domain consumed table-driven from
 * digest-vectors.json, produced by scripts/golden-vectors-gen.mjs with
 * node:crypto (zero shared code with the SDK). Any layout change in digest.ts
 * or mailbox.ts must regenerate the vectors intentionally — otherwise this
 * file fails and the CI `git diff --exit-code` gate blocks the merge.
 */
import { readFileSync } from 'node:fs';
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
      chainId: CHAIN, orgId: I.orgId, epochVersion: 1n, nonce: 1n,
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
];

describe('golden digest vectors (digest-vectors.json)', () => {
  it('covers all 10 digest domains', () => {
    expect(cases.length).toBe(10);
    expect(Object.keys(fixture.vectors).length).toBe(10);
  });

  for (const c of cases) {
    it(`${c.name} matches golden vector`, () => {
      expect(Buffer.from(c.actual).toString('hex')).toBe(c.expected);
    });
  }
});
