"use client"

import { useEffect, useRef, useState } from "react"
import { QRCodeSVG } from "qrcode.react"
import { Copy, Download } from "lucide-react"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { isValidSuiAddress } from "@mysten/sui/utils"
import { useI18n } from "@/components/i18n-provider"

interface ShareQrDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  kind: "person" | "group"
  identifier: string
  description?: string
}

export function ShareQrDialog({ open, onOpenChange, title, kind, identifier, description }: ShareQrDialogProps) {
  const { t } = useI18n()
  const [link, setLink] = useState("")
  const [notice, setNotice] = useState("")
  const svgRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setNotice("")
    if (!open || !isValidSuiAddress(identifier)) { setLink(""); return }
    const url = new URL("/", window.location.origin)
    url.searchParams.set(kind, identifier)
    setLink(url.toString())
  }, [open, kind, identifier])

  const copy = async () => {
    try { await navigator.clipboard.writeText(link); setNotice(t("groups.linkCopied")) }
    catch { setNotice(t("groups.copyFailedManual")) }
  }

  const download = () => {
    const svg = svgRef.current?.querySelector("svg")
    if (!svg) return
    const blob = new Blob([new XMLSerializer().serializeToString(svg)], { type: "image/svg+xml;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = `${kind}-${identifier.slice(0, 10)}.svg`
    anchor.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-w-sm">
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description || (kind === "person" ? t("groups.qrPersonDesc") : t("groups.qrGroupDesc"))}</DialogDescription>
      </DialogHeader>
      {link ? <>
        <div ref={svgRef} className="mx-auto rounded-xl bg-white p-4">
          <QRCodeSVG value={link} size={208} level="M" marginSize={4} title={title} />
        </div>
        <p className="text-xs text-muted-foreground break-all">{identifier}</p>
        <input className="w-full rounded-md border bg-background p-2 text-xs" aria-label={t("groups.shareLinkAria")} value={link} readOnly onFocus={(event) => event.target.select()} />
        <div className="flex gap-2">
          <Button className="flex-1" onClick={copy}><Copy className="mr-2 h-4 w-4" />{t("groups.copyLink")}</Button>
          <Button variant="outline" onClick={download}><Download className="mr-2 h-4 w-4" />{t("groups.saveQr")}</Button>
        </div>
      </> : <p className="text-sm text-muted-foreground">{t("groups.qrNotReady")}</p>}
      <p role="status" className="text-sm text-muted-foreground">{notice}</p>
    </DialogContent>
  </Dialog>
}
