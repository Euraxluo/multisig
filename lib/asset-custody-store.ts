"use client"

import { t } from "./i18n/t"

/**
 * 资产托管金库的本地记录（`sui_asset_custody` in localStorage）。
 *
 * 链上没有组织 → 托管金库的反查索引（AssetCustody 是 shared 对象），前端在
 * 创建后把 custody ID 按 orgId 记在本地；换设备缺记录时可手工粘贴 ID 补录。
 * 链上状态永远以 reader 快照为准，本地记录只是入口便利。
 */
const KEY = "sui_asset_custody"

export interface AssetCustodyRecord {
  orgId: string
  custodyId: string
  createdAtMs: number
  txDigest?: string
}

function readAll(): Record<string, AssetCustodyRecord> {
  try {
    const raw = window.localStorage.getItem(KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
    return parsed as Record<string, AssetCustodyRecord>
  } catch {
    return {}
  }
}

function writeAll(records: Record<string, AssetCustodyRecord>): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(records))
  } catch {
    /* 私密模式/配额下静默失败：本地记录只是便利，不阻塞链上操作 */
  }
}

export function loadCustodyRecord(orgId: string): AssetCustodyRecord | null {
  const record = readAll()[orgId]
  if (!record || typeof record.custodyId !== "string" || !record.custodyId) return null
  return record
}

export function saveCustodyRecord(record: AssetCustodyRecord): void {
  if (!record.orgId || !record.custodyId) throw new Error(t("walrus.custodyRecordRequired"))
  const all = readAll()
  if (all[record.orgId]?.custodyId === record.custodyId) return
  all[record.orgId] = record
  writeAll(all)
}

export function clearCustodyRecord(orgId: string): void {
  const all = readAll()
  if (!all[orgId]) return
  delete all[orgId]
  writeAll(all)
}

/**
 * 从创建交易的 effects 里发现新 shared 托管金库。
 *
 * gRPC effects 没有 created 数组：新建对象在 `changedObjects[]`，以
 * `idOperation === "Created"` 且 `outputOwner.$kind === "Shared"` 识别，
 * 再按类型 `…::asset_custody::AssetCustody` 验证兜底。
 */
interface ChangedObjectEntry {
  objectId: string
  idOperation?: string
  outputOwner?: { $kind?: string }
}

export interface CustodyDiscoveryClient {
  getTransaction(input: { digest: string; include?: { effects?: boolean } }): Promise<{
    effects?: { changedObjects?: ChangedObjectEntry[] }
    Transaction?: { effects?: { changedObjects?: ChangedObjectEntry[] } }
  }>
  getObject(input: { objectId: string }): Promise<{ object?: { type?: string; objectType?: string } }>
}

export async function discoverCreatedCustody(
  client: CustodyDiscoveryClient,
  digest: string,
  packageId: string,
  attempts = 10,
): Promise<string> {
  for (let i = 0; i < attempts; i++) {
    try {
      const tx = await client.getTransaction({ digest, include: { effects: true } })
      const changed: ChangedObjectEntry[] = tx?.effects?.changedObjects ?? tx?.Transaction?.effects?.changedObjects ?? []
      for (const entry of changed) {
        if (entry?.idOperation !== "Created" || entry?.outputOwner?.$kind !== "Shared") continue
        const object = await client.getObject({ objectId: entry.objectId }).catch(() => null)
        const type = String(object?.object?.type ?? object?.object?.objectType ?? "")
        if (type.startsWith(`${packageId}::asset_custody::AssetCustody`)) return entry.objectId
      }
    } catch {
      /* 索引未就绪，重试 */
    }
    await new Promise(resolve => setTimeout(resolve, 3000))
  }
  throw new Error(t("walrus.custodyDiscoveryFailed"))
}
