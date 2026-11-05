"use client"

import React, { useState } from "react"
import { KeyRound, Copy, Check } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { AGENT_VAULT_PACKAGE_ID, formatSuiUnits } from "@/lib/agent-vault-chain"
import type { AgentCapView, AgentVaultView } from "@/types/agent"
import { useI18n } from "@/components/i18n-provider"

interface ExportConfigDialogProps {
  cap: AgentCapView | null
  vault: AgentVaultView | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * Exports only verified values. The agent's private key is never generated or
 * exported here: spawning a card transfers the AgentCap to an address chosen by
 * the operator, and that key must stay wherever the agent runtime keeps it.
 */
export function ExportConfigDialog({ cap, vault, open, onOpenChange }: ExportConfigDialogProps) {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)

  if (!cap) return null

  const envSnippet = `# AgentVault configuration · Sui testnet
# Values below were read from chain; verify them again before use.
SUI_NETWORK="testnet"
SUI_AGENT_VAULT_PACKAGE="${AGENT_VAULT_PACKAGE_ID}"
SUI_VAULT_ID="${cap.vaultId}"
SUI_AGENT_CAP_ID="${cap.capId}"
SUI_AGENT_ADDRESS="${cap.agentAddress}"
SUI_AGENT_EPOCH_BUDGET="${formatSuiUnits(cap.dailyBudgetUnits)}"
SUI_AGENT_SERVICE_TARGET="${new TextDecoder().decode(cap.serviceHash)}"
# The AgentCap object is owned by ${cap.capOwner ?? "a non-address owner"}.
# That address must sign spend/pause/budget transactions; this file grants nothing.
# The contract does not enforce SUI_AGENT_SERVICE_TARGET.
`

  const copy = () => {
    void navigator.clipboard.writeText(envSnippet)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="h-5 w-5 text-primary" />
            <span>{t("misc.exp.title")}</span>
          </DialogTitle>
          <DialogDescription className="text-xs">
            {t("misc.exp.hint", { status: vault ? ` ${vault.vaultId}` : t("misc.exp.unverified") })}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          <div className="relative">
            <pre className="select-all overflow-x-auto rounded-lg border border-border/60 bg-black/80 p-3 font-mono text-[11px] leading-relaxed text-purple-300">{envSnippet}</pre>
            <Button size="sm" variant="outline" onClick={copy} className="absolute right-2 top-2 h-7 gap-1 border-border/80 bg-background/80 text-xs hover:bg-background">
              {copied ? <><Check className="h-3 w-3 text-emerald-400" />{t("common.copied")}</> : <><Copy className="h-3 w-3" />{t("common.copy")}</>}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {t("misc.exp.noteA")}<span className="font-mono">spend_x402_budget</span>{t("misc.exp.noteB")}
          </p>
        </div>

        <DialogFooter>
          <Button size="sm" onClick={() => onOpenChange(false)} className="text-xs">{t("common.close")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
