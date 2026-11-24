"use client"

/**
 * identity 加密私信的前端薄壳。
 *
 * 键管理、发送、事件扫描与解密投影全部在 `multisig/bridge`；本文件只保留
 * 浏览器侧的接缝：IndexedDB 消息密钥存储、env 配置、钱包签名执行与 i18n。
 */
import { createPrivateMessaging, type MessageKeyStore, type PrivateMessaging, type PrivateMessagingOptions, type StoredMessageKey } from "multisig/bridge"
import type { IdentityProfile } from "./identity-client"
import { executeIdentityTransaction, getIdentity, identityConfig, identityConfigured, identityRpc } from "./identity-client"
import { t } from "./i18n/t"
import "./bridge-locale"

export type {
  PrivateConversation,
  PrivateConversationList,
  PrivateMessage,
  PrivateMessageHistory,
  PrivateMessageHistoryOptions,
} from "multisig/bridge"

// IndexedDB 结构化克隆保留不可导出私钥；私钥永不导出。
function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("sui-identity-private-messages", 1)
    request.onupgradeneeded = () => request.result.createObjectStore("keys", { keyPath: "id" })
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(new Error(t("misc.dmLib.openFailed")))
    request.onblocked = () => reject(new Error(t("misc.dmLib.blocked")))
  })
}

async function readKey(id: string): Promise<StoredMessageKey | undefined> {
  const db = await database()
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("keys", "readonly")
      const request = tx.objectStore("keys").get(id)
      request.onsuccess = () => resolve(request.result as StoredMessageKey | undefined)
      request.onerror = () => reject(new Error(t("misc.dmLib.readFailed")))
    })
  } finally { db.close() }
}

async function saveKey(record: StoredMessageKey): Promise<void> {
  const db = await database()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("keys", "readwrite")
      tx.objectStore("keys").put(record)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(new Error(t("misc.dmLib.saveFailed")))
      tx.onabort = () => reject(new Error(t("misc.dmLib.saveRetry")))
    })
  } finally { db.close() }
}

const keys: MessageKeyStore = { read: readKey, save: saveKey }

let instance: PrivateMessaging | null = null
function messaging(): PrivateMessaging {
  instance ??= createPrivateMessaging({
    // 未配置时用空配置构造；SDK 在 list/history 入口先返回与旧实现相同的
    // identityNotConfigured 文案，其余入口由 getIdentity 抛出配置错误。
    config: identityConfigured() ? identityConfig() : { packageId: "", namesId: "" },
    rpc: identityRpc as unknown as PrivateMessagingOptions["rpc"],
    keys,
    execute: (tx, profile) => executeIdentityTransaction(tx, profile),
    getIdentity,
    isConfigured: identityConfigured,
  })
  return instance
}

export async function hasMessagingKey(profile: IdentityProfile): Promise<boolean> {
  return messaging().hasMessagingKey(profile)
}

export async function enablePrivateMessages(profile: IdentityProfile): Promise<void> {
  return messaging().enablePrivateMessages(profile)
}

export async function sendPrivateMessage(sender: IdentityProfile, recipient: IdentityProfile, text: string): Promise<void> {
  return messaging().sendPrivateMessage(sender, recipient, text)
}

export async function listPrivateConversations(me: IdentityProfile, options: { maxPages?: number; pageSize?: number; resolveProfile?: (id: string) => Promise<IdentityProfile> } = {}) {
  return messaging().listPrivateConversations(me, options)
}

export async function readPrivateMessageHistory(me: IdentityProfile, peer: IdentityProfile, options: { maxPages?: number; pageSize?: number } = {}) {
  return messaging().readPrivateMessageHistory(me, peer, options)
}

/** Existing consumers keep the array API; protocol transports can inspect scan completeness. */
export async function getPrivateMessages(me: IdentityProfile, peer: IdentityProfile) {
  return messaging().getPrivateMessages(me, peer)
}
