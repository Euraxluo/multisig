import { completeFlow, completeSchema, consumeFlow, errorResponse, flowCookie, json, limitedJson, LoginError, protect, readFlow } from "../server"
import { cookies } from "next/headers"
import { setStoreLocale } from "@/lib/i18n/locale-store"
import { t } from "@/lib/i18n/t"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 120

export async function POST(request: Request) {
  // Resolve the visitor locale (sui_locale cookie) so server-side error messages localize.
  const savedLocale = (await cookies()).get("sui_locale")?.value
  setStoreLocale(savedLocale === "zh" ? "zh" : "en")
  let clearCookie: string | undefined
  try {
    const config = protect(request)
    const parsed = completeSchema.safeParse(await limitedJson(request, 18_000))
    if (!parsed.success) throw new LoginError(t("misc.zkSrv.credentialsInvalid"))
    const flow = readFlow(request, config.secret)
    consumeFlow(flow, parsed.data.state)
    clearCookie = flowCookie("", config.origin, true)
    return json(await completeFlow(parsed.data.jwt, flow, config), 200, clearCookie)
  } catch (error) {
    const response = errorResponse(error)
    if (clearCookie) response.headers.set("Set-Cookie", clearCookie)
    return response
  }
}
