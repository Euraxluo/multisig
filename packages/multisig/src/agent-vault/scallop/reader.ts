/** scallop_yield_adapter 读取层：适配器快照（本金 / sSUI 份额 / 已收利息）。 */
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import { normalizeStructTag } from '@mysten/sui/utils';
import { canonicalAddress } from '../org/bcs';
import { SCALLOP_MODULE } from './constants';
import { ScallopVaultAdapterBcs } from './schemas';

export type ScallopReadClient = Pick<SuiGrpcClient, 'getObject'>;
export interface ScallopReadOptions { signal?: AbortSignal }

export interface ScallopAdapterSnapshot {
  id: string;
  channelId: string;
  admin: string;
  /** 存入的 SUI 原始本金（保本基准线）。 */
  totalStakedSuiPrincipal: bigint;
  /** 持有的 sSUI 份额（按出块秒级连续升值）。 */
  ssuiBalance: bigint;
  /** 累计已提取并注入群聊的利息总量（MIST）。 */
  totalHarvestedYieldSui: bigint;
}

export function scallopAdapterType(packageId: string): string {
  return normalizeStructTag(`${canonicalAddress(packageId)}::${SCALLOP_MODULE}::ScallopVaultAdapter`);
}

export async function readScallopAdapter(client: ScallopReadClient, config: { packageId: string; adapterId: string }, options: ScallopReadOptions = {}): Promise<ScallopAdapterSnapshot> {
  const { object } = await client.getObject({ objectId: config.adapterId, include: { content: true }, signal: options.signal });
  if (normalizeStructTag(object.type) !== scallopAdapterType(config.packageId)) throw new Error('对象不是当前包的 scallop_yield_adapter::ScallopVaultAdapter。');
  const fields = ScallopVaultAdapterBcs.parse(object.content);
  return {
    id: fields.id,
    channelId: fields.channel_id,
    admin: fields.admin,
    totalStakedSuiPrincipal: BigInt(fields.total_staked_sui_principal),
    ssuiBalance: BigInt(fields.ssui_balance.value),
    totalHarvestedYieldSui: BigInt(fields.total_harvested_yield_sui),
  };
}
