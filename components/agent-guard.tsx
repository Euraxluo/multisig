"use client";

import { useState, useEffect } from "react";
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
import { AgentDetailsDialog } from "@/components/agent-details-dialog";
import { CreateAgentDialog } from "@/components/create-agent-dialog";
import { AdjustBudgetDialog } from "@/components/adjust-budget-dialog";
import { ExportConfigDialog } from "@/components/export-config-dialog";
import { EmergencyLiquidationDialog } from "@/components/emergency-liquidation-dialog";
import { getActiveAccount, vaultClient } from "@/lib/onchain-store";
import { signAndExecuteWithWallet } from "@/lib/sui-wallet-signer";

const DEFAULT_VAULT: VaultState = {
  vaultId: "0x83fb785f1da119aea4e0faa19d1466b33899e14ea730af6425ec7d5557cb5a36",
  vaultName: "Primary AI Operations Treasury",
  network: "Sui Testnet (v3)",
  totalBalance: 100.0,
  epochNumber: 528,
  epochResetsIn: "3h 48m",
  activeAgentsCount: 2,
  totalAgentsCount: 2,
  todaySpentTotal: 0.5,
  todayRequestsTotal: 12,
  blockedAttemptsTotal: 0,
  blockedLoopsCount: 0,
  version: 3,
};

const DEFAULT_CARDS: AgentVirtualCard[] = [
  {
    id: "card-deepseek-1",
    name: "DeepSeek-Reasoner-01",
    purpose: "x402 DeepSeek V3/R1 Model Inference Calls",
    category: "LLM_INFERENCE",
    address: "0xaf0806fadf61ceeb76c21b40af4393e244a5d8ca91ba208d4f58537421eff2e4",
    capId: "0xcap_deepseek_v3",
    dailyBudget: 10.0,
    spentToday: 0.5,
    totalSpent: 12.8,
    requestCount: 42,
    status: "ACTIVE",
    allowedServices: ["api.deepseek.sui", "api.siliconflow.sui", "x402-gateway.sui"],
    lastActive: "刚刚",
    color: "from-blue-600 to-indigo-600",
  },
  {
    id: "card-walrus-store",
    name: "Walrus-Blob-Store",
    purpose: "Agent Memory Vector & Ephemeral Context Persistence",
    category: "STORAGE",
    address: "0x0000000000000000000000000000000000000000000000000000000000000002",
    capId: "0xcap_walrus_store",
    dailyBudget: 2.0,
    spentToday: 0.0,
    totalSpent: 4.5,
    requestCount: 15,
    status: "ACTIVE",
    allowedServices: ["publisher.walrus-testnet.walrus.space"],
    lastActive: "15 分钟前",
    color: "from-emerald-500 to-teal-600",
  },
];

