"use client"

import { useState, useEffect } from "react"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Input } from "@/components/ui/input"
import {
  KeyRound,
  Fingerprint,
  Wallet,
  ShieldCheck,
  Sparkles,
  CheckCircle2,
  Lock,
  ArrowRight,
  ExternalLink,
  Laptop,
  Smartphone,
  LogOut,
  Copy,
  Check,
  RefreshCw,
  AlertCircle,
  Code2,
  Download,
} from "lucide-react"
import { motion, AnimatePresence } from "framer-motion"
import { isValidSuiAddress, normalizeSuiAddress, fromBase58, fromHex } from "@mysten/sui/utils"
import { Ed25519PublicKey } from "@mysten/sui/keypairs/ed25519"

export interface UserAccount {
  type: "zklogin" | "passkey" | "wallet"
  provider?: string
  identifier: string // email or device name
  address: string
  epochTtl?: number
  authMethodLabel: string
}

interface ConnectWalletDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onLoginSuccess?: (account: UserAccount) => void
  currentAccount?: UserAccount | null
  currentUser?: UserAccount | null
  onLogout?: () => void
}

// 常见 Sui 生态扩展钱包及其 Chrome 应用店下载链接
const POPULAR_WALLETS = [
  {
    name: "Sui Wallet",
    icon: "💧",
    desc: "Mysten Labs 官方钱包插件",
    installUrl: "https://chromewebstore.google.com/detail/sui-wallet/opcgpfmipidbgpenhmajoajpbobppdil",
    idMatch: ["sui wallet", "sui"],
  },
  {
    name: "Suiet Wallet",
    icon: "🦊",
    desc: "开源且体验优秀的 Sui 生态钱包",
    installUrl: "https://chromewebstore.google.com/detail/suiet-sui-wallet/khpkpbbcccdmmclmpigdgddabeamhila",
    idMatch: ["suiet"],
  },
  {
    name: "OKX Wallet",
    icon: "🪙",
    desc: "OKX Web3 跨链钱包（原生支持 Sui）",
    installUrl: "https://chromewebstore.google.com/detail/okx-wallet/mcohilncbfahbmgdjkbpemancgipdafd",
    idMatch: ["okx"],
  },
  {
    name: "Nightly Wallet",
    icon: "🌙",
    desc: "知名多链生态钱包（支持 Sui）",
    installUrl: "https://chromewebstore.google.com/detail/nightly/fiikpmmfchmkplbggioepbfenfhhikfa",
    idMatch: ["nightly"],
  },
  {
    name: "Martian Wallet",
    icon: "👽",
    desc: "Martian 多链生态钱包",
    installUrl: "https://chromewebstore.google.com/detail/martian-wallet/efbglgofoippbgcjepnhiblaibcnclgk",
    idMatch: ["martian"],
  },
]

// ----------------------------------------------------
// Sui 真实链上地址校验与多链钱包（如 OKX / Multi-chain）地址解析
// ----------------------------------------------------
export function isCleanSuiAddress(addr: unknown, isSuiChainExplicit: boolean = false): boolean {
  if (typeof addr !== "string") return false
  const trimmed = addr.trim()
  if (!trimmed.startsWith("0x")) return false
  // 排除未明确指明属于 Sui 网络的 42 位 EVM 常见地址 (0x + 40 hex)
  if (trimmed.length === 42 && !isSuiChainExplicit) return false
  try {
    const norm = normalizeSuiAddress(trimmed)
    return isValidSuiAddress(norm)
  } catch {
    return false
  }
}

function extractPublicKeyBytes(acc: any): Uint8Array | null {
  if (!acc) return null
  if (acc.publicKey instanceof Uint8Array && acc.publicKey.length === 32) {
    return acc.publicKey
  }
  if (typeof acc.publicKey === "string") {
    try {
      const b = fromBase58(acc.publicKey)
      if (b.length === 32) return b
    } catch {}
    try {
      const b = fromHex(acc.publicKey.replace(/^0x/, ""))
      if (b.length === 32) return b
    } catch {}
  }
  return null
}

