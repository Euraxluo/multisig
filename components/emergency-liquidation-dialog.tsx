"use client";

import React, { useState } from "react";
import { AlertOctagon } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface EmergencyLiquidationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  totalBalance: number;
  onConfirmPurge: () => void;
}

export function EmergencyLiquidationDialog({
  open,
  onOpenChange,
  totalBalance,
  onConfirmPurge,
}: EmergencyLiquidationDialogProps) {
  const [confirmText, setConfirmText] = useState("");
  const isConfirmed = confirmText.trim().toUpperCase() === "PURGE";

  const handleExecute = () => {
    if (!isConfirmed) return;
    onConfirmPurge();
    setConfirmText("");
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px] border-red-500/40">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-red-500">
            <AlertOctagon className="w-5 h-5 text-red-500" />
            单向紧急熔断与资金强退 (Kill Switch)
          </DialogTitle>
          <DialogDescription className="text-xs text-red-400/90">
            仅需 Master 私钥签名，无需任何副卡或 Operator 确认。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2 text-xs">
          <div className="p-3 rounded-lg bg-red-950/40 border border-red-500/30 text-red-200 space-y-1.5 leading-relaxed">
            <p className="font-semibold text-white">链上触发效果 (390ms 内即时生效)：</p>
            <p>1. <span className="font-mono text-purple-300">AgentVault.version</span> 版本号递增，当前所有已签发的副卡 <span className="font-mono text-purple-300">AgentCap</span> 立即失效。</p>
            <p>2. 金库所有余额 <span className="font-bold text-white font-mono">{totalBalance.toFixed(2)} SUI</span> 将全部撤回至 Master 安全冷钱包。</p>
            <p>3. 彻底阻断任何潜在的黑客 Prompt 注入盗取资金或无限循环恶意扣费。</p>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">
              请输入 <span className="font-bold text-red-400">PURGE</span> 确认执行：
            </Label>
            <Input
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder="PURGE"
              className="h-8 text-xs font-mono border-red-500/30 focus-visible:ring-red-500"
            />
          </div>
        </div>

        <DialogFooter className="pt-2">
          <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)} className="text-xs">
            取消
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            disabled={!isConfirmed}
            onClick={handleExecute}
            className="text-xs bg-red-600 hover:bg-red-700 font-semibold"
          >
            确认并执行熔断
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
