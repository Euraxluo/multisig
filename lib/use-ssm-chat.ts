"use client"

// State for the Sui Stack Messaging transport, shared by the group conversation.
// The conversation itself lives in one place (the chat tab); this hook only
// owns the encrypted transport's state so the chat tab can route the same
// message list and composer through either transport.
import { useCallback, useEffect, useRef, useState } from "react"
import {
  MAX_SSM_GROUPS, createSsmGroup, describeSsmError, inviteToSsmGroup, probeRelayer,
  readLocalRelayer, readSsmGroups, readSsmMessages, resetSsmSession, saveLocalRelayer,
  sendSsmMessage, ssmStatus, subscribeSsmMessages,
  type SsmChatRow, type SsmGroupRecord, type SsmStatus,
} from "@/lib/sui-stack-messaging"
import { t } from "./i18n/t"

export interface UseSsmChatOptions {
  /** Local group record id used to scope this browser's SSM registrations. */
  groupId: string
  accountAddress: string
  /** Subscriptions and reads only run while the encrypted transport is shown. */
  enabled: boolean
  readOnly?: boolean
}

export function useSsmChat({ groupId, accountAddress, enabled, readOnly = false }: UseSsmChatOptions) {
  const [status, setStatus] = useState<SsmStatus>(() => ssmStatus({}, ""))
  const [relayerDraft, setRelayerDraft] = useState("")
  const [probe, setProbe] = useState<{ ok: boolean; detail: string } | null>(null)
  const [probing, setProbing] = useState(false)
  const [groups, setGroups] = useState<SsmGroupRecord[]>([])
  const [activeGroupId, setActiveGroupId] = useState("")
  const [groupError, setGroupError] = useState("")
  const [groupName, setGroupName] = useState("")
  const [creating, setCreating] = useState(false)
  const [invitee, setInvitee] = useState("")
  const [inviting, setInviting] = useState(false)
  const [rows, setRows] = useState<SsmChatRow[]>([])
  const [loadingRows, setLoadingRows] = useState(false)
  const [messageError, setMessageError] = useState("")
  const [notice, setNotice] = useState("")
  const [sending, setSending] = useState(false)
  const [subscribed, setSubscribed] = useState(false)
  const accountRef = useRef(accountAddress)
  accountRef.current = accountAddress
  // The registry is newest-first, so the newest registration is the default
  // selection; every other registration stays reachable through the picker.
  const activeGroup = groups.find(group => group.groupId === activeGroupId) ?? groups[0]

  useEffect(() => {
    const local = typeof window === "undefined" ? "" : readLocalRelayer(localStorage)
    setRelayerDraft(local)
    setStatus(ssmStatus(undefined, local))
  }, [])

  useEffect(() => {
    try { setGroups(readSsmGroups(localStorage, groupId)); setGroupError("") }
    catch (error) { setGroups([]); setGroupError(error instanceof Error ? error.message : t("misc.ssm.registryUnreadable")) }
    setActiveGroupId("")
  }, [groupId])

  const applyRelayer = (value: string) => {
    try {
      const saved = saveLocalRelayer(localStorage, value)
      setRelayerDraft(saved)
      setStatus(ssmStatus(undefined, saved))
      resetSsmSession()
      setProbe(null); setMessageError(""); setRows([])
      setNotice(saved ? t("misc.ssm.relaySaved") : t("misc.ssm.relayCleared"))
    } catch (error) { setNotice(error instanceof Error ? error.message : t("misc.ssm.relayInvalid")) }
  }

  const checkRelayer = async () => {
    if (!status.configured) return
    setProbing(true); setProbe(null)
    try { setProbe(await probeRelayer(status.relayerUrl)) } finally { setProbing(false) }
  }

  const createGroup = async () => {
    if (readOnly) return
    setCreating(true); setGroupError(""); setNotice("")
    try {
      const created = await createSsmGroup(groupId, groupName)
      setGroups(readSsmGroups(localStorage, groupId))
      setActiveGroupId(created.record.groupId)
      setGroupName("")
      setNotice(created.warning ?? t("misc.ssm.groupCreated", { groupId: created.record.groupId.slice(0, 10), digest: created.digest.slice(0, 10) }))
    } catch (error) { setGroupError(describeSsmError(error)) } finally { setCreating(false) }
  }

  const invite = async () => {
    if (!activeGroup || readOnly) return
    setInviting(true); setGroupError("")
    try {
      const digest = await inviteToSsmGroup(activeGroup.groupId, invitee)
      setInvitee("")
      setNotice(t("misc.ssm.memberTxConfirmed", { digest: digest.slice(0, 12) }))
    } catch (error) { setGroupError(describeSsmError(error)) } finally { setInviting(false) }
  }

  const load = useCallback(async () => {
    if (!activeGroup) return
    const expected = accountRef.current
    setLoadingRows(true); setMessageError("")
    try {
      const next = await readSsmMessages(activeGroup.uuid, 50)
      if (accountRef.current === expected) setRows(next)
    } catch (error) {
      if (accountRef.current === expected) setMessageError(describeSsmError(error))
    } finally { setLoadingRows(false) }
  }, [activeGroup])

  useEffect(() => {
    if (!enabled || !activeGroup || !accountAddress) return
    setRows([]); setMessageError("")
    void load()
    const controller = new AbortController()
    let stopped = false
    setSubscribed(true)
    subscribeSsmMessages(activeGroup.uuid, controller.signal, next => { if (!stopped) setRows(next) })
      .catch(error => { if (!stopped) setMessageError(describeSsmError(error)) })
      .finally(() => { if (!stopped) setSubscribed(false) })
    return () => { stopped = true; controller.abort() }
  }, [enabled, activeGroup, accountAddress, load])

  const send = async (text: string) => {
    if (!activeGroup) throw new Error(t("misc.ssm.noGroup"))
    setSending(true); setMessageError("")
    try {
      await sendSsmMessage(activeGroup.uuid, text)
      await load()
    } finally { setSending(false) }
  }

  return {
    status, relayerDraft, setRelayerDraft, applyRelayer, probe, probing, checkRelayer,
    groups, activeGroup, setActiveGroupId, groupError, groupName, setGroupName, creating, createGroup,
    invitee, setInvitee, inviting, invite,
    rows, loadingRows, messageError, notice, send, sending, subscribed, load,
    maxGroups: MAX_SSM_GROUPS, readOnly,
  }
}

export type SsmChatController = ReturnType<typeof useSsmChat>