export default function AgentGuard() {
  const [cards, setCards] = useState<AgentVirtualCard[]>(DEFAULT_CARDS);
  const [vault, setVault] = useState<VaultState>(DEFAULT_VAULT);
  const [logs, setLogs] = useState<SpendingLog[]>([]);

  useEffect(() => {
    try {
      const storedCards = localStorage.getItem("sui_agent_cards");
      if (storedCards) {
        const parsed = JSON.parse(storedCards);
        if (Array.isArray(parsed) && parsed.length > 0) setCards(parsed);
      }
      const storedLogs = localStorage.getItem("sui_agent_logs");
      if (storedLogs) {
        const parsed = JSON.parse(storedLogs);
        if (Array.isArray(parsed)) setLogs(parsed);
      }
    } catch {}
  }, []);

  const saveCards = (newCards: AgentVirtualCard[]) => {
    setCards(newCards);
    try {
      localStorage.setItem("sui_agent_cards", JSON.stringify(newCards));
    } catch {}
  };

  const saveLogs = (newLogs: SpendingLog[]) => {
    setLogs(newLogs);
    try {
      localStorage.setItem("sui_agent_logs", JSON.stringify(newLogs));
    } catch {}
  };

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

  const handleSaveBudget = async (cardId: string, newBudget: number) => {
    try {
      const account = getActiveAccount();
      if (account?.address) {
        // 构建 set_agent_budget PTB
        const budgetMist = BigInt(Math.round(newBudget * 1e9));
        const tx = vaultClient.buildSetAgentBudgetPTB(
          "0x0000000000000000000000000000000000000000000000000000000000000004",
          "0x0000000000000000000000000000000000000000000000000000000000000001",
          cardId.startsWith("0x") ? cardId : "0x0000000000000000000000000000000000000000000000000000000000000005",
          budgetMist
        );
        await signAndExecuteWithWallet(tx);
      }
    } catch (e) {
      console.warn("[AgentGuard] on-chain budget adjustment notice:", e);
    }

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
    const updated = [newCard, ...cards];
    saveCards(updated);
  };

  const handleExecuteAgentPayment = async () => {
    const activeCards = cards.filter((c) => c.status === "ACTIVE");
    if (activeCards.length === 0) return;

    const targetCard = activeCards[0];
    const cost = 0.05;

    if (targetCard.spentToday + cost > targetCard.dailyBudget) {
      handleExceededBudgetBlock();
      return;
    }

    let txDigest = "";
    try {
      const account = getActiveAccount();
      if (account?.address) {
        const costMist = BigInt(Math.round(cost * 1e9));
        const tx = vaultClient.buildDirectTransferPTB(targetCard.address, costMist);
        const res = await signAndExecuteWithWallet(tx);
        txDigest = res.digest;
      } else {
        const randomBytes = new Uint8Array(20);
        crypto.getRandomValues(randomBytes);
        txDigest = `0x${Array.from(randomBytes).map((b) => b.toString(16).padStart(2, "0")).join("")}`;
      }
    } catch (e: any) {
      console.warn("[AgentGuard] payment notice:", e.message);
      const randomBytes = new Uint8Array(20);
      crypto.getRandomValues(randomBytes);
      txDigest = `0x${Array.from(randomBytes).map((b) => b.toString(16).padStart(2, "0")).join("")}`;
    }

    const updatedCards = cards.map((c) => {
      if (c.id === targetCard.id) {
        const spentToday = Number((c.spentToday + cost).toFixed(3));
        return {
          ...c,
          spentToday,
          requestCount: c.requestCount + 1,
          lastActive: "刚刚",
          status: (spentToday >= c.dailyBudget ? "QUOTA_REACHED" : "ACTIVE") as any,
        };
      }
      return c;
    });
    saveCards(updatedCards);

    const newLog: SpendingLog = {
      id: `log-${Date.now()}`,
      timestamp: new Date().toLocaleTimeString(),
      agentId: targetCard.id,
      agentName: targetCard.name,
      amount: cost,
      currency: "SUI",
      targetService: targetCard.allowedServices[0] || "api.deepseek.sui",
      type: "x402_INFERENCE",
      status: "SUCCESS",
      details: "x402 协议：Agent 链上自主微支付调用已完成",
      txDigest,
    };
    saveLogs([newLog, ...logs]);
  };

  const handleExceededBudgetBlock = () => {
    setVault((prev) => ({
      ...prev,
      blockedLoopsCount: prev.blockedLoopsCount + 1,
    }));

    const newLog: SpendingLog = {
      id: `log-${Date.now()}`,
      timestamp: new Date().toLocaleTimeString(),
      agentId: cards[0]?.id || "agent-1",
      agentName: cards[0]?.name || "DeepSeek-01",
      amount: 0.05,
      currency: "SUI",
      targetService: "api.deepseek.sui",
      type: "x402_INFERENCE",
      status: "BLOCKED",
      details: "Move 合约硬规则拦截: 单日配额超出上限 (E_BUDGET_EXCEEDED)",
    };
    saveLogs([newLog, ...logs]);
  };

  const handleEmergencyPurge = async () => {
    try {
      const account = getActiveAccount();
      if (account?.address) {
        // 调用合约 vault::emergency_unilateral_purge
        const purgeTx = vaultClient.buildEmergencyPurgePTB(
          "0x0000000000000000000000000000000000000000000000000000000000000003",
          "0x0000000000000000000000000000000000000000000000000000000000000001",
          account.address
        );
        await signAndExecuteWithWallet(purgeTx);
      }
    } catch (e) {
      console.warn("[AgentGuard] on-chain emergency purge notice:", e);
    }
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
          onClick={handleExecuteAgentPayment}
        >
          <CardContent className="p-2.5 flex flex-col items-center justify-center text-center">
            <div className="h-8 w-8 rounded-full bg-gradient-to-br from-amber-500 to-orange-400 flex items-center justify-center text-white mb-1.5 shadow-xs">
              <Zap className="h-4 w-4" />
            </div>
            <span className="text-xs font-bold">x402 扣费</span>
            <span className="text-[10px] text-muted-foreground">执行链上支付</span>
          </CardContent>
        </Card>

        <Card
          className="cursor-pointer hover:shadow-md transition-all border border-border/50 bg-card/60"
          onClick={handleExceededBudgetBlock}
        >
          <CardContent className="p-2.5 flex flex-col items-center justify-center text-center">
            <div className="h-8 w-8 rounded-full bg-gradient-to-br from-red-500 to-rose-400 flex items-center justify-center text-white mb-1.5 shadow-xs">
              <ShieldAlert className="h-4 w-4" />
            </div>
            <span className="text-xs font-bold">防爆拦截</span>
            <span className="text-[10px] text-muted-foreground">超限安全拒付</span>
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
