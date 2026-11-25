/**
 * I9 合约边界同步的文件级单测：
 * - 错误码注册表：onchain_chat 单条发信与批量共用 6018（E_MESSAGE_TOO_LONG）、
 *   vault 三条出金路径共用 2014（E_ZERO_RECIPIENT）、cryptographic_org 创世
 *   质押提取新增 1013（E_ZERO_RECIPIENT）——三者都须能被 explainAbort 翻译。
 * - 事件表与 BCS：vault 新增 AgentBudgetUpdatedEvent / VaultUnpausedEvent
 *   （I9 补齐的调额与解暂停审计事件），类型名与字段布局与合约逐一对齐。
 * - 载荷界：CHAT_LIMITS 的 preview/blob 上界即合约单条入口新启用的一组断言。
 */
import { describe, expect, it } from './vitest-shim';
import { CHAT_ERRORS, ORG_ERRORS, SCALLOP_ERRORS, VAULT_ERRORS, VAULT_EVENTS, explainAbort } from './constants';
import { CHAT_LIMITS } from '../chat/constants';
import { AgentBudgetUpdatedBcs, VaultUnpausedBcs } from '../finance/schemas';

const ADDR = '0x' + 'ab'.repeat(32);
const substatus = (module: string, code: number) =>
  `MoveAbort(UserSubstatus(ModuleAddress(0x73afe159f7b017efdfc7a013a6e444d54317b0147ae7fb182a182c3dc5ba57b5), ${module}, ${code})) in 0x…`;

describe('I9 error registry: zero recipients and message bounds', () => {
  it('registers cryptographic_org 1013 as E_ZERO_RECIPIENT (withdraw_genesis_stake)', () => {
    expect(ORG_ERRORS[1013]).toBe('E_ZERO_RECIPIENT');
    expect(explainAbort(substatus('cryptographic_org', 1013))).toBe('cryptographic_org E_ZERO_RECIPIENT (1013)');
  });

  it('pins vault 2014 (E_ZERO_RECIPIENT) shared by withdraw, purge sweep and agent spend', () => {
    expect(VAULT_ERRORS[2014]).toBe('E_ZERO_RECIPIENT');
    expect(explainAbort(substatus('vault', 2014))).toBe('vault E_ZERO_RECIPIENT (2014)');
  });

  it('pins onchain_chat 6018 (E_MESSAGE_TOO_LONG) shared by batch and both single-entry posts', () => {
    expect(CHAT_ERRORS[6018]).toBe('E_MESSAGE_TOO_LONG');
    expect(explainAbort(substatus('onchain_chat', 6018))).toBe('onchain_chat E_MESSAGE_TOO_LONG (6018)');
  });

  it('registers the I9 increment: chat creation bounds 6021/6022 and scallop zero-recipient 7006', () => {
    expect(CHAT_ERRORS[6021]).toBe('E_NAME_TOO_LONG');
    expect(CHAT_ERRORS[6022]).toBe('E_TOO_MANY_INITIAL_MEMBERS');
    expect(explainAbort(substatus('onchain_chat', 6021))).toBe('onchain_chat E_NAME_TOO_LONG (6021)');
    expect(explainAbort(substatus('onchain_chat', 6022))).toBe('onchain_chat E_TOO_MANY_INITIAL_MEMBERS (6022)');
    expect(SCALLOP_ERRORS[7004]).toBe('E_WRONG_CHANNEL');
    expect(SCALLOP_ERRORS[7005]).toBe('E_ZERO_DEPOSIT');
    expect(SCALLOP_ERRORS[7006]).toBe('E_ZERO_RECIPIENT');
    expect(explainAbort(substatus('scallop_yield_adapter', 7006))).toBe('scallop_yield_adapter E_ZERO_RECIPIENT (7006)');
  });

  it('still reports unknown codes as unregistered', () => {
    expect(explainAbort(substatus('vault', 2099))).toBe('vault error 2099 (未注册)');
  });
});

describe('I9 chat payload bounds mirror the contract asserts', () => {
  it('keeps 4096/128 byte caps that the single entries now enforce', () => {
    expect(CHAT_LIMITS.maxPreviewBytes).toBe(4096);
    expect(CHAT_LIMITS.maxBlobIdBytes).toBe(128);
  });

  it('keeps the channel-creation caps on name and initial members', () => {
    expect(CHAT_LIMITS.maxChannelNameBytes).toBe(256);
    expect(CHAT_LIMITS.maxInitialMembers).toBe(256);
  });
});

describe('I9 vault audit events', () => {
  it('registers the two new event type names under the vault module', () => {
    expect(VAULT_EVENTS.agentBudgetUpdated).toBe('vault::AgentBudgetUpdatedEvent');
    expect(VAULT_EVENTS.vaultUnpaused).toBe('vault::VaultUnpausedEvent');
  });

  it('round-trips AgentBudgetUpdatedEvent with old/new budget fields', () => {
    const bytes = AgentBudgetUpdatedBcs.serialize({
      vault_id: ADDR, agent_id: ADDR, old_daily_budget: 30n, new_daily_budget: 80n,
    }).toBytes();
    // 32B vault_id + 32B agent_id + u64 old + u64 new, little-endian.
    expect(bytes.length).toBe(32 + 32 + 8 + 8);
    const parsed = AgentBudgetUpdatedBcs.parse(bytes);
    expect(parsed.vault_id).toBe(ADDR);
    expect(parsed.agent_id).toBe(ADDR);
    // bcs.u64() 解析结果按值大小返回 number 或 string，与 finance reader 一律经 BigInt 归一。
    expect(BigInt(parsed.old_daily_budget)).toBe(30n);
    expect(BigInt(parsed.new_daily_budget)).toBe(80n);
  });

  it('round-trips VaultUnpausedEvent with a single vault_id field', () => {
    const bytes = VaultUnpausedBcs.serialize({ vault_id: ADDR }).toBytes();
    expect(bytes.length).toBe(32);
    const parsed = VaultUnpausedBcs.parse(bytes);
    expect(parsed.vault_id).toBe(ADDR);
  });
});
