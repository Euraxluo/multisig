"use client";

import { useState, useEffect, useRef } from "react";
import { Input } from "@/components/ui/input";
import { readDkgSessionLink, saveDkgSessionLink, readQualifiedDealers } from "@/lib/dkg-local-session";
import { assembleDeviceKey } from "@/lib/dkg-key-package";
import { savePendingDeviceKey, readPendingDeviceKey, bindDeviceKey, readDeviceKey, saveDealerContribution, readDealerContribution, type BoundDeviceKey } from "@/lib/committee-device-store";
import { readDkgOrganizationCreation } from "@/lib/dkg-organization";
import { acknowledgePendingTransaction, getPendingTransaction, TransactionReceiptError, type PendingTransactionReceipt } from "@/lib/pending-transactions";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  ShieldCheck,
  Cpu,
  Network,
  CheckCircle2,
  RefreshCw,
  Sparkles,
  Lock,
  Layers,
  Clock,
  ExternalLink,
} from "lucide-react";
import { DKGParticipant } from "@/lib/crypto/ceremony";
import { useI18n } from "@/components/i18n-provider";
import { GennaroResharingParticipant } from "@/lib/crypto/resharing";
import { signWithCommittee, ThresholdSigningError } from "@/lib/crypto/committee-signing";
import { getCommitteeSession, setCommitteeSession, adoptLiveEpoch } from "@/lib/committee-session";
import { readLiveOrganization } from "@/lib/group-roster";
import { signAndExecuteWithWallet, resumePendingTransaction, getTransactionAccount, assertTransactionAccount } from "@/lib/sui-wallet-signer";
import { proposalClient } from "@/lib/proposal-chain";
import { MAX_ROSTER_MEMBERS } from "@/lib/group-roster";
import { computeThresholdApprovalDigest } from "@/lib/vault-client";
import { errorMessage as describeError } from "@/lib/error-message";
import { TESTNET_PACKAGE_ID, findCreatedProtocolObject, getActiveAccount, getUserGroups, persistGroupOrganization } from "@/lib/onchain-store";
import { ADMISSION_ECONOMICS } from "multisig/agent-vault/org";

const SESSION_CREATION_FEE_MIST = ADMISSION_ECONOMICS.SESSION_CREATION_FEE_MIST
const MIN_BOND_MIST = ADMISSION_ECONOMICS.MIN_BOND_MIST

/** Round1 须公布 32B attest 公钥；attest 阶段用对应私钥签名。
 *  按会话+地址持久化于 localStorage（密钥语义 = 会话级一次性，不与钱包钥复用）。 */
async function ensureAttestationSecretKey(sessionId: string, address: string): Promise<Uint8Array> {
  const storeKey = `dkg-attest-sk:${sessionId}:${address}`
  const skB64 = localStorage.getItem(storeKey)
  if (skB64) return Uint8Array.from(atob(skB64), (c) => c.charCodeAt(0))
  const sk = new Uint8Array(32)
  crypto.getRandomValues(sk)
  localStorage.setItem(storeKey, btoa(String.fromCharCode(...sk)))
  return sk
}

async function ensureAttestationKey(sessionId: string, address: string): Promise<Uint8Array> {
  const { ed25519 } = await import("@noble/curves/ed25519.js")
  return ed25519.getPublicKey(await ensureAttestationSecretKey(sessionId, address))
}
import { DKG_ATTESTATION_TYPE_ORIGIN, DKG_ENCRYPTION_KEY_TYPE_ORIGIN, DKG_TYPE_ORIGIN } from "@/lib/dkg-type-origin";
import { Transaction } from "@mysten/sui/transactions";
import { isValidSuiAddress, normalizeSuiAddress } from "@mysten/sui/utils";
import {
  DKG_STATUS, dkgSessionClient, encodeCommitments, readCommitment, readConfirmation,
  readGroupKeyAttestation, readMailboxShare, readSession,
} from "@/lib/dkg-session";
import { createEncryptionKeyReader, encryptionKeyClient, openShare, sealShare } from "@/lib/dkg-mailbox";
import { ensureMailboxKey, persistMailboxKey, readMailboxKey } from "@/lib/dkg-mailbox-keys";
import { bytesToScalar, scalarToBytes32 } from "@/lib/crypto/math";
import { bytesToHex } from "@/lib/crypto/bytes";
import { ed25519 } from "@noble/curves/ed25519.js";
import { verifyShareCommitment, type Point } from "@/lib/crypto/vss";

interface DkgCeremonyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groupName: string;
  groupId?: string;
  initialMembers: { name: string; address: string; weight: number }[];
  onConvertedSuccess?: (groupPk: string, orgId: string, txDigest?: string) => void;
}

type CeremonyStep =
  | "INIT"
  | "ROUND_1_COMMITMENTS"
  | "ROUND_2_SHARES"
  | "COMPUTING_PK"
  | "DEPLOYING_ONCHAIN"
  | "COMPLETE"
  | "RESHARING_ACTIVE";

