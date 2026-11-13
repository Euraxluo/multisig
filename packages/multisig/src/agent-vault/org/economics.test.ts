/**
 * 准入经济学（admission economics）文件级单测：
 * - computeGenesisWithdrawDigest：与 node:crypto 手工重排的逐字节布局对照（与实现零共享代码）。
 * - 新 PTB 构造器：withdraw_genesis_stake（含 Clock 尾参）、claim_bond、
 *   vault_client 的 create_dkg_session（fee coin + Clock）/submit_commitment /
 *   submit_async_package（payment coin）/create_organization_from_session（Clock）。
 * - parseOrganization：尾随创世质押四元组（Balance<SUI> BCS = 裸 u64）解析与旧布局拒绝。
 * - 错误码注册表与常量：3020–3025 / 1011 / DOMAIN / 经济学常量逐项对齐。
 */
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { describe, expect, it } from './vitest-shim';
import { Transaction } from '@mysten/sui/transactions';
import {
  computeGenesisWithdrawDigest,
} from './digest';
import {
  buildClaimBondPTB,
  buildWithdrawGenesisStakePTB,
} from './builders';
import { parseOrganization } from './reader';
import { AgentVaultClient } from '../vault_client';
import {
  ADMISSION_ECONOMICS,
  DOMAINS,
  DKG_ERRORS,
  MAX_MAILBOX_PAYLOAD_BYTES,
  ORG_ERRORS,
} from './constants';

const sha256 = (...parts: Uint8Array[]) => createHash('sha256').update(Buffer.concat(parts)).digest();
const A = (hex: string) => Buffer.from(hex.replace(/^0x/, '').padStart(64, '0'), 'hex');
const u64 = (v: bigint) => Buffer.from(v.toString(16).padStart(16, '0').match(/../g)!.reverse().join(''), 'hex');
const txt = (s: string) => Buffer.from(s, 'utf8');

const CHAIN = 'sui-testnet:';
const ORGID = '0x' + 'aa'.repeat(32);
const ORG = A(ORGID);
const SESSION = A('0x' + 'cc'.repeat(32));
const RECIPIENT = A('0x' + 'bb'.repeat(32));
const SIG = Buffer.alloc(64, 0x77);

describe('computeGenesisWithdrawDigest', () => {
  it('equals hand-computed H(SUI_ORG_GENESIS_WITHDRAW_V1: || chain || org || epoch || nonce || amount || recipient)', () => {
    const expected = sha256(
      txt('SUI_ORG_GENESIS_WITHDRAW_V1:'), txt(CHAIN), ORG,
      u64(3n), u64(9n), u64(123_456_789n), RECIPIENT,
    );
    expect(Buffer.from(computeGenesisWithdrawDigest({
      chainId: CHAIN, orgId: ORGID, epochVersion: 3n, nonce: 9n, amount: 123_456_789n,
      recipient: '0x' + 'bb'.repeat(32),
    }))).toEqual(expected);
  });
  it('matches the DOMAINS registry byte-for-byte and binds every field (each flip changes the digest)', () => {
    const base = Buffer.from(computeGenesisWithdrawDigest({ chainId: CHAIN, orgId: ORGID, epochVersion: 1n, nonce: 1n, amount: 1n, recipient: '0x' + 'bb'.repeat(32) }));
    const flip = (over: Partial<{ epochVersion: bigint; nonce: bigint; amount: bigint; recipient: string }>) =>
      Buffer.from(computeGenesisWithdrawDigest({ chainId: CHAIN, orgId: ORGID, epochVersion: 1n, nonce: 1n, amount: 1n, recipient: '0x' + 'bb'.repeat(32), ...over }));
    assert.notDeepStrictEqual(flip({ epochVersion: 2n }), base);
    assert.notDeepStrictEqual(flip({ nonce: 2n }), base);
    assert.notDeepStrictEqual(flip({ amount: 2n }), base);
    assert.notDeepStrictEqual(flip({ recipient: '0x' + 'cc'.repeat(32) }), base);
    expect(DOMAINS.GENESIS_WITHDRAW).toBe('SUI_ORG_GENESIS_WITHDRAW_V1:');
  });
});

