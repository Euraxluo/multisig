import type { Domain } from "../types"

/** Generic words shared across many components. Bundles must not edit this
 * file; if a generic word is missing, define it in your own domain instead. */
export const common: Domain = {
  zh: {
    confirm: "确认",
    cancel: "取消",
    close: "关闭",
    save: "保存",
    copy: "复制",
    copied: "已复制",
    retry: "重试",
    back: "返回",
    loading: "加载中…",
    submit: "提交",
    delete: "删除",
    edit: "编辑",
    details: "详情",
    testnetBadge: "Sui 测试网",
    connectWalletFirst: "连接钱包后，这里会显示你的链上数据。",
  },
  en: {
    confirm: "Confirm",
    cancel: "Cancel",
    close: "Close",
    save: "Save",
    copy: "Copy",
    copied: "Copied",
    retry: "Retry",
    back: "Back",
    loading: "Loading…",
    submit: "Submit",
    delete: "Delete",
    edit: "Edit",
    details: "Details",
    testnetBadge: "Sui Testnet",
    connectWalletFirst: "Connect a wallet to see your on-chain data here.",
  },
}
