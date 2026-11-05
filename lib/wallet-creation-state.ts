import { transactionAccountKey, type TransactionAccount } from "./pending-transactions"
import { t } from "./i18n/t"

/** Every new load invalidates all earlier loads, including those for the same address. */
export function createAccountLoadGuard() {
  let generation = 0
  return {
    invalidate: () => { generation++ },
    begin(account: TransactionAccount | null, readActive: () => TransactionAccount | null) {
      const version = ++generation
      const ownerKey = transactionAccountKey(account)
      return { ownerKey, current: () => version === generation && ownerKey === transactionAccountKey(readActive()) }
    },
  }
}
export function assertAssetOwner(ownerKey: string, account: TransactionAccount | null): asserts account is TransactionAccount {
  if (!account || !ownerKey || ownerKey !== transactionAccountKey(account)) throw new Error(t("misc.creation.accountSwitched"))
}
/** A synchronous guard closes the gap before React commits a disabled button. */
export function createSubmissionGuard() {
  let busy = false
  return {
    enter() { if (busy) return false; busy = true; return true },
    leave() { busy = false },
  }
}
