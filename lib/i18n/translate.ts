import { messages } from "./dictionaries"
import type { Locale } from "./locale-store"

export type TranslateParams = Record<string, string | number | bigint>

/**
 * Pure lookup — safe in server components (pass an explicit locale) and in
 * client render. Fallback chain: locale → en → zh → the raw key, so a missing
 * entry degrades visibly instead of crashing. `{{name}}` placeholders
 * interpolate from params.
 */
export function translate(locale: Locale, key: string, params?: TranslateParams): string {
  let text = messages[locale][key] ?? messages.en[key] ?? messages.zh[key] ?? key
  if (params) {
    text = text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, name: string) => String(params[name] ?? ""))
  }
  return text
}
