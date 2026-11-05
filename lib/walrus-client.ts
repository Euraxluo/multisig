"use client"

import { t } from "./i18n/t"

export interface WalrusUploadResult {
  blobId: string
  size: number
  contentType: string
  epochs: number
  storageCostMist?: string
  uploadedAt: string
  url: string
  isLocalFallback?: boolean
}

export interface GroupFileInfo {
  id: string
  groupId: string
  name: string
  size: number | null
  blobId: string
  uploader: string
  uploadedAt: string
  contentType: string
  url: string
  source?: "local" | "chain"
  transactionDigest?: string
  channelId?: string
  recordIssues?: string[]
}

export const isWalrusBlobId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value)

export const WALRUS_PUBLISHER_URL = "https://publisher.walrus-testnet.walrus.space"
export const WALRUS_AGGREGATOR_URL = "https://aggregator.walrus-testnet.walrus.space"

/**
 * 上传文件或数据到 Walrus 去中心化存储协议
 */
export async function uploadToWalrus(
  data: Blob | File | string,
  options: {
    epochs?: number
    contentType?: string
    filename?: string
  } = {}
): Promise<WalrusUploadResult> {
  const epochs = options.epochs ?? 5
  if (!Number.isSafeInteger(epochs) || epochs < 1) throw new Error(t("walrus.epochsPositive"))
  let blobData: Blob
  let contentType = options.contentType || "application/octet-stream"

  if (typeof data === "string") {
    blobData = new Blob([data], { type: options.contentType || "text/plain" })
    contentType = options.contentType || "text/plain"
  } else {
    blobData = data
    if (data.type) contentType = data.type
  }

  const arrayBuffer = await blobData.arrayBuffer()
  let realBlobId: string

  try {
    const response = await fetch(`${WALRUS_PUBLISHER_URL}/v1/blobs?epochs=${epochs}`, {
      method: "PUT",
      body: arrayBuffer,
      headers: {
        "Content-Type": contentType,
      },
      signal: AbortSignal.timeout(8000),
    })

    if (!response.ok) throw new Error(t("walrus.publisherHttpError", { status: response.status }))
    const json = await response.json()
    realBlobId = json.newlyCreated?.blobObject?.blobId || json.alreadyCertified?.blobId
    if (!isWalrusBlobId(realBlobId)) throw new Error(t("walrus.publisherNoBlobId"))
  } catch (error) {
    throw new Error(error instanceof Error ? t("walrus.uploadFailed", { message: error.message }) : t("walrus.uploadFailedNoMessage"))
  }

  // 本地离线/快速缓存
  try {
    const base64Data = arrayBufferToBase64(arrayBuffer)
    const cacheKey = `walrus_blob_${realBlobId}`
    if (typeof window !== "undefined" && base64Data.length < 2_000_000) {
      localStorage.setItem(
        cacheKey,
        JSON.stringify({
          data: base64Data,
          contentType,
          uploadedAt: new Date().toISOString(),
          filename: options.filename,
        })
      )
    }
  } catch {}

  const result: WalrusUploadResult = {
    blobId: realBlobId,
    size: arrayBuffer.byteLength,
    contentType,
    epochs,
    uploadedAt: new Date().toISOString(),
    url: `${WALRUS_AGGREGATOR_URL}/v1/blobs/${realBlobId}`,
    isLocalFallback: false,
  }

  return result
}

/**
 * 从 Walrus 聚合节点（或本地内容缓存）下载 Blob
 */
