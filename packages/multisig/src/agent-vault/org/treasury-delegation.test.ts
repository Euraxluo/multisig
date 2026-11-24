/**
 * I3 组织金库门限授权（delegate_agent_authority / set_agent_outflow_policy）的
 * SDK 侧单测：
 * - 摘要：两个新域与 organization_treasury.move 逐字节一致（node:crypto 手工
 *   重排布局，与实现零共享代码），每个绑定字段翻转都改变摘要；
 * - 域隔离：AGENT 与 OUTFLOW 前缀互斥，且与 DOMAINS 注册表逐字节一致；
 * - builder：目标模块 / 参数序 / 链下镜像守卫（64 字节签名、operator 非零、
 *   授权上限为正；停机入口允许 0/0）；
 * - 错误码注册表：organization_treasury 1–14 与合约逐一对齐，explainAbort 可读；
 * - 会话动作：delegateAgent / setOutflowPolicy 从快照派生摘要（nonce =
 *   lastNonce+1，绑定 keyGeneration），FROST t-of-n 聚合签名后 buildPTB
 *   指向正确入口，verifyExecution 逐字段核验事件 BCS；
 * - PTB 一致性：把序列化后的 PTB 读回来，只用它的字节重算摘要，必须等于被
 *   签名的摘要（builder 与会话各一组）——builder 把两个上限写反、换一个
 *   operator、截短签名，都过不了这一关；
 * - 签名意图：sign() 把动作与绑定状态（SigningIntent）连同摘要交给 provider。
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from './vitest-shim';
import { Transaction } from '@mysten/sui/transactions';
import { ed25519 } from '@noble/curves/ed25519.js';
import { generatePolynomial, evaluatePolynomial } from '../../dkg/vss';
import { ThresholdSignerNode } from '../../dkg/threshold_signer';
import {
  computeTreasuryAgentDelegationDigest,
  computeTreasuryOutflowPolicyDigest,
  computeTreasuryTransferDigest,
} from './digest';
import {
  buildDelegateAgentAuthorityPTB,
  buildSetTreasuryOutflowPolicyPTB,
} from './builders';
import {
  ThresholdProposalSession, LocalMemoryShareProvider, verifyFrostSignature,
  type SessionAction, type SessionShareMaterial, type SessionShareProvider, type SigningIntent,
} from './session';
import type { OrganizationSnapshot } from './reader';
import { BcsReader, u64le } from './bcs';
import { AGENT_VAULT_PACKAGE_ID, DOMAINS, TREASURY_ERRORS, TREASURY_EVENTS, explainAbort } from './constants';
import type { SuiGrpcClient } from '@mysten/sui/grpc';

const sha256 = (...parts: Uint8Array[]) => createHash('sha256').update(Buffer.concat(parts)).digest();
const A = (hex: string) => Buffer.from(hex.replace(/^0x/, '').padStart(64, '0'), 'hex');
const u64 = (v: bigint) => Buffer.from(v.toString(16).padStart(16, '0').match(/../g)!.reverse().join(''), 'hex');
const txt = (s: string) => Buffer.from(s, 'utf8');

const CHAIN = 'sui-testnet:';
const ORGID = '0x' + 'aa'.repeat(32);
const ORG = A(ORGID);
const TREASURY = A('0x' + 'ee'.repeat(32));
const VAULT = A('0x' + 'ff'.repeat(32));
const OPERATOR = A('0x' + '99'.repeat(32));
const PK = Buffer.alloc(32, 0x01);

const agentInput = {
  chainId: CHAIN, orgId: ORGID, epochVersion: 2n, nonce: 31n,
  treasuryId: '0x' + 'ee'.repeat(32), vaultId: '0x' + 'ff'.repeat(32), operator: '0x' + '99'.repeat(32),
  maxEpochOutflow: 700n, maxAgentBudget: 80n, keyGeneration: 4n,
};
const outflowInput = {
  chainId: CHAIN, orgId: ORGID, epochVersion: 2n, nonce: 32n,
  treasuryId: '0x' + 'ee'.repeat(32), vaultId: '0x' + 'ff'.repeat(32),
  maxEpochOutflow: 0n, maxAgentBudget: 0n, keyGeneration: 4n,
};

describe('computeTreasuryAgentDelegationDigest (V1)', () => {
  it('equals hand-computed H(AGENT || chain || org || epoch || nonce || treasury || vault || operator || outflow || budget || kg)', () => {
    const expected = sha256(
      txt('SUI_ORG_TREASURY_AGENT_V1:'), txt(CHAIN), ORG, u64(2n), u64(31n),
      TREASURY, VAULT, OPERATOR, u64(700n), u64(80n), u64(4n),
    );
    expect(Buffer.from(computeTreasuryAgentDelegationDigest(agentInput))).toEqual(expected);
  });
  it('binds every field: each flip changes the digest', () => {
    const base = computeTreasuryAgentDelegationDigest(agentInput);
    const flip = (over: Partial<typeof agentInput>) =>
      Buffer.from(computeTreasuryAgentDelegationDigest({ ...agentInput, ...over }));
    expect(flip({ orgId: '0x' + 'ab'.repeat(32) }).equals(Buffer.from(base))).toBe(false);
    expect(flip({ epochVersion: 3n }).equals(Buffer.from(base))).toBe(false);
    expect(flip({ nonce: 32n }).equals(Buffer.from(base))).toBe(false);
    expect(flip({ treasuryId: '0x' + 'cd'.repeat(32) }).equals(Buffer.from(base))).toBe(false);
    expect(flip({ vaultId: '0x' + 'cd'.repeat(32) }).equals(Buffer.from(base))).toBe(false);
    expect(flip({ operator: '0x' + 'ab'.repeat(32) }).equals(Buffer.from(base))).toBe(false);
    expect(flip({ maxEpochOutflow: 701n }).equals(Buffer.from(base))).toBe(false);
    expect(flip({ maxAgentBudget: 81n }).equals(Buffer.from(base))).toBe(false);
    expect(flip({ keyGeneration: 5n }).equals(Buffer.from(base))).toBe(false);
  });
  it('rejects short treasury / vault / operator addresses before hashing', () => {
    expect(() => computeTreasuryAgentDelegationDigest({ ...agentInput, treasuryId: '0x1234' })).toThrow();
    expect(() => computeTreasuryAgentDelegationDigest({ ...agentInput, vaultId: '0x1234' })).toThrow();
    expect(() => computeTreasuryAgentDelegationDigest({ ...agentInput, operator: '0x1234' })).toThrow();
  });
});

describe('computeTreasuryOutflowPolicyDigest (V1)', () => {
  it('equals hand-computed H(OUTFLOW || chain || org || epoch || nonce || treasury || vault || outflow || budget || kg)', () => {
    const expected = sha256(
      txt('SUI_ORG_TREASURY_OUTFLOW_V1:'), txt(CHAIN), ORG, u64(2n), u64(32n),
      TREASURY, VAULT, u64(0n), u64(0n), u64(4n),
    );
    expect(Buffer.from(computeTreasuryOutflowPolicyDigest(outflowInput))).toEqual(expected);
  });
  it('binds every field: each flip changes the digest', () => {
    const base = computeTreasuryOutflowPolicyDigest(outflowInput);
    const flip = (over: Partial<typeof outflowInput>) =>
      Buffer.from(computeTreasuryOutflowPolicyDigest({ ...outflowInput, ...over }));
    expect(flip({ orgId: '0x' + 'ab'.repeat(32) }).equals(Buffer.from(base))).toBe(false);
    expect(flip({ epochVersion: 3n }).equals(Buffer.from(base))).toBe(false);
    expect(flip({ nonce: 33n }).equals(Buffer.from(base))).toBe(false);
    expect(flip({ treasuryId: '0x' + 'cd'.repeat(32) }).equals(Buffer.from(base))).toBe(false);
    expect(flip({ vaultId: '0x' + 'cd'.repeat(32) }).equals(Buffer.from(base))).toBe(false);
    expect(flip({ maxEpochOutflow: 1n }).equals(Buffer.from(base))).toBe(false);
    expect(flip({ maxAgentBudget: 1n }).equals(Buffer.from(base))).toBe(false);
    expect(flip({ keyGeneration: 5n }).equals(Buffer.from(base))).toBe(false);
  });
});

describe('domain separation', () => {
  it('carries the DOMAINS registry byte-for-byte', () => {
    expect(DOMAINS.TREASURY_AGENT).toBe('SUI_ORG_TREASURY_AGENT_V1:');
    expect(DOMAINS.TREASURY_OUTFLOW).toBe('SUI_ORG_TREASURY_OUTFLOW_V1:');
  });
  it('separates the two action domains and the transfer domain', () => {
    const agent = Buffer.from(computeTreasuryAgentDelegationDigest(agentInput));
    // Same binding fields minus the domain prefix and the operator slot: the
    // outflow digest must still differ (domain prefix + absent operator).
    const outflow = Buffer.from(computeTreasuryOutflowPolicyDigest({
      ...outflowInput, nonce: 31n, maxEpochOutflow: 700n, maxAgentBudget: 80n,
    }));
    const transfer = Buffer.from(computeTreasuryTransferDigest({
      chainId: CHAIN, orgId: ORGID, epochVersion: 2n, nonce: 31n,
      proposalId: '0x' + 'ee'.repeat(32), recipient: '0x' + '99'.repeat(32),
      amount: 700n, keyGeneration: 4n, vaultId: '0x' + 'ff'.repeat(32),
    }));
    expect(agent.equals(outflow)).toBe(false);
    expect(agent.equals(transfer)).toBe(false);
    expect(outflow.equals(transfer)).toBe(false);
  });
});

function firstMoveCall(tx: Transaction) {
  const data = tx.getData();
  const calls = data.commands
    .map((c) => (c as { MoveCall?: { module: string; function: string; arguments: unknown[]; typeArguments?: string[] } }).MoveCall)
    .filter(Boolean) as Array<{ module: string; function: string; arguments: unknown[]; typeArguments?: string[] }>;
  if (!calls.length) throw new Error('PTB 中没有 MoveCall');
  return calls[0];
}

describe('treasury delegation builders', () => {
  const pkg = '0x' + '77'.repeat(32);
  const sig = new Uint8Array(64).fill(0x5a);

  it('buildDelegateAgentAuthorityPTB targets delegate_agent_authority with 8 args and no type args', () => {
    const call = firstMoveCall(buildDelegateAgentAuthorityPTB({
      packageId: pkg, treasuryId: '0x' + 'ee'.repeat(32), orgId: ORGID, vaultId: '0x' + 'ff'.repeat(32),
      operator: '0x' + '99'.repeat(32), maxEpochOutflow: 700n, maxAgentBudget: 80n, nonce: 31n, frostSignature: sig,
    }));
    expect(call.module).toBe('organization_treasury');
    expect(call.function).toBe('delegate_agent_authority');
    expect(call.arguments.length).toBe(8);
    expect((call as { typeArguments?: string[] }).typeArguments?.length ?? 0).toBe(0);
  });
  it('mirrors the on-chain guards: 63-byte sig / non-signer operator / zero caps rejected', () => {
    const base = {
      packageId: pkg, treasuryId: '0x' + 'ee'.repeat(32), orgId: ORGID, vaultId: '0x' + 'ff'.repeat(32),
      operator: '0x' + '99'.repeat(32), maxEpochOutflow: 700n, maxAgentBudget: 80n, nonce: 31n,
    };
    expect(() => buildDelegateAgentAuthorityPTB({ ...base, frostSignature: new Uint8Array(63) })).toThrow(/64/);
    expect(() => buildDelegateAgentAuthorityPTB({ ...base, operator: '0x0', frostSignature: sig })).toThrow(/E10|零地址/);
    expect(() => buildDelegateAgentAuthorityPTB({ ...base, operator: '0x' + '00'.repeat(32), frostSignature: sig })).toThrow(/E10|零地址/);
    // The organization, treasury, and vault are objects: no key signs for them.
    expect(() => buildDelegateAgentAuthorityPTB({ ...base, operator: base.treasuryId, frostSignature: sig })).toThrow(/E10/);
    expect(() => buildDelegateAgentAuthorityPTB({ ...base, operator: base.orgId, frostSignature: sig })).toThrow(/E10/);
    expect(() => buildDelegateAgentAuthorityPTB({ ...base, operator: '0X' + 'FF'.repeat(32), frostSignature: sig })).toThrow(/E10/);
    // Upper-case hex and an upper-case X are the same address.
    expect(firstMoveCall(buildDelegateAgentAuthorityPTB({ ...base, operator: '0X' + '99'.repeat(32), frostSignature: sig })).function)
      .toBe('delegate_agent_authority');
    expect(() => buildDelegateAgentAuthorityPTB({ ...base, maxEpochOutflow: 0n, frostSignature: sig })).toThrow(/E11/);
    expect(() => buildDelegateAgentAuthorityPTB({ ...base, maxAgentBudget: 0n, frostSignature: sig })).toThrow(/E12/);
  });
  it('buildSetTreasuryOutflowPolicyPTB targets set_agent_outflow_policy with 7 args and allows the stop switch', () => {
    const call = firstMoveCall(buildSetTreasuryOutflowPolicyPTB({
      packageId: pkg, treasuryId: '0x' + 'ee'.repeat(32), orgId: ORGID, vaultId: '0x' + 'ff'.repeat(32),
      maxEpochOutflow: 0n, maxAgentBudget: 0n, nonce: 32n, frostSignature: sig,
    }));
    expect(call.module).toBe('organization_treasury');
    expect(call.function).toBe('set_agent_outflow_policy');
    expect(call.arguments.length).toBe(7);
    expect(() => buildSetTreasuryOutflowPolicyPTB({
      packageId: pkg, treasuryId: '0x' + 'ee'.repeat(32), orgId: ORGID, vaultId: '0x' + 'ff'.repeat(32),
      maxEpochOutflow: 1n, maxAgentBudget: 1n, nonce: 1n, frostSignature: new Uint8Array(63),
    })).toThrow(/64/);
  });
});

describe('error registry', () => {
  it('registers treasury 10-14 with the contract names', () => {
    expect(TREASURY_ERRORS[10]).toEqual({ name: 'EInvalidOperator', message: 'Delegated operator must be a signer address: not zero, and not the address of the organization, the treasury, or the vault.' });
    expect(TREASURY_ERRORS[11]).toEqual({ name: 'EZeroOutflowCap', message: 'Delegation requires a positive per-epoch outflow cap.' });
    expect(TREASURY_ERRORS[12]).toEqual({ name: 'EZeroAgentBudget', message: 'Delegation requires a positive per-agent budget cap.' });
    expect(TREASURY_ERRORS[13]).toEqual({ name: 'EInvalidNonce', message: "Authorization nonce must strictly exceed the organization's last nonce." });
    expect(TREASURY_ERRORS[14]).toEqual({ name: 'EInvalidSignature', message: 'Threshold signature must verify against the organization group key over the authorization digest.' });
  });
  it('explainAbort translates treasury aborts readably', () => {
    expect(explainAbort('MoveAbort(UserSubstatus(ModuleAddress(0x75ae), organization_treasury, 14))'))
      .toBe('organization_treasury EInvalidSignature (14): Threshold signature must verify against the organization group key over the authorization digest.');
    expect(explainAbort('MoveAbort(UserSubstatus(ModuleAddress(0x75ae), organization_treasury, 13))'))
      .toBe('organization_treasury EInvalidNonce (13): Authorization nonce must strictly exceed the organization\'s last nonce.');
    expect(explainAbort('MoveAbort(UserSubstatus(ModuleAddress(0x75ae), organization_treasury, 10))'))
      .toBe('organization_treasury EInvalidOperator (10): Delegated operator must be a signer address: not zero, and not the address of the organization, the treasury, or the vault.');
  });
});

// --- PTB parity: what the PTB submits is what the digest signed ---
//
// The builders and the session each copy the signed fields into a MoveCall.
// Nothing above checked that the MoveCall carries the same values, so a
// builder that swapped the two caps, passed the treasury where the vault
// belongs, or submitted a different operator passed every test. These read
// the serialized PTB back out and rebuild the digest from its bytes alone.

type PtArg = { kind: 'object'; objectId: string } | { kind: 'pure'; bytes: Buffer };

function onlyMoveCall(tx: Transaction) {
  const data = tx.getData();
  const calls = data.commands.filter((c) => c.$kind === 'MoveCall');
  if (calls.length !== 1) throw new Error(`PTB 应恰好一个 MoveCall，实际 ${calls.length}`);
  const call = (calls[0] as Extract<(typeof calls)[number], { $kind: 'MoveCall' }>).MoveCall;
  const args: PtArg[] = call.arguments.map((a) => {
    if (a.$kind !== 'Input') throw new Error('unexpected nested argument');
    const input = data.inputs[a.Input];
    if (input.$kind === 'Pure') return { kind: 'pure', bytes: Buffer.from(input.Pure.bytes, 'base64') };
    if (input.$kind === 'UnresolvedObject') return { kind: 'object', objectId: input.UnresolvedObject.objectId };
    throw new Error(`unexpected input kind ${String(input.$kind)}`);
  });
  return { package: call.package, module: call.module, function: call.function, typeArguments: call.typeArguments, args };
}

const asObject = (a: PtArg): string => {
  if (a.kind !== 'object') throw new Error('expected an object argument');
  return a.objectId;
};
const asU64 = (a: PtArg): bigint => {
  if (a.kind !== 'pure' || a.bytes.length !== 8) throw new Error('expected a u64 argument');
  return a.bytes.readBigUInt64LE(0);
};
const asAddress = (a: PtArg): string => {
  if (a.kind !== 'pure' || a.bytes.length !== 32) throw new Error('expected an address argument');
  return '0x' + a.bytes.toString('hex');
};
/** bcs vector<u8> = uleb128(len) || bytes; the signatures here are 63 or 64 bytes, a one-byte uleb. */
const asSignature = (a: PtArg): Buffer => {
  if (a.kind !== 'pure' || a.bytes.length < 2 || a.bytes[0] >= 0x80) throw new Error('expected a vector<u8> argument');
  if (a.bytes.length !== 1 + a.bytes[0]) throw new Error('vector<u8> length prefix does not match its bytes');
  return a.bytes.subarray(1);
};

