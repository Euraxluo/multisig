import { Transaction } from "@mysten/sui/transactions"
import { isValidSuiAddress, normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils"
import { paymentUnits } from "./scheduled-payments-chain"
import { t } from "./i18n/t"
import type { WalletAsset } from "./wallet-data"

/** Use published coin units and exact decimals; a symbol is never a coin identity. */
export function directPaymentUnits(amount: string, asset: WalletAsset): bigint {
  if (asset.decimals === null) throw new Error(t("payments.errNoDecimals"))
  const units = paymentUnits(amount.trim(), asset.decimals)
  if (units > asset.rawBalance) throw new Error(t("payments.errInsufficientBalanceWithGas"))
  return units
}

export function buildDirectCoinPayment(sender: string, recipient: string, coinType: string, units: bigint): Transaction {
  if (!isValidSuiAddress(sender) || !isValidSuiAddress(recipient) || BigInt(recipient) === 0n || units < 1n || units > (1n << 64n) - 1n) throw new Error(t("payments.errInvalidAddressOrAmount"))
  const tx = new Transaction()
  tx.setSender(normalizeSuiAddress(sender))
  const coin = tx.coin({ type: normalizeStructTag(coinType), balance: units })
  tx.transferObjects([coin], tx.pure.address(recipient))
  return tx
}

export interface BatchRecipientTransfer {
  recipient: string
  units: bigint
}

export function buildDirectBatchPayment(
  sender: string,
  coinType: string,
  transfers: BatchRecipientTransfer[]
): Transaction {
  if (!isValidSuiAddress(sender) || BigInt(sender) === 0n) throw new Error(t("payments.errInvalidSender"))
  if (!Array.isArray(transfers) || transfers.length === 0) throw new Error(t("payments.errBatchNeedsRecipient"))
  const tx = new Transaction()
  tx.setSender(normalizeSuiAddress(sender))
  const normCoinType = normalizeStructTag(coinType)
  for (const transfer of transfers) {
    if (!isValidSuiAddress(transfer.recipient) || BigInt(transfer.recipient) === 0n || transfer.units < 1n || transfer.units > (1n << 64n) - 1n) {
      throw new Error(t("payments.errInvalidRecipientOrAmount", { recipient: transfer.recipient }))
    }
    const coin = tx.coin({ type: normCoinType, balance: transfer.units })
    tx.transferObjects([coin], tx.pure.address(normalizeSuiAddress(transfer.recipient)))
  }
  return tx
}
