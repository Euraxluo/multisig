import { getLocale } from "./locale-store"
import { translate, type TranslateParams } from "./translate"

/**
 * Locale-aware translate for non-React modules — lib error messages, notices
 * built outside components. Components must use `useI18n().t` instead so they
 * re-render when the locale changes.
 */
export function t(key: string, params?: TranslateParams): string {
  return translate(getLocale(), key, params)
}