const agentDigestOf = (f: {
  chainId: string; orgId: string; epochVersion: bigint; nonce: bigint; treasuryId: string; vaultId: string;
  operator: string; maxEpochOutflow: bigint; maxAgentBudget: bigint; keyGeneration: bigint;
}) => sha256(
  txt('SUI_ORG_TREASURY_AGENT_V1:'), txt(f.chainId), A(f.orgId), u64(f.epochVersion), u64(f.nonce),
  A(f.treasuryId), A(f.vaultId), A(f.operator), u64(f.maxEpochOutflow), u64(f.maxAgentBudget), u64(f.keyGeneration),
);
const outflowDigestOf = (f: {
  chainId: string; orgId: string; epochVersion: bigint; nonce: bigint; treasuryId: string; vaultId: string;
  maxEpochOutflow: bigint; maxAgentBudget: bigint; keyGeneration: bigint;
}) => sha256(
  txt('SUI_ORG_TREASURY_OUTFLOW_V1:'), txt(f.chainId), A(f.orgId), u64(f.epochVersion), u64(f.nonce),
  A(f.treasuryId), A(f.vaultId), u64(f.maxEpochOutflow), u64(f.maxAgentBudget), u64(f.keyGeneration),
);

type Bound = { chainId: string; epochVersion: bigint; keyGeneration: bigint };

