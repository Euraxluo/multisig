import { ThresholdSignerNode } from "../packages/multisig/src/dkg/threshold_signer"
import { generatePolynomial, evaluatePolynomial } from "../packages/multisig/src/dkg/vss"
import { ed25519 } from "@noble/curves/ed25519.js"
import { sha256 } from "@noble/hashes/sha2.js"
const { poly } = { poly: generatePolynomial(1) } // 2-of-3 threshold
const groupPk = ed25519.Point.BASE.multiply(poly[0]).toBytes()
const nodes = [1n, 2n, 3n].map((idx, i) => new ThresholdSignerNode(`m${i}`, idx, evaluatePolynomial(poly, idx)))
const msg = sha256(new TextEncoder().encode("SUI_ORG_TREASURY_TRANSFER_V1: live gate"))
const comms = [nodes[0], nodes[1]].map(n => n.generateNonceCommitment())
const shares = [nodes[0], nodes[1]].map(n => n.computeSignatureShare(msg, groupPk, comms))
const sig = ThresholdSignerNode.aggregateSignature(msg, groupPk, comms, shares)
console.log("aggregated sig verifies:", ed25519.verify(sig, msg, groupPk))
