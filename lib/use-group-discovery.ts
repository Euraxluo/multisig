"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { getActiveAccount } from "./onchain-store"
import { discoverGroupsCached, type GroupDiscoveryResult } from "./group-discovery"
import { t } from "@/lib/i18n/t"

/**
 * Account-scoped group discovery shared by every group list.
 *
 * The cache and the in-flight dedupe live in `group-discovery.ts`, so the
 * dashboard and the profile menu share one scan per account.
 */
export interface GroupDiscoveryState {
  /** Null until a scan for the current account has completed. */
  data: GroupDiscoveryResult | null
  loading: boolean
  /** Set only when the whole scan failed; local groups remain visible regardless. */
  error: string
  address: string
  refresh: () => void
}

export function useGroupDiscovery(): GroupDiscoveryState {
  const [address, setAddress] = useState("")
  const [data, setData] = useState<GroupDiscoveryResult | null>(null)
  const [loadedAddress, setLoadedAddress] = useState("")
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)
  const [revision, setRevision] = useState(0)
  const generation = useRef(0)
  const forced = useRef(false)

  // The account lives in localStorage, so it is read on mount and on the same
  // events every other account-scoped reader listens to.
  useEffect(() => {
    const sync = () => setAddress(getActiveAccount()?.address ?? "")
    sync()
    window.addEventListener("sui-account-switched", sync)
    window.addEventListener("sui-account-changed", sync)
    window.addEventListener("storage", sync)
    return () => {
      window.removeEventListener("sui-account-switched", sync)
      window.removeEventListener("sui-account-changed", sync)
      window.removeEventListener("storage", sync)
    }
  }, [])

  useEffect(() => {
    const run = ++generation.current
    const current = () => run === generation.current
    if (!address) {
      setData(null); setLoadedAddress(""); setError(""); setLoading(false)
      return
    }
    setLoading(true); setError("")
    const force = forced.current
    forced.current = false
    discoverGroupsCached(address, force)
      .then(result => { if (current()) { setData(result); setLoadedAddress(address); setError("") } })
      .catch(cause => {
        if (!current()) return
        // A failed scan is reported as a failure, never as "no groups".
        setData(null); setLoadedAddress(address)
        setError(cause instanceof Error ? cause.message : t("groups.discoveryFailed"))
      })
      .finally(() => { if (current()) setLoading(false) })
    const invalidate = () => { generation.current++ }
    return () => { invalidate() }
  }, [address, revision])

  const refresh = useCallback(() => { forced.current = true; setRevision(value => value + 1) }, [])
  return {
    data: loadedAddress === address ? data : null,
    loading: loading && !!address,
    error: loadedAddress === address ? error : "",
    address,
    refresh,
  }
}