/** The fields of a delegate_agent_authority call, read from the PTB, plus the digest they produce. */
function readDelegation(args: PtArg[], bound: Bound) {
  if (args.length !== 8) throw new Error(`delegate_agent_authority takes 8 arguments, got ${args.length}`);
  const fields = {
    ...bound,
    treasuryId: asObject(args[0]), orgId: asObject(args[1]), vaultId: asObject(args[2]),
    operator: asAddress(args[3]), maxEpochOutflow: asU64(args[4]), maxAgentBudget: asU64(args[5]), nonce: asU64(args[6]),
  };
  return { fields, signature: asSignature(args[7]), digest: agentDigestOf(fields) };
}

/** The same for set_agent_outflow_policy. */
function readOutflowPolicy(args: PtArg[], bound: Bound) {
  if (args.length !== 7) throw new Error(`set_agent_outflow_policy takes 7 arguments, got ${args.length}`);
  const fields = {
    ...bound,
    treasuryId: asObject(args[0]), orgId: asObject(args[1]), vaultId: asObject(args[2]),
    maxEpochOutflow: asU64(args[3]), maxAgentBudget: asU64(args[4]), nonce: asU64(args[5]),
  };
  return { fields, signature: asSignature(args[6]), digest: outflowDigestOf(fields) };
}

