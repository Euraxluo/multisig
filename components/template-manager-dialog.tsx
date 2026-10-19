"use client"

import { useState, useEffect } from "react"
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
import { Send, Code, FileText, Pencil, Trash, Plus, X } from "lucide-react"
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
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"

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
  recipient?: string
  amount?: string
  token?: string
  contract?: string
  function?: string
  args?: string
  batchItems?: { recipient: string; amount: string; token: string }[]
}

export function TemplateManagerDialog({ open, onOpenChange }: TemplateManagerDialogProps) {
  const DEFAULT_TEMPLATES: TransactionTemplate[] = [
    {
      id: "template-1",
      name: "每月团队津贴发放",
      type: "transfer",
      description: "向核心贡献者划拨 50 SUI 津贴",
      createdAt: "2025-02-15T12:00:00Z",
      lastUsed: "2025-03-15T12:00:00Z",
      recipient: "0xaf0806fadf61ceeb76c21b40af4393e244a5d8ca91ba208d4f58537421eff2e4",
      amount: "50",
      token: "SUI",
    },
    {
      id: "template-2",
      name: "生态流动性金库充值",
      type: "contract",
      description: "向流动性池注入做市资金",
      createdAt: "2025-02-10T12:00:00Z",
      lastUsed: "2025-03-10T12:00:00Z",
      contract: "0x83fb785f1da119aea4e0faa19d1466b33899e14ea730af6425ec7d5557cb5a36",
      function: "deposit",
      args: '{"amount": "100"}',
    },
    {
      id: "template-3",
      name: "SUI/USDC 快捷对冲",
      type: "contract",
      description: "在 DeepBook / Cetus 执行稳定币兑换",
      createdAt: "2025-02-05T12:00:00Z",
      contract: "0x0000000000000000000000000000000000000000000000000000000000000002",
      function: "swap",
      args: '{"tokenIn": "SUI", "tokenOut": "USDC", "amountIn": "10"}',
    },
  ]

  const [templates, setTemplates] = useState<TransactionTemplate[]>(DEFAULT_TEMPLATES)

  useEffect(() => {
    try {
      const stored = localStorage.getItem("sui_payment_templates")
      if (stored) {
        const parsed = JSON.parse(stored)
        if (Array.isArray(parsed) && parsed.length > 0) {
          setTemplates(parsed)
        }
      }
    } catch {}
  }, [])

  const persistTemplates = (newTemplates: TransactionTemplate[]) => {
    setTemplates(newTemplates)
    try {
      localStorage.setItem("sui_payment_templates", JSON.stringify(newTemplates))
      window.dispatchEvent(new CustomEvent("sui-templates-updated", { detail: newTemplates }))
    } catch {}
  }
  const [searchTerm, setSearchTerm] = useState("")
  const [deleteTemplateId, setDeleteTemplateId] = useState<string | null>(null)
  const [isEditMode, setIsEditMode] = useState(false)
  const [editingTemplate, setEditingTemplate] = useState<TransactionTemplate | null>(null)
  const [formState, setFormState] = useState({
    name: "",
    type: "transfer",
    description: "",
    recipient: "",
    amount: "",
    token: "USDC",
    contract: "",
    function: "",
    args: "",
    batchItems: [] as { recipient: string; amount: string; token: string }[],
  })

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
    const updated = templates.filter((template) => template.id !== id)
    persistTemplates(updated)
    setDeleteTemplateId(null)
  }

  const startEditingTemplate = (template: TransactionTemplate) => {
    setEditingTemplate(template)
    setFormState({
      name: template.name,
      type: template.type,
      description: template.description,
      recipient: template.recipient || "",
      amount: template.amount || "",
      token: template.token || "USDC",
      contract: template.contract || "",
      function: template.function || "",
      args: template.args || "",
      batchItems: template.batchItems || [],
    })
    setIsEditMode(true)
  }

  const startCreatingTemplate = () => {
    setEditingTemplate(null)
    setFormState({
      name: "",
      type: "transfer",
      description: "",
      recipient: "",
      amount: "",
      token: "USDC",
      contract: "",
      function: "",
      args: "",
      batchItems: [],
    })
    setIsEditMode(true)
  }

  const cancelEditing = () => {
    setIsEditMode(false)
    setEditingTemplate(null)
  }

  const saveTemplate = () => {
    if (!formState.name) return

    const newTemplate = {
      id: editingTemplate?.id || `template-${Date.now()}`,
      name: formState.name,
      type: formState.type,
      description: formState.description,
      createdAt: editingTemplate?.createdAt || new Date().toISOString(),
      lastUsed: editingTemplate?.lastUsed,
      recipient: formState.recipient,
      amount: formState.amount,
      token: formState.token,
      contract: formState.contract,
      function: formState.function,
      args: formState.args,
      batchItems: formState.batchItems,
    }

    let updated: TransactionTemplate[]
    if (editingTemplate) {
      updated = templates.map((t) => (t.id === editingTemplate.id ? newTemplate : t))
    } else {
      updated = [...templates, newTemplate]
    }
    persistTemplates(updated)

    setIsEditMode(false)
    setEditingTemplate(null)
  }

  const addBatchItem = () => {
    setFormState({
      ...formState,
      batchItems: [...formState.batchItems, { recipient: "", amount: "", token: "USDC" }],
    })
  }

  const updateBatchItem = (index: number, field: string, value: string) => {
    const updatedItems = [...formState.batchItems]
    updatedItems[index] = { ...updatedItems[index], [field]: value }
    setFormState({
      ...formState,
      batchItems: updatedItems,
    })
  }

  const removeBatchItem = (index: number) => {
    const updatedItems = [...formState.batchItems]
    updatedItems.splice(index, 1)
    setFormState({
      ...formState,
      batchItems: updatedItems,
    })
  }

  const tokens = ["SUI", "USDC", "USDT"]

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-[600px]">
          <DialogHeader>
            <DialogTitle>Transaction Templates</DialogTitle>
            <DialogDescription>Manage your saved transaction templates</DialogDescription>
          </DialogHeader>

          {isEditMode ? (
            <div className="space-y-4">
              <div className="space-y-2">
                <h3 className="text-sm font-medium">{editingTemplate ? "Edit Template" : "Create Template"}</h3>
                <div className="space-y-2">
                  <div className="space-y-1">
                    <Label htmlFor="template-name">Template Name</Label>
                    <Input
                      id="template-name"
                      value={formState.name}
                      onChange={(e) => setFormState({ ...formState, name: e.target.value })}
                      placeholder="Monthly Payment, Staking, etc."
                    />
                  </div>

                  <div className="space-y-1">
                    <Label htmlFor="template-description">Description</Label>
                    <Input
                      id="template-description"
                      value={formState.description}
                      onChange={(e) => setFormState({ ...formState, description: e.target.value })}
                      placeholder="Brief description of this template"
                    />
                  </div>

                  <div className="space-y-1">
                    <Label>Transaction Type</Label>
                    <Select
                      value={formState.type}
                      onValueChange={(value) => setFormState({ ...formState, type: value })}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select type" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="transfer">Transfer</SelectItem>
                        <SelectItem value="contract">Contract Call</SelectItem>
                        <SelectItem value="batch">Batch Transaction</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  {formState.type === "transfer" && (
                    <>
                      <div className="space-y-1">
                        <Label htmlFor="recipient">Recipient Address</Label>
                        <Input
                          id="recipient"
                          value={formState.recipient}
                          onChange={(e) => setFormState({ ...formState, recipient: e.target.value })}
                          placeholder="0x..."
                        />
                      </div>

                      <div className="grid grid-cols-2 gap-2">
                        <div className="space-y-1">
                          <Label htmlFor="amount">Amount</Label>
                          <Input
                            id="amount"
                            value={formState.amount}
                            onChange={(e) => setFormState({ ...formState, amount: e.target.value })}
                            placeholder="0.00"
                          />
                        </div>
                        <div className="space-y-1">
                          <Label htmlFor="token">Token</Label>
                          <Select
                            value={formState.token}
                            onValueChange={(value) => setFormState({ ...formState, token: value })}
                          >
                            <SelectTrigger id="token">
                              <SelectValue placeholder="Select" />
                            </SelectTrigger>
                            <SelectContent>
                              {tokens.map((token) => (
                                <SelectItem key={token} value={token}>
                                  {token}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      </div>
                    </>
                  )}

                  {formState.type === "contract" && (
                    <>
                      <div className="space-y-1">
                        <Label htmlFor="contract">Contract Address</Label>
                        <Input
                          id="contract"
                          value={formState.contract}
                          onChange={(e) => setFormState({ ...formState, contract: e.target.value })}
                          placeholder="0x..."
                        />
                      </div>

                      <div className="space-y-1">
                        <Label htmlFor="function">Function Name</Label>
                        <Input
                          id="function"
                          value={formState.function}
                          onChange={(e) => setFormState({ ...formState, function: e.target.value })}
                          placeholder="transfer, mint, etc."
                        />
                      </div>

                      <div className="space-y-1">
                        <Label htmlFor="args">Arguments (JSON)</Label>
                        <Textarea
                          id="args"
                          value={formState.args}
                          onChange={(e) => setFormState({ ...formState, args: e.target.value })}
                          placeholder='{"param1": "value1", "param2": "value2"}'
                          className="font-mono text-xs"
                        />
                      </div>
                    </>
                  )}

                  {formState.type === "batch" && (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <Label>Batch Items</Label>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={addBatchItem}
                          className="h-7 text-xs"
                        >
                          <Plus className="h-3 w-3 mr-1" /> Add Item
                        </Button>
                      </div>

                      {formState.batchItems.length === 0 ? (
                        <div className="text-center py-4 border border-dashed rounded-md">
                          <p className="text-sm text-muted-foreground">No batch items added</p>
                        </div>
                      ) : (
                        <div className="space-y-2 max-h-[200px] overflow-y-auto">
                          {formState.batchItems.map((item, index) => (
                            <div key={index} className="flex items-center space-x-2 p-2 border rounded-md">
                              <div className="flex-1">
                                <Input
                                  placeholder="Recipient (0x...)"
                                  value={item.recipient}
                                  onChange={(e) => updateBatchItem(index, "recipient", e.target.value)}
                                  className="text-xs"
                                />
                              </div>
                              <div className="w-20">
                                <Input
                                  placeholder="Amount"
                                  value={item.amount}
                                  onChange={(e) => updateBatchItem(index, "amount", e.target.value)}
                                  className="text-xs"
                                />
                              </div>
                              <div className="w-20">
                                <Select
                                  value={item.token}
                                  onValueChange={(value) => updateBatchItem(index, "token", value)}
                                >
                                  <SelectTrigger className="h-8 text-xs">
                                    <SelectValue placeholder="Token" />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {tokens.map((token) => (
                                      <SelectItem key={token} value={token}>
                                        {token}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </div>
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => removeBatchItem(index)}
                                className="h-8 w-8"
                              >
                                <X className="h-4 w-4" />
                              </Button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>

              <DialogFooter>
                <Button variant="outline" onClick={cancelEditing}>
                  Cancel
                </Button>
                <Button
                  onClick={saveTemplate}
                  className="bg-gradient-to-r from-primary to-purple-500 hover:from-primary/90 hover:to-purple-500/90"
                >
                  Save Template
                </Button>
              </DialogFooter>
            </div>
          ) : (
            // 原有的模板列表内容
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
                <Button
                  className="ml-2 bg-gradient-to-r from-primary to-purple-500 hover:from-primary/90 hover:to-purple-500/90"
                  onClick={startCreatingTemplate}
                >
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
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            onClick={() => startEditingTemplate(template)}
                          >
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
          )}

          {!isEditMode && (
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Close
              </Button>
            </DialogFooter>
          )}
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
