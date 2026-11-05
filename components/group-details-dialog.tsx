"use client"

import { Dialog, DialogContent } from "@/components/ui/dialog"
import { GroupDetailsView } from "@/components/group-details-view"

export interface GroupDetailsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  groupId: string
  readOnly?: boolean
}

export function GroupDetailsDialog({ open, onOpenChange, groupId, readOnly = false }: GroupDetailsDialogProps) {
  if (!open || !groupId) return null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[95vw] max-w-2xl p-0 gap-0 overflow-hidden rounded-2xl max-h-[90vh] flex flex-col border border-border bg-card shadow-2xl">
        <GroupDetailsView
          groupId={groupId}
          readOnly={readOnly}
          isDialog={true}
          onClose={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  )
}
