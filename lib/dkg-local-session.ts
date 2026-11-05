import { t } from "@/lib/i18n/t"
import { normalizeSuiAddress } from "@mysten/sui/utils"
import { DKG_STATUS, decodeCommitments, readCommitment, type SessionClient, type SessionSnapshot } from "./dkg-session"

/** Round 2 freezes Q on chain; participants without a commitment are holders, not missing dealers. */
export async function readQualifiedDealers(client: SessionClient, session: SessionSnapshot) {
  if (session.status !== DKG_STATUS.ROUND_2_MAILBOX && session.status !== DKG_STATUS.FINALIZED) throw new Error(t("dkg.dealersNotFrozen"))
  if (session.participants.length > 128 || new Set(session.participants).size !== session.participants.length) throw new Error(t("dkg.participantsInvalid"))
  const dealers: Array<{ address: string; commitments: Uint8Array[] }> = []
  for (const address of session.participants) {
    const raw = await readCommitment(client, session, address)
    if (!raw) continue
    const commitments = decodeCommitments(raw)
    if (BigInt(commitments.length) !== session.threshold) throw new Error(t("dkg.commitmentsLengthMismatch"))
    dealers.push({ address, commitments })
  }
  if (BigInt(dealers.length) < session.threshold) throw new Error(t("dkg.frozenDealersBelowThreshold"))
  return dealers
}

const prefix = "sui_dkg_session_v1:"
const storageKey = (groupId: string, holder: string) => `${prefix}${encodeURIComponent(groupId)}:${normalizeSuiAddress(holder)}`

export function saveDkgSessionLink(groupId: string, holder: string, sessionId: string): void {
  localStorage.setItem(storageKey(groupId, holder), normalizeSuiAddress(sessionId))
}

export function readDkgSessionLink(groupId: string, holder: string): string | null {
  const raw = localStorage.getItem(storageKey(groupId, holder))
  if (raw === null) return null
  if (!/^0x[\da-f]{64}$/.test(raw)) throw new Error(t("dkg.corruptSessionIndex"))
  return raw
}
