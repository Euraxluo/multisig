"use client"

import type { Signer } from "@mysten/sui/cryptography"
import { fromBase64, isValidSuiAddress, normalizeSuiAddress } from "@mysten/sui/utils"
import { verifyPersonalMessageSignature } from "@mysten/sui/verify"
import { proposalClient } from "./proposal-chain"
import { assertTransactionAccount, getTransactionAccount } from "./sui-wallet-signer"
import { t } from "./i18n/t"

type ProtocolSigner = Pick<Signer, "toSuiAddress" | "signPersonalMessage">
type ProtocolAccount = ReturnType<typeof getTransactionAccount>
export interface ProtocolMessageSigningDependencies {
  getSigner?: () => Promise<ProtocolSigner>
  getAccount?: () => ProtocolAccount
  assertAccount?: (expected: ProtocolAccount) => void
  verifySignature?: typeof verifyPersonalMessageSignature
  client?: NonNullable<Parameters<typeof verifyPersonalMessageSignature>[2]>["client"]
}
export interface SignedProtocolMessage { address: string; signature: string }

function address(value: string): string {
  if (!isValidSuiAddress(value)) throw new Error(t("misc.personal.addressInvalid"))
  return normalizeSuiAddress(value)
}

/** Defaults always use the real wallet signer and SDK verifier; tests can replace I/O boundaries. */
export function createProtocolMessageSigner(dependencies: ProtocolMessageSigningDependencies = {}) {
  const getAccount = dependencies.getAccount ?? getTransactionAccount
  const assertAccount = dependencies.assertAccount ?? assertTransactionAccount
  const verifySignature = dependencies.verifySignature ?? verifyPersonalMessageSignature
  const client = dependencies.client ?? proposalClient
  const getSigner = dependencies.getSigner ?? (async () => (await import("./sui-stack-messaging")).getSsmSigner())

  async function verifyProtocolMessage(bytes: Uint8Array, signature: string, expectedAddress: string): Promise<void> {
    if (!(bytes instanceof Uint8Array) || typeof signature !== "string" || !signature) throw new Error(t("misc.personal.invalidPayload"))
    await verifySignature(new Uint8Array(bytes), signature, { address: address(expectedAddress), client })
  }

  async function signProtocolMessage(bytes: Uint8Array): Promise<SignedProtocolMessage> {
    if (!(bytes instanceof Uint8Array)) throw new Error(t("misc.personal.notBytes"))
    const message = new Uint8Array(bytes)
    // Copy the snapshot so a wallet/provider switch cannot mutate our expected account.
    const expected = { ...getAccount() }
    const expectedAddress = address(expected.address)
    assertAccount(expected)
    const signer = await getSigner()
    assertAccount(expected)
    if (address(signer.toSuiAddress()) !== expectedAddress) throw new Error(t("misc.personal.signerMismatch"))
    const signed = await signer.signPersonalMessage(new Uint8Array(message))
    assertAccount(expected)
    if (typeof signed?.bytes !== "string" || typeof signed?.signature !== "string" || !signed.signature) throw new Error(t("misc.personal.noSignature"))
    const echoed = Uint8Array.from(fromBase64(signed.bytes))
    if (echoed.length !== message.length || echoed.some((value: number, index: number) => value !== message[index])) throw new Error(t("misc.personal.messageAltered"))
    await verifyProtocolMessage(message, signed.signature, expectedAddress)
    assertAccount(expected)
    return { address: expectedAddress, signature: signed.signature }
  }

  return { signProtocolMessage, verifyProtocolMessage }
}

export const { signProtocolMessage, verifyProtocolMessage } = createProtocolMessageSigner()
