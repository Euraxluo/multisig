/**
 * scallop_yield_adapter 常量：群金库 sSUI 适配器的记账入口。
 *
 * 适配器没有接入任何借贷协议：`Move.toml` 没有 Scallop 依赖，SSUI 只是本包内的
 * 占位 Witness，没有铸造入口，链上不存在有值的 `Coin<SSUI>`。项目决定不接入真实
 * Scallop，所以存入本金与赎回两条路径目前都没有可用的调用方式，sSUI 份额不升值。
 */
import { AGENT_VAULT_PACKAGE_ID, MODULES } from '../org/constants';
import { normalizeSuiAddress } from '@mysten/sui/utils';

export const SCALLOP_MODULE = MODULES.scallop;

/** Coin<SSUI> 的类型参数（以配置包为类型源）。 */
export function ssuiCoinType(packageId: string = AGENT_VAULT_PACKAGE_ID): string {
  return `${normalizeSuiAddress(packageId)}::${SCALLOP_MODULE}::SSUI`;
}

// SCALLOP_ERRORS 注册表住在 org/constants（全模块错误码同一事实源），此处 re-export。
export { SCALLOP_ERRORS } from '../org/constants';

export const SCALLOP_EVENTS = {
  adapterCreated: 'scallop_yield_adapter::ScallopAdapterCreatedEvent',
  stakedIntoScallop: 'scallop_yield_adapter::StakedIntoScallopEvent',
  yieldHarvestedAndDistributed: 'scallop_yield_adapter::YieldHarvestedAndDistributedEvent',
  principalRedeemed: 'scallop_yield_adapter::PrincipalRedeemedEvent',
} as const;
