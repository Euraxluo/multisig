/**
 * 升级产物校验（E5）：门限签名批准的是「编译产物 digest」。
 *
 * 任何成员在签名前都应从同一源码 commit、同一 pinned 工具链独立重算
 * digest 并与提案比对，避免把编译机单点信任塞回多签：
 *
 *   1. git checkout <提案对应的源码 commit>
 *   2. const result = verifyUpgradeArtifacts({ pkgDir, expected: '0x…' })
 *   3. result.match === true 才可参与签名；MISMATCH 立即停止并通报委员会
 *
 * 本模块依赖 node:child_process / node:fs，因此不并入包主入口——
 * 通过 `multisig/agent-vault/artifacts` 子路径单独引用（CLI/脚本专用，
 * 浏览器包不引入）。
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { fromHex, toHex } from '@mysten/sui/utils';

export interface UpgradeArtifacts {
  modules: string[];
  dependencies: string[];
  /** 32 字节 package digest。 */
  digest: Uint8Array;
}

export function digestHex(bytes: Uint8Array): string {
  return `0x${toHex(bytes)}`;
}

/** 独立构建并取产物：sui move build --dump-bytecode-as-base64，stdout 仅含 JSON。 */
export function buildUpgradeArtifacts(pkgDir: string): UpgradeArtifacts {
  const raw = execFileSync('sui', ['move', 'build', '--dump-bytecode-as-base64'], {
    cwd: pkgDir,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const parsed = JSON.parse(raw) as { modules?: unknown; dependencies?: unknown; digest?: unknown };
  if (!Array.isArray(parsed.modules) || !Array.isArray(parsed.dependencies) || !Array.isArray(parsed.digest) || parsed.digest.length !== 32) {
    throw new Error('构建产物结构异常：期望 {modules[], dependencies[], digest[32]}');
  }
  return { modules: parsed.modules as string[], dependencies: parsed.dependencies as string[], digest: Uint8Array.from(parsed.digest as number[]) };
}

/**
 * 期望 digest 的两种来源：`0x` 开头 64 位 hex，或 `--dump-bytecode-as-base64`
 * 产物 JSON 文件路径（取其 .digest 字段）。
 */
export function parseExpectedUpgradeDigest(input: string): Uint8Array {
  if (/^0x[0-9a-fA-F]{64}$/.test(input)) {
    return fromHex(input);
  }
  const parsed = JSON.parse(fs.readFileSync(input, 'utf8')) as { digest?: unknown };
  if (!Array.isArray(parsed.digest) || parsed.digest.length !== 32) throw new Error(`文件 ${input} 中没有有效的 digest[32]`);
  return Uint8Array.from(parsed.digest as number[]);
}

export interface UpgradeVerification {
  match: boolean;
  /** 本机独立构建出的 digest。 */
  digest: string;
  /** 提案/产物文件中的期望 digest。 */
  expected: string;
  moduleCount: number;
  dependencies: string[];
}

/** 独立构建并与期望 digest 比对；match=false 时不抛错，由调用方决定退出码与通报流程。 */
export function verifyUpgradeArtifacts(options: { pkgDir: string; expected: string | Uint8Array }): UpgradeVerification {
  const artifacts = buildUpgradeArtifacts(options.pkgDir);
  const expected = typeof options.expected === 'string' ? parseExpectedUpgradeDigest(options.expected) : options.expected;
  return {
    match: digestHex(expected) === digestHex(artifacts.digest),
    digest: digestHex(artifacts.digest),
    expected: digestHex(expected),
    moduleCount: artifacts.modules.length,
    dependencies: artifacts.dependencies,
  };
}