export function DkgCeremonyDialog({ open, onOpenChange, groupId, initialMembers, onConvertedSuccess }: DkgCeremonyDialogProps) {
  const { t } = useI18n();
  const [step, setStep] = useState<CeremonyStep>("INIT");
  const [progress, setProgress] = useState(0);
  const [activeLog, setActiveLog] = useState<string>(t("dkg.logWaiting"));
  const [groupPk, setGroupPk] = useState<string>("");
  const [orgObjectId, setOrgObjectId] = useState<string>("");
  const [txDigest, setTxDigest] = useState<string>("");
  const [suiscanTxUrl, setSuiscanTxUrl] = useState<string>("");
  const [suiscanOrgUrl, setSuiscanOrgUrl] = useState<string>("");
  const [epoch, setEpoch] = useState<number>(1);

  // 保存 DKG 分片以供 Resharing 门限签名使用
  const [storedShares, setStoredShares] = useState<bigint[]>([]);
  const [storedPkBytes, setStoredPkBytes] = useState<Uint8Array | null>(null);

  // 限时加入：发起后 X 秒内未签名者被排除，到期可强制固化
  const [deadlineTs, setDeadlineTs] = useState<number | null>(null);
  const [nowTs, setNowTs] = useState<number>(Date.now());
  const [memberSigned, setMemberSigned] = useState<Record<string, boolean>>({});
  const [onChainSessionId, setOnChainSessionId] = useState<string | null>(null);
  // The dealer's secret polynomial must survive between the commitment phase and
  // the share phase: re-deriving it would publish commitments for a polynomial
  // whose shares were never sent, and re-submitting aborts (E_ALREADY_SUBMITTED).
  // A reload clears this, which is reported instead of silently restarting.
  const dealerRef = useRef<{ sessionId: string; holder: string; node: DKGParticipant } | null>(null);
  const generation = useRef(0);
  const [sessionInput, setSessionInput] = useState("");
  const [creationInput, setCreationInput] = useState("");
  const [deviceKey, setDeviceKey] = useState<BoundDeviceKey | null>(null);
  const [pendingDeviceKey, setPendingDeviceKey] = useState<Awaited<ReturnType<typeof readPendingDeviceKey>>>(null);
  const [deviceKeyError, setDeviceKeyError] = useState("");

  useEffect(() => {
    const invalidate = () => { generation.current++; dealerRef.current = null; setDeviceKey(null); setDeviceKeyError(""); };
    window.addEventListener("sui-account-switched", invalidate);
    invalidate();
    return () => { generation.current++; window.removeEventListener("sui-account-switched", invalidate); };
  }, [groupId]);

  // 异步信箱状态
  // Resharing 状态
  const [reshareLog, setReshareLog] = useState<string>("");
  const [reshareTxDigest, setReshareTxDigest] = useState<string>("");
  const [suiscanReshareTxUrl, setSuiscanReshareTxUrl] = useState<string>("");
  const [isResharingBusy, setIsResharingBusy] = useState(false);

  // 倒计时 tick
  useEffect(() => {
    if (!deadlineTs) return
    const id = window.setInterval(() => setNowTs(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [deadlineTs])

  // `null` = not checked yet, so the panel never claims deployment from a
  // local record alone. The mount restore below sets this from a real
  // `getObject` on the organization.
  const [orgChainCheck, setOrgChainCheck] = useState<{ state: "pending" | "verified" | "failed"; error?: string }>({ state: "pending" });

  // 挂载时尝试从 localStorage 恢复已有 DAO 状态
  useEffect(() => {
    if (typeof window === "undefined" || !groupId) return;
    const restore = () => {
      try {
        const run = generation.current;
        const holder = getActiveAccount()?.address;
        const sessionId = holder && groupId ? readDkgSessionLink(groupId, holder) : null;
        if (sessionId) void readSession(dkgSessionClient, sessionId).then(session => {
          if (run !== generation.current) return;
          setOnChainSessionId(session.sessionId); setSessionInput(session.sessionId);
          const active = getActiveAccount();
          if (active) void readPendingDeviceKey(session.sessionId, normAddress(active.address, t("dkg.addrInvalid"))).then(key => { if (run === generation.current) setPendingDeviceKey(key); });
          setDeadlineTs(Number(session.deadlineTimestampMs));
        }).catch((error: unknown) => { if (run === generation.current) setActiveLog(describeError(error, t("dkg.restoreReadFailed"))); });
        const group = getUserGroups().find(value => value.id === groupId)
        if (!group?.orgObjectId) return
        const raw = JSON.parse(localStorage.getItem(`dao_org_${groupId}`) || "null")
        const saved = raw?.orgObjectId === group.orgObjectId ? raw : {}
        setOrgObjectId(group.orgObjectId)
        setGroupPk(group.groupPk || "")
        setTxDigest(group.orgTxDigest || "")
        setSuiscanTxUrl(group.orgTxDigest ? `https://suiscan.xyz/testnet/tx/${group.orgTxDigest}` : "")
        setSuiscanOrgUrl(`https://suiscan.xyz/testnet/object/${group.orgObjectId}`)
        setEpoch(group.epoch || 1)
        setReshareTxDigest(saved.reshareTxDigest || "")
        setSuiscanReshareTxUrl(saved.reshareTxDigest ? `https://suiscan.xyz/testnet/tx/${saved.reshareTxDigest}` : "")
        // Shares live in this tab's module memory rather than localStorage, so a
        // closed dialog can still see them; a reload cannot.
        const held = getCommitteeSession(group.orgObjectId)
        setStoredShares(held?.shares ?? [])
        setStoredPkBytes(held?.groupPk ?? null)
        setStep("COMPLETE")
        setActiveLog(t("dkg.logRestored"));
        const keyRun = generation.current;
        if (holder) void readDeviceKey(group.orgObjectId, holder).then(key => {
          if (keyRun !== generation.current) return;
          setDeviceKey(key);
          if (key) setOnChainSessionId(key.sessionId);
        }).catch((error: unknown) => { if (keyRun === generation.current) setDeviceKeyError(describeError(error, t("dkg.deviceKeyReadFailed"))); });
        // The COMPLETE panel says "deployed on chain". That is a chain fact, so
        // it is read from chain rather than inferred from a saved object id.
        const orgId = group.orgObjectId
        setOrgChainCheck({ state: "pending" })
        void readLiveOrganization(proposalClient, orgId).then(live => {
          setOrgChainCheck({ state: "verified" })
          setEpoch(Number(live.epoch))
        }).catch((error: unknown) => {
          setOrgChainCheck({ state: "failed", error: error instanceof Error ? error.message : t("dkg.orgReadFailed") })
        })
      } catch (error) { console.warn("Failed to restore DAO state", error) }
    }
    setStep("INIT"); setOrgObjectId(""); setGroupPk(""); setTxDigest("")
    setStoredShares([]); setStoredPkBytes(null)
    setDeadlineTs(null); setOnChainSessionId(null); setMemberSigned({})
    restore()
    window.addEventListener("sui-groups-updated", restore)
    return () => window.removeEventListener("sui-groups-updated", restore)
  }, [groupId]);

  const loadSession = async () => {
    const account = getTransactionAccount();
    const run = generation.current;
    try {
      const session = await readSession(dkgSessionClient, normAddress(sessionInput, t("dkg.sessionIdInvalid")));
      assertTransactionAccount(account);
      if (run !== generation.current) return;
      if (!session.participants.includes(account.address)) throw new Error(t("dkg.notOriginalParticipant"));
      if (groupId) saveDkgSessionLink(groupId, account.address, session.sessionId);
      dealerRef.current = null;
      setOnChainSessionId(session.sessionId); setSessionInput(session.sessionId); setDeadlineTs(Number(session.deadlineTimestampMs));
      setPendingDeviceKey(await readPendingDeviceKey(session.sessionId, account.address));
      setStep("INIT"); setActiveLog(t("dkg.logSessionLoaded", { status: session.status, threshold: String(session.threshold), participants: session.participants.length }));
    } catch (error) { setActiveLog(describeError(error, t("dkg.sessionReadFailed"))); }
  };

  /** Normalizes an address for both PTB arguments and on-chain comparisons. */
  const normAddress = (value: string, message: string) => {
    try {
      const normalized = normalizeSuiAddress(String(value ?? "").trim())
      if (!isValidSuiAddress(normalized)) throw new Error(message)
      return normalized
    } catch {
      throw new Error(message)
    }
  }
  const shortAddr = (value: string) => `${value.slice(0, 6)}…${value.slice(-4)}`

  // `scalarToBytes32` is little-endian; the peer must decode with the same
  // helper, so never hand-roll this encoding elsewhere.
  const shareToBytes = (share: bigint): Uint8Array => scalarToBytes32(share)

  const encryptionKeys = createEncryptionKeyReader(encryptionKeyClient, TESTNET_PACKAGE_ID, DKG_ENCRYPTION_KEY_TYPE_ORIGIN)
  const readEncryptionKey = (sessionId: string, participant: string) => encryptionKeys.readKey(sessionId, participant)

  // 当前钱包在链上 confirm_participant 由 handleConfirmWithShares 完成：
  // 它必须先解封并校验收到的份额，才允许确认，单删掉这里的重复调用是刻意的。

  /**
   * Real turn: every round is a chain transaction, and each participant's
   * commitment and sealed shares are read back from the session object.
   *
   * The previous implementation generated all participants' polynomials in this
   * one tab, never called `submit_commitment`, and jumped straight to finalize
   * — which aborts 3002 because the session is still in ROUND_1_COMMITMENTS. It
   * also returned before reaching that code whenever a session already existed,
   * so the "finish" click actually just timed the session out. Both are gone:
   * phases advance only when chain state advances.
   */
  const handleStartDkg = async () => {
    if (!groupId || !getUserGroups().some(group => group.id === groupId)) {
      setActiveLog(t("dkg.groupMissing"))
      return
    }
    const me = getActiveAccount()
    if (!me) { setActiveLog(t("dkg.connectWalletFirst")); return }

    // Phase 0: create the session. Nothing else may run until it exists.
    if (!deadlineTs) {
      setStep("DEPLOYING_ONCHAIN"); setProgress(10)
      setActiveLog(t("dkg.logCreatingSession"))
      try {
        const participants = initialMembers.map((m) => normAddress(m.address, t("dkg.memberAddrInvalid", { address: m.address })))
        const threshold = Math.max(1, Math.min(participants.length, Math.ceil(participants.length * 0.6)))
        // 准入经济学（#16）：deadline 钳制 [10min,7d]，创建费 0.005 SUI 销毁，bond 地板 0.05 SUI
        const deadlineMs = Date.now() + 30 * 60 * 1000
        const tx = new Transaction()
        const [creationFee] = tx.splitCoins(tx.gas, [BigInt(SESSION_CREATION_FEE_MIST)])
        tx.moveCall({
          target: `${TESTNET_PACKAGE_ID}::dkg_committee::create_dkg_session`,
          typeArguments: [],
          arguments: [tx.pure.u64(BigInt(threshold)), tx.pure.vector('address', participants), tx.pure.u64(BigInt(deadlineMs)), creationFee, tx.object("0x6")],
        })
        const { digest, createdObjects } = await signAndExecuteWithWallet(tx)
        const sessionId = await findCreatedProtocolObject(createdObjects, "dkg_committee", "DkgSession");
        setOnChainSessionId(sessionId); setSessionInput(sessionId);
        saveDkgSessionLink(groupId, me.address, sessionId);
        setDeadlineTs(deadlineMs); setNowTs(Date.now())
        setStep("INIT"); setProgress(0)
        setActiveLog(t("dkg.logSessionCreated", { digest: digest.slice(0, 10) }))
      } catch (err) {
        setStep("INIT"); setActiveLog(t("dkg.logStartFailed", { error: describeError(err, String(err)) }))
      }
      return
    }

    if (!onChainSessionId) { setActiveLog(t("dkg.sessionMissing")); return }
    if (nowTs >= deadlineTs) {
      setActiveLog(t("dkg.deadlinePassed"))
      return
    }

    const account = getTransactionAccount();
    const run = generation.current;
    const check = () => { assertTransactionAccount(account); if (run !== generation.current) throw new Error(t("dkg.contextSwitched")); };
    const mine = normAddress(me.address, t("dkg.walletAddrInvalid"));

    try {
      const session = await readSession(dkgSessionClient, onChainSessionId);
      check();
      if (!session.participants.includes(mine)) throw new Error(t("dkg.notParticipant"));
      const myIndex = BigInt(session.participants.indexOf(mine) + 1);
      const thresholdN = Number(session.threshold);
      const nodeCount = session.participants.length;

      // Phase 1: publish this participant's commitment, advancing the session to
      // ROUND_2_MAILBOX once the threshold of commitments is on chain.
      if (session.status === DKG_STATUS.ROUND_1_COMMITMENTS) {
        if (await readCommitment(dkgSessionClient, session, mine)) {
          setActiveLog(t("dkg.logAlreadyCommitted"))
          return
        }
        setStep("ROUND_1_COMMITMENTS"); setProgress(20)
        setActiveLog(t("dkg.logRound1"))
        const node = new DKGParticipant(`M${myIndex}`, myIndex, thresholdN, nodeCount)
        session.participants.forEach((participant, index) => {
          if (participant !== mine) node.registerPeerIndex(`M${index + 1}`, BigInt(index + 1))
        })
        const previous = await readDealerContribution(session.sessionId, mine);
        if (previous) throw new Error(t("dkg.dealerContributionExists"));
        const r1 = node.round1();
        await saveDealerContribution({ sessionId: session.sessionId, holder: mine, index: myIndex, commitments: r1.commitmentBytes, share: node.evaluateShareForIndex(myIndex) });
        dealerRef.current = { sessionId: session.sessionId, holder: mine, node };
        check();
        // 准入经济学：bond 0.05 SUI 随承诺原子托管（finalize/timeout 后 claim_bond 全额退款）；
        // attest 公钥须在 Round1 公布（attest 时用它对 H(SUI_DKG_ATTEST_V1‖sid‖groupPk) 验签）。
        const attestKeyBytes = await ensureAttestationKey(onChainSessionId, mine)
        const tx = new Transaction()
        const [bondCoin] = tx.splitCoins(tx.gas, [BigInt(MIN_BOND_MIST)])
        tx.moveCall({
          target: `${TESTNET_PACKAGE_ID}::dkg_committee::submit_commitment`,
          typeArguments: [],
          arguments: [tx.object(onChainSessionId), tx.object("0x6"), tx.pure.vector('u8', Array.from(encodeCommitments(r1.commitmentBytes))), tx.pure.vector('u8', Array.from(attestKeyBytes)), bondCoin],
        })
        const { digest } = await signAndExecuteWithWallet(tx)
        setStep("INIT"); setProgress(0)
        setActiveLog(t("dkg.logCommitted", { digest: digest.slice(0, 10) }))
        return
      }

      // Phase 2: register the mailbox key, then seal every participant's share
      // to their registered key and deposit it. No plaintext ever leaves memory.
      if (session.status === DKG_STATUS.ROUND_2_MAILBOX) {
        if (!(await readCommitment(dkgSessionClient, session, mine))) {
          setActiveLog(t("dkg.logNotDealer")); return;
        }
        const pending = []
        for (const participant of session.participants) {
          if (participant === mine) continue
          if (!(await readMailboxShare(dkgSessionClient, session, DKG_TYPE_ORIGIN, mine, participant))) pending.push(participant)
        }
        if (pending.length === 0) { setActiveLog(t("dkg.logAllDeposited")); return }
        setStep("ROUND_2_SHARES"); setProgress(45)
        setActiveLog(t("dkg.logRound2", { count: pending.length }))
        const result = await sealAndDepositShares({ session, mine, myIndex, thresholdN, nodeCount, pending })
        setStep("INIT"); setProgress(0)
        setActiveLog(t("dkg.logDeposited", { count: result.deposited, digest: result.digest.slice(0, 10) }) + (result.skipped.length ? t("dkg.logSkippedNoKey", { count: result.skipped.length, list: result.skipped.map(s => shortAddr(s)).join("、") }) : "") + (result.unusable.length ? t("dkg.logUnusableKeys", { count: result.unusable.length, list: result.unusable.join("、") }) : ""))
        return
      }

      if (session.status === DKG_STATUS.FINALIZED) {
        setActiveLog(t("dkg.logAlreadyFinalized"))
        return
      }
      setActiveLog(t("dkg.logStatusStuck", { status: session.status }))
    } catch (err) {
      console.error("DKG phase error:", err)
      setStep("INIT"); setProgress(0)
      setActiveLog(t("dkg.logPhaseFailed", { error: describeError(err, String(err)) }))
    }
  }

  /**
   * Seal one share per recipient to their registered P-256 key and deposit them
   * in a single PTB.
   *
   * This uses `deposit_mailbox_share` for each recipient rather than
   * `submit_async_package`: the commitment was already published in phase 1, and
   * `submit_async_package` would call `submit_commitment` again, aborting with
   * E_ALREADY_SUBMITTED (3003). The dealer polynomial therefore has to be the one
   * retained from phase 1 — a recipient who has not registered a key is
   * reported, never downgraded to plaintext.
   */
  const sealAndDepositShares = async (args: {
    session: Awaited<ReturnType<typeof readSession>>
    mine: string; myIndex: bigint; thresholdN: number; nodeCount: number; pending: string[]
  }) => {
    const { session, mine, pending } = args
    const held = dealerRef.current;
    if (!held || held.sessionId !== session.sessionId || held.holder !== mine) {
      throw new Error(t("dkg.dealerPolynomialMissing"));
    }
    const node = held.node;
    const ownCommitment = await readCommitment(dkgSessionClient, session, mine);
    const own = await readDealerContribution(session.sessionId, mine);
    if (!ownCommitment || !own || bytesToHex(ownCommitment) !== bytesToHex(encodeCommitments(own.commitments))) throw new Error(t("dkg.dealerCommitmentMismatch"));
    const shares = node.round2();

    const recipients: string[] = []
    const payloads: Uint8Array[] = []
    const skipped: string[] = []
    /** Registered but unusable keys: length-valid, not a usable curve point. */
    const unusable: string[] = []
    for (const participant of session.participants) {
      if (participant === mine) continue
      if (!pending.includes(participant)) continue
      const key = await readEncryptionKey(session.sessionId, participant)
      if (!key) { skipped.push(participant); continue }
      const index = BigInt(session.participants.indexOf(participant) + 1)
      const share = shares.get(`M${index}`)
      if (share === undefined) { skipped.push(participant); continue }
      // `register_encryption_key` only checks the byte length, so a registered
      // value can be off-curve. WebCrypto then throws on import. Letting that
      // propagate aborted the whole batch — one bad recipient cost every other
      // recipient their share. Skip just that one and report it.
      let sealed: Awaited<ReturnType<typeof sealShare>>
      try {
        sealed = await sealShare(shareToBytes(share), key, {
          sessionId: session.sessionId, sender: mine, recipient: participant, epoch: Number(session.epoch),
        })
      } catch (error) {
        unusable.push(`${shortAddr(participant)}（${error instanceof Error ? error.message : t("dkg.keyUnusableForEncryption")}）`)
        continue
      }
      recipients.push(participant); payloads.push(sealed.bytes)
    }
    if (payloads.length === 0) throw new Error(t("dkg.noRecipientsRegistered"))

    const tx = new Transaction()
    recipients.forEach((recipient, index) => {
      tx.moveCall({
        target: `${TESTNET_PACKAGE_ID}::dkg_committee::deposit_mailbox_share`,
        typeArguments: [],
        arguments: [
          tx.object(session.sessionId), tx.object("0x6"),
          tx.pure.address(recipient), tx.pure.vector('u8', Array.from(payloads[index])),
        ],
      })
    })
    const { digest } = await signAndExecuteWithWallet(tx)
    return { digest, deposited: payloads.length, skipped, unusable }
  }

  /**
   * Create (or load) this device's mailbox key and publish its public half on
   * the session, so other participants can seal shares to it.
   *
   * The key is created locally and stored non-extractable; only the public point
   * goes on chain.
   */
  const handleRegisterMailboxKey = async () => {
    if (!onChainSessionId) { setActiveLog(t("dkg.sessionMissing")); return }
    const me = getActiveAccount()
    if (!me) { setActiveLog(t("dkg.connectWallet")); return }
    const mine = normAddress(me.address, t("dkg.walletAddrInvalid"))
    try {
      setActiveLog(t("dkg.logPreparingKey"))
      const session = await readSession(dkgSessionClient, onChainSessionId)
      if (session.status !== DKG_STATUS.ROUND_1_COMMITMENTS && session.status !== DKG_STATUS.ROUND_2_MAILBOX) {
        setActiveLog(t("dkg.logKeyRegistrationClosed", { status: session.status }))
        return
      }
      const onChain = await readEncryptionKey(session.sessionId, mine)
      if (onChain) {
        setActiveLog(t("dkg.logKeyAlreadyRegistered"))
        return
      }
      // Pass what was actually read, not `null`: `ensureMailboxKey` refuses on a
      // mismatch, and `null` silently disabled that guard.
      const { key, created } = await ensureMailboxKey(session.sessionId, mine, onChain)
      const tx = new Transaction()
      tx.moveCall({
        target: `${TESTNET_PACKAGE_ID}::dkg_committee::register_encryption_key`,
        typeArguments: [],
        arguments: [tx.object(session.sessionId), tx.object("0x6"), tx.pure.vector('u8', Array.from(key.publicKey))],
      })
      const { digest } = await signAndExecuteWithWallet(tx)
      // Persist only now: a key written before the transaction lands is a key
      // that can never be used, and would shadow whatever another tab
      // registered first (registration is once-only on chain).
      if (created) await persistMailboxKey(session.sessionId, mine, key as Parameters<typeof persistMailboxKey>[2])
      setActiveLog(t("dkg.logKeyRegistered", { digest: digest.slice(0, 10) }))
    } catch (err) {
      console.error("register key error:", err)
      setActiveLog(t("dkg.logKeyRegisterFailed", { error: describeError(err, String(err)) }))
    }
  }

  /**
   * Verify every dealer in the chain-frozen qualified set, persist this device's
   * aggregate share locally, then confirm on chain.
   */
  const handleConfirmWithShares = async () => {
    if (!onChainSessionId) { setActiveLog(t("dkg.sessionMissing")); return }
    const me = getActiveAccount()
    if (!me) { setActiveLog(t("dkg.connectWallet")); return }
    const account = getTransactionAccount()
    const run = generation.current
    const check = () => { assertTransactionAccount(account); if (run !== generation.current) throw new Error(t("dkg.contextSwitched")); }
    const mine = normAddress(me.address, t("dkg.walletAddrInvalid"))
    try {
      setStep("ROUND_2_SHARES"); setProgress(60)
      setActiveLog(t("dkg.logReadingDealers"))
      const session = await readSession(dkgSessionClient, onChainSessionId)
      check()
      if (session.status !== DKG_STATUS.ROUND_2_MAILBOX) {
        setActiveLog(t("dkg.logNotMailboxPhase", { status: session.status }))
        setStep("INIT"); return
      }
      const participantPosition = session.participants.indexOf(mine)
      if (participantPosition < 0) { setActiveLog(t("dkg.notInParticipants")); return }
      const myIndex = BigInt(participantPosition + 1)

      const dealers = await readQualifiedDealers(dkgSessionClient, session)
      check()
      const dealerSet = new Set(dealers.map(dealer => dealer.address))
      const localDealer = dealerSet.has(mine) ? await readDealerContribution(session.sessionId, mine) : null
      if (dealerSet.has(mine) && !localDealer) {
        throw new Error(t("dkg.dealerLocalMissing"))
      }
      const recipients = dealers.filter(dealer => dealer.address !== mine)
      let privateKey: CryptoKey | null = null
      if (recipients.length > 0) {
        const registered = await readEncryptionKey(session.sessionId, mine)
        if (!registered) {
          setActiveLog(t("dkg.logKeyNotRegistered"))
          setStep("INIT"); return
        }
        // Opening shares requires this device's non-extractable mailbox key.
        const local = await readMailboxKey(session.sessionId, mine)
        if (!local) {
          setActiveLog(t("dkg.logMailboxKeyMissing"))
          setStep("INIT"); return
        }
        if (local.publicKey.some((byte, index) => byte !== registered[index])) {
          setActiveLog(t("dkg.logMailboxKeyMismatch"))
          setStep("INIT"); return
        }
        privateKey = local.privateKey
      }

      const missing: string[] = []
      const broken: string[] = []
      const dealerShares: Array<{ address: string; commitments: Uint8Array[]; share: bigint }> = []
      for (const dealer of dealers) {
        check()
        if (dealer.address === mine) {
          const contribution = localDealer
          if (!contribution || contribution.sessionId !== session.sessionId || contribution.holder !== mine || contribution.index !== myIndex) {
            throw new Error(t("dkg.contributionContextMismatch"))
          }
          const raw = await readCommitment(dkgSessionClient, session, mine)
          if (!raw || bytesToHex(raw) !== bytesToHex(encodeCommitments(contribution.commitments))) {
            throw new Error(t("dkg.contributionFrozenMismatch"))
          }
          dealerShares.push({ address: mine, commitments: dealer.commitments, share: contribution.share })
          continue
        }
        const sealed = await readMailboxShare(dkgSessionClient, session, DKG_TYPE_ORIGIN, dealer.address, mine)
        if (!sealed) { missing.push(dealer.address); continue }
        let value: bigint
        try {
          const share = await openShare(sealed, privateKey!, {
            sessionId: session.sessionId, sender: dealer.address, recipient: mine, epoch: Number(session.epoch),
          })
          value = bytesToScalar(share)
          const points: Point[] = dealer.commitments.map(bytes => ed25519.Point.fromBytes(bytes))
          if (!verifyShareCommitment(value, myIndex, points)) throw new Error(t("dkg.shareCommitmentMismatch"))
        } catch (error) {
          broken.push(`${shortAddr(dealer.address)}（${error instanceof Error ? error.message : t("dkg.envelopeUnverifiable")}）`)
          continue
        }
        dealerShares.push({ address: dealer.address, commitments: dealer.commitments, share: value })
      }
      if (missing.length > 0) {
        setActiveLog(t("dkg.logMissingShares", { count: missing.length, list: missing.map(shortAddr).join("、") }))
        setStep("INIT"); return
      }
      if (broken.length > 0) {
        setActiveLog(t("dkg.logBrokenShares", { count: broken.length, list: broken.join("、") }))
        setStep("INIT"); return
      }
      if (dealerShares.length !== dealers.length) throw new Error(t("dkg.sharesIncomplete"))

      const key = assembleDeviceKey({
        sessionId: session.sessionId, holder: mine, participantAddresses: session.participants,
        threshold: session.threshold, sessionEpoch: session.epoch, dealers: dealerShares,
      })
      check()
      // The share is LOCAL custody. Persist it before the irreversible on-chain
      // confirmation so storage failure can never create an unbacked confirmation.
      await savePendingDeviceKey(key)
      setPendingDeviceKey(key)
      check()
      const alreadyConfirmed = await readConfirmation(dkgSessionClient, session, mine)
      if (alreadyConfirmed) {
        setMemberSigned(prev => ({ ...prev, [mine]: true }))
        setStep("INIT"); setProgress(0)
        setActiveLog(t("dkg.logAlreadyConfirmed", { dealers: dealers.length }))
        return
      }
      const tx = new Transaction()
      tx.moveCall({
        target: `${TESTNET_PACKAGE_ID}::dkg_committee::confirm_participant`,
        typeArguments: [],
        arguments: [tx.object(session.sessionId), tx.object("0x6")],
      })
      check()
      const { digest } = await signAndExecuteWithWallet(tx)
      check()
      setMemberSigned(prev => ({ ...prev, [mine]: true }))
      setStep("INIT"); setProgress(0)
      setActiveLog(t("dkg.logConfirmed", { count: dealerShares.length, digest: digest.slice(0, 10) }))
    } catch (err) {
      console.error("confirm error:", err)
      setStep("INIT"); setProgress(0)
      setActiveLog(t("dkg.logConfirmFailed", { error: describeError(err, String(err)) }))
    }
  }

  const createOrRecoverOrganization = async (session: Awaited<ReturnType<typeof readSession>>, allowCreate: boolean) => {
    if (!groupId) throw new Error(t("dkg.groupMissingUnsafe"));
    const account = getTransactionAccount();
    const run = generation.current;
    const check = () => { assertTransactionAccount(account); if (run !== generation.current) throw new Error(t("dkg.contextSwitched")); };
    const intent = { account, action: "dkg-organization-create", scope: session.sessionId, network: "testnet" as const, metadata: { sessionId: session.sessionId } };
    const pending = getPendingTransaction(intent);
    let digest = creationInput.trim();
    let receipt: PendingTransactionReceipt | undefined;
    if (pending) {
      if (digest && pending.digest && digest !== pending.digest) throw new TransactionReceiptError(t("dkg.digestMismatchPending"), pending);
      if (digest && !pending.digest) throw new TransactionReceiptError(t("dkg.pendingNoDigest"), pending);
      digest = pending.digest ?? "";
      receipt = pending;
      if (!digest) throw new TransactionReceiptError(t("dkg.pendingUnclearNoDigest"), pending);
      const recovered = await resumePendingTransaction(pending);
      check();
      receipt = recovered.receipt;
      digest = recovered.digest;
    } else if (!digest) {
      if (!allowCreate) throw new Error(t("dkg.finalizedNeedsDigest"));
      const tx = new Transaction();
      tx.moveCall({
        target: `${TESTNET_PACKAGE_ID}::cryptographic_org::create_organization_from_session`,
        typeArguments: [],
        arguments: [tx.object(session.sessionId), tx.pure.u64(session.threshold), tx.object("0x6")],
      });
      setStep("DEPLOYING_ONCHAIN"); setProgress(88);
      setActiveLog(t("dkg.logCreatingOrg"));
      const created = await signAndExecuteWithWallet(tx, { action: intent.action, scope: intent.scope, expectedAccount: account, metadata: intent.metadata });
      check();
      receipt = created.receipt;
      digest = created.digest;
    }
    if (!/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(digest)) throw new Error(t("dkg.needFullDigest"));
    setCreationInput(digest);
    const live = await readDkgOrganizationCreation(digest, session);
    check();
    if (!live.members.some(member => member.address === account.address)) throw new Error(t("dkg.walletNotInRoster"));
    const pendingKey = await readPendingDeviceKey(session.sessionId, account.address);
    if (pendingKey) {
      if (pendingKey.holder !== account.address || pendingKey.sessionId !== session.sessionId || pendingKey.sessionEpoch !== session.epoch) throw new Error(t("dkg.pendingKeyMismatch"));
      const bound = await bindDeviceKey({ sessionId: session.sessionId, holder: account.address, orgId: live.orgId, epoch: live.epoch, creationDigest: digest, groupPk: live.groupPk });
      setDeviceKey(bound);
    } else {
      const existing = await readDeviceKey(live.orgId, account.address);
      if (existing && (existing.sessionId !== session.sessionId || existing.creationDigest !== digest || existing.epoch !== live.epoch)) throw new Error(t("dkg.boundKeyMismatch"));
      setDeviceKey(existing);
    }
    persistGroupOrganization(groupId, { orgObjectId: live.orgId, groupPk: `0x${bytesToHex(live.groupPk)}`, epoch: Number(live.epoch), txDigest: digest, createdAt: Date.now(), dkgSessionId: session.sessionId });
    check();
    if (receipt && receipt.status === "success") acknowledgePendingTransaction(receipt);
    setOrgObjectId(live.orgId); setGroupPk(`0x${bytesToHex(live.groupPk)}`); setEpoch(Number(live.epoch));
    setTxDigest(digest); setSuiscanTxUrl(`https://suiscan.xyz/testnet/tx/${digest}`); setSuiscanOrgUrl(`https://suiscan.xyz/testnet/object/${live.orgId}`);
    setOrgChainCheck({ state: "verified" }); setStep("COMPLETE"); setProgress(0);
    onConvertedSuccess?.(`0x${bytesToHex(live.groupPk)}`, live.orgId, digest);
    setActiveLog(t("dkg.logOrgVerified", { digest: digest.slice(0, 10), org: live.orgId.slice(0, 10) }) + (pendingKey ? t("dkg.logOrgVerifiedBound") : t("dkg.logOrgVerifiedNoKey")));
  };

  /**
   * Attest and finalize the group key, then create the organization.
   *
   * Since package v6 the trust anchor is member attestation, not the caller:
   * `finalize_session` refuses unless `threshold` *confirmed* participants
   * each wrote the same key into their own `GroupKeyAttestationSlot`. The key
   * itself is never taken from the finalize caller — the client recomputes
   * `Σ C_0` from the on-chain commitments and attests that value, so a caller
   * cannot finalize a key the committee did not deal. The two older entry
   * points still exist (published functions cannot be removed) but abort 3013.
   */
  const handleFinalize = async (createFromFinalized = false) => {
    if (!onChainSessionId || !groupId) { setActiveLog(t("dkg.sessionOrGroupMissing")); return }
    const me = getActiveAccount()
    if (!me) { setActiveLog(t("dkg.connectWallet")); return }
    try {
      setStep("COMPUTING_PK"); setProgress(80)
      setActiveLog(t("dkg.logRecomputing"))
      let session = await readSession(dkgSessionClient, onChainSessionId)
      const account = getTransactionAccount();
      const run = generation.current;
      const check = () => { assertTransactionAccount(account); if (run !== generation.current) throw new Error(t("dkg.contextSwitched")); };
      check();
      const finalizeIntent = { account, action: "dkg-session-finalize", scope: session.sessionId, network: "testnet" as const, metadata: { sessionId: session.sessionId } };
      let finalizationReceipt: PendingTransactionReceipt | undefined;
      const pendingFinalize = getPendingTransaction(finalizeIntent);
      if (pendingFinalize) {
        const recovered = await resumePendingTransaction(pendingFinalize);
        check();
        finalizationReceipt = recovered.receipt;
        session = await readSession(dkgSessionClient, session.sessionId);
        check();
      }

      // The group key is the sum of every dealer's constant commitment term.
      // Recomputing it from chain data is what each member attests to, and it
      // is the only value `finalize_session` will accept from a quorum.
      const recomputeGroupPk = async (): Promise<Uint8Array> => {
        // Q is frozen when ROUND_2_MAILBOX begins. A participant without a
        // commitment remains eligible to hold a share, but contributes nothing
        // to the aggregate key and must not block n>t sessions.
        const dealers = await readQualifiedDealers(dkgSessionClient, session)
        const constants = dealers.map(dealer => ed25519.Point.fromBytes(dealer.commitments[0]))
        let groupPoint = constants[0]
        for (const point of constants.slice(1)) groupPoint = groupPoint.add(point)
        return groupPoint.toBytes()
      }

      if (session.status === DKG_STATUS.FINALIZED) {
        const finalHex = `0x${bytesToHex(session.finalPublicKey)}`
        const attestations = await Promise.all(session.participants.map(participant =>
          readGroupKeyAttestation(dkgSessionClient, session, DKG_ATTESTATION_TYPE_ORIGIN, participant)))
        check()
        const vouched = attestations.filter(value =>
          !!value && value.length === session.finalPublicKey.length
          && value.every((byte, index) => byte === session.finalPublicKey[index])).length
        let recomputed: Uint8Array
        try { recomputed = await recomputeGroupPk() }
        catch (error) {
          setGroupPk(finalHex)
          setStep("COMPLETE")
          setActiveLog(t("dkg.logFinalizedRecomputeFailed", { vouched, error: error instanceof Error ? error.message : t("dkg.recomputeReadFailed") }))
          return
        }
        const same = recomputed.length === session.finalPublicKey.length
          && recomputed.every((byte, index) => byte === session.finalPublicKey[index])
        setGroupPk(finalHex)
        setStep("COMPLETE")
        if (!same) {
          setActiveLog(t("dkg.logFinalizedKeyMismatch", { current: finalHex.slice(0, 12), recomputed: bytesToHex(recomputed).slice(0, 12) }))
        } else if (vouched >= Number(session.threshold)) {
          setActiveLog(t("dkg.logFinalizedVerified", { vouched, threshold: String(session.threshold) }))
        } else {
          setActiveLog(t("dkg.logFinalizedLowAttestation", { key: finalHex.slice(0, 12), vouched, threshold: String(session.threshold) }))
        }
        if (!same) return;
        if (createFromFinalized || creationInput.trim()) {
          await createOrRecoverOrganization(session, createFromFinalized);
          if (finalizationReceipt?.status === "success") acknowledgePendingTransaction(finalizationReceipt);
          return;
        }
        if (!deviceKey) {
          setActiveLog(t("dkg.logFinalizedNeedsDigestInput"));
        }
        return
      }
      if (session.status !== DKG_STATUS.ROUND_2_MAILBOX) { setActiveLog(t("dkg.logCannotFinalize", { status: session.status })); setStep("INIT"); return }
      if (session.confirmationsCount < session.threshold) {
        setActiveLog(t("dkg.logConfirmationsBelow", { confirmed: String(session.confirmationsCount), threshold: String(session.threshold) })); setStep("INIT"); return
      }

      const pkBytes = await recomputeGroupPk()
      check()
      const pkHex = `0x${bytesToHex(pkBytes)}`
      setGroupPk(pkHex)
      setStoredPkBytes(pkBytes)

      // v3 trusts attestations, not the caller. Count confirmed members whose
      // current on-chain attestation names exactly this key; a member who
      // vouched for a different key does not count toward this one.
      const sameKey = (candidate: Uint8Array | null) =>
        !!candidate && candidate.length === pkBytes.length && candidate.every((byte, index) => byte === pkBytes[index])
      const attested: string[] = []
      for (const participant of session.participants) {
        const value = await readGroupKeyAttestation(dkgSessionClient, session, DKG_ATTESTATION_TYPE_ORIGIN, participant)
        if (sameKey(value)) attested.push(participant)
      }
      const needed = Number(session.threshold)

      if (attested.length >= needed) {
        const tx = new Transaction()
        tx.moveCall({
          target: `${TESTNET_PACKAGE_ID}::dkg_committee::finalize_session`,
          typeArguments: [],
          arguments: [
            tx.object(session.sessionId),
            tx.pure.vector("u8", Array.from(pkBytes)),
          ],
        })
        let digest: string
        try {
          const finalized = await signAndExecuteWithWallet(tx, { action: finalizeIntent.action, scope: finalizeIntent.scope, expectedAccount: account, metadata: finalizeIntent.metadata })
          digest = finalized.digest
          finalizationReceipt = finalized.receipt
        } catch (error) {
          // 3002 means somebody finalized between our read and our submit; that
          // is a benign race, not a failure of this key.
          const message = error instanceof Error ? error.message : String(error)
          setActiveLog(t("dkg.logFinalizeTxFailed", { message }))
          setStep("INIT"); return
        }

        check()
        const finalized = await readSession(dkgSessionClient, session.sessionId)
        check()
        if (finalized.status !== DKG_STATUS.FINALIZED) throw new Error(t("dkg.finalizedNotVisible"))
        setActiveLog(t("dkg.logFinalizedCreating", { digest: digest.slice(0, 10) }))
        await createOrRecoverOrganization(finalized, true)
        if (finalizationReceipt?.status === "success") acknowledgePendingTransaction(finalizationReceipt)
        return
      }

      // A duplicated participant makes `attestation_count_for` count the same
      // slot twice, so a session built that way can never reach its threshold.
      // The deployed v6 package accepts duplicates; refuse to attest into a
      // session that can never finalize rather than looping on it forever.
      const unique = new Set(session.participants)
      if (unique.size !== session.participants.length) {
        setActiveLog(t("dkg.logDuplicateParticipants", { total: session.participants.length, unique: unique.size }))
        setStep("INIT"); return
      }

      const meNorm = normAddress(me.address, t("dkg.addrInvalidBare"))
      if (!session.participants.includes(meNorm)) {
        setActiveLog(t("dkg.logCannotAttestNotParticipant", { attested: attested.length, needed }))
        setStep("INIT"); return
      }
      // The contract refuses an attestation from an unconfirmed member (3011);
      // reporting it here is a clearer failure than an abort code.
      const confirmed = await readConfirmation(dkgSessionClient, session, meNorm)
      if (!confirmed) {
        setActiveLog(t("dkg.logNotConfirmedCannotAttest"))
        setStep("INIT"); return
      }

      const mine = await readGroupKeyAttestation(dkgSessionClient, session, DKG_ATTESTATION_TYPE_ORIGIN, meNorm)
      if (sameKey(mine)) {
        setActiveLog(t("dkg.logAlreadyAttested", { attested: attested.length, needed, remaining: needed - attested.length }))
        setStep("INIT"); return
      }

      // attest 签名（round7）：用 Round1 公布的会话级私钥对 H(SUI_DKG_ATTEST_V1‖sid‖groupPk) 签名
      const { computeDkgAttestationDigest } = await import("multisig/agent-vault/org")
      const attestSk = await ensureAttestationSecretKey(session.sessionId, meNorm)
      const attestSig = ed25519.sign(computeDkgAttestationDigest({ sessionId: session.sessionId, groupPublicKey: pkBytes }), attestSk)
      const tx = new Transaction()
      tx.moveCall({
        target: `${TESTNET_PACKAGE_ID}::dkg_committee::attest_group_key`,
        typeArguments: [],
        arguments: [
          tx.object(session.sessionId),
          tx.object("0x6"),
          tx.pure.vector("u8", Array.from(pkBytes)),
          tx.pure.vector("u8", Array.from(attestSig)),
        ],
      })
      const { digest } = await signAndExecuteWithWallet(tx)
      setActiveLog(t("dkg.logAttested", { key: pkHex.slice(0, 12), digest: digest.slice(0, 10), attested: attested.length + 1, needed }))
      setStep("INIT"); setProgress(0)
      return
    } catch (err) {
      console.error("finalize error:", err)
      setStep("INIT"); setProgress(0)
      setActiveLog(t("dkg.logFinalizeFailed", { error: describeError(err, String(err)) }))
    }
  }

  const handleTriggerResharing = async () => {
    if (isResharingBusy) return;
    if (!orgObjectId) { setReshareLog(t("dkg.logNoOrgForReshare")); return; }
    setIsResharingBusy(true);
    setStep("RESHARING_ACTIVE");
    setReshareLog(t("dkg.logReadingRoster"));

    try {
      // 1. Refresh live state; all signing inputs come from the chain, never from
      //    props that may predate a previous change.
      const live = await readLiveOrganization(proposalClient, orgObjectId);
      if (live.members.length > Number(MAX_ROSTER_MEMBERS)) throw new Error(t("dkg.rosterTooLarge", { max: MAX_ROSTER_MEMBERS }));
      const held = getCommitteeSession(live.orgId);
      const oldShares = held?.shares ?? storedShares;
      const oldPk = held?.groupPk ?? storedPkBytes;
      if (oldShares.length < 2 || !oldPk) throw new ThresholdSigningError(t("dkg.noSharesInTab"));
      if (oldPk.length !== live.groupPk.length || oldPk.some((value, index) => value !== live.groupPk[index])) {
        throw new ThresholdSigningError(t("dkg.reshareGroupKeyMismatch"));
      }
      if (held && held.epoch !== live.epoch) {
        throw new ThresholdSigningError(t("dkg.reshareEpochMismatch", { held: String(held.epoch), live: String(live.epoch) }));
      }

      // 2. Refresh every share with a zero-constant polynomial so a leaked old
      //    share cannot sign for the new epoch. Committee indices stay 1..N and
      //    match the DKG participant order, not addresses. Reuse this tab's FROST
      //    threshold; the on-chain weighted threshold is a different number.
      const threshold = Math.max(2, Math.min(oldShares.length, Number(held?.threshold ?? BigInt(oldShares.length))));
      const newOf = (id: string, index: bigint, share: bigint) =>
        new GennaroResharingParticipant({ id, index, isOldActiveMember: true, isNewMember: true, currentShare: share, newThreshold: threshold });
      const activeOld = oldShares.map((_, index) => BigInt(index + 1));
      const committee = new Map(oldShares.map((_, index) => [`S${index + 1}`, BigInt(index + 1)]));
      const dealers = oldShares.map((share, index) => newOf(`S${index + 1}`, BigInt(index + 1), share));
      const reshareContext = { orgId: live.orgId, epoch: live.epoch, sessionId: `${live.orgId}:reshare:${live.epoch}` };
      const pkgs = dealers.map(dealer => dealer.generateResharePackage(activeOld, committee, reshareContext));
      const commitments = new Map(pkgs.map(pkg => [pkg.senderId, pkg.commitments]));
      const proofs = new Map(pkgs.map(pkg => [pkg.senderId, pkg.honestyProof!]));
      const refreshed: bigint[] = [];
      for (const [holder, index] of committee.entries()) {
        const node = new GennaroResharingParticipant({ id: holder, index, isOldActiveMember: true, isNewMember: true, newThreshold: threshold });
        const incoming = new Map<string, bigint>();
        pkgs.forEach(pkg => incoming.set(pkg.senderId, pkg.subShares.get(holder)!));
        const result = node.finalizeNewShare(incoming, commitments, live.groupPk, [], { dealerHonestyProofs: proofs, oldActiveIndices: activeOld, context: reshareContext });
        refreshed.push(result.newPrivateShare);
      }
      if (refreshed.length !== oldShares.length) throw new Error(t("dkg.reshareCountMismatch"));

      // 3. Sign the approval digest from the chain's own epoch and chain id.
      //    V2 摘要绑定 key_generation（round-9）：换钥后旧代签名不可重放。
      const nonce = live.lastNonce + 1n;
      const approvalDigest = computeThresholdApprovalDigest(live.chainId, live.orgId, live.epoch, nonce, live.epoch + 1n, live.keyGeneration);
      const signature = signWithCommittee(
        { orgId: live.orgId, groupPk: live.groupPk, epoch: live.epoch, threshold: BigInt(threshold), indices: [...committee.values()], shares: refreshed },
        approvalDigest, { groupPk: live.groupPk, epoch: live.epoch },
      );
      setReshareLog(t("dkg.logReshareSigned", { count: signature.signerIndices.length }));

      // 4. Fail closed if the deployed package lacks the transition, then submit.
      try {
        await proposalClient.getMoveFunction({
          packageId: TESTNET_PACKAGE_ID, moduleName: "cryptographic_org", name: "advance_organization_epoch",
          signal: AbortSignal.timeout(20_000),
        });
      } catch (cause) {
        throw new Error(t("dkg.advanceEpochMissing") + (cause instanceof Error ? `（${cause.message}）` : ""));
      }
      const advanceTx = new Transaction();
      advanceTx.moveCall({
        target: `${TESTNET_PACKAGE_ID}::cryptographic_org::advance_organization_epoch`,
        typeArguments: [],
        arguments: [advanceTx.object(live.orgId), advanceTx.pure.u64(nonce), advanceTx.pure.vector('u8', Array.from(signature.signature))],
      });
      const { digest: advDigest } = await signAndExecuteWithWallet(advanceTx);

      const nextEpoch = Number(live.epoch + 1n);
      setStoredShares(refreshed);
      setCommitteeSession({
        orgId: live.orgId, groupPk: live.groupPk, epoch: live.epoch + 1n,
        threshold: BigInt(threshold), indices: [...committee.values()], shares: refreshed,
      });
      adoptLiveEpoch(live.orgId, { groupPk: live.groupPk, epoch: live.epoch + 1n });
      setEpoch(nextEpoch);
      setReshareTxDigest(advDigest);
      setSuiscanReshareTxUrl(`https://suiscan.xyz/testnet/tx/${advDigest}`);

      const saved = localStorage.getItem(`dao_org_${groupId}`);
      const curData = saved ? JSON.parse(saved) : {};
      localStorage.setItem(`dao_org_${groupId}`, JSON.stringify({
        ...curData, epoch: nextEpoch, reshareTxDigest: advDigest, suiscanReshareTxUrl: `https://suiscan.xyz/testnet/tx/${advDigest}`,
      }));

      setReshareLog(t("dkg.logReshareSuccess", { epoch: nextEpoch }));
    } catch (error) {
      console.error("Resharing Error:", error);
      setReshareLog(t("dkg.logReshareFailed", { error: error instanceof Error ? error.message : String(error) }));
    } finally {
      setIsResharingBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[94vw] max-w-[460px] p-0 overflow-hidden bg-background border border-border rounded-2xl">
        {/* Header */}
        <div className="bg-muted/30 p-4 border-b border-border/50">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-2.5">
              <div className="w-8 h-8 bg-primary/10 rounded-xl text-primary flex items-center justify-center">
                <Network className="h-4 w-4" />
              </div>
              <div>
                <DialogTitle className="text-sm font-semibold">
                  {t("dkg.title")}
                </DialogTitle>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {t("dkg.subtitle")}
                </p>
              </div>
            </div>
            <Badge variant="outline" className="text-xs">
              {step === "INIT" ? t("dkg.badgeUpgradable") : step === "COMPLETE" ? (orgChainCheck.state === "verified" ? t("dkg.badgeReady", { epoch }) : orgChainCheck.state === "pending" ? t("dkg.badgeVerifying") : t("dkg.badgeLocalUnverified")) : t("dkg.badgeUpgrading")}
            </Badge>
          </div>
        </div>

        {/* Content Body */}
        <div className="p-4 space-y-3.5">
          {/* 进度指示 */}
          {step !== "INIT" && step !== "COMPLETE" && step !== "RESHARING_ACTIVE" && (
            <div className="space-y-1.5">
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>{t("dkg.progressLabel")}</span>
                <span className="font-semibold text-primary">{progress}%</span>
              </div>
              <Progress value={progress} className="h-1.5" />
            </div>
          )}

          {/* 状态日志盒子 */}
          <div className="p-2.5 bg-muted/30 rounded-xl border border-border/40 text-xs space-y-1">
            <div className="flex items-center text-primary space-x-1.5 font-medium">
              <Cpu className="h-3.5 w-3.5" />
              <span>{t("dkg.currentStatus")}</span>
            </div>
            <p className="text-muted-foreground pl-5 break-all">{activeLog}</p>
          </div>

          {/* 阶段 1: 准备启动 */}
          {step === "INIT" && (
            <div className="space-y-3">
              <div className="p-3.5 rounded-xl border border-primary/20 bg-primary/5 space-y-2">
                <div className="flex items-center space-x-2 text-primary font-medium text-xs">
                  <ShieldCheck className="h-4 w-4" />
                  <span>{t("dkg.whyAsyncTitle")}</span>
                </div>
                <ul className="text-xs text-muted-foreground space-y-1.5 list-disc list-inside">
                  <li>
                    <strong>{t("dkg.why1Label")}</strong>{t("dkg.why1Body")}
                  </li>
                  <li>
                    <strong>{t("dkg.why2Label")}</strong>{t("dkg.why2Body")}
                  </li>
                  <li>
                    <strong>{t("dkg.why3Label")}</strong>{t("dkg.why3Body")}
                  </li>
                  <li>
                    <strong>{t("dkg.why4Label")}</strong>{t("dkg.why4Body")}
                  </li>
                </ul>
              </div>

              <div className="space-y-1.5 rounded-lg border border-border/50 bg-muted/20 p-2.5">
                <label htmlFor="dkg-session-id" className="text-xs font-medium">{t("dkg.importSessionLabel")}</label>
                <div className="flex gap-2">
                  <Input id="dkg-session-id" aria-label={t("dkg.sessionInputAria")} value={sessionInput} onChange={event => setSessionInput(event.target.value)} placeholder="0x…" className="h-8 min-w-0 font-mono text-[11px]" />
                  <Button type="button" variant="outline" size="sm" onClick={() => void loadSession()} className="h-8 shrink-0">{t("dkg.importReadonlyBtn")}</Button>
                </div>
                {onChainSessionId && <p className="break-all text-[10px] text-muted-foreground">{t("dkg.currentSessionPrefix")}{onChainSessionId}</p>}
                {deviceKeyError && <p role="alert" className="break-all text-[10px] text-amber-700 dark:text-amber-300">{t("dkg.deviceKeyErrorPrefix")}{deviceKeyError}</p>}
                {deviceKey && <p role="status" className="text-[10px] text-emerald-700 dark:text-emerald-300">{t("dkg.deviceKeyHeld", { index: deviceKey.index.toString(), threshold: deviceKey.threshold.toString() })}</p>}
                {pendingDeviceKey && <p role="status" className="text-[10px] text-amber-700 dark:text-amber-300">{t("dkg.deviceKeyPending", { index: pendingDeviceKey.index.toString(), threshold: pendingDeviceKey.threshold.toString() })}</p>}
                <p className="text-[10px] text-muted-foreground">{t("dkg.importNote")}</p>
              </div>

              {/* 参与成员列表 */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span className="font-medium">{t("dkg.memberStatus")}</span>
                  <span className="text-[11px] text-primary">{t("dkg.thresholdNote")}</span>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {initialMembers.map((m, idx) => {
                    return (
                      <div
                        key={idx}
                        className="flex items-center p-2 rounded-lg border text-xs bg-muted/30 border-border/40"
                      >
                        <Avatar className="h-6 w-6 mr-2">
                          <AvatarFallback className="bg-primary/20 text-primary text-[10px]">
                            {(m.name || m.address || "?")[0]}
                          </AvatarFallback>
                        </Avatar>
                        <div className="truncate flex-1">
                          <div className="flex items-center space-x-1">
                            <span className="font-medium truncate">{m.name || m.address || t("dkg.member")}</span>
                            <Badge variant="outline" className={`text-[9px] px-1 py-0 h-4 ${memberSigned[m.address] ? "border-primary/40 text-primary" : "border-muted text-muted-foreground"}`}>
                              {memberSigned[m.address] ? t("dkg.signed") : deadlineTs ? t("dkg.awaitingSignature") : t("dkg.awaitingConfirm")}
                            </Badge>
                          </div>
                          <span className="text-muted-foreground text-[10px]">
                            {t("dkg.weightPrefix")}{m.weight}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {deadlineTs && (
                <div className={`p-3 rounded-lg border text-xs ${
                  nowTs >= deadlineTs
                    ? "border-red-500/40 bg-red-500/10"
                    : "border-amber-500/40 bg-amber-500/10"
                }`}>
                  <p className={`font-medium mb-1 ${nowTs >= deadlineTs ? "text-red-600 dark:text-red-400" : "text-amber-600 dark:text-amber-400"}`}>
                    {nowTs >= deadlineTs ? t("dkg.deadlineExpired") : t("dkg.deadlineRunning")}
                  </p>
                  <p className="text-muted-foreground">
                    {nowTs >= deadlineTs ? (
                      <>{t("dkg.deadlineExpiredBody")}</>
                    ) : (
                      <>{t("dkg.deadlineRemaining", { seconds: Math.max(0, Math.ceil((deadlineTs - nowTs) / 1000)) })}</>
                    )}
                  </p>
                </div>
              )}
              {!deadlineTs
                ? <Button onClick={handleStartDkg} className="w-full mt-2">
                    <Sparkles className="h-4 w-4 mr-2" />
                    {t("dkg.startBtn")}
                  </Button>
                : <div className="space-y-1.5 pt-1">
                    {/* Each button drives exactly one chain phase. Nothing here
                        skips ahead: a later phase stays disabled until the chain
                        state it needs is actually present. */}
                    <Button onClick={handleStartDkg} className="w-full" disabled={nowTs >= deadlineTs}>
                      <Cpu className="h-3.5 w-3.5 mr-2" />
                      {t("dkg.step1")}
                    </Button>
                    <Button onClick={handleRegisterMailboxKey} variant="outline" className="w-full" disabled={nowTs >= deadlineTs}>
                      <Lock className="h-3.5 w-3.5 mr-2" />
                      {t("dkg.step2")}
                    </Button>
                    <Button onClick={handleStartDkg} variant="outline" className="w-full" disabled={nowTs >= deadlineTs}>
                      <Network className="h-3.5 w-3.5 mr-2" />
                      {t("dkg.step3")}
                    </Button>
                    <Button onClick={handleConfirmWithShares} variant="outline" className="w-full" disabled={nowTs >= deadlineTs}>
                      <CheckCircle2 className="h-3.5 w-3.5 mr-2" />
                      {t("dkg.step4")}
                    </Button>
                    {/* Finalization is NOT time-gated on chain: members attest
                        before the deadline, but `finalize_session` has no
                        clock check, so anyone may land an already-attested key
                        afterwards. Disabling this after the deadline would
                        strand a session that already has its quorum. */}
                    <Button onClick={() => void handleFinalize()} variant="outline" className="w-full">
                      <Layers className="h-3.5 w-3.5 mr-2" />
                      {t("dkg.step5")}
                    </Button>
                    <div className="space-y-1.5 rounded-lg border border-border/50 bg-muted/20 p-2.5">
                      <label htmlFor="dkg-creation-digest" className="text-[11px] font-medium">{t("dkg.digestInputLabel")}</label>
                      <Input id="dkg-creation-digest" aria-label={t("dkg.digestInputAria")} value={creationInput} onChange={event => setCreationInput(event.target.value.trim())} placeholder={t("dkg.digestPlaceholder")} className="h-8 font-mono text-[11px]" />
                      <Button type="button" variant="outline" size="sm" className="h-8 w-full" onClick={() => void handleFinalize()} disabled={!creationInput.trim()}>
                        {t("dkg.digestVerifyBtn")}
                      </Button>
                      {sessionInput && <Button type="button" variant="outline" size="sm" className="h-8 w-full" onClick={() => void handleFinalize(true)}>
                        {t("dkg.continueCreateBtn")}
                      </Button>}
                      <p className="text-[10px] text-muted-foreground">{t("dkg.digestNote")}</p>
                    </div>
                    {nowTs >= deadlineTs && <p className="text-[11px] text-muted-foreground">
                      {t("dkg.afterDeadlineNote")}
                    </p>}
                  </div>}
            </div>
          )}

          {/* 阶段 2: 正在运行步骤 */}
          {(step === "ROUND_1_COMMITMENTS" || step === "ROUND_2_SHARES" || step === "COMPUTING_PK" || step === "DEPLOYING_ONCHAIN") && (
            <div className="py-6 flex flex-col items-center justify-center space-y-3 text-center">
              <div className="relative">
                <div className="w-12 h-12 rounded-2xl bg-primary/20 flex items-center justify-center text-primary animate-spin">
                  <RefreshCw className="h-6 w-6" />
                </div>
                <Lock className="h-3.5 w-3.5 text-primary absolute -bottom-1 -right-1" />
              </div>
              <div>
                <p className="font-semibold text-sm">
                  {t("dkg.syncing")}
                </p>
                <p className="text-xs text-muted-foreground mt-1 max-w-sm">
                  {t("dkg.syncingBody")}
                </p>
              </div>
            </div>
          )}

          {/* 阶段 3: 转化完成态 */}
          {(step === "COMPLETE" || step === "RESHARING_ACTIVE") && (
            <div className="space-y-3">
              <div className="p-3.5 rounded-xl border border-emerald-500/30 bg-emerald-500/5 space-y-2.5">
                <div className="flex items-center justify-between">
                  <div className={`flex items-center space-x-2 font-medium text-sm ${orgChainCheck.state === "verified" ? "text-emerald-600 dark:text-emerald-400" : "text-amber-700 dark:text-amber-300"}`}>
                    {orgChainCheck.state === "verified" ? <CheckCircle2 className="h-4 w-4" /> : <Clock className="h-4 w-4" />}
                    <span>{orgChainCheck.state === "verified" ? t("dkg.orgVerified") : orgChainCheck.state === "pending" ? t("dkg.orgVerifying") : t("dkg.orgUnverified")}</span>
                  </div>
                  <Badge variant="outline" className="text-[10px] border-emerald-500/40 text-emerald-600 dark:text-emerald-400">
                    {orgChainCheck.state === "verified" ? t("dkg.epochN", { epoch }) : t("dkg.epochUnverified")}
                  </Badge>
                </div>
                {orgChainCheck.state === "failed" && <p role="alert" className="text-[11px] text-amber-700 dark:text-amber-300">{t("dkg.orgReadFailedPrefix")}{orgChainCheck.error}{t("dkg.orgReadFailedSuffix")}</p>}

                <div className="space-y-2 text-xs">
                  <div>
                    <span className="text-muted-foreground">{t("dkg.groupPkLabel")}</span>
                    <div className="p-2 bg-background rounded-lg border border-border/40 font-mono text-[11px] truncate select-all mt-0.5">
                      {groupPk}
                    </div>
                  </div>
                  <div>
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">{t("dkg.orgIdLabel")}</span>
                      {suiscanOrgUrl && (
                        <a
                          href={suiscanOrgUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[11px] text-primary flex items-center hover:underline"
                        >
                          {t("dkg.viewOnSuiscan")}<ExternalLink className="h-3 w-3 ml-0.5" />
                        </a>
                      )}
                    </div>
                    <div className="p-2 bg-background rounded-lg border border-border/40 font-mono text-[11px] truncate select-all mt-0.5">
                      {orgObjectId}
                    </div>
                  </div>
                  {txDigest && (
                    <div>
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground">{t("dkg.deployTxDigestLabel")}</span>
                        {suiscanTxUrl && (
                          <a
                            href={suiscanTxUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-[11px] text-primary flex items-center hover:underline"
                          >
                            {t("dkg.suiscanTx")} <ExternalLink className="h-3 w-3 ml-0.5" />
                          </a>
                        )}
                      </div>
                      <div className="p-2 bg-background rounded-lg border border-border/40 font-mono text-[11px] truncate select-all mt-0.5">
                        {txDigest}
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* One signing share belongs to this device; threshold signing requires other devices. */}
              <div className="p-3 rounded-xl border border-border/50 bg-muted/20 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-1.5 text-xs font-semibold">
                    <Lock className="h-3.5 w-3.5 text-primary" />
                    <span>{t("dkg.deviceShareTitle")}</span>
                  </div>
                  <Badge variant={deviceKey ? "outline" : "secondary"} className={`text-[10px] ${deviceKey ? "border-emerald-500/40 text-emerald-500" : ""}`}>
                    {deviceKey ? t("dkg.shareCount", { threshold: deviceKey.threshold.toString() }) : t("dkg.shareNotRestored")}
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  {deviceKey
                    ? t("dkg.shareBound", { epoch: deviceKey.epoch.toString(), index: deviceKey.index.toString() })
                    : deviceKeyError || t("dkg.shareMissing")}
                </p>
              </div>

              {/* 动态成员调整 (Resharing) */}
              <div className="p-3 rounded-xl border border-border/50 bg-muted/20 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-1.5 text-xs font-semibold">
                    <Layers className="h-3.5 w-3.5 text-primary" />
                    <span>{t("dkg.reshareTitle")}</span>
                  </div>
                  <Badge variant="secondary" className="text-[10px]">
                    {t("dkg.reshareBadge")}
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  {t("dkg.reshareBody")}
                </p>

                {reshareLog && (
                  <p className="text-xs font-mono text-primary bg-primary/10 p-2 rounded-lg break-all">
                    {reshareLog}
                  </p>
                )}

                {reshareTxDigest && suiscanReshareTxUrl && (
                  <div className="flex items-center justify-between p-2 rounded-lg bg-background border border-border/40 text-[11px]">
                    <span className="text-muted-foreground">{t("dkg.reshareTxLabel")}</span>
                    <a
                      href={suiscanReshareTxUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary font-mono flex items-center hover:underline"
                    >
                      {reshareTxDigest.slice(0, 8)}...{reshareTxDigest.slice(-6)}
                      <ExternalLink className="h-3 w-3 ml-1" />
                    </a>
                  </div>
                )}

                <div className="flex justify-end pt-1">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={isResharingBusy}
                    onClick={handleTriggerResharing}
                    className="text-xs border-primary/30 text-primary"
                  >
                    <RefreshCw className={`h-3 w-3 mr-1 ${isResharingBusy ? "animate-spin" : ""}`} />
                    {isResharingBusy ? t("dkg.reshareBusy") : t("dkg.reshareBtn")}
                  </Button>
                </div>
              </div>

              <Button onClick={() => onOpenChange(false)} className="w-full">
                {t("dkg.doneBtn")}
              </Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
