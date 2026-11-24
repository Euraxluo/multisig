/**
 * 设备密钥库接口：秘密材料在本机以设备绑定的不可导出 AES-256-GCM
 * CryptoKey 密封。具体存储实现（IndexedDB 等）由宿主应用提供。
 */
export interface SealedSecretBox {
  version: 1;
  /** 12 字节 AES-GCM IV，hex。 */
  iv: string;
  /** AES-GCM 密文（含 16 字节 tag），hex。 */
  data: string;
}

export interface DeviceVault {
  seal(plaintext: Uint8Array, context: string): Promise<SealedSecretBox>;
  open(box: SealedSecretBox, context: string): Promise<Uint8Array>;
}
