import { configuration, errorResponse, flowCookie, json, limitedJson, protect, sealFlow, startFlow, startSchema, LoginError } from "../server"
import { cookies } from "next/headers"
import { setStoreLocale } from "@/lib/i18n/locale-store"
import { t } from "@/lib/i18n/t"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  // Resolve the visitor locale (sui_locale cookie) so server-side error messages localize.
  const savedLocale = (await cookies()).get("sui_locale")?.value
  setStoreLocale(savedLocale === "zh" ? "zh" : "en")
  try {
    protect(request)
    const parsed = startSchema.safeParse(await limitedJson(request, 1024))
    if (!parsed.success) throw new LoginError(t("misc.zkSrv.startInvalid"))
    const flow = await startFlow(parsed.data)
    const config = configuration()
    return json(flow, 200, flowCookie(sealFlow(flow, config.secret), config.origin))
  } catch (error) { return errorResponse(error) }
}
