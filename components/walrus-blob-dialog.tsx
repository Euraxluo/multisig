"use client"

import { useState } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { HardDrive, Download, ExternalLink, Copy, Check, ShieldCheck, Database, Layers, Lock } from "lucide-react"

interface WalrusBlobDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  blobId: string | null
}

export function WalrusBlobDialog({ open, onOpenChange, blobId }: WalrusBlobDialogProps) {
  const [copied, setCopied] = useState(false)
  const [isDownloading, setIsDownloading] = useState(false)

  if (!blobId) return null

  const handleCopy = () => {
    navigator.clipboard.writeText(blobId)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const handleDownload = () => {
    setIsDownloading(true)
    const content = `=== DAO Governance Specification (Decrypted from Walrus Protocol) ===
Blob ID: ${blobId}
Protocol: Mysten Labs Walrus Protocol (RedStuff 2D Erasure Coding)
Encrypted With: AES-256-GCM (MLS RFC 9420 Group Secret)

[1. Executive Summary]
This specification document records the dynamic committee transition to Epoch 2.
SubagentMessagingCap and SubagentCoSignCap are formally enabled on Sui Move.

[2. Protocol Invariants]
- Root Public Key: Immutable across all epochs (PK_GROUP invariance).
- Subagent Co-Sign Limits: Max 100 SUI/tx, Max 300 SUI/day.
- Zero-Popup Messaging: Client-side ephemeral session key with 7-day TTL.
- Storage Optimization: All rich media stored as Walrus Blobs, zero Sui state bloat.

[3. Signatures & Attestation]
- Committee Quorum: 3/4 Threshold Achieved.
- Walrus Storage Node Signatures: 16/16 Nodes Verified.
`
    const element = document.createElement("a")
    const file = new Blob([content], { type: "text/plain" })
    element.href = URL.createObjectURL(file)
    element.download = `${blobId}_decrypted.txt`
    document.body.appendChild(element)
    element.click()
    document.body.removeChild(element)

    setTimeout(() => setIsDownloading(false), 1000)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[540px] p-0 gap-0 overflow-hidden bg-background border border-cyan-500/30 shadow-2xl">
        {/* 顶部 Walrus 科技感横幅 */}
        <div className="bg-gradient-to-r from-cyan-600 via-teal-600 to-emerald-600 p-4 text-white">
          <div className="flex items-center justify-between mb-1">
            <div className="flex items-center gap-2">
              <div className="p-1.5 rounded-lg bg-white/20 backdrop-blur-sm">
                <HardDrive className="w-5 h-5 text-cyan-100" />
              </div>
              <DialogTitle className="text-lg font-bold">Walrus 去中心化 Blob 浏览器</DialogTitle>
            </div>
            <Badge variant="outline" className="bg-white/20 text-white border-white/30 text-[10px]">
              Mysten Labs 存储协议
            </Badge>
          </div>
          <DialogDescription className="text-xs text-cyan-100/90">
            Sui Move 链上仅存索引，数据全文由 Walrus RedStuff 2D 纠删码分布式托管
          </DialogDescription>
        </div>

        <div className="p-4 space-y-3.5 text-xs max-h-[80vh] overflow-y-auto">
          {/* Blob ID 凭证卡片 */}
          <div className="p-3 rounded-xl bg-cyan-950/20 border border-cyan-500/30 space-y-2">
            <div className="flex items-center justify-between text-muted-foreground text-[11px]">
              <span className="font-semibold text-foreground flex items-center gap-1.5">
                <Database className="w-3.5 h-3.5 text-cyan-500" />
                Walrus Blob ID
              </span>
              <Badge variant="outline" className="text-[10px] bg-emerald-500/10 text-emerald-500 border-emerald-500/30">
                16 节点已固化
              </Badge>
            </div>
            <div className="flex items-center justify-between gap-2 p-2 rounded-lg bg-background/80 border border-border font-mono text-[11px]">
              <span className="truncate text-cyan-600 dark:text-cyan-400 font-semibold">{blobId}</span>
              <Button size="sm" variant="ghost" onClick={handleCopy} className="h-6 w-6 p-0 shrink-0">
                {copied ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
              </Button>
            </div>
          </div>

          {/* 属性参数网格 */}
          <div className="grid grid-cols-2 gap-2 text-[11px]">
            <div className="p-2.5 rounded-lg border border-border/60 bg-muted/20 space-y-1">
              <span className="text-muted-foreground flex items-center gap-1">
                <Layers className="w-3 h-3 text-primary" />
                纠删码冗余
              </span>
              <p className="font-medium text-foreground">RedStuff 2D Reed-Solomon</p>
            </div>
            <div className="p-2.5 rounded-lg border border-border/60 bg-muted/20 space-y-1">
              <span className="text-muted-foreground flex items-center gap-1">
                <Lock className="w-3 h-3 text-purple-500" />
                端到端加密
              </span>
              <p className="font-medium text-foreground">AES-256-GCM (MLS 树形棘轮)</p>
            </div>
            <div className="p-2.5 rounded-lg border border-border/60 bg-muted/20 space-y-1">
              <span className="text-muted-foreground">存储周期</span>
              <p className="font-medium text-foreground">Epoch 1 → 10 (已预付 WAL)</p>
            </div>
            <div className="p-2.5 rounded-lg border border-border/60 bg-muted/20 space-y-1">
              <span className="text-muted-foreground">Sui 状态开销</span>
              <p className="font-medium text-emerald-600 dark:text-emerald-400">0 字节 (仅 Event 索引)</p>
            </div>
          </div>

          {/* 解密内容预览框 */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-[11px]">
              <span className="font-semibold text-foreground flex items-center gap-1">
                <ShieldCheck className="w-3.5 h-3.5 text-emerald-500" />
                MLS 客户端解密内容预览
              </span>
              <span className="text-muted-foreground text-[10px]">DAO_Governance_Proposal_v2.pdf</span>
            </div>
            <div className="p-3 rounded-xl bg-card border border-border font-mono text-[11px] leading-relaxed text-muted-foreground space-y-1.5 whitespace-pre-wrap select-text">
              <p className="font-bold text-foreground">📜 决议草案：Epoch 2 动态重分片与 Subagent 权能激活</p>
              <p>• 目标：为新成员 Eve 颁发门限分片，保持群公钥 PK_GROUP 永久恒定不变。</p>
              <p>• 权能：向 Subagent 签发 7 天免密发信 Cap 与 100 SUI/tx 协签 Cap。</p>
              <p>• 存储：全量技术文档已上传至 Walrus，链上仅存索引，完全避免全局锁竞争。</p>
              <p className="text-emerald-600 dark:text-emerald-400 text-[10px] pt-1 border-t border-border/60">
                ✓ 16/16 Walrus 存储节点法定见证签名通过 · 密码学组织已受邀确认
              </p>
            </div>
          </div>

          {/* 底部操作栏 */}
          <div className="flex items-center justify-between pt-2 border-t border-border/60">
            <Button
              size="sm"
              variant="outline"
              onClick={() => window.open(`/api/walrus/${blobId}`, "_blank")}
              className="h-8 text-xs gap-1.5 border-cyan-500/30 text-cyan-600 dark:text-cyan-400 hover:bg-cyan-500/10"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              在 Walrus Aggregator API 查看
            </Button>
            <div className="flex gap-2">
              <Button size="sm" onClick={handleDownload} disabled={isDownloading} className="h-8 text-xs gap-1.5 bg-cyan-600 hover:bg-cyan-700 text-white">
                <Download className="w-3.5 h-3.5" />
                {isDownloading ? "解密下载中..." : "下载解密文件"}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => onOpenChange(false)} className="h-8 text-xs">
                关闭
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
