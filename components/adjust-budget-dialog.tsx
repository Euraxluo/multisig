"use client";

import React, { useState, useEffect } from "react";
import { Settings2 } from "lucide-react";
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
import { AgentVirtualCard } from "@/types/agent";

interface AdjustBudgetDialogProps {
  card: AgentVirtualCard | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (cardId: string, newBudget: number) => void;
}

export function AdjustBudgetDialog({ card, open, onOpenChange, onSave }: AdjustBudgetDialogProps) {
  const [budget, setBudget] = useState("");

  useEffect(() => {
    if (card) {
      setBudget(card.dailyBudget.toString());
    }
  }, [card]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!card) return;
    const num = parseFloat(budget);
    if (!isNaN(num) && num > 0) {
      onSave(card.id, num);
      onOpenChange(false);
    }
  };

  if (!card) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Settings2 className="w-5 h-5 text-primary" />
            <span>调整副卡单日限额</span>
          </DialogTitle>
          <DialogDescription className="text-xs">
            正在修改 <span className="font-semibold text-foreground">{card.name}</span> 的配额。
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label className="text-xs">单日消费限额 (SUI)</Label>
            <Input
              type="number"
              step="0.1"
              min="0.1"
              max="1000"
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
              required
              className="h-8 text-xs font-mono"
            />
            <p className="text-[11px] text-muted-foreground">
              当前 Epoch 已消耗: {card.spentToday.toFixed(2)} SUI。
            </p>
          </div>

          <div className="p-3 rounded-lg bg-card border border-border/60 text-[11px] text-muted-foreground space-y-1">
            <p className="font-semibold text-foreground">链上即时生效：</p>
            <p>• 同步更新 Move 智能合约中的 `AgentRecord.daily_budget`。</p>
            <p>• 若设置值低于今日已消耗额度，Agent 调用将即刻受限直至下一 Epoch 自动恢复。</p>
          </div>

          <DialogFooter className="pt-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)} className="text-xs">
              取消
            </Button>
            <Button type="submit" size="sm" className="bg-gradient-to-r from-primary to-purple-600 text-white text-xs">
              确认更新
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
