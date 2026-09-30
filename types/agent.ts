export type AgentStatus = 'ACTIVE' | 'QUOTA_REACHED' | 'PAUSED' | 'REVOKED';

export type UserRole = 'MASTER' | 'OPERATOR' | 'GUEST';

export interface AgentVirtualCard {
  id: string;
  name: string;
  purpose: string;
  category: 'LLM_INFERENCE' | 'DATA_SCRAPING' | 'STORAGE' | 'DEFI_EXECUTION' | 'CUSTOM';
  address: string;
  capId: string;
  agentCapId?: string;
  dailyBudget: number; // in SUI
  spentToday: number; // in SUI
  totalSpent: number; // in SUI
  totalSpentAllTime?: number;
  requestCount: number;
  status: AgentStatus;
  allowedServices: string[];
  lastActive: string;
  color: string;
  privateKeyExported?: string;
}

export type TransactionType = 'x402_INFERENCE' | 'STORAGE_PAY' | 'PROXY_NETWORK' | 'UNIVERSAL_SWAP';

export interface SpendingLog {
  id: string;
  timestamp: string;
  agentId: string;
  agentName: string;
  amount: number;
  currency: string;
  targetService: string;
  type: TransactionType;
  status: 'SUCCESS' | 'BLOCKED' | 'BLOCKED_OVERBUDGET' | 'BLOCKED_UNAUTHORIZED';
  details: string;
  txDigest?: string;
}

export interface OperatorMember {
  id: string;
  address: string;
  name: string;
  roleDescription?: string;
  role?: string;
  authorizedAt: string;
  status: 'ACTIVE' | 'REVOKED';
}

export interface VaultState {
  vaultId: string;
  vaultName: string;
  network: string;
  totalBalance: number; // in SUI
  epochNumber: number;
  epochResetsIn: string; // e.g. "4h 12m"
  activeAgentsCount: number;
  totalAgentsCount: number;
  todaySpentTotal: number;
  todayRequestsTotal: number;
  blockedAttemptsTotal: number;
  blockedLoopsCount: number;
  version: number;
}
