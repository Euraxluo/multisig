/**
 * asset_custody（DAO 金库托管任意 owned 对象）的前端读链与组合层。
 *
 * 快照读取委托 SDK custody/reader（单一事实源）；此处补前端独有的三件事：
 * ① CustodyProposal.voters 是 Table，键值在动态字段里——readCustodyVoters 分页
 *   join 出投票明细；② verifySlotChild 核验托管资产仍是 custody 的动态子对象
 * （守恒徽章：owner === ObjectOwner(custodyId)）；③ readUpgradeCapObject 解析
 * 73B UpgradeCap BCS，升级模板启动器由此推导 currentPackageId，不信用户输入。
 */
import { bcs } from "@mysten/sui/bcs"
import type { SuiClientTypes } from "@mysten/sui/client"
import { normalizeSuiAddress, normalizeStructTag, parseStructTag, toHex } from "@mysten/sui/utils"
import { readAssetCustody, readCustodyProposal, type AssetCustodySnapshot, type CustodyProposalSnapshot } from "multisig/agent-vault/custody"
import { PROPOSAL_PACKAGE_ID, PROPOSAL_TYPE_ORIGIN, proposalClient } from "@/lib/proposal-chain"
import { t } from "@/lib/i18n/t"

const requestSignal = () => AbortSignal.timeout(20_000)

export type CustodyChainClient = Parameters<typeof readAssetCustody>[0] & Parameters<typeof readCustodyProposal>[0] & {
  getObjects(input: { objectIds: string[]; include?: { content?: boolean }; signal?: AbortSignal }): Promise<{ objects: unknown[] }>
} & Pick<SuiClientTypes.TransportMethods, "listDynamicFields">

const VoterField = bcs.struct("VoterField", { id: bcs.Address, name: bcs.Address, value: bcs.u8() })

/** 1 = 赞成、2 = 否决（合约 voters 表的双用途编码）。 */
export type CustodyVoteMark = 1 | 2

export function readCustodyInventory(client: CustodyChainClient, custodyId: string): Promise<AssetCustodySnapshot> {
  return readAssetCustody(client, { custodyId, packageId: PROPOSAL_PACKAGE_ID })
}

export function readCustodyProposalSnapshot(client: CustodyChainClient, proposalId: string): Promise<CustodyProposalSnapshot> {
  return readCustodyProposal(client, { proposalId, packageId: PROPOSAL_PACKAGE_ID })
}

/** 分页读投票明细（模式照 proposal-chain 的权重表读法；上限防失控分页）。 */
export async function readCustodyVoters(
  client: CustodyChainClient,
  tableId: string,
): Promise<Record<string, CustodyVoteMark>> {
  const voters: Record<string, CustodyVoteMark> = {}
  const cursors = new Set<string>()
  let fieldsRead = 0
  let cursor: string | null = null
  do {
    const page = await client.listDynamicFields({ parentId: tableId, cursor, limit: 50, signal: requestSignal() })
    fieldsRead += page.dynamicFields.length
    if (fieldsRead > 1000) throw new Error(t("walrus.votersTooMany"))
    if (page.dynamicFields.length) {
      const { objects } = await client.getObjects({ objectIds: page.dynamicFields.map(field => field.fieldId), include: { content: true }, signal: requestSignal() })
      for (const object of objects as Array<{ type?: string; content?: Uint8Array }>) {
        if (normalizeStructTag(String(object.type)) !== normalizeStructTag("0x2::dynamic_field::Field<address,u8>")) {
          throw new Error(t("walrus.votersTableTypeMismatch"))
        }
        if (!(object.content instanceof Uint8Array)) throw new Error(t("walrus.votersFieldContentMissing"))
        const field = VoterField.parse(object.content)
        const mark = Number(field.value)
        if (mark !== 1 && mark !== 2) throw new Error(t("walrus.votersInvalidMark"))
        voters[normalizeSuiAddress(field.name)] = mark as CustodyVoteMark
      }
    }
    if (page.hasNextPage) {
      if (!page.cursor || cursors.has(page.cursor)) throw new Error(t("walrus.votersPaginationStuck"))
      cursors.add(page.cursor)
    }
    cursor = page.hasNextPage ? page.cursor : null
  } while (cursor)
  return voters
}

