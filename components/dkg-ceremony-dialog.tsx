"use client";

import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { motion, AnimatePresence } from "framer-motion";
import {
  ShieldCheck,
  Cpu,
  Key,
  Network,
  Users,
  CheckCircle2,
  RefreshCw,
  Sparkles,
  ArrowRight,
  Lock,
  Layers,
  Mail,
  Inbox,
  Clock,
  Send,
} from "lucide-react";

interface DkgCeremonyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groupName: string;
  initialMembers: { name: string; address: string; weight: number }[];
  onConvertedSuccess?: (groupPk: string, orgId: string) => void;
}

type CeremonyMode = "SYNC" | "ASYNC_MAILBOX";

type CeremonyStep =
  | "INIT"
  | "ROUND_1_COMMITMENTS"
  | "ROUND_2_SHARES"
  | "COMPUTING_PK"
  | "DEPLOYING_ONCHAIN"
  | "COMPLETE"
  | "RESHARING_ACTIVE";

export function DkgCeremonyDialog({
  open,
  onOpenChange,
  groupName,
  initialMembers,
  onConvertedSuccess,
}: DkgCeremonyDialogProps) {
  const [mode, setMode] = useState<CeremonyMode>("ASYNC_MAILBOX");
  const [step, setStep] = useState<CeremonyStep>("INIT");
  const [progress, setProgress] = useState(0);
  const [activeLog, setActiveLog] = useState<string>("等待启动分布式密钥生成 (FROST DKG)...");
  const [groupPk, setGroupPk] = useState<string>("");
  const [orgObjectId, setOrgObjectId] = useState<string>("");

  // 异步信箱状态
  const [davidAwakened, setDavidAwakened] = useState(false);
  const [davidWakeupLog, setDavidWakeupLog] = useState<string>("");

  // Resharing 状态
  const [reshareMembers, setReshareMembers] = useState(initialMembers);
  const [reshareLog, setReshareLog] = useState<string>("");

  const handleStartDkg = async () => {
    setStep("ROUND_1_COMMITMENTS");
    setProgress(25);
    setActiveLog("【步骤 1】Alice 已确认升级提案...");
    await new Promise((r) => setTimeout(r, 1000));

    setStep("ROUND_2_SHARES");
    setProgress(55);
    setActiveLog("【步骤 2】Bob 已确认升级提案...");
    await new Promise((r) => setTimeout(r, 1000));

    setStep("COMPUTING_PK");
    setProgress(80);
    setActiveLog("【步骤 3】Charlie 已确认，已达成所需门限 (3/4)...");
    const simulatedPk = "0xc469b05e3e7cdbb91e49cba1f08686f6e920df5a9598ad21a063ab4f71ca2e0d";
    setGroupPk(simulatedPk);
    await new Promise((r) => setTimeout(r, 1000));

    setStep("DEPLOYING_ONCHAIN");
    setProgress(95);
    setActiveLog("正在部署链上组织合约...");
    await new Promise((r) => setTimeout(r, 1000));

    const simulatedOrgId = "0x8a1b7e41590d996e00000000000000000000000000000000000000000000cafe";
    setOrgObjectId(simulatedOrgId);
    setProgress(100);
    setStep("COMPLETE");
    setActiveLog("升级成功！组织已成功部署在链上。");

    if (onConvertedSuccess) {
      onConvertedSuccess(simulatedPk, simulatedOrgId);
    }
  };

  const handleDavidWakeup = async () => {
    setDavidWakeupLog("David 已确认并同步成员状态...");
    await new Promise((r) => setTimeout(r, 1000));
    setDavidAwakened(true);
    setDavidWakeupLog("David 状态同步完成，已成功加入治理。");
  };

  const handleTriggerResharing = async () => {
    setStep("RESHARING_ACTIVE");
    setReshareLog("引入新成员 Eve (@0xEE7E)...");
    await new Promise((r) => setTimeout(r, 1000));

    setReshareMembers([
      ...initialMembers,
      { name: "Eve (新加入)", address: "0xee7e...a001", weight: 2 },
    ]);
    setReshareLog("成员更新成功，组织主地址保持不变。");
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[94vw] max-w-[460px] p-0 overflow-hidden bg-background border border-border rounded-2xl">
        {/* Header */}
        <div className="bg-muted/30 p-4 border-b border-border/50">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-2.5">
              <div className="w-8 h-8 bg-primary/10 rounded-xl text-primary flex items-center justify-center">
                <Network className="h-4 w-4" />
              </div>
              <div>
                <DialogTitle className="text-sm font-semibold">
                  升级为链上组织 (DAO)
                </DialogTitle>
                <p className="text-xs text-muted-foreground mt-0.5">
                  成员确认即可完成升级，无需同时在线
                </p>
              </div>
            </div>
            <Badge variant="outline" className="text-xs">
              {step === "INIT" ? "可升级" : step === "COMPLETE" ? "已就绪" : "升级中"}
            </Badge>
          </div>
        </div>

        {/* Content Body */}
        <div className="p-4 space-y-3.5">
          {/* 进度指示 */}
          {step !== "INIT" && step !== "COMPLETE" && step !== "RESHARING_ACTIVE" && (
            <div className="space-y-1.5">
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>升级进度</span>
                <span className="font-semibold text-primary">{progress}%</span>
              </div>
              <Progress value={progress} className="h-1.5" />
            </div>
          )}

          {/* 状态日志盒子 */}
          <div className="p-2.5 bg-muted/30 rounded-xl border border-border/40 text-xs space-y-1">
            <div className="flex items-center text-primary space-x-1.5 font-medium">
              <Cpu className="h-3.5 w-3.5" />
              <span>当前状态</span>
            </div>
            <p className="text-muted-foreground pl-5">{activeLog}</p>
          </div>

          {/* 阶段 1: 准备启动 */}
          {step === "INIT" && (
            <div className="space-y-3">
              <div className="p-3.5 rounded-xl border border-primary/20 bg-primary/5 space-y-2">
                <div className="flex items-center space-x-2 text-primary font-medium text-xs">
                  <ShieldCheck className="h-4 w-4" />
                  <span>为什么必须 100% 全异步 (Zero Simultaneous Online)？</span>
                </div>
                <ul className="text-xs text-muted-foreground space-y-1.5 list-disc list-inside">
                  <li>
                    <strong>真实世界痛点</strong>：移动端用户随时可能离线、息屏或处于不同时区，无法维持同时在线长连接；
                  </li>
                  <li>
                    <strong>单阶段投递 (Single-Shot)</strong>：成员打开 App 一次性广播承诺并存入各成员信箱，操作完毕即可退出；
                  </li>
                  <li>
                    <strong>门限容错 (3/4 Quorum)</strong>：只要累计确认数达到门限，无需等待全员，组织立即固化生效；
                  </li>
                  <li>
                    <strong>全异步治理</strong>：后续国库提案与门限签名也是成员在各自时间签署，由 Relayer 一键执行！
                  </li>
                </ul>
              </div>

              {/* 参与成员列表 */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span className="font-medium">群成员状态：</span>
                  <span className="text-[11px] text-primary">3/4 成员同意即可升级</span>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {initialMembers.map((m, idx) => {
                    return (
                      <div
                        key={idx}
                        className="flex items-center p-2 rounded-lg border text-xs bg-muted/30 border-border/40"
                      >
                        <Avatar className="h-6 w-6 mr-2">
                          <AvatarFallback className="bg-primary/20 text-primary text-[10px]">
                            {m.name[0]}
                          </AvatarFallback>
                        </Avatar>
                        <div className="truncate flex-1">
                          <div className="flex items-center space-x-1">
                            <span className="font-medium truncate">{m.name}</span>
                            <Badge variant="outline" className="text-[9px] px-1 py-0 h-4 border-primary/40 text-primary">
                              {idx === 3 ? "待同步" : "已确认"}
                            </Badge>
                          </div>
                          <span className="text-muted-foreground text-[10px]">
                            权重: {m.weight}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              <Button onClick={handleStartDkg} className="w-full mt-2">
                <Sparkles className="h-4 w-4 mr-2" />
                确认升级为 DAO
              </Button>
            </div>
          )}

          {/* 阶段 2: 正在运行步骤 */}
          {(step === "ROUND_1_COMMITMENTS" || step === "ROUND_2_SHARES" || step === "COMPUTING_PK" || step === "DEPLOYING_ONCHAIN") && (
            <div className="py-6 flex flex-col items-center justify-center space-y-3 text-center">
              <div className="relative">
                <div className="w-12 h-12 rounded-2xl bg-primary/20 flex items-center justify-center text-primary animate-spin">
                  <RefreshCw className="h-6 w-6" />
                </div>
                <Lock className="h-3.5 w-3.5 text-primary absolute -bottom-1 -right-1" />
              </div>
              <div>
                <p className="font-semibold text-sm">
                  正在同步成员确认...
                </p>
                <p className="text-xs text-muted-foreground mt-1 max-w-sm">
                  成员确认已同步，组织合约部署中...
                </p>
              </div>
            </div>
          )}

          {/* 阶段 3: 转化完成态 */}
          {(step === "COMPLETE" || step === "RESHARING_ACTIVE") && (
            <div className="space-y-3">
              <div className="p-3.5 rounded-xl border border-emerald-500/30 bg-emerald-500/5 space-y-2.5">
                <div className="flex items-center space-x-2 text-emerald-600 dark:text-emerald-400 font-medium text-sm">
                  <CheckCircle2 className="h-4 w-4" />
                  <span>升级成功！组织已成功部署在链上</span>
                </div>

                <div className="space-y-2 text-xs">
                  <div>
                    <span className="text-muted-foreground">组织公钥地址:</span>
                    <div className="p-2 bg-background rounded-lg border border-border/40 font-mono text-[11px] truncate select-all mt-0.5">
                      {groupPk}
                    </div>
                  </div>
                  <div>
                    <span className="text-muted-foreground">链上合约 ID:</span>
                    <div className="p-2 bg-background rounded-lg border border-border/40 font-mono text-[11px] truncate select-all mt-0.5">
                      {orgObjectId}
                    </div>
                  </div>
                </div>
              </div>

              {/* 成员同步卡片 */}
              {mode === "ASYNC_MAILBOX" && (
                <div className="p-3 rounded-xl border border-border/50 bg-muted/20 space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center space-x-1.5 text-xs font-semibold">
                      <Inbox className="h-3.5 w-3.5 text-primary" />
                      <span>离线成员同步</span>
                    </div>
                    <Badge variant={davidAwakened ? "outline" : "secondary"} className={`text-[10px] ${davidAwakened ? "border-emerald-500/40 text-emerald-500" : ""}`}>
                      {davidAwakened ? "已同步" : "待同步"}
                    </Badge>
                  </div>
                  
                  <p className="text-xs text-muted-foreground">
                    {davidAwakened
                      ? "离线成员 David 现已同步，具备完整签名权限！"
                      : "多数成员已确认，无需等待全员在线即可开始治理。"}
                  </p>

                  {davidWakeupLog && (
                    <p className="text-xs font-mono text-primary bg-primary/10 p-2 rounded-lg">
                      {davidWakeupLog}
                    </p>
                  )}

                  {!davidAwakened && (
                    <div className="flex justify-end pt-0.5">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleDavidWakeup}
                        className="text-xs"
                      >
                        <Clock className="h-3 w-3 mr-1" />
                        同步 David 成员状态
                      </Button>
                    </div>
                  )}
                </div>
              )}

              {/* 动态成员调整 */}
              <div className="p-3 rounded-xl border border-border/50 bg-muted/20 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-1.5 text-xs font-semibold">
                    <Layers className="h-3.5 w-3.5 text-primary" />
                    <span>动态调整成员</span>
                  </div>
                  <Badge variant="secondary" className="text-[10px]">
                    地址保持不变
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  当有新成员加入或移除时，组织地址与资产保持恒定，无需重新部署。
                </p>

                {reshareLog && (
                  <p className="text-xs font-mono text-primary bg-primary/10 p-2 rounded-lg">
                    {reshareLog}
                  </p>
                )}

                <div className="flex justify-end pt-1">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleTriggerResharing}
                    className="text-xs border-primary/30 text-primary"
                  >
                    <RefreshCw className="h-3 w-3 mr-1" />
                    添加新成员
                  </Button>
                </div>
              </div>

              <Button onClick={() => onOpenChange(false)} className="w-full">
                完成并返回群组
              </Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
