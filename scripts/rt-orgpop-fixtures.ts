/* eslint-disable */
// Regenerates org_pop_tests.move fixtures for the V3 key-rotation digest:
//   H("SUI_ORG_KEY_ROTATION_V3:" || chain || bcs(org_id) || bcs(epoch) ||
//     bcs(nonce) || new_group_pk || bcs(new_signers) || bcs(key_threshold))
// Step 1 recomputes the unchanged V1 PoP fixtures byte-exact (create + rotate)
// to pin the secret keys and the deterministic ORG_ID; any mismatch aborts.
// Step 2 emits the V3 rotation signatures for the updated tests.
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { sha256 } from '@noble/hashes/sha2.js';
import { keccak_256 } from '@noble/hashes/sha3.js';


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
const u64bcs = (n: bigint) => le(n);
const concat = (...xs: Uint8Array[]) => {
  const len = xs.reduce((a, x) => a + x.length, 0);
  const out = new Uint8Array(len);
  let o = 0; for (const x of xs) { out.set(x, o); o += x.length; }
  return out;
};
const txDigest = (txn: bigint) => {
  const h = uleb(txn);
  const out = new Uint8Array(32).fill(0);
  out.set(h);
  return out;
};
// object::derive_id = keccak_256(tx_hash ++ le_bytes(ids_created)) in the Move VM
const deriveId = (txn: bigint, ids: bigint) => keccak_256(concat(txDigest(txn), le(ids)));
// BCS vector<address>/vector<u64> = ULEB(len) ++ items
const vecItems = (items: Uint8Array[]) => concat(uleb(BigInt(items.length)), ...items);

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const addr = (a: string) => K(a.replace(/^0x/, '').padStart(64, '0'));

const ALICE = addr('0xa11ce');
const BOB = addr('0xb0b');
const EVE = addr('0xee7e');
const CHAIN = Buffer.from('sui-testnet:');

const SK1 = new Uint8Array(32).fill(0xab);
const SK2 = new Uint8Array(32).fill(0xcd);
const kp1 = Ed25519Keypair.fromSecretKey(SK1);
const kp2 = Ed25519Keypair.fromSecretKey(SK2);

const PK1 = kp1.getPublicKey().toRawBytes();
const PK2 = kp2.getPublicKey().toRawBytes();

const MEMBERS_AB = vecItems([ALICE, BOB]);
const WEIGHTS_21 = vecItems([u64bcs(2n), u64bcs(1n)]);

const createPop = (thresholdWeight: bigint) =>
  sha256(concat(Buffer.from('SUI_ORG_POP_V1:'), CHAIN, PK1, MEMBERS_AB, WEIGHTS_21, u64bcs(thresholdWeight)));

const rotatePop = (orgId: Uint8Array, nextEpoch: bigint) =>
  sha256(concat(Buffer.from('SUI_ORG_POP_V1:'), CHAIN, orgId, u64bcs(nextEpoch), PK2));

const rotDigest = (domain: string, orgId: Uint8Array, epoch: bigint, nonce: bigint, signers: Uint8Array[], keyThreshold: bigint | null) =>
  sha256(concat(
    Buffer.from(domain), CHAIN, orgId, u64bcs(epoch), u64bcs(nonce), PK2,
    vecItems(signers),
    ...(keyThreshold === null ? [] : [u64bcs(keyThreshold)]),
  ));

const V2 = 'SUI_ORG_KEY_ROTATION_V2:';
const V3 = 'SUI_ORG_KEY_ROTATION_V3:';

// pinned constants from tests/org_pop_tests.move — step 1 must reproduce these
const EXPECT_PK1 = '248acbdbaf9e050196de704bea2d68770e519150d103b587dae2d9cad53dd930';
const EXPECT_PK2 = 'fc947730f49eb01427a66e050733294d9e520e545c7a27125a780634e0860a27';
const EXPECT_CREATE_POP = 'b3eafb2a53e077745d82fecaa71b46c039f3eed256d4fb98536c0d4ba89614ee595daf0ec2b2e211c2e5a10612169c26223b22b5e94bef9865c15382af824503';
const EXPECT_ROTATE_POP = 'c1f01de552ab0873cce4ea255f089c553fbc6abe870c7dcfbb83d8be023731e590c39a164523e86390a639b08779fd68eeaea85e0e14f177723d05faf0c7720f';

