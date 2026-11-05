"use client"

import { useState } from "react"
import { Dialog, DialogContent } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Users, Wallet, Rocket, ArrowLeft } from "lucide-react"
import { useI18n } from "@/components/i18n-provider"

const STORAGE_KEY = "sui_onboarded_v1"

export function FirstRunDialog() {
  const { t } = useI18n()
  const [step, setStep] = useState(0)
  const [open, setOpen] = useState(false)
  const [checked, setChecked] = useState(false)

  const steps = [
    {
      icon: Users,
      title: t("shell.onbStep1Title"),
      body: t("shell.onbStep1Body"),
    },
    {
      icon: Wallet,
      title: t("shell.onbStep2Title"),
      body: t("shell.onbStep2Body"),
    },
    {
      icon: Rocket,
      title: t("shell.onbStep3Title"),
      body: t("shell.onbStep3Body"),
    },
  ]

  // Read once on mount; only first-time visitors see the guide.
  if (typeof window !== "undefined" && !checked) {
    setChecked(true)
    try {
      if (!localStorage.getItem(STORAGE_KEY)) setOpen(true)
    } catch { /* private mode: skip the guide */ }
  }

  const finish = () => {
    try { localStorage.setItem(STORAGE_KEY, "1") } catch { /* ignore */ }
    setOpen(false)
  }

  const current = steps[step]
  const Icon = current.icon

  return (
    <Dialog open={open} onOpenChange={value => { if (!value) finish() }}>
      <DialogContent className="max-w-sm rounded-2xl p-0 overflow-hidden" aria-describedby={undefined}>
        <div className="flex flex-col items-center px-6 pb-6 pt-10 text-center">
          <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <Icon className="h-7 w-7" aria-hidden="true" />
          </div>
          <h2 className="text-lg font-bold">{current.title}</h2>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{current.body}</p>

          <div className="mt-6 flex items-center gap-1.5" aria-hidden="true">
            {steps.map((item, index) => (
              <span
                key={item.title}
                className={`h-1.5 rounded-full transition-all ${index === step ? "w-5 bg-primary" : "w-1.5 bg-muted-foreground/30"}`}
              />
            ))}
          </div>

          <div className="mt-6 flex w-full items-center gap-2">
            {step > 0 ? (
              <Button variant="outline" className="h-11 flex-1" onClick={() => setStep(step - 1)} aria-label={t("shell.onbPrev")}>
                <ArrowLeft className="h-4 w-4" />
              </Button>
            ) : (
              <Button variant="ghost" className="h-11 flex-1 text-muted-foreground" onClick={finish}>
                {t("shell.onbSkip")}
              </Button>
            )}
            {step < steps.length - 1 ? (
              <Button className="h-11 flex-[2]" onClick={() => setStep(step + 1)}>{t("shell.onbNext")}</Button>
            ) : (
              <Button className="h-11 flex-[2]" onClick={finish}>{t("shell.onbStart")}</Button>
            )}
          </div>
          <p className="mt-4 text-xs text-muted-foreground">{t("shell.onbDisclaimer")}</p>
        </div>
      </DialogContent>
    </Dialog>
  )
}
