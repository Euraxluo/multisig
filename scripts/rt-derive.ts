import { sha3_256 } from "@noble/hashes/sha3.js"
import { sha256 } from "@noble/hashes/sha2.js"
const le = (n: bigint) => { const o = new Uint8Array(8); let v = n; for (let i = 0; i < 8; i++) { o[i] = Number(v & 0xffn); v >>= 8n } return o }
const cat = (...xs: Uint8Array[]) => { const l = xs.reduce((a, x) => a + x.length, 0); const o = new Uint8Array(l); let p = 0; for (const x of xs) { o.set(x, p); p += x.length } return o }
const target = "a4137e2ed945e7f4e8c307001c32e97472fb3eebb8f7b4ab7534b447d22da89b"
for (const txn of [0n, 1n]) {
  // candidate tx digests
  const u32 = new Uint8Array(32); new DataView(u32.buffer).setUint32(0, Number(txn), true)
  const u64 = le(txn)
  for (const [dn, tx] of [["u32le-pad", u32], ["u64le-pad", (() => { const o = new Uint8Array(32); o.set(u64); return o })()]]) {
    for (const ids of [0n, 1n, 2n, 3n]) {
      for (const [hn, h] of [["sha3", sha3_256], ["sha2", sha256]] as const) {
        const id = Buffer.from(h(cat(tx, le(ids)))).toString("hex")
        if (id === target) console.log("MATCH", { txn, dn, ids, hn })
      }
    }
  }
}
console.log("done")
