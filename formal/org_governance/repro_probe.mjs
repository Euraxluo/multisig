// Translates the two TLC counterexamples back onto the implementation.
//
// The model treats a signature as the tuple of fields its digest binds, and a
// transition as consuming exactly that tuple. That is only faithful if the
// real digest function changes its output whenever one of those fields
// changes. This probe asserts exactly that, against the SDK builders that are
// byte-for-byte the Move layout (packages/multisig/src/agent-vault/org/digest.ts,
// pinned by golden-vectors.test.ts).
//
//   isolation  RosterUnguarded(1, "roster_drop_signer") then a later action.
//              cryptographic_org.move:908 refuses to drop a key signer; the
//              digest must bind the member list so the refusal cannot be
//              sidestepped by reusing a signature over a different roster.
//   broken     RotateUnbound: the digest no longer names the new key, so one
//              signature installs whichever key the caller supplies.
//              compute_key_rotation_digest (:510) appends new_group_pk, so two
//              different keys must hash differently.
const {
  computeKeyRotationDigest,
  computeThresholdApprovalDigest,
  computeRosterUpdateDigest,
  computeGenesisWithdrawDigest,
} = await import('../../packages/multisig/src/agent-vault/org/digest.ts');

const CHAIN = 'sui-testnet:';
const ORG = '0x' + '11'.repeat(32);
const A = '0x' + '01'.repeat(32);
const B = '0x' + '02'.repeat(32);
const C = '0x' + '03'.repeat(32);
const PK1 = Uint8Array.from({ length: 32 }, () => 0xab);
const PK2 = Uint8Array.from({ length: 32 }, () => 0xcd);

const hex = (b) => Buffer.from(b).toString('hex');
let failed = 0;
function check(name, ok) {
  console.log(`${ok ? 'pass' : 'FAIL'}  ${name}`);
  if (!ok) failed += 1;
}

// --- isolation: the roster digest binds every member and every weight. ---
const base = computeRosterUpdateDigest({
  chainId: CHAIN, orgId: ORG, epochVersion: 1, nonce: 1, newEpochVersion: 2,
  thresholdWeight: 2, newMembers: [A, B], newWeights: [1, 1],
});
const droppedSigner = computeRosterUpdateDigest({
  chainId: CHAIN, orgId: ORG, epochVersion: 1, nonce: 1, newEpochVersion: 2,
  thresholdWeight: 2, newMembers: [A, C], newWeights: [1, 1],
});
const loweredThreshold = computeRosterUpdateDigest({
  chainId: CHAIN, orgId: ORG, epochVersion: 1, nonce: 1, newEpochVersion: 2,
  thresholdWeight: 1, newMembers: [A, B], newWeights: [1, 1],
});
check('roster digest changes when a key signer is swapped out', hex(base) !== hex(droppedSigner));
check('roster digest changes when the threshold drops', hex(base) !== hex(loweredThreshold));

// --- broken: the rotation digest binds the new key. ---
const rot1 = computeKeyRotationDigest({
  chainId: CHAIN, orgId: ORG, epochVersion: 1, nonce: 1,
  newGroupPk: PK1, newSigners: [A, B], keyThreshold: 2,
});
const rot2 = computeKeyRotationDigest({
  chainId: CHAIN, orgId: ORG, epochVersion: 1, nonce: 1,
  newGroupPk: PK2, newSigners: [A, B], keyThreshold: 2,
});
check('rotation digest changes when the new key changes', hex(rot1) !== hex(rot2));

// --- advance binds the key generation, which is what closes the resharing window.
const adv1 = computeThresholdApprovalDigest({
  chainId: CHAIN, orgId: ORG, epochVersion: 1, nonce: 1, newEpochVersion: 2, keyGeneration: 1,
});
const adv2 = computeThresholdApprovalDigest({
  chainId: CHAIN, orgId: ORG, epochVersion: 1, nonce: 1, newEpochVersion: 2, keyGeneration: 2,
});
check('advance digest changes when key_generation changes', hex(adv1) !== hex(adv2));

// --- and the negative control: the SAME inputs must reproduce the SAME digest,
// otherwise the checks above pass trivially because the builder is not pure.
const adv1b = computeThresholdApprovalDigest({
  chainId: CHAIN, orgId: ORG, epochVersion: 1, nonce: 1, newEpochVersion: 2, keyGeneration: 1,
});
check('advance digest is deterministic', hex(adv1) === hex(adv1b));

// --- genesis withdrawal binds the amount, so the hard-lock-gated signature
// cannot be replayed for a different amount once the lock expires.
const w1 = computeGenesisWithdrawDigest({
  chainId: CHAIN, orgId: ORG, epochVersion: 1, nonce: 1, amount: 100, recipient: A,
});
const w2 = computeGenesisWithdrawDigest({
  chainId: CHAIN, orgId: ORG, epochVersion: 1, nonce: 1, amount: 200, recipient: A,
});
check('withdraw digest changes when the amount changes', hex(w1) !== hex(w2));

console.log(failed === 0 ? 'probe ok' : `${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
