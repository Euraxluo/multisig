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
import { format, addDays, differenceInDays } from "date-fns"
import { cn } from "@/lib/utils"
import { CalendarIcon, Waves, ArrowRight } from "lucide-react"
import { Slider } from "@/components/ui/slider"
import { Textarea } from "@/components/ui/textarea"

interface StreamPaymentDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  groupId?: string
}

export function StreamPaymentDialog({ open, onOpenChange, groupId }: StreamPaymentDialogProps) {
  const [recipient, setRecipient] = useState("")
  const [totalAmount, setTotalAmount] = useState("")
  const [token, setToken] = useState("USDC")
  const [startDate, setStartDate] = useState<Date | undefined>(new Date())
  const [endDate, setEndDate] = useState<Date | undefined>(addDays(new Date(), 30))
  const [description, setDescription] = useState("")
  const [isProcessing, setIsProcessing] = useState(false)
  const [flowRate, setFlowRate] = useState(50) // 0-100 percentage of linear flow

  const tokens = ["SUI", "USDC", "USDT"]

  const handleSubmit = () => {
    if (!recipient.trim() || !totalAmount.trim()) return
    setIsProcessing(true)
    try {
      const stored = JSON.parse(localStorage.getItem("sui_recurring_payments") || "[]")
      const newStream = {
        id: `stream-${Date.now()}`,
        type: "stream",
        name: description.trim() || `Stream payment to ${recipient.slice(0, 8)}...`,
        recipient: recipient.trim(),
        amount: totalAmount.trim(),
        token,
        startDate: startDate || new Date(),
        endDate: endDate || addDays(new Date(), 30),
        progress: 0,
        status: "active",
      }
      localStorage.setItem("sui_recurring_payments", JSON.stringify([newStream, ...stored]))
      window.dispatchEvent(new CustomEvent("sui-recurring-updated", { detail: newStream }))
      window.dispatchEvent(new Event("storage"))
    } catch (e) {
      console.warn("Failed to save stream payment", e)
    } finally {
      setIsProcessing(false)
      onOpenChange(false)
    }
  }

  const getDurationInDays = () => {
    if (!startDate || !endDate) return 0
    return differenceInDays(endDate, startDate)
  }

  const getFlowRatePerDay = () => {
    if (!totalAmount || !startDate || !endDate) return "0"
    const days = Math.max(1, getDurationInDays())
    return (Number.parseFloat(totalAmount) / days).toFixed(4)
  }

  const getFlowCurveDescription = () => {
    if (flowRate < 30) return "Front-loaded (higher amounts released earlier)"
    if (flowRate > 70) return "Back-loaded (higher amounts released later)"
    return "Linear (equal amounts released over time)"
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Create Stream Payment</DialogTitle>
          <DialogDescription>Set up a continuous stream of payments over time</DialogDescription>
        </DialogHeader>

        {isProcessing ? (
          <div className="py-8 flex flex-col items-center justify-center">
            <div className="h-12 w-12 rounded-full border-4 border-primary border-t-transparent animate-spin mb-4"></div>
            <p className="font-medium">Creating stream payment...</p>
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
                <Label htmlFor="amount">Total Amount</Label>
                <Input
                  id="amount"
                  type="number"
                  placeholder="0.00"
                  value={totalAmount}
                  onChange={(e) => setTotalAmount(e.target.value)}
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

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Start Date</Label>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      variant={"outline"}
                      className={cn(
                        "w-full justify-start text-left font-normal",
                        !startDate && "text-muted-foreground",
                      )}
                    >
                      <CalendarIcon className="mr-2 h-4 w-4" />
                      {startDate ? format(startDate, "PPP") : "Select date"}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0">
                    <Calendar
                      mode="single"
                      selected={startDate}
                      onSelect={(date) => {
                        setStartDate(date)
                        if (date && endDate && date > endDate) {
                          setEndDate(addDays(date, 30))
                        }
                      }}
                    />
                  </PopoverContent>
                </Popover>
              </div>

              <div className="space-y-2">
                <Label>End Date</Label>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      variant={"outline"}
                      className={cn("w-full justify-start text-left font-normal", !endDate && "text-muted-foreground")}
                    >
                      <CalendarIcon className="mr-2 h-4 w-4" />
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
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Flow Rate Curve</Label>
                <span className="text-xs text-muted-foreground">{getFlowCurveDescription()}</span>
              </div>
              <Slider
                value={[flowRate]}
                min={0}
                max={100}
                step={1}
                onValueChange={(value) => setFlowRate(value[0])}
                className="py-4"
              />
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>Front-loaded</span>
                <span>Linear</span>
                <span>Back-loaded</span>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="description">Description (Optional)</Label>
              <Textarea
                id="description"
                placeholder="Add details about this stream payment"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="resize-none h-20"
              />
            </div>

            <div className="bg-muted/50 p-3 rounded-lg space-y-2">
              <h4 className="text-sm font-medium flex items-center">
                <Waves className="h-4 w-4 mr-2" />
                Stream Summary
              </h4>
              <div className="text-sm space-y-1">
                <p>Total amount: {totalAmount ? `${totalAmount} ${token}` : "Not specified"}</p>
                <p>Duration: {getDurationInDays()} days</p>
                <p>
                  Average flow rate: {getFlowRatePerDay()} {token}/day
                </p>
                <div className="flex items-center mt-2">
                  <div className="text-xs text-muted-foreground">
                    {startDate ? format(startDate, "MMM d") : "Start"}
                  </div>
                  <div className="flex-1 mx-2 h-2 bg-muted rounded-full overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-primary to-purple-500"
                      style={{
                        clipPath:
                          flowRate < 50
                            ? `polygon(0 0, ${100 - flowRate}% 100%, 100% 100%, 100% 0)`
                            : `polygon(0 0, 0 100%, ${flowRate}% 0)`,
                      }}
                    ></div>
                  </div>
                  <div className="text-xs text-muted-foreground">{endDate ? format(endDate, "MMM d") : "End"}</div>
                </div>
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
                disabled={!recipient || !totalAmount || !startDate || !endDate}
                className="bg-gradient-to-r from-primary to-purple-500 hover:from-primary/90 hover:to-purple-500/90"
              >
                <ArrowRight className="h-4 w-4 mr-2" />
                Create Stream
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
