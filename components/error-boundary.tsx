"use client"

// Keeps one broken panel from taking the whole app down.
//
// Without a boundary, a render error in any tab unmounts the React root and the
// page goes blank — including the navigation that would let the user reach a
// working tab. Each tab panel is wrapped separately so a crash is contained to
// the panel that caused it and the user can still switch away.
//
// The message shown is the thrown error's `message`, never the stack: our own
// errors carry Chinese, user-facing text, while a stack can contain file paths
// and internal state. Nothing is logged to a third party.
import React from "react"
import { AlertTriangle, RotateCcw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useI18n } from "@/components/i18n-provider"

interface Props {
  /** Named in the fallback so the user knows which panel failed. */
  label: string
  children: React.ReactNode
}

interface State {
  error: Error | null
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error) {
    // Console only, and only the message: no wallet data, no keys, no stack.
    console.error(`[${this.props.label}]`, error.message)
  }

  private reset = () => this.setState({ error: null })

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    return <BoundaryFallback label={this.props.label} message={error.message || null} onReset={this.reset} />
  }
}

/** Function component so the fallback text follows locale switches. */
function BoundaryFallback({ label, message, onReset }: { label: string; message: string | null; onReset: () => void }) {
  const { t } = useI18n()
  return (
    <div role="alert" className="rounded-xl border border-destructive/40 bg-destructive/5 p-4">
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">{t("dash.panelFailed", { label })}</p>
          <p className="mt-1 break-words text-xs text-muted-foreground">{message || t("dash.noErrorMessage")}</p>
          <p className="mt-2 text-xs text-muted-foreground">{t("dash.otherPanelsUsable")}</p>
          <Button size="sm" variant="outline" className="mt-3" onClick={onReset}>
            <RotateCcw className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            {t("dash.retryPanel")}
          </Button>
        </div>
      </div>
    </div>
  )
}
