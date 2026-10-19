import { NextResponse } from 'next/server';

/**
 * 已废弃的服务端代签路由。
 *
 * 本应用定位为「全链应用、无后端」：所有交易由前端通过 Sui Wallet Standard
 * (`lib/sui-wallet-signer.ts`) 直接唤起用户钱包签名，不设服务端代签。
 *
 * 旧版本通过读取 `~/.sui/sui_config/sui.keystore` 在服务端持有私钥签名，
 * 已移除该能力（私钥永不应驻留服务端进程内存）。请使用前端钱包签名。
 */

export async function POST() {
  return NextResponse.json(
    {
      success: false,
      error:
        'DEPRECATED: 服务端代签已移除（全链无后端架构）。请在前端使用 Sui Wallet Standard 签名。',
    },
    { status: 410 }
  )
}

export async function GET() {
  return NextResponse.json({ deprecated: true, reason: 'server-side signing removed' }, { status: 410 })
}
