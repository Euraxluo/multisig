"use client"

import type { Transaction } from "@mysten/sui/transactions"
import { acknowledgePendingTransaction } from "./pending-transactions"
import { getTransactionAccount, signAndExecuteWithWallet, type WalletTransactionDependencies, type WalletTransactionResult } from "./sui-wallet-signer"
import { t } from "@/lib/i18n/t"

export interface AgentTransactionInput {
  action: string
  scope: string
  metadata?: Record<string, string>
  /**
   * Creation flows resolve created objects after this call; they defer the
   * pending-lock release until that resolution (and owner verification)
   * succeeds, so a UI failure cannot be mistaken for an unconfirmed
   * transaction. The caller MUST acknowledge `result.receipt` or surface the
   * digest, exactly as this function does on the immediate path.
   */
  deferAcknowledgement?: boolean
}

/**
 * Sign with the selected identity, then release the pending lock only after the
 * confirmed result is in hand. If releasing fails, the digest is still surfaced:
 * the transaction is already on chain and must not be silently retried.
 */
export async function submitAgentTransaction(tx: Transaction, input: AgentTransactionInput, dependencies: WalletTransactionDependencies = {}): Promise<WalletTransactionResult> {
  const account = getTransactionAccount()
  const result = await signAndExecuteWithWallet(tx, {
    action: input.action, scope: input.scope, expectedAccount: account, metadata: input.metadata,
  }, dependencies)
  if (input.deferAcknowledgement) return result
  try {
    acknowledgePendingTransaction(result.receipt)
  } catch (error) {
    throw new Error(t("agents.txConfirmedLockStuck", { digest: result.digest }) + (error instanceof Error ? error.message : t("agents.storageUnavailable")))
  }
  return result
}

/**
 * Release the pending lock of a deferred submission after created-object
 * resolution succeeded. Same error contract as the immediate path: the digest
 * is surfaced because the transaction is already on chain.
 */
export function acknowledgeAgentTransaction(result: WalletTransactionResult): void {
  try {
    acknowledgePendingTransaction(result.receipt)
  } catch (error) {
    throw new Error(t("agents.txConfirmedLockStuck", { digest: result.digest }) + (error instanceof Error ? error.message : t("agents.storageUnavailable")))
  }
}
