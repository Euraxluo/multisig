"use client"

import { t } from "./i18n/t"

/**
 * Scallop 生息适配器的本地记录（`sui_scallop_adapters` in localStorage）。
 *
 * 链上没有频道 → 适配器的反查索引：`create_scallop_adapter` 不发事件、适配器
 * 是 shared 对象（无 owner 列表），因此前端在创建后把 adapter ID 按频道记在
 * 本地。旧版本或换设备缺记录时，可手工粘贴 ID 补录。所有字段读取时都可能
 * 缺席，读取方必须容错。
 */
const KEY = "sui_scallop_adapters"

export interface ScallopAdapterRecord {
  channelId: string
  adapterId: string
  createdAtMs: number
  txDigest?: string
}

function readAll(): Record<string, ScallopAdapterRecord> {
  try {
    const raw = window.localStorage.getItem(KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
    return parsed as Record<string, ScallopAdapterRecord>
  } catch {
    return {}
  }
}

function writeAll(records: Record<string, ScallopAdapterRecord>): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(records))
  } catch {
    /* 私密模式/配额下静默失败：本地记录只是便利，不阻塞链上操作 */
  }
}

export function loadAdapterRecord(channelId: string): ScallopAdapterRecord | null {
  const record = readAll()[channelId]
  if (!record || typeof record.adapterId !== "string" || !record.adapterId) return null
  return record
}

export function saveAdapterRecord(record: ScallopAdapterRecord): void {
  if (!record.channelId || !record.adapterId) throw new Error(t("walrus.adapterRecordRequired"))
  const all = readAll()
  if (all[record.channelId]?.adapterId === record.adapterId) return
  all[record.channelId] = record
  writeAll(all)
}

export function clearAdapterRecord(channelId: string): void {
  const all = readAll()
  if (!all[channelId]) return
  delete all[channelId]
  writeAll(all)
}

/**
 * 从创建交易的 effects 里发现新 shared 适配器。
 *
 * gRPC effects 没有 created 数组：新建对象在 `changedObjects[]`，以
 * `idOperation === "Created"` 且 `outputOwner.$kind === "Shared"` 识别，
 * 再按类型 `…::scallop_yield_adapter::ScallopVaultAdapter` 验证兜底。
 */
interface ChangedObjectEntry {
  objectId: string
  idOperation?: string
  outputOwner?: { $kind?: string }
}

/** gRPC 读取的最小结构面（节点返回的 effects/object 形状允许字段缺席）。 */
export interface AdapterDiscoveryClient {
  getTransaction(input: { digest: string; include?: { effects?: boolean } }): Promise<{
    effects?: { changedObjects?: ChangedObjectEntry[] }
    Transaction?: { effects?: { changedObjects?: ChangedObjectEntry[] } }
  }>
  getObject(input: { objectId: string }): Promise<{ object?: { type?: string; objectType?: string } }>
}

export async function discoverCreatedAdapter(
  client: AdapterDiscoveryClient,
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
        if (type.startsWith(`${packageId}::scallop_yield_adapter::ScallopVaultAdapter`)) return entry.objectId
      }
    } catch {
      /* 索引未就绪，重试 */
    }
    await new Promise(resolve => setTimeout(resolve, 3000))
  }
  throw new Error(t("walrus.adapterDiscoveryFailed"))
}
