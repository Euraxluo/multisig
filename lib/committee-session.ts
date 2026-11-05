"use client"

import { t } from "@/lib/i18n/t"

// In-memory custody of FROST committee shares for this browser session only.
//
// The DKG dialog simulates every participant inside one page, so the shares it
// produces all live in this tab's memory. They are deliberately never written to
// localStorage, IndexedDB, logs or transaction metadata: a reload loses them, and
// every consumer must then report that threshold signing is unavailable instead
// of falling back to placeholder shares. In a real deployment each member holds
// only their own share and signature shares are exchanged between members.
export interface CommitteeSession {
  orgId: string
  /** Group public key these shares reconstruct; must equal the on-chain `group_pk`. */
  groupPk: Uint8Array
  /** Organization epoch the shares belong to; signing is refused after a mismatch. */
  epoch: bigint
  /** Number of shares required to reconstruct the group key. */
  threshold: bigint
  /** Holder indices, aligned with `shares`. */
  indices: bigint[]
  shares: bigint[]
}

const sessions = new Map<string, CommitteeSession>()

const key = (orgId: string) => orgId.toLowerCase()

export function setCommitteeSession(session: CommitteeSession): void {
  if (session.shares.length !== session.indices.length || session.shares.length === 0) {
    throw new Error(t("dkg.sharesIndexMismatch"))
  }
  if (session.threshold <= 0n || BigInt(session.shares.length) < session.threshold) {
    throw new Error(t("dkg.sharesBelowThreshold"))
  }
  sessions.set(key(session.orgId), session)
}

export function clearCommitteeSession(orgId: string): void {
  sessions.delete(key(orgId))
}

export function getCommitteeSession(orgId: string): CommitteeSession | null {
  return sessions.get(key(orgId)) ?? null
}

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((value, index) => value === b[index])

/**
 * Record a key-preserving epoch transition (roster update or resharing) for the
 * shares this tab holds. Refused when the live group key differs, because those
 * shares cannot sign for it and pretending otherwise would only fail on chain.
 */
export function adoptLiveEpoch(orgId: string, live: { groupPk: Uint8Array; epoch: bigint }): boolean {
  const session = sessions.get(key(orgId))
  if (!session || !sameBytes(session.groupPk, live.groupPk)) return false
  sessions.set(key(orgId), { ...session, epoch: live.epoch })
  return true
}
