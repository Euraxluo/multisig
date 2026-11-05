import { SuiGrpcClient } from "@mysten/sui/grpc"
import { SuinsClient } from "@mysten/suins"
import {
  SUI_NS_DEFAULT_TIMEOUT_MS,
  resolveSuiNsAddress,
  reverseResolveSuiNsName as sdkReverseResolveSuiNsName,
  type SuiNameServiceCore,
} from "multisig/namespace"

export const suiNamesClient = new SuiGrpcClient({ network: "testnet", baseUrl: "https://fullnode.testnet.sui.io:443" })
export const suinsClient = new SuinsClient({ client: suiNamesClient, network: "testnet" })

// 解析语义统一住在 multisig/namespace；前端只保留 client 单例与 SuinsClient
// 注册表交叉校验的注入。跨 @mysten/sui 版本的结构接口在 SDK 侧定义。
const core = suiNamesClient.core as SuiNameServiceCore
const recordSource = { getNameRecord: (name: string) => suinsClient.getNameRecord(name) }

export async function resolveSuiNSName(input: string, { timeoutMs = SUI_NS_DEFAULT_TIMEOUT_MS } = {}): Promise<string> {
  return resolveSuiNsAddress(core, input, { timeoutMs, recordSource })
}

export async function reverseResolveSuiNSName(address: string): Promise<string | null> {
  return sdkReverseResolveSuiNsName(core, address)
}
