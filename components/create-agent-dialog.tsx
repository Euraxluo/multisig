"use client"

import { useEffect, useRef, useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Bot, ShieldCheck, Sparkles } from "lucide-react"
import { normalizeSuiAddress, isValidSuiAddress } from "@mysten/sui/utils"
import { agentSuiUnits, agentVaultReader, createAgentVaultWriters, findCreatedAgentCap, SUI_TYPE, type AgentVaultLabel } from "@/lib/agent-vault-chain"
import { acknowledgeAgentTransaction, submitAgentTransaction } from "@/lib/agent-vault-transactions"
import { rememberAgentCap, saveAgentLabel } from "@/lib/use-agent-vault"
import { useI18n } from "@/components/i18n-provider"
import type { AgentVaultView } from "@/types/agent"

/** Category `label` values are i18n keys — render with `t(item.label)`. */
export const AGENT_CATEGORIES = [
  { key: "LLM_INFERENCE", label: "agents.create.catLLM", color: "border-blue-500/40 text-blue-600" },
  { key: "DATA_SCRAPING", label: "agents.create.catScraping", color: "border-amber-500/40 text-amber-600" },
  { key: "STORAGE", label: "agents.create.catStorage", color: "border-emerald-500/40 text-emerald-600" },
  { key: "DEFI_EXECUTION", label: "agents.create.catDeFi", color: "border-purple-500/40 text-purple-600" },
] as const

interface CreateAgentDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  vaults: AgentVaultView[]
  account: string | null
  onCreated: () => void
}

