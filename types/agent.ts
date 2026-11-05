// Chain-backed view models for the AgentVault page.
//
// The deployed contract stores no card name, purpose or service allowlist; the
// capability itself carries a per-epoch budget and a raw service hash that the
// contract never enforces. Everything marked `chain` below is read from a
// verified shared vault, an owned capability, or an emitted event.
export type AgentStatus = "ACTIVE" | "QUOTA_REACHED" | "PAUSED" | "REVOKED" | "STALE" | "UNVERIFIED";

/** Local-only label; never presented as an on-chain property. */
export interface AgentLocalLabel {
  name: string
  purpose: string
  category: "LLM_INFERENCE" | "DATA_SCRAPING" | "STORAGE" | "DEFI_EXECUTION" | "CUSTOM"
}

export interface AgentSpendRow {
  digest: string
  amountUnits: bigint
  epoch: bigint
  recipient: string
  timestampMs: number | null
}

export interface AgentCapView {
  /** AgentCap object id — the only durable identity the contract provides. */
  capId: string
  vaultId: string
  agentAddress: string
  /** Sui object owner of this cap. Only this address can sign pause/budget/spend. */
  capOwner: string | null
  dailyBudgetUnits: bigint
  spentInEpochUnits: bigint
  /** Counter after applying the real epoch: a stored counter from an older epoch resets to zero. */
  effectiveSpentUnits: bigint
  /** False when the current epoch could not be read, so `effectiveSpentUnits` is not a projection. */
  epochKnown: boolean
  lastSpentEpoch: bigint
  vaultVersion: bigint
  vaultBalanceUnits: bigint
  vaultPaused: boolean
  isActive: boolean
  /** Raw `service_target_hash` bytes. The contract stores but never enforces them. */
  serviceHash: Uint8Array
  status: AgentStatus
  reason: string
  label: AgentLocalLabel | null
  spends: AgentSpendRow[]
  /** True when the spend feed is a bounded slice rather than the full history. */
  spendsTruncated: boolean
  /** Non-empty when the spend feed could not be read; the cap itself is still verified. */
  spendsError: string
}

export interface AgentVaultView {
  vaultId: string
  balanceUnits: bigint
  vaultVersion: bigint
  totalSubagents: bigint
  paused: boolean
  /** MasterCap objects owned by the connected account for this vault. */
  masterCapIds: string[]
  /** OperatorCap objects owned by the connected account, with the vault version they were issued at. */
  operatorCaps: Array<{ capId: string; vaultVersion: bigint }>
  caps: AgentCapView[]
  errors: string[]
}

/** A capability whose vault could not be verified; shown, never turned into a fake card. */
export interface UnverifiedAgentCap {
  capId: string
  reason: string
}
