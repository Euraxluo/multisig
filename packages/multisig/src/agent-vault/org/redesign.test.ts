/**
 * 文件级单测：新摘要 / PTB 构造器 / BCS 解析（Organization.key_signers、
 * AgentVault 4 个流出策略 u64）。期望值全部用 node:crypto 的 sha256 +
 * Buffer.concat 手工重排字节布局，与实现零共享代码。
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from './vitest-shim';
import { bcs } from '@mysten/sui/bcs';
import {
  computeCreatePopDigest,
  computeKeyRotationDigest,
  computeRotatePopDigest,
  computeTreasuryTransferDigest,
} from './digest';
import {
  buildCreateOrganizationPTB,
  buildRotateGroupKeyPTB,
  buildSetOutflowPolicyPTB,
} from './builders';
import { parseOrganization } from './reader';
import { AgentVaultBcs, parseFinanceBcs } from '../finance/schemas';
import { buildExecuteTreasuryTransfer } from '../finance/treasury';

const sha256 = (...parts: Uint8Array[]) => createHash('sha256').update(Buffer.concat(parts)).digest();
const A = (hex: string) => Buffer.from(hex.replace(/^0x/, '').padStart(64, '0'), 'hex');
const u64 = (v: bigint) => Buffer.from(v.toString(16).padStart(16, '0').match(/../g)!.reverse().join(''), 'hex');
const uleb = (n: number) => n < 128 ? Buffer.from([n]) : Buffer.from([(n & 0x7f) | 0x80, n >> 7]);
const txt = (s: string) => Buffer.from(s, 'utf8');

const CHAIN = 'sui-testnet:';
const ORGID = '0x' + 'aa'.repeat(32);
const PK = Buffer.alloc(32, 0xab);
const PK2 = Buffer.alloc(32, 0xcd);
const ORG = A(ORGID);
const M1 = A('0x' + '11'.repeat(32));
const M2 = A('0x' + '22'.repeat(32));

describe('computeCreatePopDigest', () => {
  it('equals hand-computed H(SUI_ORG_POP_V1: || chain || pk || bcs(members) || bcs(weights) || bcs(threshold))', () => {
    const expected = sha256(
      txt('SUI_ORG_POP_V1:'), txt(CHAIN), PK,
      uleb(2), M1, M2,
      uleb(2), u64(3n), u64(7n),
      u64(5n),
    );
    expect(Buffer.from(computeCreatePopDigest({ chainId: CHAIN, groupPk: PK, members: [M1, M2].map(b => '0x' + b.toString('hex')), weights: [3n, 7n], thresholdWeight: 5n })))
      .toEqual(expected);
  });
});

describe('computeRotatePopDigest', () => {
  it('equals hand-computed H(SUI_ORG_POP_V1: || chain || bcs(org_id) || bcs(epoch) || new_pk)', () => {
    const expected = sha256(txt('SUI_ORG_POP_V1:'), txt(CHAIN), ORG, u64(9n), PK2);
    expect(Buffer.from(computeRotatePopDigest({ chainId: CHAIN, orgId: ORGID, newEpochVersion: 9n, newGroupPk: PK2 }))).toEqual(expected);
  });
});

describe('computeKeyRotationDigest (V2)', () => {
  it('binds new signers after the new public key', () => {
    const expected = sha256(
      txt('SUI_ORG_KEY_ROTATION_V2:'), txt(CHAIN), ORG, u64(4n), u64(11n), PK2,
      uleb(2), M1, M2,
    );
    expect(Buffer.from(computeKeyRotationDigest({
      chainId: CHAIN, orgId: ORGID, epochVersion: 4n, nonce: 11n, newGroupPk: PK2,
      newSigners: [M1, M2].map(b => '0x' + b.toString('hex')),
    }))).toEqual(expected);
  });
});

describe('computeTreasuryTransferDigest', () => {
  it('equals hand-computed H(SUI_ORG_TREASURY_TRANSFER_V1: || … || proposal || recipient || amount)', () => {
    const prop = A('0x' + 'aa'.repeat(32));
    const recv = A('0x' + 'bb'.repeat(32));
    const expected = sha256(
      txt('SUI_ORG_TREASURY_TRANSFER_V1:'), txt(CHAIN), ORG, u64(6n), u64(21n), prop, recv, u64(1_000_000n),
    );
    expect(Buffer.from(computeTreasuryTransferDigest({
      chainId: CHAIN, orgId: ORGID, epochVersion: 6n, nonce: 21n,
      proposalId: '0x' + 'aa'.repeat(32), recipient: '0x' + 'bb'.repeat(32), amount: 1_000_000n,
    }))).toEqual(expected);
  });
});

/** PTB 断言：从序列化后的命令里取目标与参数个数（不依赖内部结构）。 */
function firstMoveCall(tx: ReturnType<typeof buildCreateOrganizationPTB>) {
  const data = tx.getData();
  const command = data.commands[0] as { MoveCall?: { module: string; function: string; arguments: unknown[] } };
  return command.MoveCall!;
}

