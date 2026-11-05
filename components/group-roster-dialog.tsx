"use client"

// Roster change for an on-chain organization's Members tab.
//
// The standard path is an explicit, cross-device FROST package exchange. Each
// device signs a fixed action descriptor, exchanges public round data via
// encrypted identity messages or a deliberate manual copy/paste fallback, and
// retains its private key share and one-shot nonces only in IndexedDB. It is
// gated by a fresh chain read and exact signature check.
import { useEffect, useMemo, useRef, useState } from "react"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Loader2, UserMinus, UserPlus, Users } from "lucide-react"
import { isValidSuiAddress, normalizeSuiAddress, toHex } from "@mysten/sui/utils"
import { describeRosterChange, planRosterChange, readLiveOrganization, type LiveOrganization, type RosterMember, type RosterPlan } from "@/lib/group-roster"
import { proposalClient } from "@/lib/proposal-chain"
import { assertRosterFrostRequest, createRosterFrostAction, ensureRosterUpdateFunction, submitFrostRosterChange } from "@/lib/group-roster-transactions"
import { getUserGroups } from "@/lib/onchain-store"
import { readDeviceKey, type BoundDeviceKey } from "@/lib/committee-share-store"
import {
  aggregateFrostSession,
  createFrostRequest,
  createFrostTranscript,
  parseFrostRequest,
  prepareFrostCommitment,
  produceFrostShare,
  verifyFrostRequest,
  verifyFrostRound1,
  verifyFrostRound2,
  verifyFrostTranscript,
  type FrostRequest,
  type FrostRound1,
  type FrostRound2,
  type FrostSigningResult,
  type FrostTranscript,
} from "@/lib/frost-session"
import { defaultFrostSessionStore, rememberFrostSession, type FrostSessionRecord } from "@/lib/frost-session-store"
import { listRosterSessions, mergeFrostRounds, recoverRosterSessionReceipt, restoreRosterSession } from "@/lib/group-roster-session"
import { transactionAccountKey } from "@/lib/pending-transactions"
import { frostPrivateTransport } from "@/lib/frost-private-transport"
import { getIdentityByAddress, identityConfigured, type IdentityProfile } from "@/lib/identity-client"
import { signProtocolMessage, verifyProtocolMessage } from "@/lib/wallet-personal-signing"
import { assertTransactionAccount, getTransactionAccount } from "@/lib/sui-wallet-signer"
import { useI18n } from "@/components/i18n-provider"

interface GroupRosterDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  orgId: string
  groupId: string
}

interface DraftMember extends RosterMember {
  name: string
  isNew: boolean
}

const protocolAuthFor = (check: () => void) => ({
  sign: async (bytes: Uint8Array) => { check(); const signed = await signProtocolMessage(bytes); check(); return signed },
  verify: async (bytes: Uint8Array, signature: string, address: string) => { check(); await verifyProtocolMessage(bytes, signature, address); check() },
})
const json = (value: unknown) => JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item, 2)
const bytesEqual = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((value, index) => value === b[index])
const sessionRecord = (request: FrostRequest, round1: FrostRound1[], transcript?: FrostTranscript, round2: FrostRound2[] = []) => ({
  request, round1, ...(transcript ? { transcript } : {}), round2, updatedAtMs: Date.now(),
})

function parseObject<T>(text: string, label: string): T {
  if (!text.trim()) throw new Error(ROSTER_PARSE_EMPTY(label))
  try { return JSON.parse(text) as T }
  catch { throw new Error(ROSTER_PARSE_BAD(label)) }
}

// Module-scope helpers keep parseObject usable before the component mounts; they
// resolve through the locale store at call time.
import { t } from "@/lib/i18n/t"
const ROSTER_PARSE_EMPTY = (label: string) => t("groups.parseEmpty", { label })
const ROSTER_PARSE_BAD = (label: string) => t("groups.parseBad", { label })

