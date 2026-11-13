import { SuiClient } from "@mysten/sui/client"
import { bcs } from "@mysten/sui/bcs"
async function main() {
  const c = new SuiClient({ url: "https://fullnode.testnet.sui.io:443" })
  const NAMES = "0x25193e4ee41b0927cf0624421b50ed97e85cade5c617cf51e38e7eaec58d8294"
  const full = await c.getObject({ id: NAMES, options: { showContent: true } })
  const fields = (full.data?.content as any)?.fields ?? {}
  console.log("fields keys:", Object.keys(fields))
  const accounts = fields.accounts?.fields?.id ?? fields.accounts?.id
  console.log("accounts table id:", accounts)
  const df = await c.getDynamicFieldObject({ parentId: accounts, name: { type: "address", value: "0x2c6539e5802d1476dae4a7aada30265dd2568f198ecf2f184861ea7deb3f6347" } })
  const nameId = (df.data?.content as any)?.fields?.value ?? (df.data?.content as any)?.fields
  console.log("A1 name id:", JSON.stringify(nameId).slice(0, 200))
}
main().catch(e => console.error("ERR", String(e).slice(0, 300)))
