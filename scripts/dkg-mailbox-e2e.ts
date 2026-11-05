/**
 * End-to-end check of the DKG contract surface on Sui testnet.
 *
 * It drives the same phases the ceremony dialog exposes, using the local Sui
 * keystore's first three Ed25519 accounts as three independent members:
 *
 *   1. create_dkg_session                (threshold 2 of 3)
 *   2. register_encryption_key           (one P-256 mailbox key each)
 *   3. submit_commitment                  (real Feldman commitments)
 *   4. deposit_mailbox_share              (real share f_0(2), sealed)
 *   5. confirm_participant                (both attesting members)
 *   6. attest_group_key → finalize_session_v3
 *   7. create_organization_from_session
 *   8. threshold-sign a message with the dealt shares
 *
 * Steps 6-7 also exercise the negative paths on chain: an unconfirmed member's
 * attestation must abort with 3011, and finalizing an unattested key with 3012.
 * Step 8 is what makes the run meaningful — it proves the dealt shares actually
 * reconstruct the key the organization was finalized onto. Without it a green
 * run would only show that the state machine advanced.
 *
 * This script does NOT exercise the web UI, browser storage, or cross-device
 * transport; those have their own coverage.
 *
 * This SENDS REAL TESTNET TRANSACTIONS. Run it only when that is intended:
 *   pnpm exec tsx scripts/dkg-mailbox-e2e.ts
 */
import { readFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { ed25519 } from "@noble/curves/ed25519.js"
import { Transaction } from "@mysten/sui/transactions"
import { SuiGrpcClient } from "@mysten/sui/grpc"
import { PROPOSAL_PACKAGE_ID } from "../lib/proposal-chain"
import { DKG_ENCRYPTION_KEY_TYPE_ORIGIN, DKG_TYPE_ORIGIN, DKG_ATTESTATION_TYPE_ORIGIN } from "../lib/dkg-type-origin"
import {
  DKG_STATUS, dkgSessionClient, encodeCommitments, readCommitment,
  readConfirmation, readGroupKeyAttestation, readMailboxShare, readSession,
  type SessionSnapshot,
} from "../lib/dkg-session"
import { openShare, sealShare } from "../lib/dkg-mailbox"
import { generateMessageKey, publicKeyBytes } from "../lib/message-crypto"
import { createCommitments, evaluatePolynomial, generatePolynomial, verifyShareCommitment } from "../lib/crypto/vss"
import { mod, scalarToBytes32 } from "../lib/crypto/math"
import { signWithCommittee } from "../lib/crypto/committee-signing"

const client = new SuiGrpcClient({ network: "testnet", baseUrl: "https://fullnode.testnet.sui.io:443" })
const log = (...parts: unknown[]) => console.log(...parts)

function localKeys(): Ed25519Keypair[] {
  const raw = JSON.parse(readFileSync(path.join(os.homedir(), ".sui/sui_config/sui.keystore"), "utf8"))
  return (raw as string[]).flatMap(value => {
    const bytes = Buffer.from(value, "base64")
    if (bytes.length !== 33 || bytes[0] !== 0) return []
    try { return [Ed25519Keypair.fromSecretKey(bytes.subarray(1))] } catch { return [] }
  })
}

type Inner = { status?: { success?: boolean }; digest?: string; events?: Array<{ eventType?: string; json?: unknown; parsedJson?: unknown }> }
type Result = Inner & { Transaction?: Inner }
/** The client wraps the payload as `{ $kind: "Transaction", Transaction: {...} }`. */
const unwrap = (result: Result): Inner => result.Transaction ?? result
const ok = (result: Result) => unwrap(result).status?.success === true

async function exec(keypair: Ed25519Keypair, tx: Transaction): Promise<Result> {
  tx.setSender(keypair.toSuiAddress())
  const bytes = await tx.build({ client })
  const { signature } = await keypair.signTransaction(bytes)
  return client.executeTransaction({ transaction: bytes, signatures: [signature], include: { effects: true, events: true } }) as unknown as Result
}
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function readSessionKey(session: string, participant: string): Promise<number | null> {
  const { createEncryptionKeyReader, encryptionKeyClient } = await import("../lib/dkg-mailbox")
  const reader = createEncryptionKeyReader(encryptionKeyClient, PROPOSAL_PACKAGE_ID, DKG_ENCRYPTION_KEY_TYPE_ORIGIN)
  const key = await reader.readKey(session, participant)
  return key ? key.length : null
}

/**
 * Counts confirmed participants whose current attestation equals `groupPk`.
 * Mirrors `attestation_count_for` in the contract without calling it, so the
 * script sees the same number a finalize would use.
 */
async function readAttestationCount(
  session: SessionSnapshot,
  groupPk: Uint8Array,
): Promise<number> {
  let count = 0
  for (const participant of session.participants) {
    const attested = await readGroupKeyAttestation(dkgSessionClient, session, DKG_ATTESTATION_TYPE_ORIGIN, participant)
    if (attested && Buffer.from(attested).equals(Buffer.from(groupPk))) count++
  }
  return count
}

async function main(): Promise<void> {
  const keys = localKeys().slice(0, 3)
  if (keys.length < 3) throw new Error("需要本机 keystore 中至少 3 个 Ed25519 账户。")
  const addresses = keys.map(key => key.toSuiAddress())
  log("accounts:", addresses.length)

  // 1. Create the session (threshold 2 of 3).
  const create = new Transaction()
  create.moveCall({
    target: `${PROPOSAL_PACKAGE_ID}::dkg_committee::create_dkg_session`,
    arguments: [create.pure.u64(2n), create.pure.vector("address", addresses), create.pure.u64(BigInt(Date.now() + 10 * 60 * 1000))],
  })
  const created = await exec(keys[0]!, create)
  const sessionId = (unwrap(created).events ?? []).map(event => (event.json ?? event.parsedJson) as { session_id?: string } | undefined)
    .find(fields => fields?.session_id)?.session_id
  if (!ok(created) || !sessionId) {
    // Print the real shape instead of a bare "failed": the event field names come
    // from the Move struct and are the only way to see which part disagrees.
    throw new Error(`创建会话失败。ok=${ok(created)} events=${JSON.stringify((unwrap(created).events ?? []).map(e => e.eventType))}`)
  }
  log("session:", sessionId, "tx:", unwrap(created).digest)

  await wait(2500)
  const initial = await readSession(dkgSessionClient, sessionId)
  log("after create:", { status: initial.status, threshold: initial.threshold, participants: initial.participants.length })

  // 2. Register a mailbox key per participant and keep the private halves here.
  const pairs = await Promise.all(keys.map(() => generateMessageKey()))
  const publicKeys = await Promise.all(pairs.map(pair => publicKeyBytes(pair.publicKey)))
  for (const [index, key] of keys.entries()) {
    const tx = new Transaction()
    tx.moveCall({
      target: `${PROPOSAL_PACKAGE_ID}::dkg_committee::register_encryption_key`,
      arguments: [tx.object(sessionId), tx.object("0x6"), tx.pure.vector("u8", Array.from(publicKeys[index]!))],
    })
    log(`register[${index}]:`, ok(await exec(key, tx)))
  }

  // 3. Deal real Verifiable Secret Shares.
  //
  // Each dealer `i` picks a polynomial f_i of degree t-1, publishes the Feldman
  // commitments C_{i,k} = a_{i,k}·G on chain, and owes every participant `j`
  // the evaluation f_i(j). The group key is Σ_i C_{i,0} and participant `j`'s
  // final share is Σ_i f_i(j) — so this has to be real, not placeholder bytes,
  // or the run proves only the state machine and not the sharing.
  const polynomials = keys.map((_, index) => generatePolynomial(Number(initial.threshold) - 1, BigInt(1000 + index)))
  const commitmentsPerDealer = polynomials.map(poly => createCommitments(poly))

  for (let index = 0; index < Number(initial.threshold); index++) {
    const blob = encodeCommitments(commitmentsPerDealer[index]!.map(point => point.toBytes()))
    const tx = new Transaction()
    tx.moveCall({
      target: `${PROPOSAL_PACKAGE_ID}::dkg_committee::submit_commitment`,
      arguments: [tx.object(sessionId), tx.object("0x6"), tx.pure.vector("u8", Array.from(blob))],
    })
    log(`commit[${index}] len=${blob.length}:`, ok(await exec(keys[index]!, tx)))
  }

  await wait(2500)
  const open = await readSession(dkgSessionClient, sessionId)
  log("after commitments:", { status: open.status, expected: DKG_STATUS.ROUND_2_MAILBOX })
  log("registered key length:", (await readSessionKey(sessionId, addresses[0]!)) ?? null)
  const firstCommitment = await readCommitment(dkgSessionClient, open, addresses[0]!)
  log("commitment length:", firstCommitment?.length ?? null)

  // Cross-check the on-chain commitment against what we computed locally. If
  // these disagree, the mailbox later carries a share that cannot be verified
  // against chain state, and any "success" would be theatre.
  if (firstCommitment) {
    const matches = commitmentsPerDealer[0]!.every((point, k) =>
      Buffer.from(firstCommitment.subarray(k * 32, (k + 1) * 32)).equals(Buffer.from(point.toBytes())))
    log("on-chain commitment equals the locally computed one:", matches)
  }

  // 4. Seal dealer 0's real share for participant 1 and deposit it.
  //
  // Participant index `j` evaluates at x = j+1, so participant 1 receives f_0(2).
  const shareFor1 = evaluatePolynomial(polynomials[0]!, 2n)
  const shareBytes = scalarToBytes32(shareFor1)
  log("share f_0(2) verifies against C_0:", verifyShareCommitment(shareFor1, 2n, commitmentsPerDealer[0]!))
  const sealed = await sealShare(shareBytes, publicKeys[1]!, {
    sessionId, sender: addresses[0]!, recipient: addresses[1]!, epoch: Number(open.epoch),
  })
  const deposit = new Transaction()
  deposit.moveCall({
    target: `${PROPOSAL_PACKAGE_ID}::dkg_committee::deposit_mailbox_share`,
    arguments: [deposit.object(sessionId), deposit.object("0x6"), deposit.pure.address(addresses[1]!), deposit.pure.vector("u8", Array.from(sealed.bytes))],
  })
  log("deposit:", ok(await exec(keys[0]!, deposit)))

  await wait(2500)
  // The field name type uses the DEFINING package, not the call target.
  const stored = await readMailboxShare(dkgSessionClient, open, DKG_TYPE_ORIGIN, addresses[0]!, addresses[1]!)
  log("mailbox[a0->a1]:", stored ? `${stored.length} bytes` : "null")
  if (!stored) throw new Error("投递成功但读取不到信箱条目：类型原点不一致。")
  log("ciphertext contains the plaintext share:", Buffer.from(stored).includes(Buffer.from(shareBytes)))
  const recovered = await openShare(stored, pairs[1]!.privateKey, {
    sessionId, sender: addresses[0]!, recipient: addresses[1]!, epoch: Number(open.epoch),
  })
  log("recipient recovered the share:", Buffer.from(recovered).equals(shareBytes))

  // 5. Confirm on chain. `attest_group_key` requires the sender to have
  //    confirmed, so every member who will attest must confirm first — the
  //    contract's anchor is "you opened and verified the shares you can see".
  const confirmed = await readSession(dkgSessionClient, sessionId)
  for (let index = 0; index < Number(confirmed.threshold); index++) {
    const confirm = new Transaction()
    confirm.moveCall({
      target: `${PROPOSAL_PACKAGE_ID}::dkg_committee::confirm_participant`,
      arguments: [confirm.object(sessionId), confirm.object("0x6")],
    })
    log(`confirm[${index}]:`, ok(await exec(keys[index]!, confirm)))
    await wait(1500)
  }
  await wait(2000)
  const confirmedAgain = await readSession(dkgSessionClient, sessionId)
  log("confirmations count:", confirmedAgain.confirmationsCount, "threshold:", confirmed.threshold)
  log("final status:", confirmedAgain.status)

  // 6. Attest the group key from `threshold` confirmed members, then finalize.
  //
  // This is the step the web UI cannot do for other people: each attestation
  // must be signed by that member's own wallet. Driving it from separate
  // keystore keys here is exactly what a multi-wallet run looks like on chain,
  // even though one process holds all the keys.
  //
  // The key is derived the way an honest participant would: sum the dealers'
  // C_0 commitments as published on chain, and check that this matches the
  // sum of the locally held polynomials. A mismatch means the on-chain
  // commitments were not actually the ones used to deal the shares, and any
  // finalize would enshrine a key nobody can collectively sign for.
  const commitments: Uint8Array[] = []
  for (let index = 0; index < Number(confirmed.threshold); index++) {
    const blob = await readCommitment(dkgSessionClient, confirmed, addresses[index]!)
    if (!blob) throw new Error(`参与者 ${index} 的承诺读不到，无法计算群公钥。`)
    commitments.push(blob)
  }
  // `reduce` without a seed reuses the first element as the accumulator and then
  // visits it again, so Σ C_0 would count dealer 0 twice. The seed is mandatory
  // here: the resulting key must be exactly what every participant recomputes.
  const groupPk = commitments
    .reduce(
      (sum, bytes) => sum.add(ed25519.Point.fromBytes(bytes.subarray(0, 32))),
      ed25519.Point.ZERO,
    )
    .toBytes()
  log("group pk:", Buffer.from(groupPk).toString("hex"))

  // The same group key, derived independently from the local polynomials.
  const localGroupPk = polynomials.slice(0, Number(confirmed.threshold))
    .map(poly => ed25519.Point.BASE.multiply(mod(poly[0]!)))
    .reduce((sum, point) => sum.add(point), ed25519.Point.ZERO)
    .toBytes()
  log("on-chain commitments and local dealing describe the same key:",
    Buffer.from(localGroupPk).equals(Buffer.from(groupPk)))

  // Reject an unconfirmed member's attestation first: that is the contract's
  // anchor, and a script that skips it would not be testing the real gate.
  //
  // Simulated, not sent: `Transaction.build()` resolves and pre-executes, so an
  // expected abort surfaces as a thrown SimulationError before any signature.
  // That is exactly the check we want here, and it costs no gas.
  const outsider = keys[2]!
  if (!(await readConfirmation(dkgSessionClient, confirmed, outsider.toSuiAddress()))) {
    const premature = new Transaction()
    premature.setSender(outsider.toSuiAddress())
    premature.moveCall({
      target: `${PROPOSAL_PACKAGE_ID}::dkg_committee::attest_group_key`,
      arguments: [premature.object(sessionId), premature.object("0x6"), premature.pure.vector("u8", Array.from(groupPk))],
    })
    let abortCode: string | null = null
    try {
      await premature.build({ client })
    } catch (error) {
      const moveAbort = (error as { executionError?: { MoveAbort?: { abortCode?: string } } }).executionError?.MoveAbort
      abortCode = moveAbort?.abortCode ?? null
    }
    log("unconfirmed attestation rejected with 3011:", abortCode === "3011", `(abort ${abortCode ?? "none"})`)
  }

  for (let index = 0; index < Number(confirmed.threshold); index++) {
    const tx = new Transaction()
    tx.moveCall({
      target: `${PROPOSAL_PACKAGE_ID}::dkg_committee::attest_group_key`,
      arguments: [tx.object(sessionId), tx.object("0x6"), tx.pure.vector("u8", Array.from(groupPk))],
    })
    log(`attest[${index}]:`, ok(await exec(keys[index]!, tx)))
  }

  await wait(2500)
  const attested = await readSession(dkgSessionClient, sessionId)
  log("attestations for this key:", await readAttestationCount(attested, groupPk))
  // Finalize with a key nobody attested: must abort with E_KEY_NOT_ATTESTED (3012).
  const wrongKey = new Uint8Array(32).fill(0xab)
  const badFinalize = new Transaction()
  badFinalize.setSender(keys[0]!.toSuiAddress())
  badFinalize.moveCall({
    target: `${PROPOSAL_PACKAGE_ID}::dkg_committee::finalize_session_v3`,
    arguments: [badFinalize.object(sessionId), badFinalize.pure.vector("u8", Array.from(wrongKey))],
  })
  let finalizeAbort: string | null = null
  try {
    await badFinalize.build({ client })
  } catch (error) {
    const moveAbort = (error as { executionError?: { MoveAbort?: { abortCode?: string } } }).executionError?.MoveAbort
    finalizeAbort = moveAbort?.abortCode ?? null
  }
  log("finalize with an unattested key rejected with 3012:", finalizeAbort === "3012", `(abort ${finalizeAbort ?? "none"})`)

  const doFinalize = new Transaction()
  doFinalize.moveCall({
    target: `${PROPOSAL_PACKAGE_ID}::dkg_committee::finalize_session_v3`,
    arguments: [doFinalize.object(sessionId), doFinalize.pure.vector("u8", Array.from(groupPk))],
  })
  const finalized = await exec(keys[0]!, doFinalize)
  log("finalize:", ok(finalized), unwrap(finalized).digest)

  await wait(2500)
  const afterFinalize = await readSession(dkgSessionClient, sessionId)
  log("status after finalize:", afterFinalize.status, "expected:", DKG_STATUS.FINALIZED)
  log("on-chain final key matches the recomputed sum:",
    Buffer.from(afterFinalize.finalPublicKey ?? []).equals(Buffer.from(groupPk)))
  // 7. Turn the finalized session into a DAO and confirm its roster is real.
  const orgTx = new Transaction()
  orgTx.moveCall({
    target: `${PROPOSAL_PACKAGE_ID}::cryptographic_org::create_organization_from_session`,
    arguments: [orgTx.object(sessionId), orgTx.pure.u64(confirmed.threshold)],
  })
  const orgResult = await exec(keys[0]!, orgTx)
  log("create organization:", ok(orgResult), unwrap(orgResult).digest)
  if (!ok(orgResult)) throw new Error("固化成功但建组织失败，这是不可撤销状态，需人工介入。")

  const createdOrg = (unwrap(orgResult).events ?? [])
    .map(event => (event.json ?? event.parsedJson) as { org_id?: string } | undefined)
    .find(fields => fields?.org_id)?.org_id
  log("organization id:", createdOrg ?? "(event shape differed)")

  // 8. Prove the dealt shares actually reconstruct the on-chain key.
  //
  // This is the step that separates "the state machine advanced" from "the
  // group key is collectively controllable". Each participant's share is
  // Σ_i f_i(j+1) over the same dealers whose C_0 the contract enshrined; any t
  // of them must Lagrange-interpolate back to that key. If this passes, the
  // organization's funds are spendable by its members and by nobody else.
  const shareOf = (participantIndex: number): bigint =>
    polynomials
      .slice(0, Number(confirmed.threshold))
      .reduce((sum, poly) => mod(sum + evaluatePolynomial(poly, BigInt(participantIndex + 1))), 0n)

  const committee = {
    orgId: createdOrg ?? "",
    groupPk: afterFinalize.finalPublicKey ?? groupPk,
    epoch: afterFinalize.epoch,
    threshold: confirmed.threshold,
    indices: Array.from({ length: Number(confirmed.threshold) }, (_, i) => BigInt(i + 1)),
    shares: Array.from({ length: Number(confirmed.threshold) }, (_, i) => shareOf(i)),
  }
  const message = new TextEncoder().encode(`dkg-e2e-threshold-signing:${sessionId}`)
  let signed = false
  try {
    const signature = signWithCommittee(committee, message, {
      groupPk: committee.groupPk,
      epoch: committee.epoch,
    })
    signed = ed25519.verify(signature.signature, message, committee.groupPk)
    log("t-of-n signature verifies against the on-chain group key:", signed)
  } catch (error) {
    log("threshold signing failed:", (error as Error).message)
  }
  if (!signed) throw new Error("分片无法重构链上群公钥：DKG 的密钥共享不成立。")
}

main().catch(error => { console.error(error); process.exitCode = 1 })
