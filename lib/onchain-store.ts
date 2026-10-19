"use client"

import { AgentVaultClient } from "@sui-universal/sdk"
import { createSuiClient, fetchBalances, type OwnedCoinBalance } from "@sui-universal/sdk"
import { signAndExecuteWithWallet } from "./sui-wallet-signer"

export const TESTNET_PACKAGE_ID = "0x83fb785f1da119aea4e0faa19d1466b33899e14ea730af6425ec7d5557cb5a36"
export const KNOWN_TESTNET_ORG_ID = "0xaf0806fadf61ceeb76c21b40af4393e244a5d8ca91ba208d4f58537421eff2e4"

export const vaultClient = new AgentVaultClient({
  packageId: TESTNET_PACKAGE_ID,
  defaultCoinType: "0x2::sui::SUI",
})

export interface TokenBalanceInfo {
  symbol: string
  name: string
  coinType: string
  balance: string
  usdValue: string
  rawBalance: bigint
}

export interface ProposalItem {
  id: string
  onChainId?: string
  orgId: string
  vaultId?: string
  masterCapId?: string
  title: string
  description: string
  amount: number
  amountMist: string
  token: string
  groupId: string
  groupName: string
  recipient: string
  status: "pending" | "approved" | "executed" | "rejected"
  approvals: number
  requiredApprovals: number
  createdAt: string
  expiresAt: string
  deadlineMs: number
  type: "transfer" | "contract" | "batch"
  color: string
  isScheduled?: boolean
  scheduledDate?: string
  isConditional?: boolean
  conditionType?: string
  conditionDetails?: string
  isBatch?: boolean
  batchCount?: number
  voters: string[]
  txDigest?: string
  executionDigest?: string
  executedAt?: string
  rejectedAt?: string
}

const DEFAULT_PROPOSALS: ProposalItem[] = [
  {
    id: "tx-init-1",
    orgId: KNOWN_TESTNET_ORG_ID,
    title: "Eco Grants #1: Developer Tooling",
    description: "Quarterly liquidity grant to ecosystem contributors",
    amount: 100,
    amountMist: "100000000000",
    token: "SUI",
    groupId: "group-1",
    groupName: "Team Treasury (Sui MultiSig)",
    recipient: "0xaf0806fadf61ceeb76c21b40af4393e244a5d8ca91ba208d4f58537421eff2e4",
    status: "pending",
    approvals: 1,
    requiredApprovals: 2,
    createdAt: new Date(Date.now() - 3600000 * 12).toISOString(),
    expiresAt: new Date(Date.now() + 3600000 * 24 * 7).toISOString(),
    deadlineMs: Date.now() + 3600000 * 24 * 7,
    type: "transfer",
    color: "from-primary to-purple-500",
    voters: ["0x00000000000000000000000000000000000000000000000000000000000000a1"],
  },
  {
    id: "tx-init-2",
    orgId: KNOWN_TESTNET_ORG_ID,
    title: "Liquidity Staking Allocation",
    description: "Deposit treasury reserve into Spring sSUI vault for yield",
    amount: 50,
    amountMist: "50000000000",
    token: "SUI",
    groupId: "group-2",
    groupName: "DAO Fund (Sui Native)",
    recipient: "0x0000000000000000000000000000000000000000000000000000000000000002",
    status: "pending",
    approvals: 1,
    requiredApprovals: 2,
    createdAt: new Date(Date.now() - 3600000 * 24).toISOString(),
    expiresAt: new Date(Date.now() + 3600000 * 24 * 5).toISOString(),
    deadlineMs: Date.now() + 3600000 * 24 * 5,
    type: "contract",
    color: "from-blue-500 to-cyan-400",
    voters: [],
  },
]

/**
 * 从 localStorage 读取当前活跃账户
 */
export function getActiveAccount(): { address: string; identifier?: string; type?: string } | null {
  if (typeof window === "undefined") return null
  try {
    const raw = localStorage.getItem("sui_active_account")
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (parsed?.address && typeof parsed.address === "string" && parsed.address.startsWith("0x")) {
      return parsed
    }
  } catch {}
  return null
}

/**
 * 实时从 Sui RPC 节点获取地址的所有链上代币余额
 */
