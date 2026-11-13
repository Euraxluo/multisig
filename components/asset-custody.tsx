"use client"

import { useCallback, useEffect, useState } from "react"
import { Landmark, RefreshCw, ShieldCheck, ShieldAlert } from "lucide-react"
import { Transaction } from "@mysten/sui/transactions"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { CUSTODY_KIND, CUSTODY_STATUS } from "multisig/agent-vault/custody"
import {
  buildCreateAssetCustody, buildDepositAsset, buildCreateCustodyProposal, buildSubmitCustodyVote,
  buildRejectCustodyVote, buildExecuteRelease, buildCustodyUpgradeTemplate,
} from "multisig/agent-vault/custody"
import { MIST_PER_SUI, normalizeSuiAddress } from "@mysten/sui/utils"
import { agentVaultClient } from "@/lib/agent-vault-chain"
import { getActiveAccount } from "@/lib/onchain-store"
import { PROPOSAL_PACKAGE_ID } from "@/lib/proposal-chain"
import {
  clearCustodyRecord, discoverCreatedCustody, loadCustodyRecord, saveCustodyRecord,
} from "@/lib/asset-custody-store"
import {
  readCustodyInventory, readCustodyProposalSnapshot, readCustodyVoters, readUpgradeCapObject, verifySlotChild,
  type CustodyVoteMark,
} from "@/lib/asset-custody-chain"
import { useI18n } from "@/components/i18n-provider"

interface AssetCustodyPanelProps {
  /** 组织上链后才可用（托管金库绑定 Organization）。 */
  orgId?: string
  readOnly?: boolean
  /** 由宿主对话框提供：负责签名、执行与回执（群聊交易通道）。 */
  run: (build: () => Transaction, success: string) => Promise<unknown>
  busy?: boolean
}

/** i18n keys for the module-level label maps; resolved with t() at render. */
const KIND_LABEL_KEY: Record<number, string> = { [CUSTODY_KIND.borrow]: "walrus.custodyKindBorrow", [CUSTODY_KIND.release]: "walrus.custodyKindRelease" }
const STATUS_LABEL_KEY: Record<number, string> = {
  [CUSTODY_STATUS.pending]: "walrus.custodyStatusPending", [CUSTODY_STATUS.executed]: "walrus.custodyStatusExecuted", [CUSTODY_STATUS.rejected]: "walrus.custodyStatusRejected",
}
const VOTE_LABEL_KEY: Record<CustodyVoteMark, string> = { 1: "walrus.custodyVoteApprove", 2: "walrus.custodyVoteReject" }

interface ProposalRow {
  id: string
  title: string
  kind: number
  status: number
  typeName: string
  slot: bigint
  /** 提案冻结的具体资产（槽位号复用时不会误伤新存入的对象）。 */
  objectId: string
  /** 提案人：借出只能由提案人本人签发（合约 EBorrowerMismatch）。 */
  proposer: string
  accumulated: bigint
  rejected: bigint
  threshold: bigint
  deadlineMs: bigint
  recipient: string
  voters: Record<string, CustodyVoteMark>
}

const shortId = (value: string) => `${value.slice(0, 8)}…${value.slice(-4)}`

