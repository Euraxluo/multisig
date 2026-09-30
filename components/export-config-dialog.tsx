"use client";

import React, { useState } from "react";
import { KeyRound, Copy, Check } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { AgentVirtualCard } from "@/types/agent";

interface ExportConfigDialogProps {
  card: AgentVirtualCard | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ExportConfigDialog({ card, open, onOpenChange }: ExportConfigDialogProps) {
  const [copied, setCopied] = useState(false);

  if (!card) return null;

  const envSnippet = `# Configuration for ${card.name}
SUI_VAULT_ID="0x7a8b9c4d2e1f0a5b6c7d8e9f0a1b2c3d4e5f6a7b"
SUI_AGENT_CAP_ID="${card.agentCapId || card.capId}"
SUI_AGENT_ADDRESS="${card.address}"
SUI_DAILY_BUDGET_SUI="${card.dailyBudget}"
SUI_ALLOWED_SERVICES="${card.allowedServices.join(",")}"
SUI_NETWORK="https://fullnode.mainnet.sui.io:443"
`;

  const handleCopy = () => {
    navigator.clipboard.writeText(envSnippet);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="w-5 h-5 text-primary" />
            <span>导出 Agent .env 运行环境</span>
          </DialogTitle>
          <DialogDescription className="text-xs">
            用于提供给 <span className="font-semibold text-foreground">{card.name}</span> 容器执行微支付。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          <div className="relative">
            <pre className="p-3 rounded-lg bg-black/80 border border-border/60 text-[11px] font-mono text-purple-300 overflow-x-auto select-all leading-relaxed">
              {envSnippet}
            </pre>
            <Button
              size="sm"
              variant="outline"
              onClick={handleCopy}
              className="absolute top-2 right-2 h-7 text-xs border-border/80 bg-background/80 hover:bg-background gap-1"
            >
              {copied ? (
                <>
                  <Check className="w-3 h-3 text-emerald-400" />
                  已复制
                </>
              ) : (
                <>
                  <Copy className="w-3 h-3" />
                  复制
                </>
              )}
            </Button>
          </div>

          <p className="text-xs text-muted-foreground">
            将这些环境变量配置到您的 Python / TypeScript AI Agent 进程中，Agent 即可在受限沙盒内通过 HTTP 402 请求自动完成 SUI 微支付扣款。
          </p>
        </div>

        <DialogFooter>
          <Button size="sm" onClick={() => onOpenChange(false)} className="text-xs">
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
