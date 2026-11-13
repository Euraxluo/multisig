import { SuiGrpcClient } from "@mysten/sui/grpc"
import { bcs } from "@mysten/sui/bcs"
async function main() {
  const c = new SuiGrpcClient({ network: "testnet", baseUrl: "https://fullnode.testnet.sui.io:443" })
  const NAMES = "0x25193e4ee41b0927cf0624421b50ed97e85cade5c617cf51e38e7eaec58d8294"
  const dyn: any = await (c as any).getDynamicFieldObject({ parent: NAMES, name: { type: "address", value: "0x2c6539e5802d1476dae4a7aada30265dd2568f198ecf2f184861ea7deb3f6347" } }).catch((e: any) => ({ error: String(e).slice(0, 120) }))
  console.log(JSON.stringify(dyn).slice(0, 400))
}
main().catch(e => console.error("ERR", e.message))
