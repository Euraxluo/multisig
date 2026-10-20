import { ed25519 } from '@noble/curves/ed25519.js';
import { sha512 } from '@noble/hashes/sha2.js';
import { mod, randomScalar, bytesToScalar, scalarToBytes32, lagrangeCoefficient } from './math';
import { Point } from './vss';

export interface NonceCommitment {
  participantId: string;
  participantIndex: bigint;
  noncePoint: Point;
  nonceBytes: Uint8Array;
}

export interface SignatureShare {
  participantId: string;
  participantIndex: bigint;
  shareZ: bigint;
}

export class ThresholdSignerNode {
  public readonly id: string;
  public readonly index: bigint;
  public readonly privateShare: bigint;

  private ephemeralNonce: bigint = 0n;
  private noncePoint: Point = ed25519.Point.ZERO;

  constructor(id: string, index: number | bigint, privateShare: bigint) {
    this.id = id;
    this.index = BigInt(index);
    this.privateShare = privateShare;
  }

  /**
   * 签名阶段 Round 1: 选取临时随机数 r_i 并广播承诺 R_i = r_i * G
   */
  public generateNonceCommitment(): NonceCommitment {
    this.ephemeralNonce = randomScalar();
    this.noncePoint = ed25519.Point.BASE.multiply(this.ephemeralNonce);

    return {
      participantId: this.id,
      participantIndex: this.index,
      noncePoint: this.noncePoint,
      nonceBytes: this.noncePoint.toBytes(),
    };
  }

  /**
   * 签名阶段 Round 2: 计算部分签名份额 z_i = r_i + c * λ_i * s_i (mod L)
   */
  public computeSignatureShare(
    message: Uint8Array,
    groupPublicKey: Uint8Array,
    allNonceCommitments: NonceCommitment[]
  ): SignatureShare {
    if (this.ephemeralNonce === 0n) {
      throw new Error(
        `[ThresholdSigner-${this.id}] No ephemeral nonce available or nonce already consumed (nonce reuse prohibited!)`
      );
    }

    // 1. 聚合随机承诺点 R = ∑ R_i
    let aggregateR = ed25519.Point.ZERO;
    for (const item of allNonceCommitments) {
      aggregateR = aggregateR.add(item.noncePoint);
    }
    const rBytes = aggregateR.toBytes();

    // 2. 按照 RFC 8032 Ed25519 标准计算挑战标量 c = SHA512(R || Y || message) mod L
    const hashInput = new Uint8Array(32 + 32 + message.length);
    hashInput.set(rBytes, 0);
    hashInput.set(groupPublicKey, 32);
    hashInput.set(message, 64);

    const challengeDigest = sha512(hashInput);
    const c = bytesToScalar(challengeDigest);

    // 3. 计算本参与者在当前门限子集中的拉格朗日系数 λ_i(0)
    const subsetX = allNonceCommitments.map((nc) => nc.participantIndex);
    const lambda = lagrangeCoefficient(this.index, subsetX, 0n);

    // 4. 计算部分签名 z_i 并销毁临时 nonce，防止重放与私钥泄露
    const zi = mod(this.ephemeralNonce + c * lambda * this.privateShare);
    this.ephemeralNonce = 0n;
    this.noncePoint = ed25519.Point.ZERO;

    return {
      participantId: this.id,
      participantIndex: this.index,
      shareZ: zi,
    };
  }

  /**
   * 签名聚合器: 收集所有部分签名，求和产出标准 64 字节 Ed25519 签名 (R || z)
   */
  public static aggregateSignature(
    allNonceCommitments: NonceCommitment[],
    allSignatureShares: SignatureShare[]
  ): Uint8Array {
    let aggregateR = ed25519.Point.ZERO;
    for (const item of allNonceCommitments) {
      aggregateR = aggregateR.add(item.noncePoint);
    }
    const rBytes = aggregateR.toBytes();

    let aggregateZ = 0n;
    for (const item of allSignatureShares) {
      aggregateZ = mod(aggregateZ + item.shareZ);
    }
    const zBytes = scalarToBytes32(aggregateZ);

    const finalSignature = new Uint8Array(64);
    finalSignature.set(rBytes, 0);
    finalSignature.set(zBytes, 32);

    return finalSignature;
  }

  /**
   * 原生 Ed25519 签名校验 (与 Sui 链上 sui::ed25519::ed25519_verify 行为 100% 一致)
   */
  public static verifyThresholdSignature(
    signature: Uint8Array,
    message: Uint8Array,
    groupPublicKey: Uint8Array
  ): boolean {
    return ed25519.verify(signature, message, groupPublicKey);
  }
}
