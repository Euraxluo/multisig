"use client"

import { Transaction } from "@mysten/sui/transactions"
import { getActiveDevKeypair } from "./dev-keystore"

export const TESTNET_PACKAGE_ID = "0x83fb785f1da119aea4e0faa19d1466b33899e14ea730af6425ec7d5557cb5a36"

/**
 * 由活跃账户直接签名并提交交易：
 * 1. 若当前切换至开发/测试 Keystore 账户，使用纯客户端本地 Keypair 自动签名（赋能 Agent 全自动化测试与多用户模拟）。
 * 2. 否则通过 Sui Wallet Standard 唤起用户浏览器扩展钱包（Slush, OKX, Sui Wallet 等）签名。
 */
export async function signAndExecuteWithWallet(tx: Transaction): Promise<{
  digest: string
  createdObjects: string[]
}> {
  // 1. 优先检查是否有本地 Keystore 活跃密钥对（用于开发与 Agent 自动化多角色测试）
  const devKeypair = getActiveDevKeypair()
  if (devKeypair) {
    try {
      const { SuiJsonRpcClient } = await import("@mysten/sui/jsonRpc") as any
      const client = new SuiJsonRpcClient({
        url: "https://fullnode.testnet.sui.io:443",
        network: "testnet",
      })

      const res = await client.signAndExecuteTransaction({
        signer: devKeypair,
        transaction: tx,
        options: { showEffects: true },
      })

      const digest = res?.digest
      if (!digest) throw new Error("Keystore 签名提交未返回 digest")

      const effects = (res as any)?.effects?.effects ?? (res as any)?.effects
      const created = (effects?.created ?? [])
        .map((o: any) => o?.reference?.objectId ?? o?.objectId)
        .filter(Boolean)

      return { digest, createdObjects: created }
    } catch (e: any) {
      console.warn("[sui-wallet-signer] Dev keystore signing error, trying wallet standard fallback:", e)
    }
  }

  // 2. 通过 Sui Wallet Standard 由浏览器扩展钱包签名
  const { getWallets } = await import("@mysten/wallet-standard")
  const walletsApi = getWallets()
  const all = walletsApi.get()

  const wallet = all.find(
    (w: any) => w.features?.["sui:signAndExecuteTransaction"] || w.features?.["sui:signAndExecuteTransactionBlock"]
  )
  if (!wallet) {
    throw new Error("未检测到支持签名的 Sui 钱包。可在连接菜单选择「本机 Keystore 多账户模拟」进行测试。")
  }

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
  const client = new SuiJsonRpcClient({ url: "https://fullnode.testnet.sui.io:443", network: "testnet" })
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
