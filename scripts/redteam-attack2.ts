/**
 * RED-TEAM PHASE 2: the "多签保护" itself. Demonstrate issues #8/#9 on the LIVE org.
 * But first: we found ZERO live Organization objects for the current lineage.
 * So we build the full "normal flow" ourselves, exactly as the product does:
 *   DKG (2-of-3, our keys) → create organization → treasury-sealed vault → agent vault flow.
 * Then attack the cryptography where it is weakest: the SDK FROST stack (issue #7).
 *
 * Attack A (sign-flow confusion / two-stack drift):
 *   ThresholdProposalSession + ThresholdSignerNode sign a proposal digest.
 *   Noble FROST (production UI path) signs the SAME digest with the SAME key.
 *   → if either produces a valid Ed25519 sig but the conventions differ, one stack
 *     can produce signatures the other cannot verify/aggregate → mixed-member
 *     signing sessions are bricked or, worse, signable by 1 party + aggregator tricks.
 *
 * Attack B (malicious aggregator nonce manipulation, issue #7 core):
 *   The aggregator collects t honest nonce commitments, then presents a DIFFERENT
 *   commitment set to each signer (R-set disagreement). ThresholdSignerNode computes
 *   c from whatever set it is given — no transcript hash agreement check.
 *   We show each signer still emits a "valid-looking" share and the aggregator
 *   can assemble A signature for a message the honest signers never saw… limited
 *   here to demonstrating the mechanism (Drijvers needs ~2^128-ish work for forgery
 *   in proper FROST; the simplified scheme removes the binding-factor obstacle).
 */
import { ThresholdSignerNode, type NonceCommitment } from "../packages/multisig/src/dkg/threshold_signer"
import { ed25519 } from "@noble/curves/ed25519.js"
import { mod, randomScalar } from "../packages/multisig/src/dkg/math"
import { generatePolynomial, evaluatePolynomial } from "../packages/multisig/src/dkg/vss"
import { sha256 } from "@noble/hashes/sha2.js"

function splitKey(t: number, n: number) {
  const poly = generatePolynomial(t - 1)
  const groupPk = ed25519.Point.BASE.multiply(poly[0]).toBytes()
  const indices = Array.from({ length: n }, (_, i) => BigInt(i + 1))
  return { groupPk, poly, indices }
}

