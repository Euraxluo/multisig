// Projection from verified chain records to the AgentVault page model.
//
// The projection is pure: it never invents a balance, a spend, or a status. A
// capability whose vault failed verification is listed separately as unverified
// rather than folded into a vault with zeroed values.
import type { AgentCapView, AgentStatus, AgentVaultView, UnverifiedAgentCap } from "@/types/agent"
import type { AgentCardRecord, AgentVaultLabel, AgentVaultSnapshot } from "./agent-vault-chain"
import { t } from "@/lib/i18n/t"

const STATUS: Record<AgentCardRecord["status"], AgentStatus> = {
  active: "ACTIVE",
  quota: "QUOTA_REACHED",
  paused: "PAUSED",
  stale: "STALE",
  unverified: "UNVERIFIED",
}

function capView(card: AgentCardRecord, label: AgentVaultLabel | undefined): AgentCapView | null {
  // 卡对象与金库表行缺一即不可展示：二者共同构成一张可扣费的卡。
  if (!card.cap || !card.record) return null
  return {
    capId: card.capId,
    vaultId: card.vaultId,
    agentAddress: card.cap.agentId,
    capOwner: card.cap.capOwner,
    dailyBudgetUnits: card.record.dailyBudget,
    spentInEpochUnits: card.record.spentInEpoch,
    effectiveSpentUnits: card.effectiveSpent,
    epochKnown: card.epochKnown,
    lastSpentEpoch: card.record.lastSpentEpoch,
    vaultVersion: card.cap.vaultVersion,
    vaultBalanceUnits: card.vault.balance,
    vaultPaused: card.vault.paused,
    isActive: card.record.isActive,
    serviceHash: card.record.serviceHash,
    status: STATUS[card.status],
    reason: card.reason,
    label: label ? {
      name: label.name || t("agents.chain.unnamedCard"),
      purpose: label.purpose,
      category: (["LLM_INFERENCE", "DATA_SCRAPING", "STORAGE", "DEFI_EXECUTION", "CUSTOM"].includes(label.category)
        ? label.category : "CUSTOM") as AgentLocalLabelCategory,
    } : null,
    spends: card.spentEvents.map(row => ({ digest: row.digest, amountUnits: row.amount, epoch: row.epoch, recipient: row.recipient, timestampMs: row.timestampMs })),
    spendsTruncated: card.spentEventsTruncated,
    spendsError: card.spentEventsError,
  }
}

type AgentLocalLabelCategory = "LLM_INFERENCE" | "DATA_SCRAPING" | "STORAGE" | "DEFI_EXECUTION" | "CUSTOM"

export function buildAgentVaultViews(
  snapshot: AgentVaultSnapshot,
  labels: Record<string, AgentVaultLabel>,
): { vaults: AgentVaultView[]; unverified: UnverifiedAgentCap[] } {
  const unverified: UnverifiedAgentCap[] = []
  const byVault = new Map<string, AgentCapView[]>()
  for (const card of snapshot.cards) {
    const view = capView(card, labels[card.capId])
    if (!view) {
      unverified.push({ capId: card.capId, reason: card.reason })
      continue
    }
    const rows = byVault.get(view.vaultId) ?? []
    rows.push(view)
    byVault.set(view.vaultId, rows)
  }
  const vaults = snapshot.vaults.map(vault => {
    const master = snapshot.masterCaps.filter(cap => cap.vaultId === vault.vaultId).map(cap => cap.capId)
    const operators = snapshot.operatorCaps.filter(cap => cap.vaultId === vault.vaultId).map(cap => ({ capId: cap.capId, vaultVersion: cap.vaultVersion }))
    return {
      vaultId: vault.vaultId,
      balanceUnits: vault.balance,
      vaultVersion: vault.vaultVersion,
      totalSubagents: vault.totalSubagents,
      paused: vault.paused,
      masterCapIds: master,
      operatorCaps: operators,
      caps: byVault.get(vault.vaultId) ?? [],
      errors: [],
    }
  })
  // A capability whose vault object was not resolved cannot be placed in a
  // vault; it stays in `unverified` and is never attached to another vault.
  return { vaults, unverified }
}
