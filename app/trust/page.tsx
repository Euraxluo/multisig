import Link from "next/link"
import { ArrowLeft } from "lucide-react"
import { PrivacyNotice } from "@/components/privacy-notice"
import { cookies } from "next/headers"
import { translate } from "@/lib/i18n/translate"

export async function generateMetadata() {
  const saved = (await cookies()).get("sui_locale")?.value
  const locale = saved === "zh" ? "zh" : "en"
  return {
    title: translate(locale, "shell.trustMetaTitle"),
    description: translate(locale, "shell.trustMetaDescription"),
  }
}

export default async function TrustPage() {
  const saved = (await cookies()).get("sui_locale")?.value
  const locale = saved === "zh" ? "zh" : "en"
  return (
    <main className="mx-auto min-h-screen w-full max-w-lg px-3 pb-16 pt-6 md:px-5">
      <div className="mb-1 flex items-center gap-2">
        <Link
          href="/"
          aria-label={translate(locale, "shell.backHome")}
          className="flex h-9 w-9 items-center justify-center rounded-full bg-muted transition-colors hover:bg-accent"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <h1 className="text-xl font-bold">{translate(locale, "shell.trustTitle")}</h1>
      </div>
      <p className="mb-4 pl-11 text-sm text-muted-foreground">
        {translate(locale, "shell.trustSubtitle")}
      </p>
      <PrivacyNotice />
    </main>
  )
}
