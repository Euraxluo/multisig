/**
 * walrus_app_policy 读取层：registry / admin cap / 单应用策略快照。
 *
 * 策略存在 registry.policies Table<String, PaymentPolicy> 动态字段里，
 * 键为 blob ID 字符串；读取走 getDynamicField。remainingEpochBudget 按
 * 「spent_in_epoch 属于 last_payment_epoch，跨纪元懒清零」重算剩余额度。
 */
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import { bcs } from '@mysten/sui/bcs';
import { normalizeStructTag } from '@mysten/sui/utils';
import { canonicalAddress } from '../org/bcs';
import { AdminCapBcs, PaymentPolicyBcs, RegistryBcs } from './schemas';
import { APP_POLICY_MODULE } from './constants';

export type AppPolicyReadClient = Pick<SuiGrpcClient, 'getObject' | 'getDynamicField'>;
export interface AppPolicyReadOptions { signal?: AbortSignal }

export interface PolicyRegistrySnapshot {
  id: string;
  policiesTableId: string;
  totalApps: bigint;
}

export interface AdminCapSnapshot {
  id: string;
  registryId: string;
}

export interface PaymentPolicySnapshot {
  channelId: string;
  minMemberStake: bigint;
  recipient: string;
  maxPayment: bigint;
  epochBudget: bigint;
  spentInEpoch: bigint;
  lastPaymentEpoch: bigint;
  isActive: boolean;
}

function policyType(packageId: string, name: string): string {
  return normalizeStructTag(`${canonicalAddress(packageId)}::${APP_POLICY_MODULE}::${name}`);
}

export async function readPolicyRegistry(client: AppPolicyReadClient, config: { packageId: string; registryId: string }, options: AppPolicyReadOptions = {}): Promise<PolicyRegistrySnapshot> {
  const { object } = await client.getObject({ objectId: config.registryId, include: { content: true }, signal: options.signal });
  if (normalizeStructTag(object.type) !== policyType(config.packageId, 'Registry')) throw new Error('对象不是当前包的 walrus_app_policy::Registry。');
  const fields = RegistryBcs.parse(object.content);
  return { id: fields.id, policiesTableId: fields.policies.id, totalApps: BigInt(fields.total_apps) };
}

export async function readAdminCap(client: AppPolicyReadClient, config: { packageId: string; capId: string }, options: AppPolicyReadOptions = {}): Promise<AdminCapSnapshot> {
  const { object } = await client.getObject({ objectId: config.capId, include: { content: true }, signal: options.signal });
  if (normalizeStructTag(object.type) !== policyType(config.packageId, 'AdminCap')) throw new Error('对象不是当前包的 walrus_app_policy::AdminCap。');
  const fields = AdminCapBcs.parse(object.content);
  return { id: fields.id, registryId: fields.registry_id };
}

/** 读单个应用的策略；无此 blob ID 时返回 null（与「暂停」区分开）。 */
export async function readPaymentPolicy(
  client: AppPolicyReadClient,
  config: { packageId: string; registryId: string },
  blobId: string,
  options: AppPolicyReadOptions = {},
): Promise<PaymentPolicySnapshot | null> {
  const registry = await readPolicyRegistry(client, config, options);
  const value = await tableValue(client, config, registry.policiesTableId, blobId, options);
  if (!value) return null;
  const fields = PaymentPolicyBcs.parse(value);
  return {
    channelId: fields.channel_id,
    minMemberStake: BigInt(fields.min_member_stake),
    recipient: fields.recipient,
    maxPayment: BigInt(fields.max_payment),
    epochBudget: BigInt(fields.epoch_budget),
    spentInEpoch: BigInt(fields.spent_in_epoch),
    lastPaymentEpoch: BigInt(fields.last_payment_epoch),
    isActive: fields.is_active,
  };
}

async function tableValue(
  client: AppPolicyReadClient,
  config: { packageId: string },
  tableId: string,
  blobId: string,
  options: AppPolicyReadOptions,
): Promise<Uint8Array | null> {
  const expected = normalizeStructTag(`0x2::dynamic_field::Field<0x1::string::String,${canonicalAddress(config.packageId)}::${APP_POLICY_MODULE}::PaymentPolicy>`);
  try {
    const { dynamicField } = await client.getDynamicField({
      parentId: tableId,
      name: { type: '0x1::string::String', bcs: bcs.string().serialize(blobId).toBytes() },
      signal: options.signal,
    });
    if (dynamicField.$kind !== 'DynamicField' || normalizeStructTag(dynamicField.type) !== expected) {
      throw new Error('策略表字段类型不匹配。');
    }
    return dynamicField.value.bcs;
  } catch (error) {
    // notFound（跨版本 ObjectError 结构判定）= 无此应用；其余异常原样冒泡。
    if (typeof error === 'object' && error !== null && (error as { reason?: unknown }).reason === 'notFound') return null;
    throw error;
  }
}

/** 剩余纪元额度：跨纪元懒清零 —— last_payment_epoch 之前/之后的纪元额度都是满额。 */
export function remainingEpochBudget(policy: PaymentPolicySnapshot, epoch: bigint): bigint {
  return policy.epochBudget - (epoch === policy.lastPaymentEpoch ? policy.spentInEpoch : 0n);
}
