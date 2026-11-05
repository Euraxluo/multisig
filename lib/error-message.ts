/**
 * Extracts a human-readable message from a caught value.
 *
 * `catch` binds `unknown` on purpose: a thrown value is not required to be an
 * Error, and typing the binding as `any` silently accepts a bare string, a
 * rejected response object, or `undefined` while hiding every property access
 * from the compiler. Callers pass the binding here instead of reaching for
 * `.message`, so the one place that decides how a non-Error is rendered stays
 * auditable.
 */
export function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === "string" && error) return error
  return fallback
}
