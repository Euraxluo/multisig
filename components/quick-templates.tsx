"use client"

import { useState, useCallback, useEffect } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Send, Code, FileText, Clock, Plus, ChevronRight } from "lucide-react"
import { motion } from "framer-motion"
import { TemplateManagerDialog, type TransactionTemplate } from "./template-manager-dialog"
import { CreateTransactionDialog } from "./create-transaction-dialog"
import { PaymentDialog } from "./payment-dialog"
import { getPaymentTemplates } from "@/lib/local-records"
import { paymentAssetByCoinType, paymentAssetBySymbol, SUI_COIN_TYPE } from "@/lib/payment-assets"
import { calculateBatchTotal } from "@/lib/transaction-templates"
import { useI18n } from "@/components/i18n-provider"

interface QuickTemplatesProps {
  groupId?: string
}

const DEFAULT_TEMPLATES: TransactionTemplate[] = []

/** Resolve a template's token to a canonical coin type, or `null` when it cannot be verified. */
function templateCoinType(template: TransactionTemplate): string | null {
  const token = template.token?.trim()
  if (!token) return SUI_COIN_TYPE
  if (token.includes("::")) return paymentAssetByCoinType(token)?.coinType ?? null
  return paymentAssetBySymbol(token)?.coinType ?? null
}

export function QuickTemplates({ groupId }: QuickTemplatesProps) {
  const { t } = useI18n()
  const [isTemplateManagerOpen, setIsTemplateManagerOpen] = useState(false)
  const [isCreateTransactionOpen, setIsCreateTransactionOpen] = useState(false)
  const [isPaymentOpen, setIsPaymentOpen] = useState(false)
  const [selectedTemplate, setSelectedTemplate] = useState<TransactionTemplate | null>(null)
  const [templateError, setTemplateError] = useState("")
  const [templates, setTemplates] = useState(DEFAULT_TEMPLATES)

  useEffect(() => {
    const load = () => setTemplates(getPaymentTemplates())
    load()
    window.addEventListener("sui-templates-updated", load)
    window.addEventListener("storage", load)
    return () => {
      window.removeEventListener("sui-templates-updated", load)
      window.removeEventListener("storage", load)
    }
  }, [])

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

  const applyTemplate = useCallback(
    (template: TransactionTemplate) => {
      setTemplateError("")
      if (template.type === "batch") {
        if (groupId) {
          setTemplateError(t("vault.qtBatchProposalUnsupported"))
          return
        }
        if (!template.batchItems || template.batchItems.length === 0) {
          setTemplateError(t("vault.qtBatchEmptyItems"))
          return
        }
        setSelectedTemplate(template)
        setIsPaymentOpen(true)
        return
      }
      if (template.type !== "transfer") {
        setTemplateError(template.type === "contract" ? t("vault.qtContractUnsupported") : t("vault.qtUnknownType", { type: template.type }))
        return
      }
      const coinType = templateCoinType(template)
      if (!coinType) {
        setTemplateError(t("vault.qtUnknownToken", { token: template.token ?? "" }))
        return
      }
      setSelectedTemplate(template)
      // Group proposals must go through the proposal wizard so the treasury and
      // organisation are confirmed; personal transfers use the direct payment dialog.
      if (groupId) setIsCreateTransactionOpen(true)
      else setIsPaymentOpen(true)
    },
    [groupId, t],
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

  const selectedCoinType = selectedTemplate ? templateCoinType(selectedTemplate) : null

  return (
    <>
      <div className="mb-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-lg font-semibold">{groupId ? t("vault.qtGroupTitle") : t("vault.qtPersonalTitle")}</h3>
          <Button
            variant="ghost"
            size="sm"
            className="text-xs flex items-center"
            onClick={() => setIsTemplateManagerOpen(true)}
          >
            {t("vault.qtManage")} <ChevronRight className="h-3 w-3 ml-1" />
          </Button>
        </div>

        <p className="mb-3 text-xs text-muted-foreground">{t("vault.qtStoragePrefix")}{groupId ? t("vault.qtConfirmGroup") : t("vault.qtConfirmPersonal")}{t("vault.qtStorageSuffix")}</p>
        {templateError && <p role="alert" className="mb-3 text-xs text-destructive">{templateError}</p>}
        <motion.div className="grid gap-2" variants={container} initial="hidden" animate="show">
          {templates.map((template) => (
            <motion.div key={template.id} variants={item}>
              <Card
                className="cursor-pointer hover:shadow-md transition-all duration-200 border-none shadow-sm"
                onClick={() => applyTemplate(template)}
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
                        <p className="text-[10px] text-muted-foreground">{template.sourceStatus === "unverified" ? t("vault.tmHistoryBadge") : t("vault.tmLocalBadge")}</p>
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
              {t("vault.qtNewLocalTemplate")}
            </Button>
          </motion.div>
        </motion.div>
      </div>

      <TemplateManagerDialog open={isTemplateManagerOpen} onOpenChange={setIsTemplateManagerOpen} />

      {groupId ? (
        <CreateTransactionDialog
          open={isCreateTransactionOpen}
          onOpenChange={setIsCreateTransactionOpen}
          groupId={groupId}
          initialTemplate={selectedTemplate || undefined}
        />
      ) : (
        <PaymentDialog
          open={isPaymentOpen}
          onOpenChange={setIsPaymentOpen}
          title={selectedTemplate ? t("vault.qtPaymentDialogTitle", { kind: selectedTemplate.type === "batch" ? t("vault.typeBatch") : t("vault.qtPersonalTransfer"), name: selectedTemplate.name }) : t("vault.qtPersonalTransfer")}
          amount={selectedTemplate?.type === "batch" ? calculateBatchTotal(selectedTemplate.batchItems) : selectedTemplate?.amount}
          recipientAddress={selectedTemplate?.recipient}
          initialCoinType={selectedCoinType || undefined}
          batchItems={selectedTemplate?.type === "batch" ? selectedTemplate.batchItems : undefined}
        />
      )}
    </>
  )
}
