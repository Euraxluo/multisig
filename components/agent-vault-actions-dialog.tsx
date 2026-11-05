"use client"

import { useEffect, useRef, useState } from "react"
import { Coins, ArrowDownToLine, ArrowUpFromLine, UserPlus, PlayCircle } from "lucide-react"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { isValidSuiAddress } from "@mysten/sui/utils"
import { agentSuiUnits, agentVaultClient, agentVaultReader, createAgentVaultWriters, findCreatedVaultObjects, formatSuiUnits } from "@/lib/agent-vault-chain"
import { acknowledgeAgentTransaction, submitAgentTransaction } from "@/lib/agent-vault-transactions"
import { getTransactionAccount } from "@/lib/sui-wallet-signer"
import { useI18n } from "@/components/i18n-provider"
import type { AgentVaultView } from "@/types/agent"

export type VaultAction = "deposit" | "withdraw" | "operator" | "unpause"

/** Field values are i18n keys — resolve with `t()` at render time. */
const TITLES: Record<VaultAction, { title: string; description: string; submit: string }> = {
  deposit: { title: "agents.actions.depositTitle", description: "agents.actions.depositDesc", submit: "agents.actions.depositSubmit" },
  withdraw: { title: "agents.actions.withdrawTitle", description: "agents.actions.withdrawDesc", submit: "agents.actions.withdrawSubmit" },
  operator: { title: "agents.actions.operatorTitle", description: "agents.actions.operatorDesc", submit: "agents.actions.operatorSubmit" },
  unpause: { title: "agents.actions.unpauseTitle", description: "agents.actions.unpauseDesc", submit: "agents.actions.unpauseSubmit" },
}

interface AgentVaultActionDialogProps {
  action: VaultAction | null
  vault: AgentVaultView | null
  account: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onDone: () => void
}