describe('builders', () => {
  const pkg = '0x' + 'ee'.repeat(32);
  it('buildCreateOrganizationPTB targets create_organization with 5 args', () => {
    const call = firstMoveCall(buildCreateOrganizationPTB({ packageId: pkg, groupPk: PK, thresholdWeight: 2n, members: ['0x' + '11'.repeat(32)], weights: [2n], popSignature: new Uint8Array(64) }));
    expect(call.module).toBe('cryptographic_org');
    expect(call.function).toBe('create_organization');
    expect(call.arguments.length).toBe(5);
  });
  it('buildRotateGroupKeyPTB targets rotate_group_key with 6 args and rejects duplicates', () => {
    const call = firstMoveCall(buildRotateGroupKeyPTB({ packageId: pkg, orgId: ORGID, nonce: 3n, newGroupPk: PK2, newSigners: ['0x' + '11'.repeat(32), '0x' + '22'.repeat(32)], popSignature: new Uint8Array(64), frostSignature: new Uint8Array(64) }));
    expect(call.function).toBe('rotate_group_key');
    expect(call.arguments.length).toBe(6);
    const dup = '0x' + '33'.repeat(32);
    expect(() => buildRotateGroupKeyPTB({ packageId: pkg, orgId: ORGID, nonce: 3n, newGroupPk: PK2, newSigners: [dup, dup], popSignature: new Uint8Array(64), frostSignature: new Uint8Array(64) })).toThrow(/重复/);
    expect(() => buildRotateGroupKeyPTB({ packageId: pkg, orgId: ORGID, nonce: 3n, newGroupPk: PK2, newSigners: [], popSignature: new Uint8Array(64), frostSignature: new Uint8Array(64) })).toThrow(/1\.\./);
  });
  it('buildSetOutflowPolicyPTB targets vault::set_outflow_policy with 4 args + typeArg', () => {
    const data = buildSetOutflowPolicyPTB({ packageId: pkg, coinType: '0x2::sui::SUI', masterCapId: '0x1235', vaultId: '0x1236', maxEpochOutflow: 10n, maxAgentBudget: 5n }).getData();
    const call = (data.commands[0] as { MoveCall: { module: string; function: string; arguments: unknown[]; typeArguments: string[] } }).MoveCall;
    expect(`${call.module}::${call.function}`).toBe('vault::set_outflow_policy');
    expect(call.arguments.length).toBe(4);
    expect(call.typeArguments ?? []).toBeTruthy();
  });
  it('buildExecuteTreasuryTransfer passes nonce + frostSignature before clock', () => {
    const data = buildExecuteTreasuryTransfer({ packageId: pkg, treasuryId: '0x1', bindingId: '0x2', orgId: '0x3', proposalId: '0x4', vaultId: '0x5', nonce: 8n, frostSignature: new Uint8Array(64) }).getData();
    const call = (data.commands[0] as { MoveCall: { function: string; arguments: unknown[] } }).MoveCall;
    expect(call.function).toBe('execute');
    expect(call.arguments.length).toBe(8);
  });
});

describe('readers / schemas', () => {
  it('parseOrganization accepts trailing key_signers vector<address>', () => {
    const table = (id: number) => Buffer.concat([A('0x' + id.toString(16).padStart(64, '0')), u64(0n)]);
    const bytes = Buffer.concat([
      ORG, // id
      uleb(32), PK, // group_pk
      u64(2n), // threshold
      u64(1n), // epoch
      u64(0n), // last_nonce
      uleb(CHAIN.length), txt(CHAIN), // chain_id
      table(0x20), table(0x21), // two Tables
      uleb(2), M1, M2, // key_signers
    ]);
    const snap = parseOrganization(bytes);
    expect(snap.keySigners).toEqual([M1, M2].map(b => '0x' + b.toString('hex')));
    expect(snap.memberCount).toBe(0n);
    // 缺尾随 key_signers 的旧布局必须被拒绝
    expect(() => parseOrganization(bytes.subarray(0, bytes.length - 65))).toThrow();
  });
  it('AgentVaultBcs parses 4 trailing u64 policy fields and rejects old layout', () => {
    const vault = {
      id: '0x' + 'aa'.repeat(32), balance: '1000', vault_version: '1', total_subagents: '0', paused: false,
      agents: { contents: [] },
      max_epoch_outflow: '999', epoch_outflow: '10', outflow_epoch: '7', max_agent_budget: '55',
    };
    const bytes = AgentVaultBcs.serialize(vault).toBytes();
    const parsed = parseFinanceBcs(AgentVaultBcs, bytes);
    expect(parsed.max_epoch_outflow).toBe('999');
    expect(parsed.outflow_epoch).toBe('7');
    expect(parsed.max_agent_budget).toBe('55');
    expect(() => parseFinanceBcs(AgentVaultBcs, bytes.subarray(0, bytes.length - 32))).toThrow();
  });
});
