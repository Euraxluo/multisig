import * as React from "react"
import { cn } from "@/lib/utils"

export interface GroupedCardProps extends React.HTMLAttributes<HTMLDivElement> {
  header?: React.ReactNode
  footer?: React.ReactNode
  variant?: "default" | "glass" | "plain"
}

export const GroupedCard = React.forwardRef<HTMLDivElement, GroupedCardProps>(
  ({ className, header, footer, variant = "default", children, ...props }, ref) => {
    return (
      <div ref={ref} className={cn("space-y-1.5", className)} {...props}>
        {header && (
          <div className="px-3 text-xs font-medium uppercase tracking-wider text-muted-foreground/80">
            {header}
          </div>
        )}
        <div
          className={cn(
            "rounded-2xl transition-all duration-200 overflow-hidden",
            variant === "default" &&
              "border border-border/50 bg-card text-card-foreground shadow-[0_1px_3px_rgba(0,0,0,0.03)] dark:border-border/40 dark:shadow-none",
            variant === "glass" &&
              "apple-glass border border-border/40 text-card-foreground shadow-sm",
            variant === "plain" && "bg-transparent border-0"
          )}
        >
          {children}
        </div>
        {footer && (
          <div className="px-3 text-xs text-muted-foreground/75 leading-relaxed">
            {footer}
          </div>
        )}
      </div>
    )
  }
)
GroupedCard.displayName = "GroupedCard"