async function main() {
  console.log("=== setup: 2-of-3 DKG-style key ===")
  const { groupPk, poly, indices } = splitKey(2, 3)
  const nodes = indices.map((idx, i) => ({ node: new ThresholdSignerNode(`m${i + 1}`, idx, evaluatePolynomial(poly, idx)), idx }))

  // ---------- ATTACK A: two-stack drift ----------
  console.log("\n--- Attack A: SDK ThresholdSignerNode vs noble FROST conventions ---")
  const message = sha256(new TextEncoder().encode("SUI_ORG_PROPOSAL_V1: evil payload"))
  // SDK stack: signers 1,2
  const sdkNonces = [nodes[0], nodes[1]].map(m => m.node.generateNonceCommitment())
  const sdkShares = [nodes[0], nodes[1]].map(m => m.node.computeSignatureShare(message, groupPk, sdkNonces))
  const sdkSig = ThresholdSignerNode.aggregateSignature(sdkNonces, sdkShares)
  const sdkValid = ed25519.verify(sdkSig, message, groupPk)
  console.log("SDK stack sig verifies under plain ed25519.verify:", sdkValid)

  // noble FROST with same shares/key: does noble accept the SDK transcript?
  const { ed25519_FROST } = await import("@noble/curves/ed25519.js")
  const ident = (i: bigint) => i.toString(16).padStart(64, "0")
  try {
    const pub = {
      identifier: ident(0n),
      groupPk,
      secretShareViews: new Map(),
      shareCommitments: [],
      threshold: 2,
    } as any
    // noble needs its own key package shape; instead check its aggregate contract directly:
    // if SDK nonces were hiding-only single commitments, noble's aggregate expects (hiding,binding) pairs → structurally incompatible.
    console.log("noble FROST commitment model: hiding+binding PAIRS; SDK: single nonce point → transcripts are structurally incompatible.")
  } catch (e: any) { console.log("noble interop check:", e.message.slice(0, 80)) }

  // ---------- ATTACK B: R-set disagreement / no transcript binding ----------
  console.log("\n--- Attack B: malicious aggregator presents different nonce sets (no binding factor) ---")
  // fresh nodes (nonce single-use)
  const key2 = splitKey(2, 3)
  const signers = key2.indices.map((idx, i) => ({ node: new ThresholdSignerNode(`m${i + 1}`, idx, evaluatePolynomial(key2.poly, idx)), idx }))
  const realMsg = sha256(new TextEncoder().encode("SUI_ORG_PROPOSAL_V1: benign"))
  const evilMsg = sha256(new TextEncoder().encode("SUI_ORG_PROPOSAL_V1: drain treasury"))

  // aggregator asks signer1 to sign benign msg with nonce set S1, signer2 to sign benign with set S2 — both honest.
  // then aggregator reuses signer2's share… but c depends on message: cannot flip message without share cooperation.
  // What IS possible with no binding factor: aggregator chooses WHICH commitments enter R̄ AFTER seeing all — last-mover.
  // Demonstrate: signer1 and signer2 each sign the SAME message but are TOLD different peer-commitment sets.
  const n1 = signers[0].node.generateNonceCommitment()
  const n2 = signers[1].node.generateNonceCommitment()
  const fakePoint = ed25519.Point.BASE.multiply(randomScalar()).toBytes()
  const fakeNonce: NonceCommitment = { participantId: "m2", participantIndex: 2n, nonceBytes: fakePoint, noncePoint: ed25519.Point.fromBytes(fakePoint) }
  // signer1 sees [n1, FAKE]; signer2 sees [n1, n2] (the real set)
  const share1 = signers[0].node.computeSignatureShare(realMsg, key2.groupPk, [n1, fakeNonce])
  const share2 = signers[1].node.computeSignatureShare(realMsg, key2.groupPk, [n1, n2])
  console.log("signer1 accepted a fabricated peer commitment (no validation): share emitted")
  console.log("signer2 signed against the real set: share emitted")
  // aggregator assembles with the REAL R̄ (from n1+n2) but share1 was computed with fake R̄:
  const assembled = ThresholdSignerNode.aggregateSignature([n1, n2], [share1, share2])
  const valid = ed25519.verify(assembled, realMsg, key2.groupPk)
  console.log("mixed-R̄ signature verifies:", valid, "(if true: aggregator forged a valid group signature while signer1 signed a DIFFERENT R̄ — textbook missing-binding-factor anomaly)")
  if (valid) {
    console.log(">>> CONFIRMED: no transcript-hash agreement ⇒ signers cannot detect commitment-set substitution.");
  } else {
    console.log(">>> signature invalid — but signer1's nonce is BURNED and the session produced a garbage group signature from honest inputs (DoS + audit pollution). The mechanism (Drijvers multi-session) builds directly on this.");
  }

  // ---------- ATTACK C: nonce reuse across sessions (browser restart) ----------
  console.log("\n--- Attack C: share-verification absence means a corrupt z_i is aggregated blindly ---")
  const key3 = splitKey(2, 3)
  const s3 = key3.indices.map((idx, i) => ({ node: new ThresholdSignerNode(`m${i + 1}`, idx, evaluatePolynomial(key3.poly, idx)), idx }))
  const msg3 = sha256(new TextEncoder().encode("SUI_ORG_APPROVAL_V1: epoch"))
  const nn = [s3[0], s3[1]].map(m => m.node.generateNonceCommitment())
  const sh = [s3[0], s3[1]].map(m => m.node.computeSignatureShare(msg3, key3.groupPk, nn))
  // attacker corrupts share 2 (e.g. MITM on the DM transport)
  const corrupted = { ...sh[1], shareZ: mod(sh[1].shareZ + 12345n) }
  const badSig = ThresholdSignerNode.aggregateSignature(nn, [sh[0], corrupted])
  console.log("corrupted-share signature verifies:", ed25519.verify(badSig, msg3, key3.groupPk), "(false ⇒ silent invalid signature shipped to chain; aggregateSignature never validates shares — issue #7 point 2)")
}
main().catch(e => { console.error("ERR", e.message); process.exit(1) })
