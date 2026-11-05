"use client"

// Configuration surface for the Sui Stack Messaging transport. The encrypted
// conversation itself is rendered by the group chat tab in the same message
// list and composer as the on-chain channel — this panel only configures the
// transport and manages this group's encrypted groups.
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Loader2, RefreshCw } from "lucide-react"
import type { SsmChatController } from "@/lib/use-ssm-chat"
import { useI18n } from "@/components/i18n-provider"

const time = (value: number) => new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })

export function SsmSettingsPanel({ controller }: { controller: SsmChatController }) {
  const { t } = useI18n()
  const s = controller
  const statusLabel = !s.status.configured
    ? t("walrus.ssmStatusNone")
    : s.status.relayerSource === "local" ? t("walrus.ssmStatusLocal") : t("walrus.ssmStatusEnv")

  return (
    <div className="rounded-xl border border-border/60 bg-card p-3 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] font-medium">{t("walrus.ssmTitle")}</p>
        <span className={`text-[10px] ${s.status.configured ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600"}`}>{statusLabel}</span>
      </div>
      <p className="text-[10px] leading-relaxed text-muted-foreground">
        {t("walrus.ssmIntroLead")}<span className="font-mono">@mysten/sui-stack-messaging</span>{t("walrus.ssmIntroMid")}<strong>{t("walrus.ssmIntroOffchain")}</strong>{t("walrus.ssmIntroTail")}
      </p>

      <div className="space-y-1.5">
        <label className="text-[10px] text-muted-foreground" htmlFor="ssm-relayer">{t("walrus.ssmRelayerLabel")}</label>
        <div className="flex gap-1.5">
          <Input id="ssm-relayer" value={s.relayerDraft} onChange={event => s.setRelayerDraft(event.target.value)} placeholder="https://relayer.example.com" className="h-8 flex-1 text-xs font-mono" />
          <Button size="sm" variant="outline" className="h-8 text-[11px]" onClick={() => s.applyRelayer(s.relayerDraft)}>{t("walrus.ssmSave")}</Button>
          <Button size="sm" variant="outline" className="h-8 text-[11px]" disabled={!s.status.configured || s.probing} onClick={() => void s.checkRelayer()}>
            {s.probing ? <Loader2 className="h-3 w-3 animate-spin" /> : t("walrus.ssmCheck")}
          </Button>
        </div>
        <p className="text-[10px] text-muted-foreground">
          {t("walrus.ssmRelayerHintA")}<span className="font-mono">/health_check</span>{t("walrus.ssmRelayerHintB")}
        </p>
        {s.probe && <p role="status" className={`rounded-md border p-2 text-[10px] ${s.probe.ok ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"}`}>{s.probe.ok ? t("walrus.ssmProbeOk", { detail: s.probe.detail }) : s.probe.detail}</p>}
      </div>

      {s.groupError && <p role="alert" className="text-[11px] text-amber-600">{s.groupError}</p>}
      {s.notice && <p role="status" className="text-[11px] text-emerald-600 dark:text-emerald-400">{s.notice}</p>}

      {!s.activeGroup ? <div className="space-y-1.5 rounded-lg border border-border/50 bg-muted/30 p-2.5">
        <p className="text-[11px] font-medium">{t("walrus.ssmCreateGroupTitle")}</p>
        <p className="text-[10px] text-muted-foreground">{t("walrus.ssmCreateHintA")}<span className="font-mono">PermissionedGroup&lt;Messaging&gt;</span>{t("walrus.ssmCreateHintMid")}<span className="font-mono">EncryptionHistory</span>{t("walrus.ssmCreateHintB", { max: s.maxGroups })}</p>
        <div className="flex gap-1.5">
          <Input value={s.groupName} onChange={event => s.setGroupName(event.target.value)} placeholder={t("walrus.ssmGroupNamePlaceholder")} disabled={s.readOnly || s.creating} className="h-8 flex-1 text-xs" />
          <Button size="sm" className="h-8 text-[11px]" disabled={s.readOnly || s.creating || !s.groupName.trim() || !s.status.configured} onClick={() => void s.createGroup()}>
            {s.creating ? <Loader2 className="h-3 w-3 animate-spin" /> : t("walrus.ssmCreate")}
          </Button>
        </div>
        {!s.status.configured && <p className="text-[10px] text-amber-600">{t("walrus.ssmNeedRelayerFirst")}</p>}
      </div> : <>
        {s.groups.length > 1 && <div className="space-y-1">
          <label className="text-[10px] text-muted-foreground" htmlFor="ssm-active-group">{t("walrus.ssmGroupsLabel", { count: s.groups.length, max: s.maxGroups })}</label>
          <select
            id="ssm-active-group"
            value={s.activeGroup.groupId}
            onChange={event => s.setActiveGroupId(event.target.value)}
            className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
          >
            {s.groups.map(group => <option key={group.groupId} value={group.groupId}>{group.name} · {group.groupId.slice(0, 10)}…</option>)}
          </select>
        </div>}
        <div className="space-y-1 rounded-lg border border-border/50 bg-muted/30 p-2.5">
          <p className="break-all font-mono text-[10px] text-muted-foreground">groupId {s.activeGroup.groupId}</p>
          <p className="break-all font-mono text-[10px] text-muted-foreground">uuid {s.activeGroup.uuid}</p>
          <p className="text-[10px] text-muted-foreground">{t("walrus.ssmActiveHintA")}<span className="font-mono">groupsMetadata</span>{t("walrus.ssmActiveHintB", { time: time(s.activeGroup.createdAt) })}</p>
          <div className="flex gap-1.5 pt-1">
            <Input value={s.invitee} onChange={event => s.setInvitee(event.target.value)} placeholder={t("walrus.ssmInviteePlaceholder")} disabled={s.readOnly || s.inviting} className="h-8 flex-1 text-xs font-mono" aria-label={t("walrus.ssmInviteeAria")} />
            <Button size="sm" variant="outline" className="h-8 text-[11px]" disabled={s.readOnly || s.inviting || !s.invitee.trim()} onClick={() => void s.invite()}>
              {s.inviting ? <Loader2 className="h-3 w-3 animate-spin" /> : t("walrus.ssmGrantRead")}
            </Button>
          </div>
          <p className="text-[10px] text-muted-foreground">{t("walrus.ssmGrantHint")}</p>
        </div>
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
            {s.subscribed ? <><Loader2 className="h-3 w-3 animate-spin" />{t("walrus.ssmPolling")}</> : <><RefreshCw className="h-3 w-3" />{t("walrus.ssmNotSubscribed")}</>}
          </span>
          <Button size="sm" variant="ghost" className="h-6 px-2 text-[10px]" disabled={s.loadingRows} onClick={() => void s.load()}>{t("walrus.ssmReload")}</Button>
        </div>
      </>}
    </div>
  )
}
