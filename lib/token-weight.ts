import { normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils"
import { proposalClient } from "./proposal-chain"

const SUI_TYPE = normalizeStructTag("0x2::sui::SUI")
const signal = () => AbortSignal.timeout(20_000)

// 用于处理代币权重计算的工具函数

/**
 * 根据代币余额计算投票权重
 * @param balance 代币余额
 * @param method 计算方法 (linear, sqrt, quadratic)
 * @returns 计算后的投票权重
 */
export function calculateWeight(balance: number, method: string): number {
  if (!Number.isFinite(balance) || balance < 0) throw new Error("代币余额无效。")
  const transformed = method === "sqrt" ? Math.sqrt(balance) : method === "quadratic" ? balance * balance : method === "linear" ? balance : NaN
  const weight = Math.floor(transformed)
  if (!Number.isSafeInteger(weight)) throw new Error("投票算法无效或权重超出精度范围。")
  return weight
}

/**
 * 真实从 Sui 全节点 RPC 获取代币余额与投票权重
 * @param address 用户 Sui 地址
 * @param coinType 代币类型 (默认 0x2::sui::SUI)
 * @returns 真实代币数量 (以标称单位计)
 */
export async function getTokenBalance(address: string, coinType: string = SUI_TYPE): Promise<number> {
  if (!address || !address.startsWith("0x")) throw new Error("投票地址无效。")
  const owner = normalizeSuiAddress(address)
  const wanted = normalizeStructTag(coinType || SUI_TYPE)
  let cursor: string | null = null
  let total = 0n
  const cursors = new Set<string>()
  for (let pageCount = 0; pageCount < 40; pageCount++) {
    const page = await proposalClient.listBalances({ owner, cursor, limit: 50, signal: signal() })
    for (const balance of page.balances) {
      if (normalizeStructTag(balance.coinType) === wanted) {
        if (!/^\d+$/.test(balance.balance)) throw new Error("链上代币余额无效。")
        total += BigInt(balance.balance)
      }
    }
    if (!page.hasNextPage) {
      const decimals = wanted === SUI_TYPE ? 9 : (await proposalClient.getCoinMetadata({ coinType: wanted, signal: signal() })).coinMetadata?.decimals
      if (decimals == null) throw new Error("代币元数据不可用，无法计算投票权重。")
      if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new Error("代币精度无效。")
      const unit = 10n ** BigInt(decimals)
      const nominal = total / unit
      if (nominal > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("代币余额超出当前投票权重的精度范围。")
      return Number(nominal)
    }
    if (!page.cursor || cursors.has(page.cursor)) throw new Error("代币余额分页未前进。")
    cursors.add(page.cursor)
    cursor = page.cursor
  }
  throw new Error("代币余额分页超过单次读取上限。")
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
/** Any voter row this function touches: it only reads and preserves `address`. */
export interface WeightedVoter {
  address: string
  [key: string]: unknown
}

export async function assignTokenWeights<T extends WeightedVoter>(
  voters: T[],
  tokenAddress: string,
  calculationMethod = "linear",
  blockNumber?: string,
): Promise<Array<T & { tokenBalance?: number; weight?: number }>> {
  if (blockNumber?.trim()) throw new Error("当前读取的是实时余额，尚未提供指定快照的可验证余额。")
  const addresses = voters.map((voter) => voter.address)
  if (addresses.some(address => typeof address !== "string" || !/^0x[\da-fA-F]{1,64}$/.test(address))) throw new Error("选民需要有效的 Sui 地址。")

  // 获取代币余额
  const balances = await getMultipleTokenBalances(addresses, tokenAddress)

  // 更新选民权重
  return voters.map((voter) => {
    if (voter.address.startsWith("0x") && balances[voter.address] !== undefined) {
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
