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
    // 步骤 1: 东京时间 09:00
    setStep("ROUND_1_COMMITMENTS");
    setProgress(25);
    setActiveLog("【东京 09:00】Alice 独自在线，提交单阶段 VSS 包（广播承诺并存入各成员密态信箱），完成后关闭 App 离线...");
    await new Promise((r) => setTimeout(r, 1400));

    // 步骤 2: 伦敦时间 14:00
    setStep("ROUND_2_SHARES");
    setProgress(55);
    setActiveLog("【伦敦 14:00】Bob 独自在线，读取 Alice 承诺与信箱分片，提交单阶段包并确认，随后退出...");
    await new Promise((r) => setTimeout(r, 1400));

    // 步骤 3: 纽约时间 20:00
    setStep("COMPUTING_PK");
    setProgress(80);
    setActiveLog("【纽约 20:00】Charlie 独自在线，解密信箱分片并提交确认。门限 (3/4) 达成，组织主公钥固化激活！");
    const simulatedPk = "0xc469b05e3e7cdbb91e49cba1f08686f6e920df5a9598ad21a063ab4f71ca2e0d";
    setGroupPk(simulatedPk);
    await new Promise((r) => setTimeout(r, 1400));

    // 步骤 4: 链上固化
    setStep("DEPLOYING_ONCHAIN");
    setProgress(95);
    setActiveLog("正在调用 Move dkg_committee::finalize_session 铸造 Organization 共享对象并设置 anti-replay 防重放表...");
    await new Promise((r) => setTimeout(r, 1200));

    const simulatedOrgId = "0x8a1b7e41590d996e00000000000000000000000000000000000000000000cafe";
    setOrgObjectId(simulatedOrgId);
    setProgress(100);
    setStep("COMPLETE");
    setActiveLog("纯全异步 DKG 仪式圆满成功！全过程零同时在线要求，组织成功固化为链上密码学 DAO！");

    if (onConvertedSuccess) {
      onConvertedSuccess(simulatedPk, simulatedOrgId);
    }
  };

  const handleDavidWakeup = async () => {
    setDavidWakeupLog("【悉尼 次日 08:00】David 醒来打开 App，从 Sui 链上 Table 提取各成员寄存在其信箱中的 3 份加密分片...");
    await new Promise((r) => setTimeout(r, 1000));

    setDavidWakeupLog("David 使用本地 X25519 私钥成功解密，同态校验 VSS 承诺，聚合生成私钥分片 s_4！");
    await new Promise((r) => setTimeout(r, 1200));

    setDavidAwakened(true);
    setDavidWakeupLog("解密校验成功！David 成功恢复私钥份额 s_4，已完全无缝接入该组织的后续提案与门限签名治理！");
  };

  const handleTriggerResharing = async () => {
    setStep("RESHARING_ACTIVE");
    setReshareLog("启动 Proactive Secret Resharing 仪式：引入新成员 Eve (@0xEE7E)...");
    await new Promise((r) => setTimeout(r, 1000));

    setReshareLog("各在任节点生成常数项为 0 的随机多项式 h_i(x)，执行拉格朗日重共享...");
    await new Promise((r) => setTimeout(r, 1200));

    setReshareMembers([
      ...initialMembers,
      { name: "Eve (新加入)", address: "0xee7e...a001", weight: 2 },
    ]);
    setReshareLog("重分片完成！新私钥份额刷新生效，主公钥 PK_GROUP 与链上 ObjectID 绝对不变！");
    await new Promise((r) => setTimeout(r, 1000));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[560px] p-0 overflow-hidden bg-background border border-border">
        {/* Header */}
        <div className="bg-gradient-to-r from-primary/10 via-purple-500/10 to-transparent p-5 border-b border-border/50">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-2">
              <div className="p-2 bg-primary/20 rounded-xl text-primary">
                <Network className="h-5 w-5" />
              </div>
              <div>
                <DialogTitle className="text-base font-semibold">
                  转为密码学组织 (100% 全异步协议)
                </DialogTitle>
                <p className="text-xs text-muted-foreground mt-0.5">
                  零同时在线要求 · 基于 Sui 共享对象与 X25519 密态信箱存储转发
                </p>
              </div>
            </div>
            <Badge variant="outline" className="text-xs border-primary/40 text-primary">
              {step === "INIT" ? "全异步模式" : step === "COMPLETE" ? "密码学 DAO" : "异步固化中"}
            </Badge>
          </div>
        </div>

        {/* Content Body */}
        <div className="p-5 space-y-4">
          {/* 进度指示 */}
          {step !== "INIT" && step !== "COMPLETE" && step !== "RESHARING_ACTIVE" && (
            <div className="space-y-2">
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>全异步 DKG 状态机推进中</span>
                <span className="font-semibold text-primary">{progress}%</span>
              </div>
              <Progress value={progress} className="h-2" />
            </div>
          )}

          {/* 状态日志盒子 */}
          <div className="p-3 bg-muted/40 rounded-xl border border-border/40 text-xs font-mono space-y-1">
            <div className="flex items-center text-primary space-x-1.5">
              <Cpu className="h-3.5 w-3.5 animate-pulse" />
              <span className="font-semibold">Async State Machine Dispatcher:</span>
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
                  <span className="font-medium">参与 DKG 仪式的成员状态：</span>
                  <span className="text-[11px] text-primary">门限阈值: 3/4 达成即可激活</span>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {initialMembers.map((m, idx) => {
                    const timezones = [
                      "东京 UTC+9 · Pre-Key 已注册",
                      "伦敦 UTC+0 · Pre-Key 已注册",
                      "纽约 UTC-5 · Pre-Key 已注册",
                      "悉尼 UTC+10 · Pre-Key 已注册",
                    ];
                    const tzText = timezones[idx % timezones.length];
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
                              {idx === 3 ? "次日同步" : "异步就绪"}
                            </Badge>
                          </div>
                          <span className="text-muted-foreground text-[10px]">
                            {tzText}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              <Button onClick={handleStartDkg} className="w-full mt-2">
                <Sparkles className="h-4 w-4 mr-2" />
                启动 100% 全异步 DKG 仪式 (跨时区零在线要求)
              </Button>
            </div>
          )}

          {/* 阶段 2: 正在运行步骤 */}
          {(step === "ROUND_1_COMMITMENTS" || step === "ROUND_2_SHARES" || step === "COMPUTING_PK" || step === "DEPLOYING_ONCHAIN") && (
            <div className="py-6 flex flex-col items-center justify-center space-y-3 text-center">
              <div className="relative">
                <div className="w-14 h-14 rounded-2xl bg-primary/20 flex items-center justify-center text-primary animate-spin">
                  <RefreshCw className="h-7 w-7" />
                </div>
                <Lock className="h-4 w-4 text-primary absolute -bottom-1 -right-1" />
              </div>
              <div>
                <p className="font-semibold text-sm">
                  正在推进 100% 纯全异步 DKG 状态机...
                </p>
                <p className="text-xs text-muted-foreground mt-1 max-w-sm">
                  成员在各自时区随时随地在手机上操作一次即可退出，无需与任何其他成员同时在线！
                </p>
              </div>
            </div>
          )}

          {/* 阶段 3: 转化完成态 */}
          {(step === "COMPLETE" || step === "RESHARING_ACTIVE") && (
            <div className="space-y-3">
              <div className="p-4 rounded-xl border border-green-500/30 bg-green-500/5 space-y-3">
                <div className="flex items-center space-x-2 text-green-500 font-medium text-sm">
                  <CheckCircle2 className="h-4 w-4" />
                  <span>密码学身份固化成功！</span>
                </div>

                <div className="space-y-2 text-xs">
                  <div>
                    <span className="text-muted-foreground">恒定群组公钥 (PK_GROUP):</span>
                    <div className="p-2 bg-background rounded-lg border border-border/40 font-mono text-[11px] truncate select-all mt-1">
                      {groupPk}
                    </div>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Sui 共享对象 (Organization ID):</span>
                    <div className="p-2 bg-background rounded-lg border border-border/40 font-mono text-[11px] truncate select-all mt-1">
                      {orgObjectId}
                    </div>
                  </div>
                </div>
              </div>

              {/* 异步密态信箱投递与唤醒卡片 */}
              {mode === "ASYNC_MAILBOX" && (
                <div className="p-3.5 rounded-xl border border-border/50 bg-muted/20 space-y-2.5">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center space-x-1.5 text-xs font-semibold">
                      <Inbox className="h-3.5 w-3.5 text-primary" />
                      <span>异步密态信箱与离线唤醒 (Mailbox Quorum)</span>
                    </div>
                    <Badge variant={davidAwakened ? "outline" : "secondary"} className={`text-[10px] ${davidAwakened ? "border-green-500/40 text-green-500" : ""}`}>
                      {davidAwakened ? "David 已同步就绪" : "信箱中存在未取分片"}
                    </Badge>
                  </div>
                  
                  <p className="text-xs text-muted-foreground">
                    {davidAwakened
                      ? "离线成员 David 现已上线，成功提取并解密信箱分片，具备完整的门限签署能力！"
                      : "离线成员 David 的分片已封装为 HPKE 密文存储在链上表，组织无需等待其上线即可开始治理！"}
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
                        className="text-xs border-amber-500/40 text-amber-600 dark:text-amber-400 hover:bg-amber-500/10"
                      >
                        <Clock className="h-3 w-3 mr-1" />
                        模拟 David 上线唤醒并提取信箱
                      </Button>
                    </div>
                  )}
                </div>
              )}

              {/* Proactive Resharing 交互区 */}
              <div className="p-3.5 rounded-xl border border-border/50 bg-muted/20 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-1.5 text-xs font-semibold">
                    <Layers className="h-3.5 w-3.5 text-primary" />
                    <span>动态成员换届 (Proactive Resharing)</span>
                  </div>
                  <Badge variant="secondary" className="text-[10px]">
                    公钥保持恒定不变
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  当有新成员加入或移除时，通过主动秘密共享算法重新分发多项式切片，而无需重新部署链上合约或改变公钥地址！
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
                    演示：加入新成员并执行 Resharing
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
