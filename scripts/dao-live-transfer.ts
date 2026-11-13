// Live testnet proof that a DAO's group key owns and spends SUI.
//
// This sends REAL transactions. It exists because "the signature verifies" and
// "the chain accepts the transaction" are different claims, and only the second
// one proves the DAO can hold and move assets.
//
// Sequence:
//   1. Fund a DAO address derived from a FROST group public key.
//   2. Reshare the committee (remove a member, then add one back).
//   3. Confirm the DAO address — and therefore its balance — never moved.
//   4. Spend FROM the DAO address with a threshold signature, after the roster
//      changes, and verify the transfer on chain.
//
// Run with: pnpm exec tsx scripts/dao-live-transfer.ts
// Requires the local sui CLI keystore for the funder account.
import { execFileSync } from "node:child_process"
import { Ed25519PublicKey } from "@mysten/sui/keypairs/ed25519"
import { Transaction } from "@mysten/sui/transactions"
import { SuiGrpcClient } from "@mysten/sui/grpc"
import { messageWithIntent, toSerializedSignature } from "@mysten/sui/cryptography"
import { ed25519 } from "@noble/curves/ed25519.js"
import { blake2b } from "@noble/hashes/blake2.js"
import { GennaroResharingParticipant, type DealerHonestyProof } from "../lib/crypto/resharing"
import { mod, randomScalar } from "../lib/crypto/math"
import type { Point } from "../lib/crypto/vss"
import {
  aggregateNonce, aggregateSignature, createNonceCommitment, createSignatureShare,
} from "../lib/frost-exchange"

const NETWORK = "testnet" as const
const client = new SuiGrpcClient({ network: NETWORK, baseUrl: "https://fullnode.testnet.sui.io:443" })
const ORG = "0x" + "da0".repeat(10) + "0000"

const log = (...parts: unknown[]) => console.log(...parts)

interface Member { id: string; index: bigint; share: bigint }

function split(threshold: number, n: number) {
  const coefficients = Array.from({ length: threshold }, () => randomScalar())
  const shareAt = (x: bigint) => coefficients.reduceRight((acc, c) => mod(acc * x + c), 0n)
  const indices = Array.from({ length: n }, (_, i) => BigInt(i + 1))
  return { indices, shares: indices.map(shareAt), groupPk: ed25519.Point.BASE.multiply(coefficients[0]).toBytes() }
}

function reshare(oldCommittee: Member[], roster: { id: string; index: bigint }[], threshold: number, originalGroupPk: Uint8Array) {
  const oldIndices = oldCommittee.map(m => m.index)
  const rosterMap = new Map(roster.map(m => [m.id, m.index] as [string, bigint]))
  const oldIds = new Set(oldCommittee.map(m => m.id))
  const context = { orgId: ORG, epoch: 1, sessionId: `${ORG}:reshare:1` }
  const packages = oldCommittee.map(member => new GennaroResharingParticipant({
    id: member.id, index: member.index, isOldActiveMember: true,
    isNewMember: rosterMap.has(member.id), currentShare: member.share, newThreshold: threshold,
  }).generateResharePackage(oldIndices, rosterMap, context))
  const peerCommitments = new Map<string, Point[]>(packages.map(p => [p.senderId, p.commitments] as [string, Point[]]))
  const proofs = new Map(packages.map(p => [p.senderId, p.honestyProof!] as [string, DealerHonestyProof]))
  const results = roster.map(member => new GennaroResharingParticipant({
    id: member.id, index: member.index,
    isOldActiveMember: oldIds.has(member.id), isNewMember: true, newThreshold: threshold,
  }).finalizeNewShare(
    new Map(packages.map(p => [p.senderId, p.subShares.get(member.id)!] as [string, bigint])),
    peerCommitments, originalGroupPk, [], { dealerHonestyProofs: proofs, oldActiveIndices: oldIndices, context },
  ))
  for (const result of results) {
    if (Buffer.compare(Buffer.from(result.groupPublicKey), Buffer.from(originalGroupPk)) !== 0) {
      throw new Error(`${result.participantId} 重算了不同的群公钥，拒绝继续。`)
    }
  }
  return {
    groupPk: results[0].groupPublicKey,
    members: roster.map((member, i) => ({ id: member.id, index: member.index, share: results[i].newPrivateShare })),
  }
}

/** Two-round threshold signature over raw bytes. */
function thresholdSign(members: Member[], groupPk: Uint8Array, message: Uint8Array, threshold: number) {
  const round1 = members.map(member => ({ member, ...createNonceCommitment(ORG, member.index) }))
  const aggregateR = aggregateNonce(round1.map(r => r.commitment), ORG)
  const signerIndices = members.map(m => m.index)
  const parts = round1.map(r => createSignatureShare({
    orgId: ORG, index: r.member.index, secret: r.secret, share: r.member.share,
    threshold: BigInt(threshold), signerIndices, aggregateR, groupPk, message, verifyRoundOne: true,
  }))
  return aggregateSignature(aggregateR, parts, groupPk, message).signature
}