const assertEq = (label: string, got: string, want: string) => {
  if (got !== want) throw new Error(`${label} MISMATCH\n got ${got}\nwant ${want}`);
  console.log(`OK ${label}`);
};

const sig1 = async (d: Uint8Array) => new Uint8Array(await kp1.sign(d));
const sig2 = async (d: Uint8Array) => new Uint8Array(await kp2.sign(d));

(async () => {
  // --- keys pinned ---
  assertEq('PK1', hex(PK1), EXPECT_PK1);
  assertEq('PK2', hex(PK2), EXPECT_PK2);

  // --- create PoP unchanged (threshold_weight = 3, [ALICE,BOB]/[2,1]) ---
  assertEq('CREATE_POP_SIG', hex(await sig1(createPop(3n))), EXPECT_CREATE_POP);

  // --- pin ORG_ID from the on-chain debug print (std::debug::print(&org_id)
  //     in start_valid_org via sui move test org_pop; object-creation order is
  //     unchanged by the key_threshold param, so the id carries over from V2) ---
  const ORG_ID = K('a4137e2ed945e7f4e8c307001c32e97472fb3eebb8f7b4ab7534b447d22da89b');
  assertEq('ROTATE_POP_SIG', hex(await sig2(rotatePop(ORG_ID, 2n))), EXPECT_ROTATE_POP);

  // --- V3 fixtures: epoch=1, nonce=1, PK2, key_threshold=2 ---
  const KT = 2n;
  console.log(`ORG_ID = x"${hex(ORG_ID)}"`);
  console.log(`ROT_FROST_SIG_AB (V3, [A,B], kt=2)  = x"${hex(await sig1(rotDigest(V3, ORG_ID, 1n, 1n, [ALICE, BOB], KT)))}"`);
  console.log(`ROT_FROST_SIG_AB (V3, [A,B], kt=2)  = x"${hex(await sig1(rotDigest(V3, ORG_ID, 1n, 1n, [ALICE, BOB], KT)))}"`);
  // attack-T roster sig: org created 2/2 (kt=2, tw=2, members [A,B] w[1,1]);
  // digest = SUI_ORG_ROSTER_V1(chain, org, epoch=1, nonce=1, next_epoch=2,
  // tw=1, members=[A,B,E,C,D], weights=[1,1,1,1,1]) — must abort E_THRESHOLD_BELOW_KEY.
  const CAROL = addr('0xc4401');
  const DAVE = addr('0xda4e');
  const rosterDigest = sha256(concat(
    Buffer.from('SUI_ORG_ROSTER_V1:'), CHAIN, ORG_ID, u64bcs(1n), u64bcs(1n), u64bcs(2n), u64bcs(1n),
    vecItems([ALICE, BOB, EVE, CAROL, DAVE]),
    vecItems([u64bcs(1n), u64bcs(1n), u64bcs(1n), u64bcs(1n), u64bcs(1n)]),
  ));
  console.log(`ATTACK_T_ROSTER_SIG (V1 roster, tw=1) = x"${hex(await sig1(rosterDigest))}"`);
  console.log(`ROT_FROST_SIG_V2 (V2 domain, [A,B]) = x"${hex(await sig1(rotDigest(V2, ORG_ID, 1n, 1n, [ALICE, BOB], null)))}"`);
  console.log(`ROT_FROST_SIG_KT1 (V3, [A,B], kt=1) = x"${hex(await sig1(rotDigest(V3, ORG_ID, 1n, 1n, [ALICE, BOB], 1n)))}"`);
})();
// --- attack-T roster fixture: create 2/2 org (kt=2, tw=2), then roster-update
//     to 5 members with threshold_weight=1 (below kt) — the signed digest that
//     update_organization_roster must reject with E_THRESHOLD_BELOW_KEY.
//     Roster digest is unchanged (V1), so this signs the canonical layout.
