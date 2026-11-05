"use client"

// Resolves the protocol identity (and therefore the on-chain avatar) for a
// bounded set of member addresses. Identity is an optional overlay: when the
// package is not configured, or a member never minted an identity, the caller
// keeps its local fallback instead of inventing a profile.
import { useEffect, useMemo, useRef, useState } from "react"
import { getIdentityByAddress, identityConfigured, type IdentityProfile } from "@/lib/identity-client"
import { t } from "./i18n/t"

const CONCURRENCY = 4
const MAX_ADDRESSES = 50

export function useMemberProfiles(addresses: string[]) {
  const [profiles, setProfiles] = useState<Record<string, IdentityProfile>>({})
  const [failed, setFailed] = useState<Record<string, string>>({})
  const epoch = useRef(0)
  // Normalize and de-duplicate so an inline array literal does not refetch on
  // every render; the key is the sorted, lower-cased address list.
  const key = useMemo(() => [...new Set(addresses.map(value => value.trim().toLowerCase()).filter(Boolean))].sort().join(","), [addresses])

  useEffect(() => {
    const run = ++epoch.current
    setProfiles({}); setFailed({})
    const list = key ? key.split(",").slice(0, MAX_ADDRESSES) : []
    if (!list.length || !identityConfigured()) return
    let cancelled = false
    void (async () => {
      const next: Record<string, IdentityProfile> = {}
      const errors: Record<string, string> = {}
      for (let index = 0; index < list.length; index += CONCURRENCY) {
        const batch = list.slice(index, index + CONCURRENCY)
        const results = await Promise.all(batch.map(async address => {
          try { return { address, profile: await getIdentityByAddress(address), error: "" } }
          catch (error) { return { address, profile: null, error: error instanceof Error ? error.message : t("misc.memberProfiles.readFailed") } }
        }))
        for (const result of results) {
          if (result.error) errors[result.address] = result.error
          else if (result.profile) next[result.address] = result.profile
        }
        if (cancelled || run !== epoch.current) return
        setProfiles({ ...next }); setFailed({ ...errors })
      }
    })()
    const invalidate = () => { epoch.current++ }
    return () => { cancelled = true; invalidate() }
  }, [key])

  return { profiles, failed }
}
