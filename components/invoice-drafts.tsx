"use client"

import { useEffect, useState } from "react"
import { FileText, Pencil, Receipt, Trash } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { InvoiceGeneratorDialog } from "@/components/invoice-generator-dialog"
import { INVOICES_UPDATED_EVENT, readInvoices, removeInvoice, type StoredInvoice } from "@/lib/invoice-records"
import { useI18n } from "@/components/i18n-provider"

// Local invoice drafts saved in this browser. Nothing here proves the invoice
// was delivered or paid; payment status is not tracked.
export function InvoiceDrafts() {
  const { t } = useI18n()
  const [invoices, setInvoices] = useState<StoredInvoice[]>([])
  const [storageError, setStorageError] = useState("")
  const [reopened, setReopened] = useState<StoredInvoice | undefined>(undefined)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState("")

  useEffect(() => {
    const load = () => {
      try {
        setInvoices(readInvoices())
        setStorageError("")
      } catch {
        setInvoices([])
        setStorageError(t("payments.invErrStorageRead"))
      }
    }
    load()
    window.addEventListener(INVOICES_UPDATED_EVENT, load)
    window.addEventListener("storage", load)
    window.addEventListener("sui-account-switched", load)
    return () => {
      window.removeEventListener(INVOICES_UPDATED_EVENT, load)
      window.removeEventListener("storage", load)
      window.removeEventListener("sui-account-switched", load)
    }
  }, [])

  const open = (invoice?: StoredInvoice) => {
    setReopened(invoice)
    setDialogOpen(true)
  }

  const remove = (invoiceNumber: string) => {
    if (confirmingDelete !== invoiceNumber) {
      setConfirmingDelete(invoiceNumber)
      return
    }
    try {
      setInvoices(removeInvoice(invoiceNumber))
      setStorageError("")
    } catch {
      setStorageError(t("payments.invErrDeleteFailed"))
    } finally {
      setConfirmingDelete("")
    }
  }

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold">{t("payments.invDraftsTitle")}</h3>
          <p className="text-xs text-muted-foreground">{t("payments.invDraftsNote")}</p>
        </div>
        <Button variant="outline" size="sm" className="rounded-lg" onClick={() => open()}>
          <Receipt className="mr-1 h-3.5 w-3.5" />{t("payments.invNewInvoice")}
        </Button>
      </div>

      {storageError && <p role="alert" className="text-xs text-destructive">{storageError}</p>}

      {invoices.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-border/60 p-6 text-center text-sm text-muted-foreground bg-muted/20">
          {t("payments.invDraftsEmpty")}
        </p>
      ) : (
        <div className="space-y-2.5">
          {invoices.map((invoice) => (
            <Card key={invoice.invoiceNumber} className="rounded-2xl border border-border/60 bg-surface-card hover:border-primary/40 hover:shadow-sm transition-all shadow-sm">
              <CardContent className="flex items-center gap-3 p-3.5">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                  <FileText className="h-4 w-4" />
                </div>
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  onClick={() => open(invoice)}
                >
                  <p className="truncate text-sm font-semibold text-label-primary">#{invoice.invoiceNumber}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {invoice.recipient || t("payments.invNoRecipient")}
                    {invoice.dueDate ? t("payments.invDueSuffix", { date: new Date(invoice.dueDate).toLocaleDateString() }) : ""}
                  </p>
                </button>
                <div className="shrink-0 text-right">
                  <p className="text-sm font-semibold text-label-primary">{invoice.total} {invoice.token}</p>
                  <Badge variant="outline" className="mt-1 text-[10px] rounded-full">{invoice.paymentUri ? t("payments.invBadgeDraft") : t("payments.invBadgeNoLink")}</Badge>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button variant="ghost" size="icon" className="h-8 w-8 rounded-full active:scale-95 touch-target-expand" aria-label={t("payments.invEditLabel", { number: invoice.invoiceNumber })} onClick={() => open(invoice)}>
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant={confirmingDelete === invoice.invoiceNumber ? "destructive" : "ghost"}
                    size="icon"
                    className="h-8 w-8 rounded-full active:scale-95 touch-target-expand"
                    aria-label={confirmingDelete === invoice.invoiceNumber ? t("payments.invConfirmDeleteLabel", { number: invoice.invoiceNumber }) : t("payments.invDeleteLabel", { number: invoice.invoiceNumber })}
                    onClick={() => remove(invoice.invoiceNumber)}
                  >
                    <Trash className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <InvoiceGeneratorDialog
        open={dialogOpen}
        onOpenChange={(value) => {
          setDialogOpen(value)
          if (!value) setReopened(undefined)
        }}
        initialInvoice={reopened}
      />
    </section>
  )
}
