/**
 * scallop_yield_adapter 常量：群金库 sSUI 生息适配。
 *
 * SSUI 是本包内的模拟 Witness（对应 Scallop MarketCoin<SUI> 的测试网替身）；
 * 主网真实组合 = 同一 PTB 内调 Scallop 包 deposit/redeem，中间的 Coin 以
 * TransactionArgument 传入本模块入口（见 builders 的组合约定）。
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