/** 托管资产守恒核验：资产仍是 custody 的动态子对象。
 *  dynamic_object_field 的直接 owner 是 Field wrapper（wrapper 的 owner 才是 custody），
 *  故先比直接 owner，不等再跳一跳比 wrapper 的 owner；两种 gRPC owner 形状都兼容。 */
export async function verifySlotChild(
  client: Pick<CustodyChainClient, "getObject">,
  objectId: string,
  custodyId: string,
): Promise<boolean> {
  try {
    const direct = await objectOwnerId(client, objectId)
    if (direct === null) return false
    if (normalizeSuiAddress(direct) === normalizeSuiAddress(custodyId)) return true
    // 直接 owner 是 wrapper：wrapper 的 owner 必须恰为本 custody
    const hop = await objectOwnerId(client, direct)
    return hop !== null && normalizeSuiAddress(hop) === normalizeSuiAddress(custodyId)
  } catch {
    return false
  }
}

/** 对象的 object-owner id；非对象托管（地址持有/共享）返回 null。gRPC owner 形状漂移全兼容。 */
async function objectOwnerId(
  client: Pick<CustodyChainClient, "getObject">,
  objectId: string,
): Promise<string | null> {
  const { object } = await client.getObject({ objectId, signal: requestSignal() }) as {
    object?: { owner?: { $kind?: string; ObjectOwner?: unknown; Object?: unknown } }
  }
  const owner = object?.owner
  if (!owner || (owner.$kind !== "ObjectOwner" && owner.$kind !== "Object")) return null
  const raw = owner.ObjectOwner ?? owner.Object
  const ownerId = typeof raw === "string" ? raw
    : raw && typeof raw === "object" ? String((raw as { objectId?: string; inner?: string }).objectId ?? (raw as { inner?: string }).inner ?? "")
    : ""
  return ownerId ? normalizeSuiAddress(ownerId) : null
}

export interface UpgradeCapObjectSnapshot {
  id: string
  packageId: string
  version: bigint
  policy: number
}

/** gRPC content 三形状兼容（字节数组 / base64 串 / 逗号分隔数字串）。 */
function contentBytes(content: unknown): Uint8Array {
  if (content instanceof Uint8Array) return content
  if (typeof content === "string" && /^[\d,]+$/.test(content)) {
    return Uint8Array.from(content.split(",").map(Number))
  }
  if (typeof content === "string") {
    const binary = atob(content)
    return Uint8Array.from(binary, char => char.charCodeAt(0))
  }
  if (Array.isArray(content)) return Uint8Array.from(content as number[])
  throw new Error(t("walrus.contentShapeInvalid"))
}

/** 解析独立 UpgradeCap（73B：uid || package || version LE || policy）——托管后仍以原 ID 可读。 */
export async function readUpgradeCapObject(
  client: Pick<CustodyChainClient, "getObject">,
  objectId: string,
): Promise<UpgradeCapObjectSnapshot> {
  const { object } = await client.getObject({ objectId, include: { content: true }, signal: requestSignal() }) as {
    object?: { id?: string; objectId?: string; content?: unknown }
  }
  const bytes = contentBytes(object?.content)
  if (bytes.length !== 73) throw new Error(t("walrus.upgradeCapLength", { length: bytes.length }))
  const id = normalizeSuiAddress(object?.id ?? object?.objectId ?? objectId)
  const uid = `0x${toHex(bytes.slice(0, 32))}`
  if (uid !== id) throw new Error(t("walrus.upgradeCapUidMismatch"))
  const packageId = `0x${toHex(bytes.slice(32, 64))}`
  let version = 0n
  for (let i = 71; i >= 64; i--) version = (version << 8n) | BigInt(bytes[i])
  return { id, packageId, version, policy: bytes[72] }
}

/** custody 提案对象类型是否来自现行包（事件/对象发现时兜底校验）。 */
export function isCustodyProposalType(type: string): boolean {
  try {
    const parsed = parseStructTag(type)
    return parsed.module === "asset_custody" &&
      parsed.name === "CustodyProposal" &&
      parsed.typeParams.length === 0 &&
      normalizeSuiAddress(parsed.address) === normalizeSuiAddress(PROPOSAL_TYPE_ORIGIN)
  } catch {
    return false
  }
}

export { proposalClient as custodyChainClient }
