"use client"

import { useEffect, useState } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { FileText, Download, Copy, Check, ExternalLink } from "lucide-react"
import { downloadFromWalrus, WALRUS_AGGREGATOR_URL } from "@/lib/walrus-client"
import { useI18n } from "@/components/i18n-provider"

interface WalrusBlobDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  blobId: string | null
}

export function WalrusBlobDialog({ open, onOpenChange, blobId }: WalrusBlobDialogProps) {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)
  const [isDownloading, setIsDownloading] = useState(false)
  const [error, setError] = useState("")
  const [downloadSource, setDownloadSource] = useState("")
  useEffect(() => { setError(""); setCopied(false); setDownloadSource("") }, [blobId, open])

  if (!blobId) return null

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(blobId)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (error) { setError(error instanceof Error ? error.message : t("walrus.blobCopyFailed")) }
  }

  const handleDownload = async () => {
    setIsDownloading(true)
    setError("")
    try {
      const { data, filename, source } = await downloadFromWalrus(blobId)
      setDownloadSource(source === "cache" ? t("walrus.blobSourceCache") : t("walrus.blobSourceAggregator"))
      const downloadName = filename || `walrus_doc_${blobId.slice(0, 10)}.bin`

      const element = document.createElement("a")
      element.href = URL.createObjectURL(data)
      element.download = downloadName
      document.body.appendChild(element)
      element.click()
      document.body.removeChild(element)
      URL.revokeObjectURL(element.href)
    } catch (error) {
      setError(error instanceof Error ? error.message : t("walrus.blobDownloadFailed"))
    } finally {
      setIsDownloading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[92vw] max-w-[400px] p-0 overflow-hidden bg-background border border-border shadow-xl rounded-2xl">
        {/* 顶部标题 */}
        <div className="p-4 pb-3 border-b border-border/50 bg-muted/30">
          <DialogHeader>
            <div className="flex items-center space-x-2.5">
              <div className="w-8 h-8 rounded-xl bg-blue-500/10 text-blue-600 dark:text-blue-400 flex items-center justify-center shrink-0">
                <FileText className="w-4 h-4" />
              </div>
              <div className="text-left">
                <DialogTitle className="text-sm font-semibold">
                  {t("walrus.blobDialogTitle")}
                </DialogTitle>
                <DialogDescription className="text-xs text-muted-foreground mt-0.5 truncate max-w-[260px]">
                  {blobId}
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>
        </div>

        <div className="p-4 space-y-3.5 text-xs">
          {error && <p role="alert" className="text-destructive">{error}</p>}
          {downloadSource && <p role="status" className="text-muted-foreground">{downloadSource}</p>}
          {/* 文档预览卡片 */}
          <div className="p-3.5 rounded-xl bg-muted/40 border border-border/60 space-y-2 text-foreground/90 leading-relaxed">
            <h4 className="font-semibold text-xs text-foreground flex items-center gap-1.5">
              <FileText className="h-3.5 w-3.5" /> Walrus Blob
            </h4>
            <p className="text-[11px] text-muted-foreground break-all">
              {t("walrus.blobHint")}
            </p>
            <div className="pt-2 border-t border-border/40 text-[11px] text-muted-foreground">
              <p>{t("walrus.blobIdLabel")}{blobId}</p>
            </div>
          </div>

          {/* 底部操作 */}
          <div className="flex items-center justify-between pt-1">
            <Button
              size="sm"
              variant="outline"
              onClick={handleCopy}
              className="h-8 text-xs gap-1.5"
            >
              {copied ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
              {copied ? t("walrus.blobCopied") : t("walrus.blobCopyId")}
            </Button>

            <div className="flex gap-2">
              <a
                href={`${WALRUS_AGGREGATOR_URL}/v1/blobs/${blobId}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center justify-center h-8 px-2.5 text-xs font-medium rounded-md border border-input bg-background hover:bg-accent hover:text-accent-foreground gap-1"
              >
                <ExternalLink className="w-3.5 h-3.5 text-muted-foreground" />
                <span>{t("walrus.blobViewOnNode")}</span>
              </a>
              <Button
                size="sm"
                onClick={handleDownload}
                disabled={isDownloading}
                className="h-8 text-xs gap-1.5 bg-primary text-primary-foreground"
              >
                <Download className="w-3.5 h-3.5" />
                {isDownloading ? t("walrus.blobDownloading") : t("walrus.blobDownload")}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
