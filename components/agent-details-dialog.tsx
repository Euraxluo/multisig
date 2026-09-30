"use client";

import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Progress } from "@/components/ui/progress";
import { Copy, Pause, Play, ShieldAlert, Key, Check } from "lucide-react";
import { useState } from "react";
import { AgentVirtualCard } from "@/types/agent";

interface AgentDetailsDialogProps {
  card: AgentVirtualCard | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onTogglePause?: (cardId: string) => void;
  onOpenAdjust?: (card: AgentVirtualCard) => void;
  onOpenExport?: (card: AgentVirtualCard) => void;
}

export function AgentDetailsDialog({
  card,
  open,
  onOpenChange,
  onTogglePause,
  onOpenAdjust,
  onOpenExport,
}: AgentDetailsDialogProps) {
  const [activeTab, setActiveTab] = useState("overview");
  const [copied, setCopied] = useState(false);

  if (!card) return null;

  const quotaPercent = Math.min(100, Math.round((card.spentToday / card.dailyBudget) * 100));

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <div className={`h-1.5 -mx-6 -mt-6 rounded-t-lg bg-gradient-to-r ${card.color}`} />
        <DialogHeader className="pt-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <Avatar className="h-10 w-10 border border-border">
                <AvatarFallback className={`bg-gradient-to-br ${card.color} text-white font-bold text-sm`}>
                  {card.name.slice(0, 2).toUpperCase()}
                </AvatarFallback>
              </Avatar>
              <div>
                <DialogTitle className="text-base font-bold">{card.name}</DialogTitle>
                <p className="text-xs text-muted-foreground">{card.purpose}</p>
              </div>
            </div>
            <Badge
              variant="outline"
              className={
                card.status === "ACTIVE"
                  ? "bg-emerald-500/10 text-emerald-500 border-emerald-500/20"
                  : card.status === "QUOTA_REACHED"
                  ? "bg-amber-500/10 text-amber-500 border-amber-500/20"
                  : "bg-muted text-muted-foreground"
              }
            >
              {card.status}
            </Badge>
          </div>
        </DialogHeader>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="mt-3">
          <TabsList className="grid grid-cols-2 w-full">
            <TabsTrigger value="overview">配额与状态</TabsTrigger>
            <TabsTrigger value="security">Move 沙盒与凭证</TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="space-y-4 pt-3">
            {/* Daily Quota Progress */}
            <div className="p-3.5 rounded-xl bg-card/60 border border-border/60 space-y-2">
              <div className="flex justify-between items-center text-xs">
                <span className="text-muted-foreground">今日 SUI 消耗进度</span>
                <span className="font-bold text-foreground">
                  {card.spentToday.toFixed(2)} / {card.dailyBudget.toFixed(2)} SUI ({quotaPercent}%)
                </span>
              </div>
              <Progress value={quotaPercent} className="h-2" />
              <div className="flex justify-between items-center text-[11px] text-muted-foreground pt-1">
                <span>累计调用：{card.requestCount} 次</span>
                <span>历史总计：{(card.totalSpentAllTime ?? card.totalSpent).toFixed(2)} SUI</span>
              </div>
            </div>

            {/* Allowed Services */}
            <div className="space-y-1.5">
              <span className="text-xs font-medium text-foreground">白名单服务商</span>
              <div className="flex flex-wrap gap-1.5">
                {card.allowedServices.map((svc) => (
                  <Badge key={svc} variant="secondary" className="font-mono text-[11px] px-2 py-0.5">
                    {svc}
                  </Badge>
                ))}
              </div>
            </div>

            {/* Action Buttons */}
            <div className="grid grid-cols-3 gap-2 pt-2">
              <Button
                variant="outline"
                size="sm"
                className="text-xs gap-1.5"
                onClick={() => onTogglePause?.(card.id)}
              >
                {card.status === "PAUSED" ? <Play className="w-3.5 h-3.5 text-emerald-500" /> : <Pause className="w-3.5 h-3.5 text-amber-500" />}
                {card.status === "PAUSED" ? "恢复运行" : "暂停副卡"}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="text-xs"
                onClick={() => {
                  onOpenChange(false);
                  onOpenAdjust?.(card);
                }}
              >
                调整配额
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="text-xs gap-1"
                onClick={() => {
                  onOpenChange(false);
                  onOpenExport?.(card);
                }}
              >
                <Key className="w-3.5 h-3.5 text-primary" />
                导出 .env
              </Button>
            </div>
          </TabsContent>

          <TabsContent value="security" className="space-y-3 pt-3">
            <div className="space-y-2 text-xs">
              <div className="p-3 rounded-lg bg-muted/40 border border-border/40 space-y-1">
                <span className="text-muted-foreground block text-[11px]">Agent 链上地址</span>
                <div className="flex items-center justify-between font-mono text-foreground font-medium">
                  <span>{card.address}</span>
                  <button onClick={() => handleCopy(card.address)} className="p-1 hover:text-primary">
                    {copied ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
                  </button>
                </div>
              </div>

              <div className="p-3 rounded-lg bg-muted/40 border border-border/40 space-y-1">
                <span className="text-muted-foreground block text-[11px]">绑定 Move 权限对象 (AgentCap)</span>
                <div className="flex items-center justify-between font-mono text-foreground font-medium">
                  <span>{card.agentCapId || card.capId}</span>
                  <button onClick={() => handleCopy(card.agentCapId || card.capId)} className="p-1 hover:text-primary">
                    <Copy className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              <div className="p-3 rounded-lg bg-primary/5 border border-primary/20 space-y-1 text-muted-foreground">
                <p className="font-semibold text-foreground text-xs flex items-center gap-1.5">
                  <ShieldAlert className="w-3.5 h-3.5 text-primary" />
                  Move 字节码沙盒防护保障
                </p>
                <p className="text-[11px] leading-relaxed">
                  本 Agent 不持有金库私钥，仅能在 Sui PTB 中通过 AgentCap 在每日 {card.dailyBudget} SUI 限额内发起微支付。如果发生 Prompt 注入或死循环，智能合约将在 Epoch 周期内硬阻断。
                </p>
              </div>
            </div>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
