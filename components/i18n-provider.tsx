"use client"

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { detectLocale, persistLocale, setStoreLocale, type Locale } from "@/lib/i18n/locale-store"
import { translate, type TranslateParams } from "@/lib/i18n/translate"

type I18nValue = {
  locale: Locale
  setLocale: (locale: Locale) => void
  t: (key: string, params?: TranslateParams) => string
}

const I18nContext = createContext<I18nValue | null>(null)

/**
 * Holds the active locale. `initialLocale` comes from the `sui_locale` cookie on
 * the server, so the first paint already matches the user's saved choice. After
 * hydration, a first-time visitor is upgraded to their browser language.
 */
export function I18nProvider({ initialLocale, children }: { initialLocale: Locale; children: React.ReactNode }) {
  const router = useRouter()
  const [locale, setLocaleState] = useState<Locale>(initialLocale)

  // First boot only: an explicit saved choice or the browser language overrides
  // the SSR default ("en"). Runs after hydration so server and client markup
  // stay identical and no hydration warning is possible.
  useEffect(() => {
    const detected = detectLocale()
    if (detected !== initialLocale) {
      setStoreLocale(detected)
      setLocaleState(detected)
      persistLocale(detected)
    }
  }, [initialLocale]) // eslint-disable-line react-hooks/exhaustive-deps

  // Keep <html lang> and the non-React store in sync with the rendered locale.
  useEffect(() => {
    setStoreLocale(locale)
    document.documentElement.lang = locale === "zh" ? "zh-CN" : "en"
  }, [locale])

  const setLocale = useCallback(
    (next: Locale) => {
      setStoreLocale(next) // before setState so this render pass sees new text
      setLocaleState(next)
      persistLocale(next)
      // Refresh server-rendered segments (layout metadata, /trust and /walrus
      // page headers) so they follow the new cookie without a manual reload.
      router.refresh()
    },
    [router],
  )

  const t = useCallback((key: string, params?: TranslateParams) => translate(locale, key, params), [locale])

  const value = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t])

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext)
  if (!value) throw new Error("useI18n must be used inside <I18nProvider>")
  return value
}
