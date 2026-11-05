/**
 * SuiNS 解析层：官方 @mysten/sui gRPC core 之上的正向 / 反向名称解析。
 *
 * gRPC core 的 resolveNameServiceAddress / defaultNameServiceName 在 full node
 * 侧已校验过期与父子名关系；这里补齐 SDK 侧契约——输入校验、超时边界、
 * 以及可选的注册表记录交叉校验（SuinsClient.getNameRecord 的结构化注入，
 * 不引入 @mysten/suins 依赖，保持与官方 client 的版本解耦）。
 *
 * 解析失败与「名称不存在」是两个不同的事实，必须报不同错误；反向解析的
 * 默认名只是展示数据，回解析不一致时返回 null 而不是给出错误标签。
 */
import { isValidSuiAddress, isValidSuiNSName, normalizeSuiAddress, normalizeSuiNSName } from '@mysten/sui/utils';

/** notFound 的 ObjectError 跨 @mysten/sui 版本类身份不同，用结构判定而不是 instanceof。 */
function isRecordNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { reason?: unknown }).reason === 'notFound';
}

/** 正向：名称 → 地址；反向：地址 → 默认名。两个方法都由官方 gRPC client 提供。 */
export interface SuiNameServiceCore {
  resolveNameServiceAddress(input: { name: string; signal?: AbortSignal }): Promise<{ address?: string | null }>;
  defaultNameServiceName(input: { address: string; signal?: AbortSignal }): Promise<{ data: { name?: string | null } }>;
}

/** 有 SuinsClient 的调用方可注入 getNameRecord 做注册表交叉校验（可选增强）。 */
export interface SuinsNameRecordSource {
  getNameRecord(name: string): Promise<{ targetAddress?: string | null } | null>;
}

export const SUI_NS_DEFAULT_TIMEOUT_MS = 15_000;

/** SuinsClient.getNameRecord 不接受 signal；用有界等待把 full node 停滞变成可报告的失败。 */
async function withTimeout<T>(work: Promise<T>, what: string, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what}超时（${timeoutMs / 1000} 秒），请检查网络后重试。`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function normalizeNameInput(input: string): string {
  const value = input.trim();
  if (!isValidSuiNSName(value)) throw new Error('请输入有效的 SuiNS 名称，例如 name.sui 或 @name。');
  return normalizeSuiNSName(value, 'dot');
}

export interface ResolveSuiNsAddressOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  /** 注册表记录源；提供时按「记录目标地址 == 解析地址」交叉校验后再返回。 */
  recordSource?: SuinsNameRecordSource;
}

/** 正向解析 .sui 名称到收款地址；过期名、无目标名、解析不一致都按失败报告。 */
export async function resolveSuiNsAddress(
  client: SuiNameServiceCore,
  input: string,
  options: ResolveSuiNsAddressOptions = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? SUI_NS_DEFAULT_TIMEOUT_MS;
  const name = normalizeNameInput(input);

  if (options.recordSource) {
    // 官方注册表里「无此记录」以 notFound ObjectError 表达；映射为 null 而不是
    // 当作传输失败冒泡——两个事实驱动不同的用户提示。
    const record = await withTimeout(
      options.recordSource.getNameRecord(name).catch((error: unknown) => {
        if (isRecordNotFound(error)) return null;
        throw error;
      }),
      '查询 SuiNS 记录',
      timeoutMs,
    );
    const target = record?.targetAddress;
    if (!target || !isValidSuiAddress(target) || BigInt(target) === 0n) {
      throw new Error('该 SuiNS 名称没有配置收款地址。');
    }
    const { address } = await withTimeout(client.resolveNameServiceAddress({ name, signal: options.signal ?? AbortSignal.timeout(timeoutMs) }), '解析 SuiNS 名称', timeoutMs);
    if (!address || !isValidSuiAddress(address) || normalizeSuiAddress(address) !== normalizeSuiAddress(target)) {
      throw new Error('该 SuiNS 名称已过期、不可解析或解析记录发生变化，请刷新后重试。');
    }
    return normalizeSuiAddress(address);
  }

  const { address } = await withTimeout(client.resolveNameServiceAddress({ name, signal: options.signal ?? AbortSignal.timeout(timeoutMs) }), '解析 SuiNS 名称', timeoutMs);
  if (!address || !isValidSuiAddress(address) || BigInt(address) === 0n) {
    throw new Error('该 SuiNS 名称不可解析或未注册。');
  }
  return normalizeSuiAddress(address);
}

export interface ReverseResolveSuiNsNameOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * 反向解析：钱包自己设置的默认 .sui 名。
 * 默认名是展示数据——只有它仍回解析到同一地址时才返回，否则返回 null，
 * 让调用方渲染「未知」而不是一个指向别人的标签。
 */
export async function reverseResolveSuiNsName(
  client: SuiNameServiceCore,
  address: string,
  options: ReverseResolveSuiNsNameOptions = {},
): Promise<string | null> {
  if (!isValidSuiAddress(address) || BigInt(address) === 0n) throw new Error('请输入有效的 Sui 地址。');
  const timeoutMs = options.timeoutMs ?? SUI_NS_DEFAULT_TIMEOUT_MS;
  const { data } = await withTimeout(client.defaultNameServiceName({ address: normalizeSuiAddress(address), signal: options.signal ?? AbortSignal.timeout(timeoutMs) }), '查询默认 SuiNS 名称', timeoutMs);
  const name = data.name?.trim();
  if (!name) return null;
  const { address: resolved } = await withTimeout(client.resolveNameServiceAddress({ name, signal: options.signal ?? AbortSignal.timeout(timeoutMs) }), '解析 SuiNS 名称', timeoutMs);
  return resolved && normalizeSuiAddress(resolved) === normalizeSuiAddress(address) ? name : null;
}
