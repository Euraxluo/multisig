"use client"

import { useEffect, useRef, useState } from "react"
import { Camera, ImageUp, QrCode } from "lucide-react"
import { isValidSuiAddress } from "@mysten/sui/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { useI18n } from "@/components/i18n-provider"
import { t as tGlobal } from "@/lib/i18n/t"

interface DetectedBarcode { rawValue: string }
interface BarcodeDetectorLike {
  detect(source: ImageBitmapSource): Promise<DetectedBarcode[]>
}
type BarcodeDetectorConstructor = new (options?: { formats: string[] }) => BarcodeDetectorLike

function getAddress(raw: string): string | null {
  const value = raw.trim()
  const candidates = [value]
  try {
    const url = new URL(value)
    const person = url.searchParams.get("person")
    if (person) candidates.push(person)
  } catch {}
  const suiUri = /^sui:([^?]+)/i.exec(value)
  if (suiUri?.[1]) candidates.push(decodeURIComponent(suiUri[1]))
  return candidates.find(candidate => isValidSuiAddress(candidate)) ?? null
}

export function QrAddressScanner({ open, onOpenChange, onAddress }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onAddress: (address: string) => void
}) {
  const { t } = useI18n()
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const callbacksRef = useRef({ onAddress, onOpenChange })
  callbacksRef.current = { onAddress, onOpenChange }
  const [error, setError] = useState("")
  const [unsupported, setUnsupported] = useState(false)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    const Detector = (globalThis as typeof globalThis & { BarcodeDetector?: BarcodeDetectorConstructor }).BarcodeDetector
    if (!Detector || !navigator.mediaDevices?.getUserMedia) {
      setUnsupported(true)
      setError(tGlobal("misc.qr.noLiveSupport"))
      return
    }
    setUnsupported(false)
    setError("")
    let detector: BarcodeDetectorLike
    try { detector = new Detector({ formats: ["qr_code"] }) }
    catch { setUnsupported(true); setError(tGlobal("misc.qr.initFailed")); return }
    void navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false }).then(stream => {
      if (cancelled) { stream.getTracks().forEach(track => track.stop()); return }
      streamRef.current = stream
      const video = videoRef.current
      if (video) {
        video.srcObject = stream
        void video.play().catch(() => setError(tGlobal("misc.qr.previewFailed")))
      }
      const scan = async () => {
        if (cancelled || !videoRef.current || videoRef.current.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return
        try {
          const codes = await detector.detect(videoRef.current)
          const address = codes.map(code => getAddress(code.rawValue)).find(Boolean)
          if (address) { callbacksRef.current.onAddress(address); callbacksRef.current.onOpenChange(false); return }
          if (codes.length) setError(tGlobal("misc.qr.noAddress"))
        } catch { /* Continue scanning; camera frames may be temporarily unavailable. */ }
      }
      const timer = window.setInterval(() => void scan(), 350)
      cleanupTimer = () => window.clearInterval(timer)
    }).catch(cause => {
      if (!cancelled) setError(cause instanceof Error && cause.name === "NotAllowedError" ? tGlobal("misc.qr.cameraDenied") : tGlobal("misc.qr.cameraFailed"))
    })
    let cleanupTimer = () => {}
    return () => {
      cancelled = true
      cleanupTimer()
      streamRef.current?.getTracks().forEach(track => track.stop())
      streamRef.current = null
    }
  }, [open])

  const [manualValue, setManualValue] = useState("")

  const decodeImage = async (file?: File) => {
    if (!file) return
    const Detector = (globalThis as typeof globalThis & { BarcodeDetector?: BarcodeDetectorConstructor }).BarcodeDetector
    if (!Detector) { setError(tGlobal("misc.qr.noImageSupport")); return }
    try {
      const bitmap = await createImageBitmap(file)
      try {
        const codes = await new Detector({ formats: ["qr_code"] }).detect(bitmap)
        const address = codes.map(code => getAddress(code.rawValue)).find(Boolean)
        if (!address) { setError(codes.length ? tGlobal("misc.qr.noAddress") : tGlobal("misc.qr.noQrInImage")); return }
        callbacksRef.current.onAddress(address)
        callbacksRef.current.onOpenChange(false)
      } finally { bitmap.close() }
    } catch { setError(tGlobal("misc.qr.imageUnreadable")) }
  }

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-w-sm">
      <DialogHeader><DialogTitle>{t("misc.qr.title")}</DialogTitle><DialogDescription>{t("misc.qr.description")}</DialogDescription></DialogHeader>
      <video ref={videoRef} muted playsInline className="aspect-square w-full rounded-lg bg-muted object-cover" aria-label={t("misc.qr.videoAria")} />
      <p role="status" className="min-h-5 text-xs text-muted-foreground">{error || (unsupported ? t("misc.qr.pickImage") : t("misc.qr.scanHint"))}</p>
      <label className="flex cursor-pointer items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm hover:bg-muted">
        <ImageUp className="h-4 w-4" />{t("misc.qr.fromImage")}
        <input className="sr-only" type="file" accept="image/*" onChange={event => { void decodeImage(event.target.files?.[0]); event.currentTarget.value = "" }} />
      </label>
      <div className="flex gap-2"><Input value={manualValue} onChange={event => setManualValue(event.target.value)} placeholder={t("misc.qr.manualPlaceholder")} aria-label={t("misc.qr.manualAria")} /><Button onClick={() => { const address = getAddress(manualValue); if (!address) { setError(tGlobal("misc.qr.manualInvalid")); return }; onAddress(address); onOpenChange(false) }}>{t("misc.qr.use")}</Button></div>
      <Button variant="outline" onClick={() => onOpenChange(false)}><Camera className="mr-2 h-4 w-4" />{t("misc.qr.closeScanner")}</Button>
      <div className="sr-only"><QrCode /></div>
    </DialogContent>
  </Dialog>
}