/** Signs Sui transaction bytes with the DAO key, as an ED25519 signature string. */
function signTransactionBytes(bytes: Uint8Array, members: Member[], groupPk: Uint8Array, threshold: number): string {
  // Sui signs `blake2b(messageWithIntent("TransactionData", bytes), 32)` — not the
  // intent bytes themselves. Signing the un-hashed intent produces a signature
  // that verifies locally with a raw `ed25519.verify` but is rejected on chain.
  const digest = blake2b(messageWithIntent("TransactionData", bytes), { dkLen: 32 })
  const signature = thresholdSign(members, groupPk, digest, threshold)
  // The wire format is scheme-flag ‖ signature ‖ publicKey, base64 — let the SDK
  // build it rather than hand-rolling the layout.
  return toSerializedSignature({
    signatureScheme: "ED25519",
    signature,
    publicKey: new Ed25519PublicKey(groupPk),
  })
}

function sui(args: string[]): string {
  return execFileSync("sui", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })
}

async function main() {
  log("=== 1. 由群公钥派生 DAO 地址 ===")
  const original = split(2, 3)
  const daoAddress = new Ed25519PublicKey(original.groupPk).toSuiAddress()
  log("group pk:", Buffer.from(original.groupPk).toString("hex"))
  log("DAO address:", daoAddress)

  const funder = sui(["client", "active-address"]).trim()
  log("funder:", funder)

  log("\n=== 2. 向 DAO 地址转入 0.05 SUI（真实交易） ===")
  // `pay-sui` needs coin objects; this account holds an address balance instead,
  // so fund with a PTB that splits the gas coin.
  const fundOutput = sui([
    "client", "ptb", "--split-coins", "gas", "[50000000]", "--assign", "c",
    "--transfer-objects", "[c]", `@${daoAddress}`, "--gas-budget", "20000000",
  ])
  const digestMatch = /[1-9A-HJ-NP-Za-km-z]{43,44}/.exec(fundOutput)
  log("fund tx:", digestMatch?.[0] ?? "(见上方 sui 输出)")

  // Wait for the funding transfer to be visible.
  let balance = 0n
  for (let attempt = 0; attempt < 20; attempt++) {
    const { balance: b } = await client.getBalance({ owner: daoAddress, coinType: "0x2::sui::SUI" })
    balance = BigInt(b.balance)
    if (balance > 0n) break
    await new Promise(resolve => setTimeout(resolve, 1500))
  }
  log("DAO balance after funding:", balance.toString(), "MIST")
  if (balance === 0n) throw new Error("DAO 地址未收到资金，无法继续。")

  log("\n=== 3. 撤掉一名成员，再加回一名（真实重共享） ===")
  let committee: Member[] = [0, 1].map(i => ({ id: `m${i + 1}`, index: original.indices[i], share: original.shares[i] }))
  let roster = [0, 1].map(i => ({ id: `m${i + 1}`, index: BigInt(i + 1) }))
  let state = reshare(committee, roster, 2, original.groupPk)
  const afterRemove = new Ed25519PublicKey(state.groupPk).toSuiAddress()
  log("after remove, DAO address:", afterRemove, afterRemove === daoAddress ? "（未变）" : "（变了！）")

  committee = state.members
  roster = [0, 1, 2].map(i => ({ id: `m${i + 1}`, index: BigInt(i + 1) }))
  state = reshare(committee, roster, 2, original.groupPk)
  const afterAdd = new Ed25519PublicKey(state.groupPk).toSuiAddress()
  log("after add,    DAO address:", afterAdd, afterAdd === daoAddress ? "（未变）" : "（变了！）")
  if (afterRemove !== daoAddress || afterAdd !== daoAddress) throw new Error("DAO 地址在成员变更后发生移动，资产会丢失。")

  const { balance: stillThere } = await client.getBalance({ owner: daoAddress, coinType: "0x2::sui::SUI" })
  log("DAO balance after roster changes:", stillThere.balance, "MIST")

  log("\n=== 4. 用重共享后的门限签名，从 DAO 地址转出 0.01 SUI ===")
  // Use two of the three refreshed members.
  const signers = [state.members[1], state.members[2]]
  const recipient = funder
  const tx = new Transaction()
  tx.setSender(daoAddress)
  tx.setGasBudget(10_000_000)
  const [coin] = tx.splitCoins(tx.gas, [10_000_000])
  tx.transferObjects([coin], recipient)
  const bytes = await tx.build({ client })

  const signature = signTransactionBytes(bytes, signers, state.groupPk, 2)
  const result = await client.executeTransaction({ transaction: bytes, signatures: [signature], include: { effects: true, events: true } })
  const inner = (result as unknown as { Transaction?: { status?: { success?: boolean; error?: { message?: string } | null }; digest?: string } }).Transaction
  const ok = inner?.status?.success === true
  log("transfer digest:", inner?.digest)
  log("transfer success:", ok, inner?.status?.error?.message ?? "")

  if (!ok) throw new Error("DAO 门限签名交易未被链接受。")

  const { balance: left } = await client.getBalance({ owner: daoAddress, coinType: "0x2::sui::SUI" })
  log("DAO balance after transfer:", left.balance, "MIST")
  log("\n全部完成：DAO 地址在成员增删后未变，且能用门限签名真实转出 SUI。")
}

main().catch(error => { console.error("FAILED:", error instanceof Error ? error.message : error); process.exit(1) })