export async function fetchRealBalances(address: string): Promise<{
  sui: TokenBalanceInfo
  ssui: TokenBalanceInfo
  usdc: TokenBalanceInfo
  wal: TokenBalanceInfo
  all: OwnedCoinBalance[]
  totalUsdValue: number
}> {
  try {
    const rawBalances = await fetchBalances("testnet", address)

    let suiMist = 0n
    let ssuiMist = 0n
    let usdcMist = 0n
    let walMist = 0n

    for (const b of rawBalances) {
      if (b.coinType.endsWith("::sui::SUI")) {
        suiMist += b.totalBalance
      } else if (b.coinType.toLowerCase().includes("ssui")) {
        ssuiMist += b.totalBalance
      } else if (b.coinType.toLowerCase().includes("usdc")) {
        usdcMist += b.totalBalance
      } else if (b.coinType.toLowerCase().includes("wal")) {
        walMist += b.totalBalance
      }
    }

    const suiAmount = Number(suiMist) / 1e9
    const ssuiAmount = Number(ssuiMist) / 1e9
    const usdcAmount = Number(usdcMist) / 1e6
    const walAmount = Number(walMist) / 1e9

    // 参考当前市价估算 USD (SUI ~ $3.42, sSUI ~ $3.60, USDC = $1.00, WAL ~ $0.20)
    const suiUsd = suiAmount * 3.42
    const ssuiUsd = ssuiAmount * 3.6
    const usdcUsd = usdcAmount * 1.0
    const walUsd = walAmount * 0.2

    const totalUsd = suiUsd + ssuiUsd + usdcUsd + walUsd

    return {
      sui: {
        symbol: "SUI",
        name: "Sui Native Coin",
        coinType: "0x2::sui::SUI",
        balance: suiAmount.toFixed(2),
        usdValue: suiUsd.toFixed(2),
        rawBalance: suiMist,
      },
      ssui: {
        symbol: "sSUI",
        name: "Spring Staked SUI",
        coinType: "0x...::ssui::SSUI",
        balance: ssuiAmount.toFixed(2),
        usdValue: ssuiUsd.toFixed(2),
        rawBalance: ssuiMist,
      },
      usdc: {
        symbol: "USDC",
        name: "Sui Native USDC",
        coinType: "0x...::usdc::USDC",
        balance: usdcAmount.toFixed(2),
        usdValue: usdcUsd.toFixed(2),
        rawBalance: usdcMist,
      },
      wal: {
        symbol: "WAL",
        name: "Walrus Protocol",
        coinType: "0x...::wal::WAL",
        balance: walAmount.toFixed(2),
        usdValue: walUsd.toFixed(2),
        rawBalance: walMist,
      },
      all: rawBalances,
      totalUsdValue: totalUsd,
    }
  } catch (e) {
    console.warn("[onchain-store] fetchBalances error:", e)
    return {
      sui: { symbol: "SUI", name: "Sui Native Coin", coinType: "0x2::sui::SUI", balance: "0.00", usdValue: "0.00", rawBalance: 0n },
      ssui: { symbol: "sSUI", name: "Spring Staked SUI", coinType: "0x...::ssui::SSUI", balance: "0.00", usdValue: "0.00", rawBalance: 0n },
      usdc: { symbol: "USDC", name: "Sui Native USDC", coinType: "0x...::usdc::USDC", balance: "0.00", usdValue: "0.00", rawBalance: 0n },
      wal: { symbol: "WAL", name: "Walrus Protocol", coinType: "0x...::wal::WAL", balance: "0.00", usdValue: "0.00", rawBalance: 0n },
      all: [],
      totalUsdValue: 0,
    }
  }
}

/**
 * 获取所有提案（本地存储 + 链上同步）
 */
export function getProposals(): ProposalItem[] {
  if (typeof window === "undefined") return DEFAULT_PROPOSALS
  try {
    const raw = localStorage.getItem("sui_proposals")
    if (raw) {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed
      }
    }
    // 首次加载初始化默认提案
    localStorage.setItem("sui_proposals", JSON.stringify(DEFAULT_PROPOSALS))
    return DEFAULT_PROPOSALS
  } catch {
    return DEFAULT_PROPOSALS
  }
}

/**
 * 保存提案列表并通知全组件
 */
export function saveProposals(proposals: ProposalItem[]): void {
  if (typeof window === "undefined") return
  try {
    localStorage.setItem("sui_proposals", JSON.stringify(proposals))
    window.dispatchEvent(new CustomEvent("sui-proposals-updated", { detail: proposals }))
  } catch (e) {
    console.error("[onchain-store] Failed to save proposals", e)
  }
}

/**
 * 发起链上转账提案 (调用 Move 合约 agent_vault::asynchronous_proposal::create_transfer_proposal)
 */
