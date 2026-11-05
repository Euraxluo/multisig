"use client"

import { useEffect, useRef, useState } from "react"
import { readWalletAssets, type WalletAsset } from "./wallet-data"
import { scheduledPaymentsReader } from "./scheduled-payments-chain"
import { getTransactionAccount } from "./sui-wallet-signer"
import { createAccountLoadGuard } from "./wallet-creation-state"
import { t } from "./i18n/t"

export function usePaymentAssets(open: boolean) {
  const [assets, setAssets] = useState<WalletAsset[]>([])
  const [assetOwnerKey, setAssetOwnerKey] = useState("")
  const [deploymentError, setDeploymentError] = useState<string | null>(null)
  const guard = useRef(createAccountLoadGuard())
  useEffect(() => {
    if (!open) return
    const active = () => { try { return getTransactionAccount() } catch { return null } }
    const load = async () => {
      const account = active()
      const request = guard.current.begin(account, active)
      setAssets([])
      setAssetOwnerKey("")
      setDeploymentError(null)
      try {
        if (!account) throw new Error(t("payments.errConnectWalletFirst"))
        const [walletAssets] = await Promise.all([readWalletAssets(account.address), scheduledPaymentsReader.requireDeployment()])
        if (!request.current()) return
        setAssets(walletAssets.filter(asset => asset.decimals !== null))
        setAssetOwnerKey(request.ownerKey)
      } catch (error) {
        if (request.current()) setDeploymentError(error instanceof Error ? error.message : t("payments.errCannotReadPaymentConfig"))
      }
    }
    void load()
    window.addEventListener("storage", load)
    window.addEventListener("sui-account-switched", load)
    window.addEventListener("sui-account-changed", load)
    const invalidate = () => { guard.current.invalidate() }
    return () => { invalidate(); window.removeEventListener("storage", load); window.removeEventListener("sui-account-switched", load); window.removeEventListener("sui-account-changed", load) }
  }, [open])
  return { assets, assetOwnerKey, deploymentError }
}
