import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { sha256 } from '@noble/hashes/sha2.js';
import { blake2b } from '@noble/hashes/blake2.js';

const le = (n) => { const o = new Uint8Array(8); let v = n; for (let i=0;i<8;i++){o[i]=Number(v&0xffn);v>>=8n;} return o; };
const uleb = (n) => { const out=[]; let v=n; do{let b=Number(v&0x7fn);v>>=7n;if(v)b|=0x80;out.push(b);}while(v); return Uint8Array.from(out); };
const pad32 = (h) => { const out=new Uint8Array(32).fill(0); out.set(h); return out; };
const cat = (...xs)=>{const l=xs.reduce((a,x)=>a+x.length,0);const o=new Uint8Array(l);let p=0;for(const x of xs){o.set(x,p);p+=x.length;}return o;};
const deriveId = (t, i) => new Uint8Array(blake2b(cat(new Uint8Array([0xf1]), pad32(uleb(BigInt(t))), le(BigInt(i))), {dkLen:32}));
const K = (hex) => Uint8Array.from(hex.match(/.{2}/g).map((b) => parseInt(b, 16)));
const H = (b) => Buffer.from(b).toString('hex');
const addr = (a) => K(a.replace(/^0x/, '').padStart(64, '0'));
const CHAIN = Buffer.from('sui-testnet:');
const vecItems = (items) => cat(uleb(BigInt(items.length)), ...items);

// Keys
const kpA = Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(0x01));        // PKA 8a88e3dd...
const kp1 = Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(0xab));        // PK1 248acbdb...
const kp2 = Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(0xcd));        // PK2 fc947730...
const kpG = Ed25519Keypair.fromSecretKey(Uint8Array.from([0x69,0xd6,0x41,0x41,0x3a,0x36,0xd5,0xe5,0xc9,0xd3,0x74,0xc2,0xea,0xf0,0x7b,0x0b,0x78,0xf9,0xc7,0xae,0x0c,0x1a,0x18,0x26,0x3a,0x33,0x40,0x6c,0x60,0x59,0x36,0x64])); // PKG 1134f375...
const PKA = kpA.getPublicKey().toRawBytes(), PK1 = kp1.getPublicKey().toRawBytes(), PK2 = kp2.getPublicKey().toRawBytes();

const ALICE = addr('0xa11ce'), BOB = addr('0xb0b'), RECIPIENT = addr('0x9999');
const sig = async (kp, d) => H(await kp.sign(d));

const ADV_V2 = (orgId, epoch, nonce, nextEpoch, keyGen) =>
  sha256(cat(Buffer.from('SUI_ORG_EPOCH_ADVANCE_V2:'), CHAIN, orgId, le(BigInt(epoch)), le(BigInt(nonce)), le(BigInt(nextEpoch)), le(BigInt(keyGen))));
const TR_V2 = (orgId, epoch, nonce, propId, rec, amt, keyGen) =>
  sha256(cat(Buffer.from('SUI_ORG_TREASURY_TRANSFER_V2:'), CHAIN, orgId, le(BigInt(epoch)), le(BigInt(nonce)), propId, rec, le(BigInt(amt)), le(BigInt(keyGen))));

const out = {};
// Org IDs (runtime-verified):
const ORG_NO_CLOCK = deriveId(0, 1);   // a4137e2e... (agent_vault_tests, no clock in txn0)
const ORG_CLOCK    = deriveId(0, 2);   // 5ef2fcf8... (dkg_committee_tests, organization_treasury_tests, transfer_gate_tests)
const ORG_RT9      = deriveId(1, 1);   // 63d9a652... (rt9 regression flow: clock txn0, org txn1)
console.log('ORG_NO_CLOCK', H(ORG_NO_CLOCK), 'ORG_CLOCK', H(ORG_CLOCK), 'ORG_RT9', H(ORG_RT9));

// Epoch-advance V2 (epoch=1, nonce=2, next=2, kg=1)
out.AV_APPROVAL_N2 = await sig(kpA, ADV_V2(ORG_NO_CLOCK, 1, 2, 2, 1));
out.DKG_TREAS_APPROVAL_N2 = await sig(kpA, ADV_V2(ORG_CLOCK, 1, 2, 2, 1));

// Transfer gate V2 (org=ORG_CLOCK, epoch=1, kg=1); PROP_A=bl(3,1), PROP_B=bl(7,0)
const PROP_A = deriveId(3, 1), PROP_B = deriveId(7, 0);
console.log('PROP_A', H(PROP_A), 'PROP_B', H(PROP_B));
out.GATE_SIG_N1 = await sig(kpG, TR_V2(ORG_CLOCK, 1, 1, PROP_A, RECIPIENT, 30n, 1n));
out.GATE_SIG_N2 = await sig(kpG, TR_V2(ORG_CLOCK, 1, 2, PROP_B, RECIPIENT, 25n, 1n));

// rt9 regression (a): OLD key (PK1/sk=0xab*32) signs the POST-rotate V2 transfer digest.
// Flow: clock(txn0), org(txn1)=ORG_RT9, rotate(txn2) -> epoch2/kg2, treasury(txn3), deposit(txn4),
// create transfer(txn5): PROP_R=bl(5,0) amount=30 to 0x9999, approvals(txn6/7), execute(txn8) nonce=2.
const PROP_R = deriveId(5, 0);
console.log('PROP_R', H(PROP_R));
out.RT9_OLDKEY_TRANSFER = await sig(kp1, TR_V2(ORG_RT9, 2, 2, PROP_R, RECIPIENT, 30n, 2n));

// rt9 regression (b): OLD key signs the PRE-rotate V2 advance digest
// (epoch=1, nonce=2, next=2, kg=1) — valid only before rotation; the rotate
// in the test consumes this nonce, so replaying after rotation aborts 1001.
out.RT9_OLDKEY_ADVANCE = await sig(kp1, ADV_V2(ORG_NO_CLOCK, 1, 2, 2, 1));
// Positive control: NEW key over the post-rotate advance digest
// (epoch=3, nonce=4, next=4, kg=2) — signed for the epoch the rotation
// produced in new_key_signs_post_rotate_advance_digest.
out.RT9_NEWKEY_ADVANCE = await sig(kp2, ADV_V2(ORG_NO_CLOCK, 3, 4, 4, 2));
// key_generation lifecycle test: OLD key over the advance digest at nonce=1
// (epoch=1, nonce=1, next=2, kg=1).
out.RT9_OLDKEY_ADVANCE_N1 = await sig(kp1, ADV_V2(ORG_NO_CLOCK, 1, 1, 2, 1));

console.log(JSON.stringify(out, null, 2));
