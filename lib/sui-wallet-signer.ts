"use client"

import { Transaction } from "@mysten/sui/transactions"

export const TESTNET_PACKAGE_ID = "0x83fb785f1da119aea4e0faa19d1466b33899e14ea730af6425ec7d5557cb5a36"

/**
 * 通过 Sui Wallet Standard 由用户钱包直接签名并提交交易。无后端 relayer。
 */
export async function signAndExecuteWithWallet(tx: Transaction): Promise<{
  digest: string
  createdObjects: string[]
}> {
  const { getWallets } = await import("@mysten/wallet-standard")
  const walletsApi = getWallets()
  const all = walletsApi.get()

  const wallet = all.find(
    (w: any) => w.features?.["sui:signAndExecuteTransaction"] || w.features?.["sui:signAndExecuteTransactionBlock"]
  )
  if (!wallet) throw new Error("未检测到支持签名的 Sui 钱包")

  console.log("[sui-wallet-signer] wallets:", walletsApi.get().map((w: any) => ({ name: w.name, accounts: w.accounts?.length ?? 0, features: Object.keys(w.features || {}) })))
  console.log("[sui-wallet-signer] selected wallet:", wallet?.name, "accounts:", wallet?.accounts?.length ?? 0)
  let account = wallet.accounts?.[0]
  if (!account?.address) {
    const connectFeature: any = wallet.features?.["standard:connect"]
    if (!connectFeature) throw new Error(`${wallet.name} 未实现 standard:connect`)
    const res = await connectFeature.connect()
    const accounts = res?.accounts || wallet.accounts || []
    account = accounts[0]
    if (!account?.address) throw new Error(`${wallet.name} 连接后仍未返回账户地址`)
  }

  const feature: any =
    wallet.features["sui:signAndExecuteTransaction"] ||
    wallet.features["sui:signAndExecuteTransactionBlock"]
  const res = await feature.signAndExecuteTransaction({
    transaction: tx,
    account,
    chain: "sui:testnet",
  })

  const digest = res?.digest
  if (!digest) throw new Error("交易未返回 digest")

  const { SuiJsonRpcClient } = await import("@mysten/sui/jsonRpc") as any
  const client = new SuiJsonRpcClient({ url: "https://fullnode.testnet.sui.io:443" })
  const txResult = await client.getTransactionBlock({
    digest,
    options: { showEffects: true },
  })
  const effects = (txResult as any)?.effects?.effects ?? (txResult as any)?.effects
  const created = (effects?.created ?? [])
    .map((o: any) => o?.reference?.objectId ?? o?.objectId)
    .filter(Boolean)

  return { digest, createdObjects: created }
}
