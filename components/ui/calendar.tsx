"use client"

import type * as React from "react"
import { DayPicker } from "react-day-picker"

import { cn } from "@/lib/utils"
import { buttonVariants } from "@/components/ui/button"

export type CalendarProps = React.ComponentProps<typeof DayPicker>

function Calendar({ className, classNames, showOutsideDays = true, ...props }: CalendarProps) {
  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      className={cn("p-3", className)}
      classNames={{
        months: "flex flex-col sm:flex-row space-y-4 sm:space-x-4 sm:space-y-0",
        month: "space-y-4",
        month_caption: "flex justify-center pt-1 relative items-center",
        caption_label: "text-sm font-medium",
        nav: "space-x-1 flex items-center",
        button_next: cn(
          buttonVariants({ variant: "outline" }),
          "absolute right-0 h-7 w-7 bg-transparent p-0 opacity-50 hover:opacity-100"
        ),
        button_previous: cn(
          buttonVariants({ variant: "outline" }),
          "absolute left-0 h-7 w-7 bg-transparent p-0 opacity-50 hover:opacity-100"
        ),
        month_grid: "w-full border-collapse space-y-1",
        weekdays: "flex",
        weekday: "text-muted-foreground rounded-md w-9 font-normal text-[0.8rem]",
        weeks: "mt-2",
        week: "flex w-full mt-2",
        day: "h-9 w-9 text-center text-sm p-0 relative z-20",
        day_button: cn(
          buttonVariants({ variant: "ghost" }),
          "h-9 w-9 p-0 font-normal aria-selected:opacity-100"
        ),
        range_end: "day-range-end",
        outside:
          "day-outside text-muted-foreground opacity-50 aria-selected:bg-accent/50 aria-selected:text-muted-foreground aria-selected:opacity-30",
        disabled: "text-muted-foreground opacity-50",
        range_middle: "aria-selected:bg-accent aria-selected:text-accent-foreground",
        hidden: "invisible",
        selected:
          "bg-primary text-primary-foreground focus:bg-primary focus:text-primary-foreground",
        today: "bg-accent text-accent-foreground",
        ...classNames,
      }}
      components={{
        Chevron: function CalendarChevron(props) {
          const orientation = props.orientation === "up" ? 0 : props.orientation === "down" ? 180 : props.orientation === "left" ? 90 : 270
          return (
            <svg
              viewBox="0 0 24 24"
              width={props.size ?? 16}
              height={props.size ?? 16}
              className={cn("h-4 w-4", props.className)}
              style={{ transform: `rotate(${orientation}deg)` }}
            >
              <path d="M12 4 L20 12 L12 20 L4 12 Z" fill="none" stroke="currentColor" strokeWidth="2" />
            </svg>
          )
        },
      }}
      {...props}
    />
  )
}
Calendar.displayName = "Calendar"

export { Calendar }
