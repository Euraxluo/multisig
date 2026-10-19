import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc"

const SUI_TESTNET_RPC = "https://fullnode.testnet.sui.io:443"

// 用于处理代币权重计算的工具函数

/**
 * 根据代币余额计算投票权重
 * @param balance 代币余额
 * @param method 计算方法 (linear, sqrt, quadratic)
 * @returns 计算后的投票权重
 */
export function calculateWeight(balance: number, method: string): number {
  switch (method) {
    case "linear":
      return Math.max(1, Math.floor(balance))
    case "sqrt":
      return Math.max(1, Math.floor(Math.sqrt(balance)))
    case "quadratic":
      return Math.max(1, Math.floor(balance * balance))
    default:
      return Math.max(1, Math.floor(balance))
  }
}

/**
 * 真实从 Sui 全节点 RPC 获取代币余额与投票权重
 * @param address 用户 Sui 地址
 * @param coinType 代币类型 (默认 0x2::sui::SUI)
 * @returns 真实代币数量 (以标称单位计)
 */
export async function getTokenBalance(address: string, coinType: string = "0x2::sui::SUI"): Promise<number> {
  if (!address || !address.startsWith("0x")) return 1
  try {
    const client = new SuiJsonRpcClient({ url: SUI_TESTNET_RPC, network: "testnet" })
    const res = await client.getBalance({
      owner: address,
      coinType: coinType || "0x2::sui::SUI",
    })
    const totalMist = BigInt(res.totalBalance || "0")
    const suiAmount = Number(totalMist) / 1e9
    return Math.max(1, Math.floor(suiAmount))
  } catch (error) {
    console.debug("获取 Sui 链上代币余额回退默认权重 1:", error)
    return 1
  }
}

/**
 * 获取多个地址在 Sui 上的代币余额
 * @param addresses 地址数组
 * @param coinType 代币合约类型
 * @returns 地址到真实余额权重的映射
 */
export async function getMultipleTokenBalances(
  addresses: string[],
  coinType: string = "0x2::sui::SUI",
): Promise<Record<string, number>> {
  const result: Record<string, number> = {}
  await Promise.all(
    addresses.map(async (addr) => {
      result[addr] = await getTokenBalance(addr, coinType)
    })
  )
  return result
}

/**
 * 根据代币余额为选民分配权重
 * @param voters 选民数组
 * @param tokenAddress 代币合约地址
 * @param calculationMethod 计算方法
 * @param blockNumber 区块高度 (可选)
 * @returns 更新后的选民数组
 */
export async function assignTokenWeights(
  voters: any[],
  tokenAddress: string,
  calculationMethod = "linear",
  blockNumber?: string,
): Promise<any[]> {
  // 获取所有选民地址
  const addresses = voters.map((voter) => voter.address).filter((address) => address.startsWith("0x"))

  // 获取代币余额
  const balances = await getMultipleTokenBalances(addresses, tokenAddress)

  // 更新选民权重
  return voters.map((voter) => {
    if (voter.address.startsWith("0x") && balances[voter.address]) {
      const tokenBalance = balances[voter.address]
      const weight = calculateWeight(tokenBalance, calculationMethod)

      return {
        ...voter,
        tokenBalance,
        weight,
      }
    }
    return voter
  })
}
