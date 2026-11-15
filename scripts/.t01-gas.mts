import { SuiGrpcClient } from "@mysten/sui/grpc"
const client = new SuiGrpcClient({ network: "testnet", baseUrl: "https://fullnode.testnet.sui.io:443" } as any)
const r: any = await client.getTransaction({ digest: "C9GpNpBcYs1TwpisxmEGS1Aoe2o2VB6Cxb47jTqxpbMb", include: { effects: true } } as any)
const t = r.Transaction ?? r.transaction
console.log("gasUsed:", JSON.stringify(t.effects.gasUsed))
const net = BigInt(t.effects.gasUsed.computationCost) + BigInt(t.effects.gasUsed.storageCost) - BigInt(t.effects.gasUsed.storageRebate)
console.log("net gas cost (MIST):", net.toString())
console.log("rebates received: 12 * 1_000_000 =", 12 * 1_000_000)
console.log("profit if net < rebates:", net < 12_000_000n)
