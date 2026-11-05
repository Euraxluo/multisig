"use client"

// Stable device-key import surface for the DKG dialog and FROST signer.
// The legacy committee-share-store remains the implementation and compatibility
// boundary; this module only gives new callers a focused name.
export {
  advanceDeviceKeyEpoch,
  bindDeviceKey,
  readDealerContribution,
  readDeviceKey,
  readPendingDeviceKey,
  saveDealerContribution,
  savePendingDeviceKey,
} from "./committee-share-store"
export type {
  BoundDeviceKey,
  DealerContribution,
  DeviceKeyPackage,
} from "./dkg-key-package"
