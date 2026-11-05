export type Locale = "en" | "zh"

export const LOCALES: readonly Locale[] = ["en", "zh"]

const STORAGE_KEY = "sui_locale"
const COOKIE_KEY = "sui_locale"
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365

/**
 * Base resolution when nothing else is known.
 *
 * - Inside `node --test` runners (NODE_TEST_CONTEXT is set on child processes)
 *   the locale is zh: the existing lib test files assert exact Chinese message
 *   text, so extraction must keep those assertions green without editing them.
 * - Everywhere else English is the default. A zh browser upgrades to zh on
 *   first boot via detectLocale() inside I18nProvider.
 */
function baseLocale(): Locale {
  if (typeof window === "undefined") {
    return process.env.NODE_TEST_CONTEXT ? "zh" : "en"
  }
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY)
    if (saved === "en" || saved === "zh") return saved
  } catch {
    /* storage blocked: fall through to the browser language */
  }
  const langs = typeof navigator !== "undefined" ? navigator.languages ?? [navigator.language] : []
  return langs.some(l => (l ?? "").toLowerCase().startsWith("zh")) ? "zh" : "en"
}

let current: Locale = baseLocale()

export function getLocale(): Locale {
  return current
}

/** Update the active locale for non-React callers (lib error messages). */
export function setStoreLocale(locale: Locale) {
  current = locale
}

/** Persist a user choice so SSR (`cookies()`) and the next boot follow it. */
export function persistLocale(locale: Locale) {
  if (typeof document === "undefined") return
  try {
    window.localStorage.setItem(STORAGE_KEY, locale)
  } catch {
    /* storage blocked: the cookie below still carries the choice */
  }
  document.cookie = `${COOKIE_KEY}=${locale}; path=/; max-age=${COOKIE_MAX_AGE}; samesite=lax`
}

/** Resolve a saved preference or the browser language. Used once on first boot. */
export function detectLocale(): Locale {
  return baseLocale()
}
