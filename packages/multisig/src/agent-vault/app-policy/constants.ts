/**
 * walrus_app_policy 常量：质押门控的 SUI 付费策略。
 *
 * 本模块只授权自己的 pay 入口，绝不执行第三方包；
 * Admin 只能登记/暂停应用，不能动成员押金、改已登记条款或改道已提交付款。
 * 无默认 registry ID，一切配置显式传入。
 */
import { MODULES } from '../org/constants';

export const APP_POLICY_MODULE = MODULES.walrusPolicy;

/** 与合约常量一致。 */
export const APP_POLICY_LIMITS = {
  maxApps: 128,
  maxBlobIdBytes: 128,
} as const;

export const APP_POLICY_EVENTS = {
  paymentAppRegistered: 'walrus_app_policy::PaymentAppRegistered',
  appStatusChanged: 'walrus_app_policy::AppStatusChanged',
  paymentSent: 'walrus_app_policy::PaymentSent',
} as const;

// WALRUS_POLICY_ERRORS 注册表住在 org/constants（全模块错误码同一事实源），此处 re-export。
export { WALRUS_POLICY_ERRORS } from '../org/constants';
