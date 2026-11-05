import Link from "next/link"
import { ArrowLeft } from "lucide-react"
import { WalrusPolicyRegistry } from "@/components/walrus-policy-registry"
import { cookies } from "next/headers"
import { translate } from "@/lib/i18n/translate"

export async function generateMetadata() {
  const saved = (await cookies()).get("sui_locale")?.value
  const locale = saved === "zh" ? "zh" : "en"
  return {
    title: translate(locale, "shell.walrusMetaTitle"),
    description: translate(locale, "shell.walrusMetaDescription"),
  }
}

export default async function WalrusPage() {
  const saved = (await cookies()).get("sui_locale")?.value
  const locale = saved === "zh" ? "zh" : "en"
  return (
    <main className="mx-auto min-h-screen w-full max-w-lg px-3 pb-16 pt-6 md:px-5">
      <div className="mb-4 flex items-center gap-2">
        <Link
          href="/"
          aria-label={translate(locale, "shell.backHome")}
          className="flex h-9 w-9 items-center justify-center rounded-full bg-muted transition-colors hover:bg-accent"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <h1 className="text-xl font-bold">{translate(locale, "shell.walrusTitle")}</h1>
      </div>
      <WalrusPolicyRegistry />
    </main>
  )
}
