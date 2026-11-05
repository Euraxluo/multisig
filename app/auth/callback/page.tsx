"use client"

import { useEffect, useRef, useState } from "react"
import Link from "next/link"
import { completeGoogleZkLogin } from "@/lib/zklogin"
import { useI18n } from "@/components/i18n-provider"

export default function ZkLoginCallbackPage() {
  const { t } = useI18n()
  const started = useRef(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (started.current) return
    started.current = true
    const fragment = window.location.hash
    // Strip credentials immediately; do not retain them in history, logs or storage.
    window.history.replaceState(null, "", "/auth/callback")
    completeGoogleZkLogin(fragment).then(() => {
      window.location.replace("/")
    }).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : t("misc.auth.failed"))
    })
  }, [])

  return (
    <main className="min-h-screen flex items-center justify-center p-6 bg-background text-foreground">
      <div className="w-full max-w-md rounded-2xl border p-6 space-y-4">
        <h1 className="text-xl font-semibold">Google zkLogin</h1>
        {error ? <>
          <p role="alert" className="text-sm text-destructive">{error}</p>
          <Link href="/" className="inline-block text-sm underline">{t("misc.auth.backHome")}</Link>
        </> : <p role="status" className="text-sm text-muted-foreground">{t("misc.auth.processing")}</p>}
      </div>
    </main>
  )
}
