import { ed25519 } from "@noble/curves/ed25519.js"
import { sha256 } from "@noble/hashes/sha2.js"
const sk1 = new Uint8Array(32).fill(0x01)
const ORG = Buffer.from("a4137e2ed945e7f4e8c307001c32e97472fb3eebb8f7b4ab7534b447d22da89b", "hex")
const chain = Buffer.from("sui-testnet:")
const le = (v: bigint) => { const o = new Uint8Array(8); let x = v; for (let i = 0; i < 8; i++) { o[i] = Number(x & 0xffn); x >>= 8n } return o }
const dom = Buffer.from("SUI_ORG_EPOCH_ADVANCE_V2:")
function main() {
  // test 2 (new_key_signs_post_rotate_advance_digest): epoch=2, nonce=2, next=3, kg=2 — but signed by SK2
  const sk2 = new Uint8Array(32).fill(0x02)
  const dOld = sha256(Buffer.concat([dom, chain, ORG, le(1n), le(2n), le(2n), le(1n)]))   // SIG_OLDKEY_ADVANCE (SK1)
  const sOld = ed25519.sign(dOld, sk1)
  const dNew = sha256(Buffer.concat([dom, chain, ORG, le(2n), le(4n), le(3n), le(2n)]))   // SIG_NEWKEY_ADVANCE (SK2)
  const sNew = ed25519.sign(dNew, sk2)
  console.log("SIG_OLDKEY_ADVANCE =", Buffer.from(sOld).toString("hex"))
  console.log("SIG_NEWKEY_ADVANCE =", Buffer.from(sNew).toString("hex"))
  // test 1 (key_generation_increments_only_on_rotation): with clock → org id a413…? that was the no-clock flow? test1 uses clock in txn0 → org id differs. Print both candidate digests for nonce1 advance (epoch1→2 kg1→1)
  const dN1 = sha256(Buffer.concat([dom, chain, ORG, le(1n), le(1n), le(2n), le(1n)]))
  console.log("SIG_OLDKEY_ADVANCE_N1 (ORG above) =", Buffer.from(ed25519.sign(dN1, sk1)).toString("hex"))
}
main()
