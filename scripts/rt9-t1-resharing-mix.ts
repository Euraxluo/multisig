/**
 * ROUND-9 T1 — resharing 窗口混合攻击（纯本地仿真，0 gas）
 *
 * 链上事实（dkg/cryptographic_org 源码，非仿真）：
 *   - org.group_pk 只被 rotate_group_key 改写；advance_organization_epoch 与
 *     update_organization_roster 不换钥 → GJKR resharing 保公钥换届后，
 *     旧 epoch 分片对一切验签动作仍然有效，直到 rotate_group_key。
 *   - execute_threshold_proposal / execute_transfer_proposal 的摘要绑定
 *     「调用时」的 org.group_pk + org.epoch_version。
 *
 * 本脚本验证三件事：
 *   (a) 被踢成员的旧分片在窗口内仍可参与签出通过 ed25519.verify 的合法签名；
 *   (b) 旧分片 + 新委员会分片的跨 epoch 混合签名必然失败（标量级 + 签名级）；
 *   (c) dealer honesty context 缺失/缺 expectedVerificationShares 时，
 *       恶意 dealer 可用自洽假证明让伪造子份额通过全部校验，且 proof 与
 *       resharing 多项式承诺之间没有强制 join（C_{i,0} vs commitments[0]）。
 */
import { ed25519 } from "@noble/curves/ed25519.js"
import { sha256 } from "@noble/hashes/sha2.js"
import {
  GennaroResharingParticipant,
  verifyDealerHonestyProof,
  computeDealerChallenge,
  type DealerHonestyProof,
  type DealerHonestyContext,
} from "../lib/crypto/resharing"
import type { Point } from "../lib/crypto/vss"
import { mod, lagrangeCoefficient, modInverse, randomScalar, scalarToBytes32 } from "../lib/crypto/math"
import { ThresholdSignerNode, type NonceCommitment, type SignatureShare } from "../packages/multisig/src/dkg/threshold_signer"

const ORG_ID = "0xrt9org"
const CONTEXT: DealerHonestyContext = { orgId: ORG_ID, epoch: 1, sessionId: "rt9:reshare:1" }

interface Member { id: string; index: bigint; share: bigint }

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex")

/** 复刻链上 execute_threshold_proposal 的 transfer_digest（org_id 用 32B 占位）。 */
function transferDigest(epoch: bigint, nonce: bigint): Uint8Array {
  const domain = new TextEncoder().encode("SUI_ORG_THRESHOLD_PROPOSAL_V2:")
  const chain = new TextEncoder().encode("sui-testnet:")
  const orgId = new Uint8Array(32).fill(0xab)
  const u64le = (v: bigint) => { const o = new Uint8Array(8); let x = v; for (let i = 0; i < 8; i++) { o[i] = Number(x & 0xffn); x >>= 8n } return o }
  const data = new Uint8Array(domain.length + chain.length + 32 + 8 + 8 + 1 + 8)
  let p = 0
  for (const seg of [domain, chain, orgId, u64le(epoch), u64le(nonce), Uint8Array.of(0), u64le(0n)]) { data.set(seg, p); p += seg.length }
  return sha256(data)
}

/** FROST 两轮签名：任给 (index, share) 子集 + 群公钥 + 消息 → 64B 聚合签名。 */
function frostSign(subset: Member[], groupPk: Uint8Array, message: Uint8Array): Uint8Array {
  const nodes = subset.map(m => new ThresholdSignerNode(`${ORG_ID}:${m.index}`, m.index, m.share))
  const commitments: NonceCommitment[] = nodes.map(n => n.generateNonceCommitment())
  const shares: SignatureShare[] = nodes.map(n => n.computeSignatureShare(message, groupPk, commitments))
  return ThresholdSignerNode.aggregateSignature(message, groupPk, commitments, shares)
}

