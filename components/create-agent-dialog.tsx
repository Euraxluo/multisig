"use client";

import { useState } from "react";
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
import { Badge } from "@/components/ui/badge";
import { ShieldCheck, Bot, Key, Sparkles, Check } from "lucide-react";
import { AgentVirtualCard } from "@/types/agent";

interface CreateAgentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreateCard: (card: AgentVirtualCard) => void;
}

export function CreateAgentDialog({
  open,
  onOpenChange,
  onCreateCard,
}: CreateAgentDialogProps) {
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [category, setCategory] = useState<AgentVirtualCard["category"]>("LLM_INFERENCE");
  const [dailyBudget, setDailyBudget] = useState("5.0");
  const [allowedServicesInput, setAllowedServicesInput] = useState(
    "api.deepseek.sui, api.siliconflow.sui, x402-gateway.sui"
  );
  const [generatedKey, setGeneratedKey] = useState<string | null>(null);

  const handleCreate = () => {
    if (!name.trim()) return;

    // Simulate key generation
    const randomHex = Array.from({ length: 40 }, () =>
      Math.floor(Math.random() * 16).toString(16)
    ).join("");
    const mockAddress = `0x${randomHex}`;
    const mockCapId = `0xcap_${Date.now().toString(16)}`;
    const mockPrivateKey = `suiprivkey1${Math.random().toString(36).substring(2, 15)}${Math.random().toString(36).substring(2, 15)}`;

    const services = allowedServicesInput
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const newCard: AgentVirtualCard = {
      id: `card-${Date.now()}`,
      name,
      purpose: purpose || "AI Autonomous Task Execution",
      category,
      address: mockAddress,
      capId: mockCapId,
      agentCapId: mockCapId,
      dailyBudget: parseFloat(dailyBudget) || 5.0,
      spentToday: 0,
      totalSpent: 0,
      requestCount: 0,
      status: "ACTIVE",
      allowedServices: services,
      lastActive: "刚刚创建",
      color:
        category === "LLM_INFERENCE"
          ? "from-blue-600 to-indigo-600"
          : category === "DATA_SCRAPING"
          ? "from-amber-500 to-orange-600"
          : category === "STORAGE"
          ? "from-emerald-500 to-teal-600"
          : "from-purple-600 to-pink-600",
      privateKeyExported: mockPrivateKey,
    };

    onCreateCard(newCard);
    setGeneratedKey(mockPrivateKey);
  };

  const handleClose = () => {
    setName("");
    setPurpose("");
    setGeneratedKey(null);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-primary to-purple-600 flex items-center justify-center text-white">
              <Bot className="w-4 h-4" />
            </div>
            <span>签发 AI Agent 虚拟副卡</span>
          </DialogTitle>
          <DialogDescription>
            在 Sui 链上铸造受限 `AgentCap`，分配单日配额与 x402 服务白名单。
          </DialogDescription>
        </DialogHeader>

        {!generatedKey ? (
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="agent-name">副卡名称</Label>
              <Input
                id="agent-name"
                placeholder="例如: Qwen-2.5-Coder-Agent"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="agent-purpose">业务用途</Label>
              <Input
                id="agent-purpose"
                placeholder="例如: 执行自动化测试与代码补全"
                value={purpose}
                onChange={(e) => setPurpose(e.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <Label>卡片分类</Label>
              <div className="grid grid-cols-2 gap-2">
                {[
                  { key: "LLM_INFERENCE", label: "LLM 推理", color: "border-blue-500/40 text-blue-600" },
                  { key: "DATA_SCRAPING", label: "爬虫与情报", color: "border-amber-500/40 text-amber-600" },
                  { key: "STORAGE", label: "Walrus 存储", color: "border-emerald-500/40 text-emerald-600" },
                  { key: "DEFI_EXECUTION", label: "DeFi 执行", color: "border-purple-500/40 text-purple-600" },
                ].map((item) => (
                  <Button
                    key={item.key}
                    type="button"
                    variant={category === item.key ? "default" : "outline"}
                    size="sm"
                    className={`justify-start text-xs ${
                      category === item.key
                        ? "bg-gradient-to-r from-primary to-purple-600 text-white"
                        : item.color
                    }`}
                    onClick={() => setCategory(item.key as AgentVirtualCard["category"])}
                  >
                    <Sparkles className="w-3.5 h-3.5 mr-1" />
                    {item.label}
                  </Button>
                ))}
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="daily-budget">单日配额上限 (SUI)</Label>
              <div className="relative">
                <Input
                  id="daily-budget"
                  type="number"
                  step="0.5"
                  value={dailyBudget}
                  onChange={(e) => setDailyBudget(e.target.value)}
                  className="pr-14"
                />
                <span className="absolute right-3 top-2.5 text-xs text-muted-foreground font-semibold">
                  SUI / 天
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                受 Move 字节码沙盒保护，超出限额即刻熔断。
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="allowed-services">允许调用的 x402 网关白名单</Label>
              <Input
                id="allowed-services"
                value={allowedServicesInput}
                onChange={(e) => setAllowedServicesInput(e.target.value)}
                placeholder="逗号分隔"
                className="text-xs font-mono"
              />
            </div>
          </div>
        ) : (
          <div className="space-y-4 py-3">
            <div className="p-3 rounded-lg bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800">
              <div className="flex items-center gap-2 text-emerald-700 dark:text-emerald-400 font-semibold text-sm">
                <Check className="w-4 h-4" />
                <span>副卡已在 Sui 上成功签发！</span>
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                已生成受限 Agent 独立私钥，请将环境变量提供给 Agent 运行容器。
              </p>
            </div>

            <div className="space-y-2">
              <Label className="text-xs font-semibold">Agent 专属私钥 (请妥善保存)</Label>
              <div className="p-2.5 bg-muted rounded-md font-mono text-xs break-all select-all border border-border">
                {generatedKey}
              </div>
            </div>

            <div className="p-2.5 bg-primary/5 rounded-md border border-primary/20 text-xs text-primary space-y-1">
              <div className="font-semibold flex items-center gap-1">
                <Key className="w-3.5 h-3.5" />
                <span>Agent .env 快速配置</span>
              </div>
              <div className="font-mono text-[11px] text-muted-foreground">
                SUI_AGENT_PRIVKEY={generatedKey}<br />
                SUI_AGENT_CAP={name}
              </div>
            </div>
          </div>
        )}

        <DialogFooter>
          {!generatedKey ? (
            <>
              <Button variant="outline" onClick={handleClose}>
                取消
              </Button>
              <Button
                onClick={handleCreate}
                disabled={!name.trim()}
                className="bg-gradient-to-r from-primary to-purple-600 hover:from-primary/90 hover:to-purple-600/90 text-white"
              >
                <ShieldCheck className="w-4 h-4 mr-1.5" />
                立即铸造副卡
              </Button>
            </>
          ) : (
            <Button
              onClick={handleClose}
              className="w-full bg-gradient-to-r from-primary to-purple-600 text-white"
            >
              完成并关闭
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
