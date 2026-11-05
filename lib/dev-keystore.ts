"use client"

/** Remove keys exported by older development builds without reading their values.
 * Keep public account metadata and pending receipts available for recovery.
 */
export function clearLegacyDevKeys(storage?: Pick<Storage, "removeItem">): void {
  if (!storage) {
    try { storage = globalThis.localStorage } catch { return }
  }
  if (!storage) return
  for (const key of ["sui_dev_accounts", "sui_active_dev_privkey"]) {
    try { storage.removeItem(key) } catch {}
  }
}
