import type { Locale } from "./locale-store"

/** One translation domain: the same keys for every locale. */
export type Domain = Record<Locale, Record<string, string>>
