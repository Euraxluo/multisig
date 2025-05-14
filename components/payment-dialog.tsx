"use client"

import { useState } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Input } from "@/components/ui/input"
import { ArrowRight, Loader2 } from "lucide-react"
import { motion } from "framer-motion"

interface PaymentDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  bill: any
  amount: number
}

export function PaymentDialog({ open, onOpenChange, bill, amount }: PaymentDialogProps) {
  const [paymentToken, setPaymentToken] = useState(bill.token)
  const [needsSwap, setNeedsSwap] = useState(false)
  const [paymentAmount, setPaymentAmount] = useState(amount.toString())
  const [isProcessing, setIsProcessing] = useState(false)
  const [processingStep, setProcessingStep] = useState(0)

  const userTokens = [
    { symbol: "APT", balance: "12.45", color: "bg-gradient-to-r from-blue-500 to-cyan-400" },
    { symbol: "USDC", balance: "250.00", color: "bg-gradient-to-r from-blue-600 to-blue-400" },
    { symbol: "USDT", balance: "100.00", color: "bg-gradient-to-r from-green-500 to-emerald-400" },
  ]

  const handleTokenChange = (value: string) => {
    setPaymentToken(value)
    setNeedsSwap(value !== bill.token)
  }

  const handlePayment = () => {
    setIsProcessing(true)
    // Simulate payment processing steps
    const steps = needsSwap ? 3 : 2
    let currentStep = 0

    const interval = setInterval(() => {
      currentStep++
      setProcessingStep(currentStep)

      if (currentStep >= steps) {
        clearInterval(interval)
        setTimeout(() => {
          setIsProcessing(false)
          onOpenChange(false)
        }, 1000)
      }
    }, 1500)
  }

  const processingSteps = [
    "Connecting to wallet...",
    needsSwap ? "Swapping tokens..." : "Processing payment...",
    "Finalizing transaction...",
  ]

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>Pay Bill Request</DialogTitle>
        </DialogHeader>

        {!isProcessing ? (
          <div className="space-y-4 py-4">
            <div className="p-3 rounded-lg bg-muted/50">
              <p className="text-xs text-muted-foreground">Bill</p>
              <p className="font-medium">{bill.title}</p>

              <div className="flex items-center justify-between mt-2">
                <div>
                  <p className="text-xs text-muted-foreground">Amount Due</p>
                  <p className="font-medium">
                    {amount} {bill.token}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-xs text-muted-foreground">Due Date</p>
                  <p className="font-medium">{new Date(bill.deadline).toLocaleDateString()}</p>
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <Label className="text-xs font-medium">Payment Amount</Label>
              <Input
                type="number"
                value={paymentAmount}
                onChange={(e) => setPaymentAmount(e.target.value)}
                className="text-sm"
              />
              <p className="text-xs text-muted-foreground">You can make a partial payment if needed</p>
            </div>

            <div className="space-y-2">
              <Label className="text-xs font-medium">Pay with</Label>
              <RadioGroup defaultValue={bill.token} onValueChange={handleTokenChange}>
                {userTokens.map((token) => (
                  <div
                    key={token.symbol}
                    className="flex items-center space-x-2 p-2 rounded-lg hover:bg-muted/50 transition-colors"
                  >
                    <RadioGroupItem value={token.symbol} id={`token-${token.symbol}`} />
                    <Label
                      htmlFor={`token-${token.symbol}`}
                      className="flex items-center justify-between w-full cursor-pointer"
                    >
                      <div className="flex items-center">
                        <div
                          className={`h-6 w-6 rounded-full text-white text-xs flex items-center justify-center mr-2 ${token.color}`}
                        >
                          {token.symbol.slice(0, 1)}
                        </div>
                        <span>{token.symbol}</span>
                      </div>
                      <span className="text-muted-foreground text-sm">Balance: {token.balance}</span>
                    </Label>
                  </div>
                ))}
              </RadioGroup>
            </div>

            {needsSwap && (
              <motion.div
                className="rounded-md border p-3 bg-muted/30"
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                transition={{ duration: 0.3 }}
              >
                <p className="text-sm font-medium flex items-center">
                  <ArrowRight className="h-4 w-4 mr-1.5 text-primary" />
                  Token Swap Required
                </p>
                <div className="flex items-center justify-between mt-2 p-2 rounded-lg bg-background">
                  <div className="text-center">
                    <div
                      className={`h-8 w-8 rounded-full text-white text-xs flex items-center justify-center mx-auto ${
                        userTokens.find((t) => t.symbol === paymentToken)?.color
                      }`}
                    >
                      {paymentToken}
                    </div>
                    <p className="text-xs mt-1">{paymentToken}</p>
                  </div>
                  <ArrowRight className="h-4 w-4 text-muted-foreground" />
                  <div className="text-center">
                    <div
                      className={`h-8 w-8 rounded-full text-white text-xs flex items-center justify-center mx-auto ${
                        userTokens.find((t) => t.symbol === bill.token)?.color
                      }`}
                    >
                      {bill.token}
                    </div>
                    <p className="text-xs mt-1">{bill.token}</p>
                  </div>
                </div>
                <div className="mt-2">
                  <Label className="text-xs">Swap Provider</Label>
                  <Select defaultValue="econia">
                    <SelectTrigger className="h-8 mt-1 text-xs">
                      <SelectValue placeholder="Select provider" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="econia">Econia DEX</SelectItem>
                      <SelectItem value="pontem">Pontem Liquid</SelectItem>
                      <SelectItem value="pancake">PancakeSwap</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </motion.div>
            )}
          </div>
        ) : (
          <div className="py-8 flex flex-col items-center justify-center">
            <div className="relative h-16 w-16 mb-4">
              <Loader2 className="h-16 w-16 animate-spin text-muted-foreground" />
              <div className="absolute inset-0 flex items-center justify-center">
                <span className="text-sm font-medium">
                  {processingStep + 1}/{processingSteps.length}
                </span>
              </div>
            </div>
            <p className="font-medium text-center">{processingSteps[processingStep]}</p>
            <div className="w-full mt-6">
              <div className="h-1 bg-muted rounded-full overflow-hidden">
                <motion.div
                  className="h-full bg-gradient-to-r from-primary to-purple-500"
                  initial={{ width: 0 }}
                  animate={{
                    width: `${((processingStep + 1) / processingSteps.length) * 100}%`,
                  }}
                  transition={{ duration: 0.5 }}
                />
              </div>
              <div className="flex justify-between mt-2">
                {processingSteps.map((_, index) => (
                  <div
                    key={index}
                    className={`h-2 w-2 rounded-full ${index <= processingStep ? "bg-primary" : "bg-muted"}`}
                  />
                ))}
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
                onClick={handlePayment}
                disabled={isProcessing}
                className="bg-gradient-to-r from-primary to-purple-500 hover:from-primary/90 hover:to-purple-500/90"
              >
                Confirm Payment
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