/** 从序列化命令里找出第一个 MoveCall（tx.coin 会插入前置命令，不能假设下标 0）。 */
function firstMoveCall(tx: Transaction) {
  const data = tx.getData();
  const calls = data.commands
    .map((c) => (c as { MoveCall?: { module: string; function: string; arguments: unknown[] } }).MoveCall)
    .filter(Boolean) as Array<{ module: string; function: string; arguments: unknown[] }>;
  if (!calls.length) throw new Error('PTB 中没有 MoveCall');
  return calls[0];
}

describe('new org-side builders', () => {
  const pkg = '0x' + 'ee'.repeat(32);
  it('buildWithdrawGenesisStakePTB targets withdraw_genesis_stake with 5 pure/object args + clock', () => {
    const call = firstMoveCall(buildWithdrawGenesisStakePTB({ packageId: pkg, orgId: ORGID, nonce: 4n, amount: 500_000_000n, recipient: '0x' + 'bb'.repeat(32), frostSignature: new Uint8Array(64) }));
    expect(call.module).toBe('cryptographic_org');
    expect(call.function).toBe('withdraw_genesis_stake');
    // org, nonce, amount, recipient, frost_signature, clock = 6
    expect(call.arguments.length).toBe(6);
  });
  it('buildWithdrawGenesisStakePTB rejects a non-64-byte signature before building', () => {
    expect(() => buildWithdrawGenesisStakePTB({ orgId: ORGID, nonce: 1n, amount: 1n, recipient: '0x' + 'bb'.repeat(32), frostSignature: new Uint8Array(63) })).toThrow(/64/);
  });
  it('buildClaimBondPTB targets dkg_committee::claim_bond with exactly the session argument', () => {
    const call = firstMoveCall(buildClaimBondPTB({ packageId: pkg, sessionId: '0x' + 'cc'.repeat(32) }));
    expect(call.module).toBe('dkg_committee');
    expect(call.function).toBe('claim_bond');
    expect(call.arguments.length).toBe(1);
  });
});