const PTB_IDS = {
  pkg: '0x' + '77'.repeat(32),
  treasuryId: '0x' + 'ee'.repeat(32),
  vaultId: '0x' + 'ff'.repeat(32),
  operator: '0x' + '99'.repeat(32),
};
const BOUND: Bound = { chainId: CHAIN, epochVersion: 2n, keyGeneration: 4n };

describe('treasury PTBs submit exactly what was signed', () => {
  const sig = new Uint8Array(64).fill(0x5a);

  it('buildDelegateAgentAuthorityPTB: one call, objects and pure arguments byte for byte in the signed order', () => {
    const call = onlyMoveCall(buildDelegateAgentAuthorityPTB({
      packageId: PTB_IDS.pkg, treasuryId: PTB_IDS.treasuryId, orgId: ORGID, vaultId: PTB_IDS.vaultId,
      operator: PTB_IDS.operator, maxEpochOutflow: 700n, maxAgentBudget: 80n, nonce: 31n, frostSignature: sig,
    }));
    expect(call.package).toBe(PTB_IDS.pkg);
    expect(call.module).toBe('organization_treasury');
    expect(call.function).toBe('delegate_agent_authority');
    expect(call.typeArguments).toEqual([]);
    expect(call.args).toEqual([
      { kind: 'object', objectId: PTB_IDS.treasuryId },
      { kind: 'object', objectId: ORGID },
      { kind: 'object', objectId: PTB_IDS.vaultId },
      { kind: 'pure', bytes: OPERATOR },
      { kind: 'pure', bytes: u64(700n) },
      { kind: 'pure', bytes: u64(80n) },
      { kind: 'pure', bytes: u64(31n) },
      { kind: 'pure', bytes: Buffer.concat([Buffer.from([64]), Buffer.from(sig)]) },
    ]);
  });

  it('buildSetTreasuryOutflowPolicyPTB: one call, arguments byte for byte, distinct caps', () => {
    const call = onlyMoveCall(buildSetTreasuryOutflowPolicyPTB({
      packageId: PTB_IDS.pkg, treasuryId: PTB_IDS.treasuryId, orgId: ORGID, vaultId: PTB_IDS.vaultId,
      maxEpochOutflow: 700n, maxAgentBudget: 80n, nonce: 32n, frostSignature: sig,
    }));
    expect(call.package).toBe(PTB_IDS.pkg);
    expect(call.module).toBe('organization_treasury');
    expect(call.function).toBe('set_agent_outflow_policy');
    expect(call.typeArguments).toEqual([]);
    expect(call.args).toEqual([
      { kind: 'object', objectId: PTB_IDS.treasuryId },
      { kind: 'object', objectId: ORGID },
      { kind: 'object', objectId: PTB_IDS.vaultId },
      { kind: 'pure', bytes: u64(700n) },
      { kind: 'pure', bytes: u64(80n) },
      { kind: 'pure', bytes: u64(32n) },
      { kind: 'pure', bytes: Buffer.concat([Buffer.from([64]), Buffer.from(sig)]) },
    ]);
  });

  it('the delegation digest rebuilt from the PTB bytes equals the digest of its inputs', () => {
    const input = {
      packageId: PTB_IDS.pkg, treasuryId: PTB_IDS.treasuryId, orgId: ORGID, vaultId: PTB_IDS.vaultId,
      operator: PTB_IDS.operator, maxEpochOutflow: 700n, maxAgentBudget: 80n, nonce: 31n, frostSignature: sig,
    };
    const read = readDelegation(onlyMoveCall(buildDelegateAgentAuthorityPTB(input)).args, BOUND);
    expect(read.digest).toEqual(agentDigestOf({
      ...BOUND, treasuryId: input.treasuryId, orgId: input.orgId, vaultId: input.vaultId,
      operator: input.operator, maxEpochOutflow: input.maxEpochOutflow, maxAgentBudget: input.maxAgentBudget, nonce: input.nonce,
    }));
    expect(read.signature).toEqual(Buffer.from(sig));
  });

  it('the outflow digest rebuilt from the PTB bytes equals the digest of its inputs, for a policy change and for the stop switch', () => {
    for (const [maxEpochOutflow, maxAgentBudget] of [[700n, 80n], [0n, 0n]] as const) {
      const read = readOutflowPolicy(onlyMoveCall(buildSetTreasuryOutflowPolicyPTB({
        packageId: PTB_IDS.pkg, treasuryId: PTB_IDS.treasuryId, orgId: ORGID, vaultId: PTB_IDS.vaultId,
        maxEpochOutflow, maxAgentBudget, nonce: 32n, frostSignature: sig,
      })).args, BOUND);
      expect(read.digest).toEqual(outflowDigestOf({
        ...BOUND, treasuryId: PTB_IDS.treasuryId, orgId: ORGID, vaultId: PTB_IDS.vaultId, maxEpochOutflow, maxAgentBudget, nonce: 32n,
      }));
      expect(read.signature).toEqual(Buffer.from(sig));
    }
  });

  it('the operator goes in as the same 32 bytes whatever the hex case; a short form is refused, not padded', () => {
    const build = (operator: string) =>
      readDelegation(onlyMoveCall(buildDelegateAgentAuthorityPTB({
        packageId: PTB_IDS.pkg, treasuryId: PTB_IDS.treasuryId, orgId: ORGID, vaultId: PTB_IDS.vaultId,
        operator, maxEpochOutflow: 700n, maxAgentBudget: 80n, nonce: 31n, frostSignature: sig,
      })).args, BOUND);
    const lower = build(PTB_IDS.operator);
    const upper = build('0X' + '99'.repeat(32));
    expect(lower.fields.operator).toBe(PTB_IDS.operator);
    expect(upper.digest).toEqual(lower.digest);
    // '0x99' is 0x00…99, a different address from 0x9999…99. The digest
    // functions refuse it, and so does the builder rather than guess.
    expect(() => build('0x99')).toThrow(/64 位/);
    expect(() => build('0x' + '99'.repeat(31))).toThrow(/64 位/);
    expect(() => build('0x' + '99'.repeat(33))).toThrow();
    expect(() => build('0xzz')).toThrow();
  });
});

