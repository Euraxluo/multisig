"use client"

import { useEffect, useState } from "react"
import { assertTransactionAccount, getTransactionAccount, resumePendingTransaction, type WalletTransactionResult } from "./sui-wallet-signer"
import { getPendingTransaction, transactionAccountKey, type PendingTransactionReceipt, type TransactionAccount } from "./pending-transactions"

export function usePendingCreation(open: boolean, action: string, scope: string) {
  const [pending, setPending] = useState<PendingTransactionReceipt>()
  const [receiptError, setReceiptError] = useState<string>()
  const [owner, setOwner] = useState("")
  useEffect(() => {
    if (!open) return
    const sync = () => {
      try {
        const account = getTransactionAccount()
        setOwner(transactionAccountKey(account))
        setPending(getPendingTransaction({ account, action, scope }))
        setReceiptError(undefined)
      } catch (error) {
        setPending(undefined)
        setReceiptError(error instanceof Error ? error.message : "无法读取待确认交易。")
      }
    }
    sync()
    window.addEventListener("sui-account-switched", sync)
    window.addEventListener("sui-account-changed", sync)
    window.addEventListener("storage", sync)
    return () => { window.removeEventListener("sui-account-switched", sync); window.removeEventListener("sui-account-changed", sync); window.removeEventListener("storage", sync) }
  }, [open, action, scope])
  return {
    pending, setPending, receiptError,
    blocked: !!receiptError || (!!pending && transactionAccountKey(pending.account) === owner),
    async resume(account: TransactionAccount): Promise<WalletTransactionResult> {
      if (!pending) throw new Error("没有可恢复的待确认交易。")
      assertTransactionAccount(account)
      if (transactionAccountKey(account) !== transactionAccountKey(pending.account)) throw new Error("请切回原签名账户与钱包后恢复。")
      return resumePendingTransaction(pending)
    },
  }
}
