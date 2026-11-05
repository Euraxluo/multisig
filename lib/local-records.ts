// Local records are evidence of browser storage, not proof of an on-chain state.
export type RecordSourceStatus = "local" | "unverified" | "chain-confirmed"

export interface TransactionTemplate {
  id: string
  name: string
  type: string
  description: string
  createdAt: string
  lastUsed?: string
  recipient?: string
  amount?: string
  token?: string
  contract?: string
  function?: string
  args?: string
  batchItems?: { recipient: string; amount: string; token: string }[]
  sourceStatus?: RecordSourceStatus
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

export function readStoredArray(key: string): unknown[] {
  if (typeof window === "undefined") return []
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) || "[]")
    return Array.isArray(value) ? value : []
  } catch { return [] }
}

// These versions have fixed values in the original source. Runtime-dated quick
// templates, proposals and groups cannot be proven to be untouched seeds.
export const IMMUTABLE_TEMPLATE_SEEDS = [
  {
    id: "template-1", name: "每月团队津贴发放", type: "transfer",
    description: "向核心贡献者划拨 50 SUI 津贴", createdAt: "2025-02-15T12:00:00Z",
    lastUsed: "2025-03-15T12:00:00Z",
    recipient: "0xaf0806fadf61ceeb76c21b40af4393e244a5d8ca91ba208d4f58537421eff2e4",
    amount: "50", token: "SUI",
  },
  {
    id: "template-2", name: "生态流动性金库充值", type: "contract",
    description: "向流动性池注入做市资金", createdAt: "2025-02-10T12:00:00Z",
    lastUsed: "2025-03-10T12:00:00Z",
    contract: "0x83fb785f1da119aea4e0faa19d1466b33899e14ea730af6425ec7d5557cb5a36",
    function: "deposit", args: '{"amount": "100"}',
  },
  {
    id: "template-3", name: "SUI/USDC 快捷对冲", type: "contract",
    description: "在 DeepBook / Cetus 执行稳定币兑换", createdAt: "2025-02-05T12:00:00Z",
    contract: "0x0000000000000000000000000000000000000000000000000000000000000002",
    function: "swap", args: '{"tokenIn": "SUI", "tokenOut": "USDC", "amountIn": "10"}',
  },
] as const

export function isImmutableTemplateSeed(value: unknown): boolean {
  if (!isRecord(value)) return false
  return IMMUTABLE_TEMPLATE_SEEDS.some(seed => {
    const entries = Object.entries(seed)
    return Object.keys(value).length === entries.length && entries.every(([key, expected]) => value[key] === expected)
  })
}

export function getPaymentTemplates(): TransactionTemplate[] {
  return readStoredArray("sui_payment_templates").filter(isRecord).filter(value => !isImmutableTemplateSeed(value)).map(value => ({
    ...value,
    sourceStatus: /^template-[123]$/.test(String(value.id)) || !value.createdAt ? "unverified" : "local",
  } as TransactionTemplate))
}

/** Update visible templates without erasing suppressed seeds or unknown legacy entries. */
export function savePaymentTemplates(templates: TransactionTemplate[], removedId?: string): void {
  if (typeof window === "undefined") return
  const retained = readStoredArray("sui_payment_templates").filter(value =>
    !isRecord(value) || isImmutableTemplateSeed(value) || (!templates.some(template => template.id === value.id) && value.id !== removedId),
  )
  localStorage.setItem("sui_payment_templates", JSON.stringify([...templates, ...retained]))
  window.dispatchEvent(new CustomEvent("sui-templates-updated", { detail: templates }))
}
