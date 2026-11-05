"use client"

import { useCallback, useEffect, useState } from "react"
import { Sprout, RefreshCw } from "lucide-react"
import { Transaction } from "@mysten/sui/transactions"
import { MIST_PER_SUI } from "@mysten/sui/utils"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import {
  buildCreateScallopAdapter, buildFeedHarvestedYieldToChat, buildRecordPrincipalRedemption,
  readScallopAdapter,
} from "multisig/agent-vault"
import { agentVaultClient } from "@/lib/agent-vault-chain"
import { PROPOSAL_PACKAGE_ID } from "@/lib/proposal-chain"
import { suiMist } from "@/lib/group-chat"
import { clearAdapterRecord, discoverCreatedAdapter, loadAdapterRecord, saveAdapterRecord } from "@/lib/scallop-adapter-store"
import { useI18n } from "@/components/i18n-provider"

interface ScallopYieldPanelProps {
  /** 频道上链后才可用；本地群（未建频道）禁用全部操作。 */
  channelId?: string
  readOnly?: boolean
  /** 由宿主对话框提供：负责签名、执行与回执（群聊交易通道）。 */
  run: (build: () => Transaction, success: string) => Promise<unknown>
  busy?: boolean
}

const mistToSui = (value: bigint) => `${(Number(value) / Number(MIST_PER_SUI)).toFixed(4)} SUI`

