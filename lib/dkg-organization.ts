import { t } from "@/lib/i18n/t"
import { bcs } from "@mysten/sui/bcs"
import type { SuiClientTypes } from "@mysten/sui/client"
import { normalizeSuiAddress } from "@mysten/sui/utils"
import { fromBase64 } from "@mysten/sui/utils"
import { proposalClient, PROPOSAL_PACKAGE_ID } from "./proposal-chain"
import { findCreatedProtocolObject } from "./onchain-store"
import { readLiveOrganization } from "./group-roster"
import { DKG_STATUS, type SessionSnapshot } from "./dkg-session"

/** Checks actual transaction inputs, rather than inferring DKG origin from a matching key. */
export function verifyDkgCreationCall(transaction: SuiClientTypes.TransactionData, sessionId: string, threshold: bigint): void {
  if (transaction.commands.length !== 1) throw new Error(t("dkg.notSingleCall"))
  const command = transaction.commands[0]
  if (!("MoveCall" in command)) throw new Error(t("dkg.notMoveCall"))
  const call = command.MoveCall
  if (normalizeSuiAddress(call.package) !== normalizeSuiAddress(PROPOSAL_PACKAGE_ID)
    || call.module !== "cryptographic_org" || call.function !== "create_organization_from_session"
    || call.typeArguments.length !== 0 || call.arguments.length !== 2) throw new Error(t("dkg.protocolMismatch"))
  const [sessionArg, thresholdArg] = call.arguments
  if (!("Input" in sessionArg) || !("Input" in thresholdArg)) throw new Error(t("dkg.argsNotDirectInputs"))
  const session = transaction.inputs[sessionArg.Input]
  const weight = transaction.inputs[thresholdArg.Input]
  if (!session || !("Object" in session) || !("SharedObject" in session.Object)
    || normalizeSuiAddress(session.Object.SharedObject.objectId) !== normalizeSuiAddress(sessionId)) throw new Error(t("dkg.wrongSession"))
  if (!weight || !("Pure" in weight) || BigInt(bcs.u64().parse(fromBase64(weight.Pure.bytes))) !== threshold) throw new Error(t("dkg.orgThresholdMismatch"))
}

export async function readDkgOrganizationCreation(digest: string, session: SessionSnapshot) {
  if (!/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(digest)) throw new Error(t("dkg.invalidDigest"))
  if (session.status !== DKG_STATUS.FINALIZED) throw new Error(t("dkg.sessionNotFinalized"))
  const result = await proposalClient.getTransaction({ digest, include: { transaction: true, effects: true }, signal: AbortSignal.timeout(20_000) })
  if (result.$kind !== "Transaction" || !result.Transaction.status.success || !result.Transaction.effects?.status.success) throw new Error(t("dkg.txNotVerified"))
  const transaction = result.Transaction
  if (transaction.digest !== digest || !transaction.transaction) throw new Error(t("dkg.txIncomplete"))
  verifyDkgCreationCall(transaction.transaction, session.sessionId, session.threshold)
  const created = transaction.effects!.changedObjects.filter(object => object.idOperation === "Created").map(object => object.objectId)
  const orgId = await findCreatedProtocolObject(created, "cryptographic_org", "Organization")
  const live = await readLiveOrganization(proposalClient, orgId)
  if (live.groupPk.length !== session.finalPublicKey.length || live.groupPk.some((byte, index) => byte !== session.finalPublicKey[index])) throw new Error(t("dkg.orgGroupKeyMismatch"))
  if (live.epoch !== session.epoch) throw new Error(t("dkg.orgRotated"))
  return live
}
