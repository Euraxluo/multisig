/**
 * 密码学实现归一（2026-11-14 重构）：Gennaro resharing 的唯一实现在 SDK。
 * 此文件仅为兼容既有导入路径的 re-export shim。
 */
export {
  GennaroResharingParticipant,
  DealerHonestyError,
  verifyDealerHonestyProof,
  computeDealerChallenge,
} from "multisig/dkg";
export type { DealerHonestyProof, DealerHonestyContext } from "multisig/dkg";