export function GroupRosterDialog({ open, onOpenChange, orgId, groupId }: GroupRosterDialogProps) {
  const { t } = useI18n()
  const [live, setLive] = useState<LiveOrganization | null>(null)
  const [draft, setDraft] = useState<DraftMember[]>([])
  const [threshold, setThreshold] = useState("")
  const [newAddress, setNewAddress] = useState("")
  const [newWeight, setNewWeight] = useState("1")
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [deployment, setDeployment] = useState<"checking" | "available" | "missing">("checking")
  const [deploymentError, setDeploymentError] = useState("")

  const [activeAddress, setActiveAddress] = useState("")
  const [activeAccountKey, setActiveAccountKey] = useState("")
  const [localKey, setLocalKey] = useState<BoundDeviceKey | null>(null)
  const [keyError, setKeyError] = useState("")
  const [signerSelection, setSignerSelection] = useState<string[]>([])
  const [requestText, setRequestText] = useState("")
  const [request, setRequest] = useState<FrostRequest | null>(null)
  const [round1Text, setRound1Text] = useState("")
  const [round1, setRound1] = useState<FrostRound1[]>([])
  const [transcriptText, setTranscriptText] = useState("")
  const [transcript, setTranscript] = useState<FrostTranscript | null>(null)
  const [round2Text, setRound2Text] = useState("")
  const [round2, setRound2] = useState<FrostRound2[]>([])
  const [aggregate, setAggregate] = useState<FrostSigningResult | null>(null)
  const [meIdentity, setMeIdentity] = useState<IdentityProfile | null>(null)
  const [peerIdentities, setPeerIdentities] = useState<Array<{ signerIndex: string; profile: IdentityProfile }>>([])
  const [transportStatus, setTransportStatus] = useState("")
  const [savedSessions, setSavedSessions] = useState<FrostSessionRecord[]>([])
  const [recoveryError, setRecoveryError] = useState("")
  const operation = useRef(0)
  const busyRef = useRef(false)

  useEffect(() => {
    if (!open) return
    let previous: string | undefined
    const sync = () => {
      let current = "", address = ""
      try { const account = getTransactionAccount(); current = transactionAccountKey(account); address = account.address } catch { /* disconnected */ }
      if (current === previous) return
      previous = current
      operation.current++
      busyRef.current = false
      setBusy(false); setActiveAddress(address); setActiveAccountKey(current); setLocalKey(null); setSignerSelection([])
      setRequest(null); setRequestText(""); setRound1([]); setRound1Text("")
      setTranscript(null); setTranscriptText(""); setRound2([]); setRound2Text(""); setAggregate(null)
      setMeIdentity(null); setPeerIdentities([]); setTransportStatus(""); setSavedSessions([])
      setNotice(""); setError("")
    }
    const invalidate = () => { operation.current++; busyRef.current = false }
    sync()
    window.addEventListener("sui-account-switched", sync)
    window.addEventListener("sui-account-changed", sync)
    window.addEventListener("storage", sync)
    return () => {
      invalidate()
      window.removeEventListener("sui-account-switched", sync)
      window.removeEventListener("sui-account-changed", sync)
      window.removeEventListener("storage", sync)
    }
  }, [open, orgId, groupId])

  useEffect(() => {
    setSavedSessions([]); setRecoveryError("")
    if (!open || !activeAddress) return
    let cancelled = false
    void listRosterSessions(orgId, activeAddress).then(records => {
      if (!cancelled) setSavedSessions(records)
    }).catch(cause => {
      if (!cancelled) setRecoveryError(cause instanceof Error ? cause.message : t("groups.readSessionsFailed"))
    })
    return () => { cancelled = true }
  }, [open, orgId, activeAddress, activeAccountKey, request, round1, round2])

  const localNames = useMemo(() => {
    const group = getUserGroups().find((value: unknown) => (value as { id?: string })?.id === groupId) as { members?: Array<{ address?: string; name?: string }> } | undefined
    const names = new Map<string, string>()
    for (const member of group?.members ?? []) {
      if (typeof member.address !== "string" || typeof member.name !== "string") continue
      try { names.set(normalizeSuiAddress(member.address), member.name) } catch { /* keep unlabeled */ }
    }
    return names
  }, [groupId])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLive(null); setDraft([]); setThreshold(""); setNewAddress(""); setNewWeight("1")
    setError(""); setNotice(""); setBusy(false); setDeployment("checking"); setDeploymentError("")
    setRequestText(""); setRequest(null); setRound1Text(""); setRound1([])
    setTranscriptText(""); setTranscript(null); setRound2Text(""); setRound2([]); setAggregate(null)
    setMeIdentity(null); setPeerIdentities([]); setTransportStatus("")
    setSignerSelection([]); setLocalKey(null); setKeyError("")
    try { setActiveAddress(getTransactionAccount().address) } catch { setActiveAddress("") }
    void (async () => {
      setLoading(true)
      try {
        const organization = await readLiveOrganization(proposalClient, orgId)
        if (cancelled) return
        setLive(organization)
        setDraft(organization.members.map(member => ({ ...member, name: localNames.get(member.address) ?? "", isNew: false })))
        setThreshold(organization.thresholdWeight.toString())
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : t("groups.readOrgFailed"))
      } finally { if (!cancelled) setLoading(false) }
      try {
        await ensureRosterUpdateFunction()
        if (!cancelled) setDeployment("available")
      } catch (cause) {
        if (!cancelled) { setDeployment("missing"); setDeploymentError(cause instanceof Error ? cause.message : t("groups.rosterFnMissing")) }
      }
    })()
    return () => { cancelled = true }
  }, [open, orgId, localNames])

  useEffect(() => {
    if (!open || !live || !activeAddress) { setLocalKey(null); return }
    let cancelled = false
    setKeyError("")
    void readDeviceKey(live.orgId, activeAddress).then(key => {
      if (cancelled) return
      setLocalKey(key)
      if (key) setSignerSelection(current => current.length ? current : Array.from({ length: Number(key.threshold) }, (_, index) => String(index + 1)))
    }).catch(cause => {
      if (!cancelled) { setLocalKey(null); setKeyError(cause instanceof Error ? cause.message : t("groups.readDeviceKeyFailed")) }
    })
    return () => { cancelled = true }
  }, [open, live, activeAddress, activeAccountKey])

  useEffect(() => {
    if (!open || !request) { setMeIdentity(null); setPeerIdentities([]); return }
    setMeIdentity(null); setPeerIdentities([]); setTransportStatus("")
    let cancelled = false
    void (async () => {
      if (!identityConfigured()) {
        if (!cancelled) setTransportStatus(t("groups.transportIdentityGap"))
        return
      }
      const resolved = await Promise.all(request.signers.map(async signer => {
        const profile = await getIdentityByAddress(signer.address)
        if (!profile) throw new Error(t("groups.signerNoIdentity", { address: signer.address }))
        return { signerIndex: signer.index, profile }
      }))
      const own = resolved.find(peer => normalizeSuiAddress(peer.profile.address) === normalizeSuiAddress(activeAddress))?.profile ?? null
      if (!cancelled) { setMeIdentity(own); setPeerIdentities(resolved) }
    })().catch(cause => {
      if (!cancelled) setTransportStatus(t("groups.transportVerifyFailed", { reason: cause instanceof Error ? cause.message : t("groups.unknownError") }))
    })
    return () => { cancelled = true }
  }, [open, request, activeAddress, activeAccountKey])

  const plan = useMemo<RosterPlan | null>(() => {
    if (!live) return null
    try { return planRosterChange(live, { members: draft, thresholdWeight: BigInt(threshold || "0") }) }
    catch { return null }
  }, [live, draft, threshold])

  const changes = useMemo(() => live && plan ? describeRosterChange(live, plan) : [], [live, plan])
  const totalWeight = draft.reduce((sum, member) => sum + (member.weight > 0n ? member.weight : 0n), 0n)
  const requestMatchesDraft = (() => {
    if (!live || !plan || !request) return false
    try { assertRosterFrostRequest(live, plan, request); return true }
    catch { return false }
  })()
  const selectedSignerIndices = signerSelection.map(Number).filter(Number.isSafeInteger).sort((a, b) => a - b)

  const transportPeers = peerIdentities.filter(peer => peer.profile.id !== meIdentity?.id)

  async function requireCurrentDeviceKey(): Promise<BoundDeviceKey> {
    if (!live) throw new Error(t("groups.orgNotLoaded"))
    const account = getTransactionAccount()
    const key = await readDeviceKey(live.orgId, account.address)
    if (!key) throw new Error(t("groups.noLocalKeyPackage"))
    if (key.holder !== normalizeSuiAddress(account.address)) throw new Error(t("groups.keyHolderMismatch"))
    if (key.epoch !== live.epoch) throw new Error(t("groups.keyEpochMismatch", { local: key.epoch, chain: live.epoch }))
    if (!bytesEqual(key.groupPk, live.groupPk)) throw new Error(t("groups.keyGroupPkMismatch"))
    return key
  }

  const setWeight = (address: string, value: string) => {
    const weight = /^\d+$/.test(value) ? BigInt(value) : 0n
    setDraft(current => current.map(member => member.address === address ? { ...member, weight } : member))
  }

  const remove = (address: string) => setDraft(current => current.filter(member => member.address !== address))

  const add = () => {
    setError("")
    const target = newAddress.trim()
    if (!isValidSuiAddress(target)) { setError(t("groups.invalidSuiAddress")); return }
    const address = normalizeSuiAddress(target)
    if (draft.some(member => member.address === address)) { setError(t("groups.addressAlreadyInRoster")); return }
    if (!/^[1-9]\d*$/.test(newWeight)) { setError(t("groups.weightPositiveInteger")); return }
    setDraft(current => {
      const existing = current.find(member => member.address === address)
      if (existing) return current.map(member => member.address === address ? { ...member, weight: BigInt(newWeight) } : member)
      return [...current, { address, weight: BigInt(newWeight), name: localNames.get(address) ?? "", isNew: true }]
    })
    setNewAddress(""); setNewWeight("1")
  }

  const perform = async (task: (check: () => void) => Promise<void>) => {
    if (busyRef.current) return
    const generation = ++operation.current
    const check = () => {
      if (operation.current !== generation) throw new Error(t("groups.contextSwitchedRetry"))
      assertTransactionAccount(account)
    }
    let account: ReturnType<typeof getTransactionAccount>
    try { account = { ...getTransactionAccount() } }
    catch (cause) { setError(cause instanceof Error ? cause.message : t("groups.connectWalletFirstRoster")); return }
    busyRef.current = true
    setBusy(true); setError(""); setNotice("")
    try { await task(check) }
    catch (cause) { if (operation.current === generation) setError(cause instanceof Error ? cause.message : t("groups.frostOperationFailed")) }
    finally { if (operation.current === generation) { busyRef.current = false; setBusy(false) } }
  }

  const recoverSession = (requestId: string) => perform(async check => {
    const fresh = await readLiveOrganization(proposalClient, orgId)
    check()
    const record = await restoreRosterSession({ requestId, live: fresh, holder: activeAddress, verify: protocolAuthFor(check).verify })
    check()
    if (record.request.action.kind !== "roster") throw new Error(t("groups.notRosterSession"))
    const action = record.request.action
    setLive(fresh)
    setDraft(action.members.map((address, index) => ({ address, weight: BigInt(action.weights[index]), name: localNames.get(address) ?? "", isNew: !fresh.members.some(member => member.address === address) })))
    setThreshold(action.thresholdWeight)
    setRequest(record.request); setRequestText(json(record.request))
    setRound1(record.round1); setRound1Text(json(record.round1))
    setTranscript(record.transcript ?? null); setTranscriptText(record.transcript ? json(record.transcript) : "")
    setRound2(record.round2); setRound2Text(json(record.round2)); setAggregate(null)
    setNotice(t("groups.sessionRestoredNotice"))
  })

  const refreshAfterReceiptRecovery = async (digest: string, check: () => void) => {
    check()
    setNotice(t("groups.receiptRecoveredNotice", { digest }))
    const refreshed = await readLiveOrganization(proposalClient, orgId)
    check()
    setLive(refreshed)
    setDraft(refreshed.members.map(member => ({ ...member, name: localNames.get(member.address) ?? "", isNew: false })))
    setThreshold(refreshed.thresholdWeight.toString())
    setRequest(null); setRequestText(""); setRound1([]); setRound1Text("")
    setTranscript(null); setTranscriptText(""); setRound2([]); setRound2Text(""); setAggregate(null)
    window.dispatchEvent(new CustomEvent("sui-groups-updated", { detail: getUserGroups() }))
  }

  const recoverSessionReceipt = (requestId: string) => perform(async check => {
    const result = await recoverRosterSessionReceipt({
      requestId, orgId, verify: protocolAuthFor(check).verify,
      dependencies: { getAccount: () => { check(); return getTransactionAccount() } },
    })
    await refreshAfterReceiptRecovery(result.digest, check)
  })

  const createRequest = () => perform(async check => {
    if (!live || !plan) throw new Error(t("groups.invalidPreviewFixFirst"))
    const key = await requireCurrentDeviceKey()
    check()
    const account = getTransactionAccount()
    if (selectedSignerIndices.length < Number(key.threshold)) throw new Error(t("groups.needMoreSigners", { needed: key.threshold, selected: selectedSignerIndices.length }))
    const created = await createFrostRequest({
      action: createRosterFrostAction(live, plan), key, signerIndices: selectedSignerIndices.map(BigInt),
      coordinator: account.address, expiresAtMs: Date.now() + 24 * 60 * 60 * 1000,
    }, protocolAuthFor(check))
    await verifyFrostRequest(created, protocolAuthFor(check).verify)
    assertRosterFrostRequest(live, plan, created)
    await rememberFrostSession(sessionRecord(created, []))
    check()
    setRequest(created); setRequestText(json(created))
    setRound1([]); setRound1Text("[]"); setTranscript(null); setTranscriptText("")
    setRound2([]); setRound2Text("[]"); setAggregate(null)
    setNotice(t("groups.requestCreatedNotice"))
  })

  const importRequest = () => perform(async check => {
    if (!live || !plan) throw new Error(t("groups.invalidPreviewNoImport"))
    const imported = parseFrostRequest(requestText)
    await verifyFrostRequest(imported, protocolAuthFor(check).verify)
    assertRosterFrostRequest(live, plan, imported)
    await rememberFrostSession(sessionRecord(imported, []))
    check()
    setRequest(imported); setRequestText(json(imported))
    setRound1([]); setRound1Text("[]"); setTranscript(null); setTranscriptText("")
    setRound2([]); setRound2Text("[]"); setAggregate(null)
    setNotice(t("groups.requestVerifiedNotice"))
  })

  const addLocalCommitment = () => perform(async check => {
    if (!request || !live || !plan) throw new Error(t("groups.needValidRequestFirst"))
    assertRosterFrostRequest(live, plan, request)
    const key = await requireCurrentDeviceKey()
    check()
    const commitment = await prepareFrostCommitment(request, key, { auth: protocolAuthFor(check) })
    await verifyFrostRound1(request, commitment, protocolAuthFor(check).verify)
    const next = mergeFrostRounds(round1, [commitment])
    if (transcript) mergeFrostRounds(transcript.round1, next)
    await rememberFrostSession(sessionRecord(request, next, transcript ?? undefined, round2), { store: defaultFrostSessionStore })
    check()
    setRound1(next); setRound1Text(json(next))
    setNotice(t("groups.round1SavedNotice", { index: commitment.index }))
  })

  const importRound1 = () => perform(async check => {
    if (!request || !live || !plan) throw new Error(t("groups.needValidRequestFirst"))
    assertRosterFrostRequest(live, plan, request)
    const imported = parseObject<FrostRound1[]>(round1Text, "Round 1")
    if (!Array.isArray(imported)) throw new Error(t("groups.round1MustBeArray"))
    for (const value of imported) await verifyFrostRound1(request, value, protocolAuthFor(check).verify)
    const next = mergeFrostRounds(round1, imported)
    if (transcript) mergeFrostRounds(transcript.round1, next)
    await rememberFrostSession(sessionRecord(request, next, transcript ?? undefined, round2), { store: defaultFrostSessionStore })
    check()
    setRound1(next); setRound1Text(json(next))
    setNotice(t("groups.round1ImportedNotice", { count: imported.length, total: request.signers.length }))
  })

  const buildTranscript = () => perform(async check => {
    if (!request || !live || !plan) throw new Error(t("groups.needValidRequestFirst"))
    assertRosterFrostRequest(live, plan, request)
    const account = getTransactionAccount()
    if (normalizeSuiAddress(account.address) !== normalizeSuiAddress(request.coordinator)) throw new Error(t("groups.onlyCoordinator"))
    const created = await createFrostTranscript(request, round1, protocolAuthFor(check), defaultFrostSessionStore)
    await verifyFrostTranscript(request, created, protocolAuthFor(check).verify)
    check()
    setTranscript(created); setTranscriptText(json(created)); setRound2([]); setRound2Text("[]"); setAggregate(null)
    setNotice(t("groups.transcriptBuiltNotice"))
  })

  const importTranscript = () => perform(async check => {
    if (!request || !live || !plan) throw new Error(t("groups.needValidRequestFirst"))
    assertRosterFrostRequest(live, plan, request)
    const imported = parseObject<FrostTranscript>(transcriptText, "transcript")
    await verifyFrostTranscript(request, imported, protocolAuthFor(check).verify)
    mergeFrostRounds(round1, imported.round1)
    if (transcript && transcript.transcriptHash !== imported.transcriptHash) throw new Error(t("groups.transcriptConflict"))
    await rememberFrostSession(sessionRecord(request, imported.round1, imported, round2), { store: defaultFrostSessionStore })
    check()
    setTranscript(imported); setTranscriptText(json(imported)); setRound1(imported.round1); setRound1Text(json(imported.round1))
    setNotice(t("groups.transcriptVerifiedNotice"))
  })

  const produceLocalShare = () => perform(async check => {
    if (!request || !transcript || !live || !plan) throw new Error(t("groups.needRequestAndTranscript"))
    assertRosterFrostRequest(live, plan, request)
    const key = await requireCurrentDeviceKey()
    check()
    const share = await produceFrostShare(request, transcript, key, { auth: protocolAuthFor(check) })
    await verifyFrostRound2(request, transcript, share, protocolAuthFor(check).verify)
    const next = [...round2.filter(value => value.index !== share.index), share].sort((a, b) => Number(BigInt(a.index) - BigInt(b.index)))
    await rememberFrostSession(sessionRecord(request, transcript.round1, transcript, next), { store: defaultFrostSessionStore })
    check()
    setRound2(next); setRound2Text(json(next)); setAggregate(null)
    setNotice(t("groups.round2SavedNotice", { index: share.index }))
  })

  const importRound2 = () => perform(async check => {
    if (!request || !transcript || !live || !plan) throw new Error(t("groups.needRequestAndTranscript"))
    assertRosterFrostRequest(live, plan, request)
    const imported = parseObject<FrostRound2[]>(round2Text, "Round 2")
    if (!Array.isArray(imported)) throw new Error(t("groups.round2MustBeArray"))
    for (const value of imported) await verifyFrostRound2(request, transcript, value, protocolAuthFor(check).verify)
    const next = mergeFrostRounds(round2, imported)
    await rememberFrostSession(sessionRecord(request, transcript.round1, transcript, next), { store: defaultFrostSessionStore })
    check()
    setRound2(next); setRound2Text(json(next)); setAggregate(null)
    setNotice(t("groups.round2ImportedNotice", { count: imported.length, total: request.signers.length }))
  })

  const importFromTransport = () => perform(async check => {
    if (!request || !live || !plan) throw new Error(t("groups.needValidRequestFirst"))
    if (!meIdentity) throw new Error(t("groups.noIdentityForTransport"))
    if (!transportPeers.length) throw new Error(t("groups.noTransportPeers"))
    assertRosterFrostRequest(live, plan, request)
    setTransportStatus(t("groups.readingFromTransport"))
    const histories = await frostPrivateTransport.list({ request, transcript: transcript ?? undefined, me: meIdentity, peers: transportPeers.map(peer => peer.profile) })
    check()
    const failures = histories.filter(history => history.unavailableReason || history.truncated)
    const incomplete = failures.length > 0
    if (incomplete) {
      const details = failures.map(history => history.unavailableReason ?? t("groups.peerHistoryTruncated", { peer: history.peerId })).join(t("groups.joinSemicolon"))
      setTransportStatus(t("groups.transportReadIncomplete", { details }))
      throw new Error(t("groups.transportHistoryIncompleteError"))
    }
    // `list` authenticated the identity event and the round's wallet signature;
    // keep the signed round so ordinary transcript/aggregate verification can run.
    const remote = histories.flatMap(history => history.rounds).map(entry => entry.round)
    const importedRound1 = remote.filter((entry): entry is FrostRound1 => "hiding" in entry)
    const importedRound2 = remote.filter((entry): entry is FrostRound2 => "scalar" in entry)
    const nextRound1 = mergeFrostRounds(round1, importedRound1)
    if (transcript) mergeFrostRounds(transcript.round1, nextRound1)
    const nextRound2 = mergeFrostRounds(round2, importedRound2)
    await rememberFrostSession(sessionRecord(request, nextRound1, transcript ?? undefined, nextRound2), { store: defaultFrostSessionStore })
    check()
    setRound1(nextRound1); setRound1Text(json(nextRound1))
    setRound2(nextRound2); setRound2Text(json(nextRound2)); setAggregate(null)

    const scanned = histories.map(history => `${history.peerId.slice(0, 10)}…=${history.rounds.length}`).join(" · ")
    setTransportStatus(t("groups.transportReadSummary", { total: remote.length, scanned, round1: importedRound1.length, round2: importedRound2.length, round2Part: transcript ? t("groups.transportRound2Part", { count: importedRound2.length }) : "" }))
    setNotice(t("groups.transportVerifiedNotice"))
  })

  const sendRoundOverTransport = (kind: "round1" | "round2") => perform(async check => {
    if (!request || !live || !plan) throw new Error(t("groups.needValidRequestFirst"))
    if (!meIdentity) throw new Error(t("groups.noIdentityForTransport"))
    if (!transportPeers.length) throw new Error(t("groups.noSendPeers"))
    assertRosterFrostRequest(live, plan, request)
    const localRound = kind === "round1" ? round1.find(value => value.address === meIdentity.address) : round2.find(value => value.address === meIdentity.address)
    if (!localRound) throw new Error(t("groups.needLocalRoundFirst", { round: kind === "round1" ? "Round 1" : "Round 2" }))
    if (kind === "round2" && !transcript) throw new Error(t("groups.round2NeedsTranscript"))
    if (normalizeSuiAddress(getTransactionAccount().address) !== meIdentity.address) throw new Error(t("groups.walletSwitchedReread"))
    for (const peer of transportPeers) {
      check()
      await frostPrivateTransport.send({
        request, round: localRound, transcript: transcript ?? undefined,
        sender: meIdentity, recipient: peer.profile, userClickConfirmed: true,
      })
      check()
    }
    setTransportStatus(t("groups.transportSentStatus", { count: transportPeers.length, round: kind === "round1" ? "Round 1 commitment" : "Round 2 share" }))
    setNotice(t("groups.transportSentNotice"))
  })

  const aggregateSignature = () => perform(async check => {
    if (!request || !transcript || !live || !plan) throw new Error(t("groups.needRequestAndTranscript"))
    assertRosterFrostRequest(live, plan, request)
    const result = await aggregateFrostSession(request, transcript, round2, protocolAuthFor(check).verify)
    if (!bytesEqual(result.groupPk, live.groupPk)) throw new Error(t("groups.aggregatePkMismatch"))
    await rememberFrostSession(sessionRecord(request, transcript.round1, transcript, round2), { store: defaultFrostSessionStore })
    check()
    setAggregate(result)
    setNotice(t("groups.aggregateVerifiedNotice"))
  })

  const submitAggregated = () => perform(async check => {
    if (!live || !request || !aggregate) throw new Error(t("groups.noVerifiedAggregate"))
    if (!plan) throw new Error(t("groups.invalidPreview"))
    // `submitFrostRosterChange` re-reads chain state after package validation,
    // compares the entire signed descriptor and verifies once more before wallet.
    check()
    const result = await submitFrostRosterChange(live, { members: draft, thresholdWeight: plan.thresholdWeight }, request, aggregate, { getAccount: () => { check(); return getTransactionAccount() } })
    check()
    setNotice(t("groups.rotationConfirmedNotice", { digest: result.digest, shares: result.signerIndices.length }))
    const refreshed = await readLiveOrganization(proposalClient, orgId)
    check()
    setLive(refreshed)
    setDraft(refreshed.members.map(member => ({ ...member, name: localNames.get(member.address) ?? "", isNew: false })))
    setThreshold(refreshed.thresholdWeight.toString())
    setRequest(null); setRequestText(""); setRound1([]); setRound1Text(""); setTranscript(null); setTranscriptText("")
    setRound2([]); setRound2Text(""); setAggregate(null)
    window.dispatchEvent(new CustomEvent("sui-groups-updated", { detail: getUserGroups() }))
  })

  const validFixedSignerSet = Boolean(localKey && selectedSignerIndices.length >= Number(localKey.threshold) &&
    new Set(selectedSignerIndices).size === selectedSignerIndices.length && selectedSignerIndices.every(index => index >= 1 && index <= localKey.participantAddresses.length))

  return (
    <Dialog open={open} onOpenChange={next => { if (!busy) onOpenChange(next) }}>
      <DialogContent className="w-[94vw] max-w-[560px] max-h-[90dvh] overflow-y-auto rounded-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Users className="h-4 w-4 text-primary" />
            {t("groups.rosterDialogTitle")}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {t("groups.rosterDialogDesc")}
          </DialogDescription>
        </DialogHeader>

        <div className="min-w-0 space-y-3 py-2 text-xs">
          {loading && <p role="status" className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" />{t("groups.loadingRoster")}</p>}
          {live && (
            <div className="rounded-lg border border-border/50 bg-muted/30 p-2 font-mono text-[11px] text-muted-foreground">
              <p className="truncate">{t("groups.orgLabel")} {live.orgId}</p>
              <p>{t("groups.rosterSummaryLine", { epoch: live.epoch.toString(), threshold: live.thresholdWeight.toString(), total: live.members.reduce((sum, member) => sum + member.weight, 0n).toString(), nonce: live.lastNonce.toString() })}</p>
            </div>
          )}

          {deployment === "checking" && <p role="status" className="text-muted-foreground">{t("groups.checkingRosterFn")}</p>}
          {deployment === "missing" && (
            <p role="alert" className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-2 text-[11px]">
              {t("groups.deploymentGapPrefix")}{deploymentError} {t("groups.deploymentGapSuffix")}
            </p>
          )}

          {live && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label className="text-xs">{t("groups.currentRoster")}</Label>
                <Badge variant="outline" className="text-[10px]">{t("groups.rosterCountBadge", { count: draft.length, total: totalWeight.toString() })}</Badge>
              </div>
              <div className="max-h-56 space-y-1 overflow-y-auto pr-1">
                {draft.map(member => (
                  <div key={member.address} className="flex items-center gap-2 rounded-lg border border-border/40 bg-background/60 p-1.5">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[11px] font-medium">
                        {member.name || `${member.address.slice(0, 10)}…${member.address.slice(-6)}`}
                        {member.isNew && <span className="ml-1 text-emerald-500">{t("groups.newMemberTag")}</span>}
                      </p>
                      <p className="truncate font-mono text-[10px] text-muted-foreground">{member.address}</p>
                    </div>
                    <Input
                      aria-label={t("groups.memberWeightAria", { address: member.address })}
                      inputMode="numeric"
                      value={member.weight.toString()}
                      onChange={event => setWeight(member.address, event.target.value)}
                      disabled={busy || deployment === "missing"}
                      className="h-7 w-16 text-center font-mono text-[11px]"
                    />
                    <Button
                      size="icon" variant="ghost" className="h-7 w-7 text-destructive"
                      aria-label={t("groups.removeMemberAria", { address: member.address })}
                      onClick={() => remove(member.address)}
                      disabled={busy || deployment === "missing"}
                    >
                      <UserMinus className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
                {draft.length === 0 && <p className="text-[11px] text-muted-foreground">{t("groups.rosterEmptyKeepOne")}</p>}
              </div>
            </div>
          )}

          {live && (
            <div className="space-y-1.5">
              <Label className="text-xs">{t("groups.addMemberLabel")}</Label>
              <div className="flex gap-1.5">
                <Input
                  aria-label={t("groups.newMemberAddressAria")} value={newAddress} onChange={event => setNewAddress(event.target.value)}
                  placeholder="0x…" disabled={busy || deployment === "missing"} className="h-8 flex-1 font-mono text-[11px]"
                />
                <Input
                  aria-label={t("groups.newMemberWeightAria")} inputMode="numeric" value={newWeight} onChange={event => setNewWeight(event.target.value)}
                  disabled={busy || deployment === "missing"} className="h-8 w-16 text-center font-mono text-[11px]"
                />
                <Button size="sm" variant="outline" onClick={add} disabled={busy || deployment === "missing"} className="h-8">
                  <UserPlus className="mr-1 h-3.5 w-3.5" />{t("groups.addMemberButton")}
                </Button>
              </div>
            </div>
          )}

          {live && (
            <div className="space-y-1.5">
              <Label htmlFor="group-roster-threshold" className="text-xs">{t("groups.thresholdWeightLabel")}</Label>
              <Input
                id="group-roster-threshold" inputMode="numeric" value={threshold}
                onChange={event => setThreshold(event.target.value)}
                disabled={busy || deployment === "missing"} className="h-8 w-24 text-center font-mono text-[11px]"
              />
              <p className="text-[10px] text-muted-foreground">{t("groups.thresholdHint", { total: totalWeight.toString() })}</p>
            </div>
          )}

          {changes.length > 0 && (
            <div className="rounded-lg border border-primary/30 bg-primary/5 p-2">
              <p className="mb-1 font-medium">{t("groups.pendingChanges")}</p>
              <ul className="space-y-0.5 text-[11px] text-muted-foreground">
                {changes.map(change => <li key={change} className="break-all">{change}</li>)}
              </ul>
            </div>
          )}

          {live && (
            <section className="space-y-2 rounded-lg border border-primary/30 p-2.5" aria-label={t("groups.frostSectionAria")}>
              <div>
                <p className="font-semibold">{t("groups.frostSectionTitle")}</p>
                <p className="mt-0.5 break-all text-[10px] text-muted-foreground">{t("groups.frostWalletLine", { wallet: activeAddress || t("groups.notConnected"), keyInfo: localKey ? t("groups.frostKeyInfo", { epoch: localKey.epoch, threshold: localKey.threshold, head: localKey.keyPackageId.slice(0, 12) }) : t("groups.unavailable") })}</p>
                {keyError && <p role="alert" className="mt-1 break-all text-[10px] text-destructive">{keyError}</p>}
                {!localKey && !keyError && <p className="mt-1 text-[10px] text-amber-600">{t("groups.needDeviceKeyNotice")}</p>}
              </div>

              {localKey && (
                <div className="max-h-28 space-y-1 overflow-y-auto rounded-md border border-border/40 p-2">
                  <p className="mb-1 text-[10px] font-medium">{t("groups.fixedSignersLabel", { threshold: localKey.threshold })}</p>
                  {localKey.participantAddresses.map((address, index) => {
                    const signerIndex = String(index + 1)
                    return <label key={address} className="flex items-center gap-2 text-[10px]">
                      <input type="checkbox" checked={signerSelection.includes(signerIndex)} disabled={busy || Boolean(request)} onChange={event => setSignerSelection(current => event.target.checked ? [...current, signerIndex].sort((a, b) => Number(a) - Number(b)) : current.filter(value => value !== signerIndex))} />
                      <span className="font-mono">#{signerIndex} {address}</span>
                    </label>
                  })}
                </div>
              )}

              <div className="space-y-1.5 rounded-md border border-border/50 p-2" aria-label={t("groups.sessionRecoveryAria")}>
                <p className="text-[10px] font-medium">{t("groups.localSessionsLabel")}</p>
                <p className="text-[10px] text-muted-foreground">{t("groups.sessionRecoveryHint")}</p>
                {recoveryError && <p role="alert" className="break-all text-[10px] text-destructive">{t("groups.sessionReadFailedPrefix")}{recoveryError}</p>}
                {!recoveryError && savedSessions.length === 0 && <p className="text-[10px] text-muted-foreground">{t("groups.noSavedSessions")}</p>}
                {savedSessions.map(record => (
                  <div key={record.request.requestId} className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                    <span className="min-w-0 truncate font-mono text-[10px]">{record.request.requestId.slice(0, 12)}… · R1 {record.round1.length} / R2 {record.round2.length}</span>
                    <div className="flex flex-wrap gap-1.5">
                      <Button size="sm" variant="outline" disabled={busy} onClick={() => void recoverSession(record.request.requestId)}>{t("groups.recoverSessionButton")}</Button>
                      <Button size="sm" variant="outline" disabled={busy} onClick={() => void recoverSessionReceipt(record.request.requestId)}>{t("groups.recoverReceiptButton")}</Button>
                    </div>
                  </div>
                ))}
              </div>

              <div className="space-y-1">
                <Label htmlFor="frost-request-json" className="text-[10px]">FROST request JSON</Label>
                <Textarea id="frost-request-json" value={requestText} onChange={event => { setRequestText(event.target.value); setRequest(null); setAggregate(null) }} placeholder={t("groups.requestJsonPlaceholder")} disabled={busy} className="min-h-20 font-mono text-[10px]" />
                <div className="flex flex-wrap gap-1.5">
                  <Button size="sm" variant="outline" onClick={() => void createRequest()} disabled={busy || !localKey || !validFixedSignerSet || !plan || deployment !== "available"}>{t("groups.createRequestButton")}</Button>
                  <Button size="sm" variant="outline" onClick={() => void importRequest()} disabled={busy || !live || !plan}>{t("groups.importRequestButton")}</Button>
                  {request && <Badge variant={requestMatchesDraft ? "default" : "destructive"} className="text-[10px]">{requestMatchesDraft ? t("groups.verifiedSignersBadge", { count: request.signers.length }) : t("groups.previewMismatchBadge")}</Badge>}
                </div>
              </div>

              {request && (
                <div className="space-y-1 rounded-md bg-muted/30 p-2">
                  <p className="text-[10px] font-medium">{t("groups.requestActionPreview")}</p>
                  <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all font-mono text-[9px]">{json(request.action)}</pre>
                  <p className="break-all text-[9px] text-muted-foreground">{t("groups.fixedSignersPrefix")}{request.signers.map(signer => `#${signer.index} ${signer.address}`).join(" · ")}</p>
                </div>
              )}

              {request && (
                <div className="space-y-1.5 border-t border-border/50 pt-2">
                  <Label htmlFor="frost-round1-json" className="text-[10px]">Round 1 commitments JSON array · {round1.length}/{request.signers.length}</Label>
                  <Textarea id="frost-round1-json" value={round1Text} onChange={event => setRound1Text(event.target.value)} placeholder={t("groups.round1Placeholder")} disabled={busy} className="min-h-20 font-mono text-[10px]" />
                  <div className="flex flex-wrap gap-1.5">
                    <Button size="sm" variant="outline" onClick={() => void addLocalCommitment()} disabled={busy || !requestMatchesDraft || !localKey}>{t("groups.makeLocalRound1")}</Button>
                    <Button size="sm" variant="outline" onClick={() => void importRound1()} disabled={busy || !requestMatchesDraft}>{t("groups.importVerifyRound1")}</Button>
                    <Button size="sm" variant="outline" onClick={() => void sendRoundOverTransport("round1")} disabled={busy || !requestMatchesDraft || !meIdentity || !transportPeers.length || !round1.some(value => value.address === meIdentity.address)}>{t("groups.dmSendRound1")}</Button>
                    <Button size="sm" variant="outline" onClick={() => void importFromTransport()} disabled={busy || !requestMatchesDraft || !meIdentity || !transportPeers.length}>{t("groups.dmReadVerify")}</Button>
                    <Button size="sm" onClick={() => void buildTranscript()} disabled={busy || !requestMatchesDraft || round1.length !== request.signers.length}>{t("groups.buildTranscript")}</Button>
                  </div>
                </div>
              )}

              {request && (
                <div className="space-y-1.5 border-t border-border/50 pt-2">
                  <Label htmlFor="frost-transcript-json" className="text-[10px]">Transcript JSON</Label>
                  <Textarea id="frost-transcript-json" value={transcriptText} onChange={event => { setTranscriptText(event.target.value); setTranscript(null); setAggregate(null) }} placeholder={t("groups.transcriptPlaceholder")} disabled={busy} className="min-h-20 font-mono text-[10px]" />
                  <Button size="sm" variant="outline" onClick={() => void importTranscript()} disabled={busy || !requestMatchesDraft}>{t("groups.importVerifyTranscript")}</Button>
                </div>
              )}

              {request && transcript && (
                <div className="space-y-1.5 border-t border-border/50 pt-2">
                  <Label htmlFor="frost-round2-json" className="text-[10px]">Round 2 signature shares JSON array · {round2.length}/{request.signers.length}</Label>
                  <Textarea id="frost-round2-json" value={round2Text} onChange={event => { setRound2Text(event.target.value); setAggregate(null) }} placeholder={t("groups.round2Placeholder")} disabled={busy} className="min-h-20 font-mono text-[10px]" />
                  <div className="flex flex-wrap gap-1.5">
                    <Button size="sm" variant="outline" onClick={() => void produceLocalShare()} disabled={busy || !requestMatchesDraft || !localKey}>{t("groups.makeLocalRound2")}</Button>
                    <Button size="sm" variant="outline" onClick={() => void importRound2()} disabled={busy || !requestMatchesDraft}>{t("groups.importVerifyRound2")}</Button>
                    <Button size="sm" variant="outline" onClick={() => void sendRoundOverTransport("round2")} disabled={busy || !requestMatchesDraft || !meIdentity || !transportPeers.length || !round2.some(value => value.address === meIdentity.address)}>{t("groups.dmSendRound2")}</Button>
                    <Button size="sm" onClick={() => void aggregateSignature()} disabled={busy || !requestMatchesDraft || round2.length !== request.signers.length}>{t("groups.aggregateVerify")}</Button>
                  </div>
                </div>
              )}

              {transportStatus && <p role="status" className="break-all rounded-md bg-muted/40 p-2 text-[10px] text-muted-foreground">{transportStatus}</p>}

              {aggregate && (
                <div className="space-y-1.5 rounded-md border border-emerald-500/40 bg-emerald-500/10 p-2">
                  <p className="font-medium text-emerald-700 dark:text-emerald-300">{t("groups.aggregateVerifiedCard", { count: aggregate.signerIndices.length })}</p>
                  <p className="break-all font-mono text-[9px]">request {aggregate.requestId} · digest 0x{toHex(aggregate.digest)}</p>
                  <Button size="sm" onClick={() => void submitAggregated()} disabled={busy || deployment !== "available" || !requestMatchesDraft}>{t("groups.refreshAndSubmit")}</Button>
                </div>
              )}
            </section>
          )}

          {error && <p role="alert" className="break-all rounded-lg border border-destructive/40 bg-destructive/10 p-2 text-[11px] text-destructive">{error}</p>}
          {notice && <p role="status" className="break-all rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-2 text-[11px] text-emerald-600 dark:text-emerald-400">{notice}</p>}
          <p className="text-[10px] text-muted-foreground">{t("groups.removeMemberSecurityNote")}</p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>{t("groups.closeButton")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
