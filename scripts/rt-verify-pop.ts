import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { sha256 } from "@noble/hashes/sha2.js"
const K = (h: string) => Uint8Array.from(h.match(/.{2}/g)!.map(b => parseInt(b, 16)))
const le = (n: bigint) => { const o = new Uint8Array(8); let v = n; for (let i = 0; i < 8; i++) { o[i] = Number(v & 0xffn); v >>= 8n } return o }
const uleb = (n: bigint) => { const out: number[] = []; let v = n; do { let b = Number(v & 0x7fn); v >>= 7n; if (v) b |= 0x80; out.push(b) } while (v); return Uint8Array.from(out) }
const cat = (...xs: Uint8Array[]) => { const l = xs.reduce((a, x) => a + x.length, 0); const o = new Uint8Array(l); let p = 0; for (const x of xs) { o.set(x, p); p += x.length } return o }
const vecItems = (items: Uint8Array[]) => cat(uleb(BigInt(items.length)), ...items)
const addr = (a: string) => K(a.replace(/^0x/, "").padStart(64, "0"))
const GROUP_PK = K("1134f37538a47141469ab276bec672c3eeae7e29641f6ae56816b9ec37aee3c7")
const POP_SIG = K("6620eb725c3a6b12b5aa96ae7941326f287caa561fa162e92ef0f5fc9f07ce50bf0ab08a041cd33aab58432eab5a8c07f550d45757e036e10f5a5973c5746c0e")
async function main() {
  const kp = Ed25519Keypair.fromSecretKey(Uint8Array.from([0x69, 0xd6, 0x41, 0x41, 0x3a, 0x36, 0xd5, 0xe5, 0xc9, 0xd3, 0x74, 0xc2, 0xea, 0xf0, 0x7b, 0x0b, 0x78, 0xf9, 0xc7, 0xae, 0x0c, 0x1a, 0x18, 0x26, 0x3a, 0x33, 0x40, 0x6c, 0x60, 0x59, 0x36, 0x64]))
  console.log("pk matches:", Buffer.from(kp.getPublicKey().toRawBytes()).toString("hex") === Buffer.from(GROUP_PK).toString("hex"))
  const digest = sha256(cat(Buffer.from("SUI_ORG_POP_V1:"), Buffer.from("sui-testnet:"), GROUP_PK, vecItems([addr("0xa11ce"), addr("0xb0b")]), vecItems([le(1n), le(1n)]), le(2n)))
  console.log("digest:", Buffer.from(digest).toString("hex"))
  const resig = await kp.sign(digest)
  console.log("resig:", Buffer.from(resig).toString("hex"))
  console.log("fixture matches:", Buffer.from(resig).toString("hex") === Buffer.from(POP_SIG).toString("hex"))
}
main()
