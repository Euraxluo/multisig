"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { groupVaults, type GroupVaultList } from "./group-vaults"
import { t } from "@/lib/i18n/t"

export function useGroupVaults(open: boolean, orgId: string) {
  const [data, setData] = useState<GroupVaultList | null>(null)
  const [loadedOrg, setLoadedOrg] = useState("")
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)
  const generation = useRef(0)
  const context = useRef({ open, orgId })
  context.current = { open, orgId }
  const reload = useCallback(async () => {
    const run = ++generation.current
    const current = () => run === generation.current && context.current.open && context.current.orgId === orgId
    setLoadedOrg(orgId); setData(null); setError(""); setLoading(!!orgId)
    if (!open || !orgId) { setLoading(false); return }
    try {
      const result = await groupVaults.listVaults(orgId)
      if (current()) setData(result)
    } catch (cause) { if (current()) setError(cause instanceof Error ? cause.message : t("groups.readVaultsFailed")) }
    finally { if (current()) setLoading(false) }
  }, [open, orgId])
  useEffect(() => {
    void reload()
    const refresh = () => { void reload() }
    window.addEventListener("sui-vaults-updated", refresh)
    const invalidate = () => { generation.current++ }
    return () => { invalidate(); window.removeEventListener("sui-vaults-updated", refresh) }
  }, [reload])
  return { data: loadedOrg === orgId ? data : null, error: loadedOrg === orgId ? error : "", loading: loadedOrg === orgId ? loading : !!orgId, reload }
}
