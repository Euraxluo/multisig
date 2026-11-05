import { ed25519 } from '@noble/curves/ed25519.js';

/**
 * Ed25519 标量有限域模数 (Curve Order L)
 * L = 2^252 + 27742317777372353535851937790883648493
 */
export const CURVE_ORDER: bigint = ed25519.Point.Fn.ORDER;

/**
 * 标量正模运算
 */
export function mod(a: bigint, m: bigint = CURVE_ORDER): bigint {
  const result = a % m;
  return result >= 0n ? result : result + m;
}

/**
 * 扩展欧几里得算法求有限域乘法逆元 (a^-1 mod L)
 */
export function modInverse(a: bigint, m: bigint = CURVE_ORDER): bigint {
  let [old_r, r] = [mod(a, m), m];
  let [old_s, s] = [1n, 0n];

  while (r !== 0n) {
    const quotient = old_r / r;
    [old_r, r] = [r, old_r - quotient * r];
    [old_s, s] = [s, old_s - quotient * s];
  }

  if (old_r !== 1n) {
    throw new Error('Modular inverse does not exist (not coprime)');
  }

  return mod(old_s, m);
}

/**
 * 生成安全的密码学伪随机非零有限域标量 (1 <= s < L)
 */
export function randomScalar(): bigint {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let val = bytesToScalar(bytes);
  if (val === 0n) val = 1n;
  return val;
}

/**
 * 字节数组转小端序标量
 */
export function bytesToScalar(bytes: Uint8Array): bigint {
  let val = 0n;
  for (let i = 0; i < bytes.length; i++) {
    val += BigInt(bytes[i]) << (BigInt(i) * 8n);
  }
  return mod(val);
}

/**
 * 标量转换为 32 字节小端序格式 (符合 RFC 8032 Ed25519 规范)
 */
export function scalarToBytes32(s: bigint): Uint8Array {
  const buf = new Uint8Array(32);
  let cur = mod(s);
  for (let i = 0; i < 32; i++) {
    buf[i] = Number(cur & 0xffn);
    cur >>= 8n;
  }
  return buf;
}

/**
 * 计算拉格朗日基函数插值系数 λ_i(targetX) (mod L)
 * λ_i(targetX) = ∏_{j ≠ i} (targetX - x_j) / (x_i - x_j)
 */
export function lagrangeCoefficient(
  xi: bigint,
  allX: bigint[],
  targetX: bigint = 0n
): bigint {
  let numerator = 1n;
  let denominator = 1n;

  for (const xj of allX) {
    if (xj === xi) continue;
    numerator = mod(numerator * (targetX - xj));
    denominator = mod(denominator * (xi - xj));
  }

  return mod(numerator * modInverse(denominator));
}