export function AssetCustodyPanel({ orgId, readOnly, run, busy }: AssetCustodyPanelProps) {
  const { t } = useI18n()
  const [custodyId, setCustodyId] = useState("")
  const [inventory, setInventory] = useState<Awaited<ReturnType<typeof readCustodyInventory>> | null>(null)
  const [verified, setVerified] = useState<Record<string, boolean>>({})
  const [snapshotError, setSnapshotError] = useState("")
  const [depositId, setDepositId] = useState("")
  const [depositType, setDepositType] = useState("0x2::package::UpgradeCap")
  const [proposals, setProposals] = useState<ProposalRow[]>([])
  const [proposalIdInput, setProposalIdInput] = useState("")
  const [newKind, setNewKind] = useState<number>(CUSTODY_KIND.borrow)
  const [newSlot, setNewSlot] = useState("0")
  const [newTitle, setNewTitle] = useState("")
  const [newRecipient, setNewRecipient] = useState("")
  const [newActionDigest, setNewActionDigest] = useState("")
  const [newDeadlineHours, setNewDeadlineHours] = useState("72")
  const [voteWeight, setVoteWeight] = useState("1")
  const [dumpJson, setDumpJson] = useState("")
  const [manualId, setManualId] = useState("")
  const [notice, setNotice] = useState("")
  const [error, setError] = useState("")
  const [pending, setPending] = useState(false)
  /** 当前钱包地址：借出只能由提案人本人签发（合约 EBorrowerMismatch），UI 必须提前对齐。 */
  const [accountAddress, setAccountAddress] = useState("")

  useEffect(() => {
    const sync = () => setAccountAddress(getActiveAccount()?.address || "")
    sync()
    const storage = (event: StorageEvent) => { if (!event.key || event.key === "sui_active_account") sync() }
    window.addEventListener("storage", storage)
    window.addEventListener("sui-account-switched", sync)
    return () => { window.removeEventListener("storage", storage); window.removeEventListener("sui-account-switched", sync) }
  }, [])

  /** 地址比对统一走规范化形态（链上回读是 32 字节全地址，钱包是短形态）。 */
  const isProposer = (proposer: string) => Boolean(accountAddress) && normalizeSuiAddress(accountAddress) === normalizeSuiAddress(proposer)

  useEffect(() => {
    if (!orgId) return
    setProposals([])
    const record = loadCustodyRecord(orgId)
    setCustodyId(record?.custodyId ?? "")
  }, [orgId])

  const refreshInventory = useCallback(async () => {
    if (!custodyId) { setInventory(null); setSnapshotError(""); setVerified({}); return }
    try {
      const snapshot = await readCustodyInventory(agentVaultClient as never, custodyId)
      setInventory(snapshot)
      setSnapshotError("")
      // 守恒徽章：逐槽核验资产仍是 custody 的动态子对象
      const checks: Record<string, boolean> = {}
      for (const family of snapshot.families) {
        for (const slot of family.slots) checks[slot.objectId] = await verifySlotChild(agentVaultClient as never, slot.objectId, custodyId)
      }
      setVerified(checks)
    } catch (cause) {
      setInventory(null)
      setSnapshotError(cause instanceof Error ? cause.message : t("walrus.custodyReadInventoryFailed"))
    }
  }, [custodyId])

  useEffect(() => { void refreshInventory() }, [refreshInventory])

  const addProposalRow = async (id: string) => {
    try {
      const snapshot = await readCustodyProposalSnapshot(agentVaultClient as never, id)
      const voters = await readCustodyVoters(agentVaultClient as never, snapshot.votersTableId).catch(() => ({} as Record<string, CustodyVoteMark>))
      const row: ProposalRow = {
        id: snapshot.id, title: snapshot.title, kind: snapshot.kind, status: snapshot.status,
        typeName: snapshot.typeName, slot: snapshot.slot, objectId: snapshot.objectId, proposer: snapshot.proposer,
        accumulated: snapshot.accumulatedWeight,
        rejected: snapshot.rejectedWeight, threshold: snapshot.thresholdWeight,
        deadlineMs: snapshot.deadlineMs, recipient: snapshot.recipient, voters,
      }
      setProposals(rows => [row, ...rows.filter(entry => entry.id !== id)])
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("walrus.custodyReadProposalFailed", { id: shortId(id) }))
    }
  }

  const refreshProposal = async (id: string) => {
    setProposals(rows => rows.filter(row => row.id !== id))
    await addProposalRow(id)
  }

  const handleCreate = async () => {
    if (!orgId) throw new Error(t("walrus.custodyOrgMissing"))
    setPending(true); setError(""); setNotice("")
    try {
      const result = await run(() => buildCreateAssetCustody({ orgId }) as unknown as Transaction, t("walrus.custodyRunCreate")) as { digest?: string }
      if (!result?.digest) throw new Error(t("walrus.custodyNoDigest"))
      const id = await discoverCreatedCustody(agentVaultClient as unknown as Parameters<typeof discoverCreatedCustody>[0], result.digest, PROPOSAL_PACKAGE_ID)
      saveCustodyRecord({ orgId, custodyId: id, createdAtMs: Date.now(), txDigest: result.digest })
      setCustodyId(id)
      setNotice(t("walrus.custodyCreatedNotice", { id: shortId(id) }))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("walrus.custodyCreateFailed"))
    } finally { setPending(false) }
  }

  const handleDeposit = async () => {
    if (!orgId) throw new Error(t("walrus.custodyOrgMissing"))
    const assetId = depositId.trim()
    if (!assetId) throw new Error(t("walrus.custodyAssetIdRequired"))
    setPending(true); setError(""); setNotice("")
    try {
      await run(() => buildDepositAsset({ custodyId, orgId, assetType: depositType.trim(), assetId }) as unknown as Transaction, t("walrus.custodyRunDeposit"))
      setDepositId("")
      setNotice(t("walrus.custodyDepositedNotice"))
      await refreshInventory()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("walrus.custodyDepositFailed"))
    } finally { setPending(false) }
  }

  const handleCreateProposal = async () => {
    if (!orgId) throw new Error(t("walrus.custodyOrgMissing"))
    const deadlineMs = BigInt(Date.now()) + BigInt(Math.round(Number(newDeadlineHours || "0") * 3_600_000))
    setPending(true); setError(""); setNotice("")
    try {
      const base = { custodyId, orgId, assetType: depositType.trim(), slot: BigInt(newSlot || "0"), title: newTitle.trim(), deadlineMs }
      const result = await run(() => buildCreateCustodyProposal({
        ...base, kind: newKind, recipient: newKind === CUSTODY_KIND.release ? newRecipient.trim() : undefined,
        actionDigest: newKind === CUSTODY_KIND.borrow ? newActionDigest.trim() : undefined,
      }) as unknown as Transaction, t("walrus.custodyRunCreateProposal")) as { digest?: string }
      setNewTitle("")
      setNotice(t("walrus.custodyProposalCreatedNotice", { digest: result?.digest ? shortId(result.digest) : t("walrus.custodySubmitted") }))
      if (proposalIdInput.trim()) await refreshProposal(proposalIdInput.trim())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("walrus.custodyCreateProposalFailed"))
    } finally { setPending(false) }
  }

  const handleVote = async (proposalId: string, approve: boolean) => {
    if (!orgId) throw new Error(t("walrus.custodyOrgMissing"))
    setPending(true); setError(""); setNotice("")
    try {
      await run(() => (approve
        ? buildSubmitCustodyVote({ proposalId, orgId, claimedWeight: BigInt(voteWeight || "0") })
        : buildRejectCustodyVote({ proposalId, orgId })) as unknown as Transaction, approve ? t("walrus.custodyRunVoteApprove") : t("walrus.custodyRunVoteReject"))
      await refreshProposal(proposalId)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("walrus.custodyVoteFailed"))
    } finally { setPending(false) }
  }

  const handleExecuteRelease = async (row: ProposalRow) => {
    if (!orgId) throw new Error(t("walrus.custodyOrgMissing"))
    setPending(true); setError(""); setNotice("")
    try {
      await run(() => buildExecuteRelease({ custodyId, proposalId: row.id, orgId, assetType: row.typeName }) as unknown as Transaction, t("walrus.custodyRunExecute"))
      setNotice(t("walrus.custodyReleasedNotice", { recipient: shortId(row.recipient) }))
      await refreshInventory()
      await refreshProposal(row.id)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("walrus.custodyReleaseFailed"))
    } finally { setPending(false) }
  }

  const handleLoadProposal = async () => {
    const id = proposalIdInput.trim()
    if (!id) throw new Error(t("walrus.custodyProposalIdRequired"))
    setError("")
    await refreshProposal(id)
  }

  /** 升级模板：dump JSON（sui move build --dump-bytecode-as-base64）+ 已过门限的 UpgradeCap 借出提案。 */
  const handleUpgradeTemplate = async (row: ProposalRow) => {
    if (!orgId) throw new Error(t("walrus.custodyOrgMissing"))
    if (row.kind !== CUSTODY_KIND.borrow) throw new Error(t("walrus.custodyUpgradeBorrowOnly"))
    if (row.typeName !== "0x2::package::UpgradeCap") throw new Error(t("walrus.custodyUpgradeCapSlotOnly"))
    if (row.accumulated < row.threshold) throw new Error(t("walrus.custodyThresholdNotMet"))
    if (!isProposer(row.proposer)) throw new Error(t("walrus.custodyProposerOnly", { proposer: shortId(row.proposer) }))
    const dump = JSON.parse(dumpJson) as { modules?: unknown; dependencies?: unknown; digest?: unknown }
    if (!Array.isArray(dump.modules) || !Array.isArray(dump.dependencies) || !Array.isArray(dump.digest) || dump.digest.length !== 32) {
      throw new Error(t("walrus.custodyDumpInvalid"))
    }
    const digest32 = Uint8Array.from(dump.digest as number[])
    setPending(true); setError(""); setNotice("")
    try {
      // currentPackageId 从托管中的 cap BCS 推导（不信用户输入）
      const slot = inventory?.families.flatMap(family => family.slots).find(entry => entry.slot === row.slot)
      if (!slot) throw new Error(t("walrus.custodySlotNotFound"))
      const cap = await readUpgradeCapObject(agentVaultClient as never, slot.objectId)
      await run(() => buildCustodyUpgradeTemplate({
        custodyId, proposalId: row.id, orgId,
        modules: dump.modules as string[], dependencies: dump.dependencies as string[], digest32,
        currentPackageId: cap.packageId, gasBudgetMist: MIST_PER_SUI,
      }) as unknown as Transaction, t("walrus.custodyRunUpgrade"))
      setNotice(t("walrus.custodyUpgradeNotice", { packageId: shortId(cap.packageId) }))
      await refreshInventory()
      await refreshProposal(row.id)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("walrus.custodyUpgradeFailed"))
    } finally { setPending(false) }
  }

  const handleManualSave = () => {
    if (!orgId) throw new Error(t("walrus.custodyOrgMissing"))
    const id = manualId.trim()
    if (!id) throw new Error(t("walrus.custodyManualIdRequired"))
    saveCustodyRecord({ orgId, custodyId: id, createdAtMs: Date.now() })
    setCustodyId(id)
    setManualId("")
    setNotice(t("walrus.custodyManualSaved"))
  }

  const disabled = readOnly || busy || pending || !orgId

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="flex items-center gap-1.5 text-sm font-semibold"><Landmark className="h-4 w-4 text-amber-500" />{t("walrus.custodyTitle")}</p>
        {inventory && <Badge variant="secondary" className="text-[10px]">{t("walrus.custodySummary", { families: inventory.families.length, slots: inventory.families.reduce((sum, family) => sum + family.slots.length, 0) })}</Badge>}
      </div>

      {!orgId && <p className="text-xs text-muted-foreground">{t("walrus.custodyNeedOrg")}</p>}

      {!custodyId ? (
        <div className="space-y-2 rounded-xl border p-3">
          <p className="text-xs text-muted-foreground">{t("walrus.custodyIntro")}</p>
          <Button size="sm" className="h-8 text-xs" disabled={disabled} onClick={handleCreate}>{t("walrus.custodyCreate")}</Button>
          {orgId && (
            <div className="flex gap-2">
              <Input value={manualId} onChange={event => setManualId(event.target.value)} placeholder={t("walrus.custodyManualPlaceholder")} className="h-8 text-xs" />
              <Button size="sm" variant="outline" className="h-8 text-xs shrink-0" disabled={readOnly || !manualId.trim()} onClick={handleManualSave}>{t("walrus.custodyBackfill")}</Button>
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <p className="break-all font-mono text-[10px] text-muted-foreground">{custodyId}</p>
            <Button size="sm" variant="ghost" className="h-6 w-6 p-0 shrink-0" onClick={() => void refreshInventory()} aria-label={t("walrus.custodyRefreshAria")}><RefreshCw className="h-3 w-3" /></Button>
            {readOnly !== true && <Button size="sm" variant="ghost" className="h-6 px-2 text-[10px] shrink-0 text-muted-foreground" disabled={busy || pending} onClick={() => { if (orgId) { clearCustodyRecord(orgId); setCustodyId("") } }}>{t("walrus.custodyUnbind")}</Button>}
          </div>
          {snapshotError && <p role="alert" className="text-xs text-destructive">{snapshotError}</p>}

          {/* 资产清单 */}
          <div className="space-y-1.5 rounded-xl border p-3">
            <p className="text-xs font-medium">{t("walrus.custodyInventoryTitle")}</p>
            {inventory?.families.length ? inventory.families.map(family => (
              <div key={family.typeName} className="space-y-1">
                <p className="break-all font-mono text-[10px] text-muted-foreground">{family.typeName}</p>
                {family.slots.map(slot => (
                  <div key={slot.objectId} className="flex items-center justify-between gap-2 text-[11px]">
                    <span className="font-mono">{t("walrus.custodySlotRow", { slot: slot.slot.toString(), objectId: shortId(slot.objectId), depositor: shortId(slot.depositor) })}</span>
                    {verified[slot.objectId]
                      ? <span className="flex items-center gap-0.5 text-emerald-600 dark:text-emerald-400"><ShieldCheck className="h-3 w-3" />{t("walrus.custodyVerified")}</span>
                      : <span className="flex items-center gap-0.5 text-destructive"><ShieldAlert className="h-3 w-3" />{t("walrus.custodyUnverified")}</span>}
                  </div>
                ))}
              </div>
            )) : <p className="text-[10px] text-muted-foreground">{t("walrus.custodyEmpty")}</p>}
          </div>

          {/* 存入表单 */}
          <div className="space-y-2 rounded-xl border p-3">
            <p className="text-xs font-medium">{t("walrus.custodyDepositTitle")}</p>
            <Input value={depositType} onChange={event => setDepositType(event.target.value)} placeholder={t("walrus.custodyTypePlaceholder")} className="h-8 text-xs font-mono" />
            <div className="flex gap-2">
              <Input value={depositId} onChange={event => setDepositId(event.target.value)} placeholder={t("walrus.custodyAssetPlaceholder")} className="h-8 text-xs" />
              <Button size="sm" variant="outline" className="h-8 text-xs shrink-0" disabled={disabled || !depositId.trim()} onClick={handleDeposit}>{t("walrus.custodyDeposit")}</Button>
            </div>
            <p className="text-[10px] text-muted-foreground">{t("walrus.custodyDepositHint")}</p>
          </div>

          {/* 发起提案 */}
          <div className="space-y-2 rounded-xl border p-3">
            <p className="text-xs font-medium">{t("walrus.custodyNewProposalTitle")}</p>
            <div className="flex gap-2">
              <Button size="sm" variant={newKind === CUSTODY_KIND.borrow ? "default" : "outline"} className="h-7 text-[11px]" disabled={disabled} onClick={() => setNewKind(CUSTODY_KIND.borrow)}>{t("walrus.custodyBorrowButton")}</Button>
              <Button size="sm" variant={newKind === CUSTODY_KIND.release ? "default" : "outline"} className="h-7 text-[11px]" disabled={disabled} onClick={() => setNewKind(CUSTODY_KIND.release)}>{t("walrus.custodyReleaseButton")}</Button>
            </div>
            <div className="flex gap-2">
              <Input value={newSlot} onChange={event => setNewSlot(event.target.value)} placeholder={t("walrus.custodySlotPlaceholder")} inputMode="numeric" className="h-8 text-xs w-24" />
              <Input value={newTitle} onChange={event => setNewTitle(event.target.value)} placeholder={t("walrus.custodyTitlePlaceholder")} className="h-8 text-xs" />
            </div>
            <div className="flex gap-2">
              <Input value={newDeadlineHours} onChange={event => setNewDeadlineHours(event.target.value)} placeholder={t("walrus.custodyDeadlinePlaceholder")} inputMode="numeric" className="h-8 text-xs w-28" />
              {newKind === CUSTODY_KIND.release && <Input value={newRecipient} onChange={event => setNewRecipient(event.target.value)} placeholder={t("walrus.custodyRecipientPlaceholder")} className="h-8 text-xs" />}
              {newKind === CUSTODY_KIND.borrow && <Input value={newActionDigest} onChange={event => setNewActionDigest(event.target.value)} placeholder={t("walrus.custodyActionDigestPlaceholder")} className="h-8 text-xs font-mono" />}
            </div>
            <Button size="sm" className="h-8 text-xs" disabled={disabled || !newTitle.trim() || (newKind === CUSTODY_KIND.release && !newRecipient.trim())} onClick={handleCreateProposal}>{t("walrus.custodyCreateProposal")}</Button>
          </div>

          {/* 提案列表：读取 + 投票 + 执行 */}
          <div className="space-y-2 rounded-xl border p-3">
            <p className="text-xs font-medium">{t("walrus.custodyProposalsTitle")}</p>
            <div className="flex gap-2">
              <Input value={proposalIdInput} onChange={event => setProposalIdInput(event.target.value)} placeholder={t("walrus.custodyProposalPlaceholder")} className="h-8 text-xs" />
              <Button size="sm" variant="outline" className="h-8 text-xs shrink-0" disabled={readOnly || !proposalIdInput.trim()} onClick={handleLoadProposal}>{t("walrus.custodyRead")}</Button>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-muted-foreground shrink-0">{t("walrus.custodyRosterWeight")}</span>
              <Input value={voteWeight} onChange={event => setVoteWeight(event.target.value)} inputMode="numeric" className="h-7 text-[11px] w-20" />
            </div>
            {proposals.map(row => (
              <div key={row.id} className="space-y-1.5 rounded-lg border border-border/60 p-2 text-[11px]">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{row.title || shortId(row.id)}</span>
                  <Badge variant={row.status === CUSTODY_STATUS.pending ? "secondary" : "outline"} className="text-[9px]">{t(KIND_LABEL_KEY[row.kind])} · {t(STATUS_LABEL_KEY[row.status])}</Badge>
                </div>
                <p className="font-mono text-[10px] text-muted-foreground break-all">{t("walrus.custodyProposalMeta", { typeName: row.typeName, slot: row.slot.toString(), id: shortId(row.id) })}</p>
                <p className="font-mono text-[10px] text-muted-foreground break-all">{t("walrus.custodyProposalAssets", { objectId: shortId(row.objectId), proposer: shortId(row.proposer) })}</p>
                <p>{t("walrus.custodyVotesPrefix", { approve: row.accumulated.toString(), threshold: row.threshold.toString(), reject: row.rejected.toString() })}{Object.entries(row.voters).map(([voter, mark]) => `${shortId(voter)}:${t(VOTE_LABEL_KEY[mark])}`).join(" ") || t("walrus.custodyNoVotes")}</p>
                {row.status === CUSTODY_STATUS.pending && (
                  <div className="flex flex-wrap gap-1.5">
                    <Button size="sm" className="h-8 px-3 text-xs font-semibold bg-primary hover:bg-primary/90 text-primary-foreground shadow-sm" disabled={disabled} onClick={() => void handleVote(row.id, true)}>{t("walrus.custodyVoteApprove")}</Button>
                    <Button size="sm" variant="outline" className="h-8 px-3 text-xs font-medium text-muted-foreground hover:text-destructive hover:border-destructive/40" disabled={disabled} onClick={() => void handleVote(row.id, false)}>{t("walrus.custodyVoteReject")}</Button>
                    {row.kind === CUSTODY_KIND.release && row.accumulated >= row.threshold && (
                      <Button size="sm" variant="outline" className="h-7 text-[11px]" disabled={disabled} onClick={() => void handleExecuteRelease(row)}>{t("walrus.custodyExecuteRelease", { recipient: shortId(row.recipient) })}</Button>
                    )}
                  </div>
                )}
                {row.kind === CUSTODY_KIND.borrow && row.typeName === "0x2::package::UpgradeCap" && row.accumulated >= row.threshold && row.status === CUSTODY_STATUS.pending && (
                  <div className="space-y-1.5 rounded-md border border-dashed p-2">
                    <p className="text-[10px] font-medium">{t("walrus.custodyUpgradeTitle")}</p>
                    {isProposer(row.proposer) ? (
                      <>
                        <Input value={dumpJson} onChange={event => setDumpJson(event.target.value)} placeholder={t("walrus.custodyDumpPlaceholder")} className="h-8 text-[10px]" />
                        <Button size="sm" className="h-7 text-[11px]" disabled={disabled || !dumpJson.trim()} onClick={() => void handleUpgradeTemplate(row)}>{t("walrus.custodyExecuteUpgrade")}</Button>
                        <p className="text-[10px] text-muted-foreground">{t("walrus.custodyUpgradeHint")}</p>
                      </>
                    ) : (
                      <p className="text-[10px] text-muted-foreground">{t("walrus.custodyProposerSwitch", { proposer: shortId(row.proposer) })}</p>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {notice && <p className="text-xs text-emerald-600 dark:text-emerald-400">{notice}</p>}
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </div>
  )
}
