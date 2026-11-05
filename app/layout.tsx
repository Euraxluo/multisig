import type React from "react"
import type { Metadata } from "next"
import { cookies } from "next/headers"
import { ThemeProvider } from "@/components/theme-provider"
import { I18nProvider } from "@/components/i18n-provider"
import { translate } from "@/lib/i18n/translate"
import type { Locale } from "@/lib/i18n/locale-store"
import "./globals.css"

/** The `sui_locale` cookie is the SSR source of truth; default is English. */
async function localeFromCookies(): Promise<Locale> {
  const store = await cookies()
  const saved = store.get("sui_locale")?.value
  return saved === "zh" ? "zh" : "en"
}

export async function generateMetadata(): Promise<Metadata> {
  const locale = await localeFromCookies()
  return {
    title: translate(locale, "shell.metaTitle"),
    description: translate(locale, "shell.metaDescription"),
  }
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  const initialLocale = await localeFromCookies()
  return (
    // suppressHydrationWarning: next-themes writes the resolved theme class and
    // the i18n provider updates `lang` before hydration, so the server and
    // client markup legitimately differ.
    <html lang={initialLocale === "zh" ? "zh-CN" : "en"} suppressHydrationWarning>
      <body>
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
          <I18nProvider initialLocale={initialLocale}>{children}</I18nProvider>
        </ThemeProvider>
      </body>
    </html>
  )
}
