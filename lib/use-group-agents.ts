"use client"

// Lazy loader for the group AI tab. It only runs when the tab is open and a
// verified organization id is available, so opening a group never triggers an
// unrelated event scan.
import { useCallback, useEffect, useRef, useState } from "react"
import { groupAgents, type GroupAgentList } from "./group-agents"
import { t } from "@/lib/i18n/t"

export function useGroupAgents(open: boolean, orgId: string) {
  const [data, setData] = useState<GroupAgentList | null>(null)
  const [loadedOrg, setLoadedOrg] = useState("")
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)
  const generation = useRef(0)

  const reload = useCallback(async () => {
    const run = ++generation.current
    setLoadedOrg(orgId); setData(null); setError(""); setLoading(!!orgId)
    if (!open || !orgId) { setLoading(false); return }
    try {
      const result = await groupAgents.listDelegations(orgId)
      if (run === generation.current) setData(result)
    } catch (cause) {
      if (run === generation.current) setError(cause instanceof Error ? cause.message : t("agents.ga.listFailed"))
    } finally {
      if (run === generation.current) setLoading(false)
    }
  }, [open, orgId])

  useEffect(() => {
    void reload()
    const invalidate = () => { generation.current++ }
    return () => { invalidate() }
  }, [reload])

  return { data: loadedOrg === orgId ? data : null, error: loadedOrg === orgId ? error : "", loading: loadedOrg === orgId ? loading : !!orgId, reload }
}