// --- session integration (FROST t-of-n, mirrors threshold_signer.frost1 fixtures) ---

function buildCommittee(): { groupPublicKey: Uint8Array; material: SessionShareMaterial[] } {
  const t = 2, n = 3;
  const poly = generatePolynomial(t - 1);
  const groupPublicKey = ed25519.Point.BASE.multiply(poly[0]).toBytes();
  const material: SessionShareMaterial[] = [];
  for (let i = 1; i <= n; i++) {
    material.push({ id: `node-${i}`, participantIndex: BigInt(i), privateShare: evaluatePolynomial(poly, BigInt(i)) });
  }
  return { groupPublicKey, material };
}

function makeSnapshot(groupPublicKey: Uint8Array): OrganizationSnapshot {
  return {
    id: ORGID,
    groupPk: groupPublicKey,
    groupPkHex: Buffer.from(groupPublicKey).toString('hex'),
    thresholdWeight: 3n,
    epochVersion: 2n,
    lastNonce: 30n,
    chainId: CHAIN,
    memberCount: 3n,
    replayTableSize: 0n,
    keySigners: [],
    keyThreshold: 2n,
    nextNonce: 31n,
    genesisStake: 0n,
    genesisBondedTotal: 0n,
    genesisWithdrawn: 0n,
    genesisUnlockAtMs: 0n,
    keyGeneration: 4n,
  };
}

