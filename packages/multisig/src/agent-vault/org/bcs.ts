/**
 * 最小 BCS 工具：读（对象字节）+ 写（digest 拼接用）。
 * 只实现组织/提案路径实际用到的原语，保持零依赖。
 *
 * 地址与 hex 的**规范化**一律交给官方 `@mysten/sui/utils`：手写 padding 在
 * 大小写、前导零和空串上各有坑（`normalizeSuiAddress('')` 会给出全零地址，
 * 因此这里先做形态校验再交给官方补齐）。
 */
import { fromHex, normalizeSuiAddress, toHex } from '@mysten/sui/utils';

export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export function bytesToHex(b: Uint8Array): string {
  return toHex(b);
}

export function hexToBytes(hex: string): Uint8Array {
  const h = hex.replace(/^0x/i, '');
  if (h.length % 2 !== 0) throw new Error(`hex 长度必须为偶数: ${hex}`);
  if (!/^[0-9a-f]*$/i.test(h)) throw new Error('hex 包含非法字符');
  return fromHex(h);
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** Sui 接受简写地址；先严格校验形态，再交给官方补齐为 BCS 的 32 字节。 */
export function canonicalAddress(value: string): string {
  const hex = typeof value === 'string' ? value.replace(/^0x/i, '') : '';
  if (!/^[0-9a-f]{1,64}$/i.test(hex)) throw new Error('无效的 Sui 地址');
  return normalizeSuiAddress(hex);
}

function exactInteger(v: number | bigint): bigint {
  if (typeof v === 'number' && !Number.isSafeInteger(v)) throw new Error('数值必须是安全整数，请改用 bigint');
  return BigInt(v);
}

export function u64le(v: number | bigint): Uint8Array {
  const x = exactInteger(v);
  if (x < 0n || x > 0xffff_ffff_ffff_ffffn) throw new Error(`u64 溢出: ${v}`);
  const out = new Uint8Array(8);
  let n = x;
  for (let i = 0; i < 8; i++) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

export function uleb128(v: number | bigint): Uint8Array {
  let n = exactInteger(v);
  if (n < 0n || n > 0xffff_ffffn) throw new Error(`uleb128 超出 BCS u32 范围: ${v}`);
  const bytes: number[] = [];
  for (;;) {
    const byte = Number(n & 0x7fn);
    n >>= 7n;
    if (n === 0n) {
      bytes.push(byte);
      return new Uint8Array(bytes);
    }
    bytes.push(byte | 0x80);
  }
}

/** bcs(vector<u8>)：uleb 长度 + 字节。 */
export function bcsVectorBytes(payload: Uint8Array): Uint8Array {
  return concat(uleb128(payload.length), payload);
}

/** bcs(vector<address>)：uleb 个数 + 每成员 32 字节。 */
export function bcsVectorAddress(addresses: string[]): Uint8Array {
  const heads = addresses.map((a) => {
    const b = hexToBytes(a);
    if (b.length !== 32) throw new Error(`地址必须 32 字节: ${a}`);
    return b;
  });
  return concat(uleb128(heads.length), ...heads);
}

/** bcs(vector<u64>)：uleb 个数 + 每成员 8 字节小端。 */
export function bcsVectorU64(values: Array<number | bigint>): Uint8Array {
  const parts = values.map((v) => u64le(v));
  return concat(uleb128(parts.length), ...parts);
}

/** 只读 BCS 解析器（对象 content 字节）。 */
export class BcsReader {
  private off = 0;
  constructor(private readonly b: Uint8Array) {}

  private take(n: number): Uint8Array {
    if (!Number.isSafeInteger(n) || n < 0 || n > this.b.length - this.off) {
      throw new Error(`BCS 越界: 需要 ${n}，剩余 ${this.b.length - this.off}`);
    }
    const out = this.b.slice(this.off, this.off + n);
    this.off += n;
    return out;
  }

  address(): string {
    return '0x' + bytesToHex(this.take(32));
  }

  u64(): bigint {
    const b = this.take(8);
    let v = 0n;
    for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[i]);
    return v;
  }

  u8(): number {
    return this.take(1)[0];
  }

  uleb(): number {
    let v = 0;
    for (let i = 0; i < 5; i++) {
      const byte = this.u8();
      const digit = byte & 0x7f;
      if (i === 4 && digit > 0x0f) throw new Error('BCS ULEB128 溢出');
      v += digit * 2 ** (7 * i);
      if ((byte & 0x80) === 0) {
        if (i > 0 && digit === 0) throw new Error('BCS ULEB128 非规范编码');
        return v;
      }
    }
    throw new Error('BCS ULEB128 过长');
  }

  vector(): Uint8Array {
    return this.take(this.uleb());
  }

  /** sui::table::Table 的存储布局 = { id: address, size: u64 }。 */
  table(): { id: string; size: bigint } {
    return { id: this.address(), size: this.u64() };
  }

  get remaining(): number {
    return this.b.length - this.off;
  }
}
