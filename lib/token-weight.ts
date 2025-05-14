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
      return balance
    case "sqrt":
      return Math.floor(Math.sqrt(balance))
    case "quadratic":
      return Math.floor(balance * balance)
    default:
      return balance
  }
}

/**
 * 从区块链获取代币余额
 * @param address 用户地址
 * @param tokenAddress 代币合约地址
 * @param blockNumber 区块高度 (可选)
 * @returns 代币余额
 */
export async function getTokenBalance(address: string, tokenAddress: string, blockNumber?: string): Promise<number> {
  try {
    // 在实际应用中，这里会调用区块链API或Web3库
    // 例如使用ethers.js:
    // const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
    // const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
    // const balance = await tokenContract.balanceOf(address, { blockTag: blockNumber || 'latest' });
    // return ethers.utils.formatUnits(balance, await tokenContract.decimals());

    // 模拟API调用
    console.log(`获取地址 ${address} 在代币 ${tokenAddress} 的余额，区块高度: ${blockNumber || "latest"}`)

    // 返回模拟数据
    return Math.floor(Math.random() * 1000) + 1
  } catch (error) {
    console.error("获取代币余额失败:", error)
    return 0
  }
}

/**
 * 获取多个地址的代币余额
 * @param addresses 地址数组
 * @param tokenAddress 代币合约地址
 * @param blockNumber 区块高度 (可选)
 * @returns 地址到余额的映射
 */
export async function getMultipleTokenBalances(
  addresses: string[],
  tokenAddress: string,
  blockNumber?: string,
): Promise<Record<string, number>> {
  const balances: Record<string, number> = {}

  // 在实际应用中，可以使用批量调用优化性能
  for (const address of addresses) {
    balances[address] = await getTokenBalance(address, tokenAddress, blockNumber)
  }

  return balances
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
  const balances = await getMultipleTokenBalances(addresses, tokenAddress, blockNumber)

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
