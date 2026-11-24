/**
 * 设备密钥包校验的前端入口：实现位于 `multisig/bridge`（单一事实源）。
 */
export {
  assembleDeviceKey,
  DEVICE_KEY_NETWORK,
  deviceKeyAddress,
  parsePublicKeyPackage,
  publicKeyPackageId,
  serializePublicKeyPackage,
  toNobleFrostPublic,
  toPublicKeyPackage,
  validateDealerContribution,
  validateDeviceKeyPackage,
  validateKeyEpoch,
  validatePublicKeyPackage,
} from "multisig/bridge"
export type { BoundDeviceKey, DealerContribution, DeviceKeyPackage, PublicKeyPackage } from "multisig/bridge"
