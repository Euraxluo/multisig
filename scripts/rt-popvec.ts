// PoP + V2-rotation + treasury-transfer signature fixture generator.
// Usage: tsx scripts/rt-popvec.ts <mode> [args…]
//   mode=key                     → prints SEED_PK/SEED_SK
//   mode=pop <skHex> <chain> <pkHex> <membersCSV> <weightsCSV> <threshold>
//   mode=rotatepop <skHex> <chain> <orgId> <newEpoch> <newPkHex>
//   mode=rotate <skHex> <chain> <orgId> <epoch> <nonce> <newPkHex> <signersCSV>
//   mode=transfer <skHex> <chain> <orgId> <epoch> <nonce> <proposalId> <recipient> <amount>
import { ed25519 } from "@noble/curves/ed25519.js"
import { sha256 } from "@noble/hashes/sha2.js"
const enc = new TextEncoder()
const h = (s: string) => Buffer.from(s.replace(/^0x/, "").padStart(64, "0"), "hex")
function u64le(v: bigint): Uint8Array { const b = new Uint8Array(8); let x = v; for (let i = 0; i < 8; i++) { b[i] = Number(x & 0xffn); x >>= 8n } return b }
function vecAddr(addrs: string[]): Uint8Array { const buf = new Uint8Array(1 + addrs.length * 32); buf[0] = addrs.length; addrs.forEach((a, i) => buf.set(h(a), 1 + i * 32)); return buf }
function vecU64(vals: bigint[]): Uint8Array { const buf = new Uint8Array(1 + vals.length * 8); buf[0] = vals.length; vals.forEach((v, i) => buf.set(u64le(v), 1 + i * 8)); return buf }
function c(...parts: Uint8Array[]) { return Buffer.concat(parts) }
const [mode, ...a] = process.argv.slice(2)
if (mode === "key") {
  const kp = ed25519.keygen()
  console.log("SEED_PK " + Buffer.from(kp.publicKey).toString("hex"))
  console.log("SEED_SK " + Buffer.from(kp.secretKey).toString("hex"))
} else if (mode === "pop") {
  const [sk, chain, pk, members, weights, threshold] = a
  const digest = sha256(c(enc.encode("SUI_ORG_POP_V1:"), enc.encode(chain), h(pk), vecAddr(members.split(",")), vecU64(weights.split(",").map(BigInt)), u64le(BigInt(threshold))))
  console.log("DIGEST " + Buffer.from(digest).toString("hex"))
  console.log("SIG " + Buffer.from(ed25519.sign(digest, h(sk)!)).toString("hex"))
} else if (mode === "rotatepop") {
  const [sk, chain, orgId, newEpoch, newPk] = a
  const digest = sha256(c(enc.encode("SUI_ORG_POP_V1:"), enc.encode(chain), h(orgId), u64le(BigInt(newEpoch)), h(newPk)))
  console.log("SIG " + Buffer.from(ed25519.sign(digest, h(sk)!)).toString("hex"))
} else if (mode === "rotate") {
  const [sk, chain, orgId, epoch, nonce, newPk, signers] = a
  const digest = sha256(c(enc.encode("SUI_ORG_KEY_ROTATION_V2:"), enc.encode(chain), h(orgId), u64le(BigInt(epoch)), u64le(BigInt(nonce)), h(newPk), vecAddr(signers.split(","))))
  console.log("SIG " + Buffer.from(ed25519.sign(digest, h(sk)!)).toString("hex"))
} else if (mode === "transfer") {
  const [sk, chain, orgId, epoch, nonce, proposalId, recipient, amount] = a
  const digest = sha256(c(enc.encode("SUI_ORG_TREASURY_TRANSFER_V1:"), enc.encode(chain), h(orgId), u64le(BigInt(epoch)), u64le(BigInt(nonce)), h(proposalId), h(recipient), u64le(BigInt(amount))))
  console.log("DIGEST " + Buffer.from(digest).toString("hex"))
  console.log("SIG " + Buffer.from(ed25519.sign(digest, h(sk)!)).toString("hex"))
} else { console.error("unknown mode"); process.exit(1) }