export function AgentVaultActionDialog({ action, vault, account, open, onOpenChange, onDone }: AgentVaultActionDialogProps) {
  const { t } = useI18n()
  const [amount, setAmount] = useState("")
  const [recipient, setRecipient] = useState("")
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [busy, setBusy] = useState(false)
  const generation = useRef(0)
  const lastAccount = useRef(account)

  useEffect(() => {
    if (open && lastAccount.current && account && lastAccount.current !== account) {
      onOpenChange(false)
    }
    lastAccount.current = account
  }, [account, open, onOpenChange])

  useEffect(() => {
    if (!open) return
    setAmount(""); setRecipient(action === "withdraw" ? account ?? "" : ""); setError(""); setNotice(""); setBusy(false)
    generation.current++
  }, [open, action, account])

  if (!action) return null
  const copy = TITLES[action]
  const masterCapId = vault?.masterCapIds[0]
  const needsAmount = action === "deposit" || action === "withdraw"
  const needsRecipient = action === "withdraw" || action === "operator"

  const execute = async () => {
    if (!vault || busy) return
    setError(""); setNotice("")
    let units = 0n
    if (needsAmount) {
      try { units = agentSuiUnits(amount) } catch (cause) { setError(cause instanceof Error ? cause.message : t("agents.invalidAmount")); return }
      if (units <= 0n) { setError(t("agents.amountMustBePositive")); return }
      if (action === "withdraw" && units > vault.balanceUnits) { setError(t("agents.actions.exceedsVaultBalance", { balance: formatSuiUnits(vault.balanceUnits) })); return }
    }
    if (needsRecipient && !isValidSuiAddress(recipient.trim())) { setError(t("agents.validSuiAddressRequired")); return }
    if (action !== "deposit" && !masterCapId) { setError(t("agents.actions.noMasterCap")); return }
    const run = ++generation.current
    setBusy(true)
    const writers = createAgentVaultWriters()
    try {
      let tx
      if (action === "deposit") tx = writers.deposit(vault.vaultId, units)
      else if (action === "withdraw") tx = writers.withdraw(masterCapId!, vault.vaultId, units, recipient.trim())
      else if (action === "operator") tx = writers.issueOperator(masterCapId!, vault.vaultId, recipient.trim())
      else tx = writers.unpause(masterCapId!, vault.vaultId)
      const result = await submitAgentTransaction(tx, {
        action: `agent-vault-${action}`,
        scope: `${vault.vaultId}:${action === "operator" ? recipient.trim() : units.toString()}`,
        metadata: { vaultId: vault.vaultId, ...(masterCapId ? { masterCapId } : {}), ...(needsAmount ? { units: units.toString() } : {}), ...(needsRecipient ? { recipient: recipient.trim() } : {}) },
      })
      if (run !== generation.current) return
      setNotice(t("agents.actions.confirmed", { digest: result.digest }))
      onDone()
    } catch (cause) {
      if (run === generation.current) setError(cause instanceof Error ? cause.message : t("agents.actions.txFailed"))
    } finally {
      if (run === generation.current) setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={next => { if (!busy) onOpenChange(next) }}>
      <DialogContent className="w-[92vw] max-w-[420px] rounded-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            {action === "deposit" ? <ArrowDownToLine className="h-4 w-4 text-primary" /> : action === "withdraw" ? <ArrowUpFromLine className="h-4 w-4 text-primary" /> : action === "operator" ? <UserPlus className="h-4 w-4 text-primary" /> : <PlayCircle className="h-4 w-4 text-primary" />}
            <span>{t(copy.title)}</span>
          </DialogTitle>
          <DialogDescription className="text-xs">{t(copy.description)}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2 text-xs">
          <p className="break-all rounded-lg border border-border/40 bg-muted/30 p-2 font-mono text-[11px] text-muted-foreground">{t("agents.actions.vaultLine", { vault: vault?.vaultId ?? t("agents.actions.unverified"), version: vault?.vaultVersion.toString() ?? "-", balance: vault ? formatSuiUnits(vault.balanceUnits) : "-" })}</p>
          {needsAmount && (
            <div className="space-y-1.5">
              <Label htmlFor="vault-amount" className="text-xs">{t("agents.actions.amountLabel")}</Label>
              <Input id="vault-amount" inputMode="decimal" value={amount} onChange={event => setAmount(event.target.value)} disabled={busy} className="font-mono text-xs" />
              {action === "deposit" && <p className="text-[11px] text-muted-foreground">{t("agents.actions.depositGasNote")}</p>}
            </div>
          )}
          {needsRecipient && (
            <div className="space-y-1.5">
              <Label htmlFor="vault-recipient" className="text-xs">{action === "operator" ? t("agents.actions.operatorAddressLabel") : t("agents.actions.recipientLabel")}</Label>
              <Input id="vault-recipient" value={recipient} onChange={event => setRecipient(event.target.value)} disabled={busy} className="font-mono text-xs" placeholder="0x…" />
              {action === "operator" && <p className="text-[11px] text-muted-foreground">{t("agents.actions.operatorNote")}</p>}
            </div>
          )}
          {action === "unpause" && <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-2 text-[11px]">{t("agents.actions.unpauseNote")}</p>}
          {error && <p role="alert" className="break-all text-xs text-destructive">{error}</p>}
          {notice && <p role="status" className="break-all text-xs text-emerald-600">{notice}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={busy} className="text-xs">{t("agents.close")}</Button>
          <Button size="sm" onClick={() => void execute()} disabled={busy || !vault} className="gap-1 text-xs">
            <Coins className="h-3.5 w-3.5" />{busy ? t("agents.awaitWalletSigning") : t(copy.submit)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Initialize a new vault; returns the confirmed vault and MasterCap ids. */
export async function createAgentVault(): Promise<{ vaultId: string; masterCapId: string; digest: string }> {
  const account = getTransactionAccount()
  const tx = createAgentVaultWriters().initializeVault(account.address)
  // The pending lock stays held until the created objects are resolved and the
  // MasterCap is proven to sit at this account; a failure before that keeps the
  // recovery entry holding the confirmed digest instead of releasing silently.
  const result = await submitAgentTransaction(tx, { action: "agent-vault-initialize", scope: "initialize_vault", metadata: { coinType: "0x2::sui::SUI" }, deferAcknowledgement: true })
  const { vaultId, masterCapId } = await findCreatedVaultObjects(agentVaultClient, result.createdObjects, { expectedOwner: account.address })
  // Confirm the fresh vault is readable before reporting success.
  await agentVaultReader.readVault(vaultId)
  acknowledgeAgentTransaction(result)
  return { vaultId, masterCapId, digest: result.digest }
}
