"use client"

import { Check, X, Plus } from "lucide-react"
import { motion } from "framer-motion"

interface HistoryItemProps {
  item: {
    id: string
    type: string
    title: string
    description: string
    date: string
    group: string
  }
}

export function HistoryItem({ item }: HistoryItemProps) {
  const getTypeIcon = () => {
    switch (item.type) {
      case "approval":
        return <Check className="h-4 w-4" />
      case "rejection":
        return <X className="h-4 w-4" />
      case "creation":
        return <Plus className="h-4 w-4" />
      default:
        return <Check className="h-4 w-4" />
    }
  }

  const getTypeColor = () => {
    switch (item.type) {
      case "approval":
        return "bg-gradient-to-br from-green-400 to-emerald-400"
      case "rejection":
        return "bg-gradient-to-br from-red-400 to-pink-400"
      case "creation":
        return "bg-gradient-to-br from-primary to-purple-500"
      default:
        return "bg-gradient-to-br from-blue-400 to-cyan-400"
    }
  }

  return (
    <motion.div
      className="flex items-center justify-between p-2 rounded-lg hover:bg-muted/50 transition-colors"
      whileHover={{ x: 5 }}
    >
      <div className="flex items-center">
        <div className={`flex h-8 w-8 items-center justify-center rounded-full ${getTypeColor()} text-white`}>
          {getTypeIcon()}
        </div>
        <div className="ml-3">
          <div className="font-medium text-sm">{item.title}</div>
          <div className="text-xs text-muted-foreground flex items-center">
            <span className="mr-1">{item.description}</span>•<span className="ml-1">{item.group}</span>
          </div>
        </div>
      </div>
      <div className="text-right">
        <div className="text-xs text-muted-foreground">{new Date(item.date).toLocaleDateString()}</div>
      </div>
    </motion.div>
  )
}
