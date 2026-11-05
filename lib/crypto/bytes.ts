// Byte helpers that work in both the browser and Node via official Sui SDK.
//
// `Buffer` is a Node global and Next.js does not polyfill it for the client
// bundle, so any crypto code reachable from a component must not use it.
import { t } from "@/lib/i18n/t"
import { fromHex, toHex } from "@mysten/sui/utils"

export function bytesToHex(bytes: Uint8Array): string {
  return toHex(bytes)
}

/** Rejects malformed input instead of silently producing a short buffer. */
export function hexToBytes(value: string): Uint8Array {
  if (value.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(value)) throw new Error(t("dkg.invalidHex"))
  return fromHex(value)
}

/** Constant-time is not required here: both operands are public key material. */
export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) return false
  return true
}
