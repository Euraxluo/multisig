/* eslint-disable */
// Generates transfer-gate Move test fixtures for the agent_vault package.
// Deterministic object IDs in sui::test_scenario:
//   tx digest  = ULEB128(txn_number) zero-padded to 32 bytes (dummy_tx_hash_with_hint)
//   object id  = sha3_256(tx digest ++ le_bytes(ids_created))  (tx_context::derive_id)
// We replay the exact ID consumption order of the fixture setup in
// tests/transfer_gate_tests.move and print the PoP signature (id-independent)
// plus a valid threshold signature per (org_id, proposal_id) pair.
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { sha256 } from '@noble/hashes/sha2.js';
import { sha3_256 } from '@noble/hashes/sha3.js';

const K = (hex: string) => Uint8Array.from(hex.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
const le = (n: bigint) => {
  const out = new Uint8Array(8);
  let v = n;
  for (let i = 0; i < 8; i++) { out[i] = Number(v & 0xffn); v >>= 8n; }
  return out;
};
const uleb = (n: bigint) => {
  const out: number[] = [];
  let v = n;
  do { let b = Number(v & 0x7fn); v >>= 7n; if (v) b |= 0x80; out.push(b); } while (v);
  return Uint8Array.from(out);
};
const u64bcs = (n: bigint) => le(n); // BCS u64 = fixed LE 8 bytes
const concat = (...xs: Uint8Array[]) => {
  const len = xs.reduce((a, x) => a + x.length, 0);
  const out = new Uint8Array(len);
  let o = 0; for (const x of xs) { out.set(x, o); o += x.length; }
  return out;
};
// BCS vector<u8> = ULEB(len) ++ bytes; vector<address>/vector<u64> = ULEB(len) ++ items
const vecBytes = (b: Uint8Array) => concat(uleb(BigInt(b.length)), b);
const vecItems = (items: Uint8Array[]) => concat(uleb(BigInt(items.length)), ...items);

const txDigest = (txn: bigint) => {
  const h = uleb(txn);
  const out = new Uint8Array(32).fill(0);
  out.set(h);
  return out;
};
const deriveId = (txn: bigint, ids: bigint) => sha3_256(concat(txDigest(txn), le(ids)));

// --- scenario layout mirroring transfer_gate_tests.start_fixture ---
const ALICE = '0xa11ce';
const BOB = '0xb0b';
const recipients = { A: '0x9999', B: '0x7777' };

// txn0 (begin ALICE): clock UID(ids=0), org UID(ids=1)
const ORG_ID = K('5ef2fcf809fb9535ea0aeaea421f683026f06c34569aafc42bcde652ef6dd270'); // TRUE id from on-chain debug print

// members/weights fixed for both orgs
const MEMBERS = vecItems([K(ALICE.replace(/^0x/, '').padStart(64, '0')), K(BOB.replace(/^0x/, '').padStart(64, '0'))]);
const WEIGHTS = vecItems([u64bcs(1n), u64bcs(1n)]);

const POP = (chainId: Uint8Array, groupPk: Uint8Array) =>
  sha256(concat(Buffer.from('SUI_ORG_POP_V1:'), chainId, groupPk, MEMBERS, WEIGHTS, u64bcs(2n)))  // threshold_weight = 2;

const TRANSFER = (chainId: Uint8Array, orgId: Uint8Array, epoch: bigint, nonce: bigint, proposalId: Uint8Array, recipient: Uint8Array, amount: bigint) =>
  sha256(concat(Buffer.from('SUI_ORG_TREASURY_TRANSFER_V1:'), chainId, orgId, u64bcs(epoch), u64bcs(nonce), proposalId, recipient, u64bcs(amount)));

// keys: GROUP_PK is a valid single-party ed25519 keypair whose pk we fix on-chain
const kp = Ed25519Keypair.fromSecretKey(Uint8Array.from([0x69,0xd6,0x41,0x41,0x3a,0x36,0xd5,0xe5,0xc9,0xd3,0x74,0xc2,0xea,0xf0,0x7b,0x0b,0x78,0xf9,0xc7,0xae,0x0c,0x1a,0x18,0x26,0x3a,0x33,0x40,0x6c,0x60,0x59,0x36,0x64]));
const pk = kp.getPublicKey().toRawBytes();
;(async () => {
const sig = async (digest: Uint8Array) => kp.sign(digest);



// txn1 (ALICE): treasury new -> vault UID(0), master UID(1), treasury UID(2)
// txn2 (ALICE): deposit coin UID(0); create_transfer -> voters tbl(1), partial tbl(2), proposal(3), binding(4)
const CHAIN = Buffer.from('sui-testnet:');
const AMT_A = 30n;
const propA = K('489d325645528066bd5fc2fd6e54cedebd2d7e98aa6095740a6b892e1b1c09f7'); // TRUE id from on-chain debug print

// helper to format the x"..." literal for Move
const moveBytes = (label: string, bytes: Uint8Array) => console.log(`${label} = x"${Buffer.from(bytes).toString('hex')}"`);

console.log(`GROUP_PK = x"${Buffer.from(pk).toString('hex')}"`);
moveBytes('ORG_ID', ORG_ID);
moveBytes('POP_SIG', await sig(POP(CHAIN, pk)));
moveBytes('PROP_A', propA);
moveBytes('SIG_A_N1', await sig(TRANSFER(CHAIN, ORG_ID, 1n, 1n, propA, K(recipients.A.replace(/^0x/, '').padStart(64, '0')), AMT_A)));
// second proposal created in txn5 (proposal UID at ids_created 0 of txn5)
const propB = deriveId(6n, 0n); // txn6: ALICE creates transfer B -> proposal uid(0)
moveBytes('PROP_B', propB);
moveBytes('SIG_B_N2', await sig(TRANSFER(CHAIN, ORG_ID, 1n, 2n, propB, K(recipients.A.replace(/^0x/, '').padStart(64, '0')), 25n)));

})();