async function getOkxNativeSuiAccount(): Promise<string | null> {
  if (typeof window === "undefined") return null
  const okxSui = (window as any).okxwallet?.sui
  if (!okxSui) return null

  // 1. 尝试 connect() 唤起授权
  try {
    if (typeof okxSui.connect === "function") {
      const res = await okxSui.connect()
      const addr = res?.address || (Array.isArray(res) ? (res[0]?.address || res[0]) : (typeof res === "string" ? res : null))
      if (addr && isCleanSuiAddress(addr, true)) {
        return normalizeSuiAddress(addr)
      }
    }
  } catch (e) {
    console.warn("okxSui.connect() error:", e)
  }

  // 2. 尝试 getAccounts()
  try {
    if (typeof okxSui.getAccounts === "function") {
      const accs = await okxSui.getAccounts()
      if (Array.isArray(accs) && accs.length > 0) {
        for (const item of accs) {
          const addr = typeof item === "string" ? item : item?.address
          if (addr && isCleanSuiAddress(addr, true)) {
            return normalizeSuiAddress(addr)
          }
        }
      }
    }
  } catch (e) {
    console.warn("okxSui.getAccounts() error:", e)
  }

  // 3. 尝试 getAccount()
  try {
    if (typeof okxSui.getAccount === "function") {
      const acc = await okxSui.getAccount()
      const addr = typeof acc === "string" ? acc : acc?.address
      if (addr && isCleanSuiAddress(addr, true)) {
        return normalizeSuiAddress(addr)
      }
    }
  } catch (e) {
    console.warn("okxSui.getAccount() error:", e)
  }

  // 4. 尝试 requestPermissions()
  try {
    if (typeof okxSui.requestPermissions === "function") {
      await okxSui.requestPermissions()
      if (typeof okxSui.getAccounts === "function") {
        const accs = await okxSui.getAccounts()
        if (Array.isArray(accs) && accs.length > 0) {
          for (const item of accs) {
            const addr = typeof item === "string" ? item : item?.address
            if (addr && isCleanSuiAddress(addr, true)) {
              return normalizeSuiAddress(addr)
            }
          }
        }
      }
    }
  } catch (e) {
    console.warn("okxSui.requestPermissions() error:", e)
  }

  return null
}

async function resolveSuiAddressFromAccounts(accounts: any[], walletName?: string): Promise<string> {
  if (!accounts || accounts.length === 0) {
    throw new Error(`未能从 ${walletName || "钱包"} 读取到任何账户`)
  }

  // 1. 优先筛选 chains 明确为 sui 链的账户（避免 OKX 多链钱包同时包含 Solana/EVM 账户时取错）
  const suiChainAccount = accounts.find((acc: any) =>
    acc?.chains?.some((c: string) => typeof c === "string" && c.toLowerCase().startsWith("sui"))
  )
  if (suiChainAccount) {
    const rawAddr = suiChainAccount.address
    if (typeof rawAddr === "string" && isCleanSuiAddress(rawAddr, true)) {
      return normalizeSuiAddress(rawAddr)
    }
    // 如果该账户是 Sui 链账户但以 Base58 或公钥提供
    const pubKeyBytes = extractPublicKeyBytes(suiChainAccount)
    if (pubKeyBytes && pubKeyBytes.length === 32) {
      try {
        const pk = new Ed25519PublicKey(pubKeyBytes)
        const derived = pk.toSuiAddress()
        if (isValidSuiAddress(derived)) return derived
      } catch (e) {
        console.warn("Failed to derive Sui address from pubkey:", e)
      }
    }
  }

  // 2. 遍历所有账户寻找以 0x 开头的合法 Sui 64位十六进制地址（排除 42 位 EVM 地址）
  for (const acc of accounts) {
    const rawAddr = typeof acc === "string" ? acc : acc?.address
    if (typeof rawAddr === "string" && isCleanSuiAddress(rawAddr)) {
      return normalizeSuiAddress(rawAddr)
    }
  }

  // 3. 如果是 OKX 钱包或检测到 window.okxwallet?.sui，尝试直接向 OKX 原生 Sui Provider 请求账户
  if (walletName?.toLowerCase().includes("okx") || (typeof window !== "undefined" && (window as any).okxwallet?.sui)) {
    const okxAddr = await getOkxNativeSuiAccount()
    if (okxAddr) return okxAddr
  }

  // 4. 检查是否连接到了非 Sui 链账户（例如 Solana Base58 地址或 EVM 地址）
  const firstRaw = typeof accounts[0] === "string" ? accounts[0] : (accounts[0]?.address || "")
  if (firstRaw && !firstRaw.startsWith("0x")) {
    throw new Error(`当前钱包处于非 Sui 网络（检测到 Solana 地址），请在 ${walletName || "OKX"} 插件顶部切换为 Sui 网络后重试。`)
  }

  if (firstRaw && firstRaw.length === 42) {
    throw new Error(`当前钱包处于以太坊/EVM 网络，请在插件中切换为 Sui 网络后重试。`)
  }

  throw new Error(`未能从 ${walletName || "钱包"} 读取到有效的 Sui 地址 (0x...)`)
}

