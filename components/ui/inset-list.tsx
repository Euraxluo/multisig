import * as React from "react"
import { ChevronRight } from "lucide-react"
import { cn } from "@/lib/utils"

export interface InsetListProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode
}

export const InsetList = React.forwardRef<HTMLDivElement, InsetListProps>(
  ({ className, children, ...props }, ref) => {
    return (
      <div
        ref={ref}
        className={cn(
          "rounded-2xl border border-border/50 bg-card divide-y divide-border/40 overflow-hidden shadow-[0_1px_3px_rgba(0,0,0,0.03)] dark:border-border/40 dark:shadow-none",
          className
        )}
        {...props}
      >
        {children}
      </div>
    )
  }
)
InsetList.displayName = "InsetList"

export interface InsetListItemProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
  icon?: React.ReactNode
  title: React.ReactNode
  subtitle?: React.ReactNode
  value?: React.ReactNode
  showChevron?: boolean
  onClick?: React.MouseEventHandler<HTMLDivElement>
  disabled?: boolean
}

export const InsetListItem = React.forwardRef<
  HTMLDivElement,
  InsetListItemProps
>(
  (
    {
      className,
      icon,
      title,
      subtitle,
      value,
      showChevron,
      onClick,
      disabled,
      children,
      ...props
    },
    ref
  ) => {
    const isInteractive = Boolean(onClick) && !disabled

    return (
      <div
        ref={ref}
        onClick={disabled ? undefined : onClick}
        role={isInteractive ? "button" : undefined}
        tabIndex={isInteractive ? 0 : undefined}
        aria-disabled={disabled}
        className={cn(
          "flex items-center justify-between gap-3 px-4 py-3.5 text-sm transition-colors",
          isInteractive &&
            "cursor-pointer hover:bg-muted/40 active:bg-muted/70 motion-reduce:active:bg-muted/40 select-none focus-visible:outline-none focus-visible:bg-muted/40",
          disabled && "opacity-50 pointer-events-none",
          className
        )}
        {...props}
      >
        <div className="flex items-center gap-3 min-w-0 flex-1">
          {icon && (
            <div className="flex-shrink-0 text-muted-foreground flex items-center justify-center">
              {icon}
            </div>
          )}
          <div className="flex flex-col min-w-0 flex-1">
            <span className="font-medium text-foreground truncate">{title}</span>
            {subtitle && (
              <span className="text-xs text-muted-foreground truncate leading-relaxed">
                {subtitle}
              </span>
            )}
          </div>
        </div>

        {(value !== undefined || showChevron || children) && (
          <div className="flex items-center gap-2 flex-shrink-0 text-muted-foreground">
            {value !== undefined && (
              <span className="text-xs sm:text-sm text-muted-foreground">
                {value}
              </span>
            )}
            {children}
            {showChevron && (
              <ChevronRight className="h-4 w-4 opacity-50 flex-shrink-0" />
            )}
          </div>
        )}
      </div>
    )
  }
)
InsetListItem.displayName = "InsetListItem"
