"use client"

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { motion } from "framer-motion"

interface ConnectWalletDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function ConnectWalletDialog({ open, onOpenChange }: ConnectWalletDialogProps) {
  const walletOptions = [
    { name: "Petra Wallet", icon: "🦊", color: "from-orange-400 to-amber-500" },
    { name: "Martian Wallet", icon: "👽", color: "from-green-400 to-emerald-500" },
    { name: "Pontem Wallet", icon: "🔑", color: "from-blue-400 to-cyan-500" },
    { name: "Rise Wallet", icon: "🚀", color: "from-purple-400 to-pink-500" },
  ]

  const container = {
    hidden: { opacity: 0 },
    show: {
      opacity: 1,
      transition: {
        staggerChildren: 0.1,
      },
    },
  }

  const item = {
    hidden: { opacity: 0, y: 20 },
    show: { opacity: 1, y: 0 },
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>Connect Wallet</DialogTitle>
          <DialogDescription>Connect your Aptos wallet to use the Bill Splitter app.</DialogDescription>
        </DialogHeader>

        <motion.div className="grid gap-3 py-4" variants={container} initial="hidden" animate="show">
          {walletOptions.map((wallet) => (
            <motion.div key={wallet.name} variants={item}>
              <Button
                variant="outline"
                className="flex justify-start items-center h-12 w-full overflow-hidden group relative"
                onClick={() => onOpenChange(false)}
              >
                <div
                  className={`absolute inset-0 bg-gradient-to-r ${wallet.color} opacity-0 group-hover:opacity-10 transition-opacity`}
                ></div>
                <span className="text-xl mr-4">{wallet.icon}</span>
                <span>{wallet.name}</span>
              </Button>
            </motion.div>
          ))}
        </motion.div>
      </DialogContent>
    </Dialog>
  )
}
