/** walrus_app_policy 的 BCS schema：registry、admin cap、策略与三个事件。 */
import { bcs } from '@mysten/sui/bcs';

const Table = bcs.struct('Table', { id: bcs.Address, size: bcs.u64() });

export const RegistryBcs = bcs.struct('Registry', {
  id: bcs.Address,
  policies: Table,
  total_apps: bcs.u64(),
});

export const AdminCapBcs = bcs.struct('AdminCap', {
  id: bcs.Address,
  registry_id: bcs.Address,
});

export const PaymentPolicyBcs = bcs.struct('PaymentPolicy', {
  channel_id: bcs.Address,
  min_member_stake: bcs.u64(),
  recipient: bcs.Address,
  max_payment: bcs.u64(),
  epoch_budget: bcs.u64(),
  spent_in_epoch: bcs.u64(),
  last_payment_epoch: bcs.u64(),
  is_active: bcs.bool(),
});

export const PaymentAppRegisteredBcs = bcs.struct('PaymentAppRegistered', {
  registry_id: bcs.Address, blob_id: bcs.string(), channel_id: bcs.Address,
  min_member_stake: bcs.u64(), recipient: bcs.Address, max_payment: bcs.u64(),
  epoch_budget: bcs.u64(), epoch: bcs.u64(),
});

export const AppStatusChangedBcs = bcs.struct('AppStatusChanged', {
  registry_id: bcs.Address, blob_id: bcs.string(), was_active: bcs.bool(), is_active: bcs.bool(),
});

export const PaymentSentBcs = bcs.struct('PaymentSent', {
  registry_id: bcs.Address, blob_id: bcs.string(), channel_id: bcs.Address,
  receipt_id: bcs.Address, recipient: bcs.Address, amount: bcs.u64(),
  epoch: bcs.u64(), spent_in_epoch: bcs.u64(),
});
