import { SuiGrpcClient } from "@mysten/sui/grpc"
const client = new SuiGrpcClient({ network: "testnet", baseUrl: "https://fullnode.testnet.sui.io:443" })
async function main() {
  for (const a of ["0x8ac06d3d4328aff5bef88990741c1f620a96d5fc579bf2e459467763bd605788", "0x2b9953911b07f6b7d2c92e17ed6cb2325cc26f9eb1eaeb58497ee7b5523ea859", "0x2c6539e5802d1476dae4a7aada30265dd2568f198ecf2f184861ea7deb3f6347", "0x341acf449c898fa437e7928e8567898952dcfff8fffeddccb25b6a8b679d5b7a", "0x843f44a42e10a6dc701b7f60a4dedc544dc7910e971ee6a493f4d9096953e04e"]) {
    const { balance }: any = await client.getBalance({ owner: a, coinType: "0x2::sui::SUI" })
    console.log(a.slice(0, 10), BigInt(balance.balance).toString(), "MIST")
  }
}
main()
