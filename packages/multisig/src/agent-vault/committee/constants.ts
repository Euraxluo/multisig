/** dkg_committee 模块常量：与 `sources/dkg_committee.move` 逐项对应。 */

export const DKG_MODULE = 'dkg_committee';

/** 会话状态：1 承诺期、2 信箱期、3 已定稿、4 已超时（合约 STATUS_* 常量）。 */
export const DKG_SESSION_STATUS = {
  ROUND_1_COMMITMENTS: 1,
  ROUND_2_MAILBOX: 2,
  FINALIZED: 3,
  TIMED_OUT: 4,
} as const;

export type DkgSessionStatus = (typeof DKG_SESSION_STATUS)[keyof typeof DKG_SESSION_STATUS];

/** Feldman 承诺向量中每个 Ed25519 压缩点的字节数。 */
export const COMPRESSED_POINT_BYTES = 32;
