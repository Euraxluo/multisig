"use client"

import { useState, useCallback } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Send, Code, FileText, Clock, Plus, ChevronRight } from "lucide-react"
import { motion } from "framer-motion"
import { TemplateManagerDialog } from "./template-manager-dialog"
import { CreateTransactionDialog } from "./create-transaction-dialog"

interface QuickTemplatesProps {
  groupId?: string
}

export function QuickTemplates({ groupId }: QuickTemplatesProps) {
  const [isTemplateManagerOpen, setIsTemplateManagerOpen] = useState(false)
  const [isCreateTransactionOpen, setIsCreateTransactionOpen] = useState(false)
  const [selectedTemplate, setSelectedTemplate] = useState<string | null>(null)

  // Mock templates data
  const templates = [
    {
      id: "template-1",
      name: "Monthly Salary Payment",
      type: "transfer",
      description: "Transfer 500 USDC to team members",
      lastUsed: "2025-03-15T12:00:00Z",
    },
    {
      id: "template-2",
      name: "Staking Rewards",
      type: "contract",
      description: "Claim staking rewards from DeFi protocol",
      lastUsed: "2025-03-10T12:00:00Z",
    },
    {
      id: "template-3",
      name: "Token Swap",
      type: "contract",
      description: "Swap APT for USDC on DEX",
    },
  ]

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

  const useTemplate = useCallback(
    (templateId: string) => {
      setSelectedTemplate(templateId)
      setIsCreateTransactionOpen(true)
    },
    [setSelectedTemplate, setIsCreateTransactionOpen],
  )

  const container = {
    hidden: { opacity: 0 },
    show: {
      opacity: 1,
      transition: {
        staggerChildren: 0.05,
      },
    },
  }

  const item = {
    hidden: { opacity: 0, y: 10 },
    show: { opacity: 1, y: 0 },
  }

  return (
    <>
      <div className="mb-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-lg font-semibold">Quick Templates</h3>
          <Button
            variant="ghost"
            size="sm"
            className="text-xs flex items-center"
            onClick={() => setIsTemplateManagerOpen(true)}
          >
            Manage <ChevronRight className="h-3 w-3 ml-1" />
          </Button>
        </div>

        <motion.div className="grid gap-2" variants={container} initial="hidden" animate="show">
          {templates.map((template) => (
            <motion.div key={template.id} variants={item}>
              <Card
                className="cursor-pointer hover:shadow-md transition-all duration-200 border-none shadow-sm"
                onClick={() => useTemplate(template.id)}
              >
                <CardContent className="p-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center">
                      <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center mr-3">
                        {getTemplateIcon(template.type)}
                      </div>
                      <div>
                        <h4 className="text-sm font-medium">{template.name}</h4>
                        <p className="text-xs text-muted-foreground">{template.description}</p>
                      </div>
                    </div>
                    <Badge variant="outline" className="text-xs">
                      {template.type === "transfer" ? "Transfer" : template.type === "contract" ? "Contract" : "Batch"}
                    </Badge>
                  </div>
                  {template.lastUsed && (
                    <div className="mt-2 flex items-center text-xs text-muted-foreground">
                      <Clock className="h-3 w-3 mr-1" />
                      Last used: {formatDate(template.lastUsed)}
                    </div>
                  )}
                </CardContent>
              </Card>
            </motion.div>
          ))}

          <motion.div variants={item}>
            <Button
              variant="outline"
              className="w-full justify-center py-6 border-dashed"
              onClick={() => setIsTemplateManagerOpen(true)}
            >
              <Plus className="h-4 w-4 mr-2" />
              Create New Template
            </Button>
          </motion.div>
        </motion.div>
      </div>

      <TemplateManagerDialog open={isTemplateManagerOpen} onOpenChange={setIsTemplateManagerOpen} />

      <CreateTransactionDialog
        open={isCreateTransactionOpen}
        onOpenChange={setIsCreateTransactionOpen}
        groupId={groupId}
      />
    </>
  )
}
