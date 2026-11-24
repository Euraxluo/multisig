/**
 * bridge 测试共享假件：进程内设备密钥库与协议认证。
 * 生产实现由宿主应用注入；这里只追求语义等价，便于 Node 测试离线运行。
 */
import { fromHex, toHex } from '@mysten/sui/utils';
import type { DeviceVault } from './device-vault';

/** AES-256-GCM 内存设备库：context 作为 AAD 绑定，密钥不可导出。 */
export function createMemoryDeviceVault(): DeviceVault {
  let key: Promise<CryptoKey> | undefined;
  const cryptoKey = () => (key ??= crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']));
  const aad = (context: string) => new TextEncoder().encode(`test-device-vault-v1:${context}`);
  return {
    async seal(plaintext, context) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(context) }, await cryptoKey(), plaintext));
      return { version: 1, iv: toHex(iv), data: toHex(data) };
    },
    async open(box, context) {
      return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromHex(box.iv), additionalData: aad(context) }, await cryptoKey(), fromHex(box.data)));
    },
  };
}
