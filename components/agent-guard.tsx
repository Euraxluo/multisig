"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Progress } from "@/components/ui/progress";
import { motion } from "framer-motion";
import {
  TrendingUp,
  Clock,
  Plus,
  ShieldCheck,
  Bot,
  Zap,
  ShieldAlert,
  ArrowRight,
  Flame,
  Key,
} from "lucide-react";
import { AgentVirtualCard, SpendingLog, VaultState } from "@/types/agent";
import { INITIAL_CARDS, INITIAL_LOGS, INITIAL_VAULT } from "@/lib/mock-data";
import { AgentDetailsDialog } from "@/components/agent-details-dialog";
import { CreateAgentDialog } from "@/components/create-agent-dialog";
import { AdjustBudgetDialog } from "@/components/adjust-budget-dialog";
import { ExportConfigDialog } from "@/components/export-config-dialog";
import { EmergencyLiquidationDialog } from "@/components/emergency-liquidation-dialog";

export default function AgentGuard() {
  const [cards, setCards] = useState<AgentVirtualCard[]>(INITIAL_CARDS);
  const [vault, setVault] = useState<VaultState>(INITIAL_VAULT);
  const [logs, setLogs] = useState<SpendingLog[]>(INITIAL_LOGS);

  // Dialog states
  const [selectedCard, setSelectedCard] = useState<AgentVirtualCard | null>(null);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isEmergencyPurgeOpen, setIsEmergencyPurgeOpen] = useState(false);
  const [adjustTargetCard, setAdjustTargetCard] = useState<AgentVirtualCard | null>(null);
  const [exportTargetCard, setExportTargetCard] = useState<AgentVirtualCard | null>(null);

  // Handlers
  const handleTogglePause = (cardId: string) => {
    setCards((prev) =>
      prev.map((c) => {
        if (c.id === cardId) {
          return {
            ...c,
            status: c.status === "PAUSED" ? "ACTIVE" : "PAUSED",
          };
        }
        return c;
      })
    );
  };

  const handleSaveBudget = (cardId: string, newBudget: number) => {
    setCards((prev) =>
      prev.map((c) => {
        if (c.id === cardId) {
          return {
            ...c,
            dailyBudget: newBudget,
            status: c.spentToday >= newBudget ? "QUOTA_REACHED" : "ACTIVE",
          };
        }
        return c;
      })
    );
  };

  const handleCardCreated = (newCard: AgentVirtualCard) => {
    setCards((prev) => [newCard, ...prev]);
  };

  const handleSimulatePayment = () => {
    const activeCards = cards.filter((c) => c.status === "ACTIVE");
    if (activeCards.length === 0) return;

    const card = activeCards[Math.floor(Math.random() * activeCards.length)];
    const cost = 0.05;

    if (card.spentToday + cost >= card.dailyBudget) {
      handleSimulateBlockedLoop();
      return;
    }

    setCards((prev) =>
      prev.map((c) => {
        if (c.id === card.id) {
          const spentToday = Number((c.spentToday + cost).toFixed(3));
          return {
            ...c,
            spentToday,
            requestCount: c.requestCount + 1,
            lastActive: "刚刚",
            status: spentToday >= c.dailyBudget ? "QUOTA_REACHED" : "ACTIVE",
          };
        }
        return c;
      })
    );

    setVault((prev) => ({
      ...prev,
      totalBalance: Number((prev.totalBalance - cost).toFixed(3)),
      todaySpentTotal: Number((prev.todaySpentTotal + cost).toFixed(3)),
    }));

    const newLog: SpendingLog = {
      id: `log-${Date.now()}`,
      timestamp: new Date().toLocaleTimeString(),
      agentId: card.id,
      agentName: card.name,
      amount: cost,
      currency: "SUI",
      targetService: card.allowedServices[0] || "api.deepseek.sui",
      type: "x402_INFERENCE",
      status: "SUCCESS",
      details: "HTTP 402 Paid: Agent 链上即时扣款微支付",
      txDigest: `0x${Math.random().toString(36).substring(2, 8)}...`,
    };

    setLogs((prev) => [newLog, ...prev]);
  };

  const handleSimulateBlockedLoop = () => {
    setVault((prev) => ({
      ...prev,
      blockedLoopsCount: prev.blockedLoopsCount + 1,
    }));

    const newLog: SpendingLog = {
      id: `log-${Date.now()}`,
      timestamp: new Date().toLocaleTimeString(),
      agentId: cards[0].id,
      agentName: cards[0].name,
      amount: 0.05,
      currency: "SUI",
      targetService: "api.deepseek.sui",
      type: "x402_INFERENCE",
      status: "BLOCKED",
      details: "Move 沙盒死循环防爆拦截: 单周期频次超阈值 (E_LOOP_GAS_EXHAUSTED)",
    };

    setLogs((prev) => [newLog, ...prev]);
  };

  const handleEmergencyPurge = () => {
    setCards((prev) => prev.map((c) => ({ ...c, status: "REVOKED" })));
    setVault((prev) => ({ ...prev, version: prev.version + 1, totalBalance: 0 }));
  };

  const container = {
    hidden: { opacity: 0 },
    show: { opacity: 1, transition: { staggerChildren: 0.08 } },
  };

  const item = {
    hidden: { opacity: 0, y: 15 },
    show: { opacity: 1, y: 0 },
  };

  return (
    <div className="space-y-4">
      {/* Header Banner */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-xl font-bold tracking-tight">AI Agent 虚拟副卡</h2>
            <Badge variant="outline" className="bg-primary/10 text-primary border-primary/20 text-xs">
              Sui Move 沙盒
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            基于受限 AgentCap 与 x402 协议，为 AI Agent 设立单日配额与防爆卡死循环保护
          </p>
        </div>
        <Button
          size="sm"
          className="bg-gradient-to-r from-primary to-purple-500 hover:from-primary/90 hover:to-purple-500/90 text-white text-xs gap-1"
          onClick={() => setIsCreateOpen(true)}
        >
          <Plus className="w-3.5 h-3.5" /> 签发副卡
        </Button>
      </div>

      {/* 6 Quick Action Grid */}
      <div className="grid grid-cols-3 gap-2">
        <Card
          className="cursor-pointer hover:shadow-md transition-all border border-border/50 bg-card/60"
          onClick={() => setIsCreateOpen(true)}
        >
          <CardContent className="p-2.5 flex flex-col items-center justify-center text-center">
            <div className="h-8 w-8 rounded-full bg-gradient-to-br from-primary to-purple-500 flex items-center justify-center text-white mb-1.5 shadow-xs">
              <Plus className="h-4 w-4" />
            </div>
            <span className="text-xs font-bold">新建副卡</span>
            <span className="text-[10px] text-muted-foreground">签发 AgentCap</span>
          </CardContent>
        </Card>

        <Card
          className="cursor-pointer hover:shadow-md transition-all border border-border/50 bg-card/60"
          onClick={handleSimulatePayment}
        >
          <CardContent className="p-2.5 flex flex-col items-center justify-center text-center">
            <div className="h-8 w-8 rounded-full bg-gradient-to-br from-amber-500 to-orange-400 flex items-center justify-center text-white mb-1.5 shadow-xs">
              <Zap className="h-4 w-4" />
            </div>
            <span className="text-xs font-bold">x402 支付</span>
            <span className="text-[10px] text-muted-foreground">模拟模型扣费</span>
          </CardContent>
        </Card>

        <Card
          className="cursor-pointer hover:shadow-md transition-all border border-border/50 bg-card/60"
          onClick={handleSimulateBlockedLoop}
        >
          <CardContent className="p-2.5 flex flex-col items-center justify-center text-center">
            <div className="h-8 w-8 rounded-full bg-gradient-to-br from-red-500 to-rose-400 flex items-center justify-center text-white mb-1.5 shadow-xs">
              <ShieldAlert className="h-4 w-4" />
            </div>
            <span className="text-xs font-bold">防爆卡沙盒</span>
            <span className="text-[10px] text-muted-foreground">死循环硬拦截</span>
          </CardContent>
        </Card>
      </div>

      {/* 3 Metric Cards */}
      <div className="grid grid-cols-3 gap-2.5">
        <Card className="bg-gradient-to-br from-primary/10 to-purple-500/10 border-none shadow-sm">
          <CardContent className="p-3 flex flex-col items-center justify-center text-center">
            <TrendingUp className="h-5 w-5 text-primary mb-1" />
            <p className="text-base font-bold text-foreground">{vault.totalBalance.toFixed(1)} SUI</p>
            <p className="text-[11px] text-muted-foreground">金库总资产</p>
          </CardContent>
        </Card>

        <Card className="bg-gradient-to-br from-amber-500/10 to-orange-500/10 border-none shadow-sm">
          <CardContent className="p-3 flex flex-col items-center justify-center text-center">
            <Clock className="h-5 w-5 text-amber-500 mb-1" />
            <p className="text-base font-bold text-foreground">{vault.todaySpentTotal.toFixed(2)} SUI</p>
            <p className="text-[11px] text-muted-foreground">今日消耗配额</p>
          </CardContent>
        </Card>

        <Card className="bg-gradient-to-br from-emerald-500/10 to-teal-500/10 border-none shadow-sm">
          <CardContent className="p-3 flex flex-col items-center justify-center text-center">
            <ShieldCheck className="h-5 w-5 text-emerald-500 mb-1" />
            <p className="text-base font-bold text-foreground">{vault.blockedLoopsCount} 次拦截</p>
            <p className="text-[11px] text-muted-foreground">沙盒死循环防护</p>
          </CardContent>
        </Card>
      </div>

      {/* Virtual Cards List */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
            运行中的副卡 ({cards.length})
          </h3>
          <span className="text-[11px] text-muted-foreground">每 24h Epoch 自动重置</span>
        </div>

        <motion.div className="grid gap-3" variants={container} initial="hidden" animate="show">
          {cards.map((card) => {
            const quotaPercent = Math.min(100, Math.round((card.spentToday / card.dailyBudget) * 100));

            return (
              <motion.div key={card.id} variants={item}>
                <Card
                  className="overflow-hidden hover:shadow-md transition-all border-none shadow-sm bg-card cursor-pointer group"
                  onClick={() => setSelectedCard(card)}
                >
                  <div className={`h-1.5 bg-gradient-to-r ${card.color}`} />
                  <CardHeader className="p-3 pb-1">
                    <div className="flex items-start justify-between">
                      <div>
                        <h4 className="font-semibold text-sm group-hover:text-primary transition-colors">
                          {card.name}
                        </h4>
                        <p className="text-xs text-muted-foreground line-clamp-1 mt-0.5">{card.purpose}</p>
                      </div>
                      <Badge
                        variant="outline"
                        className={`text-[10px] font-medium px-2 py-0.5 ${
                          card.status === "ACTIVE"
                            ? "bg-emerald-500/10 text-emerald-500 border-emerald-500/20"
                            : card.status === "QUOTA_REACHED"
                            ? "bg-amber-500/10 text-amber-500 border-amber-500/20"
                            : "bg-muted text-muted-foreground"
                        }`}
                      >
                        {card.status === "ACTIVE" && "● 运行中"}
                        {card.status === "QUOTA_REACHED" && "⏳ 额度达上限"}
                        {card.status === "PAUSED" && "⏸ 已暂停"}
                      </Badge>
                    </div>
                  </CardHeader>

                  <CardContent className="p-3 pt-2">
                    <div className="space-y-1.5 mb-2.5">
                      <div className="flex justify-between items-center text-xs">
                        <span className="text-muted-foreground text-[11px]">今日消耗 / 每日限额</span>
                        <span className="font-mono font-medium text-xs">
                          {card.spentToday.toFixed(2)} / {card.dailyBudget.toFixed(2)} SUI
                        </span>
                      </div>
                      <Progress value={quotaPercent} className="h-1.5" />
                    </div>

                    <div className="flex items-center justify-between pt-1 border-t border-border/40">
                      <span className="text-[11px] text-muted-foreground font-mono">
                        {card.allowedServices[0] || "x402-gateway.sui"}
                      </span>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 text-xs text-primary flex items-center gap-1 hover:bg-primary/10"
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectedCard(card);
                        }}
                      >
                        查看详情 <ArrowRight className="h-3 w-3" />
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              </motion.div>
            );
          })}
        </motion.div>
      </div>

      {/* x402 Micropayments Stream */}
      <div className="space-y-2 pt-2">
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
          实时 x402 微支付与沙盒拦截流
        </h3>
        <div className="space-y-2">
          {logs.slice(0, 4).map((log) => {
            const isBlocked = log.status.startsWith("BLOCKED");
            return (
              <div
                key={log.id}
                className="flex items-center justify-between p-2.5 rounded-xl border border-border/40 bg-card/40 text-xs"
              >
                <div className="flex items-center gap-2.5">
                  <div
                    className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${
                      isBlocked ? "bg-red-500/15 text-red-500" : "bg-emerald-500/15 text-emerald-500"
                    }`}
                  >
                    {isBlocked ? <ShieldAlert className="w-3.5 h-3.5" /> : <Zap className="w-3.5 h-3.5" />}
                  </div>
                  <div>
                    <p className="font-semibold text-xs">{log.agentName}</p>
                    <p className="text-[10px] text-muted-foreground font-mono">{log.details}</p>
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <p className={`font-mono font-bold ${isBlocked ? "text-red-500 line-through" : "text-foreground"}`}>
                    {isBlocked ? "+0.00 SUI" : `-${log.amount.toFixed(3)} SUI`}
                  </p>
                  <span className="text-[10px] text-muted-foreground">{log.timestamp}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Dialogs */}
      <AgentDetailsDialog
        card={selectedCard}
        open={Boolean(selectedCard)}
        onOpenChange={(open) => !open && setSelectedCard(null)}
        onTogglePause={handleTogglePause}
        onOpenAdjust={(card) => setAdjustTargetCard(card)}
        onOpenExport={(card) => setExportTargetCard(card)}
      />

      <CreateAgentDialog
        open={isCreateOpen}
        onOpenChange={setIsCreateOpen}
        onCreateCard={handleCardCreated}
      />

      <AdjustBudgetDialog
        card={adjustTargetCard}
        open={Boolean(adjustTargetCard)}
        onOpenChange={(open) => !open && setAdjustTargetCard(null)}
        onSave={handleSaveBudget}
      />

      <ExportConfigDialog
        card={exportTargetCard}
        open={Boolean(exportTargetCard)}
        onOpenChange={(open) => !open && setExportTargetCard(null)}
      />

      <EmergencyLiquidationDialog
        open={isEmergencyPurgeOpen}
        onOpenChange={setIsEmergencyPurgeOpen}
        totalBalance={vault.totalBalance}
        onConfirmPurge={handleEmergencyPurge}
      />
    </div>
  );
}
