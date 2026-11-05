import assert from "node:assert/strict"
import { test } from "node:test"
import { bytesEqual, bytesToHex, hexToBytes } from "./bytes"

// `Buffer` is Node-only and Next.js does not polyfill it for the client bundle.
// These helpers replace `Buffer.from(x).toString("hex")` and
// `Buffer.from(hex, "hex")` in crypto code that the DKG and resharing dialogs
// reach, so their behaviour is pinned here.

test("hex round-trips and pads single digits", () => {
  const bytes = Uint8Array.from([0x00, 0x0f, 0xa0, 0xff])
  assert.equal(bytesToHex(bytes), "000fa0ff")
  assert.deepEqual(hexToBytes("000fa0ff"), bytes)
})

test("hexToBytes accepts both cases and the empty string", () => {
  assert.deepEqual(hexToBytes("DEADbeef"), Uint8Array.from([0xde, 0xad, 0xbe, 0xef]))
  assert.deepEqual(hexToBytes(""), new Uint8Array())
})

test("hexToBytes rejects odd length and non-hex input instead of truncating", () => {
  for (const value of ["abc", "zz", "0x12", "12 34"]) assert.throws(() => hexToBytes(value), /十六进制字符串无效/)
})

test("bytesEqual compares content, not identity", () => {
  assert.equal(bytesEqual(Uint8Array.from([1, 2, 3]), Uint8Array.from([1, 2, 3])), true)
  assert.equal(bytesEqual(Uint8Array.from([1, 2, 3]), Uint8Array.from([1, 2, 4])), false)
  assert.equal(bytesEqual(Uint8Array.from([1, 2]), Uint8Array.from([1, 2, 3])), false)
  assert.equal(bytesEqual(new Uint8Array(), new Uint8Array()), true)
})

test("bytesEqual does not throw on differing lengths the way Buffer.equals would", () => {
  // Buffer.equals throws on length mismatch; a key comparison must return false.
  assert.doesNotThrow(() => bytesEqual(new Uint8Array(32), new Uint8Array(31)))
})
