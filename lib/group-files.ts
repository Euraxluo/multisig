import type { ChatMessage } from "./group-chat"
import { isWalrusBlobId, WALRUS_AGGREGATOR_URL, type GroupFileInfo } from "./walrus-client"
import { t } from "@/lib/i18n/t"

const FILE_PREFIX = "sui-group-file:"
interface FileMetadata { version: 1; name: string; size: number; contentType: string }

function metadata(value: unknown): FileMetadata {
  if (!value || typeof value !== "object") throw new Error(t("groups.fileMetaInvalid"))
  const row = value as Record<string, unknown>
  if (row.version !== 1 || typeof row.name !== "string" || !row.name.trim() || new TextEncoder().encode(row.name).length > 512 ||
      typeof row.size !== "number" || !Number.isSafeInteger(row.size) || row.size < 0 ||
      typeof row.contentType !== "string" || !/^[\x20-\x7e]{1,128}$/.test(row.contentType)) throw new Error(t("groups.fileNameSizeTypeInvalid"))
  return { version: 1, name: row.name, size: row.size, contentType: row.contentType }
}

export function encodeGroupFilePreview(file: Pick<GroupFileInfo, "name" | "size" | "contentType">): string {
  return FILE_PREFIX + JSON.stringify(metadata({ version: 1, ...file }))
}

export function groupFileMessageText(preview: string): string {
  if (!preview.startsWith(FILE_PREFIX)) return preview
  try { return t("groups.sharedFileLabel", { name: metadata(JSON.parse(preview.slice(FILE_PREFIX.length))).name }) }
  catch { return preview }
}

/** Only validated channel events establish sender, channel, time and transaction provenance. */
export function sharedGroupFiles(groupId: string, channelId: string, messages: readonly ChatMessage[]): GroupFileInfo[] {
  const files = new Map<string, GroupFileInfo>()
  for (const message of messages) {
    if (!message.walrusBlobId) continue
    const issues: string[] = []
    let file: FileMetadata | null = null
    if (message.text.startsWith(FILE_PREFIX)) {
      try { file = metadata(JSON.parse(message.text.slice(FILE_PREFIX.length))) }
      catch { issues.push(t("groups.fileMetaFallback")) }
    }
    if (!isWalrusBlobId(message.walrusBlobId)) issues.push(t("groups.fileNotWalrusBlob"))
    if (!Number.isSafeInteger(message.timestampMs) || message.timestampMs < 0 || message.timestampMs > 8_640_000_000_000_000) throw new Error(t("groups.fileEventTimeInvalid"))
    // Keep the first observed reference; repeats do not invent new uploads.
    if (files.has(message.walrusBlobId)) continue
    files.set(message.walrusBlobId, {
      id: message.id, groupId, channelId, name: file?.name || t("groups.attachmentFallbackName", { id: message.walrusBlobId.slice(0, 12) }),
      size: file?.size ?? null, blobId: message.walrusBlobId, uploader: message.sender,
      uploadedAt: new Date(message.timestampMs).toISOString(), contentType: file?.contentType || "application/octet-stream",
      url: isWalrusBlobId(message.walrusBlobId) ? `${WALRUS_AGGREGATOR_URL}/v1/blobs/${message.walrusBlobId}` : "",
      source: "chain", transactionDigest: message.digest, recordIssues: issues,
    })
  }
  return [...files.values()]
}