export function CreateAgentDialog({ open, onOpenChange, vaults, account, onCreated }: CreateAgentDialogProps) {
  const { t } = useI18n()
  const [name, setName] = useState("")
  const [purpose, setPurpose] = useState("")
  const [category, setCategory] = useState<AgentVaultLabel["category"]>("LLM_INFERENCE")
  const [dailyBudget, setDailyBudget] = useState("5")
  const [agentInput, setAgentInput] = useState("")
  const [serviceInput, setServiceInput] = useState("")
  const [vaultId, setVaultId] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const generation = useRef(0)

  const operators = vaults.flatMap(vault => vault.operatorCaps
    .filter(cap => cap.vaultVersion === vault.vaultVersion)
    .map(cap => ({ ...cap, vault })))
  const selectedVault = vaults.find(vault => vault.vaultId === vaultId) ?? operators[0]?.vault
  const operator = operators.find(cap => cap.vault.vaultId === selectedVault?.vaultId)

  useEffect(() => {
    if (!open) return
    generation.current++
    setError(""); setNotice(""); setBusy(false)
    setVaultId(current => operators.some(cap => cap.vault.vaultId === current) ? current : operators[0]?.vault.vaultId ?? "")
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, vaults])

  const reset = () => { setName(""); setPurpose(""); setDailyBudget("5"); setAgentInput(""); setServiceInput(""); setError(""); setNotice("") }
  const close = () => { if (busy) return; reset(); onOpenChange(false) }

  const create = async () => {
    if (busy) return
    setError(""); setNotice("")
    if (!operator) { setError(t("agents.create.noOperatorCap")); return }
    if (!name.trim()) { setError(t("agents.create.nameRequired")); return }
    let budgetUnits: bigint
    try { budgetUnits = agentSuiUnits(dailyBudget) } catch (cause) { setError(cause instanceof Error ? cause.message : t("agents.invalidBudget")); return }
    if (budgetUnits === 0n) { setError(t("agents.create.budgetPositive")); return }
    const target = agentInput.trim() ? agentInput.trim() : account ?? ""
    if (!target || !isValidSuiAddress(target)) { setError(t("agents.create.agentAddressRequired")); return }
    const serviceHash = new TextEncoder().encode(serviceInput.trim())
    if (serviceHash.length > 256) { setError(t("agents.create.serviceHashTooLong")); return }

    const run = generation.current
    setBusy(true)
    try {
      const writers = createAgentVaultWriters(undefined, SUI_TYPE)
      const tx = writers.spawnAgent(operator.capId, operator.vault.vaultId, normalizeSuiAddress(target), budgetUnits, serviceHash)
      const result = await submitAgentTransaction(tx, {
        action: "agent-cap-spawn",
        scope: `${operator.vault.vaultId}:${normalizeSuiAddress(target)}:${budgetUnits}`,
        metadata: {
          vaultId: operator.vault.vaultId, operatorCapId: operator.capId, agent: normalizeSuiAddress(target),
          budgetUnits: budgetUnits.toString(), serviceHash: serviceInput.trim(), name: name.trim(),
        },
        // Keep the pending lock until the cap is resolved and proven to belong
        // to the intended agent; a verification failure then leaves the
        // recovery entry holding the confirmed digest instead of a bare error.
        deferAcknowledgement: true,
      })
      // Verify the confirmed object before recording it; the label is local-only.
      const cap = await findCreatedAgentCap(agentVaultReader.client, result.createdObjects, { expectedOwner: normalizeSuiAddress(target) })
      if (cap.vaultId !== operator.vault.vaultId || cap.agentId !== normalizeSuiAddress(target)) throw new Error(t("agents.create.capMismatch", { digest: result.digest }))
      acknowledgeAgentTransaction(result)
      if (run !== generation.current) return
      rememberAgentCap(cap.capId)
      saveAgentLabel({ capId: cap.capId, name: name.trim(), purpose: purpose.trim(), category })
      setNotice(t("agents.create.capConfirmed", { capId: cap.capId, digest: result.digest }))
      onCreated()
    } catch (cause) {
      if (run === generation.current) setError(cause instanceof Error ? cause.message : t("agents.create.txFailed"))
    } finally {
      if (run === generation.current) setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={next => { if (!next) close() }}>
      <DialogContent className="w-[92vw] max-w-[440px] rounded-2xl max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-primary to-purple-600 flex items-center justify-center text-white">
              <Bot className="w-4 h-4" />
            </div>
            <span>{t("agents.create.title")}</span>
          </DialogTitle>
          <DialogDescription>
            {t("agents.create.descPrefix")}<span className="font-mono">spawn_agent_card</span>{t("agents.create.descSuffix")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2" data-testid="create-agent-form">
          {!account && <p role="alert" className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs">{t("agents.create.connectFirst")}</p>}
          {account && operators.length === 0 && (
            <p role="status" className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs">
              {t("agents.create.noOperatorStatus")}
            </p>
          )}

          {operators.length > 0 && (
            <div className="space-y-1.5">
              <Label htmlFor="agent-vault" className="text-xs">{t("agents.create.vaultLabel")}</Label>
              <select id="agent-vault" value={selectedVault?.vaultId ?? ""} onChange={event => setVaultId(event.target.value)} disabled={busy}
                className="h-9 w-full rounded-md border border-input bg-background px-2 font-mono text-xs">
                {operators.map(cap => (
                  <option key={cap.capId} value={cap.vault.vaultId}>{t("agents.create.vaultOption", { vault: cap.vault.vaultId.slice(0, 12), version: cap.vault.vaultVersion.toString(), operator: cap.capId.slice(0, 10) })}</option>
                ))}
              </select>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="agent-name">{t("agents.create.nameLabel")}</Label>
            <Input id="agent-name" placeholder={t("agents.create.namePlaceholder")} value={name} onChange={event => setName(event.target.value)} disabled={busy} maxLength={60} />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="agent-purpose">{t("agents.create.purposeLabel")}</Label>
            <Input id="agent-purpose" placeholder={t("agents.create.purposePlaceholder")} value={purpose} onChange={event => setPurpose(event.target.value)} disabled={busy} maxLength={200} />
          </div>

          <div className="space-y-1.5">
            <Label>{t("agents.create.categoryLabel")}</Label>
            <div className="grid grid-cols-2 gap-2">
              {AGENT_CATEGORIES.map(item => (
                <Button key={item.key} type="button" variant={category === item.key ? "default" : "outline"} size="sm"
                  className={`justify-start text-xs ${category === item.key ? "bg-gradient-to-r from-primary to-purple-600 text-white" : item.color}`}
                  onClick={() => setCategory(item.key)} disabled={busy}>
                  <Sparkles className="mr-1 w-3.5 h-3.5" />{t(item.label)}
                </Button>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="daily-budget">{t("agents.create.budgetLabel")}</Label>
            <Input id="daily-budget" inputMode="decimal" value={dailyBudget} onChange={event => setDailyBudget(event.target.value)} disabled={busy} className="font-mono" />
            <p className="text-[11px] text-muted-foreground">{t("agents.create.budgetHint")}</p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="agent-address">{t("agents.create.agentAddressLabel")}</Label>
            <Input id="agent-address" value={agentInput} onChange={event => setAgentInput(event.target.value)} disabled={busy}
              placeholder={account ? t("agents.create.agentAddressPlaceholder", { account: account.slice(0, 12) }) : "0x…"} className="font-mono text-xs" />
            <p className="text-[11px] text-muted-foreground">
              {t("agents.create.agentAddressHint")}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="service-hash">{t("agents.create.serviceLabel")}</Label>
            <Input id="service-hash" value={serviceInput} onChange={event => setServiceInput(event.target.value)} disabled={busy} placeholder={t("agents.create.servicePlaceholder")} className="font-mono text-xs" />
            <p className="text-[11px] text-muted-foreground">{t("agents.create.serviceHint")}</p>
          </div>

          {error && <p role="alert" className="break-all text-xs text-destructive">{error}</p>}
          {notice && <p role="status" className="break-all text-xs text-emerald-600">{notice}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={close} disabled={busy}>{t("agents.close")}</Button>
          <Button onClick={() => void create()} disabled={busy || !account || operators.length === 0}
            className="bg-gradient-to-r from-primary to-purple-600 text-white">
            <ShieldCheck className="mr-1.5 w-4 h-4" />{busy ? t("agents.awaitWalletSigning") : t("agents.create.submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
