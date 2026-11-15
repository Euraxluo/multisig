import { explainAbort } from "multisig/agent-vault/org"

/**
 * Extracts a human-readable message from a caught value.
 *
 * `catch` binds `unknown` on purpose: a thrown value is not required to be an
 * Error, and typing the binding as `any` silently accepts a bare string, a
 * rejected response object, or `undefined` while hiding every property access
 * from the compiler. Callers pass the binding here instead of reaching for
 * `.message`, so the one place that decides how a non-Error is rendered stays
 * auditable.
 *
 * MoveAbort payloads from wallet executions are translated through the SDK
 * error table (`explainAbort`, codes 3001–3029 and every other module) before
 * the raw substatus is shown, so users see the abort reason in readable form
 * instead of the raw "UserSubstatus(ModuleAddress(...))" string.
 */
export function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return withAbortExplanation(error.message)
  if (typeof error === "string" && error) return withAbortExplanation(error)
  return fallback
}

/** Appends the translated abort code to a raw MoveAbort error string. */
export function withAbortExplanation(message: string): string {
  if (!message.includes("MoveAbort")) return message
  const explained = explainAbort(message)
  if (explained) return `${message}\n${explained}`
  // @mysten/sui >= 2.x formats the failure as
  // "MoveAbort, abort code: <code>, in '0xpkg::module::function'" — decode that
  // shape with the same module error tables when the SDK's own matcher misses.
  const m = message.match(/abort code:\s*(\d+).*?in\s+'(0x[0-9a-fA-F]+)::(\w+)/)
  if (!m) return message
  const named = explainAbort(`MoveAbort(UserSubstatus(ModuleAddress(${m[2]}), ${m[3]}, ${m[1]}))`)
  return named ? `${message}\n${named}` : message
}
