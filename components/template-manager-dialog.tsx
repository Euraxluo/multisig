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
import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import { Send, Code, FileText, Pencil, Trash, Plus } from "lucide-react"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"

interface TemplateManagerDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

interface TransactionTemplate {
  id: string
  name: string
  type: string
  description: string
  createdAt: string
  lastUsed?: string
}

export function TemplateManagerDialog({ open, onOpenChange }: TemplateManagerDialogProps) {
  const [templates, setTemplates] = useState<TransactionTemplate[]>([
    {
      id: "template-1",
      name: "Monthly Salary Payment",
      type: "transfer",
      description: "Transfer 500 USDC to team members",
      createdAt: "2025-02-15T12:00:00Z",
      lastUsed: "2025-03-15T12:00:00Z",
    },
    {
      id: "template-2",
      name: "Staking Rewards",
      type: "contract",
      description: "Claim staking rewards from DeFi protocol",
      createdAt: "2025-02-10T12:00:00Z",
      lastUsed: "2025-03-10T12:00:00Z",
    },
    {
      id: "template-3",
      name: "Token Swap",
      type: "contract",
      description: "Swap APT for USDC on DEX",
      createdAt: "2025-02-05T12:00:00Z",
    },
    {
      id: "template-4",
      name: "Batch Payment",
      type: "batch",
      description: "Batch payment to multiple recipients",
      createdAt: "2025-02-01T12:00:00Z",
      lastUsed: "2025-03-01T12:00:00Z",
    },
  ])
  const [searchTerm, setSearchTerm] = useState("")
  const [deleteTemplateId, setDeleteTemplateId] = useState<string | null>(null)

  const filteredTemplates = templates.filter(
    (template) =>
      template.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      template.description.toLowerCase().includes(searchTerm.toLowerCase()),
  )

  const getTemplateIcon = (type: string) => {
    switch (type) {
      case "transfer":
        return <Send className="h-4 w-4 text-primary" />
      case "contract":
        return <Code className="h-4 w-4 text-primary" />
      case "batch":
        return <FileText className="h-4 w-4 text-primary" />
      default:
        return <Send className="h-4 w-4 text-primary" />
    }
  }

  const formatDate = (dateString?: string) => {
    if (!dateString) return "Never"
    return new Date(dateString).toLocaleDateString()
  }

  const handleDeleteTemplate = (id: string) => {
    setTemplates(templates.filter((template) => template.id !== id))
    setDeleteTemplateId(null)
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-[600px]">
          <DialogHeader>
            <DialogTitle>Transaction Templates</DialogTitle>
            <DialogDescription>Manage your saved transaction templates</DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="relative flex-1">
                <Input
                  placeholder="Search templates..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="pr-10"
                />
              </div>
              <Button className="ml-2 bg-gradient-to-r from-primary to-purple-500 hover:from-primary/90 hover:to-purple-500/90">
                <Plus className="h-4 w-4 mr-1" /> New Template
              </Button>
            </div>

            <div className="space-y-2 max-h-[400px] overflow-y-auto pr-1">
              {filteredTemplates.length === 0 ? (
                <div className="text-center py-8">
                  <p className="text-muted-foreground">No templates found</p>
                </div>
              ) : (
                filteredTemplates.map((template) => (
                  <Card key={template.id} className="p-3 hover:bg-muted/50 transition-colors">
                    <div className="flex items-start justify-between">
                      <div className="flex items-start">
                        <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center mr-3">
                          {getTemplateIcon(template.type)}
                        </div>
                        <div>
                          <h3 className="font-medium text-sm flex items-center">
                            {template.name}
                            <Badge variant="outline" className="ml-2 text-xs">
                              {template.type === "transfer"
                                ? "Transfer"
                                : template.type === "contract"
                                  ? "Contract"
                                  : "Batch"}
                            </Badge>
                          </h3>
                          <p className="text-xs text-muted-foreground mt-0.5">{template.description}</p>
                          <div className="flex items-center text-xs text-muted-foreground mt-1">
                            <span>Created: {formatDate(template.createdAt)}</span>
                            <span className="mx-2">•</span>
                            <span>Last used: {formatDate(template.lastUsed)}</span>
                          </div>
                        </div>
                      </div>
                      <div className="flex space-x-1">
                        <Button variant="ghost" size="icon" className="h-8 w-8">
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-destructive"
                          onClick={() => setDeleteTemplateId(template.id)}
                        >
                          <Trash className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  </Card>
                ))
              )}
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deleteTemplateId} onOpenChange={(open) => !open && setDeleteTemplateId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Are you sure?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete this template. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteTemplateId && handleDeleteTemplate(deleteTemplateId)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
