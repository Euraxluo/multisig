"use client"

// Lazy loader for channel-scoped AI posting delegations. It runs only while the
// AI tab is open and a verified channel is loaded.
import { useCallback, useEffect, useRef, useState } from "react"
import { messagingCaps, type MessagingCapList } from "./group-messaging-caps"
import { t } from "@/lib/i18n/t"

export function useGroupMessagingCaps(open: boolean, channelId: string) {
  const [data, setData] = useState<MessagingCapList | null>(null)
  const [loadedChannel, setLoadedChannel] = useState("")
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)
  const generation = useRef(0)

  const reload = useCallback(async () => {
    const run = ++generation.current
    setLoadedChannel(channelId); setData(null); setError(""); setLoading(!!channelId)
    if (!open || !channelId) { setLoading(false); return }
    try {
      const result = await messagingCaps.listCapabilities(channelId)
      if (run === generation.current) setData(result)
    } catch (cause) {
      if (run === generation.current) setError(cause instanceof Error ? cause.message : t("groups.readMessagingCapsFailed"))
    } finally {
      if (run === generation.current) setLoading(false)
    }
  }, [open, channelId])

  useEffect(() => {
    void reload()
    const invalidate = () => { generation.current++ }
    return () => { invalidate() }
  }, [reload])

  return { data: loadedChannel === channelId ? data : null, error: loadedChannel === channelId ? error : "", loading: loadedChannel === channelId ? loading : !!channelId, reload }
}