export function ScallopYieldPanel({ channelId, readOnly, run, busy }: ScallopYieldPanelProps) {
  const { t } = useI18n()
  const [adapterId, setAdapterId] = useState("")
  const [snapshot, setSnapshot] = useState<Awaited<ReturnType<typeof readScallopAdapter>> | null>(null)
  const [snapshotError, setSnapshotError] = useState("")
  const [feedAmount, setFeedAmount] = useState("")
  const [redeemAmount, setRedeemAmount] = useState("")
  const [redeemRecipient, setRedeemRecipient] = useState("")
  const [notice, setNotice] = useState("")
  const [error, setError] = useState("")
  const [manualId, setManualId] = useState("")
  const [pending, setPending] = useState(false)

  useEffect(() => {
    if (!channelId) return
    const record = loadAdapterRecord(channelId)
    setAdapterId(record?.adapterId ?? "")
  }, [channelId])

  const refreshSnapshot = useCallback(async () => {
    if (!adapterId) { setSnapshot(null); setSnapshotError(""); return }
    try {
      const snap = await readScallopAdapter(agentVaultClient as never, { packageId: PROPOSAL_PACKAGE_ID, adapterId })
      setSnapshot(snap)
      setSnapshotError("")
    } catch (cause) {
      setSnapshot(null)
      setSnapshotError(cause instanceof Error ? cause.message : t("walrus.scallopReadFailed"))
    }
  }, [adapterId, t])

  useEffect(() => { void refreshSnapshot() }, [refreshSnapshot])

  const handleCreate = async () => {
    if (!channelId) throw new Error(t("walrus.scallopChannelMissing"))
    setPending(true); setError(""); setNotice("")
    try {
      const result = await run(() => buildCreateScallopAdapter({ channelId }) as unknown as Transaction, t("walrus.scallopRunCreate")) as { digest?: string }
      if (!result?.digest) throw new Error(t("walrus.scallopNoDigest"))
      const id = await discoverCreatedAdapter(agentVaultClient as unknown as Parameters<typeof discoverCreatedAdapter>[0], result.digest, PROPOSAL_PACKAGE_ID)
      saveAdapterRecord({ channelId, adapterId: id, createdAtMs: Date.now(), txDigest: result.digest })
      setAdapterId(id)
      setNotice(t("walrus.scallopCreatedNotice", { id: `${id.slice(0, 10)}…` }))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("walrus.scallopCreateFailed"))
    } finally { setPending(false) }
  }

  const handleFeed = async () => {
    if (!channelId) throw new Error(t("walrus.scallopChannelMissing"))
    const amount = suiMist(feedAmount)
    setPending(true); setError(""); setNotice("")
    try {
      const tx = new Transaction()
      const coin = tx.coin({ balance: amount })
      // SDK 自建 moveCall 挂到前端 PTB 上：跨 @mysten/sui 版本以 never 传参（线格式一致）
      buildFeedHarvestedYieldToChat({ adapterId, channelId, yieldCoin: coin as never, transaction: tx as never })
      await run(() => tx, t("walrus.scallopRunFeed"))
      setNotice(t("walrus.scallopFedNotice"))
      setFeedAmount("")
      await refreshSnapshot()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("walrus.scallopFeedFailed"))
    } finally { setPending(false) }
  }

  const handleRedeem = async () => {
    const amount = suiMist(redeemAmount)
    const recipient = redeemRecipient.trim()
    if (!recipient) throw new Error(t("walrus.scallopRecipientRequired"))
    setPending(true); setError(""); setNotice("")
    try {
      await run(() => buildRecordPrincipalRedemption({ adapterId, suiReturned: amount, recipient }) as unknown as Transaction, t("walrus.scallopRunRedeem"))
      setNotice(t("walrus.scallopRedeemNotice"))
      setRedeemAmount("")
      await refreshSnapshot()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("walrus.scallopRedeemFailed"))
    } finally { setPending(false) }
  }

  const handleManualSave = () => {
    if (!channelId) throw new Error(t("walrus.scallopChannelMissing"))
    const id = manualId.trim()
    if (!id) throw new Error(t("walrus.scallopAdapterIdRequired"))
    saveAdapterRecord({ channelId, adapterId: id, createdAtMs: Date.now() })
    setAdapterId(id)
    setManualId("")
    setNotice(t("walrus.scallopManualSaved"))
  }

  const disabled = readOnly || busy || pending || !channelId

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="flex items-center gap-1.5 text-sm font-semibold"><Sprout className="h-4 w-4 text-emerald-500" />{t("walrus.scallopTitle")}</p>
        {snapshot && <Badge variant="secondary" className="text-[10px]">{t("walrus.scallopSummary", { principal: mistToSui(snapshot.totalStakedSuiPrincipal), harvested: mistToSui(snapshot.totalHarvestedYieldSui) })}</Badge>}
      </div>

      {!channelId && <p className="text-xs text-muted-foreground">{t("walrus.scallopNeedChannel")}</p>}

      {!adapterId ? (
        <div className="space-y-2 rounded-xl border p-3">
          <p className="text-xs text-muted-foreground">{t("walrus.scallopIntro")}</p>
          <Button size="sm" className="h-8 text-xs" disabled={disabled} onClick={handleCreate}>{t("walrus.scallopCreate")}</Button>
          {channelId && (
            <div className="flex gap-2">
              <Input value={manualId} onChange={event => setManualId(event.target.value)} placeholder={t("walrus.scallopManualPlaceholder")} className="h-8 text-xs" />
              <Button size="sm" variant="outline" className="h-8 text-xs shrink-0" disabled={readOnly || !manualId.trim()} onClick={handleManualSave}>{t("walrus.scallopBackfill")}</Button>
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <p className="break-all font-mono text-[10px] text-muted-foreground">{adapterId}</p>
            <Button size="sm" variant="ghost" className="h-6 w-6 p-0 shrink-0" onClick={() => void refreshSnapshot()} aria-label={t("walrus.scallopRefreshAria")}><RefreshCw className="h-3 w-3" /></Button>
            {readOnly !== true && <Button size="sm" variant="ghost" className="h-6 px-2 text-[10px] shrink-0 text-muted-foreground" disabled={busy || pending} onClick={() => { if (channelId) { clearAdapterRecord(channelId); setAdapterId("") } }}>{t("walrus.scallopUnbind")}</Button>}
          </div>
          {snapshotError && <p role="alert" className="text-xs text-destructive">{snapshotError}</p>}
          {snapshot && <p className="text-xs text-muted-foreground">{t("walrus.scallopSnapshotMeta", { shares: snapshot.ssuiBalance.toString(), yield: mistToSui(snapshot.totalHarvestedYieldSui), admin: snapshot.admin.slice(0, 10) })}</p>}

          <div className="space-y-2 rounded-xl border p-3">
            <p className="text-xs font-medium">{t("walrus.scallopFeedTitle")}</p>
            <div className="flex gap-2">
              <Input value={feedAmount} onChange={event => setFeedAmount(event.target.value)} placeholder={t("walrus.scallopAmountPlaceholder")} inputMode="decimal" className="h-8 text-xs" />
              <Button size="sm" className="h-8 text-xs shrink-0" disabled={disabled || !feedAmount} onClick={handleFeed}>{t("walrus.scallopFeed")}</Button>
            </div>
            <p className="text-[10px] text-muted-foreground">{t("walrus.scallopFeedHint")}</p>
          </div>

          <div className="space-y-2 rounded-xl border p-3">
            <p className="text-xs font-medium">{t("walrus.scallopRedeemTitle")}</p>
            <div className="flex gap-2">
              <Input value={redeemAmount} onChange={event => setRedeemAmount(event.target.value)} placeholder={t("walrus.scallopAmountPlaceholder")} inputMode="decimal" className="h-8 text-xs" />
              <Input value={redeemRecipient} onChange={event => setRedeemRecipient(event.target.value)} placeholder={t("walrus.scallopRecipientPlaceholder")} className="h-8 text-xs" />
              <Button size="sm" variant="outline" className="h-8 text-xs shrink-0" disabled={disabled || !redeemAmount || !redeemRecipient.trim()} onClick={handleRedeem}>{t("walrus.scallopRecord")}</Button>
            </div>
            <p className="text-[10px] text-muted-foreground">{t("walrus.scallopRedeemHint")}</p>
          </div>

          <div className="space-y-1 rounded-xl border border-dashed p-3 opacity-70">
            <p className="text-xs font-medium">{t("walrus.scallopStakeTitle")}</p>
            <p className="text-[10px] text-muted-foreground">{t("walrus.scallopStakeHint")}</p>
          </div>
        </div>
      )}

      {notice && <p className="text-xs text-emerald-600 dark:text-emerald-400">{notice}</p>}
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </div>
  )
}
