/**
 * The shape of a locally stored bill (`sui_bills` in localStorage).
 *
 * Bills are written by the create-bill dialog and read back by the details and
 * payment dialogs. Nothing on chain enforces this shape, so the reader must
 * treat every field as possibly absent: records created by older builds may
 * lack `payees`, `acceptedTokens`, or `paid`.
 */
export interface BillPayee {
  id?: string
  address: string
  amount?: string
  name?: string
  type?: "wallet" | "email"
  paid?: boolean
  /** Set only after a real on-chain payment; absent means "paid, local record only". */
  txDigest?: string
}

export interface StoredBill {
  id: string
  title?: string
  description?: string
  amount?: number
  token?: string
  coinType?: string
  acceptedTokens?: string[]
  acceptedTokensNote?: string
  /** On-chain SUI payments are not modelled here; this is the local participant count. */
  participants?: number
  paid?: number
  deadline?: string
  progress?: number
  status?: string
  color?: string
  payees?: BillPayee[]
  creator?: string
  creatorName?: string
}

/**
 * A bill after the details dialog has normalised it for rendering: the stored
 * `payees` list becomes `participants`, and `acceptedTokens` always has at
 * least the bill's own token.
 */
export interface BillView extends Omit<StoredBill, "payees" | "participants" | "acceptedTokens"> {
  participants: BillPayee[]
  acceptedTokens: string[]
}