async function main() {
  // ── 基线：2-of-3 genesis，f(x) = a0 + a1·x，成员 1/2/3 ──
  const a0 = randomScalar()
  const a1 = randomScalar()
  const f = (x: bigint) => mod(a0 + a1 * x)
  const oldShares = new Map<bigint, bigint>([1n, 2n, 3n].map(i => [i, f(i)] as const))
  const groupPk = ed25519.Point.BASE.multiply(a0).toBytes()
  const kicked = oldShares.get(3n)!
  const msg = transferDigest(1n, 1n)

  // ── Gennaro resharing：旧活跃 [1,2]（踢 3）→ 新委员会 [1,2,4]，门限 2 ──
  const oldActive = [1n, 2n]
  const roster: Member[] = [
    { id: "m1", index: 1n, share: 0n }, { id: "m2", index: 2n, share: 0n }, { id: "m4", index: 4n, share: 0n },
  ]
  const rosterMap = new Map(roster.map(r => [r.id, r.index] as const))
  const packages = oldActive.map(idx => new GennaroResharingParticipant({
    id: `m${idx}`, index: idx, isOldActiveMember: true, isNewMember: idx !== 3n,
    currentShare: oldShares.get(idx)!, newThreshold: 2,
  }).generateResharePackage(oldActive, rosterMap, CONTEXT))
  const peerCommitments = new Map<string, Point[]>(packages.map(p => [p.senderId, p.commitments] as const))
  const proofs = new Map<string, DealerHonestyProof>(packages.map(p => [p.senderId, p.honestyProof!] as const))
  const newCommittee: Member[] = roster.map(r => {
    const incoming = new Map(packages.map(p => [p.senderId, p.subShares.get(r.id)!] as const))
    const isOld = oldActive.includes(r.index)
    const result = new GennaroResharingParticipant({
      id: r.id, index: r.index, isOldActiveMember: isOld, isNewMember: true, newThreshold: 2,
    }).finalizeNewShare(incoming, peerCommitments, groupPk, [], {
      dealerHonestyProofs: proofs, oldActiveIndices: oldActive, context: CONTEXT,
    })
    return { id: r.id, index: r.index, share: result.newPrivateShare }
  })
  const recomputeSubset = newCommittee.slice(0, 2)
  const recompute = recomputeSubset
    .map(m => ed25519.Point.BASE.multiply(m.share).multiply(lagrangeCoefficient(m.index, recomputeSubset.map(x => x.index), 0n)))
    .reduce((acc, p) => acc.add(p), ed25519.Point.ZERO)
  console.log(`[setup] resharing 保公钥: ${hex(recompute.toBytes()) === hex(groupPk) ? "OK" : "MISMATCH!"} (${newCommittee.map(m => `m${m.index}=0x${m.share.toString(16).slice(0, 8)}…`).join(", ")})`)

  // ══ (a) 窗口内被踢成员旧分片仍可签 ══
  const sigOldWindow = frostSign([
    { id: "m1", index: 1n, share: oldShares.get(1n)! },
    { id: "m3", index: 3n, share: kicked },
  ], groupPk, msg)
  const aOk = ed25519.verify(sigOldWindow, msg, groupPk)
  console.log(`[a] 被踢成员 m3(旧分片)+m1 旧组合签名 ed25519.verify = ${aOk}`)

  // ══ (b) 跨 epoch 混合签名 ══
  const m2new = newCommittee.find(m => m.index === 2n)!
  const mixedSubset = [
    { id: "m3", index: 3n, share: kicked },
    { id: "m2", index: 2n, share: m2new.share },
  ]
  let bSig: Uint8Array | null = null
  let bErr = ""
  try { bSig = frostSign(mixedSubset, groupPk, msg) } catch (e) { bErr = (e as Error).message }
  const bScalar = mixedSubset.reduce((acc, m) => {
    const lambda = lagrangeCoefficient(m.index, mixedSubset.map(x => x.index), 0n)
    return mod(acc + lambda * m.share)
  }, 0n)
  const mixedPoint = ed25519.Point.BASE.multiply(bScalar)
  console.log(`[b] 混合签名聚合 = ${bSig ? `${ed25519.verify(bSig, msg, groupPk)} (verify)` : `抛错: ${bErr.slice(0, 80)}`}`)
  console.log(`[b] 混合标量重构点 == groupPk? ${mixedPoint.equals(ed25519.Point.BASE.multiply(a0)) ? "相等(危险)" : "不相等 — 跨 epoch Shamir 组合失效"}`)

  // ══ (c) dealer honesty：context 绑定 + expectedVerificationShares + join 缺口 ══
  const lambda2 = lagrangeCoefficient(2n, oldActive, 0n)
  const realY2 = ed25519.Point.BASE.multiply(oldShares.get(2n)!).toBytes()

  // c1: 用错误 context (epoch=999) 生成的证明 → 正确 context 校验必须失败
  const wrongCtxProof = packages[1].honestyProof! // m2 在 CONTEXT(epoch=1) 下的证明
  const forgedCtx: DealerHonestyContext = { ...CONTEXT, epoch: 999 }
  const proofUnderWrongCtx = verifyDealerHonestyProof(wrongCtxProof, oldActive, forgedCtx)
  // 反向：攻击者在 epoch=999 下伪造的证明拿到 epoch=1 的会话用
  const k2 = randomScalar()
  const c0Fake = ed25519.Point.BASE.multiply(mod(lambda2 * oldShares.get(2n)!))
  const challengeWrong = computeDealerChallenge(forgedCtx, 2n, c0Fake.toBytes(), realY2, ed25519.Point.BASE.multiply(k2).toBytes())
  const manualWrong: DealerHonestyProof = {
    dealerId: "m2", dealerIndex: 2n, constantCommitment: c0Fake.toBytes(), verificationShareY: realY2,
    noncePointR: ed25519.Point.BASE.multiply(k2).toBytes(),
    responseS: mod(k2 + challengeWrong * mod(lambda2 * oldShares.get(2n)!)),
  }
  const crossCtxRejected = !verifyDealerHonestyProof(manualWrong, oldActive, CONTEXT)

  // c2: 自洽假证明（z* 任选，Y* = λ⁻¹·C*，Schnorr 自洽）无 expectedY 时通过
  const zStar = randomScalar()
  const cStar = ed25519.Point.BASE.multiply(zStar)
  const yStar = cStar.multiply(modInverse(lambda2))
  const k3 = randomScalar()
  const rStar = ed25519.Point.BASE.multiply(k3)
  const cChal = computeDealerChallenge(CONTEXT, 2n, cStar.toBytes(), yStar.toBytes(), rStar.toBytes())
  const fakeProof: DealerHonestyProof = {
    dealerId: "m2", dealerIndex: 2n, constantCommitment: cStar.toBytes(), verificationShareY: yStar.toBytes(),
    noncePointR: rStar.toBytes(), responseS: mod(k3 + cChal * zStar),
  }
  const fakeAcceptedNoExpected = verifyDealerHonestyProof(fakeProof, oldActive, CONTEXT)
  const fakeRejectedWithExpected = !verifyDealerHonestyProof(fakeProof, oldActive, CONTEXT, realY2)

  // c3: join 缺口 — 恶意 dealer 的假多项式子份额通过 VSS 校验且 finalize 不对照 proof 常数
  const fakeDealer = new GennaroResharingParticipant({
    id: "m2", index: 2n, isOldActiveMember: true, isNewMember: false, currentShare: zStar, newThreshold: 2,
  })
  // 直接借用 generateResharePackage 的形状：以 z* 为常数的多项式（模拟恶意 dealer 代码）
  const fakePoly = [zStar, randomScalar()]
  const fakeSubShares = new Map(roster.map(r => [r.id, mod(fakePoly[0] + fakePoly[1] * r.index)] as const))
  const fakeCommitments: Point[] = fakePoly.map(c => ed25519.Point.BASE.multiply(c))
  const victimIncoming = new Map<string, bigint>([
    ["m1", packages[0].subShares.get("m4")!],
    ["m2", fakeSubShares.get("m4")!],
  ])
  const victimCommitments = new Map<string, Point[]>([
    ["m1", packages[0].commitments], ["m2", fakeCommitments],
  ])
  const victimProofs = new Map<string, DealerHonestyProof>([
    ["m1", packages[0].honestyProof!], ["m2", fakeProof],
  ])
  const fakeCtx = { dealerHonestyProofs: victimProofs, oldActiveIndices: oldActive, context: CONTEXT }
  let poisonedShare: bigint | null = null
  let silentPk: Uint8Array | null = null
  let guardedError = ""
  try {
    // round-9 修复后：无 originalGroupPublicKey → 入口硬校验拒绝（不再静默毒化）
    const r = new GennaroResharingParticipant({ id: "m4", index: 4n, isOldActiveMember: false, isNewMember: true, newThreshold: 2 })
      .finalizeNewShare(victimIncoming, victimCommitments, undefined as unknown as Uint8Array, [], fakeCtx)
    poisonedShare = r.newPrivateShare
    silentPk = r.groupPublicKey
  } catch (e) { guardedError = (e as Error).message }
  let guardedResult = "n/a"
  try {
    new GennaroResharingParticipant({ id: "m4", index: 4n, isOldActiveMember: false, isNewMember: true, newThreshold: 2 })
      .finalizeNewShare(victimIncoming, victimCommitments, groupPk, [], fakeCtx)
    guardedResult = "未拦截(危险)"
  } catch (e) { guardedResult = `拦截: ${(e as Error).message.slice(0, 60)}` }
  let poisonedVerifies = false
  let poisonedErr = ""
  if (poisonedShare !== null) {
    try {
      poisonedVerifies = ed25519.verify(frostSign([{ id: "m4", index: 4n, share: poisonedShare }, { id: "m1", index: 1n, share: newCommittee[0].share }], groupPk, msg), msg, groupPk)
    } catch (e) { poisonedErr = (e as Error).message }
  }
  const vssAccepted = (() => {
    // 假 dealer 的子份额对假承诺同态成立（VSS 不设防）
    const w = fakeSubShares.get("m4")!
    const lhs = ed25519.Point.BASE.multiply(w)
    const rhs = fakeCommitments[0].add(fakeCommitments[1].multiply(4n))
    return lhs.equals(rhs)
  })()
  const proofMatchesCommitments = packages[1].commitments[0].equals(ed25519.Point.fromHex(hex(proofs.get("m2")!.constantCommitment)))

  // c4 (join gap): 诚实的 m2 证明（expectedY 可验）+ 恶意多项式承诺（常数 z*）——
  // SDK 不比对 proof.constantCommitment 与 commitments[0]，expectedY 也救不了
  const honestPoly = [mod(lambda2 * oldShares.get(2n)!), randomScalar()] // 常数 = λ·s（与证明一致）
  const fakePolyConst = randomScalar()
  const poisonPoly = [fakePolyConst, randomScalar()] // 常数 ≠ λ·s（毒化）
  const poisonCommitments: Point[] = poisonPoly.map(c => ed25519.Point.BASE.multiply(c))
  const poisonSubShares = new Map(roster.map(r => [r.id, mod(poisonPoly[0] + poisonPoly[1] * r.index)] as const))
  const joinIncoming = new Map<string, bigint>([
    ["m1", packages[0].subShares.get("m4")!],
    ["m2", poisonSubShares.get("m4")!],
  ])
  const joinCommitments = new Map<string, Point[]>([
    ["m1", packages[0].commitments], ["m2", poisonCommitments],
  ])
  const joinProofs = new Map<string, DealerHonestyProof>([
    ["m1", packages[0].honestyProof!], ["m2", packages[1].honestyProof!], // m2 的证明是诚实的
  ])
  let joinPk: Uint8Array | null = null
  let joinErr = ""
  try {
    // round-9 修复后：join 缺口已闭合 —— 诚实证明 + 毒化多项式在 constant-commitment 比对处被硬拒
    const r = new GennaroResharingParticipant({ id: "m4", index: 4n, isOldActiveMember: false, isNewMember: true, newThreshold: 2 })
      .finalizeNewShare(joinIncoming, joinCommitments, undefined as unknown as Uint8Array, [], {
        dealerHonestyProofs: joinProofs, oldActiveIndices: oldActive, context: CONTEXT,
        expectedVerificationShares: new Map([["m2", realY2]]), // expectedY 也传了
      })
    joinPk = r.groupPublicKey
  } catch (e) { joinErr = (e as Error).message }
  const joinGapExploit = joinPk !== null && hex(joinPk) !== hex(groupPk)

  console.log(`[c1] 跨 context 证明被拒 = ${crossCtxRejected}; 诚实例 proof.C == commitments[0] = ${proofMatchesCommitments}`)
  console.log(`[c4] 诚实证明+毒化多项式(带expectedY): finalize = ${joinPk ? "静默成功" : `拦截(${joinErr.slice(0, 50)})`}; 重算群公钥 == 真群公钥 = ${joinPk ? hex(joinPk) === hex(groupPk) : "n/a"}${joinPk && hex(joinPk) !== hex(groupPk) ? " (被毒化—join缺口实证)" : ""}`)
  console.log(`[c2] 自洽假证明: 无 expectedY = ${fakeAcceptedNoExpected ? "接受(缺口)" : "拒绝"}; 带 expectedY = ${fakeRejectedWithExpected ? "拒绝" : "接受(危险)"}`)
  console.log(`[c3] 假子份额 VSS 同态通过 = ${vssAccepted}; 无 guard finalize = ${poisonedShare !== null ? "静默成功" : guardedError.slice(0, 60)}; 带原公钥 = ${guardedResult}`)
  console.log(`[c3] 被污染 m4 分片参与签名 verify = ${poisonedVerifies}${poisonedErr ? ` (抛错: ${poisonedErr.slice(0, 70)})` : ""}; 静默重算群公钥 == 真群公钥 = ${silentPk ? hex(silentPk) === hex(groupPk) : "n/a"}${silentPk && hex(silentPk) !== hex(groupPk) ? " (错误密钥!)" : ""}`)

  console.log("\n=== RT9-T1 VERDICTS ===")
  console.log(`T1-a 窗口风险: ${aOk ? "CONFIRMED — 被踢成员旧分片窗口内仍可签出链上可验签名" : "未复现"}`)
  console.log(`T1-b 混合攻击: ${(bSig ? ed25519.verify(bSig, msg, groupPk) : false) || mixedPoint.equals(ed25519.Point.BASE.multiply(a0)) ? "CONFIRMED" : "不可行 — 签名级与标量级均失败"}`)
  console.log(`T1-c dealer 缺口: ${fakeAcceptedNoExpected ? "CONFIRMED — 无 expectedVerificationShares 时假证明通过" : ""}${joinGapExploit ? "；即使传 expectedY，诚实证明+毒化多项式仍可静默毒化新群公钥（join 缺口）" : "（join 缺口未复现）"}`)
}

main().catch(e => { console.error("FATAL:", e?.message ?? e); process.exit(1) })
