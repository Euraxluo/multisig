import { SuiGrpcClient } from "@mysten/sui/grpc"
const c = new SuiGrpcClient({ network: "testnet", baseUrl: "https://fullnode.testnet.sui.io:443" })
async function main() {
const r: any = await c.listOwnedObjects({ owner: "0x2c6539e5802d1476dae4a7aada30265dd2568f198ecf2f184861ea7deb3f6347", limit: 25 } as any)
for (const o of (r?.objects ?? r?.data ?? []).slice(0, 25)) console.log(o.objectId, "|", (o.type ?? "").slice(0, 80))
}
main().catch(e => console.error('ERR', e.message))
