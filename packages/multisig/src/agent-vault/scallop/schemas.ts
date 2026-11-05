/** scallop_yield_adapter 的 BCS schema：适配器对象与三个事件。Balance<T> 布局为 {value: u64}。 */
import { bcs } from '@mysten/sui/bcs';

const Balance = bcs.struct('Balance', { value: bcs.u64() });

export const ScallopVaultAdapterBcs = bcs.struct('ScallopVaultAdapter', {
  id: bcs.Address,
  channel_id: bcs.Address,
  admin: bcs.Address,
  total_staked_sui_principal: bcs.u64(),
  ssui_balance: Balance,
  total_harvested_yield_sui: bcs.u64(),
});

export const StakedIntoScallopBcs = bcs.struct('StakedIntoScallopEvent', {
  adapter_id: bcs.Address, channel_id: bcs.Address,
  sui_amount: bcs.u64(), ssui_minted: bcs.u64(), total_principal: bcs.u64(),
});

export const YieldHarvestedAndDistributedBcs = bcs.struct('YieldHarvestedAndDistributedEvent', {
  adapter_id: bcs.Address, channel_id: bcs.Address,
  yield_sui_harvested: bcs.u64(), total_harvested_so_far: bcs.u64(),
});

export const PrincipalRedeemedBcs = bcs.struct('PrincipalRedeemedEvent', {
  adapter_id: bcs.Address, channel_id: bcs.Address, recipient: bcs.Address,
  sui_returned: bcs.u64(), ssui_burned: bcs.u64(),
});
