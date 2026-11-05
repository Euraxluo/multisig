"use client"

import { useEffect, useState } from "react"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { CreateTransactionDialog } from "@/components/create-transaction-dialog"
import { getUserGroups } from "@/lib/onchain-store"
import { useI18n } from "@/components/i18n-provider"

interface GroupProposalEntryDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function GroupProposalEntryDialog({ open, onOpenChange }: GroupProposalEntryDialogProps) {
  const { t } = useI18n()
  const [groups, setGroups] = useState<Array<{ id: string; name: string; orgObjectId?: string; sourceStatus?: string }>>([])
  const [selectedGroupId, setSelectedGroupId] = useState("")
  const [confirmedGroupId, setConfirmedGroupId] = useState("")

  useEffect(() => {
    setSelectedGroupId("")
    setConfirmedGroupId("")
    if (!open) return
    const load = () => {
      const saved = getUserGroups().filter(group => group.id)
      setGroups(saved)
      setSelectedGroupId(current => saved.some(group => group.id === current) ? current : "")
    }
    load()
    window.addEventListener("sui-groups-updated", load)
    window.addEventListener("storage", load)
    const close = () => onOpenChange(false)
    window.addEventListener("sui-account-switched", close)
    return () => {
      window.removeEventListener("sui-groups-updated", load)
      window.removeEventListener("storage", load)
      window.removeEventListener("sui-account-switched", close)
    }
  }, [open, onOpenChange])

  const selectedGroup = groups.find(group => group.id === selectedGroupId)

  return <>
    <Dialog open={open && !confirmedGroupId} onOpenChange={onOpenChange}>
      <DialogContent className="w-[calc(100%-2rem)] max-w-md rounded-xl">
        <DialogHeader>
          <DialogTitle>{t("groups.pickProposalGroupTitle")}</DialogTitle>
          <DialogDescription>{t("groups.pickProposalGroupDesc")}</DialogDescription>
        </DialogHeader>
        {groups.length ? <>
          <Select value={selectedGroupId} onValueChange={setSelectedGroupId}>
            <SelectTrigger aria-label={t("groups.pickProposalGroupTitle")}><SelectValue placeholder={t("groups.pickGroupPlaceholder")} /></SelectTrigger>
            <SelectContent>{groups.map(group => <SelectItem key={group.id} value={group.id}>{group.name || t("groups.unnamedGroup")}{!group.orgObjectId ? t("groups.groupNoOrgSuffix") : group.sourceStatus !== "chain-confirmed" ? t("groups.groupUnverifiedSuffix") : ""}</SelectItem>)}</SelectContent>
          </Select>
          {selectedGroup && <p className="break-all font-mono text-xs text-muted-foreground">{selectedGroup.orgObjectId || t("groups.pollNeedsDkg")}</p>}
          <Button disabled={!selectedGroup?.orgObjectId} onClick={() => { if (selectedGroup?.orgObjectId) setConfirmedGroupId(selectedGroup.id) }}>{t("groups.continueProposal")}</Button>
        </> : <p className="text-sm text-muted-foreground">{t("groups.noOrgsAvailable")}</p>}
      </DialogContent>
    </Dialog>
    {open && confirmedGroupId && <CreateTransactionDialog open onOpenChange={onOpenChange} groupId={confirmedGroupId} />}
  </>
}
