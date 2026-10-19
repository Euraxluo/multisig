"use client"

import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { Secp256k1Keypair } from "@mysten/sui/keypairs/secp256k1"
import { Secp256r1Keypair } from "@mysten/sui/keypairs/secp256r1"
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography"

export interface DevKeystoreAccount {
  name: string
  address: string
  privateKey: string
  schema: string
  role: string
  index: number
}

const STORAGE_ACCOUNTS_KEY = "sui_dev_accounts"
const STORAGE_ACTIVE_PRIVKEY = "sui_active_dev_privkey"

/**
 * 从 Next.js 本地 API 获取本机 Keystore 账户列表
 */
export async function fetchDevAccounts(): Promise<DevKeystoreAccount[]> {
  if (typeof window === "undefined") return []
  try {
    const res = await fetch("/api/dev/keystore")
    if (res.ok) {
      const data = await res.json()
      if (Array.isArray(data.accounts) && data.accounts.length > 0) {
        localStorage.setItem(STORAGE_ACCOUNTS_KEY, JSON.stringify(data.accounts))
        return data.accounts
      }
    }
  } catch (e) {
    console.debug("[dev-keystore] fetch error, using local cached accounts:", e)
  }

  // 读取本地缓存
  try {
    const cached = localStorage.getItem(STORAGE_ACCOUNTS_KEY)
    if (cached) return JSON.parse(cached)
  } catch {}

  return []
}

/**
 * 读取当前本地存储的 Keystore 账户列表
 */
export function getCachedDevAccounts(): DevKeystoreAccount[] {
  if (typeof window === "undefined") return []
  try {
    const raw = localStorage.getItem(STORAGE_ACCOUNTS_KEY)
    if (raw) return JSON.parse(raw)
  } catch {}
  return []
}

/**
 * 切换活跃开发者/测试账户
 */
export function switchDevAccount(account: DevKeystoreAccount): void {
  if (typeof window === "undefined") return
  try {
    const userAcc = {
      type: "keystore",
      address: account.address,
      identifier: account.name,
      provider: "Dev Keystore",
      authMethodLabel: `本机私钥 · ${account.schema}`,
    }
    localStorage.setItem("sui_active_account", JSON.stringify(userAcc))
    localStorage.setItem(STORAGE_ACTIVE_PRIVKEY, account.privateKey)

    // 广播账户切换通知
    window.dispatchEvent(new CustomEvent("sui-account-switched", { detail: userAcc }))
    window.dispatchEvent(new Event("storage"))
  } catch (e) {
    console.error("[dev-keystore] Failed to switch account:", e)
  }
}

/**
 * 获取当前活跃开发账户的私钥密钥对（用于无插件全自动模拟签名）
 */
export function getActiveDevKeypair(): any | null {
  if (typeof window === "undefined") return null
  try {
    const rawPriv = localStorage.getItem(STORAGE_ACTIVE_PRIVKEY)
    if (!rawPriv) return null

    // 如果是以 suiprivkey 开头的 Bech32 格式私钥
    if (rawPriv.startsWith("suiprivkey")) {
      const decoded = decodeSuiPrivateKey(rawPriv)
      if (decoded.schema === "ED25519") {
        return Ed25519Keypair.fromSecretKey(decoded.secretKey)
      } else if (decoded.schema === "Secp256k1") {
        return Secp256k1Keypair.fromSecretKey(decoded.secretKey)
      } else if (decoded.schema === "Secp256r1") {
        return Secp256r1Keypair.fromSecretKey(decoded.secretKey)
      }
    }

    // 兜底作为 Ed25519
    return Ed25519Keypair.fromSecretKey(rawPriv as any)
  } catch (e) {
    console.warn("[dev-keystore] Failed to construct keypair from active privkey:", e)
    return null
  }
}