export async function downloadFromWalrus(blobId: string): Promise<{ data: Blob; filename?: string; source: "cache" | "aggregator" }> {
  if (!isWalrusBlobId(blobId)) throw new Error(t("walrus.invalidBlobId"))
  // 1. 优先尝试本地缓存
  try {
    const raw = localStorage.getItem(`walrus_blob_${blobId}`)
    if (raw) {
      const parsed = JSON.parse(raw)
      const buffer = base64ToArrayBuffer(parsed.data)
      return {
        data: new Blob([buffer], { type: parsed.contentType || "application/octet-stream" }),
        filename: parsed.filename,
        source: "cache",
      }
    }
  } catch {}

  // 2. 尝试从 Walrus Aggregator 官方节点拉取
  try {
    const res = await fetch(`${WALRUS_AGGREGATOR_URL}/v1/blobs/${blobId}`, {
      signal: AbortSignal.timeout(6000),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return { data: await res.blob(), source: "aggregator" }
  } catch (error) {
    throw new Error(t("walrus.aggregatorReadFailed", { blobId, message: error instanceof Error ? error.message : t("walrus.requestFailed") }))
  }
}

function storedGroupFiles(groupId: string): unknown[] {
  const raw = localStorage.getItem(`walrus_files_${groupId}`)
  if (raw === null) return []
  const parsed: unknown = JSON.parse(raw)
  if (!Array.isArray(parsed)) throw new Error(t("walrus.groupFileIndexInvalid"))
  return parsed
}

/** Local history is unverified; projections never rewrite malformed or unknown rows. */
export function getGroupWalrusFiles(groupId: string): GroupFileInfo[] {
  if (typeof window === "undefined") return []
  try {
    return storedGroupFiles(groupId).map((value, index) => {
      const row = value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
      const issues: string[] = []
      const blobId = typeof row.blobId === "string" ? row.blobId : ""
      if (!isWalrusBlobId(blobId)) issues.push(t("walrus.issueMissingBlobId"))
      if (row.groupId !== groupId) issues.push(t("walrus.issueGroupUnverified"))
      const size = typeof row.size === "number" && Number.isSafeInteger(row.size) && row.size >= 0 ? row.size : null
      if (size === null) issues.push(t("walrus.issueSizeUnknown"))
      return {
        id: typeof row.id === "string" ? row.id : `legacy:${index}`, groupId,
        name: typeof row.name === "string" && row.name ? row.name : t("walrus.unverifiedFileName"),
        size, blobId, uploader: typeof row.uploader === "string" ? row.uploader : t("walrus.unknownUploader"),
        uploadedAt: typeof row.uploadedAt === "string" ? row.uploadedAt : "",
        contentType: typeof row.contentType === "string" ? row.contentType : "application/octet-stream",
        url: isWalrusBlobId(blobId) ? `${WALRUS_AGGREGATOR_URL}/v1/blobs/${blobId}` : "",
        source: "local", recordIssues: issues,
      }
    })
  } catch (error) {
    throw new Error(error instanceof Error ? t("walrus.groupIndexReadFailed", { message: error.message }) : t("walrus.groupIndexReadFailedNoMessage"))
  }
}

/** Save the raw history intact; callers retain the upload receipt if storage fails. */
export function addGroupWalrusFile(groupId: string, file: GroupFileInfo): void {
  if (typeof window === "undefined") throw new Error(t("walrus.noWindowSave"))
  try {
    const existing = storedGroupFiles(groupId)
    const updated = [file, ...existing.filter(value => !(value !== null && typeof value === "object" && "id" in value && value.id === file.id))]
    localStorage.setItem(`walrus_files_${groupId}`, JSON.stringify(updated))
  } catch (error) {
    throw new Error(t("walrus.indexSaveFailed", { message: error instanceof Error ? error.message : t("walrus.storageUnavailable"), blobId: file.blobId }))
  }
  window.dispatchEvent(new CustomEvent("walrus-files-updated", { detail: { groupId, file } }))
}

// 辅助工具：Base64 <-> ArrayBuffer
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = ""
  const bytes = new Uint8Array(buffer)
  const len = bytes.byteLength
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary_string = atob(base64)
  const len = binary_string.length
  const bytes = new Uint8Array(len)
  for (let i = 0; i < len; i++) {
    bytes[i] = binary_string.charCodeAt(i)
  }
  return bytes.buffer
}
