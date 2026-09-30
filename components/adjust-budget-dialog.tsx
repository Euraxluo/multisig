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
      <DialogContent className="w-[92vw] max-w-[400px] rounded-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Settings2 className="w-5 h-5 text-primary" />
            <span>调整助手单日限额</span>
          </DialogTitle>
          <DialogDescription className="text-xs">
            正在修改 <span className="font-semibold text-foreground">{card.name}</span> 的限额。
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label className="text-xs">单日支出限额 (SUI)</Label>
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
              今日已消耗: {card.spentToday.toFixed(2)} SUI。
            </p>
          </div>

          <div className="p-2.5 rounded-lg bg-muted/30 border border-border/50 text-[11px] text-muted-foreground">
            修改即时生效，超出限额将自动停止划扣。
          </div>

          <DialogFooter className="pt-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)} className="text-xs">
              取消
            </Button>
            <Button type="submit" size="sm" className="bg-primary text-primary-foreground text-xs">
              确认更新
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
