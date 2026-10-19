import { NextResponse } from "next/server"
import fs from "fs"
import path from "path"
import os from "os"
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { Secp256k1Keypair } from "@mysten/sui/keypairs/secp256k1"
import { Secp256r1Keypair } from "@mysten/sui/keypairs/secp256r1"

export interface DevKeystoreAccount {
  name: string
  address: string
  privateKey: string
  schema: string
  role: string
  index: number
}

/**
 * 确定性派生备用测试账户（确保在未初始化 ~/.sui 或云端沙箱时仍有 3 个开箱即用的多签成员）
 */
function getDeterministicDevAccounts(): DevKeystoreAccount[] {
  const members = [
    { name: "Agent-Alice (理事长)", seedChar: 0xaa, role: "Creator & Leader" },
    { name: "Agent-Bob (审计员)", seedChar: 0xbb, role: "Cosigner & Auditor" },
    { name: "Agent-Carol (执行官)", seedChar: 0xcc, role: "Threshold Cosigner" },
  ]

  return members.map((m, idx) => {
    const seed = new Uint8Array(32).fill(m.seedChar)
    const keypair = Ed25519Keypair.fromSecretKey(seed)
    return {
      name: m.name,
      address: keypair.toSuiAddress(),
      privateKey: keypair.getSecretKey(),
      schema: "ED25519",
      role: m.role,
      index: idx,
    }
  })
}

export async function GET() {
  try {
    const keystorePath = path.join(os.homedir(), ".sui", "sui_config", "sui.keystore")

    if (fs.existsSync(keystorePath)) {
      const content = fs.readFileSync(keystorePath, "utf-8")
      const parsedKeys: string[] = JSON.parse(content)

      if (Array.isArray(parsedKeys) && parsedKeys.length > 0) {
        const accounts: DevKeystoreAccount[] = []

        parsedKeys.forEach((b64Key, idx) => {
          try {
            const rawBytes = Buffer.from(b64Key, "base64")
            const schemeFlag = rawBytes[0]
            const privKeyBytes = rawBytes.subarray(1, 33)

            let keypair: any
            let schemaName = "ED25519"

            if (schemeFlag === 0) {
              keypair = Ed25519Keypair.fromSecretKey(privKeyBytes)
              schemaName = "ED25519"
            } else if (schemeFlag === 1) {
              keypair = Secp256k1Keypair.fromSecretKey(privKeyBytes)
              schemaName = "Secp256k1"
            } else if (schemeFlag === 2) {
              keypair = Secp256r1Keypair.fromSecretKey(privKeyBytes)
              schemaName = "Secp256r1"
            } else {
              // 默认尝试 Ed25519
              keypair = Ed25519Keypair.fromSecretKey(privKeyBytes)
            }

            accounts.push({
              name: `本机 Keystore #${idx + 1} (${schemaName})`,
              address: keypair.toSuiAddress(),
              privateKey: keypair.getSecretKey(),
              schema: schemaName,
              role: idx === 0 ? "Default Active (群发起人)" : `Member #${idx + 1}`,
              index: idx,
            })
          } catch (keyErr) {
            console.warn(`[dev-keystore] Failed to parse key at index ${idx}:`, keyErr)
          }
        })

        if (accounts.length > 0) {
          return NextResponse.json({
            success: true,
            source: "local_keystore",
            count: accounts.length,
            accounts,
          })
        }
      }
    }

    // 回退至内置确定性测试账户
    const fallback = getDeterministicDevAccounts()
    return NextResponse.json({
      success: true,
      source: "generated_dev_accounts",
      count: fallback.length,
      accounts: fallback,
    })
  } catch (error: any) {
    console.warn("[dev-keystore] Error loading keystore:", error.message)
    const fallback = getDeterministicDevAccounts()
    return NextResponse.json({
      success: true,
      source: "fallback_after_error",
      count: fallback.length,
      accounts: fallback,
      error: error.message,
    })
  }
}
