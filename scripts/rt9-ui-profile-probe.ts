import { Transaction } from "@mysten/sui/transactions"
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { fromBase64 } from "@mysten/sui/utils"
import { SuiGrpcClient } from "@mysten/sui/grpc"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
const PKG = "0xba0780e7f08a0589c1f71c8b2eff10bfc6d498190c88d4d25292b502c7c9251e"
const NAMES = "0x25193e4ee41b0927cf0624421b50ed97e85cade5c617cf51e38e7eaec58d8294"
const A1 = "0x2c6539e5802d1476dae4a7aada30265dd2568f198ecf2f184861ea7deb3f6347"
const client = new SuiGrpcClient({ network: "testnet", baseUrl: "https://fullnode.testnet.sui.io:443" })
function keypairFor(a: string) { const ks = JSON.parse(readFileSync(`${homedir()}/.sui/sui_config/sui.keystore`, "utf8")) as string[]; for (const e of ks) { const kp = Ed25519Keypair.fromSecretKey(fromBase64(e).slice(1)); if (kp.toSuiAddress() === a) return kp } throw new Error("nokey") }
async function main() {
  // 找 A1 拥有的 name NFT（identity 对象）
  const owned: any = await client.listOwnedObjects({ owner: A1, filter: { StructType: `${PKG}::name::Name` }, limit: 5 } as any).catch(() => null)
  const objs = owned?.objects ?? owned?.data ?? []
  console.log("A1 identity names:", objs.length)
  for (const o of objs) console.log("  ", o.objectId, o.type?.slice(0, 60))
  if (!objs.length) { console.log("（A1 无 identity name → 需先 mint 才能测 set_profile；本轮只验证模块的链上校验逻辑存在性）"); }
}
main().catch(e => console.error("ERR", e.message))