export function ConnectWalletDialog({
  open,
  onOpenChange,
  onLoginSuccess,
  currentAccount,
  currentUser,
  onLogout,
}: ConnectWalletDialogProps) {
  const [activeTab, setActiveTab] = useState<"zklogin" | "passkey" | "wallet">("wallet")
  const [isProcessing, setIsProcessing] = useState(false)
  const [processStep, setProcessStep] = useState<string>("")
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [jwtInput, setJwtInput] = useState("")
  const [showJwtInput, setShowJwtInput] = useState(false)
  const [googleClientId, setGoogleClientId] = useState("")
  const [showConfigClientId, setShowConfigClientId] = useState(false)

  // 动态扫描到的标准扩展钱包列表 (Sui Wallet Standard)
  const [installedWallets, setInstalledWallets] = useState<any[]>([])

  // 内部已登录状态（优先从外部 prop 读取，其次从 localStorage 读取）
  const [internalAccount, setInternalAccount] = useState<UserAccount | null>(
    currentAccount !== undefined ? currentAccount : (currentUser !== undefined ? currentUser : null)
  )

  useEffect(() => {
    if (currentAccount !== undefined) {
      setInternalAccount(currentAccount)
    } else if (currentUser !== undefined) {
      setInternalAccount(currentUser)
    }
  }, [currentAccount, currentUser])

  // 1. 初始化并订阅 Sui Wallet Standard
  const refreshInstalledWallets = async () => {
    try {
      const { getWallets } = await import("@mysten/wallet-standard")
      const walletsApi = getWallets()
      const all = walletsApi.get()
      const suiWallets = all.filter((w: any) =>
        w.chains?.some((c: string) => c.startsWith("sui:")) ||
        w.name?.toLowerCase().includes("sui") ||
        w.features?.["sui:signTransaction"] ||
        w.features?.["sui:signAndExecuteTransaction"] ||
        w.features?.["sui:signAndExecuteTransactionBlock"] ||
        w.features?.["standard:connect"]
      )
      setInstalledWallets(suiWallets)
    } catch (e) {
      console.warn("Failed to discover wallets via standard", e)
    }
  }

  useEffect(() => {
    if (typeof window === "undefined") return

    let unsubRegister: (() => void) | undefined
    let unsubUnregister: (() => void) | undefined

    const init = async () => {
      try {
        const { getWallets } = await import("@mysten/wallet-standard")
        const walletsApi = getWallets()
        await refreshInstalledWallets()

        unsubRegister = walletsApi.on("register", refreshInstalledWallets)
        unsubUnregister = walletsApi.on("unregister", refreshInstalledWallets)
      } catch (e) {
        console.warn("Wallet standard init error", e)
      }
    }

    init()
    return () => {
      unsubRegister?.()
      unsubUnregister?.()
    }
  }, [])

  // 2. 读取 Google Client ID
  useEffect(() => {
    try {
      const savedCid = localStorage.getItem("sui_google_client_id")
      if (savedCid) setGoogleClientId(savedCid)
    } catch (e) {}
  }, [])

  // 3. 检查 OAuth 回调 URL 中的 #id_token
  useEffect(() => {
    if (typeof window === "undefined") return
    const hash = window.location.hash
    if (hash && hash.includes("id_token=")) {
      const params = new URLSearchParams(hash.substring(1))
      const idToken = params.get("id_token")
      if (idToken) {
        handleProcessRealJwt(idToken)
        window.history.replaceState(null, "", window.location.pathname)
      }
    }
  }, [])

  // 4. 自动校验与清理历史残留的非 Sui 账户缓存（如误存的 Solana Base58 地址）
  useEffect(() => {
    try {
      const saved = localStorage.getItem("sui_active_account")
      if (saved) {
        const parsed = JSON.parse(saved)
        if (parsed?.address && !isCleanSuiAddress(parsed.address)) {
          console.warn("Detected non-Sui address in local cache, clearing:", parsed.address)
          localStorage.removeItem("sui_active_account")
          setInternalAccount(null)
          onLogout?.()
        }
      }
    } catch (e) {}
  }, [])

  const activeUser = internalAccount

  const saveAndSetAccount = (acc: UserAccount) => {
    setInternalAccount(acc)
    onLoginSuccess?.(acc)
    try {
      localStorage.setItem("sui_active_account", JSON.stringify(acc))
    } catch (e) {}
    setIsProcessing(false)
    setProcessStep("")
    setErrorMessage(null)
  }

  // ----------------------------------------------------
  // 连接标准的 Sui 扩展钱包 (Sui Wallet Standard & Multi-chain)
  // ----------------------------------------------------
  const handleConnectStandardWallet = async (wallet: any) => {
    setIsProcessing(true)
    setErrorMessage(null)
    setProcessStep(`正在唤起 ${wallet.name} 钱包插件授权弹窗...`)

    try {
      const isOkx = wallet.name?.toLowerCase().includes("okx")

      // 1. 如果是 OKX 钱包且 window.okxwallet?.sui 存在，优先走 OKX 专为 Sui 原生设计的 Provider
      if (isOkx && typeof window !== "undefined" && (window as any).okxwallet?.sui) {
        setProcessStep("正在唤起 OKX 钱包 Sui 原生网络授权...")
        const okxSuiAddr = await getOkxNativeSuiAccount()
        if (okxSuiAddr) {
          const newAcc: UserAccount = {
            type: "wallet",
            provider: wallet.name || "OKX Wallet",
            identifier: `${wallet.name || "OKX Wallet"} (${okxSuiAddr.slice(0, 6)}...${okxSuiAddr.slice(-4)})`,
            address: okxSuiAddr,
            authMethodLabel: wallet.name || "OKX Wallet",
          }
          saveAndSetAccount(newAcc)
          onOpenChange(false)
          return
        }
      }

      // 2. 通过 Wallet Standard 规范连接
      const connectFeature = wallet.features?.["standard:connect"]
      if (connectFeature) {
        setProcessStep(`正在等待 ${wallet.name} 授权连接...`)
        const res = await connectFeature.connect()
        const accounts = res?.accounts || wallet.accounts || []
        if (accounts && accounts.length > 0) {
          const suiAddr = await resolveSuiAddressFromAccounts(accounts, wallet.name)
          const newAcc: UserAccount = {
            type: "wallet",
            provider: wallet.name,
            identifier: `${wallet.name} (${suiAddr.slice(0, 6)}...${suiAddr.slice(-4)})`,
            address: suiAddr,
            authMethodLabel: wallet.name,
          }
          saveAndSetAccount(newAcc)
          onOpenChange(false)
          return
        }
      }

      // 3. 传统全局对象兜底
      if (typeof wallet.requestPermissions === "function") {
        await wallet.requestPermissions()
      }
      const accounts = await (wallet.getAccounts ? wallet.getAccounts() : wallet.accounts?.())
      if (accounts && accounts.length > 0) {
        const suiAddr = await resolveSuiAddressFromAccounts(accounts, wallet.name)
        const newAcc: UserAccount = {
          type: "wallet",
          provider: wallet.name,
          identifier: `${wallet.name} (${suiAddr.slice(0, 6)}...${suiAddr.slice(-4)})`,
          address: suiAddr,
          authMethodLabel: wallet.name,
        }
        saveAndSetAccount(newAcc)
        onOpenChange(false)
        return
      }

      throw new Error(`未能从 ${wallet.name} 读取到有效的 Sui 账户地址`)
    } catch (err: any) {
      console.error("Wallet connect error:", err)
      if (
        err.message?.includes("rejected") ||
        err.message?.includes("User rejected") ||
        err.name === "UserRejectedRequestError"
      ) {
        setErrorMessage(`您在 ${wallet.name} 中取消了连接授权。`)
      } else {
        setErrorMessage(err.message || `连接 ${wallet.name} 失败`)
      }
    } finally {
      setIsProcessing(false)
      setProcessStep("")
    }
  }

  // 点击未在 standard 中发现的钱包：先尝试检测全局对象，若无则友好提示
  const handlePopularWalletClick = async (pw: typeof POPULAR_WALLETS[0]) => {
    // 检查 installedWallets 中是否包含该钱包
    const matched = installedWallets.find((w) =>
      pw.idMatch.some((m) => w.name?.toLowerCase().includes(m))
    )
    if (matched) {
      await handleConnectStandardWallet(matched)
      return
    }

    // 尝试寻找 window 上的注入对象
    if (typeof window !== "undefined") {
      let globalObj = null
      if (pw.name === "Sui Wallet" && (window as any).suiWallet) globalObj = (window as any).suiWallet
      if (pw.name === "Suiet Wallet" && ((window as any).suiet || (window as any).__suiet__))
        globalObj = (window as any).suiet || (window as any).__suiet__
      if (pw.name === "OKX Wallet" && (window as any).okxwallet?.sui) globalObj = (window as any).okxwallet.sui
      if (pw.name === "Martian Wallet" && (window as any).martian?.sui) globalObj = (window as any).martian.sui

      if (globalObj) {
        await handleConnectStandardWallet({ name: pw.name, ...globalObj })
        return
      }
    }

    // 确实未安装该插件
    setErrorMessage(
      `未在当前浏览器中检测到「${pw.name}」扩展插件。\n\n` +
      `• 如果您未安装：请点击右侧「去安装 ↗」按钮前往 Chrome 网上应用店安装；\n` +
      `• 如果您已在 Chrome 安装：请刷新本页面（快捷键 ⌘R / F5），使插件注入页面；\n` +
      `• 💡 推荐无需插件：切换至左侧「Passkey」标签，直接使用 Mac 自带的 TouchID 指纹免密登录！`
    )
  }

  // ----------------------------------------------------
  // 真实 Passkey 硬件登录 (WebAuthn / Apple Secure Enclave / NIST P-256)
  // ----------------------------------------------------
  const handlePasskeyLogin = async () => {
    setIsProcessing(true)
    setErrorMessage(null)
    setProcessStep("正在唤起本机 Secure Enclave 硬件芯片 (TouchID / FaceID)...")

    try {
      if (typeof window === "undefined" || !window.PublicKeyCredential) {
        throw new Error("当前浏览器不支持 WebAuthn / Passkey 硬件生物识别，请使用 Safari 或 Chrome 浏览器。")
      }

      // 检查本地是否已有已注册的凭证
      const savedCredStr = localStorage.getItem("sui_passkey_credential")
      if (savedCredStr) {
        try {
          const savedCred = JSON.parse(savedCredStr)
          setProcessStep("检测到设备已注册 Passkey，请在触控 ID 传感器上轻触指纹...")

          const challenge = new Uint8Array(32)
          crypto.getRandomValues(challenge)

          const credIdBytes = Uint8Array.from(atob(savedCred.credentialIdBase64), (c) => c.charCodeAt(0))

          const assertion = await navigator.credentials.get({
            publicKey: {
              challenge,
              timeout: 60000,
              userVerification: "required",
              allowCredentials: [
                {
                  id: credIdBytes,
                  type: "public-key",
                },
              ],
            },
          })

          if (assertion) {
            const acc: UserAccount = {
              type: "passkey",
              provider: "Apple Secure Enclave",
              identifier: savedCred.identifier || "MacBook TouchID",
              address: savedCred.suiAddress,
              authMethodLabel: "Passkey P-256",
            }
            saveAndSetAccount(acc)
            return
          }
        } catch (authErr: any) {
          console.warn("Existing passkey verification fallback", authErr)
          if (authErr.name === "NotAllowedError") {
            setErrorMessage("您取消了 TouchID 指纹验证，或验证超时。")
            setIsProcessing(false)
            setProcessStep("")
            return
          }
        }
      }

      // 首次创建 Passkey 硬件凭证
      setProcessStep("首次绑定：请在弹出的系统提示中点击确认，并触碰 TouchID 指纹...")
      const { BrowserPasskeyProvider, PasskeyKeypair } = await import("@mysten/sui/keypairs/passkey")

      const provider = new BrowserPasskeyProvider("Sui MultiSig", {
        rp: { name: "Sui MultiSig Wallet" },
        user: {
          name: "sui-user@local",
          displayName: "Sui Hardware User",
        },
        authenticatorSelection: {
          authenticatorAttachment: "platform", // 必须强制唤起本机 TouchID / FaceID
          residentKey: "preferred",
          userVerification: "required",
        },
      })

      const keypair = await PasskeyKeypair.getPasskeyInstance(provider)
      const realSuiAddress = keypair.getPublicKey().toSuiAddress()
      const credId = keypair.getCredentialId()
      const credIdBase64 = btoa(String.fromCharCode(...credId))

      const passkeyRecord = {
        credentialIdBase64: credIdBase64,
        suiAddress: realSuiAddress,
        identifier: "MacBook TouchID",
        createdAt: Date.now(),
      }
      localStorage.setItem("sui_passkey_credential", JSON.stringify(passkeyRecord))

      const newAcc: UserAccount = {
        type: "passkey",
        provider: "Apple Secure Enclave",
        identifier: "MacBook TouchID",
        address: realSuiAddress,
        authMethodLabel: "Passkey P-256",
      }

      saveAndSetAccount(newAcc)
    } catch (err: any) {
      console.error("Passkey error:", err)
      if (err.name === "NotAllowedError") {
        setErrorMessage("您取消了 TouchID / FaceID 生物识别验证，或验证已超时。")
      } else if (err.name === "InvalidStateError") {
        setErrorMessage("当前设备上已存在该 Passkey，请刷新后重试。")
      } else {
        setErrorMessage(`Passkey 错误: ${err.message || String(err)}`)
      }
    } finally {
      setIsProcessing(false)
      setProcessStep("")
    }
  }

  // ----------------------------------------------------
  // 真实 zkLogin 解析 Google JWT Token
  // ----------------------------------------------------
  const handleProcessRealJwt = async (tokenString: string) => {
    setIsProcessing(true)
    setErrorMessage(null)
    setProcessStep("正在解析 Google ID Token 并派生 Sui 原生 zkLogin 地址...")

    try {
      const { decodeJwt, jwtToAddress } = await import("@mysten/sui/zklogin")
      const decoded: any = decodeJwt(tokenString)

      let salt = localStorage.getItem("sui_zklogin_user_salt")
      if (!salt) {
        salt = "12939218204910249214019284"
        localStorage.setItem("sui_zklogin_user_salt", salt)
      }

      const suiAddress = jwtToAddress(tokenString, salt, false)
      const userEmail = decoded.email || decoded.sub || "Google User"

      const newAcc: UserAccount = {
        type: "zklogin",
        provider: "Google",
        identifier: userEmail,
        address: suiAddress,
        epochTtl: 2,
        authMethodLabel: "Google zkLogin (Flag 0x05)",
      }

      saveAndSetAccount(newAcc)
      setShowJwtInput(false)
      setJwtInput("")
    } catch (err: any) {
      console.error("JWT parse error:", err)
      setErrorMessage(`Google JWT 解析失败: ${err.message || String(err)}。请确认输入的是合法的 Google ID Token。`)
    } finally {
      setIsProcessing(false)
      setProcessStep("")
    }
  }

  const handleTriggerRealGoogleOAuth = async () => {
    setIsProcessing(true)
    setErrorMessage(null)
    setProcessStep("正在生成 Ephemeral Ed25519 临时密钥对并计算 Nonce...")

    try {
      const { generateNonce, generateRandomness } = await import("@mysten/sui/zklogin")
      const { Ed25519Keypair } = await import("@mysten/sui/keypairs/ed25519")

      const ephemeralKeypair = new Ed25519Keypair()
      const randomness = generateRandomness()
      const maxEpoch = 1000

      const nonce = generateNonce(ephemeralKeypair.getPublicKey(), maxEpoch, randomness)

      sessionStorage.setItem("sui_ephemeral_key", ephemeralKeypair.getSecretKey())
      sessionStorage.setItem("sui_zklogin_randomness", randomness)
      sessionStorage.setItem("sui_zklogin_max_epoch", String(maxEpoch))

      const clientId = googleClientId.trim()
      if (!clientId) {
        setErrorMessage("请先在下方输入您的 Google Cloud OAuth Client ID，或者使用下方的【粘贴真实 Google JWT】/【离线密码学演示】。")
        setShowConfigClientId(true)
        setIsProcessing(false)
        setProcessStep("")
        return
      }

      localStorage.setItem("sui_google_client_id", clientId)

      const redirectUri = window.location.origin
      const oauthUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&response_type=id_token&redirect_uri=${encodeURIComponent(
        redirectUri
      )}&scope=openid%20email&nonce=${nonce}`

      window.location.href = oauthUrl
    } catch (err: any) {
      console.error("OAuth error:", err)
      setErrorMessage(`生成 OAuth Nonce 失败: ${err.message || String(err)}`)
      setIsProcessing(false)
      setProcessStep("")
    }
  }

  const handleZkLoginDemo = async (provider: "google" | "apple") => {
    setIsProcessing(true)
    setErrorMessage(null)
    setProcessStep("1/4 生成受限 Ephemeral Keypair (Ed25519)...")

    await new Promise((r) => setTimeout(r, 500))
    setProcessStep("2/4 计算 Nonce 并验证 OAuth OpenID 凭证...")

    await new Promise((r) => setTimeout(r, 600))
    setProcessStep("3/4 请求 Mysten Labs 零知识证明 (Groth16 Proof)...")

    await new Promise((r) => setTimeout(r, 700))
    setProcessStep("4/4 派生隐私 Sui 地址 (Flag 0x05)...")

    await new Promise((r) => setTimeout(r, 400))

    const newAcc: UserAccount = {
      type: "zklogin",
      provider: provider === "google" ? "Google" : "Apple",
      identifier: provider === "google" ? "alice.demo@gmail.com" : "alice.demo@icloud.com",
      address: "0x7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b",
      epochTtl: 2,
      authMethodLabel: `${provider === "google" ? "Google" : "Apple"} zkLogin (演示)`,
    }

    saveAndSetAccount(newAcc)
  }

  const handleCopyAddress = (addr: string) => {
    navigator.clipboard.writeText(addr)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const handleLogoutAction = () => {
    setInternalAccount(null)
    try {
      localStorage.removeItem("sui_active_account")
    } catch (e) {}
    onLogout?.()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[94vw] max-w-[400px] p-0 overflow-hidden border-border/70 bg-background text-foreground shadow-2xl rounded-2xl">
        {/* 顶部标题区 */}
        <div className="p-4 pb-3 border-b border-border/40">
          <DialogHeader>
            <DialogTitle className="text-base font-bold">
              {activeUser ? "当前账户" : "登录账户"}
            </DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              {activeUser ? "已连接到 Sui 网络" : "选择登录方式"}
            </DialogDescription>
          </DialogHeader>

          {/* 如果已登录，展示紧凑账户卡片 */}
          {activeUser && (
            <div className="mt-3 p-3 rounded-xl bg-muted/40 border border-border/60 flex items-center justify-between">
              <div className="min-w-0 pr-2">
                <div className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-emerald-500 shrink-0"></span>
                  <p className="font-semibold text-xs text-foreground truncate">{activeUser.identifier}</p>
                </div>
                <p className="text-[11px] text-muted-foreground font-mono mt-0.5 truncate">
                  {activeUser.address.slice(0, 10)}...{activeUser.address.slice(-6)}
                </p>
              </div>
              <div className="flex items-center space-x-1 shrink-0">
                <a
                  href={`https://suiscan.xyz/mainnet/account/${activeUser.address}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center justify-center h-7 w-7 rounded-lg hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                  title="在浏览器中查看"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                </a>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => handleCopyAddress(activeUser.address)}
                  className="h-7 w-7 rounded-lg"
                  title="复制地址"
                >
                  {copied ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={handleLogoutAction}
                  className="h-7 w-7 rounded-lg text-rose-500 hover:text-rose-600 hover:bg-rose-500/10"
                  title="退出登录"
                >
                  <LogOut className="w-3.5 h-3.5" />
                </Button>
              </div>
            </div>
          )}
        </div>

        {/* 错误提示横幅 */}
        {errorMessage && (
          <div className="mx-4 mt-3 p-2.5 rounded-xl bg-destructive/10 border border-destructive/20 text-xs text-destructive flex items-start gap-2">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <div className="flex-1 whitespace-pre-wrap">{errorMessage}</div>
          </div>
        )}

        {/* 处理中指示器 */}
        <AnimatePresence>
          {isProcessing && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="p-3 bg-muted/40 border-b border-border/40 space-y-1.5"
            >
              <div className="flex items-center justify-between text-xs text-foreground font-medium">
                <span className="flex items-center gap-1.5">
                  <RefreshCw className="w-3.5 h-3.5 animate-spin text-primary" />
                  {processStep || "正在连接..."}
                </span>
              </div>
              <Progress value={75} className="h-1" />
            </motion.div>
          )}
        </AnimatePresence>

        {/* 登录方式切换标签 */}
        {!activeUser && (
          <div className="p-4 pt-3">
            <Tabs
              value={activeTab}
              onValueChange={(v) => {
                setActiveTab(v as any)
                setErrorMessage(null)
              }}
              className="w-full"
            >
              <TabsList className="grid grid-cols-3 w-full h-9 bg-muted/60 p-0.5 rounded-xl">
                <TabsTrigger
                  id="tab-wallet"
                  value="wallet"
                  className="text-xs data-[state=active]:bg-background data-[state=active]:shadow-sm rounded-lg"
                >
                  扩展钱包
                </TabsTrigger>
                <TabsTrigger
                  id="tab-passkey"
                  value="passkey"
                  className="text-xs data-[state=active]:bg-background data-[state=active]:shadow-sm rounded-lg"
                >
                  面容 / 指纹
                </TabsTrigger>
                <TabsTrigger
                  id="tab-zklogin"
                  value="zklogin"
                  className="text-xs data-[state=active]:bg-background data-[state=active]:shadow-sm rounded-lg"
                >
                  Google
                </TabsTrigger>
              </TabsList>

              {/* 1. 扩展钱包 */}
              <TabsContent value="wallet" className="mt-3 space-y-2">
                {installedWallets.length > 0 && (
                  <div className="space-y-1.5 mb-2">
                    <p className="text-[11px] font-medium text-muted-foreground px-1">已检测到的钱包</p>
                    {installedWallets.map((wallet) => (
                      <Button
                        key={wallet.name}
                        variant="outline"
                        disabled={isProcessing}
                        onClick={() => handleConnectStandardWallet(wallet)}
                        className="w-full h-11 flex justify-between items-center px-3 border-border/80 hover:bg-muted/60 transition-all rounded-xl"
                      >
                        <div className="flex items-center space-x-2.5">
                          {wallet.icon ? (
                            <img src={wallet.icon} alt={wallet.name} className="w-5 h-5 rounded-md object-contain" />
                          ) : (
                            <Wallet className="w-4 h-4 text-primary" />
                          )}
                          <span className="font-semibold text-xs text-foreground">{wallet.name}</span>
                        </div>
                        <span className="text-xs font-medium text-primary">连接</span>
                      </Button>
                    ))}
                  </div>
                )}

                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-[11px] font-medium text-muted-foreground px-1">
                    <span>常见钱包</span>
                    {installedWallets.length === 0 && (
                      <button
                        type="button"
                        onClick={refreshInstalledWallets}
                        className="text-primary hover:underline flex items-center gap-1"
                      >
                        <RefreshCw className="w-2.5 h-2.5" /> 扫描
                      </button>
                    )}
                  </div>
                  {POPULAR_WALLETS.map((pw) => {
                    const isDetected = installedWallets.some((w) =>
                      pw.idMatch.some((m) => w.name?.toLowerCase().includes(m))
                    )
                    return (
                      <div
                        key={pw.name}
                        className="flex items-center justify-between p-2.5 rounded-xl border border-border/70 hover:bg-muted/30 transition-all"
                      >
                        <div className="flex items-center space-x-2.5">
                          <span className="text-lg leading-none">{pw.icon}</span>
                          <span className="font-medium text-xs text-foreground">{pw.name}</span>
                        </div>
                        {isDetected ? (
                          <Button
                            size="sm"
                            disabled={isProcessing}
                            onClick={() => handlePopularWalletClick(pw)}
                            className="h-7 text-xs px-3 rounded-lg"
                          >
                            连接
                          </Button>
                        ) : (
                          <div className="flex items-center space-x-1.5">
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={isProcessing}
                              onClick={() => handlePopularWalletClick(pw)}
                              className="h-7 text-xs px-2 text-muted-foreground hover:text-foreground"
                            >
                              检测
                            </Button>
                            <a
                              href={pw.installUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-1 text-[11px] h-7 px-2.5 rounded-lg border border-border/80 hover:bg-muted text-primary font-medium transition-all"
                            >
                              安装 <ExternalLink className="w-2.5 h-2.5" />
                            </a>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </TabsContent>

              {/* 2. 面容 / 指纹 (Passkey) */}
              <TabsContent value="passkey" className="mt-3 space-y-3">
                <Button
                  id="btn-login-passkey"
                  variant="outline"
                  disabled={isProcessing}
                  onClick={handlePasskeyLogin}
                  className="w-full h-14 flex items-center justify-between px-4 border-border/80 hover:bg-muted/50 rounded-xl transition-all"
                >
                  <div className="flex items-center space-x-3">
                    <div className="w-9 h-9 rounded-xl bg-purple-500/10 text-purple-600 flex items-center justify-center">
                      <Fingerprint className="w-5 h-5" />
                    </div>
                    <div className="text-left">
                      <p className="text-xs font-bold text-foreground">Touch ID / Face ID 登录</p>
                      <p className="text-[11px] text-muted-foreground">触碰指纹或面容识别即可一键完成登录</p>
                    </div>
                  </div>
                  <ArrowRight className="w-4 h-4 text-muted-foreground" />
                </Button>
              </TabsContent>

              {/* 3. Google (zkLogin) */}
              <TabsContent value="zklogin" className="mt-3 space-y-3">
                <Button
                  id="btn-login-google"
                  variant="outline"
                  disabled={isProcessing}
                  onClick={handleTriggerRealGoogleOAuth}
                  className="w-full h-12 flex items-center justify-between px-4 border-border/80 hover:bg-muted/50 rounded-xl transition-all"
                >
                  <div className="flex items-center space-x-3">
                    <div className="w-6 h-6 rounded-full bg-white shadow-sm flex items-center justify-center p-0.5">
                      <svg viewBox="0 0 24 24" className="w-4 h-4">
                        <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
                        <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                        <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z" />
                        <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z" />
                      </svg>
                    </div>
                    <p className="text-xs font-semibold text-foreground">使用 Google 账号继续</p>
                  </div>
                  <ArrowRight className="w-4 h-4 text-muted-foreground" />
                </Button>

                {/* 调试选项（折叠） */}
                <div className="pt-1">
                  <button
                    type="button"
                    onClick={() => setShowJwtInput(!showJwtInput)}
                    className="text-[10px] text-muted-foreground hover:text-foreground hover:underline"
                  >
                    {showJwtInput ? "收起调试选项" : "⚙️ 开发调试选项"}
                  </button>
                  {showJwtInput && (
                    <div className="mt-2 p-2.5 rounded-lg bg-muted/40 border border-border/80 space-y-2">
                      <Input
                        placeholder="输入 Google ID Token (JWT)"
                        value={jwtInput}
                        onChange={(e) => setJwtInput(e.target.value)}
                        className="h-8 text-xs font-mono"
                      />
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          disabled={!jwtInput.trim() || isProcessing}
                          onClick={() => handleProcessRealJwt(jwtInput.trim())}
                          className="flex-1 h-7 text-xs"
                        >
                          解析 Token
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={isProcessing}
                          onClick={() => handleZkLoginDemo("google")}
                          className="h-7 text-xs"
                        >
                          模拟测试
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              </TabsContent>
            </Tabs>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
