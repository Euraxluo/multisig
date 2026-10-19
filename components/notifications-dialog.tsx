"use client"

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import { motion } from "framer-motion"
import { Bell, Check } from "lucide-react"

interface NotificationsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function NotificationsDialog({ open, onOpenChange }: NotificationsDialogProps) {
  const notifications = [
    {
      id: "notif1",
      title: "Payment Received",
      description: "Sam paid 25 SUI for Group Lunch",
      time: "2 hours ago",
      unread: true,
    },
    {
      id: "notif2",
      title: "New Request",
      description: "Alex requested 30 USDC for Dinner at Satoshi's",
      time: "1 day ago",
      unread: true,
    },
    {
      id: "notif3",
      title: "Bill Reminder",
      description: "Concert Tickets payment due in 3 days",
      time: "2 days ago",
      unread: false,
    },
    {
      id: "notif4",
      title: "Payment Completed",
      description: "All payments received for Vacation Rental",
      time: "3 days ago",
      unread: false,
    },
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
          <DialogTitle className="flex items-center">
            <Bell className="h-5 w-5 mr-2 text-primary" />
            Notifications
          </DialogTitle>
          <DialogDescription>Stay updated with your bill requests and payments.</DialogDescription>
        </DialogHeader>

        <ScrollArea className="h-[300px] pr-4">
          <motion.div className="space-y-3 py-2" variants={container} initial="hidden" animate="show">
            {notifications.map((notification) => (
              <motion.div
                key={notification.id}
                className={`p-3 rounded-lg relative ${notification.unread ? "bg-primary/5" : ""}`}
                variants={item}
                whileHover={{ x: 5 }}
              >
                {notification.unread && (
                  <span className="absolute top-3 right-3 h-2 w-2 rounded-full bg-primary"></span>
                )}
                <h4 className="font-medium text-sm">{notification.title}</h4>
                <p className="text-sm text-muted-foreground mt-1">{notification.description}</p>
                <div className="flex justify-between items-center mt-2">
                  <p className="text-xs text-muted-foreground">{notification.time}</p>
                  <button className="text-xs text-primary flex items-center">
                    <Check className="h-3 w-3 mr-1" /> Mark as read
                  </button>
                </div>
              </motion.div>
            ))}
          </motion.div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}
