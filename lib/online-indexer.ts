"use client"

import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc"
import { getProposals, saveProposals, ProposalItem, TESTNET_PACKAGE_ID, KNOWN_TESTNET_ORG_ID } from "./onchain-store"

const SUI_TESTNET_RPC = "https://fullnode.testnet.sui.io:443"

let indexerRunning = false
let indexerInterval: any = null

interface EventCursor {
  txDigest: string
  eventSeq: string
}

function getStoredCursor(eventType: string): EventCursor | undefined {
  if (typeof window === "undefined") return undefined
  try {
    const raw = localStorage.getItem(`cursor_${eventType}`)
    if (raw) return JSON.parse(raw)
  } catch {}
  return undefined
}

function saveStoredCursor(eventType: string, cursor: EventCursor): void {
  if (typeof window === "undefined") return
  try {
    localStorage.setItem(`cursor_${eventType}`, JSON.stringify(cursor))
  } catch {}
}

/**
 * 纯前端在线事件索引器 (Online Client-side Event Indexer)
 * 无需任何集中式后端服务或 xindex，直接通过 Sui 全节点 JSON-RPC 增量拉取提案、投票与红包事件
 */
export async function runIncrementalSync(): Promise<number> {
  if (typeof window === "undefined") return 0

  const client = new SuiJsonRpcClient({ url: SUI_TESTNET_RPC, network: "testnet" })
  let newEventsCount = 0

  try {
    // 1. 同步提案创建事件 (ProposalCreatedEvent)
    const proposalCreatedType = `${TESTNET_PACKAGE_ID}::asynchronous_proposal::ProposalCreatedEvent`
    const lastCreatedCursor = getStoredCursor("prop_created")

    const createdPage = await client.queryEvents({
      query: { MoveEventType: proposalCreatedType },
      cursor: lastCreatedCursor,
      limit: 20,
      order: "ascending",
    })

    if (createdPage.data.length > 0) {
      const currentProposals = getProposals()
      const proposalsMap = new Map(currentProposals.map((p) => [p.onChainId || p.id, p]))

      for (const ev of createdPage.data) {
        const raw = ev.parsedJson as any
        if (!raw) continue

        const onChainId = raw.proposal_id || raw.id
        const titleStr = typeof raw.title === "string" ? raw.title : new TextDecoder().decode(new Uint8Array(raw.title || []))
        const amountMist = BigInt(raw.amount || "0")
        const amountSui = Number(amountMist) / 1e9

        if (!proposalsMap.has(onChainId)) {
          const newProp: ProposalItem = {
            id: `chain_${onChainId.slice(0, 10)}`,
            onChainId,
            orgId: raw.org_id || KNOWN_TESTNET_ORG_ID,
            title: titleStr || "Sui On-Chain MultiSig Proposal",
            description: `On-chain transfer proposal to ${raw.recipient?.slice(0, 10)}...`,
            amount: amountSui,
            amountMist: amountMist.toString(),
            token: "SUI",
            groupId: "group-1",
            groupName: "Team Treasury (Sui MultiSig)",
            recipient: raw.recipient,
            status: "pending",
            approvals: 1,
            requiredApprovals: Number(raw.required_weight || 2),
            createdAt: new Date(Number(ev.timestampMs || Date.now())).toISOString(),
            expiresAt: new Date(Number(raw.deadline_ms || Date.now() + 86400000 * 7)).toISOString(),
            deadlineMs: Number(raw.deadline_ms || Date.now() + 86400000 * 7),
            type: "transfer",
            color: "from-primary to-purple-500",
            voters: [raw.creator],
            txDigest: ev.id.txDigest,
          }
          proposalsMap.set(onChainId, newProp)
          newEventsCount++
        }
      }

      saveProposals(Array.from(proposalsMap.values()))
      if (createdPage.nextCursor) {
        saveStoredCursor("prop_created", createdPage.nextCursor)
      }
    }

    // 2. 同步提案投票事件 (VoteSubmittedEvent)
    const voteSubmittedType = `${TESTNET_PACKAGE_ID}::asynchronous_proposal::VoteSubmittedEvent`
    const lastVoteCursor = getStoredCursor("vote_submitted")

    const votePage = await client.queryEvents({
      query: { MoveEventType: voteSubmittedType },
      cursor: lastVoteCursor,
      limit: 30,
      order: "ascending",
    })

    if (votePage.data.length > 0) {
      const currentProposals = getProposals()
      let modified = false

      for (const ev of votePage.data) {
        const raw = ev.parsedJson as any
        if (!raw) continue

        const proposalId = raw.proposal_id
        const voter = raw.voter
        const totalWeight = Number(raw.total_weight || 0)

        const idx = currentProposals.findIndex((p) => p.onChainId === proposalId || p.id === proposalId)
        if (idx !== -1) {
          const target = currentProposals[idx]
          if (voter && !target.voters.includes(voter)) {
            target.voters.push(voter)
            target.approvals = totalWeight > 0 ? totalWeight : target.approvals + 1
            if (target.approvals >= target.requiredApprovals) {
              target.status = "approved"
            }
            modified = true
            newEventsCount++
          }
        }
      }

      if (modified) {
        saveProposals(currentProposals)
      }
      if (votePage.nextCursor) {
        saveStoredCursor("vote_submitted", votePage.nextCursor)
      }
    }

    // 3. 同步提案执行事件 (ProposalExecutedEvent)
    const executedType = `${TESTNET_PACKAGE_ID}::asynchronous_proposal::ProposalExecutedEvent`
    const lastExecCursor = getStoredCursor("prop_executed")

    const execPage = await client.queryEvents({
      query: { MoveEventType: executedType },
      cursor: lastExecCursor,
      limit: 20,
      order: "ascending",
    })

    if (execPage.data.length > 0) {
      const currentProposals = getProposals()
      let modified = false

      for (const ev of execPage.data) {
        const raw = ev.parsedJson as any
        if (!raw) continue

        const proposalId = raw.proposal_id
        const idx = currentProposals.findIndex((p) => p.onChainId === proposalId || p.id === proposalId)
        if (idx !== -1) {
          currentProposals[idx].status = "executed"
          currentProposals[idx].executionDigest = ev.id.txDigest
          currentProposals[idx].executedAt = new Date(Number(ev.timestampMs || Date.now())).toISOString()
          modified = true
          newEventsCount++
        }
      }

      if (modified) {
        saveProposals(currentProposals)
      }
      if (execPage.nextCursor) {
        saveStoredCursor("prop_executed", execPage.nextCursor)
      }
    }
  } catch (err) {
    // 增量同步异常时保持静默重试，不影响主应用
    console.debug("[online-indexer] Incremental sync tick notice:", err)
  }

  return newEventsCount
}

/**
 * 启动前端后台在线增量同步引擎 (默认每 4 秒轮询一次)
 */
export function startOnlineIndexer(intervalMs: number = 4000): void {
  if (indexerRunning || typeof window === "undefined") return
  indexerRunning = true

  // 立即触发首次同步
  runIncrementalSync()

  indexerInterval = setInterval(() => {
    runIncrementalSync()
  }, intervalMs)
}

/**
 * 停止在线索引引擎
 */
export function stopOnlineIndexer(): void {
  if (indexerInterval) {
    clearInterval(indexerInterval)
    indexerInterval = null
  }
  indexerRunning = false
}
