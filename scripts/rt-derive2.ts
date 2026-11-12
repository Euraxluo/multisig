import { blake2b } from "@noble/hashes/blake2.js"
const le = (n: bigint) => { const o = new Uint8Array(8); let v = n; for (let i = 0; i < 8; i++) { o[i] = Number(v & 0xffn); v >>= 8n } return o }
const cat = (...xs: Uint8Array[]) => { const l = xs.reduce((a, x) => a + x.length, 0); const o = new Uint8Array(l); let p = 0; for (const x of xs) { o.set(x, p); p += x.length } return o }
const target = "a4137e2ed945e7f4e8c307001c32e97472fb3eebb8f7b4ab7534b447d22da89b"
for (const txn of [0n, 1n]) {
  const u64pad = new Uint8Array(32); u64pad.set(le(txn))
  for (const ids of [0n, 1n, 2n, 3n]) {
    const id = Buffer.from(blake2b(cat(u64pad, le(ids)), { dkLen: 32 })).toString("hex")
    if (id === target) console.log("MATCH blake2b", { txn, ids })
  }
}
console.log("done")
