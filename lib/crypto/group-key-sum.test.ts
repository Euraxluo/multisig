import assert from "node:assert/strict"
import { test } from "node:test"
import { ed25519 } from "@noble/curves/ed25519.js"
import { evaluatePolynomial, generatePolynomial } from "./vss"
import { mod } from "./math"

// Regression pin for a real defect found while running the testnet end-to-end.
//
// The DKG script summed the dealers' C_0 commitments with
//
//     commitments.map(bytes => bytes.subarray(0, 32))
//       .reduce((sum, point) => sum.add(...), ed25519.Point.fromBytes(commitments[0]...))
//
// `reduce` without an explicit seed takes the first element as the accumulator
// and then visits it again, so dealer 0's constant term was added twice. The
// on-chain organization was finalized onto that key: a key nobody dealt, whose
// discrete log was trivially recoverable from the test fixture. These tests pin
// the correct sum and the correct reconstruction of participant shares so the
// same shape cannot come back unnoticed.

/** The group public key for a set of dealer polynomials: Σ_i a_{i,0}·G. */
function groupKey(polynomials: bigint[][]): Uint8Array {
  return polynomials
    .reduce(
      (sum, poly) => sum.add(ed25519.Point.BASE.multiply(mod(poly[0]!))),
      ed25519.Point.ZERO,
    )
    .toBytes()
}

/** Participant `j` (1-indexed evaluation point) holds Σ_i f_i(j). */
function shareOf(polynomials: bigint[][], j: bigint): bigint {
  return polynomials.reduce((sum, poly) => mod(sum + evaluatePolynomial(poly, j)), 0n)
}

test("the group key is the sum of dealer constant terms, each counted once", () => {
  const dealers = [1000n, 1001n, 1002n].map(secret => generatePolynomial(1, secret))
  const expected = ed25519.Point.BASE.multiply(mod(1000n + 1001n + 1002n)).toBytes()
  assert.deepEqual(groupKey(dealers), expected)
})

test("seeding the sum with the first element instead of the identity gives a different key", () => {
  // This is the exact bug: treating element 0 as the seed adds it twice.
  const dealers = [1000n, 1001n].map(secret => generatePolynomial(1, secret))
  const points = dealers.map(poly => ed25519.Point.BASE.multiply(mod(poly[0]!)))

  const correct = points.reduce((sum, point) => sum.add(point), ed25519.Point.ZERO).toBytes()
  const doubleCounted = points
    .reduce((sum, point) => sum.add(point), points[0]!)
    .toBytes()

  assert.notDeepEqual(correct, doubleCounted)
  // And the wrong one is not a key any honest participant would ever recompute.
  assert.notDeepEqual(doubleCounted, ed25519.Point.BASE.multiply(mod(1000n + 1001n)).toBytes())
})

test("any threshold subset of participant shares interpolates back to the group key", () => {
  const dealers = [5n, 9n, 17n].map(secret => generatePolynomial(1, secret))
  const key = groupKey(dealers)

  // 2-of-3: evaluation points 1, 2, 3. Each pair must reconstruct the key.
  const points: bigint[] = [1n, 2n, 3n]
  const shares = points.map(j => shareOf(dealers, j))

  const pairs: Array<[number, number]> = [[0, 1], [0, 2], [1, 2]]
  for (const [a, b] of pairs) {
    const xa = points[a]!
    const xb = points[b]!
    const ya = shares[a]!
    const yb = shares[b]!
    // Lagrange at 0 for two points: (x_b·y_a − x_a·y_b) / (x_b − x_a).
    const denominator = mod(xb - xa)
    const secret = mod((xb * ya - xa * yb) * modInverse(denominator))
    assert.deepEqual(
      ed25519.Point.BASE.multiply(secret).toBytes(),
      key,
      `subset ${a},${b} did not reconstruct the group key`,
    )
  }
})

test("a share for the wrong evaluation point does not reconstruct the key", () => {
  const dealers = [3n, 4n].map(secret => generatePolynomial(1, secret))
  const key = groupKey(dealers)
  // Participant 1's share evaluated at the wrong point.
  const wrong = shareOf(dealers, 5n)
  assert.notDeepEqual(ed25519.Point.BASE.multiply(mod(wrong)).toBytes(), key)
})

// Local helper: modular inverse mod the curve order, kept here so the test does
// not depend on the production signer for its own arithmetic.
const CURVE_ORDER = ed25519.Point.CURVE().n
function modInverse(value: bigint): bigint {
  let [oldR, r] = [mod(value), CURVE_ORDER]
  let [oldS, s] = [1n, 0n]
  while (r !== 0n) {
    const quotient = oldR / r
    ;[oldR, r] = [r, oldR - quotient * r]
    ;[oldS, s] = [s, oldS - quotient * s]
  }
  return mod(oldS)
}
