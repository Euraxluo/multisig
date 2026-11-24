/** scallop_yield_adapter 读取层：适配器快照（记账本金 / sSUI 份额 / 累计注入）。适配器未接入任何借贷协议，以下都是记账数字。 */
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
  /** 记账的 SUI 本金（适配器上的记账数字，不对应任何借贷市场头寸）。 */
  totalStakedSuiPrincipal: bigint;
  /** 持有的 sSUI 份额（占位类型，不升值）。 */
  ssuiBalance: bigint;
  /** 累计经适配器注入群聊的 SUI 总量（MIST）。字段名带 yield，但钱只是有人主动存入的，不是利息。 */
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
