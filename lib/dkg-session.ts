// Read a `dkg_committee::DkgSession` from chain via official SDK reader slice.
//
// The ceremony dialog used to compute every participant's round-1 and round-2
// output locally, in one browser tab, and only then send `finalize_session`
// without ever submitting a commitment — which aborts with 3002 because the
// session is still in ROUND_1_COMMITMENTS. A real asynchronous DKG needs the
// other participants' *on-chain* commitments and sealed shares, so this module
// reads them back instead of assuming local state.
//
// Nothing here writes. A field that has not been submitted reads as absent, and
// absent is reported as absent rather than as an empty or zero value.

import { t } from "@/lib/i18n/t"
import { SuiGrpcClient } from "@mysten/sui/grpc"
import { normalizeSuiAddress, parseStructTag } from "@mysten/sui/utils"
import {
  COMPRESSED_POINT_BYTES,
  DKG_MODULE,
  DKG_SESSION_STATUS,
  DkgSessionBcs,
  type DkgReadClient,
  type DkgSessionSnapshot,
  decodeCommitments,
  encodeCommitments,
  readDkgAttestation,
  readDkgCommitment,
  readDkgConfirmation,
  readDkgMailboxShare,
  readDkgSession,
} from "multisig/agent-vault/committee"

export { COMPRESSED_POINT_BYTES, DKG_MODULE, decodeCommitments, encodeCommitments }

/** Mirrors the on-chain status constants. */
export const DKG_STATUS = DKG_SESSION_STATUS

export const DkgSessionContent = DkgSessionBcs

export type SessionSnapshot = DkgSessionSnapshot

export type SessionClient = DkgReadClient

/** Thrown when an object is not the session this module understands. */
export class SessionTypeError extends Error {}

export async function readSession(
  client: SessionClient,
  sessionId: string,
  packageId?: string,
): Promise<SessionSnapshot> {
  const id = normalizeSuiAddress(sessionId)
  try {
    if (!packageId) {
      const { object } = await client.getObject({ objectId: id, include: { content: true } })
      const parsed = parseStructTag(object.type)
      if (parsed.module !== DKG_MODULE || parsed.name !== "DkgSession") {
        throw new SessionTypeError(t("dkg.notDkgSession"))
      }
      packageId = parsed.address
    }
    return await readDkgSession(client, { sessionId: id, packageId })
  } catch (error) {
    if (error instanceof SessionTypeError) throw error
    throw new SessionTypeError(error instanceof Error ? error.message : String(error))
  }
}

/** A participant's round-1 commitment blob, or null when they have not submitted. */
export async function readCommitment(
  client: SessionClient,
  session: SessionSnapshot,
  participant: string,
): Promise<Uint8Array | null> {
  return readDkgCommitment(client, session, participant)
}

/** A participant's confirmation flag, or null when they have not confirmed. */
export async function readConfirmation(
  client: SessionClient,
  session: SessionSnapshot,
  participant: string,
): Promise<boolean | null> {
  return readDkgConfirmation(client, session, participant)
}

/**
 * The group key `participant` currently attests to, or null when it never did.
 *
 * Attestations live as dynamic fields on the session object (not in a Table),
 * because they were added by an upgrade and `DkgSession`'s published layout
 * cannot change. The field NAME type is pinned to the package that first
 * defined it — see `DKG_ATTESTATION_TYPE_ORIGIN`.
 */
export async function readGroupKeyAttestation(
  client: SessionClient,
  session: SessionSnapshot,
  keyTypeOrigin: string,
  participant: string,
): Promise<Uint8Array | null> {
  return readDkgAttestation(client, session, participant, keyTypeOrigin)
}

/**
 * The sealed share `sender` left for `recipient`, or null when none exists.
 *
 * The payload is whatever the sender wrote; this function does not parse or
 * interpret it. Callers must treat a non-null result as ciphertext and open it
 * with `openShare` — a plaintext share would only exist if some writer bypassed
 * the sealing path.
 */
export async function readMailboxShare(
  client: SessionClient,
  session: SessionSnapshot,
  keyTypeOrigin: string,
  sender: string,
  recipient: string,
): Promise<Uint8Array | null> {
  return readDkgMailboxShare(client, session, sender, recipient, keyTypeOrigin)
}

export const dkgSessionClient: SessionClient = new SuiGrpcClient({
  network: "testnet",
  baseUrl: "https://fullnode.testnet.sui.io:443",
}) as unknown as SessionClient
