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
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Send, Code, FileText, Pencil, Trash, Plus, Clock, Repeat } from "lucide-react"
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
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"

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
  details: {
    recipient?: string
    amount?: string
    token?: string
    contract?: string
    function?: string
    args?: string
    payload?: string
    schedule?: {
      type: "none" | "recurring" | "stream" | "batch"
      interval?: string
      duration?: string
      startDate?: string
      endDate?: string
      recipients?: Array<{
        address: string
        amount: string
      }>
    }
  }
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
      details: {
        recipient: "0x1234...5678",
        amount: "500",
        token: "USDC",
        schedule: {
          type: "recurring",
          interval: "monthly",
          startDate: "2025-04-01T00:00:00Z",
        },
      },
    },
    {
      id: "template-2",
      name: "Staking Rewards",
      type: "contract",
      description: "Claim staking rewards from DeFi protocol",
      createdAt: "2025-02-10T12:00:00Z",
      lastUsed: "2025-03-10T12:00:00Z",
      details: {
        contract: "0xabcd...efgh",
        function: "claimRewards",
        args: '{"amount": "100"}',
      },
    },
    {
      id: "template-3",
      name: "Token Swap",
      type: "contract",
      description: "Swap APT for USDC on DEX",
      createdAt: "2025-02-05T12:00:00Z",
      details: {
        contract: "0x9876...5432",
        function: "swap",
        args: '{"tokenIn": "APT", "tokenOut": "USDC", "amountIn": "10"}',
      },
    },
    {
      id: "template-4",
      name: "Team Payments",
      type: "batch",
      description: "Batch payment to multiple team members",
      createdAt: "2025-02-01T12:00:00Z",
      lastUsed: "2025-03-01T12:00:00Z",
      details: {
        token: "USDC",
        schedule: {
          type: "batch",
          recipients: [
            { address: "0x1111...2222", amount: "500" },
            { address: "0x3333...4444", amount: "750" },
            { address: "0x5555...6666", amount: "1000" },
          ],
        },
      },
    },
    {
      id: "template-5",
      name: "Developer Grant",
      type: "transfer",
      description: "Stream payment to developer",
      createdAt: "2025-01-15T12:00:00Z",
      details: {
        recipient: "0x7777...8888",
        amount: "5000",
        token: "USDT",
        schedule: {
          type: "stream",
          duration: "90days",
          startDate: "2025-04-01T00:00:00Z",
          endDate: "2025-07-01T00:00:00Z",
        },
      },
    },
  ])

  const [searchTerm, setSearchTerm] = useState("")
  const [deleteTemplateId, setDeleteTemplateId] = useState<string | null>(null)
  const [editingTemplate, setEditingTemplate] = useState<TransactionTemplate | null>(null)
  const [isCreating, setIsCreating] = useState(false)
  const [activeTab, setActiveTab] = useState("all")

  // New template form state
  const [newTemplate, setNewTemplate] = useState<Omit<TransactionTemplate, "id" | "createdAt">>({
    name: "",
    type: "transfer",
    description: "",
    details: {
      recipient: "",
      amount: "",
      token: "USDC",
    },
  })

  // Reset editing state when dialog closes
  useEffect(() => {
    if (!open) {
      setTimeout(() => {
        setEditingTemplate(null)
        setIsCreating(false)
        setNewTemplate({
          name: "",
          type: "transfer",
          description: "",
          details: {
            recipient: "",
            amount: "",
            token: "USDC",
          },
        })
      }, 300)
    }
  }, [open])

  const filteredTemplates = templates.filter(
    (template) =>
      (activeTab === "all" ||
        (activeTab === "recurring" && template.details.schedule?.type === "recurring") ||
        (activeTab === "stream" && template.details.schedule?.type === "stream") ||
        (activeTab === "batch" && template.details.schedule?.type === "batch") ||
        (activeTab === "standard" && (!template.details.schedule || template.details.schedule.type === "none"))) &&
      (template.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        template.description.toLowerCase().includes(searchTerm.toLowerCase())),
  )

  const getTemplateIcon = (type: string, scheduleType?: string) => {
    if (scheduleType === "recurring") return <Repeat className="h-4 w-4 text-primary" />
    if (scheduleType === "stream") return <Clock className="h-4 w-4 text-primary" />
    if (scheduleType === "batch" || type === "batch") return <FileText className="h-4 w-4 text-primary" />
    if (type === "transfer") return <Send className="h-4 w-4 text-primary" />
    if (type === "contract") return <Code className="h-4 w-4 text-primary" />
    return <Send className="h-4 w-4 text-primary" />
  }

  const formatDate = (dateString?: string) => {
    if (!dateString) return "Never"
    return new Date(dateString).toLocaleDateString()
  }

  const handleDeleteTemplate = (id: string) => {
    setTemplates(templates.filter((template) => template.id !== id))
    setDeleteTemplateId(null)
  }

  const handleEditTemplate = (template: TransactionTemplate) => {
    setEditingTemplate(template)
  }

  const handleSaveTemplate = () => {
    if (editingTemplate) {
      // Update existing template
      setTemplates(templates.map((t) => (t.id === editingTemplate.id ? editingTemplate : t)))
      setEditingTemplate(null)
    } else if (isCreating) {
      // Create new template
      const newId = `template-${Date.now()}`
      setTemplates([
        ...templates,
        {
          ...newTemplate,
          id: newId,
          createdAt: new Date().toISOString(),
        },
      ])
      setIsCreating(false)
    }
  }

  const handleCreateTemplate = () => {
    setIsCreating(true)
  }

  const updateNewTemplateField = (field: string, value: any) => {
    setNewTemplate({
      ...newTemplate,
      [field]: value,
    })
  }

  const updateNewTemplateDetailField = (field: string, value: any) => {
    setNewTemplate({
      ...newTemplate,
      details: {
        ...newTemplate.details,
        [field]: value,
      },
    })
  }

  const updateEditingTemplateField = (field: string, value: any) => {
    if (editingTemplate) {
      setEditingTemplate({
        ...editingTemplate,
        [field]: value,
      })
    }
  }

  const updateEditingTemplateDetailField = (field: string, value: any) => {
    if (editingTemplate) {
      setEditingTemplate({
        ...editingTemplate,
        details: {
          ...editingTemplate.details,
          [field]: value,
        },
      })
    }
  }

  const renderTemplateForm = (template: any, isEditing: boolean) => {
    const currentTemplate = isEditing ? editingTemplate : newTemplate
    const updateField = isEditing ? updateEditingTemplateField : updateNewTemplateField
    const updateDetailField = isEditing ? updateEditingTemplateDetailField : updateNewTemplateDetailField

    return (
      <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="template-name">Template Name</Label>
          <Input
            id="template-name"
            value={currentTemplate.name}
            onChange={(e) => updateField("name", e.target.value)}
            placeholder="Monthly Payment, Staking, etc."
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="template-description">Description</Label>
          <Textarea
            id="template-description"
            value={currentTemplate.description}
            onChange={(e) => updateField("description", e.target.value)}
            placeholder="Describe the purpose of this template"
            className="resize-none h-20"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="template-type">Transaction Type</Label>
          <Select value={currentTemplate.type} onValueChange={(value) => updateField("type", value)}>
            <SelectTrigger id="template-type">
              <SelectValue placeholder="Select type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="transfer">Transfer</SelectItem>
              <SelectItem value="contract">Contract Call</SelectItem>
              <SelectItem value="batch">Batch Transaction</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {currentTemplate.type === "transfer" && (
          <>
            <div className="space-y-2">
              <Label htmlFor="template-recipient">Recipient Address</Label>
              <Input
                id="template-recipient"
                value={currentTemplate.details.recipient || ""}
                onChange={(e) => updateDetailField("recipient", e.target.value)}
                placeholder="0x..."
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="template-amount">Amount</Label>
                <Input
                  id="template-amount"
                  type="number"
                  value={currentTemplate.details.amount || ""}
                  onChange={(e) => updateDetailField("amount", e.target.value)}
                  placeholder="0.00"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="template-token">Token</Label>
                <Select
                  value={currentTemplate.details.token || "USDC"}
                  onValueChange={(value) => updateDetailField("token", value)}
                >
                  <SelectTrigger id="template-token">
                    <SelectValue placeholder="Select token" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="APT">APT</SelectItem>
                    <SelectItem value="USDC">USDC</SelectItem>
                    <SelectItem value="USDT">USDT</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </>
        )}

        {currentTemplate.type === "contract" && (
          <>
            <div className="space-y-2">
              <Label htmlFor="template-contract">Contract Address</Label>
              <Input
                id="template-contract"
                value={currentTemplate.details.contract || ""}
                onChange={(e) => updateDetailField("contract", e.target.value)}
                placeholder="0x..."
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="template-function">Function Name</Label>
              <Input
                id="template-function"
                value={currentTemplate.details.function || ""}
                onChange={(e) => updateDetailField("function", e.target.value)}
                placeholder="transfer, mint, etc."
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="template-args">Arguments (JSON)</Label>
              <Textarea
                id="template-args"
                value={currentTemplate.details.args || ""}
                onChange={(e) => updateDetailField("args", e.target.value)}
                placeholder='[{"name": "amount", "value": "100"}, {"name": "recipient", "value": "0x..."}]'
                className="resize-none h-20 font-mono text-xs"
              />
            </div>
          </>
        )}

        {currentTemplate.type === "batch" && (
          <div className="space-y-2">
            <Label>Batch Recipients</Label>
            <div className="border rounded-lg p-3 space-y-2">
              <p className="text-xs text-muted-foreground">Configure batch recipients when using this template</p>
              <Button variant="outline" size="sm" className="w-full">
                <Plus className="h-3 w-3 mr-1" /> Add Recipients
              </Button>
            </div>
          </div>
        )}

        <div className="space-y-2">
          <Label htmlFor="schedule-type">Payment Schedule</Label>
          <Select
            value={currentTemplate.details.schedule?.type || "none"}
            onValueChange={(value) => {
              const scheduleType = value as "none" | "recurring" | "stream" | "batch"
              updateDetailField("schedule", {
                ...currentTemplate.details.schedule,
                type: scheduleType,
              })
            }}
          >
            <SelectTrigger id="schedule-type">
              <SelectValue placeholder="Select schedule type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">One-time Payment</SelectItem>
              <SelectItem value="recurring">Recurring Payment</SelectItem>
              <SelectItem value="stream">Stream Payment</SelectItem>
              <SelectItem value="batch">Batch Payment</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {currentTemplate.details.schedule?.type === "recurring" && (
          <>
            <div className="space-y-2">
              <Label htmlFor="schedule-interval">Interval</Label>
              <Select
                value={currentTemplate.details.schedule.interval || "monthly"}
                onValueChange={(value) => {
                  updateDetailField("schedule", {
                    ...currentTemplate.details.schedule,
                    interval: value,
                  })
                }}
              >
                <SelectTrigger id="schedule-interval">
                  <SelectValue placeholder="Select interval" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="daily">Daily</SelectItem>
                  <SelectItem value="weekly">Weekly</SelectItem>
                  <SelectItem value="biweekly">Bi-weekly</SelectItem>
                  <SelectItem value="monthly">Monthly</SelectItem>
                  <SelectItem value="quarterly">Quarterly</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="schedule-start">Start Date</Label>
              <Input
                id="schedule-start"
                type="date"
                value={
                  currentTemplate.details.schedule.startDate
                    ? new Date(currentTemplate.details.schedule.startDate).toISOString().split("T")[0]
                    : ""
                }
                onChange={(e) => {
                  updateDetailField("schedule", {
                    ...currentTemplate.details.schedule,
                    startDate: e.target.value ? new Date(e.target.value).toISOString() : undefined,
                  })
                }}
              />
            </div>
          </>
        )}

        {currentTemplate.details.schedule?.type === "stream" && (
          <>
            <div className="space-y-2">
              <Label htmlFor="stream-duration">Duration</Label>
              <Select
                value={currentTemplate.details.schedule.duration || "30days"}
                onValueChange={(value) => {
                  updateDetailField("schedule", {
                    ...currentTemplate.details.schedule,
                    duration: value,
                  })
                }}
              >
                <SelectTrigger id="stream-duration">
                  <SelectValue placeholder="Select duration" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="7days">7 days</SelectItem>
                  <SelectItem value="14days">14 days</SelectItem>
                  <SelectItem value="30days">30 days</SelectItem>
                  <SelectItem value="60days">60 days</SelectItem>
                  <SelectItem value="90days">90 days</SelectItem>
                  <SelectItem value="180days">180 days</SelectItem>
                  <SelectItem value="365days">365 days</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="stream-start">Start Date</Label>
                <Input
                  id="stream-start"
                  type="date"
                  value={
                    currentTemplate.details.schedule.startDate
                      ? new Date(currentTemplate.details.schedule.startDate).toISOString().split("T")[0]
                      : ""
                  }
                  onChange={(e) => {
                    updateDetailField("schedule", {
                      ...currentTemplate.details.schedule,
                      startDate: e.target.value ? new Date(e.target.value).toISOString() : undefined,
                    })
                  }}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="stream-end">End Date</Label>
                <Input
                  id="stream-end"
                  type="date"
                  value={
                    currentTemplate.details.schedule.endDate
                      ? new Date(currentTemplate.details.schedule.endDate).toISOString().split("T")[0]
                      : ""
                  }
                  onChange={(e) => {
                    updateDetailField("schedule", {
                      ...currentTemplate.details.schedule,
                      endDate: e.target.value ? new Date(e.target.value).toISOString() : undefined,
                    })
                  }}
                />
              </div>
            </div>
          </>
        )}
      </div>
    )
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-[600px]">
          {!editingTemplate && !isCreating ? (
            <>
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
                  <Button
                    className="ml-2 bg-gradient-to-r from-primary to-purple-500 hover:from-primary/90 hover:to-purple-500/90"
                    onClick={handleCreateTemplate}
                  >
                    <Plus className="h-4 w-4 mr-1" /> New Template
                  </Button>
                </div>

                <Tabs defaultValue="all" value={activeTab} onValueChange={setActiveTab} className="w-full">
                  <TabsList className="grid w-full grid-cols-5 p-1 bg-muted/50 rounded-xl">
                    <TabsTrigger
                      value="all"
                      className="rounded-lg text-xs data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
                    >
                      All
                    </TabsTrigger>
                    <TabsTrigger
                      value="standard"
                      className="rounded-lg text-xs data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
                    >
                      Standard
                    </TabsTrigger>
                    <TabsTrigger
                      value="recurring"
                      className="rounded-lg text-xs data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
                    >
                      <Repeat className="h-3 w-3 mr-1" />
                      Recurring
                    </TabsTrigger>
                    <TabsTrigger
                      value="stream"
                      className="rounded-lg text-xs data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
                    >
                      <Clock className="h-3 w-3 mr-1" />
                      Stream
                    </TabsTrigger>
                    <TabsTrigger
                      value="batch"
                      className="rounded-lg text-xs data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
                    >
                      <FileText className="h-3 w-3 mr-1" />
                      Batch
                    </TabsTrigger>
                  </TabsList>
                </Tabs>

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
                              {getTemplateIcon(template.type, template.details.schedule?.type)}
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
                                {template.details.schedule?.type && template.details.schedule.type !== "none" && (
                                  <Badge variant="secondary" className="ml-1 text-xs">
                                    {template.details.schedule.type === "recurring"
                                      ? "Recurring"
                                      : template.details.schedule.type === "stream"
                                        ? "Stream"
                                        : "Batch"}
                                  </Badge>
                                )}
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
                              onClick={() => handleEditTemplate(template)}
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

              <DialogFooter>
                <Button variant="outline" onClick={() => onOpenChange(false)}>
                  Close
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>{isCreating ? "Create Template" : "Edit Template"}</DialogTitle>
                <DialogDescription>
                  {isCreating ? "Create a new transaction template" : "Edit your transaction template"}
                </DialogDescription>
              </DialogHeader>

              {renderTemplateForm(isCreating ? newTemplate : editingTemplate, !isCreating)}

              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => {
                    setEditingTemplate(null)
                    setIsCreating(false)
                  }}
                >
                  Cancel
                </Button>
                <Button onClick={handleSaveTemplate}>{isCreating ? "Create Template" : "Save Changes"}</Button>
              </DialogFooter>
            </>
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
