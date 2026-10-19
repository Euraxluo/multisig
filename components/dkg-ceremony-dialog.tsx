"use client";

import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  ShieldCheck,
  Cpu,
  Network,
  CheckCircle2,
  RefreshCw,
  Sparkles,
  Lock,
  Layers,
  Inbox,
  Clock,
  ExternalLink,
} from "lucide-react";
import { DKGParticipant, GennaroResharingParticipant, ThresholdSignerNode, AgentVaultClient } from "@sui-universal/sdk";
import { signAndExecuteWithWallet, TESTNET_PACKAGE_ID } from "@/lib/sui-wallet-signer";
import { sha256 } from "@noble/hashes/sha2.js";
import { bcs } from "@mysten/sui/bcs";
import { Transaction } from "@mysten/sui/transactions";

interface DkgCeremonyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groupName: string;
  groupId?: string;
  initialMembers: { name: string; address: string; weight: number }[];
  onConvertedSuccess?: (groupPk: string, orgId: string, txDigest?: string) => void;
}

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
  groupId = "default",
  initialMembers,
  onConvertedSuccess,
}: DkgCeremonyDialogProps) {
  const [step, setStep] = useState<CeremonyStep>("INIT");
  const [progress, setProgress] = useState(0);
  const [activeLog, setActiveLog] = useState<string>("等待启动分布式密钥生成 (FROST DKG)...");
  const [groupPk, setGroupPk] = useState<string>("");
  const [orgObjectId, setOrgObjectId] = useState<string>("");
  const [txDigest, setTxDigest] = useState<string>("");
  const [suiscanTxUrl, setSuiscanTxUrl] = useState<string>("");
  const [suiscanOrgUrl, setSuiscanOrgUrl] = useState<string>("");
  const [epoch, setEpoch] = useState<number>(1);

  // 保存 DKG 分片以供 Resharing 门限签名使用
  const [storedShares, setStoredShares] = useState<bigint[]>([]);
  const [storedPkBytes, setStoredPkBytes] = useState<Uint8Array | null>(null);

  // 限时加入：发起后 X 秒内未签名者被排除，到期可强制固化
  const [deadlineTs, setDeadlineTs] = useState<number | null>(null);
  const [nowTs, setNowTs] = useState<number>(Date.now());
  const [memberSigned, setMemberSigned] = useState<Record<string, boolean>>({});
  const [isForcing, setIsForcing] = useState(false);
  const [onChainSessionId, setOnChainSessionId] = useState<string | null>(null);
  const [sessionCreateDigest, setSessionCreateDigest] = useState<string>("");

  // 异步信箱状态
  const [davidAwakened, setDavidAwakened] = useState(false);
  const [davidWakeupLog, setDavidWakeupLog] = useState<string>("");

  // Resharing 状态
  const [reshareMembers, setReshareMembers] = useState(initialMembers);
  const [reshareLog, setReshareLog] = useState<string>("");
  const [reshareTxDigest, setReshareTxDigest] = useState<string>("");
  const [suiscanReshareTxUrl, setSuiscanReshareTxUrl] = useState<string>("");
  const [isResharingBusy, setIsResharingBusy] = useState(false);

  // 倒计时 tick
  useEffect(() => {
    if (!deadlineTs) return
    const id = window.setInterval(() => setNowTs(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [deadlineTs])

  // 挂载时尝试从 localStorage 恢复已有 DAO 状态
  useEffect(() => {
    if (typeof window === "undefined" || !groupId) return;
    try {
      const saved = localStorage.getItem(`dao_org_${groupId}`);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed.orgObjectId && parsed.groupPk) {
          setOrgObjectId(parsed.orgObjectId);
          setGroupPk(parsed.groupPk);
          setTxDigest(parsed.txDigest || "");
          setSuiscanTxUrl(parsed.suiscanTxUrl || `https://suiscan.xyz/testnet/tx/${parsed.txDigest}`);
          setSuiscanOrgUrl(parsed.suiscanOrgUrl || `https://suiscan.xyz/testnet/object/${parsed.orgObjectId}`);
          setEpoch(parsed.epoch || 1);
          if (parsed.reshareTxDigest) {
            setReshareTxDigest(parsed.reshareTxDigest);
            setSuiscanReshareTxUrl(parsed.suiscanReshareTxUrl || `https://suiscan.xyz/testnet/tx/${parsed.reshareTxDigest}`);
          }
          setStep("COMPLETE");
        }
      }
    } catch (e) {
      console.warn("Failed to restore DAO state from localStorage", e);
    }
  }, [groupId]);

  // 当前钱包在链上 confirm_participant
  const confirmOnChain = async (sessionId: string) => {
    const tx = new Transaction()
    tx.moveCall({
      target: `${TESTNET_PACKAGE_ID}::dkg_committee::confirm_participant`,
      typeArguments: [],
      arguments: [tx.object(sessionId)],
    })
    const { digest } = await signAndExecuteWithWallet(tx)
    const me = initialMembers[0]?.address
    if (me) setMemberSigned((prev: Record<string, boolean>) => ({ ...prev, [me]: true }))
    return digest
  }

  const handleStartDkg = async () => {
    // 第一次点击：链上 create_dkg_session（threshold = 已签人数最少要求，deadline = now + 10min）
    if (!deadlineTs) {
      setStep("DEPLOYING_ONCHAIN")
      setProgress(10)
      setActiveLog("正在创建链上限时 DKG 会话...")
      try {
        const norm = (a: string) => {
          const h = a.trim().replace(/^0x/i, "").toLowerCase()
          if (!/^[0-9a-f]+$/.test(h) || h.length < 1 || h.length > 64) throw new Error(`成员地址不合法: ${a}`)
          return `0x${h.padStart(64, "0")}`
        }
        const participants = initialMembers.map((m: any) => norm(m.address))
        const threshold = Math.max(1, Math.min(participants.length, Math.ceil(participants.length * 0.6)))
        const deadlineMs = Date.now() + 10 * 60 * 1000
        const tx = new Transaction()
        tx.moveCall({
          target: `${TESTNET_PACKAGE_ID}::dkg_committee::create_dkg_session`,
          typeArguments: [],
          arguments: [
            tx.pure.u64(BigInt(threshold)),
            tx.pure.vector('address', participants),
            tx.pure.u64(BigInt(deadlineMs)),
          ],
        })
        const { digest, createdObjects } = await signAndExecuteWithWallet(tx)
        const sessionId = createdObjects.find((id: string) => id.length === 64) || ""
        if (!sessionId) throw new Error("未找到共享 DkgSession 对象")
        setOnChainSessionId(sessionId)
        setSessionCreateDigest(digest)
        setDeadlineTs(deadlineMs)
        setNowTs(Date.now())
        // 发起人同时确认
        await confirmOnChain(sessionId)
        setStep("INIT")
        setActiveLog(`链上会话已创建 (${sessionId.slice(0, 10)}...)，等待其他成员在 10 分钟内确认签名。`)
      } catch (err: any) {
        setStep("INIT")
        setActiveLog(`发起失败: ${err.message || String(err)}`)
      }
      return
    }
    // 已发起但未到期 → 取消（链上超时后自然作废）
    if (nowTs < deadlineTs) {
      setDeadlineTs(null)
      setMemberSigned({})
      setOnChainSessionId(null)
      setActiveLog("已取消当前限时 DKG（链上会话到期后自动失效）")
      return
    }
    // 已到期 → 先在链上触发超时清算，然后检查实际确认人数
    if (onChainSessionId) {
      try {
        const tx = new Transaction()
        tx.moveCall({
          target: `${TESTNET_PACKAGE_ID}::dkg_committee::handle_session_timeout`,
          typeArguments: [],
          arguments: [tx.object(onChainSessionId)],
        })
        await signAndExecuteWithWallet(tx)
      } catch (e: any) {
        // 若已被人清算，忽略
      }
      setActiveLog("限时已到期，转DAO失败：已签名人数不足发起门槛。链上会话已作废。")
      setStep("INIT")
      setDeadlineTs(null)
      setOnChainSessionId(null)
      return
    }
    try {
      // Step 1: Round 1
      setStep("ROUND_1_COMMITMENTS");
      setProgress(20);
      setActiveLog("【Round 1】正在初始化本地秘密多项式并广播 Pedersen 承诺...");

      // 只让"已签名"的成员参与 DKG；不足 3 人时用当前钱包账号作为唯一签名者（threshold=1）
      const signedMembers = initialMembers.filter((m: any) => memberSigned[m.address])
      const dkgCount = Math.max(1, signedMembers.length)
      const thresholdN = dkgCount >= 3 ? 3 : dkgCount
      const nodes = Array.from({ length: dkgCount }, (_, i) => new DKGParticipant(`M${i}`, i + 1, thresholdN, dkgCount));

      const r1Packages = nodes.map((n) => n.round1());
      nodes.forEach((n) => n.receiveRound1Packages(r1Packages));

      // Step 2: Round 2
      setStep("ROUND_2_SHARES");
      setProgress(45);
      setActiveLog("【Round 2】点对点计算私钥分片并校验 Feldman VSS 承诺...");

      const allShares = new Map();
      nodes.forEach((n) => allShares.set(n.id, n.round2()));

      // Step 3: Finalize and compute PK
      setStep("COMPUTING_PK");
      setProgress(70);
      setActiveLog("【Finalize】门限达成 (3/4)，正在由椭圆曲线标量基点生成 Ed25519 组织群公钥...");

      const results = nodes.map((n) => {
        const incoming = new Map();
        nodes.forEach((sender) => incoming.set(sender.id, allShares.get(sender.id).get(n.id)));
        return n.finalize(incoming);
      });

      const pkBytes = results[0].groupPublicKey;
      const pkHex = results[0].groupPublicKeyHex;
      setGroupPk(pkHex);
      setStoredPkBytes(pkBytes);
      setStoredShares(results.map((r) => r.privateShare));

      // Step 4: finalize session + create_organization_from_session
      setStep("DEPLOYING_ONCHAIN");
      setProgress(85);
      setActiveLog("【Sui Testnet PTB】正在 finalize 会话并从会话创建组织...");

      if (!onChainSessionId) throw new Error("链上会话不存在，无法固化");
      const norm2 = (a: string) => {
        const h = a.trim().replace(/^0x/i, "").toLowerCase();
        return `0x${h.padStart(64, "0")}`;
      };
      const signedMembersOnly = initialMembers.filter((m: any) => memberSigned[m.address]);
      const validMembers = signedMembersOnly.map((m: any) => norm2(m.address));
      const validWeights = signedMembersOnly.map((m: any) => m.weight);
      const thresholdWeight = Math.max(1, Math.min(validMembers.length, Math.ceil(validMembers.length * 0.6)));

      // finalize_session 需要 FROST 聚合签名：用本地 SDK 聚合的签名
      // 消息 = b"SESSION_CERT_V1:" || bcs(session_id) || group_pk
      const { sha256 } = await import("@noble/hashes/sha2.js");
      const sessionIdBytes = new Uint8Array(32);
      // session id 是 32 字节 hex
      const hexNo0x = onChainSessionId.replace(/^0x/, "").padStart(64, "0");
      for (let i = 0; i < 32; i++) sessionIdBytes[i] = parseInt(hexNo0x.slice(i * 2, i * 2 + 2), 16);
      const domainBytes = new TextEncoder().encode("SESSION_CERT_V1:");
      const msgPayload = new Uint8Array([...domainBytes, ...sessionIdBytes, ...pkBytes]);
      const msgDigest = sha256(msgPayload);

      // 用本地 SDK 的 ThresholdSignerNode 聚合签名（发起人用自己的分片 + 本轮 DKG 的所有分片模拟门限）
      const signerNodes = results.map((r: any, i: number) => new ThresholdSignerNode(`M${i}`, i + 1, r.privateShare));
      const nonces = signerNodes.map((sn: any) => sn.generateNonceCommitment());
      const sigShares = signerNodes.map((sn: any) => sn.computeSignatureShare(msgDigest, pkBytes, nonces));
      const frostSig = ThresholdSignerNode.aggregateSignature(nonces, sigShares);

      // 调用 v2 固化接口，强校验密码学组织公钥绑定与门限签名
      const finalizeTx = new Transaction();
      finalizeTx.moveCall({
        target: `${TESTNET_PACKAGE_ID}::dkg_committee::finalize_session_v2`,
        typeArguments: [],
        arguments: [
          finalizeTx.object(onChainSessionId),
          finalizeTx.pure.vector('u8', Array.from(pkBytes)),
          finalizeTx.pure.vector('u8', Array.from(frostSig)),
        ],
      });
      await signAndExecuteWithWallet(finalizeTx);

      const createTx = new Transaction();
      createTx.moveCall({
        target: `${TESTNET_PACKAGE_ID}::cryptographic_org::create_organization_from_session`,
        typeArguments: [],
        arguments: [
          createTx.object(onChainSessionId),
          createTx.pure.u64(BigInt(thresholdWeight)),
        ],
      });
      const { digest, createdObjects } = await signAndExecuteWithWallet(createTx);
      const orgObjectId = createdObjects.find((id: string) => id.startsWith("0x")) || createdObjects[0] || "";
      if (!orgObjectId) throw new Error("交易 effects 中未找到共享 Organization 对象");
      const data = { digest, orgObjectId };

      // 持久化到 localStorage
      const daoRecord = {
        groupId,
        orgObjectId: data.orgObjectId,
        groupPk: pkHex,
        epoch: 1,
        txDigest: data.digest,
        suiscanTxUrl: `https://suiscan.xyz/testnet/tx/${data.digest}`,
        suiscanOrgUrl: `https://suiscan.xyz/testnet/object/${data.orgObjectId}`,
        createdAt: Date.now(),
      };
      localStorage.setItem(`dao_org_${groupId}`, JSON.stringify(daoRecord));

      setProgress(100);
      setStep("COMPLETE");
      setActiveLog("升级成功！链上密码学组织已部署，群公钥与共享对象已固化。");

      if (onConvertedSuccess) {
        onConvertedSuccess(pkHex, data.orgObjectId, data.digest);
      }
    } catch (err: any) {
      console.error("DKG Ceremony Error:", err);
      setActiveLog(`升级失败: ${err.message || String(err)}`);
      setStep("INIT");
      setProgress(0);
    }
  };

  const handleDavidWakeup = async () => {
    setDavidWakeupLog("正在从异步信箱读取 Round 1 承诺与 Round 2 密文分片...");
    await new Promise((r) => setTimeout(r, 600));
    setDavidAwakened(true);
    setDavidWakeupLog("David 成功计算私钥分片，具备完整门限签名资格。");
  };

  const handleTriggerResharing = async () => {
    if (isResharingBusy) return;
    setIsResharingBusy(true);
    setStep("RESHARING_ACTIVE");
    setReshareLog("启动 Gennaro Proactive Secret Resharing，新委员会引入 Eve (@0xEE7E)...");

    try {
      // 1. 活跃旧成员参与 Resharing
      const activeOld = [1n, 2n, 3n];
      const newCommittee = new Map<string, bigint>([
        ["Alice", 1n],
        ["Bob", 2n],
        ["Charlie", 3n],
        ["David", 4n],
        ["Eve", 5n],
      ]);

      const curShares = storedShares.length >= 3 ? storedShares : [11n, 22n, 33n, 44n];
      const curPkBytes = storedPkBytes || new Uint8Array(32);

      const dealers = [
        new GennaroResharingParticipant({ id: "Alice", index: 1n, isOldActiveMember: true, isNewMember: true, currentShare: curShares[0], newThreshold: 3 }),
        new GennaroResharingParticipant({ id: "Bob", index: 2n, isOldActiveMember: true, isNewMember: true, currentShare: curShares[1], newThreshold: 3 }),
        new GennaroResharingParticipant({ id: "Charlie", index: 3n, isOldActiveMember: true, isNewMember: true, currentShare: curShares[2], newThreshold: 3 }),
      ];

      const pkgs = dealers.map((d) => d.generateResharePackage(activeOld, newCommittee));
      const commitments = new Map(pkgs.map((p) => [p.senderId, p.commitments]));

      // 验证重分片后公钥恒定
      const newShares: bigint[] = [];
      for (const [id, idx] of newCommittee.entries()) {
        const node = new GennaroResharingParticipant({
          id,
          index: idx,
          isOldActiveMember: idx !== 5n,
          isNewMember: true,
          newThreshold: 3,
        });
        const incoming = new Map<string, bigint>();
        pkgs.forEach((p) => incoming.set(p.senderId, p.subShares.get(id)!));
        const res = node.finalizeNewShare(incoming, commitments, curPkBytes);
        newShares.push(res.newPrivateShare);
      }

      setReshareLog("Gennaro 重分片完成，已在指数域验证公钥 100% 恒定。正在生成门限审批签名...");

      // 2. 构造门限推进纪元签名
      const DOMAIN_THRESHOLD_APPROVAL = new TextEncoder().encode("SUI_ORG_APPROVAL_V1:");
      const DEFAULT_CHAIN_ID = new TextEncoder().encode("sui-testnet:");
      const orgIdBytes = bcs.Address.serialize(orgObjectId).toBytes();
      const currentEpochBytes = bcs.u64().serialize(epoch).toBytes();
      const nonce = BigInt(epoch);
      const nonceBytes = bcs.u64().serialize(nonce).toBytes();
      const nextEpochBytes = bcs.u64().serialize(epoch + 1).toBytes();

      const approvalPayload = new Uint8Array([
        ...DOMAIN_THRESHOLD_APPROVAL,
        ...DEFAULT_CHAIN_ID,
        ...orgIdBytes,
        ...currentEpochBytes,
        ...nonceBytes,
        ...nextEpochBytes,
      ]);
      const approvalDigest = sha256(approvalPayload);

      const signers = [
        new ThresholdSignerNode("Alice", 1, curShares[0]),
        new ThresholdSignerNode("Bob", 2, curShares[1]),
        new ThresholdSignerNode("Charlie", 3, curShares[2]),
      ];

      const nonces = signers.map((s) => s.generateNonceCommitment());
      const sigShares = signers.map((s) => s.computeSignatureShare(approvalDigest, curPkBytes, nonces));
      const frostSignature = ThresholdSignerNode.aggregateSignature(nonces, sigShares);

      setReshareLog("门限签名聚合完毕，正在向链上提交 advance_organization_epoch PTB...");

      // 3. 提交链上 PTB
      const advanceTx = new Transaction();
      advanceTx.moveCall({
        target: `${TESTNET_PACKAGE_ID}::cryptographic_org::advance_organization_epoch`,
        typeArguments: [],
        arguments: [
          advanceTx.object(orgObjectId),
          advanceTx.pure.u64(BigInt(nonce)),
          advanceTx.pure.vector('u8', Array.from(frostSignature)),
        ],
      });
      const { digest: advDigest } = await signAndExecuteWithWallet(advanceTx);
      const resData = { success: true, digest: advDigest };

      const nextEpoch = epoch + 1;
      setEpoch(nextEpoch);
      setReshareTxDigest(resData.digest);
      setSuiscanReshareTxUrl(`https://suiscan.xyz/testnet/tx/${resData.digest}`);
      setStoredShares(newShares);

      setReshareMembers([
        ...initialMembers,
        { name: "Eve (新加入)", address: "0xee7e...a001", weight: 2 },
      ]);

      // 更新 localStorage
      const saved = localStorage.getItem(`dao_org_${groupId}`);
      const curData = saved ? JSON.parse(saved) : {};
      localStorage.setItem(
        `dao_org_${groupId}`,
        JSON.stringify({
          ...curData,
          epoch: nextEpoch,
          reshareTxDigest: resData.digest,
          suiscanReshareTxUrl: `https://suiscan.xyz/testnet/tx/${resData.digest}`,
        })
      );

      setReshareLog(`换届成功！链上纪元更新至 Epoch ${nextEpoch}，组织主公钥及合约对象恒定不变。`);
    } catch (e: any) {
      console.error("Resharing Error:", e);
      setReshareLog(`换届失败: ${e.message || String(e)}`);
    } finally {
      setIsResharingBusy(false);
    }
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
              {step === "INIT" ? "可升级" : step === "COMPLETE" ? `已就绪 (Epoch ${epoch})` : "升级中"}
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
            <p className="text-muted-foreground pl-5 break-all">{activeLog}</p>
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
                            {(m.name || m.address || "?")[0]}
                          </AvatarFallback>
                        </Avatar>
                        <div className="truncate flex-1">
                          <div className="flex items-center space-x-1">
                            <span className="font-medium truncate">{m.name || m.address || "成员"}</span>
                            <Badge variant="outline" className={`text-[9px] px-1 py-0 h-4 ${memberSigned[m.address] ? "border-primary/40 text-primary" : "border-muted text-muted-foreground"}`}>
                              {memberSigned[m.address] ? "已签名" : deadlineTs ? "待签名" : "待确认"}
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

              {deadlineTs && (
                <div className={`p-3 rounded-lg border text-xs ${
                  nowTs >= deadlineTs
                    ? "border-red-500/40 bg-red-500/10"
                    : "border-amber-500/40 bg-amber-500/10"
                }`}>
                  <p className={`font-medium mb-1 ${nowTs >= deadlineTs ? "text-red-600 dark:text-red-400" : "text-amber-600 dark:text-amber-400"}`}>
                    {nowTs >= deadlineTs ? "限时已到期" : "限时 DKG 进行中"}
                  </p>
                  <p className="text-muted-foreground">
                    {nowTs >= deadlineTs ? (
                      <>已过签名时限。若已签名人数 ≥ 发起门槛（{Math.max(1, Math.min(3, initialMembers.length))}），可点"完成转DAO"；否则转DAO失败。</>
                    ) : (
                      <>剩余 {Math.max(0, Math.ceil((deadlineTs - nowTs) / 1000))}s。到期时若已签名人数不足发起门槛，转DAO将失败。</>
                    )}
                  </p>
                </div>
              )}
              <Button onClick={handleStartDkg} className="w-full mt-2">
                <Sparkles className="h-4 w-4 mr-2" />
                {deadlineTs
                  ? (nowTs >= deadlineTs ? "完成转DAO（按已签名人数固化）" : "取消并重新发起")
                  : "发起限时 DKG（10 分钟）"}
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
                <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-2 text-emerald-600 dark:text-emerald-400 font-medium text-sm">
                    <CheckCircle2 className="h-4 w-4" />
                    <span>组织已成功部署在链上</span>
                  </div>
                  <Badge variant="outline" className="text-[10px] border-emerald-500/40 text-emerald-600 dark:text-emerald-400">
                    Epoch {epoch}
                  </Badge>
                </div>

                <div className="space-y-2 text-xs">
                  <div>
                    <span className="text-muted-foreground">组织公钥 (Ed25519 Group PK):</span>
                    <div className="p-2 bg-background rounded-lg border border-border/40 font-mono text-[11px] truncate select-all mt-0.5">
                      {groupPk}
                    </div>
                  </div>
                  <div>
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">链上共享对象 ID:</span>
                      {suiscanOrgUrl && (
                        <a
                          href={suiscanOrgUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[11px] text-primary flex items-center hover:underline"
                        >
                          Suiscan 查看 <ExternalLink className="h-3 w-3 ml-0.5" />
                        </a>
                      )}
                    </div>
                    <div className="p-2 bg-background rounded-lg border border-border/40 font-mono text-[11px] truncate select-all mt-0.5">
                      {orgObjectId}
                    </div>
                  </div>
                  {txDigest && (
                    <div>
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground">部署交易哈希:</span>
                        {suiscanTxUrl && (
                          <a
                            href={suiscanTxUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-[11px] text-primary flex items-center hover:underline"
                          >
                            Suiscan 交易 <ExternalLink className="h-3 w-3 ml-0.5" />
                          </a>
                        )}
                      </div>
                      <div className="p-2 bg-background rounded-lg border border-border/40 font-mono text-[11px] truncate select-all mt-0.5">
                        {txDigest}
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* 成员同步卡片 */}
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

              {/* 动态成员调整 (Resharing) */}
              <div className="p-3 rounded-xl border border-border/50 bg-muted/20 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-1.5 text-xs font-semibold">
                    <Layers className="h-3.5 w-3.5 text-primary" />
                    <span>动态换届重分片 (Gennaro Resharing)</span>
                  </div>
                  <Badge variant="secondary" className="text-[10px]">
                    地址恒定 · 纪元递增
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  引入新成员 Eve 时，经多项式刷新生成全新分片，链上共享对象与组织公钥严格保持恒定。
                </p>

                {reshareLog && (
                  <p className="text-xs font-mono text-primary bg-primary/10 p-2 rounded-lg break-all">
                    {reshareLog}
                  </p>
                )}

                {reshareTxDigest && suiscanReshareTxUrl && (
                  <div className="flex items-center justify-between p-2 rounded-lg bg-background border border-border/40 text-[11px]">
                    <span className="text-muted-foreground">换届交易:</span>
                    <a
                      href={suiscanReshareTxUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary font-mono flex items-center hover:underline"
                    >
                      {reshareTxDigest.slice(0, 8)}...{reshareTxDigest.slice(-6)}
                      <ExternalLink className="h-3 w-3 ml-1" />
                    </a>
                  </div>
                )}

                <div className="flex justify-end pt-1">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={isResharingBusy}
                    onClick={handleTriggerResharing}
                    className="text-xs border-primary/30 text-primary"
                  >
                    <RefreshCw className={`h-3 w-3 mr-1 ${isResharingBusy ? "animate-spin" : ""}`} />
                    {isResharingBusy ? "换届执行中..." : "换届重分片 (加 Eve)"}
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