describe('ThresholdProposalSession treasury actions', () => {
  const { groupPublicKey, material } = buildCommittee();

  it('derives the delegateAgent digest from the snapshot (nonce = lastNonce+1, kg-bound)', () => {
    const session = ThresholdProposalSession.fromSnapshot({
      snapshot: makeSnapshot(groupPublicKey),
      action: {
        kind: 'delegateAgent',
        treasuryId: '0x' + 'ee'.repeat(32), vaultId: '0x' + 'ff'.repeat(32),
        operator: '0x' + '99'.repeat(32), maxEpochOutflow: 700n, maxAgentBudget: 80n,
      },
    });
    expect(session.nonce).toBe(31n);
    expect(Buffer.from(session.proposalDigest)).toEqual(Buffer.from(computeTreasuryAgentDelegationDigest({
      ...agentInput, nonce: 31n,
    })));
  });

  it('derives the setOutflowPolicy digest from the snapshot', () => {
    const session = ThresholdProposalSession.fromSnapshot({
      snapshot: makeSnapshot(groupPublicKey),
      action: {
        kind: 'setOutflowPolicy',
        treasuryId: '0x' + 'ee'.repeat(32), vaultId: '0x' + 'ff'.repeat(32),
        maxEpochOutflow: 0n, maxAgentBudget: 0n,
      },
    });
    expect(Buffer.from(session.proposalDigest)).toEqual(Buffer.from(computeTreasuryOutflowPolicyDigest({
      ...outflowInput, nonce: 31n,
    })));
  });

  it('signs via FROST t-of-n and builds the delegate_agent_authority PTB', async () => {
    const session = ThresholdProposalSession.fromSnapshot({
      snapshot: makeSnapshot(groupPublicKey),
      action: {
        kind: 'delegateAgent',
        treasuryId: '0x' + 'ee'.repeat(32), vaultId: '0x' + 'ff'.repeat(32),
        operator: '0x' + '99'.repeat(32), maxEpochOutflow: 700n, maxAgentBudget: 80n,
      },
    });
    expect(() => session.buildPTB()).toThrow();
    const provider = new LocalMemoryShareProvider(material.slice(0, 2));
    const signature = await session.sign(provider);
    expect(signature.length).toBe(64);
    const call = firstMoveCall(session.buildPTB());
    expect(call.module).toBe('organization_treasury');
    expect(call.function).toBe('delegate_agent_authority');
    expect(call.arguments.length).toBe(8);
  });

  it('verifyExecution decodes AgentAuthorityDelegated field by field', async () => {
    const txDigest = '0x' + 'ab'.repeat(32);
    const fakeClient = (eventBcs: Buffer) => ({
      getTransaction: async () => ({
        $kind: 'Transaction',
        Transaction: {
          digest: txDigest,
          status: { success: true },
          effects: { status: { success: true }, transactionDigest: txDigest },
          events: [
            {
              eventType: `${AGENT_VAULT_PACKAGE_ID}::organization_treasury::AgentAuthorityDelegated`,
              bcs: new Uint8Array(eventBcs),
            },
          ],
        },
      }),
    }) as unknown as SuiGrpcClient;
    const session = ThresholdProposalSession.fromSnapshot({
      snapshot: makeSnapshot(groupPublicKey),
      client: fakeClient(Buffer.concat([TREASURY, VAULT, OPERATOR, u64(700n), u64(80n), u64(31n)])),
      action: {
        kind: 'delegateAgent',
        treasuryId: '0x' + 'ee'.repeat(32), vaultId: '0x' + 'ff'.repeat(32),
        operator: '0x' + '99'.repeat(32), maxEpochOutflow: 700n, maxAgentBudget: 80n,
      },
    });
    const provider = new LocalMemoryShareProvider(material.slice(0, 2));
    await session.sign(provider);

    const verification = await session.verifyExecution(txDigest);
    expect(verification.success).toBe(true);
    expect(verification.matchedEvents).toEqual([TREASURY_EVENTS.agentAuthorityDelegated]);
    expect(verification.failures).toEqual([]);
  });

  it('verifyExecution rejects a tampered operator in the event payload', async () => {
    const txDigest = '0x' + 'ab'.repeat(32);
    const fakeClient = (eventBcs: Buffer) => ({
      getTransaction: async () => ({
        $kind: 'Transaction',
        Transaction: {
          digest: txDigest,
          status: { success: true },
          effects: { status: { success: true }, transactionDigest: txDigest },
          events: [
            {
              eventType: `${AGENT_VAULT_PACKAGE_ID}::organization_treasury::AgentAuthorityDelegated`,
              bcs: new Uint8Array(eventBcs),
            },
          ],
        },
      }),
    }) as unknown as SuiGrpcClient;
    const session = ThresholdProposalSession.fromSnapshot({
      snapshot: makeSnapshot(groupPublicKey),
      client: fakeClient(Buffer.concat([TREASURY, VAULT, A('0x' + '88'.repeat(32)), u64(700n), u64(80n), u64(31n)])),
      action: {
        kind: 'delegateAgent',
        treasuryId: '0x' + 'ee'.repeat(32), vaultId: '0x' + 'ff'.repeat(32),
        operator: '0x' + '99'.repeat(32), maxEpochOutflow: 700n, maxAgentBudget: 80n,
      },
    });
    const provider = new LocalMemoryShareProvider(material.slice(0, 2));
    await session.sign(provider);
    const verification = await session.verifyExecution(txDigest);
    expect(verification.success).toBe(false);
    expect(verification.failures.length).toBe(1);
  });

  // The session derives the digest and the PTB in two separate places. These
  // pin them together: every signed field is read back from the PTB, rehashed
  // with the snapshot's chain / epoch / key generation, and must reproduce the
  // signed digest; the signature in the PTB must verify over it.

  it('delegateAgent: the PTB rehashes to the signed digest and carries the aggregated signature', async () => {
    const snapshot = makeSnapshot(groupPublicKey);
    const action = {
      kind: 'delegateAgent' as const,
      treasuryId: PTB_IDS.treasuryId, vaultId: PTB_IDS.vaultId, operator: PTB_IDS.operator,
      maxEpochOutflow: 700n, maxAgentBudget: 80n,
    };
    const session = ThresholdProposalSession.fromSnapshot({ snapshot, action });
    const signature = await session.sign(new LocalMemoryShareProvider(material.slice(0, 2)));

    const call = onlyMoveCall(session.buildPTB());
    expect(call.module).toBe('organization_treasury');
    expect(call.function).toBe('delegate_agent_authority');
    expect(call.args.slice(0, 3).map(asObject)).toEqual([action.treasuryId, snapshot.id, action.vaultId]);

    const read = readDelegation(call.args, { chainId: snapshot.chainId, epochVersion: snapshot.epochVersion, keyGeneration: snapshot.keyGeneration });
    expect(read.fields).toEqual({
      chainId: CHAIN, orgId: snapshot.id, epochVersion: 2n, nonce: 31n, keyGeneration: 4n,
      treasuryId: action.treasuryId, vaultId: action.vaultId, operator: action.operator,
      maxEpochOutflow: 700n, maxAgentBudget: 80n,
    });
    expect(read.digest).toEqual(Buffer.from(session.proposalDigest));
    expect(read.signature).toEqual(Buffer.from(signature));
    expect(verifyFrostSignature(read.digest, read.signature, groupPublicKey)).toBe(true);
  });

  it('setOutflowPolicy: the PTB rehashes to the signed digest and carries the aggregated signature', async () => {
    const snapshot = makeSnapshot(groupPublicKey);
    const action = {
      kind: 'setOutflowPolicy' as const,
      treasuryId: PTB_IDS.treasuryId, vaultId: PTB_IDS.vaultId, maxEpochOutflow: 700n, maxAgentBudget: 80n,
    };
    const session = ThresholdProposalSession.fromSnapshot({ snapshot, action });
    const signature = await session.sign(new LocalMemoryShareProvider(material.slice(0, 2)));

    const call = onlyMoveCall(session.buildPTB());
    expect(call.module).toBe('organization_treasury');
    expect(call.function).toBe('set_agent_outflow_policy');
    expect(call.args.slice(0, 3).map(asObject)).toEqual([action.treasuryId, snapshot.id, action.vaultId]);

    const read = readOutflowPolicy(call.args, { chainId: snapshot.chainId, epochVersion: snapshot.epochVersion, keyGeneration: snapshot.keyGeneration });
    expect(read.fields).toEqual({
      chainId: CHAIN, orgId: snapshot.id, epochVersion: 2n, nonce: 31n, keyGeneration: 4n,
      treasuryId: action.treasuryId, vaultId: action.vaultId, maxEpochOutflow: 700n, maxAgentBudget: 80n,
    });
    expect(read.digest).toEqual(Buffer.from(session.proposalDigest));
    expect(read.signature).toEqual(Buffer.from(signature));
    expect(verifyFrostSignature(read.digest, read.signature, groupPublicKey)).toBe(true);
  });

  it('sign() hands the provider the action and the state it is bound to', async () => {
    const seen: SigningIntent[] = [];
    const handed: Uint8Array[] = [];
    const provider: SessionShareProvider = {
      collect: async ({ digest, groupPublicKey: pk, intent }) => {
        // Two digests arrive: the one to sign, and the one inside the intent a
        // signer would be shown. Both are copied, so neither can alias the session.
        handed.push(Uint8Array.from(digest));
        seen.push({ ...intent, digest: Uint8Array.from(intent.digest) });
        return new LocalMemoryShareProvider(material.slice(0, 2)).collect({ digest, groupPublicKey: pk, intent });
      },
    };
    const snapshot = makeSnapshot(groupPublicKey);
    const action = {
      kind: 'delegateAgent' as const,
      treasuryId: PTB_IDS.treasuryId, vaultId: PTB_IDS.vaultId, operator: PTB_IDS.operator,
      maxEpochOutflow: 700n, maxAgentBudget: 80n,
    };
    const session = ThresholdProposalSession.fromSnapshot({ snapshot, action });
    await session.sign(provider);

    expect(seen.length).toBe(1);
    expect(handed.length).toBe(1);
    expect(Buffer.from(handed[0])).toEqual(Buffer.from(session.proposalDigest));
    // The digest shown to a signer is the digest being signed.
    expect(Buffer.from(seen[0].digest)).toEqual(Buffer.from(handed[0]));
    expect(seen[0].action).toEqual(action);
    expect(seen[0].chainId).toBe(snapshot.chainId);
    expect(seen[0].orgId).toBe(snapshot.id);
    expect(seen[0].epochVersion).toBe(2n);
    expect(seen[0].nonce).toBe(31n);
    expect(seen[0].keyGeneration).toBe(4n);
    expect(Buffer.from(seen[0].digest)).toEqual(Buffer.from(session.proposalDigest));
    // What the provider saw is enough to recompute the digest it was asked to sign.
    const shown = seen[0].action as Extract<SessionAction, { kind: 'delegateAgent' }>;
    expect(agentDigestOf({
      chainId: seen[0].chainId, orgId: seen[0].orgId, epochVersion: seen[0].epochVersion, nonce: seen[0].nonce,
      keyGeneration: seen[0].keyGeneration,
      treasuryId: shown.treasuryId, vaultId: shown.vaultId, operator: shown.operator,
      maxEpochOutflow: BigInt(shown.maxEpochOutflow), maxAgentBudget: BigInt(shown.maxAgentBudget),
    })).toEqual(Buffer.from(seen[0].digest));
  });

  it('the intent exposes a stop switch as what it is: zero caps', async () => {
    const seen: SigningIntent[] = [];
    const handed: Uint8Array[] = [];
    const provider: SessionShareProvider = {
      collect: async ({ digest, groupPublicKey: pk, intent }) => {
        handed.push(Uint8Array.from(digest));
        seen.push({ ...intent, digest: Uint8Array.from(intent.digest) });
        return new LocalMemoryShareProvider(material.slice(0, 2)).collect({ digest, groupPublicKey: pk, intent });
      },
    };
    const session = ThresholdProposalSession.fromSnapshot({
      snapshot: makeSnapshot(groupPublicKey),
      action: { kind: 'setOutflowPolicy', treasuryId: PTB_IDS.treasuryId, vaultId: PTB_IDS.vaultId, maxEpochOutflow: 0n, maxAgentBudget: 0n },
    });
    await session.sign(provider);
    const shown = seen[0].action as Extract<SessionAction, { kind: 'setOutflowPolicy' }>;
    expect(shown.kind).toBe('setOutflowPolicy');
    expect([shown.maxEpochOutflow, shown.maxAgentBudget]).toEqual([0n, 0n]);
    expect(seen[0].nonce).toBe(31n);
    expect(Buffer.from(seen[0].digest)).toEqual(Buffer.from(handed[0]));
  });
});
