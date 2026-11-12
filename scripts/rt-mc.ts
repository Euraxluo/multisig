import { SuiGrpcClient } from "@mysten/sui/grpc"
const client = new SuiGrpcClient({ network: "testnet", baseUrl: "https://fullnode.testnet.sui.io:443" })
async function main() {
  const res: any = await client.getTransaction({ digest: "G4dx8TVz1pBL2TMTJWWRE7kJdbGiJXRSM9HpzWNXTQbv", include: { objectTypes: true, effects: true } })
  const t = res.Transaction
  console.log("objectTypes:", String(JSON.stringify(t.objectTypes)).slice(0, 600))
}
main().catch(e => console.log("ERR", e.message.slice(0, 100)))
