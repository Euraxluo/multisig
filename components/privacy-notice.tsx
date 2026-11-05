"use client"

// One place that answers "what does this app publish, and what stays here?"
//
// Before this panel the answer was scattered across individual dialogs, which
// meant a user could enable a feature without ever seeing the whole picture.
// Each row below states a fact that is true of the code as it stands — not an
// aspiration — and says which of the four states it is in. Where an entry is
// not the finished article (single-device keys, unaudited crypto, a memory-only
// relayer) it says so in the same sentence rather than in a footnote.
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Eye, Lock, ShieldQuestion } from "lucide-react"
import { useI18n } from "@/components/i18n-provider"

interface Fact {
  /** What the user does that produces this data. */
  action: string
  /** Where it ends up, in plain terms. */
  where: string
  tone: "public" | "private" | "local"
}

const FACTS: Array<{ actionKey: string; whereKey: string; tone: Fact["tone"] }> = [
  { actionKey: "factOnchainActions", whereKey: "factOnchainWhere", tone: "public" },
  { actionKey: "factChannelMessages", whereKey: "factChannelWhere", tone: "public" },
  { actionKey: "factEncryptedDm", whereKey: "factEncryptedDmWhere", tone: "private" },
  { actionKey: "factDkgCeremony", whereKey: "factDkgWhere", tone: "private" },
  { actionKey: "factDkgRoster", whereKey: "factDkgRosterWhere", tone: "public" },
  { actionKey: "factSsmChat", whereKey: "factSsmWhere", tone: "local" },
  { actionKey: "factLocalKeys", whereKey: "factLocalKeysWhere", tone: "local" },
  { actionKey: "factLocalDrafts", whereKey: "factLocalDraftsWhere", tone: "local" },
  { actionKey: "factWalletAddress", whereKey: "factWalletWhere", tone: "local" },
]

const TONE_ICONS = {
  public: Eye,
  private: Lock,
  local: ShieldQuestion,
} as const

const TONE_CLASS = {
  public: "border-amber-500/40 text-amber-700 dark:text-amber-400",
  private: "border-emerald-500/40 text-emerald-700 dark:text-emerald-400",
  local: "border-sky-500/40 text-sky-700 dark:text-sky-400",
} as const

export function PrivacyNotice() {
  const { t } = useI18n()
  const toneLabel = (tone: Fact["tone"]) =>
    tone === "public" ? t("privacy.tonePublic") : tone === "private" ? t("privacy.tonePrivate") : t("privacy.toneLocal")
  return (
    <Card className="border-none shadow-sm">
      <CardHeader className="p-4 pb-2">
        <h2 className="text-sm font-semibold">{t("privacy.title")}</h2>
        <p className="mt-1 text-xs text-muted-foreground">{t("privacy.intro")}</p>
      </CardHeader>
      <CardContent className="p-4 pt-1">
        <ul className="space-y-3">
          {FACTS.map(fact => {
            const ToneIcon = TONE_ICONS[fact.tone]
            return (
              <li key={fact.actionKey} className="rounded-lg border bg-muted/30 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <ToneIcon className="h-3.5 w-3.5 shrink-0" aria-hidden />
                  <span className="text-xs font-medium text-foreground">{t(`privacy.${fact.actionKey}`)}</span>
                  <Badge variant="outline" className={`ml-auto text-[10px] ${TONE_CLASS[fact.tone]}`}>{toneLabel(fact.tone)}</Badge>
                </div>
                <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{t(`privacy.${fact.whereKey}`)}</p>
              </li>
            )
          })}
        </ul>
        <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">{t("privacy.auditNote")}</p>
      </CardContent>
    </Card>
  )
}