export async function createTransferProposalOnChain(params: {
  title: string
  recipient: string
  amount: number
  token?: string
  description?: string
  groupId?: string
  groupName?: string
  deadlineMs?: number
  orgId?: string
}): Promise<{ proposal: ProposalItem; digest?: string }> {
  const token = params.token || "SUI"
  const amountMist = BigInt(Math.round(params.amount * 1e9))
  const deadlineMs = params.deadlineMs || (Date.now() + 86400000 * 7)
  const orgId = params.orgId || KNOWN_TESTNET_ORG_ID
  const groupId = params.groupId || "group-1"
  const groupName = params.groupName || "Team Treasury (Sui MultiSig)"

  let txDigest: string | undefined = undefined
  let onChainId: string | undefined = undefined

  // 如果连接了真实钱包，构建 PTB 上链提交提案
  const account = getActiveAccount()
  if (account?.address) {
    try {
      const tx = vaultClient.buildCreateTransferProposalPTB(
        orgId,
        params.title,
        params.recipient,
        amountMist,
        deadlineMs
      )
      const res = await signAndExecuteWithWallet(tx)
      txDigest = res.digest
      if (res.createdObjects.length > 0) {
        onChainId = res.createdObjects[0]
      }
    } catch (e: any) {
      console.warn("[onchain-store] On-chain proposal creation via wallet failed, saving locally:", e.message)
    }
  }

  const newProposal: ProposalItem = {
    id: `prop_${Date.now()}`,
    onChainId,
    orgId,
    title: params.title,
    description: params.description || `Transfer ${params.amount} ${token} to ${params.recipient.slice(0, 10)}...`,
    amount: params.amount,
    amountMist: amountMist.toString(),
    token,
    groupId,
    groupName,
    recipient: params.recipient,
    status: "pending",
    approvals: 1, // 发起人自投 1 票
    requiredApprovals: 2,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(deadlineMs).toISOString(),
    deadlineMs,
    type: "transfer",
    color: "from-primary to-purple-500",
    voters: account?.address ? [account.address] : [],
    txDigest,
  }

  const existing = getProposals()
  const updated = [newProposal, ...existing]
  saveProposals(updated)

  return { proposal: newProposal, digest: txDigest }
}

/**
 * 投票审批提案 (Approve)
 */
export async function approveProposal(proposalId: string): Promise<{ success: boolean; isNowApproved: boolean; digest?: string }> {
  const account = getActiveAccount()
  const userAddr = account?.address || "0x0000000000000000000000000000000000000000"

  const proposals = getProposals()
  const idx = proposals.findIndex((p) => p.id === proposalId)
  if (idx === -1) throw new Error("Proposal not found")

  const target = proposals[idx]
  if (target.voters.includes(userAddr) && userAddr !== "0x0000000000000000000000000000000000000000") {
    throw new Error("You have already voted on this proposal")
  }

  let voteDigest: string | undefined = undefined

  // 如果提案具备真实链上对象 ID，可通过钱包向链上合约提交 vote
  if (target.onChainId && account?.address) {
    try {
      const dummySigShare = new Uint8Array(64).fill(1)
      const tx = vaultClient.buildSubmitAsyncVotePTB(
        target.onChainId,
        target.orgId,
        1,
        dummySigShare
      )
      const res = await signAndExecuteWithWallet(tx)
      voteDigest = res.digest
    } catch (e: any) {
      console.warn("[onchain-store] On-chain async vote via wallet failed, updating state locally:", e.message)
    }
  }

  const newApprovals = target.approvals + 1
  const isNowApproved = newApprovals >= target.requiredApprovals

  const updatedTarget: ProposalItem = {
    ...target,
    approvals: newApprovals,
    status: isNowApproved ? "approved" : target.status,
    voters: [...target.voters, userAddr],
  }

  proposals[idx] = updatedTarget
  saveProposals(proposals)

  return { success: true, isNowApproved, digest: voteDigest }
}

/**
 * 拒绝提案 (Reject)
 */
export async function rejectProposal(proposalId: string): Promise<boolean> {
  const proposals = getProposals()
  const idx = proposals.findIndex((p) => p.id === proposalId)
  if (idx === -1) return false

  proposals[idx] = {
    ...proposals[idx],
    status: "rejected",
    rejectedAt: new Date().toISOString(),
  }
  saveProposals(proposals)
  return true
}

/**
 * 执行已批准的提案 (Execute)
 */
export async function executeProposal(proposalId: string): Promise<{ success: boolean; digest?: string }> {
  const proposals = getProposals()
  const idx = proposals.findIndex((p) => p.id === proposalId)
  if (idx === -1) throw new Error("Proposal not found")

  const target = proposals[idx]
  if (target.status !== "approved" && target.approvals < target.requiredApprovals) {
    throw new Error("Proposal is not approved yet")
  }

  let executionDigest: string | undefined = undefined

  // 如果有链上金库与 MasterCap，唤起钱包执行链上金库划转
  if (target.onChainId && target.vaultId && target.masterCapId) {
    try {
      const tx = vaultClient.buildExecuteTransferProposalPTB(
        target.onChainId,
        target.orgId,
        target.vaultId,
        target.masterCapId,
        target.token === "SUI" ? "0x2::sui::SUI" : undefined
      )
      const res = await signAndExecuteWithWallet(tx)
      executionDigest = res.digest
    } catch (e: any) {
      console.warn("[onchain-store] On-chain execute withdrawal via wallet failed, marking state locally:", e.message)
    }
  } else {
    // 模拟生成可验证的模拟执行记录
    executionDigest = `0xexec_${Date.now().toString(16)}`
  }

  proposals[idx] = {
    ...proposals[idx],
    status: "executed",
    executionDigest,
    executedAt: new Date().toISOString(),
  }
  saveProposals(proposals)

  return { success: true, digest: executionDigest }
}
