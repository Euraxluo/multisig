"use client"

import { useEffect, useState } from "react"
import { UserRound } from "lucide-react"
import type { IdentityProfile } from "@/lib/identity-client"
import { useI18n } from "@/components/i18n-provider"

export function safeAvatar(url: string) {
  try { return new URL(url).protocol === "https:" ? url : undefined } catch { return undefined }
}

export function IdentityAvatar({ profile, size = "md" }: { profile: IdentityProfile; size?: "sm" | "md" }) {
  const { t } = useI18n()
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [profile.avatarUrl])
  const sizeClass = size === "sm" ? "h-7 w-7" : "h-12 w-12"
  return safeAvatar(profile.avatarUrl) && !failed
    // `next/image` requires every remote host to be listed in `images.remotePatterns`
    // at build time. An avatar URL is supplied per identity, so its host is unknown
    // until runtime; the URL is already restricted to https by `safeAvatar` above.
    // eslint-disable-next-line @next/next/no-img-element
    ? <img src={profile.avatarUrl} referrerPolicy="no-referrer" alt={t("misc.avatar.alt", { name: profile.displayName || profile.label })} onError={() => setFailed(true)} className={`${sizeClass} shrink-0 rounded-full object-cover`} />
    : <div className={`flex ${sizeClass} shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary`}><UserRound className={size === "sm" ? "h-3.5 w-3.5" : "h-6 w-6"} /></div>
}
