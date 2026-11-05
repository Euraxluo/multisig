/**
 * 账号基础状态层：官方 @mysten/sui gRPC client 之上的余额读取。
 *
 * listBalances 本身由官方 client 提供，这里只补齐 SDK 侧的契约——地址与
 * coinType 校验、传输数字无损转 bigint、确定序。账号状态是其它子包的
 * 依赖底座，本模块不反向依赖 agent-vault / dkg。
 */
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { SUI_TYPE_ARG, isValidSuiAddress, normalizeSuiAddress, normalizeStructTag, parseStructTag } from '@mysten/sui/utils';

export type MultisigNetwork = 'devnet' | 'testnet' | 'mainnet' | 'localnet';

export const MULTISIG_NETWORK_URLS: Readonly<Record<MultisigNetwork, string>> = {
  devnet: 'https://fullnode.devnet.sui.io:443',
  testnet: 'https://fullnode.testnet.sui.io:443',
  mainnet: 'https://fullnode.mainnet.sui.io:443',
  localnet: 'http://127.0.0.1:9000',
};

/** 显式选择网络；未知网络必须报错，绝不静默回落 testnet。 */
export function createMultisigClient(network: MultisigNetwork = 'testnet', baseUrl?: string): SuiGrpcClient {
  if (!Object.prototype.hasOwnProperty.call(MULTISIG_NETWORK_URLS, network)) {
    throw new Error(`未知网络 ${String(network)}；请使用 MULTISIG_NETWORK_URLS 中的网络或显式传 baseUrl。`);
  }
  return new SuiGrpcClient({ network, baseUrl: baseUrl ?? MULTISIG_NETWORK_URLS[network] });
}

export interface AccountBalance { coinType: string; totalBalance: bigint }

/** Move 整数在传输层可能是 string / number / bigint / {value}；统一无损转 bigint。 */
export function accountAmount(value: unknown): bigint {
  if (value === null || value === undefined) return 0n;
  if (typeof value === 'object') return accountAmount((value as { value?: unknown }).value);
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('余额数值超出安全整数范围，请检查传输层数字格式。');
    return BigInt(value);
  }
  const text = typeof value === 'string' ? value.trim() : '';
  if (!/^\d+$/.test(text)) throw new Error(`无法解析余额数值：${String(value).slice(0, 32)}`);
  return BigInt(text);
}

function accountAddress(value: string): string {
  if (typeof value !== 'string') throw new Error('需要有效的非零 Sui 地址。');
  const normalized = normalizeSuiAddress(value);
  if (!isValidSuiAddress(normalized) || BigInt(normalized) === 0n) {
    throw new Error('需要有效的非零 Sui 地址。');
  }
  return normalized;
}

function coinTag(value: unknown): string {
  let tag: ReturnType<typeof parseStructTag>;
  try {
    tag = parseStructTag(String(value));
  } catch {
    throw new Error(`余额条目的 coinType 无效：${String(value)}`);
  }
  const normAddress = normalizeSuiAddress(tag.address);
  if (!isValidSuiAddress(normAddress) || BigInt(normAddress) === 0n) {
    throw new Error(`余额条目的 coinType 无效：${String(value)}`);
  }
  return normalizeStructTag(tag);
}

export type AccountBalancesClient = Pick<SuiGrpcClient, 'listBalances'>;

/** 读取地址持有的全部 coin 类型余额，按 coinType 字典序稳定返回。 */
export async function fetchAccountBalances(
  client: AccountBalancesClient,
  owner: string,
  options: { signal?: AbortSignal } = {},
): Promise<AccountBalance[]> {
  const address = accountAddress(owner);
  const response = await client.listBalances({ owner: address, signal: options.signal });
  if (response == null) throw new Error('listBalances 无响应；gRPC 通道可能未建立。');
  const raw = (response as { balances?: unknown }).balances;
  if (raw !== undefined && !Array.isArray(raw)) throw new Error('listBalances 响应格式异常。');
  const balances = ((raw ?? []) as Array<{ coinType?: unknown; balance?: unknown }>).map((entry) => ({
    coinType: coinTag(entry.coinType),
    totalBalance: accountAmount(entry.balance),
  }));
  balances.sort((a, b) => (a.coinType < b.coinType ? -1 : a.coinType > b.coinType ? 1 : 0));
  return balances;
}

export const MULTISIG_SUI_COIN_TYPE = SUI_TYPE_ARG;

/** 未持有 SUI 时返回 0n，而不是把「无条目」和「读取失败」混为一谈。 */
export function findSuiBalance(balances: AccountBalance[]): bigint {
  return balances.find((entry) => entry.coinType === MULTISIG_SUI_COIN_TYPE)?.totalBalance ?? 0n;
}

export async function fetchSuiBalance(client: AccountBalancesClient, owner: string, options: { signal?: AbortSignal } = {}): Promise<bigint> {
  return findSuiBalance(await fetchAccountBalances(client, owner, options));
}
