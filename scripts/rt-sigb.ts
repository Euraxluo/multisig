import { ed25519 } from "@noble/curves/ed25519.js"
import { sha256 } from "@noble/hashes/sha2.js"
const K = (h: string) => Uint8Array.from(h.match(/.{2}/g)!.map(b => parseInt(b, 16)))
const le = (n: bigint) => { const o = new Uint8Array(8); let v = n; for (let i = 0; i < 8; i++) { o[i] = Number(v & 0xffn); v >>= 8n } return o }
const uleb = (n: bigint) => { const out: number[] = []; let v = n; do { let b = Number(v & 0x7fn); v >>= 7n; if (v) b |= 0x80; out.push(b) } while (v); return Uint8Array.from(out) }
const cat = (...xs: Uint8Array[]) => { const l = xs.reduce((a, x) => a + x.length, 0); const o = new Uint8Array(l); let p = 0; for (const x of xs) { o.set(x, p); p += x.length } return o }
const addr = (a: string) => K(a.replace(/^0x/, "").padStart(64, "0"))
const SK = Uint8Array.from([0x69,0xd6,0x41,0x41,0x3a,0x36,0xd5,0xe5,0xc9,0xd3,0x74,0xc2,0xea,0xf0,0x7b,0x0b,0x78,0xf9,0xc7,0xae,0x0c,0x1a,0x18,0x26,0x3a,0x33,0x40,0x6c,0x60,0x59,0x36,0x64])
const digest = sha256(cat(Buffer.from("SUI_ORG_TREASURY_TRANSFER_V1:"), Buffer.from("sui-testnet:"), K("5ef2fcf809fb9535ea0aeaea421f683026f06c34569aafc42bcde652ef6dd270"), le(1n), le(2n), K("3545e4579801a352350fbdef9cfe1130e3c8c662c571f6535501f996395d5dc8"), addr("0x9999"), le(25n)))
console.log("SIG_B_N2", Buffer.from(ed25519.sign(digest, SK)).toString("hex"))
