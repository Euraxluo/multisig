"use client"

// Loading state for the AgentVault page. Discovery starts from the account's
// owned capabilities and then verifies every card against the live vault; the
// local index only supplies candidate cap IDs created by this browser.
import { useCallback, useEffect, useRef, useState } from "react"
import { getActiveAccount } from "./onchain-store"
import {
  AGENT_CAP_INDEX_KEY, AGENT_LABEL_KEY, addAgentCapIndex, agentVaultReader, parseAgentCapIndex, parseAgentLabels, readAgentCapIndex,
  readAgentEpoch, removeAgentCapIndex, type AgentEpochInfo, type AgentVaultLabel,
} from "./agent-vault-chain"
import { buildAgentVaultViews } from "./agent-vault-view"
import { t } from "@/lib/i18n/t"
import type { AgentVaultView, UnverifiedAgentCap } from "@/types/agent"

export interface AgentVaultPageState {
  account: string | null
  loading: boolean
  error: string
  vaults: AgentVaultView[]
  unverified: UnverifiedAgentCap[]
  epoch: AgentEpochInfo | null
  epochError: string
  errors: string[]
  labels: Record<string, AgentVaultLabel>
}

function readIndex(): { ids: string[]; error: string } {
  try { return readAgentCapIndex(localStorage.getItem(AGENT_CAP_INDEX_KEY)) }
  catch { return { ids: [], error: t("agents.chain.storageUnavailableCards") } }
}
function readLabels(): Record<string, AgentVaultLabel> {
  try { return parseAgentLabels(localStorage.getItem(AGENT_LABEL_KEY)) } catch { return {} }
}

export function rememberAgentCap(capId: string) {
  try {
    const next = addAgentCapIndex(parseAgentCapIndex(localStorage.getItem(AGENT_CAP_INDEX_KEY)), capId)
    localStorage.setItem(AGENT_CAP_INDEX_KEY, JSON.stringify(next))
  } catch { /* the cap is still verified on chain; only discovery is lost in this browser */ }
}

export function forgetAgentCap(capId: string) {
  try {
    const next = removeAgentCapIndex(parseAgentCapIndex(localStorage.getItem(AGENT_CAP_INDEX_KEY)), capId)
    localStorage.setItem(AGENT_CAP_INDEX_KEY, JSON.stringify(next))
  } catch { /* ignore */ }
}

export function saveAgentLabel(label: AgentVaultLabel): Record<string, AgentVaultLabel> {
  const records = Object.values(readLabels())
  const next = [label, ...records.filter(record => record.capId !== label.capId)]
  try { localStorage.setItem(AGENT_LABEL_KEY, JSON.stringify(next)) } catch { /* label stays in memory for this view */ }
  return parseAgentLabels(JSON.stringify(next))
}

export function useAgentVault() {
  const [state, setState] = useState<AgentVaultPageState>({
    account: null, loading: true, error: "", vaults: [], unverified: [], epoch: null, epochError: "", errors: [], labels: {},
  })
  const generation = useRef(0)
  const mounted = useRef(true)

  const load = useCallback(async () => {
    const run = ++generation.current
    const active = getActiveAccount()
    if (!active || !/^0x[0-9a-fA-F]{64}$/.test(active.address)) {
      setState({ account: null, loading: false, error: "", vaults: [], unverified: [], epoch: null, epochError: "", errors: [], labels: readLabels() })
      return
    }
    const labels = readLabels()
    const index = readIndex()
    setState(current => ({ ...current, account: active.address, loading: true, error: "", labels }))
    try {
      const [snapshot, epoch] = await Promise.all([
        agentVaultReader.snapshot(active.address, index.ids),
        readAgentEpoch(agentVaultReader.client).catch(error => error instanceof Error ? error : new Error(t("agents.chain.epochReadFailed"))),
      ])
      if (run !== generation.current || !mounted.current) return
      const { vaults, unverified } = buildAgentVaultViews(snapshot, labels)
      const epochInfo = epoch instanceof Error ? null : epoch
      setState({
        account: active.address, loading: false, error: "",
        vaults, unverified, epoch: epochInfo,
        epochError: epoch instanceof Error ? epoch.message : "",
        // A corrupt local index is reported next to the chain errors: an empty
        // list must not also mean "the index could not be read".
        errors: index.error ? [...snapshot.errors, index.error] : snapshot.errors, labels,
      })
    } catch (error) {
      if (run !== generation.current || !mounted.current) return
      setState({
        account: active.address, loading: false, labels,
        error: error instanceof Error ? error.message : t("agents.chain.vaultReadFailed"),
        vaults: [], unverified: [], epoch: null, epochError: "", errors: [],
      })
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    void load()
    const sync = () => { void load() }
    window.addEventListener("sui-account-switched", sync)
    window.addEventListener("sui-account-changed", sync)
    window.addEventListener("storage", sync)
    const invalidate = () => { generation.current++ }
    return () => {
      mounted.current = false
      invalidate()
      window.removeEventListener("sui-account-switched", sync)
      window.removeEventListener("sui-account-changed", sync)
      window.removeEventListener("storage", sync)
    }
  }, [load])

  return { ...state, reload: load, setLabels: (labels: Record<string, AgentVaultLabel>) => setState(current => ({ ...current, labels })) }
}

/** Shared "remaining budget for this epoch" projection used by the page and dialogs. */
export function remainingBudget(cap: { dailyBudgetUnits: bigint; effectiveSpentUnits: bigint }): bigint {
  return cap.dailyBudgetUnits > cap.effectiveSpentUnits ? cap.dailyBudgetUnits - cap.effectiveSpentUnits : 0n
}