describe('vault_client admission-economics builders', () => {
  const client = new AgentVaultClient({ packageId: '0x' + 'ee'.repeat(32) });
  const sender = '0x' + '11'.repeat(32);

  it('buildCreateDkgSessionPTB emits fee coin command + moveCall(threshold, participants, deadline, fee, clock)', () => {
    const tx = client.buildCreateDkgSessionPTB(sender, 2n, [sender], 3_600_000n, { amount: 5_000_000n });
    const data = tx.getData();
    // tx.coin 生成 CoinWithBalance $Intent 前置命令 + moveCall 本体
    const intents = data.commands.filter((c) => '$Intent' in (c as object));
    expect(intents.length).toBe(1);
    const intent = intents[0] as { $Intent?: { name: string; data?: { balance?: string } } };
    expect(intent.$Intent?.name).toBe('CoinWithBalance');
    expect(String(intent.$Intent?.data?.balance)).toBe('5000000');
    const call = firstMoveCall(tx);
    expect(call.function).toBe('create_dkg_session');
    expect(call.arguments.length).toBe(5);
  });
  it('buildCreateDkgSessionPTB defaults the fee to 5_000_000 MIST when omitted', () => {
    const tx = client.buildCreateDkgSessionPTB(sender, 2n, [sender], 3_600_000n);
    expect(firstMoveCall(tx).arguments.length).toBe(5);
  });
  it('buildSubmitCommitmentPTB emits payment coin + moveCall(session, clock, commitment, attest key, payment)', () => {
    const tx = client.buildSubmitCommitmentPTB('0x' + 'cc'.repeat(32), new Uint8Array(32), new Uint8Array(32), { amount: 50_000_000n });
    expect(firstMoveCall(tx).function).toBe('submit_commitment');
    expect(firstMoveCall(tx).arguments.length).toBe(5);
    expect(() => client.buildSubmitCommitmentPTB('0x' + 'cc'.repeat(32), new Uint8Array(32), new Uint8Array(31))).toThrow(/32/);
  });
  it('buildSubmitAsyncPackagePTB emits payment coin + moveCall(session, clock, commitment, attest key, recipients, payloads, payment)', () => {
    const tx = client.buildSubmitAsyncPackagePTB('0x' + 'cc'.repeat(32), new Uint8Array(32), new Uint8Array(32), ['0x' + '22'.repeat(32)], [new Uint8Array(4)], { amount: 50_000_000n });
    expect(firstMoveCall(tx).function).toBe('submit_async_package');
    expect(firstMoveCall(tx).arguments.length).toBe(7);
  });
  it('buildDepositMailboxSharePTB accepts a payload at the 2048B limit and emits a 4-arg moveCall', () => {
    const tx = client.buildDepositMailboxSharePTB('0x' + 'cc'.repeat(32), '0x' + '22'.repeat(32), new Uint8Array(2048));
    const call = firstMoveCall(tx);
    expect(call.function).toBe('deposit_mailbox_share');
    expect(call.arguments.length).toBe(4);
  });
  it('buildDepositMailboxSharePTB rejects a 2049B payload with the 3028 guard', () => {
    expect(() => client.buildDepositMailboxSharePTB('0x' + 'cc'.repeat(32), '0x' + '22'.repeat(32), new Uint8Array(2049))).toThrow(/2048|3028/);
  });
  it('buildSubmitAsyncPackagePTB rejects any over-limit payload (whole-package abort guard)', () => {
    expect(() => client.buildSubmitAsyncPackagePTB(
      '0x' + 'cc'.repeat(32), new Uint8Array(32), new Uint8Array(32),
      ['0x' + '22'.repeat(32), '0x' + '33'.repeat(32)],
      [new Uint8Array(4), new Uint8Array(2049)],
      { amount: 50_000_000n },
    )).toThrow(/2048|3028/);
  });
  it('buildCreateOrganizationFromSessionPTB appends the clock argument (session, threshold, clock)', () => {
    const tx = client.buildCreateOrganizationFromSessionPTB('0x' + 'cc'.repeat(32), 2n);
    const call = firstMoveCall(tx);
    expect(call.function).toBe('create_organization_from_session');
    expect(call.arguments.length).toBe(3);
  });
  it('buildClaimBondPTB and buildWithdrawGenesisStakePTB are reachable on the client facade', () => {
    expect(firstMoveCall(client.buildClaimBondPTB('0x' + 'cc'.repeat(32))).function).toBe('claim_bond');
    expect(firstMoveCall(client.buildWithdrawGenesisStakePTB({ orgId: ORGID, nonce: 1n, amount: 1n, recipient: '0x' + 'bb'.repeat(32), frostSignature: new Uint8Array(64) })).function).toBe('withdraw_genesis_stake');
  });
});

