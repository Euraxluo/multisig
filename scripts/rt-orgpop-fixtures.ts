import { ed25519 } from "@noble/curves/ed25519.js"
import { sha256 } from "@noble/hashes/sha2.js"
import { sha3_256 } from "@noble/hashes/sha3.js"
const K = (h: string) => Uint8Array.from(h.match(/.{2}/g)!.map(b => parseInt(b, 16)))
const le = (n: bigint) => { const o = new Uint8Array(8); let v = n; for (let i = 0; i < 8; i++) { o[i] = Number(v & 0xffn); v >>= 8n } return o }
const uleb = (n: bigint) => { const out: number[] = []; let v = n; do { let b = Number(v & 0x7fn); v >>= 7n; if (v) b |= 0x80; out.push(b) } while (v); return Uint8Array.from(out) }
const cat = (...xs: Uint8Array[]) => { const l = xs.reduce((a, x) => a + x.length, 0); const o = new Uint8Array(l); let p = 0; for (const x of xs) { o.set(x, p); p += x.length } return o }
const vi = (items: Uint8Array[]) => cat(uleb(BigInt(items.length)), ...items)
const addr = (a: string) => K(a.replace(/^0x/, "").padStart(64, "0"))
const CHAIN = Buffer.from("sui-testnet:")
const SK1 = new Uint8Array(32).fill(0xab)
const SK2 = new Uint8Array(32).fill(0xcd)
const PK1 = ed25519.getPublicKey(SK1)
const PK2 = ed25519.getPublicKey(SK2)
console.log("PK1", Buffer.from(PK1).toString("hex"))
console.log("PK2", Buffer.from(PK2).toString("hex"))
const ALICE = addr("0xa11ce"), BOB = addr("0xb0b"), EVE = addr("0xee7e")
const popCreate = sha256(cat(Buffer.from("SUI_ORG_POP_V1:"), CHAIN, PK1, vi([ALICE, BOB]), vi([le(2n), le(1n)]), le(3n)))
console.log("CREATE_POP_SIG", Buffer.from(ed25519.sign(popCreate, SK1)).toString("hex"))
// org UID: created via create_organization: members_weight Table(id 0) + org UID(id 1) + executed_proposals Table(id 2)? table::new allocates UID too!
// Order in create_organization_with_chain_id: members_table = table::new (UID id0), org_uid = object::new (id1), executed_proposals table::new inside struct (id2)? Struct literal order: executed_proposals field constructed AFTER org_uid? We'll try ids=1 first; fallback ids=2.
const txDigest = (txn: bigint) => { const h = uleb(txn); const o = new Uint8Array(32); o.set(h); return o }
const deriveId = (txn: bigint, ids: bigint) => sha3_256(cat(txDigest(txn), le(ids)))
{
  const ORG_ID = K('a4137e2ed945e7f4e8c307001c32e97472fb3eebb8f7b4ab7534b447d22da89b')
  const rotPop = sha256(cat(Buffer.from("SUI_ORG_POP_V1:"), CHAIN, ORG_ID, le(2n), PK2))
  const rotFrostAB = sha256(cat(Buffer.from("SUI_ORG_KEY_ROTATION_V2:"), CHAIN, ORG_ID, le(1n), le(1n), PK2, vi([ALICE, BOB])))
  const rotFrostAE = sha256(cat(Buffer.from("SUI_ORG_KEY_ROTATION_V2:"), CHAIN, ORG_ID, le(1n), le(1n), PK2, vi([ALICE, EVE])))
  const rosterAddEve = sha256(cat(Buffer.from("SUI_ORG_ROSTER_V1:"), CHAIN, ORG_ID, le(1n), le(1n), le(2n), le(3n), vi([ALICE, BOB, EVE]), vi([le(2n), le(1n), le(1n)])))
  console.log("ROTATE_POP_SIG", Buffer.from(ed25519.sign(rotPop, SK2)).toString("hex"))
  console.log("ROT_FROST_SIG_AB", Buffer.from(ed25519.sign(rotFrostAB, SK1)).toString("hex"))
  console.log("ROT_FROST_SIG_AE", Buffer.from(ed25519.sign(rotFrostAE, SK1)).toString("hex"))
  console.log("ROSTER_SIG_ADD_EVE", Buffer.from(ed25519.sign(rosterAddEve, SK1)).toString("hex"))
}

