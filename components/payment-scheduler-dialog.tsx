"use client"

import { useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Calendar } from "@/components/ui/calendar"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { format } from "date-fns"
import { cn } from "@/lib/utils"
import { CalendarIcon, Clock, Repeat, CalendarPlus2Icon as CalendarIcon2, Check } from "lucide-react"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"

interface PaymentSchedulerDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  groupId?: string
}

export function PaymentSchedulerDialog({ open, onOpenChange, groupId }: PaymentSchedulerDialogProps) {
  const [recipient, setRecipient] = useState("")
  const [amount, setAmount] = useState("")
  const [token, setToken] = useState("USDC")
  const [frequency, setFrequency] = useState("monthly")
  const [startDate, setStartDate] = useState<Date | undefined>(new Date())
  const [endDate, setEndDate] = useState<Date | undefined>(undefined)
  const [endAfterOccurrences, setEndAfterOccurrences] = useState("10")
  const [endType, setEndType] = useState("occurrences") // occurrences, date, never
  const [description, setDescription] = useState("")
  const [requiresApproval, setRequiresApproval] = useState(true)
  const [isProcessing, setIsProcessing] = useState(false)

  const tokens = ["SUI", "USDC", "USDT"]

  const frequencies = [
    { value: "daily", label: "Daily" },
    { value: "weekly", label: "Weekly" },
    { value: "biweekly", label: "Bi-weekly" },
    { value: "monthly", label: "Monthly" },
    { value: "quarterly", label: "Quarterly" },
    { value: "yearly", label: "Yearly" },
  ]

  const handleSubmit = () => {
    setIsProcessing(true)

    // Simulate API call
    setTimeout(() => {
      setIsProcessing(false)
      onOpenChange(false)
      // In a real app, you would save the recurring payment here
    }, 1500)
  }

  const getFrequencyText = () => {
    switch (frequency) {
      case "daily":
        return "day"
      case "weekly":
        return "week"
      case "biweekly":
        return "2 weeks"
      case "monthly":
        return "month"
      case "quarterly":
        return "3 months"
      case "yearly":
        return "year"
      default:
        return "month"
    }
  }

  const getEndDateText = () => {
    if (endType === "never") return "No end date"
    if (endType === "occurrences") return `After ${endAfterOccurrences} payments`
    if (endType === "date" && endDate) return `Until ${format(endDate, "PPP")}`
    return "Not specified"
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Schedule Recurring Payment</DialogTitle>
          <DialogDescription>Set up automatic recurring payments</DialogDescription>
        </DialogHeader>

        {isProcessing ? (
          <div className="py-8 flex flex-col items-center justify-center">
            <div className="h-12 w-12 rounded-full border-4 border-primary border-t-transparent animate-spin mb-4"></div>
            <p className="font-medium">Creating recurring payment...</p>
          </div>
        ) : (
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="recipient">Recipient Address</Label>
              <Input
                id="recipient"
                placeholder="0x..."
                value={recipient}
                onChange={(e) => setRecipient(e.target.value)}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="amount">Amount</Label>
                <Input
                  id="amount"
                  type="number"
                  placeholder="0.00"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="token">Token</Label>
                <Select value={token} onValueChange={setToken}>
                  <SelectTrigger id="token">
                    <SelectValue placeholder="Select token" />
                  </SelectTrigger>
                  <SelectContent>
                    {tokens.map((t) => (
                      <SelectItem key={t} value={t}>
                        {t}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-2">
              <Label>Payment Frequency</Label>
              <RadioGroup value={frequency} onValueChange={setFrequency} className="grid grid-cols-3 gap-2">
                {frequencies.map((f) => (
                  <div key={f.value} className="flex items-center space-x-2">
                    <RadioGroupItem value={f.value} id={`frequency-${f.value}`} />
                    <Label htmlFor={`frequency-${f.value}`} className="text-sm cursor-pointer">
                      {f.label}
                    </Label>
                  </div>
                ))}
              </RadioGroup>
            </div>

            <div className="space-y-2">
              <Label>Start Date</Label>
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant={"outline"}
                    className={cn("w-full justify-start text-left font-normal", !startDate && "text-muted-foreground")}
                  >
                    <CalendarIcon className="mr-2 h-4 w-4" />
                    {startDate ? format(startDate, "PPP") : "Select date"}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0">
                  <Calendar mode="single" selected={startDate} onSelect={setStartDate} />
                </PopoverContent>
              </Popover>
            </div>

            <div className="space-y-2">
              <Label>End Condition</Label>
              <RadioGroup value={endType} onValueChange={setEndType} className="space-y-2">
                <div className="flex items-center space-x-2">
                  <RadioGroupItem value="occurrences" id="end-occurrences" />
                  <Label htmlFor="end-occurrences" className="text-sm cursor-pointer flex items-center">
                    <Repeat className="h-4 w-4 mr-2" />
                    After
                    <Input
                      type="number"
                      value={endAfterOccurrences}
                      onChange={(e) => setEndAfterOccurrences(e.target.value)}
                      className="w-16 mx-2 h-7 text-sm"
                      disabled={endType !== "occurrences"}
                    />
                    payments
                  </Label>
                </div>

                <div className="flex items-center space-x-2">
                  <RadioGroupItem value="date" id="end-date" />
                  <Label htmlFor="end-date" className="text-sm cursor-pointer flex items-center">
                    <CalendarIcon2 className="h-4 w-4 mr-2" />
                    On specific date
                    <Popover>
                      <PopoverTrigger asChild>
                        <Button
                          variant={"outline"}
                          className={cn("ml-2 h-7 text-sm", !endDate && "text-muted-foreground")}
                          disabled={endType !== "date"}
                        >
                          {endDate ? format(endDate, "PPP") : "Select date"}
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent className="w-auto p-0">
                        <Calendar
                          mode="single"
                          selected={endDate}
                          onSelect={setEndDate}
                          disabled={(date) => {
                            if (!startDate) return false
                            return date < startDate
                          }}
                        />
                      </PopoverContent>
                    </Popover>
                  </Label>
                </div>

                <div className="flex items-center space-x-2">
                  <RadioGroupItem value="never" id="end-never" />
                  <Label htmlFor="end-never" className="text-sm cursor-pointer flex items-center">
                    <Clock className="h-4 w-4 mr-2" />
                    No end date (until cancelled)
                  </Label>
                </div>
              </RadioGroup>
            </div>

            <div className="space-y-2">
              <Label htmlFor="description">Description (Optional)</Label>
              <Textarea
                id="description"
                placeholder="Add details about this recurring payment"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="resize-none h-20"
              />
            </div>

            <div className="flex items-center space-x-2">
              <Switch id="requires-approval" checked={requiresApproval} onCheckedChange={setRequiresApproval} />
              <Label htmlFor="requires-approval" className="cursor-pointer">
                Require approval for each payment
              </Label>
            </div>

            <div className="bg-muted/50 p-3 rounded-lg space-y-2">
              <h4 className="text-sm font-medium">Payment Summary</h4>
              <div className="text-sm space-y-1">
                <p>
                  {amount ? `${amount} ${token}` : "Amount"} will be sent to {recipient || "recipient"} every{" "}
                  {getFrequencyText()}.
                </p>
                <p>First payment: {startDate ? format(startDate, "PPP") : "Not specified"}</p>
                <p>{getEndDateText()}</p>
                <p>
                  {requiresApproval
                    ? "Each payment will require manual approval."
                    : "Payments will be processed automatically."}
                </p>
              </div>
            </div>
          </div>
        )}

        <DialogFooter>
          {!isProcessing && (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                onClick={handleSubmit}
                disabled={!recipient || !amount || !startDate}
                className="bg-gradient-to-r from-primary to-purple-500 hover:from-primary/90 hover:to-purple-500/90"
              >
                <Check className="h-4 w-4 mr-2" />
                Schedule Payments
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