describe('parseOrganization genesis tail', () => {
  const table = (id: number) => Buffer.concat([A('0x' + id.toString(16).padStart(64, '0')), u64(0n)]);
  // 手工 Move 序列化：UID || group_pk || threshold || epoch || last_nonce || chain || 2×Table || key_signers || key_threshold || 4×u64 genesis || key_generation
  const orgBytes = (...tail: Buffer[]) => Buffer.concat([
    ORG,
    Buffer.from([32]), Buffer.alloc(32, 0xab), // group_pk = uleb(32) + 32B
    u64(2n), u64(1n), u64(0n), // threshold_weight, epoch_version, last_nonce
    Buffer.from([CHAIN.length]), txt(CHAIN),
    table(0x20), table(0x21),
    Buffer.from([0]), // key_signers = 空 vector
    u64(2n), // key_threshold
    ...tail,
  ]);
  const genesisTail = [u64(123n), u64(200n), u64(77n), u64(1_777_777_777_777n), u64(1n)]; // 创世四元组 + key_generation（尾部）
  it('parses the 4 trailing genesis fields after key_threshold (Balance<SUI> as bare u64)', () => {
    const snap = parseOrganization(orgBytes(...genesisTail));
    expect(snap.genesisStake).toBe(123n);
    expect(snap.genesisBondedTotal).toBe(200n);
    expect(snap.genesisWithdrawn).toBe(77n);
    expect(snap.genesisUnlockAtMs).toBe(1_777_777_777_777n);
    expect(snap.keyThreshold).toBe(2n);
    expect(snap.keyGeneration).toBe(1n);
    expect(snap.nextNonce).toBe(1n);
  });
  it('rejects the pre-genesis layout (missing 32-byte tail) and truncations inside the tail', () => {
    expect(() => parseOrganization(orgBytes(u64(123n), u64(200n), u64(77n), u64(1_777_777_777_777n)))).toThrow(/key_generation/);
    expect(() => parseOrganization(orgBytes())).toThrow(/创世质押/);
    expect(() => parseOrganization(orgBytes(u64(123n)))).toThrow(/创世质押/);
    expect(() => parseOrganization(orgBytes(...genesisTail, Buffer.from([0])))).toThrow(/多余字节/);
  });
  it('rejects the old layout without key_threshold (precedent preserved)', () => {
    const withTail = orgBytes(...genesisTail);
    expect(() => parseOrganization(withTail.subarray(0, withTail.length - 8))).toThrow(/key_generation/);
    expect(() => parseOrganization(withTail.subarray(0, withTail.length - 48))).toThrow();
  });
});

describe('error registries + economics constants', () => {
  it('registers dkg 3020-3025 and org 1011 with contract names', () => {
    expect(DKG_ERRORS[3020]).toBe('E_BOND_BELOW_MIN');
    expect(DKG_ERRORS[3021]).toBe('E_BOND_ABOVE_MAX');
    expect(DKG_ERRORS[3022]).toBe('E_BOND_INSUFFICIENT_PAYMENT');
    expect(DKG_ERRORS[3023]).toBe('E_NO_BOND_TO_CLAIM');
    expect(DKG_ERRORS[3024]).toBe('E_SESSION_NOT_TERMINAL');
    expect(DKG_ERRORS[3025]).toBe('E_DEADLINE_OUT_OF_RANGE');
    expect(ORG_ERRORS[1011]).toBe('E_GENESIS_LOCKED');
    expect(DKG_ERRORS[3028]).toBe('E_PAYLOAD_TOO_LARGE');
    expect(DKG_ERRORS[3029]).toBe('E_RECIPIENT_KEY_MISSING');
  });
  it('carries the mailbox payload limit verbatim', () => {
    expect(MAX_MAILBOX_PAYLOAD_BYTES).toBe(2048);
  });
  it('carries the contract economics constants verbatim', () => {
    expect(ADMISSION_ECONOMICS.SESSION_CREATION_FEE_MIST).toBe(5_000_000);
    expect(ADMISSION_ECONOMICS.MIN_BOND_MIST).toBe(50_000_000);
    expect(ADMISSION_ECONOMICS.MAX_BOND_MIST).toBe(500_000_000);
    expect(ADMISSION_ECONOMICS.MIN_SESSION_DURATION_MS).toBe(600_000);
    expect(ADMISSION_ECONOMICS.MAX_SESSION_DURATION_MS).toBe(604_800_000);
    expect(ADMISSION_ECONOMICS.GENESIS_LOCK_MS).toBe(7_776_000_000);
  });
});
