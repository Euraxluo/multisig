import { ed25519 } from '@noble/curves/ed25519.js';
import { mod, randomScalar } from './math';

export type Point = typeof ed25519.Point.BASE;

/**
 * 生成 t-1 阶秘密多项式:
 * f(x) = a_0 + a_1*x + a_2*x^2 + ... + a_{t-1}*x^{t-1} (mod L)
 * 其中 a_0 可以指定或随机生成
 */
export function generatePolynomial(degree: number, secret?: bigint): bigint[] {
  const poly: bigint[] = [];
  poly.push(secret !== undefined ? mod(secret) : randomScalar());

  for (let i = 1; i <= degree; i++) {
    poly.push(randomScalar());
  }

  return poly;
}

/**
 * 计算多项式在点 x 处的取值 f(x) (mod L)
 */
export function evaluatePolynomial(poly: bigint[], x: bigint): bigint {
  let result = 0n;
  let xPow = 1n;

  for (const coeff of poly) {
    result = mod(result + coeff * xPow);
    xPow = mod(xPow * x);
  }

  return result;
}

/**
 * 计算多项式系数对应的 Pedersen / Feldman 椭圆曲线承诺点:
 * C_k = a_k * G (k = 0 .. t-1)
 * 当 a_k == 0 时，对应群的恒等元 ZERO
 */
export function createCommitments(poly: bigint[]): Point[] {
  return poly.map((coeff) => {
    const c = mod(coeff);
    if (c === 0n) {
      return ed25519.Point.ZERO;
    }
    return ed25519.Point.BASE.multiply(c);
  });
}

/**
 * 校验接收到的秘密分片 s_{i -> j} 是否与发送方公开承诺 C_{i,k} 严格同态匹配:
 * s * G == ∑ (x^k * C_k)
 */
export function verifyShareCommitment(
  share: bigint,
  x: bigint,
  commitments: Point[]
): boolean {
  const s = mod(share);
  // 左侧: s * G
  const leftPoint = s === 0n ? ed25519.Point.ZERO : ed25519.Point.BASE.multiply(s);

  // 右侧: ∑ (x^k * C_k)
  let rightPoint = ed25519.Point.ZERO;
  let xPow = 1n;

  for (const c of commitments) {
    if (!c.equals(ed25519.Point.ZERO)) {
      const p = mod(xPow);
      if (p !== 0n) {
        const term = c.multiply(p);
        rightPoint = rightPoint.add(term);
      }
    }
    xPow = mod(xPow * x);
  }

  return leftPoint.equals(rightPoint);
}
