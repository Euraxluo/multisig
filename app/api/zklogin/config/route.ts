import { configuration, errorResponse, json } from "../server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export function GET() {
  try {
    const config = configuration()
    return json({ enabled: true, clientId: config.clientId, redirectUri: `${config.origin}/auth/callback`, network: "testnet" })
  } catch (error) { return errorResponse(error) }
}
