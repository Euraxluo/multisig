import assert from "node:assert/strict"
import { test } from "node:test"
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { Secp256k1Keypair } from "@mysten/sui/keypairs/secp256k1"
import { Secp256r1Keypair } from "@mysten/sui/keypairs/secp256r1"
import { toBase64 } from "@mysten/sui/utils"
import { verifyPersonalMessageSignature } from "@mysten/sui/verify"
import { proposalClient } from "./proposal-chain"
import { createProtocolMessageSigner, type ProtocolMessageSigningDependencies } from "./wallet-personal-signing"

const message = () => new TextEncoder().encode("SUI_FROST_PROTOCOL_V1:离线协议消息")
function setup(extra: ProtocolMessageSigningDependencies = {}) {
  const keypair = Ed25519Keypair.generate()
  let active = { address: keypair.toSuiAddress(), type: "wallet", provider: "first-wallet" }
  const signer = createProtocolMessageSigner({
    getAccount: () => active,
    assertAccount(expected) { assert.deepEqual(active, expected, "account/provider changed") },
    getSigner: async () => keypair,
    ...extra,
  })
  return { keypair, signer, switchProvider() { active = { ...active, provider: "other-wallet" } }, switchAddress() { active = { ...active, address: Ed25519Keypair.generate().toSuiAddress() } } }
}

test("signs and verifies real personal signatures offline across supported key schemes", async () => {
  for (const keypair of [Ed25519Keypair.generate(), Secp256k1Keypair.generate(), Secp256r1Keypair.generate()]) {
    const account = { address: keypair.toSuiAddress(), type: "keystore" }
    const signer = createProtocolMessageSigner({ getSigner: async () => keypair, getAccount: () => account, assertAccount: expected => assert.deepEqual(expected, account) })
    const signed = await signer.signProtocolMessage(message())
    assert.equal(signed.address, keypair.toSuiAddress())
    await verifyPersonalMessageSignature(message(), signed.signature, { address: signed.address })
    await signer.verifyProtocolMessage(message(), signed.signature, signed.address)
    await assert.rejects(signer.verifyProtocolMessage(new Uint8Array([1]), signed.signature, signed.address))
    await assert.rejects(signer.verifyProtocolMessage(message(), signed.signature, Ed25519Keypair.generate().toSuiAddress()))
  }
})

test("forwards proposalClient into the SDK verifier for zkLogin-compatible verification", async () => {
  let calls = 0
  const { signer } = setup({ verifySignature: async (bytes, signature, options) => {
    calls++
    assert.equal(options?.client, proposalClient)
    return verifyPersonalMessageSignature(bytes, signature, options)
  } })
  const signed = await signer.signProtocolMessage(message())
  await signer.verifyProtocolMessage(message(), signed.signature, signed.address)
  assert.equal(calls, 2)
})

test("rejects account or provider changes while discovering the signer", async () => {
  for (const change of ["switchProvider", "switchAddress"] as const) {
    let signCalls = 0
    const fixture = setup({ getSigner: async () => {
      fixture[change]()
      return { toSuiAddress: () => fixture.keypair.toSuiAddress(), signPersonalMessage: async bytes => { signCalls++; return fixture.keypair.signPersonalMessage(bytes) } }
    } })
    await assert.rejects(fixture.signer.signProtocolMessage(message()), /account\/provider changed/)
    assert.equal(signCalls, 0)
  }
})

test("rejects a signer belonging to another address before requesting a signature", async () => {
  let signCalls = 0
  const fixture = setup({ getSigner: async () => ({ toSuiAddress: () => Ed25519Keypair.generate().toSuiAddress(), signPersonalMessage: async bytes => { signCalls++; return fixture.keypair.signPersonalMessage(bytes) } }) })
  await assert.rejects(fixture.signer.signProtocolMessage(message()), /签名者与当前账户/)
  assert.equal(signCalls, 0)
})

test("rejects a provider switch during the wallet signature and during verification", async () => {
  const duringSign = setup({ getSigner: async () => ({ toSuiAddress: () => duringSign.keypair.toSuiAddress(), signPersonalMessage: async bytes => {
    const signed = await duringSign.keypair.signPersonalMessage(bytes)
    duringSign.switchProvider()
    return signed
  } }) })
  await assert.rejects(duringSign.signer.signProtocolMessage(message()), /account\/provider changed/)
  const duringVerify = setup({ verifySignature: async (bytes, signature, options) => {
    const key = await verifyPersonalMessageSignature(bytes, signature, options)
    duringVerify.switchAddress()
    return key
  } })
  await assert.rejects(duringVerify.signer.signProtocolMessage(message()), /account\/provider changed/)
})

test("rejects mutated echoed bytes and signatures for a different message", async () => {
  const echo = setup({ getSigner: async () => ({ toSuiAddress: () => echo.keypair.toSuiAddress(), signPersonalMessage: async bytes => ({ ...await echo.keypair.signPersonalMessage(bytes), bytes: toBase64(new Uint8Array([9])) }) }) })
  await assert.rejects(echo.signer.signProtocolMessage(message()), /改动了待签协议消息/)
  const wrong = setup({ getSigner: async () => ({ toSuiAddress: () => wrong.keypair.toSuiAddress(), signPersonalMessage: async bytes => ({ ...await wrong.keypair.signPersonalMessage(new Uint8Array([9])), bytes: toBase64(bytes) }) }) })
  await assert.rejects(wrong.signer.signProtocolMessage(message()), /not valid/)
})

test("snapshots caller bytes before awaiting wallet discovery", async () => {
  const bytes = message(), original = new Uint8Array(bytes)
  const fixture = setup({ getSigner: async () => { bytes.fill(0); return fixture.keypair } })
  const signed = await fixture.signer.signProtocolMessage(bytes)
  await verifyPersonalMessageSignature(original, signed.signature, { address: signed.address })
  await assert.rejects(verifyPersonalMessageSignature(bytes, signed.signature, { address: signed.address }))
})

test("fails closed for malformed signatures and addresses", async () => {
  const { signer } = setup()
  await assert.rejects(signer.verifyProtocolMessage(message(), "", Ed25519Keypair.generate().toSuiAddress()), /签名无效/)
  await assert.rejects(signer.verifyProtocolMessage(message(), "invalid", ""), /地址无效/)
  await assert.rejects(signer.verifyProtocolMessage(message(), "invalid", Ed25519Keypair.generate().toSuiAddress()))
})
